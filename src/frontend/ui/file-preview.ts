// File preview dialog (R11).
//
// Clicking a transcript file link opens ONE reusable modal (ui/dialog.ts) and,
// only for that user activation, asks the existing `fileRead` tool for a BOUNDED
// window of the file. There is no auto-fetch of mentioned paths, no new server
// endpoint and no filesystem access in the browser.
//
// REQUEST CONTRACT
// ----------------
// `FilePreviewReader` is injected by the app shell (main.ts) so this module stays
// network-free and testable:
//
//     readFile({ path, startLine: 1, maxLines: 200 })
//         -> { files: [{ content, truncated, startLine, endLine, nextLine,
//                        error? }], truncated? }
//
// main.ts implements that with `callTool('fileRead', [{ path, startLine, maxLines }])`.
// The result shape is read structurally (`files[]`), so an older/extra field does
// not break the dialog.
//
// RENDERING / SECURITY
// --------------------
// - `content` is model/server text: it is escaped/highlighted by the existing
//   `highlightCode` helper and inserted as `<pre><code>`; no raw HTML path.
// - Errors and truncation notes are written with textContent.
// - The panel starts with a loading line. A result that arrives AFTER the dialog
//   was closed is dropped (`handle.isOpen`), so a late promise cannot resurrect a
//   detached modal or move focus.
// - The caller passes no focus destination: ui/dialog.ts captures the trigger
//   (the file-link button) and restores it on close. Nothing here can focus the
//   composer.
//
// Cross-references:
//   - path validation/extension map: ./file-links.ts
//   - modal shell/focus: ./dialog.ts (styles: ./dialog.css, imported by styles.css)
//   - highlight helper: ./markdown.ts (`highlightCode`)
//   - caller/request wiring: src/frontend/main.ts
//   - consumers: ./turns.ts, tools result body (`enhanceFileLinks`)

import { openDialog } from './dialog';
import type { DialogHandle } from './dialog';
import { languageOfPath, localFilePathOf } from './file-links';
import { highlightCode } from './markdown';

// Bounded default: one screen of source is enough for a preview, and this is the
// same order of magnitude as the tool's own default (200). The shell clamps it.
export const FILE_PREVIEW_MAX_LINES = 200;

// Structural view of one `fileRead` entry. Everything is optional/unknown at the
// boundary because this is wire data; the renderer narrows each field.
export type FilePreviewEntry = {
    content?: unknown;
    truncated?: unknown;
    startLine?: unknown;
    endLine?: unknown;
    nextLine?: unknown;
    error?: { message?: unknown } | null;
};

export type FilePreviewResult = {
    files?: unknown;
    truncated?: unknown;
};

export type FilePreviewRequest = {
    path: string;
    startLine: number;
    maxLines: number;
};

export type FilePreviewReader = (request: FilePreviewRequest) => Promise<FilePreviewResult>;

export type FilePreviewOptions = {
    // Reads the file. Omitted in standalone tests / an unwired page: the dialog
    // then reports that reading is unavailable instead of guessing.
    read?: FilePreviewReader;
    // Explicit focus destination passed to ui/dialog.ts. Left undefined in normal
    // use, which makes the dialog restore the element focused at open time.
    returnFocus?: HTMLElement | null;
    // Bounded window size. Defaults to FILE_PREVIEW_MAX_LINES.
    maxLines?: number;
};

// One-line status/error node. Text only, never HTML.
const statusNode = (className: string, text: string): HTMLElement => {
    const node = document.createElement('div');
    node.className = className;
    node.textContent = text;
    return node;
};

// Read a positive integer out of a wire value, ignoring anything else.
const integerOf = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;

// First entry of a structural result. `files` is the only contract; a malformed
// value is reported as an error rather than rendering a half-preview.
const firstEntryOf = (result: FilePreviewResult): FilePreviewEntry | undefined => {
    if (!Array.isArray(result.files)) return undefined;

    const entry = result.files[0];
    if (typeof entry !== 'object' || entry === null) return undefined;

    return entry as FilePreviewEntry;
};

// Error text for a wire failure. The ENOENT message from fileRead already names
// the requested path, so it is shown verbatim.
const messageOfEntry = (entry: FilePreviewEntry): string | undefined => {
    if (entry.error === undefined || entry.error === null) return undefined;

    const message = entry.error.message;
    return typeof message === 'string' && message.length > 0 ? message : 'The file could not be read.';
};

// Build the full preview body for one successful/error result.
const previewBody = (path: string, result: FilePreviewResult): HTMLElement => {
    const host = document.createElement('div');
    host.className = 'preview preview-file';

    const entry = firstEntryOf(result);
    if (entry === undefined) {
        host.append(statusNode('preview-error', `The server did not return a readable entry for ${path}.`));
        return host;
    }

    const failure = messageOfEntry(entry);
    if (failure !== undefined) {
        host.append(statusNode('preview-error', failure));
        return host;
    }

    const content = typeof entry.content === 'string' ? entry.content : '';
    const startLine = integerOf(entry.startLine) ?? 1;
    const endLine = integerOf(entry.endLine);
    const truncated = entry.truncated === true || result.truncated === true;

    // Range caption: line numbering is metadata from fileRead, not prefixes in
    // the copied text. This keeps the preview honest when the window starts late.
    const range =
        endLine === undefined || endLine < startLine
            ? `line ${startLine}`
            : `lines ${startLine}–${endLine}`;
    host.append(statusNode('preview-meta', `${path} · ${range}`));

    if (content.length === 0) {
        host.append(statusNode('preview-empty', 'This file has no text in the requested window.'));
    } else {
        const pre = document.createElement('pre');
        pre.className = 'preview-code';
        const code = document.createElement('code');
        // `highlightCode` escapes or highlights every character, so inserting its
        // result is safe; `languageOfPath` never guesses beyond a known map.
        code.className = 'hljs';
        code.innerHTML = highlightCode(content, languageOfPath(path));
        pre.append(code);
        host.append(pre);
    }

    if (truncated) {
        const next = integerOf(entry.nextLine);
        host.append(
            statusNode(
                'preview-truncated',
                next === undefined
                    ? 'The file continues after this window.'
                    : `The file continues after this window; the next request starts at line ${next}.`
            )
        );
    }

    return host;
};

// Open the modal and resolve the window asynchronously. Returns the dialog handle
// immediately so the caller (and tests) can inspect/close it while loading.
//
// A refused path never reaches the reader: the dialog states why instead. This is
// the second line of defence behind `enhanceFileLinks`, which already filters
// non-local targets before offering a click.
export const openFilePreview = (path: string, options: FilePreviewOptions = {}): DialogHandle => {
    const normalized = localFilePathOf(path);
    const maxLines = Math.min(Math.max(Math.trunc(options.maxLines ?? FILE_PREVIEW_MAX_LINES), 1), 5000);

    const handle = openDialog({
        // The title is the path under review, not the window; the range is in the
        // body so a truncated preview is visible without hovering.
        title: normalized ?? path,
        content: statusNode('preview-status', normalized === undefined ? 'Checking path…' : 'Reading file…'),
        ...(options.returnFocus === undefined ? {} : { returnFocus: options.returnFocus })
    });

    if (normalized === undefined) {
        handle.update({
            content: statusNode(
                'preview-error',
                'Only a local relative file path can be previewed. Absolute, drive, UNC and URL targets are refused.'
            )
        });
        return handle;
    }

    if (options.read === undefined) {
        handle.update({
            content: statusNode('preview-error', 'File reading is not available on this page.')
        });
        return handle;
    }

    const read = options.read;
    void Promise.resolve()
        .then(() => read({ path: normalized, startLine: 1, maxLines }))
        .then((result) => {
            // Late result after close: drop it. The modal is gone and there is no
            // focus/DOM to update.
            if (!handle.isOpen) return;
            handle.update({ content: previewBody(normalized, result) });
        })
        .catch((error: unknown) => {
            if (!handle.isOpen) return;
            const message = error instanceof Error ? error.message : String(error);
            handle.update({ content: statusNode('preview-error', message) });
        });

    return handle;
};

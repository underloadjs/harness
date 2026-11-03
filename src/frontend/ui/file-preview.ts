// File preview dialog (R11).
//
// Clicking a transcript file link opens ONE reusable modal (ui/dialog.ts) and,
// only for that user activation, asks the existing `read` tool for a BOUNDED
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
// main.ts implements that with `callTool('read', [{ path, startLine, maxLines }])`.
// The result shape is read structurally (`files[]`), so an older/extra field does
// not break the dialog.
//
// BASENAME RESOLUTION (the "clicking a file shows nothing" fix)
// --------------------------------------------------------------
// A transcript reference is very often a BARE NAME (`descriptors.ts`), while the
// `read` tool resolves a path against the SERVER process working directory and does
// no fuzzy search — so the old behaviour was a red ENOENT for a file that exists
// three directories deep. The shell may therefore inject a second adapter:
//
//     resolveFile('descriptors.ts') -> ['src/a/descriptors.ts', ...]   (relative paths)
//
// main.ts implements it with the existing `glob` tool (`filePreviewGlobPattern`),
// rooted at '.' — the same root `read` resolves against, and there is deliberately
// no workspace-root endpoint (src/server/runtime.ts). `openFilePreview` runs the
// resolver ONLY for a normalized path with no '/', because a complete relative path
// needs no help:
//
//   - one candidate  -> read and title that exact path (`filePreviewCandidatesOf`
//                       guarantees exact, case-sensitive basename equality);
//   - several        -> the dialog lists them as `.file-link` buttons and reads
//                       NOTHING; picking one re-uses this same dialog in place;
//   - none           -> a plain not-found line, and again no bogus `read` call.
//
// With no resolver wired, behaviour is byte-identical to before: the bare name goes
// straight to `read` and the server's own ENOENT message is rendered (that is the
// state ui/file-preview.test.ts pins). A resolver that THROWS or rejects also falls
// back to the plain read: a broken search must not hide the file's real answer.
//
// RENDERING / SECURITY
// --------------------
// - `content` is model/server text rendered by the SHARED line-view builder
//   `createCodeBlock` (ui/tools.ts): one `.code-line` row per logical line, CSS
//   counter numbers, and `.code-break` separators that carry the payload's own
//   '\n' so `code.textContent` stays BYTE-IDENTICAL to the window. The gutter is
//   generated content, so it is never in `textContent`, never in a selection, and
//   never in the Copy payload. The preview flavour is `preview-code`, whose rules
//   (no soft wrap, sideways scroll, STICKY gutter) live in ui/dialog.css.
// - Past MAX_HIGHLIGHT_CHARS the builder carries the whole text as escaped text
//   instead of asking the highlighter for a head-only render, so a long window can
//   no longer silently lose its tail (that is why `highlightCode` is not called
//   directly here).
// - Errors, captions and truncation notes are written with textContent.
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
//   - line-numbered code view: ./tools.ts (`createCodeBlock`), CSS counters in
//     styles.css (`.code-line`), preview overrides in ./dialog.css
//   - highlight helper: ./markdown.ts (`highlightCode`, used through the builder)
//   - caller/request wiring + glob adapter: src/frontend/main.ts
//   - consumers: ./turns.ts, tools result body (`enhanceFileLinks`)

import { openDialog } from './dialog';
import type { DialogHandle } from './dialog';
import { languageOfPath, localFilePathOf } from './file-links';
import { createCodeBlock } from './tools';

// Bounded default: one screen of source is enough for a preview, and this is the
// same order of magnitude as the tool's own default (200). The shell clamps it.
export const FILE_PREVIEW_MAX_LINES = 200;

// The scoping class of the preview's code view. `createCodeBlock` always emits
// `code-block <class>`; this class is the hook ui/dialog.css uses for the editor
// layout (no wrap + sticky gutter), replacing the tool pane's `tool-code` soft wrap.
export const PREVIEW_CODE_CLASS = 'preview-code';

// Structural view of one `read` entry. Everything is optional/unknown at the
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

// Locates a BARE BASENAME anywhere under the workspace root and answers the relative
// paths that name it (the shell implements this with `glob`, see the header). The
// caller's answer is narrowed by `filePreviewCandidatesOf`, so an error body, a
// duplicate or a substring hit cannot reach the dialog.
export type FilePreviewResolver = (name: string) => Promise<readonly string[]>;

export type FilePreviewOptions = {
    // Reads the file. Omitted in standalone tests / an unwired page: the dialog
    // then reports that reading is unavailable instead of guessing.
    read?: FilePreviewReader;
    // Resolves a bare basename to real paths. Omitted => the historical behaviour
    // (the bare name is read as typed, and the server reports ENOENT).
    resolve?: FilePreviewResolver;
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

// Error text for a wire failure. The ENOENT message from read already names
// the requested path, so it is shown verbatim.
const messageOfEntry = (entry: FilePreviewEntry): string | undefined => {
    if (entry.error === undefined || entry.error === null) return undefined;

    const message = entry.error.message;
    return typeof message === 'string' && message.length > 0 ? message : 'The file could not be read.';
};

// --- basename resolution ----------------------------------------------------

// Glob pattern for one bare basename. `**/` can consume ZERO directories
// (src/tools/files/glob.ts `globToRegExp`), so a file at the workspace root is
// found as well as one nested any depth below it. Exported so the shell's `glob`
// adapter and the tests share ONE pattern shape instead of each inventing one.
export const filePreviewGlobPattern = (name: string): string[] => [`**/${name}`];

// The last segment of a relative posix path.
const basenameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

// Fewer separators = closer to the workspace root, i.e. the likelier file.
const depthOf = (path: string): number => path.split('/').length;

// Narrow whatever a resolver answered into usable candidates, deterministically.
//
// The resolver is wire data (a `glob` file list), so nothing is trusted:
//   - non-strings and paths `localFilePathOf` refuses (absolute, drive, `..`, URL)
//     are dropped — a candidate that could not be typed into the dialog cannot be
//     opened from it either;
//   - only exact, CASE-SENSITIVE basename matches survive, so the picker's
//     substring form (`**/*name*`) can never open `old-descriptors.ts` in place of
//     `descriptors.ts`;
//   - duplicates collapse, and the order is shallowest-first, then code-point
//     order, so a single-candidate auto-pick and a 3-candidate list are both
//     stable across clicks.
export const filePreviewCandidatesOf = (
    name: string,
    values: readonly unknown[] | undefined
): string[] => {
    const unique: string[] = [];
    const seen = new Set<string>();

    for (const value of values ?? []) {
        if (typeof value !== 'string') continue;

        const safe = localFilePathOf(value);
        if (safe === undefined || seen.has(safe)) continue;
        if (basenameOf(safe) !== name) continue;

        seen.add(safe);
        unique.push(safe);
    }

    return unique.sort((left, right) => {
        const byDepth = depthOf(left) - depthOf(right);
        if (byDepth !== 0) return byDepth;
        return left < right ? -1 : left > right ? 1 : 0;
    });
};

// The preview body plus the exact text its Copy action should write. `copyText`
// is undefined for loading/error/empty states (there is nothing meaningful to
// copy), which removes the Copy control from the dialog.
type PreviewBody = {
    element: HTMLElement;
    copyText?: string;
};

// Build the full preview body for one successful/error result.
const previewBody = (path: string, result: FilePreviewResult): PreviewBody => {
    const host = document.createElement('div');
    host.className = 'preview preview-file';

    const entry = firstEntryOf(result);
    if (entry === undefined) {
        host.append(statusNode('preview-error', `The server did not return a readable entry for ${path}.`));
        return { element: host };
    }

    const failure = messageOfEntry(entry);
    if (failure !== undefined) {
        host.append(statusNode('preview-error', failure));
        return { element: host };
    }

    const content = typeof entry.content === 'string' ? entry.content : '';
    const startLine = integerOf(entry.startLine) ?? 1;
    const endLine = integerOf(entry.endLine);
    const truncated = entry.truncated === true || result.truncated === true;
    const language = languageOfPath(path);

    // Range caption: line numbering is metadata from read, not prefixes in
    // the copied text. This keeps the preview honest when the window starts late.
    const range =
        endLine === undefined || endLine < startLine
            ? `line ${startLine}`
            : `lines ${startLine}–${endLine}`;
    // The language segment names what the viewer actually colourised
    // (`languageOfPath` never guesses beyond the known extension map), so an
    // unknown extension keeps the historical two-segment caption.
    const caption = language === undefined ? `${path} · ${range}` : `${path} · ${language} · ${range}`;
    host.append(statusNode('preview-meta', caption));

    if (content.length === 0) {
        host.append(statusNode('preview-empty', 'This file has no text in the requested window.'));
    } else {
        // The SAME line-per-row builder as the tool panes, scoped to
        // `preview-code`: line numbers, no soft wrap, sideways scroll, and a
        // gutter that stays put while the text scrolls (ui/dialog.css).
        const pre = createCodeBlock(content, language, undefined, PREVIEW_CODE_CLASS);
        // Numbers start at the window's own first line, so a future paged window
        // (`startLine > 1`) is numbered correctly instead of restarting at 1. The
        // inline declaration outranks styles.css `counter-reset: code-line`, and a
        // start of 1 becomes `code-line 0` — the counter increments before print.
        pre.querySelector('code')?.style.setProperty('counter-reset', `code-line ${startLine - 1}`);
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

    // Copy the previewed WINDOW exactly as rendered. The range/truncation metadata
    // and the generated line numbers are deliberately not part of the text: this is
    // file content, not a log caption, and the dialog already tells the reader
    // whether the file continues.
    return content.length === 0 ? { element: host } : { element: host, copyText: content };
};

// Ambiguous bare name: ask, never guess. One button per candidate, labelled with
// the FULL relative path and styled with the transcript's own `.file-link` class so
// the list reads as the same clickable paths the reader already knows.
const candidateBody = (
    name: string,
    candidates: readonly string[],
    onPick: (path: string) => void
): HTMLElement => {
    const host = document.createElement('div');
    host.className = 'preview preview-file preview-candidates';

    host.append(statusNode('preview-meta', `${candidates.length} files named ${name}. Pick one to preview:`));

    const list = document.createElement('div');
    list.className = 'preview-candidate-list';
    for (const path of candidates) {
        const button = document.createElement('button');
        button.type = 'button';
        // `data-path` mirrors the attribute `enhanceFileLinks` writes on a
        // transcript link, so a test/inspection of "which path does this open"
        // works the same way in both places.
        button.className = 'file-link preview-candidate';
        button.dataset.path = path;
        button.textContent = path;
        // Reading is owned by the caller closure (`loadPath` below): the path here
        // always contains a '/', so it opens directly with no second resolution.
        button.addEventListener('click', () => onPick(path));
        list.append(button);
    }
    host.append(list);

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
    const resolver = options.resolve;
    // A path with no '/' names a file without its directory. That is the only case
    // the resolver is for: a complete relative path goes straight to `read`.
    const bare = normalized !== undefined && !normalized.includes('/');
    // The loading line tells the truth about which step is running: a bare name with
    // a resolver wired is a workspace walk, not a read of the typed path.
    const searching = bare && resolver !== undefined;

    const handle = openDialog({
        // The title is the path under review, not the window; the range is in the
        // body so a truncated preview is visible without hovering.
        title: normalized ?? path,
        content: statusNode(
            'preview-status',
            normalized === undefined
                ? 'Checking path…'
                : searching
                  ? `Looking for ${normalized} in the workspace…`
                  : 'Reading file…'
        ),
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

    // Read ONE exact path and paint it. Shared by the initial load and by a
    // candidate click, so both settle the same dialog (title, body, Copy) and a
    // result that lands after close is dropped the same way.
    const loadPath = (target: string): void => {
        void Promise.resolve()
            .then(() => read({ path: target, startLine: 1, maxLines }))
            .then((result) => {
                // Late result after close: drop it. The modal is gone and there is no
                // focus/DOM to update.
                if (!handle.isOpen) return;
                const body = previewBody(target, result);
                handle.update({
                    // The title follows the file actually on screen: a resolved
                    // basename becomes its real path, and a picked candidate becomes
                    // the path the reader chose.
                    title: target,
                    content: body.element,
                    // The Copy action appears with the content: a loading/error/empty
                    // preview has nothing meaningful to copy and keeps no dead control.
                    ...(body.copyText === undefined ? { copy: null } : { copy: body.copyText })
                });
            })
            .catch((error: unknown) => {
                if (!handle.isOpen) return;
                const message = error instanceof Error ? error.message : String(error);
                handle.update({ content: statusNode('preview-error', message) });
            });
    };

    // A complete relative path (or no resolver) is exactly the historical request:
    // the typed name goes straight to `read`, and the server's own ENOENT message is
    // what the dialog renders.
    if (!bare || resolver === undefined) {
        loadPath(normalized);
        return handle;
    }

    void Promise.resolve()
        .then(() => resolver(normalized))
        .then((found) => {
            if (!handle.isOpen) return;

            const candidates = filePreviewCandidatesOf(normalized, found);

            if (candidates.length === 1) {
                // One unambiguous file. When it equals the bare name (a root-level
                // match) this is the same read the dialog always issued.
                loadPath(candidates[0] as string);
                return;
            }

            if (candidates.length > 1) {
                // Count in the title, list in the body: the reader sees immediately
                // why the click did not open a file, and nothing is read blindly.
                handle.update({
                    title: `${normalized} · ${candidates.length} files`,
                    content: candidateBody(normalized, candidates, loadPath),
                    copy: null
                });
                return;
            }

            // No match: a stated terminal state, not a doomed `read` whose ENOENT
            // message would name a path the user never typed as a full path.
            handle.update({
                content: statusNode(
                    'preview-error',
                    `${normalized} was not found under the workspace root; the reference may be incomplete.`
                ),
                copy: null
            });
        })
        .catch(() => {
            // A failed/absent walk says nothing about the file itself, so fall back
            // to the plain read and let the server's own message stand. A late
            // answer after close is dropped by `loadPath` itself.
            if (!handle.isOpen) return;
            loadPath(normalized);
        });

    return handle;
};

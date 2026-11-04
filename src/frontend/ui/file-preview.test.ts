// File-preview dialog contract (R11).
//
// Pins the bounded request, escaped rendering, truncation/error states and the
// late-result-after-close safety of ui/file-preview.ts, plus the two halves of the
// "clicking a file shows nothing / it looks like prose" fix:
//   - BASENAME RESOLUTION: a bare `descriptors.ts` is looked up through the injected
//     resolver (one match -> read it, several -> list them, none -> say so), and a
//     page with no resolver keeps the historical ENOENT rendering;
//   - the PAYLOAD CODE VIEW: one numbered row per logical line, SOFT WRAP (like every
//     other dialog payload), with `code.textContent` still byte-identical to the window
//     (the Copy contract depends on it) and numbering that starts at the window's line.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/file-preview.test.ts

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    FILE_PREVIEW_MAX_LINES,
    filePreviewCandidatesOf,
    filePreviewGlobPattern,
    openFilePreview
} from './file-preview';
import type { FilePreviewReader, FilePreviewResolver } from './file-preview';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// Resolution adds microtask hops before the read, so two ticks guarantees every
// queued `.then` (resolver -> read -> render) has run.
const flushAll = async (): Promise<void> => {
    await flush();
    await flush();
};

// Mirror tool-code-viewer.test.ts: resolve from the package root (`npm test`) or the
// frontend root (the frontend vitest config sets `root` to src/frontend/).
const stylesheet = ['src/frontend/ui/dialog.css', 'ui/dialog.css']
    .map((candidate) => resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(candidate));
if (stylesheet === undefined) throw new Error('dialog.css not found');

const css = readFileSync(stylesheet, 'utf8');

const blockOf = (selector: string): string => {
    const start = css.indexOf(selector);
    if (start < 0) throw new Error(`missing selector ${selector}`);

    const open = css.indexOf('{', start);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
};

const dialog = (): HTMLElement => {
    const found = document.querySelector<HTMLElement>('.dialog');
    if (found === null) throw new Error('missing dialog');
    return found;
};

const rowsOf = (scope: Element): HTMLElement[] =>
    Array.from(scope.querySelectorAll<HTMLElement>('.code-line'));

const breaksOf = (scope: Element): HTMLElement[] =>
    Array.from(scope.querySelectorAll<HTMLElement>('.code-break'));

// The scrollable code frame of the open dialog. Throws (instead of a `??` fallback)
// so a missing view is a real assertion failure, not a row count of zero.
const previewFrame = (): HTMLElement => {
    const found = dialog().querySelector<HTMLElement>('.preview-code');
    if (found === null) throw new Error('missing preview code view');
    return found;
};

// Every dialog opened in one test must be gone before the next: `document
// .querySelector('.dialog')` reads the FIRST panel, so a leftover modal makes an
// unrelated later test look broken.
beforeEach(() => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('.dialog-close')) button.click();
    document.body.innerHTML = '';
});

describe('openFilePreview', () => {
    it('reads one bounded window and renders escaped/highlighted text', async () => {
        const read = vi.fn<FilePreviewReader>(async () => ({
            files: [
                {
                    content: 'const answer = 42;\nconsole.log(answer);\n',
                    startLine: 1,
                    endLine: 2,
                    truncated: false,
                    nextLine: null
                }
            ],
            truncated: false
        }));

        const handle = openFilePreview('src/main.ts', { read });
        expect(dialog().querySelector('.preview-status')?.textContent).toBe('Reading file…');

        await flush();

        // Bounded request: startLine 1 and the preview's own maxLines.
        expect(read).toHaveBeenCalledWith({
            path: 'src/main.ts',
            startLine: 1,
            maxLines: FILE_PREVIEW_MAX_LINES
        });
        expect(dialog().querySelector('.dialog-title')?.textContent).toBe('src/main.ts');
        // The caption names the path, the highlighter alias the extension resolves
        // to, and the window — line numbers live in CSS, never in the text.
        expect(dialog().querySelector('.preview-meta')?.textContent).toBe(
            'src/main.ts · typescript · lines 1–2'
        );

        const code = dialog().querySelector('.preview-code code');
        expect(code?.textContent).toBe('const answer = 42;\nconsole.log(answer);\n');
        // Highlighting is the existing safe helper: tokens become spans, not HTML.
        expect(code?.querySelector('.hljs-keyword')?.textContent).toBe('const');
        expect(dialog().textContent).not.toContain('<script>');

        handle.close();
        expect(document.querySelector('.dialog')).toBeNull();
    });

    it('reports truncation with the next line', async () => {
        const read: FilePreviewReader = async () => ({
            files: [{ content: 'a\nb\n', startLine: 1, endLine: 2, truncated: true, nextLine: 3 }],
            truncated: true
        });

        const handle = openFilePreview('src/long.ts', { read });
        await flush();

        expect(dialog().querySelector('.preview-truncated')?.textContent).toBe(
            'The file continues after this window; the next request starts at line 3.'
        );
        handle.close();
    });

    it('shows the server error for an unreadable file', async () => {
        const read: FilePreviewReader = async () => ({
            files: [
                {
                    content: '',
                    startLine: 1,
                    endLine: 0,
                    truncated: false,
                    nextLine: null,
                    error: { message: 'read could not find "missing.ts": no such file or directory (ENOENT).' }
                }
            ],
            truncated: false
        });

        const handle = openFilePreview('missing.ts', { read });
        await flush();

        expect(dialog().querySelector('.preview-error')?.textContent).toBe(
            'read could not find "missing.ts": no such file or directory (ENOENT).'
        );
        handle.close();
    });

    it('reports a rejected request without rendering a half preview', async () => {
        const read: FilePreviewReader = async () => {
            throw new Error('the server is unreachable');
        };

        const handle = openFilePreview('src/a.ts', { read });
        await flush();

        expect(dialog().querySelector('.preview-error')?.textContent).toBe('the server is unreachable');
        expect(dialog().querySelector('.preview-code')).toBeNull();
        handle.close();
    });

    it('refuses absolute/drive/traversal paths before calling the reader', async () => {
        const read = vi.fn<FilePreviewReader>();

        for (const path of ['/etc/passwd', 'C:/secret.ts', '../secret.ts', 'https://example.com/a.ts']) {
            const handle = openFilePreview(path, { read });
            expect(dialog().querySelector('.preview-error')?.textContent).toBe(
                'Only a local relative file path can be previewed. Absolute, drive, UNC and URL targets are refused.'
            );
            handle.close();
        }

        expect(read).not.toHaveBeenCalled();
    });

    it('reports that reading is unwired when no reader is supplied', () => {
        const handle = openFilePreview('src/a.ts');
        expect(dialog().querySelector('.preview-error')?.textContent).toBe(
            'File reading is not available on this page.'
        );
        handle.close();
    });

    it('ignores a result that arrives after the dialog was closed', async () => {
        let resolve: ((value: Awaited<ReturnType<FilePreviewReader>>) => void) | undefined;
        const read: FilePreviewReader = () =>
            new Promise((settle) => {
                resolve = settle;
            });

        const handle = openFilePreview('src/late.ts', { read });
        handle.close();
        expect(handle.isOpen).toBe(false);

        resolve?.({ files: [{ content: 'late', startLine: 1, endLine: 1 }] });
        await flush();

        // No detached dialog and no thrown error; the late body is simply dropped.
        expect(document.querySelector('.dialog')).toBeNull();
    });
});

// --- the editor-style code view ---------------------------------------------

describe('preview code view', () => {
    const content = 'export const a = 1;\n\nexport const b = 2;\n';

    const mounted = async (): Promise<void> => {
        const read: FilePreviewReader = async () => ({
            files: [{ content, startLine: 1, endLine: 3, truncated: false }]
        });
        openFilePreview('src/views.ts', { read });
        await flush();
    };

    it('lays one numbered row per logical line, byte-identical to the window', async () => {
        await mounted();

        const pre = previewFrame();
        // The shared `createCodeBlock` builder, scoped with `preview-code`: the same
        // soft-wrapped payload layout as a tool pane, plus the window-relative counter
        // start that only the preview needs (ui/dialog.css).
        expect(pre.className).toBe('code-block preview-code');
        // 4 logical lines: `a`, the blank line, `b`, and the empty line the trailing
        // '\n' leaves — exactly what `code.split('\n')` means.
        expect(pre.getAttribute('data-code-lines')).toBe('4');
        expect(rowsOf(pre).map((row) => row.textContent)).toEqual([
            'export const a = 1;',
            '',
            'export const b = 2;',
            ''
        ]);
        // The separators carry the payload's own newlines and nothing else.
        expect(breaksOf(pre).map((node) => node.textContent)).toEqual(['\n', '\n', '\n']);
        // `textContent` is the window, character for character: the numbering and the
        // row layout did not touch the text, so Copy and every consumer still match.
        expect(pre.querySelector('code')?.textContent).toBe(content);
    });

    it('sizes the gutter and starts numbering at the window first line', async () => {
        const read: FilePreviewReader = async () => ({
            files: [{ content: 'x\ny\n', startLine: 201, endLine: 202, truncated: true, nextLine: 203 }]
        });
        const handle = openFilePreview('src/paged.md', { read });
        await flush();

        const code = dialog().querySelector('.preview-code code');
        // Two rows -> the 2ch floor; a 3-digit window would ask for 3ch.
        expect(code?.style.getPropertyValue('--code-gutter')).toBe('2ch');
        // `counter-reset` is the row count MINUS one, so the first visible number is
        // 201: a paged window is numbered like the file, not restarted at 1.
        expect(code?.style.getPropertyValue('counter-reset')).toBe('code-line 200');
        expect(dialog().querySelector('.preview-meta')?.textContent).toBe(
            'src/paged.md · markdown · lines 201–202'
        );
        expect(dialog().querySelector('.preview-truncated')?.textContent).toBe(
            'The file continues after this window; the next request starts at line 203.'
        );

        // No text node anywhere carries a line number: they are CSS counters.
        expect(code?.textContent).toBe('x\ny\n');
        handle.close();
    });

    it('keeps the whole window past the highlight budget instead of dropping the tail', async () => {
        // `highlightCode` returns a HEAD-only render above 40k characters, which is
        // why the viewer carries the text itself when the block is that big.
        const line = 'x'.repeat(20_000);
        const huge = `${line}\n${line}\nTAIL`;

        const read: FilePreviewReader = async () => ({
            files: [{ content: huge, startLine: 1, endLine: 3, truncated: false }]
        });
        const handle = openFilePreview('src/big.ts', { read });
        await flush();

        const code = dialog().querySelector('.preview-code code');
        expect(code?.textContent).toBe(huge);
        // Plain escaped text: no highlight token anywhere (the rows themselves are
        // spans, so the assertion looks INSIDE a row), and the tail survives.
        expect(previewFrame().querySelector('.code-line span')).toBeNull();
        // `line / line / TAIL` — the tail is a real row, not a dropped suffix.
        expect(rowsOf(previewFrame())).toHaveLength(3);
        expect(rowsOf(previewFrame())[2]?.textContent).toBe('TAIL');
        handle.close();
    });

    it('declares the wrapped payload rules in its own stylesheet', () => {
        // R1: the preview wraps like every other dialog payload — the block stops
        // preserving whitespace, the rows do, and there is nothing left to scroll
        // sideways into. The old `white-space: pre` + sideways scrollbar is gone.
        const frame = blockOf('.preview-file .preview-code.code-block {');
        expect(frame).toContain('max-height: 68vh');
        expect(frame).toContain('overflow-x: hidden');
        expect(frame).toContain('overflow-y: auto');
        expect(frame).toContain('white-space: normal');
        expect(frame).not.toContain('overflow-x: auto');
        expect(frame).not.toMatch(/white-space:\s*pre(?!-wrap)/);

        // The text column is the scrollport's width, NOT `max-content`: a max-content
        // box would size itself to the longest source line and re-open the horizontal
        // scroll the row wrap just removed. The counter still resets once per pane, and
        // `ui/file-preview.ts` overrides it inline for a paged window.
        const text = blockOf('.preview-file .preview-code.code-block code {');
        expect(text).toContain('counter-reset: code-line');
        expect(text).toContain('font-variant-numeric: tabular-nums');
        expect(text).toContain('white-space: normal');
        expect(text).not.toContain('width: max-content');

        // One row per LOGICAL line, wrapped: `pre-wrap` keeps the source's own
        // indentation and `anywhere` breaks a token that has no break opportunity at
        // all, which is the 200-column path/URL case the pane used to scroll through.
        const row = blockOf('.preview-file .preview-code .code-line {');
        expect(row).toContain('white-space: pre-wrap');
        expect(row).toContain('overflow-wrap: anywhere');
        expect(row).toContain('var(--code-gutter');

        // The number is generated content (never in `textContent`, never selectable,
        // never copied) and it sits in the ROW'S PADDING against its own first visual
        // line, so a wrapped continuation line flows in the text column. Absolute, not
        // sticky: with the wrap there is no sideways scroll to stay pinned to.
        const gutter = blockOf('.preview-file .preview-code .code-line::before {');
        expect(gutter).toContain('content: counter(code-line)');
        expect(gutter).toContain('position: absolute');
        expect(gutter).toContain('top: 0');
        expect(gutter).toContain('left: 1px');
        expect(gutter).toContain('width: var(--code-gutter, 2ch)');
        expect(gutter).toContain('text-align: right');
        expect(gutter).toContain('user-select: none');
        expect(gutter).not.toContain('position: sticky');
    });
});

// --- bare-basename resolution ------------------------------------------------

describe('basename resolution', () => {
    const readable: FilePreviewReader = async () => ({
        files: [{ content: 'export const answer = 42;\n', startLine: 1, endLine: 1, truncated: false }]
    });

    it('reads and titles the single resolved path for a bare name', async () => {
        const read = vi.fn<FilePreviewReader>(readable);
        const resolve = vi.fn<FilePreviewResolver>(async () => [
            'packages/underload/harness/src/frontend/ui/descriptors.ts'
        ]);

        const handle = openFilePreview('descriptors.ts', { read, resolve });
        // The loading line names the step that is actually running.
        expect(dialog().querySelector('.preview-status')?.textContent).toBe(
            'Looking for descriptors.ts in the workspace…'
        );
        await flushAll();

        expect(resolve).toHaveBeenCalledWith('descriptors.ts');
        expect(read).toHaveBeenCalledWith({
            path: 'packages/underload/harness/src/frontend/ui/descriptors.ts',
            startLine: 1,
            maxLines: FILE_PREVIEW_MAX_LINES
        });
        // Title and caption both show the file that is on screen, not the typed name.
        expect(dialog().querySelector('.dialog-title')?.textContent).toBe(
            'packages/underload/harness/src/frontend/ui/descriptors.ts'
        );
        expect(dialog().querySelector('.preview-meta')?.textContent).toBe(
            'packages/underload/harness/src/frontend/ui/descriptors.ts · typescript · lines 1–1'
        );
        expect(dialog().querySelector('.preview-candidate')).toBeNull();
        handle.close();
    });

    it('lists every candidate and reads nothing when the name is ambiguous', async () => {
        const read = vi.fn<FilePreviewReader>(readable);
        const resolve = vi.fn<FilePreviewResolver>(async () => [
            'src/a/deep/descriptors.ts',
            'descriptors.ts',
            'src/b/descriptors.ts',
            'src/b/descriptors.ts'
        ]);

        const handle = openFilePreview('descriptors.ts', { read, resolve });
        await flushAll();

        // No blind read: the dialog is asking a question, not guessing.
        expect(read).not.toHaveBeenCalled();
        expect(dialog().querySelector('.preview-code')).toBeNull();
        expect(dialog().querySelector('.dialog-title')?.textContent).toBe('descriptors.ts · 3 files');
        expect(dialog().querySelector('.preview-meta')?.textContent).toBe(
            '3 files named descriptors.ts. Pick one to preview:'
        );

        // Deduped, and ordered shallowest-first so the likeliest file is on top.
        const buttons = [...dialog().querySelectorAll<HTMLButtonElement>('.preview-candidate')];
        expect(buttons.map((button) => button.dataset.path)).toEqual([
            'descriptors.ts',
            'src/b/descriptors.ts',
            'src/a/deep/descriptors.ts'
        ]);
        expect(buttons.map((button) => button.textContent)).toEqual([
            'descriptors.ts',
            'src/b/descriptors.ts',
            'src/a/deep/descriptors.ts'
        ]);
        // The transcript's own link style, so these read as paths rather than new chrome.
        expect(buttons[0]?.className).toBe('file-link preview-candidate');
        expect(dialog().querySelector('.preview-candidates')).not.toBeNull();

        // Choosing one re-uses this dialog (no second modal) and reads that path.
        buttons[1]?.click();
        await flushAll();

        expect(document.querySelectorAll('.dialog')).toHaveLength(1);
        expect(read).toHaveBeenCalledWith({
            path: 'src/b/descriptors.ts',
            startLine: 1,
            maxLines: FILE_PREVIEW_MAX_LINES
        });
        expect(dialog().querySelector('.dialog-title')?.textContent).toBe('src/b/descriptors.ts');
        expect(dialog().querySelector('.preview-candidate')).toBeNull();
        expect(dialog().querySelector('.preview-code code')?.textContent).toBe(
            'export const answer = 42;\n'
        );
        handle.close();
    });

    it('states a not-found instead of reading a path that cannot exist', async () => {
        const read = vi.fn<FilePreviewReader>(readable);
        const resolve = vi.fn<FilePreviewResolver>(async () => ['src/a/other-descriptors.ts']);

        const handle = openFilePreview('descriptors.ts', { read, resolve });
        await flushAll();

        // A substring hit is a DIFFERENT file, so the search still found nothing.
        expect(read).not.toHaveBeenCalled();
        expect(dialog().querySelector('.preview-error')?.textContent).toBe(
            'descriptors.ts was not found under the workspace root; the reference may be incomplete.'
        );
        expect(dialog().querySelector('.preview-code')).toBeNull();
        handle.close();
    });

    it('ignores candidate entries that are unsafe, duplicated or not the named file', async () => {
        const read = vi.fn<FilePreviewReader>(readable);
        const resolve = vi.fn<FilePreviewResolver>(async () => [
            'src/x/A.ts', // case differs: a different file
            '/abs/src/a.ts', // absolute -> refused
            'C:/x/a.ts', // drive -> refused
            '../up/a.ts', // traversal -> refused
            'src/ok/a.ts',
            'src/ok/a.ts', // duplicate
            'src/other/a.ts'
        ]);

        const handle = openFilePreview('a.ts', { read, resolve });
        await flushAll();

        // Two survivors, ordered shallowest-first.
        expect(read).not.toHaveBeenCalled();
        expect([...dialog().querySelectorAll<HTMLButtonElement>('.preview-candidate')].map((button) => button.dataset.path)).toEqual([
            'src/ok/a.ts',
            'src/other/a.ts'
        ]);
        handle.close();
    });

    it('falls back to the typed path when the workspace walk fails', async () => {
        const read = vi.fn<FilePreviewReader>(async () => ({
            files: [
                {
                    content: '',
                    startLine: 1,
                    endLine: 0,
                    error: { message: 'read could not find "descriptors.ts": no such file or directory (ENOENT).' }
                }
            ]
        }));
        const resolve = vi.fn<FilePreviewResolver>(async () => {
            throw new Error('the glob tool is not available');
        });

        const handle = openFilePreview('descriptors.ts', { read, resolve });
        await flushAll();

        // A failed search says nothing about the file, so the server answer stands.
        expect(read).toHaveBeenCalledWith({ path: 'descriptors.ts', startLine: 1, maxLines: 200 });
        expect(dialog().querySelector('.preview-error')?.textContent).toBe(
            'read could not find "descriptors.ts": no such file or directory (ENOENT).'
        );
        handle.close();
    });

    it('reads a bare name directly and keeps the ENOENT state when no resolver is wired', async () => {
        const read = vi.fn<FilePreviewReader>(async () => ({
            files: [
                {
                    content: '',
                    startLine: 1,
                    endLine: 0,
                    error: { message: 'read could not find "descriptors.ts": no such file or directory (ENOENT).' }
                }
            ]
        }));

        const handle = openFilePreview('descriptors.ts', { read });
        expect(dialog().querySelector('.preview-status')?.textContent).toBe('Reading file…');
        await flush();

        expect(read).toHaveBeenCalledWith({ path: 'descriptors.ts', startLine: 1, maxLines: 200 });
        expect(dialog().querySelector('.preview-error')?.textContent).toBe(
            'read could not find "descriptors.ts": no such file or directory (ENOENT).'
        );
        handle.close();
    });

    it('drops a resolution that arrives after the dialog was closed', async () => {
        let settle: ((value: readonly string[]) => void) | undefined;
        const read = vi.fn<FilePreviewReader>(readable);
        const resolve: FilePreviewResolver = () =>
            new Promise((done) => {
                settle = done;
            });

        const handle = openFilePreview('descriptors.ts', { read, resolve });
        handle.close();

        settle?.(['src/a/descriptors.ts']);
        await flushAll();

        expect(read).not.toHaveBeenCalled();
        expect(document.querySelector('.dialog')).toBeNull();
    });
});

// --- the resolver contract the shell implements ------------------------------

describe('filePreviewGlobPattern / filePreviewCandidatesOf', () => {
    it('asks glob for the name at any depth', () => {
        // `**/` may consume ZERO directories, so this pattern also matches a
        // workspace-root file (ui/file-preview-glob.test.ts proves it with the real
        // tool); a separate `[name]` fallback pattern is therefore dead weight.
        expect(filePreviewGlobPattern('descriptors.ts')).toEqual(['**/descriptors.ts']);
        expect(filePreviewGlobPattern('main.ts')).toEqual(['**/main.ts']);
    });

    it('keeps exact matches only and orders them shallowest-first', () => {
        expect(
            filePreviewCandidatesOf('a.ts', [
                'src/x/a.ts',
                'a.ts',
                'src/a.ts',
                'src/y/a.ts',
                'src/y/a.ts', // duplicate
                'b.ts', // different file
                'src/A.ts', // case-sensitive basename match
                'src/x/old-a.ts', // substring hit
                '/abs/a.ts', // refused by localFilePathOf
                '../a.ts',
                42 // not a string
            ])
        ).toEqual(['a.ts', 'src/a.ts', 'src/x/a.ts', 'src/y/a.ts']);
    });

    it('answers an empty list for a search with no usable entry', () => {
        expect(filePreviewCandidatesOf('a.ts', undefined)).toEqual([]);
        expect(filePreviewCandidatesOf('a.ts', [])).toEqual([]);
        expect(filePreviewCandidatesOf('a.ts', ['src/b.ts', 7])).toEqual([]);
    });
});

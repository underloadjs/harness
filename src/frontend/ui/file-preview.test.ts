// File-preview dialog contract (R11).
//
// Pins the bounded request, escaped rendering, truncation/error states and the
// late-result-after-close safety of ui/file-preview.ts.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/file-preview.test.ts

import { describe, expect, it, vi } from 'vitest';
import { FILE_PREVIEW_MAX_LINES, openFilePreview } from './file-preview';
import type { FilePreviewReader } from './file-preview';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const dialog = (): HTMLElement => {
    const found = document.querySelector<HTMLElement>('.dialog');
    if (found === null) throw new Error('missing dialog');
    return found;
};

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
        expect(dialog().querySelector('.preview-meta')?.textContent).toBe('src/main.ts · lines 1–2');

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
                    error: { message: 'fileRead could not find "missing.ts": no such file or directory (ENOENT).' }
                }
            ],
            truncated: false
        });

        const handle = openFilePreview('missing.ts', { read });
        await flush();

        expect(dialog().querySelector('.preview-error')?.textContent).toBe(
            'fileRead could not find "missing.ts": no such file or directory (ENOENT).'
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

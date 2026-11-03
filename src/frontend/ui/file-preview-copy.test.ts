// R5 — the file preview dialog copies the file window it displays.
//
// The Copy control appears only after readable content arrives (loading/error/empty
// states have nothing meaningful to copy) and writes the exact previewed text, not
// the range caption or line numbers. R11+ adds two surfaces with the same rule: the
// gutter numbers of the editor view are CSS counters, so they never reach the
// clipboard, and an ambiguous-basename candidate list has no Copy until the reader
// picks a file.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/file-preview-copy.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilePreviewReader } from './file-preview';
import { openFilePreview } from './file-preview';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// A basename lookup adds microtask hops before the read lands; two ticks drains the
// whole resolver -> read -> render chain.
const flushAll = async (): Promise<void> => {
    await flush();
    await flush();
};

const setClipboard = (writeText: ((text: string) => Promise<void>) | undefined): void => {
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: writeText === undefined ? undefined : { writeText }
    });
};

const setExecCommand = (implementation: ((command: string) => boolean) | undefined): void => {
    Object.defineProperty(document, 'execCommand', { configurable: true, value: implementation });
};

const copyButton = (): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>('.dialog .dialog-copy');

beforeEach(() => {
    document.body.innerHTML = '';
    setClipboard(undefined);
    setExecCommand(undefined);
});

afterEach(() => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('.dialog-close')) button.click();
    document.body.innerHTML = '';
    setClipboard(undefined);
    setExecCommand(undefined);
});

describe('file preview copy', () => {
    it('copies the exact previewed window after the file loads', async () => {
        const content = 'const answer = 42;\nconsole.log(answer);\n';
        const writeText = vi.fn(async () => undefined);
        setClipboard(writeText);
        const read: FilePreviewReader = async () => ({
            files: [{ content, startLine: 1, endLine: 2, truncated: false }]
        });

        openFilePreview('src/main.ts', { read });
        expect(copyButton()).toBeNull();

        await flush();

        // T1/R3: the shared control is an icon button — no visible word before the
        // first activation, a stable accessible name, and a hidden live child.
        expect(copyButton()?.textContent).toBe('');
        expect(copyButton()?.querySelector('svg.dialog-copy-icon > path')).not.toBeNull();
        expect(copyButton()?.getAttribute('aria-label')).toBe('Copy dialog contents');
        copyButton()?.click();
        await flush();

        expect(writeText).toHaveBeenCalledWith(content);
        expect(copyButton()?.querySelector('.dialog-copy-feedback')?.textContent).toBe('Copied');
    });

    it('has no Copy action for an error or an empty window', async () => {
        const read: FilePreviewReader = async (request) =>
            request.path === 'missing.ts'
                ? {
                      files: [
                          {
                              content: '',
                              startLine: 1,
                              endLine: 0,
                              error: { message: 'read could not find "missing.ts".' }
                          }
                      ]
                  }
                : { files: [{ content: '', startLine: 1, endLine: 1 }] };

        const missing = openFilePreview('missing.ts', { read });
        await flush();
        expect(copyButton()).toBeNull();
        missing.close();

        const empty = openFilePreview('empty.ts', { read });
        await flush();
        expect(document.querySelector('.preview-empty')?.textContent).toBe(
            'This file has no text in the requested window.'
        );
        expect(copyButton()).toBeNull();
        empty.close();
    });

    // R11+: the code view is line-numbered, and the numbers are CSS generated
    // content. Copy still writes the WINDOW, so the gutter never becomes part of the
    // payload the reader pastes somewhere else.
    it('copies the window without the gutter numbers it displays', async () => {
        const content = 'const answer = 42;\nconsole.log(answer);\n';
        const writeText = vi.fn(async () => undefined);
        setClipboard(writeText);
        const read: FilePreviewReader = async () => ({
            files: [{ content, startLine: 1, endLine: 2, truncated: false }]
        });

        openFilePreview('src/main.ts', { read });
        await flush();

        // The numbered rows are on screen (3 logical lines: two statements plus the
        // empty line the trailing '\n' leaves)…
        expect(document.querySelectorAll('.preview-code .code-line')).toHaveLength(3);
        expect(document.querySelector('.preview-code code')?.textContent).toBe(content);

        copyButton()?.click();
        await flush();

        // …and the clipboard holds the file text, with no `1`/`2`/`3` in it.
        expect(writeText).toHaveBeenCalledWith(content);
    });

    // R11+: an ambiguous basename is a QUESTION first (`Copy` would have nothing to
    // copy), and the file chosen from the list is what the control then writes.
    it('has no Copy for a candidate list and copies the file that gets picked', async () => {
        const content = 'export const picked = true;\n';
        const writeText = vi.fn(async () => undefined);
        setClipboard(writeText);
        const read: FilePreviewReader = async () => ({
            files: [{ content, startLine: 1, endLine: 1, truncated: false }]
        });

        openFilePreview('descriptors.ts', {
            read,
            resolve: async () => ['src/a/descriptors.ts', 'src/b/descriptors.ts']
        });
        await flushAll();

        expect(copyButton()).toBeNull();

        const candidates = [...document.querySelectorAll<HTMLButtonElement>('.preview-candidate')];
        expect(candidates).toHaveLength(2);
        candidates[1]?.click();
        await flushAll();

        copyButton()?.click();
        await flush();

        expect(writeText).toHaveBeenCalledWith(content);
        expect(document.querySelector('.preview-code code')?.textContent).toBe(content);
    });
});

// R5 — the file preview dialog copies the file window it displays.
//
// The Copy control appears only after readable content arrives (loading/error/empty
// states have nothing meaningful to copy) and writes the exact previewed text, not
// the range caption or line numbers.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/file-preview-copy.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FilePreviewReader } from './file-preview';
import { openFilePreview } from './file-preview';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

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

        expect(copyButton()?.textContent).toBe('Copy');
        copyButton()?.click();
        await flush();

        expect(writeText).toHaveBeenCalledWith(content);
        expect(copyButton()?.textContent).toBe('Copied');
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
                              error: { message: 'fileRead could not find "missing.ts".' }
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
});

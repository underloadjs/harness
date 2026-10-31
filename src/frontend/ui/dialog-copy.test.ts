// R5 — shared Copy action for data-inspection dialogs.
//
// Pins the exact feedback contract (Copy -> Copied / Copy failed), the live source
// evaluation, the async Clipboard API path, the textarea/execCommand fallback, and
// the optional add/remove behaviour used by asynchronously loaded previews.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/dialog-copy.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDialogHost } from './dialog';
import type { DialogCopySource, DialogHost } from './dialog';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const paragraph = (text: string): HTMLElement => {
    const node = document.createElement('p');
    node.textContent = text;
    return node;
};

// jsdom's navigator has no clipboard by default. Define/restore an own property so
// each test states exactly which clipboard path is available.
const setClipboard = (writeText: ((text: string) => Promise<void>) | undefined): void => {
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: writeText === undefined ? undefined : { writeText }
    });
};

const setExecCommand = (implementation: ((command: string) => boolean) | undefined): void => {
    Object.defineProperty(document, 'execCommand', {
        configurable: true,
        value: implementation
    });
};

const copyButton = (host: DialogHost): HTMLButtonElement | null =>
    host.top?.element.querySelector<HTMLButtonElement>('.dialog-copy') ?? null;

let host: DialogHost;

beforeEach(() => {
    document.body.innerHTML = '';
    document.body.style.overflow = '';
    host = createDialogHost();
    setClipboard(undefined);
    setExecCommand(undefined);
});

afterEach(() => {
    host.closeAll();
    document.body.innerHTML = '';
    document.body.style.overflow = '';
    setClipboard(undefined);
    setExecCommand(undefined);
});

describe('dialog copy action', () => {
    it('stays absent unless the dialog opts in', () => {
        host.open({ title: 'Plain', content: paragraph('no copy here') });

        expect(copyButton(host)).toBeNull();
        expect(host.top?.element.querySelectorAll('.dialog-head > *')).toHaveLength(2);
    });

    it('writes the exact source through the async Clipboard API and reports success', async () => {
        const writeText = vi.fn(async () => undefined);
        setClipboard(writeText);

        host.open({ title: 'Tool', content: paragraph('body'), copy: 'exact payload' });
        const button = copyButton(host);
        expect(button).not.toBeNull();
        expect(button?.textContent).toBe('Copy');
        expect(button?.getAttribute('aria-live')).toBe('polite');

        button?.click();
        await flush();

        expect(writeText).toHaveBeenCalledTimes(1);
        expect(writeText).toHaveBeenCalledWith('exact payload');
        expect(button?.textContent).toBe('Copied');
        expect(button?.dataset.state).toBe('success');
        // The dialog stays open: copying is not a dismiss action.
        expect(host.count).toBe(1);
    });

    it('evaluates a function source on every activation (live dialog contents)', async () => {
        const writeText = vi.fn(async () => undefined);
        setClipboard(writeText);

        let payload = 'first';
        const source: DialogCopySource = () => payload;
        host.open({ title: 'Live', content: paragraph('body'), copy: source });
        const button = copyButton(host);

        button?.click();
        await flush();
        payload = 'second';
        button?.click();
        await flush();

        expect(writeText.mock.calls).toEqual([['first'], ['second']]);
        expect(button?.textContent).toBe('Copied');
    });

    it('reports failure when both clipboard paths fail', async () => {
        setClipboard(async () => {
            throw new Error('permission denied');
        });
        setExecCommand(() => false);

        host.open({ title: 'Tool', content: paragraph('body'), copy: 'nope' });
        copyButton(host)?.click();
        await flush();

        expect(copyButton(host)?.textContent).toBe('Copy failed');
        expect(copyButton(host)?.dataset.state).toBe('error');
    });

    it('falls back to the focused textarea + execCommand when the async API is unavailable', async () => {
        let captured: string | undefined;
        const execCommand = vi.fn((command: string) => {
            captured = document.querySelector<HTMLTextAreaElement>('.dialog-copy-buffer')?.value;
            return command === 'copy';
        });
        setExecCommand(execCommand);

        host.open({ title: 'Tool', content: paragraph('body'), copy: 'fallback payload' });
        copyButton(host)?.click();
        await flush();

        expect(execCommand).toHaveBeenCalledWith('copy');
        expect(captured).toBe('fallback payload');
        expect(document.querySelector('.dialog-copy-buffer')).toBeNull();
        expect(copyButton(host)?.textContent).toBe('Copied');
    });

    it('treats a throwing source as a failed copy without closing the dialog', async () => {
        setClipboard(vi.fn(async () => undefined));

        host.open({
            title: 'Broken',
            content: paragraph('body'),
            copy: () => {
                throw new Error('no data');
            }
        });
        copyButton(host)?.click();
        await flush();

        expect(copyButton(host)?.textContent).toBe('Copy failed');
        expect(host.count).toBe(1);
    });

    it('adds and removes Copy through update for an async preview', async () => {
        const writeText = vi.fn(async () => undefined);
        setClipboard(writeText);

        const handle = host.open({ title: 'File', content: paragraph('loading') });
        expect(copyButton(host)).toBeNull();

        handle.update({ content: paragraph('loaded'), copy: 'loaded text' });
        expect(copyButton(host)).not.toBeNull();
        // Copy sits before Close, so Close remains the last header control.
        const head = host.top?.element.querySelector('.dialog-head');
        expect(head?.lastElementChild?.classList.contains('dialog-close')).toBe(true);

        copyButton(host)?.click();
        await flush();
        expect(writeText).toHaveBeenCalledWith('loaded text');

        handle.update({ copy: null });
        expect(copyButton(host)).toBeNull();
        expect(host.top?.element.querySelectorAll('.dialog-head > *')).toHaveLength(2);
    });
});

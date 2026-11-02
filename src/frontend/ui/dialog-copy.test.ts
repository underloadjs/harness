// R5 — shared Copy action for data-inspection dialogs.
//
// Pins the exact feedback contract, the live source evaluation, the async Clipboard
// API path, the textarea/execCommand fallback (T1/R3: it must FOCUS the helper, because
// the plain-HTTP LAN deployment has no `navigator.clipboard` at all), and the optional
// add/remove behaviour used by asynchronously loaded previews.
//
// T1/R3: the control is an ICON button. Its accessible name/title are stable action
// text, the announced word is the hidden `role="status"` child, and success/failure
// also swaps the glyph (`data-state` drives the colour reinforcement) so feedback is
// never colour-only.
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

        // T1/R3: an ICON button. No visible word at idle (the glyph and its colour
        // carry the state), and the accessible name/title are stable action text so a
        // state change never renames the control.
        expect(button?.textContent).toBe('');
        expect(button?.querySelector('svg.dialog-copy-icon > path')).not.toBeNull();
        expect(button?.getAttribute('aria-label')).toBe('Copy dialog contents');
        expect(button?.title).toBe('Copy the dialog contents to the clipboard');
        expect(button?.hasAttribute('aria-live')).toBe(false);
        const feedback = button?.querySelector<HTMLElement>('.dialog-copy-feedback');
        expect(feedback?.getAttribute('aria-live')).toBe('polite');
        expect(feedback?.getAttribute('role')).toBe('status');
        expect(feedback?.textContent).toBe('');
        const idlePath = button?.querySelector('svg.dialog-copy-icon > path')?.getAttribute('d');

        button?.click();
        await flush();

        expect(writeText).toHaveBeenCalledTimes(1);
        expect(writeText).toHaveBeenCalledWith('exact payload');
        // Success feedback: the glyph changes, the live word announces the result, and
        // `data-state` drives the border/colour reinforcement.
        const successPath = button?.querySelector('svg.dialog-copy-icon > path')?.getAttribute('d');
        expect(successPath).toBeDefined();
        expect(successPath).not.toBe(idlePath);
        expect(feedback?.textContent).toBe('Copied');
        expect(button?.dataset.state).toBe('success');
        expect(button?.title).toBe('Copied to the clipboard');
        // The dialog stays open: copying is not a dismiss action.
        expect(host.count).toBe(1);
    });

    it('keeps the accessible name and swaps the glyph on a failed copy', async () => {
        setClipboard(async () => {
            throw new Error('permission denied');
        });
        setExecCommand(() => false);

        host.open({ title: 'Tool', content: paragraph('body'), copy: 'nope' });
        const button = copyButton(host);
        const idlePath = button?.querySelector('svg.dialog-copy-icon > path')?.getAttribute('d');
        button?.click();
        await flush();

        const failurePath = button?.querySelector('svg.dialog-copy-icon > path')?.getAttribute('d');
        expect(failurePath).toBeDefined();
        expect(failurePath).not.toBe(idlePath);
        expect(button?.querySelector('.dialog-copy-feedback')?.textContent).toBe('Copy failed');
        expect(button?.dataset.state).toBe('error');
        // The name never changed, so a reader is never told the button became "Copy failed".
        expect(button?.getAttribute('aria-label')).toBe('Copy dialog contents');
    });

    // T1/R3 REGRESSION: the deployed UI is also served over plain HTTP on the LAN
    // static host (src/frontend/deployment.ts), where `navigator.clipboard` does not
    // exist AT ALL, so every copy went through this fallback. `execCommand('copy')`
    // copies the selection of the FOCUSED control; the old code only called
    // `area.select()` while the dialog panel held focus, so it copied nothing and still
    // reported success. The modal focus trap is the other half: it drags focus out of
    // the helper back into the panel, which is why the workaround needs the trap held
    // open for the duration of the command.
    it('falls back to the focused textarea + execCommand when the async API is unavailable', async () => {
        let captured: { value: string | undefined; focused: boolean; start: number; end: number } | undefined;
        const execCommand = vi.fn((command: string) => {
            const area = document.querySelector<HTMLTextAreaElement>('.dialog-copy-buffer');
            captured = {
                value: area?.value,
                // The proof the trap did not steal focus back before the command ran.
                focused: document.activeElement === area,
                start: area?.selectionStart ?? -1,
                end: area?.selectionEnd ?? -1
            };
            return command === 'copy';
        });
        setExecCommand(execCommand);

        host.open({ title: 'Tool', content: paragraph('body'), copy: 'fallback payload' });
        const panel = host.top?.element;
        const button = copyButton(host);
        button?.click();
        await flush();

        // The whole payload, in a focused helper, selected start-to-end.
        expect(captured).toEqual({ value: 'fallback payload', focused: true, start: 0, end: 16 });
        expect(execCommand).toHaveBeenCalledWith('copy');
        // Cleanup: no leftover buffer, and focus is back on the dialog panel.
        expect(document.querySelector('.dialog-copy-buffer')).toBeNull();
        expect(document.activeElement).toBe(panel ?? document.body);
        expect(button?.querySelector('.dialog-copy-feedback')?.textContent).toBe('Copied');
        expect(button?.dataset.state).toBe('success');
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

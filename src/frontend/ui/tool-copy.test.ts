// R3 — every tool pane copies its OWN payload, and the tool dialog has no
// dialog-level Copy any more.
//
// What is pinned here:
//   - the tool detail dialog has NO `.dialog-copy` header action at all (the header
//     keeps title + close only); every OTHER dialog still gets one, and those paths
//     are pinned by dialog-copy.test.ts / file-preview-copy.test.ts;
//   - each pane heading carries an icon button whose accessible name says which pane
//     it copies, and clicking it writes ONLY that pane's ORIGINAL payload — full,
//     untruncated, never concatenated with the tool name, the state word or the other
//     pane;
//   - the payload is resolved at CLICK time, so a dialog opened while the call is
//     still running copies the settled result (or the interruption reason) that is on
//     screen, not the pending placeholder;
//   - the write goes through the shared ui/dialog.ts clipboard path, including the
//     textarea/execCommand fallback the plain-HTTP LAN origin needs;
//   - success/failure feedback is the shared icon + hidden live word, and a failed
//     write leaves the dialog open.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/tool-copy.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolCallCard } from './tools';
import { createToolCallCard } from './tools';

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

const mount = (card: ToolCallCard): ToolCallCard => {
    document.body.append(card.element);
    return card;
};

const openDialog = (card: ToolCallCard): void => {
    const summary = card.element.querySelector<HTMLElement>('summary');
    if (summary === null) throw new Error('missing summary');
    summary.click();
};

const dialog = (): HTMLElement => {
    const panel = document.querySelector<HTMLElement>('.dialog');
    if (panel === null) throw new Error('no open dialog');
    return panel;
};

// The pane controls are addressed by their accessible names, because that name is
// part of the requirement (an assistive tech user must know WHICH pane a press
// copies) and it is the only stable handle: the label text itself changes with state.
const paneButton = (label: string): HTMLButtonElement => {
    const button = document.querySelector<HTMLButtonElement>(`.dialog [aria-label="${label}"]`);
    if (button === null) throw new Error(`missing copy button for ${label}`);
    return button;
};

const argumentsButton = (): HTMLButtonElement => paneButton('Copy arguments');
const resultButton = (): HTMLButtonElement => paneButton('Copy result');

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

describe('tool pane copy', () => {
    it('replaces the dialog-level Copy with one control per pane heading', () => {
        setClipboard(vi.fn(async () => undefined));
        const card = mount(createToolCallCard('read', '{"paths":["a.ts"]}'));
        openDialog(card);

        // No whole-dialog action anywhere in the tool dialog: `copyPayload` (the
        // combined Tool/State/Arguments/Result record) is gone from this path only.
        expect(document.querySelectorAll('.dialog .dialog-copy')).toHaveLength(0);
        expect(dialog()?.querySelectorAll('.dialog-head > *')).toHaveLength(2);
        expect(dialog().querySelector('.dialog-title')?.textContent).toBe('read · running');
        expect(dialog().querySelector('.dialog-close')).not.toBeNull();

        // Each heading is `label + icon`, and the button is a SIBLING of the label so
        // the label text stays exactly `arguments` / `result · pending`.
        const headings = dialog().querySelectorAll<HTMLElement>('.tool-heading');
        expect(headings).toHaveLength(2);
        expect(headings[0]?.querySelector('.tool-label')?.textContent).toBe('arguments');
        expect(headings[1]?.querySelector('.tool-label')?.textContent).toBe('result · pending');
        for (const [index, button] of [argumentsButton(), resultButton()].entries()) {
            expect(headings[index]?.contains(button)).toBe(true);
            expect(button.className).toBe('text-copy tool-copy');
            expect(button.type).toBe('button');
            // The shared icon button: inline SVG glyph plus the hidden live word.
            expect(button.querySelector('svg.dialog-copy-icon > path')).not.toBeNull();
            expect(button.querySelector('.dialog-copy-feedback')?.textContent).toBe('');
            expect(button.dataset.state).toBeUndefined();
            expect(button.title).toBe(index === 0 ? 'Copy arguments' : 'Copy result');
        }
    });

    it('copies only the arguments pane, byte for byte, while the result is pending', async () => {
        const writeText = vi.fn(async () => undefined);
        setClipboard(writeText);
        const raw = '{"paths":["a.ts"],"limit":12}';
        const card = mount(createToolCallCard('read', raw));
        openDialog(card);

        argumentsButton().click();
        await flush();

        // The ORIGINAL payload: exactly what the model sent. Not the pretty-printed
        // view, not the `Tool:`/`State:` record, and not the result pane.
        expect(writeText).toHaveBeenCalledTimes(1);
        expect(writeText).toHaveBeenCalledWith(raw);

        resultButton().click();
        await flush();
        expect(writeText).toHaveBeenNthCalledWith(2, 'Waiting for the harness to run this call…');
    });

    it('copies the settled result fresh when the call resolves behind an open dialog', async () => {
        const writeText = vi.fn(async () => undefined);
        setClipboard(writeText);
        const card = mount(createToolCallCard('read', '{"paths":["a.ts"]}'));
        openDialog(card);

        resultButton().click();
        await flush();
        expect(writeText).toHaveBeenNthCalledWith(1, 'Waiting for the harness to run this call…');

        const payload = '{"ok":true,"rows":[{"id":"1"}]}';
        card.resolve(payload, 'completed', 1500);

        expect(dialog().querySelectorAll('.tool-heading')[1]?.querySelector('.tool-label')?.textContent)
            .toBe('result');

        resultButton().click();
        await flush();
        // Full and untruncated, with the JSON exactly as the tool answered it — the
        // pane on screen shows the pretty-printed, line-numbered view of the same text.
        expect(writeText).toHaveBeenNthCalledWith(2, payload);
        expect(dialog().querySelector('.tool-result code')?.textContent).toBe(
            '{\n  "ok": true,\n  "rows": [\n    {\n      "id": "1"\n    }\n  ]\n}'
        );

        // Arguments are unaffected by the result arriving.
        argumentsButton().click();
        await flush();
        expect(writeText).toHaveBeenNthCalledWith(3, '{"paths":["a.ts"]}');
        expect(resultButton().querySelector('.dialog-copy-feedback')?.textContent).toBe('Copied');
        expect(resultButton().dataset.state).toBe('success');
    });

    it('copies a multi-line error result without any decoration', async () => {
        const writeText = vi.fn(async () => undefined);
        setClipboard(writeText);
        const card = mount(createToolCallCard('shell', '{"command":"build"}'));
        openDialog(card);
        card.resolve('exit code 1\nno such file or directory', 'failed');

        resultButton().click();
        await flush();

        expect(writeText).toHaveBeenCalledWith('exit code 1\nno such file or directory');
    });

    it('copies the placeholder for an empty answer', async () => {
        const writeText = vi.fn(async () => undefined);
        setClipboard(writeText);
        const card = mount(createToolCallCard('timeNow', ''));
        openDialog(card);
        card.resolve('', 'completed');

        resultButton().click();
        argumentsButton().click();
        await flush();

        expect(writeText).toHaveBeenNthCalledWith(1, '(empty result)');
        expect(writeText).toHaveBeenNthCalledWith(2, '');
    });

    it('copies the interruption reason when a call never returned', async () => {
        const writeText = vi.fn(async () => undefined);
        setClipboard(writeText);
        const card = mount(createToolCallCard('websearch', '{"q":"slow"}'));
        openDialog(card);

        card.abandon('Cancelled before the call returned.');
        resultButton().click();
        await flush();

        expect(writeText).toHaveBeenCalledWith('Cancelled before the call returned.');
    });

    it('keeps each card\'s panes pointed at their own payloads', async () => {
        const writeText = vi.fn(async () => undefined);
        setClipboard(writeText);
        const first = mount(createToolCallCard('read', '{"path":"a"}'));
        const second = mount(createToolCallCard('shell', '{"command":"ls"}'));

        first.resolve('A-RESULT', 'completed');
        second.resolve('B-RESULT', 'completed');

        openDialog(second);
        resultButton().click();
        await flush();
        expect(writeText).toHaveBeenNthCalledWith(1, 'B-RESULT');
        argumentsButton().click();
        await flush();
        expect(writeText).toHaveBeenNthCalledWith(2, '{"command":"ls"}');

        for (const button of document.querySelectorAll<HTMLButtonElement>('.dialog-close')) button.click();

        openDialog(first);
        resultButton().click();
        argumentsButton().click();
        await flush();
        expect(writeText).toHaveBeenNthCalledWith(3, 'A-RESULT');
        expect(writeText).toHaveBeenNthCalledWith(4, '{"path":"a"}');
    });

    it('writes through the textarea fallback when the clipboard API is absent (LAN origin)', async () => {
        // The harness UI is served over plain HTTP on the LAN, where
        // `navigator.clipboard` does not exist. The shared path has to FOCUS its own
        // helper and hold the modal focus trap open for the duration of the copy,
        // which is why the tool panes reuse ui/dialog.ts instead of rolling their own.
        setClipboard(undefined);
        const seen: string[] = [];
        Object.defineProperty(document, 'execCommand', {
            configurable: true,
            value: (command: string): boolean => {
                if (command !== 'copy') return false;
                const area = document.querySelector<HTMLTextAreaElement>('.dialog-copy-buffer');
                seen.push(area?.value ?? '');
                return true;
            }
        });

        const card = mount(createToolCallCard('read', '{"paths":["a.ts"]}'));
        card.resolve('RESULT-BY-FALLBACK', 'completed');
        openDialog(card);

        resultButton().click();
        await flush();

        expect(seen).toEqual(['RESULT-BY-FALLBACK']);
        // The helper is removed whatever the command answered.
        expect(document.querySelector('.dialog-copy-buffer')).toBeNull();
        expect(resultButton().querySelector('.dialog-copy-feedback')?.textContent).toBe('Copied');
        expect(resultButton().dataset.state).toBe('success');
    });

    it('reports a failed clipboard write without closing the dialog', async () => {
        setClipboard(async () => {
            throw new Error('permission denied');
        });
        setExecCommand(() => false);
        const card = mount(createToolCallCard('read', '{}'));
        openDialog(card);

        argumentsButton().click();
        await flush();

        expect(argumentsButton().querySelector('.dialog-copy-feedback')?.textContent).toBe('Copy failed');
        expect(argumentsButton().dataset.state).toBe('error');
        expect(document.querySelector('.dialog')).not.toBeNull();
        // The other pane keeps its neutral idle state: one failure is not both.
        expect(resultButton().dataset.state).toBeUndefined();
        expect(resultButton().querySelector('.dialog-copy-feedback')?.textContent).toBe('');
    });
});

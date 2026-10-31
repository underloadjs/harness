// R5 — the tool detail dialog copies its COMPLETE call record.
//
// The payload is self-describing (tool/state/arguments/result), uses the same
// pretty-printed data the boxes render, and is resolved at click time so an open
// dialog copies the settled result after `resolve`/`abandon`.
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

const copyButton = (): HTMLButtonElement => {
    const button = document.querySelector<HTMLButtonElement>('.dialog .dialog-copy');
    if (button === null) throw new Error('missing copy button');
    return button;
};

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

describe('tool dialog copy', () => {
    it('copies the pending call arguments and state, then the settled result', async () => {
        const writeText = vi.fn(async () => undefined);
        setClipboard(writeText);
        const card = mount(createToolCallCard('fileRead', '{"paths":["a.ts"]}'));
        openDialog(card);

        copyButton().click();
        await flush();

        expect(writeText).toHaveBeenNthCalledWith(
            1,
            [
                'Tool: fileRead',
                'State: running',
                '',
                'Arguments:',
                '{\n  "paths": [\n    "a.ts"\n  ]\n}',
                '',
                'Result:',
                'Waiting for the harness to run this call…'
            ].join('\n')
        );

        card.resolve('{"ok":true}', 'completed', 1500);
        copyButton().click();
        await flush();

        expect(writeText).toHaveBeenNthCalledWith(
            2,
            [
                'Tool: fileRead',
                'State: ok',
                '',
                'Arguments:',
                '{\n  "paths": [\n    "a.ts"\n  ]\n}',
                '',
                'Result:',
                '{\n  "ok": true\n}'
            ].join('\n')
        );
        expect(copyButton().textContent).toBe('Copied');
    });

    it('reports a failed clipboard write without closing the dialog', async () => {
        setClipboard(async () => {
            throw new Error('permission denied');
        });
        setExecCommand(() => false);
        const card = mount(createToolCallCard('fileRead', '{}'));
        openDialog(card);

        copyButton().click();
        await flush();

        expect(copyButton().textContent).toBe('Copy failed');
        expect(copyButton().dataset.state).toBe('error');
        expect(document.querySelector('.dialog')).not.toBeNull();
    });

    it('copies the interruption reason when a call never returned', async () => {
        const writeText = vi.fn(async () => undefined);
        setClipboard(writeText);
        const card = mount(createToolCallCard('websearch', '{"q":"slow"}'));
        openDialog(card);

        card.abandon('Cancelled before the call returned.');
        copyButton().click();
        await flush();

        expect(writeText).toHaveBeenCalledWith(
            [
                'Tool: websearch',
                'State: cancelled',
                '',
                'Arguments:',
                '{\n  "q": "slow"\n}',
                '',
                'Result:',
                'Cancelled before the call returned.'
            ].join('\n')
        );
    });
});

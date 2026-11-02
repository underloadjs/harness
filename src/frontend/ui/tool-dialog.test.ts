// Tool-call detail dialog (R12): a chip activation opens a modal instead of
// expanding inline. These tests pin the exact DOM/behaviour contract:
//   - click and Enter/Space open the dialog and the `<details>` stays closed;
//   - the SAME live body node moves into `.dialog-body` (no clone) and returns to
//     the closed card on close, so arguments/result/error are always readable;
//   - `resolve`/`abandon` update an already-open dialog (streaming -> settled);
//   - close/reopen keeps the settled content and restores focus to that chip;
//   - independent cards restore their own chip, never the composer;
//   - `destroy` closes an orphaned dialog (no leaked focus trap/overlay);
//   - model-written markup in arguments/results stays escaped text;
//   - the dialog has NO whole-dialog Copy; each pane heading carries its own icon
//     (the payloads themselves are pinned in ui/tool-copy.test.ts);
//   - local paths in argument/result code become file links that request ONE
//     bounded `read` window on click (never automatically), through either an
//     injected reader or the default `callTool` adapter.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts

// The default adapter must be observed without a real network request. Only this
// test file mocks the API module; other suites import the real one.
vi.mock('../api', () => ({ callTool: vi.fn() }));

import { callTool } from '../api';
import type { ToolCallResult } from '../../server/protocol';
import type { FilePreviewReader } from './file-preview';
import { createToolCallCard, type ToolCallCard } from './tools';

// Let the preview dialog's promise chain (`read` -> `handle.update`) settle.
const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
};

// The card is appended so `returnFocus` (the summary) is a connected element and
// focus restoration is observable, exactly like a card in the transcript.
const mount = (card: ToolCallCard): ToolCallCard => {
    document.body.append(card.element);
    return card;
};

const summaryOf = (card: ToolCallCard): HTMLElement => {
    const summary = card.element.querySelector<HTMLElement>('summary');
    if (summary === null) throw new Error('missing summary');
    return summary;
};

const clickSummary = (card: ToolCallCard): MouseEvent => {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    summaryOf(card).dispatchEvent(event);
    return event;
};

const pressSummary = (card: ToolCallCard, key: string): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    summaryOf(card).dispatchEvent(event);
    return event;
};

const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('.dialog');

// A file preview stacks on top of the tool dialog, so the focused/current layer
// is the LAST `.dialog` in tree order.
const topDialog = (): HTMLElement | null => {
    const all = [...document.querySelectorAll<HTMLElement>('.dialog')];
    return all[all.length - 1] ?? null;
};

const closeDialog = (): void => {
    const button = dialog()?.querySelector<HTMLButtonElement>('.dialog-close');
    if (button === null || button === undefined) throw new Error('no open dialog to close');
    button.click();
};

beforeEach(() => {
    vi.mocked(callTool).mockReset();
});

// Every test must leave the document with no overlay and no fake clock: dialog.ts
// keeps module-level listeners/scroll-lock state, and a leaked layer would change
// the next test's top dialog.
afterEach(() => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('.dialog-close')) {
        button.click();
    }
    document.body.replaceChildren();
    vi.useRealTimers();
});

describe('tool detail dialog', () => {
    it('opens from a chip click without expanding the details inline', () => {
        const card = mount(createToolCallCard('read', '{"paths":["package.json"]}'));

        const event = clickSummary(card);

        // The native disclosure default was cancelled, so the chip never grows an
        // inline body; the dialog is the only detail surface.
        expect(event.defaultPrevented).toBe(true);
        expect(card.element.open).toBe(false);
        expect(card.element.querySelector('.tool-body')).toBeNull();

        expect(dialog()).not.toBeNull();
        expect(dialog()?.getAttribute('role')).toBe('dialog');
        expect(dialog()?.getAttribute('aria-modal')).toBe('true');
        expect(dialog()?.querySelector('.dialog-title')?.textContent).toBe('read · running');
        expect(dialog()?.querySelector('.tool-body')).not.toBeNull();
        expect(dialog()?.querySelectorAll('.tool-section code')[0]?.textContent).toBe(
            '{\n  "paths": [\n    "package.json"\n  ]\n}'
        );
        expect(dialog()?.querySelector('.tool-pending')?.textContent).toBe(
            'Waiting for the harness to run this call…'
        );
    });

    it('opens from Enter and Space while keeping the chip closed', () => {
        const card = mount(createToolCallCard('shell', '{"command":"true"}'));

        const enter = pressSummary(card, 'Enter');
        expect(enter.defaultPrevented).toBe(true);
        expect(dialog()?.querySelector('.dialog-title')?.textContent).toBe('shell · running');
        expect(card.element.open).toBe(false);

        closeDialog();
        expect(dialog()).toBeNull();

        const space = pressSummary(card, ' ');
        expect(space.defaultPrevented).toBe(true);
        expect(dialog()?.querySelector('.dialog-title')?.textContent).toBe('shell · running');
        expect(card.element.open).toBe(false);
    });

    it('cancels a native details toggle and keeps a single dialog on repeat activation', () => {
        const card = mount(createToolCallCard('read', '{}'));

        // Guard for anything that bypasses the click listener: a programmatic
        // `open` is reverted on the queued `toggle` event (jsdom/browsers queue it).
        vi.useFakeTimers();
        card.element.open = true;
        expect(card.element.open).toBe(true);
        vi.runAllTimers();
        expect(card.element.open).toBe(false);
        vi.useRealTimers();

        clickSummary(card);
        clickSummary(card);
        expect(document.querySelectorAll('.dialog')).toHaveLength(1);
    });

    it('updates an already-open dialog when the call resolves', () => {
        const card = mount(createToolCallCard('read', '{"paths":["package.json"]}'));
        const body = card.element.querySelector('.tool-body');
        clickSummary(card);

        // The SAME node was adopted (dialog.ts moves it), not cloned.
        expect(dialog()?.querySelector('.tool-body')).toBe(body);

        card.resolve('{"ok":true}', 'completed', 1500);

        expect(dialog()?.querySelector('.dialog-title')?.textContent).toBe('read · ok');
        expect(dialog()?.querySelectorAll('.tool-section .tool-label')[1]?.textContent).toBe('result');
        expect(dialog()?.querySelector('.tool-result code')?.textContent).toBe('{\n  "ok": true\n}');
        expect(card.element.querySelector('.tool-duration')?.textContent).toBe('1.5s');
        expect(card.element.getAttribute('data-state')).toBe('ok');
    });

    it('shows a full error result and the cancelled reason in an open dialog', () => {
        const failed = mount(createToolCallCard('shell', '{"command":"false"}'));
        clickSummary(failed);
        failed.resolve('exit code 1', 'failed');

        expect(dialog()?.querySelector('.dialog-title')?.textContent).toBe('shell · error');
        expect(dialog()?.querySelectorAll('.tool-label')[1]?.textContent).toBe('result · error');
        expect(dialog()?.querySelector('.tool-result code')?.textContent).toBe('exit code 1');
        closeDialog();

        const interrupted = mount(createToolCallCard('websearch', '{"q":"slow"}'));
        clickSummary(interrupted);
        interrupted.abandon('Cancelled before the call returned.');

        expect(dialog()?.querySelector('.dialog-title')?.textContent).toBe('websearch · cancelled');
        expect(dialog()?.querySelectorAll('.tool-label')[1]?.textContent).toBe('result · cancelled');
        expect(dialog()?.querySelector('.tool-pending')?.textContent).toBe(
            'Cancelled before the call returned.'
        );
    });

    it('returns the body to the closed card and reopens the same node', () => {
        const card = mount(createToolCallCard('read', '{"paths":["package.json"]}'));
        card.resolve('{"ok":true}', 'completed');
        const body = card.element.querySelector('.tool-body');

        clickSummary(card);
        expect(dialog()?.querySelector('.tool-body')).toBe(body);
        closeDialog();

        expect(dialog()).toBeNull();
        expect(card.element.open).toBe(false);
        expect(card.element.querySelector('.tool-body')).toBe(body);
        // Detail is still part of the card DOM (closed details hides it visually),
        // which is what transcript consumers read.
        expect(card.element.querySelector('.tool-result code')?.textContent).toBe('{\n  "ok": true\n}');

        clickSummary(card);
        expect(dialog()?.querySelector('.tool-body')).toBe(body);
        expect(dialog()?.querySelector('.tool-result code')?.textContent).toBe('{\n  "ok": true\n}');
        expect(dialog()?.querySelectorAll('.tool-section code')[0]?.textContent).toBe(
            '{\n  "paths": [\n    "package.json"\n  ]\n}'
        );
    });

    it('restores focus to the triggering chip of each card, never the composer', () => {
        const composer = document.createElement('textarea');
        composer.id = 'composer';
        document.body.append(composer);
        composer.focus();
        expect(document.activeElement).toBe(composer);

        const first = mount(createToolCallCard('read', '{}'));
        const second = mount(createToolCallCard('shell', '{}'));

        clickSummary(first);
        closeDialog();
        expect(document.activeElement).toBe(summaryOf(first));
        expect(document.activeElement).not.toBe(composer);

        clickSummary(second);
        closeDialog();
        expect(document.activeElement).toBe(summaryOf(second));
        expect(document.activeElement).not.toBe(composer);
    });

    it('closes an open dialog when the card is destroyed', () => {
        const card = mount(createToolCallCard('read', '{}'));
        const body = card.element.querySelector('.tool-body');
        clickSummary(card);
        expect(dialog()).not.toBeNull();

        card.destroy();

        expect(dialog()).toBeNull();
        expect(document.querySelector('.dialog-overlay')).toBeNull();
        // Cleanup also returns the shared body so a late resolve cannot write into
        // a detached overlay.
        expect(card.element.querySelector('.tool-body')).toBe(body);
        card.resolve('late result', 'completed');
        expect(card.element.querySelector('.tool-result code')?.textContent).toBe('late result');
    });

    it('shows the complete result past the highlighter cap', () => {
        // markdown.ts stops highlighting at 40k. The dialog is the only detail
        // surface now, so the tail must still be present as escaped text.
        const payload = `${'a'.repeat(40_005)}TAIL`;
        const card = mount(createToolCallCard('read', '{}'));
        card.resolve(payload, 'completed');
        clickSummary(card);

        const code = dialog()?.querySelector('.tool-result code');
        expect(code?.textContent).toBe(payload);
        // Above the cap the block is plain (no highlight spans) but complete, and the
        // only elements in it are the viewer's own row scaffolding — one logical line.
        expect(code?.innerHTML).toBe(`<span class="code-line">${payload}</span>`);
        expect(code?.querySelectorAll('.code-line')).toHaveLength(1);
        expect(code?.querySelectorAll('.code-break')).toHaveLength(0);
    });

    it('links local paths in argument/result code and previews only on click', async () => {
        const read = vi.fn<FilePreviewReader>(async () => ({
            files: [
                {
                    content: 'export const answer = 42;\n',
                    startLine: 1,
                    endLine: 1,
                    truncated: false,
                    nextLine: null
                }
            ],
            truncated: false
        }));
        const card = mount(
            createToolCallCard('read', '{"path":"src/frontend/main.ts"}', {}, { readFile: read })
        );
        card.resolve('also read src/frontend/tools.ts', 'completed');

        // Building/resolving a card never requests a file. The reader is dormant
        // until a link inside the open modal is activated.
        expect(read).not.toHaveBeenCalled();

        clickSummary(card);
        expect(read).not.toHaveBeenCalled();

        const argumentsCode = dialog()?.querySelectorAll('.tool-section code')[0];
        const argumentLink = argumentsCode?.querySelector<HTMLButtonElement>('button.file-link');
        expect(argumentLink?.dataset.path).toBe('src/frontend/main.ts');
        expect(argumentLink?.textContent).toBe('src/frontend/main.ts');
        // Syntax highlighting survived around the inserted link.
        expect(argumentsCode?.querySelector('.hljs-attr')?.textContent).toBe('"path"');

        const resultLink = dialog()?.querySelector<HTMLButtonElement>('.tool-result button.file-link');
        expect(resultLink?.dataset.path).toBe('src/frontend/tools.ts');
        expect(resultLink?.textContent).toBe('src/frontend/tools.ts');

        argumentLink?.click();
        await flush();

        expect(read).toHaveBeenCalledTimes(1);
        expect(read.mock.calls[0]?.[0]).toEqual({
            path: 'src/frontend/main.ts',
            startLine: 1,
            maxLines: 200
        });
        // The preview is a NEW top dialog; the tool detail remains underneath.
        expect(topDialog()?.querySelector('.dialog-title')?.textContent).toBe('src/frontend/main.ts');
        expect(topDialog()?.querySelector('.preview-code code')?.textContent).toBe(
            'export const answer = 42;\n'
        );
    });

    it('uses the bounded callTool read adapter when no reader is injected', async () => {
        vi.mocked(callTool).mockResolvedValueOnce({
            ok: true,
            result: {
                files: [
                    {
                        content: '# Doc\n',
                        startLine: 1,
                        endLine: 1,
                        truncated: false,
                        nextLine: null
                    }
                ],
                truncated: false
            }
        } as ToolCallResult);

        const card = mount(createToolCallCard('shell', '{"command":"cat README.md"}'));
        card.resolve('README.md', 'completed');
        clickSummary(card);

        const link = dialog()?.querySelector<HTMLButtonElement>('.tool-result button.file-link');
        expect(link?.dataset.path).toBe('README.md');
        link?.click();
        await flush();

        expect(vi.mocked(callTool)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(callTool)).toHaveBeenCalledWith('read', [
            { path: 'README.md', startLine: 1, maxLines: 200 }
        ]);
        expect(topDialog()?.querySelector('.preview-code code')?.textContent).toBe('# Doc\n');
    });

    it('never interprets tool code as Markdown images', () => {
        const card = mount(createToolCallCard('read', '{}'));
        card.resolve('![chart](https://example.com/a.png)', 'completed');
        clickSummary(card);

        const code = dialog()?.querySelector('.tool-result code');
        expect(code?.textContent).toBe('![chart](https://example.com/a.png)');
        // No Markdown parse, no `<img>`, no image-preview trigger: literal text.
        expect(dialog()?.querySelector('img')).toBeNull();
        expect(dialog()?.querySelector('.image-link')).toBeNull();
    });

    it('keeps model-written markup as escaped text in arguments and results', () => {
        const card = mount(
            createToolCallCard(
                'read',
                '{"path":"<img src=x onerror=\\"window.pwned=1\\">"}'
            )
        );
        card.resolve('<script>window.pwned=1</script>', 'failed');
        clickSummary(card);

        const argumentsCode = dialog()?.querySelectorAll('.tool-section code')[0];
        expect(argumentsCode?.textContent).toBe(
            '{\n  "path": "<img src=x onerror=\\"window.pwned=1\\">"\n}'
        );
        expect(argumentsCode?.querySelector('img')).toBeNull();

        const resultCode = dialog()?.querySelector('.tool-result code');
        expect(resultCode?.textContent).toBe('<script>window.pwned=1</script>');
        expect(resultCode?.querySelector('script')).toBeNull();
        expect(dialog()?.querySelector('script')).toBeNull();
        expect(dialog()?.querySelector('img')).toBeNull();
        expect((window as unknown as { pwned?: unknown }).pwned).toBeUndefined();
    });

    it('gives each pane heading its own copy icon and no dialog-level copy', () => {
        const card = mount(createToolCallCard('read', '{"paths":["a.ts"]}'));
        clickSummary(card);

        // R3: the tool dialog opts out of the whole-dialog Copy action entirely —
        // the header keeps only the title and the dismiss control.
        expect(dialog()?.querySelectorAll('.dialog-copy')).toHaveLength(0);
        expect(dialog()?.querySelectorAll('.dialog-head > *')).toHaveLength(2);

        const headings = dialog()?.querySelectorAll<HTMLElement>('.tool-heading');
        expect(headings).toHaveLength(2);
        expect(headings[0]?.querySelector('.tool-label')?.textContent).toBe('arguments');
        expect(headings[0]?.querySelector('.tool-copy')?.getAttribute('aria-label')).toBe(
            'Copy arguments'
        );
        expect(headings[1]?.querySelector('.tool-label')?.textContent).toBe('result · pending');
        expect(headings[1]?.querySelector('.tool-copy')?.getAttribute('aria-label')).toBe('Copy result');

        // The heading is the section's first child and the code view stays a DIRECT
        // child of `.tool-section`, which is what the dialog's height chain and
        // tool-chip-style.test.ts address.
        const sections = dialog()?.querySelectorAll<HTMLElement>('.tool-section');
        expect(sections?.[0]?.firstElementChild).toBe(headings?.[0] ?? null);
        expect(sections?.[0]?.lastElementChild?.className).toBe('code-block tool-code');
        expect(sections?.[1]?.lastElementChild?.className).toContain('tool-result');

        // Both icons are real tab stops of the modal, so the focus trap reaches them
        // (these are the exact criteria dialog.ts `focusablesWithin` applies).
        const buttons = [...(dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
        expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
            'Close',
            'Copy arguments',
            // The file link lives in the arguments code view, i.e. between the two
            // headings — proof the pane controls stay inside their own section.
            'Open a.ts',
            'Copy result'
        ]);
        for (const label of ['Copy arguments', 'Copy result']) {
            const control = buttons.find((button) => button.getAttribute('aria-label') === label);
            expect(control?.disabled).toBe(false);
            expect((control?.tabIndex ?? -1)).toBeGreaterThanOrEqual(0);
            expect(control?.closest('[hidden]')).toBeNull();
            expect(control?.closest('[inert]')).toBeNull();
        }
    });

    it('keeps the pane copy controls alive across close and reopen (one write per click)', () => {
        const calls: string[] = [];
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: async (text: string): Promise<void> => void calls.push(text) }
        });

        try {
            const card = mount(createToolCallCard('read', '{"paths":["a.ts"]}'));
            card.resolve('RESULT', 'completed');
            clickSummary(card);

            const argumentsButton = dialog()?.querySelector<HTMLElement>(
                '.tool-section:first-child .tool-copy'
            );
            argumentsButton?.click();

            // The SAME node is adopted on reopen: the body moves in and back out, so
            // the listener is never re-attached and a click can never write twice.
            closeDialog();
            expect(card.element.contains(argumentsButton ?? null)).toBe(true);
            clickSummary(card);
            expect(dialog()?.querySelector('.tool-section:first-child .tool-copy')).toBe(
                argumentsButton ?? null
            );
            argumentsButton?.click();

            expect(calls).toEqual(['{"paths":["a.ts"]}', '{"paths":["a.ts"]}']);
        } finally {
            Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
        }
    });
});

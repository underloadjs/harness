// The inline "think" chip — ui/tools.ts `createReasoningCard`, a streamed reasoning
// round rendered as a CHIP in the agent's tool row, in the same `.tool` box vocabulary
// as a tool call. TOOL chips are pinned by ui/tools.test.ts / tool-dialog.test.ts /
// ui/tool-copy.test.ts; nothing here duplicates them.
//
// What is pinned here:
//   - anatomy: `<details class="tool think">` whose summary is EXACTLY
//     [`span.tool-name` = `think`, `span.think-count` = the share pill]. Thinking has no
//     pass/fail outcome, so the call vocabulary (`.tool-glyph`, `.tool-state`,
//     `.tool-peek`, `.tool-duration`) is absent, and so is any disclosure arrow — the
//     marker reset lives on the base `summary` element (styles.css), so the chip needs
//     none of its own;
//   - share math: the pill is a PERCENTAGE of the block's context, from
//     `formatThinkShare(characters, contextTokens)` with the documented token estimate
//     (~4 chars/token) and the three rounding bands (`<0.1%`, one decimal below 10%,
//     whole percent at or above it), always en-US grouped;
//   - hidden-pill-without-denominator: while the round is empty OR the block reports no
//     honest context figure, `count.hidden` is true and `count.textContent` is '' —
//     never `0%`, never a dash — so the chip keeps its intrinsic `think` width;
//   - ONE paint path: `setText` (the CUMULATIVE buffer, never a delta) and `setContext`
//     repaint the pill, the `.reasoning` body, the accessible name, the hover title and
//     an already-open dialog's title together, so no two surfaces disagree;
//   - dialog-only detail: activating the summary (click, Enter, Space) opens the shared
//     modal and MOVES the very same `.tool-body` node into `.dialog-body` (no clone); the
//     `<details>` never stays open because the native default is cancelled and the
//     `toggle` listener re-closes anything that bypasses that; closing hands the node
//     back to the chip and returns focus to the summary;
//   - the pane heading's copy control is named `Copy thinking` and writes the FULL text
//     through the shared ui/dialog.ts clipboard path;
//   - `destroy` closes only a dialog this card owns (restoring the body) and is inert
//     when there is none.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/think-chip.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReasoningCard, formatThinkShare, THINK_LABEL, type ReasoningCard } from './tools';

// Lets the shared copy path's promise chain (`writeText` -> feedback paint) settle.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// Same clipboard control as ui/tool-copy.test.ts: the write prefers
// `navigator.clipboard.writeText` and falls back to textarea + `execCommand` on the
// plain-HTTP LAN origin, so the API has to be owned by the test.
const setClipboard = (writeText?: (text: string) => Promise<void>): void => {
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: writeText === undefined ? undefined : { writeText }
    });
};

// Appended to the document so `returnFocus` (the summary) is a connected element and
// focus restoration is observable, exactly like a chip in the transcript.
const mount = (card: ReasoningCard): ReasoningCard => {
    document.body.append(card.element);
    return card;
};

const clickSummary = (card: ReasoningCard): MouseEvent => {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    card.summary.dispatchEvent(event);
    return event;
};

const pressSummary = (card: ReasoningCard, key: string): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    card.summary.dispatchEvent(event);
    return event;
};

const dialog = (): HTMLElement => {
    const panel = document.querySelector<HTMLElement>('.dialog');
    if (panel === null) throw new Error('no open dialog');
    return panel;
};

const closeDialog = (): void => {
    const button = dialog().querySelector<HTMLButtonElement>('.dialog-close');
    if (button === null) throw new Error('no open dialog to close');
    button.click();
};

// Addressed by its accessible name, because that name is itself a requirement: an
// assistive-tech user has to know WHICH pane a press copies.
const copyButton = (): HTMLButtonElement => {
    const button = document.querySelector<HTMLButtonElement>('[aria-label="Copy thinking"]');
    if (button === null) throw new Error('missing "Copy thinking" button');
    return button;
};

const reasoningHost = (root: ParentNode): HTMLElement | null =>
    root.querySelector<HTMLElement>('.reasoning');

// 387 characters -> ceil(387 / 4) = 97 tokens. 12,108 -> 3,027 tokens.
const TEXT_387 = 'x'.repeat(387);
const TEXT_12108 = 'y'.repeat(12108);

beforeEach(() => {
    document.body.replaceChildren();
    setClipboard(undefined);
});

// dialog.ts keeps module-level layer/listener state, so a leaked overlay would change
// the next test's `.dialog`.
afterEach(() => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('.dialog-close')) {
        button.click();
    }
    document.body.replaceChildren();
    setClipboard(undefined);
    vi.useRealTimers();
});

describe('formatThinkShare', () => {
    it('prints the exact pill text for every rounding band', () => {
        // 97 tokens / 42,212 = 0.2298% -> one decimal, because that is the range where
        // the comparison happens.
        expect(formatThinkShare(387, 42212)).toBe('0.2%');
        // 3,027 tokens / 358,448 = 0.8445% -> 0.8%
        expect(formatThinkShare(12108, 358448)).toBe('0.8%');
        // 100,000 tokens / 1,000,000 = exactly 10% -> the band boundary rounds.
        expect(formatThinkShare(400000, 1000000)).toBe('10%');
        // 100 tokens / 1,000 = 10% -> whole percent, never `10.0%`.
        expect(formatThinkShare(400, 1000)).toBe('10%');
        // 10 tokens / 1,000 = 1% -> the one-decimal band keeps its `.0`.
        expect(formatThinkShare(40, 1000)).toBe('1.0%');
        // 1 token (the `Math.max(1, ...)` floor) / 1,000 = 0.1% -> the band floor.
        expect(formatThinkShare(3, 1000)).toBe('0.1%');
        // 50 tokens / 100,000 = 0.05% -> under the floor. `0.0%` would claim the model
        // never thought at all, so the pill says "<0.1%".
        expect(formatThinkShare(200, 100000)).toBe('<0.1%');
    });

    it('returns an empty pill string instead of inventing a measurement', () => {
        // No text, or no honest denominator, is the caller's signal to HIDE the pill.
        expect(formatThinkShare(0, 1000)).toBe('');
        expect(formatThinkShare(-1, 1000)).toBe('');
        expect(formatThinkShare(1000, undefined)).toBe('');
        expect(formatThinkShare(1000, 0)).toBe('');
        expect(formatThinkShare(1000, -42212)).toBe('');
        expect(formatThinkShare(1000, Number.NaN)).toBe('');
        expect(formatThinkShare(1000, Number.POSITIVE_INFINITY)).toBe('');
    });
});

describe('createReasoningCard', () => {
    it('builds a think chip whose summary is exactly the label plus the share pill', () => {
        const card = mount(createReasoningCard());

        expect(THINK_LABEL).toBe('think');
        expect(card.element.tagName).toBe('DETAILS');
        // `.tool` is the shared box vocabulary; `.think` only restyles the register.
        expect(card.element.className).toBe('tool think');
        expect(card.element.open).toBe(false);
        expect(card.element.querySelectorAll('summary')).toHaveLength(1);

        // The summary's parts, in order: nothing is generated around them and no arrow
        // element is inside them.
        expect([...card.summary.children].map((node) => node.className)).toEqual([
            'tool-name',
            'think-count'
        ]);
        expect(card.summary.firstElementChild).toBe(card.label);
        expect(card.summary.lastElementChild).toBe(card.count);
        expect(card.label.className).toBe('tool-name');
        expect(card.label.textContent).toBe('think');
        expect(card.count.className).toBe('think-count');

        // A call chip's parts: a think round has no outcome, so it carries none of them.
        for (const selector of ['.tool-glyph', '.tool-state', '.tool-peek', '.tool-duration']) {
            expect(card.element.querySelector(selector)).toBeNull();
        }

        // Popup vocabulary: activation opens a modal, never an inline disclosure, and the
        // summary is the target the dialog returns focus to.
        expect(card.summary.getAttribute('aria-haspopup')).toBe('dialog');
        expect(card.summary.tabIndex).toBe(0);

        // The body is built ONCE inside the closed card, so activation can adopt that
        // node: one section, whose heading carries the pane label and the copy control.
        expect(card.element.querySelector('.tool-body')).toBe(card.body);
        expect(card.body.className).toBe('tool-body');
        expect([...card.body.children].map((node) => node.className)).toEqual(['tool-section']);
        const section = card.body.querySelector<HTMLElement>('.tool-section');
        if (section === null) throw new Error('missing .tool-section');
        expect([...section.children].map((node) => node.className)).toEqual([
            'tool-heading',
            'reasoning'
        ]);
        const heading = section.querySelector<HTMLElement>('.tool-heading');
        if (heading === null) throw new Error('missing .tool-heading');
        expect([...heading.children].map((node) => node.className)).toEqual([
            'tool-label',
            'text-copy tool-copy'
        ]);
        expect(heading.querySelector('.tool-label')?.textContent).toBe('think');
        expect(reasoningHost(card.body)?.textContent).toBe('');
    });

    it('hides the share pill until the block reports an honest denominator', () => {
        const card = mount(createReasoningCard());
        card.setText(TEXT_387);

        // The whole cumulative buffer is held, and the body shows it even while the pill
        // is hidden — the missing figure is the DENOMINATOR, not the text.
        expect(card.text()).toBe(TEXT_387);
        expect(card.text()).toHaveLength(387);
        expect(card.context()).toBeUndefined();
        expect(card.share()).toBe('');
        expect(card.count.textContent).toBe('');
        expect(card.count.hidden).toBe(true);

        // The accessible name stays the bare label; the arithmetic stays on hover, where
        // the exact character count and the estimate are spelled out.
        expect(card.summary.getAttribute('aria-label')).toBe('think');
        expect(card.summary.title).toBe('387 characters ≈ 97 tokens · no context size reported yet');
        expect(reasoningHost(card.body)?.textContent).toBe(TEXT_387);
    });

    it('paints the pill the moment the context figure arrives', () => {
        const card = mount(createReasoningCard());
        card.setText(TEXT_387);
        card.setContext(42212);

        expect(card.context()).toBe(42212);
        expect(card.share()).toBe('0.2%');
        expect(card.count.textContent).toBe('0.2%');
        expect(card.count.hidden).toBe(false);
        expect(card.summary.getAttribute('aria-label')).toBe('think: 0.2% of the context so far');
        // en-US grouping is pinned: `42,212`, never `42.212` or `42 212`.
        expect(card.summary.title).toBe('≈ 97 of 42,212 context tokens (0.2%)');
        // The text itself is untouched by the denominator change.
        expect(reasoningHost(card.body)?.textContent).toBe(TEXT_387);
    });

    it('repaints every derived surface from a longer cumulative buffer', () => {
        const card = mount(createReasoningCard());
        card.setContext(358448);

        // A share under the floor is still a share: the pill reads `<0.1%`, not hidden.
        card.setText(TEXT_387);
        expect(card.share()).toBe('<0.1%');
        expect(card.count.textContent).toBe('<0.1%');
        expect(card.count.hidden).toBe(false);

        card.setText(TEXT_12108);
        expect(card.text()).toBe(TEXT_12108);
        expect(card.share()).toBe('0.8%');
        expect(card.count.textContent).toBe('0.8%');
        expect(card.summary.getAttribute('aria-label')).toBe('think: 0.8% of the context so far');
        expect(card.summary.title).toBe('≈ 3,027 of 358,448 context tokens (0.8%)');
        expect(reasoningHost(card.body)?.textContent).toBe(TEXT_12108);

        // A fresh denominator repaints the same text against it — a percentage can never
        // be measured against a figure the header has already moved past.
        card.setContext(42212);
        expect(card.share()).toBe('7.2%');
        expect(card.count.textContent).toBe('7.2%');
        expect(card.summary.getAttribute('aria-label')).toBe('think: 7.2% of the context so far');
        expect(card.summary.title).toBe('≈ 3,027 of 42,212 context tokens (7.2%)');
    });

    it('treats every unusable denominator as no share at all', () => {
        const card = mount(createReasoningCard());
        card.setText(TEXT_387);
        card.setContext(42212);
        expect(card.share()).toBe('0.2%');

        // `setContext` normalises before storing, so `context()` reports what is actually
        // in force and the pill goes back to hidden rather than showing `0%`.
        for (const unusable of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            card.setContext(unusable);
            expect(card.context()).toBeUndefined();
            expect(card.share()).toBe('');
            expect(card.count.textContent).toBe('');
            expect(card.count.hidden).toBe(true);
            expect(card.summary.getAttribute('aria-label')).toBe('think');
            expect(card.summary.title).toBe(
                '387 characters ≈ 97 tokens · no context size reported yet'
            );
        }
    });

    it('paints an empty round as the bare label with no hover arithmetic', () => {
        const card = mount(createReasoningCard());
        card.setText('');

        expect(card.text()).toBe('');
        expect(card.share()).toBe('');
        expect(card.count.textContent).toBe('');
        expect(card.count.hidden).toBe(true);
        expect(card.summary.getAttribute('aria-label')).toBe('think');
        expect(card.summary.title).toBe('think');
        expect(reasoningHost(card.body)?.textContent).toBe('');
    });

    it('opens the modal from a click, adopting the same body and never the details', () => {
        const card = mount(createReasoningCard());
        card.setText(TEXT_387);
        card.setContext(42212);

        const event = clickSummary(card);

        // The native disclosure default was cancelled, so the chip never grows an inline
        // panel: the dialog is the only detail surface.
        expect(event.defaultPrevented).toBe(true);
        expect(card.element.open).toBe(false);

        // The body was MOVED out of the chip, not cloned.
        expect(card.element.querySelector('.tool-body')).toBeNull();
        expect(dialog().querySelector<HTMLElement>('.dialog-body > .tool-body')).toBe(card.body);
        expect(dialog()?.getAttribute('role')).toBe('dialog');
        expect(dialog()?.getAttribute('aria-modal')).toBe('true');

        // The dialog is the surface that still spells the figure out in full.
        expect(dialog()?.querySelector('.dialog-title')?.textContent).toBe(
            'think · 0.2% · 387 chars'
        );
        expect(reasoningHost(dialog())?.textContent).toBe(TEXT_387);

        closeDialog();
        expect(document.querySelector('.dialog')).toBeNull();
        expect(card.element.querySelector('.tool-body')).toBe(card.body);
        expect(card.element.open).toBe(false);
        expect(document.activeElement).toBe(card.summary);
    });

    it('opens from Enter and Space and reopens the same node', () => {
        const card = mount(createReasoningCard());
        card.setText(TEXT_387);
        card.setContext(42212);

        const enter = pressSummary(card, 'Enter');
        expect(enter.defaultPrevented).toBe(true);
        expect(card.element.open).toBe(false);
        expect(dialog().querySelector<HTMLElement>('.dialog-body > .tool-body')).toBe(card.body);

        closeDialog();
        expect(document.querySelector('.dialog')).toBeNull();

        const space = pressSummary(card, ' ');
        expect(space.defaultPrevented).toBe(true);
        expect(card.element.open).toBe(false);
        expect(dialog().querySelector<HTMLElement>('.dialog-body > .tool-body')).toBe(card.body);
        expect(dialog()?.querySelector('.dialog-title')?.textContent).toBe(
            'think · 0.2% · 387 chars'
        );
    });

    it('re-closes a native toggle and opens only one dialog per chip', () => {
        const card = mount(createReasoningCard());
        card.setText(TEXT_387);

        // Guard for anything that bypasses the click listener (a restored disclosure, a
        // script): the queued `toggle` event re-closes the chip.
        vi.useFakeTimers();
        card.element.open = true;
        expect(card.element.open).toBe(true);
        vi.runAllTimers();
        expect(card.element.open).toBe(false);
        vi.useRealTimers();

        clickSummary(card);
        clickSummary(card);
        expect(document.querySelectorAll('.dialog')).toHaveLength(1);
        // With no denominator the title drops the share segment but keeps the exact count.
        expect(dialog()?.querySelector('.dialog-title')?.textContent).toBe('think · 387 chars');
    });

    it('tracks the streaming round inside an already-open dialog', () => {
        const card = mount(createReasoningCard());
        card.setContext(358448);
        card.setText(TEXT_387);

        clickSummary(card);
        expect(dialog()?.querySelector('.dialog-title')?.textContent).toBe(
            'think · <0.1% · 387 chars'
        );
        expect(reasoningHost(dialog())?.textContent).toBe(TEXT_387);

        // The adopted node is the live one, so a longer buffer repaints the open modal.
        card.setText(TEXT_12108);
        expect(dialog()?.querySelector('.dialog-title')?.textContent).toBe(
            'think · 0.8% · 12,108 chars'
        );
        expect(reasoningHost(dialog())?.textContent).toBe(TEXT_12108);

        card.setContext(42212);
        expect(dialog()?.querySelector('.dialog-title')?.textContent).toBe(
            'think · 7.2% · 12,108 chars'
        );
        expect(card.count.textContent).toBe('7.2%');
        expect(card.summary.title).toBe('≈ 3,027 of 42,212 context tokens (7.2%)');
    });

    it('titles an empty round with the bare label', () => {
        const card = mount(createReasoningCard());

        clickSummary(card);

        expect(dialog()?.querySelector('.dialog-title')?.textContent).toBe('think');
        expect(reasoningHost(dialog())?.textContent).toBe('');
        expect(dialog().querySelector<HTMLElement>('.dialog-body > .tool-body')).toBe(card.body);
    });

    it('copies the whole thinking text from the pane heading', async () => {
        const writeText = vi.fn(async () => undefined);
        setClipboard(writeText);

        const card = mount(createReasoningCard());
        card.setText(TEXT_387);
        card.setContext(42212);
        clickSummary(card);

        const button = copyButton();
        // The shared icon button: same class vocabulary as a tool pane's copy, plus the
        // fixed accessible name that says WHICH pane it copies.
        expect(button.className).toBe('text-copy tool-copy');
        expect(button.type).toBe('button');
        expect(button.title).toBe('Copy thinking');
        expect(button.getAttribute('aria-label')).toBe('Copy thinking');
        expect(button.parentElement?.className).toBe('tool-heading');
        expect(button.parentElement?.querySelector('.tool-label')?.textContent).toBe('think');
        expect(button.querySelector('.dialog-copy-feedback')?.textContent).toBe('');
        // One pane, one control: the tool dialog has no whole-dialog Copy either.
        expect(document.querySelectorAll('.dialog .tool-copy')).toHaveLength(1);
        expect(document.querySelectorAll('.dialog .dialog-copy')).toHaveLength(0);

        button.click();
        await flush();

        // The FULL cumulative buffer, byte for byte: no character count, no percentage,
        // no prefix of the stream.
        expect(writeText).toHaveBeenCalledTimes(1);
        expect(writeText).toHaveBeenCalledWith(TEXT_387);
        expect(button.querySelector('.dialog-copy-feedback')?.textContent).toBe('Copied');
        expect(button.dataset.state).toBe('success');
    });

    it('closes a dialog it owns on destroy and is inert without one', () => {
        const card = mount(createReasoningCard());
        card.setText(TEXT_387);
        card.setContext(42212);

        // Nothing to close: the body stays in the chip and the chip still opens its modal.
        card.destroy();
        expect(document.querySelector('.dialog')).toBeNull();
        expect(card.element.querySelector('.tool-body')).toBe(card.body);

        clickSummary(card);
        expect(document.querySelectorAll('.dialog')).toHaveLength(1);

        card.destroy();
        expect(document.querySelector('.dialog')).toBeNull();
        expect(document.querySelector('.dialog-overlay')).toBeNull();
        // Cleanup also returns the adopted body, so a late delta cannot write into a
        // detached overlay.
        expect(card.element.querySelector('.tool-body')).toBe(card.body);
        expect(card.element.open).toBe(false);

        // The card keeps working after its dialog was closed for it.
        card.setContext(358448);
        card.setText(TEXT_12108);
        expect(card.share()).toBe('0.8%');
        expect(reasoningHost(card.body)?.textContent).toBe(TEXT_12108);
    });
});

// Tool-chip CSS contract.
//
// jsdom cannot lay out flex rows or resolve the chip visibility, so this test
// reads stylesheet source and pins the rules the compact tool UI relies on:
//   - consecutive calls live in a wrapping flex row (`.tool-group`);
//   - the chip keeps its compact intrinsic width; the detail body is dialog
//     content (R12) and never an inline panel;
//   - the state word and the argument preview stay hidden while the chip is
//     closed, but the duration BADGE does not (R2): every chip overlays its own
//     measured span in its top-right corner, absolutely positioned so a live label
//     cannot move the name or a neighbour, and an unknown span stays hidden through
//     `[hidden]` so no empty pill is painted;
//   - the tool name is green on success and red on failure, neutral otherwise.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// Mirror activity-style.test.ts: resolve from the package root (`npm test`) or
// the frontend root (vitest frontend config sets `root` to frontend/).
const stylesheet = ['src/frontend/styles.css', 'src/styles.css']
    .map((candidate) => resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(candidate));
if (stylesheet === undefined) throw new Error('styles.css not found');

const css = readFileSync(stylesheet, 'utf8');

const blockOf = (selector: string): string => {
    const start = css.indexOf(selector);
    if (start < 0) throw new Error(`missing selector ${selector}`);

    const open = css.indexOf('{', start);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
};

// The selector list of a rule (everything before its `{`). The duration badge has
// to be ABSENT from the collapsed-hide list, and `blockOf` only returns the
// declarations, so the selector itself is what this reads.
const selectorListOf = (selector: string): string => {
    const start = css.indexOf(selector);
    if (start < 0) throw new Error(`missing selector ${selector}`);

    const open = css.indexOf('{', start);
    return css.slice(start, open);
};

it('flows consecutive chips horizontally and wraps them', () => {
    const group = blockOf('.tool-group {');
    expect(group).toContain('display: flex');
    expect(group).toContain('flex-wrap: wrap');
    expect(group).toContain('align-items: flex-start');
    expect(group).toContain('gap: 4px');

    // Chips shrink to their content; `.tool` never grows into a card-width block
    // on its own, which is what keeps a fresh call compact.
    expect(blockOf('.tool {')).toContain('flex: 0 1 auto');
    expect(blockOf('.tool {')).toContain('max-width: 100%');
});

it('hides verbose summary pieces but keeps the duration badge while the chip is closed', () => {
    // One rule hides the state word and the argument preview. R12 keeps the
    // `<details>` closed forever (the body moves into the modal when opened), so
    // this is the permanent chip state; the accessible `aria-label` carries the
    // state text.
    const hidden = blockOf('.tool:not([open]) .tool-state,');
    expect(hidden).toContain('display: none');

    expect(css).toContain('.tool:not([open]) .tool-peek {');

    // R2: the measured span has to be readable without opening anything, so
    // `.tool-duration` is NOT part of that selector list (the stale expectation that
    // the closed chip hides the span is what this test used to pin). Pinning the list
    // is the only way to catch a rule that re-adds it.
    const hiddenSelectors = selectorListOf('.tool:not([open]) .tool-state,');
    expect(hiddenSelectors.replace(/\s+/g, ' ').trim()).toBe(
        '.tool:not([open]) .tool-state, .tool:not([open]) .tool-peek'
    );
    expect(hiddenSelectors).not.toContain('.tool-duration');

    // The shared detail body keeps its section layout when the dialog adopts it,
    // so arguments/result stay stacked and readable inside `.dialog-body`.
    expect(blockOf('.tool-body {')).toContain('flex-direction: column');
    expect(blockOf('.tool-body {')).toContain('gap: 8px');
});

it('overlays each chip with its own duration badge in the top-right corner', () => {
    // R2: the badge is an OVERLAY, not a label in the flow. The live span changes
    // every 250ms and a final server span replaces it, so an in-flow pill of
    // changing width is exactly what made the chip row jitter. Out of flow and
    // anchored to the chip, it can never move the name or a neighbouring chip.
    expect(blockOf('.tool {')).toContain('position: relative');

    // MUI-Badge-like pill built from the existing tokens only — no component
    // library and no new dependency. The border is the separator now, so the old
    // `·` pseudo-element is gone.
    const badge = blockOf('.tool-duration {');
    expect(badge).toContain('position: absolute');
    expect(badge).toContain('top: 2px');
    expect(badge).toContain('right: 3px');
    expect(badge).toContain('z-index: 1');
    expect(badge).toContain('pointer-events: none');
    expect(badge).toContain('display: inline-flex');
    expect(badge).toContain('border: 1px solid var(--border-strong)');
    expect(badge).toContain('border-radius: 999px');
    expect(badge).toContain('background: var(--bg-input)');
    expect(badge).toContain('color: var(--muted)');
    expect(badge).toContain('font-variant-numeric: tabular-nums');
    expect(badge).toContain('white-space: nowrap');
    expect(css).not.toContain('.tool-duration:not(:empty)::before');

    // Not clipped: the pill sits INSIDE the chip's border box, and nothing on the
    // chip, its summary or the wrapping row may cut it off.
    expect(blockOf('.tool {')).not.toContain('overflow: hidden');
    expect(blockOf('.tool-summary {')).not.toContain('overflow: hidden');
    expect(blockOf('.tool-group {')).not.toContain('overflow: hidden');

    // The chip reserves the corner only while a badge is actually painted, so a call
    // with an unknown span keeps its tighter width and the row stays compact.
    //
    // T5: the reservation must cover the LONGEST legitimate pill, not the common one.
    // `formatDuration` prints minutes with no hours unit, so the pill keeps growing:
    // `59m59s` (6 chars) is 47.7px wide and `5999m00s` (8 chars, 99.98h) is 59.6px,
    // while the pill's right edge sits 4px inside the chip. A flat 46px (the old
    // 5-character budget) left `59m59s` covering 4.7px of the tool NAME on a real chip
    // and 16.6px for the 8-character form — see Temp/t5/badge-geometry.json.
    // The rule is therefore `8ch` of the summary's own mono (`ch` = 6.75px vs the
    // pill's 5.95px, so the budget is font-relative and conservative) plus 22px of
    // pill chrome, inset and gap = 76px >= the 70px the widest sensible span needs.
    expect(blockOf('.tool-summary {')).toContain('padding: 3px 8px');
    const reservation = blockOf('.tool:has(.tool-duration:not([hidden])) > .tool-summary {');
    expect(reservation).toContain('padding-right: calc(8ch + 22px)');
    // A flat pixel value here is how the 4-character case crept back in.
    expect(reservation).not.toContain('padding-right: 46px');
    expect(reservation).toMatch(/padding-right:\s*calc\(\s*8ch\s*\+\s*22px\s*\)/);

    // `[hidden]` is the only suppression path (an unknown span), and it has to win
    // over the badge's own `display` above — otherwise an empty pill would paint.
    expect(blockOf('.tool-duration[hidden] {')).toContain('display: none');

    // No plain `.tool-duration` rule may hide it: the phone breakpoint keeps the
    // badge and drops only `.tool-peek`, so the span stays visible at every width.
    const hiding = [...css.matchAll(/\.tool-duration\s*\{[^}]*\}/g)].filter((rule) =>
        rule[0].includes('display: none')
    );
    expect(hiding).toHaveLength(0);

    // The badge carries the call's state colour, like the name and the glyph do.
    expect(blockOf(".tool[data-state='ok'] .tool-duration {")).toContain('color: var(--ok)');
    expect(blockOf(".tool[data-state='error'] .tool-duration {")).toContain('color: var(--danger)');
});

it('fills the dialog height with the result pane instead of leaving a blank tail', () => {
    // R12 dialog sizing: the shell is content-sized with a viewport cap, and the
    // tool body is the flex chain that distributes that height. `min-height: 0`
    // lets each level shrink so the result block scrolls internally rather than
    // keeping the card's fixed 300px and exposing empty space beneath it.
    const body = blockOf('.dialog-body > .tool-body {');
    expect(body).toContain('flex: 1 1 auto');
    expect(body).toContain('min-height: 0');
    expect(body).toContain('padding: 0');

    // Arguments are capped relative to the viewport and do not shrink: a long
    // result must not collapse this pane below its label.
    const argsSection = blockOf('.dialog-body > .tool-body > .tool-section:first-child {');
    expect(argsSection).toContain('flex: 0 0 auto');
    expect(blockOf('.dialog-body > .tool-body > .tool-section:first-child > .code-block {')).toContain(
        'max-height: min(32vh, 280px)'
    );

    // The result section and its code block take the remaining height. The
    // `max-height: none` is the dialog-only override of `.tool-result .code-block`.
    const resultSection = blockOf('.dialog-body > .tool-body > .tool-section:last-child {');
    expect(resultSection).toContain('flex: 1 1 auto');
    // A short viewport scrolls `.dialog-body` rather than collapsing the result.
    expect(resultSection).toContain('min-height: 96px');
    expect(blockOf('.dialog-body > .tool-body > .tool-section:last-child > .tool-result {')).toContain(
        'flex-direction: column'
    );
    const result = blockOf('.dialog-body > .tool-body > .tool-section:last-child > .tool-result > .code-block {');
    expect(result).toContain('flex: 1 1 auto');
    expect(result).toContain('min-height: 0');
    expect(result).toContain('max-height: none');
});

it('sizes the ACTUAL manual-runner dialog chain, not the chip body path', () => {
    // F3: the manual runner is built by main.ts as
    //   .dialog-body > .tool-runner-slot > .pane > .log-wrap > .log > .tool-card
    // and has NO `.tool-body` child. Its own chain must fill the dialog and let
    // `.tool-output > .card-body` take the remaining height.
    const wrap = blockOf(
        '.dialog-body > .tool-runner-slot > .pane > .log-wrap {'
    );
    expect(wrap).toContain('display: flex');
    expect(wrap).toContain('flex: 1 1 auto');
    expect(wrap).toContain('min-height: 0');
    expect(wrap).toContain('padding: 0');

    const log = blockOf(
        '.dialog-body > .tool-runner-slot > .pane > .log-wrap > .log {'
    );
    expect(log).toContain('display: flex');
    expect(log).toContain('flex-direction: column');
    expect(log).toContain('max-width: none');

    const card = blockOf(
        '.dialog-body > .tool-runner-slot > .pane > .log-wrap > .log > .tool-card {'
    );
    expect(card).toContain('flex: 1 1 auto');
    expect(card).toContain('min-height: 0');

    // Only the result grows; the notes/schema/arguments/Call controls keep their
    // intrinsic height.
    expect(
        blockOf(
            '.dialog-body > .tool-runner-slot > .pane > .log-wrap > .log > .tool-card > :not(.tool-output) {'
        )
    ).toContain('flex: 0 0 auto');

    const output = blockOf(
        '.dialog-body > .tool-runner-slot > .pane > .log-wrap > .log > .tool-card > .tool-output {'
    );
    expect(output).toContain('display: flex');
    expect(output).toContain('flex: 1 1 auto');
    expect(output).toContain('min-height: 96px');

    const body = blockOf(
        '.dialog-body > .tool-runner-slot > .pane > .log-wrap > .log > .tool-card > .tool-output > .card-body {'
    );
    expect(body).toContain('flex: 1 1 auto');
    expect(body).toContain('min-height: 0');
    expect(body).toContain('max-height: none');
});

it('colours the tool name by state, keeping running neutral', () => {
    expect(blockOf('.tool-name {')).toContain('color: var(--text)');
    expect(blockOf(".tool[data-state='ok'] .tool-name {")).toContain('color: var(--ok)');
    expect(blockOf(".tool[data-state='error'] .tool-name {")).toContain('color: var(--danger)');
    // A long name is ellipsized in the chip but shown in full once expanded.
    expect(blockOf('.tool[open] .tool-name {')).toContain('max-width: none');
});

it('mutes an interrupted call instead of painting it as success or failure', () => {
    // R6: pending work is interrupted, not failed. The chip and its state word drop
    // to the muted colour so a settled tile never reads as red (tool error) or as a
    // live call (the default running style).
    expect(blockOf(".tool[data-state='cancelled'] .tool-name {")).toContain('color: var(--muted)');
    expect(blockOf(".tool[data-state='cancelled'] .tool-state {")).toContain('color: var(--muted)');
    expect(blockOf(".tool[data-state='cancelled'] .tool-glyph {")).toContain('color: var(--muted)');
});

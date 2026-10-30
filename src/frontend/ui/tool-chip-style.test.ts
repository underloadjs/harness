// Tool-chip CSS contract.
//
// jsdom cannot lay out flex rows or resolve the chip visibility, so this test
// reads stylesheet source and pins the rules the compact tool UI relies on:
//   - consecutive calls live in a wrapping flex row (`.tool-group`);
//   - the chip keeps its compact intrinsic width; the detail body is dialog
//     content (R12) and never an inline panel;
//   - state, duration and argument preview stay hidden while the chip is closed;
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

it('hides verbose summary pieces while the chip is closed', () => {
    // One rule hides state word, duration and preview. R12 keeps the `<details>`
    // closed forever (the body moves into the modal when opened), so this is the
    // permanent chip state; the accessible `aria-label` carries the state text.
    const hidden = blockOf('.tool:not([open]) .tool-state,');
    expect(hidden).toContain('display: none');

    expect(css).toContain('.tool:not([open]) .tool-duration,');
    expect(css).toContain('.tool:not([open]) .tool-peek {');

    // The shared detail body keeps its section layout when the dialog adopts it,
    // so arguments/result stay stacked and readable inside `.dialog-body`.
    expect(blockOf('.tool-body {')).toContain('flex-direction: column');
    expect(blockOf('.tool-body {')).toContain('gap: 8px');
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

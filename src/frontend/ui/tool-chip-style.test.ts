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

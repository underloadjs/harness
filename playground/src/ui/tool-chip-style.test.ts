// Tool-chip CSS contract.
//
// jsdom cannot lay out flex rows or resolve the collapsed/expanded visibility, so
// this test reads stylesheet source and pins the rules the compact tool UI relies
// on:
//   - consecutive calls live in a wrapping flex row (`.tool-group`);
//   - an opened call takes the full row so its detail keeps card width;
//   - state, duration and argument preview are hidden only while collapsed;
//   - the tool name is green on success and red on failure, neutral otherwise.
//
// Run: npx vitest run --config playground/vitest.config.ts

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// Mirror activity-style.test.ts: resolve from the package root (`npm test`) or
// the playground root (vitest playground config sets `root` to playground/).
const stylesheet = ['playground/src/styles.css', 'src/styles.css']
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

    // Collapsed chips shrink to their content; the override below gives an opened
    // card a full line without changing the closed row.
    expect(blockOf('.tool {')).toContain('flex: 0 1 auto');
    expect(blockOf('.tool[open] {')).toContain('flex-basis: 100%');
});

it('hides verbose summary pieces only while the chip is collapsed', () => {
    // One rule hides state word, duration and preview; the body/detail stays in
    // the DOM and is revealed by `details[open]`.
    const hidden = blockOf('.tool:not([open]) .tool-state,');
    expect(hidden).toContain('display: none');

    expect(css).toContain('.tool:not([open]) .tool-duration,');
    expect(css).toContain('.tool:not([open]) .tool-peek {');

    // The open summary gets the roomier former padding and the body keeps its
    // sections, so nothing about arguments/result is lost.
    expect(blockOf('.tool[open] > .tool-summary {')).toContain('padding: 7px 10px');
    expect(blockOf('.tool-body {')).toContain('flex-direction: column');
});

it('colours the tool name by state, keeping running neutral', () => {
    expect(blockOf('.tool-name {')).toContain('color: var(--text)');
    expect(blockOf(".tool[data-state='ok'] .tool-name {")).toContain('color: var(--ok)');
    expect(blockOf(".tool[data-state='error'] .tool-name {")).toContain('color: var(--danger)');
    // A long name is ellipsized in the chip but shown in full once expanded.
    expect(blockOf('.tool[open] .tool-name {')).toContain('max-width: none');
});

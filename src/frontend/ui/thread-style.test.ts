// Invocation-thread CSS contract (R1/R2/R5).
//
// jsdom cannot compute layout, so — like turn-tile-style.test.ts — this reads the
// stylesheet source and pins the properties the thread layout depends on:
//   - one indent step per nesting level, so depth 1/2/3… indent without the CSS
//     enumerating depths;
//   - the body is `display:none` until the entry is expanded (collapsing an entry
//     must not hide its descendants, which live outside the body);
//   - status is visible text with colour reinforcement, not colour alone;
//   - a compact narrow-screen indent that keeps depth 2 readable.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

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

it('indents one step per nesting level so any depth works', () => {
    const children = blockOf('.thread-children {');

    expect(children).toContain('--thread-indent: 18px');
    expect(children).toContain('padding-left: var(--thread-indent)');
    expect(children).toContain('flex-direction: column');

    // The row keeps a visible depth stripe; the indent itself is the nesting rule
    // (a grandchild sits inside its parent's `.thread-children`).
    expect(blockOf('.thread-row {')).toContain('border-left');
    // Depth is mirrored as an attribute and reinforced by tone for depth 2.
    expect(blockOf(".thread-row[data-depth='2'] {")).toContain('border-left-color');
});

it('hides only the entry body when collapsed', () => {
    const collapsed = blockOf('.thread-row:not(.is-expanded) .thread-body {');

    expect(collapsed).toContain('display: none');
    // The children host is a SIBLING of the body in the DOM (ui/turns.ts), so no
    // rule here can hide descendants; pin that the selector targets only the body.
    expect(css).not.toContain('.thread-row:not(.is-expanded) .thread-children');
    expect(css).toContain('.thread-row.is-expanded .thread-preview');
});

it('keeps the entry header a compact, keyboard-focusable one-liner', () => {
    const select = blockOf('.thread-select {');
    expect(select).toContain('width: 100%');
    expect(select).toContain('cursor: pointer');
    expect(select).toContain('color: inherit');
    expect(blockOf('.thread-select:focus-visible {')).toContain('outline: 2px solid var(--accent)');

    const preview = blockOf('.thread-preview {');
    expect(preview).toContain('white-space: nowrap');
    expect(preview).toContain('text-overflow: ellipsis');

    // Status is a visible word; colour is reinforcement only.
    expect(blockOf('.thread-status {')).not.toContain('display: none');
    expect(blockOf(".thread-row[data-state='error'] .thread-status {")).toContain('color: var(--danger)');
});

it('styles the per-invocation outcome and keeps it readable at depth', () => {
    expect(blockOf('.thread-outcome {')).toContain('overflow-wrap: anywhere');
    expect(blockOf(".thread-outcome[data-tone='error'] {")).toContain('color: var(--danger)');

    expect(css).toMatch(
        /@media \(max-width: 600px\)[\s\S]*?\.thread-children \{[\s\S]*?--thread-indent: 10px;/
    );
});

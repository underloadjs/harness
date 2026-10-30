// R6 layout containment CSS contract.
//
// Symptom: at a 1234px viewport the chat column is 248px | 666px | 320px, yet a
// main or nested turn block painted out to ~1095px — straight over the right rail
// that starts at 928px. Cause: a flex item's `min-width` defaults to `auto`, i.e.
// its content-based minimum, so a long transcript widened `.pane` (and then the
// block) past the grid track that owns it.
//
// jsdom cannot compute layout, so — like thread-style.test.ts and
// turn-tile-style.test.ts — this reads the stylesheet source and pins the chain the
// fix depends on:
//   - every flex level from the grid item down to the block declares
//     `min-width: 0`, so the automatic minimum can no longer widen the column;
//   - every level is capped at its parent's width (`max-width: 100%`);
//   - the fix is containment, NOT page-level clipping: the boxes that are supposed
//     to scroll sideways still declare `overflow: auto`, and `.stage`/`.pane`/`.log`
//     do not hide overflow;
//   - the responsive rails, the compact single-line turn row and the nested thread
//     indentation are untouched.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// Resolve the stylesheet from the package root (`npm test`) or the frontend root
// (vitest.config.ts `root`), exactly like the other CSS-source tests.
const stylesheet = ['src/frontend/styles.css', 'src/styles.css']
    .map((candidate) => resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(candidate));
if (stylesheet === undefined) throw new Error('styles.css not found');

const css = readFileSync(stylesheet, 'utf8');

// Comments deliberately NAME the properties and selectors under discussion, so all
// assertions run against the comment-stripped stylesheet (see thread-style.test.ts).
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

// Slice a rule/at-rule body by brace matching, so a nested `@media` block cannot be
// cut short by the first `}`.
const blockOf = (selector: string): string => {
    // Anchor to a TOP-LEVEL selector at the start of a line. A plain `indexOf`
    // also matches the same class name inside a longer descendant selector (e.g.
    // the dialog runner's `.dialog-body > … > .log-wrap`), which would return that
    // rule's body and hide the base declaration this test is pinning.
    const start = rules.indexOf(`\n${selector}`);
    if (start < 0) throw new Error(`missing selector ${selector}`);

    const open = rules.indexOf('{', start);
    if (open < 0) throw new Error(`missing body for ${selector}`);

    let depth = 0;
    for (let index = open; index < rules.length; index += 1) {
        if (rules[index] === '{') depth += 1;
        if (rules[index] === '}') {
            depth -= 1;
            if (depth === 0) return rules.slice(open + 1, index);
        }
    }

    throw new Error(`unbalanced block for ${selector}`);
};

it('lets every flex level down to the block shrink to the chat column', () => {
    // The chain the overflow travelled along: the grid track is already
    // `minmax(0, 1fr)` and `.center` already shrinks; these four did not.
    expect(blockOf('.center {')).toContain('min-width: 0');
    expect(blockOf('.stage {')).toContain('min-width: 0');
    expect(blockOf('.pane {')).toContain('min-width: 0');
    expect(blockOf('.log-wrap {')).toContain('min-width: 0');
    expect(blockOf('.log {')).toContain('min-width: 0');

    // Inside the transcript: the list, each row, the block, and the nested thread
    // host/row/block all shrink instead of raising an intrinsic floor.
    expect(blockOf('.turns {')).toContain('min-width: 0');
    expect(blockOf('.turn-row {')).toContain('min-width: 0');
    expect(blockOf('.tile {')).toContain('min-width: 0');
    expect(blockOf('.thread-children {')).toContain('min-width: 0');
    expect(blockOf('.thread-row {')).toContain('min-width: 0');
    expect(blockOf('.thread-tile {')).toContain('min-width: 0');
});

it('caps every level at its parent width instead of widening the grid track', () => {
    // `max-width: 100%` is the belt-and-braces half: even an over-stretched
    // ancestor cannot make a level claim more than the width it was given.
    expect(blockOf('.pane {')).toContain('max-width: 100%');
    expect(blockOf('.log-wrap {')).toContain('max-width: 100%');
    expect(blockOf('.turns {')).toContain('max-width: 100%');
    expect(blockOf('.turn-row {')).toContain('max-width: 100%');
    expect(blockOf('.tile {')).toContain('max-width: 100%');
    expect(blockOf('.thread-children {')).toContain('max-width: 100%');
    expect(blockOf('.thread-row {')).toContain('max-width: 100%');
    expect(blockOf('.thread-tile {')).toContain('max-width: 100%');

    // The desktop reading width is still a cap, never a demanded width: `.log`
    // fills the scroll box first and only stops growing at 1180px.
    const log = blockOf('.log {');
    expect(log).toContain('width: 100%');
    expect(log).toContain('max-width: 1180px');
    expect(log).toContain('margin: 0 auto');

    // The three-column shell itself is unchanged: the fix must not steal width
    // from the rails.
    expect(blockOf('.shell {')).toContain(
        'grid-template-columns: 248px minmax(0, 1fr) 320px'
    );
});

it('contains the width instead of hiding the overflow at page level', () => {
    // "Don't just clip": the layout levels must reflow, so they may not swallow
    // overflow. Only the boxes that are SUPPOSED to scroll declare it.
    expect(blockOf('.stage {')).not.toContain('overflow');
    expect(blockOf('.pane {')).not.toContain('overflow');
    expect(blockOf('.log {')).not.toContain('overflow');

    // The transcript scrolls vertically, code blocks scroll horizontally inside it.
    expect(blockOf('.log-wrap {')).toContain('overflow: auto');
    // Anchored to the block's own first declaration: `.tool-result .code-block`
    // appears earlier in the file and would otherwise be sliced instead.
    expect(blockOf('.code-block {\n    max-height: 420px;')).toContain('overflow: auto');
    expect(blockOf('.reasoning {')).toContain('overflow: auto');
    // Anchored to its own first declaration: the margin group above also starts with
    // a `.markdown table {` selector line.
    expect(blockOf('.markdown table {\n    display: block;')).toContain('overflow: auto');

    // Prose still breaks inside the tile: a long unbroken word wraps instead of
    // forcing the block wider than the column.
    expect(blockOf('.markdown {')).toContain('overflow-wrap: anywhere');
});

it('keeps the rails responsive and the nested indentation intact', () => {
    // Phone: both rails still collapse to nothing and are restored by the open
    // state (R1) — containment must not have moved the chat or the rails.
    const phone = blockOf('@media (max-width: 860px)');
    expect(phone).toContain('.rail-left,\n    .rail-right {\n        display: none;\n    }');
    expect(phone).toContain('.center {\n        grid-row: 1;\n    }');

    // Tablet: the right rail is still the two-column strip under the chat.
    const tablet = blockOf('@media (max-width: 1180px)');
    expect(tablet).toContain('grid-template-columns: 216px minmax(0, 1fr)');
    expect(tablet).toContain('.rail-right {\n        grid-column: 1 / -1;');

    // Nesting still indents one step per level, including the narrow-screen step.
    const children = blockOf('.thread-children {');
    expect(children).toContain('--thread-indent: 18px');
    expect(children).toContain('padding-left: var(--thread-indent)');
    expect(rules).toMatch(
        /@media \(max-width: 600px\)[\s\S]*?\.thread-children \{[\s\S]*?--thread-indent: 10px;/
    );
});

it('keeps a collapsed turn a single full-width row after containment', () => {
    // R1 is the regression this containment could break: shrinking the pane must
    // not turn the compact row into a wrapping block.
    expect(blockOf('.tile:not(.is-expanded) {')).toContain('width: 100%');

    const select = blockOf('.tile:not(.is-expanded) .tile-select {');
    expect(select).toContain('flex-direction: row');
    expect(select).toContain('align-items: center');
    expect(select).toContain('padding: 6px 10px');

    const prompt = blockOf('.tile:not(.is-expanded) .tile-prompt {');
    expect(prompt).toContain('flex: 1 1 auto');
    expect(prompt).toContain('min-width: 0');
    expect(prompt).toContain('white-space: nowrap');
    expect(prompt).toContain('text-overflow: ellipsis');

    // The nested header is the same one-line contract.
    const threadSelect = blockOf('.thread-select {');
    expect(threadSelect).toContain('flex-direction: row');
    expect(blockOf('.thread-preview {')).toContain('text-overflow: ellipsis');
    expect(blockOf('.thread-preview {')).toContain('min-width: 0');
});

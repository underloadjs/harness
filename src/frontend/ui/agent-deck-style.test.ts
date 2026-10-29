// Agent card-deck CSS contract (R2).
//
// The deck is `[primary] ] ] ]`: one fully visible front card and one named strip
// per other card. jsdom cannot compute layout, so — like activity-style.test.ts and
// layout-containment.test.ts — this reads the stylesheet source and pins the
// geometry the component (ui/agents.ts) and the deck depend on:
//   - one fixed card width and one exposed-strip width, so the fan is predictable;
//   - the FRONT card is visual-first via `order: -1` (DOM order untouched) and is
//     stacked above the cards it covers, so its controls stay clickable;
//   - every hidden card is pulled left by exactly `width - peek + gap`, which is what
//     leaves `--agent-deck-peek` of its right edge visible;
//   - the strip button is absolutely positioned inside that visible edge, above the
//     card's own controls, so a strip click can only front the card;
//   - horizontal scrolling stays available as the fallback for extreme team sizes;
//   - the activity ring stays intact and non-blocking, and nothing added here
//     animates (so reduced motion needs no extra rule).

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

// The comments deliberately NAME the properties and selectors under discussion, so
// every assertion runs against the comment-stripped stylesheet.
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

// Slice a rule body by brace matching, so a nested at-rule cannot cut it short.
const blockOf = (selector: string): string => {
    const start = rules.indexOf(selector);
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

it('fixes one card width and one exposed-strip width', () => {
    const row = blockOf('.agent-row {');
    // The exact literals the geometry below is derived from: a 200px card that
    // exposes 52px per extra agent instead of a full card each.
    expect(row).toContain('--agent-deck-width: 200px');
    expect(row).toContain('--agent-deck-peek: 52px');
    expect(row).toContain('--agent-deck-gap: 6px');
    expect(row).toContain('display: flex');
    expect(row).toContain('gap: var(--agent-deck-gap)');
    // Fallback for an extreme team, not the primary layout mechanism.
    expect(row).toContain('overflow-x: auto');

    const tile = blockOf('.agent-tile {');
    expect(tile).toContain('position: relative');
    expect(tile).toContain('flex: 0 0 var(--agent-deck-width)');
    expect(tile).toContain('width: var(--agent-deck-width)');
    // The old content-sized card (128–200px) must be gone: the strip only lines up
    // with the exposed edge when every card is the same width.
    expect(tile).not.toContain('min-width: 128px');
    expect(tile).not.toContain('max-width: 200px');
    // The activity ring's dim track is still the tile border.
    expect(tile).toContain('border: 1px solid var(--border)');
});

it('puts the front card first visually and stacks each card above its right neighbour', () => {
    const front = blockOf(".agent-tile[data-front='true'] {");
    // `order` keeps the listitem DOM order (and every querySelector order) intact.
    expect(front).toContain('order: -1');

    // The rank is dynamic (leftmost above its right neighbour, whose body covers the
    // left card's exposed strip), so it is a custom property written per tile by
    // ui/agents.ts. Without it a later sibling would hide an earlier card's strip and
    // a click there would land on the neighbour's promotion button.
    expect(blockOf('.agent-tile {')).toContain('z-index: var(--agent-deck-z, 1)');
    expect(front).not.toContain('z-index');
    expect(blockOf(".agent-tile:not([data-front='true']) {")).not.toContain('z-index');

    const hidden = blockOf(".agent-tile:not([data-front='true']) {");
    // Exactly one strip stays visible: width - peek + gap must be subtracted. The
    // gap is included because the flex `gap` would otherwise push each strip 6px
    // further right per card and drift it away from the handle.
    expect(hidden).toContain(
        'margin-left: calc(var(--agent-deck-peek) - var(--agent-deck-width) - var(--agent-deck-gap))'
    );

    // The front card must win the overlap, or its name/remove/model controls would be
    // covered by the cards it fronts.
    expect(rules.indexOf(".agent-tile[data-front='true'] {")).toBeLessThan(
        rules.indexOf(".agent-tile:not([data-front='true']) {")
    );
});

it('sizes the strip button to the exposed edge and hides it on the front card', () => {
    const handle = blockOf('.agent-handle {');
    expect(handle).toContain('position: absolute');
    expect(handle).toContain('right: 0');
    expect(handle).toContain('top: 0');
    expect(handle).toContain('bottom: 0');
    expect(handle).toContain('width: var(--agent-deck-peek)');
    // Above the card's own controls, so the strip can never hit remove/select.
    expect(handle).toContain('z-index: 3');
    expect(handle).toContain('cursor: pointer');

    // `hidden` (the front card's handle) must beat the `display: flex` above it.
    const hidden = blockOf('.agent-handle[hidden] {');
    expect(hidden.trim()).toBe('display: none;');
    expect(rules.indexOf('.agent-handle[hidden] {')).toBeGreaterThan(
        rules.indexOf('.agent-handle {')
    );

    const label = blockOf('.agent-handle-name {');
    // Vertical, book-spine reading for a strip much narrower than a name; the full
    // name is still available through the button's title/aria-label (ui/agents.ts).
    expect(label).toContain('writing-mode: vertical-rl');
    expect(label).toContain('transform: rotate(180deg)');
    expect(label).toContain('text-overflow: ellipsis');
    expect(label).toContain('overflow: hidden');
    expect(label).toContain('font-size: 10px');
});

it('keeps every card surface opaque so covered cards do not show through', () => {
    // The deck stacks cards, so a translucent surface would let the card underneath
    // bleed through the front card. The primary's green tint is therefore a gradient
    // layer over the solid elevated surface, not a bare rgba background.
    const primary = blockOf(".agent-tile[data-role='primary'] {");
    expect(primary).toContain('var(--bg-elevated)');
    expect(primary).toContain('linear-gradient(rgba(74, 222, 128, 0.1), rgba(74, 222, 128, 0.1))');
    expect(primary).not.toContain('background: rgba(');
    // The base card surface and the strip hover wash sit on that opaque surface.
    expect(blockOf('.agent-tile {')).toContain('background: var(--bg-elevated)');
    expect(blockOf('.agent-handle:hover {')).toContain('background: rgba(255, 255, 255, 0.05)');
});

it('keeps the ring working and adds no animation', () => {
    // The activity ring is geometry-independent: it keeps its non-blocking
    // pointer-events:none, which is what still lets a strip click through.
    expect(blockOf(".agent-tile[data-activity='active']::before {")).toContain(
        'pointer-events: none'
    );

    // Nothing in the deck rules animates or transitions position, so reduced motion
    // needs no extra rule for it (the existing ring reduced-motion rule stays).
    for (const selector of [
        ".agent-tile[data-front='true'] {",
        ".agent-tile:not([data-front='true']) {",
        '.agent-handle {',
        '.agent-handle-name {'
    ]) {
        const block = blockOf(selector);
        expect(block).not.toContain('animation');
        expect(block).not.toContain('transition');
    }
});

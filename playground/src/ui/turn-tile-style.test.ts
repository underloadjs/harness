// Compact turn-tile CSS contract.
//
// The slim tile and its state cues are pure CSS, so jsdom cannot compute them.
// Like activity-style.test.ts this test reads the stylesheet source and pins the
// properties that make the design work:
//   - no square `aspect-ratio` on a collapsed tile (it reserved ~210px of empty
//     space under the prompt) and a two-line prompt clamp;
//   - a compact status whose word is clipped, not removed (assistive tech keeps
//     it), so "done" is never a second visible label;
//   - green/red/neutral tile borders for done/error/cancelled;
//   - the same conic-gradient ring and `agent-ring-spin` keyframes the agent row
//     uses while a tile is queued/waiting/streaming;
//   - reduced motion freezes that ring and forced colors replaces it with an
//     outline.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// `import.meta.url` is not a file: URL under jsdom. Resolve the stylesheet from
// the package root (`npm test`) or the playground root (vitest.config.ts `root`).
const stylesheet = ['playground/src/styles.css', 'src/styles.css']
    .map((candidate) => resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(candidate));
if (stylesheet === undefined) throw new Error('styles.css not found');

const css = readFileSync(stylesheet, 'utf8');

// CSS selectors contain `{`/`}` inside pseudo-class arguments? No — the tile
// selectors here are plain attribute/pseudo-class lists, so the first `{` after
// the selector opens the rule and the first `}` closes it.
const blockOf = (selector: string): string => {
    const start = css.indexOf(selector);
    if (start < 0) throw new Error(`missing selector ${selector}`);

    const open = css.indexOf('{', start);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
};

it('keeps a collapsed tile content-high instead of square', () => {
    const compact = blockOf('.tile:not(.is-expanded) {');

    // The empty middle came from `aspect-ratio: 1 / 1`; it must not come back.
    expect(compact).not.toContain('aspect-ratio');
    expect(compact).toContain('align-self: start');

    const select = blockOf('.tile:not(.is-expanded) .tile-select {');
    expect(select).toContain('padding: 8px 10px 9px');
    expect(select).toContain('gap: 4px');

    const prompt = blockOf('.tile:not(.is-expanded) .tile-prompt {');
    expect(prompt).toContain('-webkit-line-clamp: 2');
});

it('clips the compact status word and colour-codes the timeline states', () => {
    const statusText = blockOf('.tile:not(.is-expanded) .tile-status-text {');
    expect(statusText).toContain('position: absolute');
    expect(statusText).toContain('clip-path: inset(50%)');
    // Clipped rather than `display: none`: the word stays readable to a screen
    // reader while the tile itself shows colour instead.
    expect(statusText).not.toContain('display: none');

    // R4: completed is GREY; green is reserved for the one active task.
    expect(blockOf(".tile:not(.is-expanded)[data-state='done'] {")).toContain('border-color: var(--border)');
    expect(blockOf(".tile:not(.is-expanded)[data-state='streaming'] {")).toContain(
        'border-color: rgba(74, 222, 128, 0.5)'
    );
    expect(blockOf(".tile:not(.is-expanded)[data-state='error'] {")).toContain(
        'border-color: rgba(248, 113, 113, 0.5)'
    );
    // Completed status text is muted too: no green glow on finished work.
    expect(blockOf(".tile[data-state='done'] .tile-status {")).toContain('color: var(--muted)');
    // Cancelled stays neutral: no green, no red.
    expect(css).not.toContain(".tile:not(.is-expanded)[data-state='cancelled'] {");
});

it('sweeps the agent activity ring around the active tile only', () => {
    const ring = blockOf(".tile:not(.is-expanded)[data-state='streaming']::before {");

    expect(ring).toContain('from var(--agent-ring-angle, 0deg)');
    expect(ring).toContain('var(--accent) 330deg');
    expect(ring).toContain('#b9cdff 360deg');
    expect(ring).toContain('padding: 1px');
    expect(ring).toContain('mask-composite: exclude');
    expect(ring).toContain('pointer-events: none');
    expect(ring).toContain('animation: agent-ring-spin 900ms linear infinite');

    // The shared keyframes and registered property are the consistency contract
    // with `.agent-tile[data-activity='active']::before`.
    expect(css).toContain('@keyframes agent-ring-spin');
    expect(css).toContain('@property --agent-ring-angle');

    // R4: a queued task is NOT spinning; only waiting/streaming animate, and a
    // settled tile never does.
    const ringSelectors = css.slice(
        css.indexOf("/* Compact tile activity ring"),
        css.indexOf("content: ''", css.indexOf('/* Compact tile activity ring'))
    );
    expect(ringSelectors).not.toContain("[data-state='queued']");
    expect(ringSelectors).toContain("[data-state='waiting']");
    expect(ringSelectors).toContain("[data-state='streaming']");
    expect(ringSelectors).not.toContain("[data-state='done']");
    expect(ringSelectors).not.toContain("[data-state='error']");
    expect(ringSelectors).not.toContain("[data-state='cancelled']");
});

it('lays the turns out as one linear timeline with grey completed markers', () => {
    // R4: a single vertical timeline, not the old responsive grid.
    const turns = blockOf('.turns {');
    expect(turns).toContain('display: flex');
    expect(turns).toContain('flex-direction: column');
    expect(turns).not.toContain('grid-template-columns');

    // Completed rows are grey; the active one is the only green marker.
    expect(blockOf(".turn-row[data-state='done'] .turn-marker {")).toContain("background: var(--muted)");
    expect(blockOf(".turn-row[data-state='streaming'] .turn-marker {")).toContain('background: var(--ok)');
    expect(blockOf(".turn-row[data-state='queued'] .turn-marker {")).toContain(
        'background: var(--border-strong)'
    );
    // Queued status text is neutral, never green.
    expect(blockOf(".tile[data-state='queued'] .tile-status {")).toContain('color: var(--muted)');
});

it('freezes the tile ring for reduced motion and outlines it under forced colors', () => {
    expect(css).toMatch(
        /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.tile\[data-state='streaming'\]::before[\s\S]*?animation: none !important;/
    );

    expect(css).toMatch(
        /@media \(forced-colors: active\)[\s\S]*?\.tile:not\(\.is-expanded\)\[data-state='streaming'\] \{[\s\S]*?outline: 2px solid CanvasText;/
    );
    expect(css).toMatch(
        /@media \(forced-colors: active\)[\s\S]*?\.tile:not\(\.is-expanded\)\[data-state='streaming'\]::before \{[\s\S]*?display: none;/
    );
});

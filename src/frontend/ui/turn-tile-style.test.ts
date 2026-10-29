// Compact turn-tile CSS contract.
//
// The slim tile and its state cues are pure CSS, so jsdom cannot compute them.
// Like activity-style.test.ts this test reads the stylesheet source and pins the
// properties that make the design work:
//   - no square `aspect-ratio` on a collapsed tile (it reserved ~210px of empty
//     space under the prompt) and no multi-line clamp: a compact task is ONE
//     full-width line (R1);
//   - no timeline rule and no marker dot (R1): rows only;
//   - a compact status whose word is clipped, not removed (assistive tech keeps
//     it), so "done" is never a second visible label;
//   - green/red/neutral tile borders for done/error/cancelled;
//   - the same conic-gradient ring and `agent-ring-spin` keyframes the agent row
//     uses while a tile is waiting/streaming;
//   - reduced motion freezes that ring and forced colors replaces it with an
//     outline.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// `import.meta.url` is not a file: URL under jsdom. Resolve the stylesheet from
// the package root (`npm test`) or the frontend root (vitest.config.ts `root`).
const stylesheet = ['src/frontend/styles.css', 'src/styles.css']
    .map((candidate) => resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(candidate));
if (stylesheet === undefined) throw new Error('styles.css not found');

const css = readFileSync(stylesheet, 'utf8');

// Comments deliberately name removed rules, so "this rule is gone" assertions run
// against the stylesheet with comments stripped (see thread-style.test.ts).
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

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

it('keeps a collapsed tile a single full-width line instead of a square card', () => {
    const compact = blockOf('.tile:not(.is-expanded) {');

    // The empty middle came from `aspect-ratio: 1 / 1`; it must not come back.
    expect(compact).not.toContain('aspect-ratio');
    // R1: a compact task is a FULL-WIDTH row, not a card that hugs its content.
    expect(compact).toContain('width: 100%');
    expect(compact).not.toContain('align-self: start');

    const select = blockOf('.tile:not(.is-expanded) .tile-select {');
    // ONE line: the header lays out as a row (prompt + metadata group).
    expect(select).toContain('flex-direction: row');
    expect(select).toContain('align-items: center');
    expect(select).toContain('padding: 6px 10px');

    const prompt = blockOf('.tile:not(.is-expanded) .tile-prompt {');
    // Clamped by ellipsis, never by a multi-line clamp: the row cannot grow.
    expect(prompt).toContain('white-space: nowrap');
    expect(prompt).toContain('text-overflow: ellipsis');
    expect(prompt).not.toContain('-webkit-line-clamp');

    // The meta line would be a second line, so it is clipped (still in the DOM
    // for assistive tech, exactly like the status word).
    const meta = blockOf('.tile:not(.is-expanded) .tile-meta {');
    expect(meta).toContain('clip-path: inset(50%)');
});

it('clips the compact status word and colour-codes the rows', () => {
    const statusText = blockOf('.tile:not(.is-expanded) .tile-status-text {');
    expect(statusText).toContain('position: absolute');
    expect(statusText).toContain('clip-path: inset(50%)');
    // Clipped rather than `display: none`: the word stays readable to a screen
    // reader while the tile itself shows colour instead.
    expect(statusText).not.toContain('display: none');

    // R4: completed is GREY; green is reserved for the one active task. R3: the
    // surface rules are grouped with `.thread-tile` so a nested block gets the SAME
    // treatment (no second copy can drift).
    expect(blockOf(":is(.tile, .thread-tile):not(.is-expanded)[data-state='done'] {")).toContain(
        'border-color: var(--border)'
    );
    expect(blockOf(":is(.tile, .thread-tile):not(.is-expanded)[data-state='streaming'] {")).toContain(
        'border-color: rgba(74, 222, 128, 0.5)'
    );
    expect(blockOf(":is(.tile, .thread-tile):not(.is-expanded)[data-state='error'] {")).toContain(
        'border-color: rgba(248, 113, 113, 0.5)'
    );
    // Completed status text is muted too: no green glow on finished work.
    expect(blockOf(".tile[data-state='done'] .tile-status {")).toContain('color: var(--muted)');
    // Cancelled stays neutral: no green, no red. (No surface rule is written for it
    // on either block owner.)
    expect(rules).not.toContain(":is(.tile, .thread-tile):not(.is-expanded)[data-state='cancelled']");
});

it('sweeps the agent activity ring around the active block, main or nested', () => {
    const ring = blockOf(
        ":is(.tile, .thread-tile):not(.is-expanded)[data-state='waiting']::before,"
    );

    expect(ring).toContain('from var(--agent-ring-angle, 0deg)');
    expect(ring).toContain('var(--accent) 330deg');
    expect(ring).toContain('#b9cdff 360deg');
    expect(ring).toContain('padding: 1px');
    expect(ring).toContain('mask-composite: exclude');
    expect(ring).toContain('pointer-events: none');
    expect(ring).toContain('animation: agent-ring-spin 900ms linear infinite');

    // R3: the SAME rule list covers `.thread-tile`, so a working child entry shows
    // the ring the working main tile shows (the markup half of that parity is the
    // mirrored `data-state` in ui/turns.ts). `blockOf` returns declarations only, so
    // the selector list itself is asserted on the stylesheet text.
    expect(css).toContain(
        ":is(.tile, .thread-tile):not(.is-expanded)[data-state='streaming']::before {"
    );

    // The shared keyframes and registered property are the consistency contract
    // with `.agent-tile[data-activity='active']::before`.
    expect(css).toContain('@keyframes agent-ring-spin');
    expect(css).toContain('@property --agent-ring-angle');

    // R4: a queued task is NOT spinning; only waiting/streaming animate, and a
    // settled tile never does.
    const ringSelectors = css.slice(
        css.indexOf('/* Compact tile activity ring'),
        css.indexOf("content: ''", css.indexOf('/* Compact tile activity ring'))
    );
    expect(ringSelectors).not.toContain("[data-state='queued']");
    expect(ringSelectors).toContain("[data-state='waiting']");
    expect(ringSelectors).toContain("[data-state='streaming']");
    expect(ringSelectors).not.toContain("[data-state='done']");
    expect(ringSelectors).not.toContain("[data-state='error']");
    expect(ringSelectors).not.toContain("[data-state='cancelled']");
});

it('lays the turns out as one plain full-width list with no timeline decoration', () => {
    // R1: a single vertical list, not the old responsive grid, and no left gutter
    // reserved for a rule/marker column.
    const turns = blockOf('.turns {');
    expect(turns).toContain('display: flex');
    expect(turns).toContain('flex-direction: column');
    expect(turns).not.toContain('grid-template-columns');
    expect(turns).not.toContain('padding-left');

    // No rule drawn behind the rows.
    expect(css).not.toContain('.turns::before');
    // No marker dot: the element and every one of its state colours is gone.
    expect(css).not.toContain('.turn-marker');
    // Rows are full width, one line each.
    expect(blockOf('.turn-row {')).toContain('width: 100%');
    // Queued status text is neutral, never green.
    expect(blockOf(".tile[data-state='queued'] .tile-status {")).toContain('color: var(--muted)');
});

it('outlines the main tile in its agent colour and defaults to the neutral tone', () => {
    // R3: identity is drawn as an OUTLINE so it survives the state border. The tile
    // is the root invocation's block, exactly like `.thread-tile` is a child's.
    const tile = blockOf('.tile {');
    expect(tile).toContain('outline: 1px solid var(--agent-line)');
    expect(tile).toContain('outline-offset: -2px');

    // The documented unknown-agent fallback (ui/agent-color.ts UNKNOWN_AGENT_COLOR).
    const root = blockOf(':root {');
    expect(root).toContain('--agent-color: #8b94a7');
    expect(root).toContain('--agent-line: rgba(139, 148, 167, 0.55)');

    // The agent name in an agent section reads the same painted property.
    expect(blockOf('.agent-name {')).toContain('color: var(--agent-color)');
    // No role badge survives anywhere (R3).
    expect(rules).not.toContain('.agent-role');
});

it('freezes the tile ring for reduced motion and outlines it under forced colors', () => {
    expect(css).toMatch(
        /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.tile\[data-state='streaming'\]::before[\s\S]*?animation: none !important;/
    );
    // R3: the nested ring freezes with it (same reduced-motion list).
    expect(css).toMatch(
        /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.thread-tile\[data-state='streaming'\]::before[\s\S]*?animation: none !important;/
    );

    // Forced colors: the grouped selector means a working CHILD gets the same
    // system outline as a working main tile, and its ring is removed too.
    expect(css).toMatch(
        /@media \(forced-colors: active\)[\s\S]*?:is\(\.tile, \.thread-tile\):not\(\.is-expanded\)\[data-state='streaming'\] \{[\s\S]*?outline: 2px solid CanvasText;/
    );
    expect(css).toMatch(
        /@media \(forced-colors: active\)[\s\S]*?:is\(\.tile, \.thread-tile\):not\(\.is-expanded\)\[data-state='streaming'\]::before \{[\s\S]*?display: none;/
    );
});

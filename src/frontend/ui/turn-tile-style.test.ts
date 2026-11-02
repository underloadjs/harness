// Compact turn-tile CSS contract.
//
// The slim tile and its state cues are pure CSS, so jsdom cannot compute them.
// Like activity-style.test.ts this test reads the stylesheet source and pins the
// properties that make the design work:
//   - no square `aspect-ratio` on a collapsed tile (it reserved ~210px of empty
//     space under the prompt) and no multi-line clamp: a compact task is ONE
//     full-width line (R1);
//   - no timeline rule and no marker dot (R1): rows only;
//   - a status whose word is clipped in BOTH header states (assistive tech keeps
//     it), so `- done` is never a visible suffix of the measurement line; the
//     line's colour is the state cue (done green, streaming yellow, error red);
//   - green/red/neutral tile borders for done/error/cancelled;
//   - the same conic-gradient ring and `agent-ring-spin` keyframes the agent row
//     uses while a tile is waiting/streaming;
//   - an EXPANDED header wraps as a ROW: the identity cluster plus the measurement line
//     on the badge's own baseline (flush right), with the meta forced onto the line
//     below. The right-edge control slot that used to be reserved for a button is gone;
//   - the inline think chip (`.tool.think`) paints its label and figure with the amber
//     `--warn` token on the SHARED tool pill box; the full-width `.thinking` bar it
//     replaced is gone and its text scrolls inside the dialog;
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

// Declarations of EVERY rule written for a selector, in stylesheet order. `blockOf`
// returns only the first, and the expanded-header selectors really are declared twice
// (an early `cursor: default` override, then the row-wrap contract further down), so the
// wrap behaviour has to be read off the LAST one — the cascade's winner.
const blocksOf = (selector: string): string[] => {
    const blocks: string[] = [];
    let start = css.indexOf(selector);
    if (start < 0) throw new Error(`missing selector ${selector}`);

    while (start >= 0) {
        const open = css.indexOf('{', start);
        const close = css.indexOf('}', open);
        blocks.push(css.slice(open + 1, close));
        start = css.indexOf(selector, close);
    }
    return blocks;
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

it('clips the state word in both header states and colour-codes the measurement line', () => {
    // T2: the measurement line is `34.2s | 18,654 (37,376)` and NOTHING else visible.
    // The state word stays in the DOM as a screen-reader label in BOTH header states —
    // clipped, never `display: none` — so the state is still announced (and still
    // searchable) while `- done` is no longer painted. ONE grouped rule for both block
    // owners, so a collapsed child is as sparse as a collapsed parent and an expanded
    // child as sparse as an expanded parent.
    const statusText = blockOf(
        ':is(.tile, .thread-tile) :is(.tile-status-text, .thread-status-text) {'
    );
    expect(statusText).toContain('position: absolute');
    expect(statusText).toContain('clip-path: inset(50%)');
    expect(statusText).not.toContain('display: none');

    // The old split treatment (word visible on an EXPANDED header) must not come back:
    // it is what made `- done` a visible suffix, and it is what the T5 clip machinery
    // existed to protect the Delete slot from.
    expect(rules).not.toContain(
        ':is(.tile:not(.is-expanded), .thread-row:not(.is-expanded)) :is(.tile-status-text'
    );
    expect(rules).not.toMatch(
        /:is\(\.tile\.is-expanded, \.thread-tile\.is-expanded\)\s*:is\(\.tile-status(-text)?, \.thread-status(-text)?\)/
    );
    // And the generated ` - ` that joined the word to the figures is gone with it.
    expect(rules).not.toContain("content: ' - '");
    // The measurement separator is still the SPACED ` | ` between the two figures.
    expect(
        blockOf(
            ':is(.tile-elapsed, .thread-elapsed):not([hidden]) + :is(.tile-tokens, .thread-tokens):not([hidden])::before {'
        )
    ).toContain("content: ' | '");

    // R3: the turn ordinal was removed from the DOM, so its rule is gone too.
    expect(rules).not.toContain('.tile-index');

    // R4: the ROW SURFACE keeps its own cue set (frame + ring), grouped with
    // `.thread-tile` so a nested block gets the SAME treatment (no second copy can
    // drift). Green still frames the one active row; the line colour below is the
    // settled/failed/completed cue the reviewer asked for.
    expect(blockOf(":is(.tile, .thread-tile):not(.is-expanded)[data-state='done'] {")).toContain(
        'border-color: var(--border)'
    );
    expect(blockOf(":is(.tile, .thread-tile):not(.is-expanded)[data-state='streaming'] {")).toContain(
        'border-color: rgba(74, 222, 128, 0.5)'
    );
    expect(blockOf(":is(.tile, .thread-tile):not(.is-expanded)[data-state='error'] {")).toContain(
        'border-color: rgba(248, 113, 113, 0.5)'
    );

    // T2: the measurement LINE carries the state by colour, exactly as requested —
    // done GREEN, streaming YELLOW, error RED. Written against the figure labels
    // because the state box holds only a clipped word, so colouring that box alone
    // would colour nothing a human can see.
    expect(
        blockOf(
            ":is(.tile, .thread-tile)[data-state='done'] :is(.tile-elapsed, .tile-tokens, .thread-elapsed, .thread-tokens) {"
        )
    ).toContain('color: var(--ok)');
    expect(
        blockOf(
            ":is(.tile, .thread-tile)[data-state='streaming'] :is(.tile-elapsed, .tile-tokens, .thread-elapsed, .thread-tokens),"
        )
    ).toContain('color: var(--warn)');
    expect(
        blockOf(
            ":is(.tile, .thread-tile)[data-state='error'] :is(.tile-elapsed, .tile-tokens, .thread-elapsed, .thread-tokens) {"
        )
    ).toContain('color: var(--danger)');

    // The word's own colour agrees with the line's in every state, so no surface can
    // disagree about what state a block is in (cancelled/queued stay neutral).
    expect(blockOf(".tile[data-state='done'] .tile-status {")).toContain('color: var(--ok)');
    expect(blockOf(".tile[data-state='streaming'] .tile-status {")).toContain('color: var(--warn)');
    expect(blockOf(".tile[data-state='error'] .tile-status {")).toContain('color: var(--danger)');
    expect(blockOf(".tile[data-state='cancelled'] .tile-status {")).toContain('color: var(--muted)');
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

it('wraps an expanded header into one row with the measurement line flush right', () => {
    // The expanded header used to be a COLUMN under a reserved right-edge button slot.
    // The requested shape is:
    //   line 1:  RR1                         4m09s | 42,212 (358,448)
    //   line 2:  1 agent · 23 tool calls · local/basalt
    // `flex-flow: row wrap` plus the existing `order` values is the whole mechanism, and
    // `align-items: baseline` is what puts the 10.5px mono figures on the BADGE's text
    // baseline instead of floating a couple of pixels off it.
    //
    // The selector is declared twice (early `cursor: default`, then the wrap rule), so
    // the contract is read from the LAST rule — the one the cascade actually applies.
    const headers = blocksOf('.tile.is-expanded .tile-select {');
    expect(headers).toHaveLength(2);
    expect(headers[0]).toContain('cursor: default');

    const header = headers[1];
    expect(header).toContain('flex-flow: row wrap');
    expect(header).toContain('align-items: baseline');
    expect(header).toContain('column-gap: 10px');
    expect(header).toContain('row-gap: 4px');

    // The order values are what place each item on the line: identity (default 0) leads,
    // the measurement line closes line 1 flush right, the meta takes line 2 alone.
    expect(blockOf('.tile.is-expanded .tile-top {')).toContain('order: 1');
    expect(blockOf('.tile.is-expanded .tile-top {')).toContain('margin-left: auto');
    expect(blockOf('.tile.is-expanded .tile-meta {')).toContain('order: 2');
    expect(blockOf('.tile.is-expanded .tile-meta {')).toContain('flex: 1 0 100%');

    // `flex: 1 0 100%` is the ONLY line-break mechanism — a `clear`/`width: 100%` hack on
    // the meta, or a `flex-direction: column` on the header, would stack it again.
    expect(header).not.toContain('flex-direction: column');
    expect(blockOf('.tile.is-expanded .tile-meta {')).not.toContain('clear:');

    // The line still has to be able to SHRINK. Grouped with `.thread-top`, so the nested
    // column gets the same ellipsis as the main tile's header.
    expect(
        blockOf(':is(.tile.is-expanded, .thread-tile.is-expanded) :is(.tile-top, .thread-top) {')
    ).toContain('flex: 0 1 auto');
    expect(
        blockOf(':is(.tile.is-expanded, .thread-tile.is-expanded) :is(.tile-top, .thread-top) {')
    ).toContain('min-width: 0');

    // THE DEAD SPACE: the 92px padding that defended the absolutely positioned header
    // button, and the button classes themselves, are gone — with ordinary flex items
    // there is nothing to float, no z-index to win, and no overlap to defend.
    expect(rules).not.toContain('padding-right: 92px');
    expect(rules).not.toContain('.tile-header-action');
    expect(rules).not.toContain('.thread-header-action');
    expect(rules).not.toContain('.thread-focus-head-action');
});

it('paints the inline think chip amber on the shared tool pill box', () => {
    // A streamed reasoning round is a CHIP in the agent's tool row, not the full-width
    // `<details>` bar that used to sit between chips (that bar broke the row on every
    // round). `.think` borrows the whole `.tool` box and changes only the register.
    expect(blockOf('.tool.think {')).toContain('border-color: rgba(251, 191, 36, 0.35)');
    expect(blockOf('.think .think-count {')).toContain('border-color: rgba(251, 191, 36, 0.4)');

    // "Make think yellow": the label AND the figure read `--warn`, the app's existing
    // amber tone, so a thinking-heavy run is scannable without a new colour token.
    expect(blockOf(':is(.think .tool-name, .think .think-count) {')).toContain('color: var(--warn)');
    expect(blockOf(':root {')).toContain('--warn: #fbbf24');

    // The figure is painted by ONE pill rule shared with `.tool-duration`, so the two
    // chip kinds can never drift apart in shape, size or tabular figures — only colour.
    const pill = blockOf(':is(.tool-duration, .think-count) {');
    expect(pill).toContain('display: inline-flex');
    expect(pill).toContain('flex: 0 0 auto');
    expect(pill).toContain('border: 1px solid var(--border-strong)');
    expect(pill).toContain('border-radius: 999px');
    expect(pill).toContain('font-variant-numeric: tabular-nums');
    expect(pill).toContain('white-space: nowrap');
    // No honest denominator, no pill (never a fabricated `0%`): `[hidden]` has to beat the
    // pill's own `display`, and it is the only suppression path for either chip.
    expect(blockOf(':is(.tool-duration, .think-count)[hidden] {')).toContain('display: none');

    // The old bar is gone from the stylesheet entirely (`.thinking` / `.thinking-summary`).
    expect(rules).not.toContain('.thinking');
});

it('keeps the reasoning text scrolling in the card and filling the dialog', () => {
    // Card side: a plain-text scroll box, so one long thinking dump cannot grow a
    // page-level scrollbar on the transcript column.
    const reasoning = blockOf('.reasoning {');
    expect(reasoning).toContain('overflow: auto');
    expect(reasoning).toContain('padding: 7px 10px 9px 10px');
    expect(reasoning).toContain('max-height: 260px');
    expect(reasoning).toContain('white-space: pre-wrap');

    // Dialog side: the node moves into the modal, so the card's 260px cap must not follow
    // it — the shell owns the height and the text box scrolls its own overflow.
    const inDialog = blockOf('.dialog-body > .tool-body > .tool-section > .reasoning {');
    expect(inDialog).toContain('flex: 1 1 auto');
    expect(inDialog).toContain('min-height: 0');
    expect(inDialog).toContain('max-height: none');
});

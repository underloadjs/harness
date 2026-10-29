// Invocation-thread CSS contract (R1/R2/R3/R4).
//
// jsdom cannot compute layout, so — like turn-tile-style.test.ts — this reads the
// stylesheet source and pins the properties the thread layout depends on:
//   - R3: main and nested blocks are the SAME surface (radius/background) and the
//     only hierarchy cue is indentation. The old amber left "hierarchy stripe" and
//     its per-depth tone rules must stay gone, and no role badge class exists;
//   - R3: every nested block carries the agent outline variable
//     (`--agent-line`, painted by ui/agent-color.ts) so identity is readable;
//   - R4: a collapsed entry is exactly ONE row — the header is a row flex and the
//     task preview is the single flexible, ellipsised item;
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

// Comments deliberately NAME the removed rules ("no `.thread-role` badge"), so
// "this rule is gone" assertions must run against the stylesheet with comments
// stripped — otherwise the documentation itself fails the test.
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

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

    // R3: hierarchy is indentation ONLY. The row must have no stripe of its own and
    // no extra left padding duplicating the host indent.
    const row = blockOf('.thread-row {');
    expect(row).not.toContain('border-left');
    expect(row).not.toContain('padding-left');
    // Depth stays mirrored as an attribute for styling/assistive context, but it no
    // longer paints a tone; nothing may reintroduce a depth-coloured rule.
    expect(rules).not.toContain('.thread-row[data-depth=');
    expect(rules).not.toContain("rgba(251, 191, 36, 0.45)");
    // The role chip is gone from the DOM and the stylesheet.
    expect(rules).not.toContain('.thread-role');
    expect(rules).not.toContain('.agent-role');
});

it('gives a nested block the same surface and agent outline as a main block', () => {
    const tile = blockOf('.thread-tile {');

    // Same radius and background as `.tile`: only the indentation differs.
    expect(tile).toContain('border-radius: var(--radius)');
    expect(tile).toContain('background: var(--bg-elevated)');
    // Agent identity (R3): the outline is drawn from the painted custom property,
    // on top of the state border, so it survives every state.
    expect(tile).toContain('outline: 1px solid var(--agent-line)');
    expect(tile).toContain('outline-offset: -2px');
    // The nested tile needs its own box for the shared absolute busy ring.
    expect(tile).toContain('position: relative');

    // The main tile carries the identical outline treatment.
    expect(blockOf('.tile {')).toContain('outline: 1px solid var(--agent-line)');

    // The agent code reads the same property the outline uses; R1/F3 paints the
    // root block's `.tile-agent` with the SAME rule as the nested `.thread-name`.
    expect(blockOf(':is(.tile-agent, .thread-name) {')).toContain('color: var(--agent-color)');

    // R3 STATE PARITY: the surface/expanded/ring rules are written ONCE against the
    // grouped block-owner selector, so main and nested cannot drift (before the
    // correction, nested `done` stayed elevated, nested streaming had no ring and
    // nested expanded had no strong frame). The DOM half of the mirror is pinned in
    // turns-threads.test.ts.
    expect(blockOf(":is(.tile, .thread-tile):not(.is-expanded)[data-state='done'] {")).toContain(
        'background: transparent'
    );
    expect(blockOf(":is(.tile, .thread-tile):not(.is-expanded)[data-state='streaming'] {")).toContain(
        'border-color: rgba(74, 222, 128, 0.5)'
    );
    expect(blockOf(":is(.tile, .thread-tile):not(.is-expanded)[data-state='error'] {")).toContain(
        'border-color: rgba(248, 113, 113, 0.5)'
    );
    expect(blockOf(':is(.tile, .thread-tile).is-expanded {')).toContain(
        'border-color: var(--border-strong)'
    );
    expect(
        blockOf(":is(.tile, .thread-tile):not(.is-expanded)[data-state='waiting']::before,")
    ).toContain('animation: agent-ring-spin 900ms linear infinite');

    // No per-structure duplicate survives (that duplication is what drifted).
    expect(rules).not.toContain('.thread-row:not(.is-expanded)[data-state=');
    expect(rules).not.toContain('.thread-row:not(.is-expanded) > .thread-tile');
});

it('hides only the entry body when collapsed', () => {
    const collapsed = blockOf('.thread-row:not(.is-expanded) .thread-body {');

    expect(collapsed).toContain('display: none');
    // The children host is a SIBLING of the body in the DOM (ui/turns.ts), so no
    // rule here can hide descendants; pin that the selector targets only the body.
    expect(css).not.toContain('.thread-row:not(.is-expanded) .thread-children');
    expect(css).toContain('.thread-row.is-expanded .thread-preview');
});

it('keeps a collapsed entry to ONE compact line with an ellipsised preview', () => {
    // R4: the header is a ROW (name · preview · status), never the old two-line
    // column that pushed the preview onto its own row.
    const select = blockOf('.thread-select {');
    expect(select).toContain('flex-direction: row');
    expect(select).toContain('align-items: center');
    // Same vertical padding as the compact turn tile so both collapsed blocks are
    // the same height.
    expect(select).toContain('padding: 6px 10px');
    expect(select).toContain('cursor: pointer');
    expect(select).toContain('color: inherit');
    expect(blockOf('.thread-select:focus-visible {')).toContain('outline: 2px solid var(--accent)');

    // The preview takes the leftover width and ellipsises: no wrap, no second row.
    const preview = blockOf('.thread-preview {');
    expect(preview).toContain('flex: 1 1 auto');
    expect(preview).toContain('min-width: 0');
    expect(preview).toContain('white-space: nowrap');
    expect(preview).toContain('text-overflow: ellipsis');
    expect(preview).not.toContain('white-space: normal');

    // Status is TEXT (never colour-only), and R1 gives the nested word the SAME
    // typography as the main block's (one grouped rule) while its colour only
    // reinforces the state.
    expect(blockOf(':is(.tile-status, .thread-status) {\n    position: relative;')).toContain(
        'font-family: var(--mono)'
    );
    expect(blockOf(':is(.tile-status, .thread-status) {\n    position: relative;')).not.toContain(
        'display: none'
    );
    expect(blockOf(".thread-row[data-state='error'] .thread-status {")).toContain('color: var(--danger)');
    // R1 parity: every state the nested entry can reach is coloured, and a compact
    // nested word is clipped (not shown) exactly like the compact tile's.
    expect(blockOf(".thread-row[data-state='waiting'] .thread-status {")).toContain('color: var(--warn)');
    expect(
        blockOf(
            ':is(.tile:not(.is-expanded), .thread-row:not(.is-expanded)) :is(.tile-status-text, .thread-status-text) {'
        )
    ).toContain('clip-path: inset(50%)');
});

// R1: the parent and nested blocks share ONE anatomy — header metadata, body and
// prompt scale are single grouped rules, so the two owners cannot drift again.
it('shares the tile header metadata, body and prompt scale with the nested block', () => {
    expect(blockOf(':is(.tile-elapsed, .thread-elapsed) {')).toContain('font-size: 10.5px');
    expect(blockOf(':is(.tile-tokens, .thread-tokens) {')).toContain('font-variant-numeric: tabular-nums');
    expect(
        blockOf(
            ':is(.tile-elapsed, .thread-elapsed):not([hidden]) + :is(.tile-tokens, .thread-tokens):not([hidden])::before {'
        )
    ).toContain("content: ' | '");

    const body = blockOf(':is(.tile-body, .thread-body) {');
    expect(body).toContain('gap: 10px');
    expect(body).toContain('padding: 12px 14px 14px');
    expect(blockOf(':is(.turn-prompt, .thread-prompt) {')).toContain('padding: 9px 11px');
    expect(blockOf(':is(.tile-flow, .thread-flow) {')).toContain('gap: 10px');

    // The nested header keeps the compact tile's order: flexible preview then the
    // metadata cluster; the code leads. `order` (not DOM order) places them.
    expect(blockOf(':is(.tile-agent, .thread-name) {')).toContain('order: 0');
    expect(blockOf('.thread-preview {')).toContain('order: 1');
    expect(blockOf('.thread-top {')).toContain('order: 2');
    expect(blockOf('.thread-top {')).toContain('margin-left: auto');

    // F3: the root code is in the COMPACT header, so the expanded primary section
    // head (the same code again) is hidden. Flat legacy subagent heads stay visible
    // because they name DIFFERENT agents.
    expect(blockOf(".tile-flow > .agent[data-role='primary'] .agent-head {")).toContain('display: none');
    expect(css).not.toContain(".tile-flow > .agent[data-role='subagent'] .agent-head");
});

it('styles the per-invocation outcome and keeps it readable at depth', () => {
    expect(blockOf('.thread-outcome {')).toContain('overflow-wrap: anywhere');
    expect(blockOf(".thread-outcome[data-tone='error'] {")).toContain('color: var(--danger)');

    expect(css).toMatch(
        /@media \(max-width: 600px\)[\s\S]*?\.thread-children \{[\s\S]*?--thread-indent: 10px;/
    );
});

it('outlines a flat legacy subagent section without double-outlining the primary', () => {
    // R3: a second, unattributable agent section inside the tile flow is an
    // agent-owned block, so it gets its own colour outline; the primary section IS
    // the tile content and is excluded by the selector.
    const flat = blockOf(".tile-flow > .agent[data-role='subagent'] {");

    expect(flat).toContain('border: 1px solid var(--border)');
    expect(flat).toContain('border-radius: var(--radius)');
    expect(flat).toContain('outline: 1px solid var(--agent-line)');
    expect(flat).toContain('outline-offset: -2px');
    expect(flat).not.toContain('padding-top');

    // The primary section is never OUTLINED (no second frame around the main content);
    // F3 only hides its redundant head, which is a different rule.
    expect(rules).not.toContain(".tile-flow > .agent[data-role='primary'] {");
    expect(rules).not.toContain('.tile-flow > .agent {');
});

// R7/R8 session-control CSS contract, restated for T3/R1.
//
// The server-owned directory used to be a stack of rail ROWS (`.session-row` + a full
// meta block). T3/R1 moved it out of the right rail into a compact pill strip under the
// Instruct header (`main.ts` `createSessionPillBar`), and the same strip is inserted at
// the top of the harness details dialog on a phone. The behaviour layer owns the DOM;
// this file pins the CSS half of the agreed contract, and holds no import of main.ts so
// it stays runnable while the behaviour is changing:
//
//   .session-pills-bar[.session-pills-bar-head|.session-pills-bar-dialog] ← the strip
//     .session-pills                                                       ← role="list"
//       .session-pill[data-session-id][data-status][data-active][data-archived]
//         .session-pill-select                                             ← open
//           .session-pill-id                                               ← 8 chars ONLY
//         .session-pill-delete                                             ← one click
//       .session-pills-empty                                               ← empty hint
//     .new-session / .refresh-sessions                                     ← the actions
//
// Requirements pinned here:
//   - the strip is a WRAPPING row (it lives under the title, where horizontal overflow
//     would widen the chat column) and every level can shrink (`min-width: 0`);
//   - the pill is compact and rounded-full, with the id in monospace;
//   - the active, running and archived states are painted from the data attributes the
//     behaviour layer writes — never from a class the DOM does not produce;
//   - the destructive action is visually unambiguous, with disabled and focus states for
//     both controls, and the delete hit area stays at least 20x20;
//   - the rail DOM is GONE: no `.session-row`/`.session-list`/`.sessions-scope`/
//     `.session-archived*` rule may survive to style a surface that no longer exists;
//   - T1/R1 still holds: no `.session-confirm*` rule may exist;
//   - R7 removed the saved-session lock notice, so its `.agent-lock` / `.link-button`
//     rules must not exist any more.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// Same resolution as the other CSS-source tests: package root (`npm test`) or the
// frontend root (vitest.config.ts `root`).
const stylesheet = ['src/frontend/styles.css', 'src/styles.css']
    .map((candidate) => resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(candidate));
if (stylesheet === undefined) throw new Error('styles.css not found');

const css = readFileSync(stylesheet, 'utf8');

// Comments NAME the removed rules, so "must be gone" assertions need the stripped
// stylesheet (see thread-style.test.ts).
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

// Brace-matched slice, so a nested `@media` body is never cut at the first `}`.
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

it('lays the directory out as one wrapping strip that can shrink', () => {
    const bar = blockOf('.session-pills-bar {');

    // A row, but one that WRAPS: the strip sits under the title, where a single long line
    // of conversations would push the composer and the transcript wider than the column.
    expect(bar).toContain('display: flex');
    expect(bar).toContain('flex-wrap: wrap');
    expect(bar).toContain('align-items: center');
    expect(bar).toContain('gap: 6px');
    expect(bar).toContain('min-width: 0');
    expect(bar).toContain('max-width: 100%');

    // The list container wraps on its own axis too, and can shrink below its content:
    // a flex item's default `min-width: auto` is what used to widen the rail.
    const list = blockOf('.session-pills {');
    expect(list).toContain('display: flex');
    expect(list).toContain('flex-wrap: wrap');
    expect(list).toContain('min-width: 0');
    expect(list).toContain('max-width: 100%');
});

it('paints one compact rounded pill per conversation', () => {
    const pill = blockOf('.session-pill {');
    // Siblings (open + delete) inside one rounded shell, never nested buttons.
    expect(pill).toContain('display: inline-flex');
    expect(pill).toContain('border-radius: 999px');
    expect(pill).toContain('border: 1px solid var(--border)');
    expect(pill).toContain('background: var(--bg-elevated)');
    expect(pill).toContain('min-width: 0');
    expect(pill).toContain('max-width: 100%');

    const select = blockOf('.session-pill-select {');
    expect(select).toContain('cursor: pointer');
    expect(select).toContain('background: transparent');
    expect(select).toContain('min-width: 0');

    // The only visible text: monospace, small, and clipped instead of widening the strip.
    const id = blockOf('.session-pill-id {');
    expect(id).toContain('font-family: var(--mono)');
    expect(id).toContain('font-size: 11.5px');
    expect(id).toContain('overflow: hidden');
    expect(id).toContain('text-overflow: ellipsis');
    expect(id).toContain('white-space: nowrap');

    // Both controls advertise focus, and a locked pill reads as locked.
    expect(blockOf('.session-pill-select:focus-visible {')).toContain('outline: 2px solid var(--accent)');
    expect(blockOf('.session-pill-select:disabled {')).toContain('cursor: not-allowed');
});

it('marks active, running and archived states from the data attributes', () => {
    // `main.ts` writes `data-active` only on the conversation the card is pointed at.
    const active = blockOf(".session-pill[data-active='true'] {");
    expect(active).toContain('border-color: var(--accent)');
    expect(active).toContain('background: var(--accent-soft)');

    // `data-status` mirrors the server's status; a running/saving conversation is amber
    // (the same vocabulary as the topbar pill) and never colour-only (the attribute and
    // the tooltip carry the state).
    const running = rules.slice(
        rules.indexOf(".session-pill[data-status='running'] .session-pill-id,"),
        rules.indexOf('}', rules.indexOf(".session-pill[data-status='running'] .session-pill-id,"))
    );
    expect(running).toContain(".session-pill[data-status='saving'] .session-pill-id {");
    expect(running).toContain('color: var(--warn)');

    // R6: a conversation whose harness was deleted stays listed and stays clickable; the
    // dashed, muted frame is the only difference.
    const archived = blockOf(".session-pill[data-archived='true'] {");
    expect(archived).toContain('border-style: dashed');
    expect(archived).toContain('background: transparent');
    expect(blockOf(".session-pill[data-archived='true'] .session-pill-id {")).toContain(
        'color: var(--muted)'
    );
});

it('marks the delete control as destructive with disabled and focus states', () => {
    const remove = blockOf('.session-pill-delete {');
    expect(remove).toContain('display: inline-flex');
    // The hit area survives the compact pill: >= 20x20 on a touch screen.
    expect(remove).toContain('width: 22px');
    expect(remove).toContain('min-height: 22px');
    // Separated from the open button by a divider, so the two never read as one control.
    expect(remove).toContain('border-left: 1px solid var(--border)');
    expect(remove).toContain('color: var(--danger)');
    expect(remove).toContain('cursor: pointer');

    // Hover intensifies the danger instead of introducing it.
    expect(blockOf('.session-pill-delete:hover:not(:disabled) {')).toContain(
        'background: rgba(248, 113, 113, 0.12)'
    );

    // Focus is explicit (the generic accent ring is not enough for a destructive control)
    // and disabled is inert.
    expect(blockOf('.session-pill-delete:focus-visible {')).toContain('outline: 2px solid var(--danger)');
    expect(blockOf('.session-pill-delete:disabled {')).toContain('cursor: not-allowed');
    expect(blockOf('.session-pill-delete:disabled {')).toContain('opacity: 0.4');
});

it('keeps the empty hint short and the dialog heading present', () => {
    const empty = blockOf('.session-pills-empty {');
    expect(empty).toContain('color: var(--muted)');

    // R2 (T3): the phone dialog carries the strip, and needs its own caption.
    const heading = blockOf('.harness-details-section {');
    expect(heading).toContain('font-family: var(--mono)');
    expect(heading).toContain('text-transform: uppercase');
});

it('paints the dialog totals row as one compact line of tabular figures', () => {
    // The aggregate line (`6 threads | 51,935 input | 1m32s | 9,472 cache`) is the same
    // muted-mono voice as `.harness-details-meta` under it, so the two read as one block
    // of metadata — and it WRAPS, because a 340px phone dialog cannot scroll sideways.
    const stats = blockOf('.harness-details-stats {');
    expect(stats).toContain('display: flex');
    expect(stats).toContain('flex-wrap: wrap');
    expect(stats).toContain('gap: 4px 0');
    expect(stats).toContain('margin: 0 0 8px');
    expect(stats).toContain('color: var(--muted)');
    expect(stats).toContain('font-family: var(--mono)');
    expect(stats).toContain('font-size: 11.5px');
    expect(stats).toContain('font-variant-numeric: tabular-nums');

    // The `' | '` is generated between adjacent figures only, so there is no leading
    // separator and each `<span>` stays a clean, copy-pastable value.
    expect(blockOf('.harness-details-stat + .harness-details-stat::before {')).toContain(
        "content: ' | '"
    );
    // Nothing else styles a figure that `main.ts` `harnessStatFigures` does not produce:
    // the row owns all of its own typography, and there is no per-figure rule.
    expect(rules).not.toContain('.harness-details-stat:hover');
});

it('keeps no rail surface or confirmation row now that the directory is a strip', () => {
    // The panel, its question and both of its buttons were removed from the behaviour
    // layer (T1/R1). A surviving rule here would mean the stylesheet still styles a
    // surface that no longer exists — or that one came back.
    expect(rules).not.toContain('.session-confirm');

    // R1 (T3): the entire rail directory is gone, so nothing may still style it.
    for (const dead of [
        '.session-row',
        '.session-list',
        '.sessions-scope',
        '.sessions-actions',
        '.session-archived',
        '.session-harness',
        '.session-meta',
        '.session-prompt',
        '.session-delete'
    ]) {
        expect(rules).not.toContain(dead);
    }

    // The lock notice rules R7 removed stay removed.
    expect(rules).not.toContain('.agent-lock');
    expect(rules).not.toContain('.link-button');
});

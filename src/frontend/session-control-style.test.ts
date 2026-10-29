// R7/R8 session-control CSS contract.
//
// R8 adds permanent session deletion to the right-rail directory. The behaviour
// layer owns the DOM; this file pins the CSS half of the agreed contract, and holds
// no import of main.ts so it stays runnable while the behaviour is changing:
//
//   .session-row[data-session-id][data-status][data-active]   ← one entry wrapper
//     .session                                               ← select button
//     .session-delete                                        ← remove control
//     .session-confirm                                       ← open confirmation
//       .session-confirm-delete / .session-confirm-cancel
//
// Requirements pinned here:
//   - the entry is COMPACT for a 320px rail: the button and the delete control share
//     one grid row, and every text line clips instead of widening the rail;
//   - the confirmation text WRAPS inside the entry, and its two buttons wrap under
//     it when needed;
//   - the destructive action is visually unambiguous, with disabled and focus states
//     for both controls;
//   - the active-entry appearance is preserved for both placements of `data-active`
//     (wrapper per the contract, button for the pre-wrapper DOM) without ever
//     painting two frames;
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

it('lays one entry out as a compact shrinkable row', () => {
    const row = blockOf('.session-row {');

    // Button in column 1 (shrinkable), delete control in column 2 (intrinsic): the
    // delete control never wraps below the button, so the entry stays one row.
    expect(row).toContain('display: grid');
    expect(row).toContain('grid-template-columns: minmax(0, 1fr) auto');
    expect(row).toContain('align-items: stretch');
    expect(row).toContain('gap: 3px');
    expect(row).toContain('padding: 2px');
    // R6/R8: the wrapper can never be wider than the rail.
    expect(row).toContain('min-width: 0');
    expect(row).toContain('max-width: 100%');

    // The select button keeps its compact padding and column of text.
    const session = blockOf('.session {');
    expect(session).toContain('flex-direction: column');
    expect(session).toContain('padding: 7px 10px');
    expect(session).toContain('min-width: 0');
    expect(session).toContain('max-width: 100%');

    // Every line of the entry clips: a long harness name or session id can never
    // widen the rail or wrap the entry into extra rows.
    for (const selector of ['.session-harness {', '.session-meta {', '.session-prompt {']) {
        const line = blockOf(selector);
        expect(line).toContain('overflow: hidden');
        expect(line).toContain('text-overflow: ellipsis');
        expect(line).toContain('white-space: nowrap');
    }
});

it('preserves the active entry in either attribute placement, once', () => {
    // The pre-wrapper contract (button carries `data-active`) is unchanged.
    expect(blockOf(".session[data-active='true'] {")).toContain('border-color: var(--accent)');
    expect(blockOf(".session[data-active='true'] {")).toContain('background: var(--accent-soft)');

    // The R8 contract puts it on the wrapper, which owns the surface.
    const activeRow = blockOf(".session-row[data-active='true'] {");
    expect(activeRow).toContain('border-color: var(--accent)');
    expect(activeRow).toContain('background: var(--accent-soft)');

    // Inside a row the surface lives on the wrapper: the button is transparent so
    // the entry is one frame, and the neutralisation happens ONLY when the wrapper
    // is the active one (so a button-only `data-active` still shows a frame).
    expect(blockOf('.session-row > .session {')).toContain('grid-column: 1');
    expect(blockOf('.session-row > .session {')).toContain('background: transparent');
    // Columns are explicit, so the controls cannot swap if the markup order does.
    expect(blockOf('.session-row > .session-delete {')).toContain('grid-column: 2');
    expect(blockOf(".session-row[data-active='true'] > .session {")).toContain(
        'background: transparent'
    );

    // Status colour follows the same two placements, so a running entry is amber
    // whichever element carries `data-status`.
    expect(blockOf(".session-row[data-status='running'] .session-meta {")).toContain(
        'color: var(--warn)'
    );
    expect(blockOf(".session[data-status='running'] .session-meta,")).toContain(
        'color: var(--warn)'
    );
});

it('marks the delete control as destructive with disabled and focus states', () => {
    // Anchored to its own first declaration: the row-placement rule
    // `.session-row > .session-delete {` appears earlier in the file.
    const remove = blockOf('.session-delete {\n    display: inline-flex;');
    expect(remove).toContain('display: inline-flex');
    expect(remove).toContain('min-width: 26px');
    expect(remove).toContain('border: 1px solid rgba(248, 113, 113, 0.35)');
    expect(remove).toContain('color: var(--danger)');
    expect(remove).toContain('cursor: pointer');

    // Hover intensifies the danger instead of introducing it.
    expect(blockOf('.session-delete:hover:not(:disabled) {')).toContain('border-color: var(--danger)');

    // Focus is explicit (the generic accent ring is not enough for a destructive
    // control) and disabled is inert.
    expect(blockOf('.session-delete:focus-visible {')).toContain('outline: 2px solid var(--danger)');
    expect(blockOf('.session-delete:disabled {')).toContain('cursor: not-allowed');
    expect(blockOf('.session-delete:disabled {')).toContain('opacity: 0.4');
});

it('shows the confirmation inline, wrapping the question inside the rail', () => {
    const confirm = blockOf('.session-confirm {');

    // A wrapping flex row: the question uses the entry width and the buttons drop
    // to a second line when they do not fit beside it.
    expect(confirm).toContain('display: flex');
    expect(confirm).toContain('flex-wrap: wrap');
    expect(confirm).toContain('align-items: center');
    expect(confirm).toContain('gap: 5px');
    // The text itself breaks anywhere rather than forcing a horizontal scroll.
    expect(confirm).toContain('overflow-wrap: anywhere');
    expect(confirm).toContain('min-width: 0');
    expect(confirm).toContain('max-width: 100%');
    // Natural height and full entry width in both placements (list, or spanning grid
    // row): a flex-basis percentage here would stretch it in a column list.
    expect(confirm).toContain('flex: 0 0 auto');
    expect(confirm).toContain('width: 100%');
    expect(confirm).toContain('font-size: 11.5px');
    // The question panel is visibly a danger zone, not a neutral box.
    expect(confirm).toContain('border: 1px solid rgba(248, 113, 113, 0.45)');
    expect(confirm).toContain('background: rgba(248, 113, 113, 0.08)');

    // Inside the row it spans both grid columns: as wide as the entry, never wider.
    expect(blockOf('.session-row > .session-confirm {')).toContain('grid-column: 1 / -1');

    // Destructive choice = filled danger button; safe choice = quiet outline, so the
    // two can never be confused.
    const destroy = blockOf('.session-confirm-delete {');
    expect(destroy).toContain('background: var(--danger)');
    expect(destroy).toContain('border: 1px solid var(--danger)');
    expect(destroy).toContain('color: #1b0b0b');
    expect(destroy).toContain('font-weight: 600');

    const cancel = blockOf('.session-confirm-cancel {\n    border: 1px solid var(--border-strong);');
    expect(cancel).toContain('background: var(--bg-elevated)');
    expect(cancel).toContain('color: var(--text)');
});

it('gives both confirmation buttons disabled and focus states', () => {
    const shared = blockOf('.session-confirm-delete,\n.session-confirm-cancel {');
    expect(shared).toContain('font-family: var(--mono)');
    expect(shared).toContain('font-size: 11px');
    expect(shared).toContain('cursor: pointer');

    expect(blockOf('.session-confirm-delete:focus-visible {')).toContain(
        'outline: 2px solid var(--danger)'
    );
    expect(blockOf('.session-confirm-cancel:focus-visible {')).toContain(
        'outline: 2px solid var(--accent)'
    );

    const disabled = blockOf('.session-confirm-delete:disabled,\n.session-confirm-cancel:disabled {');
    expect(disabled).toContain('opacity: 0.45');
    expect(disabled).toContain('cursor: not-allowed');
});

it('leaves the list shrinkable and drops the removed lock notice rules', () => {
    expect(blockOf('.session-list {')).toContain('min-width: 0');
    expect(blockOf('.session-list {')).toContain('max-width: 100%');

    // R7: the saved-session lock notice and its "New session" link are gone from the
    // UI, so no rule may style (or resurrect) them.
    expect(rules).not.toContain('.agent-lock');
    expect(rules).not.toContain('.link-button');
});

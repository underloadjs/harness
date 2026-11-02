// R7/R8 session-control CSS contract.
//
// R8 adds permanent session deletion to the right-rail directory. The behaviour
// layer owns the DOM; this file pins the CSS half of the agreed contract, and holds
// no import of main.ts so it stays runnable while the behaviour is changing:
//
//   .session-row[data-session-id][data-status][data-active]   ← one entry wrapper
//     .session                                               ← select button
//     .session-delete                                        ← remove control (one click)
//
// Requirements pinned here:
//   - the entry is COMPACT for a 320px rail: the button and the delete control share
//     one grid row, and every text line clips instead of widening the rail;
//   - T1/R1: the inline confirmation is gone, so NO `.session-confirm*` rule may
//     survive (the panel cannot come back through the stylesheet alone);
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

it('keeps no confirmation surface now that one click deletes (T1/R1)', () => {
    // The panel, its question and both of its buttons are removed from the behaviour
    // layer (main.ts `renderSessions`). A surviving rule here would mean the stylesheet
    // still styles a surface that no longer exists — or that one came back.
    expect(rules).not.toContain('.session-confirm');

    // The rail row is therefore exactly the two controls, in explicit columns: nothing
    // reserves a second row inside the entry.
    expect(blockOf('.session-row > .session {')).toContain('grid-column: 1');
    expect(blockOf('.session-row > .session-delete {')).toContain('grid-column: 2');
});

it('leaves the list shrinkable and drops the removed lock notice rules', () => {
    expect(blockOf('.session-list {')).toContain('min-width: 0');
    expect(blockOf('.session-list {')).toContain('max-width: 100%');

    // R7: the saved-session lock notice and its "New session" link are gone from the
    // UI, so no rule may style (or resurrect) them.
    expect(rules).not.toContain('.agent-lock');
    expect(rules).not.toContain('.link-button');
});

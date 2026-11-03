// Composer agent control + agent configuration dialog — CSS contract (T5 R9/R10/R11/
// R12, T3 editable configuration).
//
// jsdom does not evaluate media queries, so the small-width behaviour is pinned here
// against the stylesheet source: the single agent button collapses from the full
// title to the two-letter thread code. The dialog's own rules live in
// ui/agent-dialog.css (imported by styles.css), and the contract below pins the
// dropdown form and the bottom-right single-writer action there.
//
// The dialog sizing fix lives in ui/dialog.css and is deliberately NOT asserted here;
// dialog.test.ts owns it.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const stylesheet = ['src/frontend/styles.css', 'src/styles.css']
    .map((candidate) => resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(candidate));
if (stylesheet === undefined) throw new Error('styles.css not found');

const css = readFileSync(stylesheet, 'utf8');

// T3: the agent dialog's own body rules live in the stylesheet its module imports
// (src/frontend/ui/agent-dialog.css), so the dialog contract below reads that file.
// Everything else in this suite still reads styles.css.
const agentDialogCss = readFileSync(resolve(process.cwd(), 'src/frontend/ui/agent-dialog.css'), 'utf8');

// Comments NAME old selectors, so every contract read below uses a stripped copy.
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
const agentDialogRules = agentDialogCss.replace(/\/\*[\s\S]*?\*\//g, '');

// Brace-matched slice so a nested @media body is never cut at its first `}`.
const blockOf = (selector: string, source: string = rules): string => {
    const start = source.indexOf(selector);
    if (start < 0) throw new Error(`missing selector ${selector}`);

    const open = source.indexOf('{', start);
    if (open < 0) throw new Error(`missing body for ${selector}`);

    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        if (source[index] === '}') {
            depth -= 1;
            if (depth === 0) return source.slice(open + 1, index);
        }
    }

    throw new Error(`unbalanced block for ${selector}`);
};

it('places the single agent button inside the composer field frame', () => {
    // R10/R11: the host moved INSIDE the field border. It keeps the `.agent-slot`
    // class so the Tools view show/hide code stays unchanged, but the old rail band
    // (padding/border/background) must not paint around a 32px button.
    const host = blockOf('.composer-field .agent-slot {');
    expect(host).toContain('display: flex');
    expect(host).toContain('flex: 0 0 auto');
    expect(host).toContain('padding: 0');
    expect(host).toContain('border: 0');
    expect(host).toContain('background: transparent');

    // ONE control. The old cycle button, its model chevron and the popover are gone.
    expect(rules).not.toContain('.agent-control-cycle {');
    expect(rules).not.toContain('.agent-control-model-toggle {');
    expect(rules).not.toContain('.agent-control-popover {');

    const button = blockOf('.agent-control-button {');
    expect(button).toContain('display: inline-flex');
    expect(button).toContain('height: 32px');
    expect(button).toContain('border-radius: var(--radius-sm)');
    expect(button).toContain('max-width: 180px');

    // The compact control carries the activity state on the button, while the full
    // deck keeps its animated ring inside the dialog.
    expect(blockOf(".agent-control[data-activity='active'] .agent-control-button {")).toContain(
        'border-color: var(--accent)'
    );

    // The frame owns the control row: it wraps internally, never outside the border.
    const controls = blockOf('.composer-controls {');
    expect(controls).toContain('display: flex');
    expect(controls).toContain('flex-wrap: wrap');
    expect(controls).toContain('justify-content: flex-end');
});

it('collapses the agent button to its thread code at small widths and drops the transcript control', () => {
    const phone = blockOf('@media (max-width: 860px) {');

    // R9: the transcript control and its label rules are removed entirely.
    expect(rules).not.toContain('.transcript-button');
    expect(rules).not.toContain('.transcript-button-label');

    // R11: the full title is hidden and the thread code (`Researcher` -> `RR`) shown.
    expect(phone).toMatch(/\.agent-control-name\s*\{\s*display:\s*none;/);
    expect(phone).toMatch(/\.agent-control-code\s*\{\s*display:\s*inline;/);
    expect(phone).toMatch(/\.agent-control-button\s*\{\s*max-width:\s*64px;/);

    // The code is absent at wide widths (declared once, hidden by default).
    expect(blockOf('.agent-control-code {')).toContain('display: none');
});

it('imports the agent dialog stylesheet and keeps the single-writer action bottom-right', () => {
    // T3: the dialog body moved to its own stylesheet, imported from the app sheet
    // (Vite inlines it). Without the integration line the modal would be unstyled.
    expect(rules).toContain("@import './ui/agent-dialog.css';");

    // The old deck-inside-dialog rules are gone from the app sheet: the dialog is a
    // form now, not a primary button wall plus an overlapping card deck.
    expect(rules).not.toContain('.agent-dialog-primary-list {');
    expect(rules).not.toContain('.agent-dialog .agent-summary {');
    expect(rules).not.toContain('.agent-dialog-instructions');

    // R3: the roster strip is a full-width wrap of badges (the dropdown and the
    // duplicate Team section are gone, and their rules must not come back).
    expect(blockOf('.agent-dialog-tabs {', agentDialogRules)).toContain('width: 100%');
    expect(blockOf('.agent-dialog-tabs {', agentDialogRules)).toContain('flex-wrap: wrap');
    expect(agentDialogRules).not.toContain('.agent-dialog-agent-select {');
    expect(agentDialogRules).not.toContain('.agent-dialog-note {');
    expect(agentDialogRules).not.toContain('.agent-dialog-team-list {');

    // The selected badge and the `[+]` are both painted, so "which agent am I editing"
    // and "how does another agent join" are visible without a sentence.
    expect(blockOf(".agent-dialog-tab[aria-selected='true'] {", agentDialogRules)).toContain(
        'border-color: var(--accent)'
    );
    // The `[+]` rounds with the shared control token, like every other pressable box.
    expect(blockOf('.agent-dialog-add {', agentDialogRules)).toContain(
        'border-radius: var(--radius-sm)'
    );

    // The instruction is a real editor (multi-line, resizable), not a read-only block.
    const editor = blockOf('.agent-dialog-instruction {', agentDialogRules);
    expect(editor).toContain('min-height: 128px');
    expect(editor).toContain('resize: vertical');

    // Footer: the note takes the remaining width and the action is pinned to the far
    // right, which is what makes "bottom right" the reading order rather than a guess.
    const footer = blockOf('.agent-dialog-footer {', agentDialogRules);
    expect(footer).toContain('display: flex');
    expect(footer).toContain('justify-content: space-between');
    expect(footer).toContain('border-top: 1px solid var(--border)');

    // T5 REGRESSION (measured in real Chrome, both idle and refused states): the
    // refusal line always exists in the DOM and its `flex-basis: 100%` forces a wrap,
    // so the action becomes the ONLY item on its own flex line. `space-between` then
    // parks a lone item at the START of the line, which put the save button
    // bottom-LEFT. `margin-left: auto` is the correction; deleting it must fail here.
    const action = blockOf('.agent-dialog-apply {', agentDialogRules);
    expect(action).toContain('flex: 0 0 auto');
    expect(action).toContain('margin-left: auto');
    expect(action).toContain('white-space: nowrap');
    expect(blockOf('.agent-dialog-footer-note {', agentDialogRules)).toContain('flex: 1 1 240px');

    // A refused save is painted in the palette's error colour, beside the action.
    // `flex: 1 1 100%` is the other half of the contract above: it is what makes the
    // refusal own a full line, so the note and the action cannot collide with it.
    const error = blockOf('.agent-dialog-error {', agentDialogRules);
    expect(error).toContain('flex: 1 1 100%');
    expect(error).toContain('color: var(--danger)');

    // The roster badges carry the live activity state (ui/activity.ts paints them).
    expect(blockOf(".agent-dialog-agent[data-activity='active'] {", agentDialogRules)).toContain(
        'border-color: var(--accent)'
    );
});

it('rounds every control with one shared token and keeps surfaces and circles on their own', () => {
    // The per-rule `border-radius: var(--radius-sm)` assertions above are only meaningful
    // if the token VALUES are pinned at the definition: a silent retune of the token would
    // otherwise keep every one of them green. `--radius-sm` is 6px because that is the
    // `.tool` chip frame the rest of the controls are aligned to; `--radius` stays 10px for
    // surfaces, and 999px stays reserved for round badges + circular icon buttons.
    const root = blockOf(':root {');
    expect(root).toContain('--radius: 10px;');
    expect(root).toContain('--radius-sm: 6px;');

    // Control rules in the app sheet carry no radius literal any more (one source of truth).
    for (const selector of ['\n.tool {', '\n.button {', '\n.session-pill {']) {
        expect(blockOf(selector)).toContain('border-radius: var(--radius-sm)');
    }

    // The shapes deliberately OUTSIDE the token stay outside it, so a future sweep cannot
    // flatten the duration/status badges or re-square the panels.
    expect(blockOf(':is(.tool-duration, .think-count) {')).toContain('border-radius: 999px');
    expect(blockOf('\n.status {')).toContain('border-radius: 999px');
    expect(blockOf('\n.tile {')).toContain('border-radius: var(--radius)');
    expect(blockOf('\n.conversation {')).toContain('border-radius: var(--radius)');

    // The dialog sheet resolves the same token because styles.css @imports it (asserted
    // above); neither the old 999px capsules nor the one-off 7px radius survive in it.
    expect(blockOf('.agent-dialog-tab {', agentDialogRules)).toContain(
        'border-radius: var(--radius-sm)'
    );
    expect(agentDialogRules).not.toContain('border-radius: 999px');
    expect(agentDialogRules).not.toContain('border-radius: 7px');
});

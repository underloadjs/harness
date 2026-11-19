// Composer agent control + agent configuration dialog — CSS contract (T5 R9/R10/R11/
// R12, T3 editable configuration, T1 the press/cycle affordance).
//
// jsdom does not evaluate media queries, so the small-width behaviour is pinned here
// against the stylesheet source: the single agent button collapses from the full
// title to the two-letter thread code. The dialog's own rules live in
// ui/agent-dialog.css (imported by styles.css), and the contract below pins the
// dropdown form and the bottom-right single-writer action there.
//
// T1 changed what a PRESS on that button means (a click/Enter still opens the dialog; a
// `Tab` in the field — or a tap on a touch device — moves the composer's PENDING agent,
// and a press and hold opens the dialog), so this file also pins the two things the new
// gesture needs from CSS: the touch input properties that let the page own the press at
// all, and the hold affordance, which may only ever touch `background`.
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

    // R3: the roster strip is a full-width three-column grid of badges (the dropdown and
    // the duplicate Team section are gone, and their rules must not come back). The
    // equal `minmax(0, 1fr)` tracks are what makes the badges evenly spaced, and the
    // phone rule collapses the grid to one badge per row.
    const tabs = blockOf('.agent-dialog-tabs {', agentDialogRules);
    expect(tabs).toContain('width: 100%');
    expect(tabs).toContain('display: grid');
    expect(tabs).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
    expect(blockOf('@media (max-width: 720px) {', agentDialogRules)).toContain(
        'grid-template-columns: minmax(0, 1fr)'
    );
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
    // No rule sits above the action: the footer is separated by space, not a divider.
    const footer = blockOf('.agent-dialog-footer {', agentDialogRules);
    expect(footer).toContain('display: flex');
    expect(footer).toContain('justify-content: space-between');
    expect(footer).not.toContain('border-top');

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

    // R1/R2 (T4) + the 2026-11-20 quick controls: the chip's `entry` CAPTION is
    // deleted, and the rank is the FIRST control rather than a floating corner pill.
    // The rank badge is in flow, so the chip needs no positioned containing block for
    // it; the model select sits at the right edge as the viewed member's list.
    expect(agentDialogRules).not.toContain('.agent-dialog-agent-entry {');
    expect(blockOf('.agent-dialog-tab {', agentDialogRules)).not.toContain('position: relative');

    const rankBadge = blockOf('.agent-dialog-agent-rank {', agentDialogRules);
    // In flow at the front, a real press target (the quick rank cycler), and above no
    // sibling by z-index because there is nothing left out of flow. The 18px box is
    // the shared square size for a one-letter badge.
    expect(rankBadge).not.toContain('position: absolute');
    expect(rankBadge).toContain('flex: 0 0 auto');
    expect(rankBadge).toContain('min-width: 18px');
    expect(rankBadge).toContain('height: 18px');
    expect(rankBadge).toContain('background: var(--bg-elevated)');
    expect(rankBadge).toContain('border: 1px solid var(--border)');
    expect(rankBadge).toContain('cursor: pointer');
    expect(rankBadge).not.toContain('pointer-events: none');

    // The authority palette (2026-11-20): A gold, B silver, C copper, D white.
    for (const [letter, colour] of [
        ['A', '#f6c945'],
        ['B', '#c8cfd8'],
        ['C', '#d18555'],
        ['D', '#f2f5f9']
    ] as const) {
        expect(
            blockOf(`.agent-dialog-agent-rank[data-rank='${letter}'] {`, agentDialogRules)
        ).toContain(`color: ${colour}`);
    }

    // The model is a fact at the chip's right edge; every chip's select is the actual
    // list and takes the same slot, with no chevron and no visible frame.
    expect(blockOf('.agent-dialog-agent-model {', agentDialogRules)).toContain('margin-left: auto');
    const chipSelect = blockOf('.agent-dialog-tab .agent-model-select {', agentDialogRules);
    expect(chipSelect).toContain('appearance: none');
    expect(chipSelect).not.toContain('url(');
    expect(chipSelect).toContain('background: transparent');
});

// Does a rule declare a `color:` property (as opposed to `border-color:` /
// `background-color:`, which are different channels)? `toContain('color: …')` would
// match those too, so every "no colour here" check below uses this instead.
const declaresColor = (block: string): boolean => /(^|\n)\s*color\s*:/.test(block);

it('paints the agent identity tone on the composer label and the dialog badges (R4)', () => {
    // T5/R4: the composer's agent name (`Instruct`) and its compact code (`IT`) carry the
    // agent's own hue. ui/agent-control.ts paints the `.agent-control` WRAPPER, and
    // custom properties inherit, so the tone has to be read on the button rule — exactly
    // the property styles.css already uses for the transcript labels.
    expect(blockOf('.agent-control-button {')).toContain('color: var(--agent-color)');

    // Neither label may set a colour of its own: an inline `color` on the name or the
    // code would override the inherited identity tone and R4 would silently stop working
    // (the surfaces test asserts the same thing on the DOM side, from the components).
    expect(declaresColor(blockOf('.agent-control-name {'))).toBe(false);
    expect(declaresColor(blockOf('.agent-control-code {'))).toBe(false);

    // `--accent` stays the STATE channel, and it stays on the BORDER: hovering or running
    // must not erase the hue the reader is using to tell two agents apart.
    const hover = blockOf('.agent-control-button:hover {');
    expect(hover).toContain('border-color: var(--accent)');
    expect(declaresColor(hover)).toBe(false);

    const active = blockOf(".agent-control[data-activity='active'] .agent-control-button {");
    expect(active).toContain('border-color: var(--accent)');
    expect(declaresColor(active)).toBe(false);

    // The dialog: the badge NAME is the identity (ui/agent-dialog.ts paints the badge),
    // and the `[+]` option is painted with the tone its badge will keep. The rank and    // model captions stay `--muted` — they are facts about the agent, not the agent — and
    // selection/activity keep the accent border, so identity and state stay two facts.
    expect(blockOf('.agent-dialog-agent-name {', agentDialogRules)).toContain('color: var(--agent-color)');
    expect(blockOf('.agent-dialog-add-option {', agentDialogRules)).toContain('color: var(--agent-color)');
    expect(blockOf('.agent-dialog-agent-rank {', agentDialogRules)).toContain('color: var(--muted)');
    expect(blockOf(".agent-dialog-tab[aria-selected='true'] {", agentDialogRules)).toContain(
        'border-color: var(--accent)'
    );
    expect(blockOf('.agent-dialog-tab {', agentDialogRules)).toContain('color: var(--text)');

    // The fallback that makes an unnamed agent neutral is the SAME value the module
    // publishes (ui/agent-color.ts `UNKNOWN_AGENT_COLOR`), so a block painted with no
    // identity looks exactly like a block nobody painted.
    expect(blockOf(':root {')).toContain('--agent-color: #8b94a7');
    expect(blockOf(':root {')).toContain('--agent-line: rgba(139, 148, 167, 0.55)');
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
    // The rank badge (T4/R2 + the 2026-11-20 quick path) is the one shape in this sheet
    // that COULD have taken the precedent's 999px circle (styles.css `.panel-new-pill`).
    // It deliberately did not: taking the token keeps this guard total, so the ban below
    // still covers every selector in the sheet — including any future one — instead of
    // needing an exemption.
    expect(blockOf('.agent-dialog-agent-rank {', agentDialogRules)).toContain(
        'border-radius: var(--radius-sm)'
    );
    expect(agentDialogRules).not.toContain('border-radius: 999px');
    expect(agentDialogRules).not.toContain('border-radius: 7px');
});

// --- T1: the press target, its hold affordance, and the cycle announcement ----------

it('disarms the platform long-press so the page can own the press at all (T1 D9)', () => {
    // On a touch device the chip is a PRESS target with a ~500 ms timer of its own
    // (ui/press-hold.ts). Without these four declarations the platform gets there first:
    // the double-tap-zoom delay delays `pointerup` (so a tap arrives too late to cycle),
    // a hold selects the agent's name, and iOS raises a callout on top of the dialog the
    // hold just opened. They are INPUT semantics, so not one desktop pixel changes.
    const button = blockOf('.agent-control-button {');
    expect(button).toContain('touch-action: manipulation');
    expect(button).toContain('user-select: none');
    expect(button).toContain('-webkit-user-select: none');
    expect(button).toContain('-webkit-touch-callout: none');

    // The same trade `styles.css` already makes for the rails, which are drag surfaces
    // (`.rail-resizer`, styles.css:517) — this is the package's existing convention for a
    // surface the page owns, not a new one.
    expect(blockOf('.rail-resizer {')).toContain('touch-action: none');
});

it('paints the hold on background only, so it never erases identity or activity (T1 D8/D11)', () => {
    // `ui/agent-control.ts` writes `data-hold="armed"` while the finger is down with the
    // timer running and `data-hold="held"` after the hold has fired and until release.
    const armed = blockOf(".agent-control-button[data-hold='armed'] {");
    const held = blockOf(".agent-control-button[data-hold='held'] {");

    expect(armed).toContain('background: color-mix(in srgb, var(--agent-color) 18%, transparent)');
    expect(held).toContain('background: color-mix(in srgb, var(--agent-color) 32%, transparent)');

    // `background` is the ONLY property either state may touch. `color` is the agent's
    // IDENTITY tone (the rule above and ui/agent-color.ts) and `border-color` is the
    // activity/hover STATE channel, so a hold would otherwise erase one of those two facts
    // for as long as the finger is down — the reader would lose sight of the agent they are
    // about to switch TO.
    for (const block of [armed, held]) {
        expect(block).not.toContain('border-color');
        expect(declaresColor(block)).toBe(false);
    }

    // And the press state does not REPLACE the hover affordance: a device that can hover
    // still gets the border, still without repainting the name in `--accent`.
    const hover = blockOf('.agent-control-button:hover {');
    expect(hover).toContain('border-color: var(--accent)');
    expect(declaresColor(hover)).toBe(false);
});

it('gives the cycle a live region that is hidden, not gone (T1 D10)', () => {
    // main.ts writes `Agent for the next message: Researcher` into a `role="status"`
    // polite region beside the composer. The chip's OWN label changed, but a rebuilt node
    // is not a live region, so the sentence needs a home — and that home has to be clipped
    // rather than `display: none`, because an AT never announces a hidden element.
    const live = blockOf('.agent-control-live {');
    expect(live).toContain('position: absolute');
    expect(live).toContain('width: 1px');
    expect(live).toContain('height: 1px');
    expect(live).toContain('overflow: hidden');
    expect(live).toContain('clip-path: inset(50%)');
    expect(live).not.toContain('display: none');
    expect(rules).not.toMatch(/\.agent-control-live[^{]*\{\s*display:\s*none/);

    // Same reason it lives OUTSIDE `.agent-slot`: that host is `replaceChildren`-rebuilt on
    // every cycle, and a live region destroyed at the moment it has something to say is
    // never read. The host's own rule must therefore not hide or clip the paragraph.
    expect(blockOf('.composer-field .agent-slot {')).not.toContain('overflow: hidden');
});

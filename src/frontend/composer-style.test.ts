// R9/R10 composer CSS contract.
//
// The behavior is owned by main.ts and pinned in composer-control.test.ts. This file
// pins the CSS half, so a future style edit cannot silently:
//   - give the chat field a taller default / a manual resize handle (R9 wants ONE
//     row by default, auto-grown by script, scrolling at the cap);
//   - move the single action out of the input box or let text run underneath it
//     (R10 wants the same spot inside the field in every state);
//   - re-introduce the old footer action row for the composer.
//
// It holds no import of main.ts so it stays runnable while behavior changes.

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

// Comments NAME the old selectors, so "must be gone" assertions read the stripped
// stylesheet (see session-control-style.test.ts).
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

it('keeps the send action and the agent control INSIDE one field frame', () => {
    // R10/R11 (T5): the field wrapper is the visible frame (border/background) AND
    // the positioning context for the @/# popup. Without `min-width: 0` the frame
    // could not shrink and the controls would be pushed out of the page.
    const field = blockOf('.composer-field {');
    expect(field).toContain('position: relative');
    expect(field).toContain('display: flex');
    expect(field).toContain('align-items: flex-end');
    expect(field).toContain('flex: 1');
    expect(field).toContain('min-width: 0');
    expect(field).toContain('border: 1px solid var(--border-strong)');
    expect(field).toContain('border-radius: 8px');

    // The right-hand control row is a FLOW child of the frame, wraps internally and
    // never escapes the border.
    const controls = blockOf('.composer-controls {');
    expect(controls).toContain('display: flex');
    expect(controls).toContain('flex-wrap: wrap');
    expect(controls).toContain('justify-content: flex-end');
    expect(controls).toContain('flex: 0 0 auto');

    // The action is no longer absolutely positioned over the text: it is a sibling
    // of the agent button inside `.composer-controls`, so it cannot drift outside the
    // input frame.
    const action = blockOf('.composer-action {');
    expect(action).not.toContain('position: absolute');
    expect(action).not.toContain('right: 8px');
    expect(action).not.toContain('bottom: 8px');
    expect(action).toContain('display: inline-flex');
    expect(action).toContain('flex: 0 0 auto');
    expect(action).toContain('width: 28px');
    expect(action).toContain('height: 28px');
    expect(action).toContain('border-radius: 999px');

    // Hidden is a real removal (idle + empty has NO action), not just opacity.
    const hidden = blockOf('.composer-action[hidden] {');
    expect(hidden).toContain('display: none');

    // Stop reads as outlined, not as the primary submit.
    const stop = blockOf(".composer-action[data-action='stop'] {");
    expect(stop).toContain('background: transparent');
    expect(stop).toContain('border-color: var(--border-strong)');

    // Keyboard users get a visible focus ring on the dark input.
    const focus = blockOf('.composer-action:focus-visible {');
    expect(focus).toContain('outline: 2px solid var(--accent)');
    expect(focus).toContain('outline-offset: 2px');
});

it('makes the chat field one row by default, auto-grown and scrolling at the cap', () => {
    // The base rule keeps the tool-runner arguments box usable (it shares the class
    // and keeps `resize: vertical`); the chat field overrides it below.
    const base = blockOf('.composer-input {');
    expect(base).toContain('max-height: 200px');

    // R9/T15: the empty height is ONE line box + compact padding
    // (13.5 * 1.45 = 19.575 + 12 => ~32px); the script owns every height above it.
    const field = blockOf('.composer-field .composer-input {');
    expect(field).toContain('flex: 1');
    expect(field).toContain('min-width: 0');
    expect(field).toContain('min-height: 32px');
    expect(field).not.toContain('min-height: 40px');
    expect(field).not.toContain('min-height: 54px');
    // R9/R10: the text column is borderless and shares the frame with the control
    // row. It reserves no overlay gutter — the controls are flow siblings, so text
    // can never run under the send glyph.
    expect(field).toContain('border: 0');
    expect(field).toContain('background: transparent');
    expect(field).toContain('padding: 6px 4px 6px 8px');
    expect(field).not.toContain('padding: 6px 44px 6px 8px');
    expect(field).not.toContain('padding: 10px 52px 10px 12px');
    // The script measures the content; a manual handle would fight it.
    expect(field).toContain('resize: none');
    expect(field).not.toContain('resize: vertical');
    // R5: the cap is a LINE budget owned by the script (3 lines phone / 5 desktop,
    // computed from the live line-height). A fixed stylesheet box here would clip the
    // fifth line at large fonts or zoom, so the chat field must not re-impose one.
    expect(field).toContain('max-height: none');
    expect(field).not.toContain('max-height: 200px');
    // Past the cap the field scrolls instead of growing without bound.
    expect(field).toContain('overflow-y: auto');
});

it('does not keep a footer action row for the composer', () => {
    // R10: the composer itself has one child (the field). `.composer-actions` is
    // still legitimately used by the offline Retry pane and the manual tool runner,
    // so the assertion is scoped to the composer element, not the class.
    const composer = blockOf('.composer {');
    expect(composer).toContain('display: flex');
    expect(composer).not.toContain('flex-direction: column');

    // The removed controls have no rules to style them back into existence.
    expect(rules).not.toContain('.button.run');
    expect(rules).not.toContain('.button.reset');
    expect(rules).not.toContain('.composer-actions .run');
});

it('keeps the composer column additive and compact, with no attachment chooser rules', () => {
    // T5: chips/error sit in a column ABOVE the existing `.composer-field`, so the
    // action's absolute position inside the field is untouched.
    const body = blockOf('.composer-body {');
    expect(body).toContain('display: flex');
    expect(body).toContain('flex-direction: column');
    expect(body).toContain('flex: 1');
    expect(body).toContain('min-width: 0');

    // R7/T15: compact outer spacing (8px/16px) instead of the old 13px/20px shell
    // padding; the removed chooser leaves no sibling gap to reserve.
    const composer = blockOf('.composer {');
    expect(composer).toContain('padding: 8px 16px');
    expect(composer).not.toContain('padding: 13px 20px');

    // R6/T15: the attachment chooser (button + hidden input) is gone from the
    // stylesheet as well as the DOM. The selectors are matched with their `{`/`:` so
    // the still-valid `.composer-attachment-error`/`.composer-attachments` prefixes
    // are not mistaken for the removed accessory.
    expect(rules).not.toContain('.composer-attach {');
    expect(rules).not.toContain('.composer-attach:');
    expect(rules).not.toContain('.composer-file {');

    // An empty draft truly removes the strip; the inline chips and the replay strip
    // (now the only attachment affordances) keep their contract.
    expect(blockOf('.composer-attachments[hidden] {')).toContain('display: none');

    // Chips clip a long filename instead of growing the composer off-screen, and
    // the replay strip is hidden for text-only turns.
    expect(blockOf('.attachment-name {')).toContain('text-overflow: ellipsis');
    expect(blockOf('.turn-attachments[hidden] {')).toContain('display: none');
});

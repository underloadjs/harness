// Composer agent control + shared dialog — CSS contract (T5 R9/R10/R11/R12).
//
// jsdom does not evaluate media queries, so the small-width behaviour is pinned here
// against the stylesheet source: the single agent button collapses from the full
// title to the two-letter thread code, and the deck inside the dialog is always
// visible (the modal itself is the disclosure).
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

// Comments NAME old selectors, so contract reads use the stripped stylesheet.
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

// Brace-matched slice so a nested @media body is never cut at its first `}`.
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
    expect(button).toContain('border-radius: 8px');
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

it('keeps the dialog deck visible and hides its redundant phone summary', () => {
    // The dialog IS the disclosure, so the deck's own summary has nothing to collapse
    // and the cards stay visible at every width (the modal body scrolls instead).
    expect(blockOf('.agent-dialog .agent-summary {')).toContain('display: none');
    expect(blockOf(".agent-dialog .agent-row-wrap:not([data-open='true']) .agent-row {")).toContain(
        'display: flex'
    );

    // The primary chooser is a horizontal, wrapping row of pressed buttons.
    const list = blockOf('.agent-dialog-primary-list {');
    expect(list).toContain('display: flex');
    expect(list).toContain('flex-wrap: wrap');
    expect(blockOf(".agent-dialog-primary[aria-pressed='true'] {")).toContain(
        'border-color: var(--accent)'
    );
    expect(blockOf('.agent-dialog-primary:disabled {')).toContain('cursor: default');
});

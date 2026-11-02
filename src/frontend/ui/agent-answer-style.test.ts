// Agent answer-footer CSS contract (R5).
//
// jsdom cannot lay out the transcript, so this reads the stylesheet source and pins
// the rules the answer action relies on:
//   - the block footer is a right-aligned action row, not a metadata line (the old
//     `.agent-meta` model/stop/token text is gone with its rules);
//   - an empty footer collapses instead of adding a dead strip under the block;
//   - the Copy control is a compact icon button with a focus ring, and its
//     success/error reinforcement is written LOCALLY (scoped through the footer) so
//     it cannot be outranked by ui/dialog.css depending on bundle order.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/agent-answer-style.test.ts

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// Mirror tool-chip-style.test.ts: resolve from the package root (`npm test`) or the
// frontend root (the vitest frontend config sets `root` to src/frontend).
const stylesheet = ['src/frontend/styles.css', 'src/styles.css']
    .map((candidate) => resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(candidate));
if (stylesheet === undefined) throw new Error('styles.css not found');

const css = readFileSync(stylesheet, 'utf8');

const blockOf = (selector: string): string => {
    const start = css.indexOf(selector);
    if (start < 0) throw new Error(`missing selector ${selector}`);

    const open = css.indexOf('{', start);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
};

it('makes the block footer a right-aligned action row', () => {
    const footer = blockOf('.agent-answer-actions {');
    expect(footer).toContain('display: flex');
    // R5: flush right, so the copy control reads as an affordance of the answer
    // above it and the transcript's left column stays clean at every depth.
    expect(footer).toContain('justify-content: flex-end');
    expect(footer).toContain('align-items: center');
});

it('collapses a footer with nothing completed to copy', () => {
    // An empty action row must take NO vertical space: a still-streaming answer, a
    // tool-only block and an interrupted answer all render without a dead strip.
    expect(blockOf('.agent-answer-actions:empty {')).toContain('display: none');
});

it('removes the agent metadata footer entirely', () => {
    // R5: the model / stop reason / token line is gone from the bottom of a block
    // (the block HEADERS keep those measurements). No rule may still target it, or
    // the removed element would come back through a stray selector.
    expect(css).not.toContain('.agent-meta');
});

it('styles the copy control as a compact icon button and keeps it scoped', () => {
    const button = blockOf('.agent-answer-actions .answer-copy {');
    // A real square icon target, not a text button: the dialog copy control's shape,
    // shrunk for the transcript.
    expect(button).toContain('display: inline-flex');
    expect(button).toContain('width: 24px');
    expect(button).toContain('height: 24px');
    expect(button).toContain('border: 1px solid var(--border)');
    expect(button).toContain('color: var(--muted)');
    expect(button).toContain('cursor: pointer');

    // Scoped on purpose: an unscoped `.answer-copy` rule would tie with the shared
    // control's own selectors and lose to whichever stylesheet the bundle emits last.
    expect(css).not.toContain('\n.answer-copy {');

    // The glyph is sized from the button so a state swap can never stretch the row.
    expect(blockOf('.agent-answer-actions .answer-copy svg {')).toContain('width: 14px');

    // Keyboard affordance (the footer button is reachable with Tab).
    expect(blockOf('.agent-answer-actions .answer-copy:focus-visible {')).toContain(
        'outline: 2px solid var(--accent)'
    );
});

it('reinforces the copy feedback in both directions without depending on load order', () => {
    const success = blockOf(".agent-answer-actions .answer-copy[data-state='success'] {");
    const failure = blockOf(".agent-answer-actions .answer-copy[data-state='error'] {");
    expect(success).toContain('color: var(--ok)');
    expect(failure).toContain('color: var(--danger)');

    // Written AFTER the hover rule (equal specificity) so the state tint still wins
    // while the pointer is over the button — feedback is never colour-only, but it
    // must never be colour-BLIND either.
    const hover = css.indexOf('.agent-answer-actions .answer-copy:hover {');
    expect(hover).toBeGreaterThan(-1);
    expect(css.indexOf(".agent-answer-actions .answer-copy[data-state='success'] {")).toBeGreaterThan(hover);
});

// Agent answer-footer CSS contract (R5/T7).
//
// jsdom cannot lay out the transcript, so this reads the stylesheet source and pins
// the rules the answer action and the Collapse chevron rely on:
//   - the block footer is an action row, not a metadata line (the old `.agent-meta`
//     model/stop/token text is gone with its rules); the COPY control reads first
//     (`justify-content: flex-start`) and the Collapse chevron owns the right edge
//     through `margin-left: auto` on itself, so the row is stable whether or not an
//     answer has completed;
//   - a footer with NO control at all (a flat legacy section) collapses instead of
//     adding a dead strip under the block;
//   - the Copy control is a compact icon button with a focus ring, and its
//     success/error reinforcement is written LOCALLY (scoped through the footer) so
//     it cannot be outranked by ui/dialog.css depending on bundle order;
//   - the chevron is the SAME 24px icon button (same border/colour/hover/focus ring),
//     it is a CSS rotation of one down-pointing glyph, and the rotation is dropped under
//     `prefers-reduced-motion`;
//   - T7: it is the ONLY chevron. The header chevron of the previous pass is gone, the
//     collapsed header keeps its original padding, and the control's visibility comes
//     from the body-hiding rules (`.tile:not(.is-expanded) .tile-body`,
//     `.thread-row:not(.is-expanded) .thread-body`) rather than a chevron-specific rule
//     — which is what keeps it rendered for a T12b sibling exchange whose body an open
//     conversation shows.
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

// A whole `@media` block, braces balanced: the reduced-motion contract is about the RULE
// LIST (which selectors it covers), so it cannot be read with `blockOf`.
const mediaBlockOf = (condition: string): string => {
    const start = css.indexOf(`@media ${condition} {`);
    if (start < 0) throw new Error(`missing @media ${condition}`);

    let depth = 0;
    for (let cursor = css.indexOf('{', start); cursor < css.length; cursor += 1) {
        if (css[cursor] === '{') depth += 1;
        else if (css[cursor] === '}') {
            depth -= 1;
            if (depth === 0) return css.slice(start, cursor + 1);
        }
    }

    throw new Error(`unterminated @media ${condition}`);
};

// One rule block's declarations, searched from the TOP of the stylesheet. Selectors
// that also appear inside a later `@media` block resolve to the base rule, which is
// what the contract tests describe; `blockOfInside` reads a nested copy.
const blockOfInside = (source: string, selector: string): string => {
    const start = source.indexOf(selector);
    if (start < 0) throw new Error(`missing selector ${selector}`);

    const open = source.indexOf('{', start);
    const close = source.indexOf('}', open);
    return source.slice(open + 1, close);
};

const blockOf = (selector: string): string => blockOfInside(css, selector);

it('makes the block footer a left-first action row with the toggle pinned right', () => {
    const footer = blockOf('.agent-answer-actions {');
    expect(footer).toContain('display: flex');
    // R5 (revised): the COPY control is the first thing in the row, flush left against
    // the answer it copies; the block's Collapse/Expand toggle owns the right edge via
    // `margin-left: auto` on the toggle itself (pinned below), so the row reads the
    // same whether or not an answer has completed.
    expect(footer).toContain('justify-content: flex-start');
    expect(footer).toContain('align-items: center');
});

it('collapses a footer with no control at all', () => {
    // A FLAT legacy section has no collapse surface, so its row stays childless until
    // an answer completes and must take NO vertical space (a still-streaming answer, a
    // tool-only block and an interrupted answer all render without a dead strip).
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

it('styles the collapse toggle as the copy control\u2019s twin, pinned to the right edge', () => {
    const toggle = blockOf('.agent-answer-actions .answer-collapse {');
    // Same square icon target, border, radius, quiet colour and pointer as the copy
    // button: two buttons side by side must not look like two different widgets.
    const copy = blockOf('.agent-answer-actions .answer-copy {');
    for (const declaration of [
        'display: inline-flex',
        'width: 24px',
        'height: 24px',
        'border: 1px solid var(--border)',
        'border-radius: 6px',
        'background: transparent',
        'color: var(--muted)',
        'cursor: pointer'
    ]) {
        expect(toggle).toContain(declaration);
        expect(copy).toContain(declaration);
    }

    // R5: the toggle is the ONLY thing that holds the right edge. `margin-left: auto`
    // pins it there with or without a copy button in the row.
    expect(toggle).toContain('margin-left: auto');
    expect(copy).not.toContain('margin-left');

    // Scoped on purpose, exactly like the copy control: an unscoped `.answer-collapse`
    // rule would tie with any other sheet and depend on bundle order.
    expect(css).not.toContain('\n.answer-collapse {');

    // ONE down chevron; the expanded state is a rotation, so the glyph never swaps.
    const glyph = blockOf('.agent-answer-actions .answer-collapse svg {');
    expect(glyph).toContain('width: 14px');
    expect(glyph).toContain('fill: none');
    expect(glyph).toContain('stroke: currentColor');
    expect(glyph).toContain('transition: transform 120ms ease');
    expect(blockOf(".agent-answer-actions .answer-collapse[aria-expanded='true'] svg {")).toContain(
        'transform: rotate(180deg)'
    );

    // Same hover and keyboard affordance as the copy button.
    expect(blockOf('.agent-answer-actions .answer-collapse:hover {')).toBe(
        blockOf('.agent-answer-actions .answer-copy:hover {')
    );
    expect(blockOf('.agent-answer-actions .answer-collapse:focus-visible {')).toContain(
        'outline: 2px solid var(--accent)'
    );

    // Motion preference: the flip is decoration, the state is the ARIA value and the word
    // in the accessible name, so it is dropped — and T7 leaves exactly ONE chevron in the
    // reduced-motion rule list.
    const reduced = mediaBlockOf('(prefers-reduced-motion: reduce)');
    expect(reduced).toContain('.agent-answer-actions .answer-collapse svg');
    expect(blockOfInside(reduced, '.agent-answer-actions .answer-collapse svg {')).toContain(
        'transition: none'
    );
    expect(reduced).not.toContain('header-collapse');
});

it('leaves the collapsed header row alone: one chevron, in the footer only', () => {
    // T7 (user feedback): the whole collapsed row is already the expander, so the header
    // chevron of the previous pass is gone — no rule may resurrect it.
    expect(css).not.toContain('header-collapse');

    // The header keeps its ORIGINAL padding: the reservation that defended an absolutely
    // positioned chevron is removed, so the flush-right measurement line returns to the
    // inline-padding edge like every other header.
    expect(css).not.toContain('padding-right: 44px');
    expect(blockOf('.thread-select {')).toContain('padding: 6px 10px');
    expect(blockOf('.tile:not(.is-expanded) .tile-select {')).toContain('padding: 6px 10px');

    // The footer-only contract depends on these two rules, which hide the body that holds
    // the chevron (and therefore take it out of the layout, the tab order and the
    // accessibility tree). They must not be paired with a chevron-specific hide rule: the
    // button needs no second rule of its own, and T12b's open-conversation case (a body
    // shown without `.is-expanded`) must keep its Collapse control.
    expect(blockOf('.tile:not(.is-expanded) .tile-body {')).toContain('display: none');
    expect(blockOf('.thread-row:not(.is-expanded) .thread-body {')).toContain('display: none');
    expect(blockOf('.conversation.is-expanded .tile-body {')).toContain('display: flex');
    expect(css).not.toContain('.answer-collapse { display: none');
    expect(css).not.toContain('.turn-row > .tile > .header-collapse');
});

it('gives the collapse toggle no copy-only feedback states', () => {
    // The toggle has no transient success/error tint: its click MOVES the surface, it
    // does not report a result. The copy button keeps both of its rules.
    expect(css).not.toContain(".answer-collapse[data-state='success']");
    expect(css).not.toContain(".answer-collapse[data-state='error']");
    expect(css).toContain(".agent-answer-actions .answer-copy[data-state='success'] {");
    expect(css).toContain(".agent-answer-actions .answer-copy[data-state='error'] {");
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

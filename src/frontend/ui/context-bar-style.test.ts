// T11 CSS contract for the ONE context bar and its segment dialog.
//
// jsdom does not lay CSS out, so the properties that make the bar work are pinned from the
// stylesheet source, exactly the way `activity-style.test.ts` pins the ring:
//
//   - the two numbers that MUST agree with `view-context.ts` (the painter cannot ask CSS
//     for either one): `CONTEXT_BAR_GAP_PX` as `.context-bar-segments { gap }` and
//     `CONTEXT_BAR_TRACK_HEIGHT_PX` as the track height in BOTH modes;
//   - the tone table, from the same `--ok` / `--danger` / `--warn` / `--text` values
//     `CONTEXT_BAR_TONE_STYLES` repeats for the canvas, so a theme change to one of the
//     four tokens moves both renderers together;
//   - the accessible-only surfaces stay clipped rather than `display: none` (a hidden
//     element is removed from the accessibility tree, which would silently delete the bar's
//     text from a screen reader);
//   - forced colors keeps a per-segment boundary, because a colour-only difference is the
//     one thing that mode guarantees to erase;
//   - T22 (R23): the ONE current content block sits at the tail of the strip, printed as
//     pre-wrapped text in its own scroll box, and BOTH withdrawal rules hide it — the
//     element's `hidden` and the decision's own `[data-superseded]` attribute;
//   - T23 (R23): when the designated block is a recorded CALL, the body is its complete
//     recorded request and response in one labelled pane each — in the strip's own tool tones,
//     each pane scrolling on its own, with a stated absence in the segment dialog's vocabulary.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/context-bar-style.test.ts

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { CONTEXT_BAR_GAP_PX, CONTEXT_BAR_TRACK_HEIGHT_PX, CONTEXT_BAR_TONE_STYLES } from '../view-context';

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

it('gives DOM mode the model gap and the model track height', () => {
    const segments = blockOf('.context-bar-segments {');

    // `gap` is what makes the segments VISIBLY separate; without it a proportional bar
    // reads as one merged band and the reader cannot tell where one call ends.
    expect(segments).toContain(`gap: ${CONTEXT_BAR_GAP_PX}px;`);
    expect(segments).toContain(`height: ${CONTEXT_BAR_TRACK_HEIGHT_PX}px;`);
    expect(segments).toContain('display: flex;');
    expect(segments).toContain('flex-direction: row;');
    // The floor lives in CSS too, so a flex weight that rounds below a pixel is still
    // aimable (the model promises `width >= 1`, the sheet promises it on the DOM side).
    expect(blockOf('.context-bar-segment {')).toContain('min-width: 1px;');
});

it('paints the same track height in canvas mode', () => {
    expect(blockOf('.context-bar-canvas {')).toContain(`height: ${CONTEXT_BAR_TRACK_HEIGHT_PX}px;`);
    expect(blockOf('.context-bar-canvas {')).toContain('width: 100%;');
});

it('maps every tone to the palette entry the canvas falls back to', () => {
    for (const [tone, style] of Object.entries(CONTEXT_BAR_TONE_STYLES)) {
        const rule = blockOf(`.context-bar-segment[data-tone='${tone}'] {`);
        // A tone whose colour came from a DIFFERENT token than `cssVar` would drift from
        // the canvas the moment the theme changed, so the token is asserted per tone.
        expect(rule).toContain(`background: var(${style.cssVar});`);
    }

    // Running is the same green, told apart by alpha, not by a fourth colour.
    expect(blockOf(".context-bar-segment[data-tone='running'] {")).toContain('opacity: 0.45;');
    expect(CONTEXT_BAR_TONE_STYLES.running.alpha).toBe(0.45);

    // The state signal is never colour alone: focus is an outline, in both modes.
    expect(blockOf(".context-bar-segment[data-focused='true'] {")).toContain('outline: 2px solid var(--accent);');
    expect(blockOf('.context-bar:focus-visible {')).toContain('outline: 2px solid var(--accent);');
});

it('keeps the accessible option list and live region clipped, not hidden', () => {
    const srOnly = blockOf('.context-bar-options,\n.context-bar-live {');

    expect(srOnly).toContain('position: absolute;');
    expect(srOnly).toContain('width: 1px;');
    expect(srOnly).toContain('clip-path: inset(50%);');
    expect(srOnly).not.toContain('display: none;');
});

it('puts the figures at the right of the bar, with the unit and without the label phrase', () => {
    // The stats line is where "characters, not tokens" is written down for the reader; the
    // text itself is `contextBarStatsOf`, pinned in view-context.test.ts. T16 (R16b) moved
    // it to the RIGHT edge — the figures belong at the end of the strip the reader just
    // scanned, and the sentence "context character distribution" is no longer printed at
    // all (`aria-label` still carries it, from `contextBarSummaryOf`).
    const caption = blockOf('.context-bar-caption {');

    expect(caption).toContain('font-family: var(--mono);');
    expect(caption).toContain('text-align: right;');

    // An empty bar gets a dashed track so "nothing recorded" is visible, not a blank line
    // a reader mistakes for a broken control.
    expect(blockOf(".context-bar[data-empty='true'] .context-bar-segments {")).toContain(
        'border: 1px dashed var(--border-strong);'
    );
});

// T22 (R23): the strip says what a turn was made of; the block the reader is actually
// reading still has to appear — exactly once, at the tail of that strip. Two of these
// rules are load-bearing for "one body, nothing stale": the tail prints as pre-wrapped
// text in its own scroll box, and BOTH withdrawal paths are hidden (`[hidden]` for the
// element, `[data-superseded]` for the decision), so a change to the base rule cannot
// bring the wall of stale previews back.
it('prints the one current tail block as text and hides everything superseded', () => {
    const tail = blockOf('.context-bar-tail {');
    expect(tail).toContain('display: block;');
    // The amber edge is the strip's own reasoning tone: the same token
    // `CONTEXT_BAR_TONE_STYLES.reasoning` paints for the segment this body stands for,
    // so a theme change moves the segment and its body together.
    expect(tail).toContain('border-left: 2px solid var(--warn);');
    expect(CONTEXT_BAR_TONE_STYLES.reasoning.cssVar).toBe('--warn');

    // An assistant tail is prose, so it takes the text tone on the same edge instead.
    expect(blockOf(".context-bar-tail[data-kind='assistant'] {")).toContain('border-left-color: var(--text);');

    // Reasoning is scratch space: it renders verbatim (`pre-wrap` keeps the model's own
    // line breaks) and a long round scrolls inside its box rather than growing the tile.
    const body = blockOf('.context-bar-tail-body {');
    expect(body).toContain('white-space: pre-wrap;');
    expect(body).toContain('overflow: auto;');
    expect(body).toContain('max-height:');

    // The caption line states the exact recorded length beside the body, in the same mono
    // face as the bar's count, so the two read as one instrument.
    const caption = blockOf('.context-bar-tail-caption {');
    expect(caption).toContain('font-family: var(--mono);');
    expect(caption).toContain('color: var(--muted);');

    // Both withdrawal paths: the element's own `hidden`, and the decision's own vocabulary.
    expect(blockOf('.context-bar-tail[hidden] {')).toContain('display: none;');
    expect(blockOf("[data-superseded='true'] {")).toContain('display: none;');
});

// T23 (R23): the designated block may be a recorded CALL, and its body is the complete recorded
// request plus, once the call settles, the complete recorded response - one labelled pane each.
// Three things here are load-bearing rather than cosmetic:
//   - the tone comes from the SAME palette entries `CONTEXT_BAR_TONE_STYLES` paints a segment
//     with, so a theme change moves the segment and the body it stands for together;
//   - each pane scrolls in its own box, so a huge result can never push the request the reader
//     aimed at off screen (the tile would otherwise grow without bound at the tail);
//   - a pane whose field was never recorded states the ABSENCE in the segment dialog's muted
//     vocabulary, and no rule adds generated content to a body whose whole job is to read back
//     the recorded bytes exactly.
it('prints the designated call in the strip tones, one bounded pane per recorded field', () => {
    // A settled call takes the strip's `ok` tone, verbatim.
    const tool = blockOf(".context-bar-tail[data-kind='tool'] {");
    expect(tool).toContain(`border-left-color: var(${CONTEXT_BAR_TONE_STYLES.ok.cssVar});`);

    // A failed or abandoned call takes the danger edge - the same token its segment uses. The
    // two states share one rule, so the cancelled selector is what `blockOf` can reach and the
    // error selector is pinned out of the source text beside it.
    expect(blockOf(".context-bar-tail[data-kind='tool'][data-state='cancelled'] {")).toContain(
        `border-left-color: var(${CONTEXT_BAR_TONE_STYLES.error.cssVar});`
    );
    expect(css).toContain(".context-bar-tail[data-kind='tool'][data-state='error'],");

    // A running call is the same colour, visibly unfinished. The tail fades LESS than the
    // segment does (0.72 against `running.alpha`), because this is the body the reader is
    // reading right now: it has to stay legible while it grows.
    const running = blockOf(".context-bar-tail[data-kind='tool'][data-state='running'] {");
    expect(running).toContain('opacity: 0.72;');
    expect(CONTEXT_BAR_TONE_STYLES.running.cssVar).toBe(CONTEXT_BAR_TONE_STYLES.ok.cssVar);
    // The segment's own running fade, pinned exactly: the 0.72 asserted above is the lighter
    // of the two figures, which is the relationship this surface wants.
    expect(CONTEXT_BAR_TONE_STYLES.running.alpha).toBe(0.45);

    // Stacked, never side by side: both fields are long, and every other payload surface in
    // this app gives a recorded field its own labelled block.
    expect(blockOf('.context-bar-tail-pane + .context-bar-tail-pane {')).toContain('margin-top: 8px;');

    // The field name reads like the tool dialog's headings: mono, muted, uppercase.
    const label = blockOf('.context-bar-tail-pane-label {');
    expect(label).toContain('font-family: var(--mono);');
    expect(label).toContain('color: var(--muted);');
    expect(label).toContain('text-transform: uppercase;');

    // The bytes. `pre-wrap` so a recorded newline survives, its own scroll box so it cannot
    // grow the tile, and NO generated content anywhere in the rule - the pane's text is written
    // with `textContent` and must read back exactly as the server sent it.
    const body = blockOf('.context-bar-tail-pane-body {');
    expect(body).toContain('white-space: pre-wrap;');
    expect(body).toContain('overflow: auto;');
    expect(body).toContain('max-height:');
    expect(body).not.toContain('content:');

    // A stated absence is an answer, not a blank: same muted mono vocabulary as the segment
    // dialog's own note, so "no result recorded for this call yet" reads as a fact.
    const note = blockOf('.context-bar-tail-pane-note {');
    const detailNote = blockOf('.block-detail-note {');
    expect(note).toContain('color: var(--muted);');
    expect(note).toContain('font-family: var(--mono);');
    expect(detailNote).toContain('color: var(--muted);');
    expect(detailNote).toContain('font-family: var(--mono);');
});

it('keeps every segment bounded under forced colors', () => {
    expect(css).toMatch(
        /@media \(forced-colors: active\)[\s\S]*?\.context-bar-segment \{[\s\S]*?outline: 1px solid CanvasText;/
    );
});

it('styles the segment dialog with the panes and states the payload already has', () => {
    expect(blockOf('.block-detail-panes {')).toContain('flex-direction: column;');
    // The loading/error note is one surface with a stated state, never an empty body.
    expect(blockOf(".block-detail-note[data-detail='loading'] {")).toContain('border-left-color: var(--warn);');
    expect(blockOf(".block-detail-note[data-detail='error'] {")).toContain('border-left-color: var(--danger);');
    // A long recorded body scrolls inside its pane instead of growing the modal forever.
    expect(blockOf('.block-detail-text {')).toContain('max-height:');
});

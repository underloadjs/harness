// T11 CSS contract for the ONE context bar and its segment dialog.
//
// jsdom does not lay CSS out, so the properties that make the bar work are pinned from the
// stylesheet source, exactly the way `activity-style.test.ts` pins the ring:
//
//   - the two numbers that MUST agree with `view-context.ts` (the painter cannot ask CSS
//     for either one): `CONTEXT_BAR_GAP_PX` as `.context-bar-segments { gap }` and
//     `CONTEXT_BAR_MAX_TRACK_HEIGHT_PX` as the strip box in BOTH modes — the latter published
//     as the `--context-bar-*` tokens in `:root`, which `resolveContextBarTrackHeights` reads
//     so a theme change moves the canvas and the DOM row together (T26, R27);
//   - that the DOM row SEATS its bars (`align-items: flex-end`) exactly as the canvas
//     bottom-aligns its rectangles (R28);
//   - the tone table, from the same `--ok` / `--danger` / `--warn` / `--text` values
//     `CONTEXT_BAR_TONE_STYLES` repeats for the canvas, so a theme change to one of the
//     four tokens moves both renderers together;
//   - the accessible-only surfaces stay clipped rather than `display: none` (a hidden
//     element is removed from the accessibility tree, which would silently delete the bar's
//     text from a screen reader);
//   - forced colors keeps a per-segment boundary, because a colour-only difference is the
//     one thing that mode guarantees to erase;
//   - T22 (R23): the ONE current content block, printed as pre-wrapped text in its own scroll
//     box, and BOTH withdrawal rules hide it — the element's `hidden` and the decision's own
//     `[data-superseded]` attribute; T27 (R2) moved WHERE it prints (the section's flow, below
//     the newest response) while the strip stays in its host;
//   - T23 (R23): when the designated block is a recorded CALL, the body is its complete
//     recorded request and response in one labelled pane each — in the strip's own tool tones,
//     each pane scrolling on its own, with a stated absence in the segment dialog's vocabulary;
//   - T27 (R1a/R1b): ONE shared body-height token for both tail kinds, the thinking body
//     windowed by nothing (its box scrolls the whole round), and the call's two panes laid out
//     inside that same viewport.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/context-bar-style.test.ts

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
    CONTEXT_BAR_GAP_PX,
    CONTEXT_BAR_LINE_HEIGHT_PX,
    CONTEXT_BAR_MAX_HEIGHT_LINES,
    CONTEXT_BAR_MAX_TRACK_HEIGHT_PX,
    CONTEXT_BAR_MIN_SEGMENT_HEIGHT_PX,
    CONTEXT_BAR_TONE_STYLES,
    CONTEXT_BAR_TRACK_HEIGHT_PX
} from '../view-context';

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

// Responsive rules in this stylesheet live beside the section they adapt, so a cap can sit in
// ANY `@media` block carrying this header. `blockOf` cannot slice one (its first `}` is the first
// INNER rule's), so this joins every matching at-rule body: comments are stripped first because
// they name selectors, and each body is brace-matched so a nested rule cannot cut the slice short.
const atRulesOf = (header: string): string => {
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const bodies: string[] = [];

    for (let index = rules.indexOf(header); index >= 0; index = rules.indexOf(header, index + 1)) {
        const open = rules.indexOf('{', index);
        if (open < 0) continue;

        let depth = 0;
        for (let cursor = open; cursor < rules.length; cursor += 1) {
            if (rules[cursor] === '{') depth += 1;
            if (rules[cursor] === '}') {
                depth -= 1;
                if (depth === 0) {
                    bodies.push(rules.slice(open + 1, cursor));
                    break;
                }
            }
        }
    }

    return bodies.join('\n');
};

it('gives DOM mode the model gap and the model strip box', () => {
    const segments = blockOf('.context-bar-segments {');

    // `gap` is what makes the segments VISIBLY separate; without it a proportional bar
    // reads as one merged band and the reader cannot tell where one call ends.
    expect(segments).toContain(`gap: ${CONTEXT_BAR_GAP_PX}px;`);
    // T26 (R27): the box is the TWO-LINE-HEIGHT ceiling, stated once as a token the painter
    // also reads. The per-strip inline height `layout.heightPx` overrides it at runtime; this
    // is what a host with no inline style keeps, and it must agree with the canvas.
    expect(segments).toContain('height: var(--context-bar-max-height);');
    expect(segments).toContain('display: flex;');
    expect(segments).toContain('flex-direction: row;');
    // R27/R28: the bars SEAT on the floor. `align-items: stretch` would turn the row back
    // into a ribbon and disagree with the canvas' bottom-aligned rectangles.
    expect(segments).toContain('align-items: flex-end;');
    // The floor lives in CSS too, so a flex weight that rounds below a pixel is still
    // aimable (the model promises `width >= 1`, the sheet promises it on the DOM side).
    expect(blockOf('.context-bar-segment {')).toContain('min-width: 1px;');
    expect(blockOf('.context-bar-segment {')).toContain('height: var(--context-bar-max-height);');
    expect(blockOf('.context-bar-segment {')).toContain('align-self: flex-end;');
    expect(blockOf('.context-bar-segment {')).toContain('min-height: var(--context-bar-min-height);');
});

it('publishes the vertical scale as tokens the painter resolves, with the model numbers', () => {
    // One source for "what is a line-height here": the sheet declares the three numbers and
    // `resolveContextBarTrackHeights` reads them, so a theme that restyles the bar moves BOTH
    // renderers without either one hardcoding a scale (T26, R27).
    const root = blockOf(':root {');

    expect(root).toContain(`--context-bar-line-height: ${CONTEXT_BAR_LINE_HEIGHT_PX}px;`);
    expect(root).toContain(`--context-bar-max-height: ${CONTEXT_BAR_MAX_TRACK_HEIGHT_PX}px;`);
    expect(root).toContain(`--context-bar-min-height: ${CONTEXT_BAR_MIN_SEGMENT_HEIGHT_PX}px;`);
    // The ceiling is TWO line-heights, and the empty strip reserves exactly one of them.
    expect(CONTEXT_BAR_MAX_TRACK_HEIGHT_PX).toBe(CONTEXT_BAR_LINE_HEIGHT_PX * CONTEXT_BAR_MAX_HEIGHT_LINES);
    expect(CONTEXT_BAR_TRACK_HEIGHT_PX).toBe(CONTEXT_BAR_LINE_HEIGHT_PX);

    // The name line uses the same token it is measured against, so a label is never minted
    // into a bar too short to hold it.
    expect(blockOf('.context-bar-segment-name {')).toContain('line-height: var(--context-bar-line-height);');
    // And the dashed "nothing recorded" box keeps one line-height of height.
    expect(blockOf(".context-bar[data-empty='true'] .context-bar-segments {")).toContain(
        'min-height: var(--context-bar-line-height);'
    );
});

it('paints the same box in canvas mode', () => {
    expect(blockOf('.context-bar-canvas {')).toContain('height: var(--context-bar-max-height);');
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
    // scanned, and the sentence "context bar: width is time taken, height is recorded
    // characters" is no longer printed at all (`aria-label` still carries it, from
    // `contextBarSummaryOf`).
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
// reading still has to appear — exactly once, AFTER the content that precedes it (T27, R2: the
// section's own flow, below the newest response). Two of these
// rules are load-bearing for "one body, nothing stale": the tail prints as pre-wrapped
// text in its own scroll box, and BOTH withdrawal paths are hidden (`[hidden]` for the
// element, `[data-superseded]` for the decision), so a change to the base rule cannot
// bring the wall of stale previews back.
it('prints the one current tail block as text and hides everything superseded', () => {
    const tail = blockOf('.context-bar-tail {');
    // The block is a two-row flex column — caption row then body — because the OUTER height is
    // ONE shared token and the body has to be the part that fits inside it (see the height test
    // below for the 12-line figure and the mobile cap).
    expect(tail).toContain('display: flex;');
    expect(tail).toContain('flex-direction: column;');
    expect(tail).toContain('height: var(--context-tail-height);');
    // The viewport clamp lives on the base rule with the height, so it applies at every width.
    expect(tail).toContain('max-height: 50vh;');
    expect(tail).toContain('max-height: 50dvh;');
    // The amber edge is the strip's own reasoning tone: the same token
    // `CONTEXT_BAR_TONE_STYLES.reasoning` paints for the segment this body stands for,
    // so a theme change moves the segment and its body together.
    expect(tail).toContain('border-left: 2px solid var(--warn);');
    expect(CONTEXT_BAR_TONE_STYLES.reasoning.cssVar).toBe('--warn');

    // An assistant tail is prose, so it takes the text tone on the same edge instead.
    expect(blockOf(".context-bar-tail[data-kind='assistant'] {")).toContain('border-left-color: var(--text);');

    // Reasoning is scratch space: it renders verbatim (`pre-wrap` keeps the model's own
    // line breaks) and a long round scrolls inside its box rather than growing the tile.
    // The bound itself is the BLOCK's (the token above); `min-height: 0` + `flex: 1 1 auto` are
    // what make that true — the body is the shrinkable remainder, so neither a long body nor the
    // mobile viewport cap can push the block past its height.
    const body = blockOf('.context-bar-tail-body {');
    expect(body).toContain('white-space: pre-wrap;');
    expect(body).toContain('overflow: auto;');
    expect(body).toContain('flex: 1 1 auto;');
    expect(body).toContain('min-height: 0;');

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

it('sizes the tail block at 12 of its OWN text line boxes, shared by both kinds (R1a, T28)', () => {
    // T28: "The block height too big. It should be 50% maximum on mobile view, and about 12 line
    // height on desktop." The figure is measured in the line box THIS block actually renders, and
    // it is DERIVED here from the body's own type declarations — so changing `font-size` or
    // `line-height` without re-deriving the token fails this test instead of silently resizing the
    // block. There is still exactly ONE height, declared once on the block and shared by both
    // kinds, so a call and a thinking window cannot drift apart.
    const body = blockOf('.context-bar-tail-body {');
    const fontSize = Number(/font-size: (\d+)px/.exec(body)?.[1]);
    const leading = Number(/line-height: ([\d.]+)/.exec(body)?.[1]);

    expect([fontSize, leading]).toEqual([12, 1.55]);

    const lineBox = fontSize * leading; // 18.6px

    // The ARGUMENTS/RESULT `pre` renders at the identical metrics, so one line box is the honest
    // ruler for both tail kinds; the thinking body is the representative text here.
    const paneBody = blockOf('.context-bar-tail-pane-body {');

    expect(paneBody).toContain('font-size: 12px;');
    expect(paneBody).toContain('line-height: 1.55;');

    const tail = blockOf('.context-bar-tail {');

    expect(tail).toContain(`--context-tail-line-height: ${lineBox}px;`);
    expect(tail).toContain('--context-tail-height: calc(12 * var(--context-tail-line-height));');
    // The file-wide border-box reset makes that token the OUTER box — caption row + body +
    // padding + border — i.e. 12 x 18.6px = 223.2px on desktop, not merely the scroll viewport.
    expect(tail).toContain('height: var(--context-tail-height);');

    // Budget arithmetic the next two rules have to keep true: the caption is a fixed
    // 2 x (10px x 1.3) = 26px row plus its 6px bottom margin (32px), and the block's own chrome is
    // 8+8px padding and 1+1px border (18px), so the shared body viewport is
    // 223.2 - 32 - 18 = 173.2px = 9.3 of the same line boxes.
    expect(body).toContain('flex: 1 1 auto;');
    expect(body).toContain('min-height: 0;');
    // R1b: the whole thinking body is in the DOM, so the box has to be able to scroll it.
    expect(body).toContain('overflow: auto;');

    // The caption is the block's only content-sized row, and a settled call's longest line wraps
    // to three lines in a narrow delegated card where a thinking line takes one. The row is a
    // FIXED two-line box — `min-height` so a short caption cannot make its block shorter,
    // `max-height` + `overflow: hidden` so a long one cannot make it taller — which is what makes
    // the OUTER boxes of the two kinds match rather than only their scroll boxes.
    const caption = blockOf('.context-bar-tail-caption {');

    // Fixed row of the flex column: it neither grows (which would push the block past 12 lines)
    // nor shrinks (which would let a mobile cap swallow the state line).
    expect(caption).toContain('flex: 0 0 auto;');
    expect(caption).toContain('line-height: 1.3;');
    expect(caption).toContain('min-height: 2.6em;');
    expect(caption).toContain('max-height: 2.6em;');
    expect(caption).toContain('overflow: hidden;');
    // One rule for both kinds: no per-kind caption override may exist, or the two blocks drift
    // apart again the moment one tone adds a clause.
    expect(css).not.toContain(".context-bar-tail[data-kind='tool'] .context-bar-tail-caption");
    expect(css).not.toContain(".context-bar-tail[data-kind='reasoning'] .context-bar-tail-caption");

    // The thinking kind adds no height of its own — the shared rule IS its height. A second
    // `.context-bar-tail[data-kind='reasoning'] .context-bar-tail-body` rule is exactly the
    // way this contract breaks, so it is pinned out of the stylesheet.
    expect(css).not.toContain(".context-bar-tail[data-kind='reasoning'] .context-bar-tail-body");

    // The call lays its two panes out INSIDE that same viewport: it inherits the token from the
    // base rule (so it declares no height itself) and hands the scrolling to the panes.
    const toolBody = blockOf(".context-bar-tail[data-kind='tool'] .context-bar-tail-body {");

    expect(toolBody).toContain('display: flex;');
    expect(toolBody).toContain('flex-direction: column;');
    expect(toolBody).toContain('overflow: hidden;');
    expect(toolBody).not.toContain('height:');

    // A flex item's automatic minimum is its content size, which would push the fixed viewport
    // open instead of scrolling inside it.
    const pane = blockOf(".context-bar-tail[data-kind='tool'] .context-bar-tail-pane {");

    expect(pane).toContain('display: flex;');
    expect(pane).toContain('flex-direction: column;');
    expect(pane).toContain('min-height: 0;');

    // T28 proportions: at the 173.2px remainder a rem cap would either waste the box or starve
    // one field, so the request is held to a SHARE of it and the response takes the rest. The
    // percentage is the part that keeps working under the mobile cap, where the box is smaller.
    expect(tail).toContain('--context-tail-args-share: 40%;');

    const argsPane = blockOf(".context-bar-tail[data-kind='tool'] .context-bar-tail-pane[data-pane='args'] {");

    // `flex-shrink: 0` is load-bearing (T28 review): the request pane is sized by its OWN payload,
    // so a short argument list keeps its natural height instead of being shrunk proportionally
    // against a long result. With shrink allowed the most common shape — a one-line `grep`
    // argument list against an 80-line result — collapsed the pane to a ~5px sliver its own label
    // and `pre` spilled out of.
    expect(argsPane).toContain('flex: 0 0 auto;');
    expect(argsPane).toContain('min-height: 0;');
    // 40% of 173.2px = 69.3px (label included) at desktop, and 40% of whatever the `50dvh` clamp
    // leaves at mobile — the result pane can never be squeezed out of the box.
    expect(argsPane).toContain('max-height: var(--context-tail-args-share);');
    // A floor AND a ceiling: the share is a `max-height`, never a `height`, so a two-line request
    // does not reserve 40% of the box it does not need.
    expect(argsPane).not.toMatch(/(^|\n)\s*height\s*:/);

    const argsBody = blockOf(".context-bar-tail[data-kind='tool'] .context-bar-tail-pane[data-pane='args'] .context-bar-tail-pane-body {");

    // The pane owns the cap, so the `pre` fills it and scrolls inside it: its own rem figure is
    // lifted deliberately, otherwise a 14rem pane would overflow a 69px box.
    expect(argsBody).toContain('flex: 1 1 auto;');
    expect(argsBody).toContain('min-height: 0;');
    expect(argsBody).toContain('max-height: none;');

    const resultPane = blockOf(".context-bar-tail[data-kind='tool'] .context-bar-tail-pane[data-pane='result'] {");

    expect(resultPane).toContain('flex: 1 1 auto;');

    const resultBody = blockOf(".context-bar-tail[data-kind='tool'] .context-bar-tail-pane[data-pane='result'] .context-bar-tail-pane-body {");

    expect(resultBody).toContain('flex: 1 1 auto;');
    expect(resultBody).toContain('min-height: 0;');
    expect(resultBody).toContain('max-height: none;');
});

it('clamps the WHOLE tail block to half the visual viewport, at every width (T28)', () => {
    // "It should be 50% maximum on mobile view." A width-keyed cap was the coverage gap: it left a
    // large landscape phone/tablet (932x430 measured ~52% of the viewport) and a short desktop
    // window (1000x300 measured 223.19px, over the viewport itself) uncapped, because the media
    // query never matched there. The clamp therefore sits on the base rule beside the height it
    // clamps, so the used height is `min(12 line boxes, 50% of the viewport)` for BOTH kinds, with
    // no new breakpoint invented.
    const tail = blockOf('.context-bar-tail {');

    // Dual declaration: `vh` is the fallback for an engine with no `dvh`, and the `dvh`
    // declaration wins where it parses — the VISUAL viewport, so mobile browser chrome cannot
    // leave the block taller than half of what the reader actually sees.
    expect(tail).toContain('max-height: 50vh;');
    expect(tail).toContain('max-height: 50dvh;');
    // A clamp, not a re-sized box: the 12-line height stays declared where it is.
    expect(tail).toContain('height: var(--context-tail-height);');
    // One clamp for both kinds — no per-kind override of the BLOCK may exist anywhere, or the two
    // blocks drift. (`\s*\{` right after the kind selector, so the call's own pane layout rules —
    // descendants that legitimately carry the 40% share — are not mistaken for a block override.)
    expect(css).not.toMatch(/\.context-bar-tail\[data-kind='[a-z]+'\]\s*\{[^}]*max-height/);
    // And the clamp is not repeated per width, which is how the two figures would start disagreeing
    // by breakpoint: no responsive block may mention the tail at all.
    expect(atRulesOf('@media (max-width: 860px)')).not.toContain('.context-bar-tail');
    expect(atRulesOf('@media (max-width: 1180px)')).not.toContain('.context-bar-tail');
    expect(atRulesOf('@media (max-width: 600px)')).not.toContain('.context-bar-tail');
    // The shrink has somewhere to go under the clamp: the body is the block's flex remainder with
    // `min-height: 0`, while the caption row is `flex: 0 0 auto` and keeps its two fixed lines.
    expect(blockOf('.context-bar-tail-body {')).toContain('min-height: 0;');
    expect(blockOf('.context-bar-tail-body {')).toContain('flex: 1 1 auto;');
    expect(blockOf('.context-bar-tail-caption {')).toContain('flex: 0 0 auto;');
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

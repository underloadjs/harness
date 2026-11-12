// The ONE context bar surface (T11, R7/R8): a single horizontal strip of segments that
// replaces the wall of per-call chips a long turn used to print.
//
// WHY CANVAS, AND WHY THE DOM FALLBACK IS NOT A COMPATIBILITY HACK
// ---------------------------------------------------------------
// A turn can record hundreds of tool calls. The chip wall paid a card, a timer and a
// dialog owner for each one; this bar paints the same information in ONE element:
//
//   - canvas mode (a 2D context is available) — one `<canvas>`, O(1) DOM nodes per
//     segment, geometry from ./view-context.ts, hit-testing by x coordinate, and a
//     visually hidden option list plus a live region for assistive tech;
//   - DOM mode (no 2D context: jsdom, a stripped webview, a hardened page) — one
//     lightweight `<button>` per segment with a flex weight, native focus and a native
//     tooltip. Hundreds of plain buttons are cheap; hundreds of tool CARDS are not, and
//     this mode never builds a card, a timer or a Markdown block.
//
// Both modes are the SAME widget to the caller: same classes, same `data-*` vocabulary,
// same labels, same keyboard map (arrows/Home/End, Enter/Space), and one callback per
// activation. The mode is reported on `data-mode` and via `mode()` so a host (and a
// test) can assert which one it got.
//
// THE TWO AXES (T26, R27)
// -----------------------
// The strip is a column chart, not a stacked ribbon. A segment's WIDTH is the recorded TIME
// TAKEN (laid out sequentially, never as an overlapping timeline) and its HEIGHT is the
// recorded CONTEXT SIZE in characters, normalized to the biggest block in the SAME strip and
// capped at two line-heights; every bar sits on the strip's bottom edge, and both renderers
// seat, size and hit-test from the one `layoutContextBar` result. The vertical line-height
// comes from the host (`--context-bar-line-height`, else the computed line-height, else the
// shared constant), so "2 line-heights" is two lines of THAT host's text at any font size,
// any theme and any `devicePixelRatio` — the ratio only ever scales the canvas backing store.
// Aim policy is the column, not the painted pixels: a pointer in the blank area above a short
// bar still activates that segment, in canvas mode by construction and in DOM mode by the
// documented x-coordinate fallback in `onSegmentClick`.
//
// THE LANES (C2 — why a compaction is visible)
// --------------------------------------------
// A block's `lane` (absent ⇒ 0) is which STACKED ROW of this one widget it belongs to, and
// ./view-context.ts `layoutContextBar` already stacked the rows: `layout.rows` is one entry
// per lane the blocks actually occupy (lane 0 topmost, ascending downward) and
// `layout.heightPx` is the whole stack. The painter adds no grouping of its own — canvas mode
// paints every row into ONE taller canvas at `row.offsetY`, DOM mode mints one
// `.context-bar-segments` element per row inside a `.context-bar-rows` column — so both modes
// still describe one rectangle decided by one arithmetic.
//
// A one-lane bar therefore paints EXACTLY what it painted before: one row at offset 0, the
// same `fillRect` rectangles, one `.context-bar-segments` element (in a wrapper that is a plain
// pass-through), the same caption, the same keyboard order. The multi-lane CUE is a small
// `L0`/`L1` tag per row (real DOM text in both modes, so a screen reader reads it too) that
// appears only when the reader could be confused: more than one row, or a bar whose only lane
// is not lane 0. Keyboard traversal follows the row-grouped order — all of row 0, then all of
// row 1 — which is the flat order for any bar whose lanes are monotonic (all lanes are, since
// a lane is assigned at mint time and never rewritten).
//
// THE DIM STATE (R7, T4a — "not in the context any more")
// -------------------------------------------------------
// A block can leave the prompt after it was recorded: the reader excludes it from the segment
// dialog, or a plugin writes `turn.before setIncluded` / `setReasoningIncluded`. The verdict is
// the tri-state `ContextBlock.included` (../../shared/turn-display.ts:567-600), it reaches this
// client through ../display-project.ts (a producer that publishes it) and through a
// `context:set` patch (a reader or plugin that changes it), and ./view-context.ts
// `contextBlockIsExcluded` is the ONE place it is read: `false` dims, `true` and ABSENT (no
// transcript entry behind the segment = unknown) paint normally.
//
// The rendering is transparency and NOTHING else — 0.2 in canvas mode (`globalAlpha` through
// `contextBarSegmentAlphaOf`, which also fades this mode's in-segment name so the two renderers
// still agree, since DOM mode fades the label with its button) and `opacity: 0.2` in DOM mode
// (`data-included='false'`, the figure `CONTEXT_BAR_EXCLUDED_ALPHA` mirrors). A dimmed segment is
// still a segment: same hit box, same column aim, same Enter/Space, same roving tabindex, same
// hover and focus outline. `styles.css` carries no `pointer-events`, no `display` and no
// `[data-included]` colour rule, and the words say it too — `contextBarSegmentTitleOf` keeps the
// model's `not replayed into the prompt` clause on it, which is what a screen reader hears.
//
// THE BAR NEVER FETCHES (R8)
// --------------------------
// Rendering reads nothing but the block metadata. A request happens when the reader
// ACTIVATES one segment, and the tile owns that callback (`onActivate` -> the dialog in
// ./ui/context-detail.ts). A board with 500 segments therefore costs exactly zero
// requests until one is clicked.
//
// Cross-references:
//   - ./view-context.ts      — the model, the widths, the tones, the label wording
//   - ./ui/context-detail.ts — the click-time full-detail dialog
//   - ./ui/turns.ts          — the tile that mounts one bar per turn
//   - ../styles.css          — `.context-bar*` rules (colors, gaps, the sr-only list)

import type { ContextBlock } from '../../shared/turn-display';
import {
    CONTEXT_BAR_FALLBACK_WIDTH,
    CONTEXT_BAR_LABEL,
    CONTEXT_BAR_LINE_HEIGHT_PX,
    CONTEXT_BAR_MAX_HEIGHT_LINES,
    CONTEXT_BAR_MAX_TRACK_HEIGHT_PX,
    CONTEXT_BAR_MIN_SEGMENT_HEIGHT_PX,
    CONTEXT_BAR_OPTION_LIMIT,
    CONTEXT_BAR_TONE_STYLES,
    contextBarLaneLabelOf,
    contextBarLaneTagOf,
    contextBarSegmentAlphaOf,
    contextBarSegmentAt,
    contextBarShowsLaneTagsOf,
    contextBarStatsOf,
    contextBarSummaryOf,
    contextBarToneOf,
    contextBlockIsExcluded,
    contextBlockIsWithheld,
    contextSegmentLabelOf,
    contextSegmentTitleOf,
    formatContextCharCount,
    layoutContextBar
} from '../view-context';
import type { ContextBarLayout, ContextBarModel } from '../view-context';

// A segment at least this wide gets its name painted inside it; below that a label would
// be clipped to noise, so the colour and the tooltip carry it instead. The DOM mode uses
// the same idea for whether a segment carries a label element at all.
export const CONTEXT_BAR_LABEL_MIN_PX = 44;

// T26 (R27): and it needs the bar to be at least this many line-heights tall, because a
// 6px-high bar has no room for an 18px line of text. Both modes apply this rule, so a
// segment is labelled in the DOM fallback exactly when it is labelled on the canvas.
export const CONTEXT_BAR_LABEL_MIN_LINES = 1;

// In-segment label colour. The segment itself IS the background, so the text is the
// track's own dark (the `styles.css` `--bg`), not a per-tone computation.
export const CONTEXT_BAR_ON_SEGMENT_TEXT = '#0b0d12';

// A flex row this crowded prints no in-segment labels either — one text node per segment
// is real layout cost at hundreds, and the bar is being read as a picture at that point.
export const CONTEXT_BAR_DOM_LABEL_LIMIT = 12;

// THE THINKING NOTE (trimmer uplift F8, acceptance criterion H5 — "UI truth")
// --------------------------------------------------------------------------
// `../view-context.ts` mints ONE trailing clause for every block the server marks
// `inPrompt !== true`: "not replayed into the prompt". For a TOOL block that is a fact the
// projector earned. For a REASONING block it is the projector's STATIC per-kind verdict
// (`../server/turn-projector.ts` stamps the whole class `inPrompt: false`), and the trimmer's
// thinking policy (`trimThoughts` + `thoughtTurns`) decides per ENTRY, so that sentence stops
// being a property of the class: under the shipped default (trim on, horizon 2) the two newest
// thoughts ARE replayed into the prompt, so the
// bar would be stating a falsehood on a per-segment absolute it cannot see.
//
// The bar CANNOT resolve a per-entry verdict — one activation is the only request it ever
// makes (see "THE BAR NEVER FETCHES" above), and the join that names the entry behind a
// thinking segment lives on the block-detail route, which is exactly where
// ./context-detail.ts `inclusionFactOf` renders a real chip. What the bar CAN say is the
// truth it does hold: this strip cannot tell the reader which side of the thinking policy the
// segment fell on. Hence the wording below, in place of the absolute.
//
// The exact string is the dialog chip's ABSENT wording, duplicated deliberately rather than
// imported: ./context-detail.ts drags the dialog's whole graph (a fetch, a Markdown block)
// and the bar's "does not fetch, builds no card" rule is what keeps a 500-segment board
// free. ./context-bar.test.ts pins both spellings so the two surfaces cannot drift silently,
// and the RENDERED note states no absolute of its own — acceptance H5 asks that the word
// "never" appear nowhere in the thinking wording.
export const CONTEXT_BAR_THINKING_NOTE = 'replay decided by the thinking policy';

/**
 * The bar's hover/accessible text for ONE segment: the model's string verbatim, except that
 * a THINKING segment the server marked `inPrompt !== true` carries
 * `CONTEXT_BAR_THINKING_NOTE` where the model would have put the static absolute (F8/H5).
 *
 * Every other segment is byte-identical BY CONSTRUCTION — the guard returns the model's own
 * string, and even the thinking path re-uses it: `inPrompt` is read in exactly ONE place in
 * `contextSegmentTitleOf` (that trailing clause), so asking for the in-prompt form and
 * appending the note here is the whole substitution. No string surgery, no duplicated
 * figures, nothing that could drift from the model's own numbers.
 *
 * R7 (T4a) adds ONE condition to that guard: a segment the server marked `included: false`
 * keeps the model's ABSOLUTE. The substitution exists because the bar cannot tell which side of
 * the thinking policy a thinking segment fell on — and `included: false` IS that answer, named
 * per entry by the producer that can see the transcript (../../shared/turn-display.ts:578-585: for
 * a thinking segment it is the THINKING axis, the entry itself still travelling). Saying "this
 * replay is decided by a policy" when the server has already decided it would be the bar
 * hiding a fact it is holding, so the dimmed segment's own words say what the dim shows:
 * `not replayed into the prompt`. A published `included: true` changes nothing here — the
 * policy note stays the honest wording for a thinking segment whose inclusion the bar cannot
 * see per-FRAME, and the bar's own F8/H5 pins below stay byte-identical.
 */
export const contextBarSegmentTitleOf = (block: ContextBlock): string => {
    // `(A && !B) || B` is `A || B`: the two guards below are the ORIGINAL condition
    // (`inPrompt === true` or a published `included: false`) stated through the shared
    // predicate, with the `contextBlockIsExcluded` term kept explicit because a switched-off
    // thinking window is the answer the policy note was waiting for and never gets re-worded.
    if (block.kind !== 'reasoning' || !contextBlockIsWithheld(block) || contextBlockIsExcluded(block))
        return contextSegmentTitleOf(block);

    return `${contextSegmentTitleOf({ ...block, inPrompt: true })} · ${CONTEXT_BAR_THINKING_NOTE}`;
};

/** Position + the bar's title: the label one segment carries in DOM mode and in the live region. */
export const contextBarSegmentLabelOf = (block: ContextBlock, index: number, total: number): string => {
    if (block.kind !== 'reasoning' || !contextBlockIsWithheld(block) || contextBlockIsExcluded(block))
        return contextSegmentLabelOf(block, index, total);

    // Same substitution, applied one level up: `contextSegmentLabelOf` owns the "N of M" prefix,
    // so re-using it keeps the position wording in the model instead of copying it here.
    return `${contextSegmentLabelOf({ ...block, inPrompt: true }, index, total)} · ${CONTEXT_BAR_THINKING_NOTE}`;
};

/**
 * True when EVERY withheld byte belongs to a thinking segment.
 *
 * That is the only case in which the bar's aggregate figure may take the policy wording: a byte
 * that is unreplayed for a NON-thinking reason really is absent from the request, so a mixed
 * strip keeps the model's literal count and stays honest.
 *
 * R5 review, FIX A moved this test onto `contextBlockIsWithheld` rather than `inPrompt` alone,
 * and that is load-bearing, not tidiness: the aggregate figure now also counts a segment a reader
 * SWITCHED off (`included: false` on an entry the projector calls replayed — a tool request today,
 * an answer window the moment src/server/api.ts can name its entry), and a predicate that still
 * looked only at `inPrompt` would call those bytes thinking-only and re-word them as "the thinking
 * policy decides". A switch is not a policy. Every non-thinking withheld segment now vetoes the
 * substitution on its own, which is what the F8/H5 rule always meant.
 */
const unpromptedBytesAreThinkingOnly = (model: ContextBarModel): boolean => {
    if (model.unpromptedChars <= 0) return false;

    for (const block of model.blocks) {
        if (contextBlockIsWithheld(block) && block.kind !== 'reasoning') return false;
    }

    return true;
};

/**
 * The bar's ACCESSIBLE name: the model's summary, with the aggregate
 * "N characters not replayed into the prompt" clause re-worded the same way the segments are
 * whenever every one of those characters is thinking (F8/H5 — the same absolute, in the
 * strip's own `aria-label`).
 *
 * The mechanism is a COPY with `unpromptedChars: 0`: that drops the model's clause without
 * touching its count of segments, total characters, recorded time or unmeasured segments, and
 * the replacement clause re-prints the SAME server figure through the same formatter, so the
 * number and the wording cannot disagree with each other or with the tooltip.
 */
export const contextBarAccessibleNameOf = (model: ContextBarModel): string => {
    const figures = contextBarSummaryOf(model);

    if (!unpromptedBytesAreThinkingOnly(model)) return figures;

    return `${contextBarSummaryOf({ ...model, unpromptedChars: 0 })} · ${formatContextCharCount(model.unpromptedChars)} characters' ${CONTEXT_BAR_THINKING_NOTE}`;
};

export type ContextBarActivateInput = {
    block: ContextBlock;
    index: number;
    total: number;
    source: 'pointer' | 'keyboard';
};

export type ContextBarActivate = (input: ContextBarActivateInput) => void;

export type ContextBarOptions = {
    /** Called for ONE segment activation (click, Enter or Space). Nothing else calls it. */
    onActivate?: ContextBarActivate;
    /** Explicit track width. Absent => the host's measured width, else the fallback. */
    width?: number;
    /** Geometry overrides, primarily for a host that paints a denser bar. */
    gapPx?: number;
    minSegmentPx?: number;
    /** Vertical overrides (R27): a host that knows its own line-height passes it here. */
    lineHeightPx?: number;
    maxHeightPx?: number;
    minSegmentHeightPx?: number;
};

export type ContextBarMode = 'canvas' | 'dom';

export type ContextBar = {
    element: HTMLElement;
    mode: () => ContextBarMode;
    /** Replace the segments. Idempotent: an identical model repaints nothing new. */
    setModel: (model: ContextBarModel) => void;
    /** Re-aim the geometry at a new track width (a resize, or a host that measures). */
    setWidth: (width: number) => void;
    setActivate: (activate: ContextBarActivate | undefined) => void;
    /** The geometry currently in force (also what the DOM mode weighted itself by). */
    layout: () => ContextBarLayout;
    focused: () => number;
    setFocused: (index: number) => void;
    /** Drop every segment (the tile keeps the shell for the next turn). */
    clear: () => void;
    destroy: () => void;
};

// The 2D context probe. jsdom (and any page that disabled canvas) throws or answers
// null; a canvas that cannot answer `fillRect` is treated as absent, which is what makes
// the DOM mode the default in a test environment instead of a silent no-op bar.
const context2dOf = (canvas: HTMLCanvasElement): CanvasRenderingContext2D | null => {
    try {
        const value = canvas.getContext('2d') as CanvasRenderingContext2D | null;

        return value !== null && typeof value.fillRect === 'function' ? value : null;
    } catch {
        return null;
    }
};

// A custom property that resolves to '' (jsdom, an unthemed host) falls back to the
// palette constant in ./view-context.ts, so the bar is never invisible.
const toneColorOf = (tone: ReturnType<typeof contextBarToneOf>, computed: CSSStyleDeclaration): string => {
    const style = CONTEXT_BAR_TONE_STYLES[tone];
    const raw = computed.getPropertyValue(style.cssVar);
    const value = typeof raw === 'string' ? raw.trim() : '';

    return value.length > 0 ? value : style.color;
};

// A resolved CSS length in pixels, or undefined for anything this painter cannot use.
// `getComputedStyle` answers with an ABSOLUTE value, so a `px` result is already device-
// independent; `normal`, a unitless `1.5`, an `em`, a `%` or an unset custom property all
// answer undefined, which is what keeps a themeless host (and jsdom, which lays nothing out)
// on the documented constants instead of on NaN.
const pixelsOf = (value: string | null | undefined): number | undefined => {
    const raw = typeof value === 'string' ? value.trim() : '';
    const match = /^(\d+(?:\.\d+)?)px$/.exec(raw);

    if (match === null) return undefined;

    const parsed = Number.parseFloat(match[1]);

    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

/** The vertical band one strip paints into: one line-height, its 2-line ceiling, and the
 *  shortest bar that still reads as a bar. */
export type ContextBarTrackHeights = {
    lineHeightPx: number;
    maxHeightPx: number;
    minSegmentHeightPx: number;
};

/**
 * Resolve the vertical scale from the HOST (T26, R27), in this order:
 *
 *   1. `--context-bar-line-height` / `--context-bar-max-height` / `--context-bar-min-height`
 *      on the document root — the tokens `styles.css` ships, and the only way a themed host
 *      can say "my line-height is 22px" without the painter guessing;
 *   2. the bar element's own computed `line-height` (inherited from the host's prose), which
 *      is the literal "line-height" a reader counts;
 *   3. the constants in ../view-context.ts, which `styles.css` mirrors so the DOM fallback is
 *      sized identically without any JS.
 *
 * The ceiling is always TWO line-heights of whatever scale won (R27), and everything here is
 * CSS pixels: `devicePixelRatio` scales the canvas backing store only, so 2lh measures the
 * same at 1x, 2x and a 90% browser zoom.
 */
export const resolveContextBarTrackHeights = (element: HTMLElement): ContextBarTrackHeights => {
    const fallback: ContextBarTrackHeights = {
        lineHeightPx: CONTEXT_BAR_LINE_HEIGHT_PX,
        maxHeightPx: CONTEXT_BAR_MAX_TRACK_HEIGHT_PX,
        minSegmentHeightPx: CONTEXT_BAR_MIN_SEGMENT_HEIGHT_PX
    };

    if (typeof getComputedStyle !== 'function') return fallback;

    let tokens: CSSStyleDeclaration | undefined;
    let own: CSSStyleDeclaration | undefined;

    try {
        tokens = getComputedStyle(document.documentElement);
        own = getComputedStyle(element);
    } catch {
        return fallback;
    }

    const token = (name: string): number | undefined => (tokens === undefined ? undefined : pixelsOf(tokens.getPropertyValue(name)));

    const lineHeightPx = token('--context-bar-line-height') ?? pixelsOf(own?.lineHeight) ?? fallback.lineHeightPx;
    const maxHeightPx = token('--context-bar-max-height') ?? lineHeightPx * CONTEXT_BAR_MAX_HEIGHT_LINES;
    const minSegmentHeightPx = token('--context-bar-min-height') ?? fallback.minSegmentHeightPx;

    return {
        lineHeightPx,
        maxHeightPx: Math.max(1, Math.round(maxHeightPx)),
        // A ceiling below the floor is a broken token pair: the floor cannot win, because
        // "maximum 2 line-heights" is the rule the reader sees.
        minSegmentHeightPx: Math.max(1, Math.min(Math.round(minSegmentHeightPx), Math.round(maxHeightPx)))
    };
};

/**
 * Mount one context bar. The element is inert until `setModel` — a tile that turns out to
 * have no context costs one empty wrapper.
 */
export const mountContextBar = (options: ContextBarOptions = {}): ContextBar => {
    const element = document.createElement('div');
    element.className = 'context-bar';
    element.setAttribute('role', 'group');
    element.setAttribute('aria-label', CONTEXT_BAR_LABEL);

    let activate = options.onActivate;
    let model: ContextBarModel | undefined;
    let layout: ContextBarLayout = layoutContextBar([], options.width ?? CONTEXT_BAR_FALLBACK_WIDTH);
    // An explicit `setWidth` (or a width a resize pass measured). The constructor's
    // `options.width` is only a HINT below that, so a host that lays out later is never
    // stuck with the width it did not have yet.
    let width = 0;
    let focused = -1;
    // The focused segment tracked by ID as well as by index: a live turn APPENDS blocks,
    // so an index would silently move the keyboard's place onto a different call while the
    // reader is mid-navigation.
    let focusedBlockId: string | undefined;
    let destroyed = false;

    // --- canvas attempt ---------------------------------------------------
    const canvas = document.createElement('canvas');
    canvas.className = 'context-bar-canvas';
    // The picture repeats what the group label and the option list already say.
    canvas.setAttribute('aria-hidden', 'true');

    const context = context2dOf(canvas);
    const mode: ContextBarMode = context === null ? 'dom' : 'canvas';
    // Which renderer this host got is part of the element's contract: the stylesheet and
    // the tests both read it.
    element.dataset.mode = mode;

    // Canvas mode keeps the visuals in one element, so it needs its own accessible
    // surfaces: a visually hidden option list (bounded by CONTEXT_BAR_OPTION_LIMIT) that a
    // screen reader can browse, and ONE polite live region that states the segment under
    // focus as the keyboard moves through it.
    const optionsList = document.createElement('div');
    optionsList.className = 'context-bar-options';

    const live = document.createElement('span');
    live.className = 'context-bar-live';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');

    // DOM mode's ROW STACK (C2): one `.context-bar-segments` element per lane, laid out as a
    // column. The buttons ARE the widget, so no option list and no tabindex on the wrapper
    // (Tab would otherwise stop twice). A bar with a single lane gets exactly one row element
    // in here: the wrapper is a pass-through box, and that is the entire structural cost of
    // lanes on a strip that has none.
    const rowStack = document.createElement('div');
    rowStack.className = 'context-bar-rows';

    // The lane tags (C2): ONE absolutely positioned overlay in BOTH modes, aligned to the top
    // of the track area (the canvas, or the row stack, is always the first child). Real DOM
    // text rather than canvas glyphs, so the same element serves the eye and the screen reader
    // — and `pointer-events: none` in `styles.css` keeps it out of every pointer target.
    const laneTags = document.createElement('div');
    laneTags.className = 'context-bar-lanes';

    // The figures line (T16/R16b): segment count + exact character total, right-aligned
    // under the track by `styles.css`. It carries NO leading label wording, and it is NOT
    // the accessible name — `aria-label` keeps the full summary (label + figures) above.
    const caption = document.createElement('p');
    caption.className = 'context-bar-caption';
    caption.textContent = '';

    if (mode === 'canvas') {
        element.tabIndex = 0;
        element.append(canvas, laneTags, optionsList, live);
    } else {
        element.append(rowStack, laneTags);
    }

    element.append(caption);

    // --- geometry ---------------------------------------------------------

    // Measured width, with the documented fallbacks: an explicit `setWidth` (or a width a
    // resize observer just measured), then the laid-out PAINTED SURFACE, then the caller's
    // initial hint, then CONTEXT_BAR_FALLBACK_WIDTH. A detached tile (jsdom, a collapsed
    // conversation) therefore still has real geometry, and a host that LAYS OUT later gets
    // its true width from the observer rather than keeping the hint.
    //
    // T27 (parity check): the surface first, NOT the wrapper. The canvas and the flex ROW STACK
    // are both `width: 100%` of `.context-bar`'s CONTENT box, while `element.clientWidth` also
    // counts the strip's own `padding: 4px` — 8px of phantom track. Sizing the geometry from
    // the wrapper squashed every bar by that ratio and drifted the pointer mapping (the canvas
    // hit test measures `canvas.getBoundingClientRect()`, i.e. the content box), and it stays
    // wrong for a host with no `ResizeObserver` to correct it. The observer path already reports
    // the content box, so this only makes the pre-observer and observer-less paths agree with it.
    const surfaceWidth = (): number =>
        (mode === 'canvas' ? canvas.clientWidth : rowStack.clientWidth) || element.clientWidth || 0;

    const resolveWidth = (): number => {
        if (width > 0) return width;

        const measured = surfaceWidth();
        if (measured > 0) return measured;
        if (options.width !== undefined && options.width > 0) return options.width;

        return CONTEXT_BAR_FALLBACK_WIDTH;
    };

    // The vertical band (R27), resolved whenever the bar is (re)laid out and then CACHED:
    // `recompute` also runs on a pointer event to re-aim the geometry, and a hit test must not
    // pay for a style read. A font or theme change reaches the bar as a resize (a browser zoom
    // changes the laid-out width too, whenever the host is width-relative), and every resize path
    // goes through `apply`, which re-resolves. A zoom inside a FIXED-PIXEL host moves only
    // `devicePixelRatio`, which `paint()` re-reads on any repaint but nothing forces on its own —
    // a stated limit, and it costs resolution only: 2 line-heights stay 2 line-heights in CSS
    // pixels at every ratio, because the ratio scales the backing store alone.
    let heights = resolveContextBarTrackHeights(element);

    const recompute = (): void => {
        layout = layoutContextBar(model?.blocks ?? [], resolveWidth(), {
            ...(options.gapPx === undefined ? {} : { gapPx: options.gapPx }),
            ...(options.minSegmentPx === undefined ? {} : { minSegmentPx: options.minSegmentPx }),
            lineHeightPx: options.lineHeightPx ?? heights.lineHeightPx,
            maxHeightPx: options.maxHeightPx ?? heights.maxHeightPx,
            minSegmentHeightPx: options.minSegmentHeightPx ?? heights.minSegmentHeightPx
        });
    };

    // --- painting (canvas mode) -------------------------------------------

    const paint = (): void => {
        if (mode !== 'canvas' || context === null || destroyed) return;

        const tracks = layout;
        // The bar's box is the TALLEST bar in the strip (at most two line-heights) — and with
        // lanes (C2) the SUM of every row's box plus the seams between them, which is exactly
        // what the DOM row stack occupies. One canvas therefore reserves the same rectangle as
        // the flex rows, and the reader can compare bar bottoms across both modes. An empty bar
        // keeps the base box (the dashed "nothing recorded" affordance), which `layout.heightPx`
        // already says.
        const height = Math.max(1, tracks.heightPx);
        const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;

        // Backing store at device scale, coordinates in CSS pixels: one line of setup per
        // repaint, so a resize or a DPR change (a zoom) needs no extra bookkeeping.
        canvas.width = Math.max(1, Math.round(tracks.width * ratio));
        canvas.height = Math.max(1, Math.round(height * ratio));
        canvas.style.height = `${height}px`;

        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, tracks.width, height);
        context.globalAlpha = 1;

        const computed =
            typeof getComputedStyle === 'function' ? getComputedStyle(document.documentElement) : (undefined as unknown as CSSStyleDeclaration);
        // One style read per repaint, not per segment: a 3,000-segment turn costs one
        // layout read, not three thousand.
        const colorOf = (tone: ReturnType<typeof contextBarToneOf>): string =>
            computed === undefined ? CONTEXT_BAR_TONE_STYLES[tone].color : toneColorOf(tone, computed);

        for (const segment of tracks.segments) {
            const tone = contextBarToneOf(segment.block);
            // R7 (T4a): ONE figure decides this segment's transparency — the model's
            // `contextBarSegmentAlphaOf`, which is 0.2 when the block is out of the context the
            // model is sent and the tone's own alpha otherwise (1, or 0.45 unsettled). The DOM
            // mode gets the identical number from `.context-bar-segment[data-included='false']`;
            // both come from `CONTEXT_BAR_EXCLUDED_ALPHA`, so they cannot drift (T27/R28).
            const alpha = contextBarSegmentAlphaOf(segment.block);
            // The dim also has to reach the NAME in this mode: in DOM mode the label is a CHILD of
            // the dimmed button, so CSS opacity fades it automatically, and a full-alpha label
            // over a 0.2 bar would be the one place the two renderers disagreed. Every other tone
            // keeps its label at full alpha exactly as before, so the running tone's 0.45 bar is
            // untouched (this is the dim state, not a tone change).
            const labelAlpha = contextBlockIsExcluded(segment.block) ? alpha : 1;
            // C2: the band this segment's ROW occupies inside the (possibly taller) canvas.
            // One row means offset 0 and the whole canvas height, so every rectangle below is
            // the one this painter drew before lanes existed; the guard is only for a
            // hand-built layout with no `rows`.
            const band = tracks.rows[segment.row] ?? { offsetY: 0, heightPx: height };

            // BOTTOM-ALIGNED (R27): every bar sits on its ROW's floor, so "less context"
            // reads as a shorter bar against one shared baseline per lane instead of a
            // floating block. Each lane owns its own baseline because each lane is its own
            // graph — that is what makes a second row read as a second row.
            const barHeight = Math.max(1, Math.min(segment.heightPx, band.heightPx));
            const top = band.offsetY + band.heightPx - barHeight;

            context.globalAlpha = alpha;
            context.fillStyle = colorOf(tone);
            context.fillRect(segment.x, top, segment.width, barHeight);
            context.globalAlpha = 1;

            // The name, but only where it fits BOTH ways (a documented approximation of an
            // 11px monospace cell, chosen so no text-measurement API is required): wide enough
            // for the glyphs, and one line-height tall enough to hold the line of text.
            if (
                segment.width >= CONTEXT_BAR_LABEL_MIN_PX &&
                segment.heightPx >= tracks.lineHeightPx * CONTEXT_BAR_LABEL_MIN_LINES &&
                segment.block.name.length * 7 + 12 <= segment.width
            ) {
                // The label is painted in the track colour: the segment IS the background,
                // so one constant stays readable on every tone.
                context.globalAlpha = labelAlpha;
                context.fillStyle = CONTEXT_BAR_ON_SEGMENT_TEXT;
                context.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
                context.textBaseline = 'middle';
                context.fillText(segment.block.name, segment.x + 6, top + barHeight / 2);
                context.globalAlpha = 1;
            }

            // Focus and hover share one highlight, so the keyboard and the pointer cannot
            // disagree about which segment is "the current one". The ring hugs the PAINTED
            // bar, which is the thing the reader is looking at.
            if (segment.index === focused) {
                context.strokeStyle = colorOf('neutral');
                context.lineWidth = 2;
                context.strokeRect(segment.x + 1, top + 1, Math.max(1, segment.width - 2), Math.max(1, barHeight - 2));
            }
        }
    };

    // --- accessible text ---------------------------------------------------

    /**
     * The per-row lane cue (C2): `L0` / `L1` / ... one chip per row, positioned into that row's
     * band, identical in both renderers.
     *
     * The rule is the one the brief locks: show it only when the reader could genuinely
     * misread the picture — more than one row, or a bar whose only lane is not lane 0. A
     * single-lane bar therefore mints no chip at all, which is also what keeps its DOM byte for
     * byte what it was. The chips are DOM text, so canvas mode gets the cue AND the
     * screen-reader announcement from the same nodes the DOM mode paints — no second painter
     * path, and nothing a reader cannot select or a theme cannot restyle.
     */
    const applyLaneTags = (): void => {
        const show = model !== undefined && contextBarShowsLaneTagsOf(layout.lanes);

        laneTags.hidden = !show;

        if (!show) {
            laneTags.replaceChildren();

            return;
        }

        const nodes: Element[] = [];

        for (const row of layout.rows) {
            const tag = document.createElement('span');
            tag.className = 'context-bar-lane';
            tag.dataset.lane = String(row.lane);
            tag.dataset.row = String(row.row);
            // Inline positioning only: the overlay is aligned to the top of the track area, so
            // these two numbers ARE the row's band, in the same CSS pixels both modes paint in.
            tag.style.top = `${Math.round(row.offsetY)}px`;
            tag.style.height = `${Math.round(row.heightPx)}px`;
            // The visible string is the short tag; the accessible name spells the same fact in
            // words, so a reader never has to expand `L1` and the tag is never the only place
            // the lane is stated.
            tag.setAttribute('aria-label', contextBarLaneLabelOf(row.lane));
            tag.textContent = contextBarLaneTagOf(row.lane);
            nodes.push(tag);
        }

        laneTags.replaceChildren(...nodes);
    };

    const applyLabels = (): void => {
        // TWO strings, two audiences (T16, R16b):
        //   - `summary` is the ACCESSIBLE name: label phrase + figures, so a screen reader
        //     still hears what the strip is even though the phrase is no longer printed;
        //   - `stats` is the VISIBLE line under the track: the segment COUNT, nothing else
        //     (T22, R24 — the character totals moved into `aria-label` alone, so losing the
        //     printed line never loses the figure). `styles.css` right-aligns it, which is
        //     where the reader's eye already is after reading the bar left to right.
        // `contextBarAccessibleNameOf` is the model's summary with ONE clause re-worded: the
        // aggregate thinking count, which the projector marks per KIND and a policy then
        // decides (F8/H5). The visible line never carried that clause, so it is untouched.
        const summary = model === undefined ? CONTEXT_BAR_LABEL : contextBarAccessibleNameOf(model);
        const stats = model === undefined ? '' : contextBarStatsOf(model);

        element.setAttribute('aria-label', summary);
        element.dataset.segments = String(model?.blocks.length ?? 0);
        element.dataset.chars = String(model?.totalChars ?? 0);
        element.dataset.gapPx = String(layout.gapPx);
        element.dataset.minSegmentPx = String(Math.round(layout.minSegmentPx * 100) / 100);
        element.dataset.width = String(Math.round(layout.width));
        // T26 (R27): the vertical axis and its scale, readable without a layout pass — the
        // strip's own box, the two-line ceiling it was capped to, the line-height that ceiling
        // was counted from, the shortest bar, the strip's height denominator, and how many
        // segments had no recorded span at all.
        element.dataset.heightPx = String(Math.round(layout.heightPx));
        element.dataset.maxHeightPx = String(Math.round(layout.maxHeightPx));
        element.dataset.lineHeightPx = String(Math.round(layout.lineHeightPx * 100) / 100);
        element.dataset.minHeightPx = String(Math.round(layout.minSegmentHeightPx));
        element.dataset.maxChars = String(layout.maxChars);
        element.dataset.unknownDurations = String(layout.durationsUnknown);
        element.dataset.totalDurationMs = layout.totalDurationMs === undefined ? '' : String(Math.round(layout.totalDurationMs));
        // C2: how many LANES this bar stacks and whether it labels them, readable without a
        // layout pass. `data-row-offsets` is every row's band origin, topmost first, so a test
        // (or a host) can prove the rows are where the model says they are.
        element.dataset.lanes = String(layout.lanes.length);
        element.dataset.laneTags = contextBarShowsLaneTagsOf(layout.lanes) ? 'true' : 'false';
        element.dataset.rowOffsets = layout.rows.map((row) => String(row.offsetY)).join(',');
        element.dataset.empty = model !== undefined && model.available && model.blocks.length === 0 ? 'true' : 'false';
        caption.textContent = stats;

        // The lane tags (C2), rebuilt with every repaint and in BOTH modes: one chip per row,
        // inline-positioned into that row's band so nothing about the track's geometry changes.
        // They exist only when the reader could otherwise read one row of a stacked bar as an
        // ordinary one-row strip.
        applyLaneTags();

        if (model === undefined) {
            // Nothing to show: the live region, the hover and the painted track all go
            // empty together, so a cleared bar cannot keep the previous turn's picture.
            live.textContent = '';
            element.removeAttribute('title');
            if (mode === 'canvas') paint();

            return;
        }

        if (mode === 'canvas') {
            // Bounded option list: below the limit every segment is enumerable by a screen
            // reader in browse mode; above it the live region is the contract (and the
            // caption states how many segments there are).
            const nodes: Element[] = [];

            if (model.blocks.length <= CONTEXT_BAR_OPTION_LIMIT) {
                for (const segment of layout.segments) {
                    const option = document.createElement('span');
                    option.className = 'context-bar-option';
                    option.dataset.index = String(segment.index);
                    option.textContent = contextBarSegmentLabelOf(segment.block, segment.index, model.blocks.length);
                    nodes.push(option);
                }
            }

            optionsList.replaceChildren(...nodes);
            paintFocused();
        }
    };

    /** The single place focus moves: index + the id that keeps it attached across a rebuild. */
    const rememberFocus = (index: number): void => {
        focused = index;
        focusedBlockId = index >= 0 ? (model?.blocks[index]?.id ?? undefined) : undefined;
    };

    /** Repaint the one piece of state that is not data: which segment is current. */
    const paintFocused = (): void => {
        if (mode === 'dom') {
            // Roving tabindex. Before the reader has aimed at anything, the FIRST segment is
            // the tab stop — an all-`-1` bar would be unreachable by keyboard, which is the
            // failure mode this widget's whole accessible design exists to avoid. `data-focused`
            // stays false until something really is current, so "reachable" and "current"
            // remain different facts.
            //
            // C2: "first" means first IN TAB ORDER, i.e. the first segment of the topmost row —
            // `layout.segments[0]`, which the model already put in row order. For a one-lane bar
            // that is index 0, exactly as before.
            const tabStop = focused >= 0 ? focused : (layout.segments[0]?.index ?? 0);

            for (const button of Array.from(rowStack.querySelectorAll<HTMLButtonElement>('.context-bar-segment'))) {
                const index = Number(button.dataset.index);
                const current = index === focused;
                button.tabIndex = index === tabStop ? 0 : -1;
                button.dataset.focused = current ? 'true' : 'false';
            }

            return;
        }

        const total = model?.blocks.length ?? 0;
        const block = focused >= 0 && focused < total ? model?.blocks[focused] : undefined;

        live.textContent = block === undefined ? '' : contextBarSegmentLabelOf(block, focused, total);
        element.title = block === undefined ? '' : contextBarSegmentTitleOf(block);

        paint();
    };

    // --- DOM mode build ----------------------------------------------------

    /**
     * DOM mode: ONE `.context-bar-segments` flex row per lane (C2), stacked by
     * `.context-bar-rows`.
     *
     * Each row is an INDEPENDENT graph, exactly like the canvas' band for that row: it gets its
     * own inline height (`row.heightPx` — its tallest bar, not the whole stack's) and its own
     * rendered gap (`row.gapPx` — the gap THIS row could afford). Nothing about a segment's own
     * box changes: the buttons, their `data-*` vocabulary, their flex weights and their inline
     * heights are the ones the flat strip minted, and for a bar with one lane the row wrapper is
     * the only difference at all.
     */
    const buildDomSegments = (): void => {
        const blocks = model?.blocks ?? [];
        const withLabels = blocks.length <= CONTEXT_BAR_DOM_LABEL_LIMIT;
        const showLanes = model !== undefined && contextBarShowsLaneTagsOf(layout.lanes);
        const nodes: Element[] = [];
        // The keyboard's entry point: the first segment of the TOP row, in the model's row order
        // (`layout.segments` is row-grouped). Index 0 for a one-lane bar, exactly as before.
        const tabEntry = focused >= 0 ? focused : (layout.segments[0]?.index ?? 0);

        for (const row of layout.rows) {
            const rowElement = document.createElement('div');

            rowElement.className = 'context-bar-segments';
            // Which band this element IS: the click fallback reads `data-row` to aim inside the
            // right row, and a test can pin the stack without measuring anything.
            rowElement.dataset.row = String(row.row);
            rowElement.dataset.lane = String(row.lane);

            // A11y (C2): once there is more than one row to tell apart, each row announces its
            // lane as the group it is. A single-row bar gets NO role and NO label — it is
            // labelled by the bar itself, and adding a nested group there would change the
            // accessibility tree of every bar the board has ever drawn.
            if (showLanes) {
                rowElement.setAttribute('role', 'group');
                rowElement.setAttribute('aria-label', contextBarLaneLabelOf(row.lane));
            }

            // The row is the SAME box its own canvas band sized itself to, and `styles.css`
            // gives it `align-items: flex-end` so every bar sits on THAT ROW's bottom edge
            // exactly where the painter puts it (R28).
            rowElement.style.height = row.heightPx > 0 ? `${Math.round(row.heightPx)}px` : '';

            // RENDERED gap = the gap THIS row's geometry was divided by (T27 parity check). The
            // stylesheet ships `gap: 2px`, which is `CONTEXT_BAR_GAP_PX` and therefore correct
            // for a short strip; but `layoutContextBar` SHRINKS the gap when hundreds of segments
            // cannot afford it (300 bars in a 600px track drop to 1px, 600 bars to 0), and the
            // canvas paints the shrunk gaps. With a fixed 2px the flex row pays 299px of phantom
            // space at n=300: every bar clamps to its 1px `min-width`, the row overflows its
            // `overflow: hidden` box, and the last third of the strip disappears — while
            // `nearestIndex` still aims at columns the model placed with the shrunk gap. Pinning
            // the inline value keeps both renderers on one arithmetic (R28) and leaves the CSS
            // default in charge for an unscripted host.
            rowElement.style.gap = `${row.gapPx}px`;

            const buttons: Element[] = [];

            for (const segment of row.segments) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'context-bar-segment';
                button.dataset.index = String(segment.index);
                button.dataset.blockId = segment.block.id;
                button.dataset.sectionId = segment.block.sectionId;
                button.dataset.kind = segment.block.kind;
                button.dataset.tone = contextBarToneOf(segment.block);
                button.dataset.state = segment.block.state ?? '';
                // R7 (T4a): the DIM state, as a HOOK rather than a colour. Tri-state, spelled the
                // way `data-state` above spells its absence: `''` means "no transcript entry
                // behind this segment / unknown" and takes NO styling, `'true'` is the server
                // naming the inclusion, `'false'` is the only value `styles.css` dims
                // (`[data-included='false'] { opacity: 0.2 }`, the same figure
                // `CONTEXT_BAR_EXCLUDED_ALPHA` paints in canvas mode).
                //
                // TRANSPARENCY ONLY, deliberately: nothing here is a `disabled` attribute, a
                // `hidden` attribute, a `pointer-events` rule or a tabindex change, so a dimmed
                // segment keeps its click, its Enter/Space, its place in the roving tab order and
                // its hover/focus ring — the reader can still open the detail of a block the model
                // is no longer being sent, which is the whole point of showing it faded rather
                // than gone.
                button.dataset.included = segment.block.included === undefined ? '' : String(segment.block.included);
                button.dataset.chars = String(segment.chars);
                button.dataset.durationMs = contextDurationAttr(segment.block);
                // R27: which axis is which, per segment. `durationKnown='false'` is the strip's
                // way of saying "this width is the honest baseline, not a measurement", and the
                // height figures are what the bar was actually seated at.
                button.dataset.durationKnown = segment.durationKnown ? 'true' : 'false';
                button.dataset.heightPx = String(segment.heightPx);
                button.dataset.heightShare = String(Math.round(segment.heightShare * 10_000) / 10_000);
                button.setAttribute('aria-label', contextBarSegmentLabelOf(segment.block, segment.index, blocks.length));
                button.title = contextBarSegmentTitleOf(segment.block);
                // The flex weight carries the layout's WIDTH share and the inline style carries
                // its HEIGHT, so both modes are sized by one arithmetic (R28).
                button.style.flexGrow = String(Math.max(1, Math.round(segment.share * 10_000)));
                button.style.flexBasis = '0%';
                button.style.height = `${segment.heightPx}px`;
                // Same roving rule as `paintFocused`: the FIRST segment in tab order is the Tab
                // entry until the reader aims somewhere specific.
                button.tabIndex = segment.index === tabEntry ? 0 : -1;
                button.dataset.focused = segment.index === focused ? 'true' : 'false';

                // The same minting rule the canvas applies (R28): wide enough for the glyphs AND
                // at least one line-height tall. A 6px bar has no room for an 18px line of text in
                // either renderer, so a segment is labelled in one mode exactly when it is in the
                // other. `layout.lineHeightPx` is bar-wide on purpose: two line-heights are the
                // same two lines in every row.
                const labelFits =
                    segment.width >= CONTEXT_BAR_LABEL_MIN_PX &&
                    segment.heightPx >= layout.lineHeightPx * CONTEXT_BAR_LABEL_MIN_LINES;

                if (withLabels && labelFits) {
                    const label = document.createElement('span');
                    label.className = 'context-bar-segment-name';
                    label.textContent = segment.block.name;
                    button.append(label);
                }

                buttons.push(button);
            }

            rowElement.append(...buttons);
            nodes.push(rowElement);
        }

        rowStack.replaceChildren(...nodes);
    };

    const apply = (): void => {
        // Every state change (and every resize, which lands here too) re-reads the host's
        // vertical scale, so a font or zoom change moves both axes together.
        heights = resolveContextBarTrackHeights(element);
        recompute();

        if (mode === 'dom') buildDomSegments();

        applyLabels();
    };

    // --- interaction -------------------------------------------------------

    const activateIndex = (index: number, source: 'pointer' | 'keyboard'): void => {
        const blocks = model?.blocks ?? [];
        if (index < 0 || index >= blocks.length) return;

        rememberFocus(index);
        paintFocused();
        activate?.({ block: blocks[index], index, total: blocks.length, source });
    };

    /**
     * The segment a pointer is on — including WHICH ROW it is on (C2). `y` is a CSS-pixel
     * offset from the top of the track area; omitting it asks for the top of the bar, i.e. the
     * only row a one-lane strip has.
     */
    const nearestIndex = (x: number, y = 0): number => {
        recompute();

        return contextBarSegmentAt(layout, x, y);
    };

    /**
     * Aim inside ONE named row (C2, DOM mode). The row element under the pointer knows which
     * band it is, so the hit test runs at that band's MIDDLE — the row's full height is the aim
     * target, never just the painted bars, which is the R27 column policy taken across rows.
     * A row the model no longer has (a resize rebuilt the layout meanwhile) is no error: the
     * pointer still gets the row the bar's own y says it is on.
     */
    const nearestIndexInRow = (x: number, rowIndex: number): number => {
        recompute();

        const row = layout.rows[rowIndex];

        return row === undefined ? contextBarSegmentAt(layout, x) : contextBarSegmentAt(layout, x, row.offsetY + row.heightPx / 2);
    };

    /**
     * Pointer position relative to the painted track — both axes, canvas and DOM sharing one
     * origin (C2 needs the second axis because the rows are stacked inside one surface). The
     * canvas' box in canvas mode and the row stack's box in DOM mode are each the box the
     * model's pixels were computed for, so `x` and `y` mean the same thing to
     * `contextBarSegmentAt` whichever mode this host got.
     */
    const localPoint = (event: MouseEvent): { x: number; y: number } => {
        const box = mode === 'canvas' ? canvas.getBoundingClientRect() : rowStack.getBoundingClientRect();

        // A detached/unlaid-out host reports an all-zero rect; treating the event's own
        // coordinates as the offsets keeps the bar usable there instead of pinning every hit to
        // the top-left corner of an unlaid-out box.
        return {
            x: box.width === 0 ? event.clientX : event.clientX - box.left,
            y: box.height === 0 ? event.clientY : event.clientY - box.top
        };
    };

    const onPointerMove = (event: MouseEvent): void => {
        const point = localPoint(event);
        const index = nearestIndex(point.x, point.y);
        if (index < 0 || index === focused) return;

        rememberFocus(index);
        paintFocused();
    };

    const onPointerLeave = (): void => {
        // The pointer leaving does not move the keyboard's place, it only stops claiming
        // a hover. The title goes with the hover.
        if (mode === 'canvas') element.removeAttribute('title');
    };

    const onClick = (event: MouseEvent): void => {
        const point = localPoint(event);

        activateIndex(nearestIndex(point.x, point.y), 'pointer');
    };

    const onKeyDown = (event: KeyboardEvent): void => {
        const total = model?.blocks.length ?? 0;
        if (total === 0) return;

        // C2: the traversal order is the MODEL's row order (`layout.segments` is row-grouped:
        // all of row 0, then all of row 1), so the arrows walk a stacked bar the way the reader
        // sees it instead of jumping between rows when the lanes interleave. For a one-lane bar
        // this sequence is exactly `0, 1, 2, ... total - 1`, which is the arithmetic this handler
        // performed before lanes existed.
        const sequence = layout.segments.map((segment) => segment.index);

        const key = event.key;

        if (key === 'ArrowRight' || key === 'ArrowLeft' || key === 'Home' || key === 'End') {
            event.preventDefault();

            // `indexOf` is -1 while nothing is current, which is the same "aim at the first
            // segment" answer the old `focused < 0` branch gave.
            const position = sequence.indexOf(focused);
            const next =
                key === 'Home'
                    ? sequence[0]
                    : key === 'End'
                      ? sequence[sequence.length - 1]
                      : position < 0
                        ? sequence[0]
                        : sequence[Math.min(sequence.length - 1, Math.max(0, position + (key === 'ArrowRight' ? 1 : -1)))];

            rememberFocus(next);
            paintFocused();

            if (mode === 'dom') rowStack.querySelectorAll<HTMLButtonElement>(`.context-bar-segment[data-index="${next}"]`)[0]?.focus();

            return;
        }

        if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
            // ONE activation per press. A real browser turns Enter/Space on a focused button
            // into a click; `preventDefault` stops that second path, so DOM mode and canvas
            // mode fire the same single callback (the tool chip solves it the same way,
            // ./tools.ts:857).
            event.preventDefault();
            activateIndex(focused < 0 ? sequence[0] : focused, 'keyboard');
        }
    };

    const onSegmentClick = (event: MouseEvent): void => {
        const button = (event.target as Element | null)?.closest?.('.context-bar-segment') as HTMLElement | null;

        if (button === null) {
            // T26 (R28) parity, and the documented answer for the blank area: the strip's aim
            // target is the COLUMN, not the painted pixels. A click above a short bar, or in a
            // gap between flex items, belongs to the segment whose x-range it landed in — the
            // exact rule the canvas hit test applies. A miss past the last column stays a miss
            // (`activateIndex` ignores an index of -1).
            //
            // C2 adds the other axis: the ROW element the click landed in says which band it is
            // on, which is both exact and layout-independent (a jsdom host reports no rects at
            // all). A click that hit the row STACK itself — the seam between two rows — carries
            // no row of its own, so the pointer's own y decides, by `contextBarRowAt`'s
            // nearest-band rule.
            const rowElement = (event.target as Element | null)?.closest?.('.context-bar-segments') as HTMLElement | null;
            const rowIndex = rowElement === null ? -1 : Number(rowElement.dataset.row ?? '-1');
            const point = localPoint(event);

            activateIndex(
                rowIndex >= 0 && Number.isFinite(rowIndex)
                    ? nearestIndexInRow(point.x, rowIndex)
                    : nearestIndex(point.x, point.y),
                'pointer'
            );

            return;
        }

        const index = Number(button.dataset.index ?? '-1');
        if (mode === 'dom') rememberFocus(index);
        activateIndex(index, 'pointer');
    };

    const onSegmentFocus = (event: FocusEvent): void => {
        const button = (event.target as Element | null)?.closest?.('.context-bar-segment') as HTMLElement | null;
        if (button === null) return;

        const index = Number(button.dataset.index ?? '-1');
        if (index < 0 || index === focused) return;

        rememberFocus(index);
        paintFocused();
    };

    if (mode === 'canvas') {
        canvas.addEventListener('pointermove', onPointerMove);
        canvas.addEventListener('mousemove', onPointerMove);
        canvas.addEventListener('pointerleave', onPointerLeave);
        canvas.addEventListener('click', onClick);
        element.addEventListener('keydown', onKeyDown);
    } else {
        // One set of listeners for the WHOLE stack: events bubble from every row, and the
        // handlers resolve the row from the element the event actually landed on (C2).
        rowStack.addEventListener('click', onSegmentClick);
        rowStack.addEventListener('focusin', onSegmentFocus);
        // Keyboard on a button: jsdom does not translate Enter/Space into a click, a real
        // browser does. `activateIndex` is idempotent, so a doubled activation is one call.
        rowStack.addEventListener('keydown', onKeyDown);
    }

    // Repaint on a real width change. `ResizeObserver` is the cheap path (it fires for the
    // element, not for every window event); the window listener is the fallback for a host
    // without one, and it only re-aims when the measured width actually moved.
    let observer: ResizeObserver | undefined;
    let onWindowResize: (() => void) | undefined;

    if (typeof ResizeObserver === 'function') {
        observer = new ResizeObserver((entries) => {
            const box = entries[0]?.contentRect;
            if (box === undefined || destroyed) return;
            if (Math.round(box.width) === Math.round(layout.width)) return;

            width = box.width;
            apply();
        });
        observer.observe(element);
    } else if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        onWindowResize = (): void => {
            if (destroyed) return;

            // Same origin as `resolveWidth`: the painted surface, not the padded wrapper.
            const measured = surfaceWidth();
            if (measured <= 0 || Math.round(measured) === Math.round(layout.width)) return;

            width = measured;
            apply();
        };
        window.addEventListener('resize', onWindowResize);
    }

    apply();

    return {
        element,
        mode: () => mode,
        setModel: (next: ContextBarModel) => {
            if (destroyed) return;
            model = next;

            // Focus follows the BLOCK, not the slot. A live turn appends segments, and a
            // discarded attempt removes some: an index-based focus would hand the reader a
            // different call than the one they were on, and a focus past the end is no
            // focus at all.
            if (focusedBlockId !== undefined) {
                rememberFocus(next.blocks.findIndex((block) => block.id === focusedBlockId));
            } else if (focused >= next.blocks.length) {
                rememberFocus(next.blocks.length - 1);
            }

            apply();
        },
        setWidth: (next: number) => {
            if (destroyed || !Number.isFinite(next) || next <= 0) return;
            width = next;
            apply();
        },
        setActivate: (next) => {
            activate = next;
        },
        layout: () => layout,
        focused: () => focused,
        setFocused: (index: number) => {
            const total = model?.blocks.length ?? 0;

            rememberFocus(index >= 0 && index < total ? index : -1);
            paintFocused();
        },
        clear: () => {
            model = undefined;
            rememberFocus(-1);
            apply();
        },
        destroy: () => {
            if (destroyed) return;
            destroyed = true;

            observer?.disconnect();
            if (onWindowResize !== undefined && typeof window !== 'undefined') window.removeEventListener('resize', onWindowResize);

            if (mode === 'canvas') {
                canvas.removeEventListener('pointermove', onPointerMove);
                canvas.removeEventListener('mousemove', onPointerMove);
                canvas.removeEventListener('pointerleave', onPointerLeave);
                canvas.removeEventListener('click', onClick);
                element.removeEventListener('keydown', onKeyDown);
            } else {
                rowStack.removeEventListener('click', onSegmentClick);
                rowStack.removeEventListener('focusin', onSegmentFocus);
                rowStack.removeEventListener('keydown', onKeyDown);
            }

            optionsList.replaceChildren();
            rowStack.replaceChildren();
            laneTags.replaceChildren();
            caption.textContent = '';

            // A destroyed bar describes NOTHING: its geometry goes with its listeners, so a
            // caller that still holds the layout (a resize race, a late assertion) cannot read
            // a stale strip off a widget that is no longer painted.
            model = undefined;
            rememberFocus(-1);
            recompute();
        }
    };
};

// `durationMs` as a DOM attribute: the exact server span when it has one, '' when the
// record cannot say. A test (and a future filter) can read it without re-deriving it.
const contextDurationAttr = (block: ContextBlock): string => {
    const measured = (block as ContextBlock & { durationMs?: unknown }).durationMs;
    if (typeof measured === 'number' && Number.isFinite(measured)) return String(Math.round(measured));

    const span = block.at !== undefined && block.endedAt !== undefined ? block.endedAt - block.at : undefined;

    return span === undefined || !Number.isFinite(span) || span < 0 ? '' : String(Math.round(span));
};

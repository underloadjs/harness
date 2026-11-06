// The ONE context bar's MODEL: what its segments are, how wide each one is, which tone
// it paints, and what its hover/accessible text says. Pure data in, pure data out — no
// DOM, no fetch, no timers — so every rule below is unit-testable and the renderer
// (`./ui/context-bar.ts`) stays a painter that adds no decisions of its own.
//
// WHAT THIS BAR IS (T11, R6/R7)
// -----------------------------
// One horizontal strip per user-delimited turn (one TILE), built by reading every
// section's `TurnSection.context` in `TurnDisplay.sections` order and concatenating the
// segments in their recorded order. It replaces the hundreds of visible tool chips the
// old board printed, because one strip answers the question the chip wall answered
// ("what made up this turn, in what proportion, and what failed") without one DOM node
// and one timer per call.
//
// This is a CHARACTER distribution, never a token figure. `ContextBlock.chars` is the
// exact UTF-16 length of recorded text (src/shared/turn-display.ts:353, invariant 5),
// and the provider's token numbers live on a different surface entirely
// (`TurnSummary.usage`/`latestInput`/`cachedInput`). Every label below therefore says
// "characters", and a `reasoning` block says plainly that the server marks it
// `inPrompt: false` — thinking was streamed, it was not replayed into the next request.
//
// RULES THIS MODULE OWNS
// ----------------------
//   1. ORDER is the server's: sections as the document lists them, blocks as the
//      section lists them. No sorting, no pairing, no re-derivation — the projector
//      already resolved identity and sequence (src/shared/turn-display.ts:334). The only
//      local decision is a defensive first-wins drop of a duplicated `sectionId|id`,
//      which the contract says cannot happen.
//   2. TWO DIMENSIONS (T26, R27), one strip:
//        - HORIZONTAL — segment WIDTH is the RECORDED TIME TAKEN (`ContextBlock.durationMs`,
//          else `endedAt - at`), laid out SEQUENTIALLY (segment after segment, never an
//          absolute overlapping timeline). A block the record never bracketed gets the
//          honest BASELINE width (`CONTEXT_BAR_UNKNOWN_DURATION_PX`, the same figure as the
//          pointer floor, so "not measured" visibly reads as a floor and not as a
//          measurement), and its label says `time not recorded` out loud. A 0ms span is a
//          real measurement and shares the floor path with zero-weight data; nothing is ever
//          invented.
//        - VERTICAL — each bar's HEIGHT is the CONTEXT SIZE (`chars`, the exact recorded
//          characters), NORMALIZED to the largest `chars` figure in the SAME strip and
//          clamped to a legible band: at least `CONTEXT_BAR_MIN_SEGMENT_HEIGHT_PX`, at most
//          `CONTEXT_BAR_MAX_TRACK_HEIGHT_PX` = TWO line-heights. Normalizing per strip is
//          what keeps a delegated thread's own strip readable beside a caller's strip that
//          happens to hold a 40,000-character result.
//      Both axes carry an honest DISPLAY FLOOR (a segment is never thinner than
//      `CONTEXT_BAR_MIN_SEGMENT_PX` while that still fits), so a 40-character tool call
//      stays clickable beside a 40,000-character result. The floors are display rules, never
//      claims about the data: the tooltip and the accessible label always carry the true
//      figures, and the accessible name says which axis is which.
//   3. TONE comes from `kind` + `state` ONLY (the server decides, the renderer colours):
//      a settled tool is green, a failed/cancelled tool red, a running tool faded green,
//      reasoning amber, and `user`/`system`/`assistant` neutral. No text is ever
//      classified here.
//   4. `TurnSection.context === undefined` means "this frame says nothing" (a pre-T9
//      record, a legacy view) and yields `available: false` — the caller then keeps the
//      old chip rendering instead of drawing an empty bar over real information. An
//      empty ARRAY is the server's authoritative "this section recorded no context",
//      which paints an empty bar and says so.
//   5. TAIL (T22/T23, R23): one section shows ONE content body at a time — its CURRENT
//      block, printed in full immediately after that section's strip. Whatever block it
//      is, it is the tail: the newest thinking window, the newest answer, or the newest
//      recorded CALL (its arguments while it runs, its complete result once it settles).
//      `contextTailOf` applies the server's designation (`TurnSection.tail`), so the
//      browser compiles nothing; a producer that sends none falls back to the recorded
//      order and prints no call body it was never given. `user` and `system` are the two
//      stated exceptions — the prompt already rides the row and instructions have no
//      surface here. Every EARLIER body is a bar segment the reader opens on click; it
//      renders no body, so a long run never leaves a pile of stale think chips (or call
//      payloads) under the strip. The rule lives here, not in the painter, so a live
//      frame, a rebuild and a cold reload agree by construction.
//   7. TAIL PREVIEW WINDOW (T26, R26): a CURRENT prose body is painted as its LATEST
//      SUFFIX, never its first lines. A thinking window that grows past the display bound
//      used to sit in a scroll box pinned at the top, so the reader watched a block of text
//      that never changed while the model kept writing. `contextTextSuffixOf` cuts the
//      rendered string at the SAME configured bound the display contract already publishes
//      (`DISPLAY_NODE_PREVIEW_CHARS`, ../shared/turn-display.ts:135 — no new arbitrary cap)
//      and keeps the END, so the visible text scrolls as it grows. Slicing is render-only
//      and Unicode-safe (no split code point, no orphan combining mark): the model, the
//      wire bytes, the segment's exact `chars` and the click-time detail dialog all still
//      hold the whole recorded block. A recorded CALL is the exception — its panes print the
//      complete recorded request/response (T25) and only follow the newest byte by scrolling.
//   6. CAPTION (T22/R24): the visible line under the strip is the segment COUNT only.
//      The character figures stay where they are useful — the tooltip, the accessible
//      name and the segment detail — because a count is the one number a reader can act
//      on without turning the strip into a statistics table.
//
// Cross-references:
//   - ../shared/turn-display.ts:373-530 — `ContextBlock`, `ContextBlockPatch`,
//                                          `TurnBlockDetail` (the frozen contract)
//   - ../shared/turn-display.ts `DisplayTail` + the `tail:set`/`tail:clear` ops — the
//                                          server's designation this module reads (R23)
//   - ../server/turn-projector.ts `resolveTail`/`syncTails` — the fold that decides it
//   - ./ui/context-bar.ts               — the canvas/DOM surface that paints this
//   - ./ui/context-detail.ts            — the click-time full-detail dialog (R8)
//   - ./ui/turns.ts                     — the tile that owns one bar per turn
//   - ./view-state.ts                   — the `context:*`/`tail:*` op reducer feeding the tree
//   - ./view-api.ts `getBlockDetail`    — the one lazy route a click costs

import type {
    ContextBlock,
    ContextBlockKind,
    DisplayNode,
    DisplayReasoningNode,
    DisplayStep,
    DisplayTail,
    DisplayTextNode,
    StepDisplayState,
    TurnDisplay,
    TurnSection
} from '../shared/turn-display';
// T26 (R26): the ONE configured bound a bounded prose body already uses, reused for the
// render-side preview window so no second arbitrary cap is invented (../shared/turn-display.ts:135).
import { DISPLAY_NODE_PREVIEW_CHARS } from '../shared/turn-display';
import { elapsedBetween, formatDuration } from './ui/time';

// ---------------------------------------------------------------------------
// Display constants (the numbers the stylesheet and the canvas must agree on)
// ---------------------------------------------------------------------------

// Visible separation between segments. A bar of a few segments reads as separate tiles;
// when `n` is large enough that this gap would eat the track, `layoutContextBar` shrinks
// it (never below 0) so every segment keeps at least one pixel.
export const CONTEXT_BAR_GAP_PX = 2;

// The honest minimum WIDTH: a segment this thin cannot be aimed at, and a label inside it is
// unreadable. 8px is the pointer target; the floor is only applied while the whole bar
// still fits (see rule 2 above).
export const CONTEXT_BAR_MIN_SEGMENT_PX = 8;

// T26 (R27): the width of a segment whose time taken the record never bracketed (a `user`
// prompt, a `system` instruction block, a one-event prose window). It deliberately EQUALS
// the display floor above, so an unmeasured block reads as "as thin as the thinnest thing
// the data can prove" rather than as a fabricated 0ms or an invented average. The label
// states it in words (`time not recorded`), which is what keeps the baseline honest.
export const CONTEXT_BAR_UNKNOWN_DURATION_PX = CONTEXT_BAR_MIN_SEGMENT_PX;

// One line-height of the bar's own label, in CSS pixels — the figure `styles.css` gives
// `.context-bar-segment-name` (`line-height: 18px`) and the height the strip reserved before
// T26. A host that themes the bar overrides it with `--context-bar-line-height`, which the
// painter reads (./ui/context-bar.ts `resolveTrackHeights`) so "2 line-heights" means two
// lines of THIS host's text rather than a hardcoded scale that breaks on a font change.
export const CONTEXT_BAR_LINE_HEIGHT_PX = 18;

// The maximum number of line-heights one bar may occupy (T26, R27: "maximum 2 line-heights").
export const CONTEXT_BAR_MAX_HEIGHT_LINES = 2;

// The tallest possible bar in CSS pixels: `CONTEXT_BAR_MAX_HEIGHT_LINES` line-heights. A
// custom property or a measured line-height replaces it at paint time; this is the fallback
// both modes share, and `styles.css` states the same 36px so a canvas-less host agrees.
export const CONTEXT_BAR_MAX_TRACK_HEIGHT_PX = CONTEXT_BAR_LINE_HEIGHT_PX * CONTEXT_BAR_MAX_HEIGHT_LINES;

// The shortest bar that still reads as a bar. A block with recorded characters always
// paints at least this much, so a 12-character call is visible beside a 40,000-character
// one instead of being a hairline the eye skips.
export const CONTEXT_BAR_MIN_SEGMENT_HEIGHT_PX = 3;

// The BASE strip height, in CSS pixels: what an empty strip reserves (the dashed "nothing
// recorded" box in `styles.css`) and the fallback a host with no themed line-height keeps for
// a strip with no characters. A strip WITH content is sized by `layout.heightPx` (T26), which
// both modes set inline, so this constant is the floor and the empty case only.
export const CONTEXT_BAR_TRACK_HEIGHT_PX = 18;

// A host that has not been laid out yet (a detached tile, a collapsed conversation, a
// jsdom test) reports no width. Rather than zero-width segments, the painter uses this
// width for its geometry and repaints the moment a real width arrives.
export const CONTEXT_BAR_FALLBACK_WIDTH = 640;

// Above this many segments the canvas mode stops materialising one accessible text node
// per segment (a 5,000-call turn would mint 5,000 hidden elements) and keeps only the
// live-region label of the segment under focus. Keyboard traversal is unaffected.
export const CONTEXT_BAR_OPTION_LIMIT = 600;

// The bar's stable ACCESSIBLE name: the sentence that explains its TWO axes (T26, R27).
// Since T22/R24 the VISIBLE line under the track is the segment count only, so this phrase
// exists for the reader who cannot see the picture — it names the unit (CHARACTERS, never
// tokens) and says which direction is TIME TAKEN and which is CONTEXT SIZE, which is exactly
// the pair a sighted reader reads off the shape. `contextBarSummaryOf` puts the figures behind
// it, and the segment tooltip repeats both figures per segment.
export const CONTEXT_BAR_LABEL = 'context bar: width is time taken, height is recorded characters';

// ---------------------------------------------------------------------------
// Tone: colour decided by the SERVER's kind/state, never by the text
// ---------------------------------------------------------------------------

export type ContextBarTone = 'ok' | 'error' | 'running' | 'reasoning' | 'neutral';

/**
 * `kind` + `state` -> tone. `tool` settles green (`ok`) or red (`error` / `cancelled`)
 * and stays faded-green while unsettled; `reasoning` is amber; everything the model
 * could not fail (prompt, instructions, answers) is neutral. An absent `state` on a tool
 * block is "not settled yet" (turn-display.ts:456), which is the running tone — never a
 * re-derivation from an error flag.
 */
export const contextBarToneOf = (block: ContextBlock): ContextBarTone => {
    if (block.kind === 'reasoning') return 'reasoning';
    if (block.kind !== 'tool') return 'neutral';

    switch (block.state) {
        case 'ok':
            return 'ok';
        case 'error':
        case 'cancelled':
            return 'error';
        default:
            return 'running';
    }
};

/** One palette entry per tone. The hex values are `styles.css` `:root` verbatim. */
export type ContextBarToneStyle = {
    /** Canvas fallback when the host's custom property cannot be resolved. */
    color: string;
    /** CSS variable the painter prefers, so a themed host repaints the bar for free. */
    cssVar: string;
    /** Running calls read as unfinished: the same green, visibly not settled. */
    alpha: number;
};

export const CONTEXT_BAR_TONE_STYLES: Readonly<Record<ContextBarTone, ContextBarToneStyle>> = {
    ok: { color: '#4ade80', cssVar: '--ok', alpha: 1 },
    error: { color: '#f87171', cssVar: '--danger', alpha: 1 },
    running: { color: '#4ade80', cssVar: '--ok', alpha: 0.45 },
    reasoning: { color: '#fbbf24', cssVar: '--warn', alpha: 1 },
    neutral: { color: '#d8deea', cssVar: '--text', alpha: 1 }
};

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** Per-kind figures. A count of segments and a sum of characters, both exact. */
export type ContextBarTally = Record<ContextBlockKind, number>;

export type ContextBarModel = {
    /** The turn this bar describes ('' when there is no tree at all). */
    turnId: string;
    /** False => NO section carried a `context` array: the caller keeps the chip wall. */
    available: boolean;
    /** Segments in display order: section order, then recorded order inside a section. */
    blocks: ContextBlock[];
    /** Sum of every segment's exact `chars` (a character total, not a token total). */
    totalChars: number;
    /** Characters of segments the server marks `inPrompt: false` (reasoning windows). */
    unpromptedChars: number;
    /** Segment count per kind. */
    counts: ContextBarTally;
    /** Exact character sum per kind. */
    charsByKind: ContextBarTally;
    /**
     * Sum of every segment's RECORDED span in ms, or undefined when NO segment has one
     * (T26, R27 — the horizontal axis' total). Never a guess: a turn whose blocks were all
     * unbracketed reports undefined, and the accessible name says so instead of printing
     * `0ms of recorded time`, which would read as an instantaneous turn.
     */
    totalDurationMs: number | undefined;
    /** How many segments have no recorded span and therefore paint at the baseline width. */
    durationsUnknown: number;
};

const emptyTally = (): ContextBarTally => ({
    user: 0,
    system: 0,
    reasoning: 0,
    assistant: 0,
    tool: 0
});

/**
 * Exact character count of one block, defensively read.
 *
 * The contract guarantees `chars` is present and exact (invariant 5), and for a tool it
 * is `argsChars + (resultChars ?? 0)`. Only a MALFORMED frame (a missing/NaN count) takes
 * the fallback, and the fallback is the other two EXACT server figures — never a
 * measurement of a possibly-truncated preview and never an estimate.
 */
export const contextBlockCharsOf = (block: ContextBlock): number => {
    const exact = block.chars;
    if (typeof exact === 'number' && Number.isFinite(exact) && exact >= 0) return Math.trunc(exact);

    const args = typeof block.argsChars === 'number' && Number.isFinite(block.argsChars) ? Math.max(0, Math.trunc(block.argsChars)) : 0;
    const result = typeof block.resultChars === 'number' && Number.isFinite(block.resultChars) ? Math.max(0, Math.trunc(block.resultChars)) : 0;

    return args + result;
};

/**
 * Recorded span of one block, in ms, or undefined when the record cannot say.
 *
 * Prefers the server's measured `durationMs` (the field `ContextBlock` gains alongside
 * `at`/`endedAt`), falls back to `endedAt - at`, and otherwise reports NOTHING — the same
 * "never invent a span" rule ./view-detail.ts applies to a step and ui/tools.ts applies
 * to a legacy record. A running call has no `endedAt`, so its label has no duration.
 */
export const contextBlockDurationOf = (block: ContextBlock): number | undefined => {
    // Read structurally so this module compiles against the contract with or without the
    // field (the projector stamps it while this worker's fixtures do not carry it).
    const measured = (block as ContextBlock & { durationMs?: unknown }).durationMs;
    if (typeof measured === 'number' && Number.isFinite(measured) && measured >= 0) return Math.round(measured);

    return elapsedBetween(block.at, block.endedAt);
};

/** True when this segment stands for a call that has not settled (spinner tone, no cache). */
export const contextBlockIsRunning = (block: ContextBlock): boolean =>
    block.kind === 'tool' && (block.state === undefined || block.state === 'running');

/** True when this segment's recorded text is complete: settled tool, or a prose block. */
export const contextBlockIsSettled = (block: ContextBlock): boolean => !contextBlockIsRunning(block);

/**
 * Flatten one turn's context into the bar's segment list.
 *
 * `display` is the compiled tree (`TurnDisplay`), undefined while a tile has no tree.
 * Nothing here is derived from `section.nodes`: the chips and the bar are two views of
 * DIFFERENT server figures, and pairing a step with a block locally is exactly the
 * compilation this wire exists to remove.
 */
export const contextBarOf = (display: TurnDisplay | undefined): ContextBarModel => {
    const blocks: ContextBlock[] = [];
    const counts = emptyTally();
    const charsByKind = emptyTally();
    let totalChars = 0;
    let unpromptedChars = 0;
    // T26 (R27): the horizontal axis' figures, folded in the same pass as the characters so
    // one traversal answers both dimensions. `knownDuration` stays false until a segment
    // actually reports a span, which is what keeps `totalDurationMs` undefined (rather than 0)
    // for a turn the record cannot bracket at all.
    let totalDurationMs = 0;
    let knownDuration = false;
    let durationsUnknown = 0;
    // "This frame says nothing" until a section actually carries an array.
    let available = false;
    // Defensive first-wins set: ids are unique within a turn by contract
    // (turn-display.ts:381), so a duplicate can only come from a malformed or
    // replayed frame, and showing the segment twice would double its characters.
    const seen = new Set<string>();

    for (const section of display?.sections ?? []) {
        const listed = (section as { context?: unknown }).context;
        if (!Array.isArray(listed)) continue;

        available = true;

        for (const block of listed as ContextBlock[]) {
            if (block === null || typeof block !== 'object') continue;

            const key = `${block.sectionId}|${block.id}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const chars = contextBlockCharsOf(block);

            blocks.push(block);
            counts[block.kind] += 1;
            charsByKind[block.kind] += chars;
            totalChars += chars;
            if (block.inPrompt !== true) unpromptedChars += chars;

            // The span the record supports for THIS segment (measured `durationMs`, else the
            // open/settle pair, else nothing) — see `contextBlockDurationOf`.
            const span = contextBlockDurationOf(block);
            if (span === undefined) durationsUnknown += 1;
            else {
                totalDurationMs += span;
                knownDuration = true;
            }
        }
    }

    return {
        turnId: display?.turnId ?? '',
        available,
        blocks,
        totalChars,
        unpromptedChars,
        counts,
        charsByKind,
        totalDurationMs: knownDuration ? totalDurationMs : undefined,
        durationsUnknown
    };
};

/**
 * True when the bar is the authoritative rendering for this turn: the server described
 * its context AND there is something to draw. Only then may the tile hide the per-step
 * tool chips, because only then does one strip carry the same information. A legacy tree
 * (`available: false`) and an authoritative empty bar both keep the chips: an empty bar
 * over hundreds of recorded calls would hide real information.
 */
export const contextBarReplacesChips = (model: ContextBarModel): boolean =>
    model.available && model.blocks.length > 0;

// ---------------------------------------------------------------------------
// Labels — the tooltip, the accessible name and the caption
// ---------------------------------------------------------------------------

// en-US grouping, pinned like ./ui/tokens.ts: tests assert `12,204`, never a
// locale-dependent `12.204`.
const charFormatter = new Intl.NumberFormat('en-US');

/** Exact, grouped character count ("12,204"). Never called "tokens". */
export const formatContextCharCount = (value: number): string =>
    charFormatter.format(Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0)));

/** The server's state word for a tool block, or '' when the block carries none. */
const stateWordOf = (block: ContextBlock): string =>
    block.kind === 'tool' && block.state !== undefined ? block.state : '';

/**
 * The full hover/accessible text of ONE segment: name, type, state, exact characters
 * (with the args+result split for a tool), time taken, and the honest note when the
 * server says the bytes were not replayed into the prompt.
 *
 * Every figure is printed from the metadata the server sent, so the bar and its tooltip
 * can never disagree, and neither one mentions a token.
 */
export const contextSegmentTitleOf = (block: ContextBlock): string => {
    const parts = [`${block.name} · ${block.kind}`];

    const state = stateWordOf(block);
    if (state.length > 0) parts.push(state);

    parts.push(`${formatContextCharCount(contextBlockCharsOf(block))} characters`);

    // The tool split is stated only when the server named the parts; a result-only or
    // args-only recording says exactly what it holds.
    if (block.kind === 'tool') {
        if (block.argsChars !== undefined && block.resultChars !== undefined)
            parts.push(`args ${formatContextCharCount(block.argsChars)} + result ${formatContextCharCount(block.resultChars)}`);
        else if (block.argsChars !== undefined)
            parts.push(`args ${formatContextCharCount(block.argsChars)}, no result recorded`);
        else if (block.resultChars !== undefined)
            parts.push(`result ${formatContextCharCount(block.resultChars)}`);
    }

    // T26 (R27): TIME is the horizontal axis, so a segment the record never bracketed states
    // that out loud rather than leaving a baseline-width bar to be read as a measurement. A
    // 0ms span IS a measurement and prints as one (`formatDuration(0)` -> `0ms`).
    const span = contextBlockDurationOf(block);
    parts.push(span === undefined ? 'time not recorded' : formatDuration(span));

    if (block.inPrompt !== true) parts.push('not replayed into the prompt');

    return parts.join(' · ');
};

/** Position + the full title: the label one segment carries in DOM mode and in focus. */
export const contextSegmentLabelOf = (block: ContextBlock, index: number, total: number): string =>
    `${index + 1} of ${total} · ${contextSegmentTitleOf(block)}`;

/**
 * The bar's VISIBLE caption: the segment COUNT, and nothing else (T22, R24).
 *
 * R16b already took the label sentence out of the visible line; R24 took the character
 * totals out too. A long session printed `12 segments · 52,781 characters · 3,432
 * characters not replayed into the prompt` under EVERY turn, and none of the three
 * numbers were things the reader acted on — the strip itself is the character
 * distribution, its tooltip states one segment's exact figures, and the token accounting
 * lives on the block header. What survives is the count, singular/plural spelled
 * correctly, still right-aligned by `styles.css`.
 *
 * Exact strings, pinned by ./view-context.test.ts:
 *   empty (authoritative)  `no recorded context`
 *   one segment            `1 segment`
 *   two or more            `12 segments`
 */
export const contextBarStatsOf = (model: ContextBarModel): string => {
    const count = model.blocks.length;
    if (count === 0) return 'no recorded context';

    return `${count} ${count === 1 ? 'segment' : 'segments'}`;
};

/**
 * The FULL figures — count, exact character total, the recorded TIME the strip spans, how
 * many segments have none, and the honest note when the server marks part of the strip
 * `inPrompt: false`. Not printed (R24); this is the text a screen reader hears inside
 * `contextBarSummaryOf`, so losing the visible line never loses the information — and since
 * T26 (R27) it is also where the strip's two axes are stated as numbers.
 *
 * Exact strings, pinned by ./view-context.test.ts:
 *   empty (authoritative)  `no recorded context`
 *   with segments          `4 segments · 1,300 characters · 2.6s of recorded time`
 *                          [+ ` · 2 segments have no recorded time`]
 *                          [+ ` · 300 characters not replayed into the prompt`]
 */
export const contextBarFiguresOf = (model: ContextBarModel): string => {
    if (model.blocks.length === 0) return 'no recorded context';

    const parts = [
        `${model.blocks.length} ${model.blocks.length === 1 ? 'segment' : 'segments'}`,
        `${formatContextCharCount(model.totalChars)} characters`
    ];

    // The horizontal axis, stated as a total — and `undefined` (NOT `0ms`) when the record
    // bracketed nothing at all, because "an instantaneous turn" is a different claim from
    // "a turn whose events carried no timestamps".
    if (model.totalDurationMs !== undefined) parts.push(`${formatDuration(model.totalDurationMs)} of recorded time`);

    // Which segments therefore paint at the honest baseline width (R27: explicitly labelled).
    if (model.durationsUnknown > 0)
        parts.push(
            `${model.durationsUnknown} ${model.durationsUnknown === 1 ? 'segment has' : 'segments have'} no recorded time`
        );

    if (model.unpromptedChars > 0)
        parts.push(`${formatContextCharCount(model.unpromptedChars)} characters not replayed into the prompt`);

    return parts.join(' · ');
};

/**
 * The bar's accessible name: the axis-explaining label phrase plus the FULL figures, so a
 * screen reader hears WHAT the strip is, which way each dimension runs, and how large it is
 * (the visible caption is only the count — R24), while a sighted reader never sees the phrase
 * twice.
 *
 * Exact strings, pinned by ./view-context.test.ts:
 *   empty (authoritative)  `context bar: width is time taken, height is recorded characters
 *                           · no recorded context`
 *   with segments          `context bar: width is time taken, height is recorded characters
 *                           · 4 segments · 1,300 characters · 2.6s of recorded time`
 *                          [+ ` · 300 characters not replayed into the prompt`]
 */
export const contextBarSummaryOf = (model: ContextBarModel): string =>
    `${CONTEXT_BAR_LABEL} · ${contextBarFiguresOf(model)}`;

// ---------------------------------------------------------------------------
// The render-side preview window (T26, R26): LATEST suffix, never first lines
// ---------------------------------------------------------------------------

/** "There is text before this." One character, and never counted as recorded content. */
export const CONTEXT_TEXT_ELLIPSIS = '…';

/**
 * How many characters of a prose body the pane paints. This is the SAME configured bound the
 * display contract already publishes for a bounded node (`DISPLAY_NODE_PREVIEW_CHARS`,
 * ../shared/turn-display.ts:135) — T26 reuses it deliberately instead of inventing a second
 * number, so the wire's own idea of "a preview" and the render's idea of one cannot drift.
 */
export const CONTEXT_TAIL_PREVIEW_CHARS = DISPLAY_NODE_PREVIEW_CHARS;

export type ContextTextSuffix = {
    /** The painted string: `…` + the latest `shown` characters when bounded, else the input verbatim. */
    text: string;
    /** EXACT characters of the source that survive in `text` (the marker is never counted). */
    shown: number;
    /** EXACT characters dropped from the FRONT of the source. */
    omitted: number;
    /** True exactly when `omitted > 0`. */
    bounded: boolean;
};

/** True when a UTF-16 unit cannot legally START a kept suffix: the tail of a split astral
 *  pair, a combining mark, a joiner, or a variation selector. */
const isClusterContinuation = (unit: number): boolean =>
    (unit >= 0x0300 && unit <= 0x036f) ||
    (unit >= 0x1ab0 && unit <= 0x1aff) ||
    (unit >= 0x1dc0 && unit <= 0x1dff) ||
    (unit >= 0x20d0 && unit <= 0x20ff) ||
    (unit >= 0xfe00 && unit <= 0xfe0f) ||
    (unit >= 0xfe20 && unit <= 0xfe2f) ||
    unit === 0x200d ||
    unit === 0x200c ||
    (unit >= 0xdc00 && unit <= 0xdfff);

/**
 * Keep the END of a preview rather than the beginning (T26, R26).
 *
 * WHY: a current thinking window grows every frame. Clipping it from the front (or leaving
 * the front visible in a scroll box) shows the reader the SAME first lines forever, which is
 * the "static text" complaint this rule exists to answer; keeping the newest characters makes
 * the pane visibly scroll as the model writes.
 *
 * HOW: slice on UTF-16 units (the same unit `chars` counts — invariant 5), then walk FORWARD
 * to a safe boundary so the kept suffix never starts inside a code point or a combining
 * sequence. Walking forward drops one more character rather than emitting half an emoji, and
 * `shown`/`omitted` stay exact so the caption can still state the whole truth. Slicing is
 * RENDER-ONLY: nothing here touches the recorded bytes, the wire text or the detail dialog.
 */
export const contextTextSuffixOf = (value: string | undefined, limit: number = CONTEXT_TAIL_PREVIEW_CHARS): ContextTextSuffix => {
    const source = typeof value === 'string' ? value : '';

    if (source.length === 0) return { text: '', shown: 0, omitted: 0, bounded: false };

    const bound = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 0;

    if (source.length <= bound) return { text: source, shown: source.length, omitted: 0, bounded: false };

    // A zero bound keeps no text at all; the marker still says why the pane is not empty-because
    // -whole rather than empty-by-accident.
    if (bound === 0) return { text: CONTEXT_TEXT_ELLIPSIS, shown: 0, omitted: source.length, bounded: true };

    let cut = source.length - bound;

    // Each step moves the cut one unit past a unit that cannot open a cluster, so the loop
    // runs at most once per mark in a single grapheme cluster.
    while (cut > 0 && cut < source.length) {
        const unit = source.charCodeAt(cut);
        const previous = source.charCodeAt(cut - 1);

        if (isClusterContinuation(unit) || (previous >= 0xd800 && previous <= 0xdbff)) {
            cut += 1;
            continue;
        }

        break;
    }

    const shown = source.length - cut;

    return { text: `${CONTEXT_TEXT_ELLIPSIS}${source.slice(cut)}`, shown, omitted: cut, bounded: true };
};

// ---------------------------------------------------------------------------
// The ONE current tail block (T22, R23; T23 widened it to EVERY current block)
// ---------------------------------------------------------------------------

/**
 * The three content kinds eligible to be a section's displayed body: a thinking window,
 * an answer, and a recorded CALL — "whatever block it is, it is in the tail, like tool
 * call". `user` and `system` are the two exceptions the rule names: a `user` prompt keeps
 * its own surface (`TurnSummary.prompt` rides the row, and a steered submit renders as its
 * own node), and a `system` block has no prose surface here at all.
 */
export type ContextTailKind = 'reasoning' | 'assistant' | 'tool';

/**
 * The current call's own body, as the server designated it (R23).
 *
 * `args`/`result` are the COMPLETE recorded bytes of this one block — the same strings the
 * lazy step/block routes would answer with, delivered once, on the frame that made this
 * call the newest block, and dropped from the compiled view the moment a newer block takes
 * the tail. `chars` figures stay the segment's exact recorded counts (invariant 5), so the
 * caption states the whole payload's size whatever the wire carries — and a server producer
 * carries ALL of it (T25: the designated payload has no display-side cap, so `truncated` is
 * false and the pane is the recorded bytes). Panels and media are counted, never copied: the
 * step node this tail points at still carries their bounded summaries, and the shell's panel
 * hosts draw them from the document (../view-state.ts `panelEntriesOf`).
 */
export type ContextTailTool = {
    /** The recorded tool name, verbatim (`read`, `delegate`, …). Never derived locally. */
    name: string;
    /** The server's settled state, or `running` while the call has not settled. */
    state: StepDisplayState;
    args: string | undefined;
    result: string | undefined;
    /** The tool's own measured span, or undefined when the record never measured one. */
    durationMs: number | undefined;
    /** EXACT recorded argument characters (invariant 5). */
    argsChars: number;
    /** EXACT recorded result characters; undefined while no result is recorded. */
    resultChars: number | undefined;
    /** How many panel summaries / media descriptors the settled result carries. */
    panelCount: number;
    mediaCount: number;
    /** True when the call has a recorded result, stated rather than inferred from
     *  `result !== undefined`, so an empty-string result is not read as "still running". */
    hasResult: boolean;
};

/**
 * The ONE block a section displays in full, resolved from the SERVER's designation.
 *
 * `contextTailOf` reads `TurnSection.tail` — the projector's own answer to "which block is
 * current" — and addresses the node it names. It compiles nothing: no pairing, no sort, no
 * scan for "the last thing that looked like content". That is what makes a live streamed
 * frame, a projection rebuild and a cold reload pick the SAME block, which is the guarantee
 * the chip pile used to break.
 *
 * A producer that sends no designation (a pre-T23 document) falls back to
 * `legacyTailOf` below, which reads the recorded order itself; the fallback never claims a
 * full payload the wire did not carry.
 */
export type ContextTail = {
    kind: ContextTailKind;
    /** The node the body text comes from (the server minted the id; nothing parses it). */
    nodeId: string;
    /** The segment this tail stands for, when the section's `context` names one. */
    blockId: string | undefined;
    /**
     * The wire text of a PROSE tail: COMPLETE for a designated carrier, bounded for a
     * window that lost the tail. Empty for a tool, whose body is `tool.args`/`tool.result`.
     * This stays the wire's own bytes — the render window below is a separate value, so no
     * consumer of the model can mistake a preview for the record.
     */
    text: string;
    /**
     * The PROSE body actually painted (T27, R1b): a `reasoning` tail paints the wire's text
     * WHOLE inside its own scroll box — no render window, no leading `…` — and an `assistant`
     * tail paints the LATEST `shownChars` characters of `text` behind a leading `…` when
     * anything is missing (T26, R26), never its first lines. Empty for a tool, whose panes
     * print the recorded bytes whole.
     */
    renderText: string;
    /**
     * EXACT characters of the recorded block that are on screen. `chars` when the body fits
     * whole — the normal case for a thinking tail, whose box is windowed by nothing (R1b) —
     * the wire payload's length when the server bounded it, or the render window's length when
     * an answer's pane caps a long prose body. The caption's "showing N of M" reads from here,
     * so a front-bounded wire body and a render-capped one are stated the same way.
     */
    shownChars: number;
    /** EXACT recorded characters of the block (invariant 5) — never `text.length`. */
    chars: number;
    /**
     * True when the WIRE body is strictly less than what the record holds — the server's own
     * statement (`DisplayTail.truncated`) or, for a legacy producer, an honest reading of its
     * `redacted` marker against its `chars` figure. Never derived by measuring a preview.
     *
     * T26 (R26) note: this is the WIRE's truth, not the pane's. The pane may cap a whole body
     * further (`shownChars < chars`), and the caption reports the pane; `data-truncated` keeps
     * reporting the wire, so "the record sent me a preview" and "I am showing you a window"
     * stay two separate, individually honest facts.
     */
    truncated: boolean;
    /** The current call's payload, present exactly when `kind === 'tool'`. */
    tool?: ContextTailTool;
    /** True when the tail came from the server's designation rather than the fallback. */
    designated: boolean;
};

/** The tail kind a node carries, or undefined when the node is not displayable content.
 *  A `notice` (wake / error / answered / the pending line) is server-written status prose,
 *  never model content, so it can never erase the block a reader is looking at; an
 *  `action` step is an interactive owner question that renders its own full card. */
const tailKindOf = (node: DisplayNode): ContextTailKind | undefined => {
    if (node.kind === 'reasoning') return 'reasoning';
    if (node.kind === 'text') return 'assistant';
    if (node.kind === 'tool') return 'tool';

    return undefined;
};

/** The node this section owns with this id, when it is one of the displayable kinds. */
const tailNodeOf = (section: TurnSection, nodeId: string): DisplayNode | undefined => {
    for (const node of section.nodes) {
        if (node.id === nodeId && tailKindOf(node) !== undefined) return node;
    }

    return undefined;
};

/**
 * The LAST segment of this section's bar that stands for `kind`, or undefined.
 *
 * Both lists are the server's recorded order, so the last entry of a kind IS the block
 * that owns the last node of that kind — this is an order read, not the step/segment
 * pairing the wire exists to remove, and only the fallback path needs it (a designation
 * names its own `blockId`).
 */
const lastBlockOfKind = (section: TurnSection, kind: ContextTailKind): ContextBlock | undefined => {
    const listed = (section as { context?: unknown }).context;
    if (!Array.isArray(listed)) return undefined;

    for (let index = listed.length - 1; index >= 0; index -= 1) {
        const block = listed[index] as ContextBlock | null | undefined;
        if (block !== null && block !== undefined && typeof block === 'object' && block.kind === kind)
            return block;
    }

    return undefined;
};

/** The section's segment with this id, when it carries one (a designation's `blockId`). */
const blockOfId = (section: TurnSection, blockId: string | undefined): ContextBlock | undefined => {
    if (blockId === undefined) return undefined;

    return (section.context ?? []).find((candidate) => candidate.id === blockId);
};

/**
 * The exact character figure for a tail: the segment the server counts (invariant 5), the
 * node's own server-stamped `chars`, the designation's figure, and only as a last resort
 * the length of text the server says is whole — in that order, never a local measurement of
 * a possibly-bounded preview when a stated figure exists.
 */
const exactCharsOf = (stated: unknown, fallback: number): number =>
    typeof stated === 'number' && Number.isFinite(stated) ? Math.max(0, Math.trunc(stated)) : Math.max(0, fallback);

/** A prose body's honest bounded-state: the server's marker first, then its own two
 *  figures disagreeing (a producer that states `chars` without the marker). */
const proseIsBounded = (node: DisplayTextNode | DisplayReasoningNode, chars: number, text: string): boolean =>
    node.redacted === true || chars > text.length;

/**
 * The PROSE body a tail paints, plus the two figures that describe it honestly.
 *
 * T27 (R1b): a THINKING tail is no longer windowed. Its pane is a fixed-height scroll box
 * (styles.css `.context-bar-tail-body`, height `--context-tail-body-height`) that holds the
 * whole round, so the reader scrolls the round instead of being shown "320 of 1,234
 * characters" behind a leading `…`: `renderText` is the node's text EXACTLY as the wire
 * delivered it, with no render-side cut and no marker of our own.
 *
 * Honesty is still derived from what actually arrived (T27 review, P2). A producer that
 * bounded the wire text — `redacted: true`, or a `chars` figure larger than the text it sent
 * — has fewer characters in the box than the record holds, so `shownChars` is what the pane
 * can paint and `truncated` stays true, and the caption keeps its "showing N of M … click the
 * segment" pointer instead of over-claiming. On the designated-carrier path the server sends
 * the tail whole, `node.text.length === chars`, so the tail reports `shownChars === chars` and
 * `truncated: false` and the line reads `thinking · N characters` with no "showing" clause —
 * which is the case the requirement is about.
 *
 * An ANSWER tail keeps T26 (R26) unchanged: it prints in the flow's `.agent-text` block, not
 * in a scroll box of its own, so its preview stays the LATEST window and the caption keeps
 * stating the cut. `contextTextSuffixOf` and `CONTEXT_TAIL_PREVIEW_CHARS` stay live for it.
 */
const proseRenderOf = (
    kind: ContextTailKind,
    node: DisplayTextNode | DisplayReasoningNode,
    chars: number
): { renderText: string; shownChars: number; truncated: boolean } => {
    if (kind === 'reasoning') {
        const body = node.text;

        return {
            renderText: body,
            shownChars: Math.min(chars, body.length),
            truncated: proseIsBounded(node, chars, body)
        };
    }

    const render = contextTextSuffixOf(node.text);

    return {
        renderText: render.text,
        shownChars: Math.min(chars, render.shown),
        truncated: proseIsBounded(node, chars, node.text)
    };
};

/**
 * Build the tail from the server's designation (R23) — the normal path for any
 * server-produced section.
 *
 * Every value is either the designation itself or a field of the node/block it addresses.
 * A missing node is reported as "no tail" rather than guessed at, because the designation
 * always follows the ops that establish its node (turn-display.ts:1096) and a client that
 * missed a frame is reconciled by the terminal `view` document.
 */
const designatedTailOf = (section: TurnSection, designation: DisplayTail): ContextTail | undefined => {
    const node = tailNodeOf(section, designation.nodeId);
    if (node === undefined) return undefined;

    const segment = blockOfId(section, designation.blockId);

    if (designation.kind === 'tool') {
        const step = node as DisplayStep;
        const args = designation.args;
        const result = designation.result;
        // `hasResult` is the SERVER's statement (`DisplayStep.detail`), and a payload the
        // designation itself carries proves one as well. Never inferred from a truthiness
        // test on `result`, so an honestly empty recorded result stays "settled".
        const hasResult = step.detail.hasResult === true || result !== undefined;
        const argsChars = exactCharsOf(segment?.argsChars, args?.length ?? 0);
        const resultChars = segment?.resultChars !== undefined
            ? exactCharsOf(segment.resultChars, result?.length ?? 0)
            : result === undefined
              ? undefined
              : exactCharsOf(undefined, result.length);

        // One exact figure, computed once and read by both the block's `chars` and the
        // pane's `shownChars` (they differ only when the wire bounded the payload).
        const payloadChars = (args?.length ?? 0) + (result?.length ?? 0);
        const callChars = exactCharsOf(segment?.chars ?? designation.chars, payloadChars);

        return {
            kind: 'tool',
            nodeId: step.id,
            blockId: designation.blockId,
            text: '',
            // A call's panes print the recorded bytes whole (T25), so what is on screen is the
            // payload the designation carried. `renderText` stays empty: the suffix window of
            // R26 is a PROSE preview rule, and capping a recorded payload further would be the
            // gratuitous cap the requirement warns about.
            renderText: '',
            shownChars: Math.min(callChars, payloadChars),
            chars: callChars,
            truncated: designation.truncated === true,
            designated: true,
            tool: {
                name: step.name,
                state: step.state,
                args,
                result,
                // The span the record supports, in the two shapes the server sends it
                // (../shared/turn-display.ts:669): the measured `durationMs`, else the
                // recorded open/settle pair. Never a re-derivation, and never a number for
                // a call that is still running.
                durationMs: step.durationMs ?? elapsedBetween(step.startedAt, step.endedAt),
                argsChars,
                resultChars,
                panelCount: step.panels?.length ?? 0,
                mediaCount: step.media?.length ?? 0,
                hasResult
            }
        };
    }

    const prose = node as DisplayTextNode | DisplayReasoningNode;
    const chars = exactCharsOf(segment?.chars ?? prose.chars ?? designation.chars, prose.text.length);

    // T26 (R26) for an answer / T27 (R1b) for thinking: the pane paints the whole recorded
    // window for a designated carrier either way, and the two kinds differ only in what the
    // render does with it (see `proseRenderOf`). A designated carrier's text IS the whole
    // recorded window, so live and reload paint the same bytes.
    const render = proseRenderOf(designation.kind, prose, chars);

    return {
        kind: designation.kind,
        nodeId: prose.id,
        blockId: designation.blockId,
        text: prose.text,
        renderText: render.renderText,
        shownChars: render.shownChars,
        chars,
        truncated: render.truncated,
        designated: true
    };
};

/**
 * The fallback reading, for a section whose producer sent no designation (a pre-T23
 * document, a hand-written fixture): walk the server's display order from the end.
 *
 * Skips `notice` / `action` nodes for the same reason the server does, and stops at a
 * recorded CALL exactly as the rule always did — but it reports NO tool BODY, because a
 * producer that never named the tail also never sent the call's full payload. Only a
 * designation (`designatedTailOf`) may print one, so the compactness rule still holds on
 * the old wire.
 */
const legacyTailOf = (section: TurnSection): ContextTail | undefined => {
    const nodes = section.nodes;

    // Indexed walk from the end (no copy): a long section is exactly the case where a
    // per-frame array clone would cost.
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const node = nodes[index];
        const kind = tailKindOf(node);

        // A recorded call is the newest block, and the strip — not a body — shows it here.
        if (node.kind === 'tool') return undefined;
        if (kind === undefined) continue;

        const prose = node as DisplayTextNode | DisplayReasoningNode;
        const segment = lastBlockOfKind(section, kind);
        const chars = exactCharsOf(segment?.chars ?? prose.chars, prose.text.length);
        // Same render rule as the designated path (T27, R1b): thinking whole in its scroll box,
        // answer as its latest window. The figures come from this producer's own bytes.
        const render = proseRenderOf(kind, prose, chars);

        return {
            kind,
            nodeId: prose.id,
            blockId: segment?.id,
            text: prose.text,
            renderText: render.renderText,
            shownChars: render.shownChars,
            chars,
            truncated: render.truncated,
            designated: false
        };
    }

    return undefined;
};

/**
 * Resolve a section's CURRENT tail block.
 *
 * `TurnSection.tail` (the server's designation) is the authority; the recorded-order
 * fallback keeps a pre-T23 producer rendering the way T22 left it. Either way the answer
 * is one block per section, and a live frame, a rebuild and a cold reload agree because
 * they all end in this function reading the same server state.
 */
export const contextTailOf = (section: TurnSection | undefined): ContextTail | undefined => {
    if (section === undefined) return undefined;

    const designation = (section as { tail?: DisplayTail }).tail;

    if (designation !== null && typeof designation === 'object') {
        const designated = designatedTailOf(section, designation);
        if (designated !== undefined) return designated;
    }

    return legacyTailOf(section);
};

/** The tail's heading word: the server's `name` for the segment when it sent one, and the
 *  kind word otherwise, so the printed word is never invented from the text itself. A tool
 *  tail is headed by the tool's OWN recorded name — never a local label. */
export const contextTailLabelOf = (tail: ContextTail): string => {
    if (tail.kind === 'reasoning') return 'thinking';
    if (tail.kind === 'assistant') return 'answer';

    return tail.tool?.name ?? 'call';
};

/**
 * The tail's ONE figure line, and the honest one at that (R23; windowed by T26, R26).
 *
 * `chars` is always the EXACT recorded length (invariant 5) and `shownChars` is always the
 * exact length ON SCREEN. The two differ when the wire sent a bounded payload, and they also
 * differ when the pane caps a whole prose body at `CONTEXT_TAIL_PREVIEW_CHARS` to show its
 * latest lines — either way the line states the painted figure beside the recorded one, so a
 * 320-character window of a 1,234-character block never reads as the whole block. When the
 * pane does hold the whole block the line states the length without hedging, because the
 * designated carrier IS the whole text (T25: a server's tool payload is never capped away).
 *
 * The exact strings are pinned by ./view-context.test.ts: a whole prose body prints its exact
 * length alone; a bounded or windowed one prints `showing N of M characters` with the pointer
 * to the segment detail; a settled call names its state, its measured span (or `time not
 * recorded` when the record never bracketed one, R27), its exact length and the args/result
 * split; a running call says `no result recorded yet`.
 */
export const contextTailCaptionOf = (tail: ContextTail): string => {
    const label = contextTailLabelOf(tail);

    if (tail.kind !== 'tool') {
        // Whole means WHOLE: every recorded character is on screen. Anything else states the
        // exact number painted — the wire sent a bounded body, or an ANSWER pane capped a whole
        // one at `CONTEXT_TAIL_PREVIEW_CHARS` (T26, R26). `shownChars` is the one figure both
        // cases agree on, so the line can never claim more than the reader is looking at.
        //
        // T27 (R1b): a `reasoning` tail reaches the whole branch whenever the wire sent the
        // block whole — the designated-carrier case, and the only one the live server produces
        // — because the pane no longer caps it, so the line reads `thinking · N characters` with
        // no "showing X of Y" and no pointer clause. A producer that DID bound the wire text
        // still lands here honestly (T27 review, P2): the pane shows the fewer bytes it was
        // given, and the caption says so and points at the segment.
        if (tail.shownChars >= tail.chars) return `${label} · ${formatContextCharCount(tail.chars)} characters`;

        return (
            `${label} · showing ${formatContextCharCount(tail.shownChars)} of ` +
            `${formatContextCharCount(tail.chars)} characters — click the segment for the exact text`
        );
    }

    const tool = tail.tool;
    const parts = [label, tool?.state ?? 'running'];

    if (tool?.durationMs !== undefined) parts.push(formatDuration(tool.durationMs));
    else parts.push('time not recorded');

    // The body this pane prints, when the wire bounded it, beside the block's EXACT size.
    if (tail.truncated)
        parts.push(`showing ${formatContextCharCount(tail.shownChars)} of ${formatContextCharCount(tail.chars)} characters`);
    else parts.push(`${formatContextCharCount(tail.chars)} characters`);

    // The split the strip's tooltip already states, so the body and the segment agree.
    if (tool !== undefined && !tail.truncated) {
        if (tool.argsChars > 0 && tool.resultChars !== undefined)
            parts.push(`args ${formatContextCharCount(tool.argsChars)} + result ${formatContextCharCount(tool.resultChars)}`);
        else if (tool.argsChars > 0) parts.push(`args ${formatContextCharCount(tool.argsChars)}`);
        else if (tool.resultChars !== undefined) parts.push(`result ${formatContextCharCount(tool.resultChars)}`);
    }

    // What else the settled result carried, counted only. The panel HOSTS are the shell's
    // (../view-state.ts `panelEntriesOf` -> ./ui/panels.ts), so this line names them
    // without duplicating their content — and without ever hiding the fact that a result
    // was more than text.
    if ((tool?.panelCount ?? 0) > 0)
        parts.push(`${tool?.panelCount} ${tool?.panelCount === 1 ? 'panel' : 'panels'}`);
    if ((tool?.mediaCount ?? 0) > 0) parts.push(`${tool?.mediaCount} media`);

    if (tool !== undefined && !tool.hasResult) parts.push('no result recorded yet');

    return parts.join(' · ');
};

/**
 * The id of this section's NEWEST `kind: 'text'` node, in the server's recorded order, or
 * undefined when the section has printed no prose at all (T27, R2).
 *
 * An order read, not a re-derivation: the projector appends nodes in recorded order, so the
 * last text node IS the assistant response the reader is looking at right now — an
 * intermediate reply issued before a tool call, or the committed final answer. Indexed walk
 * from the end (no copy), the same shape `legacyTailOf` uses, because a long section is
 * exactly the case where a per-frame array clone would cost.
 */
export const contextLatestTextNodeIdOf = (section: TurnSection | undefined): string | undefined => {
    const nodes = section?.nodes;
    if (!Array.isArray(nodes)) return undefined;

    for (let index = nodes.length - 1; index >= 0; index -= 1) {
        const node = nodes[index];
        if (node !== null && node !== undefined && node.kind === 'text') return node.id;
    }

    return undefined;
};

/**
 * True when this prose node prints its body while the section is bar-described (T27, R2).
 *
 * The rule moved. R23 printed a prose block ONLY when the server's designation named it, so an
 * INTERMEDIATE assistant response vanished the moment the next thinking window or recorded call
 * took the tail, and a running turn read as a bare strip over a tool pane with no reply above
 * it. The newest assistant response now stays printed for as long as it is the newest response,
 * whichever block owns the tail, and the tail block itself is painted BELOW it in the same flow
 * (./ui/turns.ts `ContextBarSurface.placeTail`). Every older response is history: it prints
 * nothing and its exact bytes stay one segment click away, which is the part of R23 that stood.
 *
 * `tail` left the signature on purpose — the answer's visibility is a fact about the section's
 * recorded order, not about which block the tail is currently printing. A section the bar never
 * described (`available: false`) is NOT narrowed here: its caller keeps the historical flow
 * rendering, which is the compatibility rule in rule 4.
 */
export const contextTailShowsProse = (section: TurnSection | undefined, nodeId: string): boolean =>
    contextLatestTextNodeIdOf(section) === nodeId;

// ---------------------------------------------------------------------------
// Geometry: TWO dimensions (T26, R27) — width from recorded time, height from
// recorded characters, each with an honest display floor
// ---------------------------------------------------------------------------

export type ContextBarSegmentLayout = {
    index: number;
    block: ContextBlock;
    /** The exact character count this segment stands for — the HEIGHT weight. */
    chars: number;
    /**
     * The RECORDED span in ms this segment stands for, or undefined when the record cannot
     * bracket it (`durationMs` first, then `endedAt - at` — never a guess). This is the WIDTH
     * weight, because the horizontal axis is TIME TAKEN.
     */
    durationMs: number | undefined;
    /** False when `durationMs` is undefined: this bar's width is the honest baseline. */
    durationKnown: boolean;
    /** Fraction of the usable track WIDTH, after the floor and the baseline, summing to exactly 1. */
    share: number;
    /** Left edge in CSS pixels from the start of the track (sequential, never overlapping). */
    x: number;
    /** Painted width in CSS pixels, at least 1. */
    width: number;
    /** `chars / maxChars` inside THIS strip (0 when the strip recorded no characters). */
    heightShare: number;
    /**
     * Painted bar HEIGHT in CSS pixels: `maxHeightPx * heightShare`, clamped into
     * `[minSegmentHeightPx, maxHeightPx]` so the tallest bar in the strip is exactly two
     * line-heights and a small-but-real block is still a visible bar.
     */
    heightPx: number;
};

export type ContextBarLayout = {
    /** The width the geometry was computed for. */
    width: number;
    /** The gap actually applied (the requested gap, shrunk when it cannot fit). */
    gapPx: number;
    /** Width left for the segments themselves: `width - gapPx * (n - 1)`. */
    trackPx: number;
    /** The minimum segment width actually applied (the floor, shrunk when it cannot fit). */
    minSegmentPx: number;
    /** The baseline width actually applied to a segment with no recorded span. */
    unknownDurationPx: number;
    /** How many segments took that baseline (R27: the strip's unmeasured count). */
    durationsUnknown: number;
    /** Sum of every recorded span, or undefined when this strip has none at all. */
    totalDurationMs: number | undefined;
    /** The line-height the vertical axis was scaled from (R27: 2 of these is the ceiling). */
    lineHeightPx: number;
    /** The tallest possible bar: `CONTEXT_BAR_MAX_HEIGHT_LINES` line-heights. */
    maxHeightPx: number;
    /** The shortest bar a block with recorded characters can paint. */
    minSegmentHeightPx: number;
    /** The largest `chars` figure in this strip — the height denominator. */
    maxChars: number;
    /**
     * The strip's own physical box: the tallest bar it paints (so a canvas and a flex row
     * reserve the same rectangle), or `CONTEXT_BAR_TRACK_HEIGHT_PX` for an empty strip, which
     * is the box the dashed "nothing recorded" affordance needs.
     */
    heightPx: number;
    segments: ContextBarSegmentLayout[];
    /** Right edge of the last segment: what a pointer test must reject beyond. */
    rightEdge: number;
};

/**
 * Share assignment by water-filling.
 *
 * Each weight wants `w / total` of the track but never less than `minShare`. Anyone below
 * the floor is locked AT the floor and the remainder is re-divided among the rest, which
 * is the standard exact algorithm and terminates in at most `n` rounds (each round locks
 * at least one more segment). `minShare` is capped at `1 / n`, so the floors always sum
 * to at most 1 and the shares always sum to exactly 1.
 *
 * A zero-weight bar (every block recorded 0 characters) splits equally: nothing is
 * proportional about it, and a bar of invisible segments would lie about the data.
 */
export const contextBarSharesOf = (weights: readonly number[], minShare: number): number[] => {
    const n = weights.length;
    if (n === 0) return [];

    const floor = Math.min(Math.max(0, Number.isFinite(minShare) ? minShare : 0), 1 / n);
    const clean = weights.map((weight) => (Number.isFinite(weight) && weight > 0 ? weight : 0));
    const total = clean.reduce((sum, weight) => sum + weight, 0);

    if (total <= 0) return clean.map(() => 1 / n);

    const shares = new Array<number>(n).fill(0);
    const locked = new Array<boolean>(n).fill(false);
    let lockedCount = 0;

    // One round per segment at most: every round that changes anything locks someone.
    for (let round = 0; round < n; round += 1) {
        const rest = Math.max(0, 1 - floor * lockedCount);
        let freeWeight = 0;
        let freeCount = 0;

        for (let i = 0; i < n; i += 1) {
            if (locked[i]) continue;
            freeWeight += clean[i];
            freeCount += 1;
        }

        if (freeCount === 0) break;

        let newlyLocked = false;

        for (let i = 0; i < n; i += 1) {
            if (locked[i]) continue;

            const share = freeWeight > 0 ? (rest * clean[i]) / freeWeight : rest / freeCount;

            // `floor` is 0 whenever the caller asked for no minimum, and a 0-weight
            // segment's share is then exactly 0 — so the epsilon only guards float noise.
            if (floor > 0 && share < floor - 1e-12) {
                shares[i] = floor;
                locked[i] = true;
                lockedCount += 1;
                newlyLocked = true;
                continue;
            }

            shares[i] = share;
        }

        if (!newlyLocked) break;
    }

    return shares;
};

/**
 * Width shares from the RECORDED spans (T26, R27): the horizontal axis is TIME TAKEN.
 *
 * `durations[i]` is the exact span in ms, or undefined when the record cannot say. Known
 * spans divide whatever the unmeasured ones leave, proportionally and water-filled against
 * the same display floor the strip has always had (so a 40ms call stays clickable beside a
 * 40s one); an undefined span takes a fixed BASELINE width instead of a fabricated number,
 * and a strip with no measurement at all splits equally because there is nothing to be
 * proportional about. Every 0ms span is real data, so an all-zero strip is the same
 * "nothing is proportional" case and splits equally rather than collapsing to baselines.
 *
 * The result sums to exactly 1, which is what lets the canvas (pixels) and the DOM mode
 * (flex weights) size themselves from one arithmetic.
 */
export const contextBarDurationSharesOf = (
    durations: readonly (number | undefined)[],
    options: { trackPx?: number; minSegmentPx?: number; unknownDurationPx?: number } = {}
): number[] => {
    const n = durations.length;
    if (n === 0) return [];

    const requestedTrack = options.trackPx ?? 0;
    const track = Number.isFinite(requestedTrack) && requestedTrack > 0 ? requestedTrack : CONTEXT_BAR_FALLBACK_WIDTH;
    const requestedMin = options.minSegmentPx ?? CONTEXT_BAR_MIN_SEGMENT_PX;
    const requestedBaseline = options.unknownDurationPx ?? CONTEXT_BAR_UNKNOWN_DURATION_PX;

    // A malformed figure (NaN, negative, a string) is "the record cannot say", the same
    // answer `contextBlockDurationOf` gives — never a coerced 0, which would read as
    // "instantaneous".
    const clean = durations.map((span) => (typeof span === 'number' && Number.isFinite(span) && span >= 0 ? Math.round(span) : undefined));
    const unknown = clean.reduce<number>((count, span) => (span === undefined ? count + 1 : count), 0);

    if (unknown === n) return clean.map(() => 1 / n);

    // A baseline may never steal more than a fair share of the strip from the measured bars,
    // so hundreds of unbracketed segments still leave the timeline readable.
    const baselinePx = Math.max(0, Math.min(requestedBaseline, track / n));
    const restPx = Math.max(0, track - baselinePx * unknown);
    const known = clean.filter((span): span is number => span !== undefined);
    const total = known.reduce((sum, span) => sum + span, 0);

    if (restPx <= 0) return clean.map(() => 1 / n);

    const restShare = restPx / track;
    const knownShares =
        total > 0 ? contextBarSharesOf(known, requestedMin / restPx) : known.map(() => 1 / known.length);

    let cursor = 0;

    return clean.map((span) => (span === undefined ? baselinePx / track : knownShares[cursor++] * restShare));
};

/**
 * Bar heights from the RECORDED characters (T26, R27): the vertical axis is CONTEXT SIZE.
 *
 * One denominator per STRIP — the largest `chars` figure this strip holds — so a delegated
 * thread's own bars stay readable beside a caller's strip whose biggest block happens to be
 * a 40,000-character result. The largest block paints exactly `maxHeightPx` (two
 * line-heights), anything smaller is proportional, and a block with characters never
 * collapses under `minSegmentHeightPx`. A strip that recorded no characters at all is a row
 * of minimum bars: short, because there is nothing tall to show.
 */
export const contextBarHeightsOf = (
    chars: readonly number[],
    options: { maxHeightPx?: number; minSegmentHeightPx?: number } = {}
): number[] => {
    const requestedMax = options.maxHeightPx ?? CONTEXT_BAR_MAX_TRACK_HEIGHT_PX;
    const maxHeightPx = Number.isFinite(requestedMax) && requestedMax > 0 ? Math.round(requestedMax) : CONTEXT_BAR_MAX_TRACK_HEIGHT_PX;
    const requestedMin = options.minSegmentHeightPx ?? CONTEXT_BAR_MIN_SEGMENT_HEIGHT_PX;
    const minSegmentHeightPx =
        Number.isFinite(requestedMin) && requestedMin > 0 ? Math.min(maxHeightPx, Math.round(requestedMin)) : Math.min(maxHeightPx, CONTEXT_BAR_MIN_SEGMENT_HEIGHT_PX);

    const clean = chars.map((value) => (Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0));
    const maxChars = clean.reduce((best, value) => (value > best ? value : best), 0);

    if (maxChars === 0) return clean.map(() => minSegmentHeightPx);

    return clean.map((value) => Math.min(maxHeightPx, Math.max(minSegmentHeightPx, Math.round((maxHeightPx * value) / maxChars))));
};

/**
 * Pixel geometry for one bar, both axes (T26, R27).
 *
 * Deterministic and total-exact: the horizontal edges come from rounding the CUMULATIVE
 * share, so rounding cannot drift a segment out of the track and the right edge of the last
 * segment is the width the painter has; segments follow each other SEQUENTIALLY (never an
 * absolute overlapping timeline). The vertical band comes from `contextBarHeightsOf`, and
 * `heightPx` is the tallest bar in the strip so both renderers reserve the same box and seat
 * every bar on its bottom edge. The gap and both floors shrink when they cannot fit (a
 * 3,000-segment turn in a 600px track), which is honest: below ~2px a proportion is not
 * visible anyway, and the tooltip still carries the true counts.
 */
export const layoutContextBar = (
    blocks: readonly ContextBlock[],
    width: number,
    options: {
        gapPx?: number;
        minSegmentPx?: number;
        unknownDurationPx?: number;
        lineHeightPx?: number;
        maxHeightPx?: number;
        minSegmentHeightPx?: number;
    } = {}
): ContextBarLayout => {
    const n = blocks.length;
    const requestedGap = options.gapPx ?? CONTEXT_BAR_GAP_PX;
    const requestedMin = options.minSegmentPx ?? CONTEXT_BAR_MIN_SEGMENT_PX;
    const safeWidth = Number.isFinite(width) && width > 0 ? width : CONTEXT_BAR_FALLBACK_WIDTH;

    // The vertical scale comes from the HOST first (./ui/context-bar.ts resolves the real
    // line-height, so "2 line-heights" survives a font or theme change), then from the shared
    // constants. CSS pixels throughout: `devicePixelRatio` only ever scales the canvas BACKING
    // STORE, so two line-heights are the same physical height in both modes and at any zoom.
    const requestedLine = options.lineHeightPx ?? CONTEXT_BAR_LINE_HEIGHT_PX;
    const lineHeightPx = Number.isFinite(requestedLine) && requestedLine > 0 ? requestedLine : CONTEXT_BAR_LINE_HEIGHT_PX;
    const requestedMax = options.maxHeightPx ?? lineHeightPx * CONTEXT_BAR_MAX_HEIGHT_LINES;
    const maxHeightPx = Number.isFinite(requestedMax) && requestedMax > 0 ? Math.round(requestedMax) : CONTEXT_BAR_MAX_TRACK_HEIGHT_PX;
    const requestedBarMin = options.minSegmentHeightPx ?? CONTEXT_BAR_MIN_SEGMENT_HEIGHT_PX;
    const minSegmentHeightPx =
        Number.isFinite(requestedBarMin) && requestedBarMin > 0
            ? Math.min(maxHeightPx, Math.round(requestedBarMin))
            : Math.min(maxHeightPx, CONTEXT_BAR_MIN_SEGMENT_HEIGHT_PX);

    // The two axes, read once per segment from the server's own figures: `chars` for the
    // vertical, the recorded span for the horizontal.
    const chars = blocks.map(contextBlockCharsOf);
    const durations = blocks.map(contextBlockDurationOf);
    const maxChars = chars.reduce((best, value) => (value > best ? value : best), 0);
    const durationsUnknown = durations.reduce<number>((count, span) => (span === undefined ? count + 1 : count), 0);
    // undefined — NOT 0 — when nothing in this strip was ever bracketed by timestamps.
    const totalDurationMs = durations.reduce<number | undefined>(
        (sum, span) => (span === undefined ? sum : (sum ?? 0) + span),
        undefined
    );

    if (n === 0)
        return {
            width: safeWidth,
            gapPx: 0,
            trackPx: safeWidth,
            minSegmentPx: 0,
            unknownDurationPx: 0,
            durationsUnknown: 0,
            totalDurationMs: undefined,
            lineHeightPx,
            maxHeightPx,
            minSegmentHeightPx,
            maxChars: 0,
            // An empty strip reserves the base box: that is the rectangle the dashed "nothing
            // recorded" affordance in `styles.css` draws.
            heightPx: CONTEXT_BAR_TRACK_HEIGHT_PX,
            segments: [],
            rightEdge: 0
        };

    // Gaps first, but never so many that a segment loses its last pixel.
    const maxGap = n > 1 ? Math.max(0, Math.floor((safeWidth - n) / (n - 1))) : 0;
    const gapPx = Math.max(0, Math.min(requestedGap, maxGap));
    const trackPx = Math.max(0, safeWidth - gapPx * (n - 1));

    // Then the two width floors: the aimable minimum, and the baseline for a span the record
    // never bracketed. Both shrink to what the track can actually afford.
    const minSegmentPx = Math.max(0, Math.min(requestedMin, trackPx > 0 ? trackPx / n : 0));
    const unknownDurationPx = Math.max(
        0,
        Math.min(options.unknownDurationPx ?? CONTEXT_BAR_UNKNOWN_DURATION_PX, trackPx > 0 ? trackPx / n : 0)
    );

    const shares = contextBarDurationSharesOf(durations, { trackPx, minSegmentPx, unknownDurationPx });
    const heights = contextBarHeightsOf(chars, { maxHeightPx, minSegmentHeightPx });

    const segments: ContextBarSegmentLayout[] = [];
    let cursor = 0;

    for (let i = 0; i < n; i += 1) {
        const block = blocks[i];
        const x = Math.round(cursor);
        const end = cursor + trackPx * shares[i];
        // A share that rounds to nothing still gets one pixel: a 0-width segment is a
        // recorded block the reader cannot reach, which is the failure this bar exists
        // to avoid.
        const painted = Math.max(1, Math.round(end) - x);

        segments.push({
            index: i,
            block,
            chars: chars[i],
            durationMs: durations[i],
            durationKnown: durations[i] !== undefined,
            share: shares[i],
            x,
            width: painted,
            heightShare: maxChars === 0 ? 0 : chars[i] / maxChars,
            heightPx: heights[i]
        });

        cursor = end + gapPx;
    }

    return {
        width: safeWidth,
        gapPx,
        trackPx,
        minSegmentPx,
        unknownDurationPx,
        durationsUnknown,
        totalDurationMs,
        lineHeightPx,
        maxHeightPx,
        minSegmentHeightPx,
        maxChars,
        // The strip's box is its tallest bar: two line-heights when anything was recorded, the
        // minimum bar height when the whole strip recorded zero characters.
        heightPx: maxChars > 0 ? maxHeightPx : minSegmentHeightPx,
        segments,
        rightEdge: Math.round(cursor - gapPx)
    };
};

/**
 * Which segment a pointer is on, or -1 outside the bar.
 *
 * A hit inside a visible gap belongs to the NEARER neighbour: the gap is 2px of styling,
 * not a dead zone, and a reader aiming at a thin segment must not be told they missed.
 * Linear on purpose — this runs on a pointer event, not per frame — and bounded by
 * `rightEdge` so a click past the last segment is a miss.
 *
 * THE VERTICAL POLICY (T26, R27, stated because both renderers implement exactly this): the
 * strip is a COLUMN chart, so the aim target is the whole column, not only the painted bar.
 * A pointer in the blank area above a 6px bar still activates that segment. A 2px-tall bar
 * would otherwise be a target nobody could hit with a mouse, and the DOM mode reproduces the
 * same rule by falling back to this function when a click lands beside the buttons.
 */
export const contextBarSegmentAt = (layout: ContextBarLayout, x: number): number => {
    if (layout.segments.length === 0) return -1;
    if (!Number.isFinite(x) || x < 0 || x > layout.rightEdge) return -1;

    let previousEdge = -1;

    for (const segment of layout.segments) {
        if (x >= segment.x && x < segment.x + segment.width) return segment.index;

        if (previousEdge !== -1 && x < segment.x) {
            // Inside the gap between the previous segment and this one.
            return x - previousEdge <= segment.x - x ? segment.index - 1 : segment.index;
        }

        previousEdge = segment.x + segment.width;
    }

    // At or past the final edge: the last segment owns the remainder.
    return layout.segments[layout.segments.length - 1].index;
};

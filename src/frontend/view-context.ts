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
//   2. WIDTH is proportional to the exact `chars`, with an honest DISPLAY FLOOR: a
//      segment is never thinner than `CONTEXT_BAR_MIN_SEGMENT_PX` while that still fits,
//      so a 40-character tool call stays clickable beside a 40,000-character result. The
//      floor is a display rule, never a claim about the data: the tooltip and the
//      accessible label always carry the true figures.
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
import { elapsedBetween, formatDuration } from './ui/time';

// ---------------------------------------------------------------------------
// Display constants (the numbers the stylesheet and the canvas must agree on)
// ---------------------------------------------------------------------------

// Visible separation between segments. A bar of a few segments reads as separate tiles;
// when `n` is large enough that this gap would eat the track, `layoutContextBar` shrinks
// it (never below 0) so every segment keeps at least one pixel.
export const CONTEXT_BAR_GAP_PX = 2;

// The honest minimum: a segment this thin cannot be aimed at, and a label inside it is
// unreadable. 8px is the pointer target; the floor is only applied while the whole bar
// still fits (see rule 2 above).
export const CONTEXT_BAR_MIN_SEGMENT_PX = 8;

// Track height in CSS pixels. The canvas paints at this height (scaled by
// `devicePixelRatio`), and `styles.css` gives `.context-bar-track`/`.context-bar-canvas`
// the same box, so both modes agree on what the bar measures.
export const CONTEXT_BAR_TRACK_HEIGHT_PX = 18;

// A host that has not been laid out yet (a detached tile, a collapsed conversation, a
// jsdom test) reports no width. Rather than zero-width segments, the painter uses this
// width for its geometry and repaints the moment a real width arrives.
export const CONTEXT_BAR_FALLBACK_WIDTH = 640;

// Above this many segments the canvas mode stops materialising one accessible text node
// per segment (a 5,000-call turn would mint 5,000 hidden elements) and keeps only the
// live-region label of the segment under focus. Keyboard traversal is unaffected.
export const CONTEXT_BAR_OPTION_LIMIT = 600;

// The bar's stable ACCESSIBLE name. `contextBarSummaryOf` prefixes it with the full
// figures; the visible line under the track shows `contextBarStatsOf` alone, which since
// T22/R24 is the segment COUNT only (the phrase must not be printed above every turn, and
// the character totals moved to the tooltip, the accessible name and the segment detail).
// Every label built from this string still says CHARACTERS.
export const CONTEXT_BAR_LABEL = 'context character distribution';

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
        }
    }

    return {
        turnId: display?.turnId ?? '',
        available,
        blocks,
        totalChars,
        unpromptedChars,
        counts,
        charsByKind
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

    const span = contextBlockDurationOf(block);
    if (span !== undefined) parts.push(formatDuration(span));

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
 * The FULL figures — count, exact character total, and the honest note when the server
 * marks part of the strip `inPrompt: false`. Not printed (R24); this is the text a
 * screen reader hears inside `contextBarSummaryOf`, so losing the visible line never
 * loses the information.
 *
 * Exact strings, pinned by ./view-context.test.ts:
 *   empty (authoritative)  `no recorded context`
 *   with segments          `4 segments · 1,300 characters`
 *                          [+ ` · 300 characters not replayed into the prompt`]
 */
export const contextBarFiguresOf = (model: ContextBarModel): string => {
    if (model.blocks.length === 0) return 'no recorded context';

    const parts = [
        `${model.blocks.length} ${model.blocks.length === 1 ? 'segment' : 'segments'}`,
        `${formatContextCharCount(model.totalChars)} characters`
    ];

    if (model.unpromptedChars > 0)
        parts.push(`${formatContextCharCount(model.unpromptedChars)} characters not replayed into the prompt`);

    return parts.join(' · ');
};

/**
 * The bar's accessible name: the label phrase plus the FULL figures, so a screen reader
 * still hears WHAT the strip is and how large it is (the visible caption is only the
 * count — R24), while a sighted reader never sees the phrase twice.
 *
 * Exact strings, pinned by ./view-context.test.ts:
 *   empty (authoritative)  `context character distribution · no recorded context`
 *   with segments          `context character distribution · 4 segments · 1,300 characters`
 *                          [+ ` · 300 characters not replayed into the prompt`]
 */
export const contextBarSummaryOf = (model: ContextBarModel): string =>
    `${CONTEXT_BAR_LABEL} · ${contextBarFiguresOf(model)}`;

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
 * caption can state the whole payload's size even when `DISPLAY_TAIL_PAYLOAD_CHARS`
 * bounded what the wire carried. Panels and media are counted, never copied: the step node
 * this tail points at still carries their bounded summaries, and the shell's panel hosts
 * draw them from the document (../view-state.ts `panelEntriesOf`).
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
     */
    text: string;
    /** EXACT recorded characters of the block (invariant 5) — never `text.length`. */
    chars: number;
    /**
     * True when the body on screen is strictly less than what the record holds. Stated by
     * the server (`DisplayTail.truncated`) or, for a legacy producer, derived honestly from
     * its own `redacted` marker and `chars` figure — never by measuring a preview.
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

        return {
            kind: 'tool',
            nodeId: step.id,
            blockId: designation.blockId,
            text: '',
            chars: exactCharsOf(segment?.chars ?? designation.chars, (args?.length ?? 0) + (result?.length ?? 0)),
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

    return {
        kind: designation.kind,
        nodeId: prose.id,
        blockId: designation.blockId,
        text: prose.text,
        chars,
        truncated: proseIsBounded(prose, chars, prose.text),
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

        return {
            kind,
            nodeId: prose.id,
            blockId: segment?.id,
            text: prose.text,
            chars,
            truncated: proseIsBounded(prose, chars, prose.text),
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
 * The tail's ONE figure line, and the honest one at that (R23).
 *
 * `chars` is always the EXACT recorded length (invariant 5). When the wire body is a
 * bounded payload the line says how much of it is on screen, so a 320-character think
 * window or a `DISPLAY_TAIL_PAYLOAD_CHARS`-capped result never reads as the whole block —
 * and when it is not bounded, the line states the length without hedging, because the
 * designated carrier IS the whole text.
 *
 * Exact strings, pinned by ./view-context.test.ts:
 *   thinking whole   `thinking · 1,234 characters`
 *   thinking bounded `thinking · showing 320 of 1,234 characters — click the segment for the exact text`
 *   answer whole     `answer · 96 characters`
 *   call settled     `read · ok · 1.3s · 1,204 characters · args 20 + result 1,184`
 *   call running     `read · running · 20 characters · no result recorded yet`
 */
export const contextTailCaptionOf = (tail: ContextTail): string => {
    const label = contextTailLabelOf(tail);

    if (tail.kind !== 'tool') {
        if (!tail.truncated) return `${label} · ${formatContextCharCount(tail.chars)} characters`;

        return (
            `${label} · showing ${formatContextCharCount(tail.text.length)} of ` +
            `${formatContextCharCount(tail.chars)} characters — click the segment for the exact text`
        );
    }

    const tool = tail.tool;
    const parts = [label, tool?.state ?? 'running'];

    if (tool?.durationMs !== undefined) parts.push(formatDuration(tool.durationMs));

    // The body this pane prints, when the wire bounded it, beside the block's EXACT size.
    if (tail.truncated) {
        const shown = (tool?.args?.length ?? 0) + (tool?.result?.length ?? 0);

        parts.push(`showing ${formatContextCharCount(shown)} of ${formatContextCharCount(tail.chars)} characters`);
    } else {
        parts.push(`${formatContextCharCount(tail.chars)} characters`);
    }

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
 * True when a prose node of this section may print its body: R23 allows exactly ONE, the
 * tail, and only when that tail IS prose. A section that has not been described by the bar
 * (no `context` array — `available: false` upstream) is NOT narrowed here: its caller keeps
 * the historical flow rendering, which is the compatibility rule in rule 4.
 */
export const contextTailShowsProse = (tail: ContextTail | undefined, nodeId: string): boolean =>
    tail !== undefined && tail.kind === 'assistant' && tail.nodeId === nodeId;

// ---------------------------------------------------------------------------
// Geometry: proportional widths with an honest display floor
// ---------------------------------------------------------------------------

export type ContextBarSegmentLayout = {
    index: number;
    block: ContextBlock;
    /** The exact character count this segment stands for (the weight it was sized from). */
    chars: number;
    /** Fraction of the usable track, after the display floor, summing to exactly 1. */
    share: number;
    /** Left edge in CSS pixels from the start of the track. */
    x: number;
    /** Painted width in CSS pixels, at least 1. */
    width: number;
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
 * Pixel geometry for one bar.
 *
 * Deterministic and total-exact: segment edges come from rounding the CUMULATIVE share,
 * so rounding cannot drift a segment out of the track, and the right edge of the last
 * segment is the width the painter has. The gap and the display floor both shrink when
 * they cannot fit (a 3,000-segment turn in a 600px track), which is honest: below ~2px a
 * proportion is not visible anyway, and the tooltip still carries the true counts.
 */
export const layoutContextBar = (
    blocks: readonly ContextBlock[],
    width: number,
    options: { gapPx?: number; minSegmentPx?: number } = {}
): ContextBarLayout => {
    const n = blocks.length;
    const requestedGap = options.gapPx ?? CONTEXT_BAR_GAP_PX;
    const requestedMin = options.minSegmentPx ?? CONTEXT_BAR_MIN_SEGMENT_PX;
    const safeWidth = Number.isFinite(width) && width > 0 ? width : CONTEXT_BAR_FALLBACK_WIDTH;

    if (n === 0)
        return {
            width: safeWidth,
            gapPx: 0,
            trackPx: safeWidth,
            minSegmentPx: 0,
            segments: [],
            rightEdge: 0
        };

    // Gaps first, but never so many that a segment loses its last pixel.
    const maxGap = n > 1 ? Math.max(0, Math.floor((safeWidth - n) / (n - 1))) : 0;
    const gapPx = Math.max(0, Math.min(requestedGap, maxGap));
    const trackPx = Math.max(0, safeWidth - gapPx * (n - 1));

    // Then the display floor, shrunk to what the track can actually afford.
    const minSegmentPx = Math.max(0, Math.min(requestedMin, trackPx > 0 ? trackPx / n : 0));
    const shares = contextBarSharesOf(blocks.map(contextBlockCharsOf), trackPx > 0 ? minSegmentPx / trackPx : 0);

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
            chars: contextBlockCharsOf(block),
            share: shares[i],
            x,
            width: painted
        });

        cursor = end + gapPx;
    }

    return {
        width: safeWidth,
        gapPx,
        trackPx,
        minSegmentPx,
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

// Server-only turn projector (R1/R3/R4).
//
// This is the fold the browser used to do. It turns ONE turn's recorded
// `HarnessEvent` stream into (a) a compact `TurnDisplay` tree, (b) a compact
// `TurnSummary` row, and (c) the `TurnDisplayOp`s that keep a live renderer in step.
// It is DOM-free, and it lives in `src/server` deliberately: the browser imports the
// TYPES from `../shared/turn-display.ts` and never this runtime, so a page pull adds
// no fold code and no module cycles.
//
// THE ONE RULE — live and replay are the same code path. The cold fold
// `projectTurn()` (restore, and every `getView`) is literally
// `createTurnProjector()` + `apply()` per recorded event + `settle()`. The recorder
// calls the identical `apply()` once per stored event (./sessions.ts:4217), so a
// reload paints exactly what the stream painted, and the compiled state is a CACHE
// the store updates as it goes — never a computation per request.
//
// Behavioural source of truth (each handler cites what it reproduces):
//   - ../frontend/ui/turns.ts:3969-4095  routing: explicit `thread` metadata is
//                                        authoritative; a conversation-root record
//                                        (no parent/call/kind/branch) is the TURN'S
//                                        OWN run, not a child; legacy events route to
//                                        the entry agent's root, else to the single
//                                        started non-terminal section for that agent,
//                                        else to an `inline:<agent>` section
//   - ../frontend/ui/turns.ts:4760-4910  pairing: `callId` is authoritative, the
//                                        name+oldest fallback is ONLY for a frame
//                                        with no id, a result for an already-settled
//                                        id is a duplicate and renders nothing, and a
//                                        result with no matching call is still shown
//   - ../frontend/ui/turns.ts:4496-4623  attempt windows: a `retry` discards exactly
//                                        the nodes, cards and delegation placeholders
//                                        THIS attempt created (a sibling's stay), and
//                                        `attempt_commit`/`done` close the window
//                                        without discarding and detach the writers
//   - ../frontend/ui/turns.ts:4262-4328  pending snapshot rules (an ABSENT `pending`
//                                        array is not a drain signal) plus the exact
//                                        wakeup / pending line texts. A transient
//                                        `retry` deliberately has NO line of its own
//                                        here (T16/R16a) — see the `retry` handler.
//   - ../frontend/ui/turns.ts:5154-5186  the parent's tool_result is the authoritative
//                                        completion of the child its call spawned
//   - ../frontend/ui/time.ts:19 and ./cli/render.ts:83  `formatDuration`
//   - ../frontend/ui/markdown.ts:474     `plainPreview`
//   - ../frontend/ui/references.ts:44    `isReferenceableBlock`
//   - ./sessions.ts:679                  a restored action request is EXPIRED
//
// What this file never does: it never edits the raw record (`turn.events` stays the
// authority and the lazy detail route serves those bytes verbatim), it never invents
// a value for an absent optional field, and it never renders a steer (steers are not
// events — `TurnSummary.steers` carries the destination section id, which is what the
// board consumes today via `turns.ts:390 tryRenderSteer`).

import type { HarnessEvent, HarnessPendingTool, HarnessToolOutcome } from '../harness';
import type { AgentResultBlock } from '../shared/agent-results';
import {
    DISPLAY_ARGS_PREVIEW_CHARS,
    DISPLAY_ATTACHMENT_INLINE_CHARS,
    DISPLAY_BLOCK_PREVIEW_CHARS,
    DISPLAY_ERROR_CHARS,
    DISPLAY_MEDIA_PER_STEP,
    DISPLAY_NODE_PREVIEW_CHARS,
    DISPLAY_NOTICE_CHARS,
    DISPLAY_PANEL_PREVIEW_CHARS,
    DISPLAY_PANEL_TITLE_CHARS,
    DISPLAY_PANELS_PER_STEP,
    DISPLAY_PREVIEW_CHARS
} from '../shared/turn-display';
import type {
    ContextBlock,
    ContextBlockKind,
    ContextBlockPatch,
    DisplayActionSummary,
    DisplayMediaSummary,
    DisplayNode,
    DisplayPanelBlockSummary,
    DisplayPanelSummary,
    DisplayProjectContext,
    DisplayReasoningNode,
    DisplayRole,
    DisplayStep,
    DisplayTail,
    DisplayTailKind,
    DisplayTextNode,
    DisplayedTurn,
    SectionDisplayState,
    StepDisplayState,
    TurnDisplay,
    TurnDisplayOp,
    TurnInstructionSource,
    TurnProjector,
    TurnRecordStatus,
    TurnSection,
    TurnSectionPatch,
    TurnSummary
} from '../shared/turn-display';
import type { SessionTurn } from './protocol';

// The turn's own root flow. INTERNAL key only: a section's wire identity is always
// its minted `${turnId}:${ordinal}` id, which is why a delegation placeholder can
// keep its id when a child `start` later adopts it. The browser had to re-key the
// row for that same moment (turns.ts:3960); the display model never does, so an
// expanded/anchored row cannot be lost mid-run.
const ROOT_KEY = 'root';

// A section's mutable status line ("pending · read 1.2s"). Stable per section, not
// derived from an event index, because it is one line that keeps being rewritten.
const PENDING_NODE_ID = 'pending';

const inlineKey = (agent: string): string => `inline:${agent}`;

// ---------------------------------------------------------------------------
// Text bounds shared with the renderer (mirrors, each cited)
// ---------------------------------------------------------------------------

/** Mirror of `formatDuration` (../frontend/ui/time.ts:19, copied by the CLI at
 *  ./cli/render.ts:83). The notice TEXT is composed here now, so all three surfaces
 *  keep one rule or a reader sees two different durations for one call. */
export const formatDuration = (milliseconds: number): string => {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return '';

    const rounded = Math.round(milliseconds);
    if (rounded < 1000) return `${rounded}ms`;
    if (rounded < 60_000) return `${(rounded / 1000).toFixed(1)}s`;

    const seconds = Math.floor(rounded / 1000);
    return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
};

/** Mirror of `plainPreview` (../frontend/ui/markdown.ts:474). Copied rather than
 *  imported because that module is frontend-owned; the rule itself is pure regex. */
/** The markdown-stripping, whitespace-collapsing form of a recorded body (shared by both
 *  preview directions, so there is ONE definition of "flattened for display"). Mirror of
 *  `plainPreview` (../frontend/ui/markdown.ts:474). */
const flattenForDisplay = (text: string): string => {
    const source = typeof text === 'string' ? text : '';

    return source
        .replace(/```[^\n]*\n?/g, ' ')
        .replace(/!\[([^\]]*)]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
        .replace(/`/g, '')
        .replace(/[*_~>#]+/g, ' ')
        .replace(/\|/g, ' ')
        .replace(/^\s*[-=]{3,}\s*$/gm, ' ')
        .replace(/\s+/g, ' ')
        .replace(/\s+([.,!?;:])/g, '$1')
        .trim();
};

export const previewText = (text: string, limit: number): string => {
    const flattened = flattenForDisplay(text);

    if (flattened.length <= limit) return flattened;

    return `${flattened.slice(0, Math.max(0, limit - 1)).trimEnd()}\u2026`;
};

/**
 * The prose-node bound, from the END (T26, R26): the LATEST characters of a body, not the
 * earliest.
 *
 * `previewText` answers "what is this block about" out of its opening, which is the right
 * shape for a one-line step, panel or notice summary. A thinking window's NODE body is a
 * different object: it is the text a reader watches GROW, and a preview pinned to its first
 * 320 characters is what left the pane showing the same static opening line. Bounding from
 * the end keeps the newest bytes on the wire, so a live stream, a reconnect and a cold reload
 * all show the same latest lines — and it matches the render-side window the browser applies
 * to a whole body (../frontend/view-context.ts `contextTextSuffixOf`), which is what makes
 * the two bounds one policy instead of two.
 *
 * Cutting is display-only, exactly like the head bound: the projector's internal node keeps
 * every recorded byte, the exact `chars` figure still rides the wire beside the marker, and
 * the lazy block/step routes answer with the whole payload. The window opens on a whole code
 * point — a flattened summary has no combining marks left to split, but an emoji survives.
 */
export const previewTextTail = (text: string, limit: number): string => {
    const flattened = flattenForDisplay(text);
    const bound = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 0;

    if (flattened.length <= bound) return flattened;

    let cut = Math.max(0, flattened.length - Math.max(0, bound - 1));

    // Never open the window between the halves of a surrogate pair.
    const unit = flattened.charCodeAt(cut);

    if (cut > 0 && cut < flattened.length && unit >= 0xdc00 && unit <= 0xdfff) cut += 1;

    return `\u2026${flattened.slice(cut).trimStart()}`;
};

// `arguments` is the raw provider JSON string (types/index.ts:100-111) and stays
// unparsed for display: malformed JSON is the model's problem, not the preview's.
const previewArguments = (raw: unknown): string =>
    previewText(typeof raw === 'string' ? raw.replace(/\s*\n\s*/g, ' ') : '', DISPLAY_ARGS_PREVIEW_CHARS);

const outcomeState = (outcome: HarnessToolOutcome): StepDisplayState =>
    outcome === 'completed' ? 'ok' : outcome === 'cancelled' ? 'cancelled' : 'error';

// `isError` is the boolean projection of `outcome` (types/index.ts:1816-1825), so a
// frame that predates `outcome` still reads correctly.
const outcomeOfResult = (event: HarnessEvent): HarnessToolOutcome => {
    if (event.type !== 'tool_result') return 'completed';

    const outcome = event.outcome;

    if (outcome === 'completed' || outcome === 'failed' || outcome === 'rejected' || outcome === 'cancelled') return outcome;

    return event.isError ? 'failed' : 'completed';
};

const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

// A usable epoch-ms timestamp, or `undefined` for "the record does not say". 0 is the
// projector's documented sentinel (DISPLAY_NO_TIMESTAMP below), and no block, notice or
// duration may report a time the record does not actually hold.
const finiteAtValue = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

/**
 * The context-segment key of one recorded steered submit.
 *
 * A submit with a recorded `id` (T13 — the server mints one with `randomUUID()` when it
 * accepts the guidance, and the durable document keeps it) is keyed by THAT: the identity
 * is intrinsic to the submit, so it cannot collide with another submit, cannot be
 * renumbered when the bounded `SessionTurn.steers` ring (./sessions.ts
 * `MAX_STEER_RECORDS`) truncates an older entry, and still resolves after a restart. The
 * `i` prefix keeps it distinguishable from the derived form below and from the fixed
 * `prompt` / `instructions` keys, and a UUID is URL-safe, so the block route needs no
 * escaping beyond what the id already has.
 *
 * A submit with NO id — a record written before the field existed — falls back to the
 * derived key: its own timestamp plus the length of its text, position-independent for the
 * same ring reason. `occurrence` numbers repeats of that derived pair (`-1`, `-2`) so two
 * submits in one millisecond with equal text length keep one segment each instead of
 * collapsing into the first one (R6 counts every segment exactly once).
 *
 * Exported because the store resolves a clicked segment back to the recorded submit with
 * the SAME keys (./sessions.ts `blockDetail`); one definition, no drift.
 */
export const steerBlockKeyOf = (steer: { id?: string; at?: number; prompt: string }, occurrence = 0): string => {
    const recorded = typeof steer?.id === 'string' ? steer.id.trim() : '';

    if (recorded.length > 0) return `i${recorded}`;

    const base = `s${finiteAtValue(steer?.at) ?? 0}-${typeof steer?.prompt === 'string' ? steer.prompt.length : 0}`;

    return occurrence > 0 ? `${base}-${occurrence}` : base;
};

/**
 * The COMPLETE list of submits one turn recorded, in the order the server accepted them —
 * the single source both the fold and the store resolve a steered context segment from.
 *
 * T14/T15: `steers` is the bounded operational AUDIT ring (a rolling 64 entries,
 * ../server/sessions.ts `MAX_STEER_RECORDS`) and `steerTexts` is the durable TEXT archive —
 * EVERY submit the turn accepted, keyed by its own id, and NOT truncated itself (an accepted
 * submit is user data, so the archive keeps all of it; only the audit ring rolls). The merged
 * list is therefore:
 *   1. the submits the archive does not name — only possible on a record written before the
 *      archive existed (or before submits carried ids) — kept in front, where they belong in
 *      time; then
 *   2. the archive, in acceptance order.
 * Idempotent and deterministic in both directions: the live fold and a cold replay merge the
 * same two arrays the same way, so the bar mints the same segments, and `blockDetail` finds
 * the same submit for the same key. Without this merge a 65th steer would have stranded the
 * bar's own segment for an older guidance text: the segment stays displayed, and its click
 * still answers with the exact recorded prompt.
 */
export const steerSubmitList = <
    T extends { id?: string; at?: number; prompt: string; threadId?: string }
>(turn: { steers?: readonly T[]; steerTexts?: readonly T[] }): T[] => {
    const archive = Array.isArray(turn.steerTexts) ? [...turn.steerTexts] : [];
    const archived = new Set(archive.map((submit) => (typeof submit?.id === 'string' ? submit.id : '')));
    const ring = Array.isArray(turn.steers) ? [...turn.steers] : [];
    // A submit the archive does not name (no id, or an older document): it is older than
    // anything the archive holds, so it keeps its recorded position at the front.
    const legacy = ring.filter((submit) => !(typeof submit?.id === 'string' && archived.has(submit.id)));

    return [...legacy, ...archive];
};

/**
 * One key per recorded submit, in array order. Idented submits are keyed by their own
 * identity and never participate in the fallback numbering; a keyless submit is numbered
 * against the earlier keyless submits that share its derived `(at, length)` pair.
 * Deterministic and shared: the fold mints segments with these
 * (./turn-projector.ts `syncSteerBlocks`) and the store matches a clicked segment back to
 * its bytes with the same list, so minting and lookup cannot drift, and a live stream and a
 * cold replay number the same prefix identically (the list only ever grows at the end).
 */
export const steerBlockKeysOf = (steers: readonly { id?: string; at?: number; prompt: string }[]): string[] => {
    const seen = new Map<string, number>();

    return steers.map((steer) => {
        const value = steer ?? ({ prompt: '' } as { id?: string; at?: number; prompt: string });
        const recorded = typeof value.id === 'string' ? value.id.trim() : '';

        // An idented submit needs no numbering: its identity already IS the key.
        if (recorded.length > 0) return `i${recorded}`;

        const derived = steerBlockKeyOf(value);
        const occurrence = seen.get(derived) ?? 0;

        seen.set(derived, occurrence + 1);

        return steerBlockKeyOf(value, occurrence);
    });
};

/**
 * The growth patch of a prose/think window: the exact running character count, the
 * last event index the window consumed, and the recorded span — but ONLY once a second
 * recorded event proves the window bracketed real time (`openedAt < stamp`). A
 * one-event window reports no duration at all, because the record cannot bracket it and
 * a fabricated `0` would read as "instantaneous" (../shared/turn-display.ts
 * `ContextBlock.durationMs`).
 */
export const flowWindowPatch = (
    openedAt: number | undefined,
    stamp: number | undefined,
    chars: number,
    index: number
): ContextBlockPatch => {
    const patch: ContextBlockPatch = { chars, eventTo: index };

    if (openedAt !== undefined && stamp !== undefined && stamp > openedAt) patch.durationMs = stamp - openedAt;

    return patch;
};

// A `pending` array only counts when every entry is usable — the same validator the
// browser applies (../frontend/contract.ts:651). An ABSENT array is a different
// answer, and the caller must keep that distinction.
const pendingOf = (value: unknown): HarnessPendingTool[] | undefined => {
    if (!Array.isArray(value)) return undefined;

    const clean: HarnessPendingTool[] = [];

    for (const entry of value) {
        if (typeof entry !== 'object' || entry === null) continue;

        const candidate = entry as { callId?: unknown; name?: unknown; elapsedMs?: unknown };
        if (typeof candidate.callId !== 'string' || candidate.callId.length === 0) continue;
        if (typeof candidate.name !== 'string' || candidate.name.length === 0) continue;
        if (!finiteNumber(candidate.elapsedMs) || candidate.elapsedMs < 0) continue;

        clean.push({ callId: candidate.callId, name: candidate.name, elapsedMs: candidate.elapsedMs });
    }

    return clean;
};

// The delegation placeholder the tile mints when it SEES a `delegate` call
// (turns.ts:4807): the child row must exist before its `start`, keyed by the
// spawning call id. Same tolerant parse; a malformed argument blob simply yields no
// placeholder rather than a phantom row.
const delegateOf = (raw: unknown): { agent: string; input?: string } | undefined => {
    if (typeof raw !== 'string' || raw.length === 0) return undefined;

    try {
        const parsed = JSON.parse(raw) as { agent?: unknown; input?: unknown };

        if (typeof parsed.agent !== 'string' || parsed.agent.length === 0) return undefined;

        return { agent: parsed.agent, ...(typeof parsed.input === 'string' ? { input: parsed.input } : {}) };
    } catch {
        return undefined;
    }
};

// ---------------------------------------------------------------------------
// Bounded panel/media summaries (T3 qualification: never the unbounded originals)
// ---------------------------------------------------------------------------
//
// One result may legitimately carry 32 panels x 64 blocks and up to 256 KiB of cell
// text (core/tool-ui.ts:51-73). Forwarding that per step is the payload this whole
// change exists to remove, so the compact wire carries identity + counts + a first
// line, and says how much it left behind. Nothing is silently dropped: `truncated`
// and `totalPanels` point the renderer at the detail request, which answers with the
// verbatim event (and therefore the verbatim panels).

const panelSummaryOf = (panel: unknown, totalPanels: number): DisplayPanelSummary => {
    const source = (panel ?? {}) as { id?: unknown; slot?: unknown; title?: unknown; blocks?: unknown };
    const blocks = Array.isArray(source.blocks) ? source.blocks : [];
    const summaries: DisplayPanelBlockSummary[] = [];
    let preview: string | undefined;
    let truncated = false;

    for (const raw of blocks) {
        const block = (raw ?? {}) as Record<string, unknown>;

        if (block.type === 'text') {
            const text = typeof block.text === 'string' ? block.text : '';
            summaries.push({ type: 'text', length: text.length });
            truncated = truncated || text.length > DISPLAY_PANEL_PREVIEW_CHARS;
            preview ??= previewText(text, DISPLAY_PANEL_PREVIEW_CHARS);
            continue;
        }

        if (block.type === 'table') {
            const columns = Array.isArray(block.columns) ? (block.columns as unknown[]) : [];
            const rows = Array.isArray(block.rows) ? (block.rows as unknown[]) : [];
            summaries.push({ type: 'table', rows: rows.length, columns: columns.length });
            // Cell TEXT is the bulk of a panel, so it is detail-only by construction.
            truncated = true;
            const first = Array.isArray(rows[0]) ? (rows[0] as unknown[]) : [];
            preview ??= previewText(
                `${columns.map((cell) => String(cell ?? '')).join(' ')} \u00b7 ${first.map((cell) => String(cell ?? '')).join(' ')}`,
                DISPLAY_PANEL_PREVIEW_CHARS
            );
            continue;
        }

        if (block.type === 'keyValue') {
            const items = Array.isArray(block.items) ? (block.items as { label?: unknown; value?: unknown }[]) : [];
            summaries.push({ type: 'keyValue', items: items.length });
            truncated = true;
            preview ??= previewText(
                items
                    .slice(0, 2)
                    .map((item) => `${String(item?.label ?? '')} ${String(item?.value ?? '')}`)
                    .join(' \u00b7 '),
                DISPLAY_PANEL_PREVIEW_CHARS
            );
        }
    }

    const title = typeof source.title === 'string' ? source.title : '';

    return {
        id: typeof source.id === 'string' ? source.id.slice(0, 64) : '',
        // `slot` is an OPEN string by contract, with 'right' the default mount
        // (types/index.ts:1005-1017).
        slot: typeof source.slot === 'string' && source.slot.length > 0 ? source.slot.slice(0, 32) : 'right',
        title: previewText(title, DISPLAY_PANEL_TITLE_CHARS),
        blocks: summaries,
        ...(preview === undefined || preview.length === 0 ? {} : { preview }),
        truncated,
        totalPanels
    };
};

const summarizePanels = (ui: unknown): { panels?: DisplayPanelSummary[] } => {
    if (!Array.isArray(ui) || ui.length === 0) return {};

    const panels = ui.slice(0, DISPLAY_PANELS_PER_STEP).map((panel) => panelSummaryOf(panel, ui.length));

    if (ui.length > panels.length) {
        // Extra panels exist: mark the FIRST summary truncated too, so a renderer
        // offers the detail without needing a second signal.
        panels[panels.length - 1] = { ...panels[panels.length - 1], truncated: true };
    }

    return { panels };
};

const summarizeMedia = (media: unknown): { media?: DisplayMediaSummary[] } => {
    if (!Array.isArray(media) || media.length === 0) return {};

    const clean = (media as unknown[])
        .map((entry) => (entry ?? {}) as { id?: unknown; kind?: unknown; name?: unknown; mime?: unknown; size?: unknown })
        .filter((entry) => typeof entry.id === 'string' && entry.id.length > 0)
        .filter((entry) => entry.kind === 'image' || entry.kind === 'video' || entry.kind === 'audio' || entry.kind === 'pdf' || entry.kind === 'file')
        .filter((entry) => typeof entry.name === 'string' && typeof entry.mime === 'string' && finiteNumber(entry.size))
        .slice(0, DISPLAY_MEDIA_PER_STEP)
        .map(
            (entry): DisplayMediaSummary => ({
                id: entry.id as string,
                kind: entry.kind as DisplayMediaSummary['kind'],
                name: entry.name as string,
                mime: entry.mime as string,
                size: entry.size as number
            })
        );

    return clean.length === 0 ? {} : { media: clean };
};

// ---------------------------------------------------------------------------
// Internal shapes
// ---------------------------------------------------------------------------

// Everything the CURRENT (uncommitted) model request produced. A `retry` removes
// exactly these ids (turns.ts:4496), which is why the client needs no attempt-window
// concept of its own.
type AttemptWindow = {
    nodeIds: string[];
    stepIds: string[];
    // Bar segments this attempt minted, so a `retry` removes exactly its own
    // segments and a sibling's stay (the same scoping as `nodeIds`).
    blockIds: string[];
    // Prose windows opened by this attempt, in order. A `done` frame mints an
    // `assistant` segment from the message content ONLY when this stayed empty —
    // otherwise the deltas already counted the same bytes.
    textKeys: string[];
    // Placeholder rows this attempt minted. A failed attempt never executed its
    // calls, so its child row goes with it — and only its own (F2).
    sectionKeys: string[];
    // Call ids this attempt opened, so a discard un-pairs them WITHOUT marking them
    // settled: a retried request may legally re-issue the same id (turns.ts:4521).
    callIds: string[];
};

type SectionRecord = {
    section: TurnSection;
    key: string;
    ordinal: number;
    agent: string;
    attempt?: AttemptWindow;
    // The live stream writers. Closing one detaches the pointer; the node stays.
    // Each writer names the context segment it is counting, so a delta updates the
    // segment's exact length without a search.
    text?: DisplayNode & { kind: 'text' };
    reasoning?: DisplayNode & { kind: 'reasoning' };
    textBlockId?: string;
    reasoningBlockId?: string;
    // The recorded time each writer OPENED with, so the segment can report the span of
    // its window once a second event proves one (and never before).
    textOpenedAt?: number;
    reasoningOpenedAt?: number;
    // R23 (T23): the stamp of the tail descriptor this section CURRENTLY publishes
    // (`tailStampOf`). The designation is recomputed at the end of every frame, and only
    // a stamp that actually moved costs an op — so a 500-delta thinking window sends one
    // `tail:set`, not 500. Kept beside the section rather than derived from
    // `section.tail` because `chars` moves every delta and deliberately does NOT
    // re-publish the descriptor (the exact figure rides `context:set`).
    tailStamp?: string;
    // R2 (T1): this section's NEWEST `kind:'text'` node id — the second full-text carrier
    // (`isFullCarrier`) — cached so no projection has to walk the array per node (P3):
    // `display()` maps EVERY node and `insertNode` projects the node it appends, so a
    // per-node backward scan would cost O(prose x nodes) on a long call run after the last
    // answer. Reads are O(1); the scan runs only where the value can actually change.
    //
    // INVARIANT: always `latestTextNodeIdOf(record)`. Maintained at every site that can move
    // it, and documented at the ones that cannot:
    //   - `insertNode` — nodes only append at the end, so an appended ANSWER IS the newest
    //     one (written there, before the wire copy of that insert);
    //   - `pushStep` / `syncPendingLine`'s push — append a step / a `notice`, never prose;
    //   - `discardAttempt` — its filter CAN drop the carrier, so it re-derives after running
    //     (one scan per discarded attempt, not per node);
    //   - `syncPendingLine`'s removal filter — drops only `PENDING_NODE_ID`, which is never a
    //     text node id (`n<eventIndex>`), so it cannot invalidate the cache;
    //   - `newSection` starts `nodes: []`, so `undefined` IS the derived value at creation.
    latestTextNodeId?: string;
    // This invocation's authoritative pending snapshot (turns.ts:4287).
    pendingCalls: Map<string, HarnessPendingTool>;
    started: boolean;
    terminal: boolean;
    placeholder: boolean;
    // The spawning call id of a delegation placeholder. Kept so a removal (a failed
    // attempt, or a turn that ended before the child ran) un-registers the join, and
    // so ADOPTION keeps the call -> child mapping alive: the parent's `tool_result`
    // still has to settle the child after the adoption (turns.ts:5154).
    spawnCallId?: string;
    latestInput?: number;
    cachedInput?: number;
    cachedReported: boolean;
};

// A step plus its detail addressing, kept together so the op stream and the lazy
// detail route can never disagree about which event opened and which settled it.
// `blockId` is the SAME pairing for the context bar: one recorded call is ONE
// segment, updated (never re-minted) when its result lands.
type StepRecord = {
    step: DisplayStep;
    sectionKey: string;
    openingIndex: number;
    resultIndex?: number;
    blockId?: string;
};

// Where a section's ONE system block and the turn's prompt block rank inside the
// bar. The system message heads every request and the prompt heads the turn, so both
// precede the event-derived segments regardless of what the record timestamps.
const BLOCK_RANK_SYSTEM = 0;
const BLOCK_RANK_PROMPT = 1;
const BLOCK_RANK_FLOW = 2;

// A block's rank is derivable from the block itself, using only server-decided
// identity fields: the fixed `instructions`/`prompt` names (see `ContextBlock.name`)
// vs every flow segment.
const blockRankOf = (block: ContextBlock): number => {
    if (block.kind === 'system') return BLOCK_RANK_SYSTEM;
    if (block.kind === 'user' && block.name === 'prompt') return BLOCK_RANK_PROMPT;

    return BLOCK_RANK_FLOW;
};

const sectionStateOf = (status: TurnRecordStatus): SectionDisplayState =>
    status === 'done'
        ? 'done'
        : status === 'error'
          ? 'error'
          : status === 'cancelled'
            ? 'cancelled'
            : status === 'running'
              ? 'streaming'
              : 'open';

const abandonedStateOf = (status: TurnRecordStatus): StepDisplayState => (status === 'cancelled' ? 'cancelled' : 'error');

const TURN_STATE_OF: Record<TurnRecordStatus, 'queued' | 'streaming' | 'done' | 'error' | 'cancelled'> = {
    queued: 'queued',
    running: 'streaming',
    done: 'done',
    error: 'error',
    cancelled: 'cancelled'
};

const isTerminalStatus = (status: TurnRecordStatus): boolean => status === 'done' || status === 'error' || status === 'cancelled';

// Duplicate-result suppression is scoped to the INVOCATION. Call ids are unique per
// conversation (types/index.ts:104), and a delegated child may legally reuse the id
// its parent used for the delegation — a turn-wide "already settled" set would then
// drop the parent's real result.
const settleKey = (sectionKey: string, callId: string): string => `${sectionKey}\u0000${callId}`;

const copyValue = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const textOf = (value: unknown, limit: number): string => previewText(typeof value === 'string' ? value : '', limit);

const messageOf = (value: unknown): string => {
    const error = (value ?? {}) as { message?: unknown };

    return typeof error.message === 'string' ? error.message : '';
};

/**
 * Incremental fold for ONE live turn.
 *
 * `turn` is held BY REFERENCE on purpose: the store mutates `status`, `updatedAt`,
 * `steers` and `usage` on that same record, and the row must reflect the server's
 * truth without a second call. `apply()` itself is still a pure event -> ops map for
 * the node tree.
 */
export const createTurnProjector = (turn: SessionTurn, context: DisplayProjectContext): TurnProjector => {
    const sections: SectionRecord[] = [];
    const byKey = new Map<string, SectionRecord>();
    const byInvocation = new Map<string, SectionRecord>();
    const byCall = new Map<string, SectionRecord>();
    const byBranch = new Map<string, SectionRecord>();

    // Open calls in call order. The pairing search prefers the RESULT's own section
    // and only then falls back turn-wide, so a `call_1` id reused by a nested
    // invocation of the SAME turn cannot settle the root's call of the same name —
    // the scoping the T3 contract requires of the detail route.
    const openCalls: StepRecord[] = [];
    const settledCalls = new Set<string>();
    const steps = new Map<string, StepRecord>();
    const actionSteps = new Map<string, StepRecord>();

    let sectionOrdinal = 0;
    let stepCount = 0;
    // The newest request seen ANYWHERE in the turn. This is ONLY the think-chip share
    // denominator (`applyShares`), never a displayed figure: a denominator is a scale,
    // so "the biggest context this turn ever worked in" is the honest choice there.
    let turnLatestInput: number | undefined;
    // T3 (user-reported display bug): the turn-level PRIMARY figure — `TurnSummary.latestInput`
    // and the `sectionId:'turn'` usage op — must describe the TURN'S OWN (root section) latest
    // model request. Before this, `turnLatestInput` was republished from the last usage event of
    // ANY section, so on a turn whose delegated child reported last the parent task part's row
    // printed the CHILD's context (e.g. parent row `100,666 (27,668,349)` while the figure shown
    // was subagent RR4's 100,666) — the emission-order rule that `turn-projector.test.ts` used to
    // pin as intended. The user declared that display wrong, so the rule is REVERSED here: root
    // frames only, and `undefined` (not a stand-in) when the root section made no request.
    // The bracket (`turn.usage`, folded turn-wide by ../sessions.ts `addUsage` ~1064) is
    // unchanged accounting and keeps folding children.
    let rootLatestInput: number | undefined;
    let lastError: string | undefined;
    let settledStatus: TurnRecordStatus | undefined;
    let settledAt: number | undefined;
    // The timestamp of the most recently folded event (undefined for a record with no
    // `eventTimes`). Reads use it as the steer-adoption gate so a poll and a live
    // watcher adopt a steered submit at the same point of the stream.
    let lastAppliedStamp: number | undefined;

    // Memoization: `listViews()`/`getView()` ask for the same row on every render,
    // and rebuilding it walks the tree and re-projects blocks. The stamp covers
    // every input the row derives from.
    let summaryStamp = '';
    let summaryCache: TurnSummary | undefined;
    let blocksCache: AgentResultBlock[] = [];
    let blocksStamp = '';

    const invalidate = (): void => {
        summaryCache = undefined;
    };

    // -----------------------------------------------------------------------
    // Sections
    // -----------------------------------------------------------------------

    const newSection = (key: string, agent: string, parentKey: string | undefined, placeholder: boolean): SectionRecord => {
        // R18/T20: a parent is resolved through BOTH identity maps, and the second one is
        // not redundant.
        //   - `byKey` holds SECTION keys: `ROOT_KEY`, an invocation id only AFTER a row was
        //     adopted/created with that id, `call:<callId>` for an un-adopted placeholder,
        //     `inline:<agent>` for a threadless flow.
        //   - `byInvocation` holds the runtime INVOCATION ids the same rows answer frames
        //     with, including the turn's own flow, which is registered under `ROOT_KEY`
        //     while its frames name its invocation (see `route`'s conversation-root branch).
        //
        // A child's `thread.parentId`, and a branch's `sourceThreadId`
        // (../types/index.ts:930 — "the INVOCATION identity of the requester"), are
        // therefore NOT section keys when the requester is the turn's own flow. Before the
        // second lookup, such a child only got a `parentSectionId` if its spawn `delegate`
        // call happened to be recorded first (the placeholder path passes
        // `record.key`, a section key); with no preceding call frame — a hand-written
        // reporter, a dropped/spawn call with unparseable args, a root-requested fork — the
        // parent resolved to `undefined` and the hierarchy link was lost on the wire even
        // though the fold knows exactly who spawned it.
        const parent =
            parentKey === undefined ? undefined : byKey.get(parentKey) ?? byInvocation.get(parentKey);
        const ordinal = sectionOrdinal++;
        const role: DisplayRole =
            parent === undefined && key === ROOT_KEY ? (agent === context.primary ? 'primary' : 'subagent') : 'subagent';

        const record: SectionRecord = {
            key,
            ordinal,
            agent,
            placeholder,
            started: !placeholder,
            terminal: false,
            pendingCalls: new Map(),
            cachedReported: false,
            section: {
                id: `${turn.id}:${ordinal}`,
                ...(parent === undefined ? {} : { parentSectionId: parent.section.id }),
                role,
                agent,
                // Labels arrive with the store's block projection / thread join; an
                // adopted child patches its own conversation label (R8/T14).
                agentLabel: key === ROOT_KEY ? turn.threadLabel ?? '' : '',
                ...(turn.threadId === undefined ? {} : { threadId: key === ROOT_KEY ? turn.threadId : undefined }),
                nodes: [],
                // The bar is always present on a server-produced section: `[]` is the
                // authoritative "nothing to report", while an absent field means a
                // producer that said nothing at all (../shared/turn-display.ts).
                context: [],
                state: 'open'
            }
        };

        // `threadId: undefined` must not become an own-key with an undefined value
        // (the whole codebase omits absent fields so old shapes stay byte-identical).
        if (record.section.threadId === undefined) delete record.section.threadId;

        sections.push(record);
        byKey.set(key, record);

        return record;
    };

    const conversationLabelOf = (invocationId: string | undefined): string | undefined =>
        invocationId === undefined ? undefined : context.threadLabels?.get(invocationId);

    // R18/T18: the PERSISTENT conversation one invocation ran in. The store owns this
    // join (../sessions.ts `Session.invocationThreads`, handed in as
    // `DisplayProjectContext.invocationThreadIds`) and it is LIVE, so a delegated
    // child's entry already exists by the time its own `start` frame is folded
    // (../sessions.ts records it immediately BEFORE `projector.apply`). The fold reads
    // it and mints nothing: `undefined` means "no recorded join", and the section then
    // omits `threadId` exactly as a pre-T18 record does.
    const conversationThreadIdOf = (invocationId: string | undefined): string | undefined =>
        invocationId === undefined ? undefined : context.invocationThreadIds?.get(invocationId);

    const openSection = (record: SectionRecord, ops: TurnDisplayOp[]): void => {
        ops.push({ op: 'section:open', turnId: turn.id, section: { ...copyValue(record.section), nodes: [] } });
        invalidate();
    };

    const patchSection = (record: SectionRecord, patch: TurnSectionPatch, ops: TurnDisplayOp[]): void => {
        const meaningful = Object.keys(patch).length > 0;

        if (!meaningful) return;

        Object.assign(record.section, patch);
        ops.push({ op: 'section:set', turnId: turn.id, sectionId: record.section.id, patch: copyValue(patch) });
        invalidate();
    };

    const removeSection = (record: SectionRecord, ops: TurnDisplayOp[]): void => {
        byKey.delete(record.key);
        if (record.spawnCallId !== undefined && byCall.get(record.spawnCallId) === record) byCall.delete(record.spawnCallId);
        if (record.section.invocationId !== undefined) byInvocation.delete(record.section.invocationId);
        if (record.section.branchId !== undefined) byBranch.delete(record.section.branchId);

        const index = sections.indexOf(record);
        if (index >= 0) sections.splice(index, 1);

        for (const step of [...steps.values()]) {
            if (step.sectionKey !== record.key) continue;
            steps.delete(step.step.id);
        }

        for (let position = openCalls.length - 1; position >= 0; position -= 1) {
            if (openCalls[position].sectionKey === record.key) openCalls.splice(position, 1);
        }

        ops.push({ op: 'section:remove', turnId: turn.id, sectionId: record.section.id });
        invalidate();
    };

    const rootSection = (agent: string): SectionRecord => {
        const existing = byKey.get(ROOT_KEY);
        if (existing !== undefined) return existing;

        const record = newSection(ROOT_KEY, agent, undefined, false);

        return record;
    };

    // A thread record with no parent, no spawning call, no kind and no branch is the
    // turn's OWN conversation (turns.ts:4063 — the same discriminator
    // ../shared/agent-results.ts uses), never an agent-spawned child.
    const isConversationRoot = (meta: NonNullable<HarnessEvent['thread']>): boolean =>
        meta.parentId === undefined && meta.callId === undefined && meta.kind === undefined && meta.branchId === undefined;

    const adoptPlaceholder = (record: SectionRecord, meta: NonNullable<HarnessEvent['thread']>, ops: TurnDisplayOp[]): void => {
        byKey.delete(record.key);
        record.key = meta.id;
        byKey.set(meta.id, record);
        // The spawn join STAYS: the parent's `tool_result` for this call settles the
        // child after the adoption too (turns.ts:5154).
        record.placeholder = false;
        record.started = true;

        if (!record.terminal) record.section.state = 'streaming';
        record.section.invocationId = meta.id;
        if (meta.branchId !== undefined) record.section.branchId = meta.branchId;
        byInvocation.set(meta.id, record);

        const label = conversationLabelOf(meta.id);
        // R18/T18: an adopted placeholder IS a delegated conversation (its spawn frame
        // named the parent's `delegate` call), so the join is looked up on the invocation
        // id this frame carries. A row that already names a conversation keeps it — the
        // `branch_start` frame's own `threadId` is direct evidence, this join is only a
        // fallback — and a row with no join stays exactly as it was before.
        const threadId = record.section.threadId ?? conversationThreadIdOf(meta.id);

        if (threadId !== undefined) record.section.threadId = threadId;

        patchSection(
            record,
            {
                invocationId: meta.id,
                ...(meta.branchId === undefined ? {} : { branchId: meta.branchId }),
                ...(record.terminal ? {} : { state: 'streaming' }),
                ...(threadId === undefined ? {} : { threadId }),
                ...(label === undefined ? {} : { agentLabel: label, threadLabel: label })
            },
            ops
        );
    };

    const createChild = (
        meta: NonNullable<HarnessEvent['thread']>,
        agent: string,
        ops: TurnDisplayOp[],
        options: { state?: SectionDisplayState; branchId?: string; model?: string; role?: DisplayRole; threadId?: string } = {}
    ): SectionRecord => {
        const record = newSection(meta.id, agent, meta.parentId, false);

        byInvocation.set(meta.id, record);
        if (meta.callId !== undefined) byCall.set(meta.callId, record);
        if (meta.branchId !== undefined) byBranch.set(meta.branchId, record);
        if (options.branchId !== undefined) byBranch.set(options.branchId, record);

        const label = conversationLabelOf(meta.id);

        record.section.role = options.role ?? 'subagent';
        record.section.invocationId = meta.id;
        record.section.branchId = options.branchId ?? meta.branchId;
        record.section.model = options.model;
        // R18/T18: a frame-supplied id (a branch names its source conversation) wins;
        // otherwise the store's invocation → conversation join is adopted verbatim, so a
        // delegated child is born addressable instead of indistinguishable from its
        // parent's flow. `undefined` omits the field on the wire, as before.
        record.section.threadId = options.threadId ?? conversationThreadIdOf(meta.id);
        record.section.agentLabel = label ?? '';
        record.section.threadLabel = label;
        record.section.state = options.state ?? 'streaming';

        openSection(record, ops);

        return record;
    };

    // A threadless stream from a non-entry agent still needs a flow of its own
    // (turns.ts:4039) so its prose and calls are not dropped.
    const inlineSection = (agent: string, ops: TurnDisplayOp[]): SectionRecord => {
        const key = inlineKey(agent);
        const existing = byKey.get(key);
        if (existing !== undefined) return existing;

        const record = newSection(key, agent, undefined, false);
        record.section.role = agent === context.primary ? 'primary' : 'subagent';

        openSection(record, ops);

        return record;
    };

    const queuedPlaceholder = (agent: string): SectionRecord | undefined =>
        sections.find((record) => record.placeholder && record.agent === agent);

    // R18/T18: adopt a delegated conversation's id for sections that were folded BEFORE
    // the store could record the join, and emit the `section:set` patch for it.
    //
    // The normal live path needs nothing here: the recorder writes the invocation →
    // conversation entry at the child's own `start` frame, immediately BEFORE folding it
    // (../sessions.ts:5478-5504), and a cold replay folds with the fully loaded map — so
    // `adoptPlaceholder`/`createChild` mint the id and this pass is a no-op. What it
    // covers is the honest late case: a projector created from a document whose roster
    // did not yet name the conversation, a host-supplied runtime that binds the roster
    // slot after the run starts, or a reporter whose child frames precede the identity
    // write. Without this pass such a section would stream its whole life without an
    // address, and the id would only appear after a restart.
    //
    // Rules, in order, each one a case that must NOT change:
    //   - the ROOT section is skipped: its conversation is `turn.threadId`, which the
    //     record states directly (the join never overrides the record);
    //   - a section that already names a thread keeps it (first evidence wins, so a
    //     `branch_start` frame's `threadId` is never replaced by a join lookup);
    //   - a BRANCH section is skipped: a branch owns no persistent conversation, the
    //     store never records a join for its frames, and its id is not an invocation id;
    //   - an un-adopted placeholder has no `invocationId` and is therefore skipped by the
    //     second rule, which keeps a never-ran delegation row exactly as it is today.
    const syncThreadIds = (ops: TurnDisplayOp[]): void => {
        const join = context.invocationThreadIds;

        if (join === undefined) return;

        for (const record of sections) {
            if (record.key === ROOT_KEY) continue;
            if (record.section.threadId !== undefined || record.section.branchId !== undefined) continue;

            const invocationId = record.section.invocationId;

            if (invocationId === undefined) continue;

            const threadId = join.get(invocationId);

            if (threadId === undefined) continue;

            patchSection(record, { threadId }, ops);
        }
    };

    const route = (event: HarnessEvent, ops: TurnDisplayOp[]): SectionRecord => {
        const meta = event.thread;

        if (meta !== undefined) {
            const known = byInvocation.get(meta.id) ?? byKey.get(meta.id);
            if (known !== undefined) return known;

            if (isConversationRoot(meta)) {
                const root = byKey.get(ROOT_KEY);

                if (root === undefined) {
                    const created = rootSection(event.agent);

                    created.section.invocationId = meta.id;
                    created.section.agentLabel = turn.threadLabel ?? conversationLabelOf(meta.id) ?? '';
                    created.section.threadLabel = conversationLabelOf(meta.id) ?? turn.threadLabel;
                    created.section.threadId = turn.threadId;
                    byInvocation.set(meta.id, created);
                    openSection(created, ops);

                    return created;
                }

                // Same agent, no parent: another frame of the host-thread run.
                if (root.agent === event.agent) {
                    if (root.section.invocationId === undefined) {
                        root.section.invocationId = meta.id;
                        byInvocation.set(meta.id, root);
                        patchSection(root, { invocationId: meta.id }, ops);
                    }

                    return root;
                }
            }

            if (meta.callId !== undefined) {
                const placeholder = byCall.get(meta.callId);

                if (placeholder !== undefined && placeholder.placeholder) {
                    adoptPlaceholder(placeholder, meta, ops);

                    return placeholder;
                }
            }

            return createChild(meta, event.agent, ops);
        }

        const root = byKey.get(ROOT_KEY);
        if (root !== undefined && root.agent === event.agent) return root;

        // A threadless stream from the ENTRY agent is the turn's own root flow: the
        // tile seeds the root section exactly this way (turns.ts:4045-4054, where
        // `inlineEntry` falls back to `ROOT_KEY`). Without this, a legacy run would
        // render into an `inline:<agent>` section and lose the conversation label the
        // root row owns.
        if (root === undefined && event.agent === context.primary) {
            const created = rootSection(event.agent);

            openSection(created, ops);

            return created;
        }

        if (event.type === 'start') {
            const placeholder = queuedPlaceholder(event.agent);

            if (placeholder !== undefined) {
                placeholder.placeholder = false;
                placeholder.started = true;
                placeholder.section.state = 'streaming';
                patchSection(placeholder, { state: 'streaming' }, ops);

                return placeholder;
            }

            return inlineSection(event.agent, ops);
        }

        // The runtime serializes one invocation per agent, so a single started,
        // non-terminal section for that agent is unambiguous. Anything else (none, or
        // more than one) keeps the flat inline section rather than guessing
        // (turns.ts:4027-4040).
        let candidate: SectionRecord | undefined;
        let matches = 0;

        for (const record of sections) {
            if (record.key === ROOT_KEY || record.placeholder) continue;
            if (record.agent !== event.agent || !record.started || record.terminal) continue;
            candidate = record;
            matches += 1;
        }

        if (matches === 1 && candidate !== undefined) return candidate;

        return inlineSection(event.agent, ops);
    };

    // -----------------------------------------------------------------------
    // Attempt windows
    // -----------------------------------------------------------------------

    const beginAttempt = (record: SectionRecord): AttemptWindow => {
        record.attempt ??= { nodeIds: [], stepIds: [], blockIds: [], textKeys: [], sectionKeys: [], callIds: [] };

        return record.attempt;
    };

    // Closing a writer detaches the node: the next request streams into nodes of its
    // OWN, or a retry could not remove the failed half without also removing the
    // committed half (the fusion defect turns.ts:4599 documents).
    const closeWriters = (record: SectionRecord): void => {
        record.text = undefined;
        record.reasoning = undefined;
        record.textBlockId = undefined;
        record.reasoningBlockId = undefined;
        record.textOpenedAt = undefined;
        record.reasoningOpenedAt = undefined;
    };

    const commitAttempt = (record: SectionRecord, ops: TurnDisplayOp[]): void => {
        const window = record.attempt;

        closeWriters(record);

        if (window === undefined) return;

        for (const nodeId of window.nodeIds) {
            const node = record.section.nodes.find((entry) => entry.id === nodeId);

            if (node === undefined) continue;
            // Only PROSE has a committed flag: a think chip's content is final once
            // the request committed, and a step/notice is not discardable here.
            if (node.kind !== 'text') continue;

            node.committed = true;
            ops.push({ op: 'node:set', turnId: turn.id, sectionId: record.section.id, nodeId, patch: { committed: true } });
        }

        // The copy target is the LAST committed prose node of this attempt (a pointer,
        // so the prose is carried once rather than duplicated). R23 (T23): bounding the
        // prose this commit superseded is no longer done here — the tail designation
        // (`syncTails`, at the end of the frame) owns which body is whole. R2 (T1) then
        // narrowed what that pass bounds: an answer a later CALL or thinking window
        // superseded stays whole (the board prints it above that block), and only an answer
        // a NEWER ANSWER superseded goes compact — so a stream of short answers costs one
        // preview patch each time the designation actually moves.
        for (let position = record.section.nodes.length - 1; position >= 0; position -= 1) {
            const node = record.section.nodes[position];

            if (node.kind === 'text' && node.text.length > 0) {
                patchSection(record, { answerNodeId: node.id }, ops);
                break;
            }
        }

        record.attempt = undefined;
        ops.push({ op: 'attempt:commit', turnId: turn.id, sectionId: record.section.id });
        invalidate();
    };

    const discardAttempt = (record: SectionRecord, ops: TurnDisplayOp[]): void => {
        const window = record.attempt;

        closeWriters(record);

        if (window === undefined) return;

        for (const callId of window.callIds) {
            const index = openCalls.findIndex((entry) => entry.step.callId === callId && entry.sectionKey === record.key);
            if (index >= 0) openCalls.splice(index, 1);
        }

        for (const nodeId of window.nodeIds) steps.delete(nodeId);

        record.section.nodes = record.section.nodes.filter((node) => !window.nodeIds.includes(node.id));

        // A discarded attempt is the ONE removal that can erase this section's newest answer, so
        // the R2 (T1) carrier is re-derived here (P3): the backward scan stays off the per-node
        // projection and runs once per discarded attempt instead.
        record.latestTextNodeId = latestTextNodeIdOf(record);

        stepCount = Math.max(0, stepCount - window.stepIds.length);

        // A call of a FAILED attempt never executed, so its id is deliberately NOT
        // marked settled (turns.ts:4521).
        for (const key of window.sectionKeys) {
            const placeholder = byKey.get(key);

            if (placeholder === undefined || !placeholder.placeholder) continue;
            removeSection(placeholder, ops);
        }

        record.attempt = undefined;

        // A retried attempt's segments leave the bar with its rows: they were never
        // committed, so their bytes were never part of the conversation either.
        for (const blockId of window.blockIds) removeBlock(record, blockId, ops);

        ops.push({ op: 'attempt:discard', turnId: turn.id, sectionId: record.section.id, nodeIds: [...window.nodeIds] });
        invalidate();
    };

    // -----------------------------------------------------------------------
    // The pending status line (one mutable node per section)
    // -----------------------------------------------------------------------

    const pendingLineText = (record: SectionRecord): string | undefined => {
        if (record.pendingCalls.size === 0) return undefined;

        // Exact existing tile text (turns.ts:4271, pinned by tests).
        return `pending \u00b7 ${[...record.pendingCalls.values()]
            .map((tool) => `${tool.name} ${formatDuration(tool.elapsedMs)}`)
            .join(' \u00b7 ')}`;
    };

    const syncPendingLine = (record: SectionRecord, ops: TurnDisplayOp[]): void => {
        const text = pendingLineText(record);
        const existing = record.section.nodes.find((node) => node.id === PENDING_NODE_ID);

        if (text === undefined) {
            if (existing === undefined) return;

            // Only the `pending` node leaves the array here, and a text node id is always
            // `n<eventIndex>`, so the R2 (T1) carrier cache cannot be naming this node.
            record.section.nodes = record.section.nodes.filter((node) => node.id !== PENDING_NODE_ID);
            ops.push({ op: 'node:remove', turnId: turn.id, sectionId: record.section.id, nodeId: PENDING_NODE_ID });

            return;
        }

        if (existing === undefined) {
            const node: DisplayNode = { kind: 'notice', id: PENDING_NODE_ID, tone: 'info', text };
            // A notice is never a carrier, so the cache is untouched by this append too.
            record.section.nodes.push(node);
            ops.push({ op: 'node:insert', turnId: turn.id, sectionId: record.section.id, node });

            return;
        }

        if (existing.kind !== 'notice' || existing.text === text) return;

        existing.text = text;
        ops.push({ op: 'node:set', turnId: turn.id, sectionId: record.section.id, nodeId: PENDING_NODE_ID, patch: { text } });
    };

    // A PRESENT array replaces this agent's snapshot; an absent one must not be read
    // as "drained" (turns.ts:5142). Both the DATA op (`pending:set`, the frozen
    // contract frame) and the composed status line are emitted: a renderer that draws
    // its own rows gets the array, and a renderer that prints verbatim gets the text.
    const paintPending = (
        record: SectionRecord,
        pending: HarnessPendingTool[] | undefined,
        ops: TurnDisplayOp[]
    ): void => {
        if (pending === undefined) return;

        record.pendingCalls.clear();
        for (const tool of pending) record.pendingCalls.set(tool.callId, tool);

        ops.push({
            op: 'pending:set',
            turnId: turn.id,
            sectionId: record.section.id,
            pending: pending.map((tool) => ({ ...tool }))
        });
        syncPendingLine(record, ops);
    };

    const prunePending = (record: SectionRecord, callId: string | undefined, ops: TurnDisplayOp[]): void => {
        if (callId === undefined) return;
        if (!record.pendingCalls.delete(callId)) return;

        ops.push({
            op: 'pending:set',
            turnId: turn.id,
            sectionId: record.section.id,
            pending: [...record.pendingCalls.values()].map((tool) => ({ ...tool }))
        });
        syncPendingLine(record, ops);
    };

    // -----------------------------------------------------------------------
    // Node / step emission
    // -----------------------------------------------------------------------

    const insertNode = (record: SectionRecord, node: DisplayNode, ops: TurnDisplayOp[], attemptOwned: boolean): void => {
        record.section.nodes.push(node);

        // R2 (T1) carrier cache, maintained at the append (P3): nodes only ever join the END of
        // this array, so an appended ANSWER is by definition the section's newest one — written
        // BEFORE the wire copy below, so the inserted node is projected as a full carrier exactly
        // as a re-scan would have. A reasoning window or a notice changes nothing.
        if (node.kind === 'text') record.latestTextNodeId = node.id;

        // The INTERNAL node keeps the exact text; the inserted copy is the bounded wire
        // shape (../shared/turn-display.ts `TurnDisplay`), so ops and a cold view agree.
        ops.push({ op: 'node:insert', turnId: turn.id, sectionId: record.section.id, node: wireNodeOf(record, node) });

        const window = attemptOwned ? record.attempt : undefined;

        if (window !== undefined) {
            window.nodeIds.push(node.id);
            if (node.kind === 'tool' || node.kind === 'action') window.stepIds.push(node.id);
        }

        invalidate();
    };

    // `attemptOwned` decides whether a later `retry` may remove this step. A tool
    // call is attempt output (turns.ts:4789), a result-only legacy card joins an
    // open window (turns.ts:4902), and an actionRequest card is NOT (turns.ts:4382
    // appends it outside the attempt tracking) — a retry must not eat a live question.
    const pushStep = (
        record: SectionRecord,
        step: DisplayStep,
        index: number,
        ops: TurnDisplayOp[],
        attemptOwned: boolean
    ): StepRecord => {
        const entry: StepRecord = { step, sectionKey: record.key, openingIndex: index };

        steps.set(step.id, entry);
        // A step joins the END of the node array and is never prose (a `tool` row or an
        // `action` card), so the R2 (T1) carrier cache (`record.latestTextNodeId`) stays exact.
        record.section.nodes.push(step);
        ops.push({ op: 'step:set', turnId: turn.id, sectionId: record.section.id, step: copyValue(step) });
        stepCount += 1;

        const window = attemptOwned ? record.attempt : undefined;

        if (window !== undefined) {
            window.nodeIds.push(step.id);
            window.stepIds.push(step.id);
        }

        invalidate();

        return entry;
    };

    const setStep = (entry: StepRecord, patch: Partial<DisplayStep>, ops: TurnDisplayOp[]): void => {
        Object.assign(entry.step, patch);

        const owner = sections.find((record) => record.key === entry.sectionKey);
        if (owner === undefined) return;

        ops.push({ op: 'step:set', turnId: turn.id, sectionId: owner.section.id, step: copyValue(entry.step) });
        invalidate();
    };

    const noticeNode = (
        record: SectionRecord,
        tone: 'retry' | 'wake' | 'error' | 'steer' | 'answer' | 'info',
        text: string,
        id: string,
        at: number | undefined,
        stepId: string | undefined,
        ops: TurnDisplayOp[]
    ): void => {
        insertNode(
            record,
            {
                kind: 'notice',
                id,
                tone,
                text: previewText(text, DISPLAY_NOTICE_CHARS),
                ...(at === undefined || at <= 0 ? {} : { at }),
                ...(stepId === undefined ? {} : { stepId })
            },
            ops,
            false
        );
    };

    // -----------------------------------------------------------------------
    // Context blocks — the ONE bar per turn (R6/R8)
    //
    // A block is METADATA ONLY (no text), so the internal state and the wire copy of
    // a block are the same object shape — unlike a prose node, which keeps the exact
    // recorded text internally and is bounded on the way out (`wireNodeOf` below).
    // Every segment therefore reports counts measured from recorded bytes, never from
    // a preview (invariant 5, ../shared/turn-display.ts).
    // -----------------------------------------------------------------------

    // Ids are position-independent (`ordinal-kind-key`), so a discarded attempt's
    // removal can never renumber a surviving segment, before or after a restart.
    const blockIdOf = (record: SectionRecord, kind: ContextBlockKind, key: string): string =>
        `${record.ordinal}-${kind}-${key}`;

    // Bar order inside one section: the system block (it heads every request), then
    // the turn's prompt, then every flow segment in recorded time order. Two rules
    // make a live stream and a cold replay converge on the SAME array: insertion is
    // always positional by (rank, time), and a segment with no recorded time keeps
    // its mint position (a legacy record without `eventTimes` has none anywhere).
    const contextIndexFor = (list: ContextBlock[], block: ContextBlock): number => {
        const rank = blockRankOf(block);
        const at = finiteAtValue(block.at);

        for (let position = 0; position < list.length; position += 1) {
            const existing = list[position];
            const existingRank = blockRankOf(existing);

            if (existingRank > rank) return position;
            if (existingRank < rank) continue;

            const existingAt = finiteAtValue(existing.at);

            if (at !== undefined && existingAt !== undefined && existingAt > at) return position;
        }

        return list.length;
    };

    const addBlock = (record: SectionRecord, block: ContextBlock, ops: TurnDisplayOp[]): void => {
        const list = (record.section.context ??= []);
        const index = contextIndexFor(list, block);

        list.splice(index, 0, block);
        ops.push({
            op: 'context:add',
            turnId: turn.id,
            sectionId: record.section.id,
            block: copyValue(block),
            // Absent `index` already means "append", so only an out-of-order insert
            // pays for the position (the same rule `node:insert` follows).
            ...(index === list.length - 1 ? {} : { index })
        });
        invalidate();
    };

    const patchBlock = (record: SectionRecord, blockId: string | undefined, patch: ContextBlockPatch, ops: TurnDisplayOp[]): void => {
        if (blockId === undefined) return;

        const block = record.section.context?.find((entry) => entry.id === blockId);
        if (block === undefined) return;

        // Only the fields that ACTUALLY moved travel: a segment that already reports
        // `chars: 12` needs no second 12, so a long stream of deltas stays one op per
        // real change instead of one per event.
        const moved = Object.fromEntries(
            Object.entries(patch).filter(([key, value]) => block[key as keyof ContextBlock] !== value)
        ) as ContextBlockPatch;

        if (Object.keys(moved).length === 0) return;

        Object.assign(block, moved);
        ops.push({ op: 'context:set', turnId: turn.id, sectionId: record.section.id, blockId, patch: copyValue(moved) });
        invalidate();
    };

    const removeBlock = (record: SectionRecord, blockId: string, ops: TurnDisplayOp[]): void => {
        const list = record.section.context;
        if (list === undefined) return;

        const index = list.findIndex((entry) => entry.id === blockId);
        if (index < 0) return;

        list.splice(index, 1);
        ops.push({ op: 'context:remove', turnId: turn.id, sectionId: record.section.id, blockId });
        invalidate();
    };

    // The store owns the instruction evidence (no harness event carries it), so the
    // fold reads it and NEVER reconstructs one: an agent with no recorded source gets
    // no system segment at all, which is what keeps a legacy document honest.
    const instructionSourceFor = (agent: string): TurnInstructionSource | undefined => {
        const sources = context.instructionSourcesOf?.(turn);

        if (!Array.isArray(sources)) return undefined;

        return sources.find(
            (entry) => entry !== null && typeof entry === 'object' && entry.agent === agent && Array.isArray(entry.instructions)
        );
    };

    const charsOfEntries = (entries: readonly string[]): number =>
        entries.reduce((total, entry) => total + (typeof entry === 'string' ? entry.length : 0), 0);

    // Mint the two non-event segments of a section: its ONE system block, and (the
    // turn's root flow only) the user prompt block. Idempotent, so it runs on every
    // event without duplicating either.
    const syncRecordBlocks = (record: SectionRecord, ops: TurnDisplayOp[]): void => {
        const list = (record.section.context ??= []);

        if (!list.some((entry) => entry.kind === 'system')) {
            const source = instructionSourceFor(record.agent);

            if (source !== undefined) {
                const at = finiteAtValue(source.at);

                addBlock(
                    record,
                    {
                        kind: 'system',
                        id: blockIdOf(record, 'system', 'instructions'),
                        turnId: turn.id,
                        sectionId: record.section.id,
                        name: 'instructions',
                        ...(at === undefined ? {} : { at }),
                        chars: charsOfEntries(source.instructions),
                        inPrompt: true
                    },
                    ops
                );
            }
        }

        if (record.key === ROOT_KEY && !list.some((entry) => entry.kind === 'user' && entry.name === 'prompt')) {
            const at = finiteAtValue(turn.startedAt);

            addBlock(
                record,
                {
                    kind: 'user',
                    id: blockIdOf(record, 'user', 'prompt'),
                    turnId: turn.id,
                    sectionId: record.section.id,
                    name: 'prompt',
                    ...(at === undefined ? {} : { at }),
                    // The row already carries the FULL prompt (`TurnSummary.prompt`), so
                    // the segment counts it and duplicates nothing.
                    chars: typeof turn.prompt === 'string' ? turn.prompt.length : 0,
                    inPrompt: true
                },
                ops
            );
        }
    };

    // Steers are record mutations, not events, so the fold adopts them on the next
    // stored event and picks up every remainder at `settle`. The `at <= stamp` gate is
    // what makes a live stream and a cold replay agree: a replay sees the whole
    // `steers` list from the first event, while the live run only saw the entries
    // recorded up to that moment.
    const syncSteerBlocks = (stamp: number | undefined, ops: TurnDisplayOp[]): void => {
        // T14: the fold mints from the COMPLETE submit list, not from the audit ring. The
        // archive (`SessionTurn.steerTexts`) keeps every submit the server accepted, so a
        // bar re-projected after a restart reproduces the same segments — including the
        // submits the 64-entry ring has already truncated — and each of them still answers
        // a click with its own recorded text (R8). A record with no archive behaves exactly
        // as before: the ring is the whole list it has.
        const steers = steerSubmitList(turn as { steers?: SessionTurn['steers']; steerTexts?: SessionTurn['steerTexts'] }) as {
            id?: string;
            at?: number;
            prompt: string;
            threadId?: string;
        }[];
        // Numbered over the WHOLE submit list, so the adoption gate below can skip a
        // submit that has not happened yet without renumbering the ones that have.
        const keys = steerBlockKeysOf(steers);

        for (let position = 0; position < steers.length; position += 1) {
            const steer = steers[position];

            if (steer === null || typeof steer !== 'object' || typeof steer.prompt !== 'string') continue;

            const at = finiteAtValue(steer.at);

            if (stamp !== undefined && at !== undefined && at > stamp) continue;

            // Destination = the section whose conversation the steer actually reached,
            // else the turn's own root flow — the identical rule `steerSummaries`
            // publishes on the row.
            const target =
                steer.threadId === undefined
                    ? undefined
                    : sections.find((entry) => entry.section.threadId !== undefined && entry.section.threadId === steer.threadId);
            const owner = target ?? byKey.get(ROOT_KEY) ?? sections[0];

            if (owner === undefined) continue;

            // Position-independent key: the steer list is a bounded ring, so a
            // surviving steer keeps its id when an older one is truncated away. The
            // store reads the SAME function back when it resolves a segment's payload,
            // so minting and lookup cannot drift. Two submits that share a millisecond
            // AND a text length are numbered apart, so each keeps its own segment (R6).
            const key = keys[position];
            const id = blockIdOf(owner, 'user', key);

            if ((owner.section.context ?? []).some((entry) => entry.id === id)) continue;

            addBlock(
                owner,
                {
                    kind: 'user',
                    id,
                    turnId: turn.id,
                    sectionId: owner.section.id,
                    name: 'steer',
                    ...(at === undefined ? {} : { at }),
                    chars: steer.prompt.length,
                    inPrompt: true
                },
                ops
            );
        }
    };

    // -----------------------------------------------------------------------
    // Wire sanitization — exact inside, bounded on the way out (R1/R3)
    //
    // The internal node keeps the FULL recorded text, because `chars` and the lazy
    // block detail must have exact bytes to be about. Only the copy that leaves the
    // process is truncated, and only the blocks named by `isFullCarrier` are allowed to
    // hold a whole body: the ONE block the server designates as the section's tail
    // (R23, T23 — a thinking window, an answer, or a tool call) and, since R2 (T1), the
    // section's newest recorded ANSWER as well, so the board can keep an intermediate
    // assistant response readable above the block that currently holds the tail.
    // `TurnSection.tail` is still the single designation and `isFullCarrier` is still the
    // single rule, so a live frame, a rebuild and a cold reload agree by construction.
    // -----------------------------------------------------------------------

    /**
     * The tail kind a node carries, or undefined when it is not displayable content.
     *
     * Eligible (R23): a recorded thinking window, an answer, and a tool call — "whatever
     * block it is, it is in the tail, like tool call". Excluded, and why:
     *   - `notice`  — server-written status prose (wake, error, answered, the pending
     *     line). A notice must never erase the block a reader is looking at, and T16/R16a
     *     already removed the per-attempt retry chatter from this tree;
     *   - an `action` step — an interactive owner question that renders its own card with
     *     the full question and every option INLINE (answering may not cost a round trip),
     *     and which mints no context segment at all (../shared/turn-display.ts:357);
     *   - `user` / `system` — not nodes: the prompt rides `TurnSummary.prompt` and a
     *     steered submit renders as its own node, and instructions have no board surface.
     */
    const tailKindOf = (node: DisplayNode): DisplayTailKind | undefined => {
        if (node.kind === 'reasoning') return 'reasoning';
        if (node.kind === 'text') return 'assistant';
        if (node.kind === 'tool') return 'tool';

        return undefined;
    };

    // The segment this node's bytes compose. Resolved by the SAME id derivation
    // `addBlock` used (a prose window is `n<eventIndex>` and its segment is keyed by
    // `<eventIndex>`; a step node IS the event index), then VERIFIED against this
    // section's own list — so a hand-written producer with a different id scheme gets
    // `blockId` absent instead of a guessed pairing. A `tool` step already carries the
    // exact id on its `StepRecord`, which is the O(1) path for a 300-call turn.
    const blockIdForNode = (record: SectionRecord, node: DisplayNode): string | undefined => {
        const kind = tailKindOf(node);

        if (kind === undefined) return undefined;

        if (node.kind === 'tool') {
            const known = steps.get(node.id)?.blockId;

            return known !== undefined && record.section.context?.some((entry) => entry.id === known)
                ? known
                : undefined;
        }

        const key = node.id.startsWith('n') ? node.id.slice(1) : node.id;
        const id = blockIdOf(record, kind, key);

        return record.section.context?.some((entry) => entry.id === id) ? id : undefined;
    };

    /**
     * The recorded bytes of one call, read back out of the durable record.
     *
     * The projector never copies a payload into its own memory: `turn.events` already
     * holds both events verbatim (and the lazy step/block routes answer from exactly
     * those bytes), so the tail reads them from the two indices the `StepRecord` already
     * pins. Live, replay and a restart therefore see identical bytes — and a call that
     * recorded no `tool_call` (a result-only frame) honestly reports no arguments.
     */
    const recordedCallOf = (entry: StepRecord): { args?: string; result?: string } => {
        const opening = turn.events?.[entry.openingIndex] as HarnessEvent | undefined;
        const closing =
            entry.resultIndex === undefined ? opening : (turn.events?.[entry.resultIndex] as HarnessEvent | undefined);

        const args = opening?.type === 'tool_call' && typeof opening.call?.arguments === 'string'
            ? opening.call.arguments
            : undefined;
        const result = closing?.type === 'tool_result' && typeof closing.content === 'string'
            ? closing.content
            : undefined;

        return {
            ...(args === undefined ? {} : { args }),
            ...(result === undefined ? {} : { result })
        };
    };

    // One tail payload field: the EXACT recorded bytes, with no cap of the display
    // contract's own (T25, R23). "The current block in full" is the whole recorded string;
    // what bounds it is the runtime that recorded it (../core/result-budget.ts), not this
    // projection. `over` stays in the shape so the descriptor's `truncated` flag keeps one
    // definition — it is always false here, and the caption therefore never hedges a body
    // that is actually complete (invariant 5 keeps the exact figure on the segment).
    const tailFieldOf = (value: string | undefined): { text?: string; over: boolean } =>
        value === undefined ? { over: false } : { text: value, over: false };

    /**
     * Resolve this section's CURRENT tail block: the newest eligible node, in the
     * section's own recorded display order.
     *
     * Walking `section.nodes` from the end is an order read of the sequence the fold
     * already wrote — not a compilation: nothing is paired, sorted or re-derived, and the
     * exact figures come from the section's context segment. Prose carries no payload here
     * (its whole text rides the designated node); a tool carries the recorded request and,
     * once settled, the recorded response.
     */
    const resolveTail = (record: SectionRecord): DisplayTail | undefined => {
        const nodes = record.section.nodes;

        for (let position = nodes.length - 1; position >= 0; position -= 1) {
            const node = nodes[position];
            const kind = tailKindOf(node);

            if (kind === undefined) continue;

            const blockId = blockIdForNode(record, node);
            const segment = blockId === undefined ? undefined : record.section.context?.find((entry) => entry.id === blockId);

            if (kind === 'tool') {
                const entry = steps.get(node.id);
                const recorded = entry === undefined ? {} : recordedCallOf(entry);
                const args = tailFieldOf(recorded.args);
                const result = tailFieldOf(recorded.result);

                return {
                    kind,
                    nodeId: node.id,
                    ...(blockId === undefined ? {} : { blockId }),
                    // The segment's EXACT figure (`argsChars + resultChars`, invariant 5),
                    // and the recorded bytes otherwise — never the length of a bound field.
                    chars: segment?.chars ?? (recorded.args?.length ?? 0) + (recorded.result?.length ?? 0),
                    truncated: args.over || result.over,
                    ...(args.text === undefined ? {} : { args: args.text }),
                    ...(result.text === undefined ? {} : { result: result.text })
                };
            }

            const prose = node as DisplayTextNode | DisplayReasoningNode;
            const stated = segment?.chars ?? prose.chars ?? prose.text.length;

            return {
                kind,
                nodeId: node.id,
                ...(blockId === undefined ? {} : { blockId }),
                chars: Number.isFinite(stated) ? Math.max(0, Math.trunc(stated)) : prose.text.length,
                // A designated prose body is whole BY CONSTRUCTION (`isFullCarrier` always
                // clears this node's bound), so this never claims a preview
                // that the wire does not carry.
                truncated: false
            };
        }

        return undefined;
    };

    /**
     * The identity of a designation: what makes the descriptor worth re-sending.
     *
     * Deliberately excludes prose `chars`: an answer's running length moves with every
     * delta and already rides `context:set` on its own segment, so republishing the
     * pointer per token would be the "full payload repeated every frame" failure in
     * miniature. A tool's payload lengths DO count, because a call that settles changes
     * the bytes the reader sees.
     */
    const tailStampOf = (tail: DisplayTail | undefined): string => {
        if (tail === undefined) return '';

        if (tail.kind !== 'tool') return `${tail.kind}:${tail.nodeId}:${tail.blockId ?? ''}`;

        return `tool:${tail.nodeId}:${tail.blockId ?? ''}:${tail.args?.length ?? -1}:${tail.result?.length ?? -1}`;
    };

    /**
     * The section's newest RECORDED ANSWER, by display order (R2, T1) — the ONE derivation of
     * the second carrier.
     *
     * "Newest" is an order read of the same array `resolveTail` walks — the LAST
     * `kind === 'text'` node — not a timestamp, not `answerNodeId` (that pointer names the
     * last COMMITTED prose and is deliberately not moved by a discard). Nodes only append to
     * the end of `section.nodes` (`insertNode`/`pushStep`) or leave it by filter
     * (`discardAttempt`/`syncPendingLine`), so a backwards scan IS the recorded order and it
     * stops at the first text node it meets.
     *
     * COMPLEXITY (P3): this scan is NOT a per-node read. Its value lives on the record
     * (`SectionRecord.latestTextNodeId`, a per-section cache maintained at the append and
     * re-derived at the one removal that can move it), so `isFullCarrier` — which the wire
     * copy calls for EVERY node of EVERY pass — stays O(1) and a call run with thousands of
     * rows after the last answer costs O(nodes) per pass instead of O(prose x nodes).
     */
    const latestTextNodeIdOf = (record: SectionRecord): string | undefined => {
        const nodes = record.section.nodes;

        for (let position = nodes.length - 1; position >= 0; position -= 1) {
            if (nodes[position].kind === 'text') return nodes[position].id;
        }

        return undefined;
    };

    /**
     * Which nodes the wire copy may print with a WHOLE body, and which ones
     * `moveTailBodies` therefore never bounds (one rule, both directions).
     *
     * Carriers:
     *   1. the designated tail, when that tail is prose — a reasoning window or an answer
     *      (R23, T23); a `tool` tail carries its payload on the descriptor instead, and a
     *      `notice`/`action`/`user` node is not prose at all, so the kind gate stays;
     *   2. ALWAYS the section's newest recorded answer, even while a later `reasoning`
     *      window or `tool` call holds the tail (R2, T1). That is what lets the board keep
     *      the assistant response visible ABOVE the current block instead of a
     *      `DISPLAY_NODE_PREVIEW_CHARS` stub: the browser already knows which node it is
     *      (`section.nodes` order), so no wire field and no second designation is needed.
     *
     * Carrier 2 supersedes in exactly the way carrier 1 does: recording a newer `text`
     * node makes it both the tail and the newest answer, and the older answer goes back to
     * being history — one `node:set` preview patch, in the same frame, emitted only when
     * the designation actually moved (`tailStampOf`). A reasoning window is NOT a second
     * carrier: R2 is about the assistant response, and a historical think chip stays one
     * lazy click away.
     *
     * COMPLEXITY (P3): O(1). The newest answer is read from the per-section cache
     * (`SectionRecord.latestTextNodeId`), never re-scanned here, because this predicate runs
     * for EVERY node of EVERY projection (`wireNodeOf`, from both the op stream and
     * `display()`).
     */
    const isFullCarrier = (record: SectionRecord, node: DisplayNode): boolean => {
        if (node.kind !== 'text' && node.kind !== 'reasoning') return false;

        if (record.section.tail?.nodeId === node.id) return true;

        return node.kind === 'text' && record.latestTextNodeId === node.id;
    };

    const wireNodeOf = (record: SectionRecord, node: DisplayNode): DisplayNode => {
        if (node.kind !== 'text' && node.kind !== 'reasoning') return copyValue(node);

        const wire = copyValue(node) as DisplayTextNode | DisplayReasoningNode;
        const chars = node.text.length;

        // A bounded node states its exact length and says so; a full carrier (`isFullCarrier`
        // — the designated tail, or this section's newest answer) carries the whole text, so
        // its length IS the count. The `redacted` marker is
        // dropped here on purpose: a node printed in full must never claim to be a
        // preview, and one printed as a preview must never claim to be whole. A preview is
        // cut from the END (T26, R26), so the newest lines are the ones that survive the bound.
        if (isFullCarrier(record, node) || chars <= DISPLAY_NODE_PREVIEW_CHARS) {
            delete wire.redacted;

            return { ...wire, chars };
        }

        // T26 (R26): a bounded body keeps its LATEST characters, so the preview a reader sees
        // is the end of what the model wrote rather than the beginning it already read.
        return { ...wire, text: previewTextTail(node.text, DISPLAY_NODE_PREVIEW_CHARS), chars, redacted: true };
    };

    /**
     * Move the wire bodies to match a designation, in BOTH directions (R23).
     *
     * The node that LOST the tail becomes history: one patch carrying the
     * `DISPLAY_NODE_PREVIEW_CHARS` preview of its LATEST characters (T26, R26 — the newest
     * lines survive the bound, never the opening ones), the exact length, and
     * `redacted: true`. The
     * node that GAINED it back (a retry discarded the block that superseded it) is
     * restored: one patch carrying the full recorded text and `unredacted: true`, so a
     * live client cannot keep a preview the cold document no longer shows.
     *
     * "Gained it back" is `isFullCarrier`, i.e. the designated tail OR this section's
     * newest answer (R2, T1): an answer that is merely superseded by a later thinking
     * window or call keeps its whole body on the wire, so the board can still print it
     * above the current block. Only an answer that a NEWER ANSWER replaced is bounded —
     * which is the same frame in which that newer answer took the tail, so this pass still
     * emits nothing at all unless the designation moved.
     *
     * Nodes at or below the bound need no patch either way — their text is already the
     * whole content — which is what keeps a stream of short windows free of churn.
     * `ops` is omitted by the read path, which only needs the same decision, not the
     * traffic.
     */
    const moveTailBodies = (record: SectionRecord, next: DisplayTail | undefined, ops?: TurnDisplayOp[]): void => {
        // Read BEFORE the loop mutates anything: the newest answer is decided from the array as
        // the fold wrote it, and one value serves the WHOLE pass (P3 — no per-node lookup).
        // (The stored node always keeps its EXACT text — only the wire copy is bounded, see
        // `wireNodeOf` — so a carrier that was previewed once can always be restored verbatim;
        // nothing here has to reconstruct a lost body.)
        const answerId = record.latestTextNodeId;

        for (const node of record.section.nodes) {
            if (node.kind !== 'text' && node.kind !== 'reasoning') continue;

            // `next` is compared explicitly rather than through `isFullCarrier`, because
            // `syncTails` calls this BEFORE it republishes `record.section.tail` — the field
            // still names the PREVIOUS designation here.
            const carrier =
                (next !== undefined && next.nodeId === node.id) || (node.kind === 'text' && node.id === answerId);

            if (carrier) {
                if (node.redacted !== true) continue;

                delete node.redacted;
                node.chars = node.text.length;
                ops?.push({
                    op: 'node:set',
                    turnId: turn.id,
                    sectionId: record.section.id,
                    nodeId: node.id,
                    patch: { text: node.text, chars: node.chars, unredacted: true }
                });

                continue;
            }

            const over = node.text.length > DISPLAY_NODE_PREVIEW_CHARS;

            if (!over || node.redacted === true) continue;

            node.redacted = true;
            node.chars = node.text.length;
            ops?.push({
                op: 'node:set',
                turnId: turn.id,
                sectionId: record.section.id,
                nodeId: node.id,
                patch: {
                    text: previewTextTail(node.text, DISPLAY_NODE_PREVIEW_CHARS),
                    chars: node.chars,
                    redacted: true
                }
            });
        }
    };

    /**
     * One pass per frame: re-resolve every section's tail and publish what moved.
     *
     * It runs at the END of `apply`/`settle` because the designation depends on the whole
     * frame (a call that settles in ANOTHER section moves that section's tail, not the
     * routed one). Sections with an unchanged stamp emit nothing, so a long round costs
     * one `tail:set` for its first delta and none for the other 499.
     *
     * The second full carrier (R2, T1) needs NO stamp of its own, and that is load-bearing
     * for compactness: `section.nodes` only grows at the end, so a node becomes the newest
     * ANSWER only by being recorded last — which is exactly when it also takes the tail and
     * moves this stamp. It stops being the newest answer only when a later answer is
     * recorded (tail moves again) or when it is removed by `discardAttempt`, whose nodes are
     * always the tail-end of the recorded order (a window is opened and closed in order, so
     * the last ELIGIBLE node is inside it) — again a moving stamp. It therefore never goes
     * whole or partial on a frame this pass skipped, and no full body is ever re-sent per
     * delta.
     */
    const syncTails = (ops: TurnDisplayOp[]): void => {
        for (const record of sections) {
            const next = resolveTail(record);
            const stamp = tailStampOf(next);

            if (stamp === record.tailStamp) continue;

            const previous = record.section.tail;
            record.tailStamp = stamp;
            moveTailBodies(record, next, ops);

            if (next === undefined) {
                // Nothing left to display: the section's last eligible node went with a
                // discarded attempt, or it never produced model content at all. Stated
                // explicitly, because an absent field means a silent producer instead.
                if (previous !== undefined) {
                    delete record.section.tail;
                    ops.push({ op: 'tail:clear', turnId: turn.id, sectionId: record.section.id });
                }

                continue;
            }

            record.section.tail = next;
            ops.push({ op: 'tail:set', turnId: turn.id, sectionId: record.section.id, tail: copyValue(next) });
        }
    };

    // -----------------------------------------------------------------------
    // apply(): one recorded event -> ops
    // -----------------------------------------------------------------------

    const apply = (event: HarnessEvent, at: number, index: number): TurnDisplayOp[] => {
        const ops: TurnDisplayOp[] = [];

        if (event === null || typeof event !== 'object' || typeof event.type !== 'string') return ops;

        // A cold fold of a legacy record has no `eventTimes`; the contract keeps
        // `at: number`, so 0 is the documented "no timestamp" sentinel and NO timing
        // is written anywhere (the tile must not invent a duration).
        const stamp = finiteNumber(at) && at > 0 ? at : undefined;
        const record = route(event, ops);

        lastAppliedStamp = stamp;

        // The non-event segments of the bar (this section's system block, the turn's
        // prompt block) and any steer recorded since the last stored event, so the bar
        // is complete on EVERY frame and never needs a client-side rule about which
        // segments "should" exist.
        syncRecordBlocks(record, ops);

        // R18/T18: a conversation id learned after a section was folded still lands on
        // that section, as its own patch, on the SAME frame (see `syncThreadIds`). This
        // runs BEFORE the steer pass because a steer's destination is resolved by
        // `section.threadId` — the id has to be on the row before the segment it owns is
        // minted, or guidance addressed to a delegated conversation would be painted onto
        // the parent's bar.
        syncThreadIds(ops);
        syncSteerBlocks(stamp, ops);

        switch (event.type) {
            case 'start': {
                if (record.key === ROOT_KEY) {
                    record.agent = event.agent;
                    record.section.agent = event.agent;
                }

                record.started = true;
                if (record.section.agentLabel.length === 0) {
                    const label = conversationLabelOf(record.section.invocationId);

                    record.section.agentLabel = label ?? (record.key === ROOT_KEY ? turn.threadLabel ?? '' : '');
                    if (record.section.agentLabel.length > 0 && record.key === ROOT_KEY) {
                        record.section.threadLabel = record.section.agentLabel;
                    }
                }

                patchSection(
                    record,
                    {
                        model: typeof event.model === 'string' ? event.model : undefined,
                        role: record.key === ROOT_KEY ? (event.agent === context.primary ? 'primary' : 'subagent') : record.section.role,
                        agentLabel: record.section.agentLabel,
                        ...(record.section.threadLabel === undefined ? {} : { threadLabel: record.section.threadLabel }),
                        ...(record.terminal ? {} : { state: 'streaming' }),
                        ...(record.section.agentLabel.length === 0 || record.key !== ROOT_KEY
                            ? {}
                            : { threadId: record.section.threadId ?? turn.threadId })
                    },
                    ops
                );
                break;
            }

            case 'text': {
                if (typeof event.delta !== 'string' || event.delta.length === 0) break;

                const window = beginAttempt(record);

                if (record.text === undefined) {
                    // A superseded writer never reopens: `closeWriters` detached it, so
                    // the node about to be minted IS the section's newest block. The
                    // prose it replaces is bounded at the END of this frame, by the same
                    // tail pass that designates this node (R23) — one rule, one order, no
                    // second copy of the redaction logic.
                    record.text = { kind: 'text', id: `n${index}`, text: '', committed: false, chars: 0 };
                    insertNode(record, record.text, ops, true);

                    const blockId = blockIdOf(record, 'assistant', String(index));

                    record.textBlockId = blockId;
                    record.textOpenedAt = stamp;
                    window.textKeys.push(blockId);
                    // A retried attempt removes its own prose segment too (the
                    // `textKeys` list only answers "did this attempt stream prose").
                    window.blockIds.push(blockId);
                    addBlock(
                        record,
                        {
                            kind: 'assistant',
                            id: blockId,
                            turnId: turn.id,
                            sectionId: record.section.id,
                            name: 'answer',
                            ...(stamp === undefined ? {} : { at: stamp }),
                            chars: 0,
                            // Committed prose is replayed to the model on every later
                            // request of this conversation.
                            inPrompt: true,
                            eventFrom: index,
                            eventTo: index
                        },
                        ops
                    );
                }

                record.text.text += event.delta;
                record.text.chars = record.text.text.length;

                // A current answer streams in FULL: one append per delta, and its bar
                // segment carries the exact running length (invariant 5).
                ops.push({ op: 'node:append', turnId: turn.id, sectionId: record.section.id, nodeId: record.text.id, delta: event.delta });
                patchBlock(record, record.textBlockId, flowWindowPatch(record.textOpenedAt, stamp, record.text.chars, index), ops);
                invalidate();
                break;
            }

            case 'reasoning': {
                if (typeof event.delta !== 'string' || event.delta.length === 0) break;

                const window = beginAttempt(record);

                if (record.reasoning === undefined) {
                    record.reasoning = { kind: 'reasoning', id: `n${index}`, text: '', chars: 0 };
                    insertNode(record, record.reasoning, ops, true);

                    const blockId = blockIdOf(record, 'reasoning', String(index));

                    record.reasoningBlockId = blockId;
                    record.reasoningOpenedAt = stamp;
                    window.blockIds.push(blockId);
                    addBlock(
                        record,
                        {
                            kind: 'reasoning',
                            id: blockId,
                            turnId: turn.id,
                            sectionId: record.section.id,
                            name: 'reasoning',
                            ...(stamp === undefined ? {} : { at: stamp }),
                            chars: 0,
                            // Thinking is recorded and shown, never replayed into the
                            // next request — the one segment class that is not prompt
                            // text, stated explicitly rather than left to a bar.
                            inPrompt: false,
                            eventFrom: index,
                            eventTo: index
                        },
                        ops
                    );
                }

                record.reasoning.text += event.delta;
                record.reasoning.chars = record.reasoning.text.length;

                // R23 (T23): a thinking window streams its bytes WHOLE, exactly like an
                // answer does, because while it is open it IS the section's newest block
                // and therefore its designated tail (`closeWriters` detaches the writer at
                // every boundary, so a live writer is always the last eligible node). The
                // `DISPLAY_NODE_PREVIEW_CHARS` bound arrives later, as ONE `node:set` patch
                // from the frame-end tail pass, at the moment a newer block takes the tail
                // — which is when the body stops being displayed and the exact length moves
                // to the segment. A reconnect therefore replays only the CURRENT window in
                // full, never a historical one (and, since R2/T1, the newest ANSWER beside
                // it — that body streamed whole here too, so it costs no extra traffic).
                ops.push({
                    op: 'node:append',
                    turnId: turn.id,
                    sectionId: record.section.id,
                    nodeId: record.reasoning.id,
                    delta: event.delta
                });

                patchBlock(record, record.reasoningBlockId, flowWindowPatch(record.reasoningOpenedAt, stamp, record.reasoning.chars, index), ops);
                applyShares(record, ops);
                invalidate();
                break;
            }

            case 'tool_call': {
                const window = beginAttempt(record);
                const callId = typeof event.call?.id === 'string' && event.call.id.length > 0 ? event.call.id : undefined;
                const name = typeof event.call?.name === 'string' ? event.call.name : '';
                const rawArgs = typeof event.call?.arguments === 'string' ? event.call.arguments : '';

                // Text before a call is finished text: close the writer so the call is
                // a node of its own and post-tool prose starts a fresh block. The prose
                // that just closed loses its body in THIS frame's tail pass (the call is
                // the newest block now, so a thinking window becomes history: bounded, with
                // its exact length on its segment) — R23 keeps that one rule for every kind
                // of supersession instead of repeating it per handler. An ANSWER is the
                // exception R2 (T1) put in `isFullCarrier`, not here: it stays whole because
                // no newer answer replaced it, so the board can keep it above this call.
                closeWriters(record);

                const step: DisplayStep = {
                    kind: 'tool',
                    id: String(index),
                    turnId: turn.id,
                    sectionId: record.section.id,
                    ...(callId === undefined ? {} : { callId }),
                    name,
                    argsPreview: previewArguments(rawArgs),
                    state: 'running',
                    ...(stamp === undefined ? {} : { startedAt: stamp }),
                    detail: {
                        stepId: String(index),
                        hasResult: false,
                        truncated: rawArgs.length > DISPLAY_ARGS_PREVIEW_CHARS
                    }
                };

                const entry = pushStep(record, step, index, ops, true);

                // ONE segment per recorded call, opened by this event and updated (not
                // re-minted) when its result lands. `argsChars` is the exact length of
                // the raw arguments the record holds right now, which for a call still
                // running is everything it has.
                const blockId = blockIdOf(record, 'tool', String(index));

                entry.blockId = blockId;
                window.blockIds.push(blockId);
                addBlock(
                    record,
                    {
                        kind: 'tool',
                        id: blockId,
                        turnId: turn.id,
                        sectionId: record.section.id,
                        name,
                        ...(stamp === undefined ? {} : { at: stamp }),
                        chars: rawArgs.length,
                        argsChars: rawArgs.length,
                        // The call's arguments travelled with the committed assistant
                        // message; the result joins them when it is recorded below.
                        inPrompt: true,
                        state: 'running',
                        eventFrom: index,
                        eventTo: index
                    },
                    ops
                );

                if (callId !== undefined) {
                    openCalls.push(entry);
                    window.callIds.push(callId);
                }

                if (name === 'delegate' && callId !== undefined) {
                    const delegate = delegateOf(rawArgs);

                    if (delegate !== undefined) {
                        const key = `call:${callId}`;

                        if (!byKey.has(key)) {
                            const placeholder = newSection(key, delegate.agent, record.key, true);

                            byCall.set(callId, placeholder);
                            placeholder.spawnCallId = callId;
                            placeholder.section.role = 'subagent';
                            openSection(placeholder, ops);
                            window.sectionKeys.push(key);
                        }
                    }
                }

                invalidate();
                break;
            }

            case 'tool_result': {
                const callId = typeof event.callId === 'string' && event.callId.length > 0 ? event.callId : undefined;
                const outcome = outcomeOfResult(event);
                const state = outcomeState(outcome);

                // A result for a call THIS INVOCATION already settled is a duplicate/
                // late frame: one call, one row, no overwrite (turns.ts:4849). Scoped
                // per invocation so a child's id cannot mask its parent's result.
                if (callId !== undefined && settledCalls.has(settleKey(record.key, callId))) break;

                const findOpen = (): StepRecord | undefined => {
                    if (callId !== undefined) {
                        const local = openCalls.findIndex(
                            (candidate) => candidate.step.callId === callId && candidate.sectionKey === record.key
                        );
                        const any = local >= 0 ? local : openCalls.findIndex((candidate) => candidate.step.callId === callId);

                        return any >= 0 ? openCalls[any] : undefined;
                    }

                    const local = openCalls.findIndex(
                        (candidate) => candidate.step.name === event.name && candidate.sectionKey === record.key
                    );
                    const any = local >= 0 ? local : openCalls.findIndex((candidate) => candidate.step.name === event.name);

                    return any >= 0 ? openCalls[any] : undefined;
                };

                const entry = findOpen();
                const content = typeof event.content === 'string' ? event.content : '';

                if (entry !== undefined) {
                    openCalls.splice(openCalls.indexOf(entry), 1);
                    // Marked against the STEP's own invocation, which is the identity a
                    // later duplicate for the same call would have to match.
                    if (callId !== undefined) settledCalls.add(settleKey(entry.sectionKey, callId));

                    entry.resultIndex = index;
                    const duration = finiteNumber(event.durationMs) ? event.durationMs : undefined;
                    const panels = summarizePanels(event.ui);
                    const media = summarizeMedia(event.media);

                    setStep(
                        entry,
                        {
                            state,
                            outcome,
                            preview: previewText(content, DISPLAY_PREVIEW_CHARS),
                            ...(duration === undefined ? {} : { durationMs: duration }),
                            ...(stamp === undefined ? {} : { endedAt: stamp }),
                            ...panels,
                            ...media,
                            detail: {
                                ...entry.step.detail,
                                resultStepId: String(index),
                                hasResult: true,
                                truncated: entry.step.detail.truncated || content.length > DISPLAY_PREVIEW_CHARS
                            }
                        },
                        ops
                    );

                    const pending = pendingOf(event.pending);

                    if (pending !== undefined) paintPending(record, pending, ops);
                    else prunePending(record, entry.step.callId ?? callId, ops);

                    // ONE bar segment for the WHOLE call: the recorded arguments PLUS
                    // the recorded result text (`chars` = the two parts, which is why
                    // `argsChars`/`resultChars` travel beside it), the tool's own
                    // measured span, and the settled state that colours the segment.
                    const owner = sectionOfEntry(entry);
                    const segment = owner?.section.context?.find((candidate) => candidate.id === entry.blockId);
                    const argsChars = segment?.argsChars ?? 0;

                    patchBlock(
                        owner ?? record,
                        entry.blockId,
                        {
                            state,
                            chars: argsChars + content.length,
                            resultChars: content.length,
                            inPrompt: true,
                            ...(stamp === undefined ? {} : { endedAt: stamp }),
                            ...(duration === undefined ? {} : { durationMs: duration }),
                            eventTo: index
                        },
                        ops
                    );
                } else if (settledStatus === undefined) {
                    // The gate is the PROJECTOR's settled flag, never `turn.status`:
                    // a cold fold replays the events of an ALREADY-terminal record,
                    // while the live run was not terminal when those same events
                    // arrived. Reading the record here would make replay disagree with
                    // live, which is the one rule this file exists to keep.
                    //
                    // A genuine result-only frame (a protocol that reports results
                    // without calls, or a missed `tool_call`): show it rather than
                    // dropping information (turns.ts:4891). The RESULT event is this
                    // step's own opening, so detail answering it alone is exact.
                    if (callId !== undefined) settledCalls.add(settleKey(record.key, callId));

                    const step: DisplayStep = {
                        kind: 'tool',
                        id: String(index),
                        turnId: turn.id,
                        sectionId: record.section.id,
                        ...(callId === undefined ? {} : { callId }),
                        name: typeof event.name === 'string' ? event.name : '',
                        preview: previewText(content, DISPLAY_PREVIEW_CHARS),
                        state,
                        outcome,
                        ...(finiteNumber(event.durationMs) ? { durationMs: event.durationMs } : {}),
                        ...(stamp === undefined ? {} : { startedAt: stamp, endedAt: stamp }),
                        ...stepAttachmentsOf(event),
                        detail: { stepId: String(index), hasResult: false, truncated: content.length > DISPLAY_PREVIEW_CHARS }
                    };

                    const duration = finiteNumber(event.durationMs) ? event.durationMs : undefined;
                    const entry = pushStep(record, step, index, ops, true);
                    const blockId = blockIdOf(record, 'tool', String(index));

                    entry.blockId = blockId;
                    record.attempt?.blockIds.push(blockId);
                    addBlock(
                        record,
                        {
                            kind: 'tool',
                            id: blockId,
                            turnId: turn.id,
                            sectionId: record.section.id,
                            name: typeof event.name === 'string' ? event.name : '',
                            ...(stamp === undefined ? {} : { at: stamp, endedAt: stamp }),
                            // NO matching call was recorded, so there are no argument
                            // bytes to report: `chars` is the result text alone, and
                            // `argsChars` stays absent rather than claiming a zero that
                            // never happened.
                            chars: content.length,
                            resultChars: content.length,
                            inPrompt: true,
                            state,
                            ...(duration === undefined ? {} : { durationMs: duration }),
                            eventFrom: index,
                            eventTo: index
                        },
                        ops
                    );
                }

                // The parent's result for the SPAWNING call is the authoritative
                // completion of that child invocation (turns.ts:5154): by call id,
                // so same-agent siblings settle the right row. A CANCELLED call is a
                // control outcome, never an error.
                if (callId !== undefined) {
                    const child = byCall.get(callId);

                    if (child !== undefined && child !== record && !child.terminal) {
                        child.terminal = true;
                        patchSection(
                            child,
                            {
                                state: outcome === 'completed' ? 'done' : outcome === 'cancelled' ? 'cancelled' : 'error',
                                ...(stamp === undefined ? {} : { endedAt: stamp })
                            },
                            ops
                        );
                    }
                }

                invalidate();
                break;
            }

            case 'usage': {
                const usage = event.usage ?? ({} as { input?: number; cached?: number });

                record.latestInput = finiteNumber(usage.input) ? usage.input : record.latestInput;
                // Share denominator only (see the declaration): every section's request can
                // move it, because it is a scale, not the figure the row prints.
                turnLatestInput = record.latestInput;

                // T3: the turn's OWN section is the only source of the turn-level primary
                // figure. A child/subagent/inline frame reports its OWN context and that
                // figure rides its own `sectionId` op (below) and its `TurnSection.latestInput`;
                // it must never become the parent task part's headline context.
                const isRootSection = record.key === ROOT_KEY;

                if (isRootSection) rootLatestInput = record.latestInput;

                if (finiteNumber(usage.cached)) {
                    record.cachedReported = true;
                    record.cachedInput = (record.cachedInput ?? 0) + usage.cached;
                }

                // Mirror the SAME two figures onto the section the ops below publish, so a
                // full-document read (`display()`, which is what a hydrate, a drain frame and
                // a terminal snapshot paint from) carries them too. They are declared fields of
                // `TurnSection` (../shared/turn-display.ts:922) and the live `usage` op already
                // patches them onto the client's tree; without this, the document is the one
                // surface that loses them and every block header falls back to whatever else it
                // holds — a nested row loses its tally outright.
                if (record.latestInput !== undefined) record.section.latestInput = record.latestInput;
                if (record.cachedReported) record.section.cachedInput = record.cachedInput ?? 0;

                ops.push({
                    op: 'usage',
                    turnId: turn.id,
                    sectionId: record.section.id,
                    ...(record.latestInput === undefined ? {} : { latestInput: record.latestInput }),
                    ...(record.cachedReported ? { cachedInput: record.cachedInput ?? 0 } : {})
                });
                ops.push({
                    op: 'usage',
                    turnId: turn.id,
                    sectionId: 'turn',
                    ...(rootLatestInput === undefined ? {} : { latestInput: rootLatestInput }),
                    ...(turn.usage === undefined ? {} : { usage: copyValue(turn.usage) })
                });

                applyShares(record, ops);
                invalidate();
                break;
            }

            case 'done': {
                const pending = pendingOf(event.pending);

                if (pending !== undefined) paintPending(record, pending, ops);

                // Captured BEFORE the commit clears the window: a `done` frame repeats
                // the response text, so it counts as an `assistant` segment ONLY when no
                // prose delta was streamed for this request (a reporter that answers
                // without streaming). Otherwise the deltas already counted those bytes,
                // and counting them twice would inflate the bar.
                const streamedProse = (record.attempt?.textKeys.length ?? 0) > 0;

                commitAttempt(record, ops);

                if (!streamedProse) {
                    const content = (event.message as { content?: unknown } | undefined)?.content;

                    if (typeof content === 'string' && content.length > 0) {
                        addBlock(
                            record,
                            {
                                kind: 'assistant',
                                id: blockIdOf(record, 'assistant', String(index)),
                                turnId: turn.id,
                                sectionId: record.section.id,
                                name: 'answer',
                                ...(stamp === undefined ? {} : { at: stamp }),
                                chars: content.length,
                                inPrompt: true,
                                eventFrom: index,
                                eventTo: index
                            },
                            ops
                        );
                    }
                }

                // `done` closes one AGENT turn, not the user's turn: the root keeps
                // streaming until the turn settles (turns.ts:5241), and a response
                // still waiting on background calls has not finished at all.
                const finished = pending === undefined || pending.length === 0;

                if (record.key !== ROOT_KEY && finished) {
                    record.terminal = true;
                    patchSection(record, { state: 'done', ...(stamp === undefined ? {} : { endedAt: stamp }) }, ops);
                }

                const model = (event.message as { model?: unknown } | undefined)?.model;

                if (record.section.model === undefined && typeof model === 'string') {
                    patchSection(record, { model }, ops);
                }

                invalidate();
                break;
            }

            case 'retry': {
                // T16 (R16a): a transient retry mints NO notice node, in either direction
                // of the one-rule-above (live `apply()` and the cold `projectTurn()` fold
                // run this same handler, so a reload cannot disagree with the stream).
                //
                // WHY THE LINE IS GONE RATHER THAN RESTYLED: the agent owns the retry loop
                // (../core/agent.ts:584-624) and re-sends the SAME request, so a failed
                // attempt is not an outcome the reader acts on — it is the server still
                // working. Eleven attempts printed eleven of these lines, and the tile's
                // status next to them read as a run that was failing.
                //
                // WHAT IS PRESERVED, EXACTLY:
                //   - the retry MECHANISM lives in `agent.ts` and is untouched here; the
                //     raw `retry` frame stays in `turn.events`, so the journal, the CLI
                //     (./cli/render.ts:193) and `GET /sessions/:id/events` keep the
                //     attempt/backoff/error evidence verbatim;
                //   - the attempt's PARTIAL OUTPUT still goes: `discardAttempt` below is
                //     what stops a failed attempt's prose/calls/segments being read as part
                //     of the answer, and it stays the only thing this handler does;
                //   - the EXHAUSTED case is still terminal and still visible: when the
                //     budget runs out the agent throws the LAST attempt's own error
                //     (../core/agent.ts:604-605), the harness turns that into the turn's
                //     `error` event, and the `error` handler below mints its notice. Only
                //     the per-attempt chatter is gone.
                //
                // Nothing here touches the section's state, so the turn keeps reading
                // `streaming` through the backoff (the tile derives its state from
                // `TurnSection.state`, turns.ts:5376, and the activity ring from ops that
                // name the agent, ../view-state.ts:820).
                discardAttempt(record, ops);
                invalidate();
                break;
            }

            case 'attempt_commit': {
                commitAttempt(record, ops);
                break;
            }

            case 'wakeup': {
                const pending = pendingOf(event.pending);

                // A wakeup without a usable pending list is malformed: the tile
                // renders nothing and leaves the last snapshot alone (turns.ts:5034).
                if (pending === undefined) break;

                closeWriters(record);
                // A wake boundary ends the prose window like any other close, so the next
                // request streams into nodes of its own. It does NOT take the tail: a wake
                // line is server status, not model content (R23 — `tailKindOf`), so the
                // block the reader was looking at stays displayed beside this notice
                // instead of being replaced by a line it cannot act on.
                noticeNode(
                    record,
                    'wake',
                    // Exact existing tile text (turns.ts:4322).
                    pending.length === 0
                        ? 'pending tools finished \u00b7 continuing'
                        : `${pending.length} tool${pending.length === 1 ? '' : 's'} still running \u00b7 continuing`,
                    `n${index}`,
                    stamp,
                    undefined,
                    ops
                );
                paintPending(record, pending, ops);
                invalidate();
                break;
            }

            case 'error': {
                const message = messageOf(event.error);

                // R23: the error LINE is server status, not a content block, so it does
                // not take the tail and does not bound the block behind it. A reader who
                // lost an answer to a failed request still sees the answer (or the failed
                // call's own recorded result) as the section's one body, with this notice
                // printed beside it — which is what keeps a terminal error from being
                // mistaken for, or replacing, the meaningful evidence.
                closeWriters(record);
                lastError = previewText(message, DISPLAY_ERROR_CHARS);
                noticeNode(record, 'error', message, `n${index}`, stamp, undefined, ops);

                // A child that reported its own failure is terminal; the root's state
                // belongs to the turn (turns.ts:5294).
                if (record.key !== ROOT_KEY) {
                    record.terminal = true;
                    patchSection(record, { state: 'error', ...(stamp === undefined ? {} : { endedAt: stamp }) }, ops);
                }

                invalidate();
                break;
            }

            case 'action_request': {
                const request = event.request;

                if (request === undefined || typeof request.requestId !== 'string' || request.requestId.length === 0) break;
                if (actionSteps.has(request.requestId)) break;

                const options = (Array.isArray(request.options) ? request.options : [])
                    .filter((option) => typeof option?.id === 'string' && typeof option?.label === 'string')
                    .map((option) => ({
                        id: option.id,
                        label: previewText(option.label, DISPLAY_NOTICE_CHARS),
                        ...(typeof option.description === 'string' && option.description.length > 0
                            ? { description: previewText(option.description, DISPLAY_NOTICE_CHARS) }
                            : {})
                    }));

                const step: DisplayStep = {
                    kind: 'action',
                    id: String(index),
                    turnId: turn.id,
                    sectionId: record.section.id,
                    ...(typeof event.callId === 'string' && event.callId.length > 0 ? { callId: event.callId } : {}),
                    name: textOf(request.question, DISPLAY_PREVIEW_CHARS),
                    state: 'running',
                    ...(stamp === undefined ? {} : { startedAt: stamp }),
                    action: {
                        requestId: request.requestId,
                        question: textOf(request.question, DISPLAY_NOTICE_CHARS),
                        options,
                        ...(typeof request.recommended === 'string' && request.recommended.length > 0
                            ? { recommended: request.recommended }
                            : {}),
                        allowCustom: true,
                        // The SERVER knows what is answerable: a restored request is
                        // expired from the start (sessions.ts:679).
                        expired: context.expiredRequestIds?.has(request.requestId) === true
                    },
                    detail: { stepId: String(index), hasResult: false, truncated: false }
                };

                const entry = pushStep(record, step, index, ops, false);

                actionSteps.set(request.requestId, entry);
                invalidate();
                break;
            }

            case 'action_answer': {
                const answer = event.answer;
                const requestId = typeof answer?.requestId === 'string' ? answer.requestId : '';
                const entry = actionSteps.get(requestId);

                if (entry === undefined) break;

                entry.resultIndex = index;

                const choiceText =
                    answer.choice.kind === 'option' ? optionLabel(entry.step.action, answer.choice.optionId) : answer.choice.text;

                setStep(
                    entry,
                    {
                        state: 'ok',
                        ...(stamp === undefined ? {} : { endedAt: stamp }),
                        action: {
                            ...(entry.step.action as DisplayActionSummary),
                            answered: { choice: copyValue(answer.choice), source: answer.source, ...(stamp === undefined ? {} : { at: stamp }) },
                            expired: false
                        },
                        detail: { ...entry.step.detail, resultStepId: String(index), hasResult: true }
                    },
                    ops
                );

                noticeNode(
                    sectionOfEntry(entry) ?? record,
                    'answer',
                    `answered \u00b7 ${choiceText}`,
                    `n${index}`,
                    stamp,
                    entry.step.id,
                    ops
                );
                invalidate();
                break;
            }

            case 'branch_start': {
                const branch = event.branch;

                if (branch === undefined || typeof branch.branchId !== 'string' || branch.branchId.length === 0) break;

                const existing = byBranch.get(branch.branchId) ?? byKey.get(branch.branchId);

                if (existing !== undefined) {
                    existing.placeholder = false;
                    existing.started = true;
                    patchSection(
                        existing,
                        {
                            ...(existing.terminal ? {} : { state: 'streaming' }),
                            ...(typeof branch.model === 'string' ? { model: branch.model } : {}),
                            ...(branch.threadId === undefined ? {} : { threadId: branch.threadId })
                        },
                        ops
                    );
                    break;
                }

                // The branch row is keyed by the BRANCH id (turns.ts:5337), nested
                // under its requester when the summary names one.
                const meta = {
                    id: branch.branchId,
                    ...(branch.sourceThreadId === undefined ? {} : { parentId: branch.sourceThreadId }),
                    ...(branch.callId === undefined ? {} : { callId: branch.callId }),
                    branchId: branch.branchId,
                    kind: branch.kind
                } as NonNullable<HarnessEvent['thread']>;

                createChild(meta, branch.agent, ops, {
                    role: branch.sourceThreadId === undefined && branch.role === 'primary' ? 'primary' : 'subagent',
                    branchId: branch.branchId,
                    model: typeof branch.model === 'string' ? branch.model : undefined,
                    threadId: typeof branch.threadId === 'string' ? branch.threadId : undefined,
                    state: 'streaming'
                });

                invalidate();
                break;
            }

            case 'branch_end': {
                const target = byBranch.get(event.branchId) ?? byKey.get(event.branchId);

                if (target === undefined) break;

                target.terminal = true;
                patchSection(
                    target,
                    {
                        state: event.status === 'completed' ? 'done' : event.status === 'cancelled' ? 'cancelled' : 'error',
                        ...(stamp === undefined ? {} : { endedAt: stamp })
                    },
                    ops
                );

                if (event.error !== undefined) {
                    noticeNode(target, 'error', messageOf(event.error), `n${index}`, stamp, undefined, ops);
                }

                invalidate();
                break;
            }

            default:
                // An unknown or future event type is recorded (the raw record stays
                // complete) and renders nothing, exactly like the tile's default case.
                break;
        }

        // R23 (T23): the frame is done, so this is where the ONE displayed body moves —
        // for every section, because a `tool_result` can settle a call that lives in
        // ANOTHER section (the parent's result completing a delegated row) and a retried
        // attempt can hand the tail back to the block before it. Runs after every op this
        // event produced, so a client never sees a designation that names a node it has
        // not received yet, and a section whose stamp did not move costs no op at all.
        syncTails(ops);

        return ops;
    };

    // Panels/media of a RESULT-ONLY legacy frame: the same bounded summaries, computed
    // by one helper so the settled and result-only tool paths cannot drift.
    const stepAttachmentsOf = (event: HarnessEvent): { panels?: DisplayPanelSummary[]; media?: DisplayMediaSummary[] } => ({
        ...summarizePanels((event as { ui?: unknown }).ui),
        ...summarizeMedia((event as { media?: unknown }).media)
    });

    const sectionOfEntry = (entry: StepRecord): SectionRecord | undefined =>
        sections.find((record) => record.key === entry.sectionKey);

    const optionLabel = (action: DisplayActionSummary | undefined, optionId: string | undefined): string => {
        if (action === undefined || optionId === undefined) return optionId ?? '';

        const found = action.options.find((option) => option.id === optionId);

        return found === undefined ? optionId : found.label;
    };

    // Think-chip shares re-measure whenever the denominator moves (turns.ts:5210):
    // computed once, here, so a stale percentage cannot disagree with the tally two
    // lines above it.
    const applyShares = (record: SectionRecord, ops: TurnDisplayOp[]): void => {
        const base = turn.usage?.input ?? turnLatestInput ?? 0;

        if (base <= 0) return;

        for (const node of record.section.nodes) {
            if (node.kind !== 'reasoning') continue;

            const share = Math.round((node.text.length / base) * 100);
            if (node.share === share) continue;

            node.share = share;
            ops.push({ op: 'node:set', turnId: turn.id, sectionId: record.section.id, nodeId: node.id, patch: { share } });
        }
    };

    // The store owns labels (it holds the seeds and the thread join), so blocks come
    // from a callback and ride their own stamp.
    const blocksForTurn = (): AgentResultBlock[] => {
        const stamp = `${turn.status}:${turn.updatedAt}:${turn.events.length}`;

        if (blocksStamp === stamp) return blocksCache;

        blocksCache = context.blocksOf === undefined ? [] : [...context.blocksOf(turn)];
        blocksStamp = stamp;

        return blocksCache;
    };

    // -----------------------------------------------------------------------
    // settle(): the turn reached a terminal status (a lifecycle edge, not an event)
    // -----------------------------------------------------------------------

    const settle = (status: TurnRecordStatus, at: number): TurnDisplayOp[] => {
        const ops: TurnDisplayOp[] = [];

        settledStatus = status;
        settledAt = finiteNumber(at) && at > 0 ? at : undefined;

        // R18/T18: settle is the last frame this projector will ever emit, so an id the
        // store learned late must ride the terminal ops — otherwise a live watcher would
        // keep a delegated row without an address until the next reload, while the cold
        // replay (a full map from the first fold) would have had it from the start.
        syncThreadIds(ops);

        // Every steer this turn recorded is now final, including one that arrived after
        // the last stored event (the gate is off at settle, so both a live run and a
        // cold replay end with the SAME set of segments).
        syncSteerBlocks(undefined, ops);

        for (const record of sections) {
            if (record.terminal) continue;

            record.terminal = true;
            // A placeholder row that was never adopted describes a delegation that
            // never ran; dropping it is exact, and it is why `section:remove` exists.
            if (record.placeholder && record.section.nodes.length === 0 && record.section.invocationId === undefined) {
                removeSection(record, ops);

                continue;
            }

            patchSection(record, { state: sectionStateOf(status), ...(settledAt === undefined ? {} : { endedAt: settledAt }) }, ops);
        }

        for (const entry of [...steps.values()]) {
            if (entry.step.state !== 'running') continue;

            const owner = sectionOfEntry(entry);
            if (owner === undefined) continue;

            const patch: Partial<DisplayStep> = {
                state: abandonedStateOf(status),
                ...(settledAt === undefined ? {} : { endedAt: settledAt }),
                ...(entry.step.preview === undefined || entry.step.preview.length === 0
                    ? {
                          preview: previewText(
                              status === 'cancelled'
                                  ? 'the turn was cancelled before this call returned'
                                  : 'the turn ended before this call returned',
                              DISPLAY_PREVIEW_CHARS
                          )
                      }
                    : {}),
                ...(entry.step.kind === 'action' && entry.step.action !== undefined
                    ? { action: { ...entry.step.action, expired: true } }
                    : {})
            };

            Object.assign(entry.step, patch);
            ops.push({ op: 'step:set', turnId: turn.id, sectionId: owner.section.id, step: copyValue(entry.step) });

            // The segment follows the row: the state it ended in and the time the turn
            // closed. NO duration is invented for a call that never reported one, and
            // its `chars` stays the argument bytes it really recorded.
            patchBlock(
                owner,
                entry.blockId,
                {
                    state: abandonedStateOf(status),
                    ...(settledAt === undefined ? {} : { endedAt: settledAt })
                },
                ops
            );
        }

        // Nothing is pending once the turn ended, and the line must not linger. The ONE
        // body rule is then settled the same way every other frame settles it: the final
        // pass below names this turn's last eligible block (so a turn that ends on a
        // thinking window, on an answer, or on a call shows THAT in full, live and after a
        // reload) and bounds every older body, which is what stops a settled turn from
        // replaying a superseded payload forever. The one older body that keeps its whole
        // text is the newest ANSWER (R2, T1) — a settled transcript still shows the last
        // response the model gave, above whatever it ended on.
        for (const record of sections) {
            record.pendingCalls.clear();
            syncPendingLine(record, ops);
        }

        syncTails(ops);

        openCalls.length = 0;
        invalidate();
        ops.push({ op: 'turn', turnId: turn.id, summary: summary() });

        return ops;
    };

    // -----------------------------------------------------------------------
    // Reads — always detached, so a watcher cannot mutate server state through a
    // frame (the same rule `copyTurn`/`publish` enforce for the raw surface)
    // -----------------------------------------------------------------------

    const display = (): TurnDisplay => {
        // A read must not lag the record: adopt the segments the NEXT stored event
        // would have minted anyway. The gate is the last event's timestamp (or the
        // settle time), so a poll cannot pull a steer into the bar earlier than a live
        // watcher would have seen it — the fold still adopts a submit on the next
        // stored event, in both paths.
        for (const record of sections) syncRecordBlocks(record, []);
        syncSteerBlocks(settledAt ?? lastAppliedStamp, []);

        // The wire copy is built here, from the exact recorded text: the block the
        // section designates as its tail (T23, R23) stays whole — an answer, a thinking
        // window, or the current call's recorded request/response — and so does this
        // section's newest answer whenever a later block holds the tail (R2, T1:
        // `isFullCarrier` is the one rule for the op stream AND for this read), while
        // everything older arrives bounded with its exact `chars` beside it. The carrier is a
        // per-section cached read (`record.latestTextNodeId`), so this map costs O(nodes) per
        // section, not O(prose x nodes) (P3). `record.section.tail` is the
        // designation the op stream just published, so this is the SAME projection the
        // stream delivered, which is why a reload paints what the stream painted.
        return {
            turnId: turn.id,
            sections: sections.map((record) => ({
                ...copyValue(record.section),
                nodes: record.section.nodes.map((node) => wireNodeOf(record, node))
            }))
        };
    };

    const attachmentSummaries = () =>
        (turn.attachments ?? []).map((attachment) => {
            const inlinable =
                attachment.kind === 'image' &&
                typeof attachment.data === 'string' &&
                attachment.data.length > 0 &&
                attachment.data.length <= DISPLAY_ATTACHMENT_INLINE_CHARS;

            return {
                id: attachment.id,
                marker: attachment.marker,
                name: attachment.name,
                kind: attachment.kind,
                mime: attachment.mime,
                size: attachment.size,
                ...(inlinable ? { data: attachment.data } : {}),
                hasBytes: typeof attachment.data === 'string' ? attachment.data.length > 0 : false
            };
        });

    const steerSummaries = () =>
        (turn.steers ?? []).map((steer) => {
            // The board needs a steer's DESTINATION; today it resolves that by
            // walking invocations (turns.ts:390). One lookup here, on the wire.
            const target =
                steer.threadId === undefined ? undefined : sections.find((record) => record.section.threadId === steer.threadId);

            return {
                // The submit's durable identity travels on the row, because it is also the
                // context bar's key for this segment (`ContextBlock.id`): one identity per
                // recorded guidance text, from the audit record through the projection to
                // the click that resolves it (T13). Absent for a pre-T13 record, whose
                // segment key the fold derives instead.
                ...(steer.id === undefined ? {} : { id: steer.id }),
                at: steer.at,
                prompt: steer.prompt,
                ...(target === undefined ? {} : { sectionId: target.section.id }),
                ...(steer.threadId === undefined ? {} : { threadId: steer.threadId }),
                ...(steer.references === undefined
                    ? {}
                    : { references: steer.references.map((reference) => ({ ...reference })) })
            };
        });

    const blockSummaries = (): TurnSummary['blocks'] =>
        blocksForTurn().map((block) => ({
            turnId: turn.id,
            ...(block.threadId === undefined ? {} : { threadId: block.threadId }),
            label: block.label,
            agent: block.agent,
            status: block.status,
            ...(block.content === undefined || block.content.length === 0
                ? {}
                : { preview: previewText(block.content, DISPLAY_BLOCK_PREVIEW_CHARS) }),
            // `isReferenceableBlock` (../frontend/ui/references.ts:44): a failed or
            // cancelled block has no usable result.
            referenceable: block.status === 'done' || block.status === 'running' || block.status === 'queued'
        }));

    const summaryOf = (): TurnSummary => {
        const status = settledStatus ?? turn.status;
        const terminal = isTerminalStatus(status);
        const active: string[] = [];

        for (const record of sections) {
            if (record.terminal || record.placeholder || !record.started) continue;
            if (!active.includes(record.agent)) active.push(record.agent);
        }

        const rootModel = byKey.get(ROOT_KEY)?.section.model;
        // The settled status line: a recorded failure text wins, a DONE turn shows the
        // model that answered (the tile's `merge(turn, model)` detail line), and a
        // cancelled turn with no message shows NOTHING rather than the model of a run
        // that never answered.
        const detail = lastError ?? (status === 'done' ? rootModel : undefined);
        const attachments = attachmentSummaries();
        const steers = steerSummaries();
        const visibleSections = sections.filter((record) => !record.placeholder).length;

        return {
            id: turn.id,
            index: turn.index,
            prompt: turn.prompt,
            status,
            state: TURN_STATE_OF[status],
            ...(turn.threadId === undefined ? {} : { threadId: turn.threadId }),
            ...(turn.threadLabel === undefined ? {} : { threadLabel: turn.threadLabel }),
            ...(turn.startedAt === undefined ? {} : { startedAt: turn.startedAt }),
            updatedAt: turn.updatedAt,
            ...(turn.usage === undefined ? {} : { usage: copyValue(turn.usage) }),
            // T3: the turn-level PRIMARY figure is the ROOT section's own latest request
            // (see `rootLatestInput`); absent when the turn's own flow made no model request.
            ...(rootLatestInput === undefined ? {} : { latestInput: rootLatestInput }),
            ...(turn.usage?.cached === undefined ? {} : { cachedInput: turn.usage.cached }),
            ...(detail === undefined || detail.length === 0 ? {} : { detail }),
            sectionCount: visibleSections,
            stepCount,
            activeAgents: terminal ? [] : active,
            ...(attachments.length === 0 ? {} : { attachments }),
            ...(turn.references === undefined || turn.references.length === 0
                ? {}
                : { references: turn.references.map((reference) => ({ ...reference })) }),
            ...(steers.length === 0 ? {} : { steers }),
            blocks: blockSummaries()
        };
    };

    const summary = (): TurnSummary => {
        const stamp = [
            turn.status,
            turn.updatedAt,
            turn.events.length,
            // T14: the row publishes the steer AUDIT ring, so its length is part of the
            // row's identity. Without it a cached row would keep the pre-steer list after
            // the store accepted guidance (a steer changes no event and no status).
            turn.steers?.length ?? 0,
            sectionOrdinal,
            stepCount,
            settledStatus ?? '',
            settledAt ?? '',
            turn.threadLabel ?? '',
            turn.usage?.total ?? ''
        ].join(':');

        if (summaryCache !== undefined && summaryStamp === stamp) return summaryCache;

        summaryCache = summaryOf();
        summaryStamp = stamp;

        return summaryCache;
    };

    // T14: adopt this turn's steer RECORD mutations right away. A steered submit is not an
    // event (`SessionTurn.steers`/`steerTexts` are record fields), so a fold that only runs
    // on `apply`/`settle` would draw the segment for guidance the user already typed only at
    // the next recorded event. The store calls this the moment it accepts a submit, with the
    // submit's own timestamp as the adoption stamp — the same `at <= stamp` gate that keeps a
    // live stream and a cold replay agreeing. The returned ops are the segments it minted,
    // exactly like `apply` returns them, so a live watcher sees the bar move with the steer.
    const syncSteers = (at: number): TurnDisplayOp[] => {
        const ops: TurnDisplayOp[] = [];

        // R18/T18: a steer addressed to a delegated conversation resolves its bar segment
        // by `section.threadId`, so the id must be adopted in the SAME frame the submit is
        // minted — this path is the only fold step that runs without a stored event.
        syncThreadIds(ops);
        syncSteerBlocks(finiteAtValue(at), ops);

        return ops;
    };

    return { turnId: () => turn.id, apply, settle, syncSteers, summary, display };
};

/**
 * Replay a recorded turn into a LIVE projector: the same fold as `projectTurn`, but
 * the caller keeps the projector so later events of a still-running turn continue
 * from the cached state instead of re-folding. Restore uses this for every turn it
 * loads, which is what makes the compiled memory warm at startup rather than built
 * per request (R4).
 */
export const refoldTurn = (turn: SessionTurn, context: DisplayProjectContext): TurnProjector => {
    const projector = createTurnProjector(turn, context);

    for (let index = 0; index < turn.events.length; index += 1) {
        const event = turn.events[index];
        const at = turn.eventTimes?.[index];

        projector.apply(event, finiteNumber(at) ? at : DISPLAY_NO_TIMESTAMP, index);
    }

    if (isTerminalStatus(turn.status)) {
        projector.settle(turn.status, turn.updatedAt);
    }

    return projector;
};

/**
 * Cold fold: the complete display state of one recorded turn, in one pass. Restore
 * and every view read go through this, so the browser folds nothing and a restart
 * rebuilds the cache instead of computing per request.
 *
 * `at` for a record WITHOUT `eventTimes` is `DISPLAY_NO_TIMESTAMP` (0), which the
 * projector reads as "no timing known" and never paints a duration from — the
 * recorded-replay rule the tile already honors (turns.ts:4778).
 */
export const projectTurn = (turn: SessionTurn, context: DisplayProjectContext): DisplayedTurn => {
    const projector = refoldTurn(turn, context);

    return { summary: projector.summary(), display: projector.display() };
};

// Sentinel `at` for a fold that has no timestamp for an event. Exported so the
// store's recorder and the tests agree on what "unknown" means.
export const DISPLAY_NO_TIMESTAMP = 0;

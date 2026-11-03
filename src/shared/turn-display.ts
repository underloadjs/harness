// Server-compiled turn DISPLAY contract (R1/R3/R4).
//
// This module is the single definition of the lightweight state the harness server
// publishes to a browser: what the UI must DRAW, never what the runtime HAPPENED to
// say. The raw record stays exactly where it is (`SessionTurn.events`,
// ../server/protocol.ts:157) and is still the authority; the display state is a
// projection of it that the SERVER computes once, caches in memory, and rebuilds
// after a restart from the durable per-step journal.
//
// Why this file exists (and why it is TYPES + CONSTANTS ONLY):
//   - The browser today folds raw events into DOM itself (see the cross-references
//     below). That is ~6k lines of client compilation repeated on every reload, and
//     it makes every wire frame carry the full tool payloads.
//   - The fold therefore moves server-side. The projection must be DOM-free and
//     isomorphic so BOTH sides can type against it, exactly like
//     ./agent-results.ts (types + pure functions, re-exported to Node and browser).
//   - No projection RUNTIME lives here. The implementation is the server-only
//     `src/server/turn-projector.ts` (owned by the server worker; not part of this
//     contract pass), so a browser that imports only these types pulls in no fold
//     code and no extra module cycles.
//
// Dependency direction is strictly ONE-WAY, and every cross-module import here is
// `import type` so nothing in this file has a runtime dependency at all except the
// numeric bounds below:
//     ../server/protocol.ts  ->  ./turn-display.ts  ->  ../harness.ts (types only)
//                                              \->  ./agent-results.ts (types only)
// `turn-display.ts` NEVER imports ../server/protocol.ts. The session-level wire
// envelopes (`SessionView`, `SessionViewStreamItem`, ...) therefore live in
// protocol.ts, which already owns `SessionThread`/`HarnessDescriptor`/
// `SessionSteerRecord`/`HarnessErrorInfo`. Where a shape here would otherwise need
// a protocol type, it declares a structural mirror instead (see `TurnRecordStatus`
// and `DisplayTurnInput`), following the precedent of `AgentResultTurn`
// (./agent-results.ts:81) which is documented as "structurally satisfied by
// SessionTurn" for the same reason.
//
// Hard invariants a producer and a renderer must both honor:
//   1. The default wire carries NO raw event. A display object never embeds a
//      `HarnessEvent`, a full `tool_result.content`, a full `tool_call.arguments`,
//      a `done.message`, a full `ToolUiPanel`, or an `AgentResultBlock.content`.
//      Every such value is bounded here, or is detail-only.
//   2. The renderer performs NO compilation: it addresses nodes by id and applies
//      ops. Nothing may be inferred from stream order, from a name, or from the
//      absence of a field. Identity, nesting, pairing, and status are decided by
//      the projector and sent explicitly.
//   3. Live and replay agree. `createTurnProjector().apply(...)` over a turn's
//      events, and the cold fold `projectTurn(turn)`, are the SAME code path, so a
//      reload renders byte-identically to the stream that produced it
//      (../server/sessions.ts:4217 is the live recorder; the journal replay is its
//      twin).
//   4. Ids are stable forever. `step.id`/`node.id` are derived from the index of
//      the event that opened them, and `turn.events` is append-only (a deletion
//      drops WHOLE turns, see ../server/sessions.ts deleteThread; it never
//      renumbers a surviving turn's events). A step id captured before a restart
//      still resolves after it.
//
// Cross-references:
//   - ../server/protocol.ts            — SessionTurn (:69), SessionSnapshot (:376),
//                                         SessionStreamItem (:493) stay UNCHANGED;
//                                         the view envelope is ADDED beside them.
//   - ../server/sessions.ts            — recorder (:4217), publish (:4028),
//                                         copyTurn (:705), copyEvent (:670),
//                                         expired action ids (:679), usage tally (:761)
//   - ../server/persistence.ts         — checkpoint document (:121), journal sibling
//   - ../frontend/ui/turns.ts          — the renderer that consumes this contract
//                                         (event switch :5046-5400, replay :5456)
//   - ../frontend/ui/tools.ts:105      — ToolState, mirrored by StepDisplayState
//   - ../frontend/ui/activity.ts:129   — replaced by TurnSummary.activeAgents
//   - ../frontend/ui/panels.ts:86      — client render bounds for panels
//   - ../core/tool-ui.ts:51            — TOOL_UI_LIMITS, the bound this projection
//                                         summarizes instead of forwarding
//   - ./agent-results.ts:62            — AgentResultBlock, whose `content` the
//                                         summary deliberately does NOT carry
//   - ./attachments.ts                 — attachment byte bounds (profile based)

import type {
    HarnessActionChoice,
    HarnessAttachment,
    HarnessEvent,
    HarnessPendingTool,
    HarnessToolOutcome,
    HarnessUsage,
    ToolMediaDescriptor
} from '../harness';
import type { AgentResultBlock, AgentResultReference, AgentResultStatus } from './agent-results';

// ---------------------------------------------------------------------------
// Bounds — the ONLY reason the display wire is smaller than the raw wire
// ---------------------------------------------------------------------------
//
// Every cap is applied by the SERVER before a frame leaves the process, so a
// renderer never has to guard a preview length. Values are UTF-16 code units
// (`.length`), the same unit `core/tool-ui.ts:62` uses, so JSON and the browser
// agree on what "280 characters" costs.

/** Settled tool result preview shown on a collapsed step row. */
export const DISPLAY_PREVIEW_CHARS = 280;

/** `tool_call.arguments` preview (the arguments are a raw JSON string, types/index.ts:100). */
export const DISPLAY_ARGS_PREVIEW_CHARS = 200;

/** One-line notice text (retry / wake / steer / answer / info). */
export const DISPLAY_NOTICE_CHARS = 400;

/** Error detail on a settled row or notice. */
export const DISPLAY_ERROR_CHARS = 600;

/** Composer `#` popup snippet per block. Deliberately far below
 *  `MAX_REFERENCE_CONTENT_CHARS` (agent-results.ts:123): expansion of a referenced
 *  block stays SERVER-side (sessions.ts `expandReferences`), so the browser never
 *  needs the full text to offer or label a reference. */
export const DISPLAY_BLOCK_PREVIEW_CHARS = 200;

/** Panel title in a step summary (`ToolUiPanel.title` allows 200, tool-ui.ts:66). */
export const DISPLAY_PANEL_TITLE_CHARS = 120;

/** First readable line of a panel, so the board shows SOMETHING without a fetch. */
export const DISPLAY_PANEL_PREVIEW_CHARS = 240;

/** Panels summarized per step. `TOOL_UI_LIMITS.panels` allows 32 panels of up to 64
 *  blocks and `totalBytes` 256 KiB (tool-ui.ts:51-73), which is why the compact wire
 *  summarizes instead of forwarding them. Extras are detail-only, never dropped:
 *  `DisplayStep.detail.hasResult` + the detail route return the verbatim event. */
export const DISPLAY_PANELS_PER_STEP = 4;

/** Media descriptors per step. Descriptors ONLY (id/kind/name/mime/size, never
 *  base64 — types/index.ts:91), and the server caps a list well below this. */
export const DISPLAY_MEDIA_PER_STEP = 16;

/** Inline base64 budget for ONE image chip in a turn summary. An image thumbnail is
 *  the only attachment byte the default wire carries; a larger clip ships metadata
 *  alone (`hasBytes: false`) and the renderer fetches the recorded attachment through
 *  the turn detail route. Chosen below the 1 MiB route cap (api.ts:487) so a
 *  attachment-heavy session list stays small. */
export const DISPLAY_ATTACHMENT_INLINE_CHARS = 96 * 1024;

// ---------------------------------------------------------------------------
// States — spelled to match the renderer, so the UI mapping is a rename
// ---------------------------------------------------------------------------

/**
 * VERBATIM mirror of `SessionTurnStatus` (../server/protocol.ts:115). Declared here
 * (not imported) to keep the one-way dependency rule. `running` is the SERVER
 * status; the renderer's own 'waiting' (../frontend/ui/turns.ts:237) is an
 * optimistic, browser-only state and is deliberately absent.
 */
export type TurnRecordStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

/** Folded tile state. Mirrors `TurnState` (../frontend/ui/turns.ts:237) minus the
 *  browser-only 'waiting': the server pre-applies the `running -> streaming` mapping
 *  that `stateOf` performs today, so the tile prints `state` verbatim. */
export type TurnDisplayState = 'queued' | 'streaming' | 'done' | 'error' | 'cancelled';

/** One agent flow. 'open' = started but nothing committed yet. */
export type SectionDisplayState = 'open' | 'streaming' | 'done' | 'error' | 'cancelled';

/** Exact mirror of `ToolState` (../frontend/ui/tools.ts:105). */
export type StepDisplayState = 'running' | 'ok' | 'error' | 'cancelled';

/** Structural role of a section, decided by the SERVER from the harness entry agent
 *  (`start.agent === primary`, ../frontend/ui/turns.ts:5065). */
export type DisplayRole = 'primary' | 'subagent';

/** Tone of a one-line notice. Mirrors the tile's existing notice kinds. */
export type DisplayNoticeTone = 'retry' | 'wake' | 'error' | 'steer' | 'answer' | 'info';

// ---------------------------------------------------------------------------
// Compact satellites (summaries that REPLACE inlined raw structures)
// ---------------------------------------------------------------------------

/** One panel as the compact wire sees it. The board still shows the panel's
 *  identity, placement and first line WITHOUT a click, and the full `ToolUiPanel`
 *  (all cells, all rows) arrives on the step's detail request. `truncated` makes the
 *  difference explicit instead of a silent loss. */
export type DisplayPanelBlockSummary =
    | { type: 'text'; length: number }
    | { type: 'table'; rows: number; columns: number }
    | { type: 'keyValue'; items: number };

export type DisplayPanelSummary = {
    /** `ToolUiPanel.id`, stable within one tool result (types/index.ts:1015). */
    id: string;
    /** `ToolUiPanel.slot` — an OPEN string by contract (types/index.ts:1005). */
    slot: string;
    title: string;
    blocks: DisplayPanelBlockSummary[];
    /** Bounded first readable line. Absent when the panel has no text content. */
    preview?: string;
    /** True when the summary dropped block CONTENT (cells, extra rows, extra
     *  panels beyond `DISPLAY_PANELS_PER_STEP`). Never implies the result is gone:
     *  it is on the detail route. */
    truncated: boolean;
    /** How many panels this result actually carries (>= blocks summarized). Lets
     *  the board say "+3 more panels" instead of hiding them. */
    totalPanels: number;
};

/** Media on the compact wire = the existing descriptor projection, unchanged
 *  (already byte-free at the source, see types/index.ts:85-98). */
export type DisplayMediaSummary = ToolMediaDescriptor;

/** One composer chip on the compact wire. `data` is present ONLY for an image
 *  small enough to inline (`DISPLAY_ATTACHMENT_INLINE_CHARS`); every other clip is
 *  identity + size, with `hasBytes: true` telling the renderer a fetch can still
 *  show it. */
export type DisplayAttachmentSummary = {
    id: string;
    marker: string;
    name: string;
    kind: HarnessAttachment['kind'];
    mime: string;
    /** DECODED byte length, same meaning as `HarnessAttachment.size`. */
    size: number;
    /** Canonical base64, no `data:` prefix (types/index.ts:56). */
    data?: string;
    /** True when recorded bytes exist and are simply not inlined here. */
    hasBytes: boolean;
};

/** A `#`-referenceable block (an agent invocation) WITHOUT its full text. This is
 *  what the composer popup and the reference graph need; `AgentResultBlock.content`
 *  (./agent-results.ts:74, up to 100 000 chars) is deliberately excluded. */
export type DisplayBlockSummary = {
    turnId: string;
    /** Same semantics as `AgentResultBlock.threadId`: absent = the ROOT invocation,
     *  otherwise the invocation key (a runtime thread id, or the stable synthetic
     *  key `call:<callId>` / `inline:<agent>`). */
    threadId?: string;
    label: string;
    agent: string;
    status: AgentResultStatus;
    /** Bounded snippet of the block's latest committed prose. */
    preview?: string;
    /** `isReferenceableBlock` (../frontend/ui/references.ts:44) decided server-side,
     *  so the popup applies one boolean instead of a status rule. */
    referenceable: boolean;
};

/** One steered submit, as the board must ROUTE it. Mirrors `SessionSteerRecord`
 *  (../server/protocol.ts:180) plus the destination the UI currently resolves by
 *  walking invocations (`tryRenderSteer`, ../frontend/ui/turns.ts:390). */
export type DisplaySteerSummary = {
    at: number;
    prompt: string;
    /** Set ONLY when the steer belongs to a nested invocation of this turn. */
    sectionId?: string;
    /** The persistent conversation the text was delivered to, when it is not this
     *  turn's own thread (a steered delegated child; protocol.ts:186-190). */
    threadId?: string;
    references?: AgentResultReference[];
};

/** A question the model asked its owner. Bounded and INLINE, because answering
 *  must be possible without a round trip: the card shows the options the moment the
 *  question arrives. The full `HarnessActionRequest` also rides the detail route. */
export type DisplayActionOption = {
    id: string;
    label: string;
    description?: string;
};

export type DisplayActionSummary = {
    requestId: string;
    question: string;
    options: DisplayActionOption[];
    /** The option to highlight, when the model recommended one (types/index.ts:852). */
    recommended?: string;
    /** Always true by contract (free text is never switchable off). */
    allowCustom: true;
    /** The recorded answer, once there is one. */
    answered?: {
        choice: HarnessActionChoice;
        source: 'owner' | 'auto';
        at?: number;
    };
    /** True when this request can no longer be answered: an expired/already-answered
     *  id. The server knows (sessions.ts:679 `expiredActionIds`), the card must not
     *  guess from elapsed time. */
    expired: boolean;
};

// ---------------------------------------------------------------------------
// Nodes and steps (the flow inside one agent section)
// ---------------------------------------------------------------------------

/**
 * Where a step's FULL payloads live. One click, one request, exact pair.
 *
 * `stepId` is the index of the event that OPENED the step (a `tool_call` or an
 * `action_request`); `resultStepId` is the index of the matching settled event
 * (`tool_result` / `action_answer`). The projector resolves that pairing by
 * `callId` WITHIN the opening event's own invocation identity (its `thread.id` /
 * branch / agent lane), never by name and never positionally, which is the rule
 * ../frontend/ui/turns.ts:5127-5186 applies today. Because the opener's index pins
 * the invocation, the same `callId` in a nested child of the SAME turn is a
 * different step with its own pair — no aliasing.
 */
export type DisplayStepDetailRef = {
    /** == `DisplayStep.id`; the opening event's index as a decimal string. */
    stepId: string;
    /** Index of the settled event, as a decimal string, when one was recorded. */
    resultStepId?: string;
    /** False while the call is still running, or for a call that never settled
     *  (cancelled mid-flight, an abandoned failed attempt). */
    hasResult: boolean;
    /** True when the compact preview hit a bound, i.e. the detail carries strictly
     *  more than the summary. */
    truncated: boolean;
};

/** One tool call (or owner question) as the compact wire sees it. */
export type DisplayStep = {
    kind: 'tool' | 'action';
    /** Stable: String(event index of the OPENING event). Also the detail key. */
    id: string;
    turnId: string;
    sectionId: string;
    /** `HarnessToolCall.id` / `action_request.callId` (types/index.ts:108). Carried
     *  so a renderer can keep its own per-call DOM handle; identity for the wire is
     *  `id`. */
    callId?: string;
    /** Tool name, or the action's question title for kind 'action'. */
    name: string;
    argsPreview?: string;
    preview?: string;
    state: StepDisplayState;
    /** Authoritative when present; never re-derived from `isError` on the client
     *  (../frontend/ui/turns.ts:5125). */
    outcome?: HarnessToolOutcome;
    /** Server-measured span (types/index.ts:1845). Absent = never measured. */
    durationMs?: number;
    startedAt?: number;
    endedAt?: number;
    /** Absent means "this frame says nothing"; an empty array means "nothing is
     *  running". The distinction is load-bearing (turns.ts:5142-5151). */
    pending?: HarnessPendingTool[];
    panels?: DisplayPanelSummary[];
    media?: DisplayMediaSummary[];
    /** Present for kind 'action' only. */
    action?: DisplayActionSummary;
    detail: DisplayStepDetailRef;
};

/** Streamed prose. `committed: false` marks an attempt window a later `retry` may
 *  discard; the CLIENT never acts on that flag — the projector sends explicit
 *  `node:remove` ops — it only exists so a reloaded client can style an in-flight
 *  attempt the same way a live one looks. */
export type DisplayTextNode = {
    kind: 'text';
    /** Stable: String(event index that OPENED this attempt window). */
    id: string;
    text: string;
    committed: boolean;
};

export type DisplayReasoningNode = {
    kind: 'reasoning';
    id: string;
    text: string;
    /** Server-computed share of the turn's tokens for the think chip
     *  (../frontend/ui/tools.ts:907 formatThinkShare behavior); absent when no usage is known. */
    share?: number;
};

export type DisplayNoticeNode = {
    kind: 'notice';
    id: string;
    tone: DisplayNoticeTone;
    text: string;
    at?: number;
    /** The step this notice explains (a retry line naming a discarded attempt, a
     *  wake line), when there is one. */
    stepId?: string;
};

export type DisplayNode = DisplayTextNode | DisplayReasoningNode | DisplayStep | DisplayNoticeNode;

/** What `node:set` may change. Text/reasoning CONTENT changes only through
 *  `node:append`; a step changes only through `step:set` (full replace).
 *
 *  T4 addition (additive): `text` rewrites a NOTICE's line in place. One per-section
 *  status line ("pending · read 1.2s") is rewritten many times per turn, and a
 *  remove+insert pair would flicker the row the renderer keeps last. */
export type DisplayNodePatch = {
    committed?: boolean;
    share?: number;
    text?: string;
};

// ---------------------------------------------------------------------------
// Sections and the compiled display tree
// ---------------------------------------------------------------------------

/** One agent flow: the turn's root invocation, or one nested invocation/branch. */
export type TurnSection = {
    /** Stable, opaque, server-minted: `${turnId}:${ordinal}` in allocation order. */
    id: string;
    /** Nesting resolved by the SERVER from `HarnessThread.parentId`/`callId`/
     *  `branchId` (types/index.ts:1669). A renderer never infers a parent. */
    parentSectionId?: string;
    role: DisplayRole;
    agent: string;
    /** The block label (`RR2`) — one sequence with the conversation label
     *  (./agent-results.ts, T14). */
    agentLabel: string;
    model?: string;
    /** Runtime invocation identity (the id a `HarnessEvent.thread.id` carries). */
    invocationId?: string;
    /** PERSISTENT conversation (protocol.ts:362 semantics) — what focus, steer and
     *  delete act on. */
    threadId?: string;
    threadLabel?: string;
    branchId?: string;
    state: SectionDisplayState;
    startedAt?: number;
    endedAt?: number;
    /** Token label, two scopes, precomputed (../frontend/ui/tokens.ts):
     *  `latestInput` = the LATEST request's input, `cachedInput` = turn-wide cached. */
    latestInput?: number;
    cachedInput?: number;
    /** Pointer to the node holding this section's copy target (the last committed
     *  answer). A pointer, not a copy: the prose travels once, never twice. */
    answerNodeId?: string;
    /** Display order. Empty for a freshly opened section. */
    nodes: DisplayNode[];
};

/** Field-level patch for an existing section (`section:set`). Absent = unchanged;
 *  a `turn`/`step` upsert replaces its whole object instead. */
export type TurnSectionPatch = {
    state?: SectionDisplayState;
    role?: DisplayRole;
    model?: string;
    agentLabel?: string;
    invocationId?: string;
    threadId?: string;
    threadLabel?: string;
    branchId?: string;
    startedAt?: number;
    endedAt?: number;
    latestInput?: number;
    cachedInput?: number;
    answerNodeId?: string;
};

/** The compiled tree of ONE turn: root section first, then nested invocations in
 *  allocation order. Flat with `parentSectionId` (not a nested array) so a client
 *  can address, patch and re-parent a section without rebuilding a tree. */
export type TurnDisplay = {
    turnId: string;
    sections: TurnSection[];
    /** Counters/ids the client needs to keep numbering consistent when it adopts a
     *  partial view: the highest section ordinal and the highest node id sequence
     *  observed so far. Optional because a full view never needs them. */
    lastSectionOrdinal?: number;
};

// ---------------------------------------------------------------------------
// The compact row
// ---------------------------------------------------------------------------

/**
 * Everything one turn TILE shows, computed by the server from the recorded turn.
 * This REPLACES the client reading `SessionTurn.events`/`eventTimes`
 * (../frontend/ui/turns.ts:5456) — no event list, no times array, no full block
 * content, no full panel, no full attachment bytes.
 */
export type TurnSummary = {
    id: string;
    index: number;
    /** Verbatim recorded prompt (protocol.ts:121). */
    prompt: string;
    /** Server status, verbatim spelling. */
    status: TurnRecordStatus;
    /** Folded tile state (the tile prints this, never a mapping). */
    state: TurnDisplayState;
    threadId?: string;
    threadLabel?: string;
    startedAt?: number;
    updatedAt: number;
    /** Server-owned token tally (protocol.ts:163-168) plus the two tile figures. */
    usage?: HarnessUsage;
    latestInput?: number;
    cachedInput?: number;
    /** Short status line for a settled tile (the model name, the error text, the
     *  cancellation reason). Bounded by `DISPLAY_ERROR_CHARS`. */
    detail?: string;
    sectionCount: number;
    stepCount: number;
    /** Agent names with live work in this turn. Replaces
     *  ../frontend/ui/activity.ts:129 walking every event. Empty = nothing runs. */
    activeAgents: string[];
    /** Chips render without a fetch; bytes only for small images. */
    attachments?: DisplayAttachmentSummary[];
    references?: AgentResultReference[];
    steers?: DisplaySteerSummary[];
    /** Composer `#` popup source, replacing `TurnHandle.blocks()`
     *  (../frontend/ui/turns.ts:381) — no client fold, no full content. */
    blocks: DisplayBlockSummary[];
};

// ---------------------------------------------------------------------------
// Stream operations
// ---------------------------------------------------------------------------

/**
 * One display mutation. Ops are ADDRESSED by id and carry bounded payloads, so the
 * browser applies them without understanding what happened.
 *
 * Ordering contract (the whole point of the op stream):
 *   - a `section:open` precedes every op that names its `sectionId`;
 *   - a `node:insert` precedes every `node:append`/`node:set`/`node:remove` naming
 *     that node, and precedes a `step:set` for a step that is not yet present;
 *   - `step:set` REPLACES the step object with the same `id` (no field merging —
 *     a step is small enough to resend and merging only creates ambiguity);
 *   - `section:set` patches the fields it names and leaves the rest;
 *   - `attempt:discard` names the exact nodes to drop, so a retry never depends on
 *     the client tracking an attempt window;
 *   - `index` on `node:insert` is the position WITHIN `section.nodes`; absent means
 *     append at the end. Only out-of-order recovery uses it, which keeps the normal
 *     stream free of bookkeeping;
 *   - a terminal `view` frame (protocol.ts `SessionViewStreamItem`) carries the
 *     authoritative summaries and trees, so any missed op is reconciled by the
 *     frame that ends the stream — exactly how today's terminal `snapshot` frame
 *     works (../server/sessions.ts:4028 fan-out, ../frontend/main.ts:6937).
 */
export type TurnDisplayOp =
    | { op: 'turn'; turnId: string; summary: TurnSummary }
    | { op: 'section:open'; turnId: string; section: TurnSection }
    | { op: 'section:set'; turnId: string; sectionId: string; patch: TurnSectionPatch }
    // T4 addition (additive): a delegation placeholder row minted when the CALL was
    // seen can be discarded when the attempt failed or the turn ended before the
    // child started. The renderer detaches that flow; it never happens to a section
    // that produced a node.
    | { op: 'section:remove'; turnId: string; sectionId: string }
    | { op: 'node:insert'; turnId: string; sectionId: string; node: DisplayNode; index?: number }
    | { op: 'node:append'; turnId: string; sectionId: string; nodeId: string; delta: string }
    | { op: 'node:set'; turnId: string; sectionId: string; nodeId: string; patch: DisplayNodePatch }
    | { op: 'node:remove'; turnId: string; sectionId: string; nodeId: string }
    | { op: 'step:set'; turnId: string; sectionId: string; step: DisplayStep }
    | { op: 'pending:set'; turnId: string; sectionId: string; pending?: HarnessPendingTool[] }
    // `sectionId` is the literal 'turn' for the turn-wide figures (the tile line),
    // a section id for that invocation's own line (../frontend/ui/turns.ts:5199).
    | { op: 'usage'; turnId: string; sectionId: string | 'turn'; latestInput?: number; cachedInput?: number; usage?: HarnessUsage }
    | { op: 'attempt:commit'; turnId: string; sectionId: string }
    | { op: 'attempt:discard'; turnId: string; sectionId: string; nodeIds: string[] };

// ---------------------------------------------------------------------------
// Lazy detail — the exact request AND response of one step
// ---------------------------------------------------------------------------

/**
 * The on-click answer: the recorded OPENING event and the recorded RESULT event,
 * both VERBATIM (the same bytes `copyEvent`, ../server/sessions.ts:670, stores),
 * with their indices and their `eventTimes` entries. Nothing is truncated here and
 * nothing is re-projected: the request/response pair for one tool call is
 * retrievable exactly, once, by one request, before or after a restart.
 *
 * Why the pair and not one event: the compact wire shows a collapsed row, and the
 * full request (raw `arguments`) and the full response (`content`, every
 * `ToolUiPanel`, every media descriptor) are what a details dialog must draw
 * together. Fetching them separately would double the round trips and could pair
 * them differently for same-name siblings.
 */
export type TurnStepDetail = {
    sessionId: string;
    turnId: string;
    /** Echo of the requested key (== `opening.index` as a string). */
    stepId: string;
    /** The invocation this step belongs to (identity scoping, see the pairing rule
     *  on `DisplayStepDetailRef`). */
    sectionId: string;
    /** The tool-call identity these two events share, when both carry one. */
    callId?: string;
    /** Recorded event that opened the step (`tool_call` / `action_request`). */
    opening: {
        index: number;
        at?: number;
        event: HarnessEvent;
    };
    /** Recorded event that settled it (`tool_result` / `action_answer`). Absent
     *  while running, or for a call that never settled — the honest answer, never a
     *  synthesized one. */
    result?: {
        index: number;
        at?: number;
        event: HarnessEvent;
    };
};

// ---------------------------------------------------------------------------
// Projector contract (implemented server-side in src/server/turn-projector.ts)
// ---------------------------------------------------------------------------

/**
 * The minimal recorded-turn shape the fold reads. `SessionTurn`
 * (../server/protocol.ts:117) satisfies it structurally, exactly like
 * `AgentResultTurn` does for ./agent-results.ts:81 — which is what keeps this
 * module free of a protocol import.
 */
export type DisplayTurnInput = {
    id: string;
    index: number;
    prompt: string;
    status: TurnRecordStatus;
    startedAt?: number;
    updatedAt: number;
    events: readonly HarnessEvent[];
    eventTimes?: readonly (number | undefined)[];
    usage?: HarnessUsage;
    threadId?: string;
    threadLabel?: string;
    attachments?: readonly HarnessAttachment[];
    references?: readonly AgentResultReference[];
    steers?: readonly DisplaySteerSummary[];
    /** The server's OWN block projection for this turn (`listAgentResultBlocks`,
     *  ./agent-results.ts:652). The fold turns it into `DisplayBlockSummary[]`
     *  instead of re-deriving labels, so one label sequence rules everywhere. */
    blocks?: readonly AgentResultBlock[];
};

/** Everything the fold needs that is NOT inside one turn record. */
export type DisplayProjectContext = {
    /** The harness entry agent: the only agent whose section is `role: 'primary'`. */
    primary: string;
    /** `SessionSnapshot.labelSeeds[turnId]` — the per-code counters as of this
     *  turn's start (protocol.ts:466), so a deletion never renumbers a label. */
    labels?: Readonly<Record<string, number>>;
    /** Invocation id -> conversation display label (persisted as
     *  `HarnessSessionRecord.threadLabels`, ../server/persistence.ts:156). */
    threadLabels?: ReadonlyMap<string, string>;
    /** Request ids the answer route refuses (restored/expired, sessions.ts:679). */
    expiredRequestIds?: ReadonlySet<string>;
    /** T4 addition (additive, optional): the store's OWN block projection for this
     *  turn (`listAgentResultBlocks` seeded with `labels`/`threadLabels`, i.e.
     *  ./sessions.ts `projectionTurns`). The fold turns those blocks into
     *  `DisplayBlockSummary` rows rather than re-minting labels, so one label
     *  sequence rules everywhere and the projector needs no label state of its own. */
    blocksOf?: (turn: DisplayTurnInput) => readonly AgentResultBlock[];
};

/** The compiled pair for one turn. */
export type DisplayedTurn = {
    summary: TurnSummary;
    display: TurnDisplay;
};

/**
 * Incremental fold for ONE live turn. `apply` is a pure event -> ops mapping: the
 * recorder calls it once per stored event and fans the returned ops out, so a
 * watcher never sees an op the stored record does not justify.
 *
 * `settle` closes a turn (status/cancel/error transitions that are NOT events;
 * ../server/sessions.ts:4303 publishes the turn frame around them).
 */
export type TurnProjector = {
    turnId: () => string;
    apply: (event: HarnessEvent, at: number, index: number) => TurnDisplayOp[];
    settle: (status: TurnRecordStatus, at: number) => TurnDisplayOp[];
    summary: () => TurnSummary;
    display: () => TurnDisplay;
};

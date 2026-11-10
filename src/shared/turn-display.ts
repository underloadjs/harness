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
//   5. Every character COUNT is exact, and no count is ever inferred from a
//      preview (T9). `ContextBlock.chars` and `DisplayTextNode.chars` measure
//      RECORDED bytes; the text beside them may be bounded, the number is not. A
//      context bar is therefore a character distribution over the record — never a
//      token estimate and never a context-window percentage (those figures stay on
//      `TurnSummary.usage`/`latestInput`/`cachedInput`).
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

/** Collapsed text for a prose node that is neither its section's current tail block nor
 *  its newest ANSWER (T9, R1/R3; T23, R23; T1, R2). A node streams in full while the server
 *  designates it the tail (`TurnSection.tail`), and an answer KEEPS its whole text while a
 *  later thinking window or call holds the tail — the newest answer is a second full
 *  carrier (`turn-projector.ts` `isFullCarrier`), because the board prints that response
 *  above the current block. The instant a NEWER answer takes the tail the projector
 *  rewrites it to a preview of this size — for a thinking window AND for an answer, so
 *  "no historical full-text replay" is one rule, not two. T26 (R26): the preview keeps the
 *  LATEST `DISPLAY_NODE_PREVIEW_CHARS` characters behind a leading `…`, not the opening ones,
 *  which is what lets a reader watch a body's newest lines on a live stream, on a reconnect
 *  and on a reload alike (`turn-projector.ts` `previewTextTail`); the browser applies the same
 *  direction to a whole body it has to window (../frontend/view-context.ts
 *  `contextTextSuffixOf`). The exact length always
 *  travels beside it (`DisplayTextNode.chars` / `DisplayReasoningNode.chars`) and the
 *  verbatim text is one click away on
 *  `GET views/:id/turns/:tid/blocks/:blockId`. Set above `DISPLAY_PREVIEW_CHARS`
 *  (a one-line tool result) because a collapsed answer/reasoning block is a paragraph
 *  the reader may still want to skim without a fetch. */
export const DISPLAY_NODE_PREVIEW_CHARS = 320;

// NO tail payload cap (T23 set the tail, T25 removed this cap, R23): "the current block
// in full" means the EXACT recorded bytes, so the display contract adds no second bound of
// its own to a designated `tool_call.arguments` / `tool_result.content`. Whatever the
// record can hold is already bounded where it is produced —
// `MODEL_TOOL_RESULT_BUDGET_BYTES` (../core/result-budget.ts:42) caps a model-facing
// result — and a tail that stopped at a display cap would print LESS than the record
// holds while the UI claims it is printing the block the reader is looking at. The size is
// paid for ONCE per section (one designated block at a time, every older payload dropped in
// the frame that replaced it, and no re-send per delta — ../server/turn-projector.ts
// `tailStampOf`), never once per frame. R2 (T1) adds a second whole prose body per section
// — the newest answer, beside the current tail block — and it costs no traffic of its own:
// that answer already streamed to the client whole while it held the tail, and only the one
// transition patch bounds it again.


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

/** Tone of a one-line notice. Mirrors the tile's existing notice kinds.
 *  T16 (R16a): the server no longer mints `retry` — a transient model-request retry is
 *  internal, and its evidence lives in the raw `retry` event (journal / CLI / the raw
 *  watcher), not in the compiled tree. The tone stays so an older document, the CLI-side
 *  mirrors and a hand-written producer all still type-check, and the board still paints
 *  one if it ever meets one. */
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
    /** The submit's durable identity, minted once by the server (T13). It is also the
     *  context bar's key for this segment (`ContextBlock.id`, line 381), which is what
     *  keeps two submits recorded in one millisecond apart and makes a trimmed audit ring
     *  unable to renumber a survivor. Absent only on a record written before the field
     *  existed, where the fold derives a deterministic occurrence key instead. */
    id?: string;
    at: number;
    prompt: string;
    /** Set ONLY when the steer belongs to a nested invocation of this turn. */
    sectionId?: string;
    /** The persistent conversation the text was delivered to, when it is not this
     *  turn's own thread (a steered delegated child; protocol.ts:186-190). */
    threadId?: string;
    references?: AgentResultReference[];
};

/** One archived steered submit — a structural mirror of ../server/protocol.ts
 *  `SessionSteerText`, declared here so this module keeps its one-way import rule.
 *  `steers` (above) is the bounded OPERATIONAL audit; this is the durable TEXT archive the
 *  context bar mints and resolves its segments from, because a submit that fell out of the
 *  audit ring must still answer a click with its exact recorded text (R8). */
export type DisplaySteerText = {
    /** The submit's durable identity, minted once by the server (`SessionSteerRecord.id`).
     *  It is also the context bar's segment key (`i${id}`, `ContextBlock.id`), so an
     *  archived entry stays resolvable after the audit ring has moved past it. */
    id: string;
    at: number;
    /** The EXACT submitted text, verbatim. Never on the default wire: a bar segment is
     *  metadata, and this text is what the one lazy block route returns on a click. */
    prompt: string;
    /** The conversation the submit was delivered to, when it is not the turn's own thread
     *  (the same attribution `DisplaySteerSummary.threadId` carries). */
    threadId?: string;
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
// Context blocks — ONE horizontal bar of character distribution (R6/R8)
// ---------------------------------------------------------------------------
//
// What a context block IS: one SEGMENT of the turn's context bar — one entry of
// recorded conversation text reduced to identity + timing + an EXACT character count.
// What it is NOT: a token figure, or a context-window percentage. This is a CHARACTER
// distribution over what the server actually recorded, worded that way on purpose,
// because the token numbers answer a different question and live elsewhere
// (`TurnSummary.usage`/`latestInput`/`cachedInput` below and the recorded
// `SessionTurn.usage`, ../server/protocol.ts:168-173 — provider-reported, never derived
// here). Nothing in this section estimates a tokenizer, models a window budget, or
// derives a count from a bounded field: every `chars` figure is measured from recorded
// bytes (invariant 5).
//
// THE CLOSED SOURCE LIST (R6 — every kind, from real evidence, counted EXACTLY once):
//   - `user`      : the turn record's `prompt`, plus one block per `steers[i].prompt`;
//   - `system`    : the turn's recorded `TurnInstructionSource` for the section's agent,
//                   as ONE block per section — and none at all when no source was
//                   recorded (never a reconstruction from the live catalogue);
//   - `reasoning` : a window of consecutive recorded `reasoning` deltas;
//   - `assistant` : a window of consecutive recorded `text` deltas, falling back to a
//                   `done` event's message content ONLY when that window holds no
//                   deltas — the two carry the same bytes, so counting both would
//                   double the answer;
//   - `tool`      : one recorded `tool_call` and its paired `tool_result` (ONE block,
//                   both parts, see `chars`).
//
// Nothing else mints a block, because nothing else carries conversation TEXT:
// `action_request`/`action_answer` re-present the very same recorded actionRequest call
// the `tool` block already counts; `usage`, `wakeup`, `retry`, `attempt_commit`,
// `branch_start`/`branch_end` and `error` are progress/metadata frames; and a notice
// node is server-written prose, not model context. A persistent thread's transcript
// (`SessionThread.messages`) is never a source either, so a tool result that also lives
// in that transcript is counted once, not twice.
//
// Assembly: ONE bar per turn, read off `TurnSection.context` in section order (`display
// .sections` order: the turn's root flow first, then nested invocations in allocation
// order — the order the transcript itself prints), and within a section in recorded
// conversation/event order, starting with that section's `system` block (the server
// emits them in that order; a renderer never sorts, never pairs and never totals).
// Identity, order and the instruction source are all server-resolved — the renderer
// still compiles nothing (invariant 2) — and every entry appears EXACTLY once, from
// the single source listed above, never from a second projection of the same bytes.
//
// Deliberately NO text and NO preview field: the bar stays bounded however long the
// conversation is. Exactly TWO payloads are ever full on the default wire, each through
// its OWN designated path, which is why they are not duplicated into a block:
//   - the user prompt  -> `TurnSummary.prompt` (the existing row, unchanged);
//   - a section's CURRENT tail block -> `TurnSection.tail` (R23, T23). The server names
//     the one newest eligible block of the section — thinking, an answer, or a tool call
//     (a call while it runs, its complete result once it settles) — and its bytes travel
//     once: prose as the whole `DisplayTextNode`/`DisplayReasoningNode.text`, a tool as
//     `DisplayTail.args`/`DisplayTail.result`. Every OLDER block is metadata here and
//     `DISPLAY_NODE_PREVIEW_CHARS`-bounded on its node.
// `TurnSection.answerNodeId` is now purely the copy target: the tail designation owns
// which body is whole (they name the same node whenever an answer IS the tail).
// Everything else is fetched per block, on a click, verbatim:
// `GET {mount}/views/:id/turns/:tid/blocks/:blockId` -> `{ block: TurnBlockDetail }`.
//
// INVARIANT 5 (new, T9): a `chars`/`argsChars`/`resultChars` figure is ALWAYS the
// exact UTF-16 code-unit length of recorded text (`.length`, the same unit every
// `DISPLAY_*` bound uses, lines 95-99). It is never inferred from a preview, a
// summary, or a token estimate, so the bar's numbers survive every bound applied to
// the wire text, before and after a restart.
//
// Cross-references:
//   - this file                       — `TurnSection.context`, the `context:*` ops,
//                                       `TurnInstructionSource`, `TurnBlockDetail`
//   - ../server/protocol.ts:608-614, 711 — the blocks route + `SessionBlockDetailResponse`
//   - ../server/persistence.ts:182      — `HarnessSessionRecord.turnInstructionSources`
//                                       (durable per-turn instruction snapshot)
//   - ../server/sessions.ts:2673        — `SessionStore.stepDetail`, the sibling that
//                                       `SessionStore.blockDetail` resolves beside
//   - ../server/turn-projector.ts       — the fold that mints/removes blocks

/** What kind of recorded text a segment stands for. The SERVER decides the tone;
 *  a renderer maps kind/state to a colour and never classifies text itself:
 *  `tool` settles green (`state: 'ok'`) or red (`state: 'error'` / `'cancelled'`),
 *  `reasoning` is amber, and `system` / `assistant` / `user` are neutral. */
export type ContextBlockKind = 'user' | 'system' | 'reasoning' | 'assistant' | 'tool';

/**
 * One segment of the context bar. METADATA ONLY — carries no text, so the default
 * wire never grows with the length of the conversation, only with its number of
 * entries (every entry is a fixed-size record; there is no cap, because R6/R8 need
 * EVERY segment and its exact count).
 */
export type ContextBlock = {
    kind: ContextBlockKind;
    /**
     * Stable, unique WITHIN the turn, and the detail route's key:
     * `${sectionOrdinal}-${kind}-${key}` (`t1:2`'s ordinal is `2`, so a settled tool
     * call opened by event 7 is `2-tool-7`). `key` is unique inside one section:
     *   - `tool` / `reasoning` / `assistant` -> the recorded event index that OPENS
     *     the block (same derivation as `DisplayStep.id`, line 558, so the step and
     *     the bar segment agree by construction). An `assistant` block opened by a
     *     `done` event — the no-deltas fallback in the source list above — uses THAT
     *     event's index, and an `action_request` never mints one at all;
     *   - `system`     -> `instructions` (exactly one system block per section);
     *   - `user`       -> `prompt`, or for a steered submit its OWN recorded identity:
     *     `i${id}` from `SessionSteerRecord.id` (`DisplaySteerSummary.id`, the id the server
     *     mints once when it accepts the guidance). A submit with an identity can never
     *     collide with another and can never be renumbered when the audit ring truncates.
     *     A submit recorded before the field existed has no id, and the key is DERIVED:
     *     `s${at}-${promptLength}` from the recorded submit itself, with `-1`, `-2`, ...
     *     appended only for a second and later submit that derives the SAME pair (the same
     *     millisecond and the same text length), so each submit still owns exactly one
     *     segment (R6). Both forms come from one function
     *     (../server/turn-projector.ts `steerBlockKeysOf`), never from the array position —
     *     that list is a bounded ring (a store keeps the last 64, sessions.ts
     *     `MAX_STEER_RECORDS`) and front-truncation must never renumber a surviving
     *     steer. A steer block sits in the section
     *     `DisplaySteerSummary.sectionId` names when that is a nested invocation, and
     *     in the turn's root section otherwise — the same destination the board
     *     already routes a steer to, never a guess;
     * A block discarded with a failed attempt is REMOVED by id and never renumbered,
     * so an id captured before a restart still resolves after it (invariant 4).
     */
    id: string;
    turnId: string;
    sectionId: string;
    /**
     * Display label, decided by the server so the renderer invents nothing: the
     * recorded tool name (`read`, `delegate`, …) for a tool block, and the fixed
     * strings `instructions` / `reasoning` / `answer` / `prompt` / `steer` for the
     * other kinds. Re-stamped by `context:set` ONLY when the recorded name changes; a
     * duplicate result for an already-settled call never rewrites it.
     */
    name: string;
    /**
     * Recorded time this block's text entered the conversation: the opening event's
     * `eventTimes` entry, a steer's `at`, or the turn's `startedAt` for the prompt.
     * ABSENT when the record carries no timestamp — never `DISPLAY_NO_TIMESTAMP` (0)
     * on the wire, so a renderer never paints a fake time.
     */
    at?: number;
    /** Settle time of a tool block (its `tool_result`'s recorded time). Absent while
     *  the call is still running, and for every other kind. */
    endedAt?: number;
    /**
     * Time taken, in milliseconds, so a segment shows its duration without a fetch.
     * This is ONLY ever a value the record supports — never a re-derivation or an
     * estimate:
     *   - `tool` -> the tool's own measured span (`tool_result.durationMs`,
     *     ../types/index.ts:1839-1845 — the same figure `DisplayStep.durationMs`
     *     carries). Deliberately NOT `endedAt - at`: a background call's recorded
     *     span is the runtime's measurement, and a call that never settled or never
     *     measured reports NOTHING;
     *   - `reasoning` / `assistant` -> the span of the recorded stream window
     *     (`eventTo`'s timestamp minus `eventFrom`'s), present ONLY when the window
     *     holds two distinct events with real timestamps;
     *   - `user` / `system` -> absent: a submitted prompt and an instruction set have
     *     no recorded span to report.
     */
    durationMs?: number;
    /**
     * EXACT character count of this block's recorded text (invariant 5). Composition
     * is unambiguous, per kind:
     *   - `tool`      -> `argsChars + (resultChars | 0)`; the two fields below name
     *                    the parts, so a bar segment can say "args 1.2k + result 8k"
     *                    without re-deriving anything;
     *   - `system`    -> the sum of the instruction entries' lengths (the join the
     *                    transport applies between messages is NOT counted);
     *   - everything else -> `TurnBlockDetail.text.length` for this block.
     */
    chars: number;
    /** `tool` only: exact length of the recorded `tool_call.arguments` string (raw
     *  JSON, ../types/index.ts:100) — for a call still running this is every argument
     *  byte recorded SO FAR, which is all the record holds. Absent for a result that
     *  was recorded with no matching call (see `id`). */
    argsChars?: number;
    /** `tool` only: exact length of the recorded `tool_result.content`. ABSENT while
     *  no result is recorded (then `chars === argsChars`), present-and-exact after it
     *  settles, including a failed or cancelled result (its text really is delivered
     *  to the model). */
    resultChars?: number;
    /**
     * True when this block's recorded text is part of the agent's committed
     * transcript, i.e. the requests that follow carry it: system instructions, the
     * user prompt, a steered submit, a committed answer, and a tool block whose text
     * is a settled result (a failed/cancelled result message is delivered to the
     * model too) or only the arguments of a call still running (those travelled with
     * the committed assistant message that asked for the call).
     *
     * False when it is not: a `reasoning` block, always — thinking is streamed and
     * recorded but never replayed into the next request. This is tracked explicitly
     * so a bar never assumes every counted segment is prompt text.
     */
    inPrompt: boolean;
    /**
     * T7 (docs/tasks/2026-11-09-context-inclusion-followups.md): the READER-facing
     * inclusion axis — is this segment's transcript entry switched into the requests
     * that follow. Deliberately NOT folded into `inPrompt`: `inPrompt` is the projector's
     * static per-kind verdict (a `reasoning` window is never replayed whatever a reader
     * does), while this is the state the reader controls from the segment dialog and the
     * state `turn.before setIncluded` writes from a plugin (src/harness.ts:8528-8567).
     *
     * Tri-state, mirroring core's storage rule (`src/core/agent.ts:161-207` persists only
     * a literal `false` and drops the key otherwise):
     *   - `false`  — the owning transcript unit IS excluded; `projectTranscript` drops the
     *     whole tool-call unit around it (src/harness.ts:6421-6460), so this states the
     *     EFFECT of the cascade, not one message's flag;
     *   - `true`   — the unit resolves and is switched on, which is what lets the dialog
     *     offer the toggle BACK rather than showing a dead end;
     *   - ABSENT   — this server could not name the transcript entry behind the segment
     *     (a `reasoning`/answer window spans many entries, a system block joins several
     *     messages, or the opening event carries no call id), so a renderer keeps its
     *     `inPrompt` verdict and offers no control.
     *
     * Published by the block detail route (src/server/api.ts `getSessionTurnBlock`), the
     * one read that has BOTH the recorded event and the live transcript in hand; the
     * display tree carries it when a producer states it, and `display-project.ts` copies
     * it only when the wire stated it (never a local guess).
     */
    included?: boolean;
    /** `tool` only: the settled state, verbatim `StepDisplayState`. Absent until the
     *  call settles, and never re-derived by the renderer from `isError` (the same
     *  authority rule as `DisplayStep.outcome`, line 572). */
    state?: StepDisplayState;
    /** First recorded event index whose bytes compose this block (the `tool_call`,
     *  the first `reasoning`/`text` delta of the window). Absent for a block with no
     *  event evidence — the user prompt block and a system block — which is also how
     *  a reader knows the payload comes from the record's `prompt`/`steers` or the
     *  turn's instruction sources. */
    eventFrom?: number;
    /** LAST recorded event index (inclusive) that composes this block: equal to
     *  `eventFrom` for a tool call opened by one event whose result is not recorded
     *  yet, the `tool_result` index once it settles, and the final delta index of a
     *  reasoning/answer window. `SessionStore.blockDetail` concatenates exactly this
     *  recorded range, so the detail is a pure function of the durable record and a
     *  restart answers with identical bytes. */
    eventTo?: number;
};

/**
 * What `context:set` may change. Identity fields (`id`, `kind`, `turnId`,
 * `sectionId`, `eventFrom`) are immutable — a block that would change one is a
 * `context:remove` + `context:add` pair instead, never a patch. Every count is a
 * full replacement, not a delta: the projector sends the settled figure, so a client
 * accumulates nothing.
 */
export type ContextBlockPatch = {
    name?: string;
    state?: StepDisplayState;
    chars?: number;
    argsChars?: number;
    resultChars?: number;
    inPrompt?: boolean;
    at?: number;
    endedAt?: number;
    durationMs?: number;
    eventTo?: number;
};

/**
 * The on-click answer for ONE segment: the block's metadata (the SAME values the bar
 * shows, embedded by value so a detail can never disagree with its segment) plus the
 * EXACT recorded bytes.
 *
 * This is the R8 surface for EVERY kind, not only tools — `TurnStepDetail` (line 886)
 * answers with the two verbatim recorded EVENTS of a step, while this answers with
 * the block's recorded TEXT, which is what a context bar needs to show for a prompt,
 * an instruction set, a reasoning window or an earlier answer. Panels and media are
 * deliberately not repeated here: they ride the step route, which carries those
 * events whole.
 *
 * Which payload field is present, per kind (absent ONLY when the record holds no
 * such bytes — never a synthesized value):
 *   - `user`      -> `text` == the recorded `turn.prompt`, or a steer's recorded
 *                    `prompt`; `chars === text.length`. A steered segment resolves
 *                    through the turn's COMPLETE submit list (../server/protocol.ts
 *                    `SessionTurn.steerTexts` archive plus any `steers` audit entry the
 *                    archive does not name), so every submit the bar drew answers with
 *                    its own bytes (R8). A submit that is in NO list — a document written
 *                    before the archive existed whose audit entry the 64-entry ring has
 *                    truncated — answers 404, never a success with no text;
 *   - `assistant` -> `text` == the recorded `text` deltas of `eventFrom..eventTo`
 *                    concatenated in order, or (no-deltas fallback) that one `done`
 *                    event's `message.content`; `chars === text.length`;
 *   - `reasoning` -> the recorded `reasoning` deltas of the same range;
 *                    `chars === text.length`;
 *   - `tool`      -> `args` == the recorded `tool_call.arguments` string and
 *                    `result` == the recorded `tool_result.content`;
 *                    `chars === (args?.length ?? 0) + (result?.length ?? 0)`. An
 *                    actionRequest answers the same way — its `action_request` /
 *                    `action_answer` frames carry no extra model-facing bytes;
 *   - `system`    -> `entries`, the instruction text the agent ACTUALLY ran with,
 *                    one entry per recorded system message in send order;
 *                    `chars === entries.reduce((n, e) => n + e.length, 0)`.
 */
export type TurnBlockDetail = ContextBlock & {
    sessionId: string;
    text?: string;
    args?: string;
    result?: string;
    entries?: readonly string[];
};

/**
 * The system-instruction SOURCE one agent ran with, recorded per turn so a section's
 * system block keeps the SAME `chars` after a restart AND after someone edits the
 * instruction later (R4/R6 — recorded metadata must not silently mutate).
 *
 * Only ACTUAL known sources are recorded: `Agent.instructions`
 * (../types/index.ts:449) for a live run, restored from the durable snapshot
 * otherwise, and never a reconstruction from the catalogue of a build the session
 * did not run on. A turn with no recorded source for an agent emits NO system block
 * for it — an honest absence beats a fabricated count, and it is why a legacy
 * database keeps working unchanged (the field below is optional).
 */
export type TurnInstructionSource = {
    /** Registry agent name — matches `TurnSection.agent`. */
    agent: string;
    /** Exact instruction entries in send order; each becomes its own
     *  `role: 'system'` message (../core/agent.ts:339). The composed
     *  `Guidelines:` block is part of the entry the profile builds
     *  (../agents/guidelines.ts), so it is counted, not invented. */
    instructions: readonly string[];
    /** When the server captured this snapshot (epoch ms), so a reader can see the
     *  snapshot predates a later edit rather than assuming it still matches. */
    at?: number;
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

/**
 * Streamed prose. `committed: false` marks an attempt window a later `retry` may
 * discard; the CLIENT never acts on that flag — the projector sends explicit
 * `node:remove` ops — it only exists so a reloaded client can style an in-flight
 * attempt the same way a live one looks.
 *
 * T9 text bounding (R1/R3), narrowed by T23 (R23) and by T1 (R2): `text` is the WHOLE
 * answer while the server designates this node its section's CURRENT tail block
 * (`TurnSection.tail`) — AND while it is the section's NEWEST recorded answer even after a
 * later thinking window or tool call takes the tail, which is what lets the board keep an
 * intermediate response readable above that block. Any later ANSWER takes the tail, and the
 * projector then sends one `node:set` patch carrying a
 * `DISPLAY_NODE_PREVIEW_CHARS` preview, the exact `chars`, and `redacted: true` — that
 * is how "no historical full-text replay on reconnect" is enforced on BOTH the live
 * stream and a cold view, with no client-side rule about which node is last. The reader
 * needs no second designation for the newest answer: `section.nodes` is display order, so
 * the last `kind: 'text'` node IS it, and its `redacted` marker is absent by the same rule
 * that keeps the tail's marker absent.
 */
export type DisplayTextNode = {
    kind: 'text';
    /** Stable: String(event index that OPENED this attempt window). */
    id: string;
    text: string;
    committed: boolean;
    /** EXACT recorded length of this node's text in UTF-16 units, whether or not
     *  `text` above is all of it (invariant 5). The field is optional only so a pre-T9
     *  fixture/record stays valid; a server-produced node always carries it — at
     *  insert, and again in the patch that redacts the node. While a node is the
     *  CURRENT answer its `text` is complete, so `chars === text.length` and either
     *  figure is the truth; the moment `redacted` is set, `chars` is the ONLY honest
     *  length, and a renderer must not measure the preview. */
    chars?: number;
    /** True when `text` is a bounded preview and the verbatim text is ONLY on this
     *  node's block detail route. Explicit, so a click decision needs no length
     *  comparison; absent means this node's `text` is the whole answer. */
    redacted?: true;
};

export type DisplayReasoningNode = {
    kind: 'reasoning';
    id: string;
    /** R23 (T23): a thinking window is a full-text carrier EXACTLY while it is its
     *  section's designated tail (`TurnSection.tail`) — it then streams every delta,
     *  whole, and its `redacted` marker is absent. The moment a later block takes the
     *  tail the projector replaces this with `DISPLAY_NODE_PREVIEW_CHARS` bounded text
     *  and stamps `redacted: true`, so a historical window is never a full body and is
     *  still one click away on its lazy detail route. (R2, T1 gives the second full
     *  carrier to `DisplayTextNode` only: a superseded ANSWER stays whole, a superseded
     *  think window does not.) */
    text: string;
    /** Server-computed share of the turn's tokens for the think chip
     *  (../frontend/ui/tools.ts:907 formatThinkShare behavior); absent when no usage is known. */
    share?: number;
    /** Exact recorded length of this node's reasoning text (invariant 5): the figure
     *  the chip prints when the wire text IS a preview, and the same figure the tail
     *  caption prints beside a whole body. It is sent with the node and refreshed by the
     *  SAME redaction patch that bounds the text when the node loses the tail, so the
     *  count stays exact while the body stops being whole. Same `redacted` marker and
     *  the same optional-for-compatibility rule as `DisplayTextNode.chars`. */
    chars?: number;
    /** True when `text` is a bounded preview; the full reasoning text is on the
     *  block detail route (its block is always `inPrompt: false`). */
    redacted?: true;
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
    /** T9 addition (additive): the exact recorded length (invariant 5). Sent while a
     *  bounded node keeps growing, so an in-flight think chip shows the true length
     *  after the wire stopped carrying its text. */
    chars?: number;
    /** T9 addition (additive): set in the SAME patch that swaps a superseded
     *  answer's `text` for a preview, so redaction is stated, never inferred. */
    redacted?: true;
    /** T23 addition (R23): `false` states the OPPOSITE in the same addressed patch —
     *  this node's `text` is the WHOLE recorded bytes again, because a discard removed
     *  the block that superseded it and the node regained the tail. Absent means "no
     *  statement", `true` means preview, `false` means whole (and the client drops its
     *  `redacted` marker), so a live tree can never keep a stale preview the cold
     *  document no longer shows. */
    unredacted?: true;
};

// ---------------------------------------------------------------------------
// The ONE current tail block of a section (T23, R23)
// ---------------------------------------------------------------------------
//
// WHAT IT IS: the server's designation of the single content block a section displays
// IN FULL, immediately after that section's context strip. "Whatever block it is, it is
// in the tail" — the newest recorded thinking window, the newest answer, or the newest
// tool call (its arguments while it runs, its complete result once it settles). The two
// exceptions are the ones the user named: `system` instructions and the `user` prompt
// are never the tail, because each already owns its own surface (the instruction text is
// bar-only and lazy, and the prompt rides `TurnSummary.prompt`).
//
// WHY THE SERVER DECIDES IT: the fold knows the block it just wrote, in the order it
// wrote it, with the exact recorded bytes in hand. If the browser picked the tail it
// would be re-doing the compilation this wire removed (and the historical pile of think
// chips is what that produced), and a live frame would disagree with a reloaded one.
//
// WHY IT STAYS COMPACT: one designated body per section at a time, and supersession
// DROPS the previous one — prose by rewriting the node to a preview (`redacted: true`),
// a tool by omitting `args`/`result` from the descriptor that moves away. The payload
// never repeats per token: prose streams through `node:append`, and a tool's payload
// moves only when the recorded bytes move (the call, then the result). R2 (T1) keeps ONE
// extra whole prose body per section — the newest ANSWER, so the response above the
// current block stays readable — and it is free for the same reason: those bytes already
// streamed while it held the tail, and it is bounded again by the very patch that a newer
// answer's own frame already owes.
//
// Cross-references:
//   - ./turn-projector.ts `resolveTail`/`syncTail` — the one implementation
//   - ./turn-projector.ts `isFullCarrier`          — who may travel whole (the tail, and
//     the newest answer: R2, T1), on the op stream and in the compiled document alike
//   - ../frontend/view-context.ts `contextTailOf`  — the renderer's reader of this
//   - ../frontend/ui/turns.ts `paintTail`          — the body it paints under the strip

/** The three content kinds eligible to be a section's displayed block. `user` and
 *  `system` are excluded by rule (each has its own surface), an `action` step is an
 *  interactive question with its own card, and a `notice` (wake / error / answered /
 *  pending line) is server-written status prose — never model content, so it can never
 *  erase the block a reader is looking at. */
export type DisplayTailKind = 'reasoning' | 'assistant' | 'tool';

/**
 * The ONE block this section displays as its CURRENT body, resolved and re-stamped by the
 * server. (R2, T1: this section's newest ANSWER is a second full-text carrier on the node
 * itself, so a whole body is not proof of a designation — the designation is, and it never
 * moves because of that second carrier.)
 *
 * A POINTER plus the block's own full payload — never a copy of the tree:
 *   - `reasoning` / `assistant` -> the body is the node's `text`, which is COMPLETE
 *     while the node holds this designation; the descriptor carries no duplicate.
 *   - `tool`                    -> the body is `args` (the complete recorded
 *     `tool_call.arguments`) and, once settled, `result` (the complete recorded
 *     `tool_result.content`), each the EXACT recorded bytes with no display-side cap
 *     (T25). The
 *     call's identity, state, span, panels and media are NOT duplicated here: they ride
 *     the `DisplayStep` this `nodeId` names.
 *
 * `blockId` is provenance, not a fetch instruction: it names the context-bar segment
 * this block stands for, so the strip and the body can never disagree, and the exact
 * per-part figures (`argsChars`/`resultChars`) stay on that segment.
 */
export type DisplayTail = {
    kind: DisplayTailKind;
    /** The node this body renders — a `DisplayTextNode`/`DisplayReasoningNode` id, or a
     *  `DisplayStep` id for a tool. Addressed, never searched for by name or position. */
    nodeId: string;
    /** The context segment of this same block, when the section recorded one (a server
     *  producer always does). */
    blockId?: string;
    /** EXACT recorded characters of this block (invariant 5), as of this designation.
     *  While a prose block is still streaming the segment's own `chars` is the moving
     *  figure, and a renderer reads that one first; this field is the honest fallback
     *  and the number a tool's payload was measured against. */
    chars: number;
    /** True when the payload below is strictly less than what the record holds. A
     *  server producer never sets it (T25, R23: a designated payload is the exact
     *  recorded bytes, and a prose tail is whole by construction); the field stays so a
     *  producer that DOES bound one states it, instead of letting a prefix read as the
     *  whole block. Never inferred from a length comparison. */
    truncated: boolean;
    /** `tool` only: the complete recorded `tool_call.arguments` string (raw JSON,
     *  ../types/index.ts:100). Absent when the record holds no call for this step (a
     *  result-only legacy frame), never an empty-string claim. */
    args?: string;
    /** `tool` only: the complete recorded `tool_result.content`. ABSENT while the call
     *  has no recorded result (still running, cancelled, or an abandoned attempt) — the
     *  same honest absence the step's `preview` uses. */
    result?: string;
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
     *  delete act on.
     *
     *  T18/R18: this is now set for a DELEGATED child section too, not only for the
     *  turn's own root row. The join comes from `DisplayProjectContext.invocationThreadIds`
     *  (../server/sessions.ts `Session.invocationThreads`), so a delegated conversation is
     *  addressable and separable from its parent inside one turn: one stable id across
     *  every run of that conversation, live and after a restart. Absent still honestly
     *  means "no recorded join" (a legacy document, or a branch that owns no
     *  conversation), never "the root conversation". */
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
     *  answer). A pointer, not a copy: the prose travels once, never twice.
     *
     *  T9 used this as the full-text designation; T23 (R23) moved that job to `tail`
     *  below, because the block a reader is actually looking at is the newest one of
     *  ANY kind, not only an answer. The two name the same node whenever a committed
     *  answer IS the section's current tail, and Copy keeps working off this pointer
     *  when the newest block is a tool call. */
    answerNodeId?: string;
    /**
     * T23 addition (additive, R23): this section's ONE displayed content block — the
     * newest recorded thinking window, answer or tool call — with its full payload
     * attached (see `DisplayTail`, line 745). ABSENT means "this producer says nothing
     * about the tail" (a pre-T23 document), and a renderer then falls back to its own
     * reading of the recorded order rather than inventing a full body.
     *
     * Every earlier block of this section renders as metadata only: a bar segment, a
     * `DISPLAY_NODE_PREVIEW_CHARS` node preview at most, and its exact bytes on one
     * lazy click. The projector re-stamps this field the moment the newest block
     * changes, and the superseded payload is dropped in the same frame.
     *
     * R2 (T1) is the one exception to "every earlier block", and it is NOT a second
     * designation: this section's newest `kind: 'text'` node keeps its whole `text` on the
     * wire even while a later reasoning window or call holds this tail, so the board can
     * keep the assistant response visible above the current block. An answer only goes
     * preview-sized when a NEWER answer supersedes it (or once it is hidden), and
     * `redacted` is absent on it by exactly that rule — no new field, and no change to how
     * this pointer is resolved or stamped.
     */
    tail?: DisplayTail;
    /** Display order. Empty for a freshly opened section. */
    nodes: DisplayNode[];
    /**
     * T9 addition (additive): this section's segments of the turn's ONE context bar,
     * in recorded conversation/event order (system instructions first, then every
     * prompt/steer, answer, reasoning window and tool call as they were recorded).
     * Metadata only — no text, so the bar costs a fixed amount per entry
     * (`ContextBlock`). A click resolves a segment exactly:
     * `GET views/:id/turns/:tid/blocks/:blockId`.
     *
     * ABSENT means "this frame says nothing about context" (a pre-T9 record/cache or
     * a frame that carried no context change), which is NOT the same as an empty bar:
     * `[]` is the server's authoritative "this section has no context entries". A
     * server-produced section ALWAYS carries the field (empty when the section has
     * nothing to report); optional only so a pre-T9 fixture or an older producer stays
     * byte-compatible.
     */
    context?: ContextBlock[];
};

/** Field-level patch for an existing section (`section:set`). Absent = unchanged;
 *  a `turn`/`step` upsert replaces its whole object instead.
 *
 *  `context` is deliberately absent here: a context block is added, changed and
 *  removed by its own `context:*` op (addressed by `blockId`), so a section patch
 *  never re-sends the whole bar. */
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
 *  can address, patch and re-parent a section without rebuilding a tree.
 *
 *  THIS IS THE WIRE SHAPE (T9, narrowed by T23/R23): every node text here is bounded as
 *  documented on `DisplayTextNode`/`DisplayReasoningNode` EXCEPT the one block each
 *  section designates as its `tail`, and the exact lengths live in `chars`.
 *  The projector keeps the EXACT recorded text internally — it must, or `chars` and
 *  the lazy block detail would have nothing to be exact about — and sanitizes on the
 *  way out (`display()`, `summary()` and the ops it emits). A view frame is therefore
 *  never a source of historical full text, while
 *  `GET views/:id/turns/:tid/blocks/:blockId` still returns the whole thing. */
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
    /** The LATEST single model request's input FOR THIS TURN'S OWN (root) SECTION, and
     *  only that (T3, user-reported display bug — this reverses the old emission-order
     *  rule, see ../server/turn-projector.ts `rootLatestInput`). A delegated child's
     *  request never moves it: its figure rides its own `TurnSection.latestInput`.
     *  ABSENT means the turn's own flow made no request with a reported context; a
     *  renderer then shows NO primary figure rather than falling back to `usage.input`,
     *  which is a turn-wide SUM (children included). `cachedInput` below keeps folding
     *  children — that pairing of scopes is the intentional accounting. */
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
    // T9 additions (additive) — the ONE context bar. Ordering contract, the same
    // shape the node ops already honor:
    //   - `context:add` precedes every `context:set`/`context:remove` naming that
    //     `blockId`, and carries the WHOLE block (metadata is small enough to send
    //     once; a patch merges, an add never does);
    //   - blocks arrive in conversation/event order, so a renderer appends. Only
    //     out-of-order recovery passes `index` (the position WITHIN
    //     `section.context`), exactly like `node:insert`;
    //   - `context:set` patches the fields it names and leaves the rest; identity
    //     fields never change in place (see `ContextBlockPatch`), so a re-minted
    //     block is a `context:remove` + `context:add` pair;
    //   - a discarded attempt removes exactly the blocks it created, by id — the
    //     client never guesses which segments belonged to a failed attempt;
    //   - the bar's full state is on the terminal `view` frame
    //     (`TurnSection.context`), so a missed op is reconciled the same way.
    | { op: 'context:add'; turnId: string; sectionId: string; block: ContextBlock; index?: number }
    | { op: 'context:set'; turnId: string; sectionId: string; blockId: string; patch: ContextBlockPatch }
    | { op: 'context:remove'; turnId: string; sectionId: string; blockId: string }
    // T23 additions (additive, R23) — the ONE current tail block per section. Ordering
    // contract, the same shape every other addressed op honors:
    //   - `tail:set` REPLACES the whole descriptor (identity + payload) for the section it
    //     names; it never patches a field, so there is no merge rule and no way to keep a
    //     stale payload from the block that used to hold the tail;
    //   - it follows the `node:insert`/`step:set`/`node:append` frames that establish the
    //     designated node, so a client can always resolve `tail.nodeId` inside the SAME
    //     frame it receives the designation;
    //   - `tail:clear` is the honest "this section has no displayed block" (its last
    //     eligible node was discarded with a failed attempt, or the section never produced
    //     model content) — an absent field on a cold document means a producer that said
    //     nothing at all, which is NOT the same statement;
    //   - a superseded prose body is withdrawn by the `node:set` preview patch that
    //     `tail:set` accompanies, and a superseded tool payload simply is not in the new
    //     descriptor: the compact view never holds two full blocks;
    //   - the full state is on the terminal `view` frame (`TurnSection.tail`), so a missed
    //     op is reconciled the same way as every other op class.
    | { op: 'tail:set'; turnId: string; sectionId: string; tail: DisplayTail }
    | { op: 'tail:clear'; turnId: string; sectionId: string }
    | { op: 'pending:set'; turnId: string; sectionId: string; pending?: HarnessPendingTool[] }
    // `sectionId` is the literal 'turn' for the turn-wide figures (the tile line),
    // a section id for that invocation's own line (../frontend/ui/turns.ts:5199).
    //
    // T3: for `sectionId: 'turn'`, `latestInput` is the turn's OWN (root) section's latest
    // request ONLY — never a delegated child's, whatever reported last — and it is ABSENT
    // when the root flow made no reported request (see `TurnSummary.latestInput`). `usage`
    // remains the turn-wide tally that folds every section.
    | { op: 'usage'; turnId: string; sectionId: string | 'turn'; latestInput?: number; cachedInput?: number; usage?: HarnessUsage }
    | { op: 'attempt:commit'; turnId: string; sectionId: string }
    | { op: 'attempt:discard'; turnId: string; sectionId: string; nodeIds: string[] };

// ---------------------------------------------------------------------------
// Lazy detail — the exact request AND response of one step
// ---------------------------------------------------------------------------
//
// The SECOND lazy surface, for one context-bar segment, is `TurnBlockDetail` in the
// context section above (../server/protocol.ts:613 route). The two do not overlap: a
// STEP answers with verbatim recorded EVENTS, a BLOCK answers with the block's
// recorded TEXT of any kind.

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
    /** T14: the turn's durable TEXT ARCHIVE of steered submits (../server/protocol.ts
     *  `SessionTurn.steerTexts`, `SessionSteerText`): EVERY submit the server accepted,
     *  keyed by its own id, not the bounded audit ring. `steers` is a 64-entry ring whose
     *  only job is the audit and the row; the context bar draws one segment per submit and
     *  a click must answer for every one of them (R8), so the fold mints its steered
     *  segments from THIS list when the turn has one and falls back to the ring for a
     *  document written before the archive existed. */
    steerTexts?: readonly DisplaySteerText[];
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
    /** T18 addition (additive, optional): invocation id -> the PERSISTENT conversation
     *  (`HarnessThreadRecord.id`) that run executed in, from the store's OWN join
     *  (../server/sessions.ts `Session.invocationThreads`, persisted as
     *  `HarnessSessionRecord.invocationThreads`, ../server/persistence.ts:188).
     *
     *  WHY THE STORE HAS TO SUPPLY IT (R18): a delegated child's frames name only its
     *  runtime INVOCATION id (`HarnessEvent.thread.id`, ../types/index.ts:1669) — the
     *  persistent conversation is a DIFFERENT namespace and nothing inside the recorded
     *  event stream states it. `parentSectionId` gives nesting, not identity, so without
     *  this join every delegated section is emitted with `threadId` absent: a renderer
     *  cannot address that conversation (focus/steer/delete), cannot give it its own
     *  context bar, and cannot tell two runs of ONE conversation apart from two separate
     *  conversations. The store already holds the exact mapping — the roster's
     *  `SessionThreadView.invocationIds` (../server/protocol.ts:437) is the same map
     *  projected per thread — so the fold takes it as given instead of inventing a second
     *  identity allocator.
     *
     *  A branch invocation is deliberately NOT in the map (a branch is transcript-
     *  ephemeral and owns no conversation; ../server/sessions.ts records the join only
     *  for frames with no `thread.kind`/`thread.branchId`), so a branch section keeps the
     *  thread id its own `branch_start` frame reported and nothing else changes.
     *
     *  The fold NEVER guesses: no entry means the section omits `threadId`, exactly like
     *  a pre-T18 document, which keeps those records byte-identical. */
    invocationThreadIds?: ReadonlyMap<string, string>;
    /** Request ids the answer route refuses (restored/expired, sessions.ts:679). */
    expiredRequestIds?: ReadonlySet<string>;
    /** T4 addition (additive, optional): the store's OWN block projection for this
     *  turn (`listAgentResultBlocks` seeded with `labels`/`threadLabels`, i.e.
     *  ./sessions.ts `projectionTurns`). The fold turns those blocks into
     *  `DisplayBlockSummary` rows rather than re-minting labels, so one label
     *  sequence rules everywhere and the projector needs no label state of its own. */
    blocksOf?: (turn: DisplayTurnInput) => readonly AgentResultBlock[];
    /** T9 addition (additive, optional): the recorded system-instruction sources for
     *  ONE turn, per agent, that the fold turns into the section's single `system`
     *  context block (`ContextBlock`, `chars` = the sum of the entries).
     *
     *  WHY A RESOLVER AND NOT AN EVENT: no harness event carries an instruction, so
     *  the projector cannot derive it and must not guess one. The store owns the
     *  evidence — `Agent.instructions` of the live run, frozen into
     *  `HarnessSessionRecord.turnInstructionSources` (./persistence.ts) — and hands
     *  the SAME value to a live fold and to a cold replay, which is what keeps a
     *  system block's `chars` identical across a restart and stable after a later
     *  instruction edit.
     *
     *  `undefined` (or no entry for a section's agent) means NO recorded source, and
     *  the fold emits NO system block for it. An absent field is therefore not an
     *  empty bar: never fabricate instructions from the live catalogue for a turn
     *  that did not run with them. */
    instructionSourcesOf?: (turn: DisplayTurnInput) => readonly TurnInstructionSource[] | undefined;
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
 *
 * Every value it returns — `summary()`, `display()` and the ops of `apply`/`settle` —
 * is the sanitized WIRE shape (see the note on `TurnDisplay`): bounded node text, exact
 * `chars`, and the context bar's `ContextBlock` metadata. The fold's internal state
 * keeps the exact recorded text, so bounding the output never costs the lazy detail
 * route anything, and a live frame and a replayed one are byte-identical.
 */
export type TurnProjector = {
    turnId: () => string;
    apply: (event: HarnessEvent, at: number, index: number) => TurnDisplayOp[];
    settle: (status: TurnRecordStatus, at: number) => TurnDisplayOp[];
    /** T14: adopt the turn's STEER record mutations (`SessionTurn.steers` audit ring +
     *  `steerTexts` archive) without waiting for the next recorded event. Steered guidance
     *  is a record field, not an event, so the fold would otherwise draw its context
     *  segment only at the next model boundary — leaving a submit the user already made
     *  invisible while the run is active. `at` is the adoption stamp (the submit's own
     *  recorded time), and the same stamp gate makes a live call and a cold replay mint the
     *  same segments. Returns the ops for the segments it minted, like `apply` does; `[]`
     *  when there is nothing new. */
    syncSteers: (at: number) => TurnDisplayOp[];
    summary: () => TurnSummary;
    display: () => TurnDisplay;
};

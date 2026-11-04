// Turn tiles: one tile per logical user → assistant exchange, laid out as a
// single vertical list of full-width rows.
//
// Turn boundaries are server data, not browser inference. The server records one
// `SessionTurn` per submitted task (`id`, `index`, `prompt`, `status`, `events`)
// and returns that list from `GET /sessions`, `GET /sessions/:id` and in the
// snapshot frames of the queue observer. This module renders those records:
//
//   - `begin(prompt)` creates an optimistic tile for a prompt the browser is
//     about to enqueue, before the server has a turn for it. It starts `queued`
//     and NEUTRAL: no spinner, no elapsed clock;
//   - `bind(turn)` attaches the server id/index when the POST /tasks answer (or a
//     stream `turn` frame) arrives, so later `event` frames route by explicit id;
//   - `merge(turn)` reconciles an existing tile with an authoritative server record
//     (queued → running → terminal) by replaying ONLY events it has not applied
//     yet, so a reconnect/upsert never duplicates streamed text;
//   - `adopt(turn)` / `reconcile(turns)` rebuild or update tiles from a server
//     snapshot. This is how a reload, a session selection or an in-progress poll
//     renders history: the server record wins over anything the browser projected.
//
// List model (R1/R4):
//   - one linear, vertical list, chronological (the server's FIFO submission
//     order), so a task submitted while another runs visibly sits BEHIND it —
//     completed tasks grey, the single active task green, queued tasks neutral;
//   - NO timeline rule and NO marker dot: each task is a plain full-width row;
//   - every tile is a compact ONE-LINE row across the full width; only the active
//     (or user-selected) tile expands into the reading surface;
//   - expanding an older tile never destroys the newest turn's content: tiles
//     keep their DOM, only visibility changes, so a user reading turn 3 is not
//     pulled away by deltas arriving for turn 7.
//
// Delegation — one agent calling another — shows up as its own nested block inside
// the same turn (each event names its agent). R3: a nested block is the SAME
// surface as a main block (radius, header, state treatment) and differs ONLY by
// indentation; there is no "subagent" label and no role badge. Agent identity is
// carried by colour instead: every agent-owned surface is painted with the
// deterministic tone from ui/agent-color.ts (name colour + block outline), so the
// same agent keeps one colour across the whole transcript.
//
// Block anatomy (R1/R3): the main tile and every nested entry share ONE header and
// body design — a compact one-line header (`agent code · preview · elapsed | tokens
// - status`) that expands into the same body scale, the same native button
// (click/Enter/Space, `aria-expanded`/`aria-controls`) and the same `createBlockMeta`
// clock/tally implementation. They differ only by depth indentation and by the
// root's server-supplied timing.
//
// Agent labels (R2/R3): a header names its agent with the compact code from
// ui/agent-label.ts (`RH1` = first+last letter of `research` + its occurrence,
// root invocation included). Occurrence numbering is conversation-scoped: it
// continues across the session's turns, so two threads of one agent read `RR1`
// and `RR2` and a `#label` always names one block. A code is allocated ONCE
// per invocation, so a stream cannot inflate it, and a rebuilt projection
// (`resetProjection`) re-seeds the tile's frozen base and replays the record, so
// replay is deterministic. Raw agent ids never appear as text; they stay on
// `data-agent` for colour/routing and in the runtime metadata. The turn's protocol
// `index` is bound but not displayed.
//
// Collapsed blocks (R4): the main tile and EVERY nested entry are exactly one
// compact row (`.tile:not(.is-expanded)`, `.thread-row:not(.is-expanded)`).
// Whatever does not fit — prompt/task preview, status, meta — is ellipsised (or
// clipped into the accessible subtree for the meta line), never wrapped onto a
// second line. Expansion still shows everything in full.
//
// Invocation threads (R1/R2/R3). A delegated agent is its own ENTRY, not just an
// extra flat agent section: the spawned invocation gets a `.thread-row` appended
// to the spawning invocation's children host, which sits INSIDE the parent
// `.turn-row` but OUTSIDE both the parent tile body and the parent's own thread
// body. Consequences that the layout depends on:
//
//   - collapsing the parent tile hides only `.tile-body`, so the child entry is
//     still visible, and equally collapsing a child hides only that child's body;
//   - children are appended to their parent's host in spawn order, and a
//     grandchild's host lives inside its parent's row, so DOM order is exactly
//     depth-first sibling order (C1, C1's children, C2, …);
//   - nesting, not a flat list, means an arbitrary depth works without the UI
//     enumerating levels (styles.css indents one step per `.thread-children`).
//
// Identity is per INVOCATION, never per agent name: two `delegate` calls to
// the same agent are two entries, each with its own content, tools, status and
// outcome. `thread` metadata (src/frontend/contract.ts `threadOf`, frozen
// contract) is authoritative. A saved session that predates it is replayed with
// the legacy inference below instead of being left as invisible rows.
//
// Concurrency (R6): tools are scheduled concurrently and the agent's response can
// finish while its own calls are still running. Three additive frames drive this
// view, none of them a new tile state:
//   - `tool_result.durationMs` — the call's authoritative span;
//   - `tool_result.pending` / `done.pending` — calls still running, rendered as a
//     `pending · name 1.2s` line in the agent section (and a "still running"
//     count in the tile meta) while the cards themselves stay untouched;
//   - `wakeup` — the agent resumed because pending work progressed. It appends a
//     visible marker and keeps the section active; it never resolves a card and
//     never settles the tile.
// A terminal turn (cancel/error/done from the server) abandons any call that
// never returned, because pending work is interrupted, not resumed.
//
// Rendering model: assistant text is Markdown, re-rendered per animation frame
// while it streams (see src/frontend/ui/markdown.ts for the sanitizer) and
// synced once when the turn settles. Reasoning is plain text: it is scratch
// space, not user-facing prose, and re-parsing it as Markdown would be wasted
// work for every delta.
//
// Persistent runtime threads (R5/R6/R7). A tile carries the PERSISTENT thread its
// turn belongs to (`SessionTurn.threadId`, additive) as a compact badge and as
// `data-thread-id`; repeated turns of one thread share that badge, so the transcript
// never presents them as independent conversations. Expansion IS focus: only one
// tile is ever expanded, and `focusedThread()` is that tile's runtime thread — the
// composer's steering/continue target (see src/frontend/ui/threads.ts). Do NOT join
// this identity to the invocation ids in `blocks()`: those are `#` reference
// bindings for ONE run and are a different namespace.
//
// Invocation → conversation join (R3). A nested card is keyed by the runtime
// invocation id of ONE run, while its conversation keeps running (and advancing
// `invocationId`) on every resume. The join therefore comes from the roster's
// authoritative `invocationIds` (the server's persisted invocation→thread map) and
// never from content: two identical sibling delegations are indistinguishable by
// agent/task text, and a wrong merge would mix two agent threads. When a payload
// does not send the list, the board keeps only joins it already observed while the
// single slots still named them, and otherwise leaves the invocation as detail.
//
// Cross-references:
//   - persistent threads (roster, routing, strip): src/frontend/ui/threads.ts
//   - tool cards: src/frontend/ui/tools.ts
//   - attachment chips (composer + replay): src/frontend/ui/attachments.ts
//   - attachment/image preview dialogs: src/frontend/ui/preview.ts
//   - transcript file links + bounded file preview: src/frontend/ui/file-links.ts,
//     src/frontend/ui/file-preview.ts
//   - lifecycle status (topbar pill): src/frontend/main.ts (`setLifecycle`)
//   - elapsed formatting: src/frontend/ui/time.ts
//   - editable transcript + unreadable roster (C5): src/frontend/ui/thread-transcript.ts,
//     src/frontend/api.ts (`updateThreadTranscript`) and the `saveThreadTranscript`
//     transport main.ts wires into this board
//   - styles: src/frontend/styles.css (`.turns`, `.turn-row`, `.tile`, `.agent`)
//   - queue/ack race (R2): src/server/sessions.ts `enqueue` publishes the queued
//     `turn` upsert BEFORE the 202 body is returned, so an observer frame can
//     describe a turn whose optimistic tile is still unbound (`claim`).

import type {
    DeleteThreadResult,
    HarnessEvent,
    HarnessUsage,
    SessionSnapshot,
    SessionSteerRecord,
    SessionThread,
    SessionTurn,
    SessionTurnStatus,
    SessionView
} from '../../server/protocol';
import type {
    HarnessActionAnswer,
    HarnessActionChoice,
    HarnessActionRequest,
    HarnessAttachment,
    HarnessBranchSummary,
    HarnessToolOutcome
} from '../../types';
// The compiled display contract (T5 R1/R2/R3): the row, the tree, and the ops that
// mutate both. TYPE-only for the tree shapes, plus the two DOM-free helpers the
// renderer needs — nothing here pulls in a server-side fold.
import type {
    DisplayAttachmentSummary,
    DisplayNode,
    DisplayNoticeNode,
    DisplayReasoningNode,
    DisplayStep,
    DisplayTextNode,
    SectionDisplayState,
    TurnBlockDetail,
    TurnDisplay,
    TurnDisplayOp,
    TurnSection,
    TurnStepDetail,
    TurnSummary
} from '../../shared/turn-display';
import { displayOf as displayOfView, isNewerSummary, sectionsOf, summariesOf } from '../view-state';
import { stepDetailPayloadOf } from '../view-detail';
// T11 (R7/R8): the ONE context bar. The model/geometry lives in ../view-context.ts (pure),
// the surface in ./context-bar.ts (canvas or lightweight buttons), and the click-time
// payload dialog in ./context-detail.ts. Nothing in this trio reads an event.
import {
    contextBarOf,
    contextBarReplacesChips,
    contextTailCaptionOf,
    contextTailOf,
    contextTailShowsProse
} from '../view-context';
import type { ContextBarModel, ContextTail } from '../view-context';
import { mountContextBar } from './context-bar';
import type { ContextBar, ContextBarActivateInput } from './context-bar';
import { blockDetailFingerprintOf, openBlockDetail } from './context-detail';
import type { BlockDetailDialog } from './context-detail';
import { applyAttachmentChips } from './attachments';
import { enhanceFileLinks } from './file-links';
import { openFilePreview } from './file-preview';
import type { FilePreviewReader, FilePreviewResolver } from './file-preview';
import { openAttachmentDialog, enhanceImages, openImageDialog } from './preview';
// C5 transcript editing: the PUT answer's transcript document. TYPE-ONLY, so this
// never pulls the fetch client into the UI graph at runtime.
import type { ThreadTranscriptPayload } from '../api';
import {
    closeThreadTranscript,
    openThreadTranscript,
    refreshOpenThreadTranscript
} from './thread-transcript';
import type { ThreadTranscriptRefresh } from './thread-transcript';
import {
    actionAnswerEventOf,
    actionRequestEventOf,
    attemptCommitOf,
    branchEndEventOf,
    branchStartEventOf,
    callIdOf,
    eventTimesOf,
    finiteOf,
    pendingOf,
    retryOf,
    threadOf,
    toolDurationOf,
    usageOf,
    wakeupOf
} from '../contract';
import type { HarnessPendingTool, HarnessThreadInfo } from '../contract';
import { createActionRequestCard } from './action-request';
import type { ActionRequestCard } from './action-request';
// Deterministic agent identity colour (R3): shared by the turn tile, every nested
// invocation tile and every agent section (see ui/agent-color.ts). The placeholder
// constant keeps the "cannot attribute this stream" sentinel in ONE place, so the
// tile and its section resolve to the same neutral tone.
import { UNNAMED_AGENT_PLACEHOLDER, paintAgentColor } from './agent-color';
// Compact conversation-scoped agent labels (`RH1`, `RH2`, …): the visible agent
// identity in a block header. Raw agent ids never reach the DOM as text (R2/R3);
// the board seeds each turn's allocator from the turns before it, so numbering is
// deterministic on replay and unique across the conversation.
import { createAgentLabels } from './agent-label';
// T14 parity: the shared block projection RESERVES an explicit conversation label
// in its allocator (root `turn.threadLabel` and child `threadLabels[id]`), so a
// same-code fallback invocation continues AFTER it (`RR1` + child `RR2`) instead of
// re-minting `RR1`. The board must consume the SAME parser and reservation rule.
import { agentLabelParts } from '../../shared/agent-results';
import type { AgentBlockDescriptor } from './references';
// R5: the shared accessible Copy affordance (icon + success/error feedback + the
// insecure-origin clipboard fallback that keeps an open dialog's focus trap alive).
// It lives in ui/dialog.ts because the transcript, a tool dialog and a file preview
// all copy text the same way; the tile only supplies the payload provider.
//
// T6/R5: the SAME module now also supplies the modal shell the mobile thread Delete
// confirmation runs in, so that surface gets the dialog's proven focus trap, Escape /
// backdrop dismissal, stacking and focus restoration instead of a second hand-rolled
// overlay. The transcript (ui/thread-transcript.ts) opened that layer first.
import { createTextCopyButton, openDialog } from './dialog';
import type { DialogHandle } from './dialog';
import { markdownFragment, plainPreview } from './markdown';
import { elapsedBetween, formatDuration } from './time';
import { formatTokens } from './tokens';
import { createReasoningCard, createToolCallCard } from './tools';
import type { ReasoningCard, ToolCallCard, ToolState } from './tools';
// Persistent (runtime) thread identity. This is NOT the invocation identity used by
// `#` references: `SessionTurn.threadId` names the stable conversation a turn
// belongs to, while `AgentBlockDescriptor.threadId` names one invocation. The two
// must never be joined — see ui/threads.ts for both contracts.
import {
    invalidThreadsOf,
    threadLabelOf,
    threadNameOf,
    threadTitleOf,
    turnThreadIdOf,
    turnThreadLabelOf
} from './threads';
import type { SessionThreadEntry } from './threads';

// Lifecycle of one user turn. `queued` and `waiting` are distinct on purpose:
// `queued` means the task is retained by the server behind other work (or the
// browser is enqueueing it); `waiting` means the request is on the wire and the
// first event has not arrived. Anything later is driven by real events, never by a
// timer.
//
// Server statuses map onto this set one-to-one (`running` → `streaming`); the two
// pre-request states only ever exist for an optimistic browser-created tile.
export type TurnState = 'queued' | 'waiting' | 'streaming' | 'done' | 'error' | 'cancelled';

// Server status → tile state. A running server turn is "streaming" even when the
// browser is polling a snapshot instead of holding a live stream. `queued` is a
// server status too (R4): it passes straight through so a retained task renders
// neutral instead of pretending to run.
const stateOf = (status: SessionTurnStatus | 'queued'): TurnState =>
    status === 'running' ? 'streaming' : status;

// Progress rank of a server status, used only to break an `updatedAt` TIE in the
// monotonic record guard (`merge`). The queue pump can stamp enqueue and start in
// the same millisecond, so an equal stamp must not let the LOWER record win: a
// queued record may never replace a running one, nor a running one a terminal one.
const rankOf = (status: SessionTurnStatus | 'queued'): number =>
    status === 'queued' ? 0 : status === 'running' ? 1 : 2;

// Attachments on a recorded turn (T5 clip/attach, additive).
//
// The protocol's `SessionTurn.attachments` is optional: a text-only turn (and every
// pre-attachment snapshot) simply omits it. It is read STRUCTURALLY here rather
// than relying on the protocol declaration being updated in the same change, so
// history replay renders chips as soon as the server starts sending them and keeps
// rendering the same tiles when it does not. Malformed values are ignored for
// RENDERING only (the server validates before it stores); a bad entry must never
// break the transcript.
export type SessionTurnWithAttachments = SessionTurn & { attachments?: HarnessAttachment[] };

export const turnAttachmentsOf = (source: SessionTurn): HarnessAttachment[] => {
    const value = (source as SessionTurnWithAttachments).attachments;
    if (!Array.isArray(value)) return [];

    return value.filter(
        (entry) =>
            typeof entry === 'object' &&
            entry !== null &&
            typeof entry.marker === 'string' &&
            typeof entry.name === 'string' &&
            (entry.kind === 'image' ||
                entry.kind === 'video' ||
                entry.kind === 'audio' ||
                entry.kind === 'pdf' ||
                entry.kind === 'file')
    );
};

export type TurnHandle = {
    element: HTMLElement;
    prompt: string;
    state: () => TurnState;
    // `detail` is short status text shown next to the state (a model name, an
    // error message, a cancellation reason).
    setState: (state: TurnState, detail?: string) => void;
    // Apply one recorded/streamed event. `at` is the server clock for this event
    // (SSE `at` or an `eventTimes` entry). `origin` says whether a missing `at`
    // should fall back to the local clock (`live`) or to no timing at all
    // (`recorded`, the legacy-replay path).
    apply: (event: HarnessEvent, at?: number, origin?: ApplyOrigin) => void;
    // Reconcile this tile with an authoritative server record (R4 queue): bind its
    // id/index, update status/timing/usage, and apply ONLY the events after the
    // ones this tile already holds. A streamed prefix is therefore never replayed
    // twice, which is what keeps a reconnect (live frames, then a snapshot) from
    // duplicating assistant text. Safe to call for queued, running and terminal
    // records; `model` is the detail line for a settled tile.
    merge: (turn: SessionTurn, model?: string) => void;
    // Number of `events` this tile has applied (live + recorded). Exposed for the
    // reconciliation tests and for callers that want to prove no double-apply.
    applied: () => number;
    // The last authoritative `SessionTurn` record this tile merged (queued/running/
    // terminal). Used ONLY as the standalone fallback for the JSON transcript when
    // the embedding shell does not provide a full session snapshot; live event
    // frames are not written back here, so the shell snapshot remains the richer
    // source whenever it exists.
    source: () => SessionTurn | undefined;
    // Render every pending incremental update immediately. Called when a turn
    // settles so the final text is never one frame behind the status.
    flush: () => void;
    // Server turn id, once the opening `turn` frame (or a snapshot) supplied one.
    // Undefined while the tile is an optimistic prompt with no server record yet.
    id: () => string | undefined;
    // Attach the server's identity for this turn and mirror its 1-based display
    // position. Called on the opening `turn` frame and when adopting a snapshot.
    bind: (turn: Pick<SessionTurn, 'id' | 'index'> & { startedAt?: number }) => void;
    // Replace the timing baseline. Hydration passes the server's `startedAt` and
    // (for a settled turn) `updatedAt`; a running turn gets no `endedAt` and the
    // label keeps ticking. Values may be undefined for legacy fixtures, in which
    // case no duration is shown.
    setTiming: (timing: { startedAt?: number; endedAt?: number }) => void;
    // Current elapsed label text ('' when the span is unknown). Exposed for the
    // meta line tests and for callers that need the value without reading DOM.
    elapsed: () => string;
    // Token label for this turn, TWO scopes — `150 (140)`:
    //   - primary: input/context size of the LATEST model request (provider
    //     `prompt_tokens`, including that request's cached subset);
    //   - bracket: total cached (replayed) input sent across the whole turn.
    // '' when nothing has reported usage yet, and no bracket when no cache figure
    // was reported. Set from live `usage` events + the frame/record tally; the
    // tile never invents a figure (see ui/tokens.ts and the tally block below).
    tokens: () => string;
    // Replace the cumulative server tally. Called per streamed frame and once per
    // hydrated turn; the latest-input primary is derived from the usage events,
    // not from this sum. `undefined` only clears the figure when no usage event
    // was recorded (a record's tally can be absent on legacy turns).
    setUsage: (usage?: HarnessUsage) => void;
    // Number of agent sections, tool cards and the primary agent name. Exposed
    // for tests and for the tile's meta line.
    summary: () => { agents: number; tools: number; primary?: string };
    // Persistent runtime thread this turn belongs to (`SessionTurn.threadId`,
    // additive). Undefined for a legacy record and for an optimistic tile that has
    // not been told a target yet. This — not the invocation ids in `blocks()` — is
    // what the composer focuses, continues and steers (ui/threads.ts).
    threadId: () => string | undefined;
    // Repaint everything roster-derived on this tile: the compact badge (S6) and the
    // persistent markers on its child rows (S2). Called when the roster arrives or
    // changes, so a tile and the strip always agree on the conversation's name.
    refreshThreadRoster: () => void;
    // Re-evaluate the R7/R8 transcript/delete action bar: visible while THIS tile
    // is the expanded surface and the roster names its thread.
    syncTranscriptAction: () => void;
    // Does a nested invocation of THIS turn belong to `threadId`? (S2 tie-break for
    // the board's focus resolution.)
    knowsThread: (threadId: string) => boolean;
    // Focus the nested invocation belonging to `threadId` (S2). Expands exactly that
    // child conversation, collapses every other PERSISTENT child conversation on the
    // tile (ephemeral invocation details stay independent) and the tile body, and
    // marks the row as the focused conversation. False when this tile has no match.
    focusChildThread: (threadId: string) => boolean;
    // Collapse persistent child conversations and clear their focus markers. Called
    // when focus moves to a tile / panel, or when the focused child is deleted.
    clearThreadFocus: () => void;
    // Attachments recorded for this turn (empty for a text-only turn). A tile
    // created by `begin` carries the draft's attachments until the server record
    // replaces them, so the optimistic and replayed renderings agree.
    attachments: () => readonly HarnessAttachment[];
    // Replace the inline attachment chips in the prompt. Called by `merge` with
    // the server's record (and by the optimistic path with the draft list); never
    // renders the base64 payload as text (filename/marker only, plus a safe
    // raster-image thumbnail). R10: every call re-renders the prompt so a marker
    // that moved/duplicated in the record cannot leave a stale chip behind.
    setAttachments: (attachments: readonly HarnessAttachment[]) => void;
    // Real agent blocks in this turn, root first then nested invocations, in
    // allocation order. This is the ONLY source for the composer's # reference
    // popup (ui/references.ts): each descriptor carries the exact turn/thread
    // binding, display label, raw agent id, status and latest text. Empty while
    // the tile has no server id (an unbound optimistic tile cannot be referenced).
    blocks: () => AgentBlockDescriptor[];
    // T12d F1: the steered-submit audit recorded on this turn, so the BOARD can
    // route guidance to a child conversation that lives in an EARLIER turn.
    steerAudit: () => readonly SessionSteerRecord[];
    // Render one steer into THIS tile's target conversation when it owns it:
    // `target` = this turn's own thread (or no target) -> root flow; `target` =
    // a child invocation joined by this tile -> that child flow. Idempotent by
    // `key`. False when this tile is not the target, so the board can try another
    // turn or the roster-only panel. Never renders a child steer on the parent.
    tryRenderSteer: (steer: SessionSteerRecord, sourceTurnId: string, key: string) => boolean;
    // --- display-wire path (T5: R1/R2/R3) --------------------------------
    //
    // Paint/patch this tile from COMPILED server state. `setSummary` prints the
    // compact row (status, timing, tally, attachment chips, block list, steers);
    // `renderDisplay` rebuilds the flow from the server's node tree; `applyOps`
    // mutates the existing DOM by node/step id. None of the three reads a
    // `HarnessEvent`, and `applyOps` never renumbers or re-pairs anything.
    setSummary: (summary: TurnSummary) => void;
    renderDisplay: (display: TurnDisplay) => void;
    // Reconcile the existing DOM with a whole compiled tree, keeping the surfaces
    // that are already painted (see `syncCompiledDisplay`).
    syncDisplay: (display: TurnDisplay) => void;
    applyOps: (ops: readonly TurnDisplayOp[], display?: TurnDisplay) => void;
    // True once this tile is driven by the display wire, i.e. the raw event fold is
    // not in play for it (the default browser path always sets this; a compatibility
    // embedding that still folds never does).
    compiled: () => boolean;
    // Stop every timer the tile owns (elapsed tick, tool timers, pending text
    // frame). Called when the board clears or the page is hidden.
    destroy: () => void;
};

// A missing timestamp is either a live gap (use the local clock) or an old record
// (show nothing rather than inventing a duration).
export type ApplyOrigin = 'live' | 'recorded';

export type HydrateOptions = {
    // Session model, appended to a settled tile's meta so a reloaded transcript
    // still answers "which model ran this?".
    model?: string;
    // Server turn id to keep expanded across the rebuild. Defaults to whichever
    // tile was expanded before `hydrate` cleared the board.
    keep?: string;
    // `SessionSnapshot.labelSeeds`: conversation-scoped label counters AT THE START
    // of each turn, keyed by turn id. A tile adopted with its own recorded seed keeps
    // the labels it originally allocated even when an EARLIER turn (a deleted
    // thread's) is no longer in the list — which is what stops a deletion from
    // renumbering the surviving blocks and orphaning every `#` reference.
    labelSeeds?: Record<string, Record<string, number>>;
};

// Read the optional per-turn label seeds structurally (additive protocol field).
// Malformed entries are ignored: a missing seed only means "continue from the
// conversation counters", the pre-seed behaviour.
export const labelSeedsOf = (session: unknown): Record<string, Record<string, number>> | undefined => {
    if (typeof session !== 'object' || session === null) return undefined;

    const value = (session as { labelSeeds?: unknown }).labelSeeds;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;

    const seeds: Record<string, Record<string, number>> = {};
    for (const [turnId, counters] of Object.entries(value as Record<string, unknown>)) {
        if (typeof counters !== 'object' || counters === null || Array.isArray(counters)) continue;

        const clean: Record<string, number> = {};
        for (const [code, used] of Object.entries(counters as Record<string, unknown>)) {
            if (typeof used === 'number' && Number.isFinite(used) && used >= 0) clean[code] = used;
        }
        seeds[turnId] = clean;
    }

    return Object.keys(seeds).length === 0 ? undefined : seeds;
};

// N3 answer routing. The board resolves the CLICK to a request+choice; it must not
// know how a session is selected. `sessionId` is captured when the card is created
// (see bindSession), so an answer can only ever target the conversation the
// question was rendered from — a session switch expires the card and main.ts
// rejects a stale binding defensively.
export type AnswerActionInput = {
    requestId: string;
    choice: HarnessActionChoice;
    sessionId?: string;
};

export type TurnBoardOptions = {
    empty?: HTMLElement;
    // Sends one human answer to the harness server. Omitted in standalone tests and
    // on a page with no wiring; the card then reports a recoverable local error.
    answerAction?: (input: AnswerActionInput) => Promise<void>;
    // Reads a bounded window of one LOCAL RELATIVE file for the R11 preview dialog.
    // Injected by the app shell (main.ts -> `callTool('read', ...)`) so the UI
    // layer owns no network code. Omitted in standalone use: clicking a file link
    // still opens the dialog, which reports that reading is not wired.
    readFile?: FilePreviewReader;
    // R11+: resolves a BARE BASENAME transcript reference (`descriptors.ts`) into the
    // real workspace path(s) before the read above. Injected by main.ts from the
    // `glob` tool; omitted in standalone use, where the bare name is read as typed
    // and the server's own ENOENT is what the dialog shows. See ui/file-preview.ts.
    resolveFile?: FilePreviewResolver;
    // Focus is DERIVED from expansion (exactly one tile is expanded at a time), so
    // the board reports every change here. The shell repaints the thread strip and
    // the composer's routing line from it; nothing is sent to the server until a
    // submit targets the focused thread (ui/threads.ts `resolveSubmitTarget`).
    onFocusChange?: (threadId: string | undefined) => void;
    // R7 freshness: invoked ONCE on an explicit transcript open. The shell reads
    // `getSession` (never per streamed event), applies it through its normal
    // tombstone-guarded snapshot path, and returns the snapshot for that board. A
    // rejected/undefined answer keeps the last applied snapshot visible; a snapshot
    // for another session/thread is ignored by the transcript module.
    refreshSessionSnapshot?: (sessionId: string) => Promise<SessionSnapshot | undefined>;
    // R9 deletion transport. The board owns confirmation, dedupe, protection and
    // feedback; the shell owns the existing DELETE API plus tombstone/snapshot
    // reconciliation. Omitted in an embedding that does not expose thread delete:
    // the control is rendered disabled rather than silently pretending to work.
    deleteThread?: (sessionId: string, threadId: string) => Promise<DeleteThreadResult>;
    // C5 transcript editing transport. The dialog owns the editor (local JSON parse,
    // the inline error area, the pending/disable rule and the invalid-transcript
    // banner); the shell owns the PUT plus applying the returned `session` through its
    // normal tombstone/watermark snapshot path, and resolves with the `transcript`
    // answer the dialog repaints from. Omitted in an embedding that does not expose
    // editing: the editor still opens (the raw JSON can be read and copied) and Save
    // says it is unwired instead of pretending to work.
    saveThreadTranscript?: (
        sessionId: string,
        threadId: string,
        messages: unknown
    ) => Promise<ThreadTranscriptPayload>;
    // R2 lazy detail transport. The board calls this AT MOST ONCE PER STEP, from the
    // reader's first expansion of that tool chip — never while it renders, and never
    // for a chip nobody opens. The shell owns the route (./view-api.ts
    // `getStepDetail`); the UI layer owns no network code, exactly like `readFile`.
    // Omitted in a standalone embedding: the chip then keeps its bounded previews and
    // issues no request, instead of pretending it has the full payload.
    loadStepDetail?: (input: {
        turnId: string;
        stepId: string;
        sessionId?: string;
    }) => Promise<TurnStepDetail>;
    // T11 R8 lazy block detail. The context bar calls this ONLY when the reader activates
    // ONE segment, and only for that segment (`blockId` is `ContextBlock.id`). The shell
    // owns the route (./view-api.ts `getBlockDetail`); the renderer owns no network code.
    // Omitted in a standalone embedding: the segment still opens, and the dialog says the
    // route is not wired rather than inventing a payload.
    loadBlockDetail?: (input: {
        turnId: string;
        blockId: string;
        sessionId?: string;
    }) => Promise<TurnBlockDetail>;
};

export type TurnBoard = {
    element: HTMLElement;
    // Bind the board to the session whose turns it renders. Called before every
    // reconcile/hydrate and when a session is opened/cleared. Cards created under a
    // DIFFERENT session expire instead of silently answering the new one.
    bindSession: (sessionId: string | undefined) => void;
    // `attachments` is the optional draft payload already validated by the
    // composer. It is rendered immediately (optimistic tile) and replaced by the
    // server record on `merge`; omitting it keeps the text-only path identical.
    //
    // `threadId` is the persistent thread the submit targets (continue/steer). The
    // optimistic tile carries the badge for it before the server answers; a NEW
    // thread omits it and gains its identity from the record's `threadId`.
    begin: (
        prompt: string,
        attachments?: readonly HarnessAttachment[],
        threadId?: string
    ) => TurnHandle;
    notice: (text: string, tone?: 'info' | 'error') => HTMLElement;
    clear: () => void;
    expand: (turn: TurnHandle) => void;
    collapse: () => void;
    expanded: () => TurnHandle | undefined;
    turns: () => readonly TurnHandle[];
    // Persistent thread id that is the steering target (S1). This is EXPLICIT state,
    // not merely "the expanded tile's thread": a focused CHILD conversation has no
    // tile of its own (S2), an optimistic follow-up tile is unbound for a while, and
    // a background adoption must never rewrite it. Undefined = deliberately
    // unfocused (the next submit opens a new thread).
    focusedThread: () => string | undefined;
    // Focus one persistent thread (S2), in this order:
    //   1. a visible turn of that thread -> expand its NEWEST turn;
    //   2. a nested invocation entry whose runtime identity matches the roster
    //      (`invocationId`/`originInvocationId`/historical `invocationIds`) -> show
    //      that child conversation, collapsing every other PERSISTENT child one;
    //   3. roster-only (a runtime child with no turn yet) -> show its recorded
    //      transcript from `SessionThread.messages`.
    // Returns false only when the id is unknown to both the turns and the roster.
    focusThread: (threadId: string) => boolean;
    // Authoritative roster (`SessionSnapshot.threads`). The board uses it to label
    // tiles with the SAME canonical name/sequence as the strip (S6), to resolve a
    // child's persistent identity, and to render a roster-only child transcript.
    setThreads: (threads: readonly SessionThreadEntry[]) => void;
    // Raw authoritative snapshot for THIS board (exact threads + turns + session
    // fields, tombstone-filtered by the shell). Observed by the R7 JSON transcript
    // and by delete protection; `setThreads` alone remains enough for every
    // pre-R7 label/focus behaviour.
    setSessionSnapshot: (snapshot: SessionSnapshot | undefined) => void;
    // The COMPILED document the shell last applied (T5 R1). Roster joins, delete
    // protection and the transcript fallback read their rows from here; the raw
    // snapshot above stays undefined until an explicit export read.
    setSessionView: (view: SessionView | undefined) => void;
    // Drop one tile without applying anything: used by the submit path when a
    // server answer describes a turn this browser already has (steering returns the
    // OWNING turn), so the optimistic steering row must not linger unbound.
    discard: (turn: TurnHandle) => void;
    // Find a tile by server turn id. This is how a stream `event` frame with an
    // explicit `turnId` finds its tile without guessing from stream order.
    find: (id: string) => TurnHandle | undefined;
    // Claim the oldest UNBOUND optimistic tile that was started for `prompt` and
    // return it, so a server record that arrives before the POST /tasks answer
    // (src/server/sessions.ts publishes the queued `turn` upsert first, line ~633)
    // merges into the tile the user is already looking at instead of adopting a
    // SECOND tile for the same turn. Returns undefined when no tile is waiting for
    // that prompt. Callers merge the record into the returned handle.
    claim: (prompt: string) => TurnHandle | undefined;
    // Build one tile from an authoritative server record (replays its events).
    adopt: (turn: SessionTurn, model?: string) => TurnHandle;
    // Replace the whole board with the server's turns. Returns the new handles;
    // any previous handle is detached and must not be used again.
    hydrate: (turns: readonly SessionTurn[], options?: HydrateOptions) => TurnHandle[];
    // Reconcile in place with the server's turns (R4): match by id, merge events
    // without duplicating them, adopt new turns, drop removed ones, and keep the
    // reader's expanded tile. This is the snapshot path for a live queue.
    reconcile: (turns: readonly SessionTurn[], options?: HydrateOptions) => TurnHandle[];
    // --- display-wire board path (T5: R1/R2/R3) -------------------------
    //
    // The same list/focus rules as `hydrate`/`reconcile`, fed by the COMPILED
    // document instead of recorded turns: rows come from `TurnSummary`, flows from
    // `TurnDisplay.displays`, and `labelSeeds` is not needed because the server
    // already owns the block labels.
    hydrateView: (view: SessionView, options?: HydrateOptions) => TurnHandle[];
    reconcileView: (view: SessionView, options?: HydrateOptions) => TurnHandle[];
    // Bind/adopt the row a submit answer names (steered submits merge into the tile
    // that already represents the owning conversation).
    upsertView: (summary: TurnSummary, view?: SessionView) => TurnHandle;
    // Route one ops frame by EXPLICIT turn id. False when no tile holds that turn,
    // in which case the caller must not guess: the terminal `view` frame reconciles.
    applyViewOps: (turnId: string, ops: readonly TurnDisplayOp[], view?: SessionView) => boolean;
    // Every real block across the visible turns, oldest→newest then root/nested.
    // The # popup uses this order together with ui/references.ts
    // `latestReferenceBlock` (latest matching label wins; labels are unique across
    // the conversation, so this is an exact lookup in practice).
    blocks: () => AgentBlockDescriptor[];
    // Stop every live timer the board owns. Safe to call repeatedly; the page's
    // `pagehide` handler and a view teardown both use it.
    destroy: () => void;
};

const STATE_TEXT: Readonly<Record<TurnState, string>> = {
    queued: 'queued',
    waiting: 'waiting for server',
    streaming: 'streaming',
    done: 'done',
    error: 'error',
    cancelled: 'cancelled'
};

// States that mean "work is actually executing". Drives the compact tile's
// activity ring (styles.css, shared with the agent row) AND the elapsed clock.
// `queued` is deliberately NOT live (R4): a retained task is neutral — no
// spinning ring and no tick — until the server advances it to running. The status
// text stays in the DOM as the accessible signal even though a compact tile clips
// it visually.
const isLive = (state: TurnState): boolean => state === 'waiting' || state === 'streaming';

// Unique ids for `aria-controls`. A module counter is enough: one document.
let nextId = 0;

const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string
): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
};

// Incremental Markdown: coalesce every delta that arrives in one frame into a
// single parse. `flushPending` cancels the queued frame and renders now.
type TextBlock = {
    node: HTMLElement;
    buffer: string;
    handle: number | undefined;
    viaFrame: boolean;
};

const schedule = (block: TextBlock, render: () => void): void => {
    if (block.handle !== undefined) return;

    // `requestAnimationFrame` is the right clock in a browser (never more than
    // one parse per paint). jsdom has it too; the timeout branch keeps the module
    // usable in any other DOM implementation.
    if (typeof requestAnimationFrame === 'function') {
        block.viaFrame = true;
        block.handle = requestAnimationFrame(() => {
            block.handle = undefined;
            render();
        });
        return;
    }

    block.viaFrame = false;
    block.handle = window.setTimeout(() => {
        block.handle = undefined;
        render();
    }, 16);
};

const cancel = (block: TextBlock): void => {
    if (block.handle === undefined) return;

    if (block.viaFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(block.handle);
    else window.clearTimeout(block.handle);

    block.handle = undefined;
};

// --- compact block metadata (R1) --------------------------------------------
//
// The elapsed clock + token tally that sit in a block header. ONE implementation is
// shared by the MAIN tile and every NESTED invocation block, so both blocks tick,
// freeze, hide and format identically and only the class names differ
// (`tile-elapsed`/`tile-tokens` vs `thread-elapsed`/`thread-tokens`) — see
// styles.css, where the two are grouped into one rule per concern.
//
// Behaviour inherited from the original tile clock (do not weaken it):
//   - a block with no known start shows NOTHING (no fabricated `0ms`);
//   - while the block is live the label ticks every 250ms (the text resolution);
//   - a terminal block stops the tick and keeps the span;
//   - a RECORDED baseline (`settle`) is never overwritten by a later replay
//     transition, so a poll/rebuild shows the server's duration, not "now";
//   - a REPLAYED block reads no wall clock at all: with no recorded end stamp its
//     duration is unknown and the label is hidden (F1);
//   - the first endpoint wins: a later parent result cannot rewrite it (F2);
//   - usage is never invented: both the input figure and the cache bracket stay
//     absent until something reported them.
type BlockMeta = {
    // `<span class="…-elapsed">`, hidden until a real span exists.
    elapsed: HTMLElement;
    // `<span class="…-tokens">`, hidden until a request reported usage.
    tokens: HTMLElement;
    // Replace the baseline with server/authoritative stamps. The block becomes a
    // RECORDED one: later state transitions must not restart the local clock or
    // clear the recorded end.
    settle: (timing: { startedAt?: number; endedAt?: number }) => void;
    // First stamp for a block that was never settled (a live/bound start). A second
    // call is ignored: the block started when it started. `recorded` says the stamp
    // came from a replayed record, so only a recorded END can complete the span.
    begin: (at: number | undefined, recorded: boolean) => void;
    // Server start for the ROOT tile: replaces the local baseline (the record's
    // stamp wins) without marking the block as a recorded replay.
    bindStart: (at: number) => void;
    // Terminal stamp. The FIRST endpoint wins: a later parent `tool_result` can only
    // supply an endpoint the block never had, never move one it reported. Without a
    // recorded endpoint the label stays hidden (no wall-clock age is invented).
    finish: (at: number | undefined, recorded: boolean) => void;
    // Non-terminal transition (root tile): drop a local end and tick while active.
    // A recorded block keeps its stamps (hydration/replay path).
    reopen: (active: boolean) => void;
    paint: () => void;
    stop: () => void;
    // One request's usage, from that block's own `usage` events.
    noteUsage: (usage: HarnessUsage | undefined) => void;
    // Display-wire path (T5 R1): the server pre-computes the two figures this line
    // prints (`TurnSummary.latestInput` / `cachedInput`, and the same pair per
    // section), so the compact view sets them directly instead of accumulating
    // `usage` events. Absent figures leave the current value alone — an unknown
    // number stays hidden, never zero-filled.
    setFigures: (figures: {
        latestInput?: number;
        cachedInput?: number;
        usage?: HarnessUsage;
    }) => void;
    // Authoritative cumulative tally (the root tile's `SessionTurn.usage`).
    setTally: (usage: HarnessUsage | undefined) => void;
    // The context size this block reports RIGHT NOW (`latestInput`, falling back to the
    // cumulative input exactly as the visible tally does), or undefined when nothing has
    // reported usage. This is the denominator a think chip's percentage is measured
    // against, so the chip and the header tally can never disagree about the size of the
    // context (ui/tools.ts `formatThinkShare`).
    context: () => number | undefined;
    // Forget the per-event usage a discarded projection contributed; the tally is
    // kept because the caller re-applies it from the record after the rebuild.
    clearUsage: () => void;
    recorded: () => boolean;
};

const createBlockMeta = (classes: { elapsed: string; tokens: string }): BlockMeta => {
    const elapsed = el('span', classes.elapsed);
    elapsed.hidden = true;
    const tokens = el('span', classes.tokens);
    tokens.hidden = true;

    // Timing baseline. `endedAt` undefined means "no end known"; the label is then
    // either LIVE (read `startedAt → now`, gated by `nowAllowed`) or UNAVAILABLE and
    // hidden. A recorded/replayed block is never `nowAllowed`: its duration must come
    // from recorded stamps only, so no wall-clock age is invented (F1).
    let startedAt: number | undefined;
    let endedAt: number | undefined;
    let tick: number | undefined;
    let recorded = false;
    // True only while a `now`-based span is honest: the live/streaming root tile and
    // a live child invocation. A replayed block keeps this false.
    let nowAllowed = false;

    // Two token scopes (see the token tally block in `create`): the LATEST request's
    // input and the cumulative cached input. `tally` is the server's authoritative
    // sum; the per-event sum is the legacy fallback.
    let tally: HarnessUsage | undefined;
    let latestInput: number | undefined;
    let eventCached = 0;
    let eventCachedReported = false;

    // Same grouping as the visible figure, for the explanatory title only.
    const titleNumber = new Intl.NumberFormat('en-US');
    const titleCount = (value: number): string => titleNumber.format(Math.trunc(Math.max(value, 0)));

    const paint = (): void => {
        // A recorded span exists ONLY when both endpoints are recorded. Reading the
        // clock for a replayed block would turn a replay's wall age (hours/days)
        // into a fake duration; such a label stays hidden instead.
        const span =
            endedAt !== undefined
                ? elapsedBetween(startedAt, endedAt)
                : nowAllowed
                  ? elapsedBetween(startedAt, Date.now())
                  : undefined;

        elapsed.textContent = span === undefined ? '' : formatDuration(span);
        elapsed.hidden = span === undefined;
    };

    const stop = (): void => {
        if (tick === undefined) return;

        window.clearInterval(tick);
        tick = undefined;
    };

    const startTick = (): void => {
        // Quarter second: enough resolution to look live, cheap enough to ignore.
        if (tick !== undefined || startedAt === undefined || endedAt !== undefined) return;

        tick = window.setInterval(paint, 250);
    };

    // The context figure the visible tally is built from, in one place: the latest
    // reported request context, falling back to the cumulative input ONLY when no usage
    // event was recorded (never on a live/hydrated block that has one, so the two scopes
    // cannot silently collapse). Shared by the tally and by a think chip's denominator.
    const contextInput = (): number | undefined => latestInput ?? tally?.input;

    const paintTokens = (): void => {
        const input = contextInput();
        const cached = tally?.cached ?? (eventCachedReported ? eventCached : undefined);
        const text = formatTokens(input, cached);

        tokens.textContent = text;
        tokens.hidden = text.length === 0;

        if (text.length === 0) {
            tokens.removeAttribute('title');
            return;
        }

        // R2: the compact numbers alone cannot express that they measure different
        // scopes. The title spells it out for both sighted and assistive readers
        // without adding a second visible line.
        const context = input === undefined ? 'unknown' : titleCount(input);
        const cache = cached === undefined ? 'unknown' : titleCount(cached);
        const scope =
            latestInput === undefined && tally !== undefined
                ? 'Cumulative input (latest request not recorded)'
                : 'Latest request context';
        tokens.title =
            `${scope}: ${context} input tokens · ` + `Total cached input sent: ${cache} tokens`;
    };

    const settle = (timing: { startedAt?: number; endedAt?: number }): void => {
        // Assign explicitly: an unknown server start must stay unknown, not fall
        // back to "now" (which would render a fabricated 0ms).
        recorded = true;
        // The server baseline is the LIVE turn view: a running record has no end
        // stamp and legitimately counts up from `startedAt`; a terminal record always
        // carries `updatedAt` as `endedAt`, so no clock is read for it.
        nowAllowed = true;
        startedAt = finiteOf(timing.startedAt);
        endedAt = finiteOf(timing.endedAt);

        stop();
        paint();
        if (endedAt === undefined) startTick();
    };

    const begin = (at: number | undefined, isRecorded: boolean): void => {
        if (at === undefined || startedAt !== undefined) return;

        recorded = isRecorded;
        // A recorded (replayed) invocation has no live view: its span exists only
        // once a recorded END stamp does (see `paint`). Reading `Date.now()` there
        // would report the replay's wall age as the child's duration.
        nowAllowed = !isRecorded;
        startedAt = at;

        paint();
        if (nowAllowed) startTick();
    };

    const bindStart = (at: number): void => {
        // A bound server start is the live tile's baseline: count up until an end.
        startedAt = at;
        nowAllowed = true;

        paint();
        startTick();
    };

    const finish = (at: number | undefined, isRecorded: boolean): void => {
        stop();
        // Freeze the live view first: after this point only recorded/known endpoints
        // may describe the span.
        nowAllowed = false;

        // FIRST endpoint wins. A child that reported its own `done` at +3s must not
        // be stretched by the parent's later `tool_result` (+19s); that result may only
        // supply an endpoint the invocation never had.
        if (startedAt !== undefined && endedAt === undefined) {
            if (at !== undefined) endedAt = at;
            else if (!isRecorded) endedAt = Date.now();
            // A recorded block with no end stamp stays UNAVAILABLE: `paint` hides it
            // rather than freezing a wall-clock age that was never measured.
        }

        paint();
    };

    const reopen = (active: boolean): void => {
        if (recorded) {
            // Hydration/replay: the record owns the span, so a replay transition must
            // not clear its end or restart a local tick.
            paint();
            return;
        }

        endedAt = undefined;
        nowAllowed = true;

        if (active) {
            if (startedAt === undefined) startedAt = Date.now();
            startTick();
        }

        paint();
    };

    const noteUsage = (usage: HarnessUsage | undefined): void => {
        if (usage === undefined) return;

        const reported = finiteOf(usage.input);
        if (reported !== undefined) latestInput = reported;

        const cached = finiteOf(usage.cached);
        if (cached !== undefined) {
            eventCachedReported = true;
            eventCached += Math.max(cached, 0);
        }

        paintTokens();
    };

    const setFigures = (figures: { latestInput?: number; cachedInput?: number; usage?: HarnessUsage }): void => {
        // Server-authoritative cumulative tally first: the tile prints this figure,
        // so a compact row and a live stream show the identical total.
        if (figures.usage !== undefined) tally = usageOf(figures.usage) ?? tally;

        const latest = finiteOf(figures.latestInput);
        if (latest !== undefined) latestInput = latest;

        // `cachedInput` is the turn-wide cached figure the projector already summed;
        // it replaces the per-event accumulation rather than adding to it, so a
        // reload cannot double-count what a live stream counted once per event.
        const cached = finiteOf(figures.cachedInput);
        if (cached !== undefined) {
            eventCachedReported = true;
            eventCached = Math.max(cached, 0);
        }

        paintTokens();
    };

    return {
        elapsed,
        tokens,
        settle,
        begin,
        bindStart,
        finish,
        reopen,
        paint,
        stop,
        noteUsage,
        setFigures,
        context: () => contextInput(),
        setTally(usage?: HarnessUsage): void {
            tally = usage;
            paintTokens();
        },
        clearUsage(): void {
            latestInput = undefined;
            eventCached = 0;
            eventCachedReported = false;
            paintTokens();
        },
        recorded: () => recorded
    };
};

// R5/T7: the COLLAPSIBLE SURFACE a block's footer chevron controls.
//
// T7 (user feedback): the collapsed row IS the expander — clicking `.thread-select` /
// `.tile-select` opens the block — so a chevron in the collapsed header was a second
// control for one affordance ("the whole row is a toggle"). Exactly one chevron remains,
// in the footer action row beside the Copy button: its job is the case the header cannot
// serve, closing a LONG block from the bottom when the reader is already at the end of it
// ("collapse without having to scroll all the way up").
//
// That makes the control SINGLE-PURPOSE, and that is what removes all the state machinery:
// the button lives inside the body, and a collapsed block hides that whole body with
// `display: none` (`.tile:not(.is-expanded) .tile-body`, `.thread-row:not(.is-expanded)
// .thread-body`, styles.css), which takes the button out of the layout, the tab order and
// the accessibility tree with it. A reader can therefore only ever SEE and PRESS it while
// the surface is open, so it always means "collapse this block": its name, tooltip and
// `aria-expanded` are constants. No `isExpanded()` probe, no repaint, no per-change sync —
// the CSS visibility rule is the state, and a projection rebuild just mints the same
// button again.
//
// A section is only given the button when the caller can name a real surface: a nested
// invocation card (`.thread-body`) or the root conversation (`.tile-body`). A flat legacy
// section has neither, so it gets no control and its footer row stays empty (and is then
// `display: none` through `:empty`).
//
// `collapse` must move ONLY the surface: it must not move board focus or retarget the
// composer. That is what separates it from clicking a nested header, which focuses a
// persistent conversation (`focusThread`).
type SectionCollapse = {
    // 'thread' or 'conversation' — the noun in the accessible name and tooltip.
    label: string;
    // The id of the element this button hides, when a REAL one exists. `aria-controls` is
    // only written when it is set, so it never points at nothing.
    controls?: string;
    // Close the surface in place (see the focus rule above).
    collapse: () => void;
};

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

// The chevron is ONE down-pointing path; CSS rotates it 180° while `aria-expanded="true"`
// — the value the button carries CONSTANTLY (see `SectionCollapse`) — so the glyph points
// UP for the one action it offers, the DOM never has to swap paths, and the animation is a
// pure transform. Same data-only SVG construction as `createCopyIcon` (ui/dialog.ts):
// this module never parses HTML, and `aria-hidden` keeps the glyph out of the
// accessible name the button carries.
const createCollapseIcon = (): SVGSVGElement => {
    const icon = document.createElementNS(SVG_NAMESPACE, 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');

    const path = document.createElementNS(SVG_NAMESPACE, 'path');
    path.setAttribute('fill', 'none');
    path.setAttribute('d', 'M6 9l6 6 6-6');
    icon.append(path);

    return icon;
};

// Build the block's ONE chevron: a real <button> (Enter/Space work natively), icon-only,
// appended to the block's action row. There is deliberately NO painter here — see the
// `SectionCollapse` comment: the button is only renderable while the surface is open, so
// "collapse" is always the truth and nothing has to be repainted when the state changes.
// The constant name is also what makes it behave like the Copy button beside it (a fixed
// accessible name), which is what lets the pair read as one affordance instead of two.
const createCollapseButton = (collapse: SectionCollapse): HTMLButtonElement => {
    const button = el('button', 'answer-collapse');
    button.type = 'button';
    // Only a real controlled body gets the relation.
    if (collapse.controls !== undefined) button.setAttribute('aria-controls', collapse.controls);
    // Open by construction whenever this button is reachable, and the stylesheet keys the
    // glyph's 180° rotation on exactly this value: up = "close what I am looking at".
    button.setAttribute('aria-expanded', 'true');
    // The name is the action, and the tooltip matches it so hover never promises the
    // other verb (the header row owns expanding; this button never does).
    const name = `Collapse ${collapse.label}`;
    button.setAttribute('aria-label', name);
    button.title = name;
    button.append(createCollapseIcon());

    // No `stopPropagation`: the button lives in the block FOOTER, never inside
    // `.thread-select`/`.tile-select`, so the header's own click handler cannot fire with
    // it — and the header stays the only way back open.
    button.addEventListener('click', () => collapse.collapse());

    return button;
};

type AgentSection = {
    root: HTMLElement;
    flow: HTMLElement;
    // R5: the block FOOTER is the answer-action row (`.agent-answer-actions`), not a
    // metadata line. The model / stop reason / token figures this row used to print
    // are measurement facts, and the block HEADERS already carry them (`.tile-top`
    // for the root, `.thread-top` for a nested invocation), so the bottom line was
    // a duplicate. It holds the Copy action for this block's final answer (FIRST, so
    // it reads left) and, for a block with a collapsible surface, that surface's
    // Collapse chevron (LAST, pinned right — the bottom-of-a-long-block way to close
    // it without scrolling back up to the header row). A block with no surface stays
    // empty until an answer completes, and is then `display: none` (styles.css `:empty`).
    actions: HTMLElement;
    text: TextBlock | undefined;
    // The LAST closed prose block's cumulative buffer. `closeText` clears `text`
    // when a `done` ends the agent's message; retaining the buffer here is what
    // keeps the final answer available to the # reference descriptor (T8).
    lastText: string | undefined;
    // R5: the block's FINAL answer — the raw Markdown of the last COMPLETED prose
    // block of THIS invocation, which is exactly what the footer Copy action writes.
    // Deliberately separate from `lastText`:
    //   - `lastText` is written by every `closeText`, including the mid-response
    //     close a `tool_call` causes, so it also tracks intermediate prose;
    //   - `finalAnswer` is promoted only at a real completion boundary
    //     (`attempt_commit` / `done`), so a partial answer that is still streaming,
    //     or one cut short by an `error`/cancel, is never offered as final.
    // A tool-only round leaves it untouched (it must not be replaced by ''), and a
    // later message only REPLACES it when that message itself completes.
    finalAnswer: string | undefined;
    // The footer Copy button, created on the first promoted answer and kept for the
    // life of the block (its payload is read at click time, so it never goes stale
    // and never needs re-creating when the answer advances).
    answerAction: HTMLButtonElement | undefined;
    // R5/T7: the block's Collapse chevron, created with the block when the caller passed a
    // `SectionCollapse` (a nested invocation card or the root conversation). Nothing ever
    // repaints it (a constant label is always true — see `SectionCollapse`), so this is
    // only the reference to the node that was appended into `actions`. Undefined for a
    // flat legacy section, which has no surface to collapse.
    collapse: HTMLButtonElement | undefined;
    // The CURRENT reasoning round: its INLINE think chip plus the cumulative text streamed
    // so far. One writer per model request — `commitAttempt`/`discardAttempt` drop this
    // pointer so the next request mints its own chip (T8: two requests' thinking must never
    // fuse into one node). `buffer` is the whole round because the chip repaints from the
    // cumulative value (pill, dialog body, accessible name), and a retry destroys the chip
    // along with the node it tracks.
    reasoning: { card: ReasoningCard; buffer: string } | undefined;
    // EVERY think chip this block rendered, committed or not, so the tile's `destroy()`
    // and `resetProjection()` can close a dialog a superseded projection no longer owns.
    // `reasoning` alone is not enough: committing a round drops the writer pointer while
    // the chip stays in the flow (T8), and its dialog would otherwise outlive the tile.
    thinking: ReasoningCard[];
    tools: ToolCallCard[];
    // Active wrapping row for consecutive tool calls AND think chips, or undefined when
    // the last flow child was neither. Keeping the group alive across calls is what lets
    // `[websearch][read]` share a line; prose/error resets it. A reasoning round now
    // JOINS this row (it is a chip like any other), which is what keeps a run of
    // `[think][glob][read]` on one line instead of alternating bars and rows.
    //
    // R1: the row survives a MODEL BATCH boundary. `attempt_commit`, `done` and
    // `wakeup` are scheduler lifecycle frames — nothing new is READABLE between the
    // calls they separate — so four calls issued as two batches of two must still
    // render as one wrapping flow, not two rows of two. Only something the reader
    // actually sees (prose, an error, a retry notice, a steer) breaks the run — a
    // reasoning round no longer does, because it is a chip inside this same row.
    toolGroup: HTMLElement | undefined;
    // `pending · name 1.2s` line for calls the SERVER still has in flight (R6).
    // Undefined means nothing is pending (or the server never reported it). It
    // lives in the flow, after the tool row, and is never inside `.tool-group`, so
    // it cannot break chip grouping. `pendingCalls` is the authoritative per-call
    // state behind the line: a snapshot from the last frame that carried `pending`,
    // minus each call whose own result has arrived (the runtime omits the field
    // when nothing remains). The tile meta sums these maps across sections, so one
    // delegated child can be pending while the parent is idle.
    pending: HTMLElement | undefined;
    pendingCalls: Map<string, HarnessPendingTool>;
    // R1/R3 attempt boundary: what the CURRENT model attempt appended. A `retry`
    // frame discards exactly this, because the agent never commits a failed
    // attempt and its partial prose/calls must not appear as part of the answer.
    // `undefined` means no attempt output is live (nothing to discard).
    //
    // OWNERSHIP BY IDENTITY, NOT BY POSITION (F2/F4). Everything the attempt added
    // is recorded as the node/card/entry it created, so a discard can never reach
    // output that belongs to something else in the same flow: a concurrently
    // streaming sibling agent, a steer node, an action card, a wakeup marker, or a
    // previously committed turn of THIS agent (which the harness legitimately does
    // not announce with `done` — see `commitAttempt`).
    attempt:
        | {
              // Flow children this attempt appended (prose block, think chip, tool
              // rows). Only these are removed; every other child stays.
              nodes: HTMLElement[];
              // Tool cards this attempt minted (each counted in `toolCount`).
              cards: ToolCallCard[];
              // The `pendingTools` entries those cards created, by identity: pruning
              // only these is what keeps a sibling invocation's pending call (or a
              // parent delegation) listed after a retry (F2).
              pendingEntries: PendingTool[];
              lastText: string | undefined;
              // R5: the copy target as it was when this attempt opened, restored on
              // discard. Promotion only ever happens at a completion boundary (which
              // closes the window), so this is defensive bookkeeping: it keeps
              // `finalAnswer` owned by the same rule as `lastText` instead of leaving
              // one pointer that a retry can stale.
              finalAnswer: string | undefined;
              // Thread keys THIS attempt minted (a `tool_call` for a delegation
              // queues a placeholder entry). Tracked by creation rather than by a
              // snapshot diff: a concurrently streaming sibling agent may mint its
              // own placeholders in the meantime, and those are not ours to remove.
              createdThreads: string[];
          }
        | undefined;
};

// Lifecycle of one INVOCATION (a thread entry). It is deliberately smaller than
// `TurnState`: only a top-level turn can be `waiting` for the server. A child is
// `queued` from the moment its spawning tool call is seen (placeholder until its
// `start`), then `streaming`; `done`/`error`/`cancelled` are terminal.
//
// `done.pending` non-empty is NOT terminal (R6): the runtime omits `done` for an
// immediately-superseded response, and a paused response can still be woken, so
// the entry stays `streaming` until a `done` with no pending work or until the
// parent's tool_result names its spawning `callId` (the authoritative outcome).
type ThreadState = 'queued' | 'streaming' | 'done' | 'error' | 'cancelled';

// T19 (R17): ONE context bar per SECTION, mounted in the surface that block owns.
//
// Before T19 a tile built a single bar from EVERY section of the tree and painted it in
// the tile body, so a delegated conversation showed its caller's strip and none of its
// own. The model layer (`../view-context.ts` `contextBarOf`) already takes a tree, so a
// per-section bar is the same function over `{turnId, sections: [section]}` — no second
// compiler, no local pairing of a step with a segment.
//
// A surface is the host element plus the two owned resources that must never be
// shared across sections: the bar itself (a `ResizeObserver` + pointer/keyboard
// listeners) and the segment dialog opened from it. Tracking the dialog per host is what
// makes a metadata refresh, a block removal and a section discard answer to the card that
// owns them; the reader still sees ONE segment at a time, because opening a segment closes
// whichever strip in this tile had one open (T11's no-stacked-modals rule).
type ContextBarSurface = {
    /** The `.context-bar-host` this surface paints (hidden while it has nothing). */
    host: HTMLElement;
    /**
     * Point this surface at ONE section of `turnId`.
     *
     * `undefined` is the server saying nothing about this section's context (a pre-T9
     * record, or a reconcile that dropped the metadata): the strip is destroyed, the host
     * hidden, and `driven()` goes false so the section's steps render as cards again.
     * Returns true when the surface CHANGED the chip/card decision, which is the only
     * moment the flow already on screen is known to be the wrong shape.
     */
    sync: (section: TurnSection | undefined, turnId: string) => boolean;
    /** True when this section's segments, not step cards, are its tool surface. */
    driven: () => boolean;
    /**
     * Paint — or hide — the section's ONE current content body, mounted inside this host
     * directly after the strip (T22/T23, R23).
     *
     * A `reasoning` tail and a `tool` tail paint here: the thinking window because the chip
     * that used to hold it is gone, and the call because R23 makes a recorded call a block
     * like any other — its complete recorded request, plus its complete recorded result once
     * the call settles. An `assistant` tail paints NOTHING: its full text is the section's
     * designated answer node, and the flow already renders that in the `.agent-text` block
     * that sits immediately below this host, so printing it twice would duplicate the answer.
     * Every body carries the SERVER's figures (`data-chars`, `data-truncated`, and for a call
     * `data-state`/`data-duration`/`data-args-chars`/`data-result-chars`), so a bounded
     * payload says so instead of letting a prefix read as the whole block.
     */
    setTail: (tail: ContextTail | undefined) => void;
    /** Repaint the dialog this surface owns from the section's current metadata. */
    refresh: () => void;
    /** Close the dialog this surface owns WITHOUT destroying the strip (a sibling section's
     *  click replaces the reader's segment, exactly as a second click on this strip does). */
    closeDetail: () => void;
    /** Close the dialog, destroy the bar, empty the host. Idempotent. */
    destroy: () => void;
};

// One invocation rendered as a thread entry. The ROOT invocation has a section
// but no row: its content is the tile body itself (depth 0). Every non-root
// invocation gets `.thread-row` → `.thread-tile` (header + collapsible body).
//
// T19 (R18): a row is a FLAT sibling in the owning turn's one `.thread-children` host,
// never inside its parent's `.thread-tile`/`.tile`. Ordering is depth-first and
// indentation is the `data-depth` figure the board stamps (`--thread-depth`), so a
// delegated conversation is an independent card a reader can point at, reference and
// collapse on its own, while `parentKey` keeps the logical parentage the wire recorded.
//
// `key` is the canonical identity inside this turn: the runtime's explicit
// `thread.id` once known, otherwise a synthesized placeholder key
// (`call:<callId>`, or `inline:<agent>` for unknown legacy streams). Placeholders
// are REKEYED on adoption so one invocation never gets two entries.
type ThreadEntry = {
    key: string;
    agent: string;
    // Compact display label (`RH1`), allocated once when this invocation's block is
    // created (ui/agent-label.ts). The raw `agent` id stays here for colour/routing
    // but is never written as text (R2/R3).
    label: string;
    input: string | undefined;
    callId: string | undefined;
    // Parent invocation key. Undefined means "child of the turn root" — the
    // frozen contract omits `parentId` for a root-parented child.
    parentKey: string | undefined;
    depth: number;
    // Runtime-provided id once a `thread` record named this invocation. Used to
    // distinguish a synthesized placeholder from an explicitly identified entry.
    explicitId: string | undefined;
    // N3: what spawned this non-root invocation. Undefined for the root and for
    // every pre-branch record (a delegation placeholder starts undefined too).
    // Fork/autoanswer rows also carry their branch identity for branch_end.
    kind: 'delegation' | 'fork' | 'autoanswer' | undefined;
    branchId: string | undefined;
    // Tiny header tag (`fork` / `auto`), created only for a branch kind. It is a
    // narrow label, not the removed oversized role badge (R3).
    kindTag: HTMLElement | undefined;
    started: boolean;
    state: ThreadState;
    section: AgentSection;
    // DOM (undefined for the root/inline sections, which live in the tile flow).
    row: HTMLElement | undefined;
    // The nested block surface. It mirrors `data-state` and `is-expanded` from its
    // row so styles.css can style main (`.tile`) and nested (`.thread-tile`) blocks
    // with ONE grouped selector instead of two copies that drift (R3).
    tile: HTMLElement | undefined;
    body: HTMLElement | undefined;
    select: HTMLButtonElement | undefined;
    // Compressed header metadata: the nested counterpart of `.tile-top`
    // (`elapsed | tokens - status`, R1/R3). The root entry has no header of its own —
    // the tile's own `BlockMeta` covers it — so this is undefined there.
    meta: BlockMeta | undefined;
    // The state word inside `.thread-status`. Kept separate so the compact CSS can
    // clip the WORD (`.thread-status-text`) while the outer span keeps the layout.
    status: HTMLElement | undefined;
    statusText: HTMLElement | undefined;
    preview: HTMLElement | undefined;
    prompt: HTMLElement | undefined;
    outcome: HTMLElement | undefined;
    // T19 (R17): this block's OWN context bar. Every kind of entry owns one — the turn's
    // root section is painted by the tile's surface (assigned in `compiledEntryOf`, which
    // also covers the defensive flat-section fallback), and a delegated section by a
    // surface inside its own `.thread-body`. Undefined for a row-less inline section that
    // no compiled frame has claimed, whose steps then keep rendering as cards.
    contextBar: ContextBarSurface | undefined;
    // Closes this entry's segment dialog and destroys its bar (observers + listeners)
    // when its projection is discarded. The root/inline literals no-op, because the TILE
    // owns that surface and destroys it with the tile.
    disposeContextBar: () => void;
    // R7/R8: transcript + delete toolbar of an expanded child CONVERSATION.
    // Undefined for a row-less root/inline section.
    transcriptAction: HTMLElement | undefined;
    transcriptButton: HTMLButtonElement | undefined;
    // Repaint the shared toolbar from board state (expansion/roster/snapshot,
    // protection, confirmation, in-flight). Removed from the board's sync set when
    // the entry's projection is rebuilt.
    syncActionBar: () => void;
    disposeActionBar: () => void;
    expanded: boolean;
    /**
     * T22 (R23): the WIRE section this entry was last painted from. The state reducer
     * mutates that object in place, so holding the reference is what lets an ops frame
     * that names no document still re-derive the section's ONE displayed content block
     * from the server's own order — no second copy of the tree, no event compilation.
     * Undefined only for a row-less legacy entry that no compiled frame has claimed.
     */
    compiledSection?: TurnSection;
};

// Root invocation key. It never collides with a runtime id because it is not a
// wire value; the map keys are otherwise the runtime ids or synthesized keys.
const ROOT_KEY = 'root';

// T12d F1: one steer audit entry has a stable render key across local event-order
// rendering, the board's cross-turn pass, and a rebuilt projection. It is stored on
// the rendered node (`data-steer-key`) so rendering is idempotent without a second
// board-level cache that could outlive the DOM.
const steerKeyOf = (turnId: string, index: number): string => `${turnId}\u0000${index}`;

const flowHasSteer = (flow: HTMLElement, key: string): boolean =>
    [...flow.querySelectorAll<HTMLElement>('.turn-steer')].some((node) => node.dataset.steerKey === key);

// The visible user-guidance surface. Shared by the tile flow (root/child invocation)
// and the roster-only focus panel, so a steer reads the same wherever its target
// conversation is shown.
const createSteerNode = (steer: SessionSteerRecord, key: string): HTMLElement => {
    const node = el('div', 'turn-steer');
    node.dataset.steerKey = key;
    node.append(el('span', 'turn-steer-role', 'you · steering'));
    const body = el('div', 'turn-steer-text markdown');
    body.append(markdownFragment(steer.prompt));
    node.append(body);
    return node;
};

// Terminal test for an invocation. A queued placeholder is not terminal: its
// child has not answered yet.
const isTerminalThread = (state: ThreadState): boolean =>
    state === 'done' || state === 'error' || state === 'cancelled';

// One unresolved tool call. `callId` is the authoritative match. A server that
// sends `tool_result` without a call id (legacy) is matched by name, oldest first;
// with concurrent calls that fallback is only used when no id is present, because
// it cannot tell two same-name siblings apart.
type PendingTool = {
    card: ToolCallCard;
    section: AgentSection;
    // Invocation that owns the card. Kept with the call so a result stamps the
    // right block's clock (same-agent siblings have separate sections, R1/R3).
    entry: ThreadEntry;
    name: string;
    callId: string | undefined;
    startedAt: number | undefined;
};

// Every thread id in `threadId`'s ownership subtree (the thread plus every
// descendant linked through `ownerThreadId`). A seen-set terminates a corrupt or
// cyclic roster chain instead of looping or attributing a sibling.
export const threadSubtreeIdsOf = (
    threadId: string,
    threads: readonly SessionThreadEntry[]
): Set<string> => {
    const subtree = new Set<string>([threadId]);
    const queue: string[] = [threadId];

    while (queue.length > 0) {
        const owner = queue.shift() as string;
        for (const candidate of threads) {
            if (candidate.ownerThreadId !== owner || subtree.has(candidate.id)) continue;

            subtree.add(candidate.id);
            queue.push(candidate.id);
        }
    }

    return subtree;
};

// Why a thread's Delete control must not send a request:
//   - 'default' — an `agent:<name>` conversation is not deletable at all (the
//     server answers 400; use Reset session), so the control is hidden;
//   - 'active'  — the thread (or any descendant it would cascade into) has a
//     running/queued turn, or the roster itself says running. The server answers
//     409; the UI disables the control until the work settles. It never auto-stops
//     work on the user's behalf.
// The server remains the authority; this is the same protection computed from the
// last applied snapshot so a stale frame cannot enable a destructive request.
export type ThreadDeleteProtection = 'default' | 'active';

// The row shape delete protection needs: the conversation a turn ran in, and its
// status. `SessionTurn` (raw) and `TurnSummary` (display wire) BOTH satisfy it,
// which is the point — the same destructive-action guard must run identically on
// either surface, without either one being re-projected into the other.
export type ThreadProtectionRow = { status: string; threadId?: string };

export const threadDeleteProtectionOf = (
    entry: SessionThreadEntry,
    threads: readonly SessionThreadEntry[],
    turns: readonly ThreadProtectionRow[]
): ThreadDeleteProtection | undefined => {
    if (entry.origin === 'agent') return 'default';

    if (entry.status === 'running') return 'active';

    const doomed = threadSubtreeIdsOf(entry.id, threads);
    for (const thread of threads) {
        if (doomed.has(thread.id) && thread.status === 'running') return 'active';
    }

    for (const turn of turns) {
        if (turn.status !== 'running' && turn.status !== 'queued') continue;

        const threadId = turnThreadIdOf(turn);
        if (threadId !== undefined && doomed.has(threadId)) return 'active';
    }

    return undefined;
};

// --- T6/R5: which Delete press is immediate, and which one owes a confirmation -----
//
// The request: desktop deletes on ONE press; a phone confirms through a dialog, because
// a thumb resting next to a destructive control must never destroy a conversation (plus
// its whole subtree of turns) on the press that only meant to look at the row.
//
// Two independent axes decide it, and BOTH have to positively say "desktop" before the
// request goes out unasked:
//   - layout width: `(max-width: 860px)` — the SAME breakpoint the shell's rails
//     (main.ts `phoneMedia`) and the composer's cap (ui/composer.ts
//     `COMPOSER_MOBILE_WIDTH`) switch at, so the app never grows a second, drifting
//     "is this a phone" threshold;
//   - primary input device: `(pointer: fine)` — also main.ts's own axis (`finePointerMedia`),
//     and asked in the POSITIVE direction on purpose: a query that only names coarse
//     input would classify `(pointer: none)` (keyboard-only, assistive tech) and any
//     undetected device as a desktop.
//
// Anything the engine cannot vouch for (no `matchMedia` at all — jsdom, old webviews,
// some embedded shells — a throwing implementation, or a list without a boolean
// `matches`) reads as UNKNOWN, and unknown keeps the confirmation. A mistaken extra
// dialog costs one press; a mistaken delete costs the conversation.
//
// Both queries are sampled at CLICK time rather than captured at module init.
// `MediaQueryList.matches` is live, but the list object itself is not always available
// at import time, and the reader may resize or rotate the window between presses — the
// answer must describe the device as it is when the finger lands.
const PHONE_LAYOUT_QUERY = '(max-width: 860px)';
const FINE_POINTER_QUERY = '(pointer: fine)';

// One media feature, three-valued: `true` / `false` only when the engine answered,
// `undefined` when it could not.
const mediaMatches = (query: string): boolean | undefined => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;

    try {
        const list = window.matchMedia(query);
        return typeof list.matches === 'boolean' ? list.matches : undefined;
    } catch {
        // A hostile/stubbed implementation that throws is still "unknown", never a
        // licence to delete without asking.
        return undefined;
    }
};

// Exported because it is the whole policy, it is pure, and a caller (or a test) can pin
// the matrix without mounting a board.
export const requiresDeleteConfirmation = (): boolean =>
    mediaMatches(PHONE_LAYOUT_QUERY) !== false || mediaMatches(FINE_POINTER_QUERY) !== true;

// The one warning sentence, shared by the confirmation dialog so the wording does not
// drift per surface. `<name>` is the conversation code (`RR1`), never a raw id.
const threadDeleteWarningOf = (name: string): string =>
    `Delete thread ${name} permanently? Its turns and transcript are removed.`;

export const createTurnBoard = (options: TurnBoardOptions = {}): TurnBoard => {
    const element = el('div', 'turns');

    const turns: TurnHandle[] = [];
    // Conversation-scoped label counters (R5): the highest occurrence number USED
    // so far per two-letter code (see shared/agent-results.ts `createAgentLabels`).
    // A new tile seeds its allocator from this map and publishes every allocation
    // back, so two distinct threads of one agent read `RR1`/`RR2` instead of both
    // restarting at `RR1`. Cleared with the board, because the numbering is a
    // function of the recorded turn order (a reload rebuilds the same sequence).
    const labelCounters = new Map<string, number>();
    // Every real block across the visible turns, oldest→newest. The composer's #
    // popup reads this on open (and on each keystroke while it stays open); the
    // list is computed live so a streaming turn's new nested block appears without
    // an extra subscription.
    const blocks = (): AgentBlockDescriptor[] => turns.flatMap((turn) => turn.blocks());
    let expandedTurn: TurnHandle | undefined;
    // S1: focus is EXPLICIT state, not a function of whichever tile happens to be
    // expanded. A background adoption (another tab's turn, a snapshot arriving
    // during a submit, a late upsert) may never move it; only `begin`/`focusThread`/
    // an explicit tile click do. `explicitUnfocus` records a deliberate "New thread",
    // which also suppresses the first-content auto-selection after it.
    let focusedThreadId: string | undefined;
    let explicitUnfocus = false;
    // A session SWITCH keeps the tiles of the conversation being left until the new
    // snapshot reconciles them away, so "first content of an empty board" cannot be
    // detected by count alone. This flag (set by `bindSession` on a real change)
    // lets the incoming session open its newest conversation exactly once.
    let pendingFirstFocus = false;
    // Authoritative roster (S2/S6). Used for canonical labels, for resolving a
    // child invocation to its persistent id, and for a roster-only transcript.
    let roster: readonly SessionThreadEntry[] = [];
    // The raw snapshot last applied by the shell. It is the R7 JSON source; the
    // normalized roster above intentionally drops fields (references, raw
    // messages) that a lossless transcript must keep.
    // The raw document last read for THIS board, and it exists only after an
    // EXPLICIT transcript/export read (T5 R3): the default path never pulls recorded
    // events, so `sessionSnapshot` is undefined for a board that has only ever shown
    // the compact view. It remains the lossless source the JSON document quotes.
    let sessionSnapshot: SessionSnapshot | undefined;
    // The compiled document the shell last applied (T5 R1). Roster joins, delete
    // protection and the transcript fallback read the ROWS from here, so none of them
    // needs an event list — and a session that has never been opened raw still knows
    // exactly what the server says exists.
    let sessionView: SessionView | undefined;
    // The session this board is bound to (N3 answer routing + transcript/delete
    // provenance). Declared here because the transcript fallback and the delete
    // transport both consult it.
    let boundSession: string | undefined;
    // Identity for this board's open transcript. Only this board's roster updates
    // refresh it; another view with a coincidentally equal thread id cannot.
    const transcriptScope = {};

    // R9 destructive-action state. T6/R5: the armed inline confirmation is GONE — a
    // mobile/narrow press opens the shared confirmation DIALOG instead, and a proven
    // desktop press sends the request on its own. The dialog reference is still BOARD
    // state (not per bar) because the expanded tile, a nested child card and the
    // roster-only panel can all name the SAME thread: one pending confirmation and one
    // layer no matter which one was pressed. In-flight keys keep deduping a double
    // pointer/confirm into exactly one request.
    let deleteConfirmation: { handle: DialogHandle; threadId: string } | undefined;
    // In-flight deletes are keyed by SESSION + THREAD. Thread ids are only unique
    // per session, and a session switch may show the same id in the new roster; a
    // late resolution of the old request must not clear the new session's dedupe.
    const deletingRequests = new Set<string>();
    let deleteRequestSequence = 0;
    // One token per in-flight confirmed delete. A successful delete closes the
    // transcript through the missing-roster path; that is expected, not a "thread
    // vanished unexpectedly" error. A Set (not a boolean) keeps a stale request's
    // finally from clearing the suppression owned by a newer request.
    const activeDeleteSuppressions = new Set<number>();

    const deletionKey = (sessionId: string, threadId: string): string =>
        `${sessionId}\u0000${threadId}`;

    const currentSessionId = (): string | undefined =>
        sessionSnapshot?.id ?? sessionView?.id ?? boundSession;

    const isDeleting = (threadId: string): boolean => {
        const sessionId = currentSessionId();
        return sessionId !== undefined && deletingRequests.has(deletionKey(sessionId, threadId));
    };
    // Every live action bar's sync callback. Expansion, roster, snapshot,
    // confirmation and in-flight changes repaint all of them from one source.
    const actionBarSyncs = new Set<() => void>();
    const refreshActionBars = (): void => {
        for (const sync of actionBarSyncs) sync();
    };

    // A roster entry for the target thread (labels/protection). The transcript
    // action remains available even when a legacy roster omitted `messages`: the
    // JSON document states the limitation instead of hiding recorded run history.
    const transcriptEntryOf = (threadId: string | undefined): SessionThreadEntry | undefined => {
        if (threadId === undefined || threadId.length === 0) return undefined;

        return roster.find((candidate) => candidate.id === threadId);
    };

    // Raw `SessionThread` for a roster entry, used by the standalone fallback when
    // the host does not provide a snapshot. The normalized entry keeps messages.
    const rawThreadOf = (entry: SessionThreadEntry): SessionThread => ({
        id: entry.id,
        agent: entry.agent,
        origin: entry.origin,
        status: entry.status,
        sequence: entry.sequence,
        ...(entry.label === undefined ? {} : { label: entry.label }),
        ...(entry.ownerThreadId === undefined ? {} : { ownerThreadId: entry.ownerThreadId }),
        ...(entry.invocationId === undefined ? {} : { invocationId: entry.invocationId }),
        ...(entry.originTurnId === undefined ? {} : { originTurnId: entry.originTurnId }),
        ...(entry.originInvocationId === undefined
            ? {}
            : { originInvocationId: entry.originInvocationId }),
        ...(entry.invocationIds === undefined ? {} : { invocationIds: [...entry.invocationIds] }),
        messages: Array.isArray(entry.messages)
            ? (entry.messages as unknown as SessionThread['messages'])
            : []
    });

    // The newest source available to this board. The shell's raw snapshot wins; an
    // embedder that only calls `setThreads` still gets a truthful roster/turn
    // fallback (turns are the last records the tiles merged, and the document's
    // limitations disclose that live frames are not folded in).
    //
    // C5: the fallback carries the invalid roster too, rebuilt from the normalized
    // entries (`SessionThreadEntry.invalid`, joined by ui/threads.ts). A transcript the
    // server cannot read must stay openable in the editor on EVERY source, or a
    // roster-only host would hide the one surface that can repair it.
    const invalidRecordsOf = (entries: readonly SessionThreadEntry[]) =>
        entries
            .map((entry) => entry.invalid)
            .filter((record): record is NonNullable<typeof record> => record !== undefined);

    const transcriptSnapshotNow = (): SessionSnapshot | undefined => {
        if (sessionSnapshot !== undefined) return sessionSnapshot;

        const invalidRecords = invalidRecordsOf(roster);

        // Display-wire authority (T5 R1/R3): the shell applied a compiled view but no
        // raw document has been read yet (the reader has not opened a transcript in
        // this page's life). The rows are the honest source then — identity, status,
        // usage, timing, steers and references all survive, and the exported document
        // simply has no recorded events, which its own limitations line discloses.
        if (sessionView !== undefined) {
            // The roster of a compiled view is `threadViews` (identity + transcript SIGNAL, no
            // messages), so the composite carries the roster rows the transcript surface needs to
            // find the conversation at all; the recorded transcript itself arrives from the
            // freshness read the dialog fires right after opening (`refreshSessionSnapshot`).
            return {
                ...sessionView,
                messages: [],
                threads: roster.map(rawThreadOf),
                turns: summariesOf(sessionView) as unknown as SessionTurn[],
                ...(invalidRecords.length === 0 ? {} : { invalidThreads: invalidRecords })
            } as unknown as SessionSnapshot;
        }

        if (roster.length === 0) return undefined;

        const sourceTurns = turns
            .map((turn) => turn.source())
            .filter((turn): turn is SessionTurn => turn !== undefined);

        return {
            id: boundSession ?? '',
            harness: '',
            status: 'idle',
            model: '',
            createdAt: 0,
            updatedAt: 0,
            messages: [],
            threads: roster.map(rawThreadOf),
            turns: sourceTurns,
            ...(invalidRecords.length === 0 ? {} : { invalidThreads: invalidRecords })
        } as SessionSnapshot;
    };

    // The rows this board currently knows, for delete protection. Preference order
    // is "most authoritative AND most recent": a raw read wins, the applied view comes
    // next, and the tiles' own merged records are the last resort (an embedder that
    // only calls `setThreads`).
    const transcriptTurnsNow = (): readonly ThreadProtectionRow[] =>
        sessionSnapshot?.turns ??
        (sessionView === undefined ? undefined : summariesOf(sessionView)) ??
        turns
            .map((turn) => turn.source())
            .filter((turn): turn is SessionTurn => turn !== undefined) ??
        [];

    // Delete protection is recomputed from the freshest roster/turns the board
    // holds. A missing entry is not deletable through this surface.
    const deleteProtectionFor = (threadId: string): ThreadDeleteProtection | undefined => {
        const entry = roster.find((candidate) => candidate.id === threadId);
        if (entry === undefined) return 'default';

        const protection = threadDeleteProtectionOf(entry, roster, transcriptTurnsNow());
        if (protection !== undefined) return protection;

        // Optimistic/local work the last snapshot cannot describe yet: a tile that
        // is queued/waiting/streaming for this thread (or a descendant) is live.
        const doomed = threadSubtreeIdsOf(threadId, roster);
        for (const turn of turns) {
            const turnThread = turn.threadId();
            if (turnThread === undefined || !doomed.has(turnThread)) continue;

            const state = turn.state();
            if (state === 'queued' || state === 'waiting' || state === 'streaming') return 'active';
        }

        return undefined;
    };

    // T6/R5: dismiss the confirmation layer this board holds. `close()` is idempotent
    // and its `onClose` (fired exactly once, after the overlay is removed and focus is
    // restored) owns the state clear plus the toolbar repaint, so the dialog's own
    // header close, Escape, the backdrop, Cancel, the Delete action and every
    // programmatic teardown below all share ONE dismissal path.
    const closeThreadDeleteConfirmation = (): void => {
        deleteConfirmation?.handle.close();
    };

    // The mobile/tablet confirmation: the SAME shared dialog shell the transcript and the
    // previews use (ui/dialog.ts), so the focus trap, Escape/backdrop dismissal, stacking
    // under an open transcript and focus restoration are the proven implementation
    // instead of a second hand-rolled overlay. `trigger` is the Delete control that was
    // pressed, which is where closing puts focus back.
    const openThreadDeleteConfirmation = (threadId: string, trigger?: HTMLElement): void => {
        const entry = roster.find((candidate) => candidate.id === threadId);
        if (entry === undefined) return;

        if (deleteConfirmation !== undefined) {
            // Second press for the SAME conversation: keep the layer already open rather
            // than stack an identical one — the request must stay exactly one, and a
            // reader double-tapping a disabled-looking control gets nothing new.
            if (deleteConfirmation.threadId === threadId) return;

            // A DIFFERENT conversation replaces the layer instead of stacking it, so the
            // dialog on screen always names the thread the reader pressed last.
            closeThreadDeleteConfirmation();
        }

        const name = threadNameOf(entry);
        // The class names are the ones styles.css already ships for the destructive
        // confirmation (`.thread-delete-confirm*`), so the dialog body is styled by the
        // rules that styled the old inline row — this worker does not own styles.css, and
        // reusing the vocabulary keeps one look. Inside `.dialog-body` the container's
        // `flex: 1 0 100%` basis is inert, so it lays out as a wrapping row either way.
        const content = el('div', 'thread-delete-confirm');
        content.setAttribute('role', 'group');
        content.setAttribute('aria-label', `Confirm deleting thread ${name}`);

        const text = el('p', 'thread-delete-confirm-text');
        text.append(el('span', 'thread-delete-confirm-body', threadDeleteWarningOf(name)));

        const confirmButton = el('button', 'thread-delete-confirm-delete', 'Delete thread');
        confirmButton.type = 'button';
        const cancelButton = el('button', 'thread-delete-confirm-cancel', 'Cancel');
        cancelButton.type = 'button';
        content.append(text, confirmButton, cancelButton);

        confirmButton.addEventListener('click', () => {
            // Ownership guard: only the layer that still OWNS the pending confirmation may
            // act. A body left over from a replaced or cleared dialog (a detached node a
            // synthetic click can still reach) must never fire a second request.
            if (deleteConfirmation === undefined || deleteConfirmation.handle !== handle) return;

            // Dismiss FIRST, then request: the confirmation is spent either way, and the
            // answer (including the transcript/focus teardown on success) must never queue
            // behind a modal layer. `confirmThreadDelete` re-checks protection, session
            // identity, in-flight dedupe and its own errors.
            closeThreadDeleteConfirmation();
            void confirmThreadDelete(threadId);
        });

        cancelButton.addEventListener('click', () => {
            // "No": the layer closes, nothing is sent, focus returns to the trigger.
            if (deleteConfirmation === undefined || deleteConfirmation.handle !== handle) return;

            closeThreadDeleteConfirmation();
        });

        let handle: DialogHandle | undefined;
        handle = openDialog({
            title: 'Delete thread',
            content,
            // Focus goes back to the control the reader actually pressed — Escape, the
            // backdrop and the header close all land on the same rule. `undefined` keeps
            // the dialog's own capture of what was focused at open time.
            returnFocus: trigger,
            onClose: () => {
                // Identity guard: a replaced layer's late cleanup must not clear the
                // confirmation that took its place.
                if (deleteConfirmation?.handle === handle) deleteConfirmation = undefined;
                refreshActionBars();
            }
        });

        deleteConfirmation = { handle, threadId };
    };

    // First click. A PROVEN desktop (wide viewport + fine pointer, see
    // `requiresDeleteConfirmation`) deletes on this press: one callback, no layer. Every
    // other surface — narrow, coarse, `none`, or an engine that cannot answer either
    // query — opens the confirmation dialog and sends nothing yet.
    const requestThreadDelete = (threadId: string, trigger?: HTMLElement): void => {
        if (isDeleting(threadId)) return;

        const entry = roster.find((candidate) => candidate.id === threadId);
        if (
            entry === undefined ||
            // Nothing to confirm when there is no transport: an unwired host keeps its
            // honest disabled control (see `sync`) and must not grow a dead-end dialog.
            options.deleteThread === undefined ||
            deleteProtectionFor(threadId) !== undefined
        ) {
            return;
        }

        if (!requiresDeleteConfirmation()) {
            void confirmThreadDelete(threadId);
            return;
        }

        openThreadDeleteConfirmation(threadId, trigger);
    };

    // The confirmed click (mobile dialog) or the single desktop click: exactly one
    // DELETE. The shell callback owns the existing API and reconciles its returned
    // snapshot/tombstones; this board only closes the surfaces that are provably gone
    // and reports failure without dropping data.
    const confirmThreadDelete = async (threadId: string): Promise<void> => {
        const sessionId = currentSessionId();
        if (sessionId !== undefined && isDeleting(threadId)) return;

        const entry = roster.find((candidate) => candidate.id === threadId);
        if (
            entry === undefined ||
            entry.origin === 'agent' ||
            deleteProtectionFor(threadId) !== undefined ||
            options.deleteThread === undefined ||
            sessionId === undefined
        ) {
            // A protected/vanished conversation cannot answer. Repaint the toolbar (the
            // confirmation layer already dismissed itself) and send nothing.
            refreshActionBars();
            return;
        }

        // Capture the subtree BEFORE the request: once the shell reconciles its
        // answer the roster no longer names it, but these are the ids whose focus/
        // transcript the successful deletion must retire.
        const doomed = threadSubtreeIdsOf(threadId, roster);
        const originSession = sessionId;
        const requestKey = deletionKey(originSession, threadId);
        if (deletingRequests.has(requestKey)) return;

        const suppressionToken = (deleteRequestSequence += 1);

        deletingRequests.add(requestKey);
        activeDeleteSuppressions.add(suppressionToken);
        refreshActionBars();

        try {
            await options.deleteThread(sessionId, threadId);
            if (boundSession !== originSession) return;

            // The shell's applySnapshot normally closes/updates through setThreads;
            // closing here keeps an embedding that only resolves its promise honest
            // too. Focus/panel cleanup is idempotent.
            closeThreadTranscript(transcriptScope, [...doomed]);
            if (focusedThreadId !== undefined && doomed.has(focusedThreadId)) {
                dropFocusState();
                notifyFocus();
            }
            if (focusPanel !== undefined && doomed.has(focusPanel.dataset.threadId ?? '')) {
                hideFocusPanel();
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            notice(`delete thread: ${message}`, 'error');
            refreshActionBars();
        } finally {
            // Identity/token-scoped cleanup: a late answer from another session (or
            // an earlier request) can only remove its OWN entry/suppression.
            deletingRequests.delete(requestKey);
            activeDeleteSuppressions.delete(suppressionToken);
            refreshActionBars();
        }
    };

    // One action bar shared by the expanded tile, every nested child card and the
    // roster-only focus panel. T26: the two controls SWAPPED homes — Delete now leads the
    // bar (left, where Transcript used to be) and Transcript closes it (right, where
    // Delete used to be painted in the card header). The header's right edge is free for
    // the measurement line instead, so `deleteHost` and its absolutely positioned slot are
    // gone: both buttons are ordinary bar children again and styles.css pushes the second
    // one right. Labels are desktop text, mobile glyphs; `aria-label` always carries the
    // full accessible name.
    //
    // T6/R5: the confirmation no longer lives in THIS bar. A proven desktop press deletes
    // on the click itself, and every other surface opens the shared confirmation DIALOG
    // (`openThreadDeleteConfirmation`). The bar is therefore exactly its two actions: no
    // inline row that a stray second tap could confirm, and nothing left to reflow the
    // identity line on a click.
    type ThreadActionBar = {
        element: HTMLElement;
        transcriptButton: HTMLButtonElement;
        deleteButton: HTMLButtonElement;
        sync: () => void;
        dispose: () => void;
    };

    const createThreadActionBar = (input: {
        className: string;
        transcriptClass?: string;
        visible: () => boolean;
        target: () => string | undefined;
        open: () => void;
    }): ThreadActionBar => {
        const bar = el('div', input.className);
        bar.hidden = true;

        const transcriptButton = el('button', 'transcript-open action-transcript');
        transcriptButton.type = 'button';
        if (input.transcriptClass !== undefined) {
            transcriptButton.classList.add(input.transcriptClass);
        }
        const transcriptLabel = el('span', 'action-label', 'Transcript');
        const transcriptGlyph = el('span', 'action-glyph', '{}');
        transcriptButton.append(transcriptLabel, transcriptGlyph);
        transcriptButton.addEventListener('click', input.open);

        const deleteButton = el('button', 'thread-delete');
        deleteButton.type = 'button';
        const deleteLabel = el('span', 'action-label', 'Delete');
        const deleteGlyph = el('span', 'action-glyph', 'X');
        deleteButton.append(deleteLabel, deleteGlyph);
        deleteButton.addEventListener('click', () => {
            const threadId = input.target();
            // The pressed control travels with the request so a confirmation dialog can
            // hand focus back to it on dismissal (desktop presses never open one).
            if (threadId !== undefined) requestThreadDelete(threadId, deleteButton);
        });

        // T26: Delete leads the bar and Transcript closes it (the two swapped places, and
        // the measurement line took the header's right-edge slot). DOM order is the visual
        // order; `margin-left: auto` on `.transcript-open` (styles.css) is what pins the
        // transcript button to the right even when Delete is hidden.
        bar.append(deleteButton, transcriptButton);

        const sync = (): void => {
            const threadId = input.target();
            const entry = threadId === undefined ? undefined : transcriptEntryOf(threadId);
            if (threadId === undefined || entry === undefined || !input.visible()) {
                bar.hidden = true;
                return;
            }

            bar.hidden = false;
            const name = threadNameOf(entry);
            const transcriptBusy = isDeleting(threadId);
            // C5: an unreadable transcript is offered through the SAME control, but
            // the hover/accessible name says what it actually opens (an editor for the
            // raw JSON) instead of promising a readable document.
            const unreadable = entry.invalid !== undefined;

            transcriptButton.dataset.invalid = unreadable ? 'true' : 'false';
            transcriptButton.setAttribute(
                'aria-label',
                unreadable
                    ? `Open the unreadable transcript JSON of ${name} to repair it`
                    : `Open the JSON transcript of ${name}`
            );
            transcriptButton.title = unreadable
                ? `This thread's transcript cannot be read; edit its raw JSON to repair it`
                : `Open the complete JSON transcript of ${name}`;
            transcriptButton.disabled = transcriptBusy;

            const protection = deleteProtectionFor(threadId);

            // The agent's default conversation is never deletable (Reset session
            // clears it); a live/queued thread is temporarily protected. Both keep
            // the toolbar honest instead of sending a request the server refuses.
            deleteButton.hidden = protection === 'default';
            deleteButton.disabled =
                protection !== undefined ||
                transcriptBusy ||
                options.deleteThread === undefined;
            deleteButton.setAttribute('aria-label', `Delete thread ${name}`);
            deleteButton.title =
                protection === 'active'
                    ? 'Stop the active or queued work in this thread before deleting it.'
                    : protection === 'default'
                      ? 'The default agent conversation cannot be deleted; reset the session instead.'
                      : transcriptBusy
                        ? 'Deleting this thread...'
                        : options.deleteThread === undefined
                          ? 'Thread deletion is not wired in this host.'
                          : 'Delete this thread permanently';
        };

        actionBarSyncs.add(sync);
        return {
            element: bar,
            transcriptButton,
            deleteButton,
            sync,
            dispose: () => {
                actionBarSyncs.delete(sync);
            }
        };
    };

    const notifyTranscriptRefresh = (result: ThreadTranscriptRefresh): void => {
        if (result !== 'closed' || activeDeleteSuppressions.size > 0) return;

        notice('Thread transcript closed: this thread no longer exists.', 'error');
    };

    // Open the JSON transcript for one persistent thread. The click is the only
    // trigger; the initial document comes from the latest applied snapshot and a
    // shell-provided single `getSession` refresh runs in the background.
    //
    // C5: an unreadable transcript is NOT a reason to silently return. The roster
    // entry carries the joined invalid record (ui/threads.ts), so the click opens the
    // editor with the raw stored value and the error banner — the state in which the
    // reader can actually fix the JSON.
    const openTranscriptOf = (threadId: string | undefined): void => {
        const entry = transcriptEntryOf(threadId);
        const source = transcriptSnapshotNow();
        if (threadId === undefined || source === undefined) return;

        // A thread the roster does not describe offers nothing — UNLESS the applied
        // snapshot names it in `invalidThreads`: an unreadable conversation the reader
        // cannot open cannot be repaired either, so a partial roster must not hide it.
        if (
            entry === undefined &&
            invalidThreadsOf(source).find((record) => record.id === threadId) === undefined
        ) {
            return;
        }

        // The standalone fallback has no session id; bind the board's id so a later
        // async refresh with the real snapshot is accepted as the SAME session.
        const snapshot =
            source.id.length > 0 || boundSession === undefined
                ? source
                : { ...source, id: boundSession };
        const sessionId = snapshot.id.length > 0 ? snapshot.id : boundSession;

        // The save transport is bound to THIS session + thread before the dialog is
        // built: the answer of a late PUT must never be applied to a conversation the
        // reader moved on to, and the dialog itself holds no routing knowledge.
        const transport = options.saveThreadTranscript;
        const onSave =
            transport === undefined || sessionId === undefined
                ? undefined
                : (messages: unknown): Promise<ThreadTranscriptPayload> =>
                      transport(sessionId, threadId, messages);

        const handle = openThreadTranscript(snapshot, threadId, transcriptScope, {
            ...(onSave === undefined ? {} : { onSave })
        });
        if (handle === undefined) return;

        if (options.refreshSessionSnapshot === undefined || sessionId === undefined) return;

        void options
            .refreshSessionSnapshot(sessionId)
            .then((fresh) => {
                // Guard the READER's state, not just the request: closed dialog,
                // another transcript, another board, or a session switch all make
                // this answer stale. The transcript module also compares session id
                // and the tracked handle identity.
                if (fresh === undefined || fresh.id !== sessionId) return;

                notifyTranscriptRefresh(refreshOpenThreadTranscript(fresh, transcriptScope));
            })
            .catch(() => {
                // A failed freshness read is not a transcript error: the last
                // applied snapshot is still truthful and remains on screen.
            });
    };
    // DURABLE invocation → persistent-thread cache (R3), BOARD-scoped so a session
    // switch can drop it (`bindSession`) instead of letting one session's invocation
    // ids resolve against another's roster. Each tile writes here from
    // `persistentIdOf` whenever the roster names its invocation; the authoritative
    // source is still the roster's `invocationIds`, which needs no cache. The cache
    // only preserves a join for an OLD payload whose roster advanced the single
    // invocation slots without sending the historical list.
    const learnedThreads = new Map<string, string>();
    // The roster-only conversation surface (a runtime child with no turn of its own).
    let focusPanel: HTMLElement | undefined;
    // The focus panel is rebuilt whenever focus changes; its toolbar must leave
    // the board-wide sync set with the old DOM instead of refreshing detached nodes.
    let focusActionDispose: (() => void) | undefined;

    // --- conversation projection (T12b, revised for the one-card rule) ---
    //
    // A persistent thread is ONE conversation, even though the server records one
    // `SessionTurn` per RUN (a continuation, a steered submit that became a queued
    // continuation, …). Every turn of the same `threadId` is projected into one
    // top-level `.conversation` container, in recorded order; a legacy turn with no
    // thread stays its own top-level `.turn-row`. The tiles (and therefore
    // `blocks()`, timing, status and references) are untouched: only their DOM
    // parent changes, so grouping can never renumber a result block.
    //
    // ONE VISIBLE CARD (R2): the `.conversation` container IS the card. styles.css
    // gives it the border/radius/agent outline and neutralises the inner `.tile`
    // frames, so a follow-up submitted to a focused thread appends a sequential
    // exchange INSIDE the same block instead of opening a second bordered tile
    // (which is what the previous projection did: one card per run, stacked under a
    // wrapper). A distinct sibling thread still gets its own card (R3).
    const conversationHosts = new Map<string, HTMLElement>();

    const conversationHost = (threadId: string): HTMLElement => {
        const existing = conversationHosts.get(threadId);
        if (existing !== undefined) return existing;

        // The section is the VISIBLE card of a persistent thread (styles.css), not a
        // transparent grouping wrapper: it carries the frame and the identity tone.
        const host = el('section', 'conversation');
        host.dataset.threadId = threadId;
        conversationHosts.set(threadId, host);
        return host;
    };

    // Paint the card with the identity of its FIRST exchange. The tile already paints
    // `--agent-*` / `data-agent` when its root section names the agent
    // (ui/agent-color.ts `paintAgentColor`), so the card outline is the conversation's
    // own tone; an unnamed conversation falls back to the neutral default instead of
    // inheriting whatever the last painted block left behind.
    const paintConversationAgent = (host: HTMLElement): void => {
        const lead = [...host.children].find(
            (node): node is HTMLElement => node instanceof HTMLElement && node.classList.contains('turn-row')
        );
        paintAgentColor(host, lead?.querySelector<HTMLElement>('.tile')?.dataset.agent);
    };

    // The exchange surface of a nested CHILD conversation card. A child thread is
    // spawned inside its parent's turn as a `.thread-row` keyed by the invocation;
    // once the roster joins it to the persistent id the row is marked with
    // `data-persistent-thread` (see `paintPersistentMarkers`). A CONTINUATION of that
    // child is a real turn of its OWN thread and belongs inside that card — not as a
    // sibling `.turn-row` under the owner conversation, which made a resumed child
    // read as a second block. Returns the card's flow so the exchange lands after the
    // child's recorded transcript, exactly like a root conversation card.
    const childExchangeHost = (threadId: string): HTMLElement | undefined => {
        // Iterate instead of escaping the id into a selector: runtime thread ids are
        // opaque and may contain quotes/percent signs.
        for (const row of element.querySelectorAll<HTMLElement>('.thread-row')) {
            if (row.dataset.persistentThread !== threadId) continue;

            const flow = row.querySelector<HTMLElement>(':scope > .thread-tile > .thread-body > .thread-flow');
            if (flow !== null) return flow;
        }

        return undefined;
    };

    // Chronological order INSIDE one card (a conversation host or a nested child
    // card's flow). `placeTurn` re-appends a row on every reconcile, and a live
    // snapshot can list a continuation BEFORE its owner (or re-place an earlier
    // exchange), so without this pass the card could show its messages out of order.
    // Only the turn rows move; a child card's own transcript/tool nodes stay ahead.
    const orderRows = (flow: HTMLElement): void => {
        const rows = [...flow.children].filter(
            (node): node is HTMLElement => node instanceof HTMLElement && node.classList.contains('turn-row')
        );
        const positionOf = (node: HTMLElement): number =>
            turns.findIndex((turn) => turn.element.parentElement === node);

        rows.sort((left, right) => positionOf(left) - positionOf(right));
        for (const node of rows) flow.append(node);
    };

    // The conversation CARD a tile currently lives in (undefined for a legacy
    // standalone turn, and for a continuation routed into a nested child card).
    // Expansion and focus follow the CONTAINER, not the thread id, because a child
    // conversation without its own card shares its owner's container.
    const hostOfTurn = (turn: TurnHandle): HTMLElement | undefined => {
        const row = turn.element.parentElement;
        const host = row?.parentElement;

        return host instanceof HTMLElement && host.classList.contains('conversation') ? host : undefined;
    };

    // C8-M1: WHICH conversation a tile's row belongs to is decided by the
    // AUTHORITATIVE record whenever one is bound, never by the tile's draft
    // binding. `turn.threadId()` is the runtime binding and `setThreadId` is
    // deliberately ADDITIVE (a record that omits `threadId` keeps the draft value):
    // the composer must keep steering/continuing the conversation the reader
    // focused when the submit left the browser, even for a record that names no
    // thread. Placement cannot inherit that draft. A server COMMAND turn is
    // thread-less (src/server/sessions.ts `executeCommandTurn` records no
    // `threadId`), so the live card sat INSIDE the focused conversation while the
    // same record hydrated board-level, and once that conversation was deleted the
    // orphaned card was the only thing keeping its container on the board.
    const placementThreadIdOf = (turn: TurnHandle): string | undefined => {
        const source = turn.source();

        // Unbound optimistic tile: no record exists yet, so the draft thread the
        // submit was addressed to IS the placement (a new conversation adopts its
        // container from its first record — see `setThreadId`).
        return source === undefined ? turn.threadId() : turnThreadIdOf(source);
    };

    const hostThreadIdOf = (threadId: string): string => {
        const seen = new Set<string>([threadId]);
        let current = roster.find((candidate) => candidate.id === threadId)?.ownerThreadId;

        while (current !== undefined && !seen.has(current)) {
            // Nest under the nearest OWNED ancestor that already has a conversation
            // container (or at least a turn). A link to a thread with no visible
            // surface falls through to this conversation remaining top-level.
            // The surface test uses the SAME placement authority as `placeTurn`, so
            // a thread-less card (a command turn) can never be mistaken for a turn
            // of the ancestor it was submitted from.
            if (
                conversationHosts.has(current) ||
                turns.some((candidate) => placementThreadIdOf(candidate) === current)
            ) {
                return current;
            }

            seen.add(current);
            current = roster.find((candidate) => candidate.id === current)?.ownerThreadId;
        }

        return threadId;
    };

    // Put one tile's row at its current conversation position. Idempotent: it is
    // called on creation, whenever a tile learns/changes its persistent id (a new
    // thread adopted from its first record), and on every reconcile.
    const placeTurn = (turn: TurnHandle): void => {
        const row = turn.element.parentElement;
        if (row === null) return;

        // C8-M1: record-authoritative (see `placementThreadIdOf`), so a live command
        // tile leaves the focused conversation the moment its record is merged and
        // reads exactly like its hydrated twin.
        const threadId = placementThreadIdOf(turn);

        // 1. A continuation of a CHILD conversation lands inside that child's own
        //    nested card (see `childExchangeHost`), so a resumed child keeps ONE card
        //    with sequential exchanges instead of gaining a sibling tile under its
        //    owner. Guarded against a card that lives inside THIS tile: appending the
        //    row into its own subtree would tear the DOM apart.
        const exchange = threadId === undefined ? undefined : childExchangeHost(threadId);
        if (exchange !== undefined && !turn.element.contains(exchange)) {
            if (row.parentElement !== exchange) exchange.append(row);
            delete row.dataset.childThread;
            row.dataset.threadExchange = threadId;
            orderRows(exchange);
            reorderBoard();
            return;
        }

        const hostId = threadId === undefined ? undefined : hostThreadIdOf(threadId);
        const host = hostId === undefined ? undefined : conversationHost(hostId);
        if (host === undefined) {
            if (row.parentElement !== element) element.append(row);
            delete row.dataset.childThread;
            delete row.dataset.threadExchange;
        } else {
            if (row.parentElement !== host) host.append(row);
            delete row.dataset.threadExchange;

            // RECORDED order inside the card. A live snapshot can list the
            // continuation before its owner (or re-place an earlier exchange), and a
            // blind `append` would then show the follow-up above the first prompt.
            orderRows(host);

            // A child CONVERSATION is visually nested in its owner, marking the row
            // so CSS can indent it without a generic `.thread-row` wrapper.
            if (threadId !== undefined && hostId !== threadId) row.dataset.childThread = threadId;
            else delete row.dataset.childThread;

            // Keep the first exchange as the conversation header; later exchanges
            // are ordered messages of the SAME conversation (their repeated label
            // is hidden by CSS, but the marker keeps the semantics assertable).
            const grouped = [...host.children].filter(
                (node): node is HTMLElement => node instanceof HTMLElement && node.classList.contains('turn-row')
            );
            grouped.forEach((node, index) => node.classList.toggle('is-continuation', index > 0));

            // The card owns the frame, so its identity tone follows the FIRST exchange.
            paintConversationAgent(host);
        }

        reorderBoard();
        // A tile that was already the focused surface when it learned its thread
        // must take its newly created group with it (otherwise the later exchanges
        // would stay collapsed under an open conversation).
        if (expandedTurn === turn && hostId !== undefined) {
            conversationHost(hostId).classList.add('is-expanded');
        }
    };

    // The board-direct ancestor of a row: the top-level unit this pass may move.
    // Walking up (rather than assuming `row.parentElement`) is what keeps a row
    // routed into a NESTED card from hoisting its `.thread-flow` out of the card —
    // the unit is then the turn row that owns the card, which is already placed.
    const topLevelOf = (node: HTMLElement): HTMLElement | undefined => {
        let cursor: HTMLElement | undefined = node;
        // `parentElement === null` also ends the walk: a freshly created conversation
        // card is DETACHED until this pass appends it, and stopping early would leave
        // it out of the board while its exchanges were already inside it.
        while (cursor !== undefined && cursor.parentElement !== null && cursor.parentElement !== element) {
            cursor = cursor.parentElement;
        }
        return cursor === element ? undefined : cursor;
    };

    // Restore deterministic top-level order: first appearance of each conversation
    // in recorded turn order, then legacy standalone rows, then notices. The focus
    // panel stays first because it is prepended and never moved by this pass.
    const reorderBoard = (): void => {
        const seen = new Set<HTMLElement>();

        for (const turn of turns) {
            const row = turn.element.parentElement;
            if (row === null) continue;

            // A legacy/standalone turn is its own top-level unit; a grouped turn's
            // unit is its conversation container. Never append `.turns` into itself.
            const container = topLevelOf(row);
            if (container === undefined) continue;
            if (seen.has(container)) continue;

            seen.add(container);
            element.append(container);
        }

        // Empty conversation shells (all turns removed) must not leave a blank row;
        // surviving groups mark their first exchange as the header so removing the
        // original run never leaves a continuation wearing the conversation label.
        for (const [threadId, host] of [...conversationHosts]) {
            // Ordering first: the "first exchange is the header" rule below must be
            // applied to RECORDED order, not to whatever order the nodes arrived in.
            orderRows(host);
            const grouped = [...host.children].filter(
                (node): node is HTMLElement => node instanceof HTMLElement && node.classList.contains('turn-row')
            );

            if (grouped.length === 0) {
                host.remove();
                conversationHosts.delete(threadId);
                continue;
            }

            grouped.forEach((node, index) => node.classList.toggle('is-continuation', index > 0));
            // The first exchange may have learned its agent AFTER the placement that
            // painted the card (the start frame can arrive later), so repaint it here:
            // the card outline follows the conversation, not the `:root` fallback.
            paintConversationAgent(host);
        }

        for (const node of [...element.querySelectorAll<HTMLElement>(':scope > .notice')]) {
            element.append(node);
        }
    };

    // Re-run the projection for EVERY turn. A nested child card only becomes
    // addressable once it is painted with its persistent id (roster join), which can
    // happen after its continuation was already placed; hydration/reconcile order must
    // never decide whether a resumed child lands in its own card. Called from the
    // per-turn projection when a card appears or is re-keyed (see `createThread` and
    // `adoptPlaceholder`) and on every roster update.
    //
    // The joins themselves come from the persistent markers (`persistentIdOf`, i.e.
    // the authoritative roster: `id`, `invocationId`, `originInvocationId`,
    // `invocationIds`) — NOT from content. A task-text match would be a guess that
    // cannot separate two identical sibling delegations, so it is deliberately absent.
    const placeAllTurns = (): void => {
        for (const turn of turns) placeTurn(turn);
        reorderBoard();
        // C5: the projection can create or replace a conversation card, so the
        // unreadable-transcript mark is re-applied from the roster in the same pass.
        paintRosterInvalid();
    };

    const notifyFocus = (): void => options.onFocusChange?.(focusedThreadId);

    // Cards THIS focus opened automatically, so ending the focus closes only them
    // (a card the reader opened by hand is their own state, not ours to collapse).
    const openedCards: HTMLElement[] = [];
    // R4/T6: the nested-card model behind each `.thread-row`. `openEnclosingCards`
    // must update the SAME entry state as a click (`expanded`, tile class,
    // `aria-expanded`, transcript action) without recording an automatic open as a
    // user preference. `remember=false` is that distinction.
    const threadRowSync = new WeakMap<HTMLElement, (expanded: boolean, remember?: boolean) => void>();

    // T22 (R22): the rows the READER collapsed on purpose.
    //
    // `openEnclosingCards` exists so an expanded exchange is never hidden inside a
    // collapsed ancestor card (T6), but an implicit reveal is not a request to undo a
    // choice the reader just made: without this set, collapsing a delegated card and then
    // expanding the parent tile re-opened it, so a loaded conversation could never be
    // read as the reader arranged it. Membership is per row element and deliberately not
    // remembered across a projection rebuild — a rebuild already starts every card
    // collapsed, and `expandedThreads` is what carries a reader's EXPANSION across one.
    // Only an explicit user transition (remember=true) writes here; the board's implicit
    // open/close passes remember=false and therefore never forges an intent.
    const userCollapsedRows = new WeakSet<HTMLElement>();

    // Open every NESTED card that contains this turn's row. A continuation routed
    // into a child card (see `placeTurn`) is only visible while that card is open, so
    // focusing a resumed child would otherwise show an "expanded" turn nobody can see.
    // The reader can still collapse the card afterwards; this only guarantees the
    // focused exchange is not hidden by an ancestor's collapsed body.
    const openEnclosingCards = (turn: TurnHandle): void => {
        let host = turn.element.parentElement?.closest<HTMLElement>('.thread-row') ?? null;

        while (host !== null) {
            // T22 (R22): a card the READER collapsed stays collapsed. The walk still climbs
            // to the next ancestor, because their collapse covered this card and not the
            // chain above it — and an implicit reveal must never look like an expansion the
            // reader asked for, so nothing is pushed onto `openedCards` here either.
            if (userCollapsedRows.has(host)) {
                host = host.parentElement?.closest<HTMLElement>('.thread-row') ?? null;
                continue;
            }

            if (!host.classList.contains('is-expanded') && !openedCards.includes(host)) openedCards.push(host);

            // T6: drive the card's MODEL, not just its DOM. A directly-added class
            // left `entry.expanded` false and its transcript action hidden, so an
            // implicitly opened card looked expanded without offering its thread
            // transcript. `remember=false` keeps the auto-open out of
            // `expandedThreads`, so a projection rebuild does not turn it into a
            // reader preference.
            const applyExpanded = threadRowSync.get(host);
            if (applyExpanded !== undefined) {
                applyExpanded(true, false);
            } else {
                host.classList.add('is-expanded');
                host.querySelector<HTMLButtonElement>(':scope > .thread-tile > .thread-select')?.setAttribute(
                    'aria-expanded',
                    'true'
                );
            }
            // Continue from the card's ROW, not the card body: the next enclosing
            // card (a grandparent invocation) is an ancestor of the row.
            host = host.parentElement?.closest<HTMLElement>('.thread-row') ?? null;
        }
    };

    // Detach the expanded TILE without touching focus state (used when focus moves
    // to a child conversation or to a roster-only panel: only ONE persistent
    // conversation may be open at a time).
    const detachTileExpansion = (): void => {
        // Cards opened only to reveal a focused exchange are closed with it; the tile
        // itself is a separate surface and is handled below.
        for (const card of openedCards.splice(0)) {
            // Mirror the open path: close the MODEL too, so the action hides and a
            // later rebuild sees the card as collapsed.
            const applyExpanded = threadRowSync.get(card);
            if (applyExpanded !== undefined) {
                applyExpanded(false, false);
            } else {
                card.classList.remove('is-expanded');
                card.querySelector<HTMLButtonElement>(':scope > .thread-tile > .thread-select')?.setAttribute(
                    'aria-expanded',
                    'false'
                );
            }
        }

        if (expandedTurn === undefined) return;

        expandedTurn.element.classList.remove('is-expanded');
        expandedTurn.element
            .querySelector<HTMLButtonElement>('.tile-select')
            ?.setAttribute('aria-expanded', 'false');
        // R4: the action belongs to the expanded surface only.
        expandedTurn.syncTranscriptAction();
        // The whole CONVERSATION was open (all its exchanges), not just this tile.
        hostOfTurn(expandedTurn)?.classList.remove('is-expanded');
        expandedTurn = undefined;
    };

    // The roster-only/child conversation panel. Rendering from `SessionThread.messages`
    // is what lets a child conversation (whose work is recorded INSIDE its parent's
    // turn and which has no `SessionTurn` of its own) be read and steered.
    const hideFocusPanel = (): void => {
        focusActionDispose?.();
        focusActionDispose = undefined;
        focusPanel?.remove();
        focusPanel = undefined;
    };

    const showFocusPanel = (entry: SessionThreadEntry): void => {
        hideFocusPanel();

        const name = threadNameOf(entry);
        const panel = el('section', 'thread-focus-panel');
        panel.dataset.threadId = entry.id;
        panel.dataset.agent = entry.agent;
        panel.setAttribute('aria-label', `Focused thread ${name} of ${entry.agent}`);

        const head = el('header', 'thread-focus-head');
        // T26: the header is not a <button> here and no longer holds a control at all —
        // Delete and Transcript both live in the bar below, in the same order every other
        // surface uses (state stays next to the conversation name on the left).
        head.append(
            el('span', 'thread-focus-agent', entry.agent),
            el('span', 'thread-focus-name', name),
            el('span', 'thread-focus-status', entry.status)
        );
        // C5: an unreadable transcript is stated ONCE, briefly, next to the identity —
        // the conversation is still focusable, steerable and fixable from the bar below,
        // and hiding the state would make the editor in the dialog look like a surprise.
        if (entry.invalid !== undefined) {
            panel.dataset.invalid = 'true';
            head.append(el('span', 'thread-focus-invalid', 'transcript unreadable'));
        }
        if (entry.ownerThreadId !== undefined) {
            const owner = roster.find((candidate) => candidate.id === entry.ownerThreadId);
            head.append(
                el(
                    'span',
                    'thread-focus-owner',
                    owner === undefined ? `owned by ${entry.ownerThreadId}` : `owned by ${threadNameOf(owner)}`
                )
            );
        }

        // R7/R8/T26: a roster-only thread has no turn tile to expand, so this panel IS its
        // expanded surface and gets the SAME controls: Delete on the left of the toolbar,
        // Transcript on the right (default/running protection still applies).
        const actionBar = createThreadActionBar({
            className: 'thread-transcript-action thread-focus-actions',
            transcriptClass: 'thread-focus-transcript',
            visible: () => focusPanel !== undefined,
            target: () => entry.id,
            open: () => openTranscriptOf(entry.id)
        });
        focusActionDispose = actionBar.dispose;

        const transcript = el('div', 'thread-focus-messages');
        const invalidRecord = entry.invalid;
        const messages = Array.isArray(entry.messages) ? entry.messages : [];
        if (invalidRecord !== undefined) {
            // The stored value is not a transcript, so nothing here can be rendered as
            // messages. Name the failure and point at the control that fixes it; the
            // dialog (not the panel) is where the raw JSON is shown and edited.
            transcript.append(
                el(
                    'p',
                    'thread-focus-invalid-note',
                    `transcript unreadable: ${invalidRecord.error}. Use Transcript to edit the raw JSON.`
                )
            );
        } else if (messages.length === 0 && entry.hasTranscript === true) {
            // T5 R1: the COMPACT roster reports a transcript without sending it (the transcript is
            // the payload class the display wire removes, protocol.ts:396-427), so the panel names
            // what exists and where to read it instead of claiming the conversation is empty.
            transcript.append(
                el(
                    'p',
                    'thread-focus-lazy',
                    `${entry.messageCount ?? 'Some'} message${entry.messageCount === 1 ? '' : 's'} — use Transcript to read them.`
                )
            );
        } else if (messages.length === 0) {
            transcript.append(el('p', 'thread-focus-empty', 'No messages recorded in this thread yet.'));
        }
        for (const message of messages) {
            const source = message as { role?: unknown; content?: unknown };
            const content = typeof source.content === 'string' ? source.content : '';
            if (content.length === 0) continue;

            const row = el('div', 'thread-focus-message');
            row.dataset.role = typeof source.role === 'string' ? source.role : 'message';
            row.append(el('span', 'thread-focus-role', row.dataset.role));
            const body = el('div', 'thread-focus-text markdown');
            body.append(markdownFragment(content));
            row.append(body);
            transcript.append(row);
        }

        panel.append(head, actionBar.element, transcript);
        // First child of the board: the focused conversation reads at the top of the
        // transcript while the compact turn rows below stay navigable.
        element.prepend(panel);
        focusPanel = panel;
        actionBar.sync();
        // A steer audit recorded by an active run must be reachable here when its
        // target has no visible invocation of its own.
        renderCrossSteers();
    };

    // T12d F1: route a steer whose target child conversation lives in ANOTHER turn
    // (or only in the roster) to the surface that actually represents it. The tile
    // that recorded the audit usually owns the parent turn, so its local renderer
    // correctly refuses a child id it cannot see; this board pass finds the earlier
    // invocation or the focused roster panel. Sorted by acceptance time and
    // idempotent by `data-steer-key`, so later snapshots cannot duplicate guidance.
    const renderSteerInPanel = (steer: SessionSteerRecord, key: string): boolean => {
        if (focusPanel === undefined || steer.threadId === undefined) return false;
        if (focusPanel.dataset.threadId !== steer.threadId) return false;

        const transcript = focusPanel.querySelector<HTMLElement>('.thread-focus-messages');
        if (transcript === null) return false;
        if (flowHasSteer(transcript, key)) return true;

        // The roster transcript may already COMMIT the guidance as a user message
        // (the runtime appends it at the model boundary). Never show it twice.
        const already = [...transcript.querySelectorAll<HTMLElement>('.thread-focus-message')].some(
            (row) =>
                row.dataset.role === 'user' &&
                (row.querySelector('.thread-focus-text')?.textContent ?? '').trim() === steer.prompt.trim()
        );
        if (already) return true;

        transcript.querySelector('.thread-focus-empty')?.remove();
        transcript.append(createSteerNode(steer, key));
        return true;
    };

    const renderCrossSteers = (): void => {
        const audits: Array<{ source: TurnHandle; sourceId: string; steer: SessionSteerRecord; key: string }> = [];

        for (const turn of turns) {
            const sourceId = turn.id();
            if (sourceId === undefined) continue;

            turn.steerAudit().forEach((steer, index) => {
                audits.push({ source: turn, sourceId, steer, key: steerKeyOf(sourceId, index) });
            });
        }

        audits.sort((left, right) => left.steer.at - right.steer.at);

        for (const audit of audits) {
            // The source tile gets the first chance (root/self and same-tile child),
            // then every other visible turn can claim the target invocation.
            if (audit.source.tryRenderSteer(audit.steer, audit.sourceId, audit.key)) continue;

            let rendered = false;
            for (const candidate of turns) {
                if (candidate === audit.source) continue;
                if (!candidate.tryRenderSteer(audit.steer, audit.sourceId, audit.key)) continue;

                rendered = true;
                break;
            }
            if (rendered) continue;

            renderSteerInPanel(audit.steer, audit.key);
        }
    };

    const threadKnown = (threadId: string): boolean =>
        roster.some((entry) => entry.id === threadId) ||
        turns.some((turn) => turn.threadId() === threadId || turn.knowsThread(threadId));

    // Clear a persistent/roster focus without treating it as a user "unfocus" of a
    // follow-up submit: used when the focused conversation was deleted.
    const dropFocusState = (): void => {
        detachTileExpansion();
        // Exactly one conversation is open at a time.
        for (const host of conversationHosts.values()) host.classList.remove('is-expanded');
        for (const turn of turns) {
            turn.clearThreadFocus();
            turn.element.classList.remove('is-expanded');
        }
        hideFocusPanel();
        focusedThreadId = undefined;
    };
    // Live cards across every tile, with the session they were rendered under. Used
    // by `bindSession` to expire a question the reader has navigated away from
    // instead of letting a stale answer reach the next conversation. `undefined`
    // means the card predates a binding (it is adopted by the first bind).
    const answerCards = new Map<string, { card: ActionRequestCard; session: string | undefined }>();

    const rememberAnswerCard = (card: ActionRequestCard): void => {
        answerCards.set(card.requestId, { card, session: boundSession });
    };
    const forgetAnswerCard = (requestId: string): void => {
        answerCards.delete(requestId);
    };

    // The empty state lives inside the grid so it inherits the same width and
    // padding; it is removed when the first turn starts and restored on clear.
    const empty = options.empty;
    if (empty !== undefined) element.append(empty);

    const expand = (turn: TurnHandle): void => {
        // Open exactly ONE persistent conversation: a tile and a roster-only panel
        // never coexist, and focusing a tile ends any child-conversation focus.
        hideFocusPanel();
        for (const candidate of turns) {
            if (candidate !== turn) candidate.clearThreadFocus();
        }

        if (expandedTurn !== turn) {
            detachTileExpansion();
            expandedTurn = turn;
        }
        turn.element.classList.add('is-expanded');
        turn.element.querySelector<HTMLButtonElement>('.tile-select')?.setAttribute('aria-expanded', 'true');
        // R4: the newly expanded tile is the one surface that offers its complete
        // thread transcript. The previous expansion hid its action in
        // `detachTileExpansion`.
        turn.syncTranscriptAction();
        // R3: a continuation routed into a nested child card lives inside that card's
        // body, so the card has to be open for the expanded exchange to be visible.
        openEnclosingCards(turn);
        // T12b: expansion is a CONVERSATION state. Mark the group so every exchange
        // (owner runs and nested child continuations) is visible; all others close.
        const threadId = turn.threadId();
        const ownHost = hostOfTurn(turn);
        for (const host of conversationHosts.values()) {
            host.classList.toggle('is-expanded', host === ownHost);
        }
        // The tile's PERSISTENT thread is the steering target (or undefined for a
        // legacy turn / an unbound new-thread tile, which becomes known on merge).
        focusedThreadId = threadId;
        explicitUnfocus = false;
        notifyFocus();
    };

    const collapse = (): void => {
        dropFocusState();
        // Unfocused = the next submit opens a NEW standalone thread. The flag also
        // stops a later background adoption from claiming the empty slot.
        explicitUnfocus = true;
        notifyFocus();
    };

    // Focus one persistent thread (S2). Tile first (a continuation turn lives
    // there), then the nested invocation whose runtime identity matches, then a
    // roster-only transcript. Returns false only for an id nobody knows.
    const focusThread = (threadId: string): boolean => {
        // 1. A turn of this conversation: the normal case, including a child thread
        //    that was continued (the continuation creates a host turn with its id).
        for (let position = turns.length - 1; position >= 0; position -= 1) {
            const candidate = turns[position];
            if (candidate.threadId() !== threadId) continue;

            expand(candidate);
            return true;
        }

        // 2. A delegated/forked child has no turn of its own: its work is recorded
        //    inside the parent's events. Focus it by the runtime identity the roster
        //    joins (`invocationId`/`originInvocationId`, or the historical
        //    `invocationIds` list). The board is only touched once a match exists: an
        //    unknown id must be a NO-OP, never a collapse.
        for (const candidate of turns) {
            if (!candidate.knowsThread(threadId)) continue;

            hideFocusPanel();
            detachTileExpansion();
            for (const other of turns) other.clearThreadFocus();
            if (!candidate.focusChildThread(threadId)) continue;

            focusedThreadId = threadId;
            explicitUnfocus = false;
            notifyFocus();
            return true;
        }

        // 3. Roster-only conversation (no invocation has reported yet): render its
        //    recorded transcript so it can be read and steered.
        const entry = roster.find((candidate) => candidate.id === threadId);
        if (entry === undefined) return false;

        hideFocusPanel();
        detachTileExpansion();
        for (const candidate of turns) candidate.clearThreadFocus();
        showFocusPanel(entry);
        focusedThreadId = threadId;
        explicitUnfocus = false;
        notifyFocus();
        return true;
    };

    const begin = (
        prompt: string,
        attachments: readonly HarnessAttachment[] = [],
        threadId?: string
    ): TurnHandle => {
        const turn = create(prompt, attachments, threadId);
        // A submit is an explicit focus choice: the tile the user just created is
        // the conversation they are looking at, even if they had unfocused before.
        expand(turn);
        return turn;
    };

    // One tile, shared by the optimistic `begin` path and server adoption. R3: the
    // tile no longer paints a `#position` ordinal; the server's `index` still binds
    // (protocol/ordering) but is never displayed. The agent identity in the header
    // is the compact conversation-scoped label (`RH1`), not a raw agent id.
    const create = (
        prompt: string,
        initialAttachments: readonly HarnessAttachment[] = [],
        initialThreadId?: string,
        initialLabelSeed?: Record<string, number>
    ): TurnHandle => {
        empty?.remove();

        const id = `turn-${++nextId}`;
        const card = el('article', 'tile');
        card.dataset.state = 'queued';

        // Row wrapper (R1): a plain full-width block, no marker and no rule
        // decoration. It stays a wrapper (rather than appending the card directly)
        // so `clear()`/`reconcile()` can remove a row without ever touching
        // `.turns` itself, and it mirrors the tile state for CSS (styles.css).
        //
        // `threadHost` is appended AFTER the tile and is intentionally OUTSIDE
        // `.tile-body`: a collapsed parent (`display:none` on its body) must not
        // hide the invocation entries that live here (R1).
        const row = el('div', 'turn-row');
        row.dataset.state = 'queued';
        const threadHost = el('div', 'thread-children');
        row.append(card, threadHost);

        const select = el('button', 'tile-select');
        select.type = 'button';
        select.setAttribute('aria-expanded', 'false');
        select.setAttribute('aria-controls', `${id}-body`);

        const top = el('span', 'tile-top');
        // Compact block metadata (R1/R3): the elapsed clock, the token tally and, LAST, the
        // state box — ONE measurement line that reads `34.2s | 18,654 (37,376)`, with the
        // state carried by the line's COLOUR rather than by a visible `- done` suffix (T2).
        // ONE shared implementation (`createBlockMeta`) paints the main tile and every
        // nested entry, so both headers tick, hide and format identically. The
        // elapsed label stays hidden until a real span exists (never "NaN" or a
        // fabricated "0ms"); the tally stays hidden until a request reports usage.
        // The `|` is CSS decoration (styles.css), not part of any value, so every span stays
        // a clean, copy-pastable figure; it is dropped together with the label it follows.
        const blockMeta = createBlockMeta({ elapsed: 'tile-elapsed', tokens: 'tile-tokens' });
        // R3: the state word measures the BLOCK (what it did and how it ended), it is
        // not part of the conversation's identity, so it closes the measurement line
        // instead of sitting beside the thread badge. T26: the measurement line itself now
        // shares the header's FIRST line with the badge — flush right, in the slot the
        // Delete button used to own — and the meta line drops underneath it.
        // T2: the word is a SCREEN-READER label only — styles.css clips it in both header
        // states, so the line shows the two figures and its colour shows the state. The
        // text node stays in the DOM (never `display: none`) so the state is still
        // announced and still searchable, and `data-state` stays the styling hook.
        // No decorative dot: the status is TEXT (`tile-status-text`), clipped — not
        // removed — in every header state. The compact row is plain.
        const statusHost = el('span', 'tile-status');
        statusHost.dataset.state = 'queued';
        const statusText = el('span', 'tile-status-text', STATE_TEXT.queued);
        statusHost.append(statusText);

        const promptPreview = el('span', 'tile-prompt', plainPreview(prompt, 220));
        const meta = el('span', 'tile-meta', 'waiting for the first event');
        // R1/R2: the root block's compact header carries the SAME agent code a nested
        // block shows (`.tile-agent`, group-styled with `.thread-name`). It stays
        // hidden until an event names the root agent (`rootSection` fills it from the
        // conversation-scoped label allocator), so an optimistic tile never claims an
        // identity.
        const tileAgent = el('span', 'tile-agent');
        tileAgent.hidden = true;
        // Persistent thread badge (R5/R6). Repeated turns of ONE runtime thread show
        // the same badge, so the transcript never presents them as independent
        // threads; the badge and the thread strip name the same conversation. Hidden
        // for a legacy turn (no `threadId`) and for an optimistic new thread until
        // the server assigns the id. The full id stays in `data-thread-id`/`title`.
        const threadBadge = el('span', 'tile-thread');
        threadBadge.hidden = true;
        // R3: no `#ordinal` span — the turn's protocol `index` is bound for
        // ordering/identity but never displayed. The line reads, in order, the elapsed
        // clock and the token tally (`34.2s | 18,654 (37,376)`), the state box being a
        // clipped screen-reader label at the end of it; a label that has nothing honest to
        // report stays hidden and its separator goes with it.
        top.append(blockMeta.elapsed, blockMeta.tokens, statusHost);
        // T1/R3: the IDENTITY LINE is the persistent-thread badge (`IT1`) plus the
        // measurement cluster. The state word left this line (R3): "which conversation"
        // is identity, "in what state" is a measurement of this block, and the colour of
        // the figures carries that state. T26: identity reads at the LEFT and the
        // measurement line at the RIGHT of the same header line — the figures took the
        // slot the Delete button used to hold, which is exactly where a reader looks for
        // "how much did this cost".
        // ONE wrapper span is still what keeps the badge on a single line in BOTH header
        // layouts: the compact row is a flex ROW (the wrapper is one order-0 item at the
        // head, the cluster is the order-2 item at the tail) and the expanded header is a
        // flex ROW-WRAP whose first line is identity + cluster and whose second line is
        // the meta. `styles.css` owns the placement; the DOM order alone already reads
        // identity → measurements → details.
        const identity = el('span', 'tile-identity');
        identity.append(threadBadge);
        // R1: the thread IDENTITY leads the header, exactly like a nested entry's
        // `.thread-name` leads `.thread-select`. It is hidden whenever the turn has no
        // persistent thread, and `.tile-agent` disappears when it would repeat the same
        // label. `styles.css` pins `order: 0` on the badge/agent so the CSS-ordered
        // compact row and the expanded column agree.
        select.append(identity, tileAgent, top, promptPreview, meta);

        const body = el('div', 'tile-body');
        body.id = `${id}-body`;

        // The prompt itself is rendered as Markdown too: users paste code fences
        // and lists into the composer, and the tile should read like the answer.
        // R10: recorded attachments are INLINE chips in this same flow. The marker
        // the user typed ("[Image 1]") is replaced in place after sanitizing; an
        // attachment whose marker is absent is appended at the end of the prompt.
        // There is deliberately NO second `.turn-attachments` row: one file must
        // never appear twice in the transcript.
        const promptBlock = el('div', 'turn-prompt markdown');

        // Attachments recorded for this tile (optimistic draft first, then the
        // server record). Kept as the source of truth for re-rendering, because
        // `merge` may call `setAttachments` more than once (e.g. ack + snapshot).
        let attachmentRecords: HarnessAttachment[] = [];

        // Open a file link in the R11 preview dialog. Only a user activation calls
        // this, so no path is fetched automatically; `options.readFile` supplies
        // the bounded request (main.ts -> callTool('read', ...)) and
        // `options.resolveFile` the basename lookup (main.ts -> callTool('glob', ...))
        // for a reference that names a file without its directory.
        const openTranscriptFile = (path: string): void => {
            openFilePreview(path, {
                ...(options.readFile === undefined ? {} : { read: options.readFile }),
                ...(options.resolveFile === undefined ? {} : { resolve: options.resolveFile })
            });
        };

        // A recorded attachment opens the shared preview modal. The dialog captures
        // the focused chip before opening and restores it on close; it never falls
        // back to the composer.
        const openAttachment = (attachment: HarnessAttachment): void => {
            openAttachmentDialog(attachment);
        };

        // A Markdown image opens the same modal (fitted full preview). The dialog
        // re-checks the source; the sanitizer already removed scriptable URLs.
        const openTranscriptImage = (source: string, alt: string): void => {
            openImageDialog(source, { alt });
        };

        // Rebuild the prompt's DOM from its sanitized Markdown and then apply the
        // post-sanitization transforms (file links, clickable images, attachment
        // chips). Called on creation and on every `setAttachments`, so optimistic
        // and replayed turns always show the same chips at the same marker positions.
        const renderPrompt = (): void => {
            promptBlock.replaceChildren(markdownFragment(prompt));
            enhanceFileLinks(promptBlock, { open: openTranscriptFile });
            enhanceImages(promptBlock, { open: openTranscriptImage });
            applyAttachmentChips(promptBlock, attachmentRecords, { onOpen: openAttachment });
        };

        const setAttachments = (attachments: readonly HarnessAttachment[]): void => {
            attachmentRecords = [...attachments];
            renderPrompt();
        };

        setAttachments(initialAttachments);

        const flow = el('div', 'tile-flow');

        // T11 (R7): this turn's ONE context bar, between the prompt and the flow. It is
        // per TURN, not per section or per call: it aggregates every section's
        // `TurnSection.context` in the document's section order, which is exactly what the
        // wall of tool chips used to spell out one card at a time. Empty and hidden until a
        // compiled frame actually carries context metadata, so a legacy turn costs nothing.
        const contextBarHost = el('div', 'context-bar-host');
        contextBarHost.hidden = true;

        body.append(promptBlock, contextBarHost, flow);

        // R7/R8/T26: the expanded tile's toolbar. Delete leads (left), Transcript closes
        // it (right), and those are its ONLY children: T6/R5 moved the Delete confirmation
        // out of the bar and into the shared dialog (`openThreadDeleteConfirmation`), where
        // a stray tap cannot confirm it. Both actions live between the header and body so
        // they are visible without scrolling and disappear with expansion. The header's
        // right edge is no longer a control slot — it now carries the measurement line
        // (styles.css).
        const actionBar = createThreadActionBar({
            className: 'tile-transcript-action',
            visible: () => expandedTurn?.element === card && card.classList.contains('is-expanded'),
            target: () => runtimeThreadId,
            open: () => openTranscriptOf(runtimeThreadId)
        });
        const transcriptAction = actionBar.element;

        card.append(select, transcriptAction, body);

        // --- per-turn state ------------------------------------------------
        let state: TurnState = 'queued';
        let detail: string | undefined;
        let primaryAgent: string | undefined;
        let toolCount = 0;
        // Server identity for this tile. Absent until `bind()` or a snapshot.
        let serverId: string | undefined;
        // Persistent runtime thread this tile belongs to. An optimistic tile gets it
        // from the submit target (continue/steer); a new thread gets it from the
        // first record that carries `threadId`. A record WITHOUT the field never
        // clears a known id (legacy fallback): the tile keeps the identity the
        // submit already told the server about.
        let runtimeThreadId = turnThreadIdOf({ threadId: initialThreadId });
        // R8: the conversation's display label, recorded ON THE TURN. It is the
        // authoritative root-block name (`RR2`) even when the roster omits the
        // default conversation; a legacy record has none and falls back to the
        // roster join.
        let runtimeThreadLabel: string | undefined;
        // S6: ONE canonical display identity, shared with the strip. The server's
        // agent-prefixed conversation label wins; an id the roster does not describe
        // (yet) reads `T?` rather than a digit invented from the opaque id. The full
        // id and the agent stay in `title`/`data-thread-id`.
        // T12d F2: a conversation-owned root already carries its canonical label in
        // the persistent-thread badge (`RR4`, with title/agent/status). The root code
        // (`tile-agent`) must not print the SAME label beside it (`RR4RR4`). Keep the
        // badge as the single visible identity; the code node stays in the DOM only
        // for legacy/unthreaded turns or a thread without a resolved badge name.
        const syncRootAgentVisibility = (): void => {
            const duplicate =
                runtimeThreadId !== undefined &&
                threadBadge.textContent !== null &&
                threadBadge.textContent.length > 0 &&
                threadBadge.textContent === tileAgent.textContent;

            tileAgent.hidden = duplicate || tileAgent.textContent === '';
        };

        // R7/R8: repaint the shared toolbar. Visibility is board expansion state,
        // so `expand`/`detachTileExpansion` and every roster/snapshot update call it.
        const syncTranscriptAction = actionBar.sync;

        const paintThreadBadge = (): void => {
            if (runtimeThreadId === undefined) {
                threadBadge.hidden = true;
                threadBadge.textContent = '';
                threadBadge.title = '';
                delete card.dataset.threadId;
                syncRootAgentVisibility();
                syncTranscriptAction();
                return;
            }

            threadBadge.hidden = false;
            threadBadge.textContent =
                runtimeThreadLabel ?? threadLabelOf(runtimeThreadId, roster) ?? '';
            threadBadge.title = threadTitleOf(runtimeThreadId, roster) ?? '';
            card.dataset.threadId = runtimeThreadId;
            syncRootAgentVisibility();
            syncTranscriptAction();
        };
        // Set once the handle exists so a thread identity learned during `merge`
        // can move this tile into its conversation container (T12b). Before then
        // the optimistic tile sits as a standalone/initial row.
        let placedTurn: TurnHandle | undefined;
        // The conversation label this tile's ROOT block must show: the turn's own
        // recorded name first, then the roster's name for its persistent thread. An
        // id the roster does not describe yields UNDEFINED (not the `T?` sentinel):
        // a legacy turn then keeps its allocator label instead of printing `T?`.
        const rootConversationLabel = (): string | undefined => {
            if (runtimeThreadLabel !== undefined) return runtimeThreadLabel;
            if (runtimeThreadId === undefined) return undefined;

            const entry = roster.find((candidate) => candidate.id === runtimeThreadId);
            return entry === undefined ? undefined : threadNameOf(entry);
        };

        const setThreadId = (value: string | undefined, label?: string): void => {
            if (label !== undefined && label.trim().length > 0) runtimeThreadLabel = label;

            if (value !== undefined && value.length > 0) {
                const changed = runtimeThreadId !== value;
                runtimeThreadId = value;
                // A tile adopted from a record learns its thread AFTER `create` has
                // already expanded it, so the focus report has to happen here too —
                // otherwise the strip/composer would still say "no focus" for a
                // conversation the reader is looking at. Only a CHANGE is reported:
                // every snapshot re-merges the expanded tile and the strip must not
                // repaint on an unchanged identity.
                if (changed && expandedTurn?.element === card) {
                    focusedThreadId = value;
                    notifyFocus();
                }
            }

            paintThreadBadge();
            // A first record can tell an optimistic NEW thread its id; move the row
            // into that conversation now instead of leaving a second top-level row.
            if (placedTurn !== undefined) placeTurn(placedTurn);
        };
        setThreadId(undefined);
        // The last authoritative record merged into this tile. The JSON transcript
        // fallback uses it when the shell did not provide a full session snapshot.
        let sourceTurn: SessionTurn | undefined;
        // How many of the server turn's `events` this tile has applied. Live
        // frames and replayed records both count, so `merge()` can skip the
        // prefix it already rendered instead of appending it twice.
        let appliedCount = 0;
        // R9: how many of the turn's recorded STEERS are already rendered as visible
        // user messages. A steered submit creates no new turn, so without this the
        // user's text would only exist in the audit metadata and never in the
        // conversation the reader is looking at.
        // T12b: indexes (not a count) because a steer addressed to a child
        // conversation may be unrenderable until that child's invocation entry
        // exists; it must not block a later steer or be duplicated on a retry.
        let renderedSteers = new Set<number>();
        // The latest recorded steer audit, kept so `refreshThreadRoster` can retry
        // attribution once the child invocation appears.
        let steerRecords: NonNullable<SessionTurn['steers']> = [];
        // The events themselves, in order. `merge()` compares the server's prefix
        // against these: identical means "append the remainder"; different means
        // the server record won and the projection must be rebuilt.
        const appliedEvents: HarnessEvent[] = [];
        // Monotonic guard for server records (R2). Every authoritative record
        // carries `updatedAt` (src/server/sessions.ts stamps it on enqueue, on start,
        // on every event and on the terminal transition), so a record OLDER than
        // the last one this tile applied can only be a stale snapshot — chiefly
        // the 202 body from POST /tasks, which is captured at enqueue time but can
        // resolve after newer observer frames. Ignoring it is what stops a running
        // row regressing to `queued` (no green / two greens) and a settled row
        // re-opening.
        let recordAt: number | undefined;
        let recordStatus: SessionTurnStatus | undefined;

        // --- timing --------------------------------------------------------
        // A queued tile has NO clock (R4): the task may wait behind another run for
        // minutes, and counting that wait would be a lie. `bind()` supplies the
        // server's start and `setTiming` the recorded baseline; the clock state
        // itself lives in `blockMeta`, because a nested entry header needs the
        // identical behaviour (R1) and only one implementation should own it.
        const paintElapsed = (): void => blockMeta.paint();
        const stopElapsed = (): void => blockMeta.stop();

        const setTiming = (timing: { startedAt?: number; endedAt?: number }): void => {
            // Recorded stamps are authoritative and REPLAY-derived: a later
            // `apply`/`setState` must not overwrite them with the local clock.
            blockMeta.settle(timing);
        };

        // --- token tally ----------------------------------------------------
        // TWO scopes, deliberately different (user-selected semantics, R1/R2):
        //   - primary: the LATEST model request's input/context size. The provider
        //     `input` (prompt_tokens) includes that request's cached subset, so
        //     this is "latest prompt sent", not a sum. Derived from the LAST
        //     `usage` event applied (emission order — so a delegated subagent's
        //     request counts as latest if it reported last, deterministically).
        //   - bracket: total cached (replayed) input sent across the whole turn.
        //     Taken from the SERVER's cumulative tally (`SessionTurn.usage.cached`,
        //     src/server/sessions.ts addUsage), with a per-event sum as the fallback
        //     for a legacy record that carries events but no tally.
        // The cumulative tally's `input` is NOT used as the primary when events
        // exist: it is the sum of every re-sent transcript. It is only the
        // conservative fallback for a record whose events were trimmed/absent
        // (the latest request is then unknowable and the cumulative input is an
        // upper bound that never understates the context). See ui/tokens.ts.
        // The figures themselves live in `blockMeta`, which also paints a nested
        // entry's tally from that entry's own `usage` events (R1). The server tally is a
        // context figure too, so the think chips of this tile re-measure against it here
        // exactly as they do on a live `usage` event.
        const setUsage = (usage?: HarnessUsage): void => {
            blockMeta.setTally(usage);
            syncThinkingShares();
        };

        // Compact agent labels (`RH1`, `RH2`, …): ONE allocator per tile, consumed
        // once per invocation (root included). The raw agent id never reaches the
        // header text (R2/R3).
        //
        // R5/R6: numbering CONTINUES the conversation. `labelSeed` is captured
        // LAZILY on the tile's FIRST allocation, not at construction: a queued tile
        // can be created while an earlier turn is still running and may allocate a
        // later label (writer WR1 -> research RH1, then the still-running turn adds
        // research RH2). Seeding at construction would miss that and mint a
        // duplicate RH2; capturing the board counters at first allocation keeps the
        // tile strictly after every label already shown. FIFO execution (one turn at
        // a time, src/server/sessions.ts queue pump) is what makes this sound: a
        // later turn cannot allocate before the earlier turn has finished allocating.
        // The captured seed is kept for the whole tile so a rebuilt projection
        // (`resetProjection`) re-seeds the SAME base and never renumbers this tile's
        // threads. `nextLabel` publishes each allocation so tiles allocating
        // afterwards continue the sequence.
        const labels = createAgentLabels();
        let labelSeed: Map<string, number> | undefined;
        // A REPLAYED turn may arrive with the counters the server recorded at its
        // start (snapshot `labelSeeds`). That recorded base is authoritative: seeding
        // from the surviving board counters instead would renumber this turn after an
        // earlier, deleted turn's allocations disappeared.
        if (initialLabelSeed !== undefined) {
            labelSeed = new Map(Object.entries(initialLabelSeed));
            labels.seed(labelSeed);
        }
        const nextLabel = (agent: string | undefined): string => {
            // First allocation of THIS tile: freeze the base it continues from.
            if (labelSeed === undefined) {
                labelSeed = new Map(labelCounters);
                labels.seed(labelSeed);
            }

            const label = labels.next(agent);

            for (const [code, used] of labels.counters()) {
                if (used > (labelCounters.get(code) ?? 0)) labelCounters.set(code, used);
            }

            return label;
        };

        // T14 parity with shared/agent-results.ts `createBlock`: an EXPLICIT
        // conversation label (`turn.threadLabel` or a child `threadLabels[id]`) is
        // shown verbatim but still RESERVES its ordinal in this tile's allocator.
        // Without it, root RR1 + a same-code fallback child would both read RR1;
        // with it the fallback continues at RR2 exactly like the server projection.
        // `seed` only raises, so a continuation repeating RR1 burns nothing.
        const reserveConversationLabel = (label: string | undefined): void => {
            if (label === undefined) return;

            const parts = agentLabelParts(label);
            if (parts === undefined) return;

            labels.seed(new Map([[parts.code, parts.ordinal]]));

            // Publish the reservation so LATER tiles (and a rebuilt projection)
            // continue after it instead of re-minting the same number.
            for (const [code, used] of labels.counters()) {
                if (used > (labelCounters.get(code) ?? 0)) labelCounters.set(code, used);
            }
        };

        // One entry per INVOCATION in this turn. The map is keyed by the canonical
        // invocation key (runtime `thread.id`, synthesized placeholder key, or
        // `inline:<agent>` for a legacy stream the UI cannot attribute). Keys never
        // merge two known invocations: adoption REKEYS a placeholder, it does not
        // append a duplicate.
        const threads = new Map<string, ThreadEntry>();
        // Invocation keys the reader has expanded (R1, independent child expansion).
        // Kept OUTSIDE the entries so a rebuilt projection (`resetProjection` on a
        // superseding record) reopens the SAME invocations instead of collapsing
        // what the reader was reading.
        const expandedThreads = new Set<string>();
        // Calls whose result has not arrived yet.
        const pendingTools: PendingTool[] = [];
        // Call ids already settled on this tile — a result applied, or a card
        // abandoned at the terminal transition. A repeated frame for one of these
        // is a DUPLICATE (retried event, replay overlap) and is ignored: it must not
        // add a second card or overwrite the first answer. Cleared with the
        // projection.
        const settledCalls = new Set<string>();
        // N3 action cards rendered by THIS tile, keyed by requestId. A rebuilt
        // projection destroys them so a replayed action_request cannot leave a
        // stale, clickable card behind.
        const actionCards = new Map<string, ActionRequestCard>();
        // Authoritative answers seen on this tile, keyed by requestId. A recorded
        // replay normally orders request before answer, but a duplicate/out-of-order
        // frame must not leave a question looking pending: a late request consumes
        // the stored answer instead of rendering actionable controls.
        const actionAnswers = new Map<string, HarnessActionAnswer>();

        const updateMeta = (): void => {
            const live = isLive(state);
            const parts: string[] = [];

            // One count per invocation (R3): repeated same-agent delegations are
            // separate entries, so the count answers "how many agents ran?" truthfully.
            if (threads.size > 0) parts.push(`${threads.size} agent${threads.size === 1 ? '' : 's'}`);
            if (toolCount > 0) parts.push(`${toolCount} tool call${toolCount === 1 ? '' : 's'}`);
            // A completed response may still wait on background calls. The count is
            // summed across entries because a delegated child can be pending on its
            // own. NOTE: on a compact row the meta line is visually clipped (sr-only,
            // styles.css `.tile:not(.is-expanded) .tile-meta`); it is read out and
            // shown in full only when the tile is expanded.
            const pendingTotal = [...threads.values()].reduce(
                (total, entry) => total + entry.section.pendingCalls.size,
                0
            );
            if (pendingTotal > 0) {
                parts.push(`${pendingTotal} tool${pendingTotal === 1 ? '' : 's'} still running`);
            }
            if (detail !== undefined && detail.length > 0) parts.push(detail);
            if (parts.length === 0) parts.push(live ? 'waiting for the first event' : 'no events yet');

            meta.textContent = parts.join(' · ');
        };

        const setState = (next: TurnState, nextDetail?: string): void => {
            state = next;
            detail = nextDetail;

            // Terminal states freeze the elapsed label. Hydration may already have
            // supplied the server's `updatedAt`; in that case keep it instead of
            // overwriting it with the replay's local clock. A task that never
            // started (cancelled while queued) had no span, so leave the label
            // hidden rather than printing a fabricated 0ms.
            if (next === 'done' || next === 'error' || next === 'cancelled') {
                // `finish` freezes the span: a non-recorded run ends at the local
                // clock, a recorded one keeps the server's `updatedAt` (or the last
                // span it painted when the record carried no end stamp).
                blockMeta.finish(undefined, blockMeta.recorded());
                // The turn is over, so nothing can still be pending: drop the
                // waiting line first (R6). A call left unsettled is INTERRUPTED —
                // cancel/restart never resumes it — so it is abandoned with a reason
                // instead of being frozen as a live-looking `running` card.
                for (const entry of threads.values()) {
                    paintPending(entry.section, []);
                    for (const tool of entry.section.tools) {
                        if (tool.state() !== 'running') continue;

                        tool.abandon(
                            next === 'cancelled'
                                ? 'Cancelled before the call returned.'
                                : next === 'error'
                                  ? 'Interrupted when the turn failed.'
                                  : 'Interrupted when the turn ended without a result.'
                        );

                        // Remember the id so a late/duplicate result is ignored
                        // instead of producing a second, resolved card.
                        if (tool.callId !== undefined) settledCalls.add(tool.callId);
                    }
                }

                // A root terminal status also closes every unfinished DESCENDANT
                // (R3/R4 cleanup): the server will not send another event for them,
                // and a child left `streaming` would claim work is still running.
                // The reason mirrors the card-abandon wording so the row's outcome
                // and its tools tell the same story.
                const reason =
                    next === 'cancelled'
                        ? 'outcome · cancelled before the child returned.'
                        : next === 'error'
                          ? 'outcome · interrupted when the turn failed.'
                          : 'outcome · interrupted when the turn ended without a result.';
                for (const entry of threads.values()) {
                    // Root state is owned by the tile (`state`) — it already carries
                    // this terminal transition. Every other entry, INCLUDING a
                    // row-less legacy `inline:<agent>` block, must settle too or
                    // blocks() would keep advertising it as running (T11).
                    if (entry.key === ROOT_KEY || isTerminalThread(entry.state)) continue;
                    completeThread(entry, next, reason);
                    // The server will send no further event for this child, so freeze
                    // its block clock at the local observation (R1). A recorded child
                    // keeps its last painted span.
                    if (entry.meta !== undefined) entry.meta.finish(undefined, entry.meta.recorded());
                }

                // N3: an unresolved question cannot outlive its turn. Done/error/
                // cancelled all mean the server will not accept an answer any more,
                // so every still-pending card becomes visibly expired. A card that
                // already has an authoritative answer is never downgraded. This is
                // the replay guard too: a settled historical turn ends up here.
                //
                // A `done` with non-empty `pending` (a scheduler pause) never
                // reaches this branch: the tile state stays `streaming`, so the
                // question remains answerable while the run is paused on work.
                const expiry =
                    next === 'cancelled'
                        ? 'This question expired when the turn was cancelled.'
                        : next === 'error'
                          ? 'This question expired when the turn failed.'
                          : 'This question expired when the turn ended.';
                for (const card of actionCards.values()) {
                    const cardState = card.state();
                    if (cardState === 'answered' || cardState === 'expired') continue;
                    card.setExpired(expiry);
                }

                // R5: a turn that ended NORMALLY completes whatever answer each block
                // streamed, even a recording that never sent a `done`/`attempt_commit`
                // frame for the last response — otherwise the footer Copy action would
                // never appear for an answer the reader can see in full.
                //
                // `error` and `cancelled` deliberately skip this: an interrupted run's
                // trailing prose is PARTIAL, and offering it as "the final answer" is
                // exactly the mislabel R5 forbids. Those blocks keep whatever answer
                // an earlier completed response promoted (or none at all).
                if (next === 'done') {
                    for (const entry of threads.values()) {
                        // Only a prose block that is STILL LIVE needs this fallback: a
                        // block the stream already closed was promoted by its own
                        // `done`/`attempt_commit`. Reading `lastText` here instead
                        // would re-promote a `done` message's content over the prose
                        // the reader actually saw, and would happily promote prose an
                        // `error` interrupted.
                        promoteAnswer(entry.section, entry.section.text?.buffer);
                    }
                }
            } else {
                // A non-terminal transition: clear a local end and tick while the task
                // actually runs (R4 — `queued` deliberately does not start a clock).
                // A recorded baseline keeps its stamps: hydration/replay owns them.
                blockMeta.reopen(isLive(next));
            }

            paintElapsed();
            card.dataset.state = next;
            // The row mirrors the state so the row and the tile never disagree
            // (styles.css keys the row's compact/active treatment off it).
            row.dataset.state = next;
            statusHost.dataset.state = next;
            statusText.textContent = STATE_TEXT[next];
            updateMeta();
        };

        // --- invocation entries -------------------------------------------
        //
        // The flat per-agent section from earlier revisions is now per INVOCATION:
        // the root invocation's section lives in `.tile-flow`; every delegated
        // invocation gets its own `.thread-row` entry. Legacy events with no
        // metadata (and no inferable delegate call) keep the old flat section so a
        // saved transcript stays readable instead of inventing ancestry.

        // Build one agent content section inside `container`. `role` is a
        // STRUCTURAL signal only (kept on `data-role` for CSS/tests/assistive
        // context): R3 removed the visible role badge, because a nested block is
        // the same surface as a main block and is told apart by indentation plus
        // its agent colour, not by the word "subagent".
        //
        // `label` is the compact conversation-scoped agent code (`RH1`) allocated
        // once by the caller for THIS invocation: the section header shows the code,
        // never the raw agent id (R2/R3). The id is still mirrored on `data-agent`
        // by `paintAgentColor` for colour/routing.
        //
        // R5/T7: `collapse` names the surface this block's footer chevron closes. It is
        // OPTIONAL: a flat legacy section has no collapsible surface, so it gets no
        // chevron. The button is appended HERE — at creation, before any answer can
        // complete — which is what lets the Copy button that arrives later be PREPENDED in
        // front of it (copy left, chevron right) in every order.
        const createSection = (
            container: HTMLElement,
            agentName: string,
            role: 'primary' | 'subagent',
            label: string,
            collapse?: SectionCollapse
        ): AgentSection => {
            const root = el('section', 'agent');
            root.dataset.role = role;
            // Paint the section: `.agent-name` reads `--agent-color`, so a flat/legacy
            // section inside the tile flow is coloured like every other agent-owned
            // surface. The helper also mirrors the name on `data-agent` (cleared for an
            // unnamed stream, so it never claims an identity).
            paintAgentColor(root, agentName);

            const head = el('header', 'agent-head');
            head.append(el('span', 'agent-name', label));

            const sectionFlow = el('div', 'agent-flow');
            // R5/T7: the footer row. A block WITH a collapsible surface owns its Collapse
            // chevron from the moment it exists (it sits last, after the Copy button); a
            // block without one (a flat legacy section) stays EMPTY until it completes an
            // answer, so it paints no orphan control (`display: none` on `:empty`,
            // styles.css). The chevron needs no state of its own: while this block is
            // closed the whole row is inside a `display: none` body, so it is unrendered,
            // untabbable and out of the accessibility tree.
            const sectionActions = el('div', 'agent-answer-actions');

            root.append(head, sectionFlow, sectionActions);
            container.append(root);

            const section: AgentSection = {
                root,
                flow: sectionFlow,
                actions: sectionActions,
                text: undefined,
                lastText: undefined,
                finalAnswer: undefined,
                answerAction: undefined,
                collapse: undefined,
                reasoning: undefined,
                thinking: [],
                tools: [],
                toolGroup: undefined,
                pending: undefined,
                pendingCalls: new Map(),
                attempt: undefined
            };

            // R5/T7: the chevron is created and appended HERE, before anything can stream,
            // so it is permanently the LAST control in the row: `paintAnswerAction`
            // PREPENDS the copy button, and a later answer can never slip in front of the
            // chevron or displace it. Its attributes are constants (see `SectionCollapse`),
            // so there is nothing to paint afterwards — a projection rebuild simply runs
            // this again.
            if (collapse !== undefined) {
                const button = createCollapseButton(collapse);
                sectionActions.append(button);
                section.collapse = button;
            }

            return section;
        };

        // Collapse/expand one entry. Independent of the board's single expanded
        // TURN: a reader can open a child while the parent tile is collapsed, and
        // opening one child never closes another. The class is mirrored onto the
        // nested tile as well, so the shared `:is(.tile, .thread-tile)` CSS can key
        // the expanded frame off one selector for both block owners (R3).
        // R7/R8: the nested child card shows its Transcript/Delete toolbar only
        // while expanded and joined to a persistent roster entry. A pure invocation
        // detail (no persistent thread) stays honest: no action.
        const syncThreadTranscriptAction = (entry: ThreadEntry): void => {
            entry.syncActionBar();
        };

        const setThreadExpanded = (entry: ThreadEntry, expanded: boolean, remember = true): void => {
            if (entry.row === undefined) return;

            entry.expanded = expanded;
            entry.row.classList.toggle('is-expanded', expanded);
            entry.tile?.classList.toggle('is-expanded', expanded);
            entry.select?.setAttribute('aria-expanded', String(expanded));
            syncThreadTranscriptAction(entry);
            // T7: nothing else to repaint. This is the ONLY transition of a nested card's
            // expansion (a header click, the footer chevron, and the board's implicit
            // open/close all route through here), and the card's own `is-expanded` class is
            // what shows or hides `.thread-body` — the row that holds the footer chevron.
            // Closing the card therefore removes that chevron from the layout, the tab
            // order and the accessibility tree by itself, which is why its label can be a
            // constant `Collapse thread`.

            // Remember the reader's choice by canonical key so a projection rebuild
            // can restore it (the entry objects are recreated, the keys are stable).
            // An IMPLICIT open (`openEnclosingCards`) passes remember=false: it is a
            // temporary reveal of the focused exchange, closed by `detachTileExpansion`
            // and never re-opened as if the reader had chosen it.
            if (!remember) return;

            if (expanded) expandedThreads.add(entry.key);
            else expandedThreads.delete(entry.key);

            // T22 (R22): a collapse the reader chose is a choice, not a transient. The row
            // is recorded so `openEnclosingCards` — the board's implicit reveal, which fires
            // whenever a tile inside this card is expanded — does not undo it on the next
            // frame, and an EXPANSION clears the marker again. The two sets are the whole
            // of "user controls expansion": hydration and streaming never write to either.
            if (expanded) userCollapsedRows.delete(entry.row);
            else userCollapsedRows.add(entry.row);
        };

        // --- persistent child conversations (S2) ---------------------------
        //
        // A delegated/forked child is an INVOCATION entry keyed by the runtime
        // `event.thread.id`. Its persistent conversation id is a different value,
        // joined through the roster (`invocationId`/`originInvocationId`). Only an
        // entry with that join is a real, steerable conversation; an entry without
        // one is ephemeral invocation detail and keeps the old independent expand.
        let focusedChildKey: string | undefined;

        // DURABLE invocation → persistent-thread association (R3).
        //
        // The authoritative join is the roster's `invocationIds` — the server's
        // persisted invocation→thread map, which names the ORIGINAL delegated run AND
        // every resume, so a fresh hydration can bind a historical card exactly. The
        // board-level `learnedThreads` cache covers a payload that predates that field:
        // an association established while the roster still named the invocation
        // (`invocationId`/`originInvocationId`) is REMEMBERED, so a later roster frame
        // that advanced those slots can only ADD joins, never silently subtract a true
        // one. Nothing here infers a join from task text: two identical sibling
        // delegations would be indistinguishable, and a wrong merge is worse than an
        // invocation-only card.
        //
        // Invalidation is explicit: a NON-EMPTY roster that no longer lists the thread
        // is evidence of deletion (`forgetRemovedThreads`), and a SESSION SWITCH drops
        // the whole cache (see `bindSession`) so one session's invocation ids can never
        // resolve to another's conversation. An empty/absent roster is not evidence of
        // anything and never erases a known identity.

        // The ONE roster conversation that claims `key`, or undefined. A card key is
        // either a persistent thread id (a ROOT entry) or an invocation id, and the
        // roster names an invocation through three exact sources: the latest run
        // (`invocationId`), the thread's first turn (`originInvocationId`) and the
        // HISTORICAL `invocationIds` list — only the last one still names the original
        // delegated run after the child was resumed.
        //
        // UNIQUENESS IS REQUIRED. A correct server maps an invocation id to exactly one
        // conversation; a payload that names it twice is ambiguous, and merging the
        // card into either one could mix two agent threads (two identical sibling
        // delegations are the realistic case). Then: no claim.
        const rosterClaimOf = (key: string): SessionThreadEntry | undefined => {
            const direct = roster.find((candidate) => candidate.id === key);
            if (direct !== undefined) return direct;

            const claims = roster.filter(
                (candidate) =>
                    candidate.invocationId === key ||
                    candidate.originInvocationId === key ||
                    candidate.invocationIds?.includes(key) === true
            );

            return claims.length === 1 ? claims[0] : undefined;
        };

        const persistentIdOf = (entry: ThreadEntry): string | undefined => {
            // A card's join key is its RUNTIME invocation identity when the board knows one
            // (`explicitId`: the raw path's `thread.id`, the compiled path's `section.invocationId`
            // / `section.threadId`), and its board key otherwise. The roster publishes exactly
            // those ids (`invocationId` / `originInvocationId` / the historical `invocationIds`),
            // so this is the documented join — not an inference from task text. The compiled
            // section id (`${turnId}:${ordinal}`) is deliberately NOT a roster key, so keying the
            // claim on it alone would never resolve a child card created before the roster landed.
            const claim = rosterClaimOf(entry.explicitId ?? entry.key);
            if (claim !== undefined) {
                // Remember the join while the roster still names it: this card's key
                // never changes, the roster's invocation fields do.
                learnedThreads.set(entry.key, claim.id);
                return claim.id;
            }

            // Ambiguous, or not named at all: keep only what was learned while the
            // roster was unambiguous. Never guess (in particular, never from task text).
            return learnedThreads.get(entry.key);
        };

        // Drop associations whose THREAD the roster no longer lists. A non-empty
        // roster enumerates every host conversation, so an absent id means the
        // conversation was deleted (and its turns with it); an empty roster is a
        // payload without the list, not a deletion signal.
        const forgetRemovedThreads = (): void => {
            if (roster.length === 0) return;

            for (const [key, persistent] of [...learnedThreads]) {
                if (!roster.some((candidate) => candidate.id === persistent)) learnedThreads.delete(key);
            }
        };

        // R8: repaint one entry's visible label. The conversation label replaces
        // the provisional per-invocation number the allocator minted when the entry
        // was created before its roster identity was known.
        const paintEntryLabel = (entry: ThreadEntry, label: string): void => {
            // A roster-provided child conversation label is authoritative too: it
            // reserves its ordinal exactly like a create-time explicit label, so a
            // later same-code fallback cannot collide with `RR5`.
            reserveConversationLabel(label);
            if (entry.label === label) return;

            entry.label = label;
            if (entry.select !== undefined) {
                const name = entry.select.querySelector('.thread-name');
                if (name !== null) name.textContent = label;
            }
            // The section head (a flat legacy subagent) carries the same code.
            const head = entry.section.root.querySelector('.agent-name');
            if (head !== null) head.textContent = label;
        };

        // R8: the ROOT block shows the tile's PERSISTENT conversation label, not a
        // separately allocated invocation number. There is no row to repaint; the
        // code lives in the tile header (`tileAgent`) and the section head.
        const paintRootLabel = (): void => {
            const entry = threads.get(ROOT_KEY);
            if (entry === undefined) return;

            const label = rootConversationLabel();
            if (label === undefined) return;

            paintEntryLabel(entry, label);
            tileAgent.textContent = label;
            tileAgent.hidden = false;
            syncRootAgentVisibility();
        };

        const paintPersistentMarkers = (): void => {
            for (const entry of threads.values()) {
                // The ROOT invocation has no row (its surface is the tile body), so
                // it has nothing to mark; its label is painted separately.
                if (entry.row === undefined) continue;

                const persistent = persistentIdOf(entry);
                if (persistent === undefined) {
                    delete entry.row.dataset.persistentThread;
                    entry.row.classList.remove('is-persistent-focused');
                    syncThreadTranscriptAction(entry);
                    continue;
                }

                entry.row.dataset.persistentThread = persistent;
                const match = roster.find((candidate) => candidate.id === persistent);
                entry.row.title = match === undefined ? `Thread ${persistent}` : `${threadNameOf(match)} · ${match.agent}`;
                // S6/R8: the row's own header names the child CONVERSATION.
                if (match !== undefined) paintEntryLabel(entry, threadNameOf(match));
                syncThreadTranscriptAction(entry);
            }

            paintRootLabel();
        };

        // Collapse persistent child conversations and clear the focused marker. A
        // focused child that the roster no longer describes (deleted thread) is
        // collapsed too, so a deletion can never leave a stale open conversation.
        const clearThreadFocus = (): void => {
            if (focusedChildKey !== undefined) {
                const entry = threads.get(focusedChildKey);
                if (entry !== undefined) setThreadExpanded(entry, false);
            }
            focusedChildKey = undefined;
            for (const entry of threads.values()) entry.row?.classList.remove('is-persistent-focused');
        };

        const knowsThread = (threadId: string): boolean => {
            for (const entry of threads.values()) {
                if (persistentIdOf(entry) === threadId) return true;
            }
            return false;
        };

        // Focus the child conversation. The tile body is collapsed so only ONE
        // persistent conversation (this child) is open; other PERSISTENT child
        // entries are collapsed, while pure invocation details are left alone.
        const focusChildThread = (threadId: string): boolean => {
            for (const entry of threads.values()) {
                if (entry.row === undefined) continue;
                if (persistentIdOf(entry) !== threadId) continue;

                for (const other of threads.values()) {
                    if (other === entry) continue;
                    if (persistentIdOf(other) !== undefined && other.expanded) setThreadExpanded(other, false);
                }

                detachTileExpansion();
                setThreadExpanded(entry, true);
                entry.row.classList.add('is-persistent-focused');
                focusedChildKey = entry.key;
                entry.row.scrollIntoView?.({ block: 'nearest' });
                return true;
            }

            return false;
        };

        // R18: where a child row belongs — FLAT. The host is wherever the parent's row already
        // lives, never the parent's own card, so a grandchild is a sibling of its parent's card
        // rather than another element inside it. The hierarchy is the returned `depth`, which
        // `orderThreadRows` stamps on the row; the DOM structure carries none of it.
        //
        // A turn root (and an inline legacy section) has no row: its children attach to the
        // turn-level host at depth 1, exactly as before. An unknown parent id degrades to the
        // same top-level slot instead of throwing, because a recorded payload is untrusted.
        const threadRowOf = (parentKey: string | undefined): { host: HTMLElement; depth: number } => {
            const parent = parentKey === undefined ? undefined : threads.get(parentKey);
            const parentHost = parent?.row?.parentElement;

            if (parent !== undefined && parent.row !== undefined && parentHost instanceof HTMLElement)
                return { host: parentHost, depth: parent.depth + 1 };

            return { host: threadHost, depth: 1 };
        };

        // R18: the ONE ordering pass for the flat hierarchy. Every invocation row this tile owns
        // is re-appended into the turn's single `.thread-children` host in DEPTH-FIRST order and
        // stamped with its level, which is what replaces the nesting that used to give that
        // order (and that indentation) for free:
        //   - a delegated conversation reads as an independent card BESIDE the block it came
        //     from — the bug being fixed was a delegate rendering inside its caller's frame;
        //   - the reading order is still [root, child, grandchild, next child], the order the
        //     roster join, the `#` result blocks and the labels were allocated in, so flattening
        //     renumbers nothing;
        //   - indentation is DATA: `data-depth` for assistive tech and the tests, and
        //     `--thread-depth` (the stylesheet's single indent step multiplied) for the visual
        //     cue, so an arbitrary metadata depth still indents without another element.
        // Map insertion order is creation order, and the projector/`entryForMeta` always open a
        // parent before its children, so a pre-order walk of that map is the server's order.
        const orderThreadRows = (): void => {
            const children = new Map<string, ThreadEntry[]>();
            const roots: ThreadEntry[] = [];

            for (const entry of threads.values()) {
                if (entry.row === undefined) continue;

                const parent =
                    entry.parentKey === undefined ? undefined : threads.get(entry.parentKey);

                // No parent, an unknown parent (a corrupt record), or a parent whose surface is
                // the tile body (the turn root / a flat legacy section): a top-level card here.
                if (parent === undefined || parent.row === undefined) {
                    roots.push(entry);
                    continue;
                }

                const list = children.get(parent.key);
                if (list === undefined) children.set(parent.key, [entry]);
                else list.push(entry);
            }

            // A corrupt/cyclic parent chain terminates: the second visit is a no-op rather than
            // infinite recursion, and the row keeps the position it already had.
            const seen = new Set<string>();

            const visit = (entry: ThreadEntry, depth: number, parentKey: string | undefined): void => {
                if (seen.has(entry.key)) return;
                seen.add(entry.key);

                entry.depth = depth;
                entry.row?.setAttribute('data-depth', String(depth));
                // R18: the hierarchy the DOM no longer carries lives in the row's own ids.
                // `data-parent-thread` names the invocation this card hangs off, so a reader, a
                // test and a `#` reference can all resolve parentage after flattening. The turn
                // root's internal 'root' key is deliberately NOT written — it is not an
                // addressable identity — but the root SECTION's wire id is, and a compiled
                // child's `parentKey` is exactly that, which is how a direct child of the turn's
                // own flow still says whose delegate it is.
                if (entry.row !== undefined) {
                    if (parentKey === undefined || parentKey === ROOT_KEY) delete entry.row.dataset.parentThread;
                    else entry.row.dataset.parentThread = parentKey;
                }
                // The host's own `padding-left` is the FIRST step, so a row adds `depth - 1`.
                entry.row?.style.setProperty('--thread-depth', String(Math.max(0, depth - 1)));
                if (entry.row !== undefined) threadHost.append(entry.row);

                for (const child of children.get(entry.key) ?? []) visit(child, depth + 1, entry.key);
            };

            // A root row still carries its recorded `parentKey` (the turn's own section id, or
            // 'root' for the raw path's root flow), so the attribute is decided from the entry,
            // not from the walk.
            for (const root of roots) visit(root, 1, root.parentKey);
        };

        // Would making `parentKey` this entry's parent create a cycle? A recorded
        // payload is untrusted enough that a self/descendant parent must not throw
        // a DOM `HierarchyRequestError` by appending a row inside itself.
        const canReparent = (entry: ThreadEntry, parentKey: string | undefined): boolean => {
            let cursor = parentKey;
            const seen = new Set<string>();

            while (cursor !== undefined) {
                if (cursor === entry.key || seen.has(cursor)) return false;
                seen.add(cursor);
                cursor = threads.get(cursor)?.parentKey;
            }

            return true;
        };

        // A thread row's prompt is the child's own task. Re-rendered as Markdown
        // (same sanitizer as the turn prompt) so pasted code fences survive.
        const renderThreadPrompt = (entry: ThreadEntry, input: string): void => {
            if (entry.body === undefined) return;

            if (entry.prompt === undefined) {
                const block = el('div', 'thread-prompt markdown');
                entry.body.prepend(block);
                entry.prompt = block;
            }

            entry.prompt.replaceChildren(markdownFragment(input));
            // File mentions and images in a delegated task are the same affordance
            // as in the main prompt (R11); the transforms are DOM-only.
            enhanceFileLinks(entry.prompt, { open: openTranscriptFile });
            enhanceImages(entry.prompt, { open: openTranscriptImage });
        };

        const setThreadInput = (entry: ThreadEntry, input: string | undefined): void => {
            if (input === undefined) return;

            entry.input = input;
            if (entry.preview !== undefined) entry.preview.textContent = plainPreview(input, 160);
            renderThreadPrompt(entry, input);
        };

        const setThreadState = (entry: ThreadEntry, state: ThreadState): void => {
            entry.state = state;

            if (entry.row === undefined) return;

            entry.row.dataset.state = state;
            // The tile mirrors the state for the shared block-surface rules
            // (`:is(.tile, .thread-tile)[data-state=…]`, styles.css R3).
            if (entry.tile !== undefined) entry.tile.dataset.state = state;
            if (entry.status !== undefined) entry.status.dataset.state = state;
            if (entry.statusText !== undefined) entry.statusText.textContent = STATE_TEXT[state];
        };

        // N3: stamp what spawned this invocation and (for fork/autoanswer) its
        // branch identity. The header tag is created lazily so a delegation row is
        // exactly the pre-N3 row (no badge, no extra width). A root/flat entry has
        // no row to tag, so the metadata is kept but nothing is painted.
        const setThreadKind = (
            entry: ThreadEntry,
            kind: 'delegation' | 'fork' | 'autoanswer' | undefined,
            branchId: string | undefined
        ): void => {
            entry.kind = kind;
            entry.branchId = branchId;

            if (entry.row === undefined) return;
            if (branchId !== undefined) entry.row.dataset.branchId = branchId;
            else delete entry.row.dataset.branchId;

            if (kind !== 'fork' && kind !== 'autoanswer') {
                entry.kindTag?.remove();
                entry.kindTag = undefined;
                delete entry.row.dataset.kind;
                return;
            }

            if (entry.kindTag === undefined) {
                const tag = el('span', 'thread-kind', kind === 'fork' ? 'fork' : 'auto');
                tag.dataset.kind = kind;
                tag.title = kind === 'fork' ? 'Fork of this thread' : 'Automatic owner answer';
                // Insert directly after the agent code so the row reads
                // `code · kind · preview`; CSS `order` keeps it in that slot even
                // though the preview was appended later.
                entry.select?.insertBefore(tag, entry.preview ?? null);
                entry.kindTag = tag;
            }

            entry.kindTag.textContent = kind === 'fork' ? 'fork' : 'auto';
            entry.kindTag.dataset.kind = kind;
            entry.row.dataset.kind = kind;
        };

        // Outcome line for one invocation. FIRST outcome wins: a replay can deliver
        // the same parent result twice, and a root-terminal interruption already
        // told the reader why the child stopped. Text only — the result is
        // model-written, so it is previewed as plain text (never HTML).
        const paintThreadOutcome = (entry: ThreadEntry, text: string, tone: 'info' | 'error'): void => {
            if (entry.outcome === undefined) return;
            if (!entry.outcome.hidden) return;

            entry.outcome.hidden = false;
            entry.outcome.dataset.tone = tone;
            entry.outcome.textContent = text;
        };

        // Terminal transition for an invocation. Idempotent: an already-terminal
        // entry still accepts an outcome (the parent's tool_result arrives AFTER the
        // child's final `done` on the wire), but its state is never reopened.
        const completeThread = (entry: ThreadEntry, state: ThreadState, outcome?: string): void => {
            if (outcome !== undefined) paintThreadOutcome(entry, outcome, state === 'error' ? 'error' : 'info');
            if (isTerminalThread(entry.state)) return;

            setThreadState(entry, state);
        };

        // --- nested block metadata (R1) ------------------------------------
        // The FIRST event routed to an invocation starts its own clock; the event
        // that settles it freezes the span. There is no server record for a nested
        // block, so `at`/`eventTimes` are the only honest source: a recorded replay
        // without a stamp leaves the clock unknown instead of inventing one. The
        // root invocation has no `entry.meta` — the tile's server-driven
        // `blockMeta` covers it.
        const observeInvocation = (
            entry: ThreadEntry,
            at: number | undefined,
            origin: ApplyOrigin
        ): void => {
            if (entry.meta === undefined) return;

            entry.meta.begin(at ?? (origin === 'live' ? Date.now() : undefined), origin === 'recorded');
        };

        // Freeze a nested block's clock. `at` is the settling event's server stamp;
        // a live event without one ends at the local clock, a recorded one keeps the
        // last painted span (never a fabricated duration).
        const settleInvocation = (
            entry: ThreadEntry,
            at: number | undefined,
            origin: ApplyOrigin
        ): void => {
            if (entry.meta === undefined) return;

            entry.meta.finish(at, origin === 'recorded');
        };

        // The placeholder created when an `delegate` tool call was observed,
        // matched by its spawning call id. Explicit metadata uses it to adopt (never
        // duplicate) the entry the user is already looking at.
        const findThreadByCallId = (callId: string): ThreadEntry | undefined => {
            for (const entry of threads.values()) {
                if (entry.row !== undefined && entry.callId === callId) return entry;
            }

            return undefined;
        };

        // Oldest not-yet-started placeholder for an agent. Legacy child `start`
        // events carry no metadata, so FIFO adoption is the truthful association
        // under the runtime's serialized-per-agent invariant; two queued delegates
        // to the SAME agent therefore become two separate entries in call order.
        const findQueuedPlaceholder = (agentName: string): ThreadEntry | undefined => {
            for (const entry of threads.values()) {
                if (entry.row === undefined) continue;
                if (entry.agent !== agentName || entry.started) continue;
                return entry;
            }

            return undefined;
        };

        // Build a thread entry (row + body + its own children host). The row is
        // appended to the parent's children host; `.turn-row` is never touched, so a
        // turn reorder/remove moves the whole invocation subtree atomically.
        const createThread = (options: {
            key: string;
            agent: string;
            input: string | undefined;
            callId: string | undefined;
            parentKey: string | undefined;
            explicitId: string | undefined;
            started: boolean;
            state: ThreadState;
            kind?: 'delegation' | 'fork' | 'autoanswer';
            branchId?: string;
        }): ThreadEntry => {
            const existing = threads.get(options.key);
            if (existing !== undefined) return existing;

            const place = threadRowOf(options.parentKey);
            const bodyId = `thread-${++nextId}-body`;

            const threadRow = el('div', 'thread-row');
            threadRow.dataset.depth = String(place.depth);
            threadRow.dataset.threadId = options.key;
            // Same painting rule as the tile: an unnamed/placeholder agent writes NO
            // `data-agent` (not `data-agent=""`) so every block shares one neutral
            // semantics and `[data-agent]` only matches a real identity.
            paintAgentColor(threadRow, options.agent);
            threadRow.dataset.state = options.state;

            const tile = el('article', 'thread-tile');
            // R3: the nested surface is painted with the SAME helper the main tile
            // uses, so a delegated invocation is visually the same block (plus the
            // indentation its host provides) and keeps one stable colour per agent.
            paintAgentColor(tile, options.agent);
            // The tile mirrors its row's state so styles.css styles main and nested
            // blocks with one grouped selector (`:is(.tile, .thread-tile)`).
            tile.dataset.state = options.state;

            // A real <button> owns collapse/expand: Enter/Space work natively and
            // `aria-expanded`/`aria-controls` describe the controlled body.
            const select = el('button', 'thread-select');
            select.type = 'button';
            select.setAttribute('aria-expanded', 'false');
            select.setAttribute('aria-controls', bodyId);

            // R4/R1: the whole collapsed entry is ONE row, with the SAME anatomy as a
            // compact turn tile — `code [kind] · preview · [elapsed | tokens]`.
            // The agent code leads (the tile's prompt is its own leading item), the
            // preview is the single flexible, ellipsised item, and the measurement line
            // (`.thread-top`) is the nested counterpart of `.tile-top`. Both lines carry
            // the same two labels from the shared `createBlockMeta`, plus the state box
            // whose word is a clipped screen-reader label (T2), so a child block shows its
            // own duration, usage and state the way the root block does.
            // R8: a nested invocation shows its child CONVERSATION label when the
            // roster already joins this invocation id; only a legacy/threadless
            // block falls back to the allocator (and therefore consumes a number).
            // The SAME claim `persistentIdOf` uses (including the historical
            // `invocationIds` list), so the header label and the conversation marker
            // can never disagree about one card.
            const conversationLabel = ((): string | undefined => {
                const match = rosterClaimOf(options.key);
                return match === undefined ? undefined : threadNameOf(match);
            })();
            reserveConversationLabel(conversationLabel);
            const label = conversationLabel ?? nextLabel(options.agent);
            const name = el('span', 'thread-name', label);
            const kindTag =
                options.kind === 'fork' || options.kind === 'autoanswer'
                    ? el('span', 'thread-kind', options.kind === 'fork' ? 'fork' : 'auto')
                    : undefined;
            if (kindTag !== undefined) {
                kindTag.dataset.kind = options.kind ?? '';
                kindTag.title = options.kind === 'fork' ? 'Fork of this thread' : 'Automatic owner answer';
            }
            const blockMeta = createBlockMeta({ elapsed: 'thread-elapsed', tokens: 'thread-tokens' });
            // Status stays TEXT: the word is clipped (not removed) in EVERY header state,
            // exactly like `.tile-status-text`, and colour only reinforces it.
            // R3/T2: the box closes the MEASUREMENT line (`34.2s | 18,654 (37,376)`, the
            // state painted as the line's colour), the same placement the main tile uses;
            // it never rides beside `.thread-name`, so the identity half of the row stays
            // code + kind tag only — and both stay fully legible because the preview is the
            // only item that truncates.
            const status = el('span', 'thread-status');
            status.dataset.state = options.state;
            const statusText = el('span', 'thread-status-text', STATE_TEXT[options.state]);
            status.append(statusText);

            const top = el('span', 'thread-top');
            top.append(blockMeta.elapsed, blockMeta.tokens, status);
            const preview = el(
                'span',
                'thread-preview',
                options.input === undefined || options.input.length === 0
                    ? 'delegated task'
                    : plainPreview(options.input, 160)
            );
            // Identity first (the conversation code, then the fork/auto marker), the
            // flexible preview in the middle, and the measurement line — clock, tally,
            // state word — flush right (R3/R1: one anatomy with the compact tile).
            select.append(name, ...(kindTag === undefined ? [] : [kindTag]), preview, top);

            const body = el('div', 'thread-body');
            body.id = bodyId;

            // T19 (R17): this conversation's OWN context strip, in the same slot the main tile
            // uses — between the identity/prompt half and the flow. It stays hidden until a
            // compiled frame carries `TurnSection.context` for THIS section, so a raw stream or
            // a legacy record costs nothing, and a delegated card can never read its caller's
            // distribution by accident.
            const entryContextBarHost = el('div', 'context-bar-host');
            entryContextBarHost.hidden = true;

            const threadFlow = el('div', 'thread-flow');
            body.append(entryContextBarHost, threadFlow);

            const outcome = el('div', 'thread-outcome');
            outcome.hidden = true;
            body.append(outcome);

            // R7/R8/T26: a delegated/forked child conversation has no SessionTurn of its
            // own, so its JSON transcript comes from the roster entry joined to this
            // invocation. The toolbar is hidden until the entry is expanded; a pure
            // invocation detail (no persistent thread) never shows an action. Delete
            // leads the bar and Transcript closes it, exactly like the main tile.
            const actionBar = createThreadActionBar({
                className: 'thread-transcript-action',
                visible: () => entry.expanded && entry.row !== undefined,
                target: () => persistentIdOf(entry),
                open: () => openTranscriptOf(persistentIdOf(entry))
            });
            const transcriptAction = actionBar.element;
            const transcriptButton = actionBar.transcriptButton;

            tile.append(select, transcriptAction, body);

            // R18: the row holds ONLY its own card now. The descendant rows that used to be
            // appended after the tile inside a per-entry `.thread-children` host are flat
            // siblings in the turn's one host, so `.thread-row > .thread-tile` is the whole
            // structure of a delegated card.
            threadRow.append(tile);

            // T19 (R17): one bar surface per delegated conversation, owned by THIS card. It is
            // created empty and stays `driven() === false` until a section points it at itself,
            // so a raw-path row (which has no `TurnSection` to read) simply never shows one.
            const entryContextBar = createContextBarSurface(entryContextBarHost);

            // R18: the row lands in its parent's host; `orderThreadRows` (called once the entry
            // is registered, below) then puts it at its depth-first position among its siblings.
            place.host.append(threadRow);

            const entry: ThreadEntry = {
                key: options.key,
                agent: options.agent,
                label,
                input: options.input,
                callId: options.callId,
                parentKey: options.parentKey,
                depth: place.depth,
                explicitId: options.explicitId,
                kind: options.kind,
                branchId: options.branchId,
                kindTag,
                started: options.started,
                state: options.state,
                // R5/T7: the footer Collapse chevron for THIS card. It is the only one:
                // the collapsed row above IS the expander (`.thread-select`, whose own
                // click handler is below), and this button is the way to close the card
                // from the bottom of a long transcript without scrolling back up.
                //
                // `collapse` reads `entry` only at CLICK time — `entry` is still in its
                // temporal dead zone while this literal is being evaluated, which is
                // harmless now that nothing is read at creation. It performs the card's own
                // collapse and deliberately does NOT route through `focusThread` the way the
                // header button does for a PERSISTENT child (see that handler): pressing the
                // chevron moves this card's body, it never re-targets the composer.
                section: createSection(threadFlow, options.agent, 'subagent', label, {
                    label: 'thread',
                    controls: bodyId,
                    collapse: () => setThreadExpanded(entry, false)
                }),
                row: threadRow,
                tile,
                body,
                select,
                meta: blockMeta,
                status,
                statusText,
                preview,
                prompt: undefined,
                outcome,
                // T19 (R17): this card's own strip + the teardown that closes its dialog and
                // destroys its observers. `destroy` is safe to call at any point: the surface
                // was created with nothing mounted on it.
                //
                // T22 (R23): the SAME surface owns this card's one tail body, so a delegated
                // conversation's thinking prints at the tail of ITS strip and never inside the
                // caller's block — the scoping rule that made the aggregate bar wrong.
                contextBar: entryContextBar,
                disposeContextBar: () => entryContextBar.destroy(),
                transcriptAction,
                transcriptButton,
                syncActionBar: actionBar.sync,
                disposeActionBar: actionBar.dispose,
                expanded: false
            };

            // T6: expose the SAME state transition to the board's implicit
            // `openEnclosingCards` pass, so an auto-opened card updates
            // `entry.expanded`, ARIA and the transcript action exactly like a click.
            threadRowSync.set(threadRow, (expanded, remember = true) => {
                setThreadExpanded(entry, expanded, remember);
            });

            // S2: clicking a child that maps to a PERSISTENT conversation focuses
            // that conversation (the composer then targets the child's true id), not
            // merely an ephemeral detail expansion. An unmapped entry keeps the old
            // independent expand/collapse behaviour.
            select.addEventListener('click', () => {
                const persistent = persistentIdOf(entry);
                if (persistent !== undefined) {
                    focusThread(persistent);
                    return;
                }

                setThreadExpanded(entry, !entry.expanded);
            });

            if (options.input !== undefined) renderThreadPrompt(entry, options.input);

            threads.set(options.key, entry);
            // R18: order ONLY after the entry is registered — `orderThreadRows` walks the
            // `threads` map, and calling it before this line would rank the brand-new row below
            // every row the map already holds (a later sibling would then sort ahead of the
            // earlier one). Appending it first and ordering here keeps creation order for
            // siblings and puts a descendant directly after its parent's subtree.
            orderThreadRows();
            // R1: restore the reader's expansion across a rebuilt projection.
            if (expandedThreads.has(options.key)) setThreadExpanded(entry, true);
            // The roster may already know this invocation (a snapshot delivered the
            // roster before this turn was replayed), so mark the persistent identity
            // immediately instead of waiting for the next `setThreads`.
            paintPersistentMarkers();
            // This card may now be the surface a continuation turn of the SAME child
            // thread belongs to (R3), so re-project the board: an already-placed
            // continuation must move into the card it just gained.
            placeAllTurns();
            updateMeta();
            return entry;
        };

        // The root invocation's section (depth 0). It has no row: the tile body IS
        // its content surface, which keeps the one authoritative TurnHandle.
        const rootSection = (agentName: string): AgentSection => {
            const existing = threads.get(ROOT_KEY);
            if (existing !== undefined) return existing.section;

            // The first agent to emit anything in the turn is the primary one;
            // every other agent is a delegated subagent. Inferred from the event
            // stream (the descriptor's agent order need not match the configured
            // primary), and only when the data actually says so.
            if (primaryAgent === undefined) primaryAgent = agentName;

            // R3: the MAIN block is agent-owned too, so the tile itself carries the
            // agent's outline/name colour (identical treatment to `.thread-tile`).
            // The helper treats the `unknown` placeholder as unnamed, so a tile whose
            // section came from the unattributable-stream fallback
            // (`resolveTool` → `inlineSection(UNNAMED_AGENT_PLACEHOLDER)`) stays
            // neutral instead of minting a palette identity for data we cannot
            // attribute.
            paintAgentColor(card, agentName);

            // R8: the root block IS the tile's persistent conversation, so it shows
            // that conversation's label (`RR4`). Only a legacy turn with no
            // persistent identity consumes an allocator occurrence. An explicit
            // conversation label still reserves its ordinal (T14 parity), so a
            // same-code child fallback continues AFTER it.
            const conversationLabel = rootConversationLabel();
            reserveConversationLabel(conversationLabel);
            const label = conversationLabel ?? nextLabel(agentName);
            // R5/T7: the root block's content IS `.tile-body`, so its footer chevron
            // closes the BOARD's single expanded conversation. There is exactly one
            // chevron for this block now: the collapsed tile's whole row (`.tile-select`)
            // is the expander, and a collapsed tile hides `.tile-body` anyway, so this
            // button only ever exists in the open state — where its job is letting the
            // reader close the conversation from the end of a long transcript.
            //
            // `collapse` calls the board's own `collapse()`, the same transition the tile
            // header performs on the expanded conversation (a deliberate unfocus). That is
            // also the correct effect for the one other state the body is visible in — a
            // sibling exchange inside an open CONVERSATION (T12b, styles.css
            // `.conversation.is-expanded .tile-body`): closing the conversation is what
            // actually hides what the reader is looking at.
            const section = createSection(flow, agentName, 'primary', label, {
                label: 'conversation',
                controls: `${id}-body`,
                collapse: () => collapse()
            });
            // R1/F3: the compact root header shows the same code as a child header.
            // The section's own `.agent-head` is hidden by CSS for the primary part
            // (the code would otherwise appear twice); flat legacy subagent sections
            // keep their head because they are DIFFERENT agents that need telling apart.
            tileAgent.textContent = label;
            tileAgent.hidden = false;
            syncRootAgentVisibility();
            threads.set(ROOT_KEY, {
                key: ROOT_KEY,
                // Root/inline sections have no row toolbar of their own; the tile's
                // action bar is created by `create` and owns Transcript/Delete.
                syncActionBar: () => undefined,
                disposeActionBar: () => undefined,
                agent: agentName,
                label,
                input: undefined,
                callId: undefined,
                parentKey: undefined,
                depth: 0,
                explicitId: undefined,
                kind: undefined,
                branchId: undefined,
                kindTag: undefined,
                started: true,
                state: 'streaming',
                section,
                row: undefined,
                tile: undefined,
                body: undefined,
                select: undefined,
                meta: undefined,
                status: undefined,
                statusText: undefined,
                preview: undefined,
                prompt: undefined,
                outcome: undefined,
                contextBar: undefined,
                // The tile owns the root/inline strip and destroys it with the tile, so a
                // row-less entry has nothing of its own to tear down here.
                disposeContextBar: () => undefined,
                transcriptAction: undefined,
                transcriptButton: undefined,
                expanded: false
            });

            updateMeta();
            return section;
        };

        // The pre-thread rendering, kept for legacy data the UI cannot attribute to
        // a known invocation (an old ctx.run child, or an ambiguous agent stream).
        // It is flat and keyed by agent, exactly like the old board: truthful about
        // what the record says instead of guessing ancestry.
        const inlineSection = (agentName: string): AgentSection => {
            const key = `inline:${agentName}`;
            const existing = threads.get(key);
            if (existing !== undefined) return existing.section;

            // The first flat agent of an unknown stream with no root yet is the
            // entry agent (the pre-thread behaviour).
            if (threads.get(ROOT_KEY) === undefined && primaryAgent === undefined) {
                return rootSection(agentName);
            }

            // The flat legacy block consumes one occurrence, like any other
            // invocation of that agent; the same label goes to the header and to the
            // entry (R2).
            const label = nextLabel(agentName);
            const section = createSection(flow, agentName, 'subagent', label);
            threads.set(key, {
                key,
                agent: agentName,
                // A flat legacy section has no row header/action surface.
                syncActionBar: () => undefined,
                disposeActionBar: () => undefined,
                label,
                input: undefined,
                callId: undefined,
                parentKey: undefined,
                depth: 0,
                explicitId: undefined,
                kind: undefined,
                branchId: undefined,
                kindTag: undefined,
                started: true,
                state: 'streaming',
                section,
                row: undefined,
                tile: undefined,
                body: undefined,
                select: undefined,
                meta: undefined,
                status: undefined,
                statusText: undefined,
                preview: undefined,
                prompt: undefined,
                outcome: undefined,
                contextBar: undefined,
                // The tile owns the root/inline strip and destroys it with the tile, so a
                // row-less entry has nothing of its own to tear down here.
                disposeContextBar: () => undefined,
                transcriptAction: undefined,
                transcriptButton: undefined,
                expanded: false
            });

            updateMeta();
            return section;
        };

        // Move one entry (and its whole subtree) under a new parent. A parent that is
        // this entry or one of its descendants is rejected: the metadata would be
        // corrupt, and the DOM cannot nest a node inside itself.
        const reparentThread = (entry: ThreadEntry, parentKey: string | undefined): void => {
            if (entry.row === undefined) return;
            if (!canReparent(entry, parentKey)) return;

            entry.parentKey = parentKey;
            // R18: the row no longer needs to be carried between hosts (there is one flat host
            // per turn); what changes is its POSITION in that host and its DEPTH, and
            // `orderThreadRows` recomputes both for the re-parented branch AND its descendants
            // in one pass — the replacement for the old per-subtree `setThreadDepth` walk.
            orderThreadRows();
        };

        // Adopt a placeholder when the runtime's explicit identity for the SAME
        // spawning call arrives. The synthesized key is replaced by the canonical
        // id, so no duplicate entry survives; the placeholder's position in the
        // list is kept (no reorder) unless the explicit metadata names a different
        // parent (explicit metadata wins).
        const adoptPlaceholder = (entry: ThreadEntry, meta: HarnessThreadInfo): void => {
            const previousKey = entry.key;
            threads.delete(previousKey);
            entry.key = meta.id;
            entry.explicitId = meta.id;
            entry.row?.setAttribute('data-thread-id', meta.id);
            threads.set(meta.id, entry);

            // The reader's expansion follows the entry to its canonical key.
            if (expandedThreads.delete(previousKey)) expandedThreads.add(meta.id);

            // Descendants (synthetic nested metadata, or a grandchild that started
            // before the parent's explicit record) follow the rekey so depth
            // recomputation and future nesting keep pointing at this entry.
            for (const child of threads.values()) {
                if (child.parentKey === previousKey) child.parentKey = meta.id;
            }

            if (meta.callId !== undefined) entry.callId = meta.callId;
            setThreadInput(entry, meta.input);
            setThreadKind(entry, meta.kind, meta.branchId);
            if (meta.parentId !== entry.parentKey) reparentThread(entry, meta.parentId);

            entry.started = true;
            setThreadState(entry, 'streaming');
            // R8: the placeholder showed the allocator's provisional number; after
            // adoption the roster can join the CHILD conversation, so repaint its
            // stable label (`RR5`) and persistent marker now.
            paintPersistentMarkers();
            // R3: the re-key can make this card the addressable surface of a child
            // thread that already has a continuation turn placed elsewhere.
            placeAllTurns();
            // R1: an adopted entry inherits the reader's expansion for its canonical
            // key (the placeholder was created under the synthesized key).
            if (expandedThreads.has(entry.key)) setThreadExpanded(entry, true);
        };

        // Resolve an explicit `thread` record to its entry. The first record for an
        // id is the child `start` (full record); later events may carry only `id`,
        // so an unknown id is created defensively instead of dropping content.
        const entryForMeta = (meta: HarnessThreadInfo, event: HarnessEvent): ThreadEntry => {
            const existing = threads.get(meta.id);
            if (existing !== undefined) return existing;

            // A placeholder for this spawning call is the entry the user already
            // sees: adopt it rather than adding a second row (R3, no duplicates).
            if (meta.callId !== undefined) {
                const placeholder = findThreadByCallId(meta.callId);
                if (placeholder !== undefined && placeholder.explicitId === undefined) {
                    adoptPlaceholder(placeholder, meta);
                    return placeholder;
                }
            }

            return createThread({
                key: meta.id,
                agent: event.agent,
                input: meta.input,
                callId: meta.callId,
                parentKey: meta.parentId,
                explicitId: meta.id,
                started: true,
                state: 'streaming',
                ...(meta.kind === undefined ? {} : { kind: meta.kind }),
                ...(meta.branchId === undefined ? {} : { branchId: meta.branchId })
            });
        };

        // Legacy (no metadata) routing. In order:
        //   1. the root invocation owns every event from the entry agent;
        //   2. a child `start` adopts the oldest queued delegate placeholder;
        //   3. any other event routes to the single STARTED, non-terminal entry for
        //      that agent (the runtime serializes one invocation per agent);
        //   4. everything else — no candidate, or MORE THAN ONE (ambiguous) — keeps
        //      the flat inline section. Distinct known invocations are never merged.
        const entryForLegacy = (event: HarnessEvent): ThreadEntry => {
            const root = threads.get(ROOT_KEY);
            if (root !== undefined && event.agent === root.agent) return root;

            if (event.type === 'start') {
                const queued = findQueuedPlaceholder(event.agent);
                if (queued !== undefined) {
                    queued.started = true;
                    setThreadState(queued, 'streaming');
                    return queued;
                }

                return threads.get(`inline:${event.agent}`) ?? inlineEntry(event.agent);
            }

            let active: ThreadEntry | undefined;
            let activeCount = 0;
            for (const entry of threads.values()) {
                if (entry.row === undefined) continue;
                if (entry.agent !== event.agent || !entry.started) continue;
                if (isTerminalThread(entry.state)) continue;
                active = entry;
                activeCount += 1;
            }

            if (activeCount === 1 && active !== undefined) return active;

            const inline = threads.get(`inline:${event.agent}`);
            return inline ?? inlineEntry(event.agent);
        };

        // `inlineSection` returns the section; routing also needs the entry (to own
        // tool calls and pending state). This resolves the entry for the same key.
        const inlineEntry = (agentName: string): ThreadEntry => {
            inlineSection(agentName);

            const entry = threads.get(`inline:${agentName}`) ?? threads.get(ROOT_KEY);
            if (entry !== undefined) return entry;

            // Unreachable: `inlineSection` always seeds one of the two keys. The
            // fallback keeps the return type total rather than throwing mid-stream.
            rootSection(agentName);
            return threads.get(ROOT_KEY) as ThreadEntry;
        };

        // R8/R10: a HOST-thread run carries an invocation identity on every frame
        // (so its events can be grouped), but it is still the TURN'S OWN root
        // conversation — not an agent-spawned child. Such a record has no parent,
        // no spawning call and no branch marker (the same discriminator
        // shared/agent-results.ts uses). Rendering it as a `.thread-row` is the
        // generic `T8` wrapper with an indented root that R8 removes.
        const isConversationRoot = (meta: HarnessThreadInfo): boolean =>
            meta.parentId === undefined &&
            meta.callId === undefined &&
            meta.kind === undefined &&
            meta.branchId === undefined;

        const entryFor = (event: HarnessEvent): ThreadEntry => {
            // Explicit metadata is authoritative (frozen runtime contract).
            const meta = threadOf(event);
            if (meta !== undefined) {
                // An already-known invocation id owns its frame, even when later
                // frames carry only `{id}` (the runtime sends the full record once).
                const known = threads.get(meta.id);
                if (known !== undefined) return known;

                if (isConversationRoot(meta)) {
                    const root = threads.get(ROOT_KEY);
                    if (root === undefined) {
                        rootSection(event.agent);
                        return threads.get(ROOT_KEY) as ThreadEntry;
                    }

                    // Same agent as the turn's root: this is another frame of the
                    // host-thread run, NOT a child. A DIFFERENT agent with no parent
                    // is a legacy/incomplete child record; keep the old row path.
                    if (root.agent === event.agent) return root;
                }

                return entryForMeta(meta, event);
            }

            return entryForLegacy(event);
        };

        // Paint ONE prose surface from ONE string. `renderText` (the streaming writer's
        // flush) and a `node:set {text}` replacement (the server swapping in a bounded
        // preview) go through here, so the two can never disagree about Markdown, file
        // links or image enhancement (T13: the patch is server state being rendered, not
        // the client re-compiling events).
        const paintProse = (node: HTMLElement, text: string): void => {
            node.replaceChildren(markdownFragment(text));
            // R11: file mentions in the assistant's answer are clickable too. The
            // transform runs after sanitizing and only creates buttons from text.
            enhanceFileLinks(node, { open: openTranscriptFile });
            enhanceImages(node, { open: openTranscriptImage });
        };

        const renderText = (block: TextBlock): void => {
            paintProse(block.node, block.buffer);
        };

        const flushText = (section: AgentSection): void => {
            const block = section.text;
            if (block === undefined) return;

            cancel(block);
            renderText(block);
        };

        const closeText = (section: AgentSection): void => {
            if (section.text === undefined) return;

            flushText(section);
            // Retain the cumulative answer for the # reference descriptor; the
            // rendered nodes stay in place, only the incremental writer is closed.
            section.lastText = section.text.buffer;
            section.text = undefined;
        };

        // R5: paint (or remove) this block's footer Copy action.
        //
        // The button exists ONLY while the block has a completed answer to copy:
        // a still-streaming response, a tool-only block and an answer that was cut
        // short by an error/cancel deliberately show nothing, so the affordance can
        // never promise "the final answer" and deliver a partial one. Once created
        // it stays for the life of the block, because the payload provider below is
        // evaluated at click time — a later completed answer advances the clipboard
        // text without re-creating the control (and without ever blanking it while a
        // new response is still streaming).
        const paintAnswerAction = (section: AgentSection): void => {
            const copyable = section.finalAnswer !== undefined && section.finalAnswer.length > 0;
            if (copyable === (section.answerAction !== undefined)) return;

            if (section.answerAction === undefined) {
                const button = createTextCopyButton({
                    // Static accessible name: the label must not go stale when a
                    // roster join repaints the block's agent code (`paintEntryLabel`).
                    label: 'Copy the final answer',
                    text: () => section.finalAnswer ?? '',
                    className: 'answer-copy'
                });
                // R5: PREPENDED, so the copy control is always the FIRST child of the
                // row (left) and the Collapse chevron — created with the block — stays the
                // last (right, pinned by `margin-left: auto`). Appending here would put
                // the copy button after the chevron and reverse the agreed order.
                section.actions.prepend(button);
                section.answerAction = button;
                return;
            }

            section.answerAction.remove();
            section.answerAction = undefined;
        };

        // R5: promote the prose of one COMPLETED model response to this block's
        // final answer. Callers pass the buffer that closed at the boundary, or the
        // terminal `done` message content (authoritative when the provider put the
        // answer there instead of in streamed deltas).
        //
        // An empty/absent answer is a NO-OP rather than a reset: a round that only
        // issued tool calls has no prose of its own, and the last real answer the
        // reader can still see must stay copyable.
        const promoteAnswer = (section: AgentSection, text: string | undefined): void => {
            if (text === undefined || text.length === 0) return;

            section.finalAnswer = text;
            paintAnswerAction(section);
        };

        // R9/T12d: render one steer into THIS tile's target surface. `sourceTurnId`
        // prevents an untargeted/self steer from being painted on another tile that
        // happens to scan the same audit. Child targets are resolved through the
        // roster join, so a child invocation is never rendered on the parent flow.
        const tryRenderSteer = (steer: SessionSteerRecord, sourceTurnId: string, key: string): boolean => {
            const targetId = steer.threadId;
            let section: AgentSection | undefined;

            if (targetId === undefined || targetId === runtimeThreadId) {
                if (serverId === undefined || serverId !== sourceTurnId) return false;
                section = threads.get(ROOT_KEY)?.section;
            } else {
                for (const entry of threads.values()) {
                    if (entry.row === undefined) continue;
                    if (persistentIdOf(entry) !== targetId) continue;

                    section = entry.section;
                    break;
                }
            }

            if (section === undefined) return false;
            // Idempotent across local event-order rendering, the board pass and a
            // rebuilt projection (the node is gone after a rebuild, so it re-appends).
            if (flowHasSteer(section.flow, key)) return true;

            closeText(section);
            // R1: a steer is VISIBLE prose (the user's own guidance inserted into the
            // conversation), so it breaks the chip run exactly like agent prose does —
            // otherwise a later call would float back up into the row above the steer.
            closeToolGroup(section);
            section.flow.append(createSteerNode(steer, key));
            return true;
        };

        let notifySteerChange: () => void = () => undefined;

        // Local event-order pass for steers this tile owns; the board pass then
        // routes targets that live in an earlier turn or the roster panel.
        const renderSteersThrough = (limitAt?: number): void => {
            for (let index = 0; index < steerRecords.length; index += 1) {
                if (renderedSteers.has(index)) continue;
                if (limitAt !== undefined && steerRecords[index].at > limitAt) continue;

                const key = steerKeyOf(serverId ?? '', index);
                if (!tryRenderSteer(steerRecords[index], serverId ?? '', key)) continue;

                renderedSteers.add(index);
            }
        };

        // End the current run of tool calls. The group node stays in the flow (its
        // cards belong to it); only the pointer is cleared so the next call is
        // appended to a fresh row after whatever broke the run.
        //
        // R1: this is for a VISIBLE break only — prose, an error, a retry notice or a
        // steer. A reasoning round does NOT break the run any more: it is a chip that
        // joins this same row. Scheduler frames (`attempt_commit`, `done`, `wakeup`) do
        // NOT call it: they add nothing readable between two calls, and clearing the
        // pointer there is what split four consecutive calls into two rows of two.
        const closeToolGroup = (section: AgentSection): void => {
            section.toolGroup = undefined;
        };

        // Return the row consecutive chips should join — a tool call or a think chip —
        // creating it lazily so no empty `.tool-group` ever sits in the flow between two
        // prose blocks.
        //
        // R1: the row is deliberately NOT registered as attempt output. Because the
        // pointer now survives `attempt_commit`/`done`/`wakeup`, one row can hold
        // calls from several attempts, and discarding the row wholesale would delete
        // calls an EARLIER attempt already committed. Ownership is therefore per
        // CHIP (`appendTool`/`appendReasoning` track `card.element`), and
        // `discardAttempt` drops a row only once nothing is left in it.
        const toolGroupOf = (section: AgentSection): HTMLElement => {
            if (section.toolGroup === undefined) {
                const group = el('div', 'tool-group');
                section.flow.append(group);
                section.toolGroup = group;
            }

            return section.toolGroup;
        };

        // Repaint one agent's pending line from its per-call map (R6). The line is a
        // STATIC snapshot of the server's last reported spans: it does not tick
        // locally, because the browser is not measuring these calls. The tool cards
        // themselves are never touched here: a `pending` entry is state, not a
        // result, so it must not resolve, abandon or restart a card.
        const renderPending = (section: AgentSection): void => {
            if (section.pendingCalls.size === 0) {
                section.pending?.remove();
                section.pending = undefined;
                updateMeta();
                return;
            }

            const node = section.pending ?? el('div', 'agent-pending');
            // Deterministic text (tests assert it): `pending · read 1.2s · search 900ms`.
            node.textContent = `pending · ${[...section.pendingCalls.values()]
                .map((tool) => `${tool.name} ${formatDuration(tool.elapsedMs)}`)
                .join(' · ')}`;

            section.pending = node;
            // Appending an already-attached node MOVES it, which keeps the pending
            // line last after any tool_call appended in the meantime.
            section.flow.append(node);

            updateMeta();
        };

        // Replace one agent's pending snapshot with a server-supplied array. Only a
        // PRESENT array reaches here; absence must leave the line alone (the runtime
        // omits `pending` when nothing remains, so absence is not a drain signal).
        const paintPending = (section: AgentSection, pending: readonly HarnessPendingTool[]): void => {
            section.pendingCalls.clear();
            for (const tool of pending) section.pendingCalls.set(tool.callId, tool);
            renderPending(section);
        };

        // A call finished, so drop THAT call from its agent's snapshot even when the
        // frame carried no `pending` array. Scoped to the call id: same-name siblings
        // and another agent's pending calls stay listed until they settle too.
        const noteSettled = (section: AgentSection, callId: string): void => {
            if (!section.pendingCalls.delete(callId)) return;
            renderPending(section);
        };

        // Visible marker for a wakeup (R6). The agent resumed because pending work
        // progressed; this is NOT a completion, so nothing here resolves a card or
        // changes the tile state.
        //
        // R1: the text block closes (the pre-wake prose is finished), but the chip
        // ROW does not. A wake is a scheduler resume, not something the reader
        // reads between two calls, so calls issued before and after it stay one
        // wrapping flow. The marker is appended into the flow AFTER the row, and a
        // later chip is appended INTO the row, so the visible order is
        // `[all chips] → wakeup → pending`: the status line follows the merged row
        // instead of splitting it, and nothing is re-created (one marker per frame,
        // one chip per call — a replay rebuilds the projection from scratch).
        const appendWakeup = (section: AgentSection, pending: readonly HarnessPendingTool[]): void => {
            closeText(section);

            const node = el('div', 'agent-wakeup');
            node.append(el('span', 'agent-wakeup-label', 'wakeup'));
            node.append(
                el(
                    'span',
                    'agent-wakeup-text',
                    pending.length === 0
                        ? 'pending tools finished · continuing'
                        : `${pending.length} tool${pending.length === 1 ? '' : 's'} still running · continuing`
                )
            );
            section.flow.append(node);
        };

        // --- N3 action cards and branch rows ---------------------------------
        //
        // A card belongs to the invocation that emitted the request: inside the
        // root tile flow for the owner's question, inside a child entry's flow for
        // an automatic fork's question. `entry.key === ROOT_KEY` is the ONE
        // interactive case; every thread (delegation, fork or autoanswer) is
        // answered by its immediate owner and renders read-only.
        const isSettledTurn = (): boolean => state === 'done' || state === 'error' || state === 'cancelled';

        // Create/register one card. `request` is already parsed by the contract
        // guard, so the card never sees a partially-malformed payload.
        const mountActionCard = (entry: ThreadEntry, request: HarnessActionRequest): ActionRequestCard => {
            const existing = actionCards.get(request.requestId);
            if (existing !== undefined) return existing;

            const interactive = entry.key === ROOT_KEY && !isSettledTurn();
            const stored = actionAnswers.get(request.requestId);
            const card = createActionRequestCard({
                request,
                interactive,
                ...(stored === undefined ? {} : { answer: stored }),
                ...(interactive
                    ? {
                          onAnswer: async (choice: HarnessActionChoice): Promise<void> => {
                              if (options.answerAction === undefined) {
                                  throw new Error('answering is not wired on this page');
                              }
                              // `boundSession` is read at click time. `bindSession`
                              // expires a card created under another session, so
                              // this can only name the conversation on screen.
                              await options.answerAction({
                                  requestId: request.requestId,
                                  choice,
                                  ...(boundSession === undefined ? {} : { sessionId: boundSession })
                              });
                          }
                      }
                    : {}),
                // A settled historical turn is not a live question: the card is
                // shown for the record but its controls are already expired.
                ...(isSettledTurn()
                    ? {
                          expired:
                              state === 'cancelled'
                                  ? 'This question expired when the turn was cancelled.'
                                  : state === 'error'
                                    ? 'This question expired when the turn failed.'
                                    : 'This question expired when the turn ended.'
                      }
                    : {})
            });

            entry.section.flow.append(card.element);
            if (entry.section.pending !== undefined) entry.section.flow.append(entry.section.pending);
            actionCards.set(request.requestId, card);
            rememberAnswerCard(card);
            return card;
        };

        // Authoritative answer frame. A card that is not on this tile is ignored:
        // a replay/duplicate must not fabricate a question row.
        const applyActionAnswer = (answer: HarnessActionAnswer): void => {
            actionAnswers.set(answer.requestId, answer);
            actionCards.get(answer.requestId)?.setAnswer(answer);
        };

        const findBranchEntry = (branchId: string): ThreadEntry | undefined => {
            for (const entry of threads.values()) {
                if (entry.row !== undefined && entry.branchId === branchId) return entry;
            }

            return undefined;
        };

        // Paint a branch summary onto its thread entry. The row keeps the same
        // block anatomy as every other invocation (R3) and adds only a tiny kind
        // tag; no raw agent id or branch id is written as text.
        const applyBranchStart = (entry: ThreadEntry, branch: HarnessBranchSummary): void => {
            entry.started = true;
            setThreadKind(entry, branch.kind, branch.branchId);
            if (!isTerminalThread(entry.state)) setThreadState(entry, 'streaming');

            entry.section.root.dataset.model = branch.model;
            entry.section.root.dataset.branchKind = branch.kind;

            // A branch has no prompt of its own; describe what it is doing instead
            // of leaving a generic "delegated task" preview. A real input (when the
            // runtime supplied one) still wins.
            if (entry.preview !== undefined && (entry.input === undefined || entry.input.length === 0)) {
                entry.preview.textContent =
                    branch.kind === 'fork' ? 'fork of this thread' : 'automatic owner answer';
            }

            updateMeta();
        };

        // Terminal branch report. The branch's own `done`/`error` may already have
        // settled the entry; `completeThread` keeps the first terminal state and
        // still allows an outcome line. The mapped state uses the same vocabulary
        // as every invocation row, so nothing new is introduced visually.
        const applyBranchEnd = (
            entry: ThreadEntry,
            status: 'completed' | 'failed' | 'cancelled',
            error: { message: string } | undefined,
            at: number | undefined,
            origin: ApplyOrigin
        ): void => {
            const mapped: ThreadState =
                status === 'completed' ? 'done' : status === 'failed' ? 'error' : 'cancelled';
            const outcome =
                status === 'completed'
                    ? 'outcome · branch completed.'
                    : status === 'failed'
                      ? `error · ${error?.message ?? 'branch failed.'}`
                      : 'outcome · branch cancelled.';

            completeThread(entry, mapped, outcome);
            settleInvocation(entry, at, origin);
            updateMeta();
        };

        // --- model-request retries (R1/R3/R4) --------------------------------
        //
        // The agent retries ONE model request after a failed attempt. Its streamed
        // prose/reasoning/tool calls from that attempt were already forwarded, and
        // none of it is in the committed history: the retried attempt is discarded.
        //
        // The UI therefore remembers WHAT the current attempt appended (identity, not
        // a position/count snapshot) and truncates exactly that on a `retry`. The
        // attempt window opens at the attempt's FIRST visible output and is closed by
        // a `retry` (discard) or by a commit frame (`request_commit` on a new server,
        // `done` on an older one). See F2/F4 in the section comment above
        // `AgentSection.attempt`: a positional discard used to delete committed tool
        // rounds and sibling/parent output, because the harness emits `done` only for
        // a tool-free response.
        const beginAttempt = (section: AgentSection): void => {
            if (section.attempt !== undefined) return;
            section.attempt = {
                nodes: [],
                cards: [],
                pendingEntries: [],
                lastText: section.lastText,
                // R5: the copy target is attempt-owned state exactly like `lastText`,
                // so a discard rewinds both together (see `discardAttempt`).
                finalAnswer: section.finalAnswer,
                createdThreads: []
            };
        };

        // Register one piece of this attempt's rendered output as discardable.
        // Called by every appender the MODEL's current attempt produces; UI chrome
        // that another source owns (steer/action/wakeup/error markers) deliberately
        // does not call it.
        //
        // The node need not be a direct child of `.agent-flow`: a tool chip lives in
        // the shared `.tool-group` row (R1), and that row may have been created by an
        // EARLIER attempt, so ownership is tracked per node and removal detaches from
        // whichever parent holds it (see `discardAttempt`).
        const trackNode = (section: AgentSection, node: HTMLElement): void => {
            section.attempt?.nodes.push(node);
        };

        // Discard everything the abandoned attempt appended. Timers on its text block
        // are cancelled, its tool cards are destroyed and any delegation placeholder
        // it minted is removed, so nothing of a failed attempt keeps working or stays
        // visible in the background. Everything ELSE in the flow is untouched.
        const discardAttempt = (section: AgentSection): void => {
            const boundary = section.attempt;
            if (boundary === undefined) return;

            if (section.text !== undefined) cancel(section.text);
            section.text = undefined;

            // Remove only the cards THIS attempt minted, and only their own pending
            // entries. A sibling invocation's call (or a parent's delegation) that
            // happens to be pending at the same time is not ours to prune (F2).
            const dropped = new Set(boundary.cards);
            for (const card of boundary.cards) {
                card.destroy();
                // F5: the meta line counts calls, so a discarded card must not keep
                // inflating it.
                toolCount = Math.max(0, toolCount - 1);
            }
            if (dropped.size > 0) {
                section.tools = section.tools.filter((card) => !dropped.has(card));
                const entrySet = new Set(boundary.pendingEntries);
                for (let index = pendingTools.length - 1; index >= 0; index--) {
                    if (entrySet.has(pendingTools[index])) pendingTools.splice(index, 1);
                }
            }

            // A discarded call never ran, so the runtime emits no `tool_result` for
            // it. Its id is deliberately NOT added to `settledCalls`: a retried
            // request may legitimately re-issue the same id, and pre-settling it
            // would make that new card's result look like a duplicate.

            // A delegation placeholder is minted when the CALL is seen, so a failed
            // attempt can leave one behind. Only the entries THIS attempt created
            // are removed: a concurrently streaming sibling agent's placeholder is
            // recorded on ITS section, never here.
            for (const key of boundary.createdThreads) {
                const entry = threads.get(key);
                if (entry === undefined) continue;
                threads.delete(key);
                // T19 (R17): the row's strip goes with the row (a placeholder never has an open
                // dialog, but the destroy is the honest teardown of everything the card owned).
                entry.disposeContextBar();
                entry.row?.remove();
            }

            // Remove exactly the children this attempt appended. A steer, action
            // card, wakeup marker or error notice that landed meanwhile stays (F4),
            // and so does every committed turn of this agent.
            //
            // R1: removal is per NODE, from its own parent. A chip's parent may be a
            // `.tool-group` row this attempt did NOT create (the row now survives
            // `attempt_commit`/`done`/`wakeup`), and removing that ROW would delete
            // calls an earlier attempt already committed. So only this attempt's own
            // nodes are detached, and an emptied row is dropped separately below.
            for (const node of boundary.nodes) {
                const parent = node.parentNode;
                if (parent === section.flow || (parent instanceof HTMLElement && parent.classList.contains('tool-group'))) {
                    parent.removeChild(node);
                }
            }

            // A row that held nothing but this attempt's calls is empty now: drop it,
            // which is what "remove the row with the cards it held" used to mean.
            // Rows that still contain committed chips are left alone.
            for (const child of [...section.flow.children]) {
                if (child.classList.contains('tool-group') && child.childElementCount === 0) child.remove();
            }

            // The status line is not attempt output, so it survived the removal above;
            // re-appending an attached node MOVES it, which keeps it last exactly as
            // `renderPending` expects.
            if (section.pending !== undefined) section.flow.append(section.pending);

            // The think chip is attempt output like the prose block next to it: it was
            // removed with the nodes above, so any dialog it owns is closed here (an
            // orphaned modal would keep a stale focus trap and a body that is no longer
            // in the document).
            section.reasoning?.card.destroy();
            section.reasoning = undefined;
            // The pointer is dropped because this attempt's chips are gone; the row
            // they lived in may still hold committed calls, and the NEXT call starts a
            // fresh row after them.
            section.toolGroup = undefined;
            section.lastText = boundary.lastText;
            // R5: the failed attempt never committed an answer, so the copy target
            // rewinds with it (a promotion only ever happens at a commit boundary, so
            // this is the safety net, not the normal path).
            section.finalAnswer = boundary.finalAnswer;
            paintAnswerAction(section);
            // Nothing from this attempt is live any more; the next attempt takes its
            // own boundary at its first output.
            section.attempt = undefined;
            updateMeta();
        };

        // Close the attempt window WITHOUT discarding it: the attempt's output is
        // committed, so a later retry of a LATER request must never touch it. This is
        // what a `done` frame used to be the only signal for, which is why a
        // completed tool round was being deleted (F1).
        //
        // It ALSO detaches the incremental stream writers. The committed nodes stay
        // in the flow (and keep their content), but `section.text`/`section.reasoning`
        // must not point at them any more: the next request would otherwise append
        // its own deltas INTO the committed block, fusing two requests' output into
        // one node — and that fused node is unowned, so a retry could not remove the
        // failed half (T8 defect 1). Closing here means every request streams into
        // blocks of its own.
        const commitAttempt = (section: AgentSection): void => {
            if (section.attempt === undefined) return;

            // R5: the prose that closes HERE is a completed model response (this is
            // the commit boundary), so it becomes the block's copyable final answer.
            // Read the buffer BEFORE `closeText` drops the writer. A round that
            // streamed no prose leaves the previous answer in place.
            const completed = section.text?.buffer;
            // `closeText` flushes and retains `lastText` for the # descriptor, then
            // clears the pointer; the committed node itself is untouched.
            closeText(section);
            // Reasoning has no `lastText` contract: the committed think chip keeps its
            // text (and its dialog stays usable), only the writer is dropped so the next
            // request mints its own chip.
            section.reasoning = undefined;
            // R1: the chip row is NOT closed. A commit is an invisible lifecycle
            // boundary — the next request's calls have no readable output between
            // them and these, so they join the same wrapping row.
            //
            // The committed nodes/cards/placeholders stay live and stay owned by the
            // section; only the discard bookkeeping is dropped.
            section.attempt = undefined;

            promoteAnswer(section, completed);
        };

        // T19 (R19): the one-line retry notice this file used to append is GONE, and with it the
        // `appendRetry` helper and its `.agent-retry` nodes. A `retry` frame's job in the browser
        // is now exactly one thing — discard the abandoned attempt — which `case 'retry'` below
        // does through `discardAttempt`. Nothing else about an attempt boundary changes:
        // `closeText`/`closeToolGroup` were only needed to PLACE the notice line, and
        // `discardAttempt` already cancels the text writer and drops the tool-group pointer. No
        // browser renderer mints `.agent-retry` any more (the compiled path suppresses a
        // `retry`-tone notice node in `paintCompiledNotice`), so the stylesheet rule is a legacy
        // hook for a DOM that already carries one, not a live surface.

        const appendText = (section: AgentSection, delta: string): void => {
            beginAttempt(section);
            // Prose after a call ends the tool row: the next call must start below
            // this text rather than float back up into the previous group.
            closeToolGroup(section);

            if (section.text === undefined) {
                const node = el('div', 'markdown agent-text');
                section.flow.append(node);
                section.text = { node, buffer: '', handle: undefined, viaFrame: false };
                // Attempt output: a retry removes this block with the rest.
                trackNode(section, node);
            }

            // The pending summary is a status line: it stays after any new prose.
            if (section.pending !== undefined) section.flow.append(section.pending);

            const block = section.text;
            block.buffer += delta;
            schedule(block, () => renderText(block));
        };

        // The context figure a section's block reports right now — the denominator of a
        // think chip's percentage. A nested entry answers with its OWN tally
        // (`entry.meta`, painted as `.thread-tokens`); the root section falls back to the
        // tile's tally (`.tile-tokens`), which is the turn-wide figure.
        const contextOfSection = (section: AgentSection): number | undefined => {
            for (const entry of threads.values()) {
                if (entry.section === section) return (entry.meta ?? blockMeta).context();
            }

            return blockMeta.context();
        };

        // Repaint every think chip in this tile after its block's context moved. The
        // percentages must be shares of the context the HEADERS print, not of whatever
        // figure happened to be current when each round finished, so a `usage` event
        // advances every chip of that block together.
        const syncThinkingShares = (): void => {
            for (const entry of threads.values()) {
                if (entry.section.thinking.length === 0) continue;

                const context = (entry.meta ?? blockMeta).context();
                for (const thought of entry.section.thinking) thought.setContext(context);
            }
        };

        // One streamed reasoning round -> ONE inline think chip in the agent's tool row.
        // The chip is created once per request (the first delta mints it) and repainted
        // with the CUMULATIVE buffer, so the pill, the dialog body and an already-open
        // dialog all agree on the same text without re-parsing anything.
        const appendReasoning = (section: AgentSection, delta: string): void => {
            beginAttempt(section);

            if (section.reasoning === undefined) {
                const card = createReasoningCard();
                // INLINE: the chip joins the same `.tool-group` row the calls use, which
                // is the whole point of the change — `[think][glob][read]` read as one
                // wrapping line. The row is created lazily, so a reasoning-only round
                // still gets exactly one row and prose is never separated by an empty one.
                toolGroupOf(section).append(card.element);
                // Attempt output: a retry removes the chip with the rest, and the dialog
                // it owns is closed by `destroy` below.
                trackNode(section, card.element);
                // Owned for the life of the BLOCK, not the round: `destroy`/
                // `resetProjection` close every dialog this section ever opened.
                section.thinking.push(card);
                // Seeded with the context this block already reports. Providers only
                // report usage per request, so the first round of a turn may have no
                // denominator yet — then the pill stays hidden until a `usage` event
                // arrives, and `syncThinkingShares` fills every chip in at that point.
                card.setContext(contextOfSection(section));
                section.reasoning = { card, buffer: '' };
            }

            // Status line last, exactly like prose.
            if (section.pending !== undefined) section.flow.append(section.pending);

            const block = section.reasoning;
            block.buffer += delta;
            // Plain text, appended in place: no parse, no innerHTML, no sanitizer
            // round-trip for scratch space.
            block.card.setText(block.buffer);
        };

        // Parse an `delegate` call's arguments for the legacy fallback: without
        // the frozen `thread` metadata, the spawning call is the ONLY evidence that
        // an invocation exists and what its prompt was. Only a complete {agent,
        // input} pair is usable; anything else leaves the old flat rendering.
        const delegateOf = (
            rawArguments: string,
            callId: string | undefined
        ): { agent: string; input: string } | undefined => {
            if (callId === undefined) return undefined;

            try {
                const parsed = JSON.parse(rawArguments) as unknown;
                if (parsed === null || typeof parsed !== 'object') return undefined;

                const agent = (parsed as { agent?: unknown }).agent;
                const input = (parsed as { input?: unknown }).input;
                if (typeof agent !== 'string' || agent.length === 0) return undefined;
                if (typeof input !== 'string') return undefined;

                return { agent, input };
            } catch {
                return undefined;
            }
        };

        const appendTool = (
            entry: ThreadEntry,
            name: string,
            rawArguments: string,
            callId: string | undefined,
            at: number | undefined,
            origin: ApplyOrigin
        ): void => {
            const section = entry.section;
            // A tool call is attempt output: a failed attempt's call is discarded
            // with the rest of its stream and was never executed (R3).
            beginAttempt(section);

            // Text written before a tool call is finished text: close it so the
            // card lands *after* it, and so post-tool prose starts a new block.
            closeText(section);

            // A live frame without `at` still deserves a live label; a recorded
            // replay without `eventTimes` must not invent one.
            const startedAt = at ?? (origin === 'live' ? Date.now() : undefined);
            const card = createToolCallCard(name, rawArguments, {
                ...(callId === undefined ? {} : { callId }),
                ...(startedAt === undefined ? {} : { startedAt })
            });

            section.tools.push(card);
            toolGroupOf(section).append(card.element);
            // R1: the CHIP is the attempt-owned unit, not the row it sits in. The row
            // may predate this attempt (it now survives `attempt_commit`/`done`/
            // `wakeup`), so a discard removes this call and keeps the committed ones.
            trackNode(section, card.element);
            // A new call must appear ABOVE the pending summary line, never below it.
            if (section.pending !== undefined) section.flow.append(section.pending);
            const pendingEntry: PendingTool = { card, section, entry, name, callId, startedAt };
            pendingTools.push(pendingEntry);
            toolCount += 1;
            // Record the card (and its own pending entry) as THIS attempt's output,
            // so a discard removes exactly this call and never a sibling's (F2/F5).
            section.attempt?.cards.push(card);
            section.attempt?.pendingEntries.push(pendingEntry);

            // Queued delegation placeholder (legacy fallback, R3): the entry appears
            // WHEN the call is made, under the invocation that made it, and is
            // adopted by its child `start` (or resolved by the parent's result when
            // the delegation is cancelled before the child starts). The key is the
            // spawning call id, which is stable for the whole turn, so a repeated
            // same-agent delegate still yields two distinct entries.
            if (name === 'delegate') {
                const delegate = delegateOf(rawArguments, callId);
                if (delegate !== undefined && callId !== undefined) {
                    const key = `call:${callId}`;
                    if (!threads.has(key)) {
                        createThread({
                            key,
                            agent: delegate.agent,
                            input: delegate.input,
                            callId,
                            parentKey: entry.key,
                            explicitId: undefined,
                            started: false,
                            state: 'queued'
                        });
                        // Record the placeholder on the ATTEMPT that minted it, so a
                        // retry removes exactly this attempt's rows.
                        section.attempt?.createdThreads.push(key);
                    }
                }
            }

            updateMeta();
        };

        // Outcome of applying one `tool_result`: which card it settled (undefined for
        // an ignored duplicate/late frame) and that card's owning section/entry. The
        // caller uses it to prune the per-call pending display without treating an
        // absent `pending` field as a global drain, and to stamp the owning
        // invocation's block clock (R1).
        type ResolvedTool = { entry: ThreadEntry; section: AgentSection; callId: string | undefined };

        const resolveTool = (
            name: string,
            content: string,
            outcome: HarnessToolOutcome,
            callId: string | undefined,
            at: number | undefined,
            origin: ApplyOrigin,
            durationMs: number | undefined
        ): ResolvedTool | undefined => {
            // A result for an id this tile already settled — resolved ok/error, or
            // abandoned when the turn went terminal — is a DUPLICATE/late frame.
            // Ignoring it is what keeps one call to one card: it must not add a
            // second card, overwrite the first answer, or (after a cancel) resurrect
            // a card the runtime already detached.
            if (callId !== undefined && settledCalls.has(callId)) return undefined;

            // The call id is authoritative. The name+oldest fallback is only for a
            // legacy frame that carries no id: with concurrent same-name calls it
            // cannot tell the siblings apart, so using it when an id IS present could
            // settle the wrong sibling.
            const index =
                callId !== undefined
                    ? pendingTools.findIndex(
                          (tool) => tool.callId === callId && tool.card.state() === 'running'
                      )
                    : pendingTools.findIndex(
                          (tool) => tool.name === name && tool.card.state() === 'running'
                      );

            const finishedAt = at ?? (origin === 'live' ? Date.now() : undefined);

            if (index >= 0) {
                const [tool] = pendingTools.splice(index, 1);
                if (tool.callId !== undefined) settledCalls.add(tool.callId);
                // Prefer the server's authoritative span: with concurrent calls the
                // wall-clock gap between this browser's call/result frames includes
                // time spent waiting behind other work, which is not this call's
                // duration. Legacy frames without `durationMs` keep the local span.
                tool.card.resolve(
                    content,
                    outcome,
                    durationMs ?? elapsedBetween(tool.startedAt, finishedAt)
                );
                return { entry: tool.entry, section: tool.section, callId: tool.callId };
            }

            // No running call for this result. Once the turn is terminal, any such
            // frame is LATE (queued before the cancel/end, or a name-only result
            // after it): the runtime ignores results after detaching, so the tile
            // renders nothing rather than a phantom card.
            if (state !== 'streaming' && state !== 'waiting' && state !== 'queued') return undefined;

            // Genuine legacy result-only frame during a live turn (a protocol that
            // reports results without calls, or a missed tool_call): show it rather
            // than dropping information. It belongs to the root invocation when one
            // emitted, otherwise to a truthful flat section for that agent name.
            const owner = threads.get(ROOT_KEY) ?? inlineEntry(primaryAgent ?? UNNAMED_AGENT_PLACEHOLDER);
            const section = owner.section;
            const card = createToolCallCard(name, '');
            card.resolve(content, outcome);
            toolGroupOf(section).append(card.element);
            section.tools.push(card);
            toolCount += 1;
            // F5: this card is attempt output when the attempt window is open, so a
            // retry removes it AND decrements the count it just incremented.
            section.attempt?.cards.push(card);
            // R1: same per-chip ownership as `appendTool` — the shared row it joins
            // may belong to an earlier, already-committed attempt.
            trackNode(section, card.element);
            updateMeta();
            return { entry: owner, section, callId: undefined };
        };

        // Discard everything the browser rendered from a now-superseded event
        // stream. Used only when a server record's event prefix DISAGREES with what
        // the tile applied (the record wins), never on a normal reconnect where the
        // prefix matches and only the remainder is appended.
        const resetProjection = (): void => {
            for (const entry of threads.values()) {
                // The entry's action bar DOM is about to be discarded; remove its
                // board-wide sync callback with it instead of refreshing detached
                // controls after every later roster/snapshot change.
                entry.disposeActionBar();
                // T19 (R17): the same rule for a delegated card's context strip — its bar owns a
                // `ResizeObserver` and possibly an open segment dialog, and both belong to the
                // projection being discarded here.
                entry.disposeContextBar();
                if (entry.section.text !== undefined) cancel(entry.section.text);
                for (const tool of entry.section.tools) tool.destroy();
                // A think chip is the same kind of owned surface as a tool chip: its
                // dialog belongs to the projection being discarded, so closing every
                // one here is what keeps a rebuild from leaving an orphaned modal.
                for (const thought of entry.section.thinking) thought.destroy();
                // Stop the nested clock too: the rebuilt projection creates new
                // entries, and a surviving interval would paint detached DOM forever.
                entry.meta?.stop();
            }

            threads.clear();
            pendingTools.length = 0;
            settledCalls.clear();
            // Cards from the discarded projection must not survive: they would be
            // detached DOM plus a stale clickable request. The rebuilt pass creates
            // fresh cards from the record.
            for (const [requestId, card] of actionCards) {
                card.destroy();
                forgetAnswerCard(requestId);
            }
            actionCards.clear();
            actionAnswers.clear();
            flow.replaceChildren();
            // T7: nothing outside `.tile-flow` belongs to a section any more — the block's
            // single Collapse chevron lives in the section's own footer row, inside this
            // flow — so clearing the flow discards it completely and the replay mints a
            // fresh one with the same constant attributes.
            // Invocation rows live OUTSIDE the tile flow, so clearing the flow alone
            // would leave orphan entries after a superseding record arrives.
            threadHost.replaceChildren();
            primaryAgent = undefined;
            toolCount = 0;
            appliedCount = 0;
            appliedEvents.length = 0;
            // R9/T12b: the steer nodes lived in flows that were just cleared.
            renderedSteers = new Set<number>();
            // Token figures derived from the discarded events must go too; the
            // server tally is re-applied by the caller after the rebuild.
            blockMeta.clearUsage();
            // The rebuilt pass re-creates the SAME conversation-scoped labels: reset
            // to the tile's captured base seed and replay the record in order. Using
            // the live board counters here would let later tiles' allocations push
            // this tile's numbers up (R6: revisiting a thread never renumbers it).
            // A tile that never allocated has no captured seed yet; its first
            // allocation will capture the current base lazily (`nextLabel`).
            labels.reset();
            if (labelSeed !== undefined) labels.seed(labelSeed);
            // The root code belongs to the discarded projection: hide it until the
            // replay's `rootSection` names the root agent again (F3).
            tileAgent.textContent = '';
            tileAgent.hidden = true;
            syncRootAgentVisibility();
        };

        // --- display-wire (compiled) rendering (T5: R1/R2/R3) -------------
        //
        // The DEFAULT browser path. A tile painted here never reads a
        // `HarnessEvent`: the row comes from `TurnSummary` and the flow comes from
        // `TurnDisplay`, both authored by the server's projector
        // (src/server/turn-projector.ts), and every later frame is an op ADDRESSED by
        // id (src/shared/turn-display.ts:499). That is what makes a reload, a live
        // stream and a reconnected observer render the same DOM from the same ids,
        // with no compilation, no call-by-name pairing and no event list on the wire.
        //
        // Identity maps (the only lookup keys this path uses):
        //   - `compiledSections`: server section id -> the invocation entry that owns
        //     that section's DOM (the root maps to the tile's own ROOT_KEY entry);
        //   - `compiledHandles`: `${sectionId}\0${nodeId}` -> the painted handle, so
        //     `node:append`/`node:set`/`node:remove`/`step:set` reach the exact
        //     surface without searching.
        type CompiledHandle =
            | {
                  kind: 'text';
                  sectionId: string;
                  entry: ThreadEntry;
                  node: HTMLElement;
                  // T22 (R23): the node id beside the element, so "is THIS the block the
                  // section is allowed to print?" is an id comparison against the server's
                  // tail — never a DOM position or a text match.
                  nodeId: string;
              }
            | { kind: 'reasoning'; sectionId: string; entry: ThreadEntry; card: ReasoningCard }
            | {
                  kind: 'step';
                  sectionId: string;
                  entry: ThreadEntry;
                  card: ToolCallCard;
                  step: DisplayStep;
              }
            // T11 (R7): a recorded call that the CONTEXT BAR owns instead of a card. The
            // handle still exists, because the ops path addresses steps by id and must be
            // able to find this one (`step:set`, `attempt:discard`, a section rebuild); it
            // simply owns no DOM. `syncCompiledNode` keeps it pointed at the server's latest
            // `DisplayStep`, and the bar segment it stands for is repainted from
            // `TurnSection.context`, which the same frame updates.
            | { kind: 'implicit'; sectionId: string; entry: ThreadEntry; step: DisplayStep }
            // T22 (R23): a thinking window the BAR owns outright. The strip carries the
            // segment and the section's ONE tail body carries the text while this node is
            // the newest content block, so no chip is minted in the flow at all — which is
            // precisely what stops a long run printing a stale chip per window. It is NOT
            // an `implicit` step: dropping it must never move the tool tally, and it never
            // resolves a card. The handle exists so `node:append`, `node:set`, `node:remove`
            // and `attempt:discard` resolve to the section that owns the tail rather than
            // falling through as an unknown node.
            | { kind: 'tail'; sectionId: string; entry: ThreadEntry; nodeId: string }
            | {
                  kind: 'action';
                  sectionId: string;
                  entry: ThreadEntry;
                  card: ActionRequestCard;
                  step: DisplayStep;
              }
            | { kind: 'notice'; sectionId: string; entry: ThreadEntry; node: HTMLElement };

        const compiledSections = new Map<string, ThreadEntry>();
        const compiledHandles = new Map<string, CompiledHandle>();
        // The compact row this tile was last painted from: blocks (the `#` popup),
        // steers (routing), attachments (chips) and usage all come from it, so no
        // invocation walk is needed to answer those questions.
        let compiledSummary: TurnSummary | undefined;
        // True once anything was painted from the display wire. The raw event fold
        // and this renderer never share a tile: a view-driven tile has no events.
        let compiledMode = false;

        // --- one context bar per SECTION (T11 R7/R8, per-section since T19 R17) ---------
        //
        // What it replaces: one `.tool` card per recorded call, each with its own timer,
        // its own expansion and its own Markdown work. A long turn printed hundreds of
        // them, and that is the wall this bar stands in front of. The bar carries the SAME
        // information per call — name, kind, whether it failed, how long it took, how many
        // characters it contributed — as one strip of segments whose widths are the exact
        // character distribution, and it opens the recorded bytes of ANY segment (prompt,
        // instructions, thinking, an earlier answer, a tool call) on one click.
        //
        // It is driven ONLY by `TurnSection.context`, never by the node tree: pairing a step
        // with a segment locally is the compilation this wire removed.
        //
        // T19 (R17) moves the ownership boundary from the tile to the SECTION. The tile's
        // strip describes the turn's OWN (root) section, and every delegated section carries
        // a surface inside its own card. Aggregating the delegates into the caller's strip was
        // the defect this closes: a delegated conversation had no bar of its own to read, and
        // clicking one of its calls opened a segment owned by a different block.
        //
        // The last tree this tile painted from. The ops path needs it to recompute the bars
        // (a frame carries ops, not the whole document) and to rebuild the flows when a bar
        // takes over from the chips mid-run.
        let compiledDisplay: TurnDisplay | undefined;

        // The model for ONE section, built by the SAME function the tree-level strip uses:
        // `contextBarOf` reads only `turnId` and `sections`, so a one-section tree IS a
        // one-section bar. No second compiler, and the recorded order inside the section is
        // still the server's (../view-context.ts rule 1).
        const sectionContextModel = (
            turnId: string,
            section: TurnSection | undefined
        ): ContextBarModel =>
            contextBarOf(section === undefined ? undefined : { turnId, sections: [section] });

        // Every surface this tile owns, in creation order. T11's rule that one activation
        // REPLACES the reader's segment rather than stacking a second modal over the same turn
        // was enforced by a single tile-wide dialog pointer; with one strip per section the same
        // guarantee needs the list, because the dialog to replace may belong to a sibling card.
        const contextBarSurfaces: ContextBarSurface[] = [];

        /**
         * Mount one bar surface over one `.context-bar-host`.
         *
         * A surface owns three things, and keeping them per section is the whole point: the
         * model (which decides cards-vs-segments for THAT section), the bar (its
         * `ResizeObserver` and pointer/keyboard listeners), and the segment dialog opened from
         * that strip. Per-section tracking is what makes a metadata change refresh, and a
         * section discard close, the RIGHT dialog; a click still shows one segment at a time,
         * because `openSegment` replaces whichever strip in this tile the reader had open.
         *
         * T22 (R23) adds a fourth owned surface inside the SAME host: this section's ONE
         * current tail body, mounted directly after the strip. It is owned per section for
         * exactly the reason the strip is — a delegated conversation's thinking must never
         * print inside its caller's block, and one host can only ever hold one body, so a
         * long run cannot accumulate the pile of stale think chips the strip replaced.
         */
        const createContextBarSurface = (host: HTMLElement): ContextBarSurface => {
            let model: ContextBarModel | undefined;
            let bar: ContextBar | undefined;
            // The one segment dialog THIS surface opened. Kept so a metadata change can
            // refresh it and a teardown can close it — never so that a second one can stack.
            let detail: { dialog: BlockDetailDialog; fingerprint: string } | undefined;

             // --- the current tail body (T22, R23; widened by T23) ----------------------
            // Minted once per surface and re-appended after the strip, so the element that
            // prints the newest block is ALWAYS the element right after the graph.
            const tail = document.createElement('div');
            tail.className = 'context-bar-tail';
            tail.hidden = true;

            const tailCaption = document.createElement('p');
            tailCaption.className = 'context-bar-tail-caption';
            tailCaption.textContent = '';

            const tailBody = document.createElement('div');
            tailBody.className = 'context-bar-tail-body';

            tail.append(tailCaption, tailBody);

            // Which body this element currently prints. Streaming calls `paintTail` on every
            // frame of the round, so this key is what makes a repaint of unchanged state cost
            // no DOM work at all.
            let tailKey: string | undefined;

            const clearTail = (): void => {
                tailKey = undefined;
                tail.hidden = true;
                delete tail.dataset.kind;
                delete tail.dataset.nodeId;
                delete tail.dataset.blockId;
                delete tail.dataset.chars;
                delete tail.dataset.truncated;
                delete tail.dataset.state;
                delete tail.dataset.duration;
                delete tail.dataset.argsChars;
                delete tail.dataset.resultChars;
                delete tail.dataset.panels;
                delete tail.dataset.media;
                tailCaption.textContent = '';
                tailBody.replaceChildren();
            };

            // One labelled pane of the current call's body, and its stated absence. The
            // record holds no arguments for a result-only frame and no result while the call
            // is running, and each of those is an ANSWER the reader deserves to see spelled
            // out rather than a blank box (the rule `ui/context-detail.ts` applies to the
            // same two fields in the dialog).
            const createTailPane = (label: string, pane: string, value: string | undefined, absence: string): HTMLElement => {
                const section = document.createElement('div');
                section.className = 'context-bar-tail-pane';
                section.dataset.pane = pane;

                const heading = document.createElement('p');
                heading.className = 'context-bar-tail-pane-label';
                heading.textContent = label;
                section.append(heading);

                if (value === undefined) {
                    const note = document.createElement('p');
                    note.className = 'context-bar-tail-pane-note';
                    note.dataset.note = absence;
                    note.textContent = absence === 'no-result'
                        ? 'no result recorded for this call yet'
                        : absence === 'empty-result'
                          ? 'this call recorded an empty result'
                          : 'no arguments recorded for this call';
                    section.append(note);

                    return section;
                }

                // Plain text, never Markdown and never a highlighter: these are recorded
                // bytes, and this path parses no model-written markup (the think chip's rule
                // verbatim). `textContent` also keeps the pane byte-identical to the payload.
                const body = document.createElement('pre');
                body.className = 'context-bar-tail-pane-body';
                body.dataset.field = pane;
                body.textContent = value;
                section.append(body);

                return section;
            };

            /**
             * Print the section's current block in full, or hide the body.
             *
             * An `assistant` tail deliberately prints NOTHING here: its full text is the
             * section's designated answer node, and the flow already renders that in the
             * `.agent-text` block immediately below this host — the existing full-answer
             * surface R23 points at. A thinking window and a recorded call DO need a body
             * minted at the tail of the strip, because the think chip and the tool card that
             * used to hold them are the wall this bar replaced.
             */
            const paintTail = (next: ContextTail | undefined): void => {
                if (next === undefined || next.kind === 'assistant') {
                    clearTail();

                    return;
                }

                const kind = next.kind === 'tool' ? next.tool : undefined;

                // A designation whose payload vanished (a legacy producer, a malformed frame)
                // has no body to print; hiding the element is honest, inventing one is not.
                if (next.kind === 'tool' && kind === undefined) {
                    clearTail();

                    return;
                }

                // Prose compares its text (the body IS the text); a call compares the
                // payload sizes and the server's figures, because its bytes are minted once
                // per recorded event and can only move by one arriving.
                const key =
                    next.kind === 'tool'
                        ? `tool|${next.nodeId}|${next.blockId ?? ''}|${next.chars}|${next.truncated}|${kind?.state ?? ''}|${kind?.durationMs ?? -1}|${kind?.args?.length ?? -1}|${kind?.result?.length ?? -1}|${kind?.panelCount ?? 0}|${kind?.mediaCount ?? 0}`
                        : `${next.kind}|${next.nodeId}|${next.blockId ?? ''}|${next.chars}|${next.truncated}|${next.text}`;

                if (key === tailKey) return;

                tailKey = key;
                tail.hidden = false;
                tail.dataset.kind = next.kind;
                tail.dataset.nodeId = next.nodeId;
                if (next.blockId === undefined) delete tail.dataset.blockId;
                else tail.dataset.blockId = next.blockId;
                // The EXACT recorded length and the honest truncation state, both from the
                // server's figures: a bounded body says so instead of letting a prefix read
                // as the whole block.
                tail.dataset.chars = String(next.chars);
                tail.dataset.truncated = next.truncated ? 'true' : 'false';
                tailCaption.textContent = contextTailCaptionOf(next);

                if (next.kind === 'reasoning') {
                    delete tail.dataset.state;
                    delete tail.dataset.duration;
                    delete tail.dataset.argsChars;
                    delete tail.dataset.resultChars;
                    delete tail.dataset.panels;
                    delete tail.dataset.media;
                    // Plain text, never Markdown — the think chip's rule verbatim: scratch
                    // space can contain anything the model wrote, and this path parses no HTML.
                    tailBody.textContent = next.text;

                    return;
                }

                // The current call: its own status, then its complete recorded request and
                // response, one pane each. R23 — a call IS a block, so it gets the same full
                // body at the tail a thinking window or an answer gets.
                tail.dataset.state = kind?.state ?? 'running';
                if (kind?.durationMs === undefined) delete tail.dataset.duration;
                else tail.dataset.duration = String(kind.durationMs);
                tail.dataset.argsChars = String(kind?.argsChars ?? 0);
                if (kind?.resultChars === undefined) delete tail.dataset.resultChars;
                else tail.dataset.resultChars = String(kind.resultChars);
                tail.dataset.panels = String(kind?.panelCount ?? 0);
                tail.dataset.media = String(kind?.mediaCount ?? 0);
                tailBody.replaceChildren(
                    createTailPane('arguments', 'args', kind?.args, 'no-args'),
                    createTailPane(
                        'result',
                        'result',
                        kind?.result,
                        kind?.hasResult === true ? 'empty-result' : 'no-result'
                    )
                );
            };

            /** True when the bar, not the chip wall, is this section's tool surface. */
            const driven = (): boolean => model !== undefined && contextBarReplacesChips(model);

            // Opens one segment's full detail: the ONLY place the block route is called.
            const openSegment = (input: ContextBarActivateInput): void => {
                const loader = options.loadBlockDetail;
                // The block names its own turn (the route's key), and an optimistic tile has
                // no `serverId` yet, so the block's value is the primary and the tile's is the
                // fallback — never a guess from stream position. A delegated segment carries
                // the SAME turn id as its caller's, because one `TurnDisplay` is one turn; the
                // block id is what makes the answer this section's and not the tile's.
                const turnId = input.block.turnId.length > 0 ? input.block.turnId : (serverId ?? '');

                // A second activation replaces the reader's segment instead of stacking a
                // second modal over the same turn (ui/dialog.ts would happily stack them). T19
                // keeps that promise across sections: the strip the reader just clicked is the
                // one they are asking about, so this surface's dialog AND any sibling section's
                // dialog close first, while each surface still tracks its own for refresh and
                // teardown.
                for (const other of contextBarSurfaces) other.closeDetail();

                const dialog = openBlockDetail({
                    block: input.block,
                    turnId,
                    ...(boundSession === undefined ? {} : { sessionId: boundSession }),
                    ...(loader === undefined ? {} : { load: loader })
                });

                detail = { dialog, fingerprint: blockDetailFingerprintOf(input.block) };
                host.dataset.open = dialog.blockId;
            };

            // Repaint the open segment from this section's CURRENT metadata, and only when that
            // metadata actually moved. A running call's `context:set` frames arrive with every
            // argument byte, so an unconditional refresh would re-issue the detail request on
            // every frame; the fingerprint is what makes "refresh when the answer could have
            // changed" both honest and cheap. A block the section dropped CLOSES its dialog,
            // because the bytes on screen are no longer part of this block.
            const refresh = (): void => {
                const open = detail;

                if (open === undefined || !open.dialog.isOpen()) {
                    detail = undefined;

                    return;
                }

                const next = model?.blocks.find((block) => block.id === open.dialog.blockId);

                if (next === undefined) {
                    open.dialog.close();
                    detail = undefined;
                    delete host.dataset.open;

                    return;
                }

                const fingerprint = blockDetailFingerprintOf(next);
                if (fingerprint === open.fingerprint) return;

                detail = { dialog: open.dialog, fingerprint };
                open.dialog.refresh(next);
            };

            const sync = (section: TurnSection | undefined, turnId: string): boolean => {
                const wasDriven = driven();
                const next = sectionContextModel(turnId, section);

                model = next;

                if (!next.available) {
                    // A pre-T9 record, or a frame that says nothing about THIS section: destroy
                    // the strip and let this section's step cards render the way they always did.
                    // The tail body goes with it: a section with no strip has no tail end to
                    // print a block at, and its chip/prose flow keeps rendering as it always did.
                    if (bar !== undefined) {
                        bar.destroy();
                        bar = undefined;
                    }

                    clearTail();
                    host.replaceChildren();
                    host.hidden = true;
                    delete host.dataset.turnId;
                    delete host.dataset.sectionId;
                    delete host.dataset.segments;

                    return wasDriven;
                }

                if (bar === undefined) {
                    bar = mountContextBar({ onActivate: openSegment });
                    host.append(bar.element);
                }

                // The tail body is ALWAYS the host's last child, so the newest block reads as
                // the tail of the strip instead of a chip left under older content (R23).
                if (host.lastElementChild !== tail) host.append(tail);

                bar.setModel(next);
                host.hidden = false;
                host.dataset.turnId = turnId;
                // Provenance, readable without a second lookup: WHICH section this strip
                // describes, and how many segments it carries.
                if (section !== undefined) host.dataset.sectionId = section.id;
                host.dataset.segments = String(next.blocks.length);
                // R23: the ONE body this section prints, taken straight from the server's
                // order. Doing it HERE is what makes a hydration render, an ops frame and a
                // reconnect land on the same single block with no second code path.
                paintTail(driven() ? contextTailOf(section) : undefined);
                refresh();

                return wasDriven !== driven();
            };

            // Closes ONLY this surface's dialog and leaves the strip mounted. `openSegment`
            // calls it on every surface this tile owns, so one click replaces whichever segment
            // the reader had open, whichever section's strip held it.
            const closeDetail = (): void => {
                detail?.dialog.close();
                detail = undefined;
                delete host.dataset.open;
            };

            const destroy = (): void => {
                // The dialog is the user-visible half: a discarded section must not leave its
                // modal behind with an already-detached strip (a focus trap and the counted
                // body scroll lock would survive the card that owned it).
                closeDetail();

                if (bar !== undefined) {
                    bar.destroy();
                    bar = undefined;
                }

                // The tail body is the user-visible half of the surface: its text must go
                // with the host, or a rebuilt card could read the previous section's block.
                clearTail();
                host.replaceChildren();
                host.hidden = true;
                delete host.dataset.turnId;
                delete host.dataset.sectionId;
                delete host.dataset.segments;
                model = undefined;

                // Out of the tile's list too: a rebuilt projection mints fresh surfaces, and a
                // dead one left behind would be asked to close a dialog it no longer owns.
                const index = contextBarSurfaces.indexOf(surface);
                if (index >= 0) contextBarSurfaces.splice(index, 1);
            };

            const surface: ContextBarSurface = {
                host,
                sync,
                driven,
                // R23: the ops path repaints the body straight from an addressed node when a
                // frame arrives without a tree, so `paintTail` is part of the surface contract.
                setTail: paintTail,
                refresh,
                closeDetail,
                destroy
            };
            contextBarSurfaces.push(surface);

            return surface;
        };

        // The tile's own surface: the turn's ROOT section strip, in `.tile-body` between the
        // prompt and the flow (exactly where T11 mounted it; only its CONTENT narrowed).
        // No tile-wide "is the bar driving?" accessor survives: T19 made that answer per
        // section, and `paintCompiledStep` asks the surface that owns the step.
        const tileContextBar = createContextBarSurface(contextBarHost);

        // Which section of a tree the TILE's strip describes. The two server figures that say
        // this are the same ones `compiledEntryOf` uses to decide which surface a section's
        // nodes land in, and they are checked in the same order, so a section can never be
        // "root" to the bar and "nested" to the flow:
        //   - `role === 'primary'` (turn-display.ts:199, the entry agent's own flow);
        //   - otherwise the FIRST section when it has no `parentSectionId` — the projector
        //     allocates the turn's own flow before anything nested (turn-display.ts:445).
        // A tree with neither (an empty or legacy document) has no root strip to paint.
        const rootSectionOf = (display: TurnDisplay | undefined): TurnSection | undefined => {
            const sections = sectionsOf(display);
            const primary = sections.find((section) => section.role === 'primary');
            if (primary !== undefined) return primary;

            const first = sections[0];

            return first !== undefined && first.parentSectionId === undefined ? first : undefined;
        };

        /**
         * Re-derive EVERY strip this tile owns from the tree it is painting (T19, R17).
         *
         * `undefined` (an ops frame with no document to read) leaves every bar exactly as it
         * was: the terminal `view` frame is the documented reconciler, so keeping the last
         * authoritative strip beats redrawing it from a guess.
         *
         * Returns true when ANY section took over from (or handed back) its chip wall — the
         * one moment in which the flows already on screen are known to be the wrong shape.
         */
        const syncContextBar = (display: TurnDisplay | undefined): boolean => {
            if (display === undefined) return false;

            compiledDisplay = display;

            let flipped = tileContextBar.sync(rootSectionOf(display), display.turnId);

            // A delegated strip lives on ITS card, so the same tree repaints it through the
            // entry that owns it. `compiledSections` is the only join, and a section seen for
            // the FIRST time is not in it yet — `compiledEntryOf` syncs a brand-new surface
            // itself at creation, which is what keeps the first paint already in the right
            // mode instead of rebuilding twice.
            for (const entry of compiledSections.values()) {
                const surface = entry.contextBar;
                if (surface === undefined || surface === tileContextBar) continue;

                const section = sectionsOf(display).find((candidate) => candidate.id === entry.key);
                flipped = surface.sync(section, display.turnId) || flipped;
            }

            return flipped;
        };

        // Rebuild every painted section's flow from the tree. Needed exactly once per turn:
        // the FIRST context frame converts a tile that had already painted step cards into a
        // bar-driven one (and the reverse when a reconcile drops the metadata). It reuses the
        // documented whole-section repaint, so handles, attempt ownership and the pending
        // snapshot stay consistent with the tree rather than with what was on screen.
        const rebuildCompiledFlow = (): void => {
            if (compiledDisplay === undefined) return;

            for (const [sectionId, entry] of [...compiledSections]) {
                const section = sectionsOf(compiledDisplay).find((candidate) => candidate.id === sectionId);
                if (section === undefined) continue;

                renderCompiledSection(entry, section);
            }

            updateMeta();
        };

        const compiledKeyOf = (sectionId: string, nodeId: string): string =>
            `${sectionId}\u0000${nodeId}`;

        // `SectionDisplayState` -> the row vocabulary. `open` (started, nothing
        // committed yet) reads as running, exactly as the fold painted a `start`
        // frame; the terminal three pass through. No inference — the server decided.
        const sectionThreadState = (value: SectionDisplayState): ThreadState =>
            value === 'done'
                ? 'done'
                : value === 'error'
                  ? 'error'
                  : value === 'cancelled'
                    ? 'cancelled'
                    : 'streaming';

        // `StepDisplayState` -> the tool card's outcome vocabulary. `DisplayStep.outcome`
        // is authoritative when present (turn-display.ts:326); the state is the
        // fallback, never a re-derivation from an `isError` boolean.
        const stepOutcomeOf = (step: DisplayStep): HarnessToolOutcome =>
            step.outcome ??
            (step.state === 'ok' ? 'completed' : step.state === 'cancelled' ? 'cancelled' : 'failed');

        // The entry that owns one server section, creating it on first sight.
        //
        // `display` is the compiled tree this tile is painting (the whole-tree paths have
        // it; an ops frame carries the store's post-state tree). It is what separates the
        // turn's own flow from a nested one whose parent the runtime never named.
        const compiledEntryOf = (section: TurnSection, display?: TurnDisplay): ThreadEntry => {
            const known = compiledSections.get(section.id);
            if (known !== undefined) return known;

            compiledMode = true;

            // The ROOT flow is the turn's own section; every other section is a nested
            // invocation with its own row. Two server figures say this, and either wins:
            //   - `role === 'primary'` (turn-display.ts:199, the entry agent's own flow);
            //   - NO `parentSectionId` (turn-display.ts:397) ON THE SECTION THE TREE ORDERS
            //     FIRST — the projector allocates the turn's own flow before anything nested
            //     (turn-display.ts:445), so "first and parentless" IS the root.
            //
            // `role` alone is not enough: a PERSISTENT CHILD conversation owns turns of its
            // own whose root run is that CHILD's agent, and the projector stamps that section
            // `role: 'subagent'` (`agent === context.primary` compares against the ENTRY
            // agent, turn-projector.ts:450). The tile is still that turn's exchange, so its
            // flow belongs in `.tile-flow`, never in an indented `.thread-row` — the same
            // discrimination the raw fold makes with `isConversationRoot` (turns.ts:4043) and
            // the rule thread-conversation-shell.test.ts pins.
            //
            // The position test matters the other way too: a branch/fork of the root ALSO has
            // no `parentSectionId` (`HarnessThread.parentId` is "omitted for a direct child of
            // the root", types/index.ts:1664), and only its place after the root keeps it a
            // nested row. With no tree to order against (an ops frame that arrived without
            // one), the honest equivalent is "this tile has no root flow yet".
            const root =
                section.role === 'primary' ||
                (section.parentSectionId === undefined &&
                    (display !== undefined
                        ? sectionsOf(display)[0]?.id === section.id
                        : threads.get(ROOT_KEY) === undefined));
            let entry: ThreadEntry;

            if (root) {
                // The root section IS the tile body: `rootSection` mints the
                // `.tile-flow` surface and registers it under ROOT_KEY, so the tile
                // remains the single owner of this conversation's DOM (every
                // expansion/focus/copy behaviour already keys off that entry).
                rootSection(section.agent);
                const rootEntry = threads.get(ROOT_KEY);
                // `rootSection` always registers ROOT_KEY; `inlineEntry` is the honest
                // fallback rather than an assertion, so a broken invariant degrades to
                // a flat block instead of throwing inside a render pass.
                entry = rootEntry ?? inlineEntry(section.agent);

                // The root header's agent code comes from the server's label, so the
                // conversation-scoped allocator is not consulted at all here.
                if (section.agentLabel.length > 0) {
                    tileAgent.textContent = section.agentLabel;
                    tileAgent.hidden = false;
                    syncRootAgentVisibility();
                }

                // T19 (R17): this entry's steps are owned by the TILE's strip. Assigned here
                // rather than in `rootSection`, because the defensive `inlineEntry` fallback
                // takes the same branch — whichever entry ends up owning the root flow is the
                // one whose steps the root strip replaces. `disposeContextBar` stays the
                // literal's no-op: the tile owns that surface and destroys it with the tile.
                entry.contextBar = tileContextBar;
            } else {
                entry = createThread({
                    // The server's section id is the card's identity: stable across a
                    // restart (turn-display.ts:50) and opaque by contract, so nothing
                    // here parses it.
                    key: section.id,
                    agent: section.agent,
                    // T5 R1: `TurnSection` carries no delegated-task text, so the row shows the
                    // COMPACT roster's bounded transcript preview
                    // (`SessionThreadView.preview`, protocol.ts:424), joined on the invocation /
                    // persistent-thread identity — the same key the card itself is addressed by
                    // (`explicitId` below), never the section id, which the roster does not know.
                    // With neither available the row keeps its neutral 'delegated task' preview
                    // instead of re-deriving a prompt from a bounded `argsPreview` string.
                    input: rosterClaimOf(section.invocationId ?? section.threadId ?? section.id)?.preview,
                    callId: undefined,
                    // A direct child of the turn's own flow has no `parentSectionId` (see above),
                    // and its parent surface is the tile body — registered under ROOT_KEY.
                    parentKey: section.parentSectionId ?? ROOT_KEY,
                    explicitId: section.invocationId ?? section.threadId,
                    started: section.state !== 'open',
                    state: sectionThreadState(section.state),
                    branchId: section.branchId
                });
            }

            compiledSections.set(section.id, entry);

            // T19 (R17): point this section's OWN strip at itself BEFORE its steps are painted,
            // so the very first pass already knows whether this section draws segments or
            // cards. `display` can be absent (an ops frame that arrived without a tree); the
            // strip's turn figure then falls back to the id this tile is bound to, and the next
            // tree repaint corrects it. A section carrying no `context` array leaves the host
            // hidden and keeps its step cards, exactly as a legacy turn always did.
            entry.contextBar?.sync(section, display?.turnId ?? serverId ?? '');

            paintCompiledSection(entry, section);

            return entry;
        };

        // Paint a section's server-authored identity: label, nesting, role, thread
        // join, model, clock and token figures. Everything ARRIVES; the local label
        // allocator and the roster invocation join are the raw path's fallbacks and
        // are deliberately not consulted first.
        const paintCompiledSection = (entry: ThreadEntry, section: TurnSection): void => {
            // T22 (R23): the reducer mutates THIS object in place, so holding the reference
            // is what lets a later ops frame — including one that arrives with no document —
            // re-derive this section's single displayed content block from server state
            // rather than from what happens to be on screen.
            entry.compiledSection = section;

            if (entry.key !== ROOT_KEY && section.agentLabel.length > 0)
                paintEntryLabel(entry, section.agentLabel);

            // The persistent conversation this invocation belongs to. The server
            // names it, so the join is data rather than a roster/`invocationIds`
            // inference; the board-level map still holds it, because child focus,
            // the badge and delete protection all read that one source.
            if (section.threadId !== undefined && section.threadId.length > 0)
                learnedThreads.set(entry.key, section.threadId);

            // The server names the persistent conversation on the section when it can resolve one.
            // When it does not (a delegated child whose identity only the roster holds), the join
            // falls back to the raw path's rule: claim the roster row by the section's RUNTIME
            // identity — `rosterClaimOf` matches `invocationId` / `originInvocationId` /
            // `invocationIds`, and the section id is never one of those, so a claim here is proof,
            // never a guess.
            if (section.threadId === undefined || section.threadId.length === 0) {
                const claimed = rosterClaimOf(section.invocationId ?? section.threadId ?? section.id);
                if (claimed !== undefined) learnedThreads.set(entry.key, claimed.id);
            }

            if (entry.key !== ROOT_KEY && section.threadId !== undefined && section.threadId.length > 0)
                entry.explicitId = section.invocationId ?? section.threadId;

            if (section.model !== undefined && section.model.length > 0)
                entry.section.root.dataset.model = section.model;

            // R3: only the structural role attribute; there is no visible badge.
            entry.section.root.dataset.role = section.role;

            const meta = entry.meta;
            if (meta !== undefined) {
                const hasStart = section.startedAt !== undefined;
                const hasEnd = section.endedAt !== undefined;
                if (hasStart || hasEnd)
                    meta.settle({
                        ...(hasStart ? { startedAt: section.startedAt } : {}),
                        ...(hasEnd ? { endedAt: section.endedAt } : {})
                    });

                meta.setFigures({
                    ...(section.latestInput === undefined ? {} : { latestInput: section.latestInput }),
                    ...(section.cachedInput === undefined ? {} : { cachedInput: section.cachedInput })
                });
            }

            setThreadState(entry, sectionThreadState(section.state));
            // A terminal section is closed by the server, so its row gets the same
            // terminal treatment (outcome wording) the fold gave a `done`/`error`.
            if (isTerminalThread(entry.state)) completeThread(entry, entry.state);

            updateMeta();
        };

        // One notice line. The tone selects the existing surface so a wake, an error and the
        // quieter notes keep the DOM vocabulary the styles and the tests already pin.
        //
        // T19 (R19): a `retry` tone renders NOTHING. A transient model-request retry is
        // internal — the runtime re-sent one request and the run went on — so a line per
        // attempt is chatter the reader never acts on, and T16 already stopped the server
        // minting one (turn-display.ts `DisplayNoticeTone`). The tone still arrives from an
        // OLDER imported/compiled document that recorded the notice as a node, and the browser
        // has to be silent about it too: "no retry line" is a rendering rule for every render
        // path, not only for the projector. The distinction is the tone, never the words — a
        // budget actually running out is an `error`-tone notice (../core/agent.ts:604) and that
        // one is the outcome the reader acts on, so it still prints.
        const paintCompiledNotice = (
            entry: ThreadEntry,
            node: DisplayNoticeNode
        ): CompiledHandle | undefined => {
            if (node.tone === 'retry') return undefined;

            const section = entry.section;

            // A notice is readable prose between chips, so it breaks the chip run —
            // the same rule the retry/error paths already apply.
            closeText(section);
            closeToolGroup(section);

            const line = el('div', 'agent-notice');
            line.dataset.tone = node.tone;
            line.append(el('span', 'agent-notice-label', node.tone));
            line.append(el('span', 'agent-notice-text', node.text));
            if (node.at !== undefined) line.dataset.at = String(node.at);
            section.flow.append(line);

            const handle: CompiledHandle = {
                kind: 'notice',
                sectionId: entry.key,
                entry,
                node: line
            };
            compiledHandles.set(compiledKeyOf(entry.key, node.id), handle);

            return handle;
        };

        // One tool call / owner question, from the compact row's step.
        //
        // R2: the card is built from PREVIEWs (`argsPreview`, `preview`) and gets a
        // lazy detail source, so the exact recorded request+response is fetched by
        // the card on the reader's first expansion — never while the board renders.
        const paintCompiledStep = (entry: ThreadEntry, step: DisplayStep): CompiledHandle => {
            // An owner question reuses the interactive card, built from the bounded
            // `DisplayActionSummary` the server sends inline (answering must not cost
            // a round trip).
            if (step.kind === 'action') return paintCompiledAction(entry, step);

            // T11 (R7) / T19 (R17): when THIS section's context is server-described, a recorded
            // call is ONE SEGMENT of that section's bar, not a card. Everything that is not the
            // card still happens: the block's tool tally, the authoritative pending snapshot and
            // the settled-call prune feed the meta line and the status row, which the bar does
            // not replace. What goes is the card itself — its DOM, its live timer, its preview
            // Markdown and its own lazy step-detail source, because the bar segment's click buys
            // the same exact recorded bytes through the block route.
            //
            // The check is per section on purpose: a caller that described its context and a
            // callee that did not are two different surfaces, and swallowing the second one's
            // cards on the first one's evidence would hide real information.
            if (entry.contextBar?.driven() === true) {
                toolCount += 1;

                // Read from `entry.section` directly: the card path below declares its own
                // `section` binding, and this branch runs before it.
                const owner = entry.section;
                if (Array.isArray(step.pending)) paintPending(owner, step.pending);
                if (step.state !== 'running' && step.callId !== undefined) noteSettled(owner, step.callId);

                const implicit: CompiledHandle = { kind: 'implicit', sectionId: entry.key, entry, step };
                compiledHandles.set(compiledKeyOf(entry.key, step.id), implicit);

                return implicit;
            }

            const section = entry.section;
            const startedAt = step.startedAt;

            // The loader is wired per step, and the card calls it at most once, on
            // expand. An unwired board (a standalone embed, a test) keeps the
            // previews and simply performs no request.
            const loader = options.loadStepDetail;
            const detail =
                loader === undefined || step.turnId.length === 0
                    ? undefined
                    : {
                          truncated: step.detail.truncated || step.detail.hasResult,
                          load: async () => {
                              const fetched = await loader({
                                  ...(boundSession === undefined ? {} : { sessionId: boundSession }),
                                  turnId: step.turnId,
                                  stepId: step.id
                              });

                              return stepDetailPayloadOf(fetched);
                          }
                      };

            const card = createToolCallCard(
                step.name,
                // The bounded preview stands in for the raw arguments until the
                // detail arrives; `previewArguments` keeps it one line.
                step.argsPreview ?? '',
                {
                    ...(step.callId === undefined ? {} : { callId: step.callId }),
                    ...(startedAt === undefined ? {} : { startedAt })
                },
                {
                    ...(options.readFile === undefined ? {} : { readFile: options.readFile }),
                    ...(detail === undefined ? {} : { detail })
                }
            );

            // The card is attempt-owned exactly like a folded call, so a server
            // `attempt:discard` that names this node removes this chip and nothing
            // else (the raw path's per-chip ownership, reused verbatim).
            section.tools.push(card);
            toolGroupOf(section).append(card.element);
            trackNode(section, card.element);
            if (section.pending !== undefined) section.flow.append(section.pending);
            toolCount += 1;

            // A settled step freezes the card with the server's figures; a running
            // one stays live and keeps ticking from `startedAt`.
            if (step.state === 'running') {
                // `pending` on the step is that agent's authoritative snapshot
                // (absence = "this frame says nothing", an empty array = drained).
                if (Array.isArray(step.pending)) paintPending(section, step.pending);
            } else {
                const outcome = stepOutcomeOf(step);

                if (step.state === 'cancelled')
                    card.abandon(
                        'Cancelled before the call returned.'
                    );
                else
                // The span is the SERVER's figure in both of its shapes: the measured
                // `durationMs` when the recorded result carried one, otherwise the span between
                // the step's own `startedAt` and `endedAt` (the projector stamps both from the
                // recorded `eventTimes`). This is the raw path's rule verbatim
                // (`durationMs ?? elapsedBetween(startedAt, finishedAt)`, turns.ts:5024-5028);
                // passing `undefined` here would leave the card ticking from `startedAt` to NOW,
                // which prints an absurd elapsed time for a recorded call.
                card.resolve(step.preview ?? '', outcome, step.durationMs ?? elapsedBetween(step.startedAt, step.endedAt));

                // The call settled, so it is no longer part of the pending snapshot —
                // the same scoped prune the raw path performs on a `tool_result`.
                if (step.callId !== undefined) noteSettled(section, step.callId);
                if (Array.isArray(step.pending)) paintPending(section, step.pending);
            }

            const handle: CompiledHandle = {
                kind: 'step',
                sectionId: entry.key,
                entry,
                card,
                step
            };
            compiledHandles.set(compiledKeyOf(entry.key, step.id), handle);

            return handle;
        };

        // An owner question from the compact wire. The card's request is rebuilt from
        // the bounded summary — the question stays answerable without a detail fetch.
        const paintCompiledAction = (entry: ThreadEntry, step: DisplayStep): CompiledHandle => {
            const action = step.action;
            const requestId = action?.requestId ?? step.callId ?? step.id;

            const request: HarnessActionRequest = {
                requestId,
                question: action?.question ?? step.name,
                recommended: action?.recommended ?? '',
                options: (action?.options ?? []).map((option) => ({
                    id: option.id,
                    label: option.label,
                    ...(option.description === undefined ? {} : { description: option.description })
                })),
                allowCustom: true
            };

            closeText(entry.section);
            closeToolGroup(entry.section);

            const card = mountActionCard(entry, request);

            // The recorded answer, when there is one, is authoritative: the card
            // shows it instead of an open question (the same `action_answer` effect).
            if (action?.answered !== undefined)
                applyActionAnswer({
                    requestId,
                    choice: action.answered.choice,
                    source: action.answered.source
                });

            // The server knows an id is dead (a restored/expired request,
            // sessions.ts:679); the card must not guess that from elapsed time.
            if (action?.expired === true && card.state() !== 'answered')
                card.setExpired('This question can no longer be answered.');

            const handle: CompiledHandle = {
                kind: 'action',
                sectionId: entry.key,
                entry,
                card,
                step
            };
            compiledHandles.set(compiledKeyOf(entry.key, step.id), handle);

            return handle;
        };

        // One prose/reasoning node. Both reuse the fold's incremental writers, so
        // Markdown scheduling, attempt ownership and the chip-row layout are the
        // same code the live path already proved — only the bytes' origin differs.
        //
        // T22 (R23) narrows what the reader SEES of that flow when the section is
        // bar-described: `applyEntryContent` runs after the paint and leaves exactly one
        // prose block printed — the section's current answer — because every earlier
        // window is a segment of the strip that answers a click with its exact bytes.
        const paintCompiledText = (entry: ThreadEntry, node: DisplayTextNode): CompiledHandle | undefined => {
            const section = entry.section;

            closeToolGroup(section);
            appendText(section, node.text);

            const block = section.text;
            if (block === undefined) return undefined;

            const handle: CompiledHandle = {
                kind: 'text',
                sectionId: entry.key,
                entry,
                node: block.node,
                nodeId: node.id
            };
            compiledHandles.set(compiledKeyOf(entry.key, node.id), handle);
            // Provenance on the surface itself, so a reader (or a test) can tell which
            // recorded node a printed block came from without re-walking the tree.
            block.node.dataset.contextNode = node.id;

            // A committed node is a closed window: the next node must stream into a
            // block of its own (the raw path closes at `attempt_commit`/`done`).
            if (node.committed) {
                flushText(section);
                closeText(section);
                promoteAnswer(section, node.text);
            }

            return handle;
        };

        const paintCompiledReasoning = (
            entry: ThreadEntry,
            node: DisplayReasoningNode
        ): CompiledHandle | undefined => {
            // T22 (R23): a bar-described section prints its thinking at the TAIL of the
            // strip, one window at a time — not as a chip per round. The tail body is owned
            // by the section's bar surface and is repainted from the server's order by
            // `applyEntryContent`, which runs after this paint, so a hydration render, an
            // ops frame and a reconnect all land on the same single body.
            if (entry.contextBar?.driven() === true) {
                const tailHandle: CompiledHandle = {
                    kind: 'tail',
                    sectionId: entry.key,
                    entry,
                    nodeId: node.id
                };
                compiledHandles.set(compiledKeyOf(entry.key, node.id), tailHandle);

                // A newly painted window IS the newest block (the projector just opened it),
                // so paint it now rather than waiting for a frame that carries a document —
                // an ops-only stream still shows the round growing, live.
                entry.contextBar?.setTail(contextTailOf(entry.compiledSection));

                return tailHandle;
            }

            const section = entry.section;

            appendReasoning(section, node.text);

            const chip = section.reasoning;
            if (chip === undefined) return undefined;

            // The server owns the token arithmetic, so the chip prints the share it
            // was handed; the local character estimate stays the fallback for a
            // frame that reports no share. Same rule for the character figure: `chars`
            // is the round's EXACT recorded length, which is the only honest number
            // once the wire text is a bounded preview (T13).
            chip.card.setContext((entry.meta ?? blockMeta).context());
            chip.card.setShare(node.share);
            chip.card.setChars(node.chars);

            const handle: CompiledHandle = {
                kind: 'reasoning',
                sectionId: entry.key,
                entry,
                card: chip.card
            };
            compiledHandles.set(compiledKeyOf(entry.key, node.id), handle);

            return handle;
        };

        const paintCompiledNode = (entry: ThreadEntry, node: DisplayNode): void => {
            const key = compiledKeyOf(entry.key, node.id);
            if (compiledHandles.has(key)) return;

            if (node.kind === 'text') void paintCompiledText(entry, node);
            else if (node.kind === 'reasoning') void paintCompiledReasoning(entry, node);
            else if (node.kind === 'notice') paintCompiledNotice(entry, node);
            else paintCompiledStep(entry, node);
        };

        // Destroy + detach one handle. A card owns timers and possibly a dialog, so
        // `destroy` runs before the node leaves the DOM (the same ownership rule the
        // raw path's `discardAttempt` documents).
        const dropCompiledHandle = (key: string): void => {
            const handle = compiledHandles.get(key);
            if (handle === undefined) return;

            compiledHandles.delete(key);

            if (handle.kind === 'step') {
                handle.entry.section.tools = handle.entry.section.tools.filter(
                    (card) => card !== handle.card
                );
                toolCount = Math.max(0, toolCount - 1);
                handle.card.destroy();
                handle.card.element.remove();

                return;
            }

            if (handle.kind === 'implicit') {
                // T11: no DOM of its own. The tile's tool tally moves, and the bar's strip is
                // repainted from the tree by `syncContextBar` — never per handle, which is
                // what keeps a 300-call turn at one repaint instead of 300.
                toolCount = Math.max(0, toolCount - 1);

                return;
            }

            if (handle.kind === 'reasoning') {
                handle.entry.section.thinking = handle.entry.section.thinking.filter(
                    (card) => card !== handle.card
                );
                handle.card.destroy();
                handle.card.element.remove();

                return;
            }

            if (handle.kind === 'tail') {
                // T22 (R23): the window leaves the flow the moment its node does, and the
                // section's tail is re-derived from the tree the discard just updated. No
                // card, no tally: a think window was never a tool call, and dropping it must
                // not move the tile's call count (the `implicit` branch above would).
                applyEntryContent(handle.entry, handle.entry.compiledSection);

                return;
            }

            if (handle.kind === 'action') {
                handle.card.destroy();
                handle.card.element.remove();

                return;
            }

            handle.node.remove();
        };

        // Every compiled handle key of one section, so a section rebuild can drop
        // exactly its own surfaces (a steer node or a pending line this path does not
        // own stays put).
        const compiledSectionKeys = (sectionId: string): string[] =>
            [...compiledHandles.keys()].filter((key) => key.startsWith(`${sectionId}\u0000`));

        /**
         * T22/T23 (R23): re-derive the ONE content body this section is allowed to print.
         *
         * Everything about the decision is server-authored (`contextTailOf` applies the
         * section's own `tail` designation and reads the node/block it names), and this
         * single pass is the only thing that turns it into DOM state. It therefore runs
         * after EVERY paint that can move the tail: a hydration render, a whole-tree
         * reconcile, one addressed ops frame (a new round, a settled call, a redaction), a
         * discard. Live streaming and a cold reload end on the same body because they end
         * in the same function.
         *
         * Two surfaces are narrowed, and only while the section is bar-described
         * (`driven()`), so a pre-T9 record keeps the historical flow untouched:
         *   - the strip's OWN tail body (this section's current thinking window or current
         *     call, printed in full directly after the graph — `surface.setTail`), and
         *   - the flow's prose blocks: the current answer prints, every earlier window is
         *     hidden because the segment plus its lazy detail is how it is represented now.
         */
        const applyEntryContent = (entry: ThreadEntry, section: TurnSection | undefined): void => {
            const surface = entry.contextBar;
            if (surface === undefined) return;

            if (section !== undefined) entry.compiledSection = section;

            const source = section ?? entry.compiledSection;
            const driven = surface.driven();
            const tail = driven ? contextTailOf(source) : undefined;

            surface.setTail(tail);

            for (const key of compiledSectionKeys(entry.key)) {
                const handle = compiledHandles.get(key);
                if (handle === undefined || handle.kind !== 'text') continue;

                // The tail IS the answer the reader is looking at, so its block prints; any
                // other prose node of this section is history and prints nothing (its segment
                // plus the lazy block detail is how it is represented now).
                const visible = driven ? contextTailShowsProse(tail, handle.nodeId) : true;

                handle.node.dataset.tailState = visible ? 'current' : 'superseded';
                // `hidden` is the base rule (`[hidden] { display: none !important }`), and
                // `data-superseded` states the same decision in its own vocabulary so the
                // stylesheet contract survives a change to that base rule. The element and
                // its writer stay in the DOM: only the rendering is withdrawn.
                if (visible) delete handle.node.dataset.superseded;
                else handle.node.dataset.superseded = 'true';
                handle.node.hidden = !visible;
            }
        };

        /** The same pass for every section this tile owns, from the tree it is painting. */
        const applyCompiledContent = (display: TurnDisplay | undefined): void => {
            for (const [sectionId, entry] of compiledSections) {
                applyEntryContent(entry, sectionsOf(display).find((candidate) => candidate.id === sectionId));
            }
        };

        // Repaint one section's flow from its compiled node array. Used for a full
        // hydration and for the rare `node:insert` with an explicit `index` (an
        // out-of-order recovery), where appending would put the node in the wrong
        // place; rebuilding is cheaper than tracking DOM positions here.
        const renderCompiledSection = (entry: ThreadEntry, section: TurnSection): void => {
            for (const key of compiledSectionKeys(entry.key)) dropCompiledHandle(key);

            // The writers must not survive into a rebuilt flow: `section.text` would
            // otherwise append into a detached block.
            closeText(entry.section);
            entry.section.text = undefined;
            entry.section.reasoning = undefined;
            entry.section.toolGroup = undefined;
            entry.section.flow.replaceChildren();
            entry.section.pendingCalls.clear();
            entry.section.pending = undefined;

            // Set BEFORE the node loop: `paintCompiledReasoning` paints the tail body from
            // this reference, and a rebuild must land on the same block a stream would.
            entry.compiledSection = section;

            for (const node of section.nodes) paintCompiledNode(entry, node);

            // R23: the flow was just rebuilt, so the ONE body this section prints is
            // re-derived here rather than left to whatever node painted last.
            applyEntryContent(entry, section);

            updateMeta();
        };

        // Full paint of one turn from the compiled tree (hydration, a drain frame,
        // or a superseding view). Rebuilds from a clean slate: this is the path that
        // says "the document IS the state", so anything left over from a previous
        // projection (including sections the document no longer names) is dropped.
        const renderCompiledDisplay = (display: TurnDisplay): void => {
            resetCompiled();
            compiledMode = true;

            // T11: the bar is decided BEFORE the flow is painted, because whether this tile
            // draws step cards or segments is a property of the whole turn, and a node loop
            // that ran first would have already minted the cards this mode replaces.
            syncContextBar(display);

            // Sections in the server's allocation order: root first, then nested.
            // `paintCompiledSection` re-applies identity, so an already-created entry
            // (an optimistic tile's root) is refreshed rather than duplicated.
            for (const section of sectionsOf(display)) {
                const entry = compiledEntryOf(section, display);
                renderCompiledSection(entry, section);
            }

            // T22 (R23): one pass over every section this tile just painted, deciding which
            // single content block prints. `renderCompiledSection` does it per section; this
            // also covers a section whose entry was refreshed without a rebuild (an
            // optimistic tile), which is what keeps a hydration and a live stream identical.
            applyCompiledContent(display);

            // The persistent-conversation join (the row's `data-persistent-thread`, its title and
            // the child header's conversation name) is painted from the roster claim or the join
            // this pass just recorded, so it runs after the sections exist — the raw path paints it
            // from its event handlers, the compiled path has no event handlers.
            paintPersistentMarkers();

            updateMeta();
        };

        // Reconcile this tile's DOM with a full compiled tree WITHOUT rebuilding the
        // surfaces that already exist.
        //
        // This is what an authoritative `view` frame (a drain, a poll, a 202 answer)
        // does to a live tile: a node id that is already painted keeps its DOM, so an
        // open tool dialog, an already-loaded detail and the reader's scroll survive;
        // the content advances to the server's text; and ids the tree no longer names
        // are detached. Text can never duplicate, because a node's content is painted
        // FROM the node (the raw path needs prefix matching for that guarantee).
        const syncCompiledDisplay = (display: TurnDisplay): void => {
            compiledMode = true;

            // T11: an authoritative frame can be the one that FINALLY carries context (or a
            // legacy reconcile that stopped carrying it). When the mode flips, the flow on
            // screen is known to be the wrong shape, so it is rebuilt from this tree rather
            // than patched node by node.
            if (syncContextBar(display)) {
                renderCompiledDisplay(display);

                return;
            }

            for (const section of sectionsOf(display)) {
                const entry = compiledEntryOf(section, display);
                paintCompiledSection(entry, section);

                const painted = new Set<string>();

                for (const node of section.nodes) {
                    painted.add(node.id);

                    const handle = compiledHandles.get(compiledKeyOf(entry.key, node.id));
                    if (handle === undefined) {
                        paintCompiledNode(entry, node);
                        continue;
                    }

                    syncCompiledNode(handle, node);
                }

                // Ids this tree no longer names are gone from the record.
                for (const key of compiledSectionKeys(entry.key)) {
                    const nodeId = key.split('\u0000')[1] ?? '';
                    if (painted.has(nodeId)) continue;

                    dropCompiledHandle(key);
                }

                // R23: this section's flow just advanced node by node, so its single
                // displayed body is re-derived from the same tree the reconcile read.
                applyEntryContent(entry, section);
            }

            // A whole section the document dropped (a deleted invocation) takes its
            // row with it; the view is the authority for what exists.
            for (const [sectionId, entry] of [...compiledSections]) {
                if (sectionsOf(display).some((candidate) => candidate.id === sectionId)) continue;

                for (const key of compiledSectionKeys(sectionId)) dropCompiledHandle(key);
                compiledSections.delete(sectionId);
                entry.disposeActionBar();
                // T19 (R17): a section the document dropped loses its OWN strip too, including
                // any segment dialog the reader still has open on it.
                entry.disposeContextBar();
                entry.row?.remove();
                threads.delete(sectionId);
            }

            // Same rule as `renderCompiledDisplay`: the persistent-conversation join (row
            // `data-persistent-thread`, the row title, the child header's conversation name) is
            // derived from the roster claim recorded while painting sections, so it is refreshed
            // once the sections exist instead of from an event handler.
            paintPersistentMarkers();

            updateMeta();
        };

        // Advance one already-painted surface to the server's current content.
        const syncCompiledNode = (handle: CompiledHandle, node: DisplayNode): void => {
            const key = compiledKeyOf(handle.sectionId, node.id);

            if (handle.kind === 'text' && node.kind === 'text') {
                const section = handle.entry.section;
                const block = section.text;

                if (block !== undefined && block.node === handle.node) {
                    // Still the live writer: adopt the cumulative text and render it
                    // once, so a delta stream and a whole-tree refresh land identically.
                    if (block.buffer !== node.text) {
                        block.buffer = node.text;
                        renderText(block);
                    }
                } else {
                    // A closed (committed) block: repaint its element from the node,
                    // reusing the fold's renderer so Markdown, file links and images
                    // are treated exactly as they were while the node streamed.
                    renderText({
                        node: handle.node,
                        buffer: node.text,
                        handle: undefined,
                        viaFrame: false
                    });
                }

                if (node.committed) {
                    flushText(section);
                    closeText(section);
                    // A committed node IS this block's completed answer, so it becomes
                    // the footer Copy target (the same promotion `commitAttempt` does).
                    if (node.text.length > 0) promoteAnswer(section, node.text);
                }

                return;
            }

            if (handle.kind === 'reasoning' && node.kind === 'reasoning') {
                handle.card.setText(node.text);
                handle.card.setShare(node.share);

                return;
            }

            // T22 (R23): a bar-described thinking window owns no DOM, so an already-painted
            // one has nothing to advance here — the caller's `applyEntryContent` pass re-reads
            // the same node and repaints the ONE tail body, which is what keeps a reconcile
            // frame identical to the stream that produced it.
            if (handle.kind === 'tail') return;

            if (handle.kind === 'notice' && node.kind === 'notice') {
                handle.node.dataset.tone = node.tone;
                const label = handle.node.querySelector('.agent-notice-label');
                const text = handle.node.querySelector('.agent-notice-text');
                if (label !== null) label.textContent = node.tone;
                if (text !== null) text.textContent = node.text;

                return;
            }

            if (handle.kind === 'implicit' && node.kind === 'tool') {
                // A bar-owned call: the step object is the only state, so the same exact
                // comparison decides whether anything moved. Repainting is a handle swap
                // (no DOM), and the segment's colour/width come from the `context:set` the
                // same frame carries, which `syncContextBar` already applied.
                if (JSON.stringify(handle.step) === JSON.stringify(node)) return;

                dropCompiledHandle(key);
                paintCompiledStep(handle.entry, node);

                return;
            }

            if (
                (handle.kind === 'step' || handle.kind === 'action') &&
                (node.kind === 'tool' || node.kind === 'action')
            ) {
                // A step is resent WHOLE by contract (no field merging), so an exact
                // comparison is the cheap, unambiguous equality test here — the same
                // JSON comparison the raw fold uses for prefix matching.
                if (JSON.stringify(handle.step) === JSON.stringify(node)) return;

                dropCompiledHandle(key);
                paintCompiledStep(handle.entry, node);

                return;
            }

            // A node whose kind changed on the same id (the contract forbids it; a
            // malformed frame must still render something truthful): repaint it.
            dropCompiledHandle(key);
            paintCompiledNode(handle.entry, node);
        };

        // Handles are registered under the ENTRY's key — its board identity, which is `ROOT_KEY`
        // for the turn's own flow and the server's section id for every nested invocation
        // (`compiledEntryOf`). An ops frame always names the WIRE section id, so a lookup must
        // resolve the entry first: keying by `op.sectionId` misses every root-flow node, and a
        // missed handle means a settled `step:set` appends a second chip beside the running one
        // instead of replacing it.
        const compiledEntryKeyOf = (sectionId: string): string | undefined =>
            compiledSections.get(sectionId)?.key;

        const compiledHandleOf = (
            sectionId: string,
            nodeId: string
        ): CompiledHandle | undefined => {
            const key = compiledEntryKeyOf(sectionId);

            return key === undefined ? undefined : compiledHandles.get(compiledKeyOf(key, nodeId));
        };

        const dropCompiledHandleOf = (sectionId: string, nodeId: string): void => {
            const key = compiledEntryKeyOf(sectionId);
            if (key === undefined) return;
            dropCompiledHandle(compiledKeyOf(key, nodeId));
        };

        // Apply one ops frame to THIS tile's DOM.
        //
        // `display` is the store's post-state tree for this turn (main.ts applies the
        // ops to the document first, then routes them here). It is consulted only for
        // an indexed insert, where the position must come from the server's order.
        const applyCompiledOps = (
            ops: readonly TurnDisplayOp[],
            display?: TurnDisplay
        ): void => {
            // One flag per frame, so the bar is repainted at most once per frame however many
            // `context:*` ops it carried (a settled tool round sends several).
            let contextTouched = false;

            for (const op of ops) {
                switch (op.op) {
                    case 'turn':
                        // The row itself: status/timing/usage/chips/blocks.
                        setCompiledSummary(op.summary);
                        break;

                    case 'section:open': {
                        compiledMode = true;
                        // A section the server opens CAN carry its whole context list on the
                        // object, so this frame is a bar frame whether or not a `context:*` op
                        // follows it.
                        contextTouched = true;
                        // `display` is the store's post-state tree for this turn: it is what
                        // tells a parentless FIRST section (the turn's own flow) apart from a
                        // parentless later one (a branch of the root).
                        const entry = compiledEntryOf(op.section, display);
                        paintCompiledSection(entry, op.section);
                        break;
                    }

                    case 'section:set': {
                        const entry = compiledSections.get(op.sectionId);
                        if (entry === undefined) break;

                        const section = sectionsOf(display).find(
                            (candidate) => candidate.id === op.sectionId
                        );
                        if (section !== undefined) paintCompiledSection(entry, section);

                        // A patch that only moves the state still has to reach the row.
                        if (op.patch.state !== undefined) {
                            setThreadState(entry, sectionThreadState(op.patch.state));
                            if (isTerminalThread(entry.state)) completeThread(entry, entry.state);
                        }

                        break;
                    }

                    case 'node:insert': {
                        const entry = compiledSections.get(op.sectionId);
                        if (entry === undefined) break;

                        compiledMode = true;

                        if (op.index !== undefined && display !== undefined) {
                            // Out-of-order recovery: rebuild this section in the
                            // server's order instead of guessing a DOM position.
                            const section = sectionsOf(display).find(
                                (candidate) => candidate.id === op.sectionId
                            );
                            if (section !== undefined) {
                                renderCompiledSection(entry, section);
                                break;
                            }
                        }

                        paintCompiledNode(entry, op.node);
                        updateMeta();
                        break;
                    }

                    case 'node:append': {
                        const handle = compiledHandleOf(op.sectionId, op.nodeId);
                        if (handle === undefined) break;

                        if (handle.kind === 'text') {
                            // The writer accumulates and schedules ONE Markdown parse
                            // per frame (`schedule` above), which is what keeps a
                            // streamed answer cheap to render.
                            const section = handle.entry.section;
                            const block = section.text;

                            if (block !== undefined) {
                                block.buffer += op.delta;
                                schedule(block, () => renderText(block));
                                // A status line stays after new prose.
                                if (section.pending !== undefined) section.flow.append(section.pending);
                            } else {
                                // The writer is closed (the node was committed and its
                                // block finalized). A delta that still arrives opens a
                                // block of its own rather than being dropped.
                                appendText(section, op.delta);
                            }
                        } else if (handle.kind === 'reasoning') {
                            handle.card.setText(`${handle.card.text()}${op.delta}`);
                        } else if (handle.kind === 'tail') {
                            // T22 (R23): a bar-described thinking window has no chip to
                            // append into — its body is the section's single tail, and the
                            // reducer has ALREADY grown `entry.compiledSection`'s node text,
                            // so re-deriving the tail is the whole update. No local buffer,
                            // and therefore nothing that could drift from a cold reload.
                            applyEntryContent(handle.entry, undefined);
                        }

                        break;
                    }

                    case 'node:set': {
                        const handle = compiledHandleOf(op.sectionId, op.nodeId);
                        if (handle === undefined) break;

                        if (handle.kind === 'reasoning' && op.patch.share !== undefined)
                            handle.card.setShare(op.patch.share);

                        // T13: the exact recorded length the chip prints. A think window's
                        // wire TEXT is bounded once it passes the cap, but its `chars` keeps
                        // arriving with every delta, so the figure stays the round's real one
                        // (../shared/turn-display.ts:684). `undefined` is "not reported", and
                        // the card falls back to measuring its own text.
                        if (handle.kind === 'reasoning' && op.patch.chars !== undefined)
                            handle.card.setChars(op.patch.chars);

                        // `text` rewrites a NOTICE line in place (turn-display.ts:380). The
                        // per-section pending status line is the node this reaches most: a
                        // remove+insert pair would flicker the row, so the patch updates the
                        // existing line's text verbatim.
                        if (handle.kind === 'notice' && op.patch.text !== undefined) {
                            const line = handle.node.querySelector('.agent-notice-text');
                            if (line !== null) line.textContent = op.patch.text;
                        }

                        // T13 (contract decision): a prose `text` patch is the SERVER
                        // replacing what this node displays, and the row must show it. Two
                        // producers, both decided by the fold: the bounded preview of a think
                        // window whose wire bytes stopped at the cap, and the preview of an
                        // answer a newer one superseded (`redactSuperseded`). The cold tree a
                        // reload receives carries the SAME string, so ignoring it here left a
                        // live chip with an empty body and a live answer expanded past what
                        // the document says. This renders addressed server state; it parses
                        // no events and restores no history.
                        if (handle.kind === 'reasoning' && op.patch.text !== undefined)
                            handle.card.setText(op.patch.text);

                        if (handle.kind === 'text' && op.patch.text !== undefined) {
                            const section = handle.entry.section;
                            const writer = section.text;

                            // The open writer owns the buffer the next scheduled flush
                            // paints, so the replacement moves the buffer too — otherwise a
                            // later frame would repaint the pre-redaction bytes over the
                            // server's text. A closed block (the normal case: a committed
                            // answer that has just been superseded) is repainted in place.
                            if (writer !== undefined && writer.node === handle.node) {
                                cancel(writer);
                                writer.buffer = op.patch.text;
                            }

                            paintProse(handle.node, op.patch.text);
                            // Prose that just moved stays before the status line, exactly as
                            // an appended delta does (turns.ts `node:append`).
                            if (section.pending !== undefined) section.flow.append(section.pending);
                        }

                        // `committed` is a styling/lifecycle marker: the server sends
                        // explicit removes for a discard, so a commit only closes the
                        // writer here (and promotes the answer for the Copy action).
                        if (handle.kind === 'text' && op.patch.committed === true) {
                            const section = handle.entry.section;
                            const text = section.text?.buffer;

                            flushText(section);
                            closeText(section);
                            if (text !== undefined && text.length > 0) promoteAnswer(section, text);
                        }

                        // T22 (R23): a tail-owned thinking window. Every patch here — the
                        // bounded preview swapped in at the cap, the exact `chars` that keeps
                        // arriving after the wire stopped carrying bytes, the `redacted`
                        // marker that says which one it was — has already been applied to
                        // `entry.compiledSection` by the reducer, so the tail body is
                        // re-derived from the same server state a reload would read.
                        if (handle.kind === 'tail') applyEntryContent(handle.entry, undefined);

                        break;
                    }

                    case 'node:remove':
                        dropCompiledHandleOf(op.sectionId, op.nodeId);
                        updateMeta();
                        break;

                    case 'section:remove': {
                        // The mirror of `section:open`: the server discarded a section that
                        // never produced a node (a delegation placeholder whose attempt
                        // failed, turn-projector.ts:1567). Its handles and its row go with
                        // it — the document no longer names it, so nothing may keep painting
                        // into it. A section this tile never adopted is a no-op.
                        const entry = compiledSections.get(op.sectionId);
                        if (entry === undefined) break;

                        // T11: the dropped section's SEGMENTS go with it. They live on the
                        // section object, so the strip is rebuilt from the post-state tree
                        // after the loop rather than spliced here.
                        contextTouched = true;

                        // Handles are keyed by the ENTRY key (`ROOT_KEY` for the turn's own
                        // flow, the wire section id for every nested invocation), so the
                        // cleanup resolves through the entry rather than the wire id.
                        for (const key of compiledSectionKeys(entry.key)) dropCompiledHandle(key);
                        compiledSections.delete(op.sectionId);
                        entry.disposeActionBar();
                        // T19 (R17): the dropped section's OWN strip goes with its row — the bar
                        // (observers + listeners) and any segment dialog opened from it. A root
                        // flow has no strip of its own to destroy: the tile owns that one.
                        entry.disposeContextBar();
                        // A root flow has no row of its own (its surfaces live in the tile),
                        // so `row?.remove()` is the honest no-op for that case.
                        entry.row?.remove();
                        threads.delete(entry.key);
                        updateMeta();
                        break;
                    }

                    case 'step:set': {
                        const entry = compiledSections.get(op.sectionId);
                        if (entry === undefined) break;

                        const key = compiledKeyOf(entry.key, op.step.id);
                        const handle = compiledHandles.get(key);

                        // A step is small enough to resend whole (turn-display.ts:509),
                        // so replacing the chip is the honest, merge-free update.
                        if (handle !== undefined) dropCompiledHandle(key);
                        paintCompiledStep(entry, op.step);
                        updateMeta();
                        break;
                    }

                    case 'pending:set': {
                        const entry = compiledSections.get(op.sectionId);
                        if (entry === undefined) break;

                        // Absent means the snapshot is gone (nothing is running); an
                        // empty array means the same thing visibly.
                        paintPending(entry.section, op.pending ?? []);
                        break;
                    }

                    case 'usage': {
                        if (op.sectionId === 'turn') {
                            blockMeta.setFigures({
                                ...(op.latestInput === undefined ? {} : { latestInput: op.latestInput }),
                                ...(op.cachedInput === undefined ? {} : { cachedInput: op.cachedInput }),
                                ...(op.usage === undefined ? {} : { usage: op.usage })
                            });
                            syncThinkingShares();
                            break;
                        }

                        const entry = compiledSections.get(op.sectionId);
                        if (entry === undefined) break;

                        entry.meta?.setFigures({
                            ...(op.latestInput === undefined ? {} : { latestInput: op.latestInput }),
                            ...(op.cachedInput === undefined ? {} : { cachedInput: op.cachedInput })
                        });
                        syncThinkingShares();
                        break;
                    }

                    case 'attempt:commit': {
                        const entry = compiledSections.get(op.sectionId);
                        if (entry === undefined) break;

                        commitAttempt(entry.section);
                        break;
                    }

                    case 'attempt:discard': {
                        const entry = compiledSections.get(op.sectionId);
                        if (entry === undefined) break;

                        for (const nodeId of op.nodeIds)
                            dropCompiledHandle(compiledKeyOf(entry.key, nodeId));

                        // The prose writer belongs to a discarded attempt: close it so
                        // the next attempt's first node starts a fresh block.
                        closeText(entry.section);
                        entry.section.text = undefined;
                        updateMeta();
                        break;
                    }

                    // T11 (R7/R8): the bar's OWN ops. The state half already ran before this
                    // frame was routed here (`view-state.applyOpToDisplay` mutated the document
                    // the caller hands back), so all three cases do is mark the frame as one
                    // that touched the strip: the single repaint happens after the loop, from
                    // the post-state tree, which is also what re-colors a segment a
                    // `context:set` just settled.
                    case 'context:add':
                    case 'context:set':
                    case 'context:remove': {
                        contextTouched = true;
                        break;
                    }

                    // T23 (R23): the tail designation. The state half already ran (the reducer
                    // replaced `section.tail` on the post-state document this frame is routed
                    // with), and the DOM half is the single frame-end `applyCompiledContent`
                    // pass below — which is also what hides the body the designation left
                    // behind. No strip repaint is needed for a designation on its own: the
                    // segments and their counts did not move, only which body prints.
                    case 'tail:set':
                    case 'tail:clear': {
                        break;
                    }
                }
            }

            // T11: one strip repaint per frame that named the bar. When that frame changed
            // whether this tile is bar-driven — the FIRST `context:add` of a run, or a
            // reconcile that stopped carrying the metadata — the flow already on screen is the
            // wrong shape, so it is rebuilt. Without the rebuild a tile that had painted step
            // cards would show cards AND segments for the same calls, which is the duplication
            // this bar exists to remove.
            if (contextTouched) {
                const compiled = display ?? compiledDisplay;

                if (syncContextBar(compiled) && compiled !== undefined) rebuildCompiledFlow();
            }

            // T22 (R23): the frame is done, so every section this tile owns re-derives its
            // ONE displayed content block. This runs for a node frame as well as a context
            // frame — the tail moves on a `node:insert` (a new round, a final answer) and on
            // a `step:set` (a call superseding the thinking), and neither carries a
            // `context:*` op of its own. One pass per frame, driven by the post-state tree
            // the reducer already advanced, so a live stream, a drain and a reconnect that
            // missed frames all end on the same single body.
            applyCompiledContent(display ?? compiledDisplay);

            // One pass per frame, after the ops it names: a `section:open` records the roster join
            // (or adopts the conversation id the server put on the section), and the row's
            // persistent-thread identity, title and header label are derived from that. The raw
            // path paints them from its event handlers; this path has none.
            paintPersistentMarkers();
        };

        // The compact row -> the tile header. Status, timing, the token tally, the
        // thread badge, the attachment chips and the copy target all come from the
        // server's figures; `state` is printed verbatim because the projector already
        // applied the `running -> streaming` mapping the fold used to do.
        //
        // MONOTONIC per id (the same N2 rule the shell applies to its record cache,
        // main.ts:6789): a row stamped strictly BEFORE the row this tile already painted
        // is a late answer — the 202 body of a submit captured before the observer
        // delivered a newer revision — and it is authoritative for nothing. Without this
        // guard a queued row repaints a tile the stream already moved to `streaming`.
        const setCompiledSummary = (summary: TurnSummary): void => {
            compiledMode = true;
            if (isNewerSummary(compiledSummary, summary)) return;

            compiledSummary = summary;

            if (serverId === undefined || serverId !== summary.id) {
                serverId = summary.id;
                card.dataset.turnId = summary.id;
            }

            // Identity: the persistent conversation and its display label.
            setThreadId(summary.threadId, summary.threadLabel);

            // Timing: a running row counts up from `startedAt`, a terminal one
            // freezes at `updatedAt` (never at "now", so a poll and a live view
            // agree) — the exact rule `merge` implements for a raw record.
            const terminal =
                summary.status !== 'running' && (summary.status as string) !== 'queued';
            blockMeta.settle({
                ...(summary.startedAt === undefined ? {} : { startedAt: summary.startedAt }),
                ...(terminal && summary.updatedAt !== undefined ? { endedAt: summary.updatedAt } : {})
            });

            blockMeta.setFigures({
                ...(summary.latestInput === undefined ? {} : { latestInput: summary.latestInput }),
                ...(summary.cachedInput === undefined ? {} : { cachedInput: summary.cachedInput }),
                ...(summary.usage === undefined ? {} : { usage: summary.usage })
            });

            // R1: the state comes from the wire, and `setState` performs the whole
            // terminal cleanup (abandon unsettled cards, expire questions, clear the
            // pending lines) that the fold used to reach through events.
            setState(summary.state, summary.detail);

            setCompiledAttachments(summary.attachments);
            renderCompiledSteers(summary);

            syncRootAgentVisibility();
            syncTranscriptAction();
            updateMeta();
        };

        // Attachment chips from the compact wire. A small image arrives inlined and
        // renders as a thumbnail; everything else is identity + size, and a chip whose
        // bytes were not inlined still shows what the file was.
        const setCompiledAttachments = (
            attachments: readonly DisplayAttachmentSummary[] | undefined
        ): void => {
            const records: HarnessAttachment[] = (attachments ?? []).map((entry) => ({
                id: entry.id,
                marker: entry.marker,
                name: entry.name,
                kind: entry.kind,
                mime: entry.mime,
                // Canonical base64 when the projector inlined it; an empty string is
                // the honest "the bytes are on the server, not here" marker.
                data: entry.data ?? '',
                size: entry.size
            }));

            setAttachments(records);
        };

        // Steered submits, routed by the section the SERVER names. `sectionId` is the
        // destination, so the raw path's "find the invocation whose thread matches"
        // walk is not needed on this path (it stays for the compatibility fold).
        const renderCompiledSteers = (summary: TurnSummary): void => {
            const steers = summary.steers ?? [];
            steerRecords = steers.map((steer) => ({
                at: steer.at,
                prompt: steer.prompt,
                ...(steer.threadId === undefined ? {} : { threadId: steer.threadId }),
                ...(steer.references === undefined ? {} : { references: steer.references })
            }));

            steers.forEach((steer, index) => {
                const key = steerKeyOf(summary.id, index);
                const section =
                    steer.sectionId === undefined
                        ? undefined
                        : compiledSections.get(steer.sectionId)?.section;

                if (section === undefined) {
                    // No section (yet): the root flow, or a child owned by an EARLIER
                    // turn, which the board-level pass routes from the audit.
                    if (steer.sectionId === undefined) {
                        if (flowHasSteer(flow, key)) return;
                        closeText(entry0Section());
                        closeToolGroup(entry0Section());
                        flow.append(createSteerNode(steer, key));
                    }

                    return;
                }

                if (flowHasSteer(section.flow, key)) return;
                closeText(section);
                closeToolGroup(section);
                section.flow.append(createSteerNode(steer, key));
            });
        };

        // The root section for a root-level steer. `threads.get(ROOT_KEY)` exists
        // once anything has been painted; `rootSection` is the documented way to
        // create it, so an empty compiled turn still has its flow.
        const entry0Section = (): AgentSection =>
            threads.get(ROOT_KEY)?.section ?? rootSection(primaryAgent ?? UNNAMED_AGENT_PLACEHOLDER);

        // Drop everything this path painted. Cards own timers and dialogs, so each is
        // destroyed before its node leaves the document.
        const resetCompiled = (): void => {
            for (const key of [...compiledHandles.keys()]) dropCompiledHandle(key);

            compiledSections.clear();
            compiledHandles.clear();

            for (const entry of threads.values()) {
                entry.disposeActionBar();
                // T19 (R17): every delegated strip is destroyed with the projection it was
                // painted from; the rebuilt pass mints a fresh surface inside each new card.
                entry.disposeContextBar();
            }

            threads.clear();
            pendingTools.length = 0;
            settledCalls.clear();
            flow.replaceChildren();
            threadHost.replaceChildren();
            primaryAgent = undefined;
            toolCount = 0;
            blockMeta.clearUsage();
            tileAgent.textContent = '';
            tileAgent.hidden = true;
            syncRootAgentVisibility();
        };

        // The `#` popup source for this tile: the server's block projection, with
        // the bounded preview as the descriptor's `content`. Full block text is
        // detail-only, and the popup only ever needs the label and the snippet.
        const compiledBlocks = (): AgentBlockDescriptor[] => {
            if (compiledSummary === undefined || serverId === undefined) return [];

            return (compiledSummary.blocks ?? []).map((block) => ({
                turnId: block.turnId,
                ...(block.threadId === undefined ? {} : { threadId: block.threadId }),
                label: block.label,
                agent: block.agent,
                status: block.status,
                ...(block.preview === undefined ? {} : { content: block.preview })
            }));
        };

        // --- events -------------------------------------------------------
        // `at` is the server clock for this event. A live frame arrives with one
        // on the new server; local date is only the fallback. `origin` keeps the
        // replay path honest for records that predate timing support.
        const apply = (event: HarnessEvent, at?: number, origin: ApplyOrigin = 'live'): void => {
            // A queued tile receiving its first event is now running: transition
            // locally (the server may batch the status upsert). `waiting` is the
            // pre-first-event state; both become `streaming`.
            if (state === 'queued' || state === 'waiting') setState('streaming');

            appliedCount += 1;
            appliedEvents.push(event);

            // Route an event to its invocation and stamp that block's clock on the
            // first event it receives (R1). ONE entry point, so every handler below
            // observes the same "this invocation is running" moment.
            const route = (): ThreadEntry => {
                const entry = entryFor(event);
                observeInvocation(entry, at, origin);
                return entry;
            };

            // The block that emitted a `usage` event, WITHOUT creating one: usage is
            // a metadata frame, so it must never mint a section for an agent that
            // sent nothing else. `thread` metadata is authoritative; otherwise the
            // same legacy rules the tile uses (root agent, or the single started
            // non-terminal invocation of that agent).
            const usageOwner = (): ThreadEntry | undefined => {
                const info = threadOf(event);
                // A metadata-only HOST root frame belongs to the tile's root
                // section (it has no child row); its usage is the root's.
                if (info !== undefined) {
                    const known = threads.get(info.id);
                    if (known !== undefined) return known;

                    return isConversationRoot(info) ? threads.get(ROOT_KEY) : undefined;
                }

                const root = threads.get(ROOT_KEY);
                if (root !== undefined && event.agent === root.agent) return root;

                let found: ThreadEntry | undefined;
                let count = 0;
                for (const candidate of threads.values()) {
                    if (candidate.row === undefined) continue;
                    if (candidate.agent !== event.agent || !candidate.started) continue;
                    if (isTerminalThread(candidate.state)) continue;
                    found = candidate;
                    count += 1;
                }

                return count === 1 ? found : threads.get(`inline:${event.agent}`);
            };

            // Background-tool wakeup (R6). A wake is a RESUME, so it must not
            // settle the tile, resolve a card, or stop any timer — it only makes
            // the un-parking visible and replaces the pending snapshot the server
            // just reported. `wakeupOf` rejects a frame without a `pending` array:
            // such a frame falls through with no rendering and no pending update
            // (absence must not claim "everything settled").
            const wakeup = wakeupOf(event);
            if (wakeup !== undefined) {
                const entry = route();
                appendWakeup(entry.section, wakeup.pending);
                paintPending(entry.section, wakeup.pending);
                updateMeta();
                return;
            }

            switch (event.type) {
                case 'start': {
                    const entry = route();
                    const section = entry.section;
                    section.root.dataset.model = event.model;

                    if (entry.row !== undefined) {
                        // A child's first event is its own `start`; the placeholder
                        // (or explicit entry) is now visibly running. A repeated
                        // start frame never reopens a settled invocation.
                        entry.started = true;
                        if (!isTerminalThread(entry.state)) setThreadState(entry, 'streaming');
                        break;
                    }

                    // A second agent in the same turn is a delegation. R3: only the
                    // STRUCTURAL role attribute is updated — there is no visible
                    // role badge to relabel, the nesting and the agent colour carry
                    // the hierarchy.
                    section.root.dataset.role = event.agent === primaryAgent ? 'primary' : 'subagent';
                    break;
                }

                case 'reasoning':
                    appendReasoning(route().section, event.delta);
                    break;

                case 'text':
                    appendText(route().section, event.delta);
                    break;

                // R1/R3/R4 + T19 (R19): a failed model attempt was abandoned and the same
                // request is re-sent. The failed attempt's partial output is still removed —
                // the agent never committed it, and leaving it on screen would show an answer
                // that was thrown away — but NOTHING replaces it. The line this case used to
                // append ("attempt 1 of 11 failed · retrying in 1.0s · …") was transient
                // machinery chatter: the next attempt overwrites the same output, the run keeps
                // its `streaming` state through the backoff, and a reader who cannot act on it
                // should not have to scroll past it. The evidence stays where it was recorded:
                // the raw `retry` event in the journal and the CLI raw watcher. A budget that
                // actually RUNS OUT still prints, because that arrives as the turn's own
                // `error`/`done` terminal frame, not as this notice.
                case 'retry': {
                    const frame = retryOf(event);
                    if (frame === undefined) break;

                    discardAttempt(route().section);
                    break;
                }

                // R3/F1: the request SUCCEEDED and its answer is committed. Close the
                // attempt window so a retry of a LATER request can never discard this
                // turn's output. This is the boundary a tool-calling round needs: the
                // harness emits `done` only for a tool-free response, so without this
                // frame the NEXT request's `retry` deleted an already committed round.
                //
                // An OLDER recording has no such frame; there the historical `done`
                // case below still closes the window, which is exactly the old
                // behaviour for the sequences those recordings contain.
                case 'attempt_commit': {
                    const frame = attemptCommitOf(event);
                    if (frame === undefined) break;

                    commitAttempt(route().section);
                    break;
                }

                case 'tool_call':
                    appendTool(route(), event.call.name, event.call.arguments, event.call.id, at, origin);
                    break;

                case 'tool_result': {
                    const callId = callIdOf(event);
                    // R1: `outcome` is authoritative when present. An older recorded
                    // event (or a hand-written reporter) has only `isError`, which is
                    // the same value's boolean projection.
                    const outcome: HarnessToolOutcome =
                        event.outcome ?? (event.isError ? 'failed' : 'completed');
                    const settledTool = resolveTool(
                        event.name,
                        event.content,
                        outcome,
                        callId,
                        at,
                        origin,
                        toolDurationOf(event)
                    );

                    if (settledTool !== undefined) {
                        // The settling event is also this invocation's clock stamp
                        // (a call can be the first thing an invocation does).
                        observeInvocation(settledTool.entry, at, origin);

                        // A PRESENT array is the server's authoritative snapshot for
                        // that agent; otherwise the call that just settled is pruned
                        // from the per-call map. Absence alone is never read as "the
                        // queue drained" — the runtime omits `pending` when nothing
                        // remains, and siblings of another agent must stay listed.
                        const pending = pendingOf(event);
                        if (pending !== undefined) paintPending(settledTool.section, pending);
                        else if (settledTool.callId !== undefined) {
                            noteSettled(settledTool.section, settledTool.callId);
                        }
                    }

                    // The parent's result for the spawning call is the AUTHORITATIVE
                    // completion of that invocation (R3): an interim child `done`
                    // with pending work is not terminal, and a delegation cancelled
                    // before the child ever started still resolves its placeholder
                    // here. Matching is by callId, so same-agent siblings settle the
                    // right entry. Its block clock freezes at this event's stamp.
                    //
                    // R1: a CANCELLED call is a control outcome, not a broken child,
                    // so its row reads "cancelled" rather than "error"; only a
                    // failed/rejected call is an error.
                    if (callId !== undefined) {
                        const child = findThreadByCallId(callId);
                        if (child !== undefined) {
                            const preview = plainPreview(event.content, 200);
                            // Completed -> done; cancelled -> the dedicated
                            // cancelled state (info tone, never red); everything
                            // else (failed/rejected) -> error.
                            const childState: ThreadState =
                                outcome === 'completed'
                                    ? 'done'
                                    : outcome === 'cancelled'
                                      ? 'cancelled'
                                      : 'error';
                            completeThread(
                                child,
                                childState,
                                `${outcome === 'completed' ? 'outcome' : outcome === 'cancelled' ? 'cancelled' : 'error'} · ${
                                    preview.length === 0 ? 'no output' : preview
                                }`
                            );
                            settleInvocation(child, at, origin);
                        }
                    }
                    break;
                }

                // Per-request usage. The tile keeps two derived facts: the LATEST
                // reported request's input (primary) and, as a fallback for records
                // without a server tally, the per-request cached sum (bracket).
                // The authoritative bracket still comes from the server's
                // SessionTurn.usage.cached via setUsage; this case only fills the
                // legacy/missing-tally path and refreshes the latest context on
                // every live usage event. A missing cache figure stays absent
                // (never zero-filled).
                //
                // R1: the NESTED block that emitted the request also shows its own
                // usage (`thread-tokens`), from exactly these events; the root block
                // keeps the turn-wide figure below.
                case 'usage': {
                    const owner = usageOwner();
                    if (owner?.meta !== undefined) owner.meta.noteUsage(event.usage);

                    blockMeta.noteUsage(event.usage);
                    // The denominator moved, so every think chip in the tile re-measures
                    // against it (a stale percentage would disagree with the tally a
                    // reader sees two lines above it).
                    syncThinkingShares();
                    break;
                }

                case 'done': {
                    const entry = route();
                    const section = entry.section;
                    const message = event.message;
                    // R5: capture the prose that is about to close BEFORE the stream
                    // writers are detached — this is the completed response's text.
                    const streamed = section.text?.buffer;
                    closeText(section);
                    // R1/R3: a completed response closes the attempt window. Anything a
                    // LATER attempt appends is its own, so a retry must never discard
                    // this turn's committed output. (On a server that emits
                    // `attempt_commit`, the window was already closed there — this is
                    // the older-recording path and stays a no-op then.)
                    commitAttempt(section);
                    // A provider can omit streamed deltas and put the answer only on
                    // the terminal message. Keep that answer as the block content too.
                    if (message.content.length > 0) section.lastText = message.content;
                    // R5: the block's copyable final answer is the prose that just
                    // COMPLETED, i.e. exactly what the reader sees rendered in this
                    // block. Only when nothing streamed (a provider that puts the
                    // answer solely on the terminal message) does the `done` message
                    // content become the target. A tool-only round supplies neither,
                    // and the previous answer stays (an empty promotion is a no-op).
                    promoteAnswer(
                        section,
                        streamed !== undefined && streamed.length > 0 ? streamed : message.content
                    );
                    // `done` closes one *agent* turn, which may be a subagent nested
                    // inside a tool call. The user turn only settles when the stream
                    // itself ends, so the tile state is left alone.
                    //
                    // R1: the chip row is deliberately NOT closed here. A `done` frame
                    // is a lifecycle boundary with no readable output of its own (R5
                    // removed the model/stop/tokens line that used to be painted into
                    // the footer), so calls issued by the NEXT response keep wrapping in
                    // the same row. Genuine prose — which is what used to make this line
                    // worth breaking on — closes the row in `appendText`.
                    //
                    // Concurrency (R6): this response can be complete while its own
                    // calls are STILL RUNNING (`pending` non-empty). That is not a
                    // finish: the cards stay live, the agent is woken when outcomes
                    // land, and only the server's terminal turn status settles the
                    // tile. `pending` renders as its own status line, which the flow
                    // keeps last.
                    const pending = pendingOf(event);
                    if (pending !== undefined) paintPending(section, pending);

                    // Invocation status (R3). An interim response (pending work
                    // still running) stays `streaming`; a final one settles this
                    // entry only — the parent tile and every other invocation keep
                    // their own state. A parent tool_result that arrives later may
                    // still attach its outcome (see `completeThread`).
                    //
                    // Row-less legacy `inline:<agent>` entries settle too: their
                    // # descriptor used to stay `running` after a successful done,
                    // and (for error/cancelled) the popup offered them (T11). The
                    // root is deliberately excluded — the tile's `state` owns it.
                    if (entry.key !== ROOT_KEY && (pending === undefined || pending.length === 0)) {
                        completeThread(entry, 'done');
                        settleInvocation(entry, at, origin);
                    }
                    break;
                }

                case 'error': {
                    const entry = route();
                    const section = entry.section;
                    closeText(section);
                    // The error notice is not a chip, so the next call starts a
                    // fresh row below it.
                    closeToolGroup(section);
                    const error = el('div', 'agent-error');
                    error.append(el('span', 'agent-error-label', 'error'), el('span', 'agent-error-text', event.error.message));
                    section.flow.append(error);

                    // A child that reported its own failure is terminal; the parent's
                    // tool_result (if any) only confirms it. Its block clock freezes at
                    // the failing event's stamp (R1). Row-less legacy inline entries
                    // settle too, so blocks()/the # popup cannot offer a failed block
                    // (T11); the root stays tile-state owned.
                    if (entry.key !== ROOT_KEY) {
                        completeThread(entry, 'error', `error · ${event.error.message}`);
                        settleInvocation(entry, at, origin);
                    }
                    break;
                }

                // N3: the owner was asked a bounded question. The card is mounted on
                // the emitting invocation: interactive ONLY for the turn root; a
                // non-root (delegation/fork/autoanswer) request is read-only because
                // its immediate owner answers it automatically.
                case 'action_request': {
                    const frame = actionRequestEventOf(event);
                    if (frame === undefined) break;

                    const entry = route();
                    mountActionCard(entry, frame.request);
                    break;
                }

                // N3: the authoritative answer. Resolves the pending card without
                // any polling; `source` distinguishes a human answer from the
                // automatic owner fork.
                case 'action_answer': {
                    const frame = actionAnswerEventOf(event);
                    if (frame === undefined) break;

                    applyActionAnswer(frame.answer);
                    break;
                }

                // N3: a fork/autoanswer branch started. Render it as the same
                // nested invocation block as a delegation (R3): depth comes from
                // the thread metadata, the only addition is a tiny kind tag.
                case 'branch_start': {
                    const frame = branchStartEventOf(event);
                    if (frame === undefined) break;

                    const branch = frame.branch;
                    // The audit frame carries the BRANCH's OWN thread (runtime
                    // contract: harness.ts `branchThreadOf` — `branch_start`,
                    // `branch_end`, and every branch frame share one id/kind/branchId;
                    // `thread.parentId` names the REQUESTER when there is one). The
                    // row is therefore keyed by the summary's `branchId`, which is the
                    // same identity the frame's `thread.id` reports — never the
                    // requester's thread.
                    let entry = threads.get(branch.branchId) ?? findBranchEntry(branch.branchId);

                    if (entry === undefined) {
                        entry = createThread({
                            key: branch.branchId,
                            agent: branch.agent,
                            input: undefined,
                            callId: branch.callId,
                            // Nest under the source invocation when the summary names
                            // one; a root-level fork has neither and sits at the turn
                            // root exactly like a root-level delegation.
                            parentKey: branch.sourceThreadId ?? branch.sourceBranchId,
                            explicitId: branch.branchId,
                            started: true,
                            state: 'streaming',
                            kind: branch.kind,
                            branchId: branch.branchId
                        });
                    }

                    observeInvocation(entry, at, origin);
                    applyBranchStart(entry, branch);
                    break;
                }

                // N3: the branch reached a terminal state. Its thread row settles
                // with the same vocabulary as any invocation; a branch id is NOT
                // rendered as text.
                case 'branch_end': {
                    const frame = branchEndEventOf(event);
                    if (frame === undefined) break;

                    // As with branch_start, `event.thread` is the REQUESTER's
                    // context. The branch row is keyed by its branchId (its thread
                    // id), so look it up by that identity only.
                    const entry = threads.get(frame.branchId) ?? findBranchEntry(frame.branchId);
                    if (entry === undefined) break;

                    observeInvocation(entry, at, origin);
                    applyBranchEnd(entry, frame.status, frame.error, at, origin);
                    break;
                }

                // A wakeup `wakeupOf` rejected (no usable `pending` list) lands
                // here on purpose: the event is recorded for prefix matching, but
                // nothing is rendered and the pending snapshot is left untouched.
                case 'wakeup':
                    break;
            }

            updateMeta();
        };

        const flush = (): void => {
            for (const entry of threads.values()) flushText(entry.section);
        };

        // Attach the server identity. `index` is the server's 0-based position; it
        // is KEPT for ordering/protocol identity but no longer rendered (R3 removed
        // the visible `#ordinal`). A late bind (the opening `turn` frame) is normal,
        // not an error: the optimistic tile existed before the request reached the
        // server. When the start stamp arrives it replaces the local baseline, so a
        // later hydrate and the live label agree.
        const bind = (server: Pick<SessionTurn, 'id' | 'index'> & { startedAt?: number }): void => {
            serverId = server.id;
            card.dataset.turnId = server.id;

            // A queued turn has no `startedAt` yet (optional until execution), so a
            // queued tile keeps its clock hidden. Once the server supplies a start,
            // it replaces the local baseline and the tick resumes if still live.
            const serverStart = finiteOf(server.startedAt);
            if (serverStart !== undefined) blockMeta.bindStart(serverStart);
        };

        // Reconcile this tile with an authoritative server record (R4). This is the
        // queue-aware replacement for "rebuild from zero": identity/index/timing/
        // status come from the record, and ONLY events past `appliedCount` are
        // applied. A reconnect that already streamed a prefix therefore appends
        // the remainder instead of duplicating assistant text.
        //
        // Queued records carry no `startedAt`; a running one has no `endedAt`; a
        // terminal one freezes at `updatedAt` (never at "now", so a poll and the
        // live view agree). The model detail follows the existing tile convention.
        const merge = (source: SessionTurn, model?: string): void => {
            // Stale-record guard (R2). A record older than the last one applied is
            // an out-of-order snapshot (see `recordAt` above): the tile already
            // knows more than this record does, so applying it would only regress
            // status/timing. An equal stamp is allowed only when it is not a
            // regression in progress rank (same-millisecond enqueue/start).
            const stamp = finiteOf(source.updatedAt);
            if (recordAt !== undefined && stamp !== undefined) {
                if (stamp < recordAt) return;
                if (stamp === recordAt && recordStatus !== undefined && rankOf(source.status) < rankOf(recordStatus)) {
                    return;
                }
            }
            if (stamp !== undefined) recordAt = stamp;
            recordStatus = source.status;
            // Keep the raw record for the standalone JSON fallback; live event
            // frames are not written back here on purpose (the shell snapshot is
            // the richer source while it exists).
            sourceTurn = source;

            bind(source);
            // Adopt the record's persistent thread identity AND its conversation
            // label (both additive). A record without a label leaves the roster
            // join / derived name in place.
            setThreadId(turnThreadIdOf(source), turnThreadLabelOf(source));

            const terminal =
                source.status !== 'running' && (source.status as string) !== 'queued';
            setTiming({
                startedAt: finiteOf(source.startedAt),
                endedAt: terminal ? finiteOf(source.updatedAt) : undefined
            });

            const times = eventTimesOf(source);
            const events = Array.isArray(source.events) ? source.events : [];

            // Server authority with no duplicated text: keep the applied prefix
            // only if it MATCHES the record. A shorter/different record means the
            // browser's projection was superseded, so rebuild it from the record.
            const samePrefix =
                appliedCount <= events.length &&
                appliedEvents.every(
                    (event, position) => JSON.stringify(event) === JSON.stringify(events[position])
                );
            if (!samePrefix) resetProjection();

            // R9: steered user messages are part of the conversation, not hidden
            // metadata. A record carries them on the owning turn (`steers`), so they
            // are rendered in real order: before the first UNAPPLIED event whose
            // server stamp is at/after the steer, and after everything already
            // applied (the live case, where the steer arrived mid-run).
            const steers = Array.isArray(source.steers) ? source.steers : [];
            steerRecords = steers;
            for (let position = appliedCount; position < events.length; position += 1) {
                const eventAt = times?.[position];

                // Steers stamped at/ before this event are inserted before it, so a
                // replayed conversation keeps the user's text in chronological order.
                if (eventAt !== undefined) renderSteersThrough(eventAt);

                apply(events[position], eventAt, 'recorded');
            }
            appliedCount = events.length;

            renderSteersThrough();
            // Steers targeting a child invocation owned by an EARLIER turn (or a
            // roster-only conversation) are not visible from this tile alone.
            notifySteerChange();

            // The server owns the tally (see setUsage).
            setUsage(usageOf(source.usage));

            // Attachments are additive history: the record's chips replace the
            // optimistic draft chips. A text-only record clears them (the draft was
            // only ever a projection of what this turn carries).
            setAttachments(turnAttachmentsOf(source));

            setState(stateOf(source.status), model !== undefined && model.length > 0 ? model : undefined);
            flush();
            // The record may have told us the conversation label after the root
            // section was created (e.g. a live frame that arrived before the ack).
            paintRootLabel();
        };

        // Clicking the header expands a compact tile; clicking the expanded tile
        // collapses it back to the compact list (so the whole conversation is
        // visible at once). Only one persistent conversation is ever expanded; a
        // collapse is a deliberate unfocus.
        select.addEventListener('click', () => {
            if (expandedTurn === turn) collapse();
            else expand(turn);
        });

        // Stop every timer this tile owns. Tool cards hold their own live label;
        // a cleared board or a hidden page must not keep ticking. Invocation
        // entries share the same mechanism: their text blocks and tool cards are
        // owned by their sections, so stopping every section stops every child.
        const destroy = (): void => {
            stopElapsed();

            for (const entry of threads.values()) {
                if (entry.section.text !== undefined) cancel(entry.section.text);
                for (const tool of entry.section.tools) tool.destroy();
                // A think chip's dialog is owned by this tile exactly like a tool
                // chip's: a cleared board must not leave the modal (and its focus trap)
                // behind with an already-detached card.
                for (const thought of entry.section.thinking) thought.destroy();
                // A nested entry ticks on its own clock; a cleared board or a hidden
                // page must not keep it running.
                entry.meta?.stop();
            }

            for (const [requestId, card] of actionCards) {
                card.destroy();
                forgetAnswerCard(requestId);
            }
            actionCards.clear();

            // T11 (R7/R8) / T19 (R17): every context bar this tile owns goes here — the turn's
            // OWN strip in the tile body, plus one strip per delegated card that still exists.
            // A bar owns a `ResizeObserver` and pointer/keyboard listeners, and its segment
            // dialog owns a modal layer (a focus trap and the counted body scroll lock). A
            // destroyed tile that left any of them behind would keep repainting a dead element
            // and keep the page locked, so they go exactly like a tool card's dialog does.
            for (const entry of threads.values()) entry.disposeContextBar();
            tileContextBar.destroy();
        };

        // Shared descriptor status: the tile's transport-facing states collapse to
        // the server's block vocabulary (`streaming` -> running, `waiting` -> the
        // queued request it represents). The # popup filters failed/cancelled.
        const referenceStatus = (value: TurnState | ThreadState): AgentBlockDescriptor['status'] =>
            value === 'streaming' ? 'running' : value === 'waiting' ? 'queued' : value;

        const blocks = (): AgentBlockDescriptor[] => {
            // Display-wire path: the SERVER's block projection is the popup source,
            // so no invocation walk and no full block text is needed (R1/R3).
            if (compiledSummary !== undefined) return compiledBlocks();

            // An optimistic tile has no server turn id yet. It cannot be referenced
            // (the wire binding would be undefined), so it contributes nothing.
            if (serverId === undefined) return [];

            const descriptors: AgentBlockDescriptor[] = [];

            // Map insertion order is allocation order: root (created by the first
            // event), then each delegated invocation. Labels are conversation-scoped
            // (seeded by the tiles before this one), so this is exactly the numbering
            // the transcript shows AND the numbering the server projection derives
            // from the same recorded turn order (R6).
            // NOTE: an optimistic tile returns [] above, so a turn that has no server
            // id yet contributes no descriptors to the # popup (nothing is bindable),
            // but its allocations are still published to `labelCounters` so later
            // tiles continue the sequence.
            for (const entry of threads.values()) {
                const isRoot = entry.key === ROOT_KEY;
                // While prose is still streaming read the live buffer; after a
                // `done` closes it, `lastText` retains the final answer (T8).
                const content = entry.section.text?.buffer ?? entry.section.lastText;

                descriptors.push({
                    turnId: serverId,
                    // Root = the wire's "no threadId" signal. Nested entries use
                    // their CURRENT stable identity (`thread.id` after adoption,
                    // otherwise `call:<callId>` / `inline:<agent>`), which shared
                    // `findAgentResultBlock` explicitly supports as an alias.
                    ...(isRoot ? {} : { threadId: entry.key }),
                    label: entry.label,
                    agent: entry.agent,
                    status: referenceStatus(isRoot ? state : entry.state),
                    ...(content !== undefined && content.length > 0 ? { content } : {})
                });
            }

            return descriptors;
        };

        // Repaint everything roster-derived. The badge name and the child markers
        // must come from ONE source (`ui/threads.ts` canonical label) so a tile and
        // the strip cannot disagree about the same conversation (S6). A focused child
        // whose thread the roster no longer lists is collapsed here, which is how a
        // deletion clears a child focus without any local guesswork.
        const refreshThreadRoster = (): void => {
            // Prune FIRST: a conversation the roster dropped is deleted, while an
            // invocation id that merely ADVANCED (`inv-5` -> `inv-6`) keeps its join.
            forgetRemovedThreads();
            paintThreadBadge();
            paintPersistentMarkers();
            syncTranscriptAction();
            // T12b/T12d: a steer addressed to a child may have arrived before its
            // invocation entry was known (or lives in another turn); render it now
            // in the TARGET conversation/panel.
            renderSteersThrough();
            notifySteerChange();

            if (focusedChildKey !== undefined) {
                const entry = threads.get(focusedChildKey);
                if (entry === undefined || persistentIdOf(entry) === undefined) clearThreadFocus();
            }
        };

        const turn: TurnHandle = {
            element: card,
            prompt,
            state: () => state,
            setState,
            apply,
            merge,
            applied: () => appliedCount,
            source: () => sourceTurn,
            flush,
            id: () => serverId,
            threadId: () => runtimeThreadId,
            refreshThreadRoster,
            syncTranscriptAction,
            knowsThread,
            focusChildThread,
            clearThreadFocus,
            bind,
            setTiming,
            elapsed: () => blockMeta.elapsed.textContent ?? '',
            tokens: () => blockMeta.tokens.textContent ?? '',
            setUsage,
            summary: () => ({ agents: threads.size, tools: toolCount, primary: primaryAgent }),
            attachments: () => attachmentRecords,
            setAttachments,
            blocks,
            steerAudit: () => steerRecords,
            tryRenderSteer,
            setSummary: (summary: TurnSummary) => setCompiledSummary(summary),
            renderDisplay: (display: TurnDisplay) => renderCompiledDisplay(display),
            syncDisplay: (display: TurnDisplay) => syncCompiledDisplay(display),
            applyOps: (ops: readonly TurnDisplayOp[], display?: TurnDisplay) =>
                applyCompiledOps(ops, display),
            compiled: () => compiledMode,
            destroy
        };

        notifySteerChange = renderCrossSteers;
        turns.push(turn);
        // The card lives inside its row; the row is what the board groups, removes
        // and reorders, and it mirrors the tile state.
        placedTurn = turn;
        placeTurn(turn);
        // A queued tile paints no clock (nothing is running yet). `bind()` and
        // `setState('streaming')` start it from the server's start stamp, so a
        // task that waited in the queue is never charged for the wait.
        paintElapsed();
        // NO auto-expansion here (S1). `create` is shared by the optimistic submit
        // (which expands explicitly in `begin`), by snapshot adoption and by the
        // observer's `upsert`; adopting a turn — another tab's, a queued sibling's,
        // a late record for a failed submit — must never steal the reader's focus.
        // Initial content is opened by `reconcile`/`hydrate` under their own rules.

        return turn;
    };

    const notice = (text: string, tone: 'info' | 'error' = 'info'): HTMLElement => {
        empty?.remove();

        const node = el('div', 'notice', text);
        node.dataset.tone = tone;
        element.append(node);
        return node;
    };

    const clear = (): void => {
        for (const turn of turns) {
            turn.destroy();
            // The tile is wrapped in its row; removing the card alone would leave
            // an empty row in the list.
            turn.element.parentElement?.remove();
        }
        turns.length = 0;
        // R7/R8: action bars are owned by the tile/panel DOM that was just removed.
        // Drop their sync callbacks with it; `hideFocusPanel` below disposes the
        // focus panel's own closure before this set is cleared again.
        actionBarSyncs.clear();
        // F2: the focus-owned expansion list must not outlive the rows. `clear` is the
        // one teardown that does NOT run `detachTileExpansion`, so without this the
        // array kept references to the cards it had opened (detached nodes for the
        // whole life of the next board) and a later focus change would walk them.
        openedCards.length = 0;
        // A cleared board starts a new numbering (hydrate re-creates the tiles in
        // recorded order, so the conversation's labels are rebuilt exactly).
        labelCounters.clear();
        // R3: the remembered invocation → thread joins belong to the conversation
        // being torn down. Keeping them would let an invocation id of the NEXT
        // session resolve to a thread of the previous one (ids are opaque and only
        // unique per session).
        learnedThreads.clear();
        // T12b: the conversation containers are structural, not turn-owned; drop
        // every shell so a rebuild starts from a clean board.
        for (const host of conversationHosts.values()) host.remove();
        conversationHosts.clear();

        for (const node of [...element.querySelectorAll<HTMLElement>('.notice')]) node.remove();

        expandedTurn = undefined;
        hideFocusPanel();
        focusedThreadId = undefined;
        // A confirmation/in-flight delete belongs to the projection being torn down.
        // T6/R5: the confirmation is a live modal layer now, so it is dismissed (no
        // stale dialog left naming a thread this board no longer shows) rather than
        // un-armed.
        closeThreadDeleteConfirmation();
        deletingRequests.clear();
        activeDeleteSuppressions.clear();
        // A cleared board is a NEW conversation surface: the next content may be
        // auto-opened (`reconcile` first-content rule). The explicit "no focus" flag
        // is reset with the session, not inherited across it.
        explicitUnfocus = false;
        pendingFirstFocus = false;
        // A cleared board has no focused thread; the shell must drop its steering
        // target in the same tick or the next submit would name a thread that this
        // view no longer shows (a deleted/new session).
        notifyFocus();
        if (empty !== undefined) element.append(empty);
    };

    // Route lookup by explicit server id. A stream frame names its `turnId`, so
    // the board never has to guess which tile a delta belongs to.
    const find = (id: string): TurnHandle | undefined => turns.find((candidate) => candidate.id() === id);

    // Remove one tile from the board without touching server state. The submit path
    // uses this when a POST answer names a turn that already has a tile (steering
    // answers with the owner), so the optimistic row cannot survive as an unbound
    // queued ghost that every later snapshot would keep alive as "pending".
    const discard = (turn: TurnHandle): void => {
        const position = turns.indexOf(turn);
        if (position === -1) return;

        if (expandedTurn === turn) collapse();

        turns.splice(position, 1);
        turn.destroy();
        turn.element.parentElement?.remove();
        reorderBoard();
    };

    // Claim the oldest optimistic tile started for `prompt` (R2). The submit path
    // calls `begin(prompt)` before the request leaves the browser and binds the
    // server id only when the POST answer arrives, but the server publishes the
    // queued `turn` upsert BEFORE that answer (src/server/sessions.ts enqueue), so the
    // observer can describe the turn first. Without this claim the observer would
    // `adopt` a second tile for the same turn; the ack then bound the optimistic
    // one and the adopted tile stayed behind as a stale green row.
    //
    // FIFO: only unbound tiles are candidates, and the first match in board order
    // wins, so two identical prompts still map to their own records in order.
    // `merge` binds the tile immediately, so one tile can never be claimed twice.
    //
    // ONLY pending rows are claimable (queued/waiting): a tile left in a terminal
    // state by a failed submit is a report of that failure, not a request in
    // flight. Claiming it would turn "task failed" into a running row for an
    // identical prompt submitted afterwards — its own `begin` already made the
    // newer, genuinely pending tile that must be claimed instead.
    const claim = (prompt: string): TurnHandle | undefined =>
        turns.find((candidate) => {
            if (candidate.id() !== undefined || candidate.prompt !== prompt) return false;

            const state = candidate.state();
            return state === 'queued' || state === 'waiting';
        });

    // Rebuild one tile from the server's record. Replaying the events (rather
    // than trusting browser state) is what makes a reload render the same
    // transcript: `events` includes subagent events the server recorded.
    const adopt = (
        source: SessionTurn,
        model?: string,
        labelSeed?: Record<string, number>
    ): TurnHandle => {
        // R3: the server `index` is not rendered, so adoption only needs the prompt;
        // the record's position is the list order (`reconcile` re-orders by record).
        // Attachments are passed to the optimistic render, then `merge` applies the
        // same record's list — one code path, no duplicated DOM. The turn's recorded
        // label seed (when the server sent one) keeps its labels stable across a
        // deleted earlier thread.
        const handle = create(source.prompt, turnAttachmentsOf(source), undefined, labelSeed);
        // One code path with `merge` keeps a freshly adopted tile and a reconciled
        // live tile identical: timing, events, tally and status all come from the
        // record, and `appliedCount` starts at zero for a new tile.
        handle.merge(source, model);

        return handle;
    };

    // Reconcile the board with an authoritative snapshot (R4 queue).
    //
    // Unlike `hydrate` this does NOT rebuild the transcript: tiles are matched by
    // the server's stable FIFO id and merged in place, so the reader's expanded
    // tile, its DOM, and any text already rendered survive a reconnect/poll. New
    // turns are adopted, turns the server dropped are removed, and the DOM is
    // re-ordered to the server's index order (a reconnect can otherwise append a
    // turn that belongs in the middle).
    //
    // An UNBOUND tile (id undefined) is CLAIMED by the record for its prompt when
    // the snapshot already lists it (the observer can beat the POST answer), and
    // while it is still PENDING (queued/waiting) it is otherwise kept after the
    // server turns: the browser must not silently discard a submit in flight. A
    // terminal unbound row (a failed submit) is retired — see below.
    const reconcile = (
        sources: readonly SessionTurn[],
        options: HydrateOptions = {}
    ): TurnHandle[] => {
        // Snapshot the focus BEFORE any merge/adopt can change it (S1). Focus is
        // explicit state; the expansion is only the surface that currently carries
        // it. `hadTurns` distinguishes the first content of a board (auto-open) from
        // every later background adoption (never steal).
        const keepHandle = expandedTurn;
        const keepFocus = focusedThreadId;
        const keepId = options.keep ?? keepHandle?.id();
        const hadTurns = turns.length > 0;
        const seen = new Set<string>();
        const ordered: TurnHandle[] = [];

        for (const source of sources) {
            // A snapshot that names one id twice is a src/server/reconnect artefact:
            // the first record wins and the repeat must not add a second row.
            if (seen.has(source.id)) continue;
            seen.add(source.id);

            const existing = find(source.id);
            if (existing !== undefined) {
                existing.merge(source, options.model);
                ordered.push(existing);
                continue;
            }

            // The record for a task this browser submitted but has not been
            // answered for yet: bind the tile the user is already reading rather
            // than adopting a duplicate (R2).
            const claimed = claim(source.prompt);
            if (claimed !== undefined) {
                claimed.merge(source, options.model);
                ordered.push(claimed);
                continue;
            }

            ordered.push(adopt(source, options.model, options.labelSeeds?.[source.id]));
        }

        const next = [...ordered];

        // An optimistic tile survives the snapshot only while it is GENUINELY
        // PENDING (queued/waiting: the enqueue is still in flight, or the ack has
        // not been applied yet) — see `claim`. Anything else unbound is a
        // browser-only projection the server never accepted: chiefly a FAILED
        // submit, whose tile would otherwise linger as a ghost row across every
        // later snapshot (its outcome stays reported by the `.notice` the submit
        // path added, which this list never touches).
        for (const turn of [...turns]) {
            if (turn.id() !== undefined) continue;

            const state = turn.state();
            if (state === 'queued' || state === 'waiting') next.push(turn);
        }

        // Server authority: every bound tile that this pass did not place is gone
        // — dropped by the server (reset, cancelled backlog) or a DUPLICATE tile
        // bound to an id another tile now owns. Remove it and its row, so a stale
        // green duplicate can never outlive the record it described (R2).
        for (const turn of [...turns]) {
            if (next.includes(turn)) continue;

            turn.destroy();
            turn.element.parentElement?.remove();
        }

        // Surviving bound tiles keep their place in the array order `next` defines.
        turns.length = 0;
        turns.push(...next);

        // Project each tile into its conversation container (T12b). `placeTurn`
        // appends/moves existing rows, so no tile is rebuilt and its events,
        // references and timers survive; the final call also drops empty groups.
        // The durable invocation joins come from the roster (`invocationIds`), which
        // `setThreads` repaints before this pass runs (R3).
        placeAllTurns();
        renderCrossSteers();

        // --- focus preservation (S1) ---------------------------------------
        //
        // A snapshot may adopt turns of other threads (another tab, a queued
        // sibling, a late record). NONE of that may move the reader's focus, and
        // `create` no longer auto-expands, so the only decisions here are explicit:
        //
        //   a. the expanded surface survived -> keep it expanded, and re-report its
        //      thread if the tile only NOW learned its id (an optimistic follow-up);
        //   b. the expanded surface disappeared but the focused thread still exists
        //      -> re-focus that thread (its next-newest turn / child / roster panel);
        //   c. nothing is focused and this is the FIRST content of an empty board
        //      -> open the newest conversation (initial session render);
        //   d. otherwise leave the board exactly as the reader left it (including a
        //      deliberate "New thread" unfocus).
        if (keepHandle !== undefined && next.includes(keepHandle)) {
            const boundFocus = keepHandle.threadId();
            if (boundFocus !== undefined && boundFocus !== focusedThreadId) {
                focusedThreadId = boundFocus;
                notifyFocus();
            }
            // A claim/merge may have re-parented focus to a child row; a surviving
            // expanded TILE is the authoritative surface, so clear stale child focus.
            if (boundFocus !== undefined) keepHandle.clearThreadFocus();
        } else if (keepFocus !== undefined) {
            if (!focusThread(keepFocus)) {
                // The focused thread is gone from this snapshot (deleted): drop the
                // focus instead of resurrecting it from a stale id. On a SESSION
                // SWITCH the same path runs for the previous session's focus, and the
                // incoming conversation is then opened like first content.
                dropFocusState();
                notifyFocus();
                if (!explicitUnfocus && pendingFirstFocus) {
                    const newest = next[next.length - 1];
                    if (newest !== undefined) expand(newest);
                }
            }
        } else if (!explicitUnfocus && (!hadTurns || pendingFirstFocus)) {
            const newest = next[next.length - 1];
            if (newest !== undefined) expand(newest);
        }
        pendingFirstFocus = false;

        return next;
    };

    // Replace the board with the server's authoritative turn list. Expansion is
    // carried across the rebuild by turn id, so a reader looking at an older
    // turn is not yanked to the end by a poll or a terminal snapshot.
    const hydrate = (sources: readonly SessionTurn[], options: HydrateOptions = {}): TurnHandle[] => {
        const keepId = options.keep ?? expandedTurn?.id();

        // `clear` resets the explicit-unfocus flag: a rebuild is a new surface, and
        // the opened conversation below is a deliberate selection, not a background
        // adoption (S1's no-steal rule concerns ADOPTION, not an explicit rebuild).
        clear();

        const handles = sources.map((source) =>
            adopt(source, options.model, options.labelSeeds?.[source.id])
        );

        // A child conversation may be listed before its owner; settle ownership
        // grouping only after every adopted tile knows its thread id. The durable
        // invocation joins (R3) are already painted: the roster's `invocationIds`
        // names the historical delegated run, so `adopt`'s own projection bound the
        // card before this pass routes the continuations.
        placeAllTurns();
        renderCrossSteers();

        const kept = keepId === undefined ? undefined : handles.find((handle) => handle.id() === keepId);
        const target = kept ?? handles[handles.length - 1];
        if (target !== undefined) {
            expand(target);
        } else {
            notifyFocus();
        }

        return handles;
    };

    // ------------------------------------------------------------------
    // The display-wire board API (T5: R1/R2/R3)
    // ------------------------------------------------------------------
    //
    // Same list model, same focus/expansion rules, different source: a row comes
    // from `TurnSummary` and a flow from `TurnDisplay`. No function below touches
    // `SessionTurn.events`, and none of them needs `labelSeeds` (the server mints
    // the block labels, so a deletion can never renumber a surviving block here —
    // the guarantee the raw path implements with seeds arrives for free).
    //
    // `HydrateOptions` is accepted unchanged so the shell has ONE options shape:
    // `model` still labels a settled tile, `keep` still preserves which turn is
    // expanded, `labelSeeds` is simply not needed.

    // A turn whose tree the view has not sent yet (a queued row, or a partial view).
    // Empty is the honest answer: the row exists, the flow has nothing to paint.
    const emptyDisplay = (turnId: string): TurnDisplay => ({ turnId, sections: [] });

    // Build one tile from the compact row + its tree.
    const adoptView = (
        summary: TurnSummary,
        display: TurnDisplay | undefined
    ): TurnHandle => {
        const handle = create(summary.prompt, [], summary.threadId);
        handle.setSummary(summary);
        handle.renderDisplay(display ?? emptyDisplay(summary.id));

        return handle;
    };

    // Reconcile the board with an authoritative VIEW document (R4 queue + a drain
    // frame). Tiles are matched by the server's stable id and patched in place, so
    // the expanded tile, its DOM, any loaded tool detail and the reader's scroll all
    // survive — and because a node's content is painted from the node itself (never
    // from a delta stream), a reconnect cannot duplicate streamed text by
    // construction. `reconcile` needs prefix matching for that; this path does not.
    const reconcileView = (
        view: SessionView,
        options: HydrateOptions = {}
    ): TurnHandle[] => {
        const keepHandle = expandedTurn;
        const keepFocus = focusedThreadId;
        const keepId = options.keep ?? keepHandle?.id();
        const hadTurns = turns.length > 0;
        const seen = new Set<string>();
        const ordered: TurnHandle[] = [];

        for (const summary of summariesOf(view)) {
            // A duplicate id in one document is the same reconnect artefact the raw
            // path guards: the first row wins, and a repeat never adds a second one.
            if (seen.has(summary.id)) continue;
            seen.add(summary.id);

            const display = displayOfView(view, summary.id);

            const existing = find(summary.id);
            if (existing !== undefined) {
                existing.setSummary(summary);
                existing.syncDisplay(display ?? emptyDisplay(summary.id));
                ordered.push(existing);
                continue;
            }

            // The row for a task this browser submitted but has not been answered
            // for yet: bind the tile the reader is already looking at.
            const claimed = claim(summary.prompt);
            if (claimed !== undefined) {
                claimed.setSummary(summary);
                claimed.syncDisplay(display ?? emptyDisplay(summary.id));
                ordered.push(claimed);
                continue;
            }

            ordered.push(adoptView(summary, display));
        }

        const next = [...ordered];

        // An optimistic tile survives while it is genuinely pending (the enqueue is
        // still in flight). A terminal unbound row is a failed submit and retires,
        // exactly as in `reconcile`.
        for (const turn of [...turns]) {
            if (turn.id() !== undefined) continue;

            const state = turn.state();
            if (state === 'queued' || state === 'waiting') next.push(turn);
        }

        // Server authority: every bound tile this pass did not place is gone.
        for (const turn of [...turns]) {
            if (next.includes(turn)) continue;

            turn.destroy();
            turn.element.parentElement?.remove();
        }

        turns.length = 0;
        turns.push(...next);

        placeAllTurns();
        renderCrossSteers();

        // Focus preservation (S1) — the identical policy `reconcile` documents: a
        // background adoption never steals the reader's focus, and a session switch
        // opens the incoming conversation exactly once.
        if (keepHandle !== undefined && next.includes(keepHandle)) {
            const boundFocus = keepHandle.threadId();
            if (boundFocus !== undefined && boundFocus !== focusedThreadId) {
                focusedThreadId = boundFocus;
                notifyFocus();
            }
            if (boundFocus !== undefined) keepHandle.clearThreadFocus();
        } else if (keepFocus !== undefined) {
            if (!focusThread(keepFocus)) {
                dropFocusState();
                notifyFocus();
                if (!explicitUnfocus && pendingFirstFocus) {
                    const newest = next[next.length - 1];
                    if (newest !== undefined) expand(newest);
                }
            }
        } else if (!explicitUnfocus && (!hadTurns || pendingFirstFocus)) {
            const newest = next[next.length - 1];
            if (newest !== undefined) expand(newest);
        }
        pendingFirstFocus = false;

        return next;
    };

    // Replace the whole board with one view document (a reload, a session open, a
    // session switch). Expansion is carried across by turn id.
    const hydrateView = (
        view: SessionView,
        options: HydrateOptions = {}
    ): TurnHandle[] => {
        const keepId = options.keep ?? expandedTurn?.id();

        clear();

        const handles = summariesOf(view).map((summary) =>
            adoptView(summary, displayOfView(view, summary.id))
        );

        placeAllTurns();
        renderCrossSteers();

        const kept = keepId === undefined ? undefined : handles.find((handle) => handle.id() === keepId);
        const target = kept ?? handles[handles.length - 1];
        if (target !== undefined) {
            expand(target);
        } else {
            notifyFocus();
        }

        return handles;
    };

    // Bind/adopt the row a `POST /views/:id/tasks` answer names, so a submit that
    // was STEERED into a running conversation merges into the tile that already
    // represents it instead of growing an unbound ghost row.
    const upsertView = (
        summary: TurnSummary,
        view: SessionView | undefined
    ): TurnHandle => {
        const display = view === undefined ? undefined : displayOfView(view, summary.id);
        const existing = find(summary.id);
        if (existing !== undefined) {
            existing.setSummary(summary);
            if (display !== undefined) existing.syncDisplay(display);

            return existing;
        }

        const claimed = claim(summary.prompt);
        if (claimed !== undefined) {
            claimed.setSummary(summary);
            if (display !== undefined) claimed.syncDisplay(display);

            return claimed;
        }

        return adoptView(summary, display);
    };

    // Route one ops frame to its tile by EXPLICIT turn id. False means this board
    // holds no tile for that turn (another tab's turn, or a frame that arrived before
    // the row it belongs to): the caller leaves it alone, because the terminal `view`
    // frame is self-sufficient and reconciles whatever a connection missed.
    const applyViewOps = (
        turnId: string,
        ops: readonly TurnDisplayOp[],
        view?: SessionView
    ): boolean => {
        let handle = find(turnId);

        // A `{ op: 'turn' }` upsert IS the row's own record — "a client has exactly one place to
        // patch a row" (protocol.ts:691) — so the frame that opens a turn CREATES the tile, which
        // is what the raw surface's leading `turn` frame did (protocol.ts:563: "`turn` opens every
        // run, before the first harness event"). A frame whose ops name a turn this board has no
        // row for, with no upsert, still proves nothing about ordering and stays unapplied.
        if (handle === undefined) {
            const opened = ops.find((op) => op.op === 'turn');
            if (opened === undefined || opened.op !== 'turn') return false;
            handle = upsertView(opened.summary, view);
        }

        const display = view === undefined ? undefined : displayOfView(view, turnId);
        handle.applyOps(ops, display);

        return true;
    };

    // Stop every timer the board owns without discarding its DOM. Used by the
    // view teardown and on `pagehide`; a reload re-reads server state anyway.
    const destroy = (): void => {
        for (const turn of turns) turn.destroy();
    };

    // N3: bind the board to one session. A card rendered for a different session
    // can no longer be answered once the reader moves on: the controls are
    // expired locally (the server would reject a stale request anyway, but the UI
    // must not even offer it). A card created before the first bind (undefined)
    // is adopted, because it was rendered by this very conversation before the id
    // arrived. Re-binding the same id is a no-op, so every snapshot is safe.
    const bindSession = (sessionId: string | undefined): void => {
        if (boundSession === sessionId) return;

        // A real session switch: the next reconciled content belongs to a different
        // conversation, so its newest surface may be opened once (see `reconcile`).
        // A first binding (undefined -> id) is the conversation already on screen.
        if (boundSession !== undefined && sessionId !== undefined) pendingFirstFocus = true;

        // R3: invocation ids are unique per SESSION only, so a remembered join from
        // the conversation being left must not resolve an invocation of the new one.
        // This applies to EVERY change after the first binding, including a switch to
        // `undefined` (session teardown before the next id arrives): the new session's
        // roster (`invocationIds`) re-establishes every join it can prove, and anything
        // else stays an invocation-only card instead of pointing at a foreign thread.
        if (boundSession !== undefined) learnedThreads.clear();

        // A transcript/confirmation from the conversation being left cannot be
        // updated or acted on here. The raw snapshot belonged to the old session;
        // the shell will install the new one through `setSessionSnapshot`.
        if (boundSession !== undefined) {
            closeThreadTranscript(transcriptScope);
            sessionSnapshot = undefined;
            // T6/R5: the confirmation layer names a thread of the conversation being
            // left; confirming it here could only ever target the wrong roster.
            closeThreadDeleteConfirmation();
            // In-flight deletes belong to the session being left. A late resolution
            // removes only its own composite key/token, so the new binding's state
            // cannot be cleared by the old request.
            deletingRequests.clear();
            activeDeleteSuppressions.clear();
        }

        for (const record of answerCards.values()) {
            if (record.session === undefined) {
                record.session = sessionId;
                continue;
            }
            if (sessionId !== undefined && record.session === sessionId) continue;

            const cardState = record.card.state();
            if (cardState === 'answered' || cardState === 'expired') continue;
            record.card.setExpired('This question belongs to another session.');
        }

        boundSession = sessionId;
    };

    // Authoritative roster update (S2/S6). Repaints every roster-derived label and
    // child marker; drops a focus the roster no longer describes (a deleted thread),
    // which is what keeps a late/stale roster from re-opening a deleted conversation.
    //
    // C5: an unreadable transcript is marked on the surfaces that represent the
    // conversation, never by hiding them — the reader has to be able to reach the
    // editor, so the state is one attribute on the card plus one short line.
    const paintRosterInvalid = (): void => {
        for (const [threadId, host] of conversationHosts) {
            const entry = roster.find((candidate) => candidate.id === threadId);
            if (entry === undefined || entry.invalid === undefined) {
                delete host.dataset.invalid;
                continue;
            }

            host.dataset.invalid = 'true';
        }
    };

    const setThreads = (entries: readonly SessionThreadEntry[]): void => {
        roster = [...entries];

        // R7 snapshot semantics: an open transcript is a snapshot of the latest
        // applied authority. Every snapshot frame already calls this method, so
        // update the dialog and its Copy payload in place. If the raw snapshot no
        // longer names the thread, the dialog CLOSES rather than keeping stale
        // content under a thread identity the server just removed.
        const transcriptSnapshot = transcriptSnapshotNow();
        if (transcriptSnapshot !== undefined) {
            notifyTranscriptRefresh(refreshOpenThreadTranscript(transcriptSnapshot, transcriptScope));
        }
        refreshActionBars();

        // A roster can reveal that a thread is a CHILD of another (ownerThreadId) and
        // can JOIN an invocation entry to its persistent id — including a HISTORICAL
        // one through `invocationIds` (R3), so a resumed child's card keeps its
        // conversation. The markers must be painted BEFORE the projection runs:
        // `placeTurn` routes a child continuation by `data-persistent-thread`, so
        // projecting on stale markers would park it under the owner instead of inside
        // its own card.
        for (const turn of turns) turn.refreshThreadRoster();
        placeAllTurns();
        // Cards are (re)created by the projection above, so the invalid marks are
        // applied after it and always describe the roster this call just installed.
        paintRosterInvalid();

        if (focusedThreadId === undefined) return;

        const entry = roster.find((candidate) => candidate.id === focusedThreadId);
        if (entry === undefined && !threadKnown(focusedThreadId)) {
            dropFocusState();
            notifyFocus();
            return;
        }

        // A roster-only conversation is rendered FROM the roster: refresh its
        // transcript in place when a newer snapshot carries more messages.
        if (focusPanel !== undefined && entry !== undefined && expandedTurn === undefined) {
            showFocusPanel(entry);
        }
    };

    // Install the raw authority used by the JSON transcript and delete protection.
    // Kept separate from `setThreads` so every pre-R7 embedding keeps working with
    // the roster-only fallback and the exact raw shape lives in ONE place.
    const setSessionSnapshot = (snapshot: SessionSnapshot | undefined): void => {
        const hadRaw = sessionSnapshot !== undefined;
        sessionSnapshot = snapshot;
        if (snapshot === undefined) {
            // Raw authority REMOVED (a session teardown): the transcript surface goes with it.
            // Installing `undefined` when nothing was installed is not a teardown — under the
            // display wire the shell re-applies documents while `instance.snapshot` is still
            // absent (the transcript's own freshness read begins with exactly such an apply), and
            // an open dialog at that moment reads the compiled fallback, which survives.
            if (hadRaw) closeThreadTranscript(transcriptScope);
        } else {
            notifyTranscriptRefresh(refreshOpenThreadTranscript(snapshot, transcriptScope));
        }
        refreshActionBars();
    };

    // Install the COMPILED authority (T5 R1/R3). The default path calls this on every
    // applied view document; the raw document above stays undefined until the reader
    // explicitly opens a transcript, because a JSON export is the one surface that
    // quotes recorded events. An open transcript dialog refreshes from the newest
    // source, so a drain frame keeps it current without ever pulling events.
    const setSessionView = (view: SessionView | undefined): void => {
        sessionView = view;

        // The transcript document needs events; only a raw read can serve it, so the
        // dialog is refreshed from whichever authority exists (raw first, compiled
        // rows otherwise — see `transcriptSnapshotNow`).
        if (view === undefined) closeThreadTranscript(transcriptScope);
        // A compiled document never repaints an open transcript: its rows carry no recorded
        // events, so it can only DOWNGRADE the lossless document the reader is looking at. The
        // surfaces that CAN improve it own their own refresh — the raw freshness read the dialog
        // fires on open (`refreshSessionSnapshot`) and the PUT answer of a save.

        refreshActionBars();
    };

    return {
        element,
        bindSession,
        begin,
        notice,
        clear,
        expand,
        collapse,
        expanded: () => expandedTurn,
        turns: () => turns,
        focusedThread: () => focusedThreadId,
        focusThread,
        setThreads,
        setSessionSnapshot,
        setSessionView,
        discard,
        find,
        claim,
        adopt,
        hydrate,
        reconcile,
        hydrateView,
        reconcileView,
        upsertView,
        applyViewOps,
        blocks,
        destroy
    };
};

// Re-exported so callers can talk about tool state without importing tools.ts.
export type { ToolState };

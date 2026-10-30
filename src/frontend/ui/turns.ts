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
// Block anatomy (R1): the main tile and every nested entry share ONE header and body
// design — a compact one-line header (`agent code · preview · elapsed | tokens
// status`) that expands into the same body scale, the same native button
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
// Identity is per INVOCATION, never per agent name: two `agentDelegate` calls to
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
//   - styles: src/frontend/styles.css (`.turns`, `.turn-row`, `.tile`, `.agent`)
//   - queue/ack race (R2): src/server/sessions.ts `enqueue` publishes the queued
//     `turn` upsert BEFORE the 202 body is returned, so an observer frame can
//     describe a turn whose optimistic tile is still unbound (`claim`).

import type {
    HarnessEvent,
    HarnessUsage,
    SessionSteerRecord,
    SessionTurn,
    SessionTurnStatus
} from '../../server/protocol';
import type {
    HarnessActionAnswer,
    HarnessActionChoice,
    HarnessActionRequest,
    HarnessAttachment,
    HarnessBranchSummary,
    HarnessToolOutcome
} from '../../types';
import { applyAttachmentChips } from './attachments';
import { enhanceFileLinks } from './file-links';
import { openFilePreview } from './file-preview';
import type { FilePreviewReader } from './file-preview';
import { openAttachmentDialog, enhanceImages, openImageDialog } from './preview';
import {
    actionAnswerEventOf,
    actionRequestEventOf,
    branchEndEventOf,
    branchStartEventOf,
    callIdOf,
    eventTimesOf,
    finiteOf,
    pendingOf,
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
import { markdownFragment, plainPreview } from './markdown';
import { elapsedBetween, formatDuration } from './time';
import { formatTokens } from './tokens';
import { createToolCallCard } from './tools';
import type { ToolCallCard, ToolState } from './tools';
// Persistent (runtime) thread identity. This is NOT the invocation identity used by
// `#` references: `SessionTurn.threadId` names the stable conversation a turn
// belongs to, while `AgentBlockDescriptor.threadId` names one invocation. The two
// must never be joined — see ui/threads.ts for both contracts.
import {
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
    // Injected by the app shell (main.ts -> `callTool('fileRead', ...)`) so the UI
    // layer owns no network code. Omitted in standalone use: clicking a file link
    // still opens the dialog, which reports that reading is not wired.
    readFile?: FilePreviewReader;
    // Focus is DERIVED from expansion (exactly one tile is expanded at a time), so
    // the board reports every change here. The shell repaints the thread strip and
    // the composer's routing line from it; nothing is sent to the server until a
    // submit targets the focused thread (ui/threads.ts `resolveSubmitTarget`).
    onFocusChange?: (threadId: string | undefined) => void;
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
    // Authoritative cumulative tally (the root tile's `SessionTurn.usage`).
    setTally: (usage: HarnessUsage | undefined) => void;
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

    const paintTokens = (): void => {
        // Latest reported context; fall back to the cumulative input only when no
        // usage event was recorded (never on a live/hydrated block that has one, so
        // the two scopes cannot silently collapse).
        const input = latestInput ?? tally?.input;
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

type AgentSection = {
    root: HTMLElement;
    flow: HTMLElement;
    meta: HTMLElement;
    text: TextBlock | undefined;
    // The LAST closed prose block's cumulative buffer. `closeText` clears `text`
    // when a `done` ends the agent's message; retaining the buffer here is what
    // keeps the final answer available to the # reference descriptor (T8).
    lastText: string | undefined;
    reasoning: { details: HTMLDetailsElement; summary: HTMLElement; body: HTMLElement; buffer: string } | undefined;
    tools: ToolCallCard[];
    // Active wrapping row for consecutive tool calls, or undefined when the last
    // flow child was not a tool. Keeping the group alive across calls is what lets
    // `[websearch][fileRead]` share a line; prose/reasoning/error resets it.
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

// One invocation rendered as a thread entry. The ROOT invocation has a section
// but no row: its content is the tile body itself (depth 0). Every non-root
// invocation gets `.thread-row` → `.thread-tile` (header + collapsible body) and
// a `.thread-children` host for its own descendants.
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
    // (`elapsed | tokens | status`, R1). The root entry has no header of its own —
    // the tile's own `BlockMeta` covers it — so this is undefined there.
    meta: BlockMeta | undefined;
    // The state word inside `.thread-status`. Kept separate so the compact CSS can
    // clip the WORD (`.thread-status-text`) while the outer span keeps the layout.
    status: HTMLElement | undefined;
    statusText: HTMLElement | undefined;
    preview: HTMLElement | undefined;
    prompt: HTMLElement | undefined;
    outcome: HTMLElement | undefined;
    childrenHost: HTMLElement | undefined;
    expanded: boolean;
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

    const hostThreadIdOf = (threadId: string): string => {
        const seen = new Set<string>([threadId]);
        let current = roster.find((candidate) => candidate.id === threadId)?.ownerThreadId;

        while (current !== undefined && !seen.has(current)) {
            // Nest under the nearest OWNED ancestor that already has a conversation
            // container (or at least a turn). A link to a thread with no visible
            // surface falls through to this conversation remaining top-level.
            if (conversationHosts.has(current) || turns.some((turn) => turn.threadId() === current)) {
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

        const threadId = turn.threadId();

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
    };

    const notifyFocus = (): void => options.onFocusChange?.(focusedThreadId);

    // Cards THIS focus opened automatically, so ending the focus closes only them
    // (a card the reader opened by hand is their own state, not ours to collapse).
    const openedCards: HTMLElement[] = [];

    // Open every NESTED card that contains this turn's row. A continuation routed
    // into a child card (see `placeTurn`) is only visible while that card is open, so
    // focusing a resumed child would otherwise show an "expanded" turn nobody can see.
    // The reader can still collapse the card afterwards; this only guarantees the
    // focused exchange is not hidden by an ancestor's collapsed body.
    const openEnclosingCards = (turn: TurnHandle): void => {
        let host = turn.element.parentElement?.closest<HTMLElement>('.thread-row') ?? null;

        while (host !== null) {
            if (!host.classList.contains('is-expanded') && !openedCards.includes(host)) openedCards.push(host);

            host.classList.add('is-expanded');
            host.querySelector<HTMLButtonElement>(':scope > .thread-tile > .thread-select')?.setAttribute(
                'aria-expanded',
                'true'
            );
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
            card.classList.remove('is-expanded');
            card.querySelector<HTMLButtonElement>(':scope > .thread-tile > .thread-select')?.setAttribute(
                'aria-expanded',
                'false'
            );
        }

        if (expandedTurn === undefined) return;

        expandedTurn.element.classList.remove('is-expanded');
        expandedTurn.element
            .querySelector<HTMLButtonElement>('.tile-select')
            ?.setAttribute('aria-expanded', 'false');
        // The whole CONVERSATION was open (all its exchanges), not just this tile.
        hostOfTurn(expandedTurn)?.classList.remove('is-expanded');
        expandedTurn = undefined;
    };

    // The roster-only/child conversation panel. Rendering from `SessionThread.messages`
    // is what lets a child conversation (whose work is recorded INSIDE its parent's
    // turn and which has no `SessionTurn` of its own) be read and steered.
    const hideFocusPanel = (): void => {
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
        head.append(
            el('span', 'thread-focus-agent', entry.agent),
            el('span', 'thread-focus-name', name),
            el('span', 'thread-focus-status', entry.status)
        );
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

        const transcript = el('div', 'thread-focus-messages');
        const messages = Array.isArray(entry.messages) ? entry.messages : [];
        if (messages.length === 0) {
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

        panel.append(head, transcript);
        // First child of the board: the focused conversation reads at the top of the
        // transcript while the compact turn rows below stay navigable.
        element.prepend(panel);
        focusPanel = panel;
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
    // N3 session binding for answer routing. Cards capture this value when created
    // (see create/action handler), never read it at click time, so a switch cannot
    // retarget an answer that was rendered for another conversation.
    let boundSession: string | undefined;
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
        // Compact block metadata (R1): the elapsed clock and the token tally. ONE
        // shared implementation (`createBlockMeta`) paints the main tile and every
        // nested entry, so both headers tick, hide and format identically. The
        // elapsed label stays hidden until a real span exists (never "NaN" or a
        // fabricated "0ms"); the tally stays hidden until a request reports usage.
        // The `|` between them is CSS decoration (styles.css), not part of either
        // value.
        const blockMeta = createBlockMeta({ elapsed: 'tile-elapsed', tokens: 'tile-tokens' });
        const badge = el('span', 'tile-status');
        badge.dataset.state = 'queued';
        // No decorative dot: the status is TEXT (`tile-status-text`), visible on
        // an expanded tile and clipped — not removed — on a compact row, and the
        // colour lives on the row's border/status word. The compact row is plain.
        const statusText = el('span', 'tile-status-text', STATE_TEXT.queued);
        badge.append(statusText);

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
        // R3: no `#ordinal` span. The metadata cluster is `elapsed | tokens | status`
        // (measurements only); the turn's protocol `index` is bound for
        // ordering/identity but never displayed.
        top.append(blockMeta.elapsed, blockMeta.tokens, badge);
        // R1: the thread IDENTITY leads the header, exactly like a nested entry's
        // `.thread-name` leads `.thread-select`. The badge used to sit inside the
        // right-aligned metadata cluster, which put the conversation name beside the
        // clock/tokens instead of left of them. DOM order puts it before the agent
        // code/prompt; styles.css pins `order: 0` so the compact row (CSS-ordered) and
        // the expanded column agree. It is hidden whenever the turn has no persistent
        // thread, and `.tile-agent` disappears when it would repeat the same label.
        select.append(threadBadge, tileAgent, top, promptPreview, meta);

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
        // the bounded request (main.ts -> callTool('fileRead', ...)).
        const openTranscriptFile = (path: string): void => {
            openFilePreview(path, options.readFile === undefined ? {} : { read: options.readFile });
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
        body.append(promptBlock, flow);

        card.append(select, body);

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

        const paintThreadBadge = (): void => {
            if (runtimeThreadId === undefined) {
                threadBadge.hidden = true;
                threadBadge.textContent = '';
                threadBadge.title = '';
                delete card.dataset.threadId;
                syncRootAgentVisibility();
                return;
            }

            threadBadge.hidden = false;
            threadBadge.textContent =
                runtimeThreadLabel ?? threadLabelOf(runtimeThreadId, roster) ?? '';
            threadBadge.title = threadTitleOf(runtimeThreadId, roster) ?? '';
            card.dataset.threadId = runtimeThreadId;
            syncRootAgentVisibility();
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
        // entry's tally from that entry's own `usage` events (R1).
        const setUsage = (usage?: HarnessUsage): void => blockMeta.setTally(usage);

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
            badge.dataset.state = next;
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
        const createSection = (
            container: HTMLElement,
            agentName: string,
            role: 'primary' | 'subagent',
            label: string
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
            const agentMeta = el('div', 'agent-meta');

            root.append(head, sectionFlow, agentMeta);
            container.append(root);

            return {
                root,
                flow: sectionFlow,
                meta: agentMeta,
                text: undefined,
                lastText: undefined,
                reasoning: undefined,
                tools: [],
                toolGroup: undefined,
                pending: undefined,
                pendingCalls: new Map()
            };
        };

        // Collapse/expand one entry. Independent of the board's single expanded
        // TURN: a reader can open a child while the parent tile is collapsed, and
        // opening one child never closes another. The class is mirrored onto the
        // nested tile as well, so the shared `:is(.tile, .thread-tile)` CSS can key
        // the expanded frame off one selector for both block owners (R3).
        const setThreadExpanded = (entry: ThreadEntry, expanded: boolean): void => {
            if (entry.row === undefined) return;

            entry.expanded = expanded;
            entry.row.classList.toggle('is-expanded', expanded);
            entry.tile?.classList.toggle('is-expanded', expanded);
            entry.select?.setAttribute('aria-expanded', String(expanded));

            // Remember the reader's choice by canonical key so a projection rebuild
            // can restore it (the entry objects are recreated, the keys are stable).
            if (expanded) expandedThreads.add(entry.key);
            else expandedThreads.delete(entry.key);
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
            const claim = rosterClaimOf(entry.key);
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
                    continue;
                }

                entry.row.dataset.persistentThread = persistent;
                const match = roster.find((candidate) => candidate.id === persistent);
                entry.row.title = match === undefined ? `Thread ${persistent}` : `${threadNameOf(match)} · ${match.agent}`;
                // S6/R8: the row's own header names the child CONVERSATION.
                if (match !== undefined) paintEntryLabel(entry, threadNameOf(match));
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

        // Where a child row belongs. A parent with a row has a children host AFTER
        // its body, so grandchildren are visible even when the parent entry is
        // collapsed. The turn root (and an inline legacy section) has no row: its
        // children attach to the turn-level host at depth 1.
        const threadRowOf = (parentKey: string | undefined): { host: HTMLElement; depth: number } => {
            const parent = parentKey === undefined ? undefined : threads.get(parentKey);
            if (parent?.childrenHost !== undefined) {
                return { host: parent.childrenHost, depth: parent.depth + 1 };
            }

            return { host: threadHost, depth: 1 };
        };

        // Recompute depth for an entry and its descendants. Needed when explicit
        // metadata re-parents an adopted placeholder; DOM nesting does the visual
        // indentation, `data-depth` keeps the accessible/test-visible level true.
        // `seen` makes a corrupt/cyclic parent chain terminate instead of recursing.
        const setThreadDepth = (entry: ThreadEntry, depth: number, seen = new Set<string>()): void => {
            if (seen.has(entry.key)) return;
            seen.add(entry.key);

            entry.depth = depth;
            entry.row?.setAttribute('data-depth', String(depth));

            for (const child of threads.values()) {
                if (child.parentKey !== entry.key) continue;
                setThreadDepth(child, depth + 1, seen);
            }
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

        // The placeholder created when an `agentDelegate` tool call was observed,
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
            // compact turn tile — `name · preview · [elapsed | tokens] status`. The
            // agent code leads (the tile's prompt is its own leading item), the preview
            // is the single flexible, ellipsised item, and the metadata cluster
            // (`.thread-top`) is the nested counterpart of `.tile-top`. Both clusters
            // carry the same two labels from the shared `createBlockMeta`, so a child
            // block shows its own duration and usage when its events report them.
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
            // Status stays TEXT: the word is clipped (not removed) on a compact row,
            // exactly like `.tile-status-text`, and colour only reinforces it.
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
            select.append(name, ...(kindTag === undefined ? [] : [kindTag]), preview, top);

            const body = el('div', 'thread-body');
            body.id = bodyId;

            const threadFlow = el('div', 'thread-flow');
            body.append(threadFlow);

            const outcome = el('div', 'thread-outcome');
            outcome.hidden = true;
            body.append(outcome);

            tile.append(select, body);

            // Children live outside the body so collapsing THIS entry never hides
            // its descendants (R2).
            const childrenHost = el('div', 'thread-children');
            threadRow.append(tile, childrenHost);
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
                section: createSection(threadFlow, options.agent, 'subagent', label),
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
                childrenHost,
                expanded: false
            };

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
            const section = createSection(flow, agentName, 'primary', label);
            // R1/F3: the compact root header shows the same code as a child header.
            // The section's own `.agent-head` is hidden by CSS for the primary part
            // (the code would otherwise appear twice); flat legacy subagent sections
            // keep their head because they are DIFFERENT agents that need telling apart.
            tileAgent.textContent = label;
            tileAgent.hidden = false;
            syncRootAgentVisibility();
            threads.set(ROOT_KEY, {
                key: ROOT_KEY,
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
                childrenHost: undefined,
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
                childrenHost: undefined,
                expanded: false
            });

            updateMeta();
            return section;
        };

        // Move one entry (and its subtree) under a new parent host. A parent that is
        // this entry or one of its descendants is rejected: the metadata would be
        // corrupt, and the DOM cannot nest a node inside itself.
        const reparentThread = (entry: ThreadEntry, parentKey: string | undefined): void => {
            if (entry.row === undefined) return;
            if (!canReparent(entry, parentKey)) return;

            const place = threadRowOf(parentKey);
            entry.parentKey = parentKey;
            place.host.append(entry.row);
            setThreadDepth(entry, place.depth);
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

        const renderText = (block: TextBlock): void => {
            block.node.replaceChildren(markdownFragment(block.buffer));
            // R11: file mentions in the assistant's answer are clickable too. The
            // transform runs after sanitizing and only creates buttons from text.
            enhanceFileLinks(block.node, { open: openTranscriptFile });
            enhanceImages(block.node, { open: openTranscriptImage });
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
        const closeToolGroup = (section: AgentSection): void => {
            section.toolGroup = undefined;
        };

        // Return the row consecutive calls should join, creating it lazily so no
        // empty `.tool-group` ever sits in the flow between two prose blocks.
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
            // Deterministic text (tests assert it): `pending · fileRead 1.2s · webSearch 900ms`.
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
        // changes the tile state. Closing the text block and the chip row means the
        // post-wake prose and any new calls start below this line instead of being
        // glued onto the pre-wake ones.
        const appendWakeup = (section: AgentSection, pending: readonly HarnessPendingTool[]): void => {
            closeText(section);
            closeToolGroup(section);

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

        const appendText = (section: AgentSection, delta: string): void => {
            // Prose after a call ends the tool row: the next call must start below
            // this text rather than float back up into the previous group.
            closeToolGroup(section);

            if (section.text === undefined) {
                const node = el('div', 'markdown agent-text');
                section.flow.append(node);
                section.text = { node, buffer: '', handle: undefined, viaFrame: false };
            }

            // The pending summary is a status line: it stays after any new prose.
            if (section.pending !== undefined) section.flow.append(section.pending);

            const block = section.text;
            block.buffer += delta;
            schedule(block, () => renderText(block));
        };

        const appendReasoning = (section: AgentSection, delta: string): void => {
            // Reasoning is its own flow block, so it breaks the chip row exactly
            // like assistant prose does.
            closeToolGroup(section);

            if (section.reasoning === undefined) {
                const details = el('details', 'thinking');
                const summary = el('summary', 'thinking-summary', 'reasoning');
                const reasoningBody = el('div', 'reasoning');
                details.append(summary, reasoningBody);
                section.flow.append(details);
                section.reasoning = { details, summary, body: reasoningBody, buffer: '' };
            }

            // Status line last, exactly like prose.
            if (section.pending !== undefined) section.flow.append(section.pending);

            const block = section.reasoning;
            block.buffer += delta;
            // Plain text, appended in place: no parse, no innerHTML, no sanitizer
            // round-trip for scratch space.
            block.body.textContent = block.buffer;
            block.summary.textContent = `reasoning · ${block.buffer.length.toLocaleString()} chars`;
        };

        // Parse an `agentDelegate` call's arguments for the legacy fallback: without
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
            // A new call must appear ABOVE the pending summary line, never below it.
            if (section.pending !== undefined) section.flow.append(section.pending);
            pendingTools.push({ card, section, entry, name, callId, startedAt });
            toolCount += 1;

            // Queued delegation placeholder (legacy fallback, R3): the entry appears
            // WHEN the call is made, under the invocation that made it, and is
            // adopted by its child `start` (or resolved by the parent's result when
            // the delegation is cancelled before the child starts). The key is the
            // spawning call id, which is stable for the whole turn, so a repeated
            // same-agent delegate still yields two distinct entries.
            if (name === 'agentDelegate') {
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
            updateMeta();
            return { entry: owner, section, callId: undefined };
        };

        // Discard everything the browser rendered from a now-superseded event
        // stream. Used only when a server record's event prefix DISAGREES with what
        // the tile applied (the record wins), never on a normal reconnect where the
        // prefix matches and only the remainder is appended.
        const resetProjection = (): void => {
            for (const entry of threads.values()) {
                if (entry.section.text !== undefined) cancel(entry.section.text);
                for (const tool of entry.section.tools) tool.destroy();
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
                    break;
                }

                case 'done': {
                    const entry = route();
                    const section = entry.section;
                    const message = event.message;
                    closeText(section);
                    // A provider can omit streamed deltas and put the answer only on
                    // the terminal message. Keep that answer as the block content too.
                    if (message.content.length > 0) section.lastText = message.content;
                    // The agent turn is over: a later call in a new turn gets its
                    // own row rather than joining calls from the finished turn.
                    closeToolGroup(section);

                    // `done` closes one *agent* turn, which may be a subagent
                    // nested inside a tool call. The user turn only settles when
                    // the stream itself ends, so the tile state is left alone.
                    //
                    // Concurrency (R6): this response can be complete while its own
                    // calls are STILL RUNNING (`pending` non-empty). That is not a
                    // finish: the cards stay live, the agent is woken when outcomes
                    // land, and only the server's terminal turn status settles the
                    // tile. `pending` is only rendered when present, so a legacy
                    // response prints exactly the old line.
                    const parts = [message.model, message.stopReason];
                    if (message.toolCalls.length > 0) {
                        parts.push(`${message.toolCalls.length} tool call${message.toolCalls.length === 1 ? '' : 's'}`);
                    }
                    if (message.usage !== undefined) parts.push(`${message.usage.total} tokens`);

                    const pending = pendingOf(event);
                    if (pending !== undefined) {
                        paintPending(section, pending);
                        if (pending.length > 0) {
                            parts.push(
                                `${pending.length} tool${pending.length === 1 ? '' : 's'} still running`
                            );
                        }
                    }

                    section.meta.textContent = parts.join(' · ');

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
                // A nested entry ticks on its own clock; a cleared board or a hidden
                // page must not keep it running.
                entry.meta?.stop();
            }

            for (const [requestId, card] of actionCards) {
                card.destroy();
                forgetAnswerCard(requestId);
            }
            actionCards.clear();
        };

        // Shared descriptor status: the tile's transport-facing states collapse to
        // the server's block vocabulary (`streaming` -> running, `waiting` -> the
        // queued request it represents). The # popup filters failed/cancelled.
        const referenceStatus = (value: TurnState | ThreadState): AgentBlockDescriptor['status'] =>
            value === 'streaming' ? 'running' : value === 'waiting' ? 'queued' : value;

        const blocks = (): AgentBlockDescriptor[] => {
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
            flush,
            id: () => serverId,
            threadId: () => runtimeThreadId,
            refreshThreadRoster,
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
    const setThreads = (entries: readonly SessionThreadEntry[]): void => {
        roster = [...entries];

        // A roster can reveal that a thread is a CHILD of another (ownerThreadId) and
        // can JOIN an invocation entry to its persistent id — including a HISTORICAL
        // one through `invocationIds` (R3), so a resumed child's card keeps its
        // conversation. The markers must be painted BEFORE the projection runs:
        // `placeTurn` routes a child continuation by `data-persistent-thread`, so
        // projecting on stale markers would park it under the owner instead of inside
        // its own card.
        for (const turn of turns) turn.refreshThreadRoster();
        placeAllTurns();

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
        discard,
        find,
        claim,
        adopt,
        hydrate,
        reconcile,
        blocks,
        destroy
    };
};

// Re-exported so callers can talk about tool state without importing tools.ts.
export type { ToolState };

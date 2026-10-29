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
// ui/agent-label.ts (`RH1` = first+last letter of `research` + its 1-based
// occurrence within the turn, root invocation included). A code is allocated ONCE
// per invocation, so a stream cannot inflate it, and a rebuilt projection
// (`resetProjection`) re-numbers from the record, so replay is deterministic. Raw
// agent ids never appear as text; they stay on `data-agent` for colour/routing and
// in the runtime metadata. The turn's protocol `index` is bound but not displayed.
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
// Cross-references:
//   - tool cards: src/frontend/ui/tools.ts
//   - attachment chips (composer + replay): src/frontend/ui/attachments.ts
//   - lifecycle status (topbar pill): src/frontend/main.ts (`setLifecycle`)
//   - elapsed formatting: src/frontend/ui/time.ts
//   - styles: src/frontend/styles.css (`.turns`, `.turn-row`, `.tile`, `.agent`)
//   - queue/ack race (R2): src/server/sessions.ts `enqueue` publishes the queued
//     `turn` upsert BEFORE the 202 body is returned, so an observer frame can
//     describe a turn whose optimistic tile is still unbound (`claim`).

import type { HarnessEvent, HarnessUsage, SessionTurn, SessionTurnStatus } from '../../server/protocol';
import type {
    HarnessActionAnswer,
    HarnessActionChoice,
    HarnessActionRequest,
    HarnessAttachment,
    HarnessBranchSummary
} from '../../types';
import { attachmentChipElement, attachmentThumbnailUrl } from './attachments';
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
// Compact per-turn agent labels (`RH1`, `RH2`, …): the visible agent identity in a
// block header. Raw agent ids never reach the DOM as text (R2/R3); the allocator is
// per turn so the numbering is deterministic on replay.
import { createAgentLabels } from './agent-label';
import { markdownFragment, plainPreview } from './markdown';
import { elapsedBetween, formatDuration } from './time';
import { formatTokens } from './tokens';
import { createToolCallCard } from './tools';
import type { ToolCallCard, ToolState } from './tools';

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
    // Attachments recorded for this turn (empty for a text-only turn). A tile
    // created by `begin` carries the draft's attachments until the server record
    // replaces them, so the optimistic and replayed renderings agree.
    attachments: () => readonly HarnessAttachment[];
    // Replace the chips under the prompt. Called by `merge` with the server's
    // record; never renders the base64 payload as text (filename/marker only, plus
    // a safe raster-image thumbnail).
    setAttachments: (attachments: readonly HarnessAttachment[]) => void;
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
    begin: (prompt: string, attachments?: readonly HarnessAttachment[]) => TurnHandle;
    notice: (text: string, tone?: 'info' | 'error') => HTMLElement;
    clear: () => void;
    expand: (turn: TurnHandle) => void;
    collapse: () => void;
    expanded: () => TurnHandle | undefined;
    turns: () => readonly TurnHandle[];
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
    let expandedTurn: TurnHandle | undefined;
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
        if (expandedTurn === turn) return;

        if (expandedTurn !== undefined) {
            expandedTurn.element.classList.remove('is-expanded');
            expandedTurn.element
                .querySelector<HTMLButtonElement>('.tile-select')
                ?.setAttribute('aria-expanded', 'false');
        }

        expandedTurn = turn;
        turn.element.classList.add('is-expanded');
        turn.element.querySelector<HTMLButtonElement>('.tile-select')?.setAttribute('aria-expanded', 'true');
    };

    const collapse = (): void => {
        if (expandedTurn === undefined) return;

        expandedTurn.element.classList.remove('is-expanded');
        expandedTurn.element.querySelector<HTMLButtonElement>('.tile-select')?.setAttribute('aria-expanded', 'false');
        expandedTurn = undefined;
    };

    const begin = (prompt: string, attachments: readonly HarnessAttachment[] = []): TurnHandle =>
        create(prompt, attachments);

    // One tile, shared by the optimistic `begin` path and server adoption. R3: the
    // tile no longer paints a `#position` ordinal; the server's `index` still binds
    // (protocol/ordering) but is never displayed. The agent identity in the header
    // is the compact per-turn label (`RH1`), not a raw agent id.
    const create = (prompt: string, initialAttachments: readonly HarnessAttachment[] = []): TurnHandle => {
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
        // per-turn label allocator), so an optimistic tile never claims an identity.
        const tileAgent = el('span', 'tile-agent');
        tileAgent.hidden = true;
        // R3: no `#ordinal` span. The header group is the metadata cluster
        // (`elapsed | tokens | status`) only; the turn's protocol `index` is bound
        // for ordering/identity but never displayed.
        top.append(blockMeta.elapsed, blockMeta.tokens, badge);
        select.append(tileAgent, top, promptPreview, meta);

        const body = el('div', 'tile-body');
        body.id = `${id}-body`;

        // The prompt itself is rendered as Markdown too: users paste code fences
        // and lists into the composer, and the tile should read like the answer.
        const promptBlock = el('div', 'turn-prompt markdown');
        promptBlock.append(markdownFragment(prompt));

        // Attachments (T5, additive): the chip strip sits directly under the prompt
        // and is hidden for a text-only turn, so every pre-attachment tile keeps its
        // exact layout. Chips are built by ui/attachments.ts (filename via
        // textContent, decorative raster thumbnail only; the base64 payload is never
        // rendered as text). History is read-only: no remove control here.
        const attachmentHost = el('div', 'turn-attachments');
        attachmentHost.setAttribute('role', 'list');
        attachmentHost.hidden = true;

        let attachmentRecords: HarnessAttachment[] = [];

        const setAttachments = (attachments: readonly HarnessAttachment[]): void => {
            attachmentRecords = [...attachments];

            const chips = attachments.map((attachment) => {
                const preview = attachmentThumbnailUrl(attachment);
                return attachmentChipElement({
                    kind: attachment.kind,
                    marker: attachment.marker,
                    name: attachment.name,
                    mime: attachment.mime,
                    ...(preview === undefined ? {} : { previewUrl: preview })
                });
            });

            attachmentHost.replaceChildren(...chips);
            attachmentHost.hidden = chips.length === 0;
        };

        setAttachments(initialAttachments);

        const flow = el('div', 'tile-flow');
        body.append(promptBlock, attachmentHost, flow);

        card.append(select, body);

        // --- per-turn state ------------------------------------------------
        let state: TurnState = 'queued';
        let detail: string | undefined;
        let primaryAgent: string | undefined;
        let toolCount = 0;
        // Server identity for this tile. Absent until `bind()` or a snapshot.
        let serverId: string | undefined;
        // How many of the server turn's `events` this tile has applied. Live
        // frames and replayed records both count, so `merge()` can skip the
        // prefix it already rendered instead of appending it twice.
        let appliedCount = 0;
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

        // Compact agent labels (`RH1`, `RH2`, …): ONE allocator per turn, consumed
        // once per invocation (root included). The raw agent id never reaches the
        // header text (R2/R3); `resetProjection` clears it so a rebuilt turn
        // re-numbers from 1 in recorded order.
        const labels = createAgentLabels();

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
                    if (entry.row === undefined || isTerminalThread(entry.state)) continue;
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
        // `label` is the compact per-turn agent code (`RH1`) allocated once by the
        // caller for THIS invocation: the section header shows the code, never the
        // raw agent id (R2/R3). The id is still mirrored on `data-agent` by
        // `paintAgentColor` for colour/routing.
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
            const label = labels.next(options.agent);
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

            select.addEventListener('click', () => setThreadExpanded(entry, !entry.expanded));

            if (options.input !== undefined) renderThreadPrompt(entry, options.input);

            threads.set(options.key, entry);
            // R1: restore the reader's expansion across a rebuilt projection.
            if (expandedThreads.has(options.key)) setThreadExpanded(entry, true);
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

            // The root invocation consumes the first occurrence of its agent (the
            // requirement counts the entry agent too, R2). Its header label lives in
            // the section head; the tile header itself carries the metadata cluster.
            const label = labels.next(agentName);
            const section = createSection(flow, agentName, 'primary', label);
            // R1/F3: the compact root header shows the same code as a child header.
            // The section's own `.agent-head` is hidden by CSS for the primary part
            // (the code would otherwise appear twice); flat legacy subagent sections
            // keep their head because they are DIFFERENT agents that need telling apart.
            tileAgent.textContent = label;
            tileAgent.hidden = false;
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
            const label = labels.next(agentName);
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

        const entryFor = (event: HarnessEvent): ThreadEntry => {
            // Explicit metadata is authoritative (frozen runtime contract).
            const meta = threadOf(event);
            if (meta !== undefined) return entryForMeta(meta, event);

            return entryForLegacy(event);
        };

        const renderText = (block: TextBlock): void => {
            block.node.replaceChildren(markdownFragment(block.buffer));
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
            section.text = undefined;
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
            isError: boolean,
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
                    isError,
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
            card.resolve(content, isError);
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
            // Token figures derived from the discarded events must go too; the
            // server tally is re-applied by the caller after the rebuild.
            blockMeta.clearUsage();
            // R2: the rebuilt pass re-numbers the agents from 1 in recorded order, so
            // a replayed turn always shows the same labels.
            labels.reset();
            // The root code belongs to the discarded projection: hide it until the
            // replay's `rootSection` names the root agent again (F3).
            tileAgent.textContent = '';
            tileAgent.hidden = true;
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
                if (info !== undefined) return threads.get(info.id);

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
                    const outcome = resolveTool(
                        event.name,
                        event.content,
                        event.isError,
                        callId,
                        at,
                        origin,
                        toolDurationOf(event)
                    );

                    if (outcome !== undefined) {
                        // The settling event is also this invocation's clock stamp
                        // (a call can be the first thing an invocation does).
                        observeInvocation(outcome.entry, at, origin);

                        // A PRESENT array is the server's authoritative snapshot for
                        // that agent; otherwise the call that just settled is pruned
                        // from the per-call map. Absence alone is never read as "the
                        // queue drained" — the runtime omits `pending` when nothing
                        // remains, and siblings of another agent must stay listed.
                        const pending = pendingOf(event);
                        if (pending !== undefined) paintPending(outcome.section, pending);
                        else if (outcome.callId !== undefined) {
                            noteSettled(outcome.section, outcome.callId);
                        }
                    }

                    // The parent's result for the spawning call is the AUTHORITATIVE
                    // completion of that invocation (R3): an interim child `done`
                    // with pending work is not terminal, and a delegation cancelled
                    // before the child ever started still resolves its placeholder
                    // here. Matching is by callId, so same-agent siblings settle the
                    // right entry. Its block clock freezes at this event's stamp.
                    if (callId !== undefined) {
                        const child = findThreadByCallId(callId);
                        if (child !== undefined) {
                            const preview = plainPreview(event.content, 200);
                            completeThread(
                                child,
                                event.isError ? 'error' : 'done',
                                `${event.isError ? 'error' : 'outcome'} · ${preview.length === 0 ? 'no output' : preview}`
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
                    closeText(section);
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
                    const message = event.message;
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
                    if (entry.row !== undefined && (pending === undefined || pending.length === 0)) {
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
                    // the failing event's stamp (R1).
                    if (entry.row !== undefined) {
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
                    // IMPORTANT: the frame is emitted by the REQUESTING run, so its
                    // optional `thread` describes the SOURCE invocation, not the
                    // branch. The branch's own thread id is its branchId (runtime
                    // contract, harness.ts `withThread`), so the row key/anchor is
                    // derived from the summary and never from `event.thread`.
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

            for (let position = appliedCount; position < events.length; position += 1) {
                apply(events[position], times?.[position], 'recorded');
            }
            appliedCount = events.length;

            // The server owns the tally (see setUsage).
            setUsage(usageOf(source.usage));

            // Attachments are additive history: the record's chips replace the
            // optimistic draft chips. A text-only record clears them (the draft was
            // only ever a projection of what this turn carries).
            setAttachments(turnAttachmentsOf(source));

            setState(stateOf(source.status), model !== undefined && model.length > 0 ? model : undefined);
            flush();
        };

        // Clicking the header expands a compact tile; clicking the expanded tile
        // collapses it back to the compact list (so the whole conversation is
        // visible at once). Only one tile is ever expanded.
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
            bind,
            setTiming,
            elapsed: () => blockMeta.elapsed.textContent ?? '',
            tokens: () => blockMeta.tokens.textContent ?? '',
            setUsage,
            summary: () => ({ agents: threads.size, tools: toolCount, primary: primaryAgent }),
            attachments: () => attachmentRecords,
            setAttachments,
            destroy
        };

        turns.push(turn);
        // The card lives inside its row; the row is what the board appends,
        // removes and reorders, and it mirrors the tile state.
        element.append(row);
        // A queued tile paints no clock (nothing is running yet). `bind()` and
        // `setState('streaming')` start it from the server's start stamp, so a
        // task that waited in the queue is never charged for the wait.
        paintElapsed();
        // Newest turn opens full-width. This is the *only* moment the board
        // changes the selection on its own: stream deltas never steal the view.
        expand(turn);

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

        for (const node of [...element.querySelectorAll<HTMLElement>('.notice')]) node.remove();

        expandedTurn = undefined;
        if (empty !== undefined) element.append(empty);
    };

    // Route lookup by explicit server id. A stream frame names its `turnId`, so
    // the board never has to guess which tile a delta belongs to.
    const find = (id: string): TurnHandle | undefined => turns.find((candidate) => candidate.id() === id);

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
    const adopt = (source: SessionTurn, model?: string): TurnHandle => {
        // R3: the server `index` is not rendered, so adoption only needs the prompt;
        // the record's position is the list order (`reconcile` re-orders by record).
        // Attachments are passed to the optimistic render, then `merge` applies the
        // same record's list — one code path, no duplicated DOM.
        const handle = create(source.prompt, turnAttachmentsOf(source));
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
        const keepId = options.keep ?? expandedTurn?.id();
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

            ordered.push(adopt(source, options.model));
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

        // Appending an existing node MOVES it, which is how the order is fixed
        // without rebuilding any tile. Notices are re-anchored after the rows.
        for (const turn of next) {
            const row = turn.element.parentElement;
            if (row !== null) element.append(row);
        }
        for (const node of [...element.querySelectorAll<HTMLElement>('.notice')]) element.append(node);

        // Keep the reader where they were; collapse only if that turn disappeared.
        const kept = keepId === undefined ? undefined : next.find((handle) => handle.id() === keepId);
        if (kept !== undefined) expand(kept);
        else if (expandedTurn !== undefined && !next.includes(expandedTurn)) collapse();

        return next;
    };

    // Replace the board with the server's authoritative turn list. Expansion is
    // carried across the rebuild by turn id, so a reader looking at an older
    // turn is not yanked to the end by a poll or a terminal snapshot.
    const hydrate = (sources: readonly SessionTurn[], options: HydrateOptions = {}): TurnHandle[] => {
        const keepId = options.keep ?? expandedTurn?.id();

        clear();

        const handles = sources.map((source) => adopt(source, options.model));

        const kept = keepId === undefined ? undefined : handles.find((handle) => handle.id() === keepId);
        if (kept !== undefined) expand(kept);

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
        find,
        claim,
        adopt,
        hydrate,
        reconcile,
        destroy
    };
};

// Re-exported so callers can talk about tool state without importing tools.ts.
export type { ToolState };

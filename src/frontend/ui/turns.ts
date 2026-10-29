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
// Delegation — one agent calling another — shows up as extra agents inside the
// same turn (each event names its agent) and is labelled as a subagent.
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
//   - lifecycle status (topbar pill): src/frontend/main.ts (`setLifecycle`)
//   - elapsed formatting: src/frontend/ui/time.ts
//   - styles: src/frontend/styles.css (`.turns`, `.turn-row`, `.tile`, `.agent`)
//   - queue/ack race (R2): src/server/sessions.ts `enqueue` publishes the queued
//     `turn` upsert BEFORE the 202 body is returned, so an observer frame can
//     describe a turn whose optimistic tile is still unbound (`claim`).

import type { HarnessEvent, HarnessUsage, SessionTurn, SessionTurnStatus } from '../../server/protocol';
import {
    callIdOf,
    eventTimesOf,
    finiteOf,
    pendingOf,
    toolDurationOf,
    usageOf,
    wakeupOf
} from '../contract';
import type { HarnessPendingTool } from '../contract';
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

export type TurnBoard = {
    element: HTMLElement;
    begin: (prompt: string) => TurnHandle;
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

type AgentSection = {
    root: HTMLElement;
    flow: HTMLElement;
    meta: HTMLElement;
    role: HTMLElement;
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

// One unresolved tool call. `callId` is the authoritative match. A server that
// sends `tool_result` without a call id (legacy) is matched by name, oldest first;
// with concurrent calls that fallback is only used when no id is present, because
// it cannot tell two same-name siblings apart.
type PendingTool = {
    card: ToolCallCard;
    section: AgentSection;
    name: string;
    callId: string | undefined;
    startedAt: number | undefined;
};

export const createTurnBoard = (options: { empty?: HTMLElement } = {}): TurnBoard => {
    const element = el('div', 'turns');

    const turns: TurnHandle[] = [];
    let expandedTurn: TurnHandle | undefined;
    let sequence = 0;

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

    const begin = (prompt: string): TurnHandle => {
        sequence += 1;
        return create(prompt, sequence);
    };

    // One tile, shared by the optimistic `begin` path and server adoption. The
    // label is the 1-based display position; a server turn overrides it through
    // `bind()` so a hydrated transcript is numbered by the server's `index`.
    const create = (prompt: string, label: number): TurnHandle => {
        empty?.remove();

        const id = `turn-${++nextId}`;
        const card = el('article', 'tile');
        card.dataset.state = 'queued';

        // Row wrapper (R1): a plain full-width block, no marker and no rule
        // decoration. It stays a wrapper (rather than appending the card directly)
        // so `clear()`/`reconcile()` can remove a row without ever touching
        // `.turns` itself, and it mirrors the tile state for CSS (styles.css).
        const row = el('div', 'turn-row');
        row.dataset.state = 'queued';
        row.append(card);

        const select = el('button', 'tile-select');
        select.type = 'button';
        select.setAttribute('aria-expanded', 'false');
        select.setAttribute('aria-controls', `${id}-body`);

        const top = el('span', 'tile-top');
        const index = el('span', 'tile-index', `#${label}`);
        // Server-recorded or live elapsed time. Painted from `startedAt`; hidden
        // when the span is unknown (legacy fixture), never "NaN".
        const elapsedLabel = el('span', 'tile-elapsed');
        elapsedLabel.hidden = true;
        // Token tally, right after the elapsed label: the latest request's input
        // context with the turn's cumulative cached input in brackets
        // (`150 (140)`, different scopes; the title explains both). Hidden until
        // the first request reports usage, so a provider that sends none leaves the
        // header clean instead of claiming "0". The `|` separator is CSS
        // decoration (styles.css), not part of either value.
        const tokensLabel = el('span', 'tile-tokens');
        tokensLabel.hidden = true;
        const badge = el('span', 'tile-status');
        badge.dataset.state = 'queued';
        // No decorative dot: the status is TEXT (`tile-status-text`), visible on
        // an expanded tile and clipped — not removed — on a compact row, and the
        // colour lives on the row's border/status word. The compact row is plain.
        const statusText = el('span', 'tile-status-text', STATE_TEXT.queued);
        badge.append(statusText);

        const promptPreview = el('span', 'tile-prompt', plainPreview(prompt, 220));
        const meta = el('span', 'tile-meta', 'waiting for the first event');
        top.append(index, elapsedLabel, tokensLabel, badge);
        select.append(top, promptPreview, meta);

        const body = el('div', 'tile-body');
        body.id = `${id}-body`;

        // The prompt itself is rendered as Markdown too: users paste code fences
        // and lists into the composer, and the tile should read like the answer.
        const promptBlock = el('div', 'turn-prompt markdown');
        promptBlock.append(markdownFragment(prompt));
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
        // minutes, and counting that wait would be a lie. `startedAt` is set when
        // the tile actually starts working (`waiting`/`streaming`), or replaced by
        // the server's `startedAt` through `bind()`/`setTiming()`. `endedAt` is set
        // when the turn settles: the local clock for a live run, `updatedAt` on
        // hydration (which is why a poll/rebuild never resets the shown duration).
        let startedAt: number | undefined;
        let endedAt: number | undefined;
        let elapsedTick: number | undefined;
        // True once `setTiming` supplied recorded server stamps. A replay calls
        // `apply`/`setState` for every recorded event, and those must not wipe
        // the hydrated `endedAt` or start a local tick.
        let recordedTiming = false;

        const paintElapsed = (): void => {
            const span = elapsedBetween(startedAt, endedAt ?? Date.now());
            elapsedLabel.textContent = span === undefined ? '' : formatDuration(span);
            elapsedLabel.hidden = span === undefined;
        };

        const stopElapsed = (): void => {
            if (elapsedTick === undefined) return;

            window.clearInterval(elapsedTick);
            elapsedTick = undefined;
        };

        const startElapsed = (): void => {
            if (elapsedTick !== undefined || endedAt !== undefined || startedAt === undefined) return;

            // The label renders tenths of a second, so the tick is a quarter
            // second: enough resolution to look live, cheap enough to ignore.
            elapsedTick = window.setInterval(paintElapsed, 250);
        };

        const setTiming = (timing: { startedAt?: number; endedAt?: number }): void => {
            // Assign explicitly: an unknown server start must stay unknown, not
            // fall back to "now" (which would render a fabricated 0ms).
            recordedTiming = true;
            startedAt = finiteOf(timing.startedAt);
            endedAt = finiteOf(timing.endedAt);

            stopElapsed();
            paintElapsed();
            startElapsed();
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
        let tally: HarnessUsage | undefined;
        let latestInput: number | undefined;
        let eventCached = 0;
        let eventCachedReported = false;

        // Same grouping as the visible figure, for the explanatory title only.
        const titleNumber = new Intl.NumberFormat('en-US');
        const titleCount = (value: number): string => titleNumber.format(Math.trunc(Math.max(value, 0)));

        const paintTokens = (): void => {
            // Latest reported context; fall back to the cumulative input only when
            // no usage event was recorded (never on a live/hydrated turn that has
            // one, so the two scopes cannot silently collapse).
            const input = latestInput ?? tally?.input;
            const cached = tally?.cached ?? (eventCachedReported ? eventCached : undefined);
            const text = formatTokens(input, cached);

            tokensLabel.textContent = text;
            tokensLabel.hidden = text.length === 0;

            // R2: the compact numbers alone cannot express that they measure
            // different scopes. The title spells it out for both sighted and
            // assistive readers without adding a second visible line.
            if (text.length === 0) {
                tokensLabel.removeAttribute('title');
                return;
            }

            const context = input === undefined ? 'unknown' : titleCount(input);
            const cache = cached === undefined ? 'unknown' : titleCount(cached);
            // A legacy record with no events can only show the cumulative input;
            // say so instead of claiming it is the latest request's context.
            const scope =
                latestInput === undefined && tally !== undefined
                    ? 'Cumulative input (latest request not recorded)'
                    : 'Latest request context';
            tokensLabel.title =
                `${scope}: ${context} input tokens · ` +
                `Total cached input sent: ${cache} tokens`;
        };

        const setUsage = (usage?: HarnessUsage): void => {
            tally = usage;
            paintTokens();
        };

        const sections = new Map<string, AgentSection>();
        // Calls whose result has not arrived yet.
        const pendingTools: PendingTool[] = [];
        // Call ids already settled on this tile — a result applied, or a card
        // abandoned at the terminal transition. A repeated frame for one of these
        // is a DUPLICATE (retried event, replay overlap) and is ignored: it must not
        // add a second card or overwrite the first answer. Cleared with the
        // projection.
        const settledCalls = new Set<string>();

        const updateMeta = (): void => {
            const live = isLive(state);
            const parts: string[] = [];

            if (sections.size > 0) parts.push(`${sections.size} agent${sections.size === 1 ? '' : 's'}`);
            if (toolCount > 0) parts.push(`${toolCount} tool call${toolCount === 1 ? '' : 's'}`);
            // A completed response may still wait on background calls. The count is
            // summed across sections because a delegated child can be pending on its
            // own. NOTE: on a compact row the meta line is visually clipped (sr-only,
            // styles.css `.tile:not(.is-expanded) .tile-meta`); it is read out and
            // shown in full only when the tile is expanded.
            const pendingTotal = [...sections.values()].reduce(
                (total, section) => total + section.pendingCalls.size,
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
                if (startedAt !== undefined && endedAt === undefined && !recordedTiming) endedAt = Date.now();
                stopElapsed();
                // The turn is over, so nothing can still be pending: drop the
                // waiting line first (R6). A call left unsettled is INTERRUPTED —
                // cancel/restart never resumes it — so it is abandoned with a reason
                // instead of being frozen as a live-looking `running` card.
                for (const section of sections.values()) {
                    paintPending(section, []);
                    for (const tool of section.tools) {
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
            } else if (!recordedTiming) {
                endedAt = undefined;

                // The clock starts only when the task actually runs (R4). `queued`
                // deliberately does not start it; `waiting`/`streaming` do.
                if (next === 'waiting' || next === 'streaming') {
                    if (startedAt === undefined) startedAt = Date.now();
                    startElapsed();
                }
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

        const ensureSection = (agentName: string): AgentSection => {
            const existing = sections.get(agentName);
            if (existing !== undefined) return existing;

            // The first agent to emit anything in this turn is the primary one;
            // every other agent is a delegated subagent. This is inferred from
            // the event stream (the descriptor's agent order need not match the
            // configured primary), and only when the data actually says so.
            if (primaryAgent === undefined) primaryAgent = agentName;

            const root = el('section', 'agent');
            root.dataset.agent = agentName;
            const isPrimary = agentName === primaryAgent;
            root.dataset.role = isPrimary ? 'primary' : 'subagent';

            const head = el('header', 'agent-head');
            head.append(el('span', 'agent-name', agentName));
            const role = el('span', 'agent-role', isPrimary ? 'primary' : 'subagent');
            // A single-agent turn needs no role badge; it is added to the DOM
            // anyway so a later delegation can label an existing section without
            // rebuilding it.
            head.append(role);

            const sectionFlow = el('div', 'agent-flow');
            const agentMeta = el('div', 'agent-meta');

            root.append(head, sectionFlow, agentMeta);
            flow.append(root);

            const section: AgentSection = {
                root,
                flow: sectionFlow,
                meta: agentMeta,
                role,
                text: undefined,
                reasoning: undefined,
                tools: [],
                toolGroup: undefined,
                pending: undefined,
                pendingCalls: new Map()
            };

            sections.set(agentName, section);
            updateMeta();
            return section;
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

        const appendTool = (
            section: AgentSection,
            name: string,
            rawArguments: string,
            callId: string | undefined,
            at: number | undefined,
            origin: ApplyOrigin
        ): void => {
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
            pendingTools.push({ card, section, name, callId, startedAt });
            toolCount += 1;
            updateMeta();
        };

        // Outcome of applying one `tool_result`: which card it settled (undefined for
        // an ignored duplicate/late frame) and that card's owning section. The caller
        // uses it to prune the per-call pending display without treating an absent
        // `pending` field as a global drain.
        type ResolvedTool = { section: AgentSection; callId: string | undefined };

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
                return { section: tool.section, callId: tool.callId };
            }

            // No running call for this result. Once the turn is terminal, any such
            // frame is LATE (queued before the cancel/end, or a name-only result
            // after it): the runtime ignores results after detaching, so the tile
            // renders nothing rather than a phantom card.
            if (state !== 'streaming' && state !== 'waiting' && state !== 'queued') return undefined;

            // Genuine legacy result-only frame during a live turn (a protocol that
            // reports results without calls, or a missed tool_call): show it rather
            // than dropping information.
            const section = sections.get(primaryAgent ?? 'unknown') ?? ensureSection('unknown');
            const card = createToolCallCard(name, '');
            card.resolve(content, isError);
            toolGroupOf(section).append(card.element);
            section.tools.push(card);
            toolCount += 1;
            updateMeta();
            return { section, callId: undefined };
        };

        const appendAgentMeta = (agentName: string, text: string): void => {
            const section = ensureSection(agentName);
            section.meta.textContent = text;
        };

        // Discard everything the browser rendered from a now-superseded event
        // stream. Used only when a server record's event prefix DISAGREES with what
        // the tile applied (the record wins), never on a normal reconnect where the
        // prefix matches and only the remainder is appended.
        const resetProjection = (): void => {
            for (const section of sections.values()) {
                if (section.text !== undefined) cancel(section.text);
                for (const tool of section.tools) tool.destroy();
            }

            sections.clear();
            pendingTools.length = 0;
            settledCalls.clear();
            flow.replaceChildren();
            primaryAgent = undefined;
            toolCount = 0;
            appliedCount = 0;
            appliedEvents.length = 0;
            // Token figures derived from the discarded events must go too; the
            // server tally is re-applied by the caller after the rebuild.
            latestInput = undefined;
            eventCached = 0;
            eventCachedReported = false;
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

            // Background-tool wakeup (R6). A wake is a RESUME, so it must not
            // settle the tile, resolve a card, or stop any timer — it only makes
            // the un-parking visible and replaces the pending snapshot the server
            // just reported. `wakeupOf` rejects a frame without a `pending` array:
            // such a frame falls through with no rendering and no pending update
            // (absence must not claim "everything settled").
            const wakeup = wakeupOf(event);
            if (wakeup !== undefined) {
                const section = ensureSection(wakeup.agent);
                appendWakeup(section, wakeup.pending);
                paintPending(section, wakeup.pending);
                updateMeta();
                return;
            }

            switch (event.type) {
                case 'start': {
                    const section = ensureSection(event.agent);
                    // A second agent in the same turn is a delegation; relabel
                    // rather than guess up front.
                    section.root.dataset.role = event.agent === primaryAgent ? 'primary' : 'subagent';
                    section.role.textContent = event.agent === primaryAgent ? 'primary' : 'subagent';
                    section.root.dataset.model = event.model;
                    break;
                }

                case 'reasoning':
                    appendReasoning(ensureSection(event.agent), event.delta);
                    break;

                case 'text':
                    appendText(ensureSection(event.agent), event.delta);
                    break;

                case 'tool_call':
                    appendTool(
                        ensureSection(event.agent),
                        event.call.name,
                        event.call.arguments,
                        event.call.id,
                        at,
                        origin
                    );
                    break;

                case 'tool_result': {
                    const outcome = resolveTool(
                        event.name,
                        event.content,
                        event.isError,
                        callIdOf(event),
                        at,
                        origin,
                        toolDurationOf(event)
                    );

                    if (outcome !== undefined) {
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
                case 'usage': {
                    const reported = finiteOf(event.usage.input);
                    if (reported !== undefined) latestInput = reported;

                    const cached = finiteOf(event.usage.cached);
                    if (cached !== undefined) {
                        eventCachedReported = true;
                        eventCached += Math.max(cached, 0);
                    }

                    paintTokens();
                    break;
                }

                case 'done': {
                    const section = ensureSection(event.agent);
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
                    break;
                }

                case 'error': {
                    const section = ensureSection(event.agent);
                    closeText(section);
                    // The error notice is not a chip, so the next call starts a
                    // fresh row below it.
                    closeToolGroup(section);
                    const error = el('div', 'agent-error');
                    error.append(el('span', 'agent-error-label', 'error'), el('span', 'agent-error-text', event.error.message));
                    section.flow.append(error);
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
            for (const section of sections.values()) flushText(section);
        };

        // Attach the server identity. `index` is 0-based on the wire; tiles are
        // numbered from 1 so the first turn reads "#1". A late bind (the opening
        // `turn` frame) is normal, not an error: the optimistic tile existed
        // before the request reached the server. When the start stamp arrives it
        // replaces the local baseline, so a later hydrate and the live label agree.
        const bind = (server: Pick<SessionTurn, 'id' | 'index'> & { startedAt?: number }): void => {
            serverId = server.id;
            card.dataset.turnId = server.id;
            index.textContent = `#${server.index + 1}`;

            // A queued turn has no `startedAt` yet (optional until execution), so a
            // queued tile keeps its clock hidden. Once the server supplies a start,
            // it replaces the local baseline and the tick resumes if still live.
            const serverStart = finiteOf(server.startedAt);
            if (serverStart !== undefined) {
                startedAt = serverStart;
                paintElapsed();
                if (isLive(state) && endedAt === undefined) startElapsed();
            }
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
        // a cleared board or a hidden page must not keep ticking.
        const destroy = (): void => {
            stopElapsed();

            for (const section of sections.values()) {
                if (section.text !== undefined) cancel(section.text);
                for (const tool of section.tools) tool.destroy();
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
            bind,
            setTiming,
            elapsed: () => elapsedLabel.textContent ?? '',
            tokens: () => tokensLabel.textContent ?? '',
            setUsage,
            summary: () => ({ agents: sections.size, tools: toolCount, primary: primaryAgent }),
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
        sequence = 0;
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
        sequence += 1;

        const handle = create(source.prompt, source.index + 1);
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

    return {
        element,
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

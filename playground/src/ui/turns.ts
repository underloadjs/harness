// Turn tiles: one tile per logical user → assistant exchange.
//
// Turn boundaries are server data, not browser inference. The server records one
// `SessionTurn` per submitted task (`id`, `index`, `prompt`, `status`, `events`)
// and returns that list from `GET /sessions`, `GET /sessions/:id` and in the
// terminal frame of every stream. This module renders those records:
//
//   - `begin(prompt)` creates an optimistic tile for a prompt the browser is
//     about to submit, before the server has a turn for it;
//   - `bind(turn)` attaches the server id/index when the stream's opening `turn`
//     frame arrives, so later `event` frames route by explicit id;
//   - `adopt(turn)` / `hydrate(turns)` rebuild tiles from a server snapshot by
//     replaying the recorded events in order. This is how a reload, a session
//     selection or an in-progress poll renders history: the server record wins
//     over anything the browser had projected locally.
//
// Delegation — one agent calling another — shows up as extra agents inside the
// same turn (each event names its agent) and is labelled as a subagent.
//
// Layout model:
//   - every turn is a square-ish tile in a responsive grid that fills left to
//     right; compact tiles show a preview, the status and counts;
//   - exactly one tile is expanded at a time, and the newest turn is expanded as
//     soon as it starts;
//   - expanding an older tile never destroys the newest turn's content: tiles
//     keep their DOM, only visibility changes, so a user reading turn 3 is not
//     pulled away by deltas arriving for turn 7.
//
// Rendering model: assistant text is Markdown, re-rendered per animation frame
// while it streams (see playground/src/ui/markdown.ts for the sanitizer) and
// synced once when the turn settles. Reasoning is plain text: it is scratch
// space, not user-facing prose, and re-parsing it as Markdown would be wasted
// work for every delta.
//
// Cross-references:
//   - tool cards: playground/src/ui/tools.ts
//   - lifecycle status (topbar pill): playground/src/main.ts (`setLifecycle`)
//   - elapsed formatting: playground/src/ui/time.ts
//   - styles: playground/src/styles.css (`.turns`, `.tile`, `.agent`)

import type { HarnessEvent, SessionTurn, SessionTurnStatus } from '../../../server/protocol';
import { callIdOf, eventTimesOf, finiteOf } from '../contract';
import { markdownFragment, plainPreview } from './markdown';
import { elapsedBetween, formatDuration } from './time';
import { createToolCallCard } from './tools';
import type { ToolCallCard, ToolState } from './tools';

// Lifecycle of one user turn. `queued` and `waiting` are distinct on purpose:
// `queued` means the browser has the prompt but has not got a session yet,
// `waiting` means the request is on the wire and the first event has not arrived.
// Anything later is driven by real events, never by a timer.
//
// Server statuses map onto this set one-to-one (`running` → `streaming`); the two
// pre-request states only ever exist for an optimistic browser-created tile.
export type TurnState = 'queued' | 'waiting' | 'streaming' | 'done' | 'error' | 'cancelled';

// Server status → tile state. A running server turn is "streaming" even when the
// browser is polling a snapshot instead of holding a live stream.
const stateOf = (status: SessionTurnStatus): TurnState => (status === 'running' ? 'streaming' : status);

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
    // Build one tile from an authoritative server record (replays its events).
    adopt: (turn: SessionTurn, model?: string) => TurnHandle;
    // Replace the whole board with the server's turns. Returns the new handles;
    // any previous handle is detached and must not be used again.
    hydrate: (turns: readonly SessionTurn[], options?: HydrateOptions) => TurnHandle[];
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

// States that mean "work is in flight". Drives the animated dot; the text next
// to it is the accessible signal.
const isLive = (state: TurnState): boolean =>
    state === 'queued' || state === 'waiting' || state === 'streaming';

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
};

// One unresolved tool call. `callId` is the authoritative match; name+order is the
// fallback for a server that sends `tool_result` without a call id.
type PendingTool = {
    card: ToolCallCard;
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
        const badge = el('span', 'tile-status');
        badge.dataset.state = 'queued';
        const dot = el('span', 'tile-dot');
        dot.setAttribute('aria-hidden', 'true');
        const statusText = el('span', 'tile-status-text', STATE_TEXT.queued);
        badge.append(dot, statusText);

        const promptPreview = el('span', 'tile-prompt', plainPreview(prompt, 220));
        const meta = el('span', 'tile-meta', 'waiting for the first event');
        top.append(index, elapsedLabel, badge);
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

        // --- timing --------------------------------------------------------
        // An optimistic tile starts on the local clock; `bind()`/`setTiming()`
        // replace that with the server's `startedAt`. `endedAt` is set when the
        // turn settles: the local clock for a live run, `updatedAt` on hydration
        // (which is why a poll/rebuild never resets the shown duration).
        let startedAt: number | undefined = Date.now();
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

        const sections = new Map<string, AgentSection>();
        // Calls whose result has not arrived yet. `callId` is the authoritative
        // match when the server sends it; otherwise the match is by tool name,
        // oldest first — which is the order the harness runs them in.
        const pendingTools: PendingTool[] = [];

        const updateMeta = (): void => {
            const live = isLive(state);
            const parts: string[] = [];

            if (sections.size > 0) parts.push(`${sections.size} agent${sections.size === 1 ? '' : 's'}`);
            if (toolCount > 0) parts.push(`${toolCount} tool call${toolCount === 1 ? '' : 's'}`);
            if (detail !== undefined && detail.length > 0) parts.push(detail);
            if (parts.length === 0) parts.push(live ? 'waiting for the first event' : 'no events yet');

            meta.textContent = parts.join(' · ');
        };

        const setState = (next: TurnState, nextDetail?: string): void => {
            state = next;
            detail = nextDetail;

            // Terminal states freeze the elapsed label. Hydration may already have
            // supplied the server's `updatedAt`; in that case keep it instead of
            // overwriting it with the replay's local clock.
            if (next === 'done' || next === 'error' || next === 'cancelled') {
                if (endedAt === undefined && !recordedTiming) endedAt = Date.now();
                stopElapsed();
                // A tool call left pending when the run ended must not keep a live
                // ticker running on a settled tile.
                for (const section of sections.values()) {
                    for (const tool of section.tools) {
                        if (tool.state() === 'running') tool.destroy();
                    }
                }
            } else if (!recordedTiming) {
                endedAt = undefined;
                startElapsed();
            }

            paintElapsed();
            card.dataset.state = next;
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
                tools: []
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

        const appendText = (section: AgentSection, delta: string): void => {
            if (section.text === undefined) {
                const node = el('div', 'markdown agent-text');
                section.flow.append(node);
                section.text = { node, buffer: '', handle: undefined, viaFrame: false };
            }

            const block = section.text;
            block.buffer += delta;
            schedule(block, () => renderText(block));
        };

        const appendReasoning = (section: AgentSection, delta: string): void => {
            if (section.reasoning === undefined) {
                const details = el('details', 'thinking');
                const summary = el('summary', 'thinking-summary', 'reasoning');
                const reasoningBody = el('div', 'reasoning');
                details.append(summary, reasoningBody);
                section.flow.append(details);
                section.reasoning = { details, summary, body: reasoningBody, buffer: '' };
            }

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
            section.flow.append(card.element);
            pendingTools.push({ card, name, callId, startedAt });
            toolCount += 1;
            updateMeta();
        };

        const resolveTool = (
            name: string,
            content: string,
            isError: boolean,
            callId: string | undefined,
            at: number | undefined,
            origin: ApplyOrigin
        ): void => {
            // Authoritative match first, then the documented fallback: same name,
            // oldest running call.
            let index =
                callId === undefined
                    ? -1
                    : pendingTools.findIndex(
                          (tool) => tool.callId === callId && tool.card.state() === 'running'
                      );

            if (index < 0) {
                index = pendingTools.findIndex(
                    (tool) => tool.name === name && tool.card.state() === 'running'
                );
            }

            const finishedAt = at ?? (origin === 'live' ? Date.now() : undefined);

            if (index >= 0) {
                const [tool] = pendingTools.splice(index, 1);
                tool.card.resolve(content, isError, elapsedBetween(tool.startedAt, finishedAt));
                return;
            }

            // A result with no matching call (a retried event, or a protocol that
            // reports only results): show it rather than dropping information.
            const section = sections.get(primaryAgent ?? 'unknown') ?? ensureSection('unknown');
            const card = createToolCallCard(name, '');
            card.resolve(content, isError);
            section.flow.append(card.element);
            section.tools.push(card);
            toolCount += 1;
            updateMeta();
        };

        const appendAgentMeta = (agentName: string, text: string): void => {
            const section = ensureSection(agentName);
            section.meta.textContent = text;
        };

        // --- events -------------------------------------------------------
        // `at` is the server clock for this event. A live frame arrives with one
        // on the new server; local date is only the fallback. `origin` keeps the
        // replay path honest for records that predate timing support.
        const apply = (event: HarnessEvent, at?: number, origin: ApplyOrigin = 'live'): void => {
            if (isLive(state) && state !== 'streaming') setState('streaming');

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

                case 'tool_result':
                    resolveTool(
                        event.name,
                        event.content,
                        event.isError,
                        callIdOf(event),
                        at,
                        origin
                    );
                    break;

                case 'done': {
                    const section = ensureSection(event.agent);
                    closeText(section);

                    // `done` closes one *agent* turn, which may be a subagent
                    // nested inside a tool call. The user turn only settles when
                    // the stream itself ends, so the tile state is left alone.
                    const message = event.message;
                    const parts = [message.model, message.stopReason];
                    if (message.toolCalls.length > 0) {
                        parts.push(`${message.toolCalls.length} tool call${message.toolCalls.length === 1 ? '' : 's'}`);
                    }
                    if (message.usage !== undefined) parts.push(`${message.usage.total} tokens`);
                    section.meta.textContent = parts.join(' · ');
                    break;
                }

                case 'error': {
                    const section = ensureSection(event.agent);
                    closeText(section);
                    const error = el('div', 'agent-error');
                    error.append(el('span', 'agent-error-label', 'error'), el('span', 'agent-error-text', event.error.message));
                    section.flow.append(error);
                    break;
                }
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

            const serverStart = finiteOf(server.startedAt);
            if (serverStart !== undefined) {
                startedAt = serverStart;
                paintElapsed();
            }
        };

        // Clicking the header expands a compact tile; clicking the expanded tile
        // collapses it back to the grid (so the whole conversation is visible at
        // once). Only one tile is ever expanded.
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
            flush,
            id: () => serverId,
            bind,
            setTiming,
            elapsed: () => elapsedLabel.textContent ?? '',
            summary: () => ({ agents: sections.size, tools: toolCount, primary: primaryAgent }),
            destroy
        };

        turns.push(turn);
        element.append(card);
        // Paint the optimistic "0ms" and start counting; `bind`/`setTiming`
        // re-baseline without ever showing a negative or a NaN.
        paintElapsed();
        startElapsed();
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
            turn.element.remove();
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

    // Rebuild one tile from the server's record. Replaying the events (rather
    // than trusting browser state) is what makes a reload render the same
    // transcript: `events` includes subagent events the server recorded.
    const adopt = (source: SessionTurn, model?: string): TurnHandle => {
        sequence += 1;

        const handle = create(source.prompt, source.index + 1);
        handle.bind(source);

        // Server timing wins over the replay clock. A running turn keeps ticking
        // from `startedAt`; a settled turn freezes at `updatedAt`. Legacy records
        // have neither, so `setTiming` gets undefined and the label stays hidden.
        handle.setTiming({
            startedAt: finiteOf(source.startedAt),
            endedAt: source.status === 'running' ? undefined : finiteOf(source.updatedAt)
        });

        // `eventTimes` is aligned 1:1 with `events`. When the server sent none,
        // pass no timestamp at all in recorded mode: tool cards then show no
        // duration instead of a fabricated one.
        const times = eventTimesOf(source);
        for (let index = 0; index < source.events.length; index += 1) {
            handle.apply(source.events[index], times?.[index], 'recorded');
        }

        const next = stateOf(source.status);
        const settled = next === 'done' || next === 'error' || next === 'cancelled';
        // `model · status` in the meta line keeps a reloaded tile as informative
        // as the one that streamed live. A running turn has no detail: its meta
        // is the agent/tool count and the live status badge already says more.
        handle.setState(next, settled && model !== undefined && model.length > 0 ? `${model} · ${source.status}` : undefined);
        handle.flush();

        return handle;
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
        adopt,
        hydrate,
        destroy
    };
};

// Re-exported so callers can talk about tool state without importing tools.ts.
export type { ToolState };

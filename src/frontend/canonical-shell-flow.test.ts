// T50 — the END-TO-END canonical browser smoke test.
//
// Everything else in this folder drives the shell through the TEST-ONLY `/api` double
// (`withViewRoutes`), which re-expresses a legacy fixture as canonical answers. That is fine
// for pinning behaviour, but it can also MASK a wire bug: if the fixture's raw body and the
// generated contract disagree, only the double is wrong and the test still passes.
//
// This file has no double at all. Every body below is written BY HAND in the exact spelling of
// the generated contract (../shared/harness-api.ts), every route is the canonical
// `/v1/harness/...` route the client dials, and the realtime plane is the `harness.v1` socket
// double (./view-test-support.ts `installHarnessStream`) — which is the only live surface the
// client has (./stream.ts has no SSE fallback). A strict stub throws for any route the shell
// asks that this file did not declare, so a back-compat request, an eager history read, or a
// invented field name fails HERE rather than being papered over.
//
// What it walks, in one continuous user gesture:
//   boot (the six bounded reads) → open the tools view → select a core tool → its argument
//   template comes from the IDENTIFIED tool read (the catalogue page has no schema) → call it
//   inside the playground's temporary session → return to the chat → submit a task → the RECEIPT
//   paints the row with no session re-read → the socket's frames settle the same row.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts src/frontend/canonical-shell-flow.test.ts
import { HARNESS_SERVICE_CAPABILITIES, HARNESS_SERVICE_LIMITS, HARNESS_PAGE_LIMIT } from '../shared/harness-api';
import type { HarnessStreamOptions, StreamDouble } from './view-test-support';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const T = 1_700_000_000_000;
const SESSION_KEY = 'underload-harness-app:session';
const ROOT = '/v1/harness';

type Call = { url: string; method: string; body: unknown };

// Recorded by the stub itself: every request the SHELL dialled, in the browser's own spelling.
let calls: Call[] = [];

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (rounds = 1): Promise<void> => {
    for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setTimeout(resolve, 30));
};

// ---------------------------------------------------------------------------
// The hand-written canonical bodies
// ---------------------------------------------------------------------------

// `PageMeta` (../shared/harness-api.ts) is the same envelope for every list.
const page = <T>(items: T[], nextCursor: string | null = null): Record<string, unknown> => ({
    items,
    limit: HARNESS_PAGE_LIMIT.default,
    next_cursor: nextCursor,
    observed_at: T,
    revision: 1
});

// A harness CARD: identity and the team, with no per-agent instruction text or model map
// (those are the identified read's, and the smoke path never opens that dialog).
const HARNESS_CARD = {
    name: 'instruct',
    title: 'Instruct',
    description: 'A general instruction-following agent.',
    requires_endpoint: true,
    primary: 'instruct',
    subagents: [],
    agents: ['instruct'],
    tools: ['read'],
    core_tools: ['task'],
    definition_revision: 1,
    builtin: true,
    editable: true
};

// `ToolSummary` (../shared/harness-api.ts:640): the catalogue ROW. It carries NO `parameters`
// — that is the point of the identified read this test exists to pin.
const TASK_ROW = {
    name: 'task',
    group: 'Core tools',
    description: 'Read or update the session task list.',
    tags: ['core', 'harness'],
    visibility: 'core',
    session_bound: true
};

// `ToolDetail` (same file :654): the row plus the argument schema and the execution scope.
const TASK_DETAIL = {
    ...TASK_ROW,
    parameters: {
        type: 'object',
        properties: { input: { type: 'string', description: 'Merge payload.' } },
        required: ['input'],
        additionalProperties: false
    },
    execution: { scope: 'session_required', manual: true }
};

// `SessionResource` (snake_case) as one metadata read answers it. Counters replace children —
// an open never receives a turn, a thread transcript or an event.
const sessionResource = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'pl-1',
    harness: 'instruct',
    status: 'idle',
    model: 'm1',
    created_at: T,
    updated_at: T,
    turn_count: 0,
    thread_count: 0,
    revision: 1,
    definition_revision: 1,
    agent_models: { instruct: 'm1' },
    endpoint: { base_url: 'http://provider/v1', model: 'm1', has_api_key: false },
    runtime_execution: 'inline',
    pending_action_count: 0,
    created_tool_count: 0,
    created_tool_limit: HARNESS_SERVICE_LIMITS.created_tools,
    ...overrides
});

// `ThreadSummary` (transcript SIGNALS only, snake_case).
const threadRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'thread-1',
    agent: 'instruct',
    origin: 'host',
    status: 'idle',
    sequence: 1,
    label: 'IN1',
    transcript_state: 'ok',
    message_count: 2,
    has_transcript: true,
    ...overrides
});

// One recorded frame set for the live run: the shape the server's own projector folds into
// `turn.upsert` / `display.ops` / `session.updated` (./view-test-support.ts stream double).
const runningTurn = {
    id: 't1',
    index: 0,
    prompt: 'smoke task',
    status: 'running',
    threadId: 'thread-1',
    startedAt: T,
    updatedAt: T + 10,
    events: [{ type: 'start', agent: 'instruct', model: 'm1' }]
};
const finishedTurn = {
    ...runningTurn,
    status: 'done',
    updatedAt: T + 200,
    events: [
        ...runningTurn.events,
        { type: 'text', agent: 'instruct', delta: 'smoke answer' },
        {
            type: 'done',
            agent: 'instruct',
            message: { role: 'assistant', content: 'smoke answer', reasoning: '', toolCalls: [], model: 'm1', stopReason: 'stop' }
        }
    ]
};

const stub = (sessions: Record<string, unknown>[]): void => {
    calls = [];

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method === undefined ? 'GET' : String(init.method);
            const body = init?.body === undefined || typeof init.body !== 'string' ? undefined : JSON.parse(init.body);
            calls.push({ url, method, body });

            const path = url.split('?')[0] ?? url;

            // --- boot: six bounded reads, each one page ----------------------------------
            if (path === ROOT && method === 'GET') {
                return json({
                    api_root: ROOT,
                    service: 'harness',
                    api_version: 'v1',
                    server_time: T,
                    epoch: 'smoke-epoch',
                    capabilities: HARNESS_SERVICE_CAPABILITIES,
                    limits: HARNESS_SERVICE_LIMITS,
                    links: {}
                });
            }
            if (path === `${ROOT}/config`) return json({ defaults: { base_url: 'http://provider/v1', model: 'm1', has_api_key: false }, writable_fields: ['settings.base_url', 'settings.model', 'settings.api_key'], revision: 1 });
            if (path === `${ROOT}/harnesses`) return json(page([HARNESS_CARD]));
            if (path === `${ROOT}/tools`) return json(page([TASK_ROW]));
            if (path === `${ROOT}/agents`) return json(page([]));
            if (path === `${ROOT}/sessions` && method === 'GET') return json(page(sessions));
            if (path === `${ROOT}/models` && method === 'POST') return json({ models: ['m1'] });

            // --- the identified tool read: the ONLY place `parameters` exists -------------
            if (path === `${ROOT}/tools/task` && method === 'GET') return json({ tool: TASK_DETAIL });

            // --- the playground's temporary session --------------------------------------
            if (path === `${ROOT}/sessions` && method === 'POST') return json({ session: sessionResource() }, 201);
            // Leaving the tools view deletes the context this browser created (R7) — a real
            // delete on a real route, not a local forget.
            if (path === `${ROOT}/sessions/pl-1` && method === 'DELETE') return json({ deleted: true });
            if (path === `${ROOT}/sessions/pl-1/tools/task/executions` && method === 'POST') {
                return json({ ok: true, result: 'queued', duration_ms: 4 });
            }

            // --- the reader's conversation: an OPEN thread with no history yet -------------
            // A session open costs metadata + rows + roster + questions. It never receives an
            // event, a transcript or a tree it did not ask for, and with no rows there is no tree
            // read at all — which is what the assertions below count.
            if (path === `${ROOT}/sessions/chat-1` && method === 'GET') {
                return json({ session: sessionResource({ id: 'chat-1', turn_count: 0, thread_count: 1 }) });
            }
            if (path === `${ROOT}/sessions/chat-1/turns` && method === 'GET') return json(page([]));
            if (path === `${ROOT}/sessions/chat-1/threads` && method === 'GET') return json(page([threadRow()]));
            if (path === `${ROOT}/sessions/chat-1/actions` && method === 'GET') {
                return json({ session_id: 'chat-1', actions: [], revision: 1 });
            }
            // The lazy tree read: fired ONLY once the reader expands the row (T24), which is why
            // the boot assertions above count zero of them. `TurnDisplay` in the projector's own
            // spelling — `turnId`, one primary section with its context blocks, no nodes yet
            // because the run has recorded nothing but its `start`.
            if (path === `${ROOT}/sessions/chat-1/turns/t1/display` && method === 'GET') {
                return json({
                    display: {
                        turnId: 't1',
                        sections: [
                            {
                                id: 't1:0',
                                role: 'primary',
                                agent: 'instruct',
                                agentLabel: 'IN1',
                                threadId: 'thread-1',
                                nodes: [],
                                context: [
                                    {
                                        kind: 'user',
                                        id: '0-user-prompt',
                                        turnId: 't1',
                                        sectionId: 't1:0',
                                        name: 'prompt',
                                        at: T,
                                        chars: 'smoke task'.length,
                                        inPrompt: true
                                    }
                                ],
                                state: 'running',
                                model: 'm1'
                            }
                        ],
                        // The window's own counter: an op frame is compared against the tree it
                        // addresses, so a read that omits it cannot be reconciled with the stream.
                        revision: 1
                    }
                });
            }

            // A submit answers a RECEIPT: identity, placement, the moved revision. Not a
            // session, not a turn record (../shared/harness-api.ts:1194-1209).
            if (path === `${ROOT}/sessions/chat-1/tasks` && method === 'POST') {
                return json(
                    {
                        session_id: 'chat-1',
                        turn_id: 't1',
                        status: 'running',
                        thread_id: 'thread-1',
                        queue_position: 0,
                        session_revision: 2,
                        accepted_at: T + 1,
                        links: {
                            turn: `${ROOT}/sessions/chat-1/turns/t1`,
                            turns: `${ROOT}/sessions/chat-1/turns?limit=25`,
                            thread: `${ROOT}/sessions/chat-1/threads/thread-1`,
                            stream: `${ROOT}/stream`
                        }
                    },
                    202
                );
            }

            throw new Error(`unexpected request: ${method} ${url}`);
        })
    );
};

const byClass = <K extends keyof HTMLElementTagNameMap>(selector: string, tag: K): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);
    return found;
};

const dialed = (method: string, path: string): number =>
    calls.filter((call) => call.method === method && (call.url.split('?')[0] ?? call.url) === path).length;

// The socket double must be resolved by a DYNAMIC import: `vi.resetModules()` clears the module
// registry, so a statically imported helper would configure the PREVIOUS graph's singleton while
// `main.ts` dials a fresh `./stream` with no factory at all (the rule main.test.ts:254-263 states).
const liveSocket = async (options: HarnessStreamOptions): Promise<StreamDouble> => {
    const support = await import('./view-test-support');

    return support.installHarnessStream(options);
};

const subscribed = async (stream: StreamDouble, scope: string, sessionId?: string): Promise<StreamDouble> => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const registered = stream.subscriptions.some(
            (sub) => sub.scope === scope && (sessionId === undefined || sub.session_id === sessionId)
        );
        if (registered) return stream;

        await flush();
    }

    throw new Error(`the shell never opened a ${scope} subscription${sessionId === undefined ? '' : ` for ${sessionId}`}`);
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(async () => {
    vi.unstubAllGlobals();

    const { resetHarnessStream } = await import('./stream');
    resetHarnessStream();
});

it('boots, runs a core tool through its identified read, then submits and settles over the socket', async () => {
    // The conversation the reader already has, as a canonical DIRECTORY ROW: metadata plus
    // counters, with no turns and no threads inside it.
    const chat = sessionResource({ id: 'chat-1', turn_count: 1, thread_count: 1, updated_at: T + 300 });
    localStorage.setItem(SESSION_KEY, 'chat-1');

    const socket = await liveSocket({ sessionId: 'chat-1' });
    stub([chat]);

    await import('./main');
    await flush(2);

    // --- 1. boot is exactly the six bounded reads plus provider discovery ---------------
    // No `/api`, no aggregate boot document, no conversation history, no SSE observer route.
    expect(calls.every((call) => call.url.startsWith(ROOT))).toBe(true);
    expect(dialed('GET', `${ROOT}/sessions/chat-1`)).toBe(1);
    expect(dialed('GET', `${ROOT}/sessions/chat-1/turns`)).toBe(1);
    expect(dialed('GET', `${ROOT}/sessions/chat-1/threads`)).toBe(1);
    expect(dialed('GET', `${ROOT}/sessions/chat-1/actions`)).toBe(1);
    expect(calls.some((call) => call.url.includes('/events'))).toBe(false);

    // An empty conversation paints no tile and costs NO display-tree read: trees are fetched for
    // the rows that exist, and there are none.
    expect(document.querySelectorAll('.tile')).toHaveLength(0);
    expect(dialed('GET', `${ROOT}/sessions/chat-1/turns/t1/display`)).toBe(0);

    // --- 2. the tools view: a row has no schema, so the template needs the identified read --
    byClass('.tools-toggle', 'button').click();
    await flush();

    byClass('.tool-tab-button[data-tool="task"]', 'button').click();
    await flush(2);

    // One identified read for the opened tool, and its schema is on screen: the catalogue row
    // carries NO `parameters` (../shared/harness-api.ts:636-648), so the schema pane can only show
    // this text if the runner merged `GET /v1/harness/tools/{id}`. The box itself starts from the
    // tool's first NAMED preset (the curated `task` read), which is the correct fill.
    expect(dialed('GET', `${ROOT}/tools/task`)).toBe(1);
    const panes = [...document.querySelectorAll<HTMLElement>('.tool-card pre')].map((node) => node.textContent ?? '');
    expect(panes.some((text) => text.includes('"properties"') && text.includes('"input"'))).toBe(true);
    expect(JSON.parse(byClass('.tool-args', 'textarea').value)).toEqual({});

    // --- 3. a session-bound call runs in the playground's OWN session --------------------
    byClass('.tool-args', 'textarea').value = JSON.stringify({ input: 'smoke' });
    byClass('.tool-card button.primary', 'button').click();
    await flush(2);

    expect(dialed('POST', `${ROOT}/sessions`)).toBe(1);
    expect(
        calls.find((call) => call.method === 'POST' && call.url === `${ROOT}/sessions/pl-1/tools/task/executions`)
    )?.toEqual({
        url: `${ROOT}/sessions/pl-1/tools/task/executions`,
        method: 'POST',
        body: { parameters: { input: 'smoke' } }
    });
    expect(JSON.parse(byClass('.tool-output .card-body', 'pre').textContent ?? '')).toEqual({
        ok: true,
        result: 'queued',
        duration_ms: 4
    });

    // Re-opening the same tool costs NO second schema read (the memo lives until the catalogue
    // page is replaced).
    byClass('.dialog-close', 'button').click();
    await flush();
    byClass('.tool-tab-button[data-tool="task"]', 'button').click();
    await flush(2);
    expect(dialed('GET', `${ROOT}/tools/task`)).toBe(1);

    // --- 4. back to the chat: the submit answers a receipt, the socket finishes the job ---
    byClass('.tools-toggle', 'button').click();
    await flush();

    const rowReadsBefore = dialed('GET', `${ROOT}/sessions/chat-1`);
    const input = byClass('.composer-input', 'textarea');
    input.value = 'smoke task';
    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush(2);

    // The accepted row is on screen, and NOTHING else was fetched to put it there: no second
    // session read, no row page, no document.
    expect(dialed('POST', `${ROOT}/sessions/chat-1/tasks`)).toBe(1);
    expect(dialed('GET', `${ROOT}/sessions/chat-1`)).toBe(rowReadsBefore);
    expect(document.querySelectorAll('.tile')).toHaveLength(1);

    // The live plane is the socket, and the shell asked for the session scope it needs.
    await subscribed(socket, 'session', 'chat-1');

    socket.push([{ type: 'turn', turn: runningTurn }]);
    await flush();
    expect(byClass('.tile', 'article').dataset.state).toBe('streaming');

    // The reader opens the row. THAT is the gesture the tree read belongs to — never a render
    // path, and never a replay of recorded events.
    byClass('.tile .tile-select', 'button').click();
    await flush(2);
    expect(dialed('GET', `${ROOT}/sessions/chat-1/turns/t1/display`)).toBe(1);

    socket.push([
        { type: 'event', turnId: 't1', event: { type: 'text', agent: 'instruct', delta: 'smoke answer' }, at: T + 100 },
        { type: 'event', turnId: 't1', event: finishedTurn.events[2], at: T + 200 }
    ]);
    await flush();

    // The visible turn also has a FLOW subscription: the ops plane is wired to the row the
    // reader is looking at (the text a delta carries is painted from those ops, never from a
    // replay of recorded events).
    await subscribed(socket, 'turn', 'chat-1');

    // The terminal snapshot frame settles the row and drains the queue.
    socket.push([
        {
            type: 'snapshot',
            session: {
                ...sessionResource({ id: 'chat-1', turn_count: 1, thread_count: 1, updated_at: T + 400 }),
                turns: [finishedTurn]
            }
        } as never
    ]);
    await flush(2);

    expect(byClass('.tile', 'article').dataset.state).toBe('done');
    // The app pill stays app-scoped: a run that finished cleanly leaves it `idle`, and no
    // request-level failure (an undeclared route) is hiding behind it.
    expect(document.querySelector('.status-text')?.textContent).toBe('idle');
    expect(document.querySelector('.status-detail')?.textContent).toBe('');
    // Nothing beyond the canonical surface was ever asked for, at any point in the walk.
    expect(calls.every((call) => call.url.startsWith(ROOT))).toBe(true);
});

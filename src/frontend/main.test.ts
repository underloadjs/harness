// End-to-end shell + request lifecycle against stubbed server answers.
//
// This file pins the redesigned three-column frontend and the behaviours the
// change is for:
//   - R1: the harness rail lists the server catalogue and offers a create action;
//   - R2: a horizontal agent row labels primary/secondary, the trailing + opens a
//     trusted preset picker, selecting a member promotes it, and a saved session
//     freezes its team (editing is locked; R7 removed the in-row notice/link, so
//     the Sessions rail's own New session is the way to an editable team);
//   - R3 (as amended by R21.2): sessions are filtered/locked to the selected
//     harness and the right rail is the scratch board then sessions — no tool list;
//   - R4: turn and tool-call durations come from the server on reload;
//   - R5: existing streaming, snapshot hydration, endpoint drafts and polling are
//     preserved.
//
// `main.ts` is a module with side effects: it builds the shell and boots against
// the API. `fetch` is stubbed and the SSE body is a real ReadableStream, so
// api.ts parses its own frames. No server, no provider.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts
import type {
    HarnessAssistantMessage,
    HarnessDescriptor,
    SessionSnapshot,
    SessionStreamItem,
    SessionTurn
} from '../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const SESSION_KEY = 'underload-harness-app:session';
// Realistic epoch stamps: the UI formats real server milliseconds, and a tiny
// value would make the live label look like a clock-skew bug.
const T = 1_700_000_000_000;

const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };

const descriptor = (overrides: Record<string, unknown> = {}): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: 'A general instruction-following agent.',
        requiresEndpoint: true,
        agents: ['instruct'],
        tools: ['fileRead'],
        coreTools: [
            'fileRead',
            'fileWrite',
            'fileEdit',
            'fileGlob',
            'toolRequest',
            'toolCreate',
            'todoManage'
        ],
        primary: 'instruct',
        subagents: [],
        builtin: true,
        editable: true,
        ...overrides
    }) as HarnessDescriptor;

const agents = [
    {
        name: 'instruct',
        title: 'Instruct',
        description: 'Answers directly with the full toolbox.',
        instruction: 'Answer the request directly and keep the answer focused.',
        guidelines: ['Prefer a tool over memory.', 'Be concise.']
    },
    {
        name: 'summarizer',
        title: 'Summarizer',
        description: 'Compresses notes into two sentences.',
        instruction: 'Compress notes into at most two sentences.',
        guidelines: ['Keep names and numbers.']
    },
    {
        name: 'workspace',
        title: 'Workspace',
        description: 'A coding-focused agent.',
        instruction: 'Inspect before you change anything.',
        guidelines: []
    }
];

const assistant = (overrides: Partial<HarnessAssistantMessage> = {}): HarnessAssistantMessage => ({
    role: 'assistant',
    content: 'answer',
    reasoning: '',
    toolCalls: [],
    model: 'm1',
    stopReason: 'stop',
    ...overrides
});

const snapshot = (overrides: Partial<SessionSnapshot> = {}): SessionSnapshot =>
    ({
        id: 's1',
        harness: 'instruct',
        status: 'idle',
        model: 'm1',
        createdAt: 1,
        updatedAt: 2,
        messages: [],
        turns: [],
        ...overrides
    }) as SessionSnapshot;

const bootstrap = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    rootPath: '/api',
    presets: [descriptor()],
    tools: [],
    defaults,
    sessions: [],
    agents,
    ...overrides
});

// One SSE frame per `SessionStreamItem`, exactly the shape api.ts parses.
const dataOf = (items: readonly unknown[]): Uint8Array =>
    new TextEncoder().encode(items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join(''));

const sse = (items: readonly unknown[]): Response => {
    const body = dataOf(items);
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(body);
            controller.close();
        }
    });

    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};

// The same body, delivered in two halves: `start` sends the first, the test calls
// `release()` for the rest. One `sse` chunk applies every frame before the test
// regains control, which cannot pin what the tile shows BETWEEN frames (main.ts
// updates the tally per frame) — this can.
const splitSse = (
    first: readonly unknown[],
    rest: readonly unknown[]
): { response: Response; release: () => void } => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;

    const stream = new ReadableStream<Uint8Array>({
        start(next) {
            controller = next;
            next.enqueue(dataOf(first));
        }
    });

    return {
        response: new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' }
        }),
        release: (): void => {
            if (controller === undefined) throw new Error('the stream never started');
            controller.enqueue(dataOf(rest));
            controller.close();
        }
    };
};

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
};

type Call = { url: string; method: string | undefined; body: unknown };

// A tiny router for the stubbed server: log every call, answer what the test
// declares, and fail loudly on anything unexpected.
const stubFetch = (
    handler: (url: string, method: string | undefined, body: unknown) => Response | undefined
): Call[] => {
    const calls: Call[] = [];

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method;
            const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
            calls.push({ url, method, body });

            const response = handler(url, method, body);
            if (response === undefined) throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);

            return response;
        })
    );

    return calls;
};

const statusText = (): string | null | undefined => document.querySelector('.status-text')?.textContent;
const tileStates = (): (string | null | undefined)[] =>
    [...document.querySelectorAll<HTMLElement>('.tile')].map((tile) => tile.dataset.state);
const tileElapsed = (): (string | null)[] =>
    [...document.querySelectorAll<HTMLElement>('.tile-elapsed')].map((node) => node.textContent);
// R11 (T5): the team/model deck now lives inside the shared agent dialog, so every
// deck read opens it from the composer's SINGLE agent button. A no-op when the modal
// is already open (a chrome rebuild refreshes it in place).
function openAgents(): void {
    if (document.querySelector('.dialog') !== null) return;
    byClass('.agent-control-button', 'button').click();
}

const agentRoles = (): (string | undefined)[] => {
    openAgents();
    return [...document.querySelectorAll<HTMLElement>('.agent-tile')].map((tile) => tile.dataset.role);
};
const agentNames = (): (string | null)[] => {
    openAgents();
    return [...document.querySelectorAll<HTMLElement>('.agent-tile-name')].map((node) => node.textContent);
};
// R2 deck: the FRONT card per tile, in DOM order (`undefined` = hidden card).
const agentFronts = (): (string | undefined)[] => {
    openAgents();
    return [...document.querySelectorAll<HTMLElement>('.agent-tile')].map((tile) => tile.dataset.front);
};
const harnessNames = (): (string | null)[] =>
    [...document.querySelectorAll<HTMLElement>('.harness-item .harness-name')].map((node) => node.textContent);
// The core list is gone from the UI (R21.2); this helper stays only so a test can
// prove it renders nothing anywhere.
const coreToolNames = (): (string | null)[] =>
    [...document.querySelectorAll<HTMLElement>('.core-tool-name')].map((node) => node.textContent);
const sessionIds = (): (string | undefined)[] =>
    [...document.querySelectorAll<HTMLElement>('.session')].map((node) => node.dataset.sessionId);
// R8: the row WRAPPER (select button + sibling delete control) carries the
// row-level data attributes and the session id.
const rowIds = (): (string | undefined)[] =>
    [...document.querySelectorAll<HTMLElement>('.session-row')].map((node) => node.dataset.sessionId);

const byClass = <K extends keyof HTMLElementTagNameMap>(
    selector: string,
    tag: K
): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);
    return found;
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

it('boots the three-column shell, streams a turn and resolves server timings', async () => {
    let taskRequests = 0;

    const start = { type: 'start' as const, agent: 'instruct', model: 'm1' };
    const call = {
        type: 'tool_call' as const,
        agent: 'instruct',
        call: { id: 'c1', name: 'fileRead', arguments: '{"path":"package.json"}' }
    };
    const result = {
        type: 'tool_result' as const,
        agent: 'instruct',
        name: 'fileRead',
        content: '{"ok":true}',
        isError: false,
        callId: 'c1'
    };
    const done = { type: 'done' as const, agent: 'instruct', message: assistant({ content: 'a b' }) };

    const recorded: SessionTurn = {
        id: 't1',
        index: 0,
        prompt: 'say hi',
        status: 'done',
        startedAt: T,
        updatedAt: T + 3600,
        events: [
            start,
            call,
            result,
            { type: 'text', agent: 'instruct', delta: '# Hi\n\n' },
            { type: 'text', agent: 'instruct', delta: 'a **b**' },
            done
        ],
        eventTimes: [T, T + 200, T + 1000, T + 1500, T + 1700, T + 2400]
    } as SessionTurn;
    const opening: SessionTurn = { ...recorded, status: 'running', events: [] };
    const finished = snapshot({ harnessDefinition: descriptor(), turns: [recorded] });

    stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap());
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions' && method === 'POST')
            return json({ session: snapshot({ harnessDefinition: descriptor() }) });

        if (url === '/api/sessions/s1/tasks' && method === 'POST') {
            taskRequests += 1;
            return json(
                {
                    session: snapshot({
                        harnessDefinition: descriptor(),
                        status: 'running',
                        turns: [opening]
                    }),
                    turn: opening
                },
                202
            );
        }

        if (url === '/api/sessions/s1/events') {
            const at = (offset: number): number => T + offset;

            const items: SessionStreamItem[] = [
                { type: 'turn', turn: opening },
                { type: 'event', turnId: 't1', event: start, at: at(0) },
                { type: 'event', turnId: 't1', event: call, at: at(200) },
                { type: 'event', turnId: 't1', event: result, at: at(1000) },
                { type: 'event', turnId: 't1', event: { type: 'text', agent: 'instruct', delta: '# Hi\n\n' }, at: at(1500) },
                { type: 'event', turnId: 't1', event: { type: 'text', agent: 'instruct', delta: 'a **b**' }, at: at(1700) },
                { type: 'event', turnId: 't1', event: done, at: at(2400) },
                { type: 'snapshot', session: finished }
            ];

            return sse(items);
        }

        return undefined;
    });

    await import('./main');
    await flush();

    // --- shell (R1/R2/R3) ---------------------------------------------
    expect(statusText()).toBe('idle');
    expect(document.querySelectorAll('.shell > .rail-left, .shell > .center, .shell > .rail-right')).toHaveLength(3);
    expect(harnessNames()).toEqual(['instruct']);
    expect(byClass('.harness-item', 'button').getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.main-title')?.textContent).toBe('Instruct');
    // The chat head shows ONLY the display title. The harness registry id
    // (`instruct`) is internal (sessions/aliases/API), so the shared badge next to
    // the title is emptied and hidden (`renderHarnessChrome`, main.ts:3212-3213).
    expect(document.querySelector('.harness-id')?.textContent).toBe('');
    expect(byClass('.harness-id', 'span').hidden).toBe(true);

    // The agent row replaced the description wall.
    expect(agentNames()).toEqual(['Instruct']);
    expect(agentRoles()).toEqual(['primary']);
    expect(document.querySelector('.harness-note')?.textContent).toBe('Edits apply to new sessions');
    expect(document.querySelector('.agent-add')).not.toBeNull();

    // R21.1: the rail says template/custom and an agent count — never a
    // read-only/editable distinction.
    expect(document.querySelector('.harness-meta')?.textContent).toBe('template · 1 agent');

    // R21.2: the right rail has NO tool list and NO core-tools dropdown. The
    // scratch board is the first section and sessions come second.
    expect(document.querySelector('.rail-right .core-tools')).toBeNull();
    expect(document.querySelector('.rail-right .tool-list')).toBeNull();
    expect(document.querySelector('.rail-right .tool-button')).toBeNull();
    expect(document.querySelector('.rail-right .catalogue-count')).toBeNull();
    const rightSections = [...document.querySelectorAll<HTMLElement>('.rail-right > .rail-section')];
    expect(rightSections.map((section) => section.className)).toEqual([
        'rail-section scratch-section',
        'rail-section sessions'
    ]);
    // The board explains its empty state and stays hidden until a tool publishes.
    expect(document.querySelector('.scratch-section .rail-title')?.textContent).toBe('Scratch board');
    expect(document.querySelector('.scratch-note')?.textContent).toBe(
        'No tool panels yet. A tool that publishes ui/panels lands here.'
    );
    expect(byClass('.scratch-section .panel-host', 'div').hidden).toBe(true);
    // No badge wall in the header any more.
    expect(document.querySelector('.badges')).toBeNull();

    // Sessions are scoped and locked to the selected harness.
    expect(document.querySelector('.sessions-scope')?.textContent).toBe('Locked to instruct.');
    expect(document.querySelector('.session-list .field-hint')?.textContent).toBe(
        'No sessions for this harness yet. Send a task to create one.'
    );

    const input = byClass('.composer-input', 'textarea');
    const form = byClass('.composer', 'form');
    // R10: the only composer action starts hidden (idle + empty field) and is the
    // single in-field control in every other state.
    const composerAction = byClass('.composer-action', 'button');
    expect(composerAction.hidden).toBe(true);
    expect(composerAction.dataset.action).toBe('none');

    input.value = 'say hi';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    // The tile exists before the server answers; while the stream is open the
    // request lock is held, so a second submit is ignored.
    expect(document.querySelector('.tile')).not.toBeNull();
    expect(byClass('.agent-main', 'button').disabled).toBe(true);
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    await flush();
    await flush();

    expect(taskRequests).toBe(1);

    const tile = byClass('.tile', 'article');
    expect(tile.dataset.state).toBe('done');
    // R3: the header carries no `#ordinal` and no raw agent id; it is the metadata
    // cluster only (the agent label lives in the section header).
    expect(tile.querySelector('.tile-index')).toBeNull();
    expect(tile.querySelector('.tile-status-text')?.textContent).toBe('done');
    expect(tile.querySelector('.turn-prompt')?.textContent).toBe('say hi\n');
    expect(tile.querySelector('.agent-text')?.innerHTML).toBe('<h1>Hi</h1>\n<p>a <strong>b</strong></p>\n');
    expect(tile.querySelector('.agent-meta')?.textContent).toBe('m1 · stop');

    // R4: the server's startedAt/updatedAt and eventTimes decide the labels.
    expect(tile.querySelector('.tile-elapsed')?.textContent).toBe('3.6s');
    expect(tile.querySelector('.tool-name')?.textContent).toBe('fileRead');
    expect(tile.querySelector('.tool-duration')?.textContent).toBe('800ms');
    expect(tile.classList.contains('is-expanded')).toBe(true);

    // The terminal snapshot populated the directory and the remembered pointer.
    const row = byClass('.session', 'button');
    expect(row.dataset.status).toBe('idle');
    expect(row.dataset.active).toBe('true');
    expect(row.querySelector('.session-meta')?.textContent).toBe('idle · 1 turn · s1');
    expect(localStorage.getItem(SESSION_KEY)).toBe('s1');

    // The header is app-scoped: a settled run is reported by the tile, not here.
    expect(statusText()).toBe('idle');
    // Empty field, no pending work: the action is gone again (R10).
    expect(composerAction.hidden).toBe(true);
    expect(composerAction.dataset.action).toBe('none');
    // A session exists now, so the TEAM is frozen: editing needs the rail's own
    // New session. R7 removed the in-row lock notice and its link.
    expect(byClass('.agent-main', 'button').disabled).toBe(true);
    expect(document.querySelector('.agent-lock')).toBeNull();
    expect(document.querySelector('.agent-row-wrap .link-button')).toBeNull();
    expect(document.querySelector('.new-session')?.textContent).toBe('New session');
    expect(byClass('.new-session', 'button').disabled).toBe(false);
    // ...but the MODELS are live (R2): the tile dropdown still edits this session.
    const modelSelect = byClass('.agent-model-select', 'select');
    expect(modelSelect.disabled).toBe(false);
    expect(modelSelect.title).toBe(
        'Model for Instruct. Applies to the next request in this session.'
    );
});

// Header badge lifecycle. `<span class="harness-id">` is shared by two heads:
//   - the CHAT head (`renderHarnessChrome`, main.ts:3206-3213) sets the display
//     title and BLANKS + HIDES the badge — the harness registry id (`instruct`,
//     `research`, …) is an internal key for sessions/aliases/API, not reader copy;
//   - the TOOLS head shows user-facing group labels in it again
//     (`paintToolsHead` main.ts:3780-3781 → `catalogue`, `selectTool`
//     main.ts:3867-3868 → the entry's group such as `Files`), so both writers
//     explicitly un-hide the element the chat head hid.
// This walks the whole round trip: chat → catalogue → tool → catalogue → chat.
it('shows the tools badge only in the tools view and keeps it hidden in the chat head', async () => {
    const tool = {
        name: 'fileRead',
        group: 'Files',
        description: 'Read one or more files.',
        tags: ['files', 'read'],
        visibility: 'searchable',
        parameters: {
            type: 'object',
            properties: { paths: { type: 'array', items: { type: 'string' } } },
            required: ['paths']
        }
    };

    stubFetch((url) => {
        if (url === '/api') return json(bootstrap({ tools: [tool] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    const badge = byClass('.harness-id', 'span');

    // Chat head: display title only, badge empty and hidden.
    expect(document.querySelector('.main-title')?.textContent).toBe('Instruct');
    expect(badge.textContent).toBe('');
    expect(badge.hidden).toBe(true);

    // Tools view: the catalogue label is readable, so the badge is shown.
    byClass('.tools-toggle', 'button').click();
    await flush();
    expect(document.querySelector('.main-title')?.textContent).toBe('Tools');
    expect(badge.textContent).toBe('catalogue');
    expect(badge.hidden).toBe(false);

    // Selected tool: the head names the tool and its GROUP in the badge.
    byClass('.tool-tab-button', 'button').click();
    await flush();
    expect(document.querySelector('.main-title')?.textContent).toBe('fileRead');
    expect(badge.textContent).toBe('Files');
    expect(badge.hidden).toBe(false);

    // Dialog close re-describes the catalogue, badge still shown.
    byClass('.dialog-close', 'button').click();
    await flush();
    expect(document.querySelector('.main-title')?.textContent).toBe('Tools');
    expect(badge.textContent).toBe('catalogue');
    expect(badge.hidden).toBe(false);

    // Back to chat: the title returns and the badge is blanked and hidden again.
    byClass('.tools-toggle', 'button').click();
    await flush();
    expect(document.querySelector('.main-title')?.textContent).toBe('Instruct');
    expect(badge.textContent).toBe('');
    expect(badge.hidden).toBe(true);
});

// Token tally: the row shows TWO scopes. The primary is the LATEST request's
// input/context size (derived from the last `usage` event in the turn), and the
// bracket is the server's cumulative cached input across the turn. See
// src/frontend/ui/tokens.ts and the tally block in ui/turns.ts. Here request 1
// sends 48/0 and request 2 sends 96/48, while the server tally sums to 144/48:
// the row renders '48 (0)' then '96 (48)' — never '144 (48)'. `output` is never
// printed.
it('prints the latest request context with the cumulative cache per frame', async () => {
    const firstTally = { input: 48, output: 18, total: 66, cached: 0 };
    const lastTally = { input: 144, output: 40, total: 184, cached: 48 };

    const start = { type: 'start' as const, agent: 'instruct', model: 'm1' };
    const text = { type: 'text' as const, agent: 'instruct', delta: 'hi' };
    const usageFirst = {
        type: 'usage' as const,
        agent: 'instruct',
        usage: { input: 48, output: 18, total: 66, cached: 0 }
    };
    const usageLast = {
        type: 'usage' as const,
        agent: 'instruct',
        usage: { input: 96, output: 22, total: 118, cached: 48 }
    };
    const done = { type: 'done' as const, agent: 'instruct', message: assistant({ content: 'hi' }) };

    // The recorded turn is what the terminal snapshot re-hydrates from, events
    // and cumulative tally included: a reload must show the same row as live.
    const recorded: SessionTurn = {
        id: 't1',
        index: 0,
        prompt: 'say hi',
        status: 'done',
        startedAt: T,
        updatedAt: T + 3600,
        events: [start, usageFirst, text, usageLast, done],
        eventTimes: [T, T + 50, T + 100, T + 150, T + 200],
        usage: lastTally
    } as SessionTurn;
    const opening: SessionTurn = { ...recorded, status: 'running', events: [], usage: firstTally };
    const finished = snapshot({ harnessDefinition: descriptor(), turns: [recorded] });

    // Assigned when the messages stream opens; a missing request must fail the
    // test loudly instead of silently asserting a stale tile.
    let releaseStream: () => void = () => {
        throw new Error('the messages stream never opened');
    };

    stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap());
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions' && method === 'POST')
            return json({ session: snapshot({ harnessDefinition: descriptor() }) });

        if (url === '/api/sessions/s1/tasks' && method === 'POST') {
            return json(
                {
                    session: snapshot({
                        harnessDefinition: descriptor(),
                        status: 'running',
                        turns: [opening]
                    }),
                    turn: opening
                },
                202
            );
        }

        if (url === '/api/sessions/s1/events') {
            const stream = splitSse(
                [
                    { type: 'turn', turn: opening },
                    { type: 'event', turnId: 't1', event: start, at: T, usage: firstTally },
                    { type: 'event', turnId: 't1', event: usageFirst, at: T + 50, usage: firstTally }
                ],
                [
                    // A frame with NO tally between two tallied ones: it must leave
                    // the figure alone rather than clear it.
                    { type: 'event', turnId: 't1', event: text, at: T + 100 },
                    { type: 'event', turnId: 't1', event: usageLast, at: T + 150, usage: lastTally },
                    { type: 'event', turnId: 't1', event: done, at: T + 200, usage: lastTally },
                    { type: 'snapshot', session: finished }
                ]
            );
            releaseStream = stream.release;
            return stream.response;
        }

        return undefined;
    });

    await import('./main');
    await flush();

    const input = byClass('.composer-input', 'textarea');
    input.value = 'say hi';
    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    // The pre-stream requests (session, models) and the first half settle here;
    // the stream cannot advance until `releaseStream()` below.
    await flush();
    await flush();

    const liveTally = byClass('.tile', 'article').querySelector<HTMLElement>('.tile-tokens');
    expect(liveTally?.textContent).toBe('48 (0)');
    expect(liveTally?.hidden).toBe(false);

    releaseStream();
    await flush();
    await flush();

    // The terminal snapshot rebuilt the tile from the recorded turn, so the label
    // comes from `SessionTurn.usage` — the same exact figure, not a double sum.
    expect(document.querySelectorAll('.tile')).toHaveLength(1);
    const tile = byClass('.tile', 'article');
    expect(tile.dataset.state).toBe('done');
    expect(tile.querySelector<HTMLElement>('.tile-tokens')?.textContent).toBe('96 (48)');
    expect(tile.querySelector<HTMLElement>('.tile-tokens')?.hidden).toBe(false);
    // The recorded stamps (not the local clock) prove this tile is the rehydrated
    // one: the live tile ran from T to "now".
    expect(tile.querySelector('.tile-elapsed')?.textContent).toBe('3.6s');
});

it('keeps the last tally when later frames carry none', async () => {
    const tally = { input: 48, output: 18, total: 66, cached: 0 };

    const start = { type: 'start' as const, agent: 'instruct', model: 'm1' };
    const text = { type: 'text' as const, agent: 'instruct', delta: 'hi' };
    const done = { type: 'done' as const, agent: 'instruct', message: assistant({ content: 'hi' }) };

    const opening: SessionTurn = {
        id: 't1',
        index: 0,
        prompt: 'say hi',
        status: 'running',
        startedAt: T,
        updatedAt: T + 200,
        events: [],
        usage: tally
    } as SessionTurn;

    stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap());
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions' && method === 'POST')
            return json({ session: snapshot({ harnessDefinition: descriptor() }) });

        if (url === '/api/sessions/s1/tasks' && method === 'POST') {
            return json(
                {
                    session: snapshot({
                        harnessDefinition: descriptor(),
                        status: 'running',
                        turns: [opening]
                    }),
                    turn: opening
                },
                202
            );
        }

        if (url === '/api/sessions/s1/events') {
            // The record carries the tally the frames established; the untallied
            // frames between must not clear it (the tile only prints server data).
            const items: SessionStreamItem[] = [
                { type: 'turn', turn: opening },
                { type: 'event', turnId: 't1', event: start, at: T, usage: tally },
                { type: 'event', turnId: 't1', event: text, at: T + 100 },
                { type: 'event', turnId: 't1', event: done, at: T + 200 },
                {
                    type: 'snapshot',
                    session: snapshot({
                        harnessDefinition: descriptor(),
                        turns: [{ ...opening, status: 'done', events: [start, text, done] }]
                    })
                }
            ];

            return sse(items);
        }

        return undefined;
    });

    await import('./main');
    await flush();

    const input = byClass('.composer-input', 'textarea');
    input.value = 'say hi';
    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    await flush();
    await flush();

    const tile = byClass('.tile', 'article');
    expect(tile.dataset.state).toBe('done');
    // The frames after the tallied one carried no `usage`, so the figure is
    // untouched — never cleared, never re-summed.
    expect(tile.querySelector<HTMLElement>('.tile-tokens')?.textContent).toBe('48 (0)');
    expect(tile.querySelector<HTMLElement>('.tile-tokens')?.hidden).toBe(false);
});

it('restores a remembered session with its frozen team and server timings', async () => {
    const frozen = descriptor({
        agents: ['instruct', 'summarizer'],
        primary: 'instruct',
        subagents: ['summarizer'],
        // A subagent allowlist is what makes the server add agentDelegate.
        coreTools: [
            'fileRead',
            'fileWrite',
            'fileEdit',
            'fileGlob',
            'toolRequest',
            'toolCreate',
            'todoManage',
            'agentDelegate'
        ]
    });

    const first: SessionTurn = {
        id: 't1',
        index: 0,
        prompt: 'first task',
        status: 'done',
        startedAt: T,
        updatedAt: T + 3600,
        events: [
            { type: 'start', agent: 'instruct', model: 'm1' },
            {
                type: 'tool_call',
                agent: 'instruct',
                call: { id: 'c1', name: 'fileRead', arguments: '{"path":"package.json"}' }
            },
            {
                type: 'tool_result',
                agent: 'instruct',
                name: 'fileRead',
                content: '{"ok":true}',
                isError: false,
                callId: 'c1'
            },
            { type: 'text', agent: 'instruct', delta: '## Answer\n\nfinal' },
            { type: 'done', agent: 'instruct', message: assistant() }
        ],
        eventTimes: [T, T + 200, T + 1700, T + 2000, T + 3000]
    } as SessionTurn;

    // A turn recorded before the server sent timing data: no eventTimes, but the
    // turn span still renders, and no tool duration is invented.
    const legacy: SessionTurn = {
        id: 't2',
        index: 1,
        prompt: 'second task',
        status: 'error',
        startedAt: T + 4000,
        updatedAt: T + 5000,
        events: [
            { type: 'start', agent: 'instruct', model: 'm1' },
            { type: 'tool_call', agent: 'instruct', call: { id: 'c2', name: 'timeNow', arguments: '{}' } },
            { type: 'error', agent: 'instruct', error: { message: 'provider exploded' } }
        ]
    };

    const restored = snapshot({ harnessDefinition: frozen, turns: [first, legacy] });
    localStorage.setItem(SESSION_KEY, 's1');

    let messageRequests = 0;
    let writes = 0;

    stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap({ presets: [descriptor()], sessions: [restored] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1') {
            if (method !== undefined) {
                writes += 1;
                throw new Error('opening a session must be read-only');
            }
            return json({ session: restored });
        }
        if (url === '/api/sessions' && method === undefined) return json({ sessions: [restored] });
        if (url.endsWith('/messages')) messageRequests += 1;
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    expect(messageRequests).toBe(0);
    expect(writes).toBe(0);
    expect(tileStates()).toEqual(['done', 'error']);
    expect(tileElapsed()).toEqual(['3.6s', '1.0s']);
    // R4: recorded tool span from eventTimes (T+200 → T+1700).
    expect(document.querySelector('.tool-duration')?.textContent).toBe('1.5s');
    // The legacy call has no recorded duration.
    expect(document.querySelectorAll('.tool-duration')[1]?.textContent).toBe('');
    // No NaN anywhere, including legacy timing.
    expect(document.body.textContent ?? '').not.toContain('NaN');

    // The frozen definition is what is displayed, not the live descriptor.
    expect(agentNames()).toEqual(['Instruct', 'Summarizer']);
    expect(agentRoles()).toEqual(['primary', 'secondary']);
    expect(document.querySelector('.harness-note')?.textContent).toBe(
        'Viewing a saved session · agent team frozen'
    );
    // R21.2: the enabled-for-session status now lives in the global tools view (its
    // pane is detached while the chat owns the stage — tools-tab.test.ts pins the
    // text). What matters here is that no right-rail core dropdown came back.
    expect(document.querySelector('.core-tools')).toBeNull();
    for (const button of document.querySelectorAll<HTMLButtonElement>('.agent-main')) {
        expect(button.disabled).toBe(true);
    }
    expect(byClass('.agent-add', 'button').disabled).toBe(true);
    // R7: the frozen team is visible through its disabled controls only. Neither
    // the removed notice nor its New session link may come back; the rail keeps
    // its own independent New session action.
    expect(document.querySelector('.agent-lock')).toBeNull();
    expect(document.querySelector('.agent-lock-text')).toBeNull();
    expect(document.querySelector('.agent-row-wrap .link-button')).toBeNull();
    expect(byClass('.new-session', 'button').textContent).toBe('New session');
    expect(byClass('.new-session', 'button').disabled).toBe(false);
    // R2: models are not part of the frozen team, so their controls stay usable on a
    // saved session and promise the next request in THIS chat.
    const modelSelects = [...document.querySelectorAll<HTMLSelectElement>('.agent-model-select')];
    expect(modelSelects.map((select) => select.disabled)).toEqual([false, false]);
    expect(modelSelects.map((select) => select.title)).toEqual([
        'Model for Instruct. Applies to the next request in this session.',
        'Model for Summarizer. Applies to the next request in this session.'
    ]);

    // The rail's New session action starts a new conversation, which unlocks
    // editing. It is the ONLY New session affordance on the page (R7).
    expect(document.querySelectorAll('.new-session')).toHaveLength(1);
    byClass('.new-session', 'button').click();
    await flush();

    expect(document.querySelectorAll('.tile')).toHaveLength(0);
    expect(document.querySelector('.harness-note')?.textContent).toBe('Edits apply to new sessions');
    expect(agentNames()).toEqual(['Instruct']);
    expect(byClass('.agent-main', 'button').disabled).toBe(false);
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(writes).toBe(0);
});

it('creates a harness from preset agents with an initial primary', async () => {
    const calls = stubFetch((url, method, body) => {
        if (url === '/api') return json(bootstrap());
        if (url === '/api/models') return json({ models: ['m1'] });

        if (url === '/api/harnesses' && method === 'POST') {
            const request = body as { name: string; title: string; primary: string; subagents: string[] };
            return json(
                {
                    harness: descriptor({
                        name: request.name,
                        title: request.title,
                        agents: [request.primary, ...request.subagents],
                        primary: request.primary,
                        subagents: request.subagents,
                        builtin: false,
                        editable: true,
                        tools: [],
                        coreTools: [
                            'fileRead',
                            'fileWrite',
                            'fileEdit',
                            'fileGlob',
                            'toolRequest',
                            'toolCreate',
                            'todoManage',
                            ...(request.subagents.length > 0 ? ['agentDelegate'] : [])
                        ]
                    })
                },
                201
            );
        }

        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    byClass('.new-harness', 'button').click();
    const panel = byClass('.create-harness', 'section');
    expect(panel.hidden).toBe(false);
    expect(byClass('.new-harness', 'button').getAttribute('aria-expanded')).toBe('true');

    byClass('.create-name', 'input').value = 'release-captain';
    byClass('.create-title-input', 'input').value = 'Release captain';

    const primary = byClass('.create-primary', 'select');
    primary.value = 'workspace';
    primary.dispatchEvent(new Event('change', { bubbles: true }));

    // The secondary select cannot offer the primary agent.
    const secondary = byClass('.create-agent-select', 'select');
    expect([...secondary.options].map((option) => option.value)).toEqual(['instruct', 'summarizer']);
    secondary.value = 'summarizer';
    byClass('.create-agent-add', 'button').click();

    expect([...document.querySelectorAll('.create-chip-name')].map((chip) => chip.textContent)).toEqual([
        'Summarizer'
    ]);

    byClass('.create-form', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    await flush();

    const post = calls.find((call) => call.url === '/api/harnesses' && call.method === 'POST');
    expect(post?.body).toEqual({
        name: 'release-captain',
        title: 'Release captain',
        primary: 'workspace',
        subagents: ['summarizer']
    });

    // The server's descriptor wins: the new harness is listed and selected.
    expect(panel.hidden).toBe(true);
    expect(harnessNames()).toEqual(['instruct', 'release-captain']);
    const selected = byClass('.harness-item[data-harness="release-captain"]', 'button');
    expect(selected.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.main-title')?.textContent).toBe('Release captain');
    // A custom harness keeps the same rule: only the title shows, the badge stays
    // empty and hidden (the registry id `release-captain` is never rendered).
    expect(document.querySelector('.harness-id')?.textContent).toBe('');
    expect(byClass('.harness-id', 'span').hidden).toBe(true);
    expect(agentNames()).toEqual(['Workspace', 'Summarizer']);
    expect(agentRoles()).toEqual(['primary', 'secondary']);
    // R21.2: no right-rail core list follows the new harness; the global tools view
    // (detached while the chat is showing) carries that status instead.
    expect(document.querySelector('.core-tools')).toBeNull();
    expect(document.querySelector('.rail-right .tool-list')).toBeNull();
});

it('adds a picker agent, promotes it to primary and never duplicates a member', async () => {
    const base = descriptor();
    let current = base;
    const calls = stubFetch((url, method, body) => {
        if (url === '/api') return json(bootstrap({ presets: [base] }));
        if (url === '/api/models') return json({ models: ['m1'] });

        if (url === '/api/harnesses/instruct' && method === 'PATCH') {
            const request = body as { primary: string; subagents: string[] };
            current = descriptor({
                agents: [request.primary, ...request.subagents],
                primary: request.primary,
                subagents: request.subagents,
                // A server with a subagent allowlist adds agentDelegate.
                coreTools: [
                    'fileRead',
                    'fileWrite',
                    'fileEdit',
                    'fileGlob',
                    'toolRequest',
                    'toolCreate',
                    'todoManage',
                    ...(request.subagents.length > 0 ? ['agentDelegate'] : [])
                ]
            });
            return json({ harness: current });
        }

        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    // The picker is the trusted preset list, with read-only instructions. The deck
    // (and its picker) lives in the shared agent dialog now (T5 R11).
    openAgents();
    byClass('.agent-add', 'button').click();
    const picker = byClass('.agent-picker', 'div');
    expect(picker.hidden).toBe(false);
    expect(byClass('.agent-add', 'button').getAttribute('aria-expanded')).toBe('true');

    const options = [...document.querySelectorAll<HTMLElement>('.agent-option')];
    expect(options.map((option) => option.dataset.agent)).toEqual(['instruct', 'summarizer', 'workspace']);
    expect(options[0].dataset.state).toBe('member');
    expect(options[0].querySelector<HTMLButtonElement>('.agent-option-add')?.disabled).toBe(true);
    expect(options[1].querySelector('.agent-instruction')?.textContent).toBe(
        'Compress notes into at most two sentences.'
    );
    expect(options[1].querySelector('.agent-guideline')?.textContent).toBe('Keep names and numbers.');

    options[1].querySelector<HTMLButtonElement>('.agent-option-add')?.click();
    await flush();

    // Complete team in one PATCH: primary + every remaining member as subagent.
    expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({
        primary: 'instruct',
        subagents: ['summarizer']
    });
    expect(picker.hidden).toBe(true);
    expect(agentNames()).toEqual(['Instruct', 'Summarizer']);
    expect(agentRoles()).toEqual(['primary', 'secondary']);
    // R21.2: the core set is no longer rendered anywhere; the global tools view lists
    // every tool (core entries included) from the server catalogue instead.
    expect(document.querySelector('.core-tool-name')).toBeNull();

    // Selecting a secondary demotes the old primary; the request lists it once.
    document.querySelectorAll<HTMLButtonElement>('.agent-main')[1].click();
    await flush();

    expect(calls.filter((call) => call.method === 'PATCH')[1]?.body).toEqual({
        primary: 'summarizer',
        subagents: ['instruct']
    });
    expect(agentNames()).toEqual(['Summarizer', 'Instruct']);
    expect(agentRoles()).toEqual(['primary', 'secondary']);

    // Removing a secondary keeps exactly one primary and the complete list.
    document.querySelectorAll<HTMLButtonElement>('.agent-remove')[1].click();
    await flush();

    expect(calls.filter((call) => call.method === 'PATCH')[2]?.body).toEqual({
        primary: 'summarizer',
        subagents: []
    });
    expect(agentNames()).toEqual(['Summarizer']);
    expect(byClass('.agent-remove', 'button').disabled).toBe(true);
});

it('fronts an agent card for viewing without promoting it or PATCHing the team', async () => {
    const base = descriptor({
        agents: ['instruct', 'summarizer'],
        primary: 'instruct',
        subagents: ['summarizer']
    });
    let current = base;
    const calls = stubFetch((url, method, body) => {
        if (url === '/api') return json(bootstrap({ presets: [base] }));
        if (url === '/api/models') return json({ models: ['m1', 'm2'] });

        if (url === '/api/harnesses/instruct' && method === 'PATCH') {
            const request = body as {
                primary: string;
                subagents: string[];
                agentModels?: Record<string, string>;
            };
            current = descriptor({
                agents: [request.primary, ...request.subagents],
                primary: request.primary,
                subagents: request.subagents,
                agentModels: request.agentModels
            });
            return json({ harness: current });
        }

        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    // R2 deck: the primary is the front card; the secondary is a named strip.
    expect(agentFronts()).toEqual(['true', undefined]);
    expect(
        [...document.querySelectorAll<HTMLButtonElement>('.agent-handle')].map((handle) => [
            handle.dataset.agent,
            handle.hidden
        ])
    ).toEqual([
        ['instruct', true],
        ['summarizer', false]
    ]);

    // Viewing the secondary sends NOTHING: fronting is local UI state, not a team
    // edit. The primary and its aria-pressed state are untouched.
    document.querySelector<HTMLButtonElement>('.agent-handle[data-agent="summarizer"]')?.click();
    await flush();

    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([]);
    expect(agentFronts()).toEqual([undefined, 'true']);
    expect(agentRoles()).toEqual(['primary', 'secondary']);
    expect(document.querySelectorAll<HTMLButtonElement>('.agent-main')[0].getAttribute('aria-pressed')).toBe(
        'true'
    );

    // The fronted card owns the usable controls: its model select is a tab stop,
    // the covered primary's is not. Editing that secondary's model is what the
    // front state is for, and the team PATCH keeps the primary unchanged.
    const selects = [...document.querySelectorAll<HTMLSelectElement>('.agent-model-select')];
    expect(selects.map((select) => select.getAttribute('tabindex'))).toEqual(['-1', null]);
    selects[1].value = 'm2';
    selects[1].dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    expect(calls.filter((call) => call.method === 'PATCH')[0]?.body).toEqual({
        primary: 'instruct',
        subagents: ['summarizer'],
        agentModels: { summarizer: 'm2' }
    });
    // The rebuild the PATCH triggers re-seeds the remembered front card, so the
    // card being viewed is not yanked away mid-edit (R2).
    expect(agentFronts()).toEqual([undefined, 'true']);
    expect(agentRoles()).toEqual(['primary', 'secondary']);
    expect(
        [...document.querySelectorAll<HTMLSelectElement>('.agent-model-select')].map((select) => select.value)
    ).toEqual(['', 'm2']);
});

it('falls back to the primary when the viewed card is removed', async () => {
    const base = descriptor({
        agents: ['instruct', 'summarizer'],
        primary: 'instruct',
        subagents: ['summarizer']
    });
    let current = base;
    const calls = stubFetch((url, method, body) => {
        if (url === '/api') return json(bootstrap({ presets: [base] }));
        if (url === '/api/models') return json({ models: ['m1'] });

        if (url === '/api/harnesses/instruct' && method === 'PATCH') {
            const request = body as { primary: string; subagents: string[] };
            current = descriptor({
                agents: [request.primary, ...request.subagents],
                primary: request.primary,
                subagents: request.subagents
            });
            return json({ harness: current });
        }

        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    // View the secondary, then remove it from its own (now front) card.
    openAgents();
    document.querySelector<HTMLButtonElement>('.agent-handle[data-agent="summarizer"]')?.click();
    await flush();
    expect(agentFronts()).toEqual([undefined, 'true']);

    document.querySelectorAll<HTMLButtonElement>('.agent-remove')[1].click();
    await flush();

    expect(calls.filter((call) => call.method === 'PATCH')[0]?.body).toEqual({
        primary: 'instruct',
        subagents: []
    });
    // The remembered front name is pruned against the new team, so the surviving
    // primary becomes front instead of an empty/ghost deck (R2 fallback).
    expect(agentNames()).toEqual(['Instruct']);
    expect(agentFronts()).toEqual(['true']);
    expect(
        [...document.querySelectorAll<HTMLButtonElement>('.agent-handle')].map((handle) => handle.hidden)
    ).toEqual([true]);
    expect(byClass('.agent-remove', 'button').disabled).toBe(true);
    expect(byClass('.agent-main', 'button').disabled).toBe(false);
});

it('fronts a card of a frozen team and keeps that card across the live model PATCH', async () => {
    const frozen = descriptor({
        agents: ['instruct', 'summarizer'],
        primary: 'instruct',
        subagents: ['summarizer'],
        coreTools: [
            'fileRead',
            'fileWrite',
            'fileEdit',
            'fileGlob',
            'toolRequest',
            'toolCreate',
            'todoManage',
            'agentDelegate'
        ]
    });
    const restored = snapshot({ harnessDefinition: frozen } as Partial<SessionSnapshot>);
    localStorage.setItem(SESSION_KEY, 's1');

    const patches: unknown[] = [];
    stubFetch((url, method, body) => {
        if (url === '/api') return json(bootstrap({ presets: [descriptor()], sessions: [restored] }));
        if (url === '/api/models') return json({ models: ['m1', 'm2'] });
        if (url === '/api/sessions/s1' && method === undefined) return json({ session: restored });
        if (url === '/api/sessions' && method === undefined) return json({ sessions: [restored] });

        if (url === '/api/sessions/s1' && method === 'PATCH') {
            patches.push(body);
            return json({
                session: snapshot({
                    harnessDefinition: frozen,
                    agentModels: { summarizer: 'm2' },
                    updatedAt: 3
                } as Partial<SessionSnapshot>)
            });
        }

        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    // R2/R3: the team is frozen, but VIEWING is not a team edit, so the strip works.
    openAgents();
    document.querySelector<HTMLButtonElement>('.agent-handle[data-agent="summarizer"]')?.click();
    await flush();

    expect(agentFronts()).toEqual([undefined, 'true']);
    expect(agentRoles()).toEqual(['primary', 'secondary']);
    // No team change was attempted; promotion stays disabled while frozen.
    expect(patches).toEqual([]);
    expect(document.querySelectorAll<HTMLButtonElement>('.agent-main').length).toBe(2);
    for (const button of document.querySelectorAll<HTMLButtonElement>('.agent-main')) {
        expect(button.disabled).toBe(true);
    }

    // The fronted (still secondary) agent's model is live: the session PATCH is what
    // a saved chat edits, and it does not touch primary/subagents at all.
    const selects = [...document.querySelectorAll<HTMLSelectElement>('.agent-model-select')];
    expect(selects.map((select) => select.disabled)).toEqual([false, false]);
    expect(selects.map((select) => select.value)).toEqual(['', '']);
    selects[1].value = 'm2';
    selects[1].dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    expect(patches).toEqual([{ agentModels: { summarizer: 'm2' } }]);
    // The PATCH rebuild keeps the viewed card in front and shows the new model.
    expect(agentFronts()).toEqual([undefined, 'true']);
    expect(agentRoles()).toEqual(['primary', 'secondary']);
    expect(
        [...document.querySelectorAll<HTMLSelectElement>('.agent-model-select')].map((select) => select.value)
    ).toEqual(['', 'm2']);
});

it('filters the sessions rail to the selected harness and opens within it', async () => {
    const instruct = descriptor();
    const workspace = descriptor({
        name: 'workspace',
        title: 'Workspace',
        agents: ['workspace'],
        primary: 'workspace',
        requiresEndpoint: false
    });

    const instructSession = snapshot({ id: 's1', harness: 'instruct' });
    const workspaceSession = snapshot({ id: 's2', harness: 'workspace' });
    const foreign = snapshot({ id: 's3', harness: 'retired' });

    stubFetch((url) => {
        if (url === '/api') {
            return json(
                bootstrap({
                    presets: [instruct, workspace],
                    sessions: [instructSession, workspaceSession, foreign]
                })
            );
        }
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s2') return json({ session: workspaceSession });
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    expect(harnessNames()).toEqual(['instruct', 'workspace']);
    expect(sessionIds()).toEqual(['s1']);
    expect(document.querySelector('.sessions-scope')?.textContent).toBe('Locked to instruct.');

    byClass('.harness-item[data-harness="workspace"]', 'button').click();
    await flush();

    expect(sessionIds()).toEqual(['s2']);
    expect(document.querySelector('.sessions-scope')?.textContent).toBe('Locked to workspace.');
    expect(agentNames()).toEqual(['Workspace']);

    byClass('.session[data-session-id="s2"]', 'button').click();
    await flush();
    await flush();

    // Opening a session keeps its harness selected — never switches it.
    expect(byClass('.harness-item[data-harness="workspace"]', 'button').getAttribute('aria-pressed')).toBe(
        'true'
    );
    expect(document.querySelector('.main-title')?.textContent).toBe('Workspace');
    // Switching harness (or opening one of its sessions) repaints the chat head,
    // which always leaves the badge empty and hidden.
    expect(document.querySelector('.harness-id')?.textContent).toBe('');
    expect(byClass('.harness-id', 'span').hidden).toBe(true);
    expect(sessionIds()).toEqual(['s2']);
});

it('keeps the existing session when endpoint settings change', async () => {
    const recorded: SessionTurn = {
        id: 't1',
        index: 0,
        prompt: 'keep me',
        status: 'done',
        startedAt: T,
        updatedAt: T + 1000,
        events: [
            { type: 'start', agent: 'instruct', model: 'm1' },
            { type: 'text', agent: 'instruct', delta: 'kept' }
        ]
    };

    const existing = snapshot({ turns: [recorded] });
    localStorage.setItem(SESSION_KEY, 's1');

    let created = 0;
    let deleted = 0;

    stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap({ sessions: [existing] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1') return json({ session: existing });

        if (url === '/api/sessions') {
            if (method === 'POST') created += 1;
            return json({ session: snapshot() });
        }

        if (method === 'DELETE') {
            deleted += 1;
            return json({ deleted: true });
        }

        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    expect(document.querySelectorAll('.tile')).toHaveLength(1);

    // Change the base URL through the real input path (this is a *draft*: it is
    // only used the next time a session is created).
    const baseURL = byClass('.endpoint input.field-input', 'input');
    baseURL.value = 'http://other-provider/v1';
    baseURL.dispatchEvent(new Event('input', { bubbles: true }));

    // Long enough for the debounced model refresh to fire, so a bug that tripped
    // session recreation on any settings change would have happened by now.
    await new Promise((resolve) => setTimeout(resolve, 650));
    await flush();

    expect(created).toBe(0);
    expect(deleted).toBe(0);
    expect(document.querySelectorAll('.tile')).toHaveLength(1);
    expect(document.querySelector('.agent-text')?.textContent).toBe('kept\n');
    expect(localStorage.getItem(SESSION_KEY)).toBe('s1');
    expect(byClass('.session', 'button').dataset.active).toBe('true');
});

it('replaces the projected stream with the authoritative terminal snapshot', async () => {
    const start = { type: 'start' as const, agent: 'instruct', model: 'm1' };
    const recorded: SessionTurn = {
        id: 't1',
        index: 0,
        prompt: 'go',
        status: 'done',
        startedAt: T,
        updatedAt: T + 500,
        events: [start, { type: 'text', agent: 'instruct', delta: 'server wins' }]
    };

    const finished = snapshot({ turns: [recorded] });
    const opening: SessionTurn = { ...recorded, status: 'running', events: [] };

    stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap());
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions' && method === 'POST') return json({ session: snapshot() });

        if (url === '/api/sessions/s1/tasks' && method === 'POST') {
            return json(
                {
                    session: snapshot({ turns: [opening], status: 'running' }),
                    turn: opening
                },
                202
            );
        }

        if (url === '/api/sessions/s1/events') {
            return sse([
                { type: 'turn', turn: opening },
                { type: 'event', turnId: 't1', event: start },
                // A transient projection the server did not record.
                { type: 'event', turnId: 't1', event: { type: 'text', agent: 'instruct', delta: 'draft ' } },
                { type: 'event', turnId: 't1', event: { type: 'text', agent: 'instruct', delta: 'that differs' } },
                { type: 'snapshot', session: finished }
            ]);
        }

        return undefined;
    });

    await import('./main');
    await flush();

    const input = byClass('.composer-input', 'textarea');
    input.value = 'go';
    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    await flush();
    await flush();

    expect(document.querySelectorAll('.tile')).toHaveLength(1);
    expect(document.querySelector('.agent-text')?.innerHTML).toBe('<p>server wins</p>\n');
    expect(document.querySelector('.agent-text')?.textContent).not.toContain('draft');
});

it('stops every task in the originating session while a run is in flight', async () => {
    let cancelRequests = 0;
    let cancelBody: unknown;
    let observerStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
        observerStarted = resolve;
    });

    const other = descriptor({ name: 'workspace', title: 'Workspace', agents: ['workspace'], primary: 'workspace' });
    const runningTurn: SessionTurn = {
        id: 't1',
        index: 0,
        prompt: 'long one',
        status: 'running',
        startedAt: T,
        updatedAt: T,
        events: [{ type: 'start', agent: 'instruct', model: 'm1' }]
    };
    const cancelledTurn: SessionTurn = { ...runningTurn, status: 'cancelled', updatedAt: T + 100 };
    const transcript = snapshot({
        harnessDefinition: descriptor(),
        status: 'running',
        turns: [runningTurn]
    });
    const cancelled = snapshot({ harnessDefinition: descriptor(), turns: [cancelledTurn] });

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);

            if (url === '/api') return json(bootstrap({ presets: [descriptor(), other] }));
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions' && init?.method === 'POST') return json({ session: transcript });
            if (url === '/api/sessions/s1/tasks' && init?.method === 'POST') {
                return json({ session: transcript, turn: runningTurn }, 202);
            }

            if (url === '/api/sessions/s1/events') {
                observerStarted?.();
                // A long-lived observer that stays open until it is unsubscribed.
                return new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () =>
                        reject(new DOMException('The operation was aborted.', 'AbortError'))
                    );
                });
            }

            if (url === '/api/sessions/s1/cancel' && init?.method === 'POST') {
                cancelRequests += 1;
                cancelBody = init.body === undefined ? undefined : JSON.parse(String(init.body));
                return json({ cancelled: true });
            }

            if (url === '/api/sessions/s1' && init?.method === undefined) {
                return json({ session: cancelled });
            }

            if (url === '/api/sessions' && init?.method === undefined) return json({ sessions: [transcript] });

            throw new Error(`unexpected request: ${url}`);
        })
    );

    await import('./main');
    await flush();

    const input = byClass('.composer-input', 'textarea');
    input.value = 'long one';
    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await started;
    await flush();

    // The queue is server-owned, so switching harness stays possible while it runs;
    // the team row is locked (frozen session) and New session refuses pending work.
    expect(byClass('.harness-item[data-harness="workspace"]', 'button').disabled).toBe(false);
    expect(byClass('.new-session', 'button').disabled).toBe(true);
    openAgents();
    expect(byClass('.agent-add', 'button').disabled).toBe(true);
    // R2: the TEAM is locked mid-run, the MODEL is not — it edits the session's live
    // map for the next request and never cancels this stream.
    const streamingSelect = byClass('.agent-model-select', 'select');
    expect(streamingSelect.disabled).toBe(false);
    expect(streamingSelect.title).toBe(
        'Model for Instruct. Applies to the next request in this session.'
    );

    // R10: the running session, with an empty field, exposes the stop action in the
    // composer's one button slot.
    const composerAction = byClass('.composer-action', 'button');
    expect(composerAction.dataset.action).toBe('stop');
    expect(composerAction.hidden).toBe(false);
    composerAction.click();
    await flush();
    await flush();
    await flush();

    // Stop is total: the body says `{ all: true }` so retained queue records are
    // cancelled too, and the tile shows the server's cancellation.
    expect(cancelRequests).toBe(1);
    expect(cancelBody).toEqual({ all: true });
    expect(tileStates()).toEqual(['cancelled']);
    // A deliberate stop is a session outcome: the tile says `cancelled`, and the
    // global header stays app-scoped instead of announcing the run's end.
    expect(statusText()).toBe('idle');
    expect(document.querySelector('.session-note')?.hasAttribute('hidden')).toBe(true);
    expect(byClass('.harness-item[data-harness="workspace"]', 'button').disabled).toBe(false);
    // The queue drained: no text, no pending work, no action (R10).
    expect(composerAction.hidden).toBe(true);
    expect(composerAction.dataset.action).toBe('none');
});

it('stops polling a running session when another harness is selected', async () => {
    vi.useFakeTimers();

    const runningTurn: SessionTurn = {
        id: 'r1',
        index: 0,
        prompt: 'long task',
        status: 'running',
        startedAt: T,
        updatedAt: T + 500,
        events: [{ type: 'start', agent: 'instruct', model: 'm1' }]
    };
    const running = snapshot({ id: 'r1', status: 'running', turns: [runningTurn] });
    const other = descriptor({ name: 'workspace', title: 'Workspace', agents: ['workspace'], primary: 'workspace' });
    localStorage.setItem(SESSION_KEY, 'r1');

    let gets = 0;
    stubFetch((url) => {
        if (url === '/api') return json(bootstrap({ presets: [descriptor(), other], sessions: [running] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/r1') {
            gets += 1;
            return json({ session: running });
        }
        return undefined;
    });

    await import('./main');
    await vi.advanceTimersByTimeAsync(50);
    expect(gets).toBe(1);

    // The reader moves on before the first poll fires.
    byClass('.harness-item[data-harness="workspace"]', 'button').click();
    await vi.advanceTimersByTimeAsync(3000);

    expect(gets).toBe(1);
    expect(sessionIds()).toEqual([]);
    expect(statusText()).toBe('idle');
});

it('clears polling and elapsed timers on pagehide', async () => {
    vi.useFakeTimers();

    const runningTurn: SessionTurn = {
        id: 'r1',
        index: 0,
        prompt: 'long task',
        status: 'running',
        startedAt: Date.now() - 500,
        updatedAt: Date.now(),
        events: [{ type: 'start', agent: 'instruct', model: 'm1' }]
    };
    const running = snapshot({ id: 'r1', status: 'running', turns: [runningTurn] });
    localStorage.setItem(SESSION_KEY, 'r1');

    let gets = 0;
    stubFetch((url) => {
        if (url === '/api') return json(bootstrap({ sessions: [running] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/r1') {
            gets += 1;
            return json({ session: running });
        }
        return undefined;
    });

    await import('./main');
    await vi.advanceTimersByTimeAsync(50);
    expect(gets).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(gets).toBe(2);
    const before = tileElapsed()[0];

    window.dispatchEvent(new Event('pagehide'));
    // Both the poll and the live tick are gone: neither may fire again.
    await vi.advanceTimersByTimeAsync(5000);

    expect(gets).toBe(2);
    expect(tileElapsed()[0]).toBe(before);
});

// ---------------------------------------------------------------------------
// R4 queue: submit behind the active task, advance in FIFO order
// ---------------------------------------------------------------------------
it('queues a second task behind the active one and advances it automatically', async () => {
    const streamBody = (): {
        response: Response;
        push: (items: readonly unknown[]) => void;
        close: () => void;
    } => {
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        const body = new ReadableStream<Uint8Array>({
            start(next) {
                controller = next;
            }
        });

        return {
            response: new Response(body, {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream' }
            }),
            push: (items) => {
                const text = items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join('');
                controller?.enqueue(new TextEncoder().encode(text));
            },
            close: () => controller?.close()
        };
    };

    const stream = streamBody();
    const start = { type: 'start' as const, agent: 'instruct', model: 'm1' };

    const runningA = {
        id: 'ta',
        index: 0,
        prompt: 'first task',
        status: 'running',
        startedAt: T,
        updatedAt: T + 10,
        events: [start, { type: 'text' as const, agent: 'instruct', delta: 'first answer' }]
    } as SessionTurn;
    const doneA = {
        ...runningA,
        status: 'done' as const,
        updatedAt: T + 100,
        events: [...runningA.events, { type: 'done' as const, agent: 'instruct', message: assistant() }]
    } as SessionTurn;
    const queuedB = {
        id: 'tb',
        index: 1,
        prompt: 'second task',
        status: 'queued',
        updatedAt: T + 20,
        events: []
    } as unknown as SessionTurn;
    const runningB = {
        ...queuedB,
        status: 'running' as const,
        startedAt: T + 200,
        updatedAt: T + 210,
        events: [start]
    } as SessionTurn;
    const doneB = {
        ...runningB,
        status: 'done' as const,
        updatedAt: T + 400,
        events: [
            ...runningB.events,
            { type: 'text' as const, agent: 'instruct', delta: 'second answer' },
            { type: 'done' as const, agent: 'instruct', message: assistant() }
        ]
    } as SessionTurn;

    const first = snapshot({ harnessDefinition: descriptor(), status: 'running', turns: [runningA] });
    const both = snapshot({
        harnessDefinition: descriptor(),
        status: 'running',
        turns: [runningA, queuedB]
    } as SessionSnapshot);

    let tasks = 0;

    stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap());
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions' && method === 'POST')
            return json({ session: snapshot({ harnessDefinition: descriptor() }) });

        if (url === '/api/sessions/s1/tasks' && method === 'POST') {
            tasks += 1;
            return tasks === 1
                ? json({ session: first, turn: runningA }, 202)
                : json({ session: both, turn: queuedB }, 202);
        }

        if (url === '/api/sessions/s1/events') return stream.response;

        return undefined;
    });

    await import('./main');
    await flush();

    const form = byClass('.composer', 'form');
    const input = byClass('.composer-input', 'textarea');

    // Task A starts processing.
    input.value = 'first task';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    await flush();
    stream.push([{ type: 'turn', turn: runningA }]);
    await flush();

    expect(tasks).toBe(1);
    expect(tileStates()).toEqual(['streaming']);
    // R4/R10: with A running and the field empty the one action is STOP; typing
    // turns that same control into an ENABLED submit, which is still queueing.
    const composerAction = byClass('.composer-action', 'button');
    expect(composerAction.dataset.action).toBe('stop');
    input.value = 'queued while running';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(composerAction.dataset.action).toBe('submit');
    expect(composerAction.disabled).toBe(false);

    // Task B is submitted BEHIND A and is visibly queued, neutral.
    input.value = 'second task';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    await flush();

    expect(tasks).toBe(2);
    expect(tileStates()).toEqual(['streaming', 'queued']);
    expect(document.querySelectorAll('.turn-row')[1]?.getAttribute('data-state')).toBe('queued');
    // Queued B has no clock, and the stop action covers the whole queue. Reset is
    // gone (R10): no third composer control exists while work is pending.
    expect(tileElapsed()[1]).toBe('');
    expect(composerAction.dataset.action).toBe('stop');
    expect(composerAction.disabled).toBe(false);
    expect(document.querySelector('.composer .reset')).toBeNull();
    // R2: models stay editable while a queue runs.
    openAgents();
    expect(byClass('.agent-model-select', 'select').disabled).toBe(false);

    // A completes; the server advances B without another submit.
    stream.push([{ type: 'turn', turn: doneA }]);
    stream.push([{ type: 'snapshot', session: snapshot({ harnessDefinition: descriptor(), status: 'running', turns: [doneA, runningB] }) }]);
    await flush();
    await flush();

    expect(tileStates()).toEqual(['done', 'streaming']);

    // B streams its text, then the drain snapshot settles both.
    stream.push([{ type: 'event', turnId: 'tb', event: { type: 'text', agent: 'instruct', delta: 'second answer' } }]);
    stream.push([{ type: 'snapshot', session: snapshot({ harnessDefinition: descriptor(), turns: [doneA, doneB] }) }]);
    stream.close();
    await flush();
    await flush();

    expect(tileStates()).toEqual(['done', 'done']);
    expect(document.querySelectorAll('.tile')[1].querySelector('.agent-text')?.textContent).toBe(
        'second answer\n'
    );
    // No duplicated events: A's single text block appears exactly once.
    expect(document.querySelectorAll('.tile')[0].querySelectorAll('.agent-text')).toHaveLength(1);
    expect(document.querySelector('.tile-elapsed')?.textContent).toBe('100ms');
    // Queue drained + empty field: no action at all (R10).
    expect(composerAction.hidden).toBe(true);
    expect(composerAction.dataset.action).toBe('none');
});

// R2 regression: a delayed 202 answer must not revert a model edit.
//
// The 202 body is captured at ENQUEUE time. A model PATCH made while that answer
// is still in flight changes `sessionModels`/`sessionModel` immediately, so a stale
// body applied afterwards must not rewrite the definition, the model map, the
// discovery list or the rail cache (it may only reconcile turn records).
it('keeps a live model edit when the delayed 202 answer lands afterwards', async () => {
    let sendAnswer!: (value: unknown) => void;
    const answer = new Response(
        new ReadableStream<Uint8Array>({
            start(controller) {
                sendAnswer = (value) => {
                    controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
                    controller.close();
                };
            }
        }),
        { status: 202, headers: { 'Content-Type': 'application/json' } }
    );

    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
        start(next) {
            controller = next;
        }
    });
    const push = (items: readonly unknown[]): void => {
        controller?.enqueue(
            new TextEncoder().encode(items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join(''))
        );
    };

    const start = { type: 'start' as const, agent: 'instruct', model: 'm1' };

    const runningA = {
        id: 'ta',
        index: 0,
        prompt: 'first task',
        status: 'running',
        startedAt: T,
        updatedAt: T + 10,
        events: [start]
    } as SessionTurn;
    const queuedB = {
        id: 'tb',
        index: 1,
        prompt: 'second task',
        status: 'queued',
        updatedAt: T + 20,
        events: []
    } as unknown as SessionTurn;

    // What the still-in-flight 202 body says (captured before the PATCH).
    const staleBoth = snapshot({
        harnessDefinition: descriptor(),
        status: 'running',
        model: 'm1',
        agentModels: { instruct: 'm1' },
        updatedAt: T + 20,
        turns: [runningA, queuedB]
    } as SessionSnapshot);
    // The PATCH answer: the session now runs m2, stamped NEWER.
    const patched = snapshot({
        harnessDefinition: descriptor(),
        status: 'running',
        model: 'm2',
        agentModels: { instruct: 'm2' },
        updatedAt: T + 300,
        turns: [runningA, queuedB]
    } as SessionSnapshot);

    let tasks = 0;
    const patches: unknown[] = [];

    stubFetch((url, method, body) => {
        if (url === '/api') return json(bootstrap());
        if (url === '/api/models') return json({ models: ['m1', 'm2'] });
        if (url === '/api/sessions' && method === 'POST')
            return json({ session: snapshot({ harnessDefinition: descriptor() }) });

        if (url === '/api/sessions/s1/tasks' && method === 'POST') {
            tasks += 1;
            return tasks === 1
                ? json(
                      {
                          session: snapshot({
                              harnessDefinition: descriptor(),
                              status: 'running',
                              model: 'm1',
                              agentModels: { instruct: 'm1' },
                              updatedAt: T + 10,
                              turns: [runningA]
                          } as SessionSnapshot),
                          turn: runningA
                      },
                      202
                  )
                : answer;
        }

        if (url === '/api/sessions/s1' && method === 'PATCH') {
            patches.push(body);
            return json({ session: patched });
        }

        if (url === '/api/sessions/s1/events')
            return new Response(stream, {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream' }
            });

        return undefined;
    });

    await import('./main');
    await flush();

    const form = byClass('.composer', 'form');
    const input = byClass('.composer-input', 'textarea');

    // A runs, then B is submitted with its 202 answer held open.
    input.value = 'first task';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    await flush();
    push([{ type: 'turn', turn: runningA }]);
    await flush();

    input.value = 'second task';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    expect(tasks).toBe(2);

    // B's queued upsert claims the optimistic row.
    push([{ type: 'turn', turn: queuedB }]);
    await flush();
    expect(tileStates()).toEqual(['streaming', 'queued']);

    // While the answer is in flight the reader changes the session's model. The
    // effective model is what the dropdown DISPLAYS: an override equal to the
    // session fallback is represented by option 0 (ui/agents.ts dedupe rule).
    openAgents();
    const shownModel = (): string | null =>
        byClass('.agent-model-select', 'select').selectedOptions[0]?.textContent ?? null;

    const select = byClass('.agent-model-select', 'select');
    expect(select.disabled).toBe(false);
    select.value = 'm2';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    expect(patches).toEqual([{ agentModels: { instruct: 'm2' } }]);
    expect(shownModel()).toBe('m2');

    // The stale 202 body lands now: it predates the PATCH.
    sendAnswer({ session: staleBoth, turn: queuedB });
    await flush();
    await flush();

    // The model edit survives: the definition and model map came from the PATCH,
    // and the stale body may only reconcile the turns.
    expect(shownModel()).toBe('m2');
    expect(tileStates()).toEqual(['streaming', 'queued']);
    expect(document.querySelectorAll('.tile')).toHaveLength(2);
});

// R2 regression: the enqueue/observer race.
//
// src/server/sessions.ts publishes the queued `turn` upsert BEFORE the 202 body, and
// the 202 body itself is captured at ENQUEUE time. So a task submitted while
// another runs can produce, in this order on the client:
//   1. observer `turn` frames for the new turn (queued, then running),
//   2. the older 202 snapshot (A still running, B still queued).
// Before this was reconciled, (1) adopted a SECOND tile for the new prompt, and
// (2) then regressed the tiles to the stale statuses — leaving duplicated,
// out-of-order green rows above the completed ones. One row per task, one
// processing row, chronological order.
it('keeps one row per task when the observer beats the POST answer', async () => {
    // A POST answer whose body is only closed when the test says so: this is what
    // makes the observer frames arrive BEFORE the ack, deterministically.
    let sendAnswer!: (value: unknown) => void;
    const answer = new Response(
        new ReadableStream<Uint8Array>({
            start(controller) {
                sendAnswer = (value) => {
                    controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
                    controller.close();
                };
            }
        }),
        { status: 202, headers: { 'Content-Type': 'application/json' } }
    );

    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
        start(next) {
            controller = next;
        }
    });
    const push = (items: readonly unknown[]): void => {
        controller?.enqueue(
            new TextEncoder().encode(items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join(''))
        );
    };

    const start = { type: 'start' as const, agent: 'instruct', model: 'm1' };

    const runningA = {
        id: 'ta',
        index: 0,
        prompt: 'first task',
        status: 'running',
        startedAt: T,
        updatedAt: T + 10,
        events: [start]
    } as SessionTurn;
    const queuedB = {
        id: 'tb',
        index: 1,
        prompt: 'second task',
        status: 'queued',
        updatedAt: T + 20,
        events: []
    } as unknown as SessionTurn;
    const runningB = {
        ...queuedB,
        status: 'running' as const,
        startedAt: T + 200,
        updatedAt: T + 210,
        events: [start]
    } as SessionTurn;
    const doneA = {
        ...runningA,
        status: 'done' as const,
        startedAt: T,
        updatedAt: T + 100,
        events: [...runningA.events, { type: 'done' as const, agent: 'instruct', message: assistant() }]
    } as SessionTurn;

    // The 202 body: captured when B was enqueued, i.e. A running + B queued.
    const staleBoth = snapshot({
        harnessDefinition: descriptor(),
        status: 'running',
        updatedAt: T + 20,
        turns: [runningA, queuedB]
    } as SessionSnapshot);
    // What the observer already knows when that body finally resolves.
    const fresh = snapshot({
        harnessDefinition: descriptor(),
        status: 'running',
        updatedAt: T + 500,
        turns: [doneA, runningB]
    } as SessionSnapshot);

    let tasks = 0;

    stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap());
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions' && method === 'POST')
            return json({ session: snapshot({ harnessDefinition: descriptor() }) });

        if (url === '/api/sessions/s1/tasks' && method === 'POST') {
            tasks += 1;
            return tasks === 1
                ? json(
                      {
                          session: snapshot({
                              harnessDefinition: descriptor(),
                              status: 'running',
                              updatedAt: T + 10,
                              turns: [runningA]
                          } as SessionSnapshot),
                          turn: runningA
                      },
                      202
                  )
                : answer;
        }

        if (url === '/api/sessions/s1/events')
            return new Response(stream, {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream' }
            });

        return undefined;
    });

    await import('./main');
    await flush();

    const form = byClass('.composer', 'form');
    const input = byClass('.composer-input', 'textarea');

    // A starts processing.
    input.value = 'first task';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    await flush();
    push([{ type: 'turn', turn: runningA }]);
    await flush();
    expect(tileStates()).toEqual(['streaming']);

    // B is submitted while A runs; its 202 answer is still on the wire.
    input.value = 'second task';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    expect(tasks).toBe(2);

    // The observer describes B first. It must CLAIM the optimistic row, not add
    // a second one for the same prompt.
    push([{ type: 'turn', turn: queuedB }]);
    await flush();

    expect(tileStates()).toEqual(['streaming', 'queued']);
    expect(document.querySelectorAll('.tile')).toHaveLength(2);
    expect(document.querySelectorAll('.turn-row')).toHaveLength(2);
    expect([...document.querySelectorAll('.tile-prompt')].map((node) => node.textContent)).toEqual([
        'first task',
        'second task'
    ]);
    // B is neutral: no clock runs until the server actually starts it.
    expect(
        document.querySelectorAll<HTMLElement>('.tile')[1]?.querySelector<HTMLElement>('.tile-elapsed')?.hidden
    ).toBe(true);

    // A settles and B starts, all before the 202 answer resolves.
    push([{ type: 'turn', turn: doneA }]);
    push([{ type: 'turn', turn: runningB }]);
    push([{ type: 'snapshot', session: fresh }]);
    await flush();

    expect(tileStates()).toEqual(['done', 'streaming']);

    // Now the stale 202 body lands. It must not duplicate, re-order, or regress.
    sendAnswer({ session: staleBoth, turn: queuedB });
    await flush();
    await flush();

    expect(document.querySelectorAll('.tile')).toHaveLength(2);
    expect(document.querySelectorAll('.turn-row')).toHaveLength(2);
    expect(tileStates()).toEqual(['done', 'streaming']);
    expect(
        [...document.querySelectorAll<HTMLElement>('.turn-row')].map((row) => row.dataset.state)
    ).toEqual(['done', 'streaming']);
    expect([...document.querySelectorAll('.tile-prompt')].map((node) => node.textContent)).toEqual([
        'first task',
        'second task'
    ]);
    // A keeps its recorded duration; B still owns the live clock.
    expect(tileElapsed()[0]).toBe('100ms');
    expect(
        document.querySelectorAll<HTMLElement>('.tile')[1]?.querySelector<HTMLElement>('.tile-elapsed')?.hidden
    ).toBe(false);
    expect(document.querySelectorAll('.tile')[1]?.classList.contains('is-expanded')).toBe(true);
});

it('hydrates a queued session on reload and stops the whole queue explicitly', async () => {

    let cancelBody: unknown;
    const runningA = {
        id: 'ta',
        index: 0,
        prompt: 'first task',
        status: 'running',
        startedAt: T,
        updatedAt: T + 10,
        events: [{ type: 'start', agent: 'instruct', model: 'm1' }]
    } as SessionTurn;
    const queuedB = {
        id: 'tb',
        index: 1,
        prompt: 'second task',
        status: 'queued',
        updatedAt: T + 20,
        events: []
    } as unknown as SessionTurn;
    const queued = snapshot({
        id: 's1',
        status: 'running',
        harnessDefinition: descriptor(),
        turns: [runningA, queuedB]
    } as SessionSnapshot);
    const stopped = snapshot({
        id: 's1',
        harnessDefinition: descriptor(),
        turns: [
            { ...runningA, status: 'cancelled', updatedAt: T + 100 },
            { ...queuedB, status: 'cancelled', updatedAt: T + 100 }
        ] as SessionTurn[]
    });

    localStorage.setItem(SESSION_KEY, 's1');

    let observer: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
        start(next) {
            observer = next;
            next.enqueue(dataOf([{ type: 'snapshot', session: queued }]));
        }
    });

    let snapshotGets = 0;

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);

            if (url === '/api') return json(bootstrap({ sessions: [queued] }));
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions/s1' && init?.method === undefined) {
                snapshotGets += 1;
                // Boot/open reads the live queue; the post-cancel resync reads the
                // server's terminal records.
                return json({ session: snapshotGets === 1 ? queued : stopped });
            }
            if (url === '/api/sessions/s1/events') return new Response(body, { status: 200 });
            if (url === '/api/sessions/s1/cancel' && init?.method === 'POST') {
                cancelBody = init.body === undefined ? undefined : JSON.parse(String(init.body));
                return json({ cancelled: true });
            }
            if (url === '/api/sessions' && init?.method === undefined) return json({ sessions: [queued] });

            throw new Error(`unexpected request: ${url}`);
        })
    );

    await import('./main');
    await flush();
    await flush();

    // Reload shows the server-owned queue: active A, neutral B behind it. Empty
    // field + pending work means the ONE composer action is stop (R10).
    expect(tileStates()).toEqual(['streaming', 'queued']);
    const composerAction = byClass('.composer-action', 'button');
    expect(composerAction.dataset.action).toBe('stop');
    expect(composerAction.disabled).toBe(false);
    expect(document.querySelector('.composer .reset')).toBeNull();

    composerAction.click();
    await flush();
    await flush();

    // Stop is explicit and total: active + retained queue.
    expect(cancelBody).toEqual({ all: true });
    expect(tileStates()).toEqual(['cancelled', 'cancelled']);
    expect(composerAction.hidden).toBe(true);
    expect(composerAction.dataset.action).toBe('none');

    observer?.close();
});

it('polls a session that is still running after reload until it is terminal', async () => {
    vi.useFakeTimers();

    const runningTurn: SessionTurn = {
        id: 'r1',
        index: 0,
        prompt: 'long task',
        status: 'running',
        startedAt: T,
        updatedAt: T + 500,
        events: [
            { type: 'start', agent: 'instruct', model: 'm1' },
            { type: 'text', agent: 'instruct', delta: 'half' }
        ]
    };

    const running = snapshot({ id: 'r1', status: 'running', turns: [runningTurn] });
    const finishedTurn: SessionTurn = {
        ...runningTurn,
        status: 'done',
        updatedAt: T + 2500,
        events: [...runningTurn.events, { type: 'text', agent: 'instruct', delta: ' and done' }]
    };
    const finished = snapshot({ id: 'r1', turns: [finishedTurn] });

    localStorage.setItem(SESSION_KEY, 'r1');

    let gets = 0;
    let messageRequests = 0;

    stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap({ sessions: [running] }));
        if (url === '/api/models') return json({ models: ['m1'] });

        if (url === '/api/sessions/r1') {
            gets += 1;
            if (method !== undefined) throw new Error('polling must be a GET');
            // 1 = initial load, 2 = first poll (still running), 3 = terminal.
            return json({ session: gets < 3 ? running : finished });
        }

        if (url.endsWith('/messages')) {
            messageRequests += 1;
            return json({ error: { message: 'Unknown API route.' } }, 404);
        }

        return undefined;
    });

    await import('./main');
    await vi.advanceTimersByTimeAsync(50);

    // The reload rendered the running turn; the observer route is absent in this
    // stub, so the UI falls back to GET polling without turning the app header into
    // a run-status display.
    expect(gets).toBe(1);
    expect(tileStates()).toEqual(['streaming']);
    expect(document.querySelector('.agent-text')?.textContent).toBe('half\n');
    expect(statusText()).toBe('idle');

    // First poll: still running, snapshot re-rendered, same single turn.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(gets).toBe(2);
    expect(tileStates()).toEqual(['streaming']);
    expect(statusText()).toBe('idle');

    // Second poll: terminal. The server turn list replaces the projection.
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(gets).toBe(3);
    expect(tileStates()).toEqual(['done']);
    expect(document.querySelector('.agent-text')?.innerHTML).toBe('<p>half and done</p>\n');
    expect(tileElapsed()).toEqual(['2.5s']);
    // The transition out of pending is reported by the tile, not the app header.
    expect(statusText()).toBe('idle');
    expect(byClass('.session', 'button').dataset.status).toBe('idle');

    // Polling is GET-only: it never starts a model run.
    expect(messageRequests).toBe(0);

    // No further polls after the terminal answer.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(gets).toBe(3);
});

// ---------------------------------------------------------------------------
// Startup without a reachable API (R1)
// ---------------------------------------------------------------------------
//
// The first paint must be a visible status, and a failed bootstrap must become
// the offline pane with a Retry action. This is the exact user-visible contract
// that the dev proxy regression broke: the module graph failed before `boot()`
// ran, leaving `#app` empty.

const emptyTitle = (): string | null | undefined =>
    document.querySelector('.empty-title')?.textContent;
const emptyText = (): string | null | undefined => document.querySelector('.empty-text')?.textContent;

const OFFLINE_HINT =
    'Start the API with `yarn start-service` (repo root, /v1/harness on :5000), then reload. `yarn dev:frontend` is the Vite UI only; it does not start an API.';

const expectOfflinePane = (message: string): void => {
    expect(emptyTitle()).toBe('Harness server unavailable');
    expect(emptyText()).toBe(message);
    expect(document.querySelector('.empty-hint')?.textContent).toBe(OFFLINE_HINT);

    // Retry is the only offered action; a reload re-resolves the API root and
    // re-reads the bootstrap document.
    const retry = [...document.querySelectorAll<HTMLButtonElement>('.stage .composer-actions button')];
    expect(retry).toHaveLength(1);
    expect(retry[0].textContent).toBe('Retry');
    expect(retry[0].type).toBe('button');

    // The status pill names the same failure and the app-level state is red.
    expect(statusText()).toBe('server offline');
    expect(document.querySelector<HTMLElement>('.status')?.dataset.state).toBe('error');

    // No catalogue, no rows and no tools view while offline (R3).
    expect(document.querySelectorAll('.harness-item')).toHaveLength(0);
    expect(document.querySelector('.harness-list .field-hint')?.textContent).toBe('No server connection.');
    expect(byClass('.tools-toggle', 'button').disabled).toBe(true);
};

it('renders the connecting pane before the first request settles', async () => {
    // A fetch that never settles models a server that accepts the TCP connection
    // but never answers: the centre must not be blank while boot waits.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));

    await import('./main');

    expect(emptyTitle()).toBe('Connecting to the harness server…');
    expect(emptyText()).toBe('Contacting /api…');
    expect(document.querySelector('.stage .empty')).not.toBeNull();
    expect(statusText()).toBe('connecting');
    expect(document.querySelector<HTMLElement>('.status')?.dataset.state).toBe('connecting');
    expect(document.querySelectorAll('.harness-item')).toHaveLength(0);
});

it('shows the offline pane when fetch rejects (network refused)', async () => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
            throw new TypeError('Failed to fetch');
        })
    );

    await import('./main');
    await flush();

    expectOfflinePane('The harness server is unreachable: Failed to fetch');
});

it('shows the offline pane when the proxy answers 502 with an empty body', async () => {
    // This is the exact shape Vite's /api proxy produced with its target down:
    // non-OK and not JSON, so readError must fall back to the status line.
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('', { status: 502, statusText: 'Bad Gateway' }))
    );

    await import('./main');
    await flush();

    expectOfflinePane('HTTP 502 Bad Gateway');
});

it('shows the offline pane when a proxy answers 200 with HTML instead of JSON', async () => {
    vi.stubGlobal(
        'fetch',
        vi.fn(
            async () =>
                new Response('<!doctype html><title>Harness UI</title>', {
                    status: 200,
                    headers: { 'Content-Type': 'text/html' }
                })
        )
    );

    await import('./main');
    await flush();

    // loadBootstrap discards the root attempt; /harnesses is the first fallback
    // route to reject with the API abstraction's actionable non-JSON message.
    expectOfflinePane('The harness server returned a non-JSON response for /harnesses (HTTP 200).');
});

// ---------------------------------------------------------------------------
// R8: permanent session deletion
// ---------------------------------------------------------------------------
//
// The row is a `.session-row` wrapper with the select button and a SIBLING
// `.session-delete` control. Deleting is two-step and inline: the first click
// only opens `.session-confirm`, cancel sends nothing, and confirm sends exactly
// one DELETE /sessions/:id and then removes the row. No replacement session is
// created for the current conversation, and a late observer frame must not
// resurrect a deleted one.

it('confirms an inactive session delete once, and cancel sends no request', async () => {
    const doneTurn: SessionTurn = {
        id: 't1',
        index: 0,
        prompt: 'hello',
        status: 'done',
        startedAt: T,
        updatedAt: T + 10,
        events: [{ type: 'start', agent: 'instruct', model: 'm1' }]
    };
    const current = snapshot({ harnessDefinition: descriptor(), turns: [doneTurn] });
    const other = snapshot({ id: 's2', harnessDefinition: descriptor() });

    localStorage.setItem(SESSION_KEY, 's1');

    const calls = stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap({ sessions: [current, other] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1') return json({ session: current });
        if (url === '/api/sessions/s2' && method === 'DELETE') return json({ deleted: true });
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    // Both rows of the selected harness are present; only s1 is active.
    expect(rowIds()).toEqual(['s1', 's2']);
    const wrappers = [...document.querySelectorAll<HTMLElement>('.session-row')];
    expect(wrappers.map((node) => [...node.children].map((child) => child.className))).toEqual([
        ['session', 'session-delete'],
        ['session', 'session-delete']
    ]);
    expect(wrappers.map((node) => node.dataset.status)).toEqual(['idle', 'idle']);
    expect(wrappers.map((node) => node.dataset.active)).toEqual(['true', undefined]);

    const del = byClass('.session-row[data-session-id="s2"] .session-delete', 'button');
    expect(del.textContent).toBe('×');
    expect(del.getAttribute('aria-label')).toBe('Delete session s2');
    expect(del.title).toBe('Delete this session permanently');
    expect(del.disabled).toBe(false);

    // First step: the confirmation opens and NOTHING is sent.
    del.click();
    await flush();

    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([]);
    expect(document.querySelectorAll('.session-confirm')).toHaveLength(1);
    const confirm = byClass('.session-confirm', 'div');
    expect(confirm.dataset.sessionId).toBe('s2');
    expect(confirm.getAttribute('role')).toBe('group');
    expect(confirm.getAttribute('aria-label')).toBe('Confirm deleting session s2');
    expect(confirm.querySelector('.session-confirm-text')?.textContent).toBe(
        'Delete this session permanently. Running or queued work in it stops.'
    );
    expect(confirm.querySelector('.session-confirm-delete')?.textContent).toBe('Delete session');
    expect(confirm.querySelector<HTMLButtonElement>('.session-confirm-delete')?.disabled).toBe(false);
    expect(confirm.querySelector('.session-confirm-cancel')?.textContent).toBe('Cancel');

    // Cancel is a pure view change: the row and the pointer survive, no request.
    byClass('.session-confirm-cancel', 'button').click();
    await flush();

    expect(document.querySelector('.session-confirm')).toBeNull();
    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([]);
    expect(rowIds()).toEqual(['s1', 's2']);
    expect(localStorage.getItem(SESSION_KEY)).toBe('s1');

    // Two-step, then exactly one DELETE and the row disappears.
    byClass('.session-row[data-session-id="s2"] .session-delete', 'button').click();
    await flush();
    byClass('.session-confirm-delete', 'button').click();
    await flush();
    await flush();

    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([
        { url: '/api/sessions/s2', method: 'DELETE', body: undefined }
    ]);
    expect(rowIds()).toEqual(['s1']);
    expect(sessionIds()).toEqual(['s1']);
    expect(byClass('.session-row[data-session-id="s1"]', 'div').dataset.active).toBe('true');
    // The current conversation is untouched: its tile, pointer, frozen team and
    // status note all stay exactly as they were.
    expect(document.querySelectorAll('.tile')).toHaveLength(1);
    expect(localStorage.getItem(SESSION_KEY)).toBe('s1');
    expect(document.querySelector('.session-note')?.hasAttribute('hidden')).toBe(true);
    expect(document.querySelector('.harness-note')?.textContent).toBe(
        'Viewing a saved session · agent team frozen'
    );
    openAgents();
    expect(byClass('.agent-main', 'button').disabled).toBe(true);
    // No session was created: a delete is not a submit.
    expect(calls.filter((call) => call.url === '/api/sessions' && call.method === 'POST')).toEqual([]);
    expect(statusText()).toBe('session s2 deleted');
    expect(byClass('.status', 'span').dataset.state).toBe('idle');
});

it('deletes the running current session, stops watching and creates no replacement', async () => {
    const runningTurn: SessionTurn = {
        id: 't1',
        index: 0,
        prompt: 'long one',
        status: 'running',
        startedAt: T,
        updatedAt: T,
        events: [{ type: 'start', agent: 'instruct', model: 'm1' }]
    };
    const running = snapshot({
        harnessDefinition: descriptor(),
        status: 'running',
        turns: [runningTurn]
    });

    localStorage.setItem(SESSION_KEY, 's1');

    const calls: Call[] = [];
    let observerAborted = false;
    let release: (() => void) | undefined;

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            calls.push({
                url,
                method: init?.method,
                body: init?.body === undefined ? undefined : JSON.parse(String(init.body))
            });

            if (url === '/api') return json(bootstrap({ sessions: [running] }));
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions/s1' && init?.method === undefined) {
                return json({ session: running });
            }
            if (url === '/api/sessions/s1' && init?.method === 'DELETE') {
                return json({ deleted: true });
            }

            if (url === '/api/sessions/s1/events') {
                init?.signal?.addEventListener('abort', () => {
                    observerAborted = true;
                });
                // One turn frame now, the terminal snapshot later: the test decides
                // when it lands, so it can prove a LATE frame cannot resurrect the
                // session after the delete.
                const stream = splitSse(
                    [{ type: 'turn', turn: runningTurn }],
                    [{ type: 'snapshot', session: running }]
                );
                release = stream.release;
                return stream.response;
            }

            throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
        })
    );

    await import('./main');
    await flush();
    await flush();

    // A running session is being observed: its tile is on screen (a running server
    // turn renders as `streaming`) and the composer's stop action is live.
    expect(tileStates()).toEqual(['streaming']);
    expect(byClass('.composer-action', 'button').dataset.action).toBe('stop');
    expect(byClass('.composer-action', 'button').disabled).toBe(false);
    expect(document.querySelector('.session-row[data-session-id="s1"]')?.getAttribute('data-status')).toBe(
        'running'
    );

    // Deleting the CURRENT session is allowed while it runs: the confirmation
    // says the running/queued work stops.
    byClass('.session-row[data-session-id="s1"] .session-delete', 'button').click();
    await flush();
    expect(byClass('.session-confirm-delete', 'button').disabled).toBe(false);
    byClass('.session-confirm-delete', 'button').click();
    await flush();
    await flush();

    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([
        { url: '/api/sessions/s1', method: 'DELETE', body: undefined }
    ]);
    // The observer is unsubscribed (abort only, never a cancel round trip).
    expect(observerAborted).toBe(true);
    expect(calls.filter((call) => call.url.endsWith('/cancel'))).toEqual([]);

    // The row, the transcript, the pointer and every view field are gone; no
    // replacement session was created and the frozen team is editable again.
    expect(rowIds()).toEqual([]);
    expect(document.querySelector('.session-list .field-hint')?.textContent).toBe(
        'No sessions for this harness yet. Send a task to create one.'
    );
    expect(document.querySelectorAll('.tile')).toHaveLength(0);
    expect(document.querySelector('.agent-text')).toBeNull();
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(document.querySelector('.harness-note')?.textContent).toBe('Edits apply to new sessions');
    openAgents();
    expect(byClass('.agent-main', 'button').disabled).toBe(false);
    expect(byClass('.agent-add', 'button').disabled).toBe(false);
    // The deleted conversation took its pending work with it: empty field + idle
    // means no action, and there is no Reset control to fall back on (R10).
    expect(byClass('.composer-action', 'button').hidden).toBe(true);
    expect(byClass('.composer-action', 'button').dataset.action).toBe('none');
    expect(document.querySelector('.reset')).toBeNull();
    expect(byClass('.new-session', 'button').disabled).toBe(false);
    expect(calls.filter((call) => call.url === '/api/sessions' && call.method === 'POST')).toEqual([]);
    expect(statusText()).toBe('session s1 deleted');
    expect(byClass('.status', 'span').dataset.state).toBe('idle');

    // A frame that arrives AFTER the delete is dropped by the session-id guards:
    // nothing repaints and the pointer is not restored.
    release?.();
    await flush();
    await flush();

    expect(rowIds()).toEqual([]);
    expect(document.querySelectorAll('.tile')).toHaveLength(0);
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
});

it('keeps the row and reports the error when a delete is rejected', async () => {
    const current = snapshot({ harnessDefinition: descriptor() });
    localStorage.setItem(SESSION_KEY, 's1');

    const calls = stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap({ sessions: [current] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1' && method === undefined) return json({ session: current });
        if (url === '/api/sessions/s1' && method === 'DELETE') {
            return json({ error: { message: 'The database is read-only.' } }, 500);
        }
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    byClass('.session-delete', 'button').click();
    await flush();
    byClass('.session-confirm-delete', 'button').click();
    await flush();
    await flush();

    // One attempt, row still there, confirmation closed, error reported through
    // the app-scoped pill (the same place a failed session-list read reports).
    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([
        { url: '/api/sessions/s1', method: 'DELETE', body: undefined }
    ]);
    expect(rowIds()).toEqual(['s1']);
    expect(sessionIds()).toEqual(['s1']);
    expect(document.querySelector('.session-confirm')).toBeNull();
    expect(byClass('.status', 'span').dataset.state).toBe('error');
    expect(statusText()).toBe('delete session: The database is read-only.');
    expect(localStorage.getItem(SESSION_KEY)).toBe('s1');
    // The control is usable again, so a transient failure can be retried.
    expect(byClass('.session-delete', 'button').disabled).toBe(false);
});

it('drops the row when the server answers 404 for an already-deleted session', async () => {
    const current = snapshot({ harnessDefinition: descriptor() });
    localStorage.setItem(SESSION_KEY, 's1');

    const calls = stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap({ sessions: [current] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1' && method === undefined) return json({ session: current });
        if (url === '/api/sessions/s1' && method === 'DELETE') {
            return json({ error: { message: 'Unknown session "s1".' } }, 404);
        }
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    byClass('.session-delete', 'button').click();
    await flush();
    byClass('.session-confirm-delete', 'button').click();
    await flush();
    await flush();

    // The desired end state already holds: the local record is dropped, without
    // claiming our request deleted it and without an error state.
    expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(1);
    expect(rowIds()).toEqual([]);
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(document.querySelectorAll('.tile')).toHaveLength(0);
    expect(byClass('.status', 'span').dataset.state).toBe('idle');
    expect(statusText()).toBe('session s1 was already gone');
});

it('dedupes a double-confirmed delete and disables the row while it is in flight', async () => {
    const current = snapshot({ harnessDefinition: descriptor() });
    localStorage.setItem(SESSION_KEY, 's1');

    let deletes = 0;
    let settleDelete: ((response: Response) => void) | undefined;
    const pendingDelete = new Promise<Response>((resolve) => {
        settleDelete = resolve;
    });

    stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap({ sessions: [current] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1' && method === undefined) return json({ session: current });
        if (url === '/api/sessions/s1' && method === 'DELETE') {
            deletes += 1;
            return pendingDelete as unknown as Response;
        }
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    byClass('.session-delete', 'button').click();
    await flush();

    // Hold the node: the in-flight repaint replaces the DOM, so this click proves
    // the guard (not the disabled attribute) is what blocks a duplicate.
    const confirm = byClass('.session-confirm-delete', 'button');
    confirm.click();
    await flush();
    confirm.click();
    await flush();

    expect(deletes).toBe(1);
    expect(byClass('.session-delete', 'button').disabled).toBe(true);
    expect(document.querySelector('.session-confirm')).toBeNull();

    settleDelete?.(json({ deleted: true }));
    await flush();
    await flush();

    expect(rowIds()).toEqual([]);
    expect(statusText()).toBe('session s1 deleted');
});

// R8 regression (reviewer-reproduced race): a directory read that STARTED before a
// delete can resolve after it. The raw list answer still contains the deleted id,
// so assigning it unfiltered rebuilt the row. A tombstoned id must stay gone while
// the survivor in the same answer still renders.
it('never resurrects a deleted session from a stale session-list answer', async () => {
    const deleted = snapshot({
        harnessDefinition: descriptor(),
        turns: [
            {
                id: 't1',
                index: 0,
                prompt: 'delete me',
                status: 'done',
                startedAt: T,
                updatedAt: T + 10,
                events: [{ type: 'start', agent: 'instruct', model: 'm1' }]
            }
        ]
    });
    const survivor = snapshot({ id: 's2', harnessDefinition: descriptor() });

    localStorage.setItem(SESSION_KEY, 's1');

    let listRequests = 0;
    let settleList: ((response: Response) => void) | undefined;
    // The list answer is held until the test releases it, so its content is
    // provably OLDER than the delete that lands while it is in flight.
    const pendingList = new Promise<Response>((resolve) => {
        settleList = resolve;
    });

    const calls = stubFetch((url, method) => {
        if (url === '/api') return json(bootstrap({ sessions: [deleted, survivor] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1' && method === undefined) return json({ session: deleted });
        if (url === '/api/sessions/s1' && method === 'DELETE') return json({ deleted: true });
        if (url === '/api/sessions' && method === undefined) {
            listRequests += 1;
            return pendingList as unknown as Response;
        }
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    expect(rowIds()).toEqual(['s1', 's2']);
    expect(document.querySelectorAll('.tile')).toHaveLength(1);

    // Start the directory read and leave it un-answered.
    const refresh = byClass('.sessions-actions button:nth-of-type(2)', 'button');
    expect(refresh.textContent).toBe('Refresh');
    refresh.click();
    await flush();
    expect(listRequests).toBe(1);
    expect(refresh.disabled).toBe(true);

    // Delete the CURRENT session while that older read is still in flight.
    byClass('.session-row[data-session-id="s1"] .session-delete', 'button').click();
    await flush();
    byClass('.session-confirm-delete', 'button').click();
    await flush();
    await flush();

    expect(calls.filter((call) => call.method === 'DELETE')).toEqual([
        { url: '/api/sessions/s1', method: 'DELETE', body: undefined }
    ]);
    expect(rowIds()).toEqual(['s2']);
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(document.querySelectorAll('.tile')).toHaveLength(0);

    // Release the pre-delete list: it still names s1. The tombstone filter must keep
    // the deleted row gone and leave the surviving session visible.
    settleList?.(json({ sessions: [deleted, survivor] }));
    await flush();
    await flush();

    expect(listRequests).toBe(1);
    expect(rowIds()).toEqual(['s2']);
    expect(sessionIds()).toEqual(['s2']);
    expect(document.querySelector('.session-row[data-session-id="s1"]')).toBeNull();
    expect(byClass('.session-row[data-session-id="s2"]', 'div').dataset.status).toBe('idle');
    expect(byClass('.session-row[data-session-id="s2"]', 'div').dataset.active).toBeUndefined();
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(document.querySelectorAll('.tile')).toHaveLength(0);
    expect(document.querySelector('.harness-note')?.textContent).toBe('Edits apply to new sessions');
    openAgents();
    expect(byClass('.agent-main', 'button').disabled).toBe(false);
    expect(refresh.disabled).toBe(false);
});

// End-to-end shell + request lifecycle against stubbed server answers.
//
// This file pins the redesigned three-column playground and the behaviours the
// change is for:
//   - R1: the harness rail lists the server catalogue and offers a create action;
//   - R2: a horizontal agent row labels primary/secondary, the trailing + opens a
//     trusted preset picker, selecting a member promotes it, and a saved session
//     freezes its team (editing is locked with a New session affordance);
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
// Run: npx vitest run --config playground/vitest.config.ts
import type {
    HarnessAssistantMessage,
    HarnessDescriptor,
    SessionSnapshot,
    SessionStreamItem,
    SessionTurn
} from '../../server/protocol';
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
const agentRoles = (): (string | undefined)[] =>
    [...document.querySelectorAll<HTMLElement>('.agent-tile')].map((tile) => tile.dataset.role);
const agentNames = (): (string | null)[] =>
    [...document.querySelectorAll<HTMLElement>('.agent-tile-name')].map((node) => node.textContent);
const harnessNames = (): (string | null)[] =>
    [...document.querySelectorAll<HTMLElement>('.harness-item .harness-name')].map((node) => node.textContent);
// The core list is gone from the UI (R21.2); this helper stays only so a test can
// prove it renders nothing anywhere.
const coreToolNames = (): (string | null)[] =>
    [...document.querySelectorAll<HTMLElement>('.core-tool-name')].map((node) => node.textContent);
const sessionIds = (): (string | undefined)[] =>
    [...document.querySelectorAll<HTMLElement>('.session')].map((node) => node.dataset.sessionId);

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
    let messageRequests = 0;

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

        if (url === '/api/sessions/s1/messages' && method === 'POST') {
            messageRequests += 1;
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
    const runButton = byClass('.run', 'button');

    input.value = 'say hi';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    // The tile exists before the server answers; while the stream is open the
    // request lock is held, so a second submit is ignored.
    expect(document.querySelector('.tile')).not.toBeNull();
    expect(byClass('.agent-main', 'button').disabled).toBe(true);
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    await flush();
    await flush();

    expect(messageRequests).toBe(1);

    const tile = byClass('.tile', 'article');
    expect(tile.dataset.state).toBe('done');
    expect(tile.querySelector('.tile-index')?.textContent).toBe('#1');
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

    expect(statusText()).toBe('done · m1 · idle');
    expect(runButton.disabled).toBe(false);
    // A session exists now, so the team is frozen: editing needs a New session.
    expect(byClass('.agent-main', 'button').disabled).toBe(true);
    expect(document.querySelector('.agent-lock-text')?.textContent).toBe(
        'This saved session keeps the agent team it started with.'
    );
});

// Token tally: the server OWNS the running sum. Each event frame carries it
// (`SessionStreamItem.usage`), main.ts forwards it to the tile (`setUsage`) and
// the tile prints INPUT with the cached part in brackets — see
// playground/src/ui/tokens.ts, which is why `48/0` renders '48 (0)' and
// `144/48` renders '144 (48)'; `output` is never printed.
it('prints the running tally per frame and keeps it through the terminal snapshot', async () => {
    const firstTally = { input: 48, output: 18, total: 66, cached: 0 };
    const lastTally = { input: 144, output: 40, total: 184, cached: 48 };

    const start = { type: 'start' as const, agent: 'instruct', model: 'm1' };
    const text = { type: 'text' as const, agent: 'instruct', delta: 'hi' };
    const done = { type: 'done' as const, agent: 'instruct', message: assistant({ content: 'hi' }) };

    // The recorded turn is what the terminal snapshot re-hydrates from, tally
    // included: a reload must show the same figure the live stream ended on.
    const recorded: SessionTurn = {
        id: 't1',
        index: 0,
        prompt: 'say hi',
        status: 'done',
        startedAt: T,
        updatedAt: T + 3600,
        events: [start, text, done],
        eventTimes: [T, T + 100, T + 200],
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

        if (url === '/api/sessions/s1/messages' && method === 'POST') {
            const stream = splitSse(
                [
                    { type: 'turn', turn: opening },
                    { type: 'event', turnId: 't1', event: start, at: T, usage: firstTally }
                ],
                [
                    // A frame with NO tally between two tallied ones: it must leave
                    // the figure alone rather than clear it.
                    { type: 'event', turnId: 't1', event: text, at: T + 100 },
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
    expect(tile.querySelector<HTMLElement>('.tile-tokens')?.textContent).toBe('144 (48)');
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

        if (url === '/api/sessions/s1/messages' && method === 'POST') {
            // An older server: no `turns` on the terminal frame, so main.ts settles
            // the LIVE tile instead of rebuilding it. Whatever the frames left on
            // the label is what the user keeps.
            const items: SessionStreamItem[] = [
                { type: 'turn', turn: opening },
                { type: 'event', turnId: 't1', event: start, at: T, usage: tally },
                { type: 'event', turnId: 't1', event: text, at: T + 100 },
                { type: 'event', turnId: 't1', event: done, at: T + 200 },
                { type: 'snapshot', session: snapshot({ harnessDefinition: descriptor() }) }
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
    // R21.2: the enabled-for-session status now lives on the Tools tab (its tab
    // pane is detached while Chat owns the stage — tools-tab.test.ts pins the
    // text). What matters here is that no right-rail core dropdown came back.
    expect(document.querySelector('.core-tools')).toBeNull();
    for (const button of document.querySelectorAll<HTMLButtonElement>('.agent-main')) {
        expect(button.disabled).toBe(true);
    }
    expect(byClass('.agent-add', 'button').disabled).toBe(true);
    expect(document.querySelector('.agent-lock-text')?.textContent).toBe(
        'This saved session keeps the agent team it started with.'
    );

    // The lock's affordance starts a new conversation, which unlocks editing.
    byClass('.agent-lock .link-button', 'button').click();
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
        'summarizer'
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
    expect(agentNames()).toEqual(['Workspace', 'Summarizer']);
    expect(agentRoles()).toEqual(['primary', 'secondary']);
    // R21.2: no right-rail core list follows the new harness; the Tools tab
    // (detached while Chat is showing) carries that status instead.
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

    // The picker is the trusted preset list, with read-only instructions.
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
    // R21.2: the core set is no longer rendered anywhere; the Tools tab lists every
    // tool (core entries included) from the server catalogue instead.
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

        if (url === '/api/sessions/s1/messages') {
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

it('stops the originating session and locks selection while a run is in flight', async () => {
    let cancelRequests = 0;
    let messageStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
        messageStarted = resolve;
    });

    const other = descriptor({ name: 'workspace', title: 'Workspace', agents: ['workspace'], primary: 'workspace' });

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);

            if (url === '/api') return json(bootstrap({ presets: [descriptor(), other] }));
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions' && init?.method === 'POST') return json({ session: snapshot() });

            if (url === '/api/sessions/s1/messages') {
                messageStarted?.();
                // A stream that stays open until the request is aborted.
                return new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () =>
                        reject(new DOMException('The operation was aborted.', 'AbortError'))
                    );
                });
            }

            if (url === '/api/sessions/s1/cancel' && init?.method === 'POST') {
                cancelRequests += 1;
                return json({ cancelled: true });
            }

            if (url === '/api/sessions' && init?.method === undefined) return json({ sessions: [] });

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

    // While the stream owns the instance, selection and edits are locked.
    expect(byClass('.harness-item[data-harness="workspace"]', 'button').disabled).toBe(true);
    expect(byClass('.new-session', 'button').disabled).toBe(true);
    expect(byClass('.agent-add', 'button').disabled).toBe(true);

    byClass('.stop', 'button').click();
    await flush();
    await flush();

    // Stop cancels the session the run started on, not a later selection.
    expect(cancelRequests).toBe(1);
    expect(tileStates()).toEqual(['cancelled']);
    expect(statusText()).toBe('cancelled');
    expect(byClass('.harness-item[data-harness="workspace"]', 'button').disabled).toBe(false);
    expect(byClass('.stop', 'button').disabled).toBe(true);
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

    // The reload rendered the running turn and says it is following the server.
    expect(gets).toBe(1);
    expect(tileStates()).toEqual(['streaming']);
    expect(document.querySelector('.agent-text')?.textContent).toBe('half\n');
    expect(statusText()).toBe('session running · polling server');

    // First poll: still running, snapshot re-rendered, same single turn.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(gets).toBe(2);
    expect(tileStates()).toEqual(['streaming']);

    // Second poll: terminal. The server turn list replaces the projection.
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(gets).toBe(3);
    expect(tileStates()).toEqual(['done']);
    expect(document.querySelector('.agent-text')?.innerHTML).toBe('<p>half and done</p>\n');
    expect(tileElapsed()).toEqual(['2.5s']);
    expect(statusText()).toBe('idle');
    expect(byClass('.session', 'button').dataset.status).toBe('idle');

    // Polling is GET-only: it never starts a model run.
    expect(messageRequests).toBe(0);

    // No further polls after the terminal answer.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(gets).toBe(3);
});

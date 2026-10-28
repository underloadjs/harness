// End-to-end shell + request lifecycle against stubbed server answers.
//
// H4 pins what this file has to prove:
//   - boot consumes the server catalogue (bootstrap document or the standalone
//     routes) and the server's session list;
//   - a reload with a remembered session id renders the server's turns, including
//     subagent events and tool cards, without POSTing a message (no model run);
//   - stream frames carry explicit turn ids, and the terminal snapshot replaces
//     whatever the browser projected;
//   - editing endpoint settings never creates, replaces or deletes a session;
//   - a session that is still running after a reload is polled until terminal.
//
// `main.ts` is a module with side effects: it builds the shell and boots against
// the API. `fetch` is stubbed and the SSE body is a real ReadableStream, so
// api.ts parses its own frames. No server, no provider.
//
// Run: npx vitest run --config playground/vitest.config.ts
import type { HarnessAssistantMessage, SessionSnapshot, SessionStreamItem, SessionTurn } from '../../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const descriptor = {
    name: 'demo',
    title: 'Demo harness',
    description: 'A harness for the lifecycle test.',
    requiresEndpoint: true,
    agents: ['writer'],
    tools: []
};

const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };

const SESSION_KEY = 'underload-harness-app:session';

const assistant = (overrides: Partial<HarnessAssistantMessage> = {}): HarnessAssistantMessage => ({
    role: 'assistant',
    content: 'answer',
    reasoning: '',
    toolCalls: [],
    model: 'm1',
    stopReason: 'stop',
    ...overrides
});

const snapshot = (overrides: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
    id: 's1',
    harness: 'demo',
    status: 'idle',
    model: 'm1',
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    turns: [],
    ...overrides
});

const bootstrap = (sessions: SessionSnapshot[] = []) => ({
    rootPath: 'D:/repo',
    presets: [descriptor],
    tools: [],
    defaults,
    sessions
});

// One SSE frame per `SessionStreamItem`, exactly the shape api.ts parses.
const sse = (items: readonly unknown[]): Response => {
    const body = items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join('');
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
        }
    });

    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};

const json = (value: unknown): Response =>
    new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

const notFound = (): Response =>
    new Response(JSON.stringify({ error: { message: 'Unknown API route.' } }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
    });

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
};

const statusText = (): string | null | undefined => document.querySelector('.status-text')?.textContent;

const tileStates = (): (string | null | undefined)[] =>
    [...document.querySelectorAll<HTMLElement>('.tile')].map((tile) => tile.dataset.state);

const tileIndexes = (): (string | null)[] =>
    [...document.querySelectorAll<HTMLElement>('.tile-index')].map((index) => index.textContent);

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

it('boots, streams a turn by explicit id, then renders the server snapshot', async () => {
    let messageRequests = 0;

    const start = { type: 'start' as const, agent: 'writer', model: 'm1' };
    const done = {
        type: 'done' as const,
        agent: 'writer',
        message: assistant({ content: 'a b' })
    };

    // The turn the server records: identical events to the stream, which is what
    // makes the hydration assertion meaningful (the DOM could not tell them
    // apart if the snapshot were ignored, so test 4 breaks that tie).
    const recorded: SessionTurn = {
        id: 't1',
        index: 0,
        prompt: 'say hi',
        status: 'done',
        startedAt: 1,
        updatedAt: 2,
        events: [start, { type: 'text', agent: 'writer', delta: '# Hi\n\n' }, { type: 'text', agent: 'writer', delta: 'a **b**' }, done]
    };

    const opening: SessionTurn = { ...recorded, status: 'running', events: [] };
    const finished = snapshot({ turns: [recorded] });

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);

            if (url === '/api') return json(bootstrap());
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions' && init?.method === 'POST') return json({ session: snapshot() });

            if (url === '/api/sessions/s1/messages' && init?.method === 'POST') {
                messageRequests += 1;

                const items: SessionStreamItem[] = [
                    { type: 'turn', turn: opening },
                    { type: 'event', turnId: 't1', event: start },
                    { type: 'event', turnId: 't1', event: { type: 'text', agent: 'writer', delta: '# Hi\n\n' } },
                    { type: 'event', turnId: 't1', event: { type: 'text', agent: 'writer', delta: 'a **b**' } },
                    { type: 'event', turnId: 't1', event: done },
                    { type: 'snapshot', session: finished }
                ];

                return sse(items);
            }

            throw new Error(`unexpected request: ${url}`);
        })
    );

    await import('./main');
    await flush();

    expect(statusText()).toBe('idle');
    expect(document.querySelector('.main-title')?.textContent).toBe('Demo harness');
    // The bootstrap session list is empty and rendered as such.
    expect(document.querySelector('.session-list .field-hint')?.textContent).toBe(
        'No sessions on this server yet. Send a task to create one.'
    );

    const input = document.querySelector<HTMLTextAreaElement>('.composer-input');
    const form = document.querySelector<HTMLFormElement>('.composer');
    const run = document.querySelector<HTMLButtonElement>('button.primary');
    if (input === null || form === null || run === null) throw new Error('shell did not render');

    input.value = 'say hi';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    // The tile exists before the server answers; while the stream is open the
    // request lock is held, so a second submit is ignored.
    expect(document.querySelector('.tile')).not.toBeNull();
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    await flush();
    await flush();

    expect(messageRequests).toBe(1);

    const tile = document.querySelector<HTMLElement>('.tile');
    expect(tile?.getAttribute('data-state')).toBe('done');
    // The server's turn index (0) is displayed 1-based.
    expect(tile?.querySelector('.tile-index')?.textContent).toBe('#1');
    expect(tile?.querySelector('.tile-status-text')?.textContent).toBe('done');
    expect(tile?.querySelector('.turn-prompt')?.textContent).toBe('say hi\n');
    expect(tile?.querySelector('.agent-text')?.innerHTML).toBe('<h1>Hi</h1>\n<p>a <strong>b</strong></p>\n');
    expect(tile?.querySelector('.agent-meta')?.textContent).toBe('m1 · stop');
    expect(tile?.querySelector('.tile-meta')?.textContent).toBe('1 agent · m1 · done');
    expect(tile?.classList.contains('is-expanded')).toBe(true);

    // The terminal snapshot populated the directory and the remembered pointer.
    const row = document.querySelector<HTMLElement>('.session');
    expect(row?.dataset.status).toBe('idle');
    expect(row?.dataset.active).toBe('true');
    expect(row?.querySelector('.session-meta')?.textContent).toBe('idle · 1 turn · s1');
    expect(row?.querySelector('.session-prompt')?.textContent).toBe('say hi');
    expect(localStorage.getItem(SESSION_KEY)).toBe('s1');

    expect(statusText()).toBe('done · m1 · idle');
    expect(run.disabled).toBe(false);
});

it('restores a remembered session from the server without starting a model run', async () => {
    const messages = [assistant({ content: 'sub answer' })];

    const first: SessionTurn = {
        id: 't1',
        index: 0,
        prompt: 'first task',
        status: 'done',
        startedAt: 10,
        updatedAt: 20,
        events: [
            { type: 'start', agent: 'writer', model: 'm1' },
            { type: 'tool_call', agent: 'writer', call: { id: 'c1', name: 'readFile', arguments: '{"path":"package.json"}' } },
            { type: 'start', agent: 'helper', model: 'm2' },
            { type: 'text', agent: 'helper', delta: 'sub **answer**' },
            { type: 'done', agent: 'helper', message: assistant({ content: 'sub answer', model: 'm2' }) },
            { type: 'tool_result', agent: 'writer', name: 'readFile', content: '{"ok":true}', isError: false },
            { type: 'text', agent: 'writer', delta: '## Answer\n\nfinal' },
            { type: 'done', agent: 'writer', message: assistant() }
        ]
    };

    const second: SessionTurn = {
        id: 't2',
        index: 1,
        prompt: 'second task',
        status: 'error',
        startedAt: 30,
        updatedAt: 40,
        events: [
            { type: 'start', agent: 'writer', model: 'm1' },
            { type: 'error', agent: 'writer', error: { message: 'provider exploded' } }
        ]
    };

    const restored = snapshot({ turns: [first, second], messages });

    const other = snapshot({ id: 's2', createdAt: 3, updatedAt: 4 });

    localStorage.setItem(SESSION_KEY, 's1');

    let messageRequests = 0;
    let getRequests = 0;
    let listRequests = 0;

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);

            if (url === '/api') return json(bootstrap([restored]));
            if (url === '/api/models') return json({ models: ['m1'] });

            if (url === '/api/sessions' && init?.method === undefined) {
                listRequests += 1;
                // The refresh answer includes a session this page never created.
                return json({ sessions: [restored, other] });
            }

            if (url === '/api/sessions/s1') {
                if (init?.method === 'POST' || init?.method === 'DELETE') throw new Error('unexpected write');
                getRequests += 1;
                return json({ session: restored });
            }

            if (url.endsWith('/messages')) messageRequests += 1;

            throw new Error(`unexpected request: ${url}`);
        })
    );

    await import('./main');
    await flush();
    await flush();

    expect(getRequests).toBe(1);
    expect(messageRequests).toBe(0);

    expect(tileIndexes()).toEqual(['#1', '#2']);
    expect(tileStates()).toEqual(['done', 'error']);

    const tiles = [...document.querySelectorAll<HTMLElement>('.tile')];

    // Newest turn is expanded; the older one stays compact but fully rendered.
    expect(tiles[0].classList.contains('is-expanded')).toBe(false);
    expect(tiles[1].classList.contains('is-expanded')).toBe(true);
    expect(tiles[0].querySelector('.tile-meta')?.textContent).toBe('2 agents · 1 tool call · m1 · done');

    // Subagent labelling and tool pairing come from the recorded event order.
    const agents = [...tiles[0].querySelectorAll<HTMLElement>('.agent')];
    expect(agents.map((agent) => agent.dataset.agent)).toEqual(['writer', 'helper']);
    expect(agents.map((agent) => agent.dataset.role)).toEqual(['primary', 'subagent']);
    expect(agents[1].querySelector('.agent-meta')?.textContent).toBe('m2 · stop');
    expect(tiles[0].querySelector<HTMLElement>('details.tool')?.dataset.state).toBe('ok');
    expect(tiles[0].querySelector('.tool-state')?.textContent).toBe('ok');
    expect(agents[0].querySelector('.agent-text')?.innerHTML).toBe('<h2>Answer</h2>\n<p>final</p>\n');

    // The failed turn renders its error event, not a synthesised message.
    expect(tiles[1].querySelector('.tile-status-text')?.textContent).toBe('error');
    expect(tiles[1].querySelector('.agent-error-label')?.textContent).toBe('error');
    expect(tiles[1].querySelector('.agent-error-text')?.textContent).toBe('provider exploded');
    expect(tiles[1].querySelector('.tile-meta')?.textContent).toBe('1 agent · m1 · error');

    // Prompt markdown and the informational entry-agent transcript.
    expect(tiles[1].querySelector('.turn-prompt')?.innerHTML).toBe('<p>second task</p>\n');
    expect(document.querySelector('.transcript-body')?.textContent).toBe(JSON.stringify(messages, null, 2));

    const row = document.querySelector<HTMLElement>('.session');
    expect(row?.dataset.active).toBe('true');
    expect(row?.querySelector('.session-meta')?.textContent).toBe('idle · 2 turns · s1');

    // Refresh re-reads the directory: a session created outside this page shows
    // up without touching the open transcript.
    const refresh = document.querySelectorAll<HTMLButtonElement>('.sessions-actions button')[1];
    refresh.click();
    await flush();

    expect(listRequests).toBe(1);
    const rows = [...document.querySelectorAll<HTMLElement>('.session')];
    expect(rows).toHaveLength(2);
    expect(rows[0].dataset.active).toBe('true');
    expect(rows[1].dataset.sessionId).toBe('s2');
    expect(rows[1].querySelector('.session-meta')?.textContent).toBe('idle · 0 turns · s2');
    expect(rows[1].querySelector('.session-prompt')?.textContent).toBe('no turns yet');
    // The open transcript was not rebuilt from the list answer.
    expect(tileIndexes()).toEqual(['#1', '#2']);

    expect(statusText()).toBe('idle');
});

it('keeps the existing session when endpoint settings change', async () => {
    const recorded: SessionTurn = {
        id: 't1',
        index: 0,
        prompt: 'keep me',
        status: 'done',
        startedAt: 1,
        updatedAt: 2,
        events: [{ type: 'start', agent: 'writer', model: 'm1' }, { type: 'text', agent: 'writer', delta: 'kept' }]
    };

    const existing = snapshot({ turns: [recorded] });
    localStorage.setItem(SESSION_KEY, 's1');

    let created = 0;
    let deleted = 0;

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);

            if (url === '/api') return json(bootstrap([existing]));
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions/s1') return json({ session: existing });

            if (url === '/api/sessions') {
                if (init?.method === 'POST') created += 1;
                return json({ session: snapshot() });
            }

            if (init?.method === 'DELETE') {
                deleted += 1;
                return json({ deleted: true });
            }

            throw new Error(`unexpected request: ${url}`);
        })
    );

    await import('./main');
    await flush();
    await flush();

    expect(document.querySelectorAll('.tile')).toHaveLength(1);

    // Change the base URL through the real input path (this is a *draft*: it is
    // only used the next time a session is created).
    const baseURL = document.querySelector<HTMLInputElement>('.endpoint input.field-input');
    if (baseURL === null) throw new Error('the endpoint fields did not render');
    baseURL.value = 'http://other-provider/v1';
    baseURL.dispatchEvent(new Event('input', { bubbles: true }));

    // Long enough for the debounced model refresh to fire, so a bug that tripped
    // session recreation on any settings change would have happened by now.
    await new Promise((resolve) => setTimeout(resolve, 650));
    await flush();

    expect(created).toBe(0);
    expect(deleted).toBe(0);
    expect(document.querySelectorAll('.tile')).toHaveLength(1);
    expect(document.querySelector('.tile')?.isConnected).toBe(true);
    expect(document.querySelector('.agent-text')?.textContent).toBe('kept\n');
    expect(localStorage.getItem(SESSION_KEY)).toBe('s1');
    expect(document.querySelector<HTMLElement>('.session')?.dataset.active).toBe('true');
});

it('replaces the projected stream with the authoritative terminal snapshot', async () => {
    const start = { type: 'start' as const, agent: 'writer', model: 'm1' };
    const recorded: SessionTurn = {
        id: 't1',
        index: 0,
        prompt: 'go',
        status: 'done',
        startedAt: 1,
        updatedAt: 2,
        events: [start, { type: 'text', agent: 'writer', delta: 'server wins' }]
    };

    const finished = snapshot({ turns: [recorded] });
    const opening: SessionTurn = { ...recorded, status: 'running', events: [] };

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);

            if (url === '/api') return json(bootstrap());
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions' && init?.method === 'POST') return json({ session: snapshot() });

            if (url === '/api/sessions/s1/messages') {
                return sse([
                    { type: 'turn', turn: opening },
                    { type: 'event', turnId: 't1', event: start },
                    // A transient projection the server did not record.
                    { type: 'event', turnId: 't1', event: { type: 'text', agent: 'writer', delta: 'draft ' } },
                    { type: 'event', turnId: 't1', event: { type: 'text', agent: 'writer', delta: 'that differs' } },
                    { type: 'snapshot', session: finished }
                ]);
            }

            throw new Error(`unexpected request: ${url}`);
        })
    );

    await import('./main');
    await flush();

    const input = document.querySelector<HTMLTextAreaElement>('.composer-input');
    const form = document.querySelector<HTMLFormElement>('.composer');
    if (input === null || form === null) throw new Error('shell did not render');

    input.value = 'go';
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    await flush();
    await flush();

    expect(document.querySelectorAll('.tile')).toHaveLength(1);
    expect(document.querySelector('.agent-text')?.innerHTML).toBe('<p>server wins</p>\n');
    expect(document.querySelector('.agent-text')?.textContent).not.toContain('draft');
    expect(document.querySelector('.tile-meta')?.textContent).toBe('1 agent · m1 · done');
});

it('polls a session that is still running after reload until it is terminal', async () => {
    vi.useFakeTimers();

    const runningTurn: SessionTurn = {
        id: 'r1',
        index: 0,
        prompt: 'long task',
        status: 'running',
        startedAt: 1,
        updatedAt: 2,
        events: [{ type: 'start', agent: 'writer', model: 'm1' }, { type: 'text', agent: 'writer', delta: 'half' }]
    };

    const running = snapshot({ id: 'r1', status: 'running', turns: [runningTurn] });
    const finishedTurn: SessionTurn = {
        ...runningTurn,
        status: 'done',
        updatedAt: 9,
        events: [...runningTurn.events, { type: 'text', agent: 'writer', delta: ' and done' }]
    };
    const finished = snapshot({ id: 'r1', turns: [finishedTurn] });

    localStorage.setItem(SESSION_KEY, 'r1');

    let gets = 0;
    let messageRequests = 0;

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);

            if (url === '/api') return json(bootstrap([running]));
            if (url === '/api/models') return json({ models: ['m1'] });

            if (url === '/api/sessions/r1') {
                gets += 1;
                if (init?.method !== undefined) throw new Error('polling must be a GET');
                // 1 = initial load, 2 = first poll (still running), 3 = terminal.
                return json({ session: gets < 3 ? running : finished });
            }

            if (url.endsWith('/messages')) {
                messageRequests += 1;
                if (init?.method === undefined) throw new Error('messages must be POSTed');
                return notFound();
            }

            throw new Error(`unexpected request: ${url}`);
        })
    );

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
    expect(document.querySelector('.tile-meta')?.textContent).toBe('1 agent · m1 · done');
    expect(statusText()).toBe('idle');
    expect(document.querySelector<HTMLElement>('.session')?.dataset.status).toBe('idle');

    // Polling is GET-only: it never starts a model run.
    expect(messageRequests).toBe(0);

    // No further polls after the terminal answer.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(gets).toBe(3);
});

it('renders the server harness descriptors as the catalogue and selects the first card', async () => {
    // The server is the only catalogue: every live card advertises the same tool
    // list, and only the agents/core tools differ by agent configuration.
    const sharedTools = ['readFile', 'clock'];
    const instruct = {
        name: 'instruct',
        title: 'Instruct',
        description: 'A general agent.',
        requiresEndpoint: true,
        agents: ['instruct'],
        tools: sharedTools,
        coreTools: ['getTools', 'createTool', 'todoTools']
    };
    const research = {
        name: 'research',
        title: 'Research',
        description: 'A research agent.',
        requiresEndpoint: true,
        agents: ['research', 'summarizer'],
        tools: sharedTools,
        coreTools: ['getTools', 'createTool', 'todoTools', 'delegate']
    };

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);

            if (url === '/api') {
                return json({
                    rootPath: '/api',
                    presets: [instruct, research],
                    tools: [],
                    defaults,
                    sessions: []
                });
            }

            if (url === '/api/models') return json({ models: ['m1'] });

            throw new Error(`unexpected request: ${url}`);
        })
    );

    await import('./main');
    await flush();
    await flush();

    const cards = [...document.querySelectorAll<HTMLButtonElement>('.presets .preset')];
    expect(cards.map((card) => card.querySelector('.preset-name')?.textContent)).toEqual([
        'instruct',
        'research'
    ]);

    // The UI selects the first server descriptor at boot (the server lists the
    // live Instruct harness first), not a hardcoded default.
    expect(cards.map((card) => card.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    expect(document.querySelector('.main-title')?.textContent).toBe('Instruct');

    const badges = (): (string | null)[] =>
        [...document.querySelectorAll('.badges .badge')].map((badge) => badge.textContent);

    expect(badges()).toEqual([
        'agents: instruct',
        // Server-owned: the UI does not invent or hardcode the core set.
        'core: getTools, createTool, todoTools',
        'catalogue: readFile, clock',
        'needs endpoint'
    ]);

    cards[1].click();

    // Same catalogue, different agent configuration: delegate appears only here.
    expect(document.querySelector('.main-title')?.textContent).toBe('Research');
    expect(badges()).toEqual([
        'agents: research, summarizer',
        'core: getTools, createTool, todoTools, delegate',
        'catalogue: readFile, clock',
        'needs endpoint'
    ]);
});

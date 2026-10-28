// Status scoping (R1/R2/R3): the topbar pill reports APP state only.
//
// User report: a saved cancelled session showed the red global status
// "The run was cancelled." in the top-right header. Each session is scoped
// separately; cancellation and run errors already have a place in the transcript
// (turn-tile status word + the pane's session note), so they must never paint the
// app header or outlive the session they belong to.
//
// Pinned here:
//   - opening a saved CANCELLED session: header idle, tile cancelled, no error note;
//   - opening a saved FAILED session: header idle, tile error, note has the detail;
//   - switching sessions: header stays neutral and the note follows the session
//     (no leakage, no stale text);
//   - an active task that fails: header idle, failed tile + note detail;
//   - a failure while the queue keeps running: detail stays local, queue continues;
//   - a real bootstrap failure: still surfaced in the app header and the pane (R3).
//
// Run: npx vitest run --config playground/vitest.config.ts
import type {
    HarnessDescriptor,
    SessionSnapshot,
    SessionTurn
} from '../../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const T = 1_700_000_000_000;
const SESSION_KEY = 'underload-harness-app:session';
const CANCELLED = 'The run was cancelled.';
const FAILURE = 'provider exploded';

const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };

const descriptor = (overrides: Record<string, unknown> = {}): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: 'A general instruction-following agent.',
        requiresEndpoint: true,
        agents: ['instruct'],
        tools: ['fileRead'],
        coreTools: ['fileRead', 'fileWrite', 'fileEdit', 'fileGlob', 'toolRequest', 'toolCreate', 'todoManage'],
        primary: 'instruct',
        subagents: [],
        builtin: true,
        editable: true,
        ...overrides
    }) as HarnessDescriptor;

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
    agents: [],
    ...overrides
});

const turn = (overrides: Partial<SessionTurn>): SessionTurn =>
    ({
        id: 't1',
        index: 0,
        prompt: 'task',
        status: 'done',
        startedAt: T,
        updatedAt: T + 100,
        events: [],
        ...overrides
    }) as SessionTurn;

// One SSE frame per `SessionStreamItem`, exactly the shape api.ts parses.
const dataOf = (items: readonly unknown[]): Uint8Array =>
    new TextEncoder().encode(items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join(''));

const sse = (items: readonly unknown[]): Response => {
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(dataOf(items));
            controller.close();
        }
    });

    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};

// A stream whose tail is released by the test, so the state BEFORE the terminal
// snapshot (a failure still owning a pane) can be observed deterministically.
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

const byClass = <K extends keyof HTMLElementTagNameMap>(
    selector: string,
    tag: K
): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);
    return found;
};

const statusState = (): string | undefined => byClass('.status', 'span').dataset.state;
const statusText = (): string | null | undefined => document.querySelector('.status-text')?.textContent;
const tileStates = (): (string | null | undefined)[] =>
    [...document.querySelectorAll<HTMLElement>('.tile')].map((tile) => tile.dataset.state);
const tileStatusText = (): (string | null | undefined)[] =>
    [...document.querySelectorAll<HTMLElement>('.tile-status-text')].map((node) => node.textContent);

// The pane note is the session-scoped failure line. `hidden` (not merely empty)
// is what keeps the common, healthy view free of an empty banner.
const note = (): HTMLElement => byClass('.session-note', 'p');
const noteText = (): string | null | undefined => note().textContent;
const noteHidden = (): boolean => note().hidden;

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

it('opens a saved cancelled session without a run status in the app header', async () => {
    const cancelled = snapshot({
        id: 's1',
        status: 'error',
        lastError: CANCELLED,
        updatedAt: T + 200,
        turns: [turn({ status: 'cancelled', prompt: 'stopped task', startedAt: undefined, updatedAt: T + 200 })]
    });

    localStorage.setItem(SESSION_KEY, 's1');
    stubFetch((url) => {
        if (url === '/api') return json(bootstrap({ sessions: [cancelled] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1') return json({ session: cancelled });
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    // The tile is the report of the stop.
    expect(tileStates()).toEqual(['cancelled']);
    expect(tileStatusText()).toEqual(['cancelled']);
    // The app header stays app-scoped: no "The run was cancelled." and no red dot.
    expect(statusState()).toBe('idle');
    expect(statusText()).toBe('idle');
    // A deliberate stop is not an error, so no failure banner is added.
    expect(noteHidden()).toBe(true);
    expect(noteText()).toBe('');
});

it('opens a saved failed session with its detail in the transcript, not the header', async () => {
    const failed = snapshot({
        id: 's1',
        status: 'error',
        lastError: FAILURE,
        updatedAt: T + 200,
        turns: [turn({ status: 'error', prompt: 'broken task', updatedAt: T + 200 })]
    });

    localStorage.setItem(SESSION_KEY, 's1');
    stubFetch((url) => {
        if (url === '/api') return json(bootstrap({ sessions: [failed] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1') return json({ session: failed });
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    expect(tileStates()).toEqual(['error']);
    expect(tileStatusText()).toEqual(['error']);
    // R3: the error detail is not swallowed — it is scoped to the session.
    expect(statusState()).toBe('idle');
    expect(statusText()).toBe('idle');
    expect(noteHidden()).toBe(false);
    expect(noteText()).toBe(FAILURE);
    expect(note().dataset.tone).toBe('error');
});

it('keeps the header neutral and the failure detail scoped when switching sessions', async () => {
    const failed = snapshot({
        id: 's1',
        status: 'error',
        lastError: FAILURE,
        updatedAt: T + 200,
        turns: [turn({ status: 'error', prompt: 'broken task', updatedAt: T + 200 })]
    });
    const healthy = snapshot({
        id: 's2',
        status: 'idle',
        updatedAt: T + 300,
        turns: [turn({ id: 't2', status: 'done', prompt: 'fine task', updatedAt: T + 300 })]
    });

    localStorage.setItem(SESSION_KEY, 's1');
    stubFetch((url) => {
        if (url === '/api') return json(bootstrap({ sessions: [failed, healthy] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1') return json({ session: failed });
        if (url === '/api/sessions/s2') return json({ session: healthy });
        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    expect(noteText()).toBe(FAILURE);
    expect(statusText()).toBe('idle');

    // Another conversation: its own tiles, its own (empty) note.
    byClass('.session[data-session-id="s2"]', 'button').click();
    await flush();
    await flush();

    expect(tileStates()).toEqual(['done']);
    expect(noteHidden()).toBe(true);
    expect(statusState()).toBe('idle');
    expect(statusText()).toBe('idle');
    expect(localStorage.getItem(SESSION_KEY)).toBe('s2');

    // Back to the failed session: the detail belongs to it and comes back with it,
    // still without touching the header.
    byClass('.session[data-session-id="s1"]', 'button').click();
    await flush();
    await flush();

    expect(tileStates()).toEqual(['error']);
    expect(noteText()).toBe(FAILURE);
    expect(statusState()).toBe('idle');
    expect(statusText()).toBe('idle');
});

it('reports an active task failure on its tile and note, never in the app header', async () => {
    const opening = turn({
        status: 'running',
        prompt: 'say hi',
        startedAt: T,
        updatedAt: T + 100,
        events: [{ type: 'start', agent: 'instruct', model: 'm1' }]
    });
    const failed = snapshot({
        id: 's1',
        status: 'error',
        lastError: FAILURE,
        updatedAt: T + 200,
        turns: [turn({ status: 'error', prompt: 'say hi', updatedAt: T + 200 })]
    });

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
            return sse([
                { type: 'turn', turn: opening },
                { type: 'failed', error: { message: FAILURE }, session: failed }
            ]);
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

    expect(tileStates()).toEqual(['error']);
    expect(tileStatusText()).toEqual(['error']);
    // The failure detail lives with the session, not in the top-right header.
    expect(noteHidden()).toBe(false);
    expect(noteText()).toBe(FAILURE);
    expect(statusState()).toBe('idle');
    expect(statusText()).toBe('idle');
    // A failed submit is not a pending queue: Stop is released.
    expect(byClass('.stop', 'button').disabled).toBe(true);
});

it('keeps a failure local while the rest of the queue keeps running', async () => {
    const failed = turn({
        status: 'error',
        prompt: 'first task',
        updatedAt: T + 100
    });
    const queued = turn({
        id: 't2',
        index: 1,
        status: 'queued',
        prompt: 'second task',
        startedAt: undefined,
        updatedAt: T + 100
    });
    const holding = snapshot({
        id: 's1',
        status: 'error',
        lastError: FAILURE,
        updatedAt: T + 100,
        queueDepth: 1,
        turns: [failed, queued]
    });
    const running = turn({
        ...queued,
        status: 'running',
        startedAt: T + 200,
        updatedAt: T + 200,
        events: [{ type: 'start', agent: 'instruct', model: 'm1' }]
    });
    const final = snapshot({
        id: 's1',
        status: 'idle',
        updatedAt: T + 400,
        turns: [failed, turn({ ...running, status: 'done', updatedAt: T + 400 })]
    });

    localStorage.setItem(SESSION_KEY, 's1');
    let releaseStream: () => void = () => {
        throw new Error('the events stream never opened');
    };

    stubFetch((url) => {
        if (url === '/api') return json(bootstrap({ sessions: [holding] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1') return json({ session: holding });

        if (url === '/api/sessions/s1/events') {
            const stream = splitSse(
                [],
                [
                    { type: 'turn', turn: running },
                    { type: 'snapshot', session: final }
                ]
            );
            releaseStream = stream.release;
            return stream.response;
        }

        return undefined;
    });

    await import('./main');
    await flush();
    await flush();

    // The failed task is visible in the transcript; the queued one is still waiting
    // and the queue is live (Stop enabled).
    expect(tileStates()).toEqual(['error', 'queued']);
    expect(noteText()).toBe(FAILURE);
    expect(statusText()).toBe('idle');
    expect(byClass('.stop', 'button').disabled).toBe(false);

    // The queue advances: the second task runs and finishes. Only the session state
    // moves; the app header never becomes a run display.
    releaseStream();
    await flush();
    await flush();

    expect(tileStates()).toEqual(['error', 'done']);
    expect(statusText()).toBe('idle');
    expect(statusState()).toBe('idle');
    // The drained snapshot is healthy again, and the failed tile still reports
    // `error`, so the session-wide note is cleared instead of going stale.
    expect(noteHidden()).toBe(true);
    expect(byClass('.stop', 'button').disabled).toBe(true);
});

it('still surfaces a bootstrap failure in the app header and the offline pane', async () => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
            throw new Error('connect ECONNREFUSED 127.0.0.1:5181');
        })
    );

    await import('./main');
    await flush();
    await flush();

    // R3: a real app/network failure is NOT swallowed by scoping run errors away.
    expect(statusState()).toBe('error');
    expect(statusText()).toBe('server offline');
    expect(document.querySelector('.empty-title')?.textContent).toBe('Harness server unavailable');
    expect(document.querySelector('.empty-text')?.textContent).toBe(
        'The harness server is unreachable: connect ECONNREFUSED 127.0.0.1:5181'
    );
    // Nothing can be submitted without the catalogue.
    expect(byClass('.run', 'button').disabled).toBe(true);
});

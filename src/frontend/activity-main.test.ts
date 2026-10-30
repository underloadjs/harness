// Activity rings in the live shell.
//
// The ring answers "which agents are working in the turn on screen":
//   - `start` lights a tile; text/reasoning/tool events keep it lit;
//   - `done`/`error` clear only that agent (a delegated sibling keeps spinning);
//   - terminal snapshot, cancel and reset clear every ring;
//   - a reload/poll only derives activity from a turn that is STILL running, so
//     opening a finished conversation never animates old work.
//
// The stream is a controlled ReadableStream so the test can assert between frames
// (a fully-enqueued stream would be consumed before the first assertion).

import type { HarnessDescriptor, HarnessEvent, SessionSnapshot, SessionTurn } from '../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const SESSION_KEY = 'underload-harness-app:session';
const T = 1_700_000_000_000;
const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };

const descriptor = (overrides: Partial<HarnessDescriptor> = {}): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: '',
        requiresEndpoint: true,
        agents: ['instruct', 'helper'],
        tools: [],
        coreTools: ['toolRequest', 'toolCreate', 'todoManage', 'agentDelegate'],
        primary: 'instruct',
        subagents: ['helper'],
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

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
};

const bootstrap = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    rootPath: '/api',
    presets: [descriptor()],
    tools: [],
    defaults,
    sessions: [],
    agents: [],
    ...overrides
});

const byClass = <K extends keyof HTMLElementTagNameMap>(selector: string, tag: K): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);
    return found;
};

// R11 (T5): the agent deck now lives inside the shared agent dialog, so deck reads
// open it from the composer's single agent button (a no-op once open; chrome
// rebuilds refresh the content in place and keep it painted from the live set).
const openDeck = (): void => {
    if (document.querySelector('.dialog') !== null) return;
    byClass('.agent-control-button', 'button').click();
};

// `data-activity` and `aria-busy` per tile, in member order.
const tileActivity = (): (string | undefined)[] => {
    openDeck();
    return [...document.querySelectorAll<HTMLElement>('.agent-tile')].map((tile) => tile.dataset.activity);
};
const tileBusy = (): (string | null)[] => {
    openDeck();
    return [...document.querySelectorAll<HTMLElement>('.agent-tile')].map((tile) => tile.getAttribute('aria-busy'));
};

type Controlled = {
    response: Response;
    push: (items: readonly unknown[]) => void;
    close: () => void;
};

// A stream whose frames are pushed by the test; `push` mirrors the server's SSE
// framing so api.ts parses it exactly like a real response.
const controlled = (): Controlled => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;

    const body = new ReadableStream<Uint8Array>({
        start(streamController) {
            controller = streamController;
        }
    });

    return {
        response: new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
        push: (items) => {
            const text = items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join('');
            controller?.enqueue(new TextEncoder().encode(text));
        },
        close: () => controller?.close()
    };
};

const start = (agent: string): HarnessEvent => ({ type: 'start', agent, model: 'm1' });
const text = (agent: string, delta: string): HarnessEvent => ({ type: 'text', agent, delta });
const toolCall = (agent: string): HarnessEvent => ({
    type: 'tool_call',
    agent,
    call: { id: 'c1', name: 'fileRead', arguments: '{}' }
});
const done = (agent: string): HarnessEvent => ({
    type: 'done',
    agent,
    message: {
        role: 'assistant',
        content: '',
        reasoning: '',
        toolCalls: [],
        model: 'm1',
        stopReason: 'stop'
    }
});
const failed = (agent: string): HarnessEvent => ({ type: 'error', agent, error: { message: 'boom' } });

const turn = (overrides: Partial<SessionTurn> = {}): SessionTurn => ({
    id: 't1',
    index: 0,
    prompt: 'go',
    status: 'running',
    startedAt: T,
    updatedAt: T,
    events: [],
    ...overrides
});

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

it('lights on start, keeps a delegated sibling lit, and clears on done/terminal', async () => {
    const stream = controlled();
    let messageRequests = 0;

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);

            if (url === '/api') return json(bootstrap());
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions' && init?.method === 'POST') return json({ session: snapshot() }, 201);

            if (url === '/api/sessions/s1/tasks' && init?.method === 'POST') {
                messageRequests += 1;
                const opening = turn({ events: [] });
                return json(
                    { session: snapshot({ status: 'running', turns: [opening] }), turn: opening },
                    202
                );
            }

            if (url === '/api/sessions/s1/events') return stream.response;

            throw new Error(`unexpected request: ${url}`);
        })
    );

    await import('./main');
    await flush();

    const opening = turn({ events: [] });
    byClass('.composer-input', 'textarea').value = 'go';
    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();

    stream.push([{ type: 'turn', turn: opening }]);
    await flush();
    expect(tileActivity()).toEqual([undefined, undefined]);

    // start → that agent becomes active; aria-busy is the assistive signal.
    stream.push([{ type: 'event', turnId: 't1', event: start('instruct') }]);
    await flush();
    expect(tileActivity()).toEqual(['active', undefined]);
    expect(tileBusy()).toEqual(['true', null]);

    // The parent's tool call starts a delegation: BOTH are working.
    stream.push([
        { type: 'event', turnId: 't1', event: toolCall('instruct') },
        { type: 'event', turnId: 't1', event: start('helper') }
    ]);
    await flush();
    expect(tileActivity()).toEqual(['active', 'active']);

    // helper finishes: only helper's ring goes away.
    stream.push([{ type: 'event', turnId: 't1', event: done('helper') }]);
    await flush();
    expect(tileActivity()).toEqual(['active', undefined]);
    expect(tileBusy()).toEqual(['true', null]);

    // A content event after an intermediate done reactivates the agent.
    stream.push([
        { type: 'event', turnId: 't1', event: done('instruct') },
        { type: 'event', turnId: 't1', event: text('instruct', 'still here') }
    ]);
    await flush();
    expect(tileActivity()).toEqual(['active', undefined]);

    // An error for one agent removes only that agent.
    stream.push([{ type: 'event', turnId: 't1', event: failed('instruct') }]);
    await flush();
    expect(tileActivity()).toEqual([undefined, undefined]);

    // Terminal snapshot: everything settles and no ring may survive.
    stream.push([
        {
            type: 'snapshot',
            session: snapshot({
                turns: [
                    turn({
                        status: 'error',
                        events: [start('instruct'), start('helper'), done('helper'), text('instruct')]
                    })
                ]
            })
        }
    ]);
    stream.close();
    await flush();
    await flush();

    expect(messageRequests).toBe(1);
    expect(tileActivity()).toEqual([undefined, undefined]);
    expect(document.querySelector('.tile')?.getAttribute('data-state')).toBe('error');
});

it('clears every ring as soon as Stop is pressed', async () => {
    const stream = controlled();

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);

            if (url === '/api') return json(bootstrap());
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions' && init?.method === 'POST') return json({ session: snapshot() }, 201);
            if (url === '/api/sessions/s1/tasks' && init?.method === 'POST') {
                const opening = turn({ events: [] });
                return json(
                    { session: snapshot({ status: 'running', turns: [opening] }), turn: opening },
                    202
                );
            }
            if (url === '/api/sessions/s1/events') return stream.response;
            if (url === '/api/sessions/s1/cancel' && init?.method === 'POST') {
                return json({ cancelled: true });
            }
            if (url === '/api/sessions/s1') {
                return json({ session: snapshot({ turns: [turn({ status: 'cancelled' })] }) });
            }
            if (url === '/api/sessions' && init?.method === undefined) return json({ sessions: [] });

            throw new Error(`unexpected request: ${url}`);
        })
    );

    await import('./main');
    await flush();

    byClass('.composer-input', 'textarea').value = 'go';
    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();

    stream.push([
        { type: 'turn', turn: turn({ events: [] }) },
        { type: 'event', turnId: 't1', event: start('instruct') },
        { type: 'event', turnId: 't1', event: start('helper') }
    ]);
    await flush();
    expect(tileActivity()).toEqual(['active', 'active']);

    // R10: the running session exposes the stop action as the composer's only button.
    const composerAction = byClass('.composer-action', 'button');
    expect(composerAction.dataset.action).toBe('stop');
    composerAction.click();
    await flush();
    expect(tileActivity()).toEqual([undefined, undefined]);

    // Releasing the stream lets the run finish; the rings stay off.
    stream.push([{ type: 'snapshot', session: snapshot({ turns: [turn({ status: 'cancelled' })] }) }]);
    stream.close();
    await flush();
    await flush();
    expect(tileActivity()).toEqual([undefined, undefined]);
});

it('derives rings from a still-running polled turn and never from completed history', async () => {
    vi.useFakeTimers();

    // An older, finished turn that ended with the parent active-looking; it must
    // not light anything. The running turn has helper working.
    const older = turn({
        id: 't0',
        index: 0,
        prompt: 'old',
        status: 'done',
        events: [start('instruct'), text('instruct', 'finished')]
    });
    const running = turn({
        id: 't1',
        index: 1,
        prompt: 'long task',
        status: 'running',
        events: [start('helper'), toolCall('helper')]
    });
    const live = snapshot({ id: 'r1', status: 'running', turns: [older, running] });
    const finished = snapshot({
        id: 'r1',
        status: 'idle',
        turns: [
            older,
            turn({ ...running, status: 'done', events: [...running.events, done('helper')] })
        ]
    });

    localStorage.setItem(SESSION_KEY, 'r1');

    let gets = 0;
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);

            if (url === '/api') return json(bootstrap({ sessions: [live] }));
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions/r1') {
                gets += 1;
                return json({ session: gets < 3 ? live : finished });
            }

            throw new Error(`unexpected request: ${url}`);
        })
    );

    await import('./main');
    await vi.advanceTimersByTimeAsync(50);

    // Only the running turn's agent is busy; the settled history contributes
    // nothing, so opening a running session never replays old activity.
    expect(gets).toBe(1);
    expect(tileActivity()).toEqual([undefined, 'active']);
    expect(tileBusy()).toEqual([null, 'true']);

    // Still running after the first poll: the derived set is unchanged.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(gets).toBe(2);
    expect(tileActivity()).toEqual([undefined, 'active']);

    // Terminal snapshot: every ring is gone.
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(gets).toBe(3);
    expect(tileActivity()).toEqual([undefined, undefined]);
    expect(tileBusy()).toEqual([null, null]);
});

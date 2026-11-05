// Activity rings in the live shell.
//
// The ring answers "which agents are working in the turn on screen":
//   - `start` lights a tile; text/reasoning/tool events keep it lit;
//   - `done`/`error` clear only that agent (a delegated sibling keeps spinning);
//   - terminal snapshot, cancel and reset clear every ring;
//   - a reload/poll only derives activity from a turn that is STILL running, so
//     opening a finished conversation never animates old work.
//
// The stream is the canonical `harness.v1` WebSocket double, which the test drives the same way
// it used to drive a controlled ReadableStream: push frames, assert between pushes. The double
// folds each RAW frame through the server's own projector (`toViewItem`) and delivers the
// `turn.upsert`/`display.ops`/`session.updated` frames the real stream would send.

import type { HarnessDescriptor, HarnessEvent, SessionSnapshot, SessionTurn } from '../server/protocol';
import { bumpFixtureEpoch, viewAwareFetch } from './view-test-support';
import type { HarnessStreamOptions, StreamDouble } from './view-test-support';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// T42: both halves of the socket lifecycle resolve through a DYNAMIC import. `vi.resetModules()`
// clears the module registry, so a statically imported `installHarnessStream` configures the
// PREVIOUS graph's singleton while the `main.ts` imported after the reset dials a fresh `./stream`
// with no factory — indistinguishable from "the shell never observed anything". The release goes
// through the same instance for the same reason (the rule `canonical-directory-live-main.test.ts:34-52`
// states). The TYPES stay static: erased at compile time, they cannot pin an instance.
const installLiveStream = (options: HarnessStreamOptions): Promise<StreamDouble> =>
    import('./view-test-support').then((support) => support.installHarnessStream(options));

const releaseLiveStream = async (): Promise<void> => {
    const { resetHarnessStream } = await import('./stream');

    resetHarnessStream();
};

// A frame is addressed to a SUBSCRIPTION, and the client writes its `subscribe` frame only after
// the double's `welcome` is answered, so a live case pushes once the subscription it wants to
// address exists — the real server's order of events. Bounded, so a shell that never observes
// fails with a named reason instead of hanging.
const subscribed = async (stream: StreamDouble, scope: string, sessionId?: string): Promise<StreamDouble> => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const registered = stream.subscriptions.some(
            (sub) => sub.scope === scope && (sessionId === undefined || sub.session_id === sessionId)
        );
        if (registered) return stream;

        await flush();
    }

    throw new Error(`the shell never opened a ${scope} subscription`);
};

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
        coreTools: ['toolRequest', 'toolCreate', 'task', 'delegate'],
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

// T3: the agent dialog lists the team as plain rows (`.agent-dialog-agent`), which is
// where the live ring paints now that the overlapping card deck is not part of the
// modal. Opening the dialog is still required: it is the only host of these rows, and
// a chrome rebuild keeps them painted from the live set.
const openDeck = (): void => {
    if (document.querySelector('.dialog') !== null) return;
    byClass('.agent-control-button', 'button').click();
};

// `data-activity` and `aria-busy` per team row, in member order.
const tileActivity = (): (string | undefined)[] => {
    openDeck();
    return [...document.querySelectorAll<HTMLElement>('.agent-dialog-agent')].map(
        (row) => row.dataset.activity
    );
};
const tileBusy = (): (string | null)[] => {
    openDeck();
    return [...document.querySelectorAll<HTMLElement>('.agent-dialog-agent')].map((row) =>
        row.getAttribute('aria-busy')
    );
};

const start = (agent: string): HarnessEvent => ({ type: 'start', agent, model: 'm1' });
const text = (agent: string, delta: string): HarnessEvent => ({ type: 'text', agent, delta });
const toolCall = (agent: string): HarnessEvent => ({
    type: 'tool_call',
    agent,
    call: { id: 'c1', name: 'read', arguments: '{}' }
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

afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    // The socket singleton is process-wide; leaving it alive leaks this test's double (and its
    // reconnect timers) into the next one. The import is dynamic so the release reaches the same
    // instance the shell used (see `installLiveStream` above).
    await releaseLiveStream();
});

it('lights on start, keeps a delegated sibling lit, and clears on done/terminal', async () => {
    const opening = turn({ events: [] });
    // The record the server holds while the run is in flight. It seeds the live fold (the entry
    // agent, the label seeds) and it is what the canonical reads are composed from, so both the
    // socket frames and the reads describe the same document — moved forward by `settle` when the
    // terminal frame is pushed.
    let host: SessionSnapshot = snapshot({ harnessDefinition: descriptor(), status: 'running', turns: [opening] });
    const settled: SessionSnapshot = snapshot({
        harnessDefinition: descriptor(),
        turns: [
            turn({
                status: 'error',
                events: [start('instruct'), start('helper'), done('helper'), text('instruct')]
            })
        ]
    });
    const settle = (): void => {
        host = settled;
    };

    const stream = await installLiveStream({ sessionId: 's1', snapshot: () => host });
    let messageRequests = 0;

    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);

            if (url === '/api') return json(bootstrap());
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions' && init?.method === 'POST') return json({ session: snapshot() }, 201);

            if (url === '/api/sessions/s1/tasks' && init?.method === 'POST') {
                messageRequests += 1;

                return json({ session: host, turn: opening }, 202);
            }

            // The one record the canonical surface is composed from. There is no SSE route any
            // more: the live plane is the `harness.v1` socket the double drives.
            if (url === '/api/sessions/s1') return json({ session: host });
            if (url === '/api/sessions' && init?.method === undefined) return json({ sessions: [] });

            throw new Error(`unexpected request: ${url}`);
        }, { root: '/api' }))
    );

    await import('./main');
    await flush();

    byClass('.composer-input', 'textarea').value = 'go';
    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    // The pending run opens the observer; the frames below are addressed to that subscription.
    await subscribed(stream, 'session', 's1');

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

    // Terminal snapshot: everything settles and no ring may survive. The stub's record moves
    // with the frame, so the resync that follows the closed stream reads the settled document.
    settle();
    stream.push([{ type: 'snapshot', session: settled }]);
    stream.close();
    await flush();
    await flush();

    expect(messageRequests).toBe(1);
    expect(tileActivity()).toEqual([undefined, undefined]);
    expect(document.querySelector('.tile')?.getAttribute('data-state')).toBe('error');
});

it('clears every ring as soon as Stop is pressed', async () => {
    const opening = turn({ events: [] });
    let host: SessionSnapshot = snapshot({ harnessDefinition: descriptor(), status: 'running', turns: [opening] });
    const cancelled: SessionSnapshot = snapshot({
        harnessDefinition: descriptor(),
        turns: [turn({ status: 'cancelled' })]
    });

    const stream = await installLiveStream({ sessionId: 's1', snapshot: () => host });

    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);

            if (url === '/api') return json(bootstrap());
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions' && init?.method === 'POST') return json({ session: snapshot() }, 201);
            if (url === '/api/sessions/s1/tasks' && init?.method === 'POST') {
                return json({ session: host, turn: opening }, 202);
            }
            if (url === '/api/sessions/s1/cancel' && init?.method === 'POST') {
                return json({ cancelled: true });
            }
            // The record the canonical reads compose from: running until Stop lands, cancelled
            // after it, which is exactly the state the server would hold at each answer.
            if (url === '/api/sessions/s1') {
                return json({ session: host });
            }
            if (url === '/api/sessions' && init?.method === undefined) return json({ sessions: [] });

            throw new Error(`unexpected request: ${url}`);
        }, { root: '/api' }))
    );

    await import('./main');
    await flush();

    byClass('.composer-input', 'textarea').value = 'go';
    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    await subscribed(stream, 'session', 's1');

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

    // Releasing the stream lets the run finish; the rings stay off. The held record settles with
    // the frame, so the post-stream resync reads the cancelled conversation.
    host = cancelled;
    stream.push([{ type: 'snapshot', session: cancelled }]);
    stream.close();
    await flush();
    await flush();
    expect(tileActivity()).toEqual([undefined, undefined]);
});

it('derives rings from a still-running polled turn and never from completed history', async () => {
    // T50: the degraded host this case is named for. `pollSession` is the observation for a run
    // the socket CANNOT carry (main.ts:8885), and stream.ts resolves the transport when the client
    // is created (stream.ts:193-199). Installing a double here would give the shell a HEALTHY
    // connection, and polling next to a healthy socket is the pattern the R5 performance rule
    // forbids — the count stayed flat because the shell was right not to poll. No constructor at
    // all is the honest statement of "no sockets on this host": ./view-shell.ts:485-490 settles
    // the observation immediately and the bounded re-read takes over. `afterEach` un-stubs it.
    vi.stubGlobal('WebSocket', undefined);
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

    // T42: the honest "how many conversations did the shell follow" counter. The raw
    // `GET {root}/sessions/:id` route is re-read by the shared double several times per canonical
    // conversation read (metadata, row page, roster, definition, usage, queue), so counting it
    // says nothing about polling. `reads` counts the canonical conversation read itself — the
    // metadata URL the browser sent, recorded OUTSIDE the adapter — which is one per open and one
    // per poll, exactly what `gets` used to be.
    const reads: string[] = [];
    let served = 0;

    const answer = viewAwareFetch(async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url === '/api') return json(bootstrap({ sessions: [live] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/r1') {
            served += 1;

            // The first two conversation reads describe the run still in flight; the third is the
            // terminal document, which is what stops the polling.
            return json({ session: served < 3 ? live : finished });
        }

        throw new Error(`unexpected request: ${url}`);
    }, { root: '/api' });

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (init?.method === undefined && url.split('?')[0] === '/v1/harness/sessions/r1') {
                reads.push('r1');
            }

            const response = answer(input, init);

            return response instanceof Promise ? await response : response;
        })
    );

    // The host has no sockets (stubbed at the top of this case), so the bounded re-read is the
    // observation from the first paint on.
    await import('./main');
    await vi.advanceTimersByTimeAsync(50);

    // Only the running turn's agent is busy; the settled history contributes
    // nothing, so opening a running session never replays old activity.
    expect(reads).toEqual(['r1']);
    expect(tileActivity()).toEqual([undefined, 'active']);
    expect(tileBusy()).toEqual([null, 'true']);

    // Still running after the first poll: the derived set is unchanged. The bump is the
    // fixture's statement that the record moved on (a poll re-reads the server's document; the
    // shared composition memo may not answer it with the document the open already read).
    bumpFixtureEpoch();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reads).toEqual(['r1', 'r1']);
    expect(tileActivity()).toEqual([undefined, 'active']);

    // Terminal snapshot: every ring is gone.
    bumpFixtureEpoch();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toEqual(['r1', 'r1', 'r1']);
    expect(tileActivity()).toEqual([undefined, undefined]);
    expect(tileBusy()).toEqual([null, null]);
});

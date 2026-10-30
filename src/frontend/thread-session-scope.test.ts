// Cross-session tombstones (N1), stale snapshots (N2) and failed-submit reference
// restore (N3) in the live shell.
//
// These are the three defects found by the second independent review:
//   N1  a session switch compared the NEW roster with the PREVIOUS session's records,
//       tombstoning an id the new session will mint later (`thread-2`);
//   N2  a stale snapshot (late 202/GET) replaced the authoritative records and
//       reconciled the older turn list, deleting a live SSE row;
//   N3  a failed submit restored the DOM snapshot captured before a deletion,
//       reinstating a `#` chip whose target no longer exists.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts thread-session-scope.test.ts

import type { HarnessDescriptor, SessionSnapshot, SessionTurn } from '../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const T = 1_700_000_000_000;
const SESSION_KEY = 'underload-harness-app:session';
const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };

const descriptor = (): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: '',
        requiresEndpoint: true,
        agents: ['instruct'],
        tools: [],
        coreTools: [],
        primary: 'instruct',
        subagents: [],
        builtin: true,
        editable: true
    }) as HarnessDescriptor;

type ThreadFixture = {
    id: string;
    agent: string;
    origin: 'host';
    status: 'idle' | 'running' | 'stopped';
    sequence: number;
    label?: string;
    ownerThreadId?: string;
};

const turn = (overrides: Partial<SessionTurn> & { threadId?: string } = {}): SessionTurn =>
    ({
        id: 'turn-1',
        index: 0,
        prompt: 'go',
        status: 'done',
        startedAt: T,
        updatedAt: T,
        events: [],
        ...overrides
    }) as unknown as SessionTurn;

const snapshot = (
    options: {
        id: string;
        status?: SessionSnapshot['status'];
        turns?: SessionTurn[];
        threads?: ThreadFixture[];
        updatedAt?: number;
    }
): SessionSnapshot =>
    ({
        id: options.id,
        harness: 'instruct',
        status: options.status ?? 'idle',
        model: 'm1',
        createdAt: 1,
        updatedAt: options.updatedAt ?? 2,
        messages: [],
        turns: options.turns ?? [],
        ...(options.threads === undefined ? {} : { threads: options.threads })
    }) as unknown as SessionSnapshot;

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (count = 2): Promise<void> => {
    for (let index = 0; index < count; index += 1) await new Promise((resolve) => setTimeout(resolve, 30));
};

const byClass = <K extends keyof HTMLElementTagNameMap>(selector: string, tag: K): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);
    return found;
};

// Visible conversation cards in board order, keyed by the persistent thread each one
// groups (ui/turns.ts `conversationHost` writes `data-thread-id` on the `.conversation`
// section). This replaces the removed `.thread-strip-row` list: one entry per
// persistent thread the session really has, so a tombstoned id shows up as a MISSING
// entry and a resurrected one as an extra entry.
const conversations = (): Array<string | undefined> =>
    [...document.querySelectorAll<HTMLElement>('.conversation')].map((node) => node.dataset.threadId);
const tiles = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.tile')];
const target = (): string => byClass('.composer-target', 'p').textContent ?? '';
// The routing line can be textually present but `hidden` (main.ts `paintComposerTarget`:
// a `new` target in a session with no threads hides the label). Both facts matter for
// N3, so the assertions read them separately.
const targetHidden = (): boolean => byClass('.composer-target', 'p').hidden;

type Stub = {
    sessions: Map<string, SessionSnapshot>;
    tasks: Array<{ sessionId: string; body: Record<string, unknown> }>;
    emit: (sessionId: string, item: unknown) => void;
    holdTasks: boolean;
    release: () => void;
    failTasks?: string;
};

const stubServer = (sessions: SessionSnapshot[], options: { holdTasks?: boolean } = {}): Stub => {
    const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
    const stub: Stub = {
        sessions: new Map(sessions.map((session) => [session.id, session])),
        tasks: [],
        emit: (sessionId, item) => {
            streams.get(sessionId)?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(item)}\n\n`));
        },
        holdTasks: options.holdTasks === true,
        release: () => undefined
    };
    if (stub.holdTasks) {
        const gate = new Promise<void>((resolve) => {
            stub.release = resolve;
        });
        (stub as Stub & { gate?: Promise<void> }).gate = gate;
    }

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method ?? 'GET';

            if (url === '/api') {
                return json({
                    rootPath: '/api',
                    presets: [descriptor()],
                    tools: [],
                    defaults,
                    sessions: [...stub.sessions.values()],
                    agents: []
                });
            }
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions' && method === 'GET') {
                return json({ sessions: [...stub.sessions.values()] });
            }

            const events = /^\/api\/sessions\/([^/]+)\/events$/.exec(url);
            if (events !== null) {
                const id = decodeURIComponent(events[1]);
                return new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            streams.set(id, controller);
                        }
                    }),
                    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
                );
            }

            const task = /^\/api\/sessions\/([^/]+)\/tasks$/.exec(url);
            if (task !== null && method === 'POST') {
                const id = decodeURIComponent(task[1]);
                const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
                stub.tasks.push({ sessionId: id, body });
                if (stub.holdTasks) await (stub as Stub & { gate?: Promise<void> }).gate;

                if (stub.failTasks !== undefined) return json({ error: { message: stub.failTasks } }, 404);

                const current = stub.sessions.get(id) as SessionSnapshot;
                const opening = turn({
                    id: `turn-new-${stub.tasks.length}`,
                    index: current.turns.length,
                    prompt: String(body.input ?? ''),
                    status: 'running',
                    threadId: 'thread-1'
                });
                const answer = {
                    ...current,
                    status: 'running',
                    updatedAt: (current.updatedAt ?? 0) + 1,
                    turns: [...current.turns, opening]
                } as SessionSnapshot;
                stub.sessions.set(id, answer);
                return json({ session: answer, turn: opening }, 202);
            }

            const one = /^\/api\/sessions\/([^/]+)$/.exec(url);
            if (one !== null && method === 'GET') {
                const id = decodeURIComponent(one[1]);
                const current = stub.sessions.get(id);
                if (current === undefined) return json({ error: { message: `Unknown session "${id}".` } }, 404);
                return json({ session: current });
            }

            throw new Error(`unexpected request: ${method} ${url}`);
        })
    );

    return stub;
};

const mount = async (): Promise<void> => {
    await import('./main');
    await flush(3);
};

const submit = async (text: string): Promise<void> => {
    const input = byClass('.composer-input', 'div');
    input.textContent = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.unstubAllGlobals();
});

it('does not poison the next session with the previous session thread ids (N1)', async () => {
    localStorage.setItem(SESSION_KEY, 's1');
    const stub = stubServer([
        snapshot({
            id: 's1',
            turns: [
                turn({ id: 'turn-1', threadId: 'thread-1' }),
                turn({ id: 'turn-2', index: 1, threadId: 'thread-2' })
            ],
            threads: [
                { id: 'thread-1', agent: 'instruct', origin: 'host', status: 'idle', sequence: 1 },
                { id: 'thread-2', agent: 'instruct', origin: 'host', status: 'idle', sequence: 2 }
            ]
        }),
        // The next session used FEWER threads; its own counter will mint `thread-2`.
        snapshot({
            id: 's2',
            status: 'running',
            updatedAt: 5,
            turns: [turn({ id: 'turn-9', threadId: 'thread-1', status: 'running' })],
            threads: [{ id: 'thread-1', agent: 'instruct', origin: 'host', status: 'running', sequence: 1 }]
        })
    ]);
    await mount();

    // s1 rendered both of its conversations before the switch.
    expect(conversations()).toEqual(['thread-1', 'thread-2']);
    expect(tiles().map((tile) => tile.dataset.turnId)).toEqual(['turn-1', 'turn-2']);

    document.querySelector<HTMLButtonElement>('.session[data-session-id="s2"]')?.click();
    await flush(3);

    // Only s2's own conversation is on screen: the previous session's tiles and
    // cards are gone, so nothing of s1 can be the baseline for deletion learning.
    expect(conversations()).toEqual(['thread-1']);
    expect(tiles().map((tile) => tile.dataset.turnId)).toEqual(['turn-9']);
    expect(tiles().map((tile) => tile.dataset.threadId)).toEqual(['thread-1']);

    // Focus s2's conversation the way a reader does (clicking the tile header, i.e.
    // ui/turns.ts `expand`). This is the explicit focus the deleted strip used to
    // offer, and it is what the composer's routing line reports.
    byClass('.tile[data-turn-id="turn-9"] .tile-select', 'button').click();
    await flush(1);
    expect(document.querySelector('.tile.is-expanded')?.getAttribute('data-turn-id')).toBe('turn-9');
    expect(target()).toBe('Steering IT1');

    // s2 mints its own `thread-2`: the id used to be tombstoned by the switch, so
    // the roster row and the turn were dropped on arrival and only `thread-1`
    // survived. The transcript must now show BOTH conversations, in recorded order.
    stub.emit('s2', {
        type: 'snapshot',
        session: snapshot({
            id: 's2',
            status: 'running',
            updatedAt: 6,
            turns: [
                turn({ id: 'turn-9', threadId: 'thread-1', status: 'running' }),
                turn({ id: 'turn-10', index: 1, threadId: 'thread-2', status: 'running' })
            ],
            threads: [
                { id: 'thread-1', agent: 'instruct', origin: 'host', status: 'running', sequence: 1 },
                { id: 'thread-2', agent: 'instruct', origin: 'host', status: 'running', sequence: 2 }
            ]
        })
    });
    await flush(3);

    expect(conversations()).toEqual(['thread-1', 'thread-2']);
    expect(tiles().map((tile) => tile.dataset.threadId)).toEqual(['thread-1', 'thread-2']);
    // The adopted turn is a REAL tile, not just a roster row: `thread-2` is alive.
    expect(tiles().map((tile) => tile.dataset.turnId)).toEqual(['turn-9', 'turn-10']);
    // The background adoption of `thread-2` must not steal the reader's focus (S1).
    expect(document.querySelector('.tile.is-expanded')?.getAttribute('data-turn-id')).toBe('turn-9');
    expect(target()).toBe('Steering IT1');
});

it('keeps a live turn that an older snapshot no longer lists (N2)', async () => {
    localStorage.setItem(SESSION_KEY, 's2');
    const stub = stubServer([
        snapshot({
            id: 's2',
            status: 'running',
            updatedAt: 10,
            turns: [turn({ id: 'turn-1', threadId: 'thread-1', status: 'running' })],
            threads: [{ id: 'thread-1', agent: 'instruct', origin: 'host', status: 'running', sequence: 1 }]
        })
    ]);
    await mount();
    expect(target()).toBe('Steering IT1');

    // A NEWER turn of another conversation arrives live.
    stub.emit('s2', {
        type: 'turn',
        turn: turn({ id: 'turn-2', index: 1, threadId: 'thread-2', status: 'running' })
    });
    await flush(2);
    expect(tiles().map((tile) => tile.dataset.turnId)).toEqual(['turn-1', 'turn-2']);

    // A LATE 202/GET captured before turn-2 existed (older `updatedAt` => stale).
    stub.emit('s2', {
        type: 'snapshot',
        session: snapshot({
            id: 's2',
            status: 'running',
            updatedAt: 5,
            turns: [turn({ id: 'turn-1', threadId: 'thread-1', status: 'running' })],
            threads: [{ id: 'thread-1', agent: 'instruct', origin: 'host', status: 'running', sequence: 1 }]
        })
    });
    await flush(3);

    // The stale answer is ignored entirely: both rows survive, still running, and
    // the reader's focus (turn-1 / thread-1) is untouched.
    expect(tiles().map((tile) => tile.dataset.turnId)).toEqual(['turn-1', 'turn-2']);
    expect(tiles().map((tile) => tile.dataset.state)).toEqual(['streaming', 'streaming']);
    expect(document.querySelector('.tile.is-expanded')?.getAttribute('data-turn-id')).toBe('turn-1');
    expect(target()).toBe('Steering IT1');
});

it('does not restore a # chip whose target was deleted while the submit was in flight (N3)', async () => {
    localStorage.setItem(SESSION_KEY, 's2');
    const stub = stubServer(
        [
            // `status: 'running'` keeps the session pending with NO running turn, which
            // is what opens the observer stream (openSession -> startWatching). Without
            // it the client could not learn about another writer's deletion at all now
            // that no in-app thread delete exists.
            snapshot({
                id: 's2',
                status: 'running',
                turns: [turn({ id: 'turn-1', threadId: 'thread-1' })],
                threads: [{ id: 'thread-1', agent: 'instruct', origin: 'host', status: 'idle', sequence: 1 }]
            })
        ],
        { holdTasks: true }
    );
    await mount();
    expect(target()).toBe('Continuing IT1');

    // A real reference chip binding turn-1, plus surviving text after it.
    const input = byClass('.composer-input', 'div');
    input.innerHTML =
        '<span data-chip="reference" data-chip-id="ref-1" data-chip-label="#IN1" data-reference-turn="turn-1" data-reference-label="IN1" contenteditable="false">#IN1</span> follow up';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush(2);
    expect(stub.tasks).toEqual([
        {
            sessionId: 's2',
            body: {
                input: '#IN1 follow up',
                references: [{ turnId: 'turn-1', label: 'IN1' }],
                threadId: 'thread-1'
            }
        }
    ]);

    // The referenced conversation is deleted SERVER-SIDE (another tab / the API)
    // while the POST is held open: the client only sees an authoritative snapshot
    // whose `turns`/`threads` no longer contain thread-1. Its `updatedAt` is NEWER,
    // so it passes the watermark and is the snapshot that LEARNS the deletion (and
    // tombstones the thread, so no later frame can resurrect it).
    stub.emit('s2', {
        type: 'snapshot',
        session: snapshot({ id: 's2', status: 'running', updatedAt: 3, turns: [], threads: [] })
    });
    await flush(3);

    // The deleted conversation's TURN tile is gone. (The in-flight optimistic row
    // has no server id yet, so it is not a turn tile; the routing label is asserted
    // below, after the rejected submit settles.)
    expect([...document.querySelectorAll<HTMLElement>('.tile[data-turn-id="turn-1"]')]).toEqual([]);
    // Only the optimistic row is left: unbound (the server never assigned an id),
    // attributed to the deleted `thread-1`, and still `queued` while the POST is held.
    expect(tiles().map((tile) => [tile.dataset.turnId, tile.dataset.threadId, tile.dataset.state])).toEqual([
        [undefined, 'thread-1', 'queued']
    ]);
    // Its conversation shell survives the deletion (the optimistic row is still
    // projected into thread-1's group); no other `.conversation` does.
    expect(conversations()).toEqual(['thread-1']);
    // The LEARNED deletion drops the focus (main.ts `applySnapshot`, immediately after
    // `reconcile`): the board re-focuses `thread-1` because that pending optimistic row
    // names it, and the shell then clears that focus because the roster diff
    // TOMBSTONED the id. With no focus, `resolveSubmitTarget` reports `{ mode: 'new' }`,
    // so the routing text is the literal `New thread`. `paintComposerTarget` also
    // hides the line here: a `new` target in a session whose roster is now empty is
    // exactly the "nothing to distinguish from" case (`hidden` + `data-target=false`).
    expect(target()).toBe('New thread');
    expect(targetHidden()).toBe(true);
    expect(byClass('.composer-target', 'p').dataset.mode).toBe('new');
    // The held POST is untouched by the deletion snapshot: still one request.
    expect(stub.tasks).toEqual([
        {
            sessionId: 's2',
            body: {
                input: '#IN1 follow up',
                references: [{ turnId: 'turn-1', label: 'IN1' }],
                threadId: 'thread-1'
            }
        }
    ]);

    // The server then rejects the submit: its target no longer exists.
    stub.failTasks = 'Unknown thread "thread-1".';
    stub.release();
    await flush(4);

    // The draft is restored for a retry, but WITHOUT the now-dead binding: the
    // surviving text stays, and a retry sends no reference.
    expect(input.querySelectorAll('[data-chip="reference"]')).toHaveLength(0);
    expect(input.textContent?.trim()).toBe('follow up');

    // The rejection does not resurrect the focus either: its optimistic row is marked
    // `error` rather than re-focused, so the routing line still reads `New thread` and
    // the line stays hidden (empty roster + `new` mode).
    expect(target()).toBe('New thread');
    expect(targetHidden()).toBe(true);

    // Exactly one tile survives: the revoked submit's optimistic row. It is still
    // unbound (`data-turn-id` absent — the server never assigned an id), still
    // attributed to `thread-1` in `data-thread-id`, and now terminal `error`.
    expect(tiles().map((tile) => [tile.dataset.turnId, tile.dataset.threadId, tile.dataset.state])).toEqual([
        [undefined, 'thread-1', 'error']
    ]);
    // ...and its conversation shell stays too, because the error row is still projected
    // into thread-1's group. No other `.conversation` survives the deletion snapshot.
    expect(conversations()).toEqual(['thread-1']);
    // The failure adds no request: the rejected POST is still the only one.
    expect(stub.tasks).toEqual([
        {
            sessionId: 's2',
            body: {
                input: '#IN1 follow up',
                references: [{ turnId: 'turn-1', label: 'IN1' }],
                threadId: 'thread-1'
            }
        }
    ]);

    await submit('follow up');
    await flush(2);
    // The retry carries NO `references` (the dead chip was purged) AND NO `threadId`:
    // the clear above left `focusedThread()` undefined, so `resolveSubmitTarget` returns
    // `{ mode: 'new' }` and `run()` omits the id — the server mints a fresh thread
    // instead of 404ing on the deleted one. Assert both requests in full, in order.
    expect(stub.tasks).toEqual([
        {
            sessionId: 's2',
            body: {
                input: '#IN1 follow up',
                references: [{ turnId: 'turn-1', label: 'IN1' }],
                threadId: 'thread-1'
            }
        },
        {
            sessionId: 's2',
            body: { input: 'follow up' }
        }
    ]);
});

// Thread routing in the live shell (R5/R6/R7).
//
// The pure decisions are pinned in ui/threads.test.ts and ui/thread-focus.test.ts.
// This file proves the WIRING: what the composer actually sends, and which
// conversation the reader's focus routes it to.
//
// The compact `.thread-strip` band is GONE (main.ts createView comment), and with
// it the per-thread stop/delete controls it hosted: focus is expressed by the
// transcript itself. Clicking a tile header (`.tile-select`) expands/focuses its
// conversation; clicking the ALREADY-expanded tile collapses it (`ui/turns.ts`
// `collapse`, which sets `explicitUnfocus`), and the composer's notched
// `.composer-target` line states the resulting target ("Continuing X" / "Steering
// X" / "Queued in X" / "New thread").
//
//   - a focused thread's id travels as `SubmitTaskRequest.threadId`;
//   - with no focus the body omits it (the wire's "new thread" signal);
//   - a deletion is learned from an authoritative snapshot whose roster/turns no
//     longer contain the thread (another tab or the API deleted it); the deletion
//     tombstones make that final against late snapshots, `turn` upserts and
//     `event` frames, so nothing resurrects the thread or re-focuses it (S3);
//   - the separate stop-all control cancels the WHOLE session even with text typed,
//     without submitting that text (per-thread stop is no longer a UI feature).
//
// Run: npx vitest run --config src/frontend/vitest.config.ts thread-routing.test.ts

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
        coreTools: ['toolRequest', 'toolCreate', 'todoManage', 'agentDelegate'],
        primary: 'instruct',
        subagents: [],
        builtin: true,
        editable: true
    }) as HarnessDescriptor;

// `threads` is additive on the snapshot (another writer owns the shared type), so
// every fixture supplies it structurally.
type ThreadFixture = {
    id: string;
    agent: string;
    origin: 'host';
    status: 'idle' | 'running' | 'stopped';
    sequence: number;
    label?: string;
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
        status?: SessionSnapshot['status'];
        turns?: SessionTurn[];
        threads?: ThreadFixture[];
        id?: string;
        updatedAt?: number;
    } = {}
): SessionSnapshot =>
    ({
        id: options.id ?? 's1',
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

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
};

const byClass = <K extends keyof HTMLElementTagNameMap>(selector: string, tag: K): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);
    return found;
};

type Stub = {
    tasks: Array<Record<string, unknown>>;
    cancels: unknown[];
    // The snapshot every GET /sessions/s1 answers after a mutation.
    current: SessionSnapshot;
    // Push one frame into the OPEN observer stream (late snapshot/turn/event).
    emit: (item: unknown) => void;
};

const stubServer = (initial: SessionSnapshot, options: { steer?: boolean } = {}): Stub => {
    const stub: Stub = {
        tasks: [],
        cancels: [],
        current: initial,
        emit: () => undefined
    };
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    stub.emit = (item) => {
        stream?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(item)}\n\n`));
    };

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
                    sessions: [stub.current],
                    agents: []
                });
            }
            if (url === '/api/models') return json({ models: ['m1'] });

            if (url === '/api/sessions/s1/tasks' && method === 'POST') {
                stub.tasks.push(JSON.parse(String(init?.body)) as Record<string, unknown>);

                // Steering a RUNNING thread answers with the OWNING turn (same id)
                // instead of creating a new one: the client must not keep a second
                // row for a turn it already renders.
                if (options.steer === true) {
                    const owner = stub.current.turns[0];
                    return json(
                        { session: snapshot({ status: 'running', turns: stub.current.turns }), turn: owner },
                        202
                    );
                }

                const opening = turn({
                    id: `turn-${stub.tasks.length + 10}`,
                    index: stub.tasks.length + 10,
                    prompt: 'go',
                    status: 'running',
                    threadId: 'thread-1'
                });
                return json(
                    {
                        session: snapshot({ status: 'running', turns: [...stub.current.turns, opening] }),
                        turn: opening
                    },
                    202
                );
            }

            if (url === '/api/sessions/s1/events') {
                return new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            // The test drives transitions through POSTs and `stub.emit`.
                            stream = controller;
                        }
                    }),
                    { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
                );
            }

            if (url === '/api/sessions/s1/cancel' && method === 'POST') {
                stub.cancels.push(init?.body === undefined ? undefined : JSON.parse(String(init.body)));
                stub.current = snapshot({
                    turns: stub.current.turns,
                    threads: threadsOf(stub.current),
                    updatedAt: (stub.current.updatedAt ?? 0) + 1
                });
                return json({ cancelled: true });
            }

            if (url === '/api/sessions/s1') {
                return json({ session: stub.current });
            }

            if (url === '/api/sessions') {
                return json({ sessions: [stub.current] });
            }

            throw new Error(`unexpected request: ${method} ${url}`);
        })
    );

    return stub;
};

const threadsOf = (source: SessionSnapshot): ThreadFixture[] => {
    const value = (source as SessionSnapshot & { threads?: ThreadFixture[] }).threads;
    return value === undefined ? [] : value;
};

// The transcript tile of one server turn. Tiles carry `data-turn-id` once the
// record is bound (ui/turns.ts `card.dataset.turnId`), so this is the stable way to
// address the surface the reader expands/collapses now that the strip is gone.
const tileOf = (turnId: string): HTMLElement => {
    const found = document.querySelector<HTMLElement>(`.tile[data-turn-id="${turnId}"]`);
    if (found === null) throw new Error(`missing tile ${turnId}`);
    return found;
};

// The tile header button: clicking it expands/focuses a compact tile and collapses
// an already-expanded one (ui/turns.ts `select` click handler).
const selectOf = (turnId: string): HTMLButtonElement => {
    const found = tileOf(turnId).querySelector<HTMLButtonElement>('.tile-select');
    if (found === null) throw new Error(`missing tile header ${turnId}`);
    return found;
};

// The compact conversation badge of one tile (`.tile-thread`, ui/turns.ts
// `paintThreadBadge`). Non-null access so a missing badge fails loudly instead of
// silently passing an optional-chain assertion.
const badgeOf = (turnId: string): HTMLElement => {
    const found = tileOf(turnId).querySelector<HTMLElement>('.tile-thread');
    if (found === null) throw new Error(`missing tile badge ${turnId}`);
    return found;
};

const mount = async (): Promise<void> => {
    await import('./main');
    await flush();
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    localStorage.setItem(SESSION_KEY, 's1');
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.unstubAllGlobals();
});

it('renders the roster, focuses the newest turn thread and continues it with threadId', async () => {
    const stub = stubServer(
        snapshot({
            turns: [
                turn({ id: 'turn-1', index: 0, threadId: 'thread-1' }),
                turn({ id: 'turn-2', index: 1, threadId: 'thread-1' })
            ],
            threads: [
                { id: 'thread-1', agent: 'instruct', origin: 'host', status: 'stopped', sequence: 1, label: 'Writing' },
                { id: 'thread-2', agent: 'instruct', origin: 'host', status: 'idle', sequence: 2 }
            ]
        })
    );
    await mount();

    // The roster's only visible effect is on the transcript: both turns belong to
    // thread-1, so they share ONE conversation card and ONE badge name.
    expect(document.querySelector('.thread-strip')).toBeNull();
    expect([...document.querySelectorAll<HTMLElement>('.conversation')].map((host) => host.dataset.threadId)).toEqual([
        'thread-1'
    ]);

    // The newest turn (turn-2) is expanded on first content, and it carries the
    // roster's label for thread-1 plus the opaque id in `data-thread-id`.
    const expanded = [...document.querySelectorAll<HTMLElement>('.tile.is-expanded')];
    expect(expanded.map((tile) => tile.dataset.turnId)).toEqual(['turn-2']);
    expect(tileOf('turn-2').dataset.threadId).toBe('thread-1');
    expect(badgeOf('turn-2').textContent).toBe('Writing');
    expect(badgeOf('turn-2').title).toBe('Thread Writing · instruct · stopped');
    expect(tileOf('turn-1').classList.contains('is-expanded')).toBe(false);

    // The routing line names the target before anything is typed.
    expect(byClass('.composer-target', 'p').textContent).toBe('Continuing Writing');

    const input = byClass('.composer-input', 'div');
    input.textContent = 'next step';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    await flush();

    expect(stub.tasks).toEqual([{ input: 'next step', threadId: 'thread-1' }]);
});

it('submits without a threadId when nothing is focused (new thread)', async () => {
    const stub = stubServer(
        snapshot({
            turns: [turn({ id: 'turn-1', index: 0, threadId: 'thread-1' })],
            threads: [
                { id: 'thread-1', agent: 'instruct', origin: 'host', status: 'stopped', sequence: 1, label: 'Writing' }
            ]
        })
    );
    await mount();

    // The newest turn is expanded (focused) on first content.
    expect(byClass('.composer-target', 'p').textContent).toBe('Continuing Writing');

    // Clicking the header of the ALREADY-expanded tile collapses it: that is the
    // explicit unfocus (ui/turns.ts `collapse` sets `explicitUnfocus`).
    selectOf('turn-1').click();
    await flush();
    expect(tileOf('turn-1').classList.contains('is-expanded')).toBe(false);
    expect(byClass('.composer-target', 'p').textContent).toBe('New thread');

    const input = byClass('.composer-input', 'div');
    input.textContent = 'brand new';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    await flush();

    // Absent, not null/empty: the wire's "open a new thread" signal.
    expect(stub.tasks).toEqual([{ input: 'brand new' }]);
});

it('never resurrects a deleted thread from a late snapshot, turn or event (S3)', async () => {
    // The PRE-delete state, captured for the late frames below.
    const initial = snapshot({
        status: 'running',
        updatedAt: 10,
        turns: [turn({ id: 'turn-1', index: 0, status: 'running', threadId: 'thread-1' })],
        threads: [
            { id: 'thread-1', agent: 'instruct', origin: 'host', status: 'running', sequence: 1 },
            // A runtime child the server removes WITH its owner.
            {
                id: 'thread-child',
                agent: 'helper',
                origin: 'host',
                status: 'idle',
                sequence: 2,
                ownerThreadId: 'thread-1'
            }
        ]
    });
    const stub = stubServer(initial);
    await mount();

    // Focus is thread-1 (the expanded turn) before the deletion. The roster's only
    // visible effect is the tile's conversation badge: the strip that used to list
    // `thread-1`/`thread-child` as rows no longer exists.
    expect(byClass('.composer-target', 'p').textContent).toBe('Steering IT1');
    expect(document.querySelector('.thread-strip')).toBeNull();
    expect(tileOf('turn-1').dataset.threadId).toBe('thread-1');
    expect(tileOf('turn-1').getAttribute('data-thread-id')).toBe('thread-1');
    expect(badgeOf('turn-1').textContent).toBe('IT1');
    expect(badgeOf('turn-1').title).toBe('Thread IT1 · instruct · running');
    expect(tileOf('turn-1').classList.contains('is-expanded')).toBe(true);

    // The deletion is performed SERVER-SIDE (another tab / the API): the client only
    // sees an authoritative snapshot whose roster and turns no longer contain
    // thread-1 (or the child it owned). Its `updatedAt` is NEWER, so it passes the
    // watermark and is the snapshot that LEARNS the deletion.
    stub.emit({
        type: 'snapshot',
        session: snapshot({ status: 'idle', updatedAt: 20, turns: [], threads: [] })
    });
    await flush();
    await flush();

    // The thread AND the child it owned are gone — from the answer and from the
    // descendant tombstone, so a late roster that still lists them is filtered.
    expect(document.querySelectorAll('.tile')).toHaveLength(0);
    expect(document.querySelectorAll('.conversation')).toHaveLength(0);
    expect(document.querySelectorAll('.thread-strip-row')).toHaveLength(0);
    // The authoritative deletion cleared the steering target.
    expect(byClass('.composer-target', 'p').textContent).toBe('New thread');

    // A LATE snapshot captured before the deletion (older `updatedAt`, so stale by
    // the watermark): the deleted thread and its turn must stay gone.
    stub.emit({ type: 'snapshot', session: { ...initial, updatedAt: 5 } });
    await flush();
    await flush();

    expect(document.querySelectorAll('.tile')).toHaveLength(0);
    expect(document.querySelectorAll('.conversation')).toHaveLength(0);
    expect(document.querySelectorAll('.thread-strip-row')).toHaveLength(0);
    expect(byClass('.composer-target', 'p').textContent).toBe('New thread');

    // A LATE turn upsert for the deleted turn.
    stub.emit({ type: 'turn', turn: initial.turns[0] });
    await flush();
    expect(document.querySelectorAll('.tile')).toHaveLength(0);
    expect(document.querySelectorAll('.conversation')).toHaveLength(0);

    // A LATE event frame for the deleted turn.
    stub.emit({ type: 'event', turnId: 'turn-1', event: { type: 'text', agent: 'instruct', delta: 'late' } });
    await flush();
    expect(document.querySelectorAll('.tile')).toHaveLength(0);
    expect(byClass('.composer-target', 'p').textContent).toBe('New thread');
});

it('steers a child conversation from its nested invocation row (S2)', async () => {
    const parentEvents = [
        { type: 'start', agent: 'instruct', model: 'm1' },
        { type: 'tool_call', agent: 'instruct', call: { id: 'd1', name: 'agentDelegate', arguments: '{}' } },
        { type: 'start', agent: 'helper', model: 'h1', thread: { id: 'inv-9' } }
    ];
    const stub = stubServer(
        snapshot({
            turns: [
                turn({
                    id: 'turn-1',
                    index: 0,
                    status: 'running',
                    threadId: 'thread-root',
                    events: parentEvents as unknown as SessionTurn['events']
                })
            ],
            threads: [
                { id: 'thread-root', agent: 'instruct', origin: 'host', status: 'running', sequence: 1 },
                {
                    id: 'thread-child',
                    agent: 'helper',
                    origin: 'host',
                    status: 'idle',
                    sequence: 2,
                    label: 'Child',
                    ownerThreadId: 'thread-root',
                    invocationId: 'inv-9'
                }
            ]
        })
    );
    await mount();

    const row = document.querySelector<HTMLElement>('.thread-row');
    expect(row?.dataset.persistentThread).toBe('thread-child');
    row?.querySelector<HTMLButtonElement>('.thread-select')?.click();

    // The composer targets the CHILD's persistent id, and the child conversation is
    // the one expanded surface (the parent tile body is closed).
    expect(byClass('.composer-target', 'p').textContent).toBe('Continuing Child');
    expect(document.querySelector<HTMLElement>('.tile')?.classList.contains('is-expanded')).toBe(false);
    expect(row?.classList.contains('is-expanded')).toBe(true);

    const input = byClass('.composer-input', 'div');
    input.textContent = 'child follow up';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    await flush();

    expect(stub.tasks).toEqual([{ input: 'child follow up', threadId: 'thread-child' }]);
});

it('steers a running focused thread and keeps exactly one conversation row', async () => {
    const stub = stubServer(
        snapshot({
            status: 'running',
            turns: [turn({ id: 'turn-1', index: 0, status: 'running', threadId: 'thread-1' })],
            threads: [{ id: 'thread-1', agent: 'instruct', origin: 'host', status: 'running', sequence: 1, label: 'Running' }]
        }),
        { steer: true }
    );
    await mount();

    expect(byClass('.composer-target', 'p').textContent).toBe('Steering Running');

    const input = byClass('.composer-input', 'div');
    input.textContent = 'change direction';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    await flush();
    await flush();

    // The steering message targets the focused thread...
    expect(stub.tasks).toEqual([{ input: 'change direction', threadId: 'thread-1' }]);
    // ...and the owning turn is the ONLY row: the optimistic steering row was
    // discarded when the answer named an existing turn (no unbound queued ghost).
    expect(document.querySelectorAll('.tile')).toHaveLength(1);
    expect(document.querySelector<HTMLElement>('.tile')?.dataset.turnId).toBe('turn-1');
    expect(document.querySelector<HTMLElement>('.tile')?.dataset.threadId).toBe('thread-1');
    expect(document.querySelector<HTMLElement>('.tile')?.dataset.state).toBe('streaming');
});

it('labels a running focus with an unfinished reference as queued, keeping the same threadId', async () => {
    const stub = stubServer(
        snapshot({
            status: 'running',
            turns: [
                turn({ id: 'turn-1', index: 0, status: 'running', threadId: 'thread-1' }),
                // The block this draft references is STILL RUNNING, so the server has
                // no terminal content to fold into steering text.
                turn({ id: 'turn-2', index: 1, status: 'running', threadId: 'thread-2' })
            ],
            threads: [
                { id: 'thread-1', agent: 'instruct', origin: 'host', status: 'running', sequence: 1, label: 'Running' },
                { id: 'thread-2', agent: 'instruct', origin: 'host', status: 'running', sequence: 2, label: 'Other' }
            ]
        })
    );
    await mount();

    // The newest turn (thread-2) is expanded/focused on first content; focus
    // thread-1 explicitly by clicking turn-1's header, so the draft addresses a
    // running conversation while its reference is unfinished.
    expect(tileOf('turn-2').classList.contains('is-expanded')).toBe(true);
    selectOf('turn-1').click();
    await flush();
    expect(tileOf('turn-1').classList.contains('is-expanded')).toBe(true);
    expect(tileOf('turn-2').classList.contains('is-expanded')).toBe(false);
    expect(byClass('.composer-target', 'p').textContent).toBe('Steering Running');

    const input = byClass('.composer-input', 'div');
    const { editorInsertChips } = await import('./ui/editor');
    const { referenceChipOf } = await import('./ui/references');
    editorInsertChips(input, { start: 0, end: 0 }, [
        referenceChipOf({ turnId: 'turn-2', label: '#IT2', agent: 'instruct', status: 'running' })
    ]);
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // The line no longer promises an immediate steer: this submit is a continuation
    // turn queued behind the active one.
    expect(byClass('.composer-target', 'p').textContent).toBe('Queued in Running');
    expect(byClass('.composer-target', 'p').dataset.mode).toBe('steer');

    byClass('.composer', 'form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await flush();
    await flush();

    // The BODY is unchanged: same focused thread, same reference binding.
    expect(stub.tasks).toEqual([
        { input: '#IT2', references: [{ turnId: 'turn-2', label: 'IT2' }], threadId: 'thread-1' }
    ]);
});

it('removes # reference chips whose turn was deleted, without touching surviving labels', async () => {
    const stub = stubServer(
        snapshot({
            // thread-2 is RUNNING, so the session is pending and the observer stream
            // is open — the only way this client can learn about another writer's
            // deletion now that no in-app thread delete exists.
            status: 'running',
            turns: [
                turn({ id: 'turn-1', index: 0, threadId: 'thread-1' }),
                turn({ id: 'turn-2', index: 1, status: 'running', threadId: 'thread-2' })
            ],
            threads: [
                { id: 'thread-1', agent: 'instruct', origin: 'host', status: 'stopped', sequence: 1 },
                { id: 'thread-2', agent: 'instruct', origin: 'host', status: 'running', sequence: 2 }
            ]
        })
    );
    await mount();

    // Draft a reference to a block of thread-1 (the chip carries the exact binding).
    const input = byClass('.composer-input', 'div');
    const { editorInsertChips } = await import('./ui/editor');
    const { referenceChipOf } = await import('./ui/references');
    editorInsertChips(input, { start: 0, end: 0 }, [
        referenceChipOf({
            turnId: 'turn-1',
            label: 'WR1',
            agent: 'instruct',
            status: 'done',
            content: 'first answer'
        })
    ]);
    const chips = () => [...input.querySelectorAll<HTMLElement>('[data-chip="reference"]')];
    expect(chips().map((chip) => chip.dataset.referenceTurn)).toEqual(['turn-1']);

    // The deletion happens SERVER-SIDE (another tab / the API): the client learns it
    // from an authoritative snapshot that no longer lists thread-1 or turn-1, with a
    // NEWER `updatedAt` so it passes the watermark and teaches the tombstone.
    stub.emit({
        type: 'snapshot',
        session: snapshot({
            updatedAt: 20,
            turns: [turn({ id: 'turn-2', index: 1, threadId: 'thread-2' })],
            threads: [{ id: 'thread-2', agent: 'instruct', origin: 'host', status: 'idle', sequence: 2 }]
        })
    });
    await flush();
    await flush();

    // The surviving conversation is still on screen; only thread-1's turn is gone.
    expect([...document.querySelectorAll<HTMLElement>('.tile')].map((tile) => tile.dataset.turnId)).toEqual([
        'turn-2'
    ]);
    // The stale binding would 400 the whole submit, so it is removed from the draft
    // and reported; surviving references would keep their labels untouched.
    expect(chips()).toEqual([]);
    expect(byClass('.composer-attachment-error', 'p').hidden).toBe(false);
    expect(byClass('.composer-attachment-error', 'p').textContent).toBe(
        'A referenced block was deleted; its # reference was removed from the draft.'
    );
});

it('keeps a separate stop-all available while a draft exists', async () => {
    const stub = stubServer(
        snapshot({
            status: 'running',
            turns: [turn({ id: 'turn-1', index: 0, status: 'running', threadId: 'thread-1' })],
            threads: [{ id: 'thread-1', agent: 'instruct', origin: 'host', status: 'running', sequence: 1 }]
        })
    );
    await mount();

    const action = byClass('.composer-action', 'button');
    const stopAll = byClass('.composer-stop', 'button');
    // Empty + pending: the inline action IS the stop; the separate control is hidden
    // so two stop buttons never share the corner.
    expect(action.dataset.action).toBe('stop');
    expect(stopAll.hidden).toBe(true);

    const input = byClass('.composer-input', 'div');
    input.textContent = 'draft while running';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // Text wins for submit, but stopping EVERYTHING is still one click away.
    expect(action.dataset.action).toBe('submit');
    expect(action.disabled).toBe(false);
    expect(stopAll.hidden).toBe(false);
    expect(stopAll.getAttribute('aria-label')).toBe('Stop all tasks');

    stopAll.click();
    await flush();
    await flush();

    expect(stub.cancels).toEqual([{ all: true }]);
    // The draft was NOT submitted by the stop.
    expect(stub.tasks).toEqual([]);
});

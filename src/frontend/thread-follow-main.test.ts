// T3: the lazy-thread contract, proven in the live shell (./main.ts) — the four things
// the request asks for, end to end:
//
//   R1  loading a conversation reads the ROSTER page and nothing per thread: not one
//       transcript read for a collapsed conversation (asserted on the exact canonical
//       request list, because the shared double answers a transcript composition from the
//       memoised host document and would hide a 50-request fan-out in a raw-route count);
//   R2  expanding a thread establishes its live following — one `thread`-scope
//       subscription and THAT thread's transcript document — and expanding while the
//       plane is down forces the reconnection rather than waiting out the backoff;
//   R3  collapsing it stops following: the subscription is released, no further load runs
//       for it, and the next expand reads the CURRENT document again;
//   R4  a dropped socket leaves nothing stale behind: the reconnection's fresh baseline
//       (the expired-replay-window case) reconciles the panes with NO user gesture and no
//       page refresh, and the page's own `pagehide` says goodbye to the plane.
//   R5  the collapsed screen stays roster-driven (the rows the reader sees are the roster
//       row's own facts — label, status, preview — with zero transcript bytes).
//
// The socket is the shared double (./view-test-support.ts `installHarnessStream`), with
// the client's timers handed to the test so a reconnect happens when the ASSERTION
// decides, not when a real 500ms backoff does. Requests are counted at the OUTER fetch
// boundary — the same trick main.test.ts's `canonicalReads` uses — because that is the
// only place the browser's own spelling (and therefore the real fan-out) is visible.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts thread-follow-main.test.ts

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HarnessDescriptor, SessionSnapshot, SessionTurn } from '../server/protocol';
import { viewAwareFetch } from './view-test-support';
import type { HarnessStreamOptions, StreamDouble } from './view-test-support';

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
        coreTools: ['delegate'],
        primary: 'instruct',
        subagents: [],
        builtin: true,
        editable: true
    }) as HarnessDescriptor;

// A roster row, in the raw spelling the fixture's host document carries. `messages` is
// what the transcript read returns for THAT conversation and nothing else — which is
// exactly why a per-thread load must be the only thing that asks for it.
type ThreadFixture = {
    id: string;
    agent: string;
    origin: 'host';
    status: 'idle' | 'running' | 'stopped';
    sequence: number;
    label?: string;
    ownerThreadId?: string;
    invocationIds?: string[];
    messages: { role: string; content: string }[];
};

// turn-1's run: the root answer, plus a delegation whose child invocation (`inv-b`) is
// joined by the roster to the persistent conversation `thread-b`. The child renders as a
// collapsed `.thread-row` card inside the tile — the surface the reader expands.
const rootEvents = (): unknown[] => [
    { type: 'start', agent: 'instruct', model: 'm1' },
    { type: 'text', agent: 'instruct', delta: 'delegating now' },
    { type: 'tool_call', agent: 'instruct', call: { id: 'd1', name: 'delegate', arguments: '{"task":"count the words"}' } },
    { type: 'start', agent: 'helper', model: 'h1', thread: { id: 'inv-b' } },
    { type: 'text', agent: 'helper', delta: 'four words', thread: { id: 'inv-b' } },
    { type: 'tool_result', agent: 'instruct', call: { id: 'd1', name: 'delegate' }, result: 'child said: four words' }
];

const turn = (overrides: Partial<SessionTurn> & { id?: string } = {}): SessionTurn =>
    ({
        id: 'turn-1',
        index: 0,
        prompt: 'go',
        status: 'running',
        threadId: 'thread-a',
        startedAt: T,
        updatedAt: T + 10,
        events: rootEvents() as SessionTurn['events'],
        eventTimes: [T, T, T, T, T, T],
        ...overrides
    }) as SessionTurn;

const roster = (): ThreadFixture[] => [
    {
        id: 'thread-a',
        agent: 'instruct',
        origin: 'host',
        status: 'running',
        sequence: 1,
        label: 'Root',
        messages: [
            { role: 'user', content: 'root prompt' },
            { role: 'assistant', content: 'root answer' }
        ]
    },
    {
        id: 'thread-b',
        agent: 'helper',
        origin: 'host',
        status: 'idle',
        sequence: 2,
        label: 'Helper',
        ownerThreadId: 'thread-a',
        invocationIds: ['inv-b'],
        messages: [
            { role: 'user', content: 'count the words' },
            { role: 'assistant', content: 'four words' }
        ]
    },
    {
        id: 'thread-c',
        agent: 'helper',
        origin: 'host',
        status: 'idle',
        sequence: 3,
        label: 'Other',
        messages: [{ role: 'user', content: 'never opened' }]
    }
];

const base = (): SessionSnapshot =>
    ({
        id: 's1',
        harness: 'instruct',
        status: 'running',
        model: 'm1',
        createdAt: 1,
        updatedAt: 2,
        messages: [],
        turns: [turn()],
        threads: roster()
    }) as unknown as SessionSnapshot;

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (ms = 40): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, ms));
};

const installLiveStream = (options: HarnessStreamOptions): Promise<StreamDouble> =>
    import('./view-test-support').then((support) => support.installHarnessStream(options));

type Stub = {
    // The record the REST routes answer; a test mutates it to move the server WITHOUT
    // pushing a frame — the case the stale-state bug is about.
    current: SessionSnapshot;
    // Every request the SHELL made, in the browser's own spelling (`/v1/harness/...`).
    canonical: string[];
    stream: StreamDouble;
    // The client's reconnect/heartbeat callbacks, captured so the test fires them.
    timers: { run: () => void; ms: number }[];
};

const mount = async (stub: Stub): Promise<void> => {
    await import('./main');
    await flush();
    await flush();
};

const stubServer = async (initial: SessionSnapshot): Promise<Stub> => {
    const timers: { run: () => void; ms: number }[] = [];
    const canonical: string[] = [];
    // The record the routes answer. A test mutates it to move the SERVER without pushing
    // a frame, which is the outage case: the client holds a document the server no longer
    // answers.
    let current = initial;
    const read = (): SessionSnapshot => current;

    const inner = viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);

        if (url === '/api') {
            return json({
                rootPath: '/api',
                presets: [descriptor()],
                tools: [],
                defaults,
                sessions: [summaryOf(read())],
                agents: []
            });
        }
        if (url === '/api/models') return json({ models: ['m1'] });
        if (url === '/api/sessions/s1/events') {
            // The legacy SSE route is answered because a strict fixture must not fail a
            // probe; the client has no SSE path (./stream.ts:40-43), so nothing reads it.
            return new Response(new ReadableStream<Uint8Array>(), {
                status: 200,
                headers: { 'Content-Type': 'text/event-stream' }
            });
        }
        if (url === '/api/sessions/s1' && init?.method === undefined) return json({ session: read() });
        if (url === '/api/sessions' && init?.method === undefined) return json({ sessions: [summaryOf(read())] });

        throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
    }, { root: '/api' });

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            // The browser's own spelling, captured BEFORE the adapter rewrites it into the
            // fixture's raw routes: this is what makes a per-thread fan-out countable.
            canonical.push(`${init?.method ?? 'GET'} ${String(input)}`);

            return inner(input, init);
        })
    );

    const stream = await installLiveStream({
        sessionId: 's1',
        snapshot: read,
        record: read,
        schedule: (fn, ms) => {
            timers.push({ run: fn, ms });

            return () => undefined;
        }
    });

    return {
        // The fixture's record is exposed through getters/setters so a test can move the
        // server (and read the roster rows it holds) without knowing the adapter's shape.
        get current() {
            return current;
        },
        set current(next: SessionSnapshot) {
            current = next;
        },
        canonical,
        stream,
        timers
    };
};

// The directory row the boot document embeds: the SAME record, counters instead of turns.
const summaryOf = (session: SessionSnapshot): Record<string, unknown> => ({
    ...(session as unknown as Record<string, unknown>),
    turn_count: (session.turns ?? []).length,
    thread_count: ((session as unknown as { threads?: unknown[] }).threads ?? []).length,
    queue_depth: 0
});

const byClass = <K extends keyof HTMLElementTagNameMap>(selector: string, tag: K): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);

    return found;
};

const transcriptReads = (stub: Stub): string[] =>
    stub.canonical.filter((entry) => entry.includes('/transcript'));

const transcriptReadsFor = (stub: Stub, threadId: string): string[] =>
    transcriptReads(stub).filter((entry) => entry.includes(`/threads/${threadId}/transcript`));

const threadSubscribes = (stream: StreamDouble): Record<string, unknown>[] =>
    stream.subscriptions.filter((sub) => sub.scope === 'thread');

// Unsubscribe frames name only their `subscription_id`, so "which scope was released" is
// answered by joining back to the subscribe that opened it.
const releasedScopes = (stream: StreamDouble): string[] => {
    const scopeOf = new Map<string, string>(
        stream.subscriptions.map((sub) => [String(sub.subscription_id), String(sub.scope)])
    );

    return stream.sent
        .filter((frame) => frame.type === 'unsubscribe')
        .map((frame) => scopeOf.get(String(frame.subscription_id)) ?? 'unknown');
};

const tileSelect = (turnId: string): HTMLButtonElement => {
    const select = document
        .querySelector<HTMLElement>(`.tile[data-turn-id="${turnId}"]`)
        ?.querySelector<HTMLButtonElement>('.tile-select');
    if (select === null || select === undefined) throw new Error(`missing tile header ${turnId}`);

    return select;
};

const childRow = (threadId: string): HTMLElement => {
    const row = document.querySelector<HTMLElement>(`.thread-row[data-persistent-thread="${threadId}"]`);
    if (row === null) throw new Error(`missing the card for ${threadId}`);

    return row;
};

const childSelect = (threadId: string): HTMLButtonElement => {
    const select = childRow(threadId).querySelector<HTMLButtonElement>(':scope > .thread-tile > .thread-select');
    if (select === null) throw new Error(`missing the card header for ${threadId}`);

    return select;
};

// The identity text one roster card states, straight from the row — the field a
// replayed, older `thread.upsert` would regress along with its status and message count
// (./main.ts `applyThreadRowPatch`, rendered by ui/turns.ts `.thread-name`).
const rowName = (threadId: string): string | undefined =>
    childRow(threadId).querySelector<HTMLElement>('.thread-name')?.textContent;

// The roster row a `thread.upsert` frame carries (../shared/harness-api.ts
// `ThreadSummary`): one conversation, `stopped`, with the transcript SIGNALS the
// collapsed card renders. Its label is the observable the patch moves.
const summaryRowOf = (threadId: string): Record<string, unknown> => ({
    id: threadId,
    agent: 'helper',
    origin: 'host',
    status: 'stopped',
    sequence: 2,
    label: 'Settled helper',
    transcript_state: 'ok',
    message_count: 9,
    has_transcript: true,
    preview: 'the settled answer'
});

// Runs the client's PENDING reconnect (the backoff callback it scheduled when the socket
// closed), which is the only way a test can bring the plane back on its own terms.
const runReconnect = async (stub: Stub): Promise<void> => {
    const pending = stub.timers.filter((entry) => entry.ms >= 500 && entry.ms < 20_000);

    if (pending.length === 0) throw new Error('the client scheduled no reconnect');

    (pending[pending.length - 1] as { run: () => void }).run();
    await flush();
    await flush();
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    localStorage.setItem(SESSION_KEY, 's1');
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(async () => {
    vi.unstubAllGlobals();

    // The stream client is a process-wide singleton (./stream.ts); leaving this file's
    // double configured hands the next test file's shell a socket that was never its own.
    const { resetHarnessStream } = await import('./stream');

    resetHarnessStream();
});

// ---------------------------------------------------------------------------
// R1 + R5 — the load reads the roster, and nothing else
// ---------------------------------------------------------------------------

it('loads a conversation with no transcript read for any thread, and still paints the roster overview', async () => {
    const stub = await stubServer(base());
    await mount(stub);

    // The roster page is read exactly once, and NO transcript route is dialled at all:
    // three conversations with committed documents, zero of them pulled. Before T3 the
    // same load path cost 2 identified reads PER THREAD the moment any thread was opened
    // (50 for a full roster page), and the board paid it again on every transcript open.
    const rosterReads = stub.canonical.filter((entry) => entry === 'GET /v1/harness/sessions/s1/threads?limit=25');

    expect(rosterReads).toHaveLength(1);
    expect(transcriptReads(stub)).toEqual([]);

    // Nothing is expanded, so nothing is followed: no `thread` subscription exists while
    // every card is collapsed (T21 R22 stays intact — a load is not an expansion request).
    expect(document.querySelectorAll('.tile.is-expanded')).toHaveLength(0);
    expect(document.querySelectorAll('.thread-row.is-expanded')).toHaveLength(0);
    expect(threadSubscribes(stub.stream)).toEqual([]);

    // R5: the collapsed screen is driven by the ROSTER row alone. The conversation badge
    // carries the roster's label and status, and the delegated child card is a collapsed
    // roster join — its name, its state word and its preview are all facts the roster and
    // the record already carry, with no transcript behind them.
    const badge = byClass('.tile-thread', 'span');
    expect(badge.textContent).toBe('Root');
    expect(badge.title).toBe('Thread Root · instruct · running');

    const card = childRow('thread-b');
    expect(card.classList.contains('is-expanded')).toBe(false);
    expect(card.querySelector<HTMLElement>('.thread-name')?.textContent).toBe('Helper');
    expect(card.querySelector<HTMLElement>('.thread-status')?.dataset.state).toBe('streaming');
    // The preview line is the record's own (this child was invoked without a task string
    // the compact path can show, so the card says `delegated task`). Either way it is
    // built from the roster row and the record — never from a transcript.
    expect(card.querySelector<HTMLElement>('.thread-preview')?.textContent).toBe('delegated task');

    // A thread the reader never opened (and that has no card of its own) costs NOTHING:
    // `thread-c` appears in no request and on no surface.
    expect(stub.canonical.filter((entry) => entry.includes('thread-c'))).toEqual([]);
});

// ---------------------------------------------------------------------------
// R2 — expanding a thread establishes the following
// ---------------------------------------------------------------------------

it('follows a thread the reader expands: one subscription and one transcript, nothing for the others', async () => {
    const stub = await stubServer(base());
    await mount(stub);

    // Expanding the delegated child CARD is the gesture the request names.
    childSelect('thread-b').click();
    await flush();

    // 1. the live following: exactly one `thread`-scope subscription, addressed with this
    //    session and this conversation (and no `filters`, which the thread scope refuses,
    //    and no cursor — a first registration starts at the server's current position).
    expect(
        threadSubscribes(stub.stream).map((sub) => [
            sub.scope,
            sub.session_id,
            sub.thread_id,
            sub.pace,
            sub.filters,
            sub.cursor
        ])
    ).toEqual([['thread', 's1', 'thread-b', 'ordered', undefined, undefined]]);

    // 2. the fresh per-thread load: THAT document, and only it.
    expect(transcriptReadsFor(stub, 'thread-b')).toEqual([
        'GET /v1/harness/sessions/s1/threads/thread-b/transcript',
        'GET /v1/harness/sessions/s1/threads/thread-b/transcript/document'
    ]);
    expect(transcriptReadsFor(stub, 'thread-a')).toEqual([]);
    expect(transcriptReadsFor(stub, 'thread-c')).toEqual([]);

    // The card is open, and the conversation is the steering target the composer names —
    // the existing focus contract still holds on top of the new following.
    expect(childRow('thread-b').classList.contains('is-expanded')).toBe(true);
    expect(byClass('.composer-target', 'p').textContent).toBe('Continuing Helper');
});

it('re-establishes the plane when a thread is expanded while the socket is down', async () => {
    const stub = await stubServer(base());
    await mount(stub);

    // An open conversation is streaming: the shell follows it on the shared socket.
    tileSelect('turn-1').click();
    await flush();

    expect(stub.stream.status()).toBe('open');

    // The plane dies. The client schedules a backoff (500ms+, with jitter) and stays
    // `reconnecting` until SOMETHING dials — before T3 nothing ever did until that timer
    // fired, and a reader expanding a card in the meantime queued a subscription behind a
    // stalled attempt.
    stub.stream.drop();
    expect(stub.stream.status()).toBe('reconnecting');

    childSelect('thread-b').click();
    await flush();

    // Expanding a conversation forces the reconnection: the socket is up again WITHOUT the
    // test running the backoff callback, and the thread is followed on the new connection.
    expect(stub.stream.status()).toBe('open');
    // Append-only across connections: `thread-a` from the first expand, `thread-b` from the
    // gesture that made the client re-dial (recorded after the drop, i.e. on the new
    // socket — the list is in the order the frames were written).
    expect(threadSubscribes(stub.stream).map((sub) => sub.thread_id)).toEqual(['thread-a', 'thread-b']);

    // And the document arrives over REST regardless of the plane's state: a reader who
    // opened a conversation sees it even while the socket is being rebuilt.
    expect(transcriptReadsFor(stub, 'thread-b')).toEqual([
        'GET /v1/harness/sessions/s1/threads/thread-b/transcript',
        'GET /v1/harness/sessions/s1/threads/thread-b/transcript/document'
    ]);
});

// ---------------------------------------------------------------------------
// R3 — collapsing stops following
// ---------------------------------------------------------------------------

it('stops following a thread the reader collapses, loads nothing more for it, and reads the current document on re-expand', async () => {
    const stub = await stubServer(base());
    await mount(stub);

    childSelect('thread-b').click();
    await flush();

    const followed = threadSubscribes(stub.stream)[0];
    if (followed === undefined) throw new Error('the expanded card was never followed');

    const id = String(followed.subscription_id);

    // The document the reader is looking at is now the SERVER's current one; move it while
    // the card is closed, which is what makes the next read observable.
    const withServerEdit = (): void => {
        const current = stub.current as unknown as { threads: ThreadFixture[] };
        const thread = current.threads.find((entry) => entry.id === 'thread-b');
        if (thread === undefined) throw new Error('missing thread-b');

        thread.messages = [{ role: 'user', content: 'count the words' }, { role: 'assistant', content: 'five words now' }];
    };

    childSelect('thread-b').click();
    await flush();

    // R3: the registration is released — an unsubscribe for exactly that id — and the
    // client holds no thread entry any more.
    expect(releasedScopes(stub.stream)).toEqual(['thread']);
    expect(stub.stream.sent).toContainEqual({ type: 'unsubscribe', subscription_id: id });

    const { harnessStream } = await import('./stream');

    expect(harnessStream().subscriptions().filter((sub) => sub.spec.scope === 'thread')).toEqual([]);

    // Nothing else is fetched for a collapsed conversation.
    const readsWhileCollapsed = transcriptReadsFor(stub, 'thread-b').length;
    withServerEdit();
    await flush();

    expect(transcriptReadsFor(stub, 'thread-b')).toHaveLength(readsWhileCollapsed);

    // Re-expanding RE-ESTABLISHES the following: a new registration (the old one is gone)
    // and a fresh read — the cached document cannot prove what the thread holds now.
    childSelect('thread-b').click();
    await flush();

    expect(threadSubscribes(stub.stream)).toHaveLength(2);
    expect(transcriptReadsFor(stub, 'thread-b')).toEqual([
        'GET /v1/harness/sessions/s1/threads/thread-b/transcript',
        'GET /v1/harness/sessions/s1/threads/thread-b/transcript/document',
        'GET /v1/harness/sessions/s1/threads/thread-b/transcript',
        'GET /v1/harness/sessions/s1/threads/thread-b/transcript/document'
    ]);
});

// ---------------------------------------------------------------------------
// R4 — a drop leaves nothing stale, and no leak
// ---------------------------------------------------------------------------

it('reconciles every open pane after a reconnect whose replay window expired, with no user gesture', async () => {
    const stub = await stubServer(base());
    await mount(stub);

    // The reader is looking at the root conversation, and its transcript dialog is open:
    // the two surfaces R4 says must not go stale.
    tileSelect('turn-1').click();
    await flush();

    document.querySelector<HTMLElement>('.tile.is-expanded .transcript-open')?.click();
    await flush();
    await flush();

    const dialog = document.querySelector<HTMLElement>('.dialog');
    if (dialog === null) throw new Error('the transcript dialog did not open');
    expect(dialog.textContent).toContain('root answer');

    // The SERVER moves on while the socket is quiet: a continuation turn appears, and the
    // committed transcript gains an entry. No frame carries either — this is the outage the
    // bug report describes, where the client is left holding a pre-drop document. (The
    // header frame below is a session-level revision bump, the kind any server-side write
    // makes; it carries no rows and no transcript, so it cannot be what repairs the pane.)
    const record = stub.current as unknown as { threads: ThreadFixture[]; turns: SessionTurn[]; updatedAt: number };
    record.turns = [
        ...record.turns,
        turn({ id: 'turn-2', index: 1, prompt: 'follow up', status: 'done', updatedAt: T + 90 })
    ];
    record.threads = record.threads.map((entry) =>
        entry.id === 'thread-a'
            ? { ...entry, messages: [...entry.messages, { role: 'assistant', content: 'reconciled after the drop' }] }
            : entry
    );
    record.updatedAt = 99;

    stub.stream.push({ kind: 'session.updated', session: { id: 's1', revision: 9, status: 'running' } });
    await flush();

    // The reads the outage is allowed to REPLACE, counted at the moment the socket dies.
    const documentsBeforeDrop = transcriptReadsFor(stub, 'thread-a').filter((entry) => entry.endsWith('/transcript/document')).length;
    // T3b (the owner decision on export fidelity): opening the transcript dialog IS the
    // explicit export, and the export quotes EVERY roster conversation losslessly — so
    // thread-c, a conversation this page never opened, has by now been read exactly once
    // (the pair of endpoints one transcript costs). Pinning that here keeps the fidelity
    // claim and the no-fan-out claim in the same test.
    const threadCReadsBeforeDrop = transcriptReadsFor(stub, 'thread-c');

    expect(threadCReadsBeforeDrop).toEqual([
        'GET /v1/harness/sessions/s1/threads/thread-c/transcript',
        'GET /v1/harness/sessions/s1/threads/thread-c/transcript/document'
    ]);

    const sessionReadsBeforeReconnect = stub.canonical.filter((entry) => entry === 'GET /v1/harness/sessions/s1').length;
    const treeReadsBeforeDrop = stub.canonical.filter((entry) => entry === 'GET /v1/harness/sessions/s1/turns/turn-1/display').length;

    stub.stream.drop();
    expect(stub.stream.status()).toBe('reconnecting');

    await runReconnect(stub);

    // The reconnection answers a FRESH baseline (no `replayed_frames`): the broker restarts
    // a subscription whose parked window is gone rather than sending `resync_required`
    // (../server/stream/broker.ts:749-768), and this is the moment the pane must re-read.
    expect(stub.stream.status()).toBe('open');

    // 1. the loaded window is re-read EXACTLY ONCE — one reconcile per loss, not one per
    //    frame, per baseline, or per second of outage.
    const sessionReReads = stub.canonical
        .filter((entry) => entry === 'GET /v1/harness/sessions/s1')
        .slice(sessionReadsBeforeReconnect);

    expect(sessionReReads).toEqual(['GET /v1/harness/sessions/s1']);

    // 2. the FOLLOWED thread's document is re-read too (a cached transcript cannot be
    //    trusted across a broken flow), while the conversations the reader never opened
    //    cost NOTHING on this path: the reconcile does not fan out, and thread-c's single
    //    read remains the export that already happened before the drop (T3b).
    expect(
        transcriptReadsFor(stub, 'thread-a').filter((entry) => entry.endsWith('/transcript/document')).length
    ).toBeGreaterThan(documentsBeforeDrop);
    expect(transcriptReadsFor(stub, 'thread-c')).toEqual(threadCReadsBeforeDrop);

    // …and so is the expanded tile's DISPLAY TREE: `createDisplayLoader` marks an answer
    // 'done' for its generation, so without the invalidation on the drop path the turn that
    // was mid-flight when the socket died would keep rendering its pre-outage tree forever.
    const treeReadsAfter = stub.canonical.filter((entry) => entry === 'GET /v1/harness/sessions/s1/turns/turn-1/display');

    // Three re-reads of the opened tile's tree: one when the flow breaks (the tree cache is
    // dropped, so the visible row refetches), one after the window reconcile, and one for
    // the re-registered `turn` subscription's fresh baseline — which names no `revisions`,
    // so the shell cannot prove its tree is covered by it and re-reads (the reconciliation
    // anchor rule of ./stream.ts, rule 4). The third appeared when the socket double started
    // answering EVERY subscribe the way the server does (./view-test-support.ts); the
    // session window above is still re-read exactly ONCE, so the loss still costs one
    // reconcile per resource, not one per frame.
    expect(treeReadsAfter.length - treeReadsBeforeDrop).toBe(3);

    // 3. the rows reconcile with it: the turn the server added during the outage is on
    //    screen, in recorded order, and the reader pressed NOTHING to get it.
    expect([...document.querySelectorAll<HTMLElement>('.tile')].map((tile) => tile.dataset.turnId)).toEqual([
        'turn-1',
        'turn-2'
    ]);

    // The dialog surface survives the outage open on the same conversation (it is the
    // pane R4 says must not go stale, and it is not closed and re-opened as a side effect
    // of the reconcile).
    const openDialog = document.querySelector<HTMLElement>('.dialog');
    if (openDialog === null) throw new Error('the transcript dialog closed under the reader');
    expect(openDialog.textContent).toContain('"id": "thread-a"');

    // 4. no leaked registrations: the client holds the session subscription, the ONE
    //    shared record-update channel T6's live panels register together
    //    (./extensions/records-wake.ts — two panels, one registration), one thread
    //    subscription and one turn subscription — re-registered on the new connection,
    //    never abandoned by a settled observer (the leak that closed its own socket).
    const { harnessStream } = await import('./stream');
    const live = harnessStream().subscriptions();

    expect(live.map((sub) => sub.spec.scope).sort()).toEqual(['session', 'session', 'thread', 'turn']);
    expect(live.filter((sub) => sub.spec.scope === 'thread').map((sub) => sub.spec.threadId)).toEqual(['thread-a']);
});

// The goodbye the page owes the server: `bye` + close 1000, so a reload does not look
// like a dropped connection (and the next page starts a fresh registration instead of
// resuming a cursor the broker parked for the one that left).
it('closes the plane on pagehide instead of dropping it', async () => {
    const stub = await stubServer(base());
    await mount(stub);

    childSelect('thread-b').click();
    await flush();

    window.dispatchEvent(new Event('pagehide'));

    const { harnessStream } = await import('./stream');

    expect(harnessStream().status()).toBe('closed');
    expect(stub.stream.sent).toContainEqual({ type: 'bye', reason: 'page unload' });
    expect(stub.stream.socket().closeCode).toBe(1000);
    // Every registration is gone with the connection — nothing left to leak.
    expect(harnessStream().subscriptions()).toEqual([]);
});

// ---------------------------------------------------------------------------
// T3b — the export owns the fan-out, and a roster patch cannot undo a newer document
// ---------------------------------------------------------------------------

// The owner decision on the lazy-thread trade: session load and board viewing stay
// fan-out-free (R1), and the LOSSLESS document gets its full transcripts back at the
// explicit export. Both halves are pinned here, counted at the outer (canonical) fetch
// boundary — the mechanism of the composition itself is pinned route-by-route in
// ./view-shell-follow.test.ts.
it('reads no transcript to open the conversation, and reads every one of them to export it', async () => {
    const stub = await stubServer(base());
    await mount(stub);

    // (a) THE LOAD. `thread-a`, `thread-b` and `thread-c` all exist in the roster and the
    // board paints all three; none of their transcripts was requested.
    expect(transcriptReads(stub)).toEqual([]);

    // The reader opens the conversation on screen and asks for its transcript — the
    // EXPLICIT export, and the only place left that pays for the whole roster.
    tileSelect('turn-1').click();
    await flush();

    document.querySelector<HTMLElement>('.tile.is-expanded .transcript-open')?.click();
    await flush();
    await flush();
    await flush();

    const dialog = document.querySelector<HTMLElement>('.dialog');
    if (dialog === null) throw new Error('the transcript dialog did not open');

    // The document the reader copies carries the conversation's committed messages.
    expect(dialog.textContent).toContain('root answer');

    // (b) THE EXPORT: `thread-b` and `thread-c` — the conversations this page never
    // opened — are read here, so the composed document describes them the way it did
    // before the lazy work. Sorted, because the documents are independent concurrent
    // reads; the two endpoints per conversation are the identified metadata read and the
    // document read (`./view-api.ts` `readTranscript`).
    expect([...new Set(transcriptReads(stub))].sort()).toEqual([
        'GET /v1/harness/sessions/s1/threads/thread-a/transcript',
        'GET /v1/harness/sessions/s1/threads/thread-a/transcript/document',
        'GET /v1/harness/sessions/s1/threads/thread-b/transcript',
        'GET /v1/harness/sessions/s1/threads/thread-b/transcript/document',
        'GET /v1/harness/sessions/s1/threads/thread-c/transcript',
        'GET /v1/harness/sessions/s1/threads/thread-c/transcript/document'
    ]);

    // The session-level reads one open + one export costs, stated exactly rather than
    // assumed: the load's compact window (`getView`), the export's own freshness window,
    // and the raw composition's session read. Everything else the export spends is the
    // transcript set above.
    expect(stub.canonical.filter((entry) => entry === 'GET /v1/harness/sessions/s1')).toEqual([
        'GET /v1/harness/sessions/s1',
        'GET /v1/harness/sessions/s1',
        'GET /v1/harness/sessions/s1'
    ]);
});

// The freshness guard on row patches (T3b): `thread.upsert` carries ONE row, so it is
// authoritative for that row and nothing else — and a replay out of the stream's retained
// window can be older than the document a mid-outage re-read already installed.
it('refuses a replayed older thread.upsert instead of regressing a settled row', async () => {
    const stub = await stubServer(base());
    await mount(stub);

    const record = stub.current as unknown as { updatedAt: number };

    expect(record.updatedAt).toBe(2);

    // 1. the live patch, stamped 900 by the server: the row on screen states it.
    stub.stream.push({ kind: 'thread.upsert', thread: summaryRowOf('thread-b'), at: 900 });
    await flush();

    expect(rowName('thread-b')).toBe('Settled helper');

    // 2. the outage's reconcile. The SERVER moved on (its document is stamped 1200) and the
    // reconnect answers a fresh baseline, whose window re-read installs that document — the
    // roster rows and all, so `thread-b` settles back at what the document states.
    record.updatedAt = 1200;
    stub.stream.drop();
    await runReconnect(stub);

    expect(stub.stream.status()).toBe('open');
    expect(rowName('thread-b')).toBe('Helper');

    // 3. THE REPLAY. The retained window re-delivers the 900-frame. Applying it would put
    // that older row — its identity, its `status`, its `messageCount` and its `preview`,
    // which the frame assigns as ONE object — back on a conversation the newer document
    // settled, with no further frame left to correct it. That is the regression the guard
    // refuses.
    stub.stream.push({ kind: 'thread.upsert', thread: summaryRowOf('thread-b'), at: 900 });
    await flush();

    expect(rowName('thread-b')).toBe('Helper');

    // 4. The guard is a freshness rule, not a freeze: the SAME row, stamped after the
    // document, is applied normally.
    stub.stream.push({ kind: 'thread.upsert', thread: summaryRowOf('thread-b'), at: 1300 });
    await flush();

    expect(rowName('thread-b')).toBe('Settled helper');
});

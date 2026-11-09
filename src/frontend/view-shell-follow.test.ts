// T3: what the OBSERVERS do when the realtime plane breaks (./view-shell.ts) and what
// the stream client does about it (./stream.ts). These are the R4 halves of the task —
// "a dropped websocket must not leave stale state requiring the user to refresh", "no
// leaked subscriptions", "a stuck dial must recover" — asserted at the seam where each
// rule actually lives, with an exact frame-by-frame wire and a hand-driven clock.
//
// Why a hand-rolled socket rather than `installHarnessStream`: that double answers the
// handshake automatically, and every rule here is about a specific handshake SHAPE (a
// fresh baseline vs a replayed one, an acknowledged registration vs a refused one, a
// close that arrives while nothing is open). The double also cannot deliver an `error`
// frame. The protocol facts are read from the contract types (../shared/harness-stream.ts)
// and from the broker's own behaviour (../server/stream/broker.ts), never invented.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts view-shell-follow.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    PendingActionListResponse,
    SessionResource,
    ThreadSummary,
    ThreadSummaryPage,
    TurnSummary,
    TurnSummaryPage
} from '../shared/harness-api';
import { configureHarnessStream, harnessStream, resetHarnessStream } from './stream';
import type { StreamSocket, StreamSocketFactory } from './stream';
import { getRawSession, observeThread, observeView } from './view-shell';
import type { ViewStreamItem } from './view-shell';
import type { ThreadRow } from './view-model';

// ---------------------------------------------------------------------------
// The socket double and the clock
// ---------------------------------------------------------------------------

type Probe = StreamSocket & {
    sent: string[];
    deliver: (value: unknown) => void;
    closeCode: number | undefined;
    // One `onclose` per connection, whatever closes it (the test or the client). A test
    // clears this before driving a RE-DIAL on the same double.
    fired: boolean;
    fireClose: (code: number) => void;
};

const createProbe = (): Probe => {
    const probe = {
        sent: [] as string[],
        onopen: null as (() => void) | null,
        onmessage: null as ((event: { data: unknown }) => void) | null,
        onerror: null as (() => void) | null,
        onclose: null as ((event: { code?: number; reason?: string }) => void) | null,
        send: (data: string): void => {
            probe.sent.push(data);
        },
        close: (code?: number): void => {
            probe.closeCode = code;
            // A real transport reports its own close, and ./stream.ts's ONLY drop path
            // is that event — a double that stayed silent could never exercise it.
            probe.fireClose(code ?? 1000);
        },
        deliver: (value: unknown): void => {
            probe.onmessage?.({ data: JSON.stringify(value) });
        },
        closeCode: undefined as number | undefined,
        fired: false,
        fireClose: (code: number): void => {
            if (probe.fired) return;
            probe.fired = true;
            probe.onclose?.({ code });
        }
    } as unknown as Probe;

    return probe;
};

// A scheduler the test drives, so a heartbeat deadline or a reconnect backoff fires at
// the exact assertion — never on a real 500ms+ backoff with random jitter.
const createClock = (): {
    schedule: (fn: () => void, ms: number) => () => void;
    advance: (ms: number) => void;
    pending: () => number;
} => {
    type Task = { at: number; fn: () => void; id: number };

    let now = 0;
    let nextId = 0;
    const tasks: Task[] = [];

    return {
        schedule: (fn, ms) => {
            const task: Task = { at: now + ms, fn, id: nextId++ };
            tasks.push(task);

            return () => {
                const index = tasks.findIndex((candidate) => candidate.id === task.id);
                if (index >= 0) tasks.splice(index, 1);
            };
        },
        advance: (ms) => {
            now += ms;

            for (const task of [...tasks].sort((left, right) => left.at - right.at)) {
                if (task.at > now) continue;

                const index = tasks.findIndex((candidate) => candidate.id === task.id);
                if (index >= 0) tasks.splice(index, 1);
                task.fn();
            }
        },
        pending: () => tasks.length
    };
};

const WELCOME = (epoch = 'e1'): Record<string, unknown> => ({
    type: 'welcome',
    protocol: 'harness.v1',
    epoch,
    at: 1_700_000_000_000,
    limits: {
        subscriptions_per_connection: 64,
        ops_per_update_frame: 32,
        delta_chars_per_append_op: 2000,
        events_per_update_frame: 16,
        ids_per_invalidation_frame: 64,
        max_client_frame_bytes: 16384,
        max_server_frame_bytes: 65536,
        client_messages_per_second: 32,
        heartbeat_interval_ms: 15000,
        heartbeat_timeout_intervals: 3,
        heartbeat_timeout_close_code: 4408,
        replay_frames: 64,
        replay_seconds: 60,
        send_queue_frames: 256,
        send_queue_bytes: 1048576,
        sustained_stall_ms: 10000,
        ack_timeout_ms: 5000,
        revision_records_per_state: 20
    }
});

const stateFrame = (
    subscriptionId: string,
    scope: string,
    sequence: number,
    cursor: string,
    extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
    type: 'subscription_state',
    subscription_id: subscriptionId,
    scope,
    epoch: 'e1',
    sequence,
    cursor,
    revisions: [],
    publishes: ['turn.upsert', 'thread.upsert', 'session.updated', 'display.ops', 'transcript.updated'],
    ...extra
});

const framesOf = (probe: Probe): Record<string, unknown>[] =>
    probe.sent.map((text) => JSON.parse(text) as Record<string, unknown>);

const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 20));
};

// ---------------------------------------------------------------------------
// The REST side `observeView`'s reconcile is allowed to spend
// ---------------------------------------------------------------------------

const session: SessionResource = {
    id: 's1',
    harness: 'instruct',
    status: 'running',
    model: 'm1',
    created_at: 1,
    updated_at: 2,
    turn_count: 1,
    thread_count: 1,
    revision: 3,
    definition_revision: 1,
    agent_models: {},
    endpoint: { base_url: 'http://provider/v1', model: 'm1', has_api_key: false },
    runtime_execution: 'inline',
    pending_action_count: 0,
    created_tool_count: 0,
    created_tool_limit: 32
};

const rowRunning: TurnSummary = {
    id: 'u1',
    index: 0,
    promptPreview: 'go',
    promptChars: 2,
    status: 'running',
    state: 'streaming',
    threadId: 't1',
    updatedAt: 2,
    sectionCount: 1,
    stepCount: 0,
    activeAgents: ['instruct'],
    blocks: []
};

// The roster row a `thread.upsert` frame carries: one conversation, `stopped`, with the
// transcript SIGNAL the collapsed card renders (no messages — the compact contract).
const rosterRow: ThreadSummary = {
    id: 't1',
    agent: 'instruct',
    origin: 'host',
    status: 'stopped',
    sequence: 0,
    label: 'Root',
    transcript_state: 'ok',
    message_count: 4,
    has_transcript: true,
    preview: 'the last entry'
};

let reads: string[] = [];

const routeOf = (path: string): Response => {
    const jsonOf = (value: unknown): Response =>
        new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

    reads.push(path.split('?')[0] as string);

    if (path === '/v1/harness/sessions/s1') return jsonOf({ session } satisfies { session: unknown });
    if (path === '/v1/harness/sessions/s1/turns?limit=25&order=desc') {
        const page: TurnSummaryPage = {
            limit: 25,
            next_cursor: null,
            observed_at: 2000,
            revision: 1,
            items: [rowRunning]
        };

        return jsonOf(page);
    }
    if (path === '/v1/harness/sessions/s1/threads?limit=25') {
        const page: ThreadSummaryPage = {
            limit: 25,
            next_cursor: null,
            observed_at: 2000,
            revision: 1,
            items: [rosterRow]
        };

        return jsonOf(page);
    }
    if (path === '/v1/harness/sessions/s1/actions') {
        const actions: PendingActionListResponse = { session_id: 's1', revision: 1, actions: [] };

        return jsonOf(actions);
    }

    // T3b: the routes the LOSSLESS export read walks (`getRawSession` asks for the wide
    // pages, then one identified transcript per conversation), pinned here because the
    // export's whole claim is which of them a given call spends.
    if (path === '/v1/harness/sessions/s1/turns?limit=100&order=desc') {
        const page: TurnSummaryPage = {
            limit: 100,
            next_cursor: null,
            observed_at: 2000,
            revision: 1,
            items: [rowRunning]
        };

        return jsonOf(page);
    }
    if (path === '/v1/harness/sessions/s1/threads?limit=100') {
        const page: ThreadSummaryPage = {
            limit: 100,
            next_cursor: null,
            observed_at: 2000,
            revision: 1,
            items: [rosterRow, helperRow]
        };

        return jsonOf(page);
    }
    if (path === '/v1/harness/sessions/s1/turns/u1') {
        return jsonOf({
            turn: { ...rowRunning, prompt: 'go', thread_id: 't1', started_at: 1, updated_at: 2 }
        });
    }
    if (path === '/v1/harness/sessions/s1/turns/u1/events?limit=100') {
        return jsonOf({
            limit: 100,
            next_cursor: null,
            observed_at: 2000,
            revision: 1,
            turn_id: 'u1',
            total_events: 0,
            partial: false,
            items: []
        });
    }
    if (path === '/v1/harness/sessions/s1/threads/t1/transcript') {
        return jsonOf({ transcript: transcriptMetadataOf('t1', 'instruct', 1) });
    }
    if (path === '/v1/harness/sessions/s1/threads/t1/transcript/document') {
        return jsonOf(transcriptDocumentOf('t1', 'instruct', [{ role: 'user', content: 'root prompt' }]));
    }
    if (path === '/v1/harness/sessions/s1/threads/t2/transcript') {
        return jsonOf({ transcript: transcriptMetadataOf('t2', 'helper', 1) });
    }
    if (path === '/v1/harness/sessions/s1/threads/t2/transcript/document') {
        return jsonOf(transcriptDocumentOf('t2', 'helper', [{ role: 'assistant', content: 'four words' }]));
    }

    throw new Error(`unstubbed request: ${path}`);
};

// The second conversation of the export fixture: a roster row that carries ONLY the
// transcript signals, so the committed bytes below can come from nowhere but the
// identified transcript routes.
const helperRow: ThreadSummary = {
    id: 't2',
    agent: 'helper',
    origin: 'host',
    status: 'idle',
    sequence: 1,
    label: 'Helper',
    transcript_state: 'ok',
    message_count: 1,
    has_transcript: true,
    preview: 'four words'
};

const transcriptMetadataOf = (threadId: string, agent: string, messageCount: number) => ({
    session_id: 's1',
    thread_id: threadId,
    agent,
    transcript_state: 'ok' as const,
    message_count: messageCount,
    chars: 11,
    bytes: 11,
    revision: 4,
    role_counts: { system: 0, user: 1, assistant: 0, tool: 0 }
});

const transcriptDocumentOf = (threadId: string, agent: string, messages: unknown) => ({
    session_id: 's1',
    thread_id: threadId,
    agent,
    revision: 4,
    transcript_state: 'ok' as const,
    document: JSON.stringify(messages)
});

beforeEach(() => {
    reads = [];
    // The canonical API root is resolved from the document URL, so pin it: every route
    // below is asserted by its exact `/v1/harness/...` path.
    window.history.replaceState(null, '', '/');
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => routeOf(String(input)))
    );
});

afterEach(() => {
    resetHarnessStream();
    vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// The stream client's drop contract
// ---------------------------------------------------------------------------

describe('the dropped socket, at the client', () => {
    it('tells every live subscription its position is gone and re-registers each with its own cursor', async () => {
        const probe = createProbe();
        const clock = createClock();

        configureHarnessStream({ socketFactory: () => probe, schedule: clock.schedule });

        const client = harnessStream();
        const losses: string[] = [];

        const sessionSub = client.subscribe({
            scope: 'session',
            sessionId: 's1',
            onResync: (frame) => losses.push(`session:${frame.reason}:${frame.resources.length}`)
        });
        const threadSub = client.subscribe({
            scope: 'thread',
            sessionId: 's1',
            threadId: 't1',
            onResync: (frame) => losses.push(`thread:${frame.reason}:${frame.resources.length}`)
        });

        probe.onopen?.();
        probe.deliver(WELCOME());
        probe.deliver(stateFrame(sessionSub.id, 'session', 0, 'cur-s0'));
        probe.deliver(stateFrame(threadSub.id, 'thread', 0, 'cur-t0'));

        expect(client.status()).toBe('open');

        // The connection dies (a server restart, a lost heartbeat, a laptop lid). Before
        // T3 this re-dialled in SILENCE: the panes kept whatever they were showing, and
        // only an inbound frame could tell them otherwise — and nothing arrives on a dead
        // socket. R4 starts here.
        probe.fireClose(1006);

        expect(losses).toEqual(['session:frames_dropped:0', 'thread:frames_dropped:0']);
        expect(client.status()).toBe('reconnecting');
        // The registrations SURVIVE the drop: the reconnect re-opens each of them, which
        // is what keeps the resume position (and avoids a leak in the other direction).
        expect(client.subscriptions().map((entry) => entry.id)).toEqual([sessionSub.id, threadSub.id]);

        // One backoff, then the re-dial.
        probe.sent.length = 0;
        clock.advance(10_000);
        probe.onopen?.();

        // `hello` names the connection's position, and EACH subscription resumes with its
        // own cursor — including the thread scope, whose cursor T3 added so a re-subscribe
        // lands inside the replay window the broker parked (../server/stream/broker.ts:720,
        // :749-768). Without it the thread subscription could never be distinguished from a
        // brand-new one.
        expect(framesOf(probe)).toEqual([
            { type: 'hello', protocol: 'harness.v1', epoch: 'e1', cursor: 'cur-t0' },
            {
                type: 'subscribe',
                subscription_id: sessionSub.id,
                scope: 'session',
                session_id: 's1',
                pace: 'ordered',
                cursor: 'cur-s0'
            },
            {
                type: 'subscribe',
                subscription_id: threadSub.id,
                scope: 'thread',
                session_id: 's1',
                thread_id: 't1',
                pace: 'ordered',
                cursor: 'cur-t0'
            }
        ]);
    });

    it('queues a subscription made while reconnecting instead of dialling in front of the backoff', () => {
        const created: Probe[] = [];
        const clock = createClock();

        configureHarnessStream({
            socketFactory: () => {
                const probe = createProbe();
                created.push(probe);

                return probe;
            },
            schedule: clock.schedule
        });

        const client = harnessStream();

        client.subscribe({ scope: 'session', sessionId: 's1' });
        created[0]?.onopen?.();
        created[0]?.deliver(WELCOME());

        created[0]?.fireClose(1006);
        expect(client.status()).toBe('reconnecting');
        expect(created).toHaveLength(1);

        // A pane mounting during the outage used to call `open()`, whose only guard is
        // `connecting`/`open` — so it DIALED IMMEDIATELY, in front of the pending backoff,
        // and every mount started another attempt (the burst the server prices at 32
        // msg/s, ../server/stream/connection.ts:305). Now it is queued for the re-dial.
        client.subscribe({ scope: 'thread', sessionId: 's1', threadId: 't1' });
        client.subscribe({ scope: 'turn', sessionId: 's1', turnId: 'u1' });

        expect(created).toHaveLength(1);

        clock.advance(10_000);
        expect(created).toHaveLength(2);

        created[1]?.onopen?.();

        // All three registrations are re-sent on the new connection: a subscription queued
        // during an outage is never lost.
        expect(
            framesOf(created[1] as Probe)
                .filter((frame) => frame.type === 'subscribe')
                .map((frame) => frame.scope)
        ).toEqual(['session', 'thread', 'turn']);
    });

    it('times out a dial that never completes and re-dials instead of staying `connecting`', () => {
        const created: Probe[] = [];
        const clock = createClock();

        configureHarnessStream({
            socketFactory: () => {
                const probe = createProbe();
                created.push(probe);

                return probe;
            },
            schedule: clock.schedule
        });

        const client = harnessStream();

        client.connect();
        expect(client.status()).toBe('connecting');

        // The upgrade never lands: no `onopen`, no frame, no close — the half-open case a
        // browser gives no event for. The heartbeat deadline is the only clock this client
        // has for the ATTEMPT ITSELF, and it used to no-op unless the state was `open`, so
        // the plane sat in `connecting` forever.
        clock.advance(45_001);

        expect(created[0]?.closeCode).toBe(4408);
        expect(client.status()).toBe('reconnecting');

        clock.advance(10_000);
        expect(created).toHaveLength(2);

        created[1]?.onopen?.();
        created[1]?.deliver(WELCOME());
        expect(client.status()).toBe('open');
    });

    it('re-registers a subscription the server refused, without an unknown-id goodbye', () => {
        const probe = createProbe();

        configureHarnessStream({ socketFactory: () => probe, schedule: createClock().schedule });

        const client = harnessStream();
        const resyncs: string[] = [];

        const sub = client.subscribe({ scope: 'session', sessionId: 's1', onResync: (frame) => resyncs.push(frame.reason) });

        probe.onopen?.();
        probe.deliver(WELCOME());

        // The cursor is older than the replay window: the broker answers `resync_required`
        // and returns BEFORE registering the subscription
        // (../server/stream/broker.ts:749-762). The client used to believe it was
        // subscribed and went blind forever after this frame.
        probe.deliver({
            type: 'resync_required',
            subscription_id: sub.id,
            reason: 'cursor_expired',
            epoch: 'e1',
            cursor: 'cur-9',
            resources: [{ resource: 'turns', id: 's1', revision: 3, epoch: 'e1', link: '/v1/harness/sessions/s1/turns' }]
        });

        expect(resyncs).toEqual(['cursor_expired']);

        const frames = framesOf(probe).filter((frame) => frame.type === 'subscribe' || frame.type === 'unsubscribe');

        // A re-registration with NO cursor (the position is dead, and resending it would be
        // refused again) — and no `unsubscribe`, because the server never held this id: an
        // unknown id is a protocol error that counts toward the three-bad-frames close
        // (../server/stream/connection.ts:305).
        expect(frames).toEqual([
            { type: 'subscribe', subscription_id: sub.id, scope: 'session', session_id: 's1', pace: 'ordered' },
            { type: 'subscribe', subscription_id: sub.id, scope: 'session', session_id: 's1', pace: 'ordered' }
        ]);
    });
});

// ---------------------------------------------------------------------------
// `observeView`: reconciliation and the leak
// ---------------------------------------------------------------------------

describe('observeView reconciliation', () => {
    // Registers the session subscription on the probe and returns its id.
    const openSession = async (probe: Probe): Promise<string> => {
        probe.onopen?.();
        probe.deliver(WELCOME());

        const subscribe = framesOf(probe).find((frame) => frame.type === 'subscribe');
        if (subscribe === undefined) throw new Error('the observer never subscribed');

        const id = String(subscribe.subscription_id);
        probe.deliver(stateFrame(id, 'session', 0, 'cur-0'));

        return id;
    };

    it('re-reads the loaded window exactly once when the re-registered baseline had no replay', async () => {
        const probe = createProbe();
        const clock = createClock();

        configureHarnessStream({ socketFactory: () => probe, schedule: clock.schedule });

        const items: ViewStreamItem[] = [];
        const controller = new AbortController();

        void observeView('s1', (item) => items.push(item), controller.signal);

        const subId = await openSession(probe);

        // A normal streamed frame: an op, never a document (T44 — a document applied here
        // would rebuild the rows the reader is watching).
        probe.deliver({
            type: 'update',
            subscription_id: subId,
            sequence: 1,
            cursor: 'cur-1',
            kind: 'turn.upsert',
            at: 10,
            turn: rowRunning
        });
        await settle();

        expect(items.map((item) => item.type)).toEqual(['ops']);
        // The baseline alone costs no read: the shell opened the window over REST already.
        expect(reads).toEqual([]);

        // The drop, then the reconnect. The drop reconciles nothing by ITSELF (the client
        // is re-registering, and a document applied before that answer can be OLDER than
        // the frames already applied — the N2/T44 hazard), and the fixture's next baseline
        // carries no `replayed_frames`: the replay window expired, so the frames missed
        // during the outage are gone. That is the moment to re-read.
        probe.fireClose(1006);
        await settle();
        expect(items.map((item) => item.type)).toEqual(['ops']);

        probe.sent.length = 0;
        clock.advance(10_000);
        probe.fired = false;
        probe.onopen?.();
        probe.deliver(stateFrame(subId, 'session', 0, 'cur-0'));
        // The SAME registration answered twice (a fixture quirk, and harmless in a real
        // server): the reconcile must still run ONCE, not per baseline.
        probe.deliver(stateFrame(subId, 'session', 0, 'cur-0'));
        await settle();
        await settle();

        expect(items.map((item) => item.type)).toEqual(['ops', 'view']);
        expect(reads.filter((path) => path === '/v1/harness/sessions/s1')).toHaveLength(1);

        // The reconciled document is the windowed one, not a history snapshot.
        const view = items[1];

        if (view === undefined || view.type !== 'view') throw new Error('expected a windowed view item');
        expect(view.view.id).toBe('s1');
        expect(view.view.turns.map((turn) => turn.id)).toEqual(['u1']);

        controller.abort();
    });

    it('does NOT re-read when the re-registered baseline replayed the missed frames', async () => {
        const probe = createProbe();
        const clock = createClock();

        configureHarnessStream({ socketFactory: () => probe, schedule: clock.schedule });

        const items: ViewStreamItem[] = [];
        const controller = new AbortController();

        void observeView('s1', (item) => items.push(item), controller.signal);

        const subId = await openSession(probe);

        probe.fireClose(1006);
        probe.sent.length = 0;
        clock.advance(10_000);
        probe.fired = false;
        probe.onopen?.();

        // Inside the replay window: the server says how much it re-sent, so the pane knows
        // the history arrived and must not throw a document at the rows it just patched.
        probe.deliver(stateFrame(subId, 'session', 2, 'cur-2', { replayed_frames: 2 }));
        await settle();

        expect(items).toEqual([]);
        expect(reads).toEqual([]);

        controller.abort();
    });

    it('releases the registration when the subscription is refused — no entry left to replay', async () => {
        const probe = createProbe();

        configureHarnessStream({ socketFactory: () => probe, schedule: createClock().schedule });

        const client = harnessStream();
        const items: ViewStreamItem[] = [];
        const controller = new AbortController();

        const observation = observeView('s1', (item) => items.push(item), controller.signal);
        let settled = false;

        void observation.then(() => {
            settled = true;
        });

        const subId = await openSession(probe);

        expect(client.subscriptions().map((entry) => entry.id)).toEqual([subId]);

        // The server refuses THIS subscription (an unknown session). The observation ends
        // and the caller's bounded read takes over — and T3's fix is that the entry leaves
        // the client's map with it. It used to stay: `onopen` re-sends every entry on each
        // reconnect, so a settled observer was re-registered forever, eating the 64
        // subscriptions per connection (broker.ts:708) and the resume burst
        // (connection.ts:305) — the leak that made drops look random.
        probe.deliver({
            type: 'error',
            code: 'unknown_resource',
            message: 'No such session',
            subscription_id: subId,
            retryable: false
        });

        await settle();

        expect(settled).toBe(true);
        expect(client.subscriptions()).toEqual([]);
        expect(framesOf(probe)).toContainEqual({ type: 'unsubscribe', subscription_id: subId });
    });

    it('patches ONE roster row for a `thread.upsert` instead of re-reading the roster', async () => {
        const probe = createProbe();

        configureHarnessStream({ socketFactory: () => probe, schedule: createClock().schedule });

        const items: ViewStreamItem[] = [];
        const controller = new AbortController();

        void observeView('s1', (item) => items.push(item), controller.signal);
        const subId = await openSession(probe);

        probe.deliver({
            type: 'update',
            subscription_id: subId,
            sequence: 1,
            cursor: 'cur-1',
            kind: 'thread.upsert',
            at: 11,
            thread: rosterRow
        });
        await settle();

        // The whole row, mapped once through the shell's own normalizer — and ZERO reads.
        // This frame used to cost a full `openSession` (metadata + rows page + roster page
        // + actions) per thread status change, on the hot path of every running board.
        expect(items).toHaveLength(1);

        const item = items[0];

        if (item === undefined || item.type !== 'thread') throw new Error('expected a thread item');

        // T3b: the item is the FRAME, not just the row — the server's own `at` for the
        // mutation and this subscription's resume `cursor` ride with it, because the
        // caller (`./main.ts` `applyThreadRowPatch`) has to be able to tell a live patch
        // from one replayed out of the retention window behind a newer document.
        expect(item).toEqual<ViewStreamItem>({
            type: 'thread',
            threadId: 't1',
            at: 11,
            cursor: 'cur-1',
            row: {
                id: 't1',
                agent: 'instruct',
                origin: 'host',
                status: 'stopped',
                sequence: 0,
                label: 'Root',
                transcriptState: 'ok',
                messageCount: 4,
                hasTranscript: true,
                preview: 'the last entry'
            }
        });
        expect(reads).toEqual([]);

        controller.abort();
    });
});

// ---------------------------------------------------------------------------
// `observeThread`: the per-thread following (R2/R3)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// T3b: `getRawSession`'s transcript composition — the LOSSLESS export reads every
// conversation in the roster, the bounded read names the ones it wants. The lazy
// work moved this fan-out off the load and the board; the export still pays it, and
// these are the two halves of that contract, pinned at the route level.
// ---------------------------------------------------------------------------

describe('the lossless export read', () => {
    // The document's thread rows, in the shape the export builder reads them.
    const threadRowsOf = (document: unknown): [string, unknown][] =>
        ((document as { threads: { id: string; messages: unknown }[] }).threads ?? []).map((row) => [
            row.id,
            row.messages
        ]);

    const transcriptRoutes = (): string[] => reads.filter((entry) => entry.includes('/transcript'));

    it('composes the committed messages of EVERY roster conversation when the caller names none', async () => {
        const document = await getRawSession('s1');

        // `t2` is the conversation this page never opened: its roster row carries only
        // transcript SIGNALS (`message_count`/`preview`), so its `messages` can only be
        // here because the export asked for the whole document — which is the lossless
        // JSON contract (ui/thread-transcript.test.ts) quoting a thread verbatim.
        expect(threadRowsOf(document)).toEqual([
            ['t1', [{ role: 'user', content: 'root prompt' }]],
            ['t2', [{ role: 'assistant', content: 'four words' }]]
        ]);
        expect(transcriptRoutes()).toEqual([
            '/v1/harness/sessions/s1/threads/t1/transcript',
            '/v1/harness/sessions/s1/threads/t1/transcript/document',
            '/v1/harness/sessions/s1/threads/t2/transcript',
            '/v1/harness/sessions/s1/threads/t2/transcript/document'
        ]);
    });

    it('composes exactly the conversations it names, and a stale id costs no request', async () => {
        const document = await getRawSession('s1', ['u1'], ['t2', 'gone']);

        // The unnamed conversation keeps its SIGNAL-ONLY row (the roster is still complete
        // and ordered), and `gone` — an id the roster no longer publishes — is intersected
        // away instead of buying a 404.
        expect(threadRowsOf(document)).toEqual([
            ['t1', []],
            ['t2', [{ role: 'assistant', content: 'four words' }]]
        ]);
        expect(transcriptRoutes()).toEqual([
            '/v1/harness/sessions/s1/threads/t2/transcript',
            '/v1/harness/sessions/s1/threads/t2/transcript/document'
        ]);
    });

    it('reads no transcript at all for an empty selection — the form the load and the board use', async () => {
        const document = await getRawSession('s1', ['u1'], []);

        expect(transcriptRoutes()).toEqual([]);
        expect(threadRowsOf(document)).toEqual([
            ['t1', []],
            ['t2', []]
        ]);
    });
});

describe('observeThread', () => {
    const attach = (probe: Probe): string => {
        const controller = new AbortController();
        const events: string[] = [];
        const rows: { threadId: string; row: ThreadRow }[] = [];

        const done = observeThread('s1', 't1', controller.signal, {
            onThread: (threadId, row) => rows.push({ threadId, row }),
            onTranscript: (threadId) => events.push(`transcript:${threadId}`),
            onResync: (threadId) => events.push(`resync:${threadId}`),
            onError: (message) => events.push(`error:${message}`)
        });

        probe.onopen?.();
        probe.deliver(WELCOME());

        const subscribe = framesOf(probe).find((frame) => frame.type === 'subscribe');

        if (subscribe === undefined) throw new Error('the thread observer never subscribed');

        const id = String(subscribe.subscription_id);
        probe.deliver(stateFrame(id, 'thread', 0, 'cur-t0'));

        return id;
    };

    it('addresses the thread scope with exactly its own ids, no filters and no cursor', () => {
        const probe = createProbe();

        configureHarnessStream({ socketFactory: () => probe, schedule: createClock().schedule });

        const id = attach(probe);

        // `filters` are not published by the thread scope (../server/stream/protocol.ts
        // :111-116 refuses any other with `unsupported_filter`), and a cursor belongs to a
        // RESUME, not to a first registration.
        expect(framesOf(probe)).toEqual([
            {
                type: 'subscribe',
                subscription_id: id,
                scope: 'thread',
                session_id: 's1',
                thread_id: 't1',
                pace: 'ordered'
            }
        ]);
    });

    it('routes transcript and roster frames to the thread that owns them, and releases the subscription on abort', async () => {
        const probe = createProbe();
        const controller = new AbortController();
        const events: string[] = [];
        const rows: { threadId: string; row: ThreadRow }[] = [];

        configureHarnessStream({ socketFactory: () => probe, schedule: createClock().schedule });

        // The singleton must be taken AFTER the factory is configured: `harnessStream()`
        // resolves the transport when the client is CREATED.
        const client = harnessStream();

        void observeThread('s1', 't1', controller.signal, {
            onThread: (threadId, row) => rows.push({ threadId, row }),
            onTranscript: (threadId) => events.push(`transcript:${threadId}`),
            onResync: (threadId) => events.push(`resync:${threadId}`),
            onError: (message) => events.push(`error:${message}`)
        });

        probe.onopen?.();
        probe.deliver(WELCOME());

        const id = String((framesOf(probe)[0] as { subscription_id: string }).subscription_id);
        probe.deliver(stateFrame(id, 'thread', 0, 'cur-t0'));

        // `transcript.updated` carries counts and a revision only — the committed document
        // is the caller's own bounded read. This is the frame that used to justify reading
        // EVERY thread; now it re-reads the one being followed.
        probe.deliver({
            type: 'update',
            subscription_id: id,
            sequence: 1,
            cursor: 'cur-1',
            kind: 'transcript.updated',
            at: 12,
            transcript: { thread_id: 't1', revision: 5, message_count: 6, has_transcript: true, state: 'ok' }
        });

        // A kind the thread scope does not publish is ignored, not guessed at.
        probe.deliver({
            type: 'update',
            subscription_id: id,
            sequence: 2,
            cursor: 'cur-2',
            kind: 'usage.updated',
            at: 13,
            usage_patch: { revision: 2 }
        });

        await settle();

        expect(events).toEqual(['transcript:t1']);
        expect(rows).toEqual([]);

        controller.abort();
        await settle();

        // R3: collapsing stops following — an unsubscribe on the same socket, and the
        // client's registration map is empty again (no entry left to re-send forever).
        expect(framesOf(probe)).toContainEqual({ type: 'unsubscribe', subscription_id: id });
        expect(client.subscriptions()).toEqual([]);
    });

    it('reports a lost position for its own thread, and never for another subscription', async () => {
        const probe = createProbe();
        const controller = new AbortController();
        const events: string[] = [];

        configureHarnessStream({ socketFactory: () => probe, schedule: createClock().schedule });

        void observeThread('s1', 't1', controller.signal, {
            onResync: (threadId) => events.push(`resync:${threadId}`)
        });

        probe.onopen?.();
        probe.deliver(WELCOME());

        const id = String((framesOf(probe)[0] as { subscription_id: string }).subscription_id);
        probe.deliver(stateFrame(id, 'thread', 0, 'cur-t0'));

        // The drop notification is addressed per subscription: the thread pane learns that
        // ITS live position is gone and re-reads the one document it is showing (R4).
        probe.fireClose(1006);
        await settle();

        expect(events).toEqual(['resync:t1']);

        controller.abort();
    });

    // T3b (finding 2): the row patch must arrive WITH the stamp that dates it, or the
    // caller cannot tell a live patch from one replayed behind a newer document.
    it('hands the roster row over together with the frame stamp that dates it', async () => {
        const probe = createProbe();
        const controller = new AbortController();
        const rows: { threadId: string; row: ThreadRow; stamp: { at: number; cursor: string } }[] = [];

        configureHarnessStream({ socketFactory: () => probe, schedule: createClock().schedule });

        void observeThread('s1', 't1', controller.signal, {
            onThread: (threadId, row, stamp) => rows.push({ threadId, row, stamp })
        });

        probe.onopen?.();
        probe.deliver(WELCOME());

        const id = String((framesOf(probe)[0] as { subscription_id: string }).subscription_id);
        probe.deliver(stateFrame(id, 'thread', 0, 'cur-t0'));

        probe.deliver({
            type: 'update',
            subscription_id: id,
            sequence: 1,
            cursor: 'cur-9',
            kind: 'thread.upsert',
            at: 41,
            thread: { ...rosterRow, status: 'idle', message_count: 9, preview: 'the settled answer' }
        });

        await settle();

        expect(rows).toEqual([
            {
                threadId: 't1',
                row: {
                    id: 't1',
                    agent: 'instruct',
                    origin: 'host',
                    status: 'idle',
                    sequence: 0,
                    label: 'Root',
                    transcriptState: 'ok',
                    messageCount: 9,
                    hasTranscript: true,
                    preview: 'the settled answer'
                },
                stamp: { at: 41, cursor: 'cur-9' }
            }
        ]);

        controller.abort();
    });
});

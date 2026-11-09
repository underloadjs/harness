// The `harness.v1` stream client (./stream.ts) — protocol behaviour, asserted on
// exact frames. No network and no timers run: the socket is a double and the
// scheduler is manual, so every assertion below is about a frame this client sent
// or a state it entered, at a moment the test chose.
//
// The contract facts under test (../shared/harness-stream.ts + the spec's
// `x-websocket` section):
//   - one connection, subprotocol `harness.v1`, at `${canonicalRoot}/stream`;
//   - `hello` is the ONLY resume input and is sent only when there is a position;
//   - `subscribe` per scope carries exactly that scope's ids;
//   - a `sequence` gap is a client-detected loss -> unsubscribe + re-subscribe with
//     the last cursor, and the pane is told (`frames_dropped`);
//   - `pace: 'ack'` acks the highest APPLIED sequence;
//   - three missed heartbeat intervals closes with 4408 and redials;
//   - `close()` says `bye` and never cancels work (it sends no task frame at all).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHarnessStream } from './stream';
import type { StreamSocket, StreamSocketFactory } from './stream';
import type { WsServerMessage } from '../shared/harness-stream';

// The socket double: it records what was sent and lets the test deliver a frame.
type Probe = StreamSocket & { sent: string[]; deliver(value: unknown): void };

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
        close: (code?: number, reason?: string): void => {
            probe.closeCode = code;
            probe.closeReason = reason;
        },
        deliver: (value: unknown): void => {
            probe.onmessage?.({ data: JSON.stringify(value) });
        },
        closeCode: undefined as number | undefined,
        closeReason: undefined as string | undefined
    };

    return probe;
};

// A scheduler the test drives by hand, so a heartbeat deadline and a reconnect
// backoff fire exactly when the assertion needs them.
const createClock = (): { schedule: (fn: () => void, ms: number) => () => void; advance: (ms: number) => void } => {
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

            for (const task of [...tasks].sort((a, b) => a.at - b.at)) {
                if (task.at > now) continue;

                const index = tasks.findIndex((candidate) => candidate.id === task.id);
                if (index >= 0) tasks.splice(index, 1);
                task.fn();
            }
        }
    };
};

// The welcome every connection starts with, in the shape the contract publishes.
const WELCOME = (epoch = 'e1'): WsServerMessage => ({
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
        replay_frames: 512,
        replay_seconds: 60,
        send_queue_frames: 256,
        send_queue_bytes: 1048576,
        sustained_stall_ms: 10000,
        ack_timeout_ms: 5000,
        revision_records_per_state: 20
    }
});

const framesOf = (probe: Probe): unknown[] => probe.sent.map((text) => JSON.parse(text));

describe('harness stream client', () => {
    let originalWebSocket: unknown;

    beforeEach(() => {
        originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
    });

    afterEach(() => {
        (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
        vi.restoreAllMocks();
    });

    it('dials the canonical stream path with the harness.v1 subprotocol', () => {
        const probe = createProbe();
        const seen: string[] = [];
        const factory: StreamSocketFactory = (url, protocol) => {
            seen.push(`${url} ${protocol}`);

            return probe;
        };

        const client = createHarnessStream({ socketFactory: factory });
        client.connect();

        // One entry, exactly the canonical path under the resolved root, and the
        // negotiated subprotocol — not `Sec-WebSocket-Protocol` in a query string.
        expect(seen).toEqual([`ws://${location.host}/v1/harness/stream harness.v1`]);
    });

    it('stays closed with no transport instead of falling back to anything', () => {
        // An explicit mock rule the task states: a missing WebSocket is handled by a
        // factory the test supplies, never by an SSE fallback the contract removed.
        (globalThis as { WebSocket?: unknown }).WebSocket = undefined;

        const client = createHarnessStream();
        client.connect();

        expect(client.status()).toBe('closed');
        expect(client.subscriptions()).toEqual([]);
    });

    it('sends no hello on a first connection, and queues a subscribe until open', () => {
        const probe = createProbe();
        const client = createHarnessStream({ socketFactory: () => probe });

        client.connect();
        const sub = client.subscribe({ scope: 'session', sessionId: 's1' });

        // Nothing is on the wire before the upgrade completes: a subscribe sent on a
        // CONNECTING socket would be a frame the server never ordered.
        expect(probe.sent).toEqual([]);

        probe.onopen?.();
        probe.deliver(WELCOME());

        // No `hello`: this client has no epoch/cursor pair to resume from, so the
        // server starts the subscription at its own current position.
        expect(framesOf(probe)).toEqual([
            {
                type: 'subscribe',
                subscription_id: sub.id,
                scope: 'session',
                session_id: 's1',
                pace: 'ordered'
            }
        ]);
    });

    it('addresses each scope with exactly its own ids', () => {
        const probe = createProbe();
        const client = createHarnessStream({ socketFactory: () => probe });

        client.connect();
        client.subscribe({ scope: 'global' });
        client.subscribe({ scope: 'session', sessionId: 's1' });
        client.subscribe({ scope: 'thread', sessionId: 's1', threadId: 't1' });
        client.subscribe({ scope: 'turn', sessionId: 's1', turnId: 'u1' });

        probe.onopen?.();
        probe.deliver(WELCOME());

        const frames = framesOf(probe) as { type: string; scope: string; session_id?: string; thread_id?: string; turn_id?: string }[];

        expect(frames.map((frame) => [frame.scope, frame.session_id, frame.thread_id, frame.turn_id])).toEqual([
            ['global', undefined, undefined, undefined],
            ['session', 's1', undefined, undefined],
            ['thread', 's1', 't1', undefined],
            ['turn', 's1', undefined, 'u1']
        ]);
    });

    it('resumes with a hello naming the last epoch and cursor after a drop', () => {
        const probe = createProbe();
        const clock = createClock();
        const client = createHarnessStream({ socketFactory: () => probe, schedule: clock.schedule });

        const sub = client.subscribe({ scope: 'session', sessionId: 's1' });
        probe.onopen?.();
        probe.deliver(WELCOME());
        probe.deliver({
            type: 'subscription_state',
            subscription_id: sub.id,
            scope: 'session',
            epoch: 'e1',
            sequence: 4,
            cursor: 'Y3Vyc29yLTQ',
            revisions: [],
            publishes: ['turn.upsert']
        });

        // The connection drops (a restart, a lost heartbeat, a laptop lid).
        probe.onclose?.({ code: 1006 });
        expect(client.status()).toBe('reconnecting');

        clock.advance(10_000);
        const redial = probe;

        expect(framesOf(redial).length).toBeGreaterThan(0);

        // Resume input is `hello` only, and it is the FIRST frame of the connection.
        redial.sent.length = 0;
        redial.sent.push(JSON.stringify({ marker: 'flushed' }));
        redial.onopen?.();

        expect(framesOf(redial).slice(1)).toEqual([
            { type: 'hello', protocol: 'harness.v1', epoch: 'e1', cursor: 'Y3Vyc29yLTQ' },
            { type: 'subscribe', subscription_id: sub.id, scope: 'session', session_id: 's1', pace: 'ordered', cursor: 'Y3Vyc29yLTQ' }
        ]);
    });

    it('detects a sequence gap, re-subscribes that subscription, and says so', () => {
        const probe = createProbe();
        const resyncs: string[] = [];
        const client = createHarnessStream({ socketFactory: () => probe });

        const sub = client.subscribe({
            scope: 'session',
            sessionId: 's1',
            onResync: (frame) => resyncs.push(frame.reason)
        });

        probe.onopen?.();
        probe.deliver(WELCOME());
        probe.deliver({
            type: 'subscription_state',
            subscription_id: sub.id,
            scope: 'session',
            epoch: 'e1',
            sequence: 1,
            cursor: 'c1',
            revisions: [],
            publishes: ['turn.upsert']
        });

        // Sequence 4 arrives when 2 was next: two frames were lost.
        probe.deliver({
            type: 'update',
            subscription_id: sub.id,
            sequence: 4,
            cursor: 'c4',
            kind: 'turn.upsert',
            at: 1,
            turn: { id: 'u9', index: 8, promptPreview: 'p', promptChars: 1, state: 'queued', status: 'queued', sectionCount: 0, stepCount: 0, activeAgents: [], blocks: [], updatedAt: 1 }
        });

        expect(resyncs).toEqual(['frames_dropped']);

        // Recovery is scoped to the ONE subscription: unsubscribe then subscribe
        // again from the last cursor. Never a snapshot, never a whole-session reload.
        const tail = framesOf(probe).slice(-2) as { type: string; subscription_id: string; cursor?: string }[];

        expect(tail.map((frame) => frame.type)).toEqual(['unsubscribe', 'subscribe']);
        expect(tail[0].subscription_id).toBe(sub.id);
        // Resume from the last frame this client APPLIED (`c1`), not from `c4`: the
        // frame that revealed the loss has itself not been applied, so replaying from
        // it would skip 2 and 3 forever.
        expect(tail[1].cursor).toBe('c1');
    });

    it('acks only a subscription that asked for ack pacing', () => {
        const probe = createProbe();
        const client = createHarnessStream({ socketFactory: () => probe });

        const paced = client.subscribe({ scope: 'turn', sessionId: 's1', turnId: 'u1', pace: 'ack' });
        const plain = client.subscribe({ scope: 'session', sessionId: 's1' });

        probe.onopen?.();
        probe.deliver(WELCOME());

        const update = (subscriptionId: string, sequence: number): void => {
            probe.deliver({
                type: 'update',
                subscription_id: subscriptionId,
                sequence,
                cursor: `c${sequence}`,
                kind: 'session.updated',
                at: 1,
                session: { id: 's1', revision: sequence }
            });
        };

        update(paced.id, 1);
        update(plain.id, 1);

        expect(framesOf(probe)).toContainEqual({ type: 'ack', subscription_id: paced.id, sequence: 1 });
        expect(framesOf(probe).filter((frame) => (frame as { type: string }).type === 'ack')).toHaveLength(1);
    });

    it('treats three silent heartbeat intervals as a dead connection and redials', () => {
        const probe = createProbe();
        const clock = createClock();
        const client = createHarnessStream({ socketFactory: () => probe, schedule: clock.schedule });

        client.connect();
        probe.onopen?.();
        probe.deliver(WELCOME());

        // 15000ms * 3 intervals, with nothing arriving at all.
        // The deadline is `heartbeat_interval_ms * heartbeat_timeout_intervals` =
        // 45000ms with the contract's defaults, and nothing arrives at all.
        clock.advance(45_001);

        expect(probe.closeCode).toBe(4408);
    });

    it('says bye and releases subscriptions on close, without touching a task', () => {
        const probe = createProbe();
        const client = createHarnessStream({ socketFactory: () => probe });

        const sub = client.subscribe({ scope: 'session', sessionId: 's1' });
        probe.onopen?.();
        probe.deliver(WELCOME());

        client.close('navigating away');

        expect(framesOf(probe)).toEqual([
            { type: 'subscribe', subscription_id: sub.id, scope: 'session', session_id: 's1', pace: 'ordered' },
            { type: 'bye', reason: 'navigating away' }
        ]);
        expect(probe.closeCode).toBe(1000);
        expect(client.status()).toBe('closed');
        expect(client.subscriptions()).toEqual([]);
    });

    it('keeps working when the server refuses one subscription', () => {
        const probe = createProbe();
        const errors: string[] = [];
        const client = createHarnessStream({ socketFactory: () => probe });

        const sub = client.subscribe({ scope: 'session', sessionId: 's1', onError: (error) => errors.push(error.code) });
        const other = client.subscribe({ scope: 'global' });

        probe.onopen?.();
        probe.deliver(WELCOME());
        probe.deliver({
            type: 'error',
            code: 'unknown_resource',
            message: 'No such session',
            subscription_id: sub.id,
            retryable: false
        });

        // The refused pane is told; the connection and its other subscriptions live.
        expect(errors).toEqual(['unknown_resource']);
        expect(client.status()).toBe('open');
        expect(client.subscriptions().map((entry) => entry.id)).toEqual([sub.id, other.id]);
    });

    it('ignores a frame it cannot tag instead of closing the connection', () => {
        const probe = createProbe();
        const unknown: unknown[] = [];
        const client = createHarnessStream({
            socketFactory: () => probe,
            handlers: { onUnknownFrame: (value) => unknown.push(value) }
        });

        client.connect();
        probe.onopen?.();
        probe.deliver(WELCOME());
        probe.deliver({ type: 'some_future_frame' });

        expect(unknown).toEqual([{ type: 'some_future_frame' }]);
        expect(client.status()).toBe('open');
    });

    // T3b (finding 5): the goodbye is a registration release, so it goes only when the
    // server holds the registration. `registered` is populated by the `subscription_state`
    // anchor — the same knowledge `reregister` uses — and an id the server never acked
    // would buy one `unknown_subscription` error frame
    // (../server/stream/broker.ts:810) for nothing.
    it('releases a subscription the server acknowledged, and sends nothing for one it never saw', () => {
        const probe = createProbe();
        const client = createHarnessStream({ socketFactory: () => probe });

        const acked = client.subscribe({ scope: 'session', sessionId: 's1' });
        const queued = client.subscribe({ scope: 'global' });

        probe.onopen?.();
        probe.deliver(WELCOME());
        // ONLY the first registration gets its baseline: the second stands for one the
        // server never acknowledged (refused, or still queued when the pane closed).
        probe.deliver({
            type: 'subscription_state',
            subscription_id: acked.id,
            scope: 'session',
            epoch: 'e1',
            sequence: 1,
            cursor: 'Y3Vyc29yLTE',
            revisions: [],
            publishes: ['turn.upsert']
        });

        acked.unsubscribe();
        queued.unsubscribe();

        expect(framesOf(probe)).toEqual([
            { type: 'subscribe', subscription_id: acked.id, scope: 'session', session_id: 's1', pace: 'ordered' },
            { type: 'subscribe', subscription_id: queued.id, scope: 'global', pace: 'ordered' },
            { type: 'unsubscribe', subscription_id: acked.id }
        ]);
        expect(client.subscriptions()).toEqual([]);
    });

    // T3b (finding 3): the rate limit that keeps a live-data caller from defeating the
    // backoff. The board's follow sync runs on every roster frame, and an unthrottled
    // force there cancels the pending backoff and re-dials per frame — a schedule that is
    // supposed to top out at one attempt per 10s becomes one per poll tick, against the
    // 32 messages/second budget that closes 4429.
    it('forceReconnectOnce spends one dial per outage, re-arms when the plane opens, and leaves refresh unthrottled', () => {
        const probes: Probe[] = [];
        const clock = createClock();
        const client = createHarnessStream({
            socketFactory: () => {
                const probe = createProbe();
                probes.push(probe);

                return probe;
            },
            schedule: clock.schedule
        });

        client.connect();
        probes[0]?.onopen?.();
        probes[0]?.deliver(WELCOME());
        expect(client.status()).toBe('open');

        // The outage: a backoff is pending, and nothing dials until it fires or something
        // forces it.
        probes[0]?.onclose?.({ code: 1006 });
        expect(client.status()).toBe('reconnecting');

        // The FIRST forced attempt dials; every later one in the same down period is
        // refused, so the pending backoff survives intact.
        client.forceReconnectOnce();
        client.forceReconnectOnce();
        client.forceReconnectOnce();

        expect(probes).toHaveLength(2);
        expect(client.status()).toBe('reconnecting');

        // The plane comes back. The allowance re-arms on `open`, and a subscribe that
        // arrives in the `connecting` window is still queued, not dialled.
        probes[1]?.onopen?.();
        probes[1]?.deliver(WELCOME());
        expect(client.status()).toBe('open');

        client.forceReconnectOnce();
        expect(probes).toHaveLength(2);

        // A second outage forces again — the limit is per outage, not per page.
        probes[1]?.onclose?.({ code: 1006 });
        client.forceReconnectOnce();
        expect(probes).toHaveLength(3);

        // `refresh` stays the unthrottled human path (the Retry affordance, and the app's
        // own "the browser is reachable again" signal): every call dials.
        probes[2]?.onclose?.({ code: 1006 });
        client.refresh();
        client.refresh();
        expect(probes).toHaveLength(5);
    });
});

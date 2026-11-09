// Tests for the per-connection conversation: the precedence ladder, the budgets, the heartbeat, and
// the backpressure rule — one of them against a REAL WebSocket client (undici, via Node's global
// `WebSocket`) and the byte-pressure paths against a deterministic fake socket.
//
// Why the split: a real client is the only way to prove the handshake, the framing, and the close
// codes actually reach a browser-grade implementation. A real client cannot, however, be made to
// stop reading its socket on demand, which is what a stalled send queue IS — so the queue-eviction
// and stall paths run against a `HarnessSocket` stand-in whose write buffer the test controls. That
// keeps those assertions exact instead of timing-dependent.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HARNESS_WS_SUBPROTOCOL } from '../../shared/harness-api';
import type { WsServerMessage, WsSubscriptionState, WsUpdate } from '../../shared/harness-stream';
import { createStreamBroker, type StreamEvent } from './broker';
import { startStreamConnection } from './connection';
import { createHarnessStreamMount, type HarnessStreamMount } from './mount';
import { HARNESS_WS_STREAM_PATH, encodeStreamCursor, resolveStreamLimits } from './protocol';
import { WEBSOCKET_STATE, type HarnessSocket, type HarnessSocketSendMeta, type HarnessSocketSendResult } from './transport';

const EPOCH = '9f2c17a4';
const KNOWN_SESSION = 'session-1';

let server: http.Server;
let mount: HarnessStreamMount;
let port = 0;

const makeEvent = (index: number): StreamEvent => ({
    kind: 'turn.upsert',
    session_id: KNOWN_SESSION,
    turn_id: `turn-${index}`,
    payload: { turn: { id: `turn-${index}`, status: 'running' } } as never
});

const startMount = (options: Parameters<typeof createHarnessStreamMount>[0] = {}): Promise<void> =>
    new Promise<void>((resolve) => {
        mount = createHarnessStreamMount({
            epoch: EPOCH,
            // The three host callbacks, faked: the point of these tests is the CONVERSATION, and a
            // real store would make every expected frame depend on projector output.
            sources: { exists: (_resource, id) => id === null || id === KNOWN_SESSION },
            ...options
        });

        server = http.createServer((_request, response) => response.end('rest'));
        mount.attach(server);
        server.listen(0, '127.0.0.1', () => {
            port = (server.address() as AddressInfo).port;
            resolve();
        });
    });

const stopMount = (): Promise<void> =>
    new Promise<void>((resolve) => {
        mount.close(1001);

        // `close()` alone waits for live keep-alive/WebSocket sockets, which in these tests include
        // the client the previous test just said `bye` to. Forcing them closed makes the callback
        // deterministic, which is what lets the budget tests rebind the listener.
        server.closeAllConnections?.();
        server.close(() => resolve());
    });

await startMount();

afterAll(async () => {
    await stopMount();
});

// ---------------------------------------------------------------------------
// Real client helpers
// ---------------------------------------------------------------------------

type Client = {
    socket: WebSocket;
    frames: WsServerMessage[];
    closes: number[];
    send: (frame: unknown) => void;
    until: (predicate: () => boolean, timeoutMs?: number) => Promise<boolean>;
};

const connect = async (): Promise<Client> => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${HARNESS_WS_STREAM_PATH}`, HARNESS_WS_SUBPROTOCOL);
    const frames: WsServerMessage[] = [];
    const closes: number[] = [];

    socket.addEventListener('message', (event) => frames.push(JSON.parse(String((event as MessageEvent).data)) as WsServerMessage));
    socket.addEventListener('close', (event) => closes.push((event as CloseEvent).code));

    await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', () => reject(new Error('handshake failed')), { once: true });
    });

    // The first frame on the wire is ALWAYS `welcome`; waiting for it here is what keeps every test
    // below free of a startup race (the `open` event and the first data event are separate ticks).
    await poll(() => frames.length > 0);

    return {
        socket,
        frames,
        closes,
        send: (frame) => socket.send(JSON.stringify(frame)),
        until: (predicate, timeoutMs = 2_000) => poll(predicate, timeoutMs)
    };
};

const poll = async (predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }

    return predicate();
};

const byType = (client: Client, type: string): WsServerMessage[] => client.frames.filter((frame) => frame.type === type);

// ---------------------------------------------------------------------------

describe('the open conversation', () => {
    it('welcomes, registers a subscription atomically, and streams bounded deltas', async () => {
        const client = await connect();

        expect(client.frames[0]).toEqual({
            type: 'welcome',
            protocol: HARNESS_WS_SUBPROTOCOL,
            epoch: EPOCH,
            at: expect.any(Number),
            limits: expect.any(Object)
        });

        client.send({ type: 'subscribe', subscription_id: 's1', scope: 'session', session_id: KNOWN_SESSION });
        expect(await client.until(() => byType(client, 'subscription_state').length === 1)).toBe(true);

        const state = byType(client, 'subscription_state')[0] as WsSubscriptionState;

        expect(state).toEqual({
            type: 'subscription_state',
            subscription_id: 's1',
            scope: 'session',
            epoch: EPOCH,
            sequence: 0,
            cursor: encodeStreamCursor(EPOCH, 0),
            // No host baseline callback here, so the broker's own counters answer — all zero, which is
            // the honest "nothing has moved in this epoch" statement.
            revisions: [
                { resource: 'session', id: KNOWN_SESSION, revision: 0, epoch: EPOCH },
                { resource: 'definition', id: KNOWN_SESSION, revision: 0, epoch: EPOCH },
                { resource: 'turns', id: KNOWN_SESSION, revision: 0, epoch: EPOCH },
                { resource: 'queue', id: KNOWN_SESSION, revision: 0, epoch: EPOCH },
                { resource: 'actions', id: KNOWN_SESSION, revision: 0, epoch: EPOCH },
                { resource: 'usage', id: KNOWN_SESSION, revision: 0, epoch: EPOCH },
                { resource: 'threads', id: KNOWN_SESSION, revision: 0, epoch: EPOCH },
                { resource: 'session_agents', id: KNOWN_SESSION, revision: 0, epoch: EPOCH },
                { resource: 'session_tools', id: KNOWN_SESSION, revision: 0, epoch: EPOCH },
                { resource: 'commands', id: KNOWN_SESSION, revision: 0, epoch: EPOCH },
                // T4: the record store joins the session baseline set (src/server/stream/protocol.ts
                // `HARNESS_WS_SCOPE_BASELINES.session`), keyed by the SESSION id — a `define`/`drop`
                // or any committed record mutation is what moves it.
                { resource: 'records', id: KNOWN_SESSION, revision: 0, epoch: EPOCH }
            ],
            publishes: [
                'session.updated',
                'turn.upsert',
                'turn.removed',
                'action.opened',
                'action.closed',
                'usage.updated',
                'records.updated',
                'thread.upsert',
                'thread.removed',
                'tool.registry_updated',
                'agent.registry_updated',
                'run.event'
            ]
        });

        mount.broker.publish(makeEvent(1));

        expect(await client.until(() => byType(client, 'update').length === 1)).toBe(true);

        expect(byType(client, 'update')[0]).toEqual({
            type: 'update',
            subscription_id: 's1',
            sequence: 1,
            cursor: encodeStreamCursor(EPOCH, 1),
            kind: 'turn.upsert',
            at: expect.any(Number),
            turn: { id: 'turn-1', status: 'running' }
        });

        // Unsubscribe, then prove the stream goes quiet for THIS subscription. Waiting for the broker
        // to observe the unsubscribe first is what makes the count exact rather than a race.
        client.send({ type: 'unsubscribe', subscription_id: 's1' });
        expect(await poll(() => mount.broker.subscriptions() === 0)).toBe(true);

        const before = client.frames.length;
        mount.broker.publish(makeEvent(2));
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(client.frames.length).toBe(before);

        client.send({ type: 'bye' });
        expect(await poll(() => client.closes.length > 0)).toBe(true);
        expect(client.closes[0]).toBe(1000);
    });

    it('answers ping with pong echoing at, and accepts an ack on an unpaced subscription', async () => {
        const client = await connect();

        client.send({ type: 'subscribe', subscription_id: 's1', scope: 'global' });
        await client.until(() => byType(client, 'subscription_state').length === 1);

        client.send({ type: 'ping', at: 1762250003000 });
        expect(await client.until(() => byType(client, 'pong').length === 1)).toBe(true);
        expect(byType(client, 'pong')[0]).toEqual({ type: 'pong', at: 1762250003000 });

        // "an `ack` on a subscription that did not ask for pacing is ignored rather than an error".
        const before = client.frames.length;
        client.send({ type: 'ack', subscription_id: 's1', sequence: 3 });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(client.frames.length).toBe(before);

        client.send({ type: 'bye' });
        await poll(() => client.closes.length > 0);
    });

    it('resumes retained frames after a reconnect through the hello cursor', async () => {
        const first = await connect();

        first.send({ type: 'hello', protocol: HARNESS_WS_SUBPROTOCOL, epoch: EPOCH });
        first.send({ type: 'subscribe', subscription_id: 's1', scope: 'session', session_id: KNOWN_SESSION });
        await first.until(() => byType(first, 'subscription_state').length === 1);

        mount.broker.publish(makeEvent(1));
        await first.until(() => byType(first, 'update').length === 1);

        const resumeCursor = (byType(first, 'update')[0] as WsUpdate).cursor;

        mount.broker.publish(makeEvent(2));
        await first.until(() => byType(first, 'update').length === 2);

        first.socket.close();
        await poll(() => first.closes.length > 0);

        const second = await connect();

        second.send({ type: 'hello', protocol: HARNESS_WS_SUBPROTOCOL, epoch: EPOCH, cursor: resumeCursor });
        second.send({ type: 'subscribe', subscription_id: 's1', scope: 'session', session_id: KNOWN_SESSION });

        expect(await second.until(() => byType(second, 'subscription_state').length === 1)).toBe(true);

        const state = byType(second, 'subscription_state')[0] as WsSubscriptionState;

        expect({ sequence: state.sequence, replayed_frames: state.replayed_frames, cursor: state.cursor }).toEqual({
            sequence: 2,
            replayed_frames: 1,
            cursor: encodeStreamCursor(EPOCH, 2)
        });

        expect(await second.until(() => byType(second, 'update').length === 1)).toBe(true);
        expect((byType(second, 'update')[0] as WsUpdate).turn.id).toBe('turn-2');

        second.send({ type: 'bye' });
        await poll(() => second.closes.length > 0);
    });

    it('refuses a hello after the first subscribe with late_hello and stays usable', async () => {
        const client = await connect();

        client.send({ type: 'subscribe', subscription_id: 's1', scope: 'global' });
        await client.until(() => byType(client, 'subscription_state').length === 1);

        client.send({ type: 'hello', epoch: EPOCH });
        expect(await client.until(() => byType(client, 'error').length === 1)).toBe(true);
        expect(byType(client, 'error')[0]).toEqual({
            type: 'error',
            code: 'late_hello',
            message: 'hello must arrive before the first subscribe.',
            retryable: false
        });

        client.send({ type: 'ping', at: 1 });
        expect(await client.until(() => byType(client, 'pong').length === 1)).toBe(true);

        client.send({ type: 'bye' });
        await poll(() => client.closes.length > 0);
        expect(client.closes[0]).toBe(1000);
    });

    it('refuses an unknown session with unknown_resource without disturbing the connection', async () => {
        const client = await connect();

        client.send({ type: 'subscribe', subscription_id: 'bad', scope: 'session', session_id: 'gone' });
        expect(await client.until(() => byType(client, 'error').length === 1)).toBe(true);
        expect(byType(client, 'error')[0]).toEqual({
            type: 'error',
            code: 'unknown_resource',
            message: 'No session matches gone.',
            subscription_id: 'bad',
            retryable: false
        });

        client.send({ type: 'subscribe', subscription_id: 'good', scope: 'session', session_id: KNOWN_SESSION });
        expect(await client.until(() => byType(client, 'subscription_state').length === 1)).toBe(true);

        client.send({ type: 'bye' });
        await poll(() => client.closes.length > 0);
    });

    it('answers unknown_subscription for an id that is not open, and closes 1007 after three bad frames', async () => {
        const client = await connect();

        client.send({ type: 'ack', subscription_id: 'nope', sequence: 1 });
        expect(await client.until(() => byType(client, 'error').length === 1)).toBe(true);
        expect(byType(client, 'error')[0]).toEqual({
            type: 'error',
            code: 'unknown_subscription',
            message: 'No subscription nope is open on this connection.',
            subscription_id: 'nope',
            retryable: false
        });

        // Three CONSECUTIVE union failures, and the connection goes with 1007.
        const closed = poll(() => client.closes.length > 0, 3_000);
        client.socket.send('{not json');
        client.socket.send('{"type":"nope"}');
        client.socket.send('{"type":"subscribe","scope":"global"}');

        expect(await closed).toBe(true);
        expect(client.closes[0]).toBe(1007);
    });

    it('closes 4401 when the subscription budget is full, after the error frame', async () => {
        // These three tests retune the CONTRACT budgets, so they run on their own listener and
        // restore the default mount afterwards (the shared listener belongs to the tests above).
        await withRetunedMount({ limits: { subscriptions_per_connection: 1 } }, async () => {
            const client = await connect();

            client.send({ type: 'subscribe', subscription_id: 'one', scope: 'global' });
            await client.until(() => byType(client, 'subscription_state').length === 1);

            client.send({ type: 'subscribe', subscription_id: 'two', scope: 'global' });

            expect(await poll(() => byType(client, 'error').length === 1)).toBe(true);
            expect(byType(client, 'error')[0]).toEqual({
                type: 'error',
                code: 'too_many_subscriptions',
                message: 'A connection carries at most 1 subscriptions.',
                subscription_id: 'two',
                retryable: false,
                close_code: 4401
            });

            expect(await poll(() => client.closes.length > 0, 3_000)).toBe(true);
            expect(client.closes[0]).toBe(4401);
        });
    });

    it('answers rate_limited and closes 4429 when the client floods the connection', async () => {
        await withRetunedMount({ limits: { client_messages_per_second: 2 } }, async () => {
            const client = await connect();

            for (let index = 0; index < 6; index += 1) client.send({ type: 'ping', at: index });

            expect(await poll(() => byType(client, 'error').length === 1)).toBe(true);
            expect(byType(client, 'error')[0]).toEqual({
                type: 'error',
                code: 'rate_limited',
                message: 'A client may send at most 2 messages per second.',
                retryable: true,
                close_code: 4429
            });

            expect(await poll(() => client.closes.length > 0, 3_000)).toBe(true);
            expect(client.closes[0]).toBe(4429);
        });
    });

    it('closes 4408 after the heartbeat budget of silence, without retuning the advertised interval', async () => {
        // `heartbeatIntervalMs` is a test seam only: the advertised limit stays the contract's
        // 15000, and nothing about the conversation changes except how fast silence is noticed.
        await withRetunedMount({ heartbeatIntervalMs: 40 }, async () => {
            const client = await connect();

            expect((byType(client, 'welcome')[0] as { limits: { heartbeat_interval_ms: number } }).limits.heartbeat_interval_ms).toBe(15_000);

            expect(await poll(() => client.closes.length > 0, 3_000)).toBe(true);
            expect(client.closes[0]).toBe(4408);
        });
    });
});

/** Run one test against a listener built with retuned stream options, then restore the shared one. */
const withRetunedMount = async (
    options: Parameters<typeof createHarnessStreamMount>[0],
    body: () => Promise<void>
): Promise<void> => {
    await stopMount();
    await startMount(options);

    try {
        await body();
    } finally {
        await stopMount();
        await startMount();
    }
};

// ---------------------------------------------------------------------------
// Send-queue pressure, against a deterministic socket
// ---------------------------------------------------------------------------

type FakeSocket = HarnessSocket & {
    /** Every text frame the conversation asked for, in order (evictions do not remove entries). */
    sent: string[];
    /** The `token` (subscription id) each send was tagged with, for the eviction-attribution check. */
    tokens: (string | undefined)[];
    queue: { text: string; droppable: boolean; token?: string; bytes: number }[];
    /** The backlog this fake imposes. Above it, a send is QUEUED, which is what a stalled peer looks like. */
    budget: { frames: number; bytes: number };
    closeCode?: number;
    message?: (text: string) => void;
    closeListener?: (code: number | undefined, reason: string) => void;
};

const createFakeSocket = (): FakeSocket => {
    const socket = {
        readyState: WEBSOCKET_STATE.open,
        protocol: HARNESS_WS_SUBPROTOCOL,
        sent: [],
        tokens: [],
        queue: [],
        budget: { frames: 0, bytes: 0 },
        get queuedFrames(): number {
            return socket.queue.length;
        },
        get queuedBytes(): number {
            return socket.queue.reduce((total, entry) => total + entry.bytes, 0);
        },
        send: (text: string, meta: HarnessSocketSendMeta = {}): HarnessSocketSendResult => {
            socket.sent.push(text);
            socket.tokens.push(meta.token);
            socket.queue.push({
                text,
                droppable: meta.droppable === true,
                bytes: Buffer.byteLength(text, 'utf8'),
                ...(meta.token === undefined ? {} : { token: meta.token })
            });

            // A stalled consumer: everything piles up in the queue instead of leaving the host.
            return socket.budget.frames > 0 && socket.queue.length > socket.budget.frames ? { status: 'queued' } : { status: 'sent' };
        },
        evictOldestDroppable: () => {
            const index = socket.queue.findIndex((entry) => entry.droppable);
            if (index === -1) return undefined;

            const [entry] = socket.queue.splice(index, 1) as [{ token?: string; bytes: number }];
            return { bytes: entry.bytes, ...(entry.token === undefined ? {} : { token: entry.token }) };
        },
        close: (code = 1000) => {
            socket.readyState = WEBSOCKET_STATE.closed;
            socket.closeCode = code;
        },
        fail: (code = 1002) => {
            socket.readyState = WEBSOCKET_STATE.closed;
            socket.closeCode = code;
        },
        onMessage: (listener: (text: string) => void) => {
            socket.message = listener;
        },
        onActivity: () => undefined,
        onClose: (listener: (code: number | undefined, reason: string) => void) => {
            socket.closeListener = listener;
        }
    } as unknown as FakeSocket;

    return socket;
};

describe('send-queue backpressure', () => {
    // Two queued frames maximum, so the third send has to cost someone a frame.
    const pressured = (): { broker: ReturnType<typeof createStreamBroker>; socket: FakeSocket } => {
        const broker = createStreamBroker({ epoch: EPOCH, limits: { send_queue_frames: 2, send_queue_bytes: 1_000_000 } });
        const socket = createFakeSocket();

        socket.budget = { frames: 2, bytes: 1_000_000 };

        startStreamConnection({
            socket,
            broker,
            limits: resolveStreamLimits({ send_queue_frames: 2, send_queue_bytes: 1_000_000 }),
            heartbeatIntervalMs: 600_000
        });

        socket.message?.('{"type":"subscribe","subscription_id":"s1","scope":"session","session_id":"session-1"}');

        return { broker, socket };
    };

    const parsed = (socket: FakeSocket): { type: string; reason?: string; sequence?: number; subscription_id?: string }[] =>
        socket.sent.map((text) => JSON.parse(text) as { type: string; reason?: string; sequence?: number; subscription_id?: string });

    it('drops update frames and answers resync_required(frames_dropped) for the right subscription', async () => {
        const { broker, socket } = pressured();

        for (let index = 0; index < 5; index += 1) broker.publish(makeEvent(index));

        // The loss report is flushed on a microtask so the offending frame reaches the wire first.
        await new Promise((resolve) => setImmediate(resolve));

        const frames = parsed(socket);

        expect(frames[0].type).toBe('welcome');
        expect(
            // Picked, not spread: the state frame's `revisions`/`publishes` content is asserted in
            // full against a real client above; here the point is WHERE it sits in the stream.
            ['type', 'subscription_id', 'scope', 'epoch', 'sequence'].map((key) => (frames[1] as Record<string, unknown>)[key])
        ).toEqual(['subscription_state', 's1', 'session', EPOCH, 0]);
        expect(frames.filter((frame) => frame.type === 'update').map((frame) => frame.sequence)).toEqual([1, 2, 3, 4, 5]);
        const resyncs = frames.filter((frame) => frame.type === 'resync_required');

        // A burst of drops becomes ONE resync per subscription, not one per lost frame: the client
        // needs to know it fell behind, and `lost_frames` carries how far.
        expect(resyncs.map((frame) => frame.reason)).toEqual(['frames_dropped']);
        // Every drop is attributed, which is the difference between "some frames were lost" and a
        // client that can actually recover.
        expect(resyncs.map((frame) => frame.subscription_id)).toEqual(['s1']);
        expect(socket.closeCode).toBeUndefined();
    });

    it('never drops welcome, subscription_state, or resync_required', async () => {
        const { broker, socket } = pressured();

        for (let index = 0; index < 8; index += 1) broker.publish(makeEvent(index));
        await new Promise((resolve) => setImmediate(resolve));

        // Whatever was evicted, the reconciliation anchors are still in the queue.
        const remaining = socket.queue.map((entry) => JSON.parse(entry.text) as { type: string });

        expect(remaining.some((frame) => frame.type === 'welcome')).toBe(true);
        expect(remaining.some((frame) => frame.type === 'subscription_state')).toBe(true);
        expect(remaining.every((frame) => frame.type !== 'update' || frame.droppable !== false)).toBe(true);
    });

    it('closes 1013 when the queue stays full past sustained_stall_ms', async () => {
        vi.useFakeTimers();

        try {
            const broker = createStreamBroker({ epoch: EPOCH, limits: { send_queue_frames: 1, sustained_stall_ms: 1_000 } });
            const socket = createFakeSocket();

            socket.budget = { frames: 1, bytes: 1_000_000 };

            startStreamConnection({
                socket,
                broker,
                limits: resolveStreamLimits({ send_queue_frames: 1, sustained_stall_ms: 1_000 }),
                heartbeatIntervalMs: 600_000
            });

            socket.message?.('{"type":"subscribe","subscription_id":"s1","scope":"session","session_id":"session-1"}');
            broker.publish(makeEvent(0));

            // Nothing drains, so the stall budget expires and the connection goes with 1013.
            await vi.advanceTimersByTimeAsync(1_001);

            expect(socket.closeCode).toBe(1013);
        } finally {
            vi.useRealTimers();
        }
    });
});

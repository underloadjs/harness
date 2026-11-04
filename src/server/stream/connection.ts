// The per-connection harness stream conversation: what happens between the `101` and the close.
//
// This module is the ONLY place a client frame changes broker state, and it enforces the order the
// contract states in `x-websocket.validation_precedence` (swagger lines 2368-2392):
//
//   (1) UTF-8 JSON text object within `max_client_frame_bytes`  -> ./transport.ts (framing) + ./protocol.ts (size)
//   (2) client-union schema                                      -> ./protocol.ts `parseClientFrame`
//   (3) `hello` only as the first frame                          -> here (`late_hello`)
//   (4) known `subscription_id` for ack/unsubscribe              -> here + ./broker.ts (`unknown_subscription`)
//   (5) required resource id exists                              -> ./broker.ts (`unknown_resource`)
//   (6) filter published for the scope                           -> ./broker.ts (`unsupported_filter`)
//   (7) budgets and rates                                        -> here (`rate_limited`) + ./broker.ts (`too_many_subscriptions`)
//
// Everything the connection owns is the CLIENT-SIDE health of the link, which the broker cannot
// see: the `welcome` frame, the heartbeat budget, the per-second message budget, the send queue
// (and therefore the drop-oldest-droppable backpressure rule), and the close codes.
//
// Cross-references:
//   - ./protocol.ts     — `parseClientFrame`, `HARNESS_WS_CLOSE_CODES`, the tunable bounds
//   - ./broker.ts       — subscriptions, sequences, replay, and the `resync_required` frames
//   - ./transport.ts    — the `HarnessSocket` whose queue this module paces
//   - swagger 2465-2488 — heartbeat and backpressure rules implemented verbatim below

import { HARNESS_WS_SUBPROTOCOL } from '../../shared/harness-api';
import type {
    WsClientMessage,
    WsProtocolError,
    WsServerMessage,
    WsStreamLimits,
    WsSubscribe,
    WsSubscriptionFilters,
    WsSubscriptionScope
} from '../../shared/harness-stream';
import { HARNESS_WS_CLOSE_CODES, parseClientFrame, streamFrameBytes, type StreamFailure } from './protocol';
import type { HarnessStreamBroker, StreamDelivery, StreamEvent, StreamSessionHandle, StreamSubscribeRequest } from './broker';
import { WEBSOCKET_STATE, type HarnessSocket } from './transport';

export type StreamConnectionOptions = {
    socket: HarnessSocket;
    broker: HarnessStreamBroker;
    /** Effective limits. Defaults to the broker's, which is what `welcome` advertises. */
    limits?: WsStreamLimits;
    clock?: () => number;
    /**
     * Test seam for the heartbeat cadence ONLY. `heartbeat_interval_ms` is `fixed_by_contract`
     * (15000), so a suite that asserted the real cadence would wait 45 seconds for a 4408 close;
     * production never passes this and the value advertised in `welcome` is untouched.
     */
    heartbeatIntervalMs?: number;
};

export type StreamConnection = {
    readonly id: string;
    readonly subscriptions: number;
    close(code?: number, reason?: string): void;
};

export const startStreamConnection = ({
    socket,
    broker,
    limits = broker.limits(),
    clock = Date.now,
    heartbeatIntervalMs = limits.heartbeat_interval_ms
}: StreamConnectionOptions): StreamConnection => {
    // Frames lost while the send queue was over budget, collected per subscription so ONE
    // `resync_required` covers a burst instead of one frame per loss.
    const lostBySubscription = new Map<string, number>();
    let firstSubscribeSent = false;
    let helloSeen = false;
    let invalidStreak = 0;
    let closing = false;
    let lastActivityAt = clock();
    let messagesThisSecond = 0;
    let secondStartedAt = clock();
    let stallTimer: ReturnType<typeof setTimeout> | undefined;

    const session: StreamSessionHandle = broker.open((frame) => deliver(frame));

    const send = (frame: WsServerMessage, meta: { droppable?: boolean; token?: string } = {}): void => {
        if (closing || socket.readyState >= WEBSOCKET_STATE.closing) return;

        const text = JSON.stringify(frame);
        socket.send(text, { droppable: meta.droppable === true, ...(meta.token === undefined ? {} : { token: meta.token }) });
    };

    const sendError = (failure: StreamFailure): void => {
        const frame: WsProtocolError = {
            type: 'error',
            code: failure.code,
            message: failure.message,
            ...(failure.subscription_id === undefined ? {} : { subscription_id: failure.subscription_id }),
            // Only `rate_limited` and a client bug are worth resending; an internal failure is the
            // server's problem and the client cannot fix it by retrying the same frame.
            retryable: failure.code === 'rate_limited' || failure.code === 'internal',
            ...(failure.close_code === undefined ? {} : { close_code: failure.close_code })
        };

        send(frame);
    };

    // ------------------------------------------------------------------
    // Send queue and backpressure
    //
    // The rule (swagger 2474-2488): when the queue is full, drop the OLDEST droppable `update`
    // frame per subscription, never a `welcome`/`subscription_state`/`resync_required`/`error`/
    // `heartbeat`/`pong`, then emit `resync_required` for each affected subscription. `frames_dropped`
    // is the closed-set reason for "frames lost while the connection stayed open" — the extension's
    // prose word "backpressure" is NOT a member of `WsResyncRequired.reason`.
    // ------------------------------------------------------------------

    const overBudget = (extraBytes: number): boolean =>
        socket.queuedFrames >= limits.send_queue_frames || socket.queuedBytes + extraBytes > limits.send_queue_bytes;

    const armStallTimer = (): void => {
        if (stallTimer !== undefined) return;

        stallTimer = setTimeout(() => {
            stallTimer = undefined;

            // Re-check rather than assume: the queue may have drained in the meantime, and only a
            // queue that is STILL full has "stalled beyond `sustained_stall_ms`".
            if (socket.queuedFrames >= limits.send_queue_frames || socket.queuedBytes >= limits.send_queue_bytes) {
                close(HARNESS_WS_CLOSE_CODES.tryAgainLater, 'The send queue stalled.');
            }
        }, limits.sustained_stall_ms);

        stallTimer.unref?.();
    };

    const deliver = (frame: WsServerMessage): StreamDelivery => {
        if (closing || socket.readyState >= WEBSOCKET_STATE.closing) return 'closed';

        const droppable = frame.type === 'update';
        const token = 'subscription_id' in frame && typeof frame.subscription_id === 'string' ? frame.subscription_id : undefined;

        if (droppable) {
            const extraBytes = streamFrameBytes(JSON.stringify(frame));

            // Evict until this frame fits, and remember WHICH subscription lost frames so the
            // broker can answer with a single `resync_required` per subscription.
            while (overBudget(extraBytes)) {
                const evicted = socket.evictOldestDroppable();
                if (evicted === undefined) break;

                const key = evicted.token ?? (token ?? '');
                lostBySubscription.set(key, (lostBySubscription.get(key) ?? 0) + 1);
                scheduleLossFlush();
            }

            // The stall clock measures a queue that STAYS full, which is a property of the queue, not
            // of whether an eviction was possible: a backlog of only non-droppable frames is just as
            // stalled, and 1013 is the honest answer for it.
            if (overBudget(extraBytes)) armStallTimer();
        }

        send(frame, droppable ? { droppable: true, ...(token === undefined ? {} : { token }) } : {});

        // An `error` frame with a `close_code` is the contract's "close immediately after this
        // frame" instruction (4401 too_many_subscriptions, 4429 rate_limited, and the host's own
        // shutdown/restart codes from `broker.close`). Because `send` above already put the frame on
        // the socket (or queued it ahead of the close), the client always sees the reason.
        if (frame.type === 'error' && typeof frame.close_code === 'number') close(frame.close_code, frame.message);

        return socket.queuedFrames > 0 ? 'queued' : 'sent';
    };

    // Evictions are reported through the broker, and a drop can be caused by a REST publish with no
    // inbound frame in flight. A microtask flush therefore covers BOTH paths while still letting the
    // offending frame reach the wire first, so the client sees `update` then `resync_required`.
    let lossFlushScheduled = false;

    const scheduleLossFlush = (): void => {
        if (lossFlushScheduled) return;
        lossFlushScheduled = true;

        queueMicrotask(() => {
            lossFlushScheduled = false;
            flushLossReports();
        });
    };

    // Evictions are reported after the current frame has been queued, so the resync frame lands
    // behind it and the client sees frames in order.
    const flushLossReports = (): void => {
        if (lostBySubscription.size === 0) return;

        const losses = [...lostBySubscription.entries()];
        lostBySubscription.clear();

        for (const [subscriptionId, lost] of losses) session.requestResync(subscriptionId, 'frames_dropped', lost);
    };

    // ------------------------------------------------------------------
    // Inbound frames
    // ------------------------------------------------------------------

    const close = (code: number = HARNESS_WS_CLOSE_CODES.normal, reason = ''): void => {
        if (closing) return;
        closing = true;

        if (stallTimer !== undefined) clearTimeout(stallTimer);
        stopHeartbeat();

        // No frame is invented here: the close CODE is the contract's signal (1000 after `bye`,
        // 1007 after repeated invalid frames, 4401/4408/4429/1013 for the budget conditions), and
        // the error frames that precede them are sent by the code paths that decide to close.
        socket.close(code, reason);
        session.release();
    };

    // `hello` is the ONLY resume input, and it is honoured only as the first frame. A late `hello`
    // answers `late_hello` and changes nothing; the connection stays usable (spec `resume.rules`).
    const handleHello = (frame: Extract<WsClientMessage, { type: 'hello' }>): void => {
        if (firstSubscribeSent) {
            sendError({ code: 'late_hello', message: 'hello must arrive before the first subscribe.' });
            return;
        }

        if (helloSeen) {
            // A repeated hello is not a contract condition; ignoring the later one is the only
            // reading that keeps "the first frame" meaningful without inventing an error code.
            return;
        }

        helloSeen = true;
        session.setResume(frame.cursor);
    };

    const subscribeRequest = (frame: WsSubscribe): StreamSubscribeRequest => {
        const scope = frame.scope as WsSubscriptionScope;
        const ids: StreamSubscribeRequest['ids'] = {};

        // The id set is exactly what the scope allows, which `parseClientFrame` already proved.
        if ('session_id' in frame && typeof frame.session_id === 'string') ids.session_id = frame.session_id;
        if ('thread_id' in frame && typeof frame.thread_id === 'string') ids.thread_id = frame.thread_id;
        if ('turn_id' in frame && typeof frame.turn_id === 'string') ids.turn_id = frame.turn_id;

        const filters = (frame as { filters?: WsSubscriptionFilters }).filters;

        return {
            subscription_id: frame.subscription_id,
            scope,
            ids,
            ...(filters === undefined ? {} : { filters }),
            pace: frame.pace ?? 'ordered',
            ...(typeof frame.cursor === 'string' ? { cursor: frame.cursor } : {})
        };
    };

    const handleSubscribe = (frame: WsSubscribe): void => {
        firstSubscribeSent = true;

        const outcome = session.subscribe(subscribeRequest(frame));

        if (outcome.status === 'rejected') {
            sendError(outcome.failure);

            // `too_many_subscriptions` closes with 4401 after the frame (the precedence mapping),
            // and it is the only rejection with a close code attached.
            if (outcome.failure.close_code !== undefined) close(outcome.failure.close_code, outcome.failure.message);
            return;
        }

        if (outcome.status === 'resync') {
            send(outcome.resync);
            return;
        }

        // `subscription_state` is the reconciliation anchor and is therefore never droppable; the
        // replayed updates that follow it are, because a later resync can always recover them.
        send(outcome.state);

        for (const frame of outcome.replay) send(frame, { droppable: true, token: outcome.state.subscription_id });
    };

    const handleMessage = (text: string): void => {
        const parsed = parseClientFrame(text);

        if (parsed.failure !== undefined) {
            invalidStreak += 1;
            sendError(parsed.failure);

            // Three consecutive frames that fail the client union close with 1007; a single bad
            // frame never kills a live UI.
            if (invalidStreak >= 3) close(HARNESS_WS_CLOSE_CODES.invalidPayload, 'Repeated invalid frames.');

            flushLossReports();
            return;
        }

        // A frame that validates resets the streak: the contract counts CONSECUTIVE failures.
        invalidStreak = 0;

        // Per-second message budget (step 7, checked after schema and resource conditions have had
        // their turn for THIS frame — a malformed flood is reported as `invalid_payload` first).
        const now = clock();

        if (now - secondStartedAt >= 1000) {
            secondStartedAt = now;
            messagesThisSecond = 0;
        }

        messagesThisSecond += 1;

        if (messagesThisSecond > limits.client_messages_per_second) {
            sendError({ code: 'rate_limited', message: `A client may send at most ${limits.client_messages_per_second} messages per second.`, close_code: HARNESS_WS_CLOSE_CODES.rateLimited });
            flushLossReports();
            close(HARNESS_WS_CLOSE_CODES.rateLimited, 'Client message rate exceeded.');
            return;
        }

        const frame = parsed.frame as WsClientMessage;

        switch (frame.type) {
            case 'hello':
                handleHello(frame);
                return;
            case 'subscribe':
                handleSubscribe(frame);
                return;
            case 'unsubscribe': {
                const failure = session.unsubscribe(frame.subscription_id);
                if (failure !== undefined) sendError(failure);
                return;
            }
            case 'ack': {
                const failure = session.acknowledge(frame.subscription_id, frame.sequence);
                if (failure !== undefined) sendError(failure);
                return;
            }
            case 'ping':
                // `pong` echoes the `at` the client sent, or the server clock when it sent none.
                send({ type: 'pong', at: frame.at ?? clock() });
                return;
            case 'bye':
                // A clean goodbye: close 1000, which is how a client releases its subscriptions
                // without looking like a dropped connection in the server's diagnostics.
                close(HARNESS_WS_CLOSE_CODES.normal, frame.reason ?? '');
                return;
            default:
                sendError({ code: 'invalid_payload', message: 'Unknown client frame type.' });
        }

        flushLossReports();
    };

    // ------------------------------------------------------------------
    // Heartbeat
    // ------------------------------------------------------------------

    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

    const stopHeartbeat = (): void => {
        if (heartbeatTimer === undefined) return;
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
    };

    const startHeartbeat = (): void => {
        heartbeatTimer = setInterval(() => {
            if (closing) return;

            // Silence for `heartbeat_timeout_intervals` intervals means the peer is gone: this is
            // how a half-open browser tab stops holding a subscription open.
            if (clock() - lastActivityAt >= heartbeatIntervalMs * limits.heartbeat_timeout_intervals) {
                close(limits.heartbeat_timeout_close_code, 'No heartbeat reply.');
                return;
            }

            send({ type: 'heartbeat', at: clock() });
        }, heartbeatIntervalMs);

        // A heartbeat timer must never keep a closing process alive.
        heartbeatTimer.unref?.();
    };

    socket.onActivity(() => {
        lastActivityAt = clock();
    });

    socket.onMessage((text) => {
        lastActivityAt = clock();
        handleMessage(text);
    });

    socket.onClose(() => {
        // The peer is gone: release the subscriptions (each keeps a parked replay window for a
        // resume) and stop every timer. The run itself is NOT cancelled — closing the stream never
        // cancels a task (spec: "Closing the connection cancels nothing").
        closing = true;
        stopHeartbeat();
        if (stallTimer !== undefined) clearTimeout(stallTimer);
        session.release();
    });

    // First frame on the wire is always `welcome`, before any `subscription_state`, so a client
    // learns the epoch and the numbers in force before it sends a single subscribe.
    send({
        type: 'welcome',
        protocol: HARNESS_WS_SUBPROTOCOL,
        epoch: broker.epoch(),
        at: clock(),
        limits
    });

    startHeartbeat();

    return {
        id: session.id,
        get subscriptions(): number {
            return session.subscriptionCount;
        },
        close
    };
};

/** Publish helper for embedders that hold a broker but not a connection (the REST side). */
export const publishStreamEvent = (broker: HarnessStreamBroker, event: StreamEvent): number => broker.publish(event);

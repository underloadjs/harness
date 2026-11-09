// The realtime plane: ONE centralized `harness.v1` WebSocket (T14).
//
// Why one socket: the contract prices a connection, not a subscription
// (`subscriptions_per_connection: 64`, `client_messages_per_second: 32`,
// `heartbeat_interval_ms: 15000`). One shared connection per page therefore costs
// a single handshake, a single heartbeat pair and a single resume, and every pane
// (session rail, focused conversation, a focused turn, the global catalogues) is a
// SCOPED SUBSCRIPTION on it. The SSE observer it replaces opened one long-lived
// HTTP stream per session and started each with a full document; this one starts
// with a `welcome` (epoch + limits) and then `subscription_state` baselines.
//
// THE RULES THIS MODULE ENFORCES (each one is a line of the spec's `x-websocket`
// section, and each is a bug the UI had before):
//   1. URL is `${API_ROOT}/stream` from `HARNESS_ROUTES.stream()`, scheme `ws:`/
//      `wss:` matched to the page, and the negotiated subprotocol is
//      `HARNESS_WS_SUBPROTOCOL` (`harness.v1`). There is no other realtime path:
//      NO SSE, no fallback transport, and NO reconnect-to-HTTP-snapshot.
//   2. Resume input is `hello` ONLY, and only as the FIRST frame of a connection
//      (a late `hello` is refused with `late_hello`). A reconnect therefore sends
//      `{ epoch, cursor }` from the highest frame it APPLIED, then re-opens its
//      subscriptions; a subscription's own `cursor` overrides the hello cursor.
//   3. A `hello` is sent only when there is something to resume. With none, the
//      server starts each subscription fresh at its own current position, which is
//      what a first connection wants.
//   4. `subscription_state` is the reconciliation anchor: its `revisions` + `seq`
//      tell the caller which later frames a REST read already covers, and
//      `replayed_frames > 0` tells a resuming client it received history.
//   5. GAP = `sequence > expected` on a subscription. The client says so
//      (re-subscribes that subscription with its last cursor and reports a
//      `frames_dropped` resync) instead of quietly rendering a wrong view.
//   6. `resync_required` re-reads ONLY the resources the frame names, as bounded
//      pages (`link` already carries its page size). Never a snapshot boot.
//   7. A dropped connection NEVER cancels a task. Execution is server-owned; this
//      module closes and re-opens an OBSERVATION and nothing else, and it keeps
//      working without a socket at all (the caller falls back to bounded reads).
//   8. `ack` is sent only for a subscription that asked for `pace: 'ack'`, and it
//      names the highest sequence APPLIED (an ack on an unpaced subscription is a
//      legal no-op, so this client never needs to know whether it is paced).
//
// Test environment note: `WebSocket` may not exist (happy-dom / bare node). That is
// NOT an error condition here and NOT a reason to fall back to SSE: the host passes
// an explicit `socketFactory` double, and `createHarnessStream` reports a missing
// global only when no factory was given.

import { HARNESS_WS_SUBPROTOCOL } from '../shared/harness-api';
import { HARNESS_WS_STREAM_LIMITS, isHarnessServerFrame } from '../shared/harness-stream';
import type {
    WsClientMessage,
    WsProtocolError,
    WsResyncRequired,
    WsServerMessage,
    WsStreamLimits,
    WsSubscribe,
    WsSubscriptionFilters,
    WsSubscriptionScope,
    WsSubscriptionState,
    WsUpdate,
    WsWelcome
} from '../shared/harness-stream';
import { streamSocketUrl } from './api';

// The minimum socket surface this client drives. Declared structurally (not as
// `globalThis.WebSocket`) so a test double can satisfy it without pretending to be
// a browser, and so the real `WebSocket` satisfies it unchanged.
export type StreamSocket = {
    send(data: string): void;
    close(code?: number, reason?: string): void;
    onopen: (() => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onerror: (() => void) | null;
    onclose: ((event: { code?: number; reason?: string }) => void) | null;
};

export type StreamSocketFactory = (url: string, protocol: string) => StreamSocket;

export type StreamStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

// One subscription's identity plus the callbacks that pane needs. `onUpdate` is
// called ONLY for a frame that arrived on THIS subscription, which is what makes
// "a frame that names a resource I am not showing is ignored" a property of the
// client and not of each pane.
export type StreamSubscriptionSpec = {
    scope: WsSubscriptionScope;
    sessionId?: string;
    threadId?: string;
    turnId?: string;
    // Narrowing may only REMOVE frames. A filter change is an unsubscribe plus a
    // subscribe with a NEW id, so this object is immutable for its lifetime.
    filters?: WsSubscriptionFilters;
    pace?: 'ordered' | 'ack';
    // Resume position for THIS subscription; overrides the connection `hello`.
    cursor?: string;
    onState?: (state: WsSubscriptionState) => void;
    onUpdate?: (update: WsUpdate) => void;
    onResync?: (frame: WsResyncRequired) => void;
    // A protocol error naming THIS subscription (unknown_resource,
    // unsupported_filter, ...): the pane reports it and stops waiting.
    onError?: (error: WsProtocolError) => void;
};

export type StreamSubscription = {
    id: string;
    spec: StreamSubscriptionSpec;
    // The last cursor this subscription applied — the resume token for a
    // re-subscribe, and the figure `resync_required` compares against.
    cursor: string | null;
    sequence: number;
    unsubscribe(): void;
};

export type StreamHandlers = {
    onStatus?: (status: StreamStatus) => void;
    onWelcome?: (welcome: WsWelcome) => void;
    // Every inbound frame, before routing. Used by the connection-state pill and
    // by tests that assert the protocol rather than a projection.
    onFrame?: (frame: WsServerMessage) => void;
    // A frame this client could not even tag (`type` outside the closed union).
    onUnknownFrame?: (value: unknown) => void;
};

export type StreamClientOptions = {
    handlers?: StreamHandlers;
    socketFactory?: StreamSocketFactory;
    limits?: Partial<WsStreamLimits>;
    // Injectable clock so a test can drive reconnect/heartbeat timing exactly.
    schedule?: (fn: () => void, ms: number) => () => void;
};

export type HarnessStreamClient = {
    status(): StreamStatus;
    // Opens the connection (idempotent while connecting/open).
    connect(): void;
    // Registers one subscription; sends it immediately when the socket is open,
    // otherwise queues it for the next `welcome` (a subscription made while
    // reconnecting is NOT lost).
    subscribe(spec: StreamSubscriptionSpec): StreamSubscription;
    // Clean goodbye: `bye`, then close 1000. Subscriptions are released, work is not.
    close(reason?: string): void;
    // Forces an immediate reconnect (the "Retry" affordance), keeping resume state.
    refresh(): void;
    // T3b: the RATE-LIMITED form of `refresh`, for callers that react to live data rather
    // than to a human pressing Retry. The board calls it when a thread watch is NEWLY
    // added while the plane is down (R2: expanding must promptly re-establish), and that
    // sync runs on every roster frame — an unthrottled force would cancel the pending
    // backoff and dial again per frame, which is the reconnect storm this client exists to
    // avoid (`client_messages_per_second: 32`, close 4429). One forced dial per down
    // period; the allowance returns when the plane reports `open` again.
    forceReconnectOnce(): void;
    // The last epoch and cursor this client APPLIED, for diagnostics and for a host
    // that persists them across reloads.
    resumeState(): { epoch: string | null; cursor: string | null };
    subscriptions(): StreamSubscription[];
};

// The defaults come from the contract constant, not from a local guess; `welcome`
// re-states them for the connection in force and this client re-adopts them, so a
// deployment that tunes a value inside the declared bounds is followed without a
// rebuild.
type Tunables = {
    heartbeatIntervalMs: number;
    heartbeatTimeoutIntervals: number;
    heartbeatTimeoutCloseCode: number;
    ackTimeoutMs: number;
    maxServerFrameBytes: number;
};

const tunablesOf = (override: Partial<WsStreamLimits> | undefined): Tunables => ({
    heartbeatIntervalMs: override?.heartbeat_interval_ms ?? HARNESS_WS_STREAM_LIMITS.heartbeat_interval_ms,
    heartbeatTimeoutIntervals:
        override?.heartbeat_timeout_intervals ?? HARNESS_WS_STREAM_LIMITS.heartbeat_timeout_intervals,
    heartbeatTimeoutCloseCode:
        override?.heartbeat_timeout_close_code ?? HARNESS_WS_STREAM_LIMITS.heartbeat_timeout_close_code,
    ackTimeoutMs: override?.ack_timeout_ms ?? HARNESS_WS_STREAM_LIMITS.ack_timeout_ms,
    maxServerFrameBytes: override?.max_server_frame_bytes ?? HARNESS_WS_STREAM_LIMITS.max_server_frame_bytes
});

// Reconnect backoff: capped exponential with jitter, so a server restart is
// survived without a thundering herd of tabs redialing the same instant.
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;

// The client's own close code for "the server stopped answering heartbeats": a
// browser gives no timeout for a half-open socket, so a silent peer is detected by
// the contract's own heartbeat budget and dialed again by this client.
const HEARTBEAT_LOSS_CODE = 4408;

export const createHarnessStream = (options: StreamClientOptions = {}): HarnessStreamClient => {
    const handlers = options.handlers ?? {};
    const limits = tunablesOf(options.limits);

    // Timers are injectable so a test can fire a heartbeat deadline or a reconnect
    // backoff on demand instead of sleeping.
    const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
        const timer = globalThis.setTimeout(fn, ms);

        return () => globalThis.clearTimeout(timer);
    };

    // A host without a WebSocket implementation must say so explicitly (a test
    // double) rather than have this client invent an SSE path the contract removed.
    const socketConstructor = (globalThis as unknown as { WebSocket?: new (url: string, protocols: readonly string[]) => StreamSocket })
        .WebSocket;
    const factory: StreamSocketFactory | undefined =
        options.socketFactory ??
        (typeof socketConstructor === 'function'
            ? (url, protocol) => new socketConstructor(url, [protocol])
            : undefined);

    let socket: StreamSocket | undefined;
    let current: StreamStatus = 'idle';
    let manualClose = false;
    let attempts = 0;
    let reconnectCancel: (() => void) | undefined;
    let heartbeatCancel: (() => void) | undefined;

    // T3b: whether the CURRENT down period has already spent its forced dial (see
    // `forceReconnectOnce`). `setStatus` clears the allowance when the plane reaches
    // `open` (the outage is over) or `closed` (a deliberate full stop); nothing here
    // replaces the backoff schedule itself.
    let forcedWhileDown = false;

    // Resume state for the NEXT `hello`: the epoch this client last spoke to, and
    // the highest cursor it APPLIED on any subscription. A cursor from a previous
    // epoch is refused with `epoch_mismatch`, which is the honest answer rather
    // than a silently wrong replay.
    let epoch: string | null = null;
    let cursor: string | null = null;

    // Subscriptions live here, keyed by the id THIS client chose (unique per
    // connection), so a pane correlates frames without a round trip.
    const subs = new Map<string, StreamSubscription>();
    let nextSubId = 0;

    // Per-subscription bookkeeping the spec requires for gap detection: the next
    // sequence this subscription must see. `null` = nothing seen yet, so the first
    // frame of a fresh subscription cannot "gap".
    const expected = new Map<string, number | null>();

    // Registrations the server has ACKNOWLEDGED with a `subscription_state` frame (T3).
    // This is what tells a re-registration from an initial one: a `resync_required` that
    // ANSWERS a subscribe never registered the id at all
    // (../server/stream/broker.ts:742-762 returns before `session.subscriptions.set`), and
    // an `unsubscribe` naming an id the server does not hold is a protocol error
    // (`unknown_subscription`, broker.ts:810). T3b precision on the cost: that error frame
    // alone does NOT close the socket — only three consecutive frames that fail the CLIENT
    // UNION parse do, with 1007 (../server/stream/connection.ts:283) — so a stray goodbye
    // is harmless noise, and this set is what keeps the client from sending one.
    const registered = new Set<string>();

    const setStatus = (next: StreamStatus): void => {
        if (current === next) return;
        current = next;

        // T3b: reaching `open` ends the down period, and reaching `closed` is a deliberate
        // full stop (both clear the forced-dial allowance, so the next drop or a later
        // expand after a close may force again — see `forcedWhileDown`).
        if (next === 'open' || next === 'closed') forcedWhileDown = false;

        handlers.onStatus?.(next);
    };

    const send = (message: WsClientMessage): boolean => {
        if (socket === undefined || current !== 'open') return false;

        // The contract bounds a CLIENT frame (`max_client_frame_bytes: 16384`);
        // every frame this client sends is a control frame far below it, so the
        // check is a guard against a future caller, not a routine cost.
        const text = JSON.stringify(message);
        if (text.length > 16384) return false;

        try {
            socket.send(text);

            return true;
        } catch {
            // A socket that throws on send is a dead socket: the close handler and
            // the reconnect path own the recovery.
            return false;
        }
    };

    // Subscribe/re-subscribe one entry. `cursor` is sent when the subscription has
    // one (a resume), which is also how a gap is recovered without a new pane.
    const sendSubscribe = (sub: StreamSubscription): void => {
        const { spec } = sub;

        // The per-scope id contract is machine-checked by the schema, so building
        // the wrong shape here is a protocol error on the wire: `global` takes no
        // ids, `session` takes `session_id`, `thread` and `turn` take both of their
        // ids and never the other scope's.
        let frame: WsSubscribe;

        if (spec.scope === 'global') {
            frame = { type: 'subscribe', subscription_id: sub.id, scope: 'global', pace: spec.pace ?? 'ordered' };
        } else if (spec.scope === 'thread' && spec.sessionId !== undefined && spec.threadId !== undefined) {
            // T3: the thread scope carries its OWN cursor, exactly like `session` and
            // `turn`. The broker accepts one for every scope (../server/stream/broker.ts:720
            // `const cursor = request.cursor ?? session.resumeCursor`) and parks a replay
            // window when a thread subscription ends (:348-369), so a re-subscribe after a
            // drop resumes inside that window instead of restarting the subscription from
            // the server's current position — which is what lets `observeThread` tell a
            // RESUMED baseline (replayed frames: nothing to reconcile) from a FRESH one
            // (the window expired: the pane must re-read). Filters are deliberately absent:
            // the thread scope publishes no filterable field (../shared/harness-stream.ts
            // `HARNESS_WS_SCOPE_FILTERS`, and ../server/stream/protocol.ts:111-116 refuses
            // any other with `unsupported_filter`).
            frame = {
                type: 'subscribe',
                subscription_id: sub.id,
                scope: 'thread',
                session_id: spec.sessionId,
                thread_id: spec.threadId,
                pace: spec.pace ?? 'ordered',
                ...(sub.cursor === null || sub.cursor === '' ? {} : { cursor: sub.cursor })
            };
        } else if (spec.scope === 'turn' && spec.sessionId !== undefined && spec.turnId !== undefined) {
            frame = {
                type: 'subscribe',
                subscription_id: sub.id,
                scope: 'turn',
                session_id: spec.sessionId,
                turn_id: spec.turnId,
                ...(spec.filters === undefined ? {} : { filters: spec.filters }),
                pace: spec.pace ?? 'ordered',
                ...(sub.cursor === null || sub.cursor === '' ? {} : { cursor: sub.cursor })
            };
        } else if (spec.sessionId !== undefined) {
            frame = {
                type: 'subscribe',
                subscription_id: sub.id,
                scope: 'session',
                session_id: spec.sessionId,
                ...(spec.filters === undefined ? {} : { filters: spec.filters }),
                pace: spec.pace ?? 'ordered',
                ...(sub.cursor === null || sub.cursor === '' ? {} : { cursor: sub.cursor })
            };
        } else {
            // A scope with no ids cannot be addressed; report rather than guess.
            spec.onError?.({
                type: 'error',
                code: 'unknown_resource',
                message: `A ${spec.scope} subscription needs its resource id.`,
                subscription_id: sub.id,
                retryable: false
            });

            return;
        }

        send(frame);
    };

    const clearHeartbeatWatch = (): void => {
        if (heartbeatCancel !== undefined) {
            heartbeatCancel();
            heartbeatCancel = undefined;
        }
    };

    // (Re)arm the heartbeat deadline. Every inbound frame counts as liveness — a
    // server that is busy publishing is by definition alive — but the deadline is
    // always `interval * timeout_intervals`, so a stalled publisher is still caught.
    const armHeartbeatWatch = (): void => {
        clearHeartbeatWatch();

        const schedule = options.schedule ?? defaultSchedule;
        const timeoutMs = limits.heartbeatIntervalMs * limits.heartbeatTimeoutIntervals;

        heartbeatCancel = schedule(() => {
            if (current === 'open') {
                // Silent peer: close from THIS side with the contract's own code and let
                // the reconnect path resume from the last cursor.
                socket?.close(HEARTBEAT_LOSS_CODE, 'heartbeat timeout');

                return;
            }

            // THE STUCK DIAL (T3). This watchdog used to no-op unless the state was
            // `open`, while `open()` arms it BEFORE the upgrade completes — so a socket
            // that is `connecting` forever (a proxy that holds the handshake, a server
            // that accepts TCP and dies before the 101, a half-open resume) could never
            // recover: nothing closes it, `open()` refuses to re-dial while connecting,
            // and a pane that subscribes in that state now queues instead of dialing
            // (see `subscribe` below). The deadline is the only clock this client has for
            // "the attempt itself is dead", so it ends the attempt and re-dials with
            // backoff instead of pretending the plane is alive.
            if (current === 'connecting' || current === 'reconnecting') {
                dropConnection(HEARTBEAT_LOSS_CODE, 'connect timeout');
            }
        }, timeoutMs);
    };

    const scheduleReconnect = (): void => {
        if (manualClose || reconnectCancel !== undefined) return;

        const schedule = options.schedule ?? defaultSchedule;
        const backoff = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempts);
        const jitter = Math.floor(backoff * 0.25 * Math.random());

        attempts += 1;

        reconnectCancel = schedule(() => {
            reconnectCancel = undefined;
            open();
        }, backoff + jitter);
    };

    // The contract's recovery frame, minted CLIENT-SIDE for the one loss the server
    // cannot report by itself: the connection carrying this subscription just ended.
    // `reason: 'frames_dropped'` is the only value of that closed union
    // (../shared/harness-stream.ts `WsResyncRequired`) that says "everything after your
    // last cursor is missing", which is exactly what a drop means.
    const droppedFrameFor = (sub: StreamSubscription): WsResyncRequired => ({
        type: 'resync_required',
        subscription_id: sub.id,
        reason: 'frames_dropped',
        epoch: epoch ?? '',
        // The resume position THIS subscription holds; with none, the server starts it
        // fresh at its own current position, which is the honest answer after an outage.
        cursor: sub.cursor ?? '',
        resources: []
    });

    // The whole drop path, in ONE place (T3). It used to be the body of `onclose`, which
    // meant the ONLY thing that could reach a pane was an inbound frame — and a dropped
    // socket sends none. Every live subscription is now told to reconcile, the sequence
    // bookkeeping restarts for the fresh `subscription_state` baseline, and the reconnect
    // loop resumes with backoff.
    const handleDrop = (): void => {
        clearHeartbeatWatch();
        socket = undefined;

        if (manualClose) {
            setStatus('closed');

            return;
        }

        // The bookkeeping starts over so a fresh baseline is not compared against the
        // old sequence space (the next connection restarts its counters at 0), and no
        // registration is considered acknowledged any more: the server dropped all of
        // them with the connection.
        for (const id of expected.keys()) expected.set(id, null);
        registered.clear();

        // A snapshot of the registrations: a pane's `onResync` may unsubscribe or
        // subscribe from inside this callback, and mutating `subs` mid-iteration would
        // otherwise decide which panes hear about the drop.
        for (const sub of [...subs.values()]) sub.spec.onResync?.(droppedFrameFor(sub));

        setStatus('reconnecting');
        scheduleReconnect();
    };

    // Ends the connection from THIS side (a heartbeat loss, a stuck dial) and runs the
    // drop path exactly once: the socket is detached BEFORE `close`, so the transport's
    // own `onclose` is refused by the `socket !== created` guards and cannot double-run
    // the reconnect or re-notify the panes.
    const dropConnection = (code: number, reason: string): void => {
        const dead = socket;

        socket = undefined;

        if (dead !== undefined) {
            try {
                dead.close(code, reason);
            } catch {
                // A socket that throws on close is by definition gone; the state below is
                // what the caller observes either way.
            }
        }

        handleDrop();
    };

    // Re-opens ONE registration from scratch (T3). Every recovery path (a client-detected
    // sequence gap, a server `resync_required`, a drop) ends the same way: the id is
    // released on the server when it is held there, the cursor is dropped when the caller
    // says the position is dead, and the subscription is dialled again so its
    // `subscription_state` baseline re-anchors the pane. `keepCursor` is the difference
    // between "resume inside the replay window" (a gap: the frames after the last applied
    // one are still retained) and "start at the server's current position" (a refused
    // cursor: retaining it would just be refused again).
    const reregister = (sub: StreamSubscription, keepCursor: boolean): void => {
        expected.set(sub.id, null);

        if (!keepCursor) sub.cursor = null;

        // T3b: the goodbye is sent only when THIS client believes the server holds the
        // id. An `unsubscribe` naming an id the server does not hold is answered with a
        // single `unknown_subscription` error frame and no close
        // (../server/stream/broker.ts:810-813) — harmless, but pointless traffic on a
        // socket that is recovering, and the client's only knowledge of what the server
        // holds is this set (`registered`, which `handleDrop` clears on every drop).
        if (registered.has(sub.id)) {
            registered.delete(sub.id);
            send({ type: 'unsubscribe', subscription_id: sub.id });
        }

        sendSubscribe(sub);
    };

    const handleFrame = (raw: unknown): void => {
        // The union is discriminated on `type`; anything else is data to tolerate,
        // never a reason to drop the connection.
        if (!isHarnessServerFrame(raw)) {
            handlers.onUnknownFrame?.(raw);

            return;
        }

        handlers.onFrame?.(raw);

        if (raw.type === 'welcome') {
            attempts = 0;
            epoch = raw.epoch;
            handlers.onWelcome?.(raw);

            return;
        }

        if (raw.type === 'subscription_state') {
            // A state frame for a subscription this client already released is
            // ignored: the id is ours, so an unknown id means "no pane wants this".
            const sub = subs.get(raw.subscription_id);
            epoch = raw.epoch;
            cursor = raw.cursor;

            if (sub === undefined) return;

            sub.cursor = raw.cursor;
            expected.set(raw.subscription_id, raw.sequence + 1);
            // The server holds this registration from here on (see `registered` above).
            registered.add(raw.subscription_id);
            sub.spec.onState?.(raw);

            return;
        }

        if (raw.type === 'update') {
            const sub = subs.get(raw.subscription_id);
            const want = expected.get(raw.subscription_id);

            // Gap detection by ARITHMETIC, exactly as the contract intends: a server
            // that dropped frames must say so, and a client that can count notices
            // when it did not.
            if (sub !== undefined && want !== null && want !== undefined && raw.sequence > want) recover(sub);

            expected.set(raw.subscription_id, raw.sequence + 1);
            cursor = raw.cursor;

            if (sub === undefined) return;

            sub.cursor = raw.cursor;
            sub.sequence = raw.sequence;
            sub.spec.onUpdate?.(raw);

            // Acking is optional everywhere else, and an ack on an unpaced
            // subscription is ignored rather than an error, so this client acks
            // whenever it was asked to pace and never otherwise.
            if (sub.spec.pace === 'ack') send({ type: 'ack', subscription_id: sub.id, sequence: raw.sequence });

            return;
        }

        if (raw.type === 'resync_required') {
            const sub = subs.get(raw.subscription_id);
            epoch = raw.epoch;
            cursor = raw.cursor;

            if (sub === undefined) return;

            sub.cursor = raw.cursor;
            sub.spec.onResync?.(raw);

            // THE RE-REGISTRATION (T3). The server answers a SUBSCRIBE with this frame
            // when the cursor is dead (`cursor_expired`) or names another epoch, and in
            // that branch it never registers the subscription at all
            // (../server/stream/broker.ts:742-762 returns BEFORE `session.subscriptions
            // .set`). The pane re-reads the resources the frame names — and then, without
            // this, receives NOTHING EVER AGAIN, because the client still believes it is
            // subscribed. A fresh registration (no cursor) is the contract's answer: the
            // server starts that subscription at its own current position. A mid-life
            // `frames_dropped` resync (an ack timeout, ../server/stream/broker.ts:427)
            // DOES hold the id, so `reregister` releases it first.
            reregister(sub, false);

            return;
        }

        if (raw.type === 'error') {
            const sub = subs.get(raw.subscription_id ?? '');
            if (sub !== undefined) sub.spec.onError?.(raw);

            // A close code means the server closes right after this frame; the
            // `close` handler owns the reconnect, so nothing is scheduled here.
            return;
        }

        // `heartbeat` / `pong`: the peer is alive, so the deadline moves.
        armHeartbeatWatch();
    };

    // Recovery for ONE subscription: re-subscribe with its last applied cursor. The
    // server either replays (bounded by `replay_frames`/`replay_seconds`) or answers
    // `resync_required` with the resource links to re-read, so a gap converges to
    // REST reads and never to a history snapshot.
    const recover = (sub: StreamSubscription): void => {
        sub.spec.onResync?.(droppedFrameFor(sub));
        reregister(sub, true);
    };

    const open = (): void => {
        if (factory === undefined) {
            // No transport at all (a bare-node test, a browser with sockets blocked).
            // Stay `idle` and let the caller use bounded reads: this is a degraded
            // observation path, never a failed task.
            setStatus('closed');

            return;
        }

        if (current === 'connecting' || current === 'open') return;

        setStatus(attempts === 0 ? 'connecting' : 'reconnecting');
        manualClose = false;

        let created: StreamSocket;

        try {
            created = factory(streamSocketUrl(), HARNESS_WS_SUBPROTOCOL);
        } catch {
            // A failed upgrade is a transport problem, not a task failure: keep the
            // resume state and dial again with backoff.
            scheduleReconnect();

            return;
        }

        socket = created;
        armHeartbeatWatch();

        created.onopen = () => {
            if (socket !== created) return;

            setStatus('open');
            armHeartbeatWatch();

            // `hello` is the ONLY resume input in the contract, and it is honoured
            // only as the first frame; send it only when there is a position to
            // resume from, so a first connection starts each subscription fresh.
            if (epoch !== null && cursor !== null) {
                send({ type: 'hello', protocol: HARNESS_WS_SUBPROTOCOL, epoch, cursor });
            }

            for (const sub of subs.values()) sendSubscribe(sub);
        };

        created.onmessage = (event) => {
            if (socket !== created) return;

            armHeartbeatWatch();

            let parsed: unknown;
            try {
                parsed = JSON.parse(String(event.data));
            } catch {
                return;
            }

            handleFrame(parsed);
        };

        created.onerror = () => {
            if (socket !== created) return;

            // The transport problem is reported by the close that follows; a task
            // keeps running regardless (rule 7).
            armHeartbeatWatch();
        };

        created.onclose = () => {
            if (socket !== created) return;

            // THE DROP PATH, in one place (see `handleDrop`): notify every subscription,
            // reset the sequence bookkeeping, and re-dial with backoff. A pane that used
            // to keep its pre-drop document forever is now told to reconcile.
            handleDrop();
        };
    };

    // The shared body of `refresh` and `forceReconnectOnce` (T3b): release the heartbeat
    // watchdog, cancel any pending backoff, drop the socket with the resume state (epoch +
    // cursor) intact so the next connection replays inside the retention window, and dial
    // immediately.
    const reconnectNow = (): void => {
        clearHeartbeatWatch();

        if (reconnectCancel !== undefined) {
            reconnectCancel();
            reconnectCancel = undefined;
        }

        if (socket !== undefined) socket.close(1011, 'client refresh');

        open();
    };

    return {
        status: () => current,

        connect: () => {
            open();
        },

        subscribe: (spec) => {
            nextSubId += 1;

            const id = `s${nextSubId}`;
            const sub: StreamSubscription = {
                id,
                spec,
                cursor: spec.cursor ?? null,
                sequence: 0,
                unsubscribe: () => {
                    if (!subs.has(id)) return;

                    subs.delete(id);
                    expected.delete(id);

                    // T3b: the goodbye goes only when the server actually holds this id,
                    // mirroring `reregister` above. Two corrections to the previous
                    // comment, which claimed this "stops the server queueing frames for
                    // the pane even mid-drop":
                    //   - mid-drop, `send` is a no-op on a non-open socket, so nothing
                    //     reached the server anyway; on a drop this client discards the
                    //     whole registration set (`handleDrop` clears `registered`) and
                    //     re-registers from `subs` on the next `welcome`, and the SERVER
                    //     drops every registration with the socket at itself
                    //     (../server/stream/connection.ts:356).
                    //   - an id the server never held (or no longer holds) would buy one
                    //     `unknown_subscription` error frame per farewell
                    //     (../server/stream/broker.ts:810-813) — tolerated, but pointless.
                    if (registered.delete(id)) send({ type: 'unsubscribe', subscription_id: id });
                }
            };

            subs.set(id, sub);
            expected.set(id, null);

            // Queued while not open: `onopen` flushes every subscription, so a pane
            // that mounted during a reconnect still gets its frames.
            if (current === 'open') sendSubscribe(sub);
            else if (current === 'connecting' || current === 'reconnecting') {
                // T3: a subscribe during an outage used to call `open()`, whose only
                // guard is `connecting`/`open` — so in `reconnecting` it DIALED IMMEDI-
                // ATELY, in front of the backoff timer that is already pending, and each
                // pane that mounted (or re-expanded) during the outage started another
                // connection attempt. That is the reconnect storm this client's own
                // comment says it exists to avoid, and the burst the server prices at 32
                // messages/second (`connection.ts:305`, close 4429). The registration is
                // queued instead; `scheduleReconnect` is a no-op while the timer is
                // pending and is the safety net when it is not.
                scheduleReconnect();
            } else open();

            return sub;
        },

        close: (reason) => {
            manualClose = true;
            clearHeartbeatWatch();

            if (reconnectCancel !== undefined) {
                reconnectCancel();
                reconnectCancel = undefined;
            }

            if (current === 'open') {
                // A clean goodbye: the server closes with 1000, which is how this
                // connection does not look like a drop in the server's diagnostics.
                send({ type: 'bye', ...(reason === undefined ? {} : { reason }) });
                socket?.close(1000, reason ?? 'client bye');
            } else {
                socket?.close(1000, reason ?? 'client bye');
            }

            socket = undefined;
            subs.clear();
            expected.clear();
            registered.clear();
            setStatus('closed');
        },

        refresh: () => reconnectNow(),

        // T3b: the rate-limited form, for patch-driven callers (the board's follow sync
        // runs on every `thread.upsert`). One forced dial per down period: the first
        // expand while the plane is down re-dials immediately, later ones leave the
        // backoff clock alone. `open` means there is nothing to force, and re-arms the
        // allowance for the next drop.
        forceReconnectOnce: () => {
            if (current === 'open') {
                forcedWhileDown = false;

                return;
            }

            if (forcedWhileDown) return;

            forcedWhileDown = true;
            reconnectNow();
        },

        resumeState: () => ({ epoch, cursor }),

        subscriptions: () => [...subs.values()]
    };
};

// The application-level singleton. The shell owns exactly one of these per page and
// registers scoped subscriptions per pane, which is what keeps the connection count
// constant however many sessions and turns are open.
let shared: HarnessStreamClient | undefined;

// Options the FIRST `harnessStream()` call gets. The shell calls it with no argument
// (it wants the real socket), and a test host installs a socket double here before
// any module asks for the client — without this seam the singleton would capture the
// real `globalThis.WebSocket` and a suite could never drive a frame on purpose.
let defaults: StreamClientOptions | undefined;

export const configureHarnessStream = (options?: StreamClientOptions): void => {
    defaults = options;
};

export const harnessStream = (options?: StreamClientOptions): HarnessStreamClient => {
    if (shared === undefined) shared = createHarnessStream(options ?? defaults ?? {});

    return shared;
};

export const resetHarnessStream = (): void => {
    if (shared !== undefined) shared.close('page unload');
    shared = undefined;
};

// The stream broker: the one place the update conversation's counters, subscriptions, sequences,
// and replay windows live. It is transport-agnostic on purpose — it never touches a socket, and the
// REST side can drive it through plain function calls.
//
// WHY THIS MODULE EXISTS SEPARATELY FROM THE ADAPTERS
// The REST dispatcher (`src/server/api.ts`) and the store (`src/server/sessions.ts`) own the
// mutations; this module owns what the stream owes a client: an epoch, per-resource revisions,
// per-subscription monotonic sequences and cursors, a bounded replay window, and reconciliation
// WITHOUT a snapshot. The contract it must satisfy is swagger lines 2234-2272
// ("RECONCILIATION WITHOUT A SNAPSHOT", "SUBSCRIPTION REGISTRATION AND THE READ BASELINE"):
//
//   - registering a subscription and capturing the revision baseline are the SAME instant, so a
//     client may drop every frame at or below `subscription_state.sequence` and apply everything
//     above it;
//   - `subscription_state.revisions` is a short per-scope list of counters (<= 20 records), never a
//     resource body, and never a snapshot: it is built from counter lookups only;
//   - a cursor is `base64url(epoch:sequence)`; a foreign epoch answers `epoch_mismatch`, a cursor
//     older than the retained window answers `cursor_expired`, and frames lost on a live
//     connection answer `frames_dropped` (the closed three-member reason set).
//
// THE INTEGRATION CONTRACT FOR THE REST/STORE OWNER (T13)
// Nothing here imports the store, so wiring is additive and lives in one place
// (./mount.ts `createStreamSources`). The three callbacks are all optional and all cheap:
//
//   exists?(resource, id)          -> the `unknown_resource` check (step 5 of the precedence)
//   baseline?(scope, ids)          -> the per-scope counter list (O(kinds) lookups, NO snapshot)
//   link?(resource, id)            -> the REST path a resync names (defaults to ./protocol.ts)
//
// and publishing is one call: `broker.publish({ kind, session_id?, thread_id?, turn_id?, payload })`.
// `store.watchView` is deliberately NOT used anywhere in this module: it opens by emitting a whole
// compiled view, which is the payload class the stream design removed.
//
// Cross-references:
//   - ./protocol.ts             — the tables this module routes with, plus the cursor codec
//   - ./connection.ts           — the per-connection conversation that calls open()/subscribe()
//   - ./mount.ts                — http.Server attachment + the store/registry source bridge
//   - ../../shared/harness-stream.ts — the generated frame types (verbatim field spelling)

import {
    HARNESS_WS_STREAM_LIMITS,
    type StreamResourceKind,
    type WsResyncRequired,
    type WsRevisionRecord,
    type WsServerMessage,
    type WsStreamLimits,
    type WsSubscribe,
    type WsSubscriptionFilters,
    type WsSubscriptionScope,
    type WsSubscriptionState,
    type WsUpdate,
    type WsUpdateKind
} from '../../shared/harness-stream';
// T13's shared epoch hub: the stream's epoch is the SAME value the REST surface reports, because a
// revision is only comparable within one epoch (see the header of ../../shared/harness-api.ts).
import { HARNESS_RUNTIME_EPOCH } from '../api-events';
import {
    HARNESS_WS_CLOSE_CODES,
    HARNESS_WS_KIND_RESOURCES,
    HARNESS_WS_SCOPE_BASELINES,
    HARNESS_WS_SCOPE_FILTERS,
    HARNESS_WS_SCOPE_PUBLISHES,
    chunkStreamPayload,
    defaultStreamLink,
    decodeStreamCursor,
    encodeStreamCursor,
    isKindPublishedTo,
    resolveStreamLimits,
    streamFrameBytes,
    streamResourceIdFor,
    streamUpdateEnvelope,
    type StreamFailure
} from './protocol';

/** One addressed counter: the pair a revision is only ever compared within (same kind, id, epoch). */
export type StreamResourceRef = { resource: StreamResourceKind; id: string | null };

/** The ids one subscription addresses. `global` uses none of them. */
export type StreamScopeIds = { session_id?: string; thread_id?: string; turn_id?: string };

/** The payload half of an update frame, derived from the generated variant so it cannot drift. */
type UpdatePayloadFor<K extends WsUpdateKind> = Omit<
    Extract<WsUpdate, { kind: K }>,
    'type' | 'subscription_id' | 'sequence' | 'cursor' | 'kind' | 'at'
>;

/**
 * What a publisher hands the broker. One shape per kind, with the body typed from the matching
 * `WsUpdate` variant, so `payload` cannot gain a field the contract forbids.
 *
 * `at` is the server clock time OF THE MUTATION, never of the send (spec `ordering.monotonic_rule`),
 * which is what lets a client order across subscriptions. `resources` overrides the counters moved,
 * and is REQUIRED for `catalogue.updated` unless the payload's `catalogue` field names the
 * collection (then it is derived).
 */
export type StreamEventFor<K extends WsUpdateKind> = {
    kind: K;
    payload: UpdatePayloadFor<K>;
    session_id?: string;
    thread_id?: string;
    turn_id?: string;
    resources?: StreamResourceRef[];
    at?: number;
};

export type StreamEvent = { [K in WsUpdateKind]: StreamEventFor<K> }[WsUpdateKind];

/**
 * How a frame left the broker. The sink is the connection: it owns the socket queue and therefore
 * owns the answer. `dropped` means the connection dropped this update for backpressure, which is
 * the only outcome that turns into `resync_required{ reason: frames_dropped }`.
 */
export type StreamDelivery = 'sent' | 'queued' | 'dropped' | 'closed';

export type StreamSink = (frame: WsServerMessage) => StreamDelivery;

/** Host callbacks that resolve existence, counters, and REST links without a snapshot. */
export type StreamBrokerSources = {
    /**
     * `unknown_resource` check (precedence step 5). `ids` is the full id set of the subscription
     * being validated, which is what lets a host answer for a THREAD or a TURN (both are only
     * meaningful inside their session) from a single lookup.
     */
    exists?: (resource: StreamResourceKind, id: string | null, ids: StreamScopeIds) => boolean;
    /**
     * The per-scope revision baseline for `subscription_state.revisions`. MUST be O(kinds) counter
     * lookups — never a compiled view, never a session snapshot.
     */
    baseline?: (scope: WsSubscriptionScope, ids: StreamScopeIds) => WsRevisionRecord[] | undefined;
    /** The REST path a `resync_required` names for one resource. Defaults to ./protocol.ts. */
    link?: (resource: StreamResourceKind, id: string | null) => string | undefined;
    clock?: () => number;
};

export type StreamBrokerOptions = StreamBrokerSources & {
    /** Omit to mint a fresh process epoch (one broker per process is the contract's rule). */
    epoch?: string;
    /** Retune only the six deployment-tunable numbers; fixed contract values are ignored. */
    limits?: Partial<WsStreamLimits>;
};

export type StreamSubscribeRequest = {
    subscription_id: string;
    scope: WsSubscriptionScope;
    ids: StreamScopeIds;
    filters?: WsSubscriptionFilters;
    pace: 'ordered' | 'ack';
    cursor?: string;
};

/** `state` first, then any `replay` frames; `resync` and `failure` are mutually exclusive with both. */
export type StreamSubscribeOutcome =
    | { status: 'ok'; state: WsSubscriptionState; replay: WsUpdate[] }
    | { status: 'resync'; resync: WsResyncRequired }
    | { status: 'rejected'; failure: StreamFailure };

export type StreamSessionHandle = {
    readonly id: string;
    readonly subscriptionCount: number;
    /** Connection-level resume state from `hello`; a `subscribe` cursor overrides it for itself. */
    setResume(cursor: string | undefined): void;
    subscribe(request: StreamSubscribeRequest): StreamSubscribeOutcome;
    unsubscribe(subscriptionId: string): StreamFailure | undefined;
    acknowledge(subscriptionId: string, sequence: number): StreamFailure | undefined;
    /**
     * Report frames LOST ON THE WIRE for one subscription (the connection's send queue evicted
     * them) and answer `resync_required{ reason: frames_dropped }`. This is the only path that
     * turns a delivery failure into a contract frame, so the transport never invents one itself.
     */
    requestResync(subscriptionId: string, reason: WsResyncRequired['reason'], lostFrames?: number): void;
    /** Release every subscription of this connection; each one keeps a parked replay window. */
    release(): void;
};

export type HarnessStreamBroker = {
    epoch(): string;
    limits(): WsStreamLimits;
    /** Current counter for one addressed resource; 0 means "never moved in this epoch". */
    revision(resource: StreamResourceKind, id?: string | null): number;
    /** Move one counter by one and return the new value. */
    bump(resource: StreamResourceKind, id?: string | null): number;
    /**
     * Mirror a counter the REST side owns (a store or projection already mints revisions). Max-
     * wins, so a late duplicate never moves a counter backwards within the epoch.
     */
    setRevision(resource: StreamResourceKind, id: string | null | undefined, revision: number): number;
    exists(resource: StreamResourceKind, id?: string | null, ids?: StreamScopeIds): boolean;
    link(resource: StreamResourceKind, ids: StreamScopeIds): string;
    open(sink: StreamSink): StreamSessionHandle;
    /** Fan one mutation out; returns how many subscriptions received at least one frame. */
    publish(event: StreamEvent): number;
    /** Live subscription total, for diagnostics and the REST capability surface. */
    subscriptions(): number;
    /** Close every live connection (host shutdown 1001, epoch change 1012) and drop all state. */
    close(code?: number): void;
};

/** One retained frame inside a replay window. */
type RetainedFrame = { sequence: number; at: number; frame: WsUpdate };

type Subscription = {
    subscriptionId: string;
    session: Session;
    scope: WsSubscriptionScope;
    ids: StreamScopeIds;
    filters?: WsSubscriptionFilters;
    pace: 'ordered' | 'ack';
    /** key of the parked window this subscription resumed, if any (for reparking on release). */
    sequence: number;
    cursor: string;
    retained: RetainedFrame[];
    /** `ack` pacing: frames minted while the client owes an acknowledgement. */
    hold: WsUpdate[];
    awaitingAck: boolean;
    ackTimer?: ReturnType<typeof setTimeout>;
    resyncPending: boolean;
    closed: boolean;
};

// A connection's subscriptions PLUS a copy of each replay window, so a client that drops the socket
// and reconnects within the retention window can resume from its cursor. The parked copy is what
// makes the contract's single resume input (`hello`, or a per-`subscribe` cursor) work at all.
type Session = {
    id: string;
    sink: StreamSink;
    subscriptions: Map<string, Subscription>;
    resumeCursor?: string;
    released: boolean;
};

type ParkedWindow = {
    key: string;
    scope: WsSubscriptionScope;
    ids: StreamScopeIds;
    filters?: WsSubscriptionFilters;
    pace: 'ordered' | 'ack';
    sequence: number;
    retained: RetainedFrame[];
    expires: ReturnType<typeof setTimeout>;
};

// The epoch comes from the REST owner's shared hub (`../api-events.ts`), because the contract allows
// a revision comparison ONLY within one epoch: if the stream minted its own, every `revisions`
// record it published would be uncomparable with the `X-Harness-Revision` a REST read carried. A
// caller may still pass an explicit epoch (a test with a fixed value, or an embedder with its own).
const defaultEpoch = (): string => HARNESS_RUNTIME_EPOCH;

const counterKey = (resource: StreamResourceKind, id: string | null | undefined): string =>
    `${resource}:${id ?? ''}`;

/** Subscription identity across a reconnect: the scope plus the ids it addresses. */
const subscriptionKey = (scope: WsSubscriptionScope, ids: StreamScopeIds): string =>
    `${scope}:${ids.session_id ?? ''}:${ids.thread_id ?? ''}:${ids.turn_id ?? ''}`;

const byteSize = (value: unknown): number => streamFrameBytes(JSON.stringify(value));

/** `catalogue.updated` names its collection inside the payload, so its counter is derived. */
const catalogueResource = (event: StreamEvent): StreamResourceRef[] => {
    if (event.kind !== 'catalogue.updated') return [];

    const collection = (event.payload as { catalogue?: unknown }).catalogue;
    const resource: StreamResourceKind = collection === 'agents' ? 'agents' : collection === 'tools' ? 'tools' : 'harnesses';

    return [{ resource, id: null }];
};

export const createStreamBroker = (options: StreamBrokerOptions = {}): HarnessStreamBroker => {
    const epoch = options.epoch ?? defaultEpoch();
    const limits = resolveStreamLimits(options.limits);
    const clock = options.clock ?? Date.now;
    const counters = new Map<string, number>();
    const sessions = new Map<string, Session>();
    const parked = new Map<string, ParkedWindow>();
    let nextSessionId = 0;

    // ------------------------------------------------------------------
    // Counters
    // ------------------------------------------------------------------

    const revision = (resource: StreamResourceKind, id: string | null = null): number =>
        counters.get(counterKey(resource, id)) ?? 0;

    const bump = (resource: StreamResourceKind, id: string | null = null): number => {
        const key = counterKey(resource, id);
        const next = (counters.get(key) ?? 0) + 1;
        counters.set(key, next);
        return next;
    };

    const setRevision = (resource: StreamResourceKind, id: string | null | undefined, value: number): number => {
        const key = counterKey(resource, id);
        const next = Math.max(counters.get(key) ?? 0, Number.isFinite(value) ? Math.trunc(value) : 0);
        counters.set(key, next);
        return next;
    };

    // ------------------------------------------------------------------
    // Baseline, existence, links
    // ------------------------------------------------------------------

    const exists = (resource: StreamResourceKind, id: string | null = null, ids: StreamScopeIds = {}): boolean =>
        options.exists === undefined ? true : options.exists(resource, id, ids);

    const link = (resource: StreamResourceKind, ids: StreamScopeIds): string => {
        const id = streamResourceIdFor(resource, ids);
        return options.link?.(resource, id) ?? defaultStreamLink(resource, ids);
    };

    // The per-scope revision list, from the host's counters when it has them (the store owns most
    // of them) and from this broker's own counters otherwise. Never more than
    // `revision_records_per_state` records, and never a resource body.
    const baselineRecords = (scope: WsSubscriptionScope, ids: StreamScopeIds): WsRevisionRecord[] => {
        const provided = options.baseline?.(scope, ids);
        const cap = limits.revision_records_per_state;

        const records =
            provided !== undefined
                ? provided.map((record) => ({ ...record, epoch }))
                : HARNESS_WS_SCOPE_BASELINES[scope].map((resource) => ({
                      resource,
                      id: streamResourceIdFor(resource, ids),
                      revision: revision(resource, streamResourceIdFor(resource, ids)),
                      epoch
                  }));

        return records.slice(0, cap);
    };

    // ------------------------------------------------------------------
    // Replay windows
    // ------------------------------------------------------------------

    // Retention is whichever of the two bounds ends FIRST (spec `replay.retained_seconds`), so old
    // frames are evicted by age as well as by count. `expiresAt` of the OLDEST retained frame is
    // what makes a cursor "too old".
    const retain = (subscription: { retained: RetainedFrame[] }, frame: RetainedFrame): void => {
        subscription.retained.push(frame);

        const oldestAllowed = clock() - limits.replay_seconds * 1000;

        while (
            subscription.retained.length > limits.replay_frames ||
            (subscription.retained.length > 0 && subscription.retained[0].at < oldestAllowed)
        ) {
            subscription.retained.shift();
        }
    };

    const park = (subscription: Subscription): void => {
        // A window with nothing in it cannot answer a resume, so it is not worth a timer.
        if (subscription.retained.length === 0) return;

        const key = subscriptionKey(subscription.scope, subscription.ids);
        const previous = parked.get(key);
        if (previous !== undefined) clearTimeout(previous.expires);

        const window: ParkedWindow = {
            key,
            scope: subscription.scope,
            ids: { ...subscription.ids },
            ...(subscription.filters === undefined ? {} : { filters: { ...subscription.filters } }),
            pace: subscription.pace,
            sequence: subscription.sequence,
            retained: [...subscription.retained],
            expires: setTimeout(() => parked.delete(key), limits.replay_seconds * 1000)
        };

        // The park timer must never hold a closing process open.
        window.expires.unref?.();
        parked.set(key, window);
    };

    const dropParked = (key: string): void => {
        const window = parked.get(key);
        if (window === undefined) return;
        clearTimeout(window.expires);
        parked.delete(key);
    };

    // ------------------------------------------------------------------
    // Delivery
    // ------------------------------------------------------------------

    const resyncFrame = (subscription: Subscription, reason: WsResyncRequired['reason'], lostFrames?: number): WsResyncRequired => {
        // `resources` names the bounded reads that restore this subscription; the set is exactly
        // its baseline kinds, capped at the 16 links `WsResyncRequired` allows.
        const kinds = HARNESS_WS_SCOPE_BASELINES[subscription.scope].slice(0, 16);

        return {
            type: 'resync_required',
            subscription_id: subscription.subscriptionId,
            reason,
            epoch,
            cursor: subscription.cursor,
            ...(lostFrames === undefined || lostFrames <= 0 ? {} : { lost_frames: lostFrames }),
            resources: kinds.map((resource) => {
                const id = streamResourceIdFor(resource, subscription.ids);
                return { resource, id, revision: revision(resource, id), epoch, link: link(resource, subscription.ids) };
            })
        };
    };

    // A `resync_required` frame does NOT consume a sequence and is never retained for replay: it is
    // an out-of-band instruction tied to the moment it was sent, and consuming a sequence would
    // look like a gap to a client doing arithmetic on `update` sequences.
    const sendResync = (subscription: Subscription, reason: WsResyncRequired['reason'], lostFrames?: number): void => {
        subscription.session.sink(resyncFrame(subscription, reason, lostFrames));
    };

    const clearAckTimer = (subscription: Subscription): void => {
        if (subscription.ackTimer === undefined) return;
        clearTimeout(subscription.ackTimer);
        subscription.ackTimer = undefined;
    };

    // `pace: ack` stops and waits: one frame goes out, the rest are held, and an `ack` that never
    // arrives converts the subscription to `resync_required` rather than queueing without bound
    // (spec `backpressure.ack_paced_rule`).
    const armAckTimer = (subscription: Subscription): void => {
        if (subscription.ackTimer !== undefined) return;

        subscription.ackTimer = setTimeout(() => {
            subscription.ackTimer = undefined;
            if (subscription.closed) return;
            const lost = subscription.hold.length;
            subscription.hold = [];
            subscription.awaitingAck = false;
            sendResync(subscription, 'frames_dropped', lost);
        }, limits.ack_timeout_ms);

        subscription.ackTimer.unref?.();
    };

    const flush = (subscription: Subscription): void => {
        const held = subscription.hold;
        subscription.hold = [];

        for (const frame of held) {
            const outcome = subscription.session.sink(frame);
            if (outcome === 'dropped') sendResync(subscription, 'frames_dropped', 1);
        }

        // Stop-and-wait stays armed: the client owes an acknowledgement for the highest frame it
        // just received, and the next frame will be held until it arrives.
        subscription.awaitingAck = true;
    };

    // The ack timeout only guards a BACKLOG. A stop-and-wait subscription that was acknowledged
    // into silence has nothing queued, so a quiet client is never punished with a spurious resync
    // (the rule exists so the server does not "queue without bound").
    const deliver = (subscription: Subscription, frame: WsUpdate): void => {
        subscription.sequence += 1;
        subscription.cursor = encodeStreamCursor(epoch, subscription.sequence);

        // The envelope (`subscription_id`, `sequence`, `cursor`) is minted HERE, never by the
        // publisher: a caller hands over a kind plus a payload, and the broker is the only thing
        // that knows which subscription the frame belongs to and where its sequence stands.
        const stamped: WsUpdate = {
            ...frame,
            subscription_id: subscription.subscriptionId,
            sequence: subscription.sequence,
            cursor: subscription.cursor
        } as WsUpdate;

        retain(subscription, { sequence: subscription.sequence, at: stamped.at, frame: stamped });

        if (subscription.pace === 'ack' && subscription.awaitingAck) {
            subscription.hold.push(stamped);
            armAckTimer(subscription);
            return;
        }

        if (subscription.pace === 'ack') subscription.awaitingAck = true;

        const outcome = subscription.session.sink(stamped);

        if (outcome === 'dropped') sendResync(subscription, 'frames_dropped', 1);
    };

    // ------------------------------------------------------------------
    // Routing
    // ------------------------------------------------------------------

    // Does this subscription want this event at all? Scope publishes first (a kind outside the
    // scope's set never reaches a client), then the ids it addresses, then its filters. Narrowing
    // only ever REMOVES frames — it never widens a payload.
    const matches = (subscription: Subscription, event: StreamEvent): boolean => {
        if (!isKindPublishedTo(subscription.scope, event.kind)) return false;

        if (subscription.scope !== 'global') {
            if (subscription.ids.session_id === undefined || subscription.ids.session_id !== event.session_id) return false;
            if (subscription.scope === 'thread' && subscription.ids.thread_id !== event.thread_id) return false;
            if (subscription.scope === 'turn' && subscription.ids.turn_id !== event.turn_id) return false;
        }

        // `run.event` is opt-in debug traffic: the `events` filter defaults to false, and a scope
        // that never asked for it must not pay for raw event bytes.
        if (event.kind === 'run.event' && subscription.filters?.events !== true) return false;

        const filters = subscription.filters;
        if (filters === undefined) return true;

        // `status` narrows the turn rows published on a session scope.
        if (filters.status !== undefined && event.kind === 'turn.upsert') {
            const status = (event.payload as { turn?: { status?: string } }).turn?.status;
            if (status !== undefined && status !== filters.status) return false;
        }

        // `thread_id` narrows the conversation whose rows and ops are published. An event with no
        // thread association (a session patch, a usage figure, a queue change) is conversation-
        // independent and therefore always stays, which is what keeps the filter from silently
        // starving a pane that is showing a thread.
        if (filters.thread_id !== undefined && event.thread_id !== undefined && event.thread_id !== filters.thread_id) return false;

        return true;
    };

    // Payload narrowing for the `turn` scope's two filters. `sections: false` keeps the frame and
    // strips the node/step bodies; `context: false` drops the `context:*` ops outright, and a frame
    // whose ops were ALL dropped is not sent at all (an empty ops array would be a lie about order).
    const narrow = (subscription: Subscription, event: StreamEvent): StreamEvent | undefined => {
        if (event.kind !== 'display.ops') return event;

        const filters = subscription.filters;
        if (filters === undefined) return event;
        if (filters.sections === undefined && filters.context === undefined) return event;

        // The payload is read through a widened view because `StreamEvent` is a union; the `narrow`
        // call site has already proved `kind === 'display.ops'`, so the shape below is the
        // `WsUpdateDisplayOps` payload exactly.
        const payload = event.payload as unknown as { turn_id: string; ops: Record<string, unknown>[] };
        let ops = payload.ops;

        if (filters.context === false) ops = ops.filter((op) => !String(op.op ?? '').startsWith('context:'));
        if (ops.length === 0) return undefined;

        if (filters.sections === false) {
            ops = ops.map((op) => {
                const { node, step, ...rest } = op as Record<string, unknown> & { node?: unknown; step?: unknown };
                void node;
                void step;
                return rest;
            });
        }

        return { ...event, payload: { ...payload, ops } as never };
    };

    // One event can become SEVERAL frames: `ops_per_update_frame`, `events_per_update_frame`, and
    // `ids_per_invalidation_frame` all say "more items become more frames, never a bigger one",
    // and `max_server_frame_bytes` is a promise the client may size a buffer by.
    const framesFor = (event: StreamEvent): WsUpdate[] => {
        const base = { ...(event.payload as Record<string, unknown>) } as Record<string, unknown>;
        const single = (payload: Record<string, unknown>): WsUpdate =>
            ({ ...payload, kind: event.kind, type: 'update' } as unknown as WsUpdate);

        if (event.kind === 'display.ops') {
            const ops = (base.ops as unknown[] | undefined) ?? [];
            const budget = limits.max_server_frame_bytes - 512;

            return chunkStreamPayload(ops, limits.ops_per_update_frame, budget, byteSize).map((chunk) =>
                single({ ...base, ops: chunk })
            );
        }

        if (event.kind === 'run.event') {
            const events = (base.events as unknown[] | undefined) ?? [];
            const budget = limits.max_server_frame_bytes - 512;

            return chunkStreamPayload(events, limits.events_per_update_frame, budget, byteSize).map((chunk) =>
                single({ ...base, events: chunk })
            );
        }

        if (event.kind === 'tool.registry_updated' || event.kind === 'agent.registry_updated' || event.kind === 'catalogue.updated') {
            const ids = (base.ids as unknown[] | undefined) ?? [];
            const chunks = chunkStreamPayload(ids, limits.ids_per_invalidation_frame, limits.max_server_frame_bytes, (id) => byteSize(id) + 2);

            if (chunks.length <= 1) return [single(base)];
            return chunks.map((chunk) => single({ ...base, ids: chunk }));
        }

        return [single(base)];
    };

    const publish = (event: StreamEvent): number => {
        const ids: StreamScopeIds = {};
        if (event.session_id !== undefined) ids.session_id = event.session_id;
        if (event.thread_id !== undefined) ids.thread_id = event.thread_id;
        if (event.turn_id !== undefined) ids.turn_id = event.turn_id;

        // 1. move the counters BEFORE fan-out, so every frame that follows is comparable with a
        //    REST read issued after it (`revisions` at or above the recorded revision wins). The
        //    default set comes from the kind table, except for `catalogue.updated`, whose counter
        //    is named inside the payload (`catalogue: harnesses | agents | tools`).
        const resources =
            event.resources ??
            (event.kind === 'catalogue.updated'
                ? catalogueResource(event)
                : HARNESS_WS_KIND_RESOURCES[event.kind].map((resource) => ({
                      resource,
                      id: streamResourceIdFor(resource, ids)
                  })));

        for (const resource of resources) bump(resource.resource, resource.id);

        // 2. fan out. Frames for one mutation keep the mutation's `at`, which is what lets a client
        //    order across subscriptions.
        const at = event.at ?? clock();
        let affected = 0;

        for (const session of sessions.values()) {
            for (const subscription of session.subscriptions.values()) {
                if (subscription.closed) continue;
                if (!matches(subscription, event)) continue;

                const narrowed = narrow(subscription, event);
                if (narrowed === undefined) continue;

                affected += 1;

                for (const frame of framesFor(narrowed)) {
                    deliver(subscription, { ...frame, at } as WsUpdate);
                }
            }
        }

        return affected;
    };

    // ------------------------------------------------------------------
    // Connections and subscriptions
    // ------------------------------------------------------------------

    const closeSubscription = (subscription: Subscription): void => {
        if (subscription.closed) return;
        subscription.closed = true;
        clearAckTimer(subscription);
        subscription.hold = [];
        park(subscription);
    };

    const open = (sink: StreamSink): StreamSessionHandle => {
        nextSessionId += 1;

        const session: Session = {
            id: `c${nextSessionId}`,
            sink,
            subscriptions: new Map(),
            released: false
        };

        sessions.set(session.id, session);

        const subscribe = (request: StreamSubscribeRequest): StreamSubscribeOutcome => {
            if (session.released) {
                return { status: 'rejected', failure: { code: 'internal', message: 'The connection is closed.', subscription_id: request.subscription_id } };
            }

            // `subscription_id` is client-chosen and unique per connection; the contract states the
            // uniqueness rule without naming a code, so the closest closed-vocabulary condition is a
            // schema failure (the frame cannot be honoured as sent).
            if (session.subscriptions.has(request.subscription_id)) {
                return {
                    status: 'rejected',
                    failure: {
                        code: 'invalid_payload',
                        message: `subscription_id ${request.subscription_id} is already in use on this connection.`,
                        subscription_id: request.subscription_id
                    }
                };
            }

            // Precedence step 5: required ids must name real resources. Checked before the filter
            // and budget steps so one bad id can never be reported as two different conditions.
            const required: [StreamResourceKind, string | undefined][] = [
                ['session', request.ids.session_id],
                ['thread', request.ids.thread_id],
                ['turn', request.ids.turn_id]
            ];

            for (const [resource, id] of required) {
                if (id === undefined) continue;
                if (exists(resource, id, request.ids)) continue;

                return {
                    status: 'rejected',
                    failure: { code: 'unknown_resource', message: `No ${resource} matches ${id}.`, subscription_id: request.subscription_id }
                };
            }

            // Precedence step 6: a filter the scope does not publish answers for THAT subscription
            // only; the connection and its other subscriptions keep working.
            const published = HARNESS_WS_SCOPE_FILTERS[request.scope];
            const unsupported = Object.keys(request.filters ?? {}).filter((key) => !published.includes(key as keyof WsSubscriptionFilters));

            if (unsupported.length > 0) {
                return {
                    status: 'rejected',
                    failure: {
                        code: 'unsupported_filter',
                        message: `${request.scope} does not publish ${unsupported.join(', ')}.`,
                        subscription_id: request.subscription_id
                    }
                };
            }

            // Precedence step 7: the per-connection budget.
            if (session.subscriptions.size >= limits.subscriptions_per_connection) {
                return {
                    status: 'rejected',
                    failure: {
                        code: 'too_many_subscriptions',
                        message: `A connection carries at most ${limits.subscriptions_per_connection} subscriptions.`,
                        subscription_id: request.subscription_id,
                        close_code: HARNESS_WS_CLOSE_CODES.tooManySubscriptions
                    }
                };
            }

            const cursor = request.cursor ?? session.resumeCursor;
            const key = subscriptionKey(request.scope, request.ids);
            const window = parked.get(key);

            const subscription: Subscription = {
                subscriptionId: request.subscription_id,
                session,
                scope: request.scope,
                ids: { ...request.ids },
                ...(request.filters === undefined ? {} : { filters: { ...request.filters } }),
                pace: request.pace,
                sequence: 0,
                cursor: encodeStreamCursor(epoch, 0),
                retained: [],
                hold: [],
                awaitingAck: false,
                resyncPending: false,
                closed: false
            };

            const decoded = decodeStreamCursor(cursor);

            // Epoch policy: a cursor from another process is dead on arrival, and the answer names
            // the bounded reads to re-issue. Never a snapshot.
            if (decoded !== undefined && decoded.epoch !== epoch) {
                const resync = resyncFrame(subscription, 'epoch_mismatch');
                return { status: 'resync', resync: { ...resync, cursor: encodeStreamCursor(decoded.epoch, decoded.sequence) } };
            }

            if (decoded !== undefined && window !== undefined && window.retained.length > 0) {
                const oldest = window.retained[0];

                // A cursor below the retained floor (or older than the age bound) cannot be
                // answered from memory: the client re-reads the resources it cares about.
                if (decoded.sequence < oldest.sequence - 1 || clock() - oldest.at > limits.replay_seconds * 1000) {
                    const resync = resyncFrame(subscription, 'cursor_expired');
                    return { status: 'resync', resync: { ...resync, cursor: cursor ?? resync.cursor } };
                }
            }

            // Resume only when the client actually sent a cursor; with none, the subscription starts
            // fresh at the server's current position (which is what "starts every subscription fresh
            // at its own current position" means for a scope whose window was never parked).
            if (decoded !== undefined && window !== undefined && window.retained.length > 0) {
                subscription.sequence = window.sequence;
                subscription.cursor = encodeStreamCursor(epoch, window.sequence);
                subscription.retained = window.retained;
                dropParked(key);
            }

            session.subscriptions.set(request.subscription_id, subscription);

            const replay =
                decoded !== undefined && window !== undefined
                    ? window.retained.filter((entry) => entry.sequence > decoded.sequence).map((entry) => entry.frame)
                    : [];

            // Registration and the baseline are one instant: the state frame reports the sequence
            // the client is reconciled against, and every frame ABOVE it is applied by the client.
            const stateSequence = replay.length > 0 ? replay[replay.length - 1].sequence : subscription.sequence;
            // The scope's declared publish set, verbatim from `x-websocket.subscription_scopes`.
            // `run.event` is listed for the `session` scope even when the `events` filter is off:
            // the field advertises what the SCOPE can publish, and the filter decides what this
            // subscription actually receives (the spec states run.event is in the list "so every
            // kind has a reachable publishing scope").
            publishes: HARNESS_WS_SCOPE_PUBLISHES[request.scope]

            const state: WsSubscriptionState = {
                type: 'subscription_state',
                subscription_id: request.subscription_id,
                scope: request.scope,
                epoch,
                sequence: stateSequence,
                cursor: encodeStreamCursor(epoch, stateSequence),
                revisions: baselineRecords(request.scope, request.ids),
                ...(request.filters === undefined ? {} : { filters_applied: { ...request.filters } }),
                ...(replay.length > 0 ? { replayed_frames: replay.length } : {}),
                publishes: [...HARNESS_WS_SCOPE_PUBLISHES[request.scope]]
            };

            for (const frame of replay) retain(subscription, { sequence: frame.sequence, at: frame.at, frame });

            return { status: 'ok', state, replay };
        };

        const find = (subscriptionId: string): Subscription | undefined => session.subscriptions.get(subscriptionId);

        const unsubscribe = (subscriptionId: string): StreamFailure | undefined => {
            const subscription = find(subscriptionId);

            // An unknown or already-closed id is step 4 of the precedence ladder.
            if (subscription === undefined) {
                return { code: 'unknown_subscription', message: `No subscription ${subscriptionId} is open on this connection.`, subscription_id: subscriptionId };
            }

            session.subscriptions.delete(subscriptionId);
            closeSubscription(subscription);
            return undefined;
        };

        const acknowledge = (subscriptionId: string, sequence: number): StreamFailure | undefined => {
            const subscription = find(subscriptionId);

            if (subscription === undefined) {
                return { code: 'unknown_subscription', message: `No subscription ${subscriptionId} is open on this connection.`, subscription_id: subscriptionId };
            }

            // Acking a subscription that did not ask for pacing is ignored rather than an error, so
            // a client may always ack.
            if (subscription.pace !== 'ack') return undefined;

            clearAckTimer(subscription);
            subscription.awaitingAck = false;
            subscription.hold.sort((left, right) => left.sequence - right.sequence);
            flush(subscription);

            void sequence;
            return undefined;
        };

        const release = (): void => {
            if (session.released) return;
            session.released = true;
            sessions.delete(session.id);

            for (const subscription of session.subscriptions.values()) closeSubscription(subscription);
            session.subscriptions.clear();
        };

        const requestResync = (subscriptionId: string, reason: WsResyncRequired['reason'], lostFrames?: number): void => {
            const subscription = find(subscriptionId);
            if (subscription === undefined || subscription.closed) return;
            sendResync(subscription, reason, lostFrames);
        };

        return {
            id: session.id,
            get subscriptionCount(): number {
                return session.subscriptions.size;
            },
            setResume: (cursor) => {
                session.resumeCursor = cursor;
            },
            subscribe,
            unsubscribe,
            acknowledge,
            requestResync,
            release
        };
    };

    const close = (code: number = HARNESS_WS_CLOSE_CODES.goingAway): void => {
        for (const session of [...sessions.values()]) {
            // `close` is the host's own shutdown path: the sink is the connection, which turns the
            // code into a WS close frame (see ./connection.ts, which closes on any `error` frame that
            // carries a `close_code`).
            session.sink({ type: 'error', code: 'internal', message: `The stream is closing (code ${code}).`, retryable: false, close_code: code });

            for (const subscription of session.subscriptions.values()) closeSubscription(subscription);
            session.subscriptions.clear();
            session.released = true;
            sessions.delete(session.id);
        }

        for (const window of parked.values()) clearTimeout(window.expires);
        parked.clear();
        counters.clear();
    };

    return {
        epoch: () => epoch,
        limits: () => limits,
        revision,
        bump,
        setRevision,
        exists,
        link,
        open,
        publish,
        subscriptions: () => {
            let total = 0;
            for (const session of sessions.values()) total += session.subscriptions.size;
            return total;
        },
        close
    };
};

/** The shipped numbers, re-exported so a host never imports the generated module for one constant. */
export const DEFAULT_STREAM_LIMITS = HARNESS_WS_STREAM_LIMITS;

/** A subscription's advertised publish set, for diagnostics and the REST capability document. */
export const streamScopePublishes = (scope: WsSubscriptionScope): readonly WsUpdateKind[] => HARNESS_WS_SCOPE_PUBLISHES[scope];

/** Every scope, in contract order (used by the capability surface and the tests). */
export const STREAM_SCOPES: readonly WsSubscriptionScope[] = ['global', 'session', 'thread', 'turn'];

/** A `subscribe` frame is the same shape the client sends; this alias is the broker's input name. */
export type StreamSubscribeFrame = WsSubscribe;

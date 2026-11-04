// Attaching the update stream to an HTTP listener, and the bridge that lets the store/registry
// answer the stream's three cheap questions without importing anything from this module.
//
// TWO HOSTS, ONE MOUNT. The standalone listener (`src/server/start.ts`) and the
// `@underload/service` gateway (`src/server/endpoint/harness/service-route-stream.ts`) both end up
// calling `mount.upgrade(request, socket, head)`. The standalone server can register the `upgrade`
// event itself; the service gateway owns its listener, so the loader hands the upgrade through the
// endpoint module's `upgrade` export. Everything below the handshake is identical, which is what
// keeps the epoch, the counters, and the subscriptions consistent between HTTP and WS in one
// process.
//
// ORIGIN POLICY IS NOT AUTHENTICATION. The handshake has no credential (spec `handshake.authentication`:
// "None"), so this gate is the same browser-origin rule the service's HTTP adapter applies, and it
// refuses with 403 BEFORE the upgrade: a policy refusal, not an authentication challenge. A client
// with no `Origin` header (curl, a native app, server-to-server) is not a cross-origin page and
// passes, exactly like the HTTP rule.
//
// Cross-references:
//   - ./transport.ts            — the handshake itself (`performUpgrade`)
//   - ./connection.ts           — the conversation started for an accepted peer
//   - ./broker.ts               — counters, subscriptions, replay
//   - ../service.ts             — the same origin rule at the HTTP layer (private copy there)
//   - ../../shared/origin.ts    — the one definition of loopback and GitHub Pages hosts

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { HARNESS_WS_SUBPROTOCOL } from '../../shared/harness-api';
import { isLoopbackHostname, isPagesOrigin } from '../../shared/origin';
import type { StreamResourceKind, WsStreamLimits, WsSubscriptionScope, WsRevisionRecord } from '../../shared/harness-stream';
// T13's shared epoch/revision hub. The stream MUST report the epoch the REST surface reports, and
// MUST read the same counters a REST read stamps in `X-Harness-Revision`, so the hub — not this
// module — is the source of both. Imported as the one cross-owner seam both sides agreed on.
import { HARNESS_RUNTIME_EPOCH, resourceKeyOf, type HarnessEventHub } from '../api-events';
import { HARNESS_WS_SCOPE_BASELINES } from './protocol';
import { createStreamBroker, type HarnessStreamBroker, type StreamBrokerSources, type StreamEvent, type StreamScopeIds } from './broker';
import { startStreamConnection, type StreamConnection } from './connection';
import { HARNESS_WS_STREAM_PATH } from './protocol';
import { performUpgrade, rejectUpgrade } from './transport';

/**
 * The stream's browser-origin rule: same host as the request, a loopback hostname, or this
 * package's deployed GitHub Pages UI. Deliberately identical to `src/server/service.ts`'s HTTP
 * rule; it lives here (rather than being imported from there) because service.ts imports THIS
 * module for the upgrade, and a back-import would make that a cycle.
 */
export const isStreamOriginAllowed = (origin: string, host: string | undefined): boolean => {
    let parsed: URL;

    try {
        parsed = new URL(origin);
    } catch {
        // `Origin: null` (sandboxed iframe, file://) proves nothing.
        return false;
    }

    if (host !== undefined && parsed.host.toLowerCase() === host.toLowerCase()) return true;
    if (isLoopbackHostname(parsed.hostname)) return true;

    return isPagesOrigin(origin);
};

/** Hosts may widen the gate for their own deployed UI without touching the default rule. */
export type StreamOriginPolicy = {
    enabled?: boolean;
    allow?: (origin: string, host: string | undefined) => boolean;
};

const policyFor = (policy: StreamOriginPolicy | undefined) => (request: IncomingMessage): { ok: true } | { ok: false; status: number; message: string } => {
    if (policy?.enabled === false) return { ok: true };

    const origin = request.headers.origin;

    if (typeof origin !== 'string' || origin.length === 0) return { ok: true };

    const host = request.headers.host;

    if (policy?.allow?.(origin, typeof host === 'string' ? host : undefined) === true) return { ok: true };
    if (isStreamOriginAllowed(origin, typeof host === 'string' ? host : undefined)) return { ok: true };

    return { ok: false, status: 403, message: 'Cross-origin stream upgrades are not allowed.' };
};

export type HarnessStreamMountOptions = {
    /** Share an existing broker (the runtime bridge does exactly this) or omit to build one. */
    broker?: HarnessStreamBroker;
    /** Existence / baseline / link callbacks. Ignored when `broker` is supplied. */
    sources?: StreamBrokerSources;
    epoch?: string;
    limits?: Partial<WsStreamLimits>;
    /** Default `/v1/harness/stream`, canonical in both mounts. */
    path?: string;
    origin?: StreamOriginPolicy;
    /** Test seam: only the heartbeat cadence, never an advertised limit. */
    heartbeatIntervalMs?: number;
    onConnection?: (connection: StreamConnection) => void;
};

export type HarnessStreamMount = {
    broker: HarnessStreamBroker;
    path: string;
    /** Live connections, for the capability surface and tests. */
    connections(): number;
    /**
     * Handle one HTTP upgrade. Returns true when this mount took the socket over (accepted or
     * refused with a status), false when the request is not for this path so the caller can try the
     * next candidate. A `false` return never writes to the socket.
     */
    upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
    /** Attach to a Node http.Server. Returns the detach function. */
    attach(server: Server): () => void;
    /** Close every live connection (1001 by default, 1012 for an epoch change). */
    close(code?: number): void;
};

/**
 * One live stream per path per mount. Connections are tracked here rather than in the broker
 * because the broker's lifetime is the PROCESS (it owns the epoch) while the mount's lifetime is
 * the LISTENER.
 */
export const createHarnessStreamMount = (options: HarnessStreamMountOptions = {}): HarnessStreamMount => {
    const broker =
        options.broker ??
        createStreamBroker({
            // The process epoch is the REST hub's; an explicit `epoch` is only for a test that wants
            // a fixed value.
            epoch: options.epoch ?? HARNESS_STREAM_EPOCH,
            ...(options.limits === undefined ? {} : { limits: options.limits }),
            ...(options.sources === undefined ? {} : options.sources)
        });

    const path = options.path ?? HARNESS_WS_STREAM_PATH;
    const connections = new Set<StreamConnection>();

    const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
        // A quick path test FIRST, so a `false` return leaves the socket untouched for the next
        // candidate route (the service gateway may host several upgrading endpoints).
        const raw = request.url ?? '/';
        const marker = raw.indexOf('?');
        const pathname = marker === -1 ? raw : raw.slice(0, marker);

        if (pathname !== path) return false;

        const socketHandle = performUpgrade(request, socket, head, {
            path,
            subprotocols: [HARNESS_WS_SUBPROTOCOL],
            headers: { [HARNESS_EPOCH_HEADER_NAME]: broker.epoch() },
            allow: policyFor(options.origin)
        });

        if (socketHandle === undefined) {
            // `performUpgrade` already answered (403 policy, 400/405/426/404 transport) and ended
            // the socket, so this mount DID own the request.
            return true;
        }

        const connection = startStreamConnection({
            socket: socketHandle,
            broker,
            ...(options.heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs: options.heartbeatIntervalMs })
        });

        connections.add(connection);

        // Releasing on close is what stops a dropped tab from holding a subscription; the parked
        // replay window (60s) is what a reconnect resumes from.
        socketHandle.onClose(() => connections.delete(connection));

        options.onConnection?.(connection);

        return true;
    };

    const attach = (server: Server): (() => void) => {
        const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
            if (upgrade(request, socket, head)) return;

            // Nothing claimed this socket. Node's default is to leave it hanging, which is worse
            // than an honest answer for a client that expected an upgrade.
            rejectUpgrade(socket, 404, `No stream is mounted at ${request.url ?? '/'}.`);
        };

        server.on('upgrade', onUpgrade);

        return () => {
            server.off('upgrade', onUpgrade);
        };
    };

    const close = (code?: number): void => {
        broker.close(code);
        connections.clear();
    };

    return {
        broker,
        path,
        connections: () => connections.size,
        upgrade,
        attach,
        close
    };
};

// The header name is spelled locally so this module has no import cycle with ./api.ts (whose epoch
// header constant is the REST owner's export); the shared/generated constant carries the same text.
const HARNESS_EPOCH_HEADER_NAME = 'X-Harness-Epoch';

/**
 * The store/registry bridge — the ONLY place this module knows anything about the domain.
 *
 * Every callback is OPTIONAL and must be cheap. `store.watchView` is deliberately unused: it opens
 * by emitting a whole compiled view (the payload class the stream removed), so the bootstrap uses
 * counter lookups instead. Where a method is not exposed yet the bridge answers "unknown" (exists)
 * or `undefined` (baseline), and the broker falls back to its own counters — which keeps the stream
 * correct-but-coarse before T13 wires the projection counters, and never wrong.
 */
/**
 * The store/registry lookups the bridge can use. Every member is optional because the store is the
 * REST owner's file; the bridge calls whatever exists today and degrades honestly for the rest.
 */
export type StreamStoreLookups = {
    hasSession?: (id: string) => boolean;
    hasThread?: (sessionId: string, threadId: string) => boolean;
    hasTurn?: (sessionId: string, turnId: string) => boolean;
    streamExists?: (resource: StreamResourceKind, id: string | null, ids: StreamScopeIds) => boolean;
    streamBaseline?: (scope: WsSubscriptionScope, ids: StreamScopeIds) => WsRevisionRecord[] | undefined;
};

export type StreamRegistryLookups = {
    has?: (name: string) => boolean;
    list?: () => unknown[];
};

export type StreamSourceHost = {
    // `object` (not the lookup shape) on purpose: `SessionStore` and `HarnessRegistry` are the REST
    // owner's types and today declare NONE of these members, which a structural parameter would
    // reject as a "type with no properties in common". The cast below is the one place that
    // assumption is checked, and the calls below are all guarded by a runtime existence test.
    store?: object;
    registry?: object;
    link?: (resource: StreamResourceKind, id: string | null) => string | undefined;
};

export const createStreamSources = (host: StreamSourceHost = {}): StreamBrokerSources => {
    const sources: StreamBrokerSources = {};
    const store = host.store as StreamStoreLookups | undefined;
    const registry = host.registry as StreamRegistryLookups | undefined;

    sources.exists = (resource, id, ids): boolean => {
        // A host that exposes one addressed lookup wins: it can answer every kind.
        if (store?.streamExists !== undefined) return store.streamExists(resource, id, ids);
        if (id === null) return true;

        if (resource === 'session' && store?.hasSession !== undefined) return store.hasSession(id);
        if (resource === 'thread' && store?.hasThread !== undefined) return store.hasThread(ids.session_id ?? '', id);
        if (resource === 'turn' && store?.hasTurn !== undefined) return store.hasTurn(ids.session_id ?? '', id);
        if (resource === 'harnesses' && registry?.has !== undefined) return registry.has(id);

        // `unknown_resource` is a claim about the server's data, and guessing it wrong is worse
        // than not claiming it: an unexposed lookup therefore accepts the id, and the subscription
        // simply receives no frames until that resource exists.
        return true;
    };

    sources.baseline = (scope, ids) => store?.streamBaseline?.(scope, ids);

    if (host.link !== undefined) sources.link = host.link;

    return sources;
};

/**
 * The REST-side integration surface (T13 wires it, and nothing in this module imports the
 * dispatcher). One object on the runtime: `runtime.stream.broker`, plus these three calls for code
 * that must not import `./stream/broker.ts` at all.
 */
export type HarnessStreamBridge = {
    epoch(): string;
    publish(event: StreamEvent): number;
    bump(resource: StreamResourceKind, id?: string | null): number;
    setRevision(resource: StreamResourceKind, id: string | null | undefined, revision: number): number;
    subscriptions(): number;
};

export const createStreamBridge = (broker: HarnessStreamBroker): HarnessStreamBridge => ({
    epoch: () => broker.epoch(),
    publish: (event) => broker.publish(event),
    bump: (resource, id) => broker.bump(resource, id),
    setRevision: (resource, id, revision) => broker.setRevision(resource, id, revision),
    subscriptions: () => broker.subscriptions()
});

// ---------------------------------------------------------------------------
// The shared epoch, and the event-hub bridge
//
// `src/server/api-events.ts` (REST owner) is the single place the process epoch and the resource
// revisions live; `src/server/api.ts` stamps them on every read, and this module hands the SAME
// values to `welcome`, to `subscription_state.revisions`, and to `resync_required.resources`. A
// stream that minted its own epoch would break the contract's one comparison rule (a revision is
// only ever compared within one epoch), so the hub's epoch is the default everywhere in here.
// ---------------------------------------------------------------------------

/** The epoch every surface of this process reports. */
export const HARNESS_STREAM_EPOCH: string = HARNESS_RUNTIME_EPOCH;

/**
 * The id one kind's counter is keyed by, in the hub's composite spelling
 * (`session:turn`, `session:thread`), so a stream baseline reads the very record the REST write
 * stamped. Host-wide kinds have no id; every other session-scoped kind is keyed by the session.
 */
export const hubResourceId = (resource: StreamResourceKind, ids: StreamScopeIds): string | null => {
    const session = ids.session_id;

    switch (resource) {
        case 'turn':
        case 'turn_display':
        case 'turn_events':
            return session === undefined || ids.turn_id === undefined ? null : `${session}:${ids.turn_id}`;
        case 'thread':
        case 'transcript':
        case 'transcript_messages':
            return session === undefined || ids.thread_id === undefined ? null : `${session}:${ids.thread_id}`;
        case 'harnesses':
        case 'agents':
        case 'tools':
        case 'config':
            return null;
        default:
            return session ?? null;
    }
};

/** Baseline + link callbacks backed by the hub, so counters and links agree with REST byte for byte. */
export const hubStreamSources = (hub: HarnessEventHub, extra: StreamBrokerSources = {}): StreamBrokerSources => ({
    ...extra,
    baseline: (scope, ids) =>
        hub.revisions(HARNESS_WS_SCOPE_BASELINES[scope].map((resource) => resourceKeyOf(resource, hubResourceId(resource, ids)))),
    link: (resource, id) => hub.baseline(resource, id).link
});

/**
 * Feed one hub fan-out into the stream. The hub has ALREADY moved the counters, so the bridge
 * mirrors them (`setRevision`, max-wins) instead of bumping, and hands the payload straight to the
 * broker, which is the only thing that knows sequences, cursors, and replay.
 *
 * Returns the detach function `hub.subscribe` gives back.
 */
export const bridgeEventHub = (hub: HarnessEventHub, broker: HarnessStreamBroker): (() => void) =>
    hub.subscribe((event) => {
        for (const record of event.revisions) broker.setRevision(record.resource, record.id, record.revision);

        // The hub keys a turn/thread payload as `session:child`; the broker routes on the plain ids a
        // subscription carries, so the composite is split back out here.
        const ids: StreamScopeIds = {};
        const target = event.target;

        if (target !== undefined && target.id !== undefined && target.id !== null) {
            const parts = String(target.id).split(':');
            ids.session_id = parts[0];

            if (event.kind === 'display.ops' || event.kind === 'turn.upsert' || event.kind === 'turn.removed' || event.kind === 'run.event') {
                ids.turn_id = parts[1] ?? parts[0];
            } else if (event.kind === 'transcript.updated' || event.kind === 'thread.upsert' || event.kind === 'thread.removed') {
                ids.thread_id = parts[1] ?? parts[0];
            }
        }

        const body = (event.payload ?? {}) as Record<string, unknown>;
        const payload = event.ops === undefined ? body : { ...body, ops: event.ops, turn_id: ids.turn_id ?? String(body.turn_id ?? '') };

        broker.publish({
            kind: event.kind,
            ...ids,
            payload: payload as never,
            // Counters were mirrored above: an empty list tells the broker not to move them a second
            // time, which is what keeps a stream revision identical to the REST header value.
            resources: [],
            ...(event.at === undefined ? {} : { at: event.at })
        } as StreamEvent);
    });

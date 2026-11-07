// T13: the server-side event hub the canonical REST surface publishes through, and the
// single place per-process EPOCH + RESOURCE REVISIONS live.
//
// WHY THIS MODULE EXISTS
// ----------------------
// The target contract (src/server/harness.swagger.yaml, mirrored by
// src/shared/harness-api.ts + src/shared/harness-stream.ts) states every collection page,
// every resource read, and every stream frame with a revision counter that is only
// comparable WITHIN one server epoch. Both transport owners need the exact same numbers:
//
//   - REST (this owner, src/server/api.ts) stamps `PageMeta.revision`,
//     `SessionResource.revision`, `TurnResource.revision`, receipts, and the
//     `X-Harness-Epoch` / `X-Harness-Revision` response headers;
//   - the realtime owner (src/server/stream/**) answers `hello`/`welcome` with the epoch,
//     resolves `subscribe` baselines, and refuses stale cursors with `resync_required`.
//
// One process, one counter set, so a REST read and a stream frame for the same resource
// can never disagree. The counters are IN-MEMORY on purpose: the contract's epoch policy
// says a revision is only ever compared against another record carrying the SAME epoch
// (see the header comment of src/shared/harness-api.ts), and the epoch changes on every
// boot, so a durable counter would only ever add a restart-vs-restart comparison nobody
// is allowed to make.
//
// KEY SPACE (verbatim, not invented)
// ----------------------------------
// A counter is keyed by `(resource, id)` where `resource` is `StreamResourceKind`
// (src/shared/harness-stream.ts) and `id` is the instance id or `null` for a host-wide
// resource. This is exactly `WsRevisionRecord`, so the realtime owner can hand a
// `WsRevisionRecord` straight out of `hub.revisions()` with no translation, and a
// subscription baseline names the same counter the REST page printed.
//
// WHAT THIS HUB IS NOT
// --------------------
// It is not a replacement for the store's own observers (`SessionStore.watch` /
// `watchView` stay the raw + display frame sources for a running turn). It is the
// mutation/revision plane: REST writes publish here, and `hub.ingest()` lets the store's
// per-turn frames participate in the same revision counters so a stream cursor and a REST
// read agree. The realtime transport may also attach its own listeners.
//
// Cross-references:
//   - ../shared/harness-api.ts     — HARNESS_API_ROOT, HARNESS_EPOCH_HEADER, PageMeta, ServiceInfo
//   - ../shared/harness-stream.ts  — StreamResourceKind, WsRevisionRecord, WsResourceLink, WsUpdateKind
//   - ./api.ts                     — the only REST caller (createHarnessApi owns one hub)

import { HARNESS_API_ROOT } from '../shared/harness-api';
import type {
    StreamResourceKind,
    TurnDisplayOp,
    WsResourceLink,
    WsRevisionRecord,
    WsUpdateKind
} from '../shared/harness-stream';

// ---------------------------------------------------------------------------
// Epoch
// ---------------------------------------------------------------------------

// The one epoch for this process. Minted at module load, before any request can be
// served, and never re-minted: every read, header, receipt, welcome frame, and cursor
// in this process's lifetime carries this exact string.
//
// Format: base36 timestamp + random suffix. It is OPAQUE to clients (the contract only
// requires a string that changes on restart), and keeping it short matters because it
// rides every cursor and header.
const randomEpochSuffix = (): string => {
    const crypto = globalThis.crypto;

    // A runtime without `crypto.getRandomValues` (an old node, a stripped worker) still
    // needs an epoch, so fall back to Math.random. Uniqueness per PROCESS is the only
    // requirement, and the process is the epoch's whole universe.
    if (crypto !== undefined && typeof crypto.getRandomValues === 'function') {
        const bytes = new Uint8Array(6);

        crypto.getRandomValues(bytes);

        return [...bytes].map((byte) => byte.toString(36).padStart(2, '0')).join('');
    }

    return Math.random().toString(36).slice(2, 14).padEnd(12, '0');
};

/** The opaque per-process epoch reported by the root document, health, headers, and cursors. */
export const HARNESS_RUNTIME_EPOCH: string = `${Date.now().toString(36)}-${randomEpochSuffix()}`;

/** True when a cursor/caller epoch is this process's epoch (the only legal comparison). */
export const isCurrentEpoch = (epoch: unknown): boolean => typeof epoch === 'string' && epoch === HARNESS_RUNTIME_EPOCH;

// ---------------------------------------------------------------------------
// Keys and events
// ---------------------------------------------------------------------------

/** The revision key of one resource instance: `(kind, id)`, matching `WsRevisionRecord`. */
export type HarnessResourceKey = {
    resource: StreamResourceKind;
    id: string | null;
};

/** Host-wide kinds have no instance id, so `null` is their key (spec: WsRevisionRecord.id). */
const HOST_KINDS: readonly StreamResourceKind[] = ['harnesses', 'agents', 'tools', 'config'];

// T5 (R2/R3) — why `plugins` is NOT in this list: a counter key must be a `StreamResourceKind`,
// and that vocabulary is the stream's bounded per-scope baseline set (`revision_records_per_state
// = 20` = the kind count, src/shared/harness-api.test.ts). `GET /v1/harness/plugins` needs a
// collection revision, so it reports the plugin settings store's OWN epoch-local counter
// (./plugins.ts `revision`) instead of minting a 21st stream kind for a pane that rereads on open
// and on save. Every published kind still flows through this hub; a plugins change publishes
// nothing, so no `resources` entry names an unknown kind.

/** Normalize an id so `undefined`/`''` and a host-wide kind collapse to the same key. */
export const resourceKeyOf = (resource: StreamResourceKind, id?: string | null): HarnessResourceKey => ({
    resource,
    id: HOST_KINDS.includes(resource) || id === undefined || id === null || id.length === 0 ? null : id
});

/**
 * One published change. `updates` is the fan-out payload: each entry is a `WsUpdate`
 * `kind` plus the resource instances it touched, so the realtime owner can forward it
 * with the revision the hub just minted, and REST needs no listener at all.
 */
export type HarnessPublishedUpdate = {
    kind: WsUpdateKind;
    /** The resources this change moved. Every listed counter is bumped BEFORE listeners run. */
    resources: HarnessResourceKey[];
    /** Instance id the update body addresses, when the update kind has one. */
    target?: HarnessResourceKey;
    /** Update body (a `WsUpdate` member payload without `seq`/`revision`, which the hub stamps). */
    payload?: unknown;
    /** Compiled display ops for one turn, when this change folds the display tree. */
    ops?: TurnDisplayOp[];
};

/** What a listener receives: the update plus the settled revision records for it. */
export type HarnessStreamEvent = HarnessPublishedUpdate & {
    epoch: string;
    at: number;
    /** One record per touched resource, already carrying the NEW revision. */
    revisions: WsRevisionRecord[];
};

export type HarnessEventListener = (event: HarnessStreamEvent) => void;

export type HarnessEventHub = {
    /** This process's epoch (verbatim, never derived from a session). */
    epoch: string;

    /** The current revision of one resource instance. Untracked resources read as 0 = "never changed". */
    getRevision: (resource: StreamResourceKind, id?: string | null) => number;

    /** Advance one resource's counter and return the new value. Used by writes that touch no payload. */
    bumpRevision: (resource: StreamResourceKind, id?: string | null) => number;

    /** `WsRevisionRecord`s for the given keys, in the order given; used for welcome/subscription_state. */
    revisions: (keys: readonly HarnessResourceKey[]) => WsRevisionRecord[];

    /** Publish one change: report the listed counters as they stand, then fan out synchronously. */
    publish: (update: HarnessPublishedUpdate) => HarnessStreamEvent;

    /** Attach a listener. The returned function detaches it exactly once. */
    subscribe: (listener: HarnessEventListener) => () => void;

    /**
     * The bounded REST read that reconstructs one resource (spec `WsResourceLink.link`).
     * Built from the path table alone - no snapshot, no store call - so a subscription
     * baseline costs nothing to state.
     */
    baseline: (resource: StreamResourceKind, id?: string | null) => WsResourceLink;

    /** How many listeners are attached (diagnostics/tests only). */
    listenerCount: () => number;
};

// ---------------------------------------------------------------------------
// Baseline links
// ---------------------------------------------------------------------------

// The page size a baseline read is worth: the contract's own default, so a resync lands
// on one bounded first page rather than an unbounded aggregate. `limit` is repeated inside
// the link text exactly as the spec requires ("a concrete path including its page size").
const BASELINE_LIMIT = 25;

/** The bounded page-shaped link one resource is rebuilt from (never a snapshot path). */
export const resourceBaselineLink = (resource: StreamResourceKind, id?: string | null): string => {
    const key = resourceKeyOf(resource, id);

    switch (resource) {
        case 'session':
            return `${HARNESS_API_ROOT}/sessions/${key.id}`;
        case 'definition':
            return `${HARNESS_API_ROOT}/sessions/${key.id}/definition`;
        case 'turns':
            return `${HARNESS_API_ROOT}/sessions/${key.id}/turns?limit=${BASELINE_LIMIT}`;
        case 'turn':
        case 'turn_display':
        case 'turn_events': {
            // A turn key carries `session:turn`; both halves are needed to build the path.
            const [sessionId = '', turnId = key.id ?? ''] = splitComposite(key.id);

            if (resource === 'turn') return `${HARNESS_API_ROOT}/sessions/${sessionId}/turns/${turnId}`;
            if (resource === 'turn_display') {
                return `${HARNESS_API_ROOT}/sessions/${sessionId}/turns/${turnId}/display`;
            }

            return `${HARNESS_API_ROOT}/sessions/${sessionId}/turns/${turnId}/events?limit=${BASELINE_LIMIT}`;
        }
        case 'threads':
            return `${HARNESS_API_ROOT}/sessions/${key.id}/threads?limit=${BASELINE_LIMIT}`;
        case 'thread': {
            const [sessionId = '', threadId = key.id ?? ''] = splitComposite(key.id);

            return `${HARNESS_API_ROOT}/sessions/${sessionId}/threads/${threadId}`;
        }
        case 'transcript':
        case 'transcript_messages': {
            const [sessionId = '', threadId = key.id ?? ''] = splitComposite(key.id);

            if (resource === 'transcript') {
                return `${HARNESS_API_ROOT}/sessions/${sessionId}/threads/${threadId}/transcript`;
            }

            return `${HARNESS_API_ROOT}/sessions/${sessionId}/threads/${threadId}/transcript/messages?limit=${BASELINE_LIMIT}`;
        }
        case 'actions':
            return `${HARNESS_API_ROOT}/sessions/${key.id}/actions`;
        case 'usage':
            return `${HARNESS_API_ROOT}/sessions/${key.id}/usage`;
        case 'queue':
            return `${HARNESS_API_ROOT}/sessions/${key.id}/queue?limit=${BASELINE_LIMIT}`;
        case 'session_agents':
            return `${HARNESS_API_ROOT}/sessions/${key.id}/agents`;
        case 'session_tools':
            return `${HARNESS_API_ROOT}/sessions/${key.id}/tools?limit=${BASELINE_LIMIT}`;
        case 'commands':
            return `${HARNESS_API_ROOT}/sessions/${key.id}/commands?limit=${BASELINE_LIMIT}`;
        case 'harnesses':
            return `${HARNESS_API_ROOT}/harnesses?limit=${BASELINE_LIMIT}`;
        case 'agents':
            return `${HARNESS_API_ROOT}/agents?limit=${BASELINE_LIMIT}`;
        case 'tools':
            return `${HARNESS_API_ROOT}/tools?limit=${BASELINE_LIMIT}`;
        case 'config':
            return `${HARNESS_API_ROOT}/config`;
        default:
            // An unknown kind still gets a valid link (the root), never a crash: the
            // realtime owner treats an unresolvable baseline as "restart from REST".
            return HARNESS_API_ROOT;
    }
};

/** Split the `parent:child` id a turn/thread-scoped kind carries. */
const splitComposite = (value: string | null): [string, string] => {
    if (value === null) return ['', ''];

    const separator = value.indexOf(':');

    if (separator < 0) return ['', value];

    return [value.slice(0, separator), value.slice(separator + 1)];
};

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/**
 * Build one hub. `createHarnessApi` owns exactly one per API instance (which is one per
 * process in every real deployment), and the realtime owner reaches it through the
 * `events` property the API exports, so REST and WS can never disagree about a revision.
 */
export const createHarnessEventHub = (): HarnessEventHub => {
    const counters = new Map<string, number>();
    const listeners = new Set<HarnessEventListener>();

    // Flat string key for the Map: `${kind}:${id}`. `null` id is the empty segment, so a
    // host-wide kind and an `undefined` id collide by design (see `resourceKeyOf`).
    const keyOf = (key: HarnessResourceKey): string => `${key.resource}:${key.id ?? ''}`;

    const read = (key: HarnessResourceKey): number => counters.get(keyOf(key)) ?? 0;

    const advance = (key: HarnessResourceKey): number => {
        const flat = keyOf(key);
        const next = (counters.get(flat) ?? 0) + 1;

        counters.set(flat, next);

        return next;
    };

    return {
        epoch: HARNESS_RUNTIME_EPOCH,

        getRevision: (resource, id) => read(resourceKeyOf(resource, id)),

        bumpRevision: (resource, id) => advance(resourceKeyOf(resource, id)),

        revisions: (keys) =>
            keys.map((key) => {
                const normalized = resourceKeyOf(key.resource, key.id);

                return {
                    resource: normalized.resource,
                    id: normalized.id,
                    revision: read(normalized),
                    epoch: HARNESS_RUNTIME_EPOCH
                };
            }),

        publish: (update) => {
            const at = Date.now();

            // The PUBLISHER owns its counters (`bumpRevision`), and this reports them as they
            // now stand. A route therefore bumps first and publishes second, which is what
            // makes a `subscription_state` frame and a `PageMeta.revision` agree: a listener
            // that answers by re-reading REST observes the revision this change is about, and
            // publishing never double-counts a write.
            const revisions = update.resources.map((resource) => {
                const normalized = resourceKeyOf(resource.resource, resource.id);

                return {
                    resource: normalized.resource,
                    id: normalized.id,
                    revision: read(normalized),
                    epoch: HARNESS_RUNTIME_EPOCH
                } satisfies WsRevisionRecord;
            });

            const event: HarnessStreamEvent = {
                ...update,
                epoch: HARNESS_RUNTIME_EPOCH,
                at,
                revisions
            };

            // Synchronous, isolated fan-out: one listener throwing must not lose the
            // change for the others, and the publisher (an HTTP write) never waits on a
            // slow transport.
            for (const listener of [...listeners]) {
                try {
                    listener(event);
                } catch {
                    // A dead listener is dropped rather than retried; nothing here can
                    // rewind a mutation that already committed.
                    listeners.delete(listener);
                }
            }

            return event;
        },

        subscribe: (listener) => {
            listeners.add(listener);

            let detached = false;

            return () => {
                if (detached) return;

                detached = true;
                listeners.delete(listener);
            };
        },

        baseline: (resource, id) => {
            const key = resourceKeyOf(resource, id);

            return {
                resource: key.resource,
                id: key.id,
                revision: read(key),
                epoch: HARNESS_RUNTIME_EPOCH,
                link: resourceBaselineLink(resource, id)
            } satisfies WsResourceLink;
        },

        listenerCount: () => listeners.size
    };
};

/** Convenience for the common "one session moved" publish (kept so api.ts stays readable). */
export const sessionResources = (
    sessionId: string,
    ...kinds: StreamResourceKind[]
): HarnessResourceKey[] => kinds.map((resource) => resourceKeyOf(resource, sessionId));

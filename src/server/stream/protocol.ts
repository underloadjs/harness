// The wire layer of the harness update stream: closed vocabularies, per-scope tables, the
// opaque cursor codec, and the client-frame validator the conversation runs FIRST.
//
// Contract role: `src/shared/harness-stream.ts` is GENERATED from
// `src/server/harness.swagger.yaml` and carries only types plus the constant maps. This file
// is the hand-written runtime half of the same vocabulary: everything the conversation must
// decide per frame, in the exact order the spec's `x-websocket.validation_precedence` states:
//
//   (1) frame is a UTF-8 JSON text object, within `max_client_frame_bytes`  -> protocol.ts `parseClientFrame`
//   (2) frame validates against the `WsClientMessage` member for its `type` -> protocol.ts (schema failure = invalid_payload)
//   (3) `hello` only as the first frame                                     -> ./connection.ts (late_hello)
//   (4) `subscription_id` known for ack/unsubscribe                         -> ./connection.ts (unknown_subscription)
//   (5) required resource id exists                                         -> ./broker.ts (unknown_resource)
//   (6) filter published for that scope                                     -> ./broker.ts (unsupported_filter)
//   (7) budgets and rates                                                   -> ./connection.ts + ./broker.ts
//
// Exactly one condition is reported per frame, so a scope value outside the closed enum can
// never also be reported as a resource or budget problem (that is why step (2) is a full
// schema check here rather than a loose tag test).
//
// Cross-references:
//   - ../../shared/harness-stream.ts — generated frame types + `HARNESS_WS_STREAM_LIMITS`
//   - ../../shared/harness-api.ts    — `HARNESS_WS_SUBPROTOCOL`, `HARNESS_ROUTES` (link builder)
//   - src/server/harness.swagger.yaml lines 2326-2571 — the `x-websocket` extension this file implements
//   - ./broker.ts ./connection.ts ./transport.ts ./mount.ts — the consumers of every table below
//
// No `@presource/*` import: `@underload/harness` ships with zero presource dependencies (see
// package.json "dependencies"), so this package's server code uses plain Node/TS primitives.

import { HARNESS_ROUTES, HARNESS_WS_SUBPROTOCOL } from '../../shared/harness-api';
import {
    HARNESS_WS_CLIENT_MESSAGE_TYPES,
    HARNESS_WS_STREAM_LIMITS,
    type StreamResourceKind,
    type WsClientMessage,
    type WsProtocolError,
    type WsStreamLimits,
    type WsSubscriptionFilters,
    type WsSubscriptionScope,
    type WsUpdate,
    type WsUpdateKind
} from '../../shared/harness-stream';

/** The one stream path, canonical in BOTH mounts (`/api` is gone). */
export const HARNESS_WS_STREAM_PATH = HARNESS_ROUTES.stream();

/**
 * Close codes this conversation may use, from `x-websocket.close_codes`. Exported as a named
 * map so `connection.ts` and the tests never spell a bare number: every entry is documented in
 * the spec, so a wrong code is a contract break, not a style choice.
 */
export const HARNESS_WS_CLOSE_CODES = {
    normal: 1000,
    goingAway: 1001,
    protocolError: 1002,
    unsupportedData: 1003,
    invalidPayload: 1007,
    policy: 1008,
    messageTooBig: 1009,
    restart: 1012,
    tryAgainLater: 1013,
    tooManySubscriptions: 4401,
    heartbeatTimeout: 4408,
    rateLimited: 4429
} as const satisfies Record<string, number>;

/**
 * Which update kinds each scope publishes, verbatim from `x-websocket.subscription_scopes[].publishes`.
 * A frame never reports a kind outside its scope's set — that is what keeps a revision baseline
 * small and makes `publishes` in `subscription_state` checkable.
 */
export const HARNESS_WS_SCOPE_PUBLISHES: Record<WsSubscriptionScope, readonly WsUpdateKind[]> = {
    global: ['catalogue.updated', 'config.updated'],
    session: [
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
    ],
    thread: ['transcript.updated', 'thread.upsert'],
    turn: ['display.ops', 'usage.updated', 'turn.upsert']
};

/**
 * Per-scope id contract, from `subscription_scopes[].ids_required` / `ids_forbidden`. Enforced at
 * schema level (step 2): a `subscribe` carrying an id outside this pair is `invalid_payload`, while
 * a required id that is well-formed but unknown is `unknown_resource` (step 5) — two different
 * conditions, never both.
 */
export const HARNESS_WS_SCOPE_IDS: Record<
    WsSubscriptionScope,
    { required: readonly ('session_id' | 'thread_id' | 'turn_id')[]; forbidden: readonly ('session_id' | 'thread_id' | 'turn_id')[] }
> = {
    global: { required: [], forbidden: ['session_id', 'thread_id', 'turn_id'] },
    session: { required: ['session_id'], forbidden: ['thread_id', 'turn_id'] },
    thread: { required: ['session_id', 'thread_id'], forbidden: ['turn_id'] },
    turn: { required: ['session_id', 'turn_id'], forbidden: ['thread_id'] }
};

/**
 * Filters a scope publishes answers for, from `subscription_scopes[].optional_filters`. A filter
 * outside this list answers `unsupported_filter` for that subscription only (step 6).
 */
export const HARNESS_WS_SCOPE_FILTERS: Record<WsSubscriptionScope, readonly (keyof WsSubscriptionFilters)[]> = {
    global: [],
    session: ['status', 'thread_id', 'events'],
    thread: [],
    turn: ['sections', 'context']
};

/**
 * The revision-baseline set per scope, verbatim from the `StreamResourceKind` description: `global`
 * = [harnesses, agents, tools, config]; `session` = [session, definition, turns, queue, actions,
 * usage, threads, session_agents, session_tools, commands, records]; `thread` = [thread, transcript];
 * `turn` = [turn, turn_display, turn_events]. Every set is within `revision_records_per_state` (21),
 * and no frame ever reports a kind outside its scope's set.
 */
export const HARNESS_WS_SCOPE_BASELINES: Record<WsSubscriptionScope, readonly StreamResourceKind[]> = {
    global: ['harnesses', 'agents', 'tools', 'config'],
    session: ['session', 'definition', 'turns', 'queue', 'actions', 'usage', 'threads', 'session_agents', 'session_tools', 'commands', 'records'],
    thread: ['thread', 'transcript'],
    turn: ['turn', 'turn_display', 'turn_events']
};

/**
 * Which counters one update kind moves, in-epoch. Two kinds are DERIVED and mint no counter of
 * their own (`turn_display`/`turn_events` carry the owning turn's revision, `transcript_messages`
 * carries the owning transcript revision), so `display.ops` bumps `turn` and `transcript.updated`
 * bumps `transcript`. `run.event` is opt-in raw event traffic and moves nothing: the replayed
 * events are a fold of the turn record's own revision.
 */
export const HARNESS_WS_KIND_RESOURCES: Record<WsUpdateKind, readonly StreamResourceKind[]> = {
    'session.updated': ['session'],
    'turn.upsert': ['turns'],
    'turn.removed': ['turns'],
    'display.ops': ['turn'],
    'usage.updated': ['usage'],
    'action.opened': ['actions'],
    'action.closed': ['actions'],
    'thread.upsert': ['threads', 'thread'],
    'thread.removed': ['threads'],
    'transcript.updated': ['transcript'],
    // The record store is ONE counter domain: any committed mutation — whatever the
    // collection — bumps the session's `records` revision, and `records.updated` is the
    // only kind that names it. The two store watermarks (`store_rev`/`collections_rev`)
    // travel in the payload, but the counter a client compares against is this one.
    'records.updated': ['records'],
    'tool.registry_updated': ['session_tools'],
    'agent.registry_updated': ['session_agents'],
    'run.event': [],
    'catalogue.updated': [],
    'config.updated': ['config']
};

/** Which scope a kind can reach, used by the broker's routing check. */
export const isKindPublishedTo = (scope: WsSubscriptionScope, kind: WsUpdateKind): boolean =>
    HARNESS_WS_SCOPE_PUBLISHES[scope].includes(kind);

/**
 * `id` a baseline counter belongs to, per kind: the session id for session-scoped kinds, the thread
 * id for `thread`/`transcript`, the turn id for the turn kinds, and `null` for host-wide resources
 * with no id. A revision is only comparable against a record with the same kind, id, AND epoch.
 */
export const streamResourceIdFor = (
    resource: StreamResourceKind,
    ids: { session_id?: string; thread_id?: string; turn_id?: string }
): string | null => {
    switch (resource) {
        case 'thread':
        case 'transcript':
            return ids.thread_id ?? null;
        case 'turn':
        case 'turn_display':
        case 'turn_events':
            return ids.turn_id ?? null;
        case 'harnesses':
        case 'agents':
        case 'tools':
        case 'config':
            return null;
        // Every remaining kind is session-scoped (session, definition, turns, actions, usage,
        // threads, session_agents, session_tools, commands, records). `transcript_messages` is a LINK target
        // only (it reuses the owning `transcript` counter) and never appears in a baseline, so it
        // falls through to the session id, which is the id its link is addressed by.
        default:
            return ids.session_id ?? null;
    }
};

/**
 * The canonical REST read that restores one resource, used when the host supplies no `link`
 * callback. Bounded pages by construction (the routes carry their own defaults), which is the
 * rule that keeps recovery from becoming a whole-session read.
 */
export const defaultStreamLink = (
    resource: StreamResourceKind,
    ids: { session_id?: string; thread_id?: string; turn_id?: string }
): string => {
    const session = ids.session_id ?? '';
    const thread = ids.thread_id ?? '';
    const turn = ids.turn_id ?? '';

    switch (resource) {
        case 'session':
            return HARNESS_ROUTES.sessionsBySessionId(session);
        case 'definition':
            return HARNESS_ROUTES.sessionsBySessionIdDefinition(session);
        case 'turns':
            return `${HARNESS_ROUTES.sessionsBySessionIdTurns(session)}?limit=25`;
        case 'turn':
            return HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnId(session, turn);
        case 'turn_display':
            return `${HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnIdDisplay(session, turn)}?limit=25`;
        case 'turn_events':
            return `${HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnIdEvents(session, turn)}?limit=25`;
        case 'threads':
            return `${HARNESS_ROUTES.sessionsBySessionIdThreads(session)}?limit=25`;
        case 'thread':
            return HARNESS_ROUTES.sessionsBySessionIdThreadsByThreadId(session, thread);
        case 'transcript':
            return HARNESS_ROUTES.sessionsBySessionIdThreadsByThreadIdTranscript(session, thread);
        case 'transcript_messages':
            return `${HARNESS_ROUTES.sessionsBySessionIdThreadsByThreadIdTranscriptMessages(session, thread)}?limit=25`;
        case 'actions':
            return `${HARNESS_ROUTES.sessionsBySessionIdActions(session)}?limit=25`;
        case 'usage':
            return HARNESS_ROUTES.sessionsBySessionIdUsage(session);
        case 'queue':
            return HARNESS_ROUTES.sessionsBySessionIdQueue(session);
        case 'session_agents':
            return `${HARNESS_ROUTES.sessionsBySessionIdAgents(session)}?limit=25`;
        case 'session_tools':
            return `${HARNESS_ROUTES.sessionsBySessionIdTools(session)}?limit=25`;
        case 'harnesses':
            return `${HARNESS_ROUTES.harnesses()}?limit=25`;
        case 'agents':
            return `${HARNESS_ROUTES.agents()}?limit=25`;
        case 'tools':
            return `${HARNESS_ROUTES.tools()}?limit=25`;
        case 'config':
            return HARNESS_ROUTES.config();
        case 'commands':
            return `${HARNESS_ROUTES.sessionsBySessionIdCommands(session)}?limit=25`;
        // The record store's canonical read. No `?limit` — the snapshot is already bounded by
        // the engine's own caps (`maxRecords` per collection, feed trimmed to 200), so paging
        // it would invent a second cursor the client already has in `store_rev`.
        case 'records':
            return HARNESS_ROUTES.sessionsBySessionIdRecords(session);
        default:
            return HARNESS_ROUTES.root();
    }
};

// ---------------------------------------------------------------------------
// Cursors
//
// A cursor is `base64url(epoch:sequence)` and is NEVER parsed by a client. It is opaque to the
// wire contract but must round-trip exactly on the server, because replay compares against it.
// ---------------------------------------------------------------------------

export type StreamCursor = { epoch: string; sequence: number };

export const encodeStreamCursor = (epoch: string, sequence: number): string =>
    Buffer.from(`${epoch}:${sequence}`, 'utf8').toString('base64url');

/** `undefined` for anything that is not a well-formed cursor of THIS epoch's shape. */
export const decodeStreamCursor = (cursor: string | undefined): StreamCursor | undefined => {
    if (typeof cursor !== 'string' || cursor.length === 0) return undefined;

    let text: string;

    try {
        text = Buffer.from(cursor, 'base64url').toString('utf8');
    } catch {
        return undefined;
    }

    const separator = text.lastIndexOf(':');
    if (separator <= 0) return undefined;

    const epoch = text.slice(0, separator);
    const sequence = Number(text.slice(separator + 1));

    // A cursor whose sequence is not a non-negative integer was not minted by this server, and a
    // cursor whose epoch is empty is the same case: both are treated as "no resume state".
    if (epoch.length === 0 || !Number.isInteger(sequence) || sequence < 0) return undefined;

    return { epoch, sequence };
};

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Declared bounds for the six `deployment_tunable_within_declared_bounds` numbers, copied from
 * the `WsStreamLimits` property schemas (swagger lines 7102-7207). A `fixed_by_contract` value is
 * never overridable, so a host cannot retune the replay window or the heartbeat cadence.
 */
export const HARNESS_WS_TUNABLE_BOUNDS = {
    subscriptions_per_connection: { min: 1, max: 256 },
    client_messages_per_second: { min: 1, max: 100 },
    send_queue_frames: { min: 1, max: 4096 },
    send_queue_bytes: { min: 65_536, max: 16_777_216 },
    sustained_stall_ms: { min: 1_000, max: 60_000 },
    ack_timeout_ms: { min: 1_000, max: 60_000 }
} as const satisfies Record<string, { min: number; max: number }>;

const clamped = (value: number | undefined, bound: { min: number; max: number }, fallback: number): number => {
    if (value === undefined || !Number.isFinite(value)) return fallback;
    return Math.min(bound.max, Math.max(bound.min, Math.trunc(value)));
};

/**
 * Resolve the numbers IN FORCE for one stream host. The contract defaults are the shipped values;
 * a deployment may retune only the six tunable entries, and only inside the declared bounds, and
 * the result is what `welcome.limits` delivers — which is the only source a client may rely on.
 */
export const resolveStreamLimits = (overrides: Partial<WsStreamLimits> = {}): WsStreamLimits => {
    const limits = { ...HARNESS_WS_STREAM_LIMITS };

    for (const key of Object.keys(HARNESS_WS_TUNABLE_BOUNDS) as (keyof typeof HARNESS_WS_TUNABLE_BOUNDS)[]) {
        limits[key] = clamped(overrides[key], HARNESS_WS_TUNABLE_BOUNDS[key], limits[key]);
    }

    // `heartbeat_timeout_close_code` has a single-member enum, so it is not overridable at all.
    limits.heartbeat_timeout_close_code = HARNESS_WS_STREAM_LIMITS.heartbeat_timeout_close_code;

    return limits;
};

// ---------------------------------------------------------------------------
// Client frame validation (precedence steps 1 and 2)
// ---------------------------------------------------------------------------

/** A protocol condition, shaped exactly like `WsProtocolError`'s informative fields. */
export type StreamFailure = {
    code: WsProtocolError['code'];
    message: string;
    close_code?: number;
    subscription_id?: string;
};

export type ClientFrameResult = { frame?: WsClientMessage; failure?: StreamFailure };

/** Field budgets per client frame type: `required` must be present, nothing outside the two lists may be. */
const CLIENT_FRAME_FIELDS: Record<string, { required: readonly string[]; optional: readonly string[] }> = {
    hello: { required: [], optional: ['protocol', 'epoch', 'cursor'] },
    subscribe: {
        required: ['subscription_id', 'scope'],
        optional: ['session_id', 'thread_id', 'turn_id', 'filters', 'pace', 'cursor']
    },
    unsubscribe: { required: ['subscription_id'], optional: [] },
    ack: { required: ['subscription_id', 'sequence'], optional: [] },
    ping: { required: [], optional: ['at'] },
    bye: { required: [], optional: ['reason'] }
};

/** Closed key set of `WsSubscriptionFilters`; an unknown key is `unsupported_filter`, not a schema failure. */
const FILTER_KEYS: readonly (keyof WsSubscriptionFilters)[] = ['status', 'thread_id', 'events', 'sections', 'context'];

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const failure = (code: WsProtocolError['code'], message: string, close_code?: number): ClientFrameResult => ({
    failure: close_code === undefined ? { code, message } : { code, message, close_code }
});

/**
 * Validate one inbound text frame.
 *
 * Returns EITHER `frame` (a value safe to narrow to `WsClientMessage`) or `failure`, never both.
 * Deliberately strict about unknown properties: every frame schema in the contract is
 * `additionalProperties: false`, so a stray field is a schema failure rather than something to
 * ignore, and a client that sends `turn_id` on a `thread` subscription learns about it immediately.
 *
 * Edge cases handled here and nowhere else:
 * - non-JSON text and an oversize frame are step (1) conditions (`frame_too_large`, close 1003/1009
 *   per the precedence mapping), NOT `invalid_payload`;
 * - a `scope` outside the closed enum is a schema failure (`invalid_payload`) — the resource and
 *   budget steps never run for it;
 * - `filters` keys are shape-checked only: whether a published key is supported FOR THAT SCOPE is
 *   step (6), a different condition with a different code;
 * - the `status` filter value is checked as a non-empty string only, because the generated shared
 *   module exports no `SessionTurnStatus` constant to compare against.
 */
export const parseClientFrame = (raw: string): ClientFrameResult => {
    // Step 1a: size, measured on bytes rather than characters, which is what the wire counts.
    if (Buffer.byteLength(raw, 'utf8') > HARNESS_WS_STREAM_LIMITS.max_client_frame_bytes) {
        return failure(
            'frame_too_large',
            `A client frame cannot exceed ${HARNESS_WS_STREAM_LIMITS.max_client_frame_bytes} bytes.`,
            HARNESS_WS_CLOSE_CODES.messageTooBig
        );
    }

    // Step 1b: must be a JSON text OBJECT.
    let parsed: unknown;

    try {
        parsed = JSON.parse(raw);
    } catch {
        return failure('frame_too_large', 'A client frame must be a JSON text object.', HARNESS_WS_CLOSE_CODES.unsupportedData);
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return failure('frame_too_large', 'A client frame must be a JSON text object.', HARNESS_WS_CLOSE_CODES.unsupportedData);
    }

    const record = parsed as Record<string, unknown>;
    const type = record.type;

    if (typeof type !== 'string' || !(HARNESS_WS_CLIENT_MESSAGE_TYPES as readonly string[]).includes(type)) {
        return failure('invalid_payload', `Unknown client frame type: ${String(type)}.`);
    }

    const fields = CLIENT_FRAME_FIELDS[type];

    for (const key of fields.required) {
        if (record[key] === undefined) {
            return failure('invalid_payload', `A ${type} frame requires ${key}.`);
        }
    }

    for (const key of Object.keys(record)) {
        if (key === 'type' || fields.optional.includes(key) || fields.required.includes(key)) continue;
        return failure('invalid_payload', `A ${type} frame does not accept ${key}.`);
    }

    // Type-specific narrowing beyond presence: these are all schema-level enum/format rules.
    switch (type) {
        case 'hello': {
            if (record.protocol !== undefined && record.protocol !== HARNESS_WS_SUBPROTOCOL) {
                return failure('invalid_payload', `The only supported protocol is ${HARNESS_WS_SUBPROTOCOL}.`);
            }
            if (record.epoch !== undefined && !isNonEmptyString(record.epoch)) {
                return failure('invalid_payload', 'hello.epoch must be a non-empty string.');
            }
            if (record.cursor !== undefined && !isNonEmptyString(record.cursor)) {
                return failure('invalid_payload', 'hello.cursor must be a non-empty string.');
            }
            break;
        }
        case 'subscribe': {
            const scope = record.scope;

            if (typeof scope !== 'string' || !(HARNESS_WS_SCOPE_BASELINES as Record<string, unknown>)[scope]) {
                // A scope outside the closed four is a SCHEMA failure, never a resource failure.
                return failure('invalid_payload', `Unknown subscription scope: ${String(scope)}.`);
            }

            const ids = HARNESS_WS_SCOPE_IDS[scope as WsSubscriptionScope];

            for (const key of ids.required) {
                if (!isNonEmptyString(record[key])) {
                    return failure('invalid_payload', `A ${scope} subscription requires ${key}.`);
                }
            }

            for (const key of ids.forbidden) {
                if (record[key] !== undefined) {
                    return failure('invalid_payload', `A ${scope} subscription does not accept ${key}.`);
                }
            }

            if (record.pace !== undefined && record.pace !== 'ordered' && record.pace !== 'ack') {
                return failure('invalid_payload', 'subscribe.pace must be "ordered" or "ack".');
            }

            if (record.cursor !== undefined && !isNonEmptyString(record.cursor)) {
                return failure('invalid_payload', 'subscribe.cursor must be a non-empty string.');
            }

            if (record.filters !== undefined) {
                if (typeof record.filters !== 'object' || record.filters === null || Array.isArray(record.filters)) {
                    return failure('invalid_payload', 'subscribe.filters must be an object.');
                }

                for (const key of Object.keys(record.filters as Record<string, unknown>)) {
                    if (!(FILTER_KEYS as readonly string[]).includes(key)) {
                        return failure('invalid_payload', `subscribe.filters does not define ${key}.`);
                    }
                }
            }

            break;
        }
        case 'ack': {
            if (!Number.isInteger(record.sequence) || (record.sequence as number) < 0) {
                return failure('invalid_payload', 'ack.sequence must be a non-negative integer.');
            }
            break;
        }
        case 'ping': {
            if (record.at !== undefined && (typeof record.at !== 'number' || !Number.isFinite(record.at))) {
                return failure('invalid_payload', 'ping.at must be a number.');
            }
            break;
        }
        case 'bye': {
            if (record.reason !== undefined && typeof record.reason !== 'string') {
                return failure('invalid_payload', 'bye.reason must be a string.');
            }
            break;
        }
        case 'unsubscribe':
            break;
        default:
            return failure('invalid_payload', `Unknown client frame type: ${String(type)}.`);
    }

    return { frame: record as unknown as WsClientMessage };
};

// ---------------------------------------------------------------------------
// Frame sizing helpers (server side)
// ---------------------------------------------------------------------------

/** UTF-8 byte length of a serialized frame — the unit `max_server_frame_bytes` is stated in. */
export const streamFrameBytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/**
 * Split a payload array so no frame exceeds `perFrame` entries AND the frame stays under
 * `maxBytes`. `display.ops` (32 ops, each delta capped at 2000 chars) and `run.event` (16 events)
 * can still exceed the byte cap, and the contract's promise is "the server never emits a larger
 * frame", so an oversize list becomes MORE frames, never a bigger one. A single item that is by
 * itself over the cap stays alone in its own frame: dropping it would silently lose a display op.
 */
export const chunkStreamPayload = <T>(items: readonly T[], perFrame: number, maxBytes: number, sizeOf: (item: T) => number): T[][] => {
    const chunks: T[][] = [];
    let chunk: T[] = [];
    let bytes = 0;

    for (const item of items) {
        const size = sizeOf(item);

        if (chunk.length > 0 && (chunk.length >= perFrame || bytes + size > maxBytes)) {
            chunks.push(chunk);
            chunk = [];
            bytes = 0;
        }

        chunk.push(item);
        bytes += size;
    }

    if (chunk.length > 0) chunks.push(chunk);

    return chunks;
};

/** The metadata every `WsUpdate` variant carries, identical across kinds. */
export type StreamUpdateEnvelope = {
    type: 'update';
    subscription_id: string;
    sequence: number;
    cursor: string;
    at: number;
};

/**
 * The `WsUpdate` variants share this metadata envelope; building it in one place keeps sequences
 * honest and leaves only the kind plus its payload to the caller.
 */
export const streamUpdateEnvelope = <K extends WsUpdateKind>(
    subscriptionId: string,
    kind: K,
    sequence: number,
    cursor: string,
    at: number
): StreamUpdateEnvelope & { kind: K } => ({
    type: 'update',
    subscription_id: subscriptionId,
    sequence,
    cursor,
    kind,
    at
});

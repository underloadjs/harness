// Server configuration.
//
// The server can run with no configuration at all: the scripted demo needs no
// provider. Live presets read these defaults, and the UI can override the base URL
// and model per session. The API key is never sent to a client.
//
// CREDENTIAL RULE (the reason mergeSettings is not a plain spread):
// the server's configured key belongs to ONE provider — the origin and base path
// of `defaults.baseURL`. A client may point a model listing or a session at any
// base URL it likes, but an omitted/blank key then means "no key", never "use
// the server key". Without this rule a foreign base URL plus a blank key would
// send the server's credential to a host of the caller's choosing.
//
// T28: the credential and the effective endpoint are separate arguments (`ProviderCredential`)
// because the REST dispatcher's advertised `defaults` document is key-free by contract, while
// its provider calls still need the real key. Nothing here accepts a boolean in place of a
// key: an absent credential is "no key", never a placeholder string.
//
// Cross-references:
//   - ./api.ts      — POST /models merges over the API's private settings channel
//                     (`createHarnessApi({ settings })`) and passes `providerCredential()`
//   - ./sessions.ts — SessionStore.create merges over the same settings, no credential arg
//   - src/server/api.ts — maps SettingsError to its 400 status

import type { RunnerSettings } from './harnesses/types';
import type { HarnessIndex } from './protocol';

// How a session's LOGICAL threads get CPU.
//
//   - 'inline' (default) - every thread runs on the server's own event loop, which
//     is the historical behaviour: turns interleave, and a CPU-bound tool body
//     blocks the loop (README "no OS worker or CPU isolation").
//   - 'worker'           - each persistent thread executes its turn (agent loop AND
//     tool bodies) on its own worker thread, so a CPU-heavy lane cannot freeze a
//     sibling lane or the HTTP surface. The session harness stays canonical on the
//     coordinator; state crosses as ordered operations with receipts
//     (./workers/lane-commit.ts, applied by ./workers/lane-authority.ts).
//
// 'worker' is a promise, not a hint: a session whose harness cannot be rebuilt from
// durable data is REJECTED with a reason (./workers/capability.ts) rather than
// quietly executed inline.
export type ThreadExecutionMode = 'inline' | 'worker';

// How the DURABLE writes get their CPU (D4). Independent of `threadExecution`: one lane
// worker isolates a turn's CPU, this one isolates the checkpoint/journal syscalls, and a
// deployment may want either, both, or neither.
//
//   - 'inline' (default) - the coordinator performs `persistence.save()` /
//     `journal.append()` itself: whole-document stringify + mkdir/open/write/fsync/rename
//     on the event loop that serves every other session. The historical behaviour.
//   - 'worker'           - ONE IO worker thread per database root owns the write side
//     (./workers/io-client.ts + ./workers/io-worker.ts). The coordinator still decides
//     WHAT is written and in WHAT ORDER; a strict save then resolves after the worker's
//     rename, so durability still precedes the response while the loop stays free.
//     A queued (observer/checkpoint/journal-event) write claims ORDER, not durability.
//
// Like `threadExecution`, 'worker' is a promise, not a hint: a missing entry, a thread
// that will not start, or a protocol mismatch FAILS startup. It never degrades to inline,
// because that would leave the operator believing a blocking write is off the loop.
export type IoExecutionMode = 'inline' | 'worker';

// The server RUNTIME, kept beside (not inside) the provider settings: settings are
// per-session and client-visible, the runtime is a deployment property and never
// leaves the process.
export type ServerRuntimeConfiguration = {
    threadExecution: ThreadExecutionMode;
    // D4: where the checkpoint/journal writes run (see `IoExecutionMode`).
    ioExecution: IoExecutionMode;
    // Reclaim a lane worker after this much idle time; 0 keeps it alive until the
    // session goes. Reclaim is always safe: the next turn rebuilds the replica from
    // the committed snapshot.
    workerIdleMs: number;
    // Upper bound on concurrently live lane workers per store. Each worker owns a
    // full harness replica, so this is the memory guard.
    maxLaneWorkers: number;
    // Upper bound on the hello handshake (import + build + capability report).
    workerHandshakeMs: number;
    // Explicit path to the built worker entry. When omitted the host resolves
    // `dist/underload-harness.worker.mjs` through ./package-root.ts, which is the
    // same source-vs-bundle resolution the static UI root uses.
    workerEntry?: string;
    // D4: explicit path to the built IO worker entry (`dist/underload-harness.io-worker
    // .mjs`). Omitted means the resolver chain in ./workers/io-client.ts
    // (`resolveIoWorkerEntry`), which prefers the built bundle and falls back to the
    // source entry only when no build exists.
    ioEntry?: string;
};

export type ServerConfiguration = {
    settings: RunnerSettings;
    defaults: HarnessIndex['defaults'];
    runtime: ServerRuntimeConfiguration;
};

// A bad runtime setting is a DEPLOYMENT error, so it is not a SettingsError (that
// type means "the client sent this" and carries a 400). It must abort startup or
// runtime creation rather than degrade into an inline server nobody asked for.
export class ServerRuntimeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ServerRuntimeError';
    }
}

const DEFAULT_BASE_URL = 'http://localhost:5500/providers/private/v1';
const DEFAULT_MODEL = 'merge/ds4-flash';

// Safe default: today's behaviour, kept deliberately. Worker isolation is a
// per-deployment opt-in because it changes WHERE a body runs (one worker thread per
// live conversation, a bounded memory window, and refusals for a harness a worker
// cannot rebuild), so no existing host changes shape by upgrading. The mode itself is
// implemented and verified: ./workers/lane-worker.test.ts measures it.
export const DEFAULT_THREAD_EXECUTION: ThreadExecutionMode = 'inline';

// D4: off-loop durability is opt-in for the same reason CPU isolation is - it changes
// WHEN a strict write is acknowledged (an awaited round trip instead of a synchronous
// syscall) and it needs a worker entry the build emits. `./workers/io-client.test.ts`
// and `./io-worker-bridge.test.ts` verify the mode itself.
export const DEFAULT_IO_EXECUTION: IoExecutionMode = 'inline';

// Bounds exist so one typo cannot park every lane behind a 40-second handshake or
// fork 400 harness replicas. They are limits, not tuning advice.
export const WORKER_IDLE_MS_MAX = 3_600_000;
export const MAX_LANE_WORKERS_LIMIT = 64;
export const WORKER_HANDSHAKE_MS_MIN = 1_000;
export const WORKER_HANDSHAKE_MS_MAX = 600_000;

export const DEFAULT_RUNTIME_CONFIGURATION: ServerRuntimeConfiguration = {
    threadExecution: DEFAULT_THREAD_EXECUTION,
    ioExecution: DEFAULT_IO_EXECUTION,
    workerIdleMs: 120_000,
    maxLaneWorkers: 16,
    workerHandshakeMs: 60_000
};

// Shared bounds for client-supplied settings. A base URL is a URL, not a
// document; a model name is an id. Both caps are generous (an OpenAI-compatible
// gateway URL with a long provider path still fits) and exist so a settings body
// cannot smuggle an unbounded string into every provider request.
export const MAX_BASE_URL_LENGTH = 2048;
export const MAX_MODEL_LENGTH = 256;

// A rejected settings value. Carries an HTTP status so the dispatcher can map it
// without knowing which field was wrong, exactly like HttpError/SessionError.
export class SettingsError extends Error {
    readonly status = 400;

    constructor(message: string) {
        super(message);
        this.name = 'SettingsError';
    }
}

// Settings arrive as parsed JSON, so a field can be any JSON value. `.trim()` on
// a number would be a TypeError → 500, so every optional string is checked here
// once instead of at each call site.
const optionalString = (value: unknown, field: keyof RunnerSettings): string | undefined => {
    if (value === undefined) return undefined;

    if (typeof value !== 'string') {
        throw new SettingsError(`\`settings.${field}\` must be a string when present.`);
    }

    return value;
};

// Canonical comparison form for a provider URL: scheme + host + base path, with
// trailing slashes removed. Query and hash are KEPT on purpose — a client that
// appends `?redirect=…` to the configured base URL is not asking for the same
// provider endpoint, so it must not receive the configured key.
//
// `new URL` also lowercases the host and normalizes a default port, which is why
// `http://Provider.test:80/v1/` and `http://provider.test/v1` compare equal. A
// value the URL parser rejects falls back to trimmed, slash-normalized text so
// the comparison never throws.
export const normalizeProviderURL = (value: string): string => {
    const trimmed = value.trim().replace(/\/+$/, '');
    if (trimmed.length === 0) return '';

    try {
        const url = new URL(trimmed);
        const pathname = url.pathname.replace(/\/+$/, '');
        return `${url.protocol}//${url.host}${pathname}${url.search}${url.hash}`;
    } catch {
        return trimmed;
    }
};

// True when both values describe the same provider endpoint. An empty base URL
// never matches: "no provider configured" is not a provider.
export const isSameProvider = (left: string, right: string): boolean => {
    const a = normalizeProviderURL(left);
    const b = normalizeProviderURL(right);

    return a.length > 0 && a === b;
};

// ---------------------------------------------------------------------------
// Runtime configuration (R3)
// ---------------------------------------------------------------------------
//
// Every runtime value is VALIDATED rather than coerced, and `numberEnsures` is
// deliberately NOT used here: it maps a typo (`HARNESS_WORKER_IDLE_MS=12s`) to 0,
// which would silently change a deployment's reclaim behaviour. A bad value must
// abort startup with the variable name and the accepted range, because the whole
// point of `threadExecution: 'worker'` is that the operator's intent is honoured,
// not approximated.

const integerWithin = (
    raw: string | undefined,
    variable: string,
    minimum: number,
    maximum: number
): number | undefined => {
    if (raw === undefined || raw.trim().length === 0) return undefined;

    const trimmed = raw.trim();
    // Digits only: no sign, no exponent, no trailing text. `/^\d+$/` also refuses
    // `1_000` and `1e3`, which an operator would otherwise have to guess about.
    if (!/^\d+$/.test(trimmed)) {
        throw new ServerRuntimeError(`${variable} must be an integer between ${minimum} and ${maximum}.`);
    }

    const parsed = Number(trimmed);

    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new ServerRuntimeError(`${variable} must be an integer between ${minimum} and ${maximum}.`);
    }

    return parsed;
};

export const parseThreadExecutionMode = (raw: string | undefined, variable = 'HARNESS_THREAD_EXECUTION'): ThreadExecutionMode => {
    const trimmed = raw?.trim().toLowerCase() ?? '';

    if (trimmed.length === 0) return DEFAULT_THREAD_EXECUTION;
    if (trimmed === 'inline' || trimmed === 'worker') return trimmed;

    // The error names the wrong value and both accepted spellings: an operator who
    // typed `threads` or `threaded` should not have to read the source.
    throw new ServerRuntimeError(
        `${variable} must be "inline" or "worker"; received ${JSON.stringify(raw)}.`
    );
};

// D4: `ioExecution` takes the same two spellings as `threadExecution`, and reuses its
// validator so the message names the FIELD that is wrong (`HARNESS_IO_EXECUTION=workr`
// aborts startup naming HARNESS_IO_EXECUTION, never silently becoming inline).
export const parseIoExecutionMode = (raw: string | undefined, variable = 'HARNESS_IO_EXECUTION'): IoExecutionMode =>
    parseThreadExecutionMode(raw, variable);

// Read the runtime from the process environment. Idempotent and side-effect free.
export const loadRuntimeConfiguration = (env: NodeJS.ProcessEnv = process.env): ServerRuntimeConfiguration => {
    const threadExecution = parseThreadExecutionMode(env.HARNESS_THREAD_EXECUTION);

    // D4: the durability mode is read next to the CPU mode, because both are deployment
    // promises and an operator sets them in one place.
    const ioExecution = parseIoExecutionMode(env.HARNESS_IO_EXECUTION);

    const workerIdleMs =
        integerWithin(env.HARNESS_WORKER_IDLE_MS, 'HARNESS_WORKER_IDLE_MS', 0, WORKER_IDLE_MS_MAX) ??
        DEFAULT_RUNTIME_CONFIGURATION.workerIdleMs;

    const maxLaneWorkers =
        integerWithin(env.HARNESS_MAX_LANE_WORKERS, 'HARNESS_MAX_LANE_WORKERS', 1, MAX_LANE_WORKERS_LIMIT) ??
        DEFAULT_RUNTIME_CONFIGURATION.maxLaneWorkers;

    const workerHandshakeMs =
        integerWithin(
            env.HARNESS_WORKER_HANDSHAKE_MS,
            'HARNESS_WORKER_HANDSHAKE_MS',
            WORKER_HANDSHAKE_MS_MIN,
            WORKER_HANDSHAKE_MS_MAX
        ) ?? DEFAULT_RUNTIME_CONFIGURATION.workerHandshakeMs;

    // A blank override means "not set", exactly like an absent variable: the host
    // then resolves the shipped bundle, which is the value that survives a rebuild.
    const entry = env.HARNESS_WORKER_ENTRY?.trim() ?? '';

    // D4: `HARNESS_IO_WORKER_ENTRY` is the same variable ./workers/io-client.ts reads as
    // an operator escape hatch; surfacing it here keeps the REPORTED runtime complete,
    // so `startHarnessServer().runtime` says exactly which entry a worker-mode store uses.
    const ioEntry = env.HARNESS_IO_WORKER_ENTRY?.trim() ?? '';

    return {
        threadExecution,
        ioExecution,
        workerIdleMs,
        maxLaneWorkers,
        workerHandshakeMs,
        ...(entry.length > 0 ? { workerEntry: entry } : {}),
        ...(ioEntry.length > 0 ? { ioEntry } : {})
    };
};

// Merge explicit host options over the environment/default layer. Explicit wins per
// field; `null`/blank strings are treated as "not supplied" so a UI form that sends
// an empty input cannot silently move the reclaim timer to 0.
export const resolveRuntimeConfiguration = (
    loaded: ServerRuntimeConfiguration,
    input: Partial<ServerRuntimeConfiguration> | undefined
): ServerRuntimeConfiguration => {
    if (input === undefined) return { ...loaded };

    const threadExecution =
        input.threadExecution === undefined
            ? loaded.threadExecution
            : parseThreadExecutionMode(input.threadExecution, 'threadExecution');

    // D4: an explicit `ioExecution` is validated the same way, so a host option cannot
    // smuggle in a mode the environment would have refused.
    const ioExecution =
        input.ioExecution === undefined
            ? loaded.ioExecution
            : parseIoExecutionMode(input.ioExecution, 'ioExecution');

    const workerIdleMs =
        input.workerIdleMs === undefined
            ? loaded.workerIdleMs
            : numberOrThrow(integerWithin(String(input.workerIdleMs), 'workerIdleMs', 0, WORKER_IDLE_MS_MAX), 'workerIdleMs');

    const maxLaneWorkers =
        input.maxLaneWorkers === undefined
            ? loaded.maxLaneWorkers
            : numberOrThrow(
                  integerWithin(String(input.maxLaneWorkers), 'maxLaneWorkers', 1, MAX_LANE_WORKERS_LIMIT),
                  'maxLaneWorkers'
              );

    const workerHandshakeMs =
        input.workerHandshakeMs === undefined
            ? loaded.workerHandshakeMs
            : numberOrThrow(
                  integerWithin(
                      String(input.workerHandshakeMs),
                      'workerHandshakeMs',
                      WORKER_HANDSHAKE_MS_MIN,
                      WORKER_HANDSHAKE_MS_MAX
                  ),
                  'workerHandshakeMs'
              );

    const entry = input.workerEntry?.trim() ?? '';

    // D4: same precedence as `workerEntry` - explicit wins, a blank explicit value falls
    // back to what the environment supplied, and an absent pair leaves the resolver in
    // ./workers/io-client.ts free to choose (built bundle first, source entry last).
    const ioEntry = input.ioEntry?.trim() ?? '';

    return {
        threadExecution,
        ioExecution,
        workerIdleMs,
        maxLaneWorkers,
        workerHandshakeMs,
        ...(entry.length > 0 ? { workerEntry: entry } : loaded.workerEntry === undefined ? {} : { workerEntry: loaded.workerEntry }),
        ...(ioEntry.length > 0 ? { ioEntry } : loaded.ioEntry === undefined ? {} : { ioEntry: loaded.ioEntry })
    };
};

const numberOrThrow = (value: number | undefined, field: string): number => {
    if (value === undefined) throw new ServerRuntimeError(`${field} must be an integer.`);

    return value;
};

export const loadConfiguration = (): ServerConfiguration => {
    const baseURL = process.env.HARNESS_BASE_URL?.trim() || DEFAULT_BASE_URL;
    const apiKey = process.env.HARNESS_API_KEY ?? process.env.OPENAI_API_KEY ?? '';
    const model = process.env.HARNESS_MODEL?.trim() || DEFAULT_MODEL;

    return {
        settings: { baseURL, apiKey, model },
        defaults: {
            baseURL,
            model,
            hasApiKey: apiKey.trim().length > 0
        },
        runtime: loadRuntimeConfiguration()
    };
};

// T28: a deployment credential, named APART from the settings it is scoped to.
//
// The rule this type exists to keep honest: a key belongs to ONE provider — the origin
// and base path it was configured with. `defaults.baseURL` in `mergeSettings` is the
// EFFECTIVE endpoint (it can move, e.g. a `PATCH /config base_url`), so it is not always
// the provider the secret belongs to. A caller that holds the key separately (the REST
// dispatcher: its `defaults` document is key-free by contract) states the pair here, and
// the scope check compares against `credential.baseURL` instead.
export type ProviderCredential = {
    apiKey: string;
    // The provider this key was issued for (origin + base path).
    baseURL: string;
};

// Merge a client's per-session settings over the server defaults.
//
// Key resolution, in order:
//   1. an explicit non-blank client key is used as given (trimmed);
//   2. otherwise the server key is used ONLY when the effective base URL is the
//      provider the key belongs to (same origin + base path, trailing slashes
//      ignored) — `credential.baseURL` when one is supplied, else `defaults.baseURL`;
//   3. otherwise the key is empty — the request goes out unauthenticated.
//
// `baseURL: ''` is kept as empty, which is how a live preset reports that it
// needs one. `model: ''` falls back to the server model, like before.
export const mergeSettings = (
    defaults: RunnerSettings,
    input: Partial<RunnerSettings> | undefined,
    // Omitted = the credential lives in `defaults.apiKey` and is scoped to
    // `defaults.baseURL` (the store's own settings object, unchanged behavior).
    credential?: ProviderCredential
): RunnerSettings => {
    const requestedBaseURL = optionalString(input?.baseURL, 'baseURL');
    const requestedModel = optionalString(input?.model, 'model');
    const requestedApiKey = optionalString(input?.apiKey, 'apiKey');

    const baseURL = requestedBaseURL !== undefined ? requestedBaseURL.trim() : defaults.baseURL;
    const model = requestedModel?.trim() || defaults.model;

    // Validate before returning: both the model listing and session creation use
    // the result, so one cap here covers every provider request path.
    if (baseURL.length > MAX_BASE_URL_LENGTH) {
        throw new SettingsError(`A provider base URL cannot exceed ${MAX_BASE_URL_LENGTH} characters.`);
    }

    if (model.length > MAX_MODEL_LENGTH) {
        throw new SettingsError(`A model name cannot exceed ${MAX_MODEL_LENGTH} characters.`);
    }

    const explicitKey = requestedApiKey?.trim() ?? '';

    // T28: the (key, provider) pair the server credential belongs to. Stating it separately
    // is what preserves the origin+base-path scope when the EFFECTIVE base URL has moved —
    // a `/config` base_url patch changes where sessions go, not whose secret may travel.
    // With no credential supplied the pair is the defaults themselves, exactly as before.
    const serverKey = credential === undefined ? defaults.apiKey : credential.apiKey;
    const scopeBaseURL = credential === undefined ? defaults.baseURL : credential.baseURL;

    const apiKey =
        explicitKey.length > 0
            ? explicitKey
            : isSameProvider(baseURL, scopeBaseURL)
              ? serverKey.trim()
              : '';

    return { baseURL, model, apiKey };
};

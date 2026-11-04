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
// Cross-references:
//   - ./api.ts      — POST /models merges over the STORE's live settings
//   - ./sessions.ts — SessionStore.create merges over the same settings
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

// The server RUNTIME, kept beside (not inside) the provider settings: settings are
// per-session and client-visible, the runtime is a deployment property and never
// leaves the process.
export type ServerRuntimeConfiguration = {
    threadExecution: ThreadExecutionMode;
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

// Bounds exist so one typo cannot park every lane behind a 40-second handshake or
// fork 400 harness replicas. They are limits, not tuning advice.
export const WORKER_IDLE_MS_MAX = 3_600_000;
export const MAX_LANE_WORKERS_LIMIT = 64;
export const WORKER_HANDSHAKE_MS_MIN = 1_000;
export const WORKER_HANDSHAKE_MS_MAX = 600_000;

export const DEFAULT_RUNTIME_CONFIGURATION: ServerRuntimeConfiguration = {
    threadExecution: DEFAULT_THREAD_EXECUTION,
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

// Read the runtime from the process environment. Idempotent and side-effect free.
export const loadRuntimeConfiguration = (env: NodeJS.ProcessEnv = process.env): ServerRuntimeConfiguration => {
    const threadExecution = parseThreadExecutionMode(env.HARNESS_THREAD_EXECUTION);

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

    return {
        threadExecution,
        workerIdleMs,
        maxLaneWorkers,
        workerHandshakeMs,
        ...(entry.length > 0 ? { workerEntry: entry } : {})
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

    return {
        threadExecution,
        workerIdleMs,
        maxLaneWorkers,
        workerHandshakeMs,
        ...(entry.length > 0 ? { workerEntry: entry } : loaded.workerEntry === undefined ? {} : { workerEntry: loaded.workerEntry })
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

// Merge a client's per-session settings over the server defaults.
//
// Key resolution, in order:
//   1. an explicit non-blank client key is used as given (trimmed);
//   2. otherwise the server key is used ONLY when the effective base URL is the
//      configured provider (same origin + base path, trailing slashes ignored);
//   3. otherwise the key is empty — the request goes out unauthenticated.
//
// `baseURL: ''` is kept as empty, which is how a live preset reports that it
// needs one. `model: ''` falls back to the server model, like before.
export const mergeSettings = (
    defaults: RunnerSettings,
    input: Partial<RunnerSettings> | undefined
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
    const apiKey =
        explicitKey.length > 0
            ? explicitKey
            : isSameProvider(baseURL, defaults.baseURL)
              ? defaults.apiKey.trim()
              : '';

    return { baseURL, model, apiKey };
};

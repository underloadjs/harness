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
// (T6) The provider time bounds. Imported from the LEAF the transport also uses
// (`../transport/provider-timeouts`, which depends on nothing but ../util), so the
// server validates the same variables with the SAME grammar and no new edge between
// the server layer and the transport is opened. One parser, two callers.
import {
    DEFAULT_PROVIDER_FIRST_TOKEN_TIMEOUT_MS,
    DEFAULT_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS,
    DEFAULT_PROVIDER_STREAM_CHUNK_TIMEOUT_MS,
    PROVIDER_FIRST_TOKEN_TIMEOUT_ENV,
    PROVIDER_RESPONSE_HEAD_TIMEOUT_ENV,
    PROVIDER_STREAM_CHUNK_TIMEOUT_ENV,
    PROVIDER_TIMEOUT_MAX_MS,
    resolveProviderTimeout
} from '../engine/transport/provider-timeouts';
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
    // Explicit path to the worker entry module. When omitted the host resolves the package's
    // own `src/server/workers/lane-worker.ts` through ./package-root.ts. Either way the
    // thread loads it through the Vite module runner (./workers/worker-runner.ts), so this is
    // a source path, not a built bundle.
    workerEntry?: string;
    // D4: explicit path to the IO worker entry module. Omitted means the resolver chain in
    // ./workers/io-client.ts (`resolveIoWorkerEntry`). Same loading as the lane entry: the
    // runner imports whatever path is resolved.
    ioEntry?: string;
    // F1 (2026-11-17): how many CONSECUTIVE network-class run failures one conversation may
    // accumulate before the server stops auto-resuming it (see
    // `DEFAULT_NETWORK_RESUME_LIMIT` above for the rule and `resolveNetworkResumeLimit` for
    // the grammar).
    //
    // OPTIONAL on the type so no existing host option object or worker-mode test fixture
    // changes shape; ALWAYS present from `loadRuntimeConfiguration` when the operator set
    // `HARNESS_PROVIDER_NETWORK_RESUME_LIMIT`, and otherwise the store resolves
    // `DEFAULT_NETWORK_RESUME_LIMIT` itself. A per-provider
    // `settings.networkResumeLimit` outranks this, exactly as the three provider time bounds
    // outrank their variables.
    networkResumeLimit?: number;
};

// (T6) The three provider time bounds in force for this process. They are a
// DEPLOYMENT property like the runtime below — the transport enforces them per
// request, and a per-session override is the same three numbers on
// `provider.*TimeoutMs` (../types). Resolved once, at startup, so an operator typo
// (`HARNESS_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS=5m`) aborts the process naming the
// variable rather than quietly landing on a different bound.
export type ProviderTimeoutConfiguration = {
    responseHeadMs: number;
    firstTokenMs: number;
    streamChunkMs: number;
};

// The shipped defaults, spelled out here so a status surface can show what is in
// force without re-deriving them. `0` on any leg means "that bound is off".
export const DEFAULT_PROVIDER_TIMEOUT_CONFIGURATION: ProviderTimeoutConfiguration = {
    responseHeadMs: DEFAULT_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS,
    firstTokenMs: DEFAULT_PROVIDER_FIRST_TOKEN_TIMEOUT_MS,
    streamChunkMs: DEFAULT_PROVIDER_STREAM_CHUNK_TIMEOUT_MS
};

// ---------------------------------------------------------------------------
// F1 (2026-11-17): the AUTO-RECOVERY ceiling
// ---------------------------------------------------------------------------
//
// WHY A CEILING AT ALL. "The thread must continue and auto-recover in every scenario"
// is the requirement, and an unbounded auto-resume is not recovery — it is a loop that
// spends provider time forever against a provider that is simply down. The store
// therefore keeps a DURABLE per-conversation streak of consecutive network-class run
// failures (./sessions.ts `Session.networkFailures`) and auto-resumes while the streak is
// BELOW this ceiling; at the ceiling the conversation rests with its recorded stop reason
// and only a host action resumes it. One answered run clears the streak.
//
// THE DEFAULT IS 10 — the same figure the per-request retry ladder publishes
// (`DEFAULT_MAX_RETRIES`, ../core/agent-limits.ts) — because the operator who asked for
// this counted ten provider attempts, not ten thread resumes.
//
// `0` means "never auto-resume": the honest spelling of "turn the feature off", mirroring
// the `0` = off rule of the three provider bounds above, and NOT "resume once" (which
// would make `0` mean `1` and leave no way to say off).
export const DEFAULT_NETWORK_RESUME_LIMIT = 10;

// The operator-facing variable, exported so the message that refuses a bad value and the
// `.env.example` entry cannot drift apart. It carries the `HARNESS_PROVIDER_` prefix for
// the same reason the three bounds above do: the number bounds a PROVIDER condition, and an
// operator looking for "what controls what my provider failures cost" finds it in one place.
export const NETWORK_RESUME_LIMIT_ENV = 'HARNESS_PROVIDER_NETWORK_RESUME_LIMIT';

// A thread resume is a whole run, not a backoff step, so a streak in the thousands is a
// mis-set variable, not a tuning choice. The ceiling exists to catch that at startup.
export const NETWORK_RESUME_LIMIT_MAX = 1_000;

// Resolve ONE ceiling, with the SAME grammar and precedence `resolveProviderTimeout`
// documents: the explicit provider/session field, then the environment variable, then the
// shipped default. Digits only, nothing coerced, and the refusal names the variable — a
// deployment whose `HARNESS_PROVIDER_NETWORK_RESUME_LIMIT=10x` silently became 10 (or 0)
// would change how a whole class of incidents resolves.
//
// It deliberately does NOT reuse `resolveProviderTimeout` (../transport/provider-timeouts):
// that parser's range and error text are about MILLISECONDS, and this is a COUNT.
export const resolveNetworkResumeLimit = (input: {
    // The provider/session-scoped setting, when a host supplied one.
    explicit?: number;
    // The environment variable this ceiling answers to (also quoted in the error).
    variable?: string;
    // The shipped default. `DEFAULT_NETWORK_RESUME_LIMIT` is what every caller uses today.
    fallback?: number;
    // Test seam: an explicit environment instead of `process.env`.
    env?: Record<string, string | undefined>;
} = {}): number => {
    const variable = input.variable ?? NETWORK_RESUME_LIMIT_ENV;
    const fallback = input.fallback ?? DEFAULT_NETWORK_RESUME_LIMIT;
    const range = `an integer between 0 and ${NETWORK_RESUME_LIMIT_MAX} (0 turns auto-resume off)`;

    const explicit = input.explicit;

    if (explicit !== undefined) {
        if (
            !Number.isSafeInteger(explicit) ||
            explicit < 0 ||
            explicit > NETWORK_RESUME_LIMIT_MAX
        ) {
            throw new SettingsError(
                `\`networkResumeLimit\` must be ${range}; received ${String(explicit)}. ` +
                    `It is the consecutive network failures one conversation tolerates before the server stops resuming it (the ${variable} default).`
            );
        }

        return explicit;
    }

    // Read defensively: this module is reachable from a browser bundle where `process`
    // does not exist, and only a dynamic index is safe there.
    const env =
        input.env ??
        (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    const raw = env?.[variable];

    if (raw === undefined || raw.trim().length === 0) return fallback;

    const trimmed = raw.trim();

    if (!/^\d+$/.test(trimmed)) {
        throw new ServerRuntimeError(`${variable} must be ${range}; received ${JSON.stringify(raw)}.`);
    }

    const parsed = Number(trimmed);

    if (!Number.isSafeInteger(parsed) || parsed > NETWORK_RESUME_LIMIT_MAX) {
        throw new ServerRuntimeError(`${variable} must be ${range}; received ${JSON.stringify(raw)}.`);
    }

    return parsed;
};

// Read the three bounds from an environment. Idempotent and side-effect free, like
// `loadRuntimeConfiguration`; the ceilings are the transport's, and the accepted
// grammar is identical (digits only, `0` disables, no coercion).
export const loadProviderTimeoutConfiguration = (
    env: NodeJS.ProcessEnv = process.env
): ProviderTimeoutConfiguration => ({
    responseHeadMs: resolveProviderTimeout({
        variable: PROVIDER_RESPONSE_HEAD_TIMEOUT_ENV,
        fallback: DEFAULT_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS,
        env
    }),
    firstTokenMs: resolveProviderTimeout({
        variable: PROVIDER_FIRST_TOKEN_TIMEOUT_ENV,
        fallback: DEFAULT_PROVIDER_FIRST_TOKEN_TIMEOUT_MS,
        env
    }),
    streamChunkMs: resolveProviderTimeout({
        variable: PROVIDER_STREAM_CHUNK_TIMEOUT_ENV,
        fallback: DEFAULT_PROVIDER_STREAM_CHUNK_TIMEOUT_MS,
        env
    })
});

export type ServerConfiguration = {
    settings: RunnerSettings;
    defaults: HarnessIndex['defaults'];
    runtime: ServerRuntimeConfiguration;
    // (T6) Optional on the type (a host that assembles a configuration by hand keeps
    // compiling) but ALWAYS present from `loadConfiguration`, because the reported
    // bounds are what a status bar needs in order to explain a `provider-timeout`.
    providerTimeouts?: ProviderTimeoutConfiguration;
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

const DEFAULT_BASE_URL = 'http://localhost:8800/providers/private/v1';
// The local basalt model, which is the id the private provider at DEFAULT_BASE_URL
// actually serves for it (its /models catalogue lists `local/basalt`; a hosted
// `merge/ds4-flash` request costs money and a `localhost/basalt` request 404s).
// Every live preset agent with no per-agent override resolves to this id, so the
// UI's agent deck shows it on every tile.
const DEFAULT_MODEL = 'local/basalt';

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
// (T6) Re-exported so the server layer, `.env.example` and any status surface quote
// ONE set of names for these bounds.
export { PROVIDER_TIMEOUT_MAX_MS };

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

// (T8, AC2) One optional provider TIME BOUND from a client-supplied settings body,
// mirroring `optionalString` above and `MAX_BASE_URL_LENGTH` validation in
// `mergeSettings`: a field that can be ANY JSON value is checked once, here, so a
// route never 500s on a string and a bad value answers 400 (SettingsError) naming the
// field. Nothing is coerced — `numberEnsures` would map `"12s"` to 0, and 0 means
// "this bound is OFF", i.e. a typo would silently re-open the very hang the bound
// exists to close. The accepted grammar is the transport's own (`resolveProviderTimeout`):
// a safe integer, `0` = disabled, ceiling `PROVIDER_TIMEOUT_MAX_MS`.
const optionalTimeout = (value: unknown, field: keyof RunnerSettings): number | undefined => {
    if (value === undefined) return undefined;

    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > PROVIDER_TIMEOUT_MAX_MS) {
        throw new SettingsError(
            `\`settings.${field}\` must be an integer between 0 and ${PROVIDER_TIMEOUT_MAX_MS} ` +
                `(0 disables the bound); received ${JSON.stringify(value)}.`
        );
    }

    return value;
};

// ONE bound of a merged result: the client's explicit value wins, the server default
// comes next, and NEITHER present stays `undefined` so the transport can still resolve
// the environment variable and the shipped default (`../transport/provider-timeouts`).
// A `0` is a real value ("this bound is off"), never "unset", which is why only
// `undefined` falls through.
const mergedTimeout = (
    requested: number | undefined,
    fallback: number | undefined,
    field: keyof RunnerSettings
): number | undefined => (requested === undefined ? fallback : optionalTimeout(requested, field));

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

    // F1: the auto-resume ceiling is read ONLY when the operator actually set the variable,
    // and then validated (a bad value aborts startup naming it). Leaving the key absent
    // otherwise keeps every existing runtime object byte-identical — the store resolves
    // `DEFAULT_NETWORK_RESUME_LIMIT` at the point of use — and matches how `workerEntry`
    // above treats "not set".
    const networkResumeLimit =
        env[NETWORK_RESUME_LIMIT_ENV] === undefined || env[NETWORK_RESUME_LIMIT_ENV]?.trim().length === 0
            ? undefined
            : resolveNetworkResumeLimit({ env });

    return {
        threadExecution,
        ioExecution,
        workerIdleMs,
        maxLaneWorkers,
        workerHandshakeMs,
        ...(entry.length > 0 ? { workerEntry: entry } : {}),
        ...(ioEntry.length > 0 ? { ioEntry } : {}),
        ...(networkResumeLimit === undefined ? {} : { networkResumeLimit })
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
        ...(ioEntry.length > 0 ? { ioEntry } : loaded.ioEntry === undefined ? {} : { ioEntry: loaded.ioEntry }),
        // F1: explicit host option wins, then what the environment supplied, and "neither"
        // stays ABSENT (the store's own default is the last resort, not this function's job —
        // `resolveNetworkResumeLimit` is what applies it at the point of use).
        ...(input.networkResumeLimit === undefined
            ? loaded.networkResumeLimit === undefined
              ? {}
              : { networkResumeLimit: loaded.networkResumeLimit }
            : {
                  networkResumeLimit: resolveNetworkResumeLimit({
                      explicit: input.networkResumeLimit
                  })
              })
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
        runtime: loadRuntimeConfiguration(),
        // Validated here as well as at transport construction: an operator must learn
        // about a bad bound at startup, not on the first stalled provider.
        providerTimeouts: loadProviderTimeoutConfiguration()
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

    // (T8, AC2) The three time bounds, merged with the SAME precedence the transport
    // already documents for them: this session's field is authoritative when present,
    // the server default comes next, and an absent pair stays absent so the environment
    // variable and the shipped default still resolve downstream. A rejected value is a
    // 400 (SettingsError) before anything is returned, exactly like the length caps
    // below, because both the model listing and session creation consume this result.
    const responseHeadTimeoutMs = mergedTimeout(
        input?.responseHeadTimeoutMs,
        defaults.responseHeadTimeoutMs,
        'responseHeadTimeoutMs'
    );

    const firstTokenTimeoutMs = mergedTimeout(input?.firstTokenTimeoutMs, defaults.firstTokenTimeoutMs, 'firstTokenTimeoutMs');

    const streamChunkTimeoutMs = mergedTimeout(input?.streamChunkTimeoutMs, defaults.streamChunkTimeoutMs, 'streamChunkTimeoutMs');

    // F1: the auto-resume ceiling, merged with the SAME precedence (this session's field
    // beats the server default, and an absent pair stays absent so the deployment variable
    // and the shipped default still resolve downstream — `resolveNetworkResumeLimit` in this
    // file). A bad value is a 400 naming the field, like every other settings bound here,
    // and NOTHING is coerced: `0` is a real answer ("never auto-resume"), so silently
    // mapping a typo to 0 would switch the recovery feature off behind the operator's back.
    const requestedResumeLimit = input?.networkResumeLimit;
    const serverResumeLimit = defaults.networkResumeLimit;

    const networkResumeLimit =
        requestedResumeLimit === undefined && serverResumeLimit === undefined
            ? undefined
            : resolveNetworkResumeLimit({
                  explicit: requestedResumeLimit ?? serverResumeLimit
              });

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

    // The bounds are attached only when a value exists at either layer, so an untouched
    // session returns the exact `{ baseURL, model, apiKey }` object it always did (no
    // `undefined`-valued keys, which `toStrictEqual` consumers would see).
    return {
        baseURL,
        model,
        apiKey,
        ...(responseHeadTimeoutMs === undefined ? {} : { responseHeadTimeoutMs }),
        ...(firstTokenTimeoutMs === undefined ? {} : { firstTokenTimeoutMs }),
        ...(streamChunkTimeoutMs === undefined ? {} : { streamChunkTimeoutMs }),
        // F1: same conditional spread — an untouched session returns exactly the settings
        // object it always did, with no `networkResumeLimit` key at all.
        ...(networkResumeLimit === undefined ? {} : { networkResumeLimit })
    };
};

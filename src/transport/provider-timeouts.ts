// Provider time bounds and failure classes (T6, 2026-11-16).
//
// WHY THIS LEAF EXISTS. The reported defect is "I open the harness, type a message,
// and creating a new thread seems to run forever". Two independent mechanisms made
// that true, and both are now owned here:
//
//   1. NOTHING BOUNDED THE OUTBOUND CALL. `openai.ts` passed only `request.signal`
//      to `fetch` (aborted solely by a user stop) and the SSE loop awaited
//      `reader.read()` with no clock, so a provider that accepted the TCP
//      connection and then said nothing kept the turn `running` forever — the
//      terminal frame at the end of that loop can only fire once the body closes.
//      (`core/agent-limits.ts` says the same thing about the run: "nothing external
//      ends it on a clock".)
//   2. EVERY TRANSPORT FAILURE SPENT THE 1 s -> 512 s LADDER. A refused connection
//      (a provider that is simply not up on the configured port) is the MOST
//      common cause of the hang, and it is a configuration condition, not a
//      transient blip — yet it burned one initial attempt plus ten retries, i.e.
//      1+2+4+…+512 s = 1023 s (~17.05 min) of pure backoff before the user saw
//      anything. THAT ARITHMETIC IS HISTORY TWICE OVER: the connection class got its
//      own 750 ms ladder (T6, AC2), and the transient ladder's waits are now CAPPED at
//      `RETRY_MAX_DELAY_MS` (60 s, ../core/agent-limits.ts), so the same exhausted
//      transient ladder costs at most 1+2+4+8+16+32+60+60+60+60 = 303 s (~5.05 min)
//      instead of 1023 s.
//
// This module holds the THREE bounds, their defaults, their environment variables,
// the message each one produces, the classifier that tells the agent which
// retry policy a fetch failure deserves, and the gateway's mid-stream error
// vocabulary (see `providerWireFailureOf`). It is a LEAF (only ../util, plus a
// type-only import of ../types) on purpose: `../server/config.ts` and `./openai.ts`
// both need the same facts and must not
// grow an import edge to each other, and a browser bundle that pulls the transport
// must not pay for the server layer.
//
// ONE PARSER, TWO CALLERS. The transport resolves these itself (at transport
// construction) so an env var changes behaviour with no server-layer wiring; the
// server resolves them through `loadProviderTimeoutConfiguration`
// (../server/config.ts) so a typo aborts startup naming the variable, and the
// reported runtime states what is in force. Both go through
// `resolveProviderTimeout` below, so there is exactly one grammar.
//
// DEFAULTS ARE DELIBERATELY GENEROUS. The risk of cutting off a legitimately slow
// provider is worse than the win of failing a stalled one a minute sooner, because
// the previous behaviour was "wait forever" and a slow provider was still correct.
// Every bound is therefore well above any real provider latency, and `0` disables
// any bound individually to restore the exact pre-T6 behaviour:
//
//   response head  300 000 ms (5 min). The bound on `fetch` resolving with response
//                  headers. Most OpenAI-compatible servers flush headers the moment
//                  they start streaming, so this normally bounds a WEDGED provider
//                  (queued behind another generation, a cold model load, a worker
//                  that accepted the socket and stalled). It is 5 minutes rather
//                  than 60 seconds because several gateways in this workspace
//                  buffer the response and flush headers only when the first token
//                  is ready — for those the head bound and the thinking time are
//                  the SAME wait, and a cold 40 B load plus a long prompt exceeds a
//                  minute by minutes.
//   first token    300 000 ms (5 min). The bound on the FIRST streamed frame after
//                  the head. A large-context thinking model can be silent before
//                  its first reasoning or content delta for minutes, so this is
//                  intentionally the same generous figure, not a token-paced one.
//   stream chunk   120 000 ms (2 min). The bound BETWEEN consecutive reads of an
//                  open body. A streaming provider emits reasoning deltas or
//                  content deltas continuously (sub-second gaps); a two-minute gap
//                  means the upstream died silently — a proxy that lost its backend
//                  and never closed the body. Two minutes is ~2 orders of magnitude
//                  above any observed inter-delta gap.
//
// Cross-references:
//   - ./openai.ts              — the only transport that enforces these
//   - ../core/agent.ts         — the retry owner that switches on these codes
//   - ../core/agent-limits.ts  — the sibling retry ladder these bypass
//   - ../server/config.ts      — startup validation + the reported runtime
//   - ../.env.example          — the operator-facing copy of these names

import { HarnessError, isInstanceOf } from '../util';
// The published shape of ONE provider attempt's diagnostics (`retry.provider`). The
// transport BUILDS this object and `providerDiagnosticsOf` below validates it off a
// thrown error, so the leaf that owns the vocabulary also owns the shape — and
// ../core/agent.ts and ../harness.ts both read it through that one function.
import type { HarnessProviderAttemptDiagnostics } from '../types';

// The ONE machine name for "the provider had the request and ran out of time". It
// follows the `HarnessError` code convention (../util/errors.ts): the code is also
// the FIRST TOKEN of the message, because `harness.ts` renders a thrown error as
// `Tool "…" failed: <message>` and only the message reaches the model, an event
// consumer and a log line.
//
// IT IS NOT TERMINAL ANY MORE (2026-11-17, the unrecoverable-timeout report). It used
// to be — "a provider that missed a five-minute bound is not repaired by an instant
// re-send" — and that read as "the thread stopped without retry" to the operator whose
// gateway went silent 120 s into a stream: ONE attempt, zero `retry` frames, and a
// permanently interrupted conversation. A missed bound is a provider that is slow or
// wedged RIGHT NOW, and the wedge usually clears, so the class now gets its own
// BOUNDED ladder (1 + 3 attempts, 2 s/4 s/8 s waits capped at 30 s, under a ladder-wide
// wall-clock deadline — `PROVIDER_TIMEOUT_*` in ../core/agent-limits.ts). What stays
// true from the original reasoning is the SHAPE of that ladder: it never touches the
// 1 s -> 512 s transient ladder, because re-sending into a slow provider must not buy
// seventeen more minutes of waiting.
export const PROVIDER_TIMEOUT_CODE = 'provider-timeout';

// The ONE machine name for "nothing answered the dial" (a refused connection, an
// unresolvable host, a connection reset before a single byte). This is a WRONG
// PORT / provider-not-up condition: `agent()` retries it a few times with
// single-digit-second waits and then fails terminally, instead of spending 17
// minutes of backoff on a deployment that is never going to answer.
export const PROVIDER_CONNECTION_CODE = 'provider-connection';

// The ONE machine name for "this request was cancelled, and not by the provider
// failing" (2026-11-17). It is the internal half of the gateway's in-stream
// `aborted` wire code (see `providerWireFailureOf` below), and it is the only
// provider-reported class `agent()` refuses to retry BESIDES `provider-rejected`:
// a cancelled request that is re-sent is a request the caller no longer wants.
// A LOCAL stop never reaches this class — the caller's own `AbortSignal` short-circuits
// first (../core/agent.ts R2), so the abort keeps its historical identity byte-for-byte.
export const PROVIDER_ABORTED_CODE = 'provider-aborted';

// The ONE machine name for "the provider answered and REFUSED the request" (T8, AC3).
// It sits beside `provider-timeout` and `provider-connection` in the same terminal
// family: all three mean "re-sending these bytes cannot help", and `agent()` treats
// them the same way (one attempt, no ladder).
//
// WHY A CODE AT ALL: an HTTP 400/401/403/404 frame used to carry no code, so it walked
// the full transient ladder — a REVOKED API KEY was therefore indistinguishable from a
// hang, 1 initial attempt plus 10 retries and 1023 s (~17 min) of backoff before the
// user learned the key was bad. `context-overflow` already proved the fix (issue 0004):
// the transport names the class, `agent()` switches on the machine code, prose is only
// ever the human half.
//
// THE CUT-OFF (why 400/401/403/404 and NOT 408/429/5xx) — see `isTerminalProviderStatus`.
export const PROVIDER_REJECTED_CODE = 'provider-rejected';

// Which bound expired, and therefore which sentence to show. `response-head` is
// the accept-but-silent case, `first-token` is a stream that opened and never
// produced, `stream-chunk` is an established stream that went silent.
export type ProviderTimeoutPhase = 'response-head' | 'first-token' | 'stream-chunk';

// A diagnosed connection failure: the errno when the platform named one, plus the
// deepest useful message from the cause chain (`connect ECONNREFUSED
// 127.0.0.1:6660`) so the frame quotes what the OS actually reported.
export type ProviderConnectionFailure = {
    errno?: string;
    detail: string;
};

// ---------------------------------------------------------------------------
// Bounds: names, defaults, and the one parser
// ---------------------------------------------------------------------------

// The three shipped defaults (see the header for the justification of each).
export const DEFAULT_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS = 300_000;
export const DEFAULT_PROVIDER_FIRST_TOKEN_TIMEOUT_MS = 300_000;
export const DEFAULT_PROVIDER_STREAM_CHUNK_TIMEOUT_MS = 120_000;

// Operator-facing variable names, exported so the message that rejects a bad value,
// the `.env.example` entry, and `server/config.ts` cannot drift apart.
export const PROVIDER_RESPONSE_HEAD_TIMEOUT_ENV = 'HARNESS_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS';
export const PROVIDER_FIRST_TOKEN_TIMEOUT_ENV = 'HARNESS_PROVIDER_FIRST_TOKEN_TIMEOUT_MS';
export const PROVIDER_STREAM_CHUNK_TIMEOUT_ENV = 'HARNESS_PROVIDER_STREAM_CHUNK_TIMEOUT_MS';

// The ceiling is one day: these are provider latency bounds, and a larger number
// means the operator meant "no bound" — which `0` says honestly.
export const PROVIDER_TIMEOUT_MAX_MS = 86_400_000;

// The environment, read defensively: the transport is reachable from a browser
// bundle (`src/browser.ts`) where `process` does not exist at all. Only a dynamic
// index is used, so a Vite `define` rewrite of `process.env.FOO` cannot fire here
// either — this module never names a variable literally on `process.env`.
const processEnvironment = (): Record<string, string | undefined> | undefined => {
    try {
        const holder = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;

        return holder?.env;
    } catch {
        return undefined;
    }
};

// Resolve ONE bound. Precedence: the explicit provider field, then the environment
// variable, then the shipped default. `0` means "this bound is off" (the pre-T6
// behaviour), and NOTHING is coerced: like `server/config.ts`, a typo is a named
// startup/construction failure rather than a silently different deployment, because
// a value that lands on 0 by accident would silently re-open the hang this task is
// about. Digits only, so `12s`, `1_000`, `1e3` and `-5` are all rejected outright.
export const resolveProviderTimeout = (input: {
    // The provider-scoped setting, when a host supplied one.
    explicit?: number;
    // The environment variable this bound answers to (also quoted in the error).
    variable: string;
    fallback: number;
    // Test seam: an explicit environment instead of `process.env`.
    env?: Record<string, string | undefined>;
}): number => {
    const { variable, fallback } = input;
    const range = `an integer between 0 and ${PROVIDER_TIMEOUT_MAX_MS} (0 disables the bound)`;

    const explicit = input.explicit;

    if (explicit !== undefined) {
        if (!Number.isSafeInteger(explicit) || explicit < 0 || explicit > PROVIDER_TIMEOUT_MAX_MS) {
            throw new HarnessError(
                `\`provider.${fieldOf(variable)}\` must be ${range}; received ${String(explicit)}. ` +
                    `It is the ${variable} bound for this provider.`
            );
        }

        return explicit;
    }

    const env = input.env ?? processEnvironment();
    const raw = env?.[variable];

    if (raw === undefined || raw.trim().length === 0) return fallback;

    const trimmed = raw.trim();

    if (!/^\d+$/.test(trimmed)) {
        throw new HarnessError(`${variable} must be ${range}; received ${JSON.stringify(raw)}.`);
    }

    const parsed = Number(trimmed);

    if (!Number.isSafeInteger(parsed) || parsed > PROVIDER_TIMEOUT_MAX_MS) {
        throw new HarnessError(`${variable} must be ${range}; received ${JSON.stringify(raw)}.`);
    }

    return parsed;
};

// The provider-field spelling that corresponds to an env var, so an error message
// names the field the host actually wrote (`provider.responseHeadTimeoutMs`) rather
// than only the variable a deployment would set.
const fieldOf = (variable: string): string =>
    variable === PROVIDER_RESPONSE_HEAD_TIMEOUT_ENV
        ? 'responseHeadTimeoutMs'
        : variable === PROVIDER_FIRST_TOKEN_TIMEOUT_ENV
          ? 'firstTokenTimeoutMs'
          : 'streamChunkTimeoutMs';

// ---------------------------------------------------------------------------
// URL display
// ---------------------------------------------------------------------------

// A URL safe to quote in a frame, a log line or an event: origin + path only, with
// no userinfo, query or fragment. The API key lives in an `authorization` header,
// but a baseURL that embedded a credential (or a token in `?key=`) must not have it
// echoed back by an error that the UI renders. `host` keeps the port so the message
// can name what was dialled; `port` is the EFFECTIVE port (an explicit port wins,
// otherwise the scheme's default) because "which port is it using, 5500 or 6660?"
// is exactly the question this failure answers.
export const providerURLOf = (raw: string): { url: string; host: string; port?: number } => {
    try {
        const parsed = new URL(raw);

        parsed.username = '';
        parsed.password = '';
        parsed.search = '';
        parsed.hash = '';

        const port =
            parsed.port !== '' && parsed.port !== undefined
                ? Number(parsed.port)
                : parsed.protocol === 'https:'
                  ? 443
                  : parsed.protocol === 'http:'
                    ? 80
                    : undefined;

        return {
            url: `${parsed.origin}${parsed.pathname}`,
            host: port === undefined ? parsed.hostname : `${parsed.hostname}:${port}`,
            ...(port === undefined ? {} : { port })
        };
    } catch {
        // A relative or malformed baseURL: quote it as written, with no host claim.
        return { url: raw, host: raw };
    }
};

// Replace the key wherever it appears in provider-supplied text. A gateway can echo
// request headers back in an error body, and the cause message of a fetch failure is
// arbitrary text; an echoed secret must never reach the UI or a log line. Short keys
// would over-redact, so only credential-shaped lengths are scrubbed (the same rule
// ./models.ts applies).
export const redactProviderKey = (message: string, key: string | undefined): string => {
    if (!key || key.length < 8) return message;

    return message.split(key).join('[redacted]');
};

// ---------------------------------------------------------------------------
// Failure classification
// ---------------------------------------------------------------------------

// Errnos that mean "the dial never reached a provider": connection establishment,
// name resolution, and reachability. All of them are configuration or deployment
// state, so retrying them for 512 seconds cannot help.
const CONNECTION_ERRNOS = new Set([
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'ECONNABORTED'
]);

// `ECONNRESET` is conditional: a reset BEFORE any byte reached us is the same dead
// dial, and a reset AFTER tokens arrived is a truncated generation, which the agent
// already handles through its existing (retried) path. That is why the caller has to
// say whether anything was delivered.
const RESET_ERRNO = 'ECONNRESET';

// Every errno we recognise, in the form a platform that only puts the code in the
// MESSAGE (not in `error.code`) writes it.
const ERRNO_IN_MESSAGE = /E(?:CONNREFUSED|NOTFOUND|AI_AGAIN|NETUNREACH|HOSTUNREACH|CONNABORTED|CONNRESET)/;

// Walk a fetch failure's cause graph and return the connection failure it describes,
// or `undefined` for anything that is not one. `fetch` wraps the socket error, so the
// useful half is usually TWO levels down (`TypeError: fetch failed` ->
// `Error: connect ECONNREFUSED 127.0.0.1:6660`), and Happy Eyeballs stacks wrap the
// real causes in an `AggregateError` under `errors`. Traversal is cycle-guarded and
// depth-capped because a thrown value may be hostile, and classification must never
// throw.
export const connectionFailureOf = (
    error: unknown,
    allowReset: boolean
): ProviderConnectionFailure | undefined => {
    const queue: unknown[] = [error];
    const seen = new Set<unknown>();
    let depth = 0;

    while (queue.length > 0 && depth < 8) {
        const size = queue.length;

        for (let index = 0; index < size; index += 1) {
            const node = queue.shift();

            if (node === undefined || node === null || seen.has(node)) continue;
            if (typeof node !== 'object') continue;

            seen.add(node);

            const record = node as {
                code?: unknown;
                message?: unknown;
                cause?: unknown;
                errors?: unknown;
                name?: unknown;
            };

            const code = typeof record.code === 'string' ? record.code.toUpperCase() : undefined;
            const message = typeof record.message === 'string' ? record.message : '';
            // An `AggregateError` names the errno in `name` (`AggregateError [EAI_AGAIN]`).
            const named = typeof record.name === 'string' ? record.name : '';

            const recognised =
                (code !== undefined && (CONNECTION_ERRNOS.has(code) || (allowReset && code === RESET_ERRNO))) ||
                (allowReset && named.includes(RESET_ERRNO)) ||
                (code === undefined && ERRNO_IN_MESSAGE.test(message));

            if (recognised) {
                const errno =
                    code !== undefined && CONNECTION_ERRNOS.has(code)
                        ? code
                        : code === RESET_ERRNO
                          ? RESET_ERRNO
                          : named.includes(RESET_ERRNO)
                            ? RESET_ERRNO
                            : (message.match(ERRNO_IN_MESSAGE) ?? [undefined])[0];

                return { ...(errno === undefined ? {} : { errno }), detail: message.length > 0 ? message : named };
            }

            if (record.cause !== undefined) queue.push(record.cause);
            if (Array.isArray(record.errors)) queue.push(...record.errors);
        }

        depth += 1;
    }

    return undefined;
};

// ---------------------------------------------------------------------------
// Deterministic HTTP refusals (T8, AC3)
// ---------------------------------------------------------------------------

// The statuses that mean "the provider is up, understood the dial, and refused THIS
// request on purpose". Every one of them is a property of the BYTES we sent (the
// credential, the route, the argument), so attempt N+1 is the same request and gets
// the same answer: a retry ladder buys a delay and nothing else.
//
// THE CUT-OFF, stated because it is a judgement call and a reader will question it:
//   400  a malformed or refused payload. A 400 whose body says "too long / context"
//        is caught EARLIER by the context-overflow classifier, which owns that
//        wording; reaching this branch means the provider refused the request shape
//        itself (an out-of-range `max_tokens`, an unknown field), which no retry fixes.
//   401  the credential was not accepted. Retrying with the same header cannot
//        change that, and it is the single most common "why is it spinning forever"
//        report after the dead dial.
//   403  the credential is valid but not allowed on this route/model — a policy
//        answer, stable across attempts.
//   404  the model or route does not exist at this endpoint. A typo'd model id is the
//        real-world case; it resolves only when someone edits the settings.
//
// NOT here, and deliberately so — these stay on the transient ladder because the
// SAME request may well succeed a moment later:
//   408  request timeout: the provider was willing and the load was transient, which
//        is precisely what a backoff is for.
//   429  rate limited: a retry-after backoff is the documented remedy, and the ladder
//        (1 s .. 512 s) is a reasonable approximation of one. Reclassifying 429
//        terminal would break the most common self-healing case in the codebase.
//   5xx  the provider or an upstream is unhealthy/restarting: transient by definition.
//        The 503 that a model load produces for ten seconds is the textbook case.
// The rule, in one line: a refusal that only OUR request can fix is terminal; a
// refusal that TIME can fix keeps the ladder. Statuses outside both lists (402, 409,
// 422, ...) keep the historical codeless frame byte-for-byte and therefore the ladder
// they have always had, so the change is exactly the four statuses above.
export const isTerminalProviderStatus = (status: number): boolean =>
    status === 400 || status === 401 || status === 403 || status === 404;

// ---------------------------------------------------------------------------
// The gateway's mid-stream error vocabulary (2026-11-17, unrecoverable-timeout report)
// ---------------------------------------------------------------------------
//
// A gateway that proxies another provider does not fail the HTTP request when ITS
// upstream dies: it answers 200, streams a while, and attaches an error object to one
// SSE frame (`{"error":{"code":"timeout","status":504,…}}`). Until now the transport
// read only `error.message` from that frame and threw the rest away, so the failure
// reached `agent()` CODELESS and walked the generic transient ladder (or, for a
// `provider-timeout`, none at all). The machine code was on the wire and we dropped it.
//
// THE VOCABULARY IS THE GATEWAY'S, NOT OURS. These six spellings are the contract the
// provider side emits — `packages/underload/service/src/server/start.ts`
// `classifyStreamError` / `buildStreamErrorPayload`, written to the SSE frame by
// `:860-873` — and `providerWireFailureOf` is the one place that translates it into OUR
// codes, so a gateway change lands in one function. Unknown spellings are NOT an error —
// they are the codeless case, i.e. today's behaviour, which keeps the ladder and can
// never fail a request the old code accepted.
//
// THE PRODUCER'S KEY SET IS EXACT: `{ error: { message, type, code, status?, errno?,
// param: null } }`. `status` and `errno` are ABSENT (not `null`) when inapplicable, and
// `param` is always `null` unless the provider named a field — so this reader treats
// "absent", `null` and `undefined` as the same answer (absence) and NEVER tests whether
// a key `in` the frame exists. BOTH producers emit that coded envelope: the primary
// gateway above, and its behaviour-compatible copy at
// `repository/agentic/src/server/start-server.ts` (vocabulary :294-303, payload builder
// :599-669), where `code` is a REQUIRED key of `StreamErrorPayload` (:310). A frame with
// NO `code` is therefore a defensive/legacy INPUT shape rather than a live producer —
// the no-code branch below is still a supported input (pinned by
// src/transport/openai.provider-wire-codes.test.ts `keeps a frame with NO code at all`),
// so it is kept on purpose and never "fixed" away.
//
// NOTHING HERE READS THE MESSAGE. Classification comes from `code`, with `status` and
// `errno` as secondary inputs, because the producer's prose is endpoint-specific (the
// private relay names `upstream <origin+pathname>`, other endpoints name
// `endpoint <folder>`) and the `unknown` class keeps the byte-identical legacy sentence
// `Upstream stream terminated`. The message is forwarded verbatim for a codeless frame
// and quoted for a coded one; it is never a classifier.
//
//   wire `timeout`        → `provider-timeout`      (the bounded timeout ladder)
//   wire `connection`     → `provider-connection`   (the short 3-attempt dial ladder)
//   wire `aborted`        → `provider-aborted`      (never retried: a cancel is not a blip)
//   wire `upstream_status`→ classified by `status` through `isTerminalProviderStatus`:
//                          a refusal status (400/401/403/404) is `provider-rejected`
//                          (terminal), anything else — including a frame with no usable
//                          status, which cannot be classified — is the codeless class.
//   wire `decode` /
//       `unknown` /
//       no code at all    → codeless, the generic transient ladder. UNCHANGED on purpose:
//                          a body we could not decode or a provider that names nothing is
//                          exactly the case the exponential ladder exists for.
//
// `decode` is deliberately NOT terminal: a provider that fails to decode ITS upstream's
// reply is an upstream that will probably answer properly on the next dial, and the
// status field is not the request's fault either way.
//
// THREE PRODUCER QUIRKS THIS CONSUMER MUST TOLERATE (they are deliberate and pinned by
// the producer's own tests, so they are absorbed here, never "fixed" upstream):
//   - an upstream 408 / 429 / 5xx — including a 504 the gateway itself would call a
//     timeout — arrives as `upstream_status` with the status attached, NOT as `timeout`.
//     The routing therefore sends 408/429/5xx to the codeless transient ladder through
//     `isTerminalProviderStatus` (a refusal must be OUR request's fault, and an upstream
//     504 is not), and only 400/401/403/404 become the terminal `provider-rejected`.
//   - `ECONNRESET` is reported as `connection` whether it landed before the first chunk
//     or after a hundred; only the message says which. Both get the short 3-attempt dial
//     ladder. That is a slight widening for the mid-stream case (it used to walk the
//     transient ladder), and it is the right answer: a reset is a dead socket either way,
//     and the short ladder still retries.
//   - `ETIMEDOUT` comes through as `timeout`, not as an errno-carrying `connection`, so
//     the timeout class must not assume "a local bound expired" — it means "the provider
//     side ran out of time", which is exactly why `details.timeoutMs` is omitted there
//     (no local bound expired, so there is no bound to quote).
export const PROVIDER_WIRE_TIMEOUT = 'timeout';
export const PROVIDER_WIRE_CONNECTION = 'connection';
export const PROVIDER_WIRE_ABORTED = 'aborted';
export const PROVIDER_WIRE_UPSTREAM_STATUS = 'upstream_status';
export const PROVIDER_WIRE_DECODE = 'decode';
export const PROVIDER_WIRE_UNKNOWN = 'unknown';

// The diagnostics class of a provider failure that the transport recognised as "the
// bytes died in transit" but that carries NO retry code (the codeless wire cases above,
// and a body that closed without reporting a completion). It exists because the retry
// decision and the DIAGNOSIS are different questions: the ladder stays generic, while
// `harness.ts` `classifyRunStopReason` still has to answer "was this run killed by the
// network?" for the session layer, and it must do that from a structured field instead
// of re-reading English prose.
//
// It is a `details.errorClass` value ONLY — never a published `HarnessErrorInfo.code` —
// because a code promises a retry policy, and this class deliberately has the generic one.
export const PROVIDER_TRANSIT_CLASS = 'provider-transit';

// What one gateway error frame means in OUR vocabulary. `code` absent = codeless
// transient ladder; `errorClass` is always set, because the diagnosis is emitted even
// when the retry class is generic (see `PROVIDER_TRANSIT_CLASS`).
export type ProviderWireFailure = {
    code?: string;
    errorClass: string;
    // The upstream HTTP status the gateway quotes, when the frame carried a usable one.
    // It rides in the MESSAGE (it is actionable prose) rather than in the diagnostics
    // block, whose shape is the frozen `HarnessProviderAttemptDiagnostics`.
    status?: number;
    errno?: string;
    // The request field the provider blamed, when it named one (`param: "max_tokens"`).
    // Quoted in the MESSAGE, because it is about OUR request; the diagnostics block keeps
    // its frozen `HarnessProviderAttemptDiagnostics` shape.
    param?: string;
    // For a wire `timeout`: which timeout phase to report. An in-stream frame can only
    // mean `stream-chunk` — the stream was open — so this is fixed, not guessed.
    phase?: ProviderTimeoutPhase;
};

// A usable HTTP status out of whatever the frame carried: a number, or a bare three-digit
// string (some proxies serialise it quoted). Anything else is "no status", which is an
// INPUT shape, not a failure — the caller then cannot claim a refusal.
const wireStatusOf = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);

    if (typeof value === 'string' && /^\d{3}$/.test(value.trim())) return Number(value.trim());

    return undefined;
};

// Translate ONE gateway error frame into our retry class + diagnostics class. TOTAL by
// construction: it reads `unknown` defensively and never throws, because this runs on an
// error path fed by arbitrary gateway JSON (a frame may be `null`, a string, or an object
// whose fields are objects).
export const providerWireFailureOf = (raw: unknown): ProviderWireFailure => {
    // The producer's exact key set is `{ message, type, code, status?, errno?, param: null }`
    // (`packages/underload/service/src/server/start.ts:635-703`). `status`/`errno` are
    // OMITTED when inapplicable rather than sent as `null`, and `param` is `null` in the
    // common case, so every field below is read as a value and absence is decided by the
    // type test — never by `'status' in frame`, which would treat an omitted key (what
    // BOTH gateway writers send, the copy in repository/agentic too) and a `null`
    // differently for no reason.
    const record = (raw ?? {}) as { code?: unknown; status?: unknown; errno?: unknown; param?: unknown };

    // Case- and space-insensitive: `Timeout`, `TIMEOUT ` and `timeout` are the same
    // gateway answer, and a spelling we fail to match silently downgrades the ladder.
    const wire = typeof record.code === 'string' ? record.code.trim().toLowerCase() : '';

    const errnoRaw = typeof record.errno === 'string' ? record.errno.trim().toUpperCase() : '';
    const status = wireStatusOf(record.status);

    const errno = errnoRaw.length > 0 ? errnoRaw : undefined;

    // The OpenAI error envelope's `param` names the request field the provider blamed
    // (`"max_tokens"`). It is only ever quoted, never classified, and a gateway that
    // sends `null` (the common case) yields absence rather than the word "null".
    const paramRaw = typeof record.param === 'string' ? record.param.trim() : '';
    const param = paramRaw.length > 0 ? paramRaw : undefined;

    if (wire === PROVIDER_WIRE_TIMEOUT) {
        return {
            code: PROVIDER_TIMEOUT_CODE,
            errorClass: PROVIDER_TIMEOUT_CODE,
            phase: 'stream-chunk',
            ...(errno === undefined ? {} : { errno })
        };
    }

    if (wire === PROVIDER_WIRE_CONNECTION) {
        return {
            code: PROVIDER_CONNECTION_CODE,
            errorClass: PROVIDER_CONNECTION_CODE,
            ...(errno === undefined ? {} : { errno })
        };
    }

    if (wire === PROVIDER_WIRE_ABORTED) {
        return { code: PROVIDER_ABORTED_CODE, errorClass: PROVIDER_ABORTED_CODE };
    }

    if (wire === PROVIDER_WIRE_UPSTREAM_STATUS) {
        // Only a status we can READ can be a refusal; a frame that claims
        // `upstream_status` without one is the codeless case, never a guess at 500.
        //
        // The producer routes an upstream 408 / 429 / 5xx — 504 included — HERE rather
        // than to `timeout`, and `isTerminalProviderStatus` deliberately names only the
        // four statuses that are about OUR request, so those land on the codeless transient
        // ladder: an upstream that is restarting, rate limiting or timing out is fixed by
        // TIME, which is precisely what a backoff buys.
        if (status !== undefined && isTerminalProviderStatus(status)) {
            return {
                code: PROVIDER_REJECTED_CODE,
                errorClass: PROVIDER_REJECTED_CODE,
                status,
                ...(param === undefined ? {} : { param })
            };
        }

        return {
            errorClass: PROVIDER_TRANSIT_CLASS,
            ...(status === undefined ? {} : { status }),
            ...(errno === undefined ? {} : { errno })
        };
    }

    // `decode`, `unknown`, an absent code, and any future gateway spelling: codeless.
    return {
        errorClass: PROVIDER_TRANSIT_CLASS,
        ...(status === undefined ? {} : { status }),
        ...(errno === undefined ? {} : { errno })
    };
};

// The operator-facing sentence for a CODED wire failure. Like every other coded frame it
// leads with the code (that text is what reaches the model, an event consumer and a log
// line), names the endpoint the frame arrived from, quotes the provider's own line, and
// says what happens next — which is the half the old `Provider reported an error` sentence
// hid, and the reason an operator could not tell a cancel from a refusal from a retryable
// stall. The status is stated when the frame carried one, because `504` and `401` call for
// completely different fixes.
const wireAdviceOf = (code: string): string => {
    if (code === PROVIDER_TIMEOUT_CODE) {
        return ' The provider (or the upstream it proxies) ran out of time while the stream was open, so this ' +
            'attempt is re-sent on a bounded retry ladder instead of ending the run.';
    }

    if (code === PROVIDER_CONNECTION_CODE) {
        return ' Nothing answered the dial on the provider side, so this attempt is re-sent on the short ' +
            'connection ladder.';
    }

    if (code === PROVIDER_ABORTED_CODE) {
        return ' The request was cancelled before it completed, so it is not re-sent.';
    }

    return ' The upstream refused this request itself, so re-sending the same bytes would be refused again.';
};

export const providerWireMessage = (input: {
    code: string;
    url: string;
    detail: string;
    status?: number;
    param?: string;
}): string => {
    const { code, url, detail } = input;

    const statusPart = input.status === undefined ? '' : ` (HTTP ${input.status})`;
    // The blamed field, when the provider named one: `401 … param "api_key"` and
    // `400 … param "max_tokens"` are different fixes, and this is the only place the
    // gateway's `param` survives.
    const paramPart = input.param === undefined ? '' : ` The provider blamed \`${input.param}\`.`;
    // Bounded like `providerRejectedMessage`: a proxy can answer with a whole HTML page,
    // and this text is replayed to the model on every later request.
    const quoted = detail.trim().length === 0 ? '' : ` The provider said: "${detail.trim().slice(0, 400)}"`;

    return `${code}: the provider reported a failure on the stream from ${url}${statusPart}.${wireAdviceOf(code)}${paramPart}${quoted}`;
};

// ---------------------------------------------------------------------------
// Diagnostics: the one reader shared by the retry frame and the terminal record
// ---------------------------------------------------------------------------

// Lift the transport's structured diagnostics off a failed attempt's error.
//
// The transport puts them on the error FRAME (`details`, see ../types), the frame loop
// puts them on the thrown `HarnessError`, and this is the ONE place that decides whether
// they are SHAPE-ABLE: a custom transport may put anything in `details`, so every field
// is checked before it rides onto a published event. Anything unrecognised yields
// `undefined`, so the `retry` event and the terminal `error` event keep the exact shape
// they had before T6 for an unclassified failure.
//
// It lives here rather than in ../core/agent.ts because BOTH consumers need it with the
// same rules: the agent puts it on every `retry` frame, and `harness.ts` puts it on the
// TERMINAL `error` record, where a UI (and the session layer) would otherwise have to
// re-derive the class from the sentence — the exact regex path this task removes.
export const providerDiagnosticsOf = (error: unknown): HarnessProviderAttemptDiagnostics | undefined => {
    try {
        if (!isInstanceOf(error, HarnessError)) return undefined;

        const details = error.details;

        if (typeof details !== 'object' || details === null) return undefined;

        const record = details as Record<string, unknown>;

        if (typeof record.errorClass !== 'string' || typeof record.url !== 'string') return undefined;

        return {
            errorClass: record.errorClass,
            // Already redacted by the transport (origin + path, no userinfo/query), so
            // a UI can render it without risking an echoed credential.
            url: record.url,
            ...(typeof record.port === 'number' ? { port: record.port } : {}),
            ...(record.phase === 'response-head' || record.phase === 'first-token' || record.phase === 'stream-chunk'
                ? { phase: record.phase }
                : {}),
            ...(typeof record.timeoutMs === 'number' ? { timeoutMs: record.timeoutMs } : {}),
            ...(typeof record.errno === 'string' ? { errno: record.errno } : {})
        };
    } catch {
        // Diagnostics are never worth a second failure on an error path.
        return undefined;
    }
};

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------


// A timeout frame. It leads with the code, names the endpoint and the bound that
// expired, says which phase stalled, and tells the operator which variable to raise
// (or set to 0) — the "legibly" half of the task. It also states honestly that the
// request may still be running on the provider, because cancelling our read does not
// cancel the provider's work.
export const providerTimeoutMessage = (input: {
    phase: ProviderTimeoutPhase;
    host: string;
    url: string;
    timeoutMs: number;
    variable: string;
    frames?: number;
}): string => {
    const { phase, host, url, timeoutMs, variable } = input;
    const seconds = Math.round(timeoutMs / 1000);

    const stalled =
        phase === 'response-head'
            ? `accepted the TCP connection at ${host} but sent no response for ${seconds} seconds`
            : phase === 'first-token'
              ? `opened the stream from ${host} but sent no token for ${seconds} seconds`
              : `delivered ${input.frames ?? 0} body chunk(s) from ${host} and then went silent for ${seconds} seconds`;

    const suffix =
        phase === 'stream-chunk'
            ? ` The stream from ${url} is unfinished, so whatever arrived is a partial answer and is discarded.`
            : ` The request was sent, so it may still be running on the provider.`;

    return (
        `${PROVIDER_TIMEOUT_CODE}: the provider ${stalled}. Nothing ended the wait earlier, so the turn ` +
        `is now failed instead of running forever.${suffix} Raise \`${variable}\` (or set it to 0 to disable ` +
        `the bound) if this endpoint legitimately needs longer.`
    );
};

// A connection frame. This is the answer to "is it using 5500 or 6660?": the message
// states the dialled host:port and the configured endpoint, quotes what the OS
// reported, and says what to check. The historical frame hid all of that behind
// "Request to <url> failed: fetch failed", because undici's real reason is on the
// `cause` that was never printed.
//
// THE REMEDIATION LEADS WITH THE PER-SESSION BASE URL, in that order on purpose. The
// effective address of a restored session resolves saved-value-first: `sessions.ts:4092`
// passes the SAVED RECORD as `input` to `mergeSettings` (`config.ts:520-524`), so a
// stored `baseURL` outranks `defaults.baseURL` — which is where `HARNESS_BASE_URL`
// (`config.ts:470`) lands. Telling the reader to set the env var FIRST is therefore the
// wrong advice for exactly this failure's classic case (a session pinned to a dead
// 5500): the env var is ignored, the dial does not move, and the user keeps seeing the
// same failure after following the message. The env var is still named — it is the
// control for a session with no stored address — but qualified so it cannot mislead.
export const providerConnectionMessage = (input: {
    host: string;
    url: string;
    failure: ProviderConnectionFailure;
}): string => {
    const { host, url, failure } = input;
    const reported =
        failure.errno === undefined
            ? failure.detail
            : `${failure.errno}${failure.detail.length > 0 ? ` (${failure.detail})` : ''}`;

    return (
        `${PROVIDER_CONNECTION_CODE}: nothing answered on ${host} — the request was dialled to ${url}. ` +
        `${reported}. Check that the provider is running on that port and that the configured base URL ` +
        `is the one you meant. Set the per-session base URL (Endpoint & model) to the endpoint that ` +
        `is actually up; \`${'HARNESS_BASE_URL'}\` counts only when the session has no stored address.`
    );
};

// A refusal frame (T8, AC3). It leads with the code like every other coded frame,
// QUOTES THE STATUS the provider actually returned (the actionable half — "401" and
// "404" call for completely different fixes), quotes the provider's own line when it
// sent one, and says what to change. The status is deliberately in the message and
// not only in the code: this text is what reaches the model, a log line and an event
// consumer, and a bare `provider-rejected` would not say whether to fix the key or
// the model id.
const refusalAdviceOf = (status: number): string => {
    if (status === 401) return ' The credential was refused: check the API key this provider was configured with.';
    if (status === 403) return ' The credential is not allowed on this endpoint or model: check what it is entitled to.';
    if (status === 404) return ' The model or route does not exist here: check the model id and the configured base path.';

    return ' The provider refused this request shape, so check the request rather than the endpoint.';
};

export const providerRejectedMessage = (input: { status: number; url: string; detail: string }): string => {
    const { status, url, detail } = input;
    // The provider's own wording is kept but bounded: a gateway can answer a 401 with
    // a full HTML error page, and a frame that reaches the model must stay short. The
    // detail is already key-redacted by the caller (`redactProviderKey`).
    const quoted = detail.trim().length === 0 ? '' : ` The provider said: "${detail.trim().slice(0, 400)}"`;

    return (
        `${PROVIDER_REJECTED_CODE}: the provider answered ${url} with HTTP ${status} and refused the request, ` +
        `so re-sending the same bytes would be refused again — this turn failed after one attempt instead of ` +
        `waiting out the retry ladder.${refusalAdviceOf(status)}${quoted}`
    );
};

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
//      anything.
//
// This module holds the THREE bounds, their defaults, their environment variables,
// the message each one produces, and the classifier that tells the agent which
// retry policy a fetch failure deserves. It is a LEAF (only ../util) on purpose:
// `../server/config.ts` and `./openai.ts` both need the same facts and must not
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

import { HarnessError } from '../util';

// The ONE machine name for "the provider had the request and ran out of time". It
// follows the `HarnessError` code convention (../util/errors.ts): the code is also
// the FIRST TOKEN of the message, because `harness.ts` renders a thrown error as
// `Tool "…" failed: <message>` and only the message reaches the model, an event
// consumer and a log line. `agent()` keeps it out of the exponential ladder — a
// provider that missed a five-minute bound is not repaired by an instant re-send,
// and the user has already waited minutes.
export const PROVIDER_TIMEOUT_CODE = 'provider-timeout';

// The ONE machine name for "nothing answered the dial" (a refused connection, an
// unresolvable host, a connection reset before a single byte). This is a WRONG
// PORT / provider-not-up condition: `agent()` retries it a few times with
// single-digit-second waits and then fails terminally, instead of spending 17
// minutes of backoff on a deployment that is never going to answer.
export const PROVIDER_CONNECTION_CODE = 'provider-connection';

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

// The @underload/service adapter for the harness HTTP API.
//
// Service endpoint modules (`packages/underload/harness/src/server/endpoint/harness/
// service-route*.ts`) default-export `{ route, handler }`; the service loader
// calls `handler(context, parameters, variables)` for every method on that
// route. This module turns Hono's context into the transport-neutral request in
// src/server/api.ts and turns the dispatcher result back into what the loader
// understands:
//
//   - JSON result  → `{ status, response }` (loader applies `context.json`)
//   - SSE result   → `{ raw: Response }` (loader passes it through untouched)
//
// Why a raw Response for SSE: the Node adapter cancels a run when the response
// socket closes. A raw ReadableStream lets this adapter observe `cancel()` and
// abort the run, and it gives the frame writer explicit backpressure, instead of
// leaning on the loader's `streamSSE` helper which exposes no abort signal.
//
// THE PUBLISHED WRITER (issue 0006). The function that builds that Response is
// `createHarnessSseResponse` below, exported and re-exported by `./index.ts`, so a host
// streaming harness events from its OWN endpoint imports it instead of reading this file
// and re-deriving the frame contract, the preamble, the header set, the backpressure rule
// and the cancel->abort wiring. It is also the ONLY writer this package uses: the
// standalone Node adapter (`./handler.ts`, `runHarnessSseStream`) consumes the same
// function and pipes its body onto a `ServerResponse`.
//
// ACCESS CONTROL — read this before exposing the service beyond loopback.
// The service loader installs permissive CORS (`origin: '*'`, `allowHeaders:
// '*'`) on every app, so the standalone API's `X-Harness-Client` header is NOT a
// boundary here: any page can send it. Instead this endpoint rejects a browser
// request whose `Origin` is not one of the hosts it knows:
//
//   - no Origin (curl, server-to-server, same-origin GET)      → allowed
//   - Origin host === Host header (same origin)                → allowed
//   - Origin hostname is localhost/127.0.0.1/[::1]             → allowed (dev UI)
//   - https Origin on the github.io zone                       → allowed (the
//     deployed Pages UI — see ./frontend/deployment.ts — which has no API on its
//     own origin and must dial this gateway directly)
//   - anything else                                            → 403
//
// This keeps `yarn dev:frontend` (Vite on localhost) able to proxy `/api` to
// http://127.0.0.1:5000/v1/harness (or point `VITE_HARNESS_API` at it) while a
// public web page cannot read transcripts or drive tools. It does NOT add
// authentication: the service still listens on 0.0.0.0 by default, so anyone who
// can reach the port
// directly (not through a browser's CORS enforcement) is trusted — the same
// trust model as the standalone loopback server. Restrict the service's host to
// 127.0.0.1 in its start options if the port is reachable from untrusted
// networks.
//
// BODY BOUNDS — and their honest limit. The service loader's DEFAULT mode calls
// `context.req.json()` BEFORE this handler exists (see
// packages/underload/service/src/server/start.ts), so a large JSON body has
// already been buffered and parsed by the time we see it, and a parse failure has
// already been swallowed into `{}`. This endpoint module therefore declares
// `body: 'raw'`, which asks the loader to skip that pre-buffer; the body then arrives
// UNPARSED and `readBoundedBody` streams it through the ROUTE cap, rejecting an
// over-sized payload before the whole thing is in memory — the same streaming rule the
// Node adapter implements (`./handler.ts` `readJson`).
//
// When a host runs an OLDER loader that ignores `body: 'raw'`, `parameters.body` is still
// pre-parsed; the adapter detects that and falls back to the two checks it can do at this layer:
//   - reject a declared `content-length` over the ROUTE limit with 413 before any
//     dispatcher work;
//   - reject a parsed body whose serialized size exceeds the same limit with 413.
// The route limit comes from api.ts bodyLimitFor: the task submit route
// (POST /sessions/:id/tasks) is the only one that carries base64 attachments, so it alone
// gets the shared 16 MiB MAX_SUBMIT_BODY_BYTES and every other route keeps the 1 MB default. A malformed body stays the dispatcher's
// problem to reject (it requires an object body for action endpoints and a `parameters`
// property for tool calls), which is what keeps a swallowed parse failure from executing a tool.
//
// THE STREAM (T15). `GET /v1/harness/stream` is the WebSocket upgrade on the SAME host, port and
// root as the REST mount — no extra port, no second listener. The loader cannot answer an upgrade
// from a Hono handler (a `101` needs the raw socket), so the endpoint module also exports
// `upgrade`, and `createHarnessServiceUpgrade` below is what the loader calls with
// `(request, socket, head, variables)`. Both paths resolve the SAME root-keyed runtime, so the
// epoch in `welcome` and the epoch on `X-Harness-Epoch` are one value.
//
// PERSISTENCE (R3b): the loader calls `handler(context, parameters, variables)`.
// `variables.root` is the service's DATABASE_ROOT (packages/underload/service/
// server.ts passes it as `variables: { root: DATABASE_ROOT }`; the loader merges
// it ahead of the scan root). It selects the root-keyed runtime, which writes
// `<root>/harness/state.json`. No root means the in-memory runtime (direct tests).
// A present-but-invalid root or a corrupt/unknown-version database is a 500 with
// the real message — the root is never silently ignored and the store is never
// silently reset.
//
// Cross-references:
//   - ./runtime.ts — lazy root-keyed store/catalogue/API (env loaded on first hit)
//   - ./persistence.ts — the durable database file and DTO validation
//   - ./api.ts     — routes, body policy, bootstrap document
//   - ../../service/src/server/start.ts — endpoint contract and registration

import { bodyLimitFor, SERVICE_MOUNT } from './api';
import type { HarnessApi, HarnessApiEmit, HarnessApiStream } from './api';
import { isLoopbackHostname, isPagesOrigin } from '../shared/origin';
import type { HarnessRuntime } from './runtime';
import { getHarnessRuntime } from './runtime';
// T15: the update stream rides the same mount; this import is types + the route string only, so
// the HTTP adapter does not depend on the transport implementation.
import { HARNESS_WS_STREAM_PATH, rejectUpgrade } from './stream';
import type { HarnessStreamMount } from './stream';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
// T5: the server RUNTIME shape, so a service host can forward `threadExecution` explicitly
// instead of being limited to the HARNESS_* environment.
import type { ServerRuntimeConfiguration } from './config';
import { HarnessPersistenceError, normalizeHarnessDatabaseRoot } from './persistence';
// D4: opening a worker-mode IO client can fail at runtime CREATION (no built entry, no worker
// threads, a protocol mismatch). The adapter maps that to a 500 naming the reason, exactly like
// a corrupt database, rather than serving a store whose durability never left the loop.
import { HarnessIoError } from './workers';

// The subset of Hono's Context this adapter reads. Typed structurally so the
// harness package needs no compile-time dependency on hono or @underload/service.
export type ServiceEndpointContext = {
    req: {
        // Full request path, including the mount (`/v1/harness/sessions`).
        path: string;
        // Case-insensitive header lookup, as HonoRequest implements it.
        header: (name: string) => string | undefined;
        // The underlying Fetch API Request; `.signal` aborts when the client
        // disconnects on runtimes that propagate it, `.method` carries the HTTP verb
        // Hono does not re-expose on HonoRequest, and `.body` is the UNREAD request
        // stream the `body: 'raw'` mode bounds by itself (T15).
        raw?: { signal?: AbortSignal; method?: string; body?: ReadableStream<Uint8Array> | null };
    };
};

// The loader's pre-parsed parameters. `body` is `{}` when the request had no
// JSON/form body; it is already parsed, so the dispatcher needs no second read. In
// `body: 'raw'` mode the loader leaves `body` UNSET and this adapter reads the stream.
export type ServiceEndpointParameters = {
    path?: Record<string, string>;
    query?: Record<string, string>;
    body?: unknown;
};

// The loader accepts these shapes; `raw` bypasses JSON/SSE wrapping entirely. `headers` are applied
// by the loader to the JSON response it builds — the contract stamps the epoch (and a revision where
// one exists) on EVERY response, and only the adapter knows those values.
export type ServiceEndpointResult = {
    status: number;
    response?: unknown;
    raw?: globalThis.Response;
    headers?: Record<string, string>;
};

export type ServiceEndpointHandler = (
    context: ServiceEndpointContext,
    parameters: ServiceEndpointParameters,
    variables?: Record<string, unknown>
) => Promise<ServiceEndpointResult>;

// Same-host (including port) OR a loopback hostname OR this package's own GitHub
// Pages UI. The loopback list and the Pages rule are shared with the frontend's
// runtime API-root gate (./origin.ts), so "which origins count as local, and which
// count as the deployed static UI" has exactly one definition in the package.
//
// The Pages entry exists because the deployed bundle (`.github/workflows/ci.yml`
// publishes src/frontend/dist to `https://<user>.github.io/harness/`) has no API on
// its own origin and therefore dials a loopback or LAN gateway directly
// (../frontend/deployment.ts). Without it the static deployment could only ever
// reach the service as a 403: the Origin is neither the gateway's host nor
// loopback. HTTPS is required — Pages serves the UI over https only, so an
// `http://…github.io` Origin is a redirect artifact or a spoofed header.
//
// This widens the browser-facing gate to ONE known zone, not to the world: the
// trust model is unchanged for every other public Origin (still 403), and the
// service's CORS is already `origin: '*'`, so this gate never claimed to stop a
// non-browser client — it stops an arbitrary web page from reading transcripts.
// A Pages page is a page the operator deployed, which is the same trust the
// loopback dev UI already gets.
const isAllowedOrigin = (origin: string, host: string | undefined): boolean => {
    let parsed: URL;

    try {
        parsed = new URL(origin);
    } catch {
        // `Origin: null` (sandboxed iframe, file://) is not a verifiable origin.
        return false;
    }

    if (host !== undefined && parsed.host.toLowerCase() === host.toLowerCase()) return true;

    if (isLoopbackHostname(parsed.hostname)) return true;

    return isPagesOrigin(origin);
};

// THE PACKAGE'S ONE SSE WRITER, published from `@underload/harness/server` (issue 0006).
// Both in-package adapters consume it — this mount returns it as `{ raw: Response }`, the
// Node adapter pipes its body onto a `ServerResponse` — so a host writing an SSE endpoint
// of its own has something to import instead of a third copy of the same rules.
//
// THE CONTRACT, exactly (pinned by src/server/sse-writer.test.ts):
//   - `200` with `text/event-stream; charset=utf-8`, `no-cache, no-transform`,
//     `keep-alive`, and `X-Accel-Buffering: no` so a proxy never buffers a frame;
//   - one leading comment frame `: connected\n\n`, then `data: <json>\n\n` per item — the
//     encoding the shipped UI parser already reads, so a UI pointed at a host endpoint
//     needs no changes;
//   - BACKPRESSURE: while the stream's queue is full (`desiredSize <= 0`) a frame waits
//     for the consumer's next `pull`, so a slow client paces the run rather than buffering
//     a whole transcript into memory;
//   - CANCEL -> ABORT: `cancel()` (tab closed, fetch aborted) and the optional `signal`
//     (a request signal, on runtimes that propagate one) both abort the signal handed to
//     `start`. That wiring is the whole point of the helper: it is the only way a browser
//     disconnect reaches a run, and the loader's `{ stream }` passthrough cannot express it.
//     WHAT the abort means stays the dispatcher's per-route decision (R4: POST /messages
//     cancels the run, GET /sessions/:id/events only unsubscribes) — this writer only
//     reports that the consumer is gone.
//
// `start(emit, signal)` is the dispatcher's own stream arm (`HarnessApiStream`). A throw
// from it is swallowed on purpose: the dispatcher already converts a failed run into a
// `failed` frame, and anything that reaches here means the writer is gone.
export const createHarnessSseResponse = (start: HarnessApiStream, signal?: AbortSignal): Response => {
    const encoder = new TextEncoder();
    const abortController = new AbortController();

    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let resolveRoom: (() => void) | undefined;
    let closed = false;

    const release = (): void => {
        const resolve = resolveRoom;
        resolveRoom = undefined;
        resolve?.();
    };

    const stop = (): void => {
        closed = true;
        abortController.abort();
        release();
    };

    // Forward the underlying request abort (when the runtime provides one) to
    // the same controller the stream's cancel() uses.
    const onRequestAbort = (): void => stop();
    signal?.addEventListener('abort', onRequestAbort, { once: true });
    if (signal?.aborted === true) stop();

    const write: HarnessApiEmit = async (item): Promise<void> => {
        // An aborted or cancelled stream has nowhere to write; dropping the frame
        // is correct because the abort listener has already cancelled the run.
        if (closed || abortController.signal.aborted) return;

        // Backpressure: wait until the consumer has drained the previous chunk.
        // `desiredSize` is null once the stream is closing, which is also a stop.
        while (!closed && (streamController?.desiredSize ?? 0) <= 0) {
            await new Promise<void>((resolve) => {
                resolveRoom = resolve;
            });
        }

        if (closed || abortController.signal.aborted) return;

        try {
            streamController?.enqueue(encoder.encode(`data: ${JSON.stringify(item)}\n\n`));
        } catch {
            // The consumer closed between the check and the enqueue.
            stop();
        }
    };

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            streamController = controller;

            // Same leading comment frame as the standalone server.
            controller.enqueue(encoder.encode(': connected\n\n'));

            void (async () => {
                try {
                    await start(write, abortController.signal);
                } catch {
                    // The dispatcher already converts run failures into a
                    // `failed` frame. Anything reaching here means the writer is
                    // gone, so there is nobody left to notify.
                } finally {
                    closed = true;
                    release();
                    signal?.removeEventListener('abort', onRequestAbort);

                    try {
                        controller.close();
                    } catch {
                        // Already errored/cancelled by the consumer.
                    }
                }
            })();
        },
        pull() {
            // Demand from the consumer: release a writer waiting on backpressure.
            release();
        },
        cancel() {
            // Browser closed the tab / fetch aborted. R4: the dispatcher decides
            // what this means per route — POST /messages cancels the run (legacy),
            // GET /sessions/:id/events only unsubscribes; the pump keeps working.
            stop();
            signal?.removeEventListener('abort', onRequestAbort);
        }
    });

    return new Response(stream, {
        status: 200,
        headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            // Mirrors the Node adapter: no proxy buffering between frames.
            'X-Accel-Buffering': 'no'
        }
    });
};

export type HarnessServiceHandlerOptions = {
    // Inject a runtime (tests). Defaults to the root-keyed lazy singleton, so
    // every discovered route module shares one store for the same database root.
    runtime?: HarnessRuntime;
    // Override the database root for tests/embedders. When omitted, the loader's
    // `variables.root` (DATABASE_ROOT) selects it; no root means in-memory.
    root?: string;
    // T5 (R1/R3): an explicit SERVER RUNTIME for the runtime this service creates -
    // `threadExecution: 'worker'` and the worker bounds. Merged over the HARNESS_*
    // environment by ./config.ts resolveRuntimeConfiguration, and ignored (with a thrown
    // ServerRuntimeError for a bad value) rather than approximated. Only consulted when no
    // `runtime` is injected: an injected store already carries its own execution model.
    execution?: Partial<ServerRuntimeConfiguration>;
};

// Read the service loader's storage boundary. `variables.root` is the explicit
// DATABASE_ROOT (the loader merges it ahead of the scan root, see
// packages/underload/service/src/server/start.ts); when the caller supplied
// nothing there is no root and the runtime stays in-memory. A present-but-invalid
// value throws instead of silently ignoring the operator's supplied root.
const rootFromVariables = (variables: Record<string, unknown> | undefined): string | undefined => {
    if (variables === undefined || !Object.prototype.hasOwnProperty.call(variables, 'root')) {
        return undefined;
    }

    return normalizeHarnessDatabaseRoot(variables.root as string | null | undefined);
};

// Same sentence the Node adapter uses for a streamed body, so both mounts answer
// an over-sized request identically (the number is the ROUTE limit).
const bodyTooLargeMessage = (limit: number): string =>
    `A request body cannot exceed ${limit} bytes.`;

// Serialized size of the already-parsed body. JSON.parse output always
// serializes; a multipart File value does not, and returns undefined so the
// dispatcher's object check decides instead of a bogus 413. `TextEncoder` is used
// instead of `Buffer` because the file already encodes SSE frames with it.
const bodyEncoder = new TextEncoder();

const serializedBodyBytes = (body: unknown): number | undefined => {
    try {
        const text = JSON.stringify(body);
        return text === undefined ? undefined : bodyEncoder.encode(text).byteLength;
    } catch {
        return undefined;
    }
};

// Bounds the request twice: the declared length (a client that tells the truth is
// rejected before the body is inspected) and the serialized parsed body (the
// loader may have accepted a chunked or lying request). `limit` is the ROUTE cap
// from bodyLimitFor. Only the FALLBACK path needs this: in `body: 'raw'` mode the
// streaming reader below enforces the cap as bytes arrive.
const exceedsBodyLimit = (
    context: ServiceEndpointContext,
    body: unknown,
    limit: number
): boolean => {
    const declared = Number.parseInt(context.req.header('content-length') ?? '', 10);

    if (Number.isFinite(declared) && declared > limit) return true;

    const serialized = serializedBodyBytes(body);

    return serialized !== undefined && serialized > limit;
};

type BoundedBody = { body: unknown; error?: undefined } | { body?: undefined; error: { status: number; message: string } };

// T15: stream the request body through the ROUTE cap instead of trusting a pre-parsed object. This
// is the fix for the loader's pre-buffer: with `body: 'raw'` declared on the endpoint module, the
// first byte of a 200 MB submit is read only as far as the cap allows, and the request is rejected
// at the cap rather than after the whole payload has been allocated and JSON-parsed.
//
// A request with no body (every GET, and a DELETE) has a null/absent stream and yields `{}` — the
// same value the legacy pre-parse produced, so the dispatcher's "object body" rules are unchanged.
const readBoundedBody = async (context: ServiceEndpointContext, limit: number): Promise<BoundedBody> => {
    const stream = context.req.raw?.body;

    if (stream === undefined || stream === null) return { body: {} };

    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;

        size += value.byteLength;

        if (size > limit) {
            // Stop the transfer rather than drain a body nobody will read.
            await reader.cancel().catch(() => undefined);
            return { error: { status: 413, message: bodyTooLargeMessage(limit) } };
        }

        chunks.push(value);
    }

    if (chunks.length === 0) return { body: {} };

    try {
        return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown };
    } catch {
        // The legacy path swallowed this into `{}`; an explicit 400 is strictly more honest and is
        // what the Node adapter already answers for the same input.
        return { error: { status: 400, message: 'The request body must be valid JSON.' } };
    }
};

// Resolve the root-keyed runtime once, so the HTTP handler and the stream upgrade below can never
// land on different stores (and therefore different epochs) for the same DATABASE_ROOT.
const resolveRuntime = (
    options: HarnessServiceHandlerOptions,
    variables: Record<string, unknown> | undefined
): HarnessRuntime => {
    const root =
        options.root === undefined ? rootFromVariables(variables) : normalizeHarnessDatabaseRoot(options.root);

    // T5 (R1/R3): `execution` forwards a host-configured server RUNTIME (notably
    // `threadExecution`) into the root-keyed runtime, which resolves it over
    // HARNESS_THREAD_EXECUTION / HARNESS_WORKER_* and hands it to the SessionStore.
    return (
        options.runtime ??
        getHarnessRuntime({
            root,
            ...(options.execution === undefined ? {} : { runtime: options.execution })
        })
    );
};

/** The loader's upgrade hook: `(request, socket, head, variables)` on the stream route. */
export type ServiceUpgradeHandler = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    variables?: Record<string, unknown>
) => boolean;

/**
 * T15: the WebSocket handshake entry point for the gateway-mounted stream.
 *
 * A `101` cannot come out of a Hono handler, so the loader calls this with the raw socket. It
 * returns true when the harness mount owned the request (accepted, or refused with a status) and
 * false when the path is not the stream route, so a gateway hosting several upgrading endpoints can
 * try the next one. Runtime creation failures answer 503 — the status the contract already declares
 * for this operation — instead of destroying the socket silently.
 */
export const createHarnessServiceUpgrade = (options: HarnessServiceHandlerOptions = {}): ServiceUpgradeHandler => {
    return (request, socket, head, variables) => {
        let mount: HarnessStreamMount;

        try {
            mount = resolveRuntime(options, variables).stream;
        } catch (error) {
            rejectUpgrade(socket, 503, error instanceof Error ? error.message : String(error));
            return true;
        }

        return mount.upgrade(request, socket, head);
    };
};

export const createHarnessServiceHandler = (
    options: HarnessServiceHandlerOptions = {}
): ServiceEndpointHandler => {
    return async (context, parameters, variables) => {
        // Access boundary, before any runtime work (and before touching env).
        const origin = context.req.header('origin');
        if (origin !== undefined && origin.length > 0) {
            const host = context.req.header('host');
            if (!isAllowedOrigin(origin, host)) {
                return {
                    status: 403,
                    response: { error: { message: 'Cross-origin requests are not allowed.' } }
                };
            }
        }

        const pathname = context.req.path;

        // T15: the upgrade is answered on the raw socket by `createHarnessServiceUpgrade`, so a
        // request that reaches the JSON pipeline on this path never sent an upgrade header. The
        // contract declares 101 for the handshake, so 400 is the honest answer here (and it beats a
        // 404 from a dispatcher that has no route for the stream).
        if (pathname === HARNESS_WS_STREAM_PATH) {
            return {
                status: 400,
                response: {
                    error: {
                        message: `GET ${HARNESS_WS_STREAM_PATH} is a WebSocket upgrade: send Upgrade: websocket and Connection: Upgrade.`
                    }
                }
            };
        }

        // `undefined` is "no body"; an explicit JSON `null` is passed through so
        // the dispatcher can reject it as a non-object instead of treating it as
        // an empty body (`?? {}` used to hide that difference).
        const body = parameters?.body === undefined ? {} : parameters.body;
        // Route-aware cap (T3): submit routes carry base64 media and get 16 MiB;
        // every other route keeps 1 MB. Resolved with the SAME helper the Node
        // adapter uses, before any runtime work.
        const method = context.req.raw?.method ?? 'GET';
        const limit = bodyLimitFor(method, pathname, SERVICE_MOUNT);

        // The loader skipped its pre-parse for this endpoint (T15): read the stream under the cap.
        // `parameters.body === undefined` is the signal — a loader that pre-parses always sets it
        // (to `{}` at worst), so the two modes are distinguishable without a capability handshake.
        const streamingBody = parameters?.body === undefined;

        if (!streamingBody && exceedsBodyLimit(context, body, limit)) {
            return { status: 413, response: { error: { message: bodyTooLargeMessage(limit) } } };
        }

        // A declared length over the cap is rejected before a single byte is read, in BOTH modes:
        // it costs nothing and stops an honest client's oversized submit at the door.
        const declared = Number.parseInt(context.req.header('content-length') ?? '', 10);

        if (Number.isFinite(declared) && declared > limit) {
            return { status: 413, response: { error: { message: bodyTooLargeMessage(limit) } } };
        }

        // R3b: the loader's third argument is the storage boundary. The runtime is
        // selected PER ROOT, so a request for a different DATABASE_ROOT can never
        // reuse (or overwrite) another root's singleton. A load/validation failure
        // is surfaced as a 500 with the real message instead of a silent empty store.
        let runtime: HarnessRuntime;

        try {
            runtime = resolveRuntime(options, variables);
        } catch (error) {
            // D4: `HarnessIoError` joins the persistence mapping because a worker-mode store
            // that cannot OPEN its IO client (no built entry, no `node:worker_threads`, a
            // protocol mismatch - ./workers/io-client.ts contract 8) fails here, at runtime
            // creation. Both are surfaced with their real reason instead of being swallowed into
            // an inline store that claims otherwise.
            if (error instanceof HarnessPersistenceError || error instanceof HarnessIoError) {
                return { status: 500, response: { error: { message: error.message } } };
            }

            throw error;
        }

        // D4: a worker-mode store has to have answered its IO handshake BEFORE it answers a
        // request (`./workers/io-client.ts`, integration contract). `ioReady()` is `undefined`
        // for an inline or in-memory store, and the memoized handshake promise otherwise, so
        // after the first resolution this costs one microtask.
        //
        // A rejection is a deployment failure, not a retry: the thread is already terminated and
        // every operation issued before the handshake failed with the same reason. Reporting 500
        // with that message is the honest answer - the alternative would be serving from a store
        // whose durability was quietly never off-loop.
        const readiness = runtime.store.ioReady();

        if (readiness !== undefined) {
            try {
                await readiness;
            } catch (error) {
                return {
                    status: 500,
                    response: { error: { message: error instanceof Error ? error.message : String(error) } }
                };
            }
        }

        // T15: in raw mode the body has NOT been read yet; bound it here, after the runtime exists
        // (a 413 must not require a store, but reading a stream needs no store either — the order
        // only matters because a rejected runtime creation should answer before any body work).
        let parsedBody: unknown = body;

        if (streamingBody) {
            const read = await readBoundedBody(context, limit);

            if (read.error !== undefined) {
                return { status: read.error.status, response: { error: { message: read.error.message } } };
            }

            parsedBody = read.body;
        }

        const result = await runtime.api({
            method: context.req.raw?.method ?? 'GET',
            pathname,
            mount: SERVICE_MOUNT,
            // T18: the loader hands the query over pre-split; forwarding it is what makes
            // `?limit=&cursor=&q=` mean anything on this mount. Without it a gateway client silently
            // gets the default page while believing it asked for a size of its own.
            ...(parameters?.query === undefined ? {} : { searchParams: parameters.query }),
            // Raw mode: the bounded stream read above. Legacy mode: the loader's pre-parsed body,
            // handed over unchanged.
            readBody: async <T>() => parsedBody as T,
            // GET /v1/harness is the canonical bootstrap document.
            bootstrapRoot: true,
            // T15 integration point, forwarded through a SPREAD so this compiles before the REST
            // owner adds the option: the dispatcher publishes through THIS broker, which is what
            // makes a REST write's revision and the frame it causes share one epoch.
            ...(runtime.stream === undefined ? {} : { stream: runtime.stream })
        } as Parameters<HarnessApi>[0]);

        if (result.kind === 'json') {
            return {
                status: result.status,
                response: result.body,
                ...(result.headers === undefined ? {} : { headers: result.headers })
            };
        }

        return { status: 200, raw: createHarnessSseResponse(result.start, context.req.raw?.signal) };
    };
};

// Service endpoint modules need both the wildcard route (everything below the
// mount) and the bare route (the bootstrap document). Exported so the two files
// cannot drift in the URL they claim.
export const SERVICE_WILDCARD_ROUTE = `${SERVICE_MOUNT}/*`;
export const SERVICE_ROOT_ROUTE = SERVICE_MOUNT;

// T15: the stream route, declared by its own endpoint module so the loader can attach an upgrade
// handler to an EXACT path instead of pattern-matching a wildcard. Same mount, same host, same port.
export const SERVICE_STREAM_ROUTE = `${SERVICE_MOUNT}/stream`;

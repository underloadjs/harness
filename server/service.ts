// The @underload/service adapter for the harness HTTP API.
//
// Service endpoint modules (`packages/underload/harness/endpoint/harness/
// service-route*.ts`) default-export `{ route, handler }`; the service loader
// calls `handler(context, parameters, variables)` for every method on that
// route. This module turns Hono's context into the transport-neutral request in
// server/api.ts and turns the dispatcher result back into what the loader
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
// ACCESS CONTROL — read this before exposing the service beyond loopback.
// The service loader installs permissive CORS (`origin: '*'`, `allowHeaders:
// '*'`) on every app, so the standalone API's `X-Harness-Client` header is NOT a
// boundary here: any page can send it. Instead this endpoint rejects a browser
// request whose `Origin` is neither the same host as the service nor a loopback
// origin:
//
//   - no Origin (curl, server-to-server, same-origin GET)      → allowed
//   - Origin host === Host header (same origin)                → allowed
//   - Origin hostname is localhost/127.0.0.1/[::1]             → allowed (dev UI)
//   - anything else                                            → 403
//
// This keeps `yarn dev:playground` (Vite on localhost) able to point its
// `VITE_HARNESS_API` at http://127.0.0.1:5000/v1/harness while a public web page
// cannot read transcripts or drive tools. It does NOT add authentication: the
// service still listens on 0.0.0.0 by default, so anyone who can reach the port
// directly (not through a browser's CORS enforcement) is trusted — the same
// trust model as the standalone loopback server. Restrict the service's host to
// 127.0.0.1 in its start options if the port is reachable from untrusted
// networks.
//
// BODY BOUNDS — and their honest limit. The service loader calls
// `context.req.json()` BEFORE this handler exists (see
// packages/underload/service/src/server/start.ts), so a large JSON body has
// already been buffered and parsed by the time we see it, and a parse failure has
// already been swallowed into `{}`. This adapter can only:
//   - reject a declared `content-length` over MAX_API_BODY_BYTES with 413 before
//     any dispatcher work;
//   - reject a parsed body whose serialized size exceeds the same cap with 413.
// It cannot prevent the loader's upstream allocation, and it cannot tell a
// malformed body from a literal `{}`. The dispatcher therefore requires an
// object body for action endpoints and a `parameters` property for tool calls,
// which is what keeps a swallowed parse failure from executing a tool. Fixing the
// allocation itself belongs in the service loader, not here.
//
// Cross-references:
//   - ./runtime.ts — lazy shared store/catalogue/API (env loaded on first hit)
//   - ./api.ts     — routes, body policy, bootstrap document
//   - ../../service/src/server/start.ts — endpoint contract and registration

import { MAX_API_BODY_BYTES, SERVICE_MOUNT } from './api';
import type { HarnessApiEmit, HarnessApiStream } from './api';
import type { HarnessRuntime } from './runtime';
import { getHarnessRuntime } from './runtime';

// The subset of Hono's Context this adapter reads. Typed structurally so the
// harness package needs no compile-time dependency on hono or @underload/service.
export type ServiceEndpointContext = {
    req: {
        // Full request path, including the mount (`/v1/harness/sessions`).
        path: string;
        // Case-insensitive header lookup, as HonoRequest implements it.
        header: (name: string) => string | undefined;
        // The underlying Fetch API Request; `.signal` aborts when the client
        // disconnects on runtimes that propagate it, and `.method` carries the
        // HTTP verb Hono does not re-expose on HonoRequest.
        raw?: { signal?: AbortSignal; method?: string };
    };
};

// The loader's pre-parsed parameters. `body` is `{}` when the request had no
// JSON/form body; it is already parsed, so the dispatcher needs no second read.
export type ServiceEndpointParameters = {
    path?: Record<string, string>;
    query?: Record<string, string>;
    body?: unknown;
};

// The loader accepts these shapes; `raw` bypasses JSON/SSE wrapping entirely.
export type ServiceEndpointResult = {
    status: number;
    response?: unknown;
    raw?: globalThis.Response;
};

export type ServiceEndpointHandler = (
    context: ServiceEndpointContext,
    parameters: ServiceEndpointParameters,
    variables?: Record<string, unknown>
) => Promise<ServiceEndpointResult>;

// Only these hostnames may use a cross-origin browser request. `URL.hostname`
// keeps IPv6 brackets, hence '[::1]'; the bare form is accepted defensively.
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const isAllowedOrigin = (origin: string, host: string | undefined): boolean => {
    let parsed: URL;

    try {
        parsed = new URL(origin);
    } catch {
        // `Origin: null` (sandboxed iframe, file://) is not a verifiable origin.
        return false;
    }

    if (host !== undefined && parsed.host.toLowerCase() === host.toLowerCase()) return true;

    return LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase());
};

// Build the canonical SSE response. Frames use the same `data: <json>\n\n`
// encoding as the standalone server, so the existing UI parser works unchanged.
const createSseResponse = (start: HarnessApiStream, requestSignal: AbortSignal | undefined): Response => {
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
    requestSignal?.addEventListener('abort', onRequestAbort, { once: true });
    if (requestSignal?.aborted === true) stop();

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
                    requestSignal?.removeEventListener('abort', onRequestAbort);

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
            // Browser closed the tab / fetch aborted: cancel the harness run.
            stop();
            requestSignal?.removeEventListener('abort', onRequestAbort);
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
    // Inject a runtime (tests). Defaults to the lazy module singleton, so every
    // discovered route module shares one store across the whole service.
    runtime?: HarnessRuntime;
};

// Same sentence the Node adapter uses for a streamed body, so both mounts answer
// an over-sized request identically.
const BODY_TOO_LARGE_MESSAGE = `A request body cannot exceed ${MAX_API_BODY_BYTES} bytes.`;

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
// loader may have accepted a chunked or lying request). See the file header for
// what this cannot do.
const exceedsBodyLimit = (context: ServiceEndpointContext, body: unknown): boolean => {
    const declared = Number.parseInt(context.req.header('content-length') ?? '', 10);

    if (Number.isFinite(declared) && declared > MAX_API_BODY_BYTES) return true;

    const serialized = serializedBodyBytes(body);

    return serialized !== undefined && serialized > MAX_API_BODY_BYTES;
};

export const createHarnessServiceHandler = (
    options: HarnessServiceHandlerOptions = {}
): ServiceEndpointHandler => {
    return async (context, parameters) => {
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
        // `undefined` is "no body"; an explicit JSON `null` is passed through so
        // the dispatcher can reject it as a non-object instead of treating it as
        // an empty body (`?? {}` used to hide that difference).
        const body = parameters?.body === undefined ? {} : parameters.body;

        // Before the runtime is created: a rejected body must not trigger the
        // lazy `.env` load, catalogue build, or any session work.
        if (exceedsBodyLimit(context, body)) {
            return { status: 413, response: { error: { message: BODY_TOO_LARGE_MESSAGE } } };
        }

        const runtime = options.runtime ?? getHarnessRuntime();

        const result = await runtime.api({
            method: context.req.raw?.method ?? 'GET',
            pathname,
            mount: SERVICE_MOUNT,
            // The service loader already parsed the body; hand it over unchanged.
            readBody: async <T>() => body as T,
            // GET /v1/harness is the canonical bootstrap document.
            bootstrapRoot: true
        });

        if (result.kind === 'json') {
            return { status: result.status, response: result.body };
        }

        return { status: 200, raw: createSseResponse(result.start, context.req.raw?.signal) };
    };
};

// Service endpoint modules need both the wildcard route (everything below the
// mount) and the bare route (the bootstrap document). Exported so the two files
// cannot drift in the URL they claim.
export const SERVICE_WILDCARD_ROUTE = `${SERVICE_MOUNT}/*`;
export const SERVICE_ROOT_ROUTE = SERVICE_MOUNT;

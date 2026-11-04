// The Node adapter for the harness HTTP API.
//
// `createHarnessHandler` is transport-neutral at the domain level: routing and
// validation live in `src/server/api.ts`, and this file only translates Node's
// IncomingMessage/ServerResponse into that dispatcher and back. The standalone
// server (`src/server/start.ts`) and the Vite dev middleware share this adapter.
//
// ACCESS CONTROL (T15): the legacy `X-Harness-Client: ui` header gate is GONE. It existed to stop a
// cross-origin page from reading transcripts once `/api` was reachable without a preflight, and the
// target contract replaces it with the Origin policy the service adapter applies
// (`./service.ts`, `../shared/origin.ts`) — a policy rule, not authentication, and the same rule the
// stream handshake uses (`./stream/mount.ts`). A header gate could not exist on a WebSocket
// handshake anyway, so keeping it on REST only would have split one boundary in two.
//
// Cross-references:
//   - ./api.ts      — routes, validation, bootstrap document, error mapping
//   - ./service.ts  — the other adapter (`/v1/harness` on @underload/service)
//   - ./start.ts    — starts a real node:http server around this handler AND the stream upgrade
//   - ./stream/     — the update stream mounted at `${mount}/stream`

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HarnessRegistry, ToolCatalogue } from './harnesses';
import type { SessionStreamItem, SessionViewStreamItem } from './protocol';
import type { HarnessIndex } from './protocol';
// T28: the credential-bearing settings type (`createHarnessApi({ settings })`).
import type { RunnerSettings } from './harnesses/types';
// T28: the resolved runtime block type (`createHarnessApi({ runtime })`).
import type { ServerRuntimeConfiguration } from './config';
import { SessionStore } from './sessions';
import {
    bodyLimitFor,
    createHarnessApi,
    HttpError,
    MAX_API_BODY_BYTES,
    STANDALONE_MOUNT
} from './api';
import type { HarnessApiEmit, HarnessApiResult } from './api';
import type { HarnessStreamMount } from './stream';
import type { HarnessEventHub } from './api-events';

export type HarnessHandlerOptions = {
    store: SessionStore;
    // `defaults` comes from the environment; the store only needs the secret
    // settings it actually builds harnesses with.
    defaults: HarnessIndex['defaults'];
    // T28: the private, credential-bearing provider settings, forwarded to the dispatcher so a
    // provider call it makes itself (`POST /models`) authenticates with the REAL key instead of
    // the key-free `defaults` document. Never serialized on the wire.
    settings?: RunnerSettings;
    // The same registry the store resolves sessions through. Required: a handler
    // with its own default registry could create a harness that its store cannot
    // see, which would make POST /harnesses succeed and the session 404.
    registry: HarnessRegistry;
    // Built by the host AFTER it loads `.env` (see src/server/start.ts), so a search
    // key in the environment is captured here and not at import time. Omitting it
    // builds a catalogue now, which is still runtime — never module evaluation.
    catalogue?: ToolCatalogue;
    // T15: the stream mount this listener serves. It exists so the mount PATH and the honest
    // non-upgrade answer for `${mount}/stream` come from one place, and so the broker can be handed
    // to the dispatcher (see below) without the REST owner importing the stream module.
    stream?: HarnessStreamMount;
    // T28: the RESOLVED deployment runtime block, forwarded to the dispatcher so `/config`
    // reports exactly what the store enforces. Omitting it leaves api.ts's documented fallback
    // (a fresh `loadRuntimeConfiguration()`), which is a second environment parse and can
    // disagree with a host that passed explicit `options.runtime` overrides.
    runtime?: ServerRuntimeConfiguration;
    // T13's epoch/revision hub. Forwarded to the dispatcher, whose `api.epoch` is the value the
    // stream's `welcome` carries — one process, one epoch, two transports.
    events?: HarnessEventHub;
};

export type HarnessHandler = (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// The contract requires the epoch (and, where one exists, the revision) on EVERY response, and the
// dispatcher states those values on the result's `headers` map — the adapter is the only thing that
// can put them on the wire, because the dispatcher never sees a response object.
const sendJson = (response: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void => {
    if (response.headersSent) {
        response.end();
        return;
    }

    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');

    for (const [name, value] of Object.entries(headers ?? {})) response.setHeader(name, value);

    response.end(JSON.stringify(body));
};

// Read a JSON body while STREAMING, so an over-sized request is rejected before
// the whole payload is buffered. `limitBytes` comes from api.ts bodyLimitFor: the
// submit routes carry base64 media and get 16 MiB, every other route keeps the
// 1 MB legacy cap. The same helper feeds service.ts, so the two mounts agree.
const readJson = <T>(request: IncomingMessage, limitBytes = MAX_API_BODY_BYTES): Promise<T> =>
    new Promise<T>((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        let settled = false;

        request.on('data', (chunk: Buffer) => {
            if (settled) return;

            size += chunk.length;
            if (size > limitBytes) {
                settled = true;
                reject(new HttpError(413, `A request body cannot exceed ${limitBytes} bytes.`));
                return;
            }

            chunks.push(chunk);
        });

        request.on('end', () => {
            if (settled) return;
            settled = true;

            if (chunks.length === 0) {
                resolve({} as T);
                return;
            }

            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
            } catch {
                reject(new HttpError(400, 'The request body must be valid JSON.'));
            }
        });

        request.on('error', (error) => {
            if (settled) return;
            settled = true;
            reject(error);
        });
    });

// Write one SSE frame and honour backpressure. The harness awaits progress, so a
// slow client naturally paces the run instead of buffering the transcript.
const createSseWriter = (response: ServerResponse): HarnessApiEmit => {
    return async (item: SessionStreamItem | SessionViewStreamItem): Promise<void> => {
        if (response.writableEnded || response.destroyed) return;

        if (response.write(`data: ${JSON.stringify(item)}\n\n`)) return;

        await new Promise<void>((resolve) => {
            const done = (): void => {
                response.off('drain', done);
                response.off('close', done);
                resolve();
            };

            response.once('drain', done);
            response.once('close', done);
        });
    };
};

// Open the SSE response, run the dispatcher's stream, and cancel the run when
// the client goes away. HTTP headers are sent only after the dispatcher has
// validated the request, so busy/unknown sessions still answer with JSON.
const runStream = async (
    result: Extract<HarnessApiResult, { kind: 'stream' }>,
    request: IncomingMessage,
    response: ServerResponse
): Promise<void> => {
    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();

    response.write(': connected\n\n');

    // One abort source for both directions: a disconnected socket cancels the
    // run, and a completed run leaves a harmless abort after the response ends.
    //
    // R4: this signal means different things per route and the dispatcher decides.
    // POST /messages treats it as "abort the run" (legacy); GET /sessions/:id/events
    // treats it as "unsubscribe only" — a queued task keeps running server-side, so
    // the watch handler must simply return (see api.ts watchSessionRoute).
    const controller = new AbortController();
    const abort = (): void => controller.abort();

    response.on('close', abort);
    request.on('error', abort);

    try {
        await result.start(createSseWriter(response), controller.signal);
    } finally {
        response.off('close', abort);
        request.off('error', abort);

        if (!response.writableEnded) response.end();
    }
};

export const createHarnessHandler = ({
    store,
    defaults,
    settings,
    runtime,
    registry,
    catalogue,
    stream,
    events
}: HarnessHandlerOptions): HarnessHandler => {
    // One dispatcher per handler: the catalogue snapshot (and therefore any
    // credential tool) is fixed for the handler's lifetime, exactly like before.
    //
    // T15 integration point: `stream` and `events` are forwarded through a SPREAD, so the call
    // compiles against whichever revision of `HarnessApiOptions` is current (the REST owner added
    // `events`; `stream` is forwarded for the frame fan-out) without this adapter ever importing the
    // store's internals.
    const api = createHarnessApi({
        store,
        defaults,
        // T28: forward the private credential channel unchanged (absent stays absent, so a
        // key-less host keeps declaring whatever `defaults` says).
        ...(settings === undefined ? {} : { settings }),
        // T28: forward the RESOLVED runtime so the reported block and the enforced one are the
        // same object (see the option comment above).
        ...(runtime === undefined ? {} : { runtime }),
        registry,
        ...(catalogue === undefined ? {} : { catalogue }),
        ...(stream === undefined ? {} : { stream }),
        ...(events === undefined ? {} : { events })
    } as Parameters<typeof createHarnessApi>[0]);

    // The upgrade lives on the `upgrade` event (`./start.ts` attaches it), so a plain HTTP request
    // for this path is a client that forgot the handshake. Answering honestly here is also what
    // keeps a `GET /v1/harness/stream` from 404ing into an unrelated static fallback.
    const streamPath = `${STANDALONE_MOUNT}/stream`;

    return async (request, response): Promise<boolean> => {
        const rawUrl = request.url ?? '/';
        const url = new URL(rawUrl, 'http://localhost');

        // The static handler owns everything outside the API mount.
        if (!url.pathname.startsWith(STANDALONE_MOUNT)) return false;

        try {
            if (url.pathname === streamPath) {
                throw new HttpError(
                    400,
                    `GET ${streamPath} is a WebSocket upgrade: send Upgrade: websocket and Connection: Upgrade.`
                );
            }

            const result = await api({
                method: request.method ?? 'GET',
                pathname: url.pathname,
                mount: STANDALONE_MOUNT,
                // T18: the query string MUST reach the dispatcher, or every paging and filter
                // parameter (`limit`, `cursor`, `q`, `since`) is silently dropped and a bounded page
                // degrades to the default while the client believes it asked for another size.
                searchParams: url.searchParams,
                // Route-aware cap resolved BEFORE reading: only POST submit routes
                // may stream a base64 body up to MAX_SUBMIT_BODY_BYTES.
                readBody: () =>
                    readJson(
                        request,
                        bodyLimitFor(request.method ?? 'GET', url.pathname, STANDALONE_MOUNT)
                    )
            });

            if (result.kind === 'json') {
                sendJson(response, result.status, result.body, result.headers);
                return true;
            }

            await runStream(result, request, response);
            return true;
        } catch (error) {
            if (response.headersSent) {
                // Headers mean an SSE stream is open; the only honest action left
                // is to drop the connection.
                response.destroy();
                return true;
            }

            const status = error instanceof HttpError ? error.status : 500;
            sendJson(response, status, { error: { message: messageOf(error) } });
            return true;
        }
    };
};

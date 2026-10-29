// The Node adapter for the harness HTTP API.
//
// `createHarnessHandler` is transport-neutral at the domain level: routing and
// validation live in `src/server/api.ts`, and this file only translates Node's
// IncomingMessage/ServerResponse into that dispatcher and back. The standalone
// server (`src/server/start.ts`) and the Vite dev middleware share this adapter, so
// `/api` keeps its exact legacy behaviour (client header, SSE writer, statuses).
//
// Cross-references:
//   - ./api.ts      — routes, validation, bootstrap document, error mapping
//   - ./service.ts  — the other adapter (`/v1/harness` on @underload/service)
//   - ./index.ts    — starts a real node:http server around this handler

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HarnessRegistry, ToolCatalogue } from './harnesses';
import type { SessionStreamItem } from './protocol';
import type { HarnessIndex } from './protocol';
import { SessionStore } from './sessions';
import {
    bodyLimitFor,
    createHarnessApi,
    HttpError,
    MAX_API_BODY_BYTES,
    STANDALONE_MOUNT
} from './api';
import type { HarnessApiEmit, HarnessApiResult } from './api';

// Every API request must identify itself. A browser page on another origin
// cannot set this header without a CORS preflight, which this server never
// answers, so a malicious page cannot read transcripts or POST a command to
// localhost. The UI sends it on every request; curl/API clients must set it too.
//
// The @underload/service adapter deliberately does NOT rely on this: the service
// loader installs permissive CORS, so a custom header is not an access boundary
// there. It uses an Origin gate instead (src/server/service.ts).
const CLIENT_HEADER = 'x-harness-client';
const CLIENT_HEADER_VALUE = 'ui';

export type HarnessHandlerOptions = {
    store: SessionStore;
    // `defaults` comes from the environment; the store only needs the secret
    // settings it actually builds harnesses with.
    defaults: HarnessIndex['defaults'];
    // The same registry the store resolves sessions through. Required: a handler
    // with its own default registry could create a harness that its store cannot
    // see, which would make POST /harnesses succeed and the session 404.
    registry: HarnessRegistry;
    // Built by the host AFTER it loads `.env` (see src/server/start.ts), so a search
    // key in the environment is captured here and not at import time. Omitting it
    // builds a catalogue now, which is still runtime — never module evaluation.
    catalogue?: ToolCatalogue;
};

export type HarnessHandler = (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
    if (response.headersSent) {
        response.end();
        return;
    }

    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
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
    return async (item: SessionStreamItem): Promise<void> => {
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
    registry,
    catalogue
}: HarnessHandlerOptions): HarnessHandler => {
    // One dispatcher per handler: the catalogue snapshot (and therefore any
    // credential tool) is fixed for the handler's lifetime, exactly like before.
    const api = createHarnessApi({
        store,
        defaults,
        registry,
        ...(catalogue === undefined ? {} : { catalogue })
    });

    return async (request, response): Promise<boolean> => {
        const rawUrl = request.url ?? '/';
        const url = new URL(rawUrl, 'http://localhost');

        // The static handler owns everything outside the API mount.
        if (!url.pathname.startsWith(STANDALONE_MOUNT)) return false;

        try {
            if (request.headers[CLIENT_HEADER] !== CLIENT_HEADER_VALUE) {
                throw new HttpError(403, `Requests require the ${CLIENT_HEADER}: ${CLIENT_HEADER_VALUE} header.`);
            }

            const result = await api({
                method: request.method ?? 'GET',
                pathname: url.pathname,
                mount: STANDALONE_MOUNT,
                // Route-aware cap resolved BEFORE reading: only POST submit routes
                // may stream a base64 body up to MAX_SUBMIT_BODY_BYTES.
                readBody: () =>
                    readJson(
                        request,
                        bodyLimitFor(request.method ?? 'GET', url.pathname, STANDALONE_MOUNT)
                    )
            });

            if (result.kind === 'json') {
                sendJson(response, result.status, result.body);
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

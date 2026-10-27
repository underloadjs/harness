// The HTTP API for the harness server.
//
// `createHarnessHandler` is transport-neutral: it receives Node's request and
// response objects, so the standalone server and the Vite dev middleware share
// exactly one implementation. It owns routing and validation; the session store
// owns conversations.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { catalogue, findTool, presets } from '../harnesses';
import type { HarnessPreset } from '../harnesses/types';
import type { Tool } from '../src/harness';
import { listModels, ModelListError } from '../src/transport/models';
import type {
    CreateSessionRequest,
    HarnessDescriptor,
    HarnessIndex,
    ModelIndex,
    ModelListRequest,
    SessionStreamItem,
    SubmitMessageRequest,
    ToolCallRequest,
    ToolCallResult,
    ToolDescriptor,
    ToolIndex
} from './protocol';
import { mergeSettings } from './config';
import { SessionError, SessionStore } from './sessions';

const MAX_BODY_BYTES = 1_000_000;

// Listing models is a convenience call, not a run: an unresponsive provider must
// not hold a browser request open indefinitely. Ten seconds is generous for a
// catalogue (providers answer from memory) and short enough to fail visibly.
const MODEL_LIST_TIMEOUT_MS = 10_000;

// Every API request must identify itself. A browser page on another origin
// cannot set this header without a CORS preflight, which this server never
// answers, so a malicious page cannot read transcripts or POST a command to
// localhost. The UI sends it on every request; curl/API clients must set it too.
const CLIENT_HEADER = 'x-harness-client';
const CLIENT_HEADER_VALUE = 'ui';

export type HarnessHandlerOptions = {
    store: SessionStore;
    // `defaults` comes from the environment; the store only needs the secret
    // settings it actually builds harnesses with.
    defaults: HarnessIndex['defaults'];
};

export type HarnessHandler = (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;

class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message);
        this.name = 'HttpError';
    }
}

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

const readJson = <T>(request: IncomingMessage): Promise<T> =>
    new Promise<T>((resolve, reject) => {
        let size = 0;
        const chunks: Buffer[] = [];
        let settled = false;

        request.on('data', (chunk: Buffer) => {
            if (settled) return;

            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                settled = true;
                reject(new HttpError(413, `A request body cannot exceed ${MAX_BODY_BYTES} bytes.`));
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

const describePreset = (preset: HarnessPreset): HarnessDescriptor => ({
    name: preset.name,
    title: preset.title,
    description: preset.description,
    requiresEndpoint: preset.requiresEndpoint,
    agents: [...preset.agents],
    tools: [...preset.tools]
});

const describeTool = (name: string, definition: Tool, group: string): ToolDescriptor => ({
    name,
    group,
    description: definition.description,
    tags: [...definition.tags],
    visibility: definition.visibility,
    parameters: definition.parameters ?? { type: 'object', properties: {} }
});

const toolIndex = (): ToolIndex => ({
    tools: catalogue.map((entry) => describeTool(entry.name, entry.tool, entry.group))
});

// Write one SSE frame and honour backpressure. The harness awaits progress, so a
// slow client naturally paces the run instead of buffering the transcript.
const createSseWriter = (response: ServerResponse) => {
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

const runSession = async (
    store: SessionStore,
    id: string,
    input: string,
    request: IncomingMessage,
    response: ServerResponse
): Promise<void> => {
    // Validate before the status line is sent, so a busy session can still answer
    // with a normal JSON error.
    store.assertRunnable(id);

    response.statusCode = 200;
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();

    response.write(': connected\n\n');

    response.on('close', () => {
        // A closed response that never ended means the client disconnected.
        if (!response.writableEnded) store.cancel(id);
    });

    request.on('error', () => store.cancel(id));

    const write = createSseWriter(response);

    try {
        await store.run(id, input, write);
    } catch (error) {
        // The pre-flight check passed, so this is a race or an internal failure.
        // The stream is already open; report it as a failed frame.
        const message = messageOf(error);
        await write({ type: 'failed', error: { message }, session: store.get(id) });
    } finally {
        if (!response.writableEnded) response.end();
    }
};

const callTool = async (response: ServerResponse, name: string, request: IncomingMessage): Promise<void> => {
    const definition = findTool(name);
    if (!definition) {
        throw new HttpError(404, `Unknown tool "${name}".`);
    }

    const body = await readJson<ToolCallRequest>(request);
    const started = Date.now();

    try {
        // The direct entry point: no harness, no agent, no loop. The value is the
        // parameter as `execute` receives it, including the single-property rule
        // the UI already mirrors.
        const result = await definition(body.parameters as never);
        const payload: ToolCallResult = { ok: true, result, durationMs: Date.now() - started };
        sendJson(response, 200, payload);
    } catch (error) {
        const payload: ToolCallResult = {
            ok: false,
            error: { message: messageOf(error) },
            durationMs: Date.now() - started
        };
        sendJson(response, 200, payload);
    }
};

// POST /api/models.
//
// The provider catalogue is fetched **server-side** for two reasons: the browser
// must not receive the server API key, and a provider generally does not send
// CORS headers. The client therefore posts the settings it would use for a
// session; anything it omits falls back to the server configuration through
// mergeSettings (a blank key means "use the server key", exactly as for
// sessions). Nothing is persisted or logged here: the merged settings live for
// the duration of this request.
//
// Status mapping:
//   - 400  the merged settings cannot be used (blank base URL, non-http scheme)
//          — the request never left the server;
//   - 502  the provider failed or answered with an unusable catalogue;
//   - 200  `{ models: string[] }`, with an empty array when the provider serves
//          nothing (the UI renders that as an empty state, not an error).
const listModelsRoute = async (
    store: SessionStore,
    request: IncomingMessage,
    response: ServerResponse
): Promise<void> => {
    const body = await readJson<ModelListRequest>(request);

    // `settings` is optional; when present it must be a plain object. A string
    // or array would make mergeSettings read properties off a non-object and
    // silently produce nonsense settings.
    if (body !== null && typeof body === 'object' && body.settings !== undefined) {
        if (typeof body.settings !== 'object' || body.settings === null || Array.isArray(body.settings)) {
            throw new HttpError(400, '`settings` must be an object when present.');
        }
    }

    // The store owns the real server settings (including the key); the handler's
    // `defaults` alias is the key-free copy advertised by /api/harnesses.
    const settings = mergeSettings(store.defaults, body?.settings);

    if (settings.baseURL.trim().length === 0) {
        throw new HttpError(400, 'Set a provider base URL before listing models.');
    }

    // Abort rather than let a dead provider pin this request forever. The timer
    // is cleared on every path so a completed request leaves no pending handle.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);

    try {
        const ids = await listModels({
            baseURL: settings.baseURL,
            // An empty key is omitted, not sent as `Bearer `.
            apiKey: settings.apiKey.trim().length === 0 ? undefined : settings.apiKey,
            signal: controller.signal
        });

        const payload: ModelIndex = { models: ids };
        sendJson(response, 200, payload);
    } catch (error) {
        // ModelListError messages are already scrubbed of the key and quote a
        // URL without userinfo or query string (see src/transport/models.ts).
        if (error instanceof ModelListError) {
            throw new HttpError(error.kind === 'configuration' ? 400 : 502, error.message);
        }

        throw error;
    } finally {
        clearTimeout(timer);
    }
};

export const createHarnessHandler = ({ store, defaults }: HarnessHandlerOptions): HarnessHandler => {
    return async (request, response): Promise<boolean> => {
        const rawUrl = request.url ?? '/';
        const url = new URL(rawUrl, 'http://localhost');

        if (!url.pathname.startsWith('/api')) return false;

        const method = request.method ?? 'GET';
        const segments = url.pathname
            .replace(/^\/api\/?/, '')
            .split('/')
            .filter((segment) => segment.length > 0)
            .map((segment) => {
                try {
                    return decodeURIComponent(segment);
                } catch {
                    // Leave it encoded: an unknown route is a 404, not a crash.
                    return segment;
                }
            });

        try {
            if (request.headers[CLIENT_HEADER] !== CLIENT_HEADER_VALUE) {
                throw new HttpError(403, `Requests require the ${CLIENT_HEADER}: ${CLIENT_HEADER_VALUE} header.`);
            }

            if (segments.length === 0) {
                throw new HttpError(404, 'Unknown API route.');
            }

            const [head, first, second] = segments;

            if (head === 'health' && segments.length === 1) {
                sendJson(response, 200, { ok: true, sessions: store.size });
                return true;
            }

            if (head === 'harnesses' && segments.length === 1) {
                if (method !== 'GET') throw new HttpError(405, 'Use GET for /api/harnesses.');

                const index: HarnessIndex = {
                    harnesses: presets.map(describePreset),
                    defaults
                };
                sendJson(response, 200, index);
                return true;
            }

            if (head === 'models' && segments.length === 1) {
                if (method !== 'POST') throw new HttpError(405, 'Use POST for /api/models.');
                await listModelsRoute(store, request, response);
                return true;
            }

            if (head === 'tools') {
                if (segments.length === 1) {
                    if (method !== 'GET') throw new HttpError(405, 'Use GET for /api/tools.');
                    sendJson(response, 200, toolIndex());
                    return true;
                }

                if (segments.length === 2) {
                    if (method !== 'POST') throw new HttpError(405, 'Use POST to call a tool.');
                    await callTool(response, first, request);
                    return true;
                }
            }

            if (head === 'sessions') {
                if (segments.length === 1) {
                    if (method === 'GET') {
                        sendJson(response, 200, { sessions: store.list() });
                        return true;
                    }

                    if (method === 'POST') {
                        const body = await readJson<CreateSessionRequest>(request);

                        if (typeof body.harness !== 'string' || body.harness.length === 0) {
                            throw new HttpError(400, 'A session requires a harness name.');
                        }

                        const session = store.create(body.harness, body.settings);
                        sendJson(response, 201, { session });
                        return true;
                    }

                    throw new HttpError(405, 'Use GET or POST for /api/sessions.');
                }

                if (segments.length === 2) {
                    if (method === 'GET') {
                        sendJson(response, 200, { session: store.get(first) });
                        return true;
                    }

                    if (method === 'DELETE') {
                        if (!store.remove(first)) throw new HttpError(404, `Unknown session "${first}".`);
                        sendJson(response, 200, { deleted: true });
                        return true;
                    }

                    throw new HttpError(405, 'Use GET or DELETE for /api/sessions/:id.');
                }

                if (segments.length === 3) {
                    if (second === 'messages') {
                        if (method !== 'POST') throw new HttpError(405, 'Use POST to submit a task.');

                        const body = await readJson<SubmitMessageRequest>(request);
                        if (typeof body.input !== 'string') {
                            throw new HttpError(400, 'A task must be a string.');
                        }

                        const input = body.input.trim();
                        if (input.length === 0) {
                            throw new HttpError(400, 'A task cannot be empty.');
                        }

                        await runSession(store, first, input, request, response);
                        return true;
                    }

                    if (second === 'reset') {
                        if (method !== 'POST') throw new HttpError(405, 'Use POST to reset a session.');
                        sendJson(response, 200, { session: store.reset(first) });
                        return true;
                    }

                    if (second === 'cancel') {
                        if (method !== 'POST') throw new HttpError(405, 'Use POST to cancel a run.');

                        // Look the session up first so an unknown id is a 404 even
                        // when there is nothing to cancel.
                        store.get(first);
                        sendJson(response, 200, { cancelled: store.cancel(first) });
                        return true;
                    }
                }
            }

            throw new HttpError(404, `Unknown API route: ${method} ${url.pathname}`);
        } catch (error) {
            if (response.headersSent) {
                // Headers mean an SSE stream is open; the only honest action left
                // is to drop the connection.
                response.destroy();
                return true;
            }

            const status = error instanceof HttpError || error instanceof SessionError ? error.status : 500;
            const message = messageOf(error);

            sendJson(response, status, { error: { message } });
            return true;
        }
    };
};

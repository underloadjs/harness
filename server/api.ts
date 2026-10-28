// Transport-neutral harness HTTP API.
//
// One dispatcher owns the whole routing surface (health, presets, tools, models,
// sessions) and knows nothing about Node's IncomingMessage, Hono's Context, or
// SSE writers. Two adapters consume it:
//
//   - server/handler.ts  — standalone node:http server, mounted at `/api`
//   - server/service.ts  — @underload/service endpoint, mounted at `/v1/harness`
//
// A request names its mount so the same code can serve both prefixes and still
// produce messages that reference the URL the caller actually used. The only
// behavioural difference between mounts is the root document:
//
//   - `/v1/harness` (canonical service API): GET root → bootstrap payload
//   - `/api` (legacy standalone API):        GET root → 404, exactly as before
//
// Bodies are read lazily: a route that rejects a request before looking at the
// body (for example an unknown tool name) must not consume it. Each adapter
// supplies `readBody`; the service loader has already parsed JSON into
// `parameters.body`, while the Node adapter streams and parses it itself.
//
// BODY POLICY (mount-independent, enforced here so both adapters agree):
//   - every action endpoint that reads a body requires a JSON OBJECT; `null`,
//     arrays, strings, and numbers are 400;
//   - POST /tools/:name additionally requires a `parameters` own-property, so a
//     body the service loader reduced to `{}` after a parse failure cannot
//     execute a tool. `{ "parameters": {} }` stays valid for argument-less tools.
//   - byte bounds live in the adapters: the Node adapter rejects while streaming,
//     the service adapter checks content-length and the serialized parsed body
//     (see service.ts, which also documents the upstream-allocation residual).
//
// BOOTSTRAP ROOT: `rootPath` is the canonical API URL this document is served
// from (`/v1/harness`), NOT a filesystem path. File tools resolve relative paths
// against the server process's working directory and there is no workspace
// sandbox, so advertising a file root would promise behaviour the tools do not
// have (see ./runtime.ts).
//
// Cross-references:
//   - ./protocol.ts  — wire types (HarnessDescriptor, SessionStreamItem, …)
//   - ./handler.ts   — Node adapter, `/api` prefix, X-Harness-Client gate
//   - ./service.ts   — service adapter, `/v1/harness` prefix, Origin gate
//   - ./runtime.ts   — lazy shared store/catalogue for the service endpoints
//   - ./config.ts    — mergeSettings credential rule and settings caps

import { coreToolNames, createToolCatalogue, presets } from '../harnesses';
import type { CatalogueEntry, ToolCatalogue } from '../harnesses';
import type { HarnessPreset } from '../harnesses/types';
import { listModels, ModelListError } from '../src/transport/models';
import type {
    CreateSessionRequest,
    HarnessDescriptor,
    HarnessIndex,
    ModelIndex,
    ModelListRequest,
    SessionSnapshot,
    SessionStreamItem,
    SubmitMessageRequest,
    ToolCallRequest,
    ToolCallResult,
    ToolDescriptor,
    ToolIndex
} from './protocol';
import { mergeSettings, SettingsError } from './config';
import { SessionError, SessionStore } from './sessions';

const MAX_BODY_BYTES = 1_000_000;

// Listing models is a convenience call, not a run: an unresponsive provider must
// not hold a request open indefinitely. Ten seconds is generous for a catalogue
// (providers answer from memory) and short enough to fail visibly.
const MODEL_LIST_TIMEOUT_MS = 10_000;

// Mount names accepted by the dispatcher. The paths differ, the routes do not.
export const STANDALONE_MOUNT = '/api';
export const SERVICE_MOUNT = '/v1/harness';

// An error with an HTTP status. The dispatcher maps it to a JSON result, so no
// adapter needs to know how a 409 or 404 is produced.
export class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message);
        this.name = 'HttpError';
    }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// What a transport adapter hands the dispatcher.
export type HarnessApiRequest = {
    method: string;
    // Full request path, including the mount prefix. Kept intact so error
    // messages (`Unknown API route: GET /v1/harness/nope`) quote the real URL.
    pathname: string;
    // Prefix this API is mounted at: STANDALONE_MOUNT or SERVICE_MOUNT.
    mount: string;
    // Parsed JSON body. Called only by routes that need it; `{}` when the
    // request carried no body, matching the legacy readJson behaviour.
    readBody: <T>() => Promise<T>;
    // When true the mount's root document is the service bootstrap payload.
    // Absent/false keeps the legacy `/api` contract (root is a 404).
    bootstrapRoot?: boolean;
};

// Push a stream item to the client. The dispatcher awaits every call, so a slow
// client paces the harness run instead of buffering the whole transcript.
export type HarnessApiEmit = (item: SessionStreamItem) => void | Promise<void>;

// A stream that has already passed validation (status line may be sent).
// `signal` aborts when the client disconnects; the dispatcher cancels the run.
export type HarnessApiStream = (emit: HarnessApiEmit, signal: AbortSignal) => Promise<void>;

export type HarnessApiResult =
    | { kind: 'json'; status: number; body: unknown }
    | { kind: 'stream'; start: HarnessApiStream };

// Payload of GET /v1/harness. Local to this module on purpose: the browser UI
// keeps consuming the individual wire types until the shared protocol documents
// the bootstrap document (protocol.ts is owned by the session-contract change).
export type HarnessBootstrap = {
    // Canonical API URL this document was served from, i.e. the mount
    // ('/v1/harness'). It is not a filesystem path: the file tools resolve
    // relative paths against the server process's working directory and no
    // workspace sandbox exists, so there is no file root to advertise.
    rootPath: string;
    presets: HarnessDescriptor[];
    tools: ToolDescriptor[];
    defaults: HarnessIndex['defaults'];
    sessions: SessionSnapshot[];
};

export type HarnessApiOptions = {
    store: SessionStore;
    // Key-free provider defaults advertised to clients.
    defaults: HarnessIndex['defaults'];
    // Built by the host AFTER it loads `.env`, so a search key in the process
    // environment is captured here and not at import time.
    catalogue?: ToolCatalogue;
};

export type HarnessApi = (request: HarnessApiRequest) => Promise<HarnessApiResult>;

// Resolve one preset onto the wire. `tools` is the declared list plus the
// environment-backed names (`environmentTools`, see harnesses/types.ts) that this
// host can ACTUALLY run: the name is appended only when the runtime catalogue has
// an executable definition for it. A keyless deployment therefore advertises
// exactly what it did before and never claims a search tool it cannot call
// (POST /tools/websearch would answer `ok: false` in that case).
//
// Cheap on purpose: the catalogue is already built by the host (after .env load,
// see runtime.ts), so answering /harnesses never constructs a harness or a live
// agent just to learn which tools a preset would register.
const describePreset = (preset: HarnessPreset, catalogue: ToolCatalogue): HarnessDescriptor => ({
    name: preset.name,
    title: preset.title,
    description: preset.description,
    requiresEndpoint: preset.requiresEndpoint,
    agents: [...preset.agents],
    tools: [
        ...preset.tools,
        // `preset.tools.includes` guards a preset that ever declares the same
        // environment-backed name statically: it must not appear twice.
        ...(preset.environmentTools ?? []).filter(
            (name) => catalogue.tools[name] !== undefined && !preset.tools.includes(name)
        )
    ],
    // Core tools are harness-owned, so the server states them instead of the UI
    // hardcoding "getTools": delegate is present exactly when the preset declares
    // a subagent allowlist (Research), which is an agent-configuration difference
    // and therefore legitimately absent from a single-agent preset.
    coreTools: coreToolNames(preset.subagents)
});

// Copy one catalogue entry onto the wire. Metadata comes from the entry, not the
// Tool, because an unconfigured credential-dependent entry has no Tool to read.
// `availability` is only sent when the entry has something to say; existing tools
// keep the exact descriptor shape they had before C1.
const describeTool = (entry: CatalogueEntry): ToolDescriptor => {
    const descriptor: ToolDescriptor = {
        name: entry.name,
        group: entry.group,
        description: entry.description,
        tags: [...entry.tags],
        visibility: entry.visibility,
        parameters: entry.parameters
    };

    if (entry.availability !== undefined) {
        descriptor.availability = {
            state: entry.availability.state,
            ...(entry.availability.environment === undefined
                ? {}
                : { environment: [...entry.availability.environment] }),
            ...(entry.availability.hint === undefined ? {} : { hint: entry.availability.hint })
        };
    }

    return descriptor;
};

const toolIndex = (catalogue: ToolCatalogue): ToolIndex => ({
    tools: catalogue.entries.map(describeTool)
});

// Split the path below the mount. Both mounts are plain prefixes; a path that
// does not start with the mount is an unknown route (the adapters already
// filtered, but a defensive empty result keeps the dispatcher safe).
const relativeSegments = (pathname: string, mount: string): string[] | undefined => {
    if (pathname !== mount && !pathname.startsWith(`${mount}/`)) return undefined;

    const rest = pathname === mount ? '' : pathname.slice(mount.length);

    return rest
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
};

// A body is only usable when it is a JSON object. Arrays, `null`, strings, and
// numbers are rejected before any route reads a field off them: `body.harness`
// on a string would be `undefined` and turn a malformed request into a confusing
// 400 about a missing field instead of the real problem.
const requireObjectBody = <T>(body: unknown, message = 'The request body must be a JSON object.'): T => {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new HttpError(400, message);
    }

    return body as T;
};

// The service loader turns a malformed JSON body into `{}` (see service.ts), so
// an absent `parameters` property is indistinguishable from "JSON failed to
// parse". Requiring the property keeps a swallowed parse failure from calling a
// tool with `undefined`; `{ "parameters": {} }` remains a valid argument-less
// call (the UI sends exactly that for an empty argument box).
const TOOL_WRAPPER_MESSAGE =
    'A tool call requires a "parameters" property. Send {"parameters": {}} for a tool with no arguments.';

export const createHarnessApi = ({
    store,
    defaults,
    catalogue = createToolCatalogue()
}: HarnessApiOptions): HarnessApi => {
    // `catalogue` is resolved once per API instance, not per request: the
    // credential tools close over the key resolved at construction, exactly like
    // a session harness. An HTTP request never triggers a fresh environment read.
    //
    // The document is built per mount because `rootPath` is the mount URL: the
    // service adapter is the only caller with `bootstrapRoot: true`, and it must
    // see the URL the client actually used.
    const bootstrap = (mount: string): HarnessBootstrap => ({
        rootPath: mount,
        presets: presets.map((preset) => describePreset(preset, catalogue)),
        tools: catalogue.entries.map(describeTool),
        defaults,
        sessions: store.list()
    });

    // POST /api/models — handled below the route table because it needs the body.
    //
    // The provider catalogue is fetched server-side for two reasons: the browser
    // must not receive the server API key, and a provider generally does not send
    // CORS headers. The client posts the settings it would use for a session;
    // anything it omits falls back to the server configuration through
    // mergeSettings (a blank key means "use the server key", but ONLY while the
    // effective base URL is the configured provider's origin + base path).
    //
    // Status mapping:
    //   400 — the merged settings cannot be used (blank base URL, bad scheme,
    //         non-object body, over-long field);
    //   502 — the provider failed or answered with an unusable catalogue;
    //   200 — `{ models: string[] }`, possibly empty.
    const listModelsRoute = async (readBody: HarnessApiRequest['readBody']): Promise<HarnessApiResult> => {
        const body = requireObjectBody<ModelListRequest>(await readBody<ModelListRequest>());

        // `settings` is optional; when present it must be a plain object. A string
        // or array would make mergeSettings read properties off a non-object and
        // silently produce nonsense settings.
        if (body.settings !== undefined) {
            if (typeof body.settings !== 'object' || body.settings === null || Array.isArray(body.settings)) {
                throw new HttpError(400, '`settings` must be an object when present.');
            }
        }

        // The store owns the real server settings (including the key); the API's
        // `defaults` alias is the key-free copy advertised by /harnesses. The key
        // is only carried over when the effective base URL is that same provider.
        const settings = mergeSettings(store.defaults, body.settings);

        if (settings.baseURL.trim().length === 0) {
            throw new HttpError(400, 'Set a provider base URL before listing models.');
        }

        // Abort rather than let a dead provider pin this request forever. The
        // timer is cleared on every path so a completed request leaves no handle.
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
            return { kind: 'json', status: 200, body: payload };
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

    // POST /tools/:name — direct call, no harness, no model, no loop.
    //
    // The entry is looked up BEFORE reading the body so an unknown name answers a
    // 404 without consuming a request the adapter may not need to drain.
    const callToolRoute = async (
        name: string,
        readBody: HarnessApiRequest['readBody']
    ): Promise<HarnessApiResult> => {
        const entry = catalogue.find(name);
        if (!entry) {
            throw new HttpError(404, `Unknown tool "${name}".`);
        }

        // The body is validated before either branch runs, so a swallowed parse
        // failure (`{}` from the service loader) cannot reach `entry.tool` with
        // no arguments — see TOOL_WRAPPER_MESSAGE above.
        const body = requireObjectBody<ToolCallRequest>(await readBody<ToolCallRequest>());

        if (!Object.prototype.hasOwnProperty.call(body, 'parameters')) {
            throw new HttpError(400, TOOL_WRAPPER_MESSAGE);
        }

        const started = Date.now();

        // A listed-but-unconfigured tool is not a 404 and not a fake success: it
        // is a tool failure reported as data, exactly like a throwing tool. The
        // message is the catalogue hint (variable names, never values).
        if (entry.tool === undefined) {
            const payload: ToolCallResult = {
                ok: false,
                error: {
                    message:
                        entry.availability?.hint ??
                        `Tool "${name}" is not configured on this server.`
                },
                durationMs: Date.now() - started
            };
            return { kind: 'json', status: 200, body: payload };
        }

        try {
            // The value is the parameter as `execute` receives it, including the
            // single-property rule the UI already mirrors.
            const result = await entry.tool(body.parameters as never);
            const payload: ToolCallResult = { ok: true, result, durationMs: Date.now() - started };
            return { kind: 'json', status: 200, body: payload };
        } catch (error) {
            const payload: ToolCallResult = {
                ok: false,
                error: { message: messageOf(error) },
                durationMs: Date.now() - started
            };
            return { kind: 'json', status: 200, body: payload };
        }
    };

    // POST /sessions/:id/messages — validate first, then hand back a stream. The
    // adapter decides how to write frames; the dispatcher owns cancellation:
    // aborting `signal` cancels the run exactly like the Node response-close path.
    const runSessionRoute = (id: string, input: string): HarnessApiResult => {
        // Validate before a status line is sent, so a busy session can still
        // answer with a normal JSON error (409) rather than an SSE failure frame.
        store.assertRunnable(id);

        return {
            kind: 'stream',
            start: async (emit, signal) => {
                // A disconnect between dispatch and stream opening still cancels.
                if (signal.aborted) {
                    store.cancel(id);
                    return;
                }

                const cancel = (): void => {
                    store.cancel(id);
                };

                signal.addEventListener('abort', cancel, { once: true });

                try {
                    await store.run(id, input, emit);
                } catch (error) {
                    // The pre-flight check passed, so this is a race or an
                    // internal failure. The stream is already open; report it as
                    // a failed frame. If the client is gone, emitting throws and
                    // there is nobody left to tell.
                    try {
                        await emit({
                            type: 'failed',
                            error: { message: messageOf(error) },
                            session: store.get(id)
                        });
                    } catch {
                        // Stream closed; cancellation already handled above.
                    }
                } finally {
                    signal.removeEventListener('abort', cancel);
                }
            }
        };
    };

    return async (request): Promise<HarnessApiResult> => {
        const { method, pathname, mount, readBody } = request;
        const segments = relativeSegments(pathname, mount);

        try {
            if (segments === undefined) {
                throw new HttpError(404, `Unknown API route: ${method} ${pathname}`);
            }

            // Canonical service root: one document with everything a client needs
            // to boot (API root URL, presets, tools, defaults, sessions).
            if (segments.length === 0) {
                if (request.bootstrapRoot !== true) {
                    throw new HttpError(404, 'Unknown API route.');
                }

                if (method !== 'GET') {
                    throw new HttpError(405, `Use GET for ${mount}.`);
                }

                return { kind: 'json', status: 200, body: bootstrap(mount) };
            }

            const [head, first, second] = segments;

            if (head === 'health' && segments.length === 1) {
                return { kind: 'json', status: 200, body: { ok: true, sessions: store.size } };
            }

            // `/presets` is an alias of `/harnesses` so canonical clients can use
            // catalogue language while standalone clients keep the old name.
            if ((head === 'harnesses' || head === 'presets') && segments.length === 1) {
                if (method !== 'GET') throw new HttpError(405, `Use GET for ${mount}/${head}.`);

                const index: HarnessIndex = {
                    harnesses: presets.map((preset) => describePreset(preset, catalogue)),
                    defaults
                };
                return { kind: 'json', status: 200, body: index };
            }

            if (head === 'models' && segments.length === 1) {
                if (method !== 'POST') throw new HttpError(405, `Use POST for ${mount}/models.`);
                return await listModelsRoute(readBody);
            }

            if (head === 'tools') {
                if (segments.length === 1) {
                    if (method !== 'GET') throw new HttpError(405, `Use GET for ${mount}/tools.`);
                    return { kind: 'json', status: 200, body: toolIndex(catalogue) };
                }

                if (segments.length === 2) {
                    if (method !== 'POST') throw new HttpError(405, 'Use POST to call a tool.');
                    return await callToolRoute(first, readBody);
                }
            }

            if (head === 'sessions') {
                if (segments.length === 1) {
                    if (method === 'GET') {
                        return { kind: 'json', status: 200, body: { sessions: store.list() } };
                    }

                    if (method === 'POST') {
                        const body = requireObjectBody<CreateSessionRequest>(
                            await readBody<CreateSessionRequest>()
                        );

                        if (typeof body.harness !== 'string' || body.harness.length === 0) {
                            throw new HttpError(400, 'A session requires a harness name.');
                        }

                        // mergeSettings enforces the credential rule: a foreign
                        // baseURL with no explicit key gets no server key.
                        const session = store.create(body.harness, body.settings);
                        return { kind: 'json', status: 201, body: { session } };
                    }

                    throw new HttpError(405, `Use GET or POST for ${mount}/sessions.`);
                }

                if (segments.length === 2) {
                    if (method === 'GET') {
                        return { kind: 'json', status: 200, body: { session: store.get(first) } };
                    }

                    if (method === 'DELETE') {
                        if (!store.remove(first)) throw new HttpError(404, `Unknown session "${first}".`);
                        return { kind: 'json', status: 200, body: { deleted: true } };
                    }

                    throw new HttpError(405, `Use GET or DELETE for ${mount}/sessions/:id.`);
                }

                if (segments.length === 3) {
                    if (second === 'messages') {
                        if (method !== 'POST') throw new HttpError(405, 'Use POST to submit a task.');

                        const body = requireObjectBody<SubmitMessageRequest>(
                            await readBody<SubmitMessageRequest>()
                        );
                        if (typeof body.input !== 'string') {
                            throw new HttpError(400, 'A task must be a string.');
                        }

                        const input = body.input.trim();
                        if (input.length === 0) {
                            throw new HttpError(400, 'A task cannot be empty.');
                        }

                        return runSessionRoute(first, input);
                    }

                    if (second === 'reset') {
                        if (method !== 'POST') throw new HttpError(405, 'Use POST to reset a session.');
                        return { kind: 'json', status: 200, body: { session: store.reset(first) } };
                    }

                    if (second === 'cancel') {
                        if (method !== 'POST') throw new HttpError(405, 'Use POST to cancel a run.');

                        // Look the session up first so an unknown id is a 404 even
                        // when there is nothing to cancel.
                        store.get(first);
                        return { kind: 'json', status: 200, body: { cancelled: store.cancel(first) } };
                    }
                }
            }

            throw new HttpError(404, `Unknown API route: ${method} ${pathname}`);
        } catch (error) {
            // Every known failure becomes a JSON result; adapters never need to
            // replicate the status mapping. An unexpected error is still a 500
            // with the same `{ error: { message } }` envelope as before.
            // SettingsError carries a 400 for the shared settings caps/type checks.
            const status =
                error instanceof HttpError || error instanceof SessionError || error instanceof SettingsError
                    ? error.status
                    : 500;
            return { kind: 'json', status, body: { error: { message: messageOf(error) } } };
        }
    };
};

// Maximum bytes accepted by the Node adapter's manual body reader. Exported so
// the adapter and its tests share one number instead of copying a literal.
export const MAX_API_BODY_BYTES = MAX_BODY_BYTES;

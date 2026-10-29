// Transport-neutral harness HTTP API.
//
// One dispatcher owns the whole routing surface (health, harnesses, agents, tools,
// models, sessions) and knows nothing about Node's IncomingMessage, Hono's Context,
// or SSE writers. Two adapters consume it:
//
//   - src/server/handler.ts  — standalone node:http server, mounted at `/api`
//   - src/server/service.ts  — @underload/service endpoint, mounted at `/v1/harness`
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
//   - POST/PATCH /harnesses reject unknown fields outright: instruction text,
//     provider settings, or a tool list are never client-supplied. The one
//     model-shaped field, `agentModels`, is a validated agent id → model id map.
//   - byte bounds live in the adapters: the Node adapter rejects while streaming,
//     the service adapter checks content-length and the serialized parsed body
//     (see service.ts, which also documents the upstream-allocation residual). The
//     default cap is 1 MB; the two submit routes (/sessions/:id/tasks and
//     /sessions/:id/messages) carry raw base64 attachments and use the shared
//     16 MiB MAX_SUBMIT_BODY_BYTES instead (see bodyLimitFor). Both adapters call
//     that one helper, so a route cannot get a different bound per mount.
//
// TOOL EXECUTION (R8): every tool runs on the server. GET /tools (and
// /tools/bootstrap, and the bootstrap document) lists the whole catalogue PLUS the
// harness-owned core tools — toolRequest, toolCreate, todoManage, agentDelegate — marked
// `visibility: 'core'` and `sessionBound: true`. R18: only the harness-owned set
// is sessionBound; core file tools/webSearch keep a real `tool` and run directly.
// A sessionBound entry has no standalone implementation: POST /tools/:name
// requires `sessionId`, rejects 400
// without one, 404 for an unknown session or a core tool that session's harness
// does not register (agentDelegate without subagents), and 409 while the session is
// busy (a streaming run, a reset, or another manual call) so a manual mutation
// cannot race an active operation. A directly callable catalogue tool keeps its
// old session-less runner and simply ignores `sessionId`.
//
// HARNESS REGISTRY: POST/PATCH /harnesses mutate the in-memory registry the store
// resolves sessions through (see ./harnesses/registry.ts). They affect FUTURE
// sessions only; an existing session keeps the preset and descriptor it captured.
//
// BOOTSTRAP ROOT: `rootPath` is the canonical API URL this document is served
// from (`/v1/harness`), NOT a filesystem path. File tools resolve relative paths
// against the server process's working directory and there is no workspace
// sandbox, so advertising a file root would promise behaviour the tools do not
// have (see ./runtime.ts).
//
// Cross-references:
//   - ./protocol.ts  — wire types (HarnessDescriptor, AgentDescriptor, SessionStreamItem, …)
//   - ./handler.ts   — Node adapter, `/api` prefix, X-Harness-Client gate
//   - ./service.ts   — service adapter, `/v1/harness` prefix, Origin gate
//   - ./runtime.ts   — lazy shared store/catalogue/registry for the service endpoints
//   - ./config.ts    — mergeSettings credential rule and settings caps
//   - ./harnesses/registry.ts — create/patch validation and the in-memory entries

import { createToolCatalogue, describeAgent, describeHarness } from './harnesses';
import { createCoreToolEntries } from './harnesses';
import { createHarnessRegistry } from './harnesses';
import type { CatalogueEntry, HarnessRegistry, ToolCatalogue } from './harnesses';
import { toolUiOf, boundToolResult, resolveToolParameters } from '../harness';
import { listModels, ModelListError } from '../transport/models';
import type { ModelListConfiguration } from '../transport/models';
import type {
    AgentDescriptor,
    AnswerActionRequest,
    AnswerActionResult,
    CancelSessionRequest,
    CreateHarnessRequest,
    CreateSessionRequest,
    HarnessAttachment,
    HarnessDescriptor,
    HarnessIndex,
    ModelIndex,
    ModelListRequest,
    SessionSnapshot,
    SessionStreamItem,
    SubmitMessageRequest,
    SubmitTaskRequest,
    ToolCallRequest,
    ToolCallResult,
    ToolDescriptor,
    ToolIndex,
    UpdateHarnessRequest,
    UpdateSessionRequest
} from './protocol';
import { mergeSettings, SettingsError } from './config';
import { HarnessRegistryError } from './harnesses/registry';
import { MAX_SUBMIT_BODY_BYTES } from '../shared/attachments';
import { SessionError, SessionStore, validateAttachmentsForSubmit } from './sessions';
import type { SessionWatch } from './sessions';

const MAX_BODY_BYTES = 1_000_000;

// Listing models is a convenience call, not a run: an unresponsive provider must
// not hold a request open indefinitely. Ten seconds is generous for a catalogue
// (providers answer from memory) and short enough to fail visibly. This is the
// FIRST attempt's budget; each retry doubles it (see listModelsWithRetry).
const MODEL_LIST_TIMEOUT_MS = 10_000;

// Total attempts for the catalogue lookup (the initial call plus nine retries).
// A provider that is cold-starting, throttling, or restarting usually recovers
// within a few tries, and the call is an idempotent GET with no side effects.
// Chosen explicitly by the product owner: ten attempts, with the final window
// at 10_000 * 2**9 = 5_120_000 ms (~85 minutes).
const MODEL_LIST_MAX_ATTEMPTS = 10;

// Fetch the catalogue, retrying provider failures with a per-attempt deadline
// that doubles each time: 10s, 20s, 40s, ... 5_120s on the tenth attempt.
//
// Why retry here (route level) instead of inside transport/models.ts:
//   - `listModels` is a thin, predictable single GET and stays usable as-is by
//     callers that want their own retry policy;
//   - the route is the only caller that owns provider credentials and must
//     produce one HTTP status, so the policy belongs with the status mapping.
//
// What is retried: only `ModelListError` of kind 'request' (network/TLS/abort)
// or 'response' (non-2xx, non-JSON, unusable body). Both mean the provider — not
// the caller — failed, and a repeat GET can plausibly succeed.
//
// What is NOT retried:
//   - `ModelListError` of kind 'configuration': a blank/invalid base URL cannot
//     be fixed by trying again, so it fails immediately (route maps it to 400);
//   - any other thrown value: a programming error, not a provider outage, must
//     surface unchanged rather than be repeated ten times.
//
// Every attempt gets a FRESH AbortController and timer: reusing one aborted
// signal would make every retry fail instantly, and the timer is cleared in
// `finally` so a fast success/failure leaves no pending handle. There is no
// sleep between attempts — the growing timeout IS the retry policy.
export const listModelsWithRetry = async (configuration: ModelListConfiguration): Promise<string[]> => {
    for (let attempt = 0; attempt < MODEL_LIST_MAX_ATTEMPTS; attempt += 1) {
        const controller = new AbortController();

        // Double the window per attempt: attempt 0 → 10s, attempt 9 → 5_120s.
        const timer = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS * 2 ** attempt);

        try {
            return await listModels({
                baseURL: configuration.baseURL,
                apiKey: configuration.apiKey,
                signal: controller.signal
            });
        } catch (error) {
            // Configuration errors and unexpected exceptions are final. The
            // route already knows how to map ModelListError; anything else is
            // rethrown untouched for the adapter's generic error handling.
            if (!(error instanceof ModelListError) || error.kind === 'configuration') {
                throw error;
            }

            // On the final attempt there is no next try: surface the provider's
            // own (already redacted) message so the route answers 502.
            if (attempt === MODEL_LIST_MAX_ATTEMPTS - 1) {
                throw error;
            }
        } finally {
            // Clear on success, failure, and the final throw alike.
            clearTimeout(timer);
        }
    }

    // The loop above either returns or throws on its last iteration; this only
    // satisfies the compiler's exhaustiveness check.
    throw new Error('Model list retry loop exited without a result.');
};

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
// `signal` aborts when the client disconnects. What that means is per route:
// POST /messages cancels the run (legacy ownership), while GET /sessions/:id/events
// only unsubscribes — the queue pump owns execution and keeps running for nobody.
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
    // Named `presets` for compatibility; the values are harness descriptors.
    presets: HarnessDescriptor[];
    // The trusted agent registry, so a client can render primary/subagent pickers
    // from the same document that lists the harnesses.
    agents: AgentDescriptor[];
    tools: ToolDescriptor[];
    defaults: HarnessIndex['defaults'];
    sessions: SessionSnapshot[];
};

export type HarnessApiOptions = {
    store: SessionStore;
    // Key-free provider defaults advertised to clients.
    defaults: HarnessIndex['defaults'];
    // Shared with the store: a harness created through POST /harnesses is
    // resolvable by a session created through the same API instance. Defaults to a
    // fresh registry over the shipped presets (convenient for a focused test).
    registry?: HarnessRegistry;
    // Built by the host AFTER it loads `.env`, so a search key in the process
    // environment is captured here and not at import time.
    catalogue?: ToolCatalogue;
};

export type HarnessApi = (request: HarnessApiRequest) => Promise<HarnessApiResult>;

// Descriptors are projected by ./harnesses/descriptor.ts, which src/server/sessions.ts
// also uses for its frozen `harnessDefinition`. Keeping one projection means a
// card and a session snapshot cannot disagree about agents, tools, or editability.
// Cheap on purpose: the catalogue is already built by the host (after .env load,
// see runtime.ts), so answering /harnesses never constructs a harness or a live
// agent just to learn which tools a preset would register.

// Body fields a client may send. Anything else is a 400: instruction text,
// provider settings, a model, or a tool list must never be client-supplied.
// `agentModels` (R9) is the one model-shaped field: a map of selected agent id →
// model id, validated against the final member set by the registry.
const CREATE_HARNESS_FIELDS = [
    'name',
    'title',
    'description',
    'primary',
    'subagents',
    'agentModels'
] as const;
const UPDATE_HARNESS_FIELDS = [
    'title',
    'description',
    'primary',
    'subagents',
    'agentModels'
] as const;

// The one live-session mutation a client may send (PATCH /sessions/:id). The
// harness, settings, and frozen definition are never client-writable, so the
// allowlist is deliberately a single field.
const SESSION_PATCH_FIELDS = ['agentModels'] as const;

// The only field POST /sessions/:id/cancel accepts. An absent body (or `{}`) is
// the legacy active-run cancel; `all` also drops the queued backlog.
const SESSION_CANCEL_FIELDS = ['all'] as const;

// The one field POST /sessions/:id/actions/:requestId/answer accepts (N4). The
// choice itself is validated by shared core/action.ts against the recorded request;
// this list only rejects wrapper-level extras.
const ANSWER_ACTION_FIELDS = ['choice'] as const;

// Reject unknown properties instead of ignoring them. A request that tries to set
// `instructions` is then a visible contract violation rather than a silent no-op
// that leaves the client believing it changed a prompt.
const requireKnownFields = (body: object, allowed: readonly string[]): void => {
    for (const key of Object.keys(body)) {
        if (!allowed.includes(key)) {
            throw new HttpError(
                400,
                `Unknown field "${key}". Allowed fields: ${allowed.join(', ')}.`
            );
        }
    }
};

// Copy one catalogue entry onto the wire. Metadata comes from the entry, not the
// Tool, because an unconfigured credential-dependent entry has no Tool to read.
// `availability` is only sent when the entry has something to say; existing tools
// keep the exact descriptor shape they had before C1. `sessionBound` (R8) is sent
// only for the core entries, which have no standalone implementation.
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

    if (entry.sessionBound === true) descriptor.sessionBound = true;

    return descriptor;
};

const toolIndex = (entries: readonly CatalogueEntry[]): ToolIndex => ({
    tools: entries.map(describeTool)
});

// Bound ONE manual tool value for the HTTP result (R13).
//
// The model-facing transcript is bounded in harness.ts; the manual (host) route is
// a second way to obtain a tool result, and a huge fileRead/webSearch result would
// otherwise travel as one enormous JSON body. The SAME shared cap is applied here —
// to the serialized text, not to a reimplementation of the limit — with two rules:
//
//   1. a value that fits stays EXACT: `JSON.stringify` is only measured and then
//      discarded, so every small structured result is byte-for-byte what it was;
//   2. a truncated result is the envelope TEXT that `boundToolResult` produced,
//      parsed back into an object when possible (`{truncated, originalBytes,
//      budgetBytes, content}`). The body therefore stays valid JSON with an
//      explicit, machine-readable truncation marker instead of a half-written
//      document or a JSON blob that is really a string.
//
// Strings are bounded directly (no double-serialization, so the reported
// `originalBytes` is the text the tool produced). Values JSON cannot encode
// (`undefined`, a function) are returned untouched: there is no wire cost to cap.
const boundToolValue = (value: unknown): unknown => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);

    if (text === undefined) return value;

    const bounded = boundToolResult(text);
    if (!bounded.truncated) return value;

    try {
        return JSON.parse(bounded.content);
    } catch {
        // Defensive only: boundToolResult always emits JSON. Returning the envelope
        // text is still a bounded, honest answer.
        return bounded.content;
    }
};

// Bound a manual tool ERROR message with the same shared cap. The envelope text is
// kept as the message because `error.message` is a string by protocol; it is still
// valid JSON, so a client can parse it to learn how much was dropped.
const boundErrorMessage = (error: unknown): string => boundToolResult(messageOf(error)).content;

// Build the success envelope for a manual tool call. R20.2: a tool may return the
// branded `toolUi(content, panels)` envelope. The HTTP result must stay the
// ordinary content (`result`) and may carry the optional declarative `panels`;
// `toolUiOf` also re-validates and bounds them here, at the server boundary, so a
// hand-built or malformed envelope cannot reach the client unbounded. An ordinary
// value is returned untouched, which keeps standard tools byte-for-byte stable.
//
// R13: the result content is bounded AFTER the unwrap (panels are bounded by
// core/tool-ui.ts, a separate surface), so a huge content cannot smuggle an
// unbounded body through the UI envelope.
const successfulToolResult = (value: unknown, started: number): ToolCallResult => {
    const ui = toolUiOf(value);

    if (ui === undefined) {
        return { ok: true, result: boundToolValue(value), durationMs: Date.now() - started };
    }

    return {
        ok: true,
        result: boundToolValue(ui.content),
        // Omit an empty list: an envelope with nothing renderable is
        // indistinguishable from a standard tool response.
        ...(ui.panels.length === 0 ? {} : { panels: ui.panels }),
        durationMs: Date.now() - started
    };
};

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

// Maximum bytes for one request body, per route (T3).
//
// The two submit routes carry raw base64 media inside JSON, so they alone get the
// shared MAX_SUBMIT_BODY_BYTES (16 MiB) bound. Everything else keeps the legacy
// 1 MB cap: an unrelated route must not become a larger allocation surface just
// because submissions may be large.
//
// Matching mirrors the dispatcher (`relativeSegments`): POST only, exactly
// `/sessions/:id/tasks` or `/sessions/:id/messages` below the mount. Both
// adapters MUST call this before reading/bounding a body so a route cannot get a
// different limit on the Node mount than on the service mount.
export const bodyLimitFor = (method: string, pathname: string, mount: string): number => {
    if (method.toUpperCase() !== 'POST') return MAX_BODY_BYTES;

    const segments = relativeSegments(pathname, mount);

    if (
        segments !== undefined &&
        segments.length === 3 &&
        segments[0] === 'sessions' &&
        (segments[2] === 'tasks' || segments[2] === 'messages')
    ) {
        return MAX_SUBMIT_BODY_BYTES;
    }

    return MAX_BODY_BYTES;
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
    registry = createHarnessRegistry(),
    catalogue = createToolCatalogue()
}: HarnessApiOptions): HarnessApi => {
    // `catalogue` is resolved once per API instance, not per request: the
    // credential tools close over the key resolved at construction, exactly like
    // a session harness. An HTTP request never triggers a fresh environment read.
    //
    // The core (harness-owned) descriptors are built once too. They are listed
    // alongside the catalogue — the Tools tab shows every tool including the core
    // set (R8) — and they carry `sessionBound`, which is what makes a call require
    // a sessionId. Metadata comes from src/core/metadata.ts, the same copy the
    // harness registers, so a descriptor cannot advertise a different schema.
    const coreEntries = createCoreToolEntries();

    // One ordered list for every listing surface: core first (always declared in
    // chat), then the directly callable catalogue in its stable group order.
    const toolEntries = (): CatalogueEntry[] => [...coreEntries, ...catalogue.entries];

    // The document is built per mount because `rootPath` is the mount URL: the
    // service adapter is the only caller with `bootstrapRoot: true`, and it must
    // see the URL the client actually used.
    const describeAll = (): HarnessDescriptor[] =>
        registry.list().map((preset) => describeHarness(preset, catalogue));

    const agentList = (): AgentDescriptor[] => registry.agents().map(describeAgent);

    const bootstrap = (mount: string): HarnessBootstrap => ({
        rootPath: mount,
        presets: describeAll(),
        agents: agentList(),
        // Core tools included: the bootstrap payload IS the catalogue a client
        // boots from, and every tool executes server-side.
        tools: toolEntries().map(describeTool),
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

        // Each attempt aborts after its own deadline, so a dead provider cannot
        // pin this request forever; failures are retried with a fresh controller
        // and a doubled deadline until the attempt budget is exhausted (see
        // listModelsWithRetry).
        try {
            const ids = await listModelsWithRetry({
                baseURL: settings.baseURL,
                // An empty key is omitted, not sent as `Bearer `.
                apiKey: settings.apiKey.trim().length === 0 ? undefined : settings.apiKey
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
        }
    };

    // POST /tools/:name — call one tool.
    //
    // Two execution paths, because there are two kinds of entry:
    //
    //   sessionBound — the harness-owned core tools toolRequest, toolCreate,
    //     todoManage, agentDelegate. They have no standalone implementation by
    //     design; they run inside a session's harness so a manual call changes THAT
    //     conversation (enabled tools, registered tools, todos, a delegated
    //     subagent turn). A call must carry `sessionId`, and the store rejects a
    //     session that is already busy (running, resetting, or another manual call).
    //   catalogue — the direct runner that predates R8: no harness, no model, no
    //     loop. A `sessionId` may still be present (one request shape) and is
    //     ignored. R18: this now includes the core FILE tools and a configured
    //     webSearch. They are `visibility: 'core'` (always declared to the model)
    //     but have real implementations, so they must NOT require a session.
    //
    // The entry is looked up BEFORE reading the body so an unknown name answers a
    // 404 without consuming a request the adapter may not need to drain.
    const callToolRoute = async (
        name: string,
        readBody: HarnessApiRequest['readBody']
    ): Promise<HarnessApiResult> => {
        const coreEntry = coreEntries.find((candidate) => candidate.name === name);
        const entry = coreEntry ?? catalogue.find(name);

        // The body is validated before either branch runs, so a swallowed parse
        // failure (`{}` from the service loader) cannot reach a tool with no
        // arguments — see TOOL_WRAPPER_MESSAGE above.
        const body = requireObjectBody<ToolCallRequest>(await readBody<ToolCallRequest>());

        // A present-but-unusable id (`0`, `true`, `{}`) must not be coerced into a
        // session lookup: it would answer 404 for a request that is really a 400.
        if (body.sessionId !== undefined && typeof body.sessionId !== 'string') {
            throw new HttpError(400, '`sessionId` must be a string when present.');
        }

        const started = Date.now();

        // R13: a tool that exists only in ONE session's registry (created by
        // toolCreate, or contributed by a plugin at session construction) is not in
        // the static catalogue. It is resolved HERE, through the session the caller
        // named, and never by scanning every session — one session's tools must not
        // become callable (or even discoverable) through another session's id.
        // Everything static keeps its existing shape: an unknown name WITHOUT a
        // session is still a 404, and that 404 is decided before the wrapper rule
        // (an unknown tool is unknown whatever the body looks like).
        if (entry === undefined) {
            if (body.sessionId === undefined || body.sessionId.length === 0) {
                throw new HttpError(404, `Unknown tool "${name}".`);
            }

            // A session IS named, so the wrapper rule applies before the call: a
            // swallowed parse failure must not reach a session tool as `undefined`.
            if (!Object.prototype.hasOwnProperty.call(body, 'parameters')) {
                throw new HttpError(400, TOOL_WRAPPER_MESSAGE);
            }

            try {
                const result = await store.callTool(body.sessionId, name, body.parameters as never);
                return { kind: 'json', status: 200, body: successfulToolResult(result, started) };
            } catch (error) {
                // Unknown session, a busy session, or a name absent from THIS
                // session's registry are request failures (404/409), not tool data.
                if (error instanceof SessionError) throw error;

                const payload: ToolCallResult = {
                    ok: false,
                    error: { message: boundErrorMessage(error) },
                    durationMs: Date.now() - started
                };
                return { kind: 'json', status: 200, body: payload };
            }
        }

        if (!Object.prototype.hasOwnProperty.call(body, 'parameters')) {
            throw new HttpError(400, TOOL_WRAPPER_MESSAGE);
        }

        // Session-bound core tool: real harness, real session state.
        if (entry.sessionBound === true) {
            const sessionId = body.sessionId;

            // An empty string is "no session" for this purpose: the tool cannot run
            // without a harness, and the message says how to fix it.
            if (sessionId === undefined || sessionId.length === 0) {
                throw new HttpError(
                    400,
                    `Tool "${name}" runs inside a session; send a "sessionId" with the call.`
                );
            }

            try {
                const result = await store.callTool(sessionId, name, body.parameters as never);
                return { kind: 'json', status: 200, body: successfulToolResult(result, started) };
            } catch (error) {
                // Unknown session (404), a busy session (409, run or another
                // manual call), and a core tool the session's harness does not
                // register (agentDelegate without subagents, 404) are REQUEST failures:
                // the client must be able to distinguish "did not run" from "ran
                // and failed".
                if (error instanceof SessionError) throw error;

                // A tool that ran and threw is data, exactly like a throwing
                // catalogue tool below.
                const payload: ToolCallResult = {
                    ok: false,
                    // R13: the error text is bounded by the shared 64 KiB cap, so a
                    // commandRun failure that dumps a build log cannot bloat the HTTP
                    // body either.
                    error: { message: boundErrorMessage(error) },
                    durationMs: Date.now() - started
                };
                return { kind: 'json', status: 200, body: payload };
            }
        }

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
            // R13: the direct runner now validates its arguments with the SAME
            // resolver the model and manual executeTool paths use, in 'direct' mode.
            // That keeps both documented shapes working — the legacy unwrapped value
            // (`["a.txt"]`) and the schema wrapper (`{ "paths": ["a.txt"] }`) — and
            // rejects a wrong type with a readable tool error instead of an
            // implementation crash.
            //
            // `parameters: null` is normalized to `{}` first: the wire sends null for
            // an empty argument box, and the empty wrapper is documented as valid
            // (see schema-validation.ts). Without this, a null argument box would be
            // schema-invalid even though it means "no arguments".
            const raw = body.parameters === null ? {} : body.parameters;
            const parameters = resolveToolParameters(entry.parameters, raw, 'direct');
            const result = await entry.tool(parameters as never);
            return { kind: 'json', status: 200, body: successfulToolResult(result, started) };
        } catch (error) {
            const payload: ToolCallResult = {
                ok: false,
                error: { message: boundErrorMessage(error) },
                durationMs: Date.now() - started
            };
            return { kind: 'json', status: 200, body: payload };
        }
    };

    // POST /sessions/:id/messages — validate first, then hand back a stream. The
    // adapter decides how to write frames; the dispatcher owns cancellation:
    // aborting `signal` cancels THIS legacy run exactly like the Node
    // response-close path.
    //
    // RACE NOTE (T12): cancellation is passed INTO store.run as `signal`, never by
    // calling store.cancel(id) from a listener here. A listener on this route would
    // outlive the run's gate: after the run finishes and the pump starts a QUEUED
    // task, a still-registered abort would cancel that different task. The store
    // forwards the signal to its own controller and removes the forwarder before
    // releasing the gate (executeTurn), so identity is exact.
    const runSessionRoute = (
        id: string,
        input: string,
        attachments: HarnessAttachment[]
    ): HarnessApiResult => {
        // Validate before a status line is sent, so a busy session can still
        // answer with a normal JSON error (409) rather than an SSE failure frame.
        store.assertRunnable(id);

        return {
            kind: 'stream',
            start: async (emit, signal) => {
                // A disconnect between dispatch and stream opening leaves nothing
                // to run: an already-aborted signal means the client is gone.
                if (signal.aborted) return;

                try {
                    await store.run(id, input, emit, { signal }, attachments);
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
                        // Stream closed; the store has already settled the turn.
                    }
                }
            }
        };
    };

    // GET /sessions/:id/events — the queue watch stream (R4).
    //
    // Unlike POST /messages, this stream does NOT own execution: the pump runs
    // regardless of who is listening, and a submit is a 202 rather than a stream.
    // A disconnect therefore only unsubscribes — it never aborts the run, which is
    // why `signal` here is used for cleanup only (see the `start` body).
    //
    // Frame contract:
    //   1. one `snapshot` immediately (complete state, including queueDepth);
    //   2. `turn` upserts when a turn is queued, starts, and reaches a terminal
    //      status (same id/index every time, so a client replaces by id);
    //   3. `event` frames while a turn runs, each naming its turnId;
    //   4. one final `snapshot` when the queue drains (or after reset).
    //
    // ORDERING: every frame goes through ONE promise chain (`tail`), snapshot first.
    // publish() never awaits its watchers, so without this chain two async writes
    // could overlap and a later frame could complete before an earlier one. The
    // chain also bounds a slow observer: once more than MAX_WATCH_BACKLOG writes are
    // pending, the observer is dropped (stream ended) instead of growing memory —
    // and because publish() never waits, dropping can never stall the task pump.
    const MAX_WATCH_BACKLOG = 1024;

    const watchSessionRoute = (id: string): HarnessApiResult => {
        // 404 before a status line, exactly like GET /sessions/:id.
        store.get(id);

        return {
            kind: 'stream',
            start: async (emit, signal) => {
                // Resolved by the client disconnect, by the session being removed,
                // or by this stream dropping a slow observer. Either way it ends
                // WITHOUT touching the pump.
                let finish!: () => void;
                const finished = new Promise<void>((resolve) => {
                    finish = resolve;
                });

                // Frames published between registration and the first chain entry
                // (the snapshot) are buffered and appended right after it, so the
                // snapshot is always the first frame and no frame is lost.
                let ready = false;
                let ended = false;
                let abandoned = false;
                let pendingWrites = 0;
                const buffered: SessionStreamItem[] = [];

                // Serialized writer: each item is written only after the previous
                // write settled, so backpressure cannot reorder frames.
                let tail: Promise<void> = Promise.resolve();

                const append = (item: SessionStreamItem): void => {
                    if (ended) return;

                    pendingWrites += 1;

                    if (pendingWrites > MAX_WATCH_BACKLOG) {
                        // Slow/dead consumer: drop it rather than buffer forever.
                        // Do not await the stalled tail below; the adapter ends the
                        // response when start() returns.
                        abandoned = true;
                        ended = true;
                        finish();
                        return;
                    }

                    const written = tail.then(() => emit(item));

                    tail = written.then(
                        () => {
                            pendingWrites -= 1;
                        },
                        () => {
                            // The write failed (client vanished). End this stream;
                            // the task is untouched.
                            pendingWrites -= 1;
                            ended = true;
                            finish();
                        }
                    );
                };

                let watched: SessionWatch | undefined;
                try {
                    // watch() captures the snapshot atomically with registration.
                    // The watcher callback is SYNCHRONOUS on purpose: frames are
                    // queued in publish() order, not in resolution order.
                    watched = store.watch(
                        id,
                        (item) => {
                            if (!ready) {
                                buffered.push(item);
                                return;
                            }

                            append(item);
                        },
                        () => {
                            // remove()/dispose(): the session is gone.
                            ended = true;
                            finish();
                        }
                    );
                } catch {
                    // Removed between dispatch and stream open: nothing to watch.
                    return;
                }

                if (watched === undefined) return;

                const onAbort = (): void => {
                    // Unsubscribe only. Never store.cancel(): the task outlives
                    // this browser by design.
                    ended = true;
                    finish();
                };

                signal.addEventListener('abort', onAbort, { once: true });
                if (signal.aborted) finish();

                // Snapshot first, then every buffered frame, then live frames — all
                // through the same chain, in this exact order.
                append({ type: 'snapshot', session: watched.snapshot });
                ready = true;

                for (const item of buffered.splice(0)) {
                    append(item);
                }

                try {
                    await finished;
                    if (!abandoned) await tail;
                } finally {
                    ready = false;
                    ended = true;
                    signal.removeEventListener('abort', onAbort);
                    watched.unsubscribe();
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
            // catalogue language while standalone clients keep the old name. Only
            // the canonical `/harnesses` mount accepts writes (POST/PATCH): an
            // alias must not become a second, undocumented mutation surface.
            if (head === 'harnesses' && segments.length === 1) {
                if (method === 'GET') {
                    const index: HarnessIndex = {
                        harnesses: describeAll(),
                        defaults,
                        agents: agentList()
                    };
                    return { kind: 'json', status: 200, body: index };
                }

                if (method === 'POST') {
                    const body = requireObjectBody<CreateHarnessRequest>(
                        await readBody<CreateHarnessRequest>()
                    );

                    // Reject instruction/provider/tool fields outright: only a
                    // trusted agent id is a valid selection.
                    requireKnownFields(body, CREATE_HARNESS_FIELDS);

                    // Semantic validation (known agents, duplicate ids, reserved
                    // names, title bounds) belongs to the registry, which throws a
                    // HarnessRegistryError with the right status.
                    const preset = registry.create({
                        name: body.name,
                        ...(body.title === undefined ? {} : { title: body.title }),
                        ...(body.description === undefined ? {} : { description: body.description }),
                        primary: body.primary,
                        ...(body.subagents === undefined ? {} : { subagents: body.subagents }),
                        // Per-agent model overrides (R9). Shape (object of strings)
                        // is the registry's semantic validation, not this layer's:
                        // it knows the final member set and the id bounds.
                        ...(body.agentModels === undefined
                            ? {}
                            : { agentModels: body.agentModels })
                    });

                    // R3b: a created harness is durable before the 201. This is a
                    // no-op when the host runs in memory.
                    store.persistRegistry();

                    return {
                        kind: 'json',
                        status: 201,
                        body: { harness: describeHarness(preset, catalogue) }
                    };
                }

                throw new HttpError(405, `Use GET or POST for ${mount}/harnesses.`);
            }

            if (head === 'presets' && segments.length === 1) {
                if (method !== 'GET') throw new HttpError(405, `Use GET for ${mount}/presets.`);

                const index: HarnessIndex = {
                    harnesses: describeAll(),
                    defaults,
                    agents: agentList()
                };
                return { kind: 'json', status: 200, body: index };
            }

            // PATCH /harnesses/:name — change any harness's metadata or agent
            // routing. Registry changes affect FUTURE sessions only; an existing
            // session keeps its captured preset and descriptor.
            if (head === 'harnesses' && segments.length === 2) {
                if (method !== 'PATCH') {
                    throw new HttpError(405, `Use PATCH for ${mount}/harnesses/:name.`);
                }

                const body = requireObjectBody<UpdateHarnessRequest>(
                    await readBody<UpdateHarnessRequest>()
                );

                requireKnownFields(body, UPDATE_HARNESS_FIELDS);

                if (UPDATE_HARNESS_FIELDS.every((field) => body[field] === undefined)) {
                    throw new HttpError(
                        400,
                        `A patch must change at least one of: ${UPDATE_HARNESS_FIELDS.join(', ')}.`
                    );
                }

                const preset = registry.update(first, {
                    ...(body.title === undefined ? {} : { title: body.title }),
                    ...(body.description === undefined ? {} : { description: body.description }),
                    ...(body.primary === undefined ? {} : { primary: body.primary }),
                    ...(body.subagents === undefined ? {} : { subagents: body.subagents }),
                    // Present = REPLACE the override map; absent = keep it (minus
                    // members the patch just removed, which the registry drops).
                    ...(body.agentModels === undefined
                        ? {}
                        : { agentModels: body.agentModels })
                });

                // R3b: persist the patched registry before answering. An existing
                // session keeps its frozen preset, so this only affects future ones.
                store.persistRegistry();

                return {
                    kind: 'json',
                    status: 200,
                    body: { harness: describeHarness(preset, catalogue) }
                };
            }

            // GET /agents — the trusted agent registry. Values are catalogue data
            // (src/agents); no client input reaches this list.
            if (head === 'agents' && segments.length === 1) {
                if (method !== 'GET') throw new HttpError(405, `Use GET for ${mount}/agents.`);
                return { kind: 'json', status: 200, body: { agents: agentList() } };
            }

            if (head === 'models' && segments.length === 1) {
                if (method !== 'POST') throw new HttpError(405, `Use POST for ${mount}/models.`);
                return await listModelsRoute(readBody);
            }

            if (head === 'tools') {
                if (segments.length === 1) {
                    if (method !== 'GET') throw new HttpError(405, `Use GET for ${mount}/tools.`);
                    return { kind: 'json', status: 200, body: toolIndex(toolEntries()) };
                }

                // GET /tools/bootstrap — the same document as GET /tools, named for
                // the client that synchronises its tool list from the bootstrap
                // payload. An alias, not a second catalogue: one projection decides
                // what a tool is.
                if (segments.length === 2 && first === 'bootstrap') {
                    if (method !== 'GET') {
                        throw new HttpError(405, `Use GET for ${mount}/tools/bootstrap.`);
                    }
                    return { kind: 'json', status: 200, body: toolIndex(toolEntries()) };
                }

                if (segments.length === 2) {
                    if (method !== 'POST') throw new HttpError(405, 'Use POST to call a tool.');
                    return await callToolRoute(first, readBody);
                }

                // POST /tools/:name/call — the verb-named alias of the route above.
                // Both spellings reach the same dispatcher, so a client that reads
                // "call a tool" as a `/call` suffix (the wording of the R8 contract)
                // is not answered with a 404 for a request the server understands.
                // The canonical route stays the short one.
                if (segments.length === 3 && second === 'call') {
                    if (method !== 'POST') {
                        throw new HttpError(405, `Use POST for ${mount}/tools/:name/call.`);
                    }
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

                    // PATCH /sessions/:id — the ONE live mutation of an existing
                    // session: retarget an agent's model without rebuilding the
                    // harness or touching the frozen definition. Unlike the manual
                    // tool routes this is allowed while a run streams (see
                    // SessionStore.setAgentModels); nothing is aborted.
                    //
                    // Envelope matches GET /sessions/:id exactly: `{ session }`.
                    if (method === 'PATCH') {
                        const body = requireObjectBody<UpdateSessionRequest>(
                            await readBody<UpdateSessionRequest>()
                        );

                        // Same policy as the harness writes: only whitelisted
                        // fields, and a patch that names none is a 400 rather than
                        // a silent no-op. Shape/agent/model-id validation of the map
                        // itself belongs to the store, which knows the members.
                        requireKnownFields(body, SESSION_PATCH_FIELDS);

                        if (body.agentModels === undefined) {
                            throw new HttpError(
                                400,
                                `A patch must change at least one of: ${SESSION_PATCH_FIELDS.join(', ')}.`
                            );
                        }

                        return {
                            kind: 'json',
                            status: 200,
                            body: { session: store.setAgentModels(first, body.agentModels) }
                        };
                    }

                    if (method === 'DELETE') {
                        if (!store.remove(first)) throw new HttpError(404, `Unknown session "${first}".`);
                        return { kind: 'json', status: 200, body: { deleted: true } };
                    }

                    throw new HttpError(405, `Use GET, PATCH or DELETE for ${mount}/sessions/:id.`);
                }

                if (segments.length === 3) {
                    // POST /sessions/:id/tasks — the server-queued submit (R4).
                    //
                    // 202 `{ session, turn }`: the turn exists immediately with
                    // status 'queued' and a stable id/index, and the server pump
                    // runs it even if this client (or any browser) disconnects.
                    // Validation/trimming/cap live in the store (400/413/429) so
                    // this route and the legacy /messages route cannot disagree.
                    if (second === 'tasks') {
                        if (method !== 'POST') throw new HttpError(405, 'Use POST to submit a task.');

                        const body = requireObjectBody<SubmitTaskRequest>(
                            await readBody<SubmitTaskRequest>()
                        );
                        if (typeof body.input !== 'string') {
                            throw new HttpError(400, 'A task must be a string.');
                        }

                        // Attachments are a trailing store argument (T3); the store
                        // validates them (400/413/415) before the queued turn exists.
                        const submitted = store.enqueue(first, body.input, body.attachments);

                        return {
                            kind: 'json',
                            status: 202,
                            body: { session: submitted.session, turn: submitted.turn }
                        };
                    }

                    // GET /sessions/:id/events — watch the queue. This is a
                    // WATCHER stream: disconnecting unsubscribes, never cancels.
                    if (second === 'events') {
                        if (method !== 'GET') {
                            throw new HttpError(405, `Use GET for ${mount}/sessions/:id/events.`);
                        }

                        return watchSessionRoute(first);
                    }

                    if (second === 'messages') {
                        if (method !== 'POST') throw new HttpError(405, 'Use POST to submit a task.');

                        const body = requireObjectBody<SubmitMessageRequest>(
                            await readBody<SubmitMessageRequest>()
                        );
                        if (typeof body.input !== 'string') {
                            throw new HttpError(400, 'A task must be a string.');
                        }

                        // Validate media BEFORE opening the SSE response: an invalid
                        // or oversized clip must answer a real 400/413/415 JSON body,
                        // not a failed frame on a stream that already started. The
                        // store validates the same copies again before creating the
                        // turn, so a route bypass cannot admit unvalidated bytes.
                        const attachments = validateAttachmentsForSubmit(body.attachments);

                        const input = body.input.trim();
                        // Empty text is allowed only when a clip carries the task.
                        if (input.length === 0 && attachments.length === 0) {
                            throw new HttpError(400, 'A task cannot be empty.');
                        }

                        return runSessionRoute(first, input, attachments);
                    }

                    if (second === 'reset') {
                        if (method !== 'POST') throw new HttpError(405, 'Use POST to reset a session.');
                        return { kind: 'json', status: 200, body: { session: store.reset(first) } };
                    }

                    if (second === 'cancel') {
                        if (method !== 'POST') throw new HttpError(405, 'Use POST to cancel a run.');

                        // Optional body: `{ all: true }` also drops the queued
                        // backlog (the UI Stop button). Absent/`{}` keeps the
                        // legacy "cancel the active run only" behaviour and the
                        // exact `{ cancelled }` response.
                        const body = requireObjectBody<CancelSessionRequest>(
                            await readBody<CancelSessionRequest>()
                        );
                        requireKnownFields(body, SESSION_CANCEL_FIELDS);

                        if (body.all !== undefined && typeof body.all !== 'boolean') {
                            throw new HttpError(400, '`all` must be a boolean when present.');
                        }

                        // Look the session up first so an unknown id is a 404 even
                        // when there is nothing to cancel.
                        store.get(first);

                        return {
                            kind: 'json',
                            status: 200,
                            body: { cancelled: store.cancel(first, { all: body.all === true }) }
                        };
                    }
                }

                if (segments.length === 5 && second === 'actions' && segments[4] === 'answer') {
                    // POST /sessions/:id/actions/:requestId/answer (N4) — the ONLY
                    // owner-answer surface. Deliberately allowed while the session
                    // is busy: the active run is awaiting exactly this answer, so a
                    // 409 busy gate would make questions unanswerable.
                    if (method !== 'POST') {
                        throw new HttpError(
                            405,
                            `Use POST for ${mount}/sessions/:id/actions/:requestId/answer.`
                        );
                    }

                    const body = requireObjectBody<AnswerActionRequest>(
                        await readBody<AnswerActionRequest>()
                    );

                    // One field only. Unknown keys are a client bug: accepting them
                    // would silently ignore a `source`/`answer` the caller believed
                    // was authoritative.
                    requireKnownFields(body, ANSWER_ACTION_FIELDS);

                    if (body.choice === undefined) {
                        throw new HttpError(400, 'An action answer requires a `choice`.');
                    }

                    // The store re-validates the choice against the recorded
                    // request (option id membership, custom text bounds) and
                    // resolves the pending promise exactly once. 400/404/409 come
                    // from SessionError and are mapped by the outer catch.
                    store.answerAction(first, segments[3], body.choice);

                    const payload: AnswerActionResult = { ok: true };
                    return { kind: 'json', status: 200, body: payload };
                }
            }

            throw new HttpError(404, `Unknown API route: ${method} ${pathname}`);
        } catch (error) {
            // Every known failure becomes a JSON result; adapters never need to
            // replicate the status mapping. An unexpected error is still a 500
            // with the same `{ error: { message } }` envelope as before.
            // SettingsError carries a 400 for the shared settings caps/type checks;
            // HarnessRegistryError carries 400/404/409 for create/patch (no 403:
            // no harness is read-only, R20.1).
            const status =
                error instanceof HttpError ||
                error instanceof SessionError ||
                error instanceof SettingsError ||
                error instanceof HarnessRegistryError
                    ? error.status
                    : 500;
            return { kind: 'json', status, body: { error: { message: messageOf(error) } } };
        }
    };
};

// Maximum bytes accepted by the Node adapter's manual body reader. Exported so
// the adapter and its tests share one number instead of copying a literal.
export const MAX_API_BODY_BYTES = MAX_BODY_BYTES;

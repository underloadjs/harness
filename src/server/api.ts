// The canonical harness HTTP API (T13).
//
// ONE transport-neutral dispatcher owns the whole REST surface named by the target
// contract: `src/server/harness.swagger.yaml`, mirrored verbatim by
// `src/shared/harness-api.ts` (deep import - the shared barrel collides). It knows nothing
// about Node's IncomingMessage, Hono's Context, or a WebSocket writer; the adapters
// (./handler.ts, ./service.ts, ./endpoint/**) supply a request object and send what comes
// back.
//
// WHAT THIS SURFACE IS
// --------------------
//   - One mount: `HARNESS_API_ROOT` = `/v1/harness`. The legacy `/api` mount, the
//     `/presets`, `/views`, `/tools/bootstrap`, `/tools/:name/call`, and
//     `/sessions/:id/messages` aliases, and BOTH old SSE routes are gone: a client that
//     wants live updates opens `/v1/harness/stream` (the realtime owner's transport), and a
//     client that wants state pages through these routes.
//   - A boot document that is CONSTANT SIZE: identity, links, capabilities, limits, epoch,
//     server time. Catalogues, defaults, and sessions are each their own bounded read.
//   - Every collection is paged (`limit` default 25 max 100, opaque `cursor`), and every
//     page stamps the collection `revision` of the shared hub (./api-events.ts).
//   - Heavy children are lazy by construction: turns, threads, events, transcripts, one
//     display tree, one step, one block, one attachment. No route assembles a session
//     aggregate, so no route calls `store.list()`, `store.get()`, `snapshot()`, or
//     `copyTurns()` (./api-reads.ts is the only reader of live records).
//   - Writes answer SLIM RECEIPTS (`TaskReceipt`, `ResetSessionResult`, `CancelSessionResult`,
//     `DeleteSessionResult`, `SessionToolRegistrationResult`, `TranscriptWriteReceipt`, …),
//     never the mutated aggregate: the receipt says what moved plus the new `revision` and
//     the links to re-read, and the stream carries the content.
//
// NAMING (contract rule, src/shared/harness-api.ts header)
// --------------------------------------------------------
// Request fields and REST response resources are snake_case (`thread_id`,
// `agent_models`, `queue_depth`). The display subtree and the domain payloads
// (TurnSummary's display fields, TurnSection, ContextBlock, HarnessMessage, HarnessUsage,
// HarnessActionRequest, HarnessAttachment, ToolMediaDescriptor) are the camelCase models the
// projector and the domain already emit, copied verbatim - so neither side renames on the
// way out. This file is where the two spellings meet: `snake` request fields are translated
// once, at the edge, into the camelCase arguments the store already accepts.
//
// BODY POLICY
// -----------
//   - a body that is read must be a JSON OBJECT; `null`, arrays, strings, and numbers are
//     400, and an unknown property is 400 naming it (never ignored, so a client is never
//     left believing it changed something);
//   - `null` is meaningful in exactly three places, each stated below: `title`,
//     `agent_models[...]`-free session fields (`title: null` clears), and `settings.*` on
//     `/config` (reset to the shipped default);
//   - byte bounds live in the adapters, which call `bodyLimitFor` so one route cannot get a
//     different cap per mount: 1 MB everywhere, the shared 16 MiB submit cap on
//     `POST /sessions/:id/tasks` only (raw base64 rides inside that JSON body).
//
// STATUS POLICY
// -------------
//   - a tool that EXECUTED and reported failure answers 200 `{ ok: false, error }` - the
//     invocation succeeded and the tool answered. Only a call the server could not make at
//     all is an HTTP error (404 unknown name, 403 scope, 409 busy, 413 body, 500 internal);
//   - a capability this deployment cannot perform answers 403 naming the capability, and the
//     same fact is stated in the boot document's `capabilities` map, so a client hides the
//     affordance instead of discovering the refusal by clicking it. Nothing is advertised as
//     working that is not implemented (see `CAPABILITY_GAPS` below);
//   - a lifecycle guard (busy session cannot reset, running conversation cannot be deleted
//     or re-registered, a manual call cannot race a run) is a 409 from the store, mapped by
//     the outer catch. It is NOT an optimistic lock - the one lock in this contract is the
//     transcript's `if_revision`, refused with 409 naming the current revision. A SECOND 409
//     class is stated by this file rather than the store: a session whose harness template
//     replays a scripted or injected factory answers 409 BEFORE a roster write, because that
//     durable record cannot rebuild a session-local team (T28, `assertDurableRoster`).
//
// REVISIONS AND EPOCH
// -------------------
// Every revision printed here comes from ONE hub per API instance (./api-events.ts), keyed
// by `(StreamResourceKind, id)` exactly like `WsRevisionRecord`. Counters are in-memory and
// restart with the process; the contract's epoch policy makes that legal because a revision
// is only ever compared against another record carrying the SAME epoch.
//
// CAPABILITY_GAPS (stated, not hidden)
// ------------------------------------
// This map used to name the domain features the runtime and the store did not have: a
// session-level agent binding (create/remove), a per-binding instruction override the runtime
// could re-seed, the global agent-override layer, and session tool removal. T19 closed the
// agent-override layer (./harnesses/agent-state.ts, durable in `<root>/harness/agents.json`)
// and `toolManage`'s enable/disable/remove; T27 closed the last two, in the same shape the
// contract already described — `harness.addAgent`/`removeAgent`/`setAgentInstruction` in the
// runtime, `addSessionAgent`/`removeSessionAgent`/`setSessionAgentInstruction` in the store,
// and the session's own preset/definition copies as the durable record of the binding.
//
// What that means for a client: nothing is advertised that this build cannot do, and a 403
// from this dispatcher is now always a POLICY refusal that names its reason (a constructed
// tool with no captured revision, an atomic replace-on-create, a deployment with no live
// stream) rather than an unimplemented operation. The remaining structural limits are stated
// by the routes that enforce them: a binding must use its profile's own name, the primary is
// not detachable at session scope, and a session with live or queued work answers 409 rather
// than resetting history to make a roster change.
//
// Cross-references:
//   - src/harness.ts            — addAgent / removeAgent / setAgentInstruction and their guards
//   - ./sessions.ts             — the binding writes, their idle gate, and their rollback
//   - ./harnesses/toolbox.ts    — `agentConfigurationFromProfile`, the shared composition
//
// T19 CLOSED two of the three gaps this file used to state:
//   - `agent_writes`: the global agent-override layer lives in ./harnesses/agent-state.ts
//     (catalogue + overlay, never a mutation of the shipped profiles), is durable in
//     `<root>/harness/agents.json`, and rolls back with the registry's own
//     snapshot/restore commit unit;
//   - `session_tool_removal`: `toolManage` grew `enable`/`disable`/`remove`
//     (src/harness.ts), so an enabled switch, an unregister, and a metadata-only PATCH are
//     real runtime writes now.
//
// Cross-references:
//   - ../shared/harness-api.ts   — DTOs, HARNESS_ROUTES, HARNESS_PATH_TEMPLATES, limits, capabilities
//   - ./api-events.ts            — the hub: epoch, revisions, publish/subscribe/baseline (realtime owner)
//   - ./api-reads.ts             — bounded projections of the live store records
//   - ./api-paging.ts            — the one limit/cursor/page implementation
//   - ./api-errors.ts            — HttpError (re-exported here for ./handler.ts and ./index.ts)
//   - ./sessions.ts              — SessionStore: the writes below, and the live records above
//   - ./config.ts                — the credential rule (mergeSettings) and the deployment runtime block

import {
    HARNESS_API_ROOT,
    HARNESS_EPOCH_HEADER,
    HARNESS_PATH_TEMPLATES,
    HARNESS_REVISION_HEADER,
    HARNESS_SERVICE_CAPABILITIES,
    HARNESS_SERVICE_LIMITS
} from '../shared/harness-api';
import type {
    AgentProfileResponse,
    AgentSummaryPage,
    AnswerActionRequest,
    AnswerActionResult,
    AttachmentResponse,
    CancelSessionRequest,
    CancelSessionResult,
    CancelThreadResult,
    CommandPage,
    CreateHarnessRequest,
    CreateSessionAgentRequest,
    CreateSessionRequest,
    CreateSessionThreadRequest,
    CreateSessionToolRequest,
    DeleteAgentResult,
    DeleteHarnessResult,
    DeleteSessionAgentResult,
    DeleteSessionResult,
    DeleteSessionToolResult,
    DeleteThreadResult,
    GlobalConfigDocument,
    GlobalConfigUpdateRequest,
    HarnessCardPage,
    HarnessDefinitionResponse,
    HarnessInstructionIndexResponse,
    HarnessInstructionTextResponse,
    ModelDiscoveryRequest,
    ModelIndex,
    PendingActionListResponse,
    // T7: the segment inclusion write's body (the one field a context segment has).
    PatchTurnBlockRequest,
    PluginDetailResponse,
    PluginSetting,
    PluginSettingsUpdate,
    PluginSummary,
    ProviderDefaults,
    QueuedTaskPage,
    ResetSessionResult,
    ServiceCapabilities,
    ServiceInfo,
    SessionAgentListResponse,
    SessionAgentResponse,
    SessionDefinitionResponse,
    SessionInstructionTextResponse,
    SessionResponse,
    SessionSummaryPage,
    SessionToolPage,
    SessionToolRegistrationResponse,
    SessionToolResponse,
    SessionToolSourceResponse,
    SubmitTaskRequest,
    TaskReceipt,
    ThreadResponse,
    ThreadSummaryPage,
    // R3: the global tool switch (the identified read a PATCH answers with, and its body).
    ToolDetailResponse,
    ToolSettingsUpdate,
    TranscriptDocumentResponse,
    TranscriptMessagePage,
    TranscriptMetadataResponse,
    TranscriptWriteReceipt,
    TurnBlockDetailResponse,
    // T7: the receipt the segment inclusion write answers with.
    TurnBlockWriteReceipt,
    TurnDisplayResponse,
    TurnEventPage,
    TurnResponse,
    TurnStepDetailResponse,
    TurnSummaryPage,
    UpdateAgentRequest,
    UpdateHarnessRequest,
    UpdateSessionAgentRequest,
    UpdateSessionRequest,
    UpdateThreadTranscriptRequest,
    UsageByThread
} from '../shared/harness-api';
import type { StreamResourceKind, WsUpdateKind } from '../shared/harness-stream';
import type { HarnessAttachment, HarnessMessage } from '../harness';
// T5 (R2/R3): the plugin catalogue types (domain models, re-exported by the library root) and
// the status-carrying error the settings store throws at the write edge.
import type { HarnessPluginMetadata, HarnessPluginSettingDescriptor } from '../harness';
import { unwrapToolResult, toolMediaDescriptors, boundToolResult, resolveToolParameters } from '../harness';
import { isInstanceOf, toErrorInfo } from '../util';
import { listModels, ModelListError } from '../transport/models';
import type { ModelListConfiguration } from '../transport/models';
import type { RunnerSettings } from './harnesses/types';
import { createToolCatalogue, createCoreToolEntries, createHarnessRegistry, describeHarness } from './harnesses';
import type { CatalogueEntry, HarnessPreset, HarnessRegistry, ToolCatalogue } from './harnesses';
import { coreToolNames } from './harnesses/toolbox';
// T39: the SAME settings bounds `mergeSettings` enforces (./config.ts:140-141) travel here so
// `PATCH /config` refuses an oversize value instead of parking it in `defaults`.
import {
    DEFAULT_RUNTIME_CONFIGURATION,
    loadRuntimeConfiguration,
    MAX_BASE_URL_LENGTH,
    MAX_MODEL_LENGTH,
    mergeSettings,
    SettingsError
} from './config';
import type { ProviderCredential, ServerRuntimeConfiguration } from './config';
import { HarnessRegistryError } from './harnesses/registry';
// T19: the global agent overlay's error type (status-carrying, like the registry's) and the
// durable overlay file. The dispatcher never builds the layer itself: the registry owns it,
// and this file only commits what the registry changed.
import { AgentStateError } from './harnesses/agent-state';
import type { AgentProfilePatch } from './harnesses/agent-state';
import { writeHarnessAgentRecords } from './persistence';
import { MAX_SUBMIT_BODY_BYTES } from '../shared/attachments';
import { SessionError, SessionStore, recordedStreamText, validateAttachmentsForSubmit } from './sessions';
import type { EnqueuedTask, SessionRecord, ThreadLaneInfo } from './sessions';
// R7 (T4b): the display-route inclusion stamp writes the bar's own field, so it is typed with the
// bar's own model (the fold's output type, which is what `projector.display()` returns).
import type { ContextBlock, TurnSection } from '../shared/turn-display';
// Issue 0005 (C): the seed on `POST /sessions` is validated by the ONE transcript reader the
// runtime and snapshot restore already enforce (`readHarnessMessages`, src/core/snapshot.ts), and
// it lands in the entry agent's DEFAULT conversation, whose id prefix is `THREAD_AGENT_PREFIX`
// (src/core/thread.ts). `src/server/sessions.ts:216` imports this same pair, so the API layer and
// the store cannot drift onto two different transcript validators or two spellings of that id.
import { readHarnessMessages, THREAD_AGENT_PREFIX } from '../core';
// T5 (R2/R3): the plugin settings store's status-carrying failure (404 unknown plugin, 400
// unknown key / mistyped / out-of-range value). The store itself is reached through
// `store.pluginSettings` (the PROCESS/TEMPLATE scope) and `requireSession(id).plugins` (R4's
// per-session scope), so this dispatcher never constructs a second one.
import { HarnessPluginSettingsError } from './plugins';
// R4: the store TYPE, because one row builder and one page builder serve both scopes — they
// take the scope's store as a parameter rather than closing over the process one (see
// `pluginRowOf`, and the session pair in the route table).
import type { HarnessPluginSettingsStore } from './plugins';
// R3: the global tool switch's status-carrying error (400 blank name), mapped exactly like
// its plugin sibling below. Every listed tool — core tools included — is switchable, so the
// store never refuses a name for being harness-owned.
import { HarnessToolSettingsError } from './tool-settings';
import type { HarnessIndex, SessionStreamItem, SessionTurn, SessionViewStreamItem } from './protocol';
import { HttpError, capabilityDenied } from './api-errors';
import { HARNESS_RUNTIME_EPOCH, createHarnessEventHub, resourceKeyOf } from './api-events';
import type { HarnessEventHub } from './api-events';
import { decodeCursor, encodeCursor, pageMeta, resolveLimit, slicePage } from './api-paging';
import {
    agentModelsOf,
    agentProfileOf,
    agentSummaryOf,
    commandRowsOf,
    createdToolNames,
    pendingActionRowOf,
    harnessCardOf,
    harnessDefinitionOf,
    instructionSummaryOf,
    instructionTextOf,
    promptPreview,
    queueRowsOf,
    recordsDeltaOf,
    recordsSnapshotOf,
    runtimeSettingsOf,
    sessionAgentRowsOf,
    sessionDefinitionOf,
    sessionResourceOf,
    sessionStatePatchOf,
    sessionSummaryOf,
    sessionToolDetailOf,
    sessionToolRowsOf,
    sessionToolSourceOf,
    storedTypeOf,
    threadKey,
    threadResourceOf,
    threadRowOf,
    toolCallFailure,
    toolDetailOf,
    toolEntryOf,
    toolExecutionScopeOf,
    toolSummaryOf,
    transcriptMetadataOf,
    transcriptSignalOf,
    turnEventRowsOf,
    turnKey,
    turnResourceOf,
    turnRowOf,
    usageFoldOf,
    usagePatchOf
} from './api-reads';
import type { ReadContext } from './api-reads';

// ---------------------------------------------------------------------------
// Constants kept for the adapters (./handler.ts, ./service.ts, ./index.ts)
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 1_000_000;

/** The body cap every route except the submit route uses. */
export const MAX_API_BODY_BYTES = MAX_BODY_BYTES;

// T13 removed the second mount: standalone and service deployments serve the SAME
// canonical root. Both names stay exported (an adapter imports one of them by name today),
// and both are `/v1/harness`, so an adapter that still hands `STANDALONE_MOUNT` is speaking
// the truth. `/api` is gone as a network surface; a client asking for it gets a 404, not a
// redirect.
export const STANDALONE_MOUNT = HARNESS_API_ROOT;
export const SERVICE_MOUNT = HARNESS_API_ROOT;

/**
 * The capability names whose backing domain feature is missing (see the header). The map is
 * the statement, not the enforcement: a name in here is a route that answers 403 naming the
 * missing operation, and no `capabilities` entry advertises it.
 *
 * T19 removed `agent_writes` (the global agent-override layer is implemented and durable)
 * and `session_tool_removal` (`toolManage` grew `enable`/`disable`/`remove`).
 *
 * T27 removed the last two:
 *   - `session_agent_bindings` — `POST`/`DELETE /sessions/:id/agents(/:agent_id)` are real.
 *     The runtime grew `addAgent`/`removeAgent` (src/harness.ts), and the store rewrites the
 *     session's OWN preset and definition copies alongside the live roster, so a binding is
 *     durable inside the saved session record without touching any frozen registry entry;
 *   - `session_agent_instruction` — `harness.setAgentInstruction` re-seeds one member's
 *     leading system block and its reset baseline in place, so no committed history is
 *     rewritten to change a prompt, and the same override text is what the next restart
 *     composes from the profile.
 *
 * The map is therefore empty in this build: every advertised capability has a backing
 * implementation, and each remaining 403 in this file states a policy refusal (a tool with no
 * captured revision, an atomic replace-on-create, a deployment without a live stream) rather
 * than an unimplemented operation.
 */
export const CAPABILITY_GAPS = {} as const;

// ---------------------------------------------------------------------------
// Model catalogue retry (unchanged; ./models-retry.test.ts pins it)
// ---------------------------------------------------------------------------

// First attempt's budget; each retry doubles it (10s, 20s, ... ~85 min on the tenth).
const MODEL_LIST_TIMEOUT_MS = 10_000;
const MODEL_LIST_MAX_ATTEMPTS = 10;

// Only `ModelListError` of kind 'request' or 'response' retries: a configuration error
// cannot be fixed by asking again, and any other thrown value is a programming error that
// must surface unchanged. Every attempt gets a FRESH controller and timer, cleared in
// `finally`; the growing window IS the policy (there is no sleep between attempts).
export const listModelsWithRetry = async (configuration: ModelListConfiguration): Promise<string[]> => {
    for (let attempt = 0; attempt < MODEL_LIST_MAX_ATTEMPTS; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS * 2 ** attempt);

        try {
            return await listModels({
                baseURL: configuration.baseURL,
                apiKey: configuration.apiKey,
                signal: controller.signal
            });
        } catch (error) {
            if (!(error instanceof ModelListError) || error.kind === 'configuration') throw error;
            if (attempt === MODEL_LIST_MAX_ATTEMPTS - 1) throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    throw new Error('Model list retry loop exited without a result.');
};

// ---------------------------------------------------------------------------
// Adapter contract
// ---------------------------------------------------------------------------

/** An error with an HTTP status (./api-errors.ts; re-exported for existing importers). */
export { HttpError } from './api-errors';

// What a transport adapter hands the dispatcher. `pathname` keeps the mount prefix so an
// error message can quote the URL the caller actually used.
export type HarnessApiRequest = {
    method: string;
    pathname: string;
    // The prefix this API is mounted at. Canonical deployments pass
    // `HARNESS_API_ROOT`; routing is mount-relative, so links match the mount.
    mount: string;
    // Parsed JSON body, called ONLY by routes that need it (`{}` when the request carried
    // no body, matching the legacy `readJson` behaviour).
    readBody: <T>() => Promise<T>;
    // T13: the query string. Every paginated route reads `limit`/`cursor` plus its filters
    // from here, so an adapter that previously had no query channel must supply one;
    // absent means "no parameters" (a page-one default).
    //
    // Accepted shapes, all normalized by `queryOf`: a `URLSearchParams`, an absolute or
    // path-only `URL`/string, or a plain record of string/string-array values.
    searchParams?: URLSearchParams | URL | string | Record<string, string | string[]>;
    // Kept for source compatibility. The root document is the boot document on every
    // mount now, so this flag no longer changes behaviour.
    bootstrapRoot?: boolean;
};

/** Push a stream item to the client (the realtime transport's writer; REST routes never stream). */
export type HarnessApiEmit = (item: SessionStreamItem | SessionViewStreamItem) => void | Promise<void>;

/** A stream that has already passed validation (a status line may already be sent). */
export type HarnessApiStream = (emit: HarnessApiEmit, signal: AbortSignal) => Promise<void>;

// The dispatcher's answer. `json` is the shape every adapter already sends; `headers` is
// additive (an adapter that ignores it still works, one that forwards it emits the epoch and
// revision contract headers on every response). `stream` is retained for the realtime owner's
// transport reuse; no canonical REST route returns it.
export type HarnessApiResult =
    | { kind: 'json'; status: number; body: unknown; headers?: Record<string, string> }
    | { kind: 'stream'; start: HarnessApiStream };

export type HarnessApiOptions = {
    store: SessionStore;
    // Key-free provider defaults advertised to clients (the shipped, environment-resolved
    // values). `PATCH /config` overlays these in-process; see `globalSettings`.
    defaults: HarnessIndex['defaults'];
    // T28: the PRIVATE, credential-bearing provider settings of THIS process — the same
    // object the host hands the session store (./start.ts, ./runtime.ts). It exists because
    // `defaults` cannot carry a secret: `has_api_key` is an ADVERTISEMENT, not a credential,
    // and seeding an outbound provider request from it used to send the literal word
    // "configured" as the bearer token. Its `baseURL` is also the credential SCOPE: the key
    // may only travel to that provider (origin + base path), so a later `/config` base_url
    // patch moves where sessions go without moving someone's secret.
    //
    // Nothing in the REST surface serializes this option — no route echoes it, and `/config`
    // still answers `defaults` through `effectiveProviderDefaults()` (key-free). Supplied, it
    // is the AUTHORITATIVE statement about this process: `has_api_key` follows the real key
    // (`''` means no key, and the advertisement says so). Omitted, this API instance holds no
    // credential of its own: provider calls go out unauthenticated and the advertised
    // `has_api_key` keeps following `defaults.hasApiKey`, which is what a key-free front end
    // that never forwards the secret (or a test fixture) states.
    settings?: RunnerSettings;
    // Shared with the store, so a harness created through this API resolves for a session
    // created through the same instance.
    registry?: HarnessRegistry;
    // T19: the resolved durable database root, when this deployment has one. It is the
    // target of the GLOBAL agent overlay file (`<root>/harness/agents.json`), and the one
    // fact the agent DELETE receipt uses to say honestly whether a restart restores the
    // profile. Omitted means in-memory: every agent edit still works, and the receipt says
    // `restored_by_restart: true`.
    databaseRoot?: string;
    // Built by the host AFTER it loads `.env`, so a search key in the process environment is
    // captured here and not at import time.
    catalogue?: ToolCatalogue;
    // T13: the deployment runtime block reported read-only on `/config` and as
    // `runtime_execution` on a session. Defaults to `loadRuntimeConfiguration()` (the same
    // validated environment parse ./start.ts performs), so omitting it stays correct.
    runtime?: ServerRuntimeConfiguration;
    // T13: attach an existing hub (a host that also mounts the realtime transport must hand
    // BOTH surfaces the same hub, or a REST read and a stream frame can disagree).
    events?: HarnessEventHub;
    // T13: override the advertised capability booleans (a deployment that withholds a
    // capability hides the affordance instead of answering 403 on click).
    capabilities?: Partial<ServiceCapabilities>;
};

/**
 * The dispatcher, plus the hub the realtime owner integrates with:
 *
 *   `api.events` — epoch, `getRevision`, `bumpRevision`, `revisions`, `publish`,
 *                  `subscribe`, `baseline` (see ./api-events.ts)
 *
 * The type stays callable exactly like before, so `runtime.ts`/`service.ts`/`handler.ts`
 * keep constructing and invoking it unchanged.
 */
export type HarnessApi = ((request: HarnessApiRequest) => Promise<HarnessApiResult>) & {
    /** The shared revision/epoch/event hub this API publishes through. */
    events: HarnessEventHub;
    /** Convenience alias of `events.epoch` for an adapter stamping a header. */
    epoch: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const messageOf = (error: unknown): string => toErrorInfo(error).message;

/** Normalize the accepted query shapes into one `URLSearchParams`. */
const queryOf = (request: HarnessApiRequest): URLSearchParams => {
    const value = request.searchParams;

    if (value === undefined || value === null) return new URLSearchParams();

    if (value instanceof URLSearchParams) return value;

    if (typeof value === 'string') return new URLSearchParams(value.startsWith('?') ? value.slice(1) : value);

    if (value instanceof URL) return value.searchParams;

    const params = new URLSearchParams();

    for (const [key, entry] of Object.entries(value)) {
        if (Array.isArray(entry)) {
            for (const item of entry) params.append(key, item);
            continue;
        }

        if (entry !== undefined) params.append(key, String(entry));
    }

    return params;
};

/** One query parameter, trimmed; `undefined` when absent or empty. */
const paramOf = (query: URLSearchParams, name: string): string | undefined => {
    const value = query.get(name);

    if (value === null || value.trim().length === 0) return undefined;

    return value.trim();
};

/** An enum-valued filter: an unrecognized value is a 400 naming the parameter. */
const enumParamOf = <T extends string>(query: URLSearchParams, name: string, allowed: readonly T[]): T | undefined => {
    const value = paramOf(query, name);

    if (value === undefined) return undefined;

    if (!(allowed as readonly string[]).includes(value)) {
        throw new HttpError(400, `Query parameter "${name}" must be one of: ${allowed.join(', ')}.`);
    }

    return value as T;
};

/** Reject unknown properties instead of ignoring them (see BODY POLICY above). */
const requireKnownFields = (body: object, allowed: readonly string[]): void => {
    for (const key of Object.keys(body)) {
        if (!allowed.includes(key)) {
            throw new HttpError(400, `Unknown field "${key}". Allowed fields: ${allowed.join(', ')}.`);
        }
    }
};

const requireObjectBody = <T>(body: unknown, message = 'The request body must be a JSON object.'): T => {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new HttpError(400, message);
    }

    return body as T;
};

/** A route that takes no body must not consume one, but a body that IS sent must be an object. */
const readEmptyBody = async (request: HarnessApiRequest): Promise<void> => {
    // `readBody` is cheap for an adapter whose loader already parsed the body, and a route
    // documented as body-less still refuses a malformed one rather than ignoring it.
    const body: unknown = await request.readBody();

    if (body === undefined || body === null) return;

    if (typeof body !== 'object' || Array.isArray(body) || Object.keys(body as object).length > 0) {
        throw new HttpError(400, 'This route accepts no request body.');
    }
};

/** The snake_case `settings` block of a create/discovery body, translated for `mergeSettings`. */
const settingsInputOf = (
    settings: Record<string, unknown> | undefined,
    where: string
): Partial<RunnerSettings> | undefined => {
    if (settings === undefined) return undefined;

    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
        throw new HttpError(400, `"${where}.settings" must be an object.`);
    }

    requireKnownFields(settings, ['base_url', 'api_key', 'model']);

    const input: Partial<RunnerSettings> = {};

    if (typeof settings.base_url === 'string') input.baseURL = settings.base_url;
    else if (settings.base_url !== undefined && settings.base_url !== null) {
        throw new HttpError(400, `"${where}.settings.base_url" must be a string.`);
    }

    if (typeof settings.api_key === 'string') input.apiKey = settings.api_key;
    else if (settings.api_key !== undefined && settings.api_key !== null) {
        throw new HttpError(400, `"${where}.settings.api_key" must be a string.`);
    }

    if (typeof settings.model === 'string') input.model = settings.model;
    else if (settings.model !== undefined && settings.model !== null) {
        throw new HttpError(400, `"${where}.settings.model" must be a string.`);
    }

    return input;
};

/** Bound ONE manual tool value for the HTTP result (the shared 64 KiB model-facing cap). */
const boundToolValue = (value: unknown): unknown => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);

    if (text === undefined) return value;

    const bounded = boundToolResult(text);

    if (!bounded.truncated) return value;

    try {
        return JSON.parse(bounded.content);
    } catch {
        return bounded.content;
    }
};

const boundErrorMessage = (error: unknown): string => boundToolResult(messageOf(error)).content;

/**
 * The success envelope of one manual tool call: the branded `toolUi(...)` / `toolMedia(...)`
 * envelopes are peeled at the server boundary (a hand-built envelope cannot reach a client
 * unbounded), the content is bounded with the shared cap, and media travel as DESCRIPTORS -
 * never base64, because a manual call has no transcript to attach bytes to.
 */
const successfulToolResult = (value: unknown, started: number) => {
    const unwrapped = unwrapToolResult(value);
    const panels = unwrapped.panels;
    const media = unwrapped.media;

    return {
        ok: true as const,
        result: boundToolValue(unwrapped.content),
        ...(panels === undefined || panels.length === 0 ? {} : { panels }),
        ...(media === undefined || media.length === 0 ? {} : { media: toolMediaDescriptors(media) }),
        duration_ms: Date.now() - started
    };
};

/** 404 for one missing subresource, worded so a client can tell WHICH id it got wrong. */
const missing = (what: string, id: string, inSession?: string): HttpError =>
    new HttpError(404, inSession === undefined ? `Unknown ${what} "${id}".` : `Unknown ${what} "${id}" in session "${inSession}".`);

// ---------------------------------------------------------------------------
// Path matching
// ---------------------------------------------------------------------------

// Every canonical route, relative to the API root, compiled from the GENERATED template
// table (`HARNESS_PATH_TEMPLATES`) so a route cannot drift from the spec: the keys are the
// generated ids and the patterns are the generated paths.
type RoutePattern = {
    id: keyof typeof HARNESS_PATH_TEMPLATES;
    // A literal segment, or `null` for a placeholder (whose name lives in `names`).
    segments: (string | null)[];
    names: string[];
};

// Split one generated template into its literal/placeholder segments. `{param}` braces are
// the ONLY matching syntax: the generated table is the spec's path list, so a route cannot
// drift from the contract by being typed out by hand here.
const compilePattern = (template: string): { segments: (string | null)[]; names: string[] } => {
    const names: string[] = [];
    const segments: (string | null)[] = [];

    for (const raw of template.slice(HARNESS_API_ROOT.length).split('/')) {
        if (raw.length === 0) continue;

        if (raw.startsWith('{') && raw.endsWith('}')) {
            segments.push(null);
            // Index-aligned with `segments`, so a match can read `names[index]` for the
            // segment it is capturing (a compact list of placeholders alone would shift).
            names.push(raw.slice(1, -1));
            continue;
        }

        segments.push(raw);
        names.push(raw);
    }

    return { segments, names };
};

const ROUTE_PATTERNS: RoutePattern[] = (Object.keys(HARNESS_PATH_TEMPLATES) as (keyof typeof HARNESS_PATH_TEMPLATES)[]).map(
    (id) => {
        const compiled = compilePattern(HARNESS_PATH_TEMPLATES[id]);

        return { id, segments: compiled.segments, names: compiled.names };
    }
);

/** Match a mount-relative path against the route table; returns the route id + params. */
const matchRoute = (
    segments: readonly string[]
): { id: keyof typeof HARNESS_PATH_TEMPLATES; params: Record<string, string> } | undefined => {
    for (const pattern of ROUTE_PATTERNS) {
        if (pattern.segments.length !== segments.length) continue;

        const params: Record<string, string> = {};
        let matched = true;

        for (let index = 0; index < pattern.segments.length; index += 1) {
            const expected = pattern.segments[index];
            const actual = segments[index];

            if (expected === null) {
                // A placeholder segment captures under its TEMPLATE name (`session_id`), so a
                // handler reads a stable key regardless of the value in the path.
                params[pattern.names[index]] = actual;
                continue;
            }

            if (expected !== actual) {
                matched = false;
                break;
            }
        }

        if (matched) return { id: pattern.id, params };
    }

    return undefined;
};

/** Split the path below the mount (mirrors the legacy dispatcher, incl. the defensive decode). */
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
                return segment;
            }
        });
};

/**
 * Maximum bytes for one request body, per route. Only the submit route carries raw base64
 * media inside JSON, so only it gets the shared 16 MiB cap; every other route keeps 1 MB.
 * Both adapters MUST call this before reading a body so a route cannot get a different bound
 * per mount.
 */
export const bodyLimitFor = (method: string, pathname: string, mount: string): number => {
    if (method.toUpperCase() !== 'POST') return MAX_BODY_BYTES;

    const segments = relativeSegments(pathname, mount);

    if (segments !== undefined && segments.length === 3 && segments[0] === 'sessions' && segments[2] === 'tasks') {
        return MAX_SUBMIT_BODY_BYTES;
    }

    return MAX_BODY_BYTES;
};

// ---------------------------------------------------------------------------
// CONTEXT INCLUSION (T7): one context-bar segment -> the transcript entry it came from
// ---------------------------------------------------------------------------
//
// WHY THIS JOIN LIVES HERE. `included` is a fact about a CONVERSATION: it sits on a
// `HarnessMessage` in a thread's transcript (src/types/index.ts:173-270), and
// `projectTranscript` drops exactly the FLAGGED ENTRY when a request is built
// (../harness.ts `projectTranscript`). A context-bar SEGMENT is a fact about a TURN: the projector
// compiled it out of that turn's recorded events (src/server/turn-projector.ts:2160 and
// :2322) and never sees a transcript. Neither record names the other, so the block detail
// route — the one read holding BOTH — does the mapping, at read time. Read time matters:
// the projector's compiled display is a CACHE, and a flag moved by a plugin's
// `turn.before setIncluded` (../harness.ts `setIncluded`) or by another browser tab moves no
// event, so a cached bar would keep answering with yesterday's inclusion forever.
//
// THE ONE RULE (entry axis). A segment is entry-addressable exactly when the event that
// OPENS it names a tool-call id that a live transcript still carries. That single rule
// states every case without a per-kind table:
//   - a `tool` segment opens on its `tool_call` (or, for a result-only record, its
//     `tool_result`), and the call id is exactly what pairs the assistant entry with its
//     results, so the entry join resolves to the entry that OWNS the call;
//   - a `reasoning` or answer window's opening delta carries prose, not an id, so the
//     entry axis resolves NOTHING for it (an answer window still streams several
//     assistant entries, and switching "this answer" off would mean guessing which
//     entries the reader meant);
//   - a `system` block joins N instruction entries into ONE segment, and a `user` prompt
//     block has no opening event at all ("from the turn record"), for the same reason.
//
// THE SECOND JOIN (thinking axis, trimmer uplift T7). A `reasoning` segment is
// thought-addressable exactly when the thinking text THIS segment answers with is the
// `reasoning` of EXACTLY ONE live assistant entry. That is the thought-side analogue of
// the rule above, and it exists because the trimmer uplift put a writable flag beside the
// thinking (`reasoningIncluded`, src/types/index.ts:223-246, written by `turn.before
// setReasoningIncluded`, src/harness.ts:8955-8999): the projector's reasoning block carries no
// id of its own — the block id is `kind` plus the OPENING EVENT INDEX — so the recorded
// bytes are the only identity it has, and the flag lives on the entry whose `reasoning`
// field IS those bytes. Requiring exactly one match is what keeps the verdict honest: two
// entries that thought the same thought mean the server cannot name one, and it then
// states NOTHING rather than picking the first. An ANSWER segment stays unaddressable on
// both axes: uplift T7 gives the thinking its join, not every prose window, so a `text`
// delta keeps the old ABSENT verdict.
//
// THE ENTRY ONE SEGMENT ADDRESSES (per entry since R8, no unit fan-out). A recorded call id
// resolves to the assistant entry that OWNS the call — the entry that asked for it and whose
// `tool_calls[]` the recorded arguments belong to. A result whose owner is gone (a host edit,
// a restored document) has no owner to name, so it IS its entry. Exclusion means exactly that
// entry leaves the next request: switching a tool segment off withholds its REQUEST, and the
// recorded answer keeps riding as an ownerless result — the same shape a hand-edited transcript
// already produces, and what the transport accepts, because it field-selects a `tool` message
// and validates nothing about its owner (../transport/openai.ts `wireMessage`). A reader who
// wants the whole exchange out of the prompt switches both segments; nothing here moves two
// entries for one click any more, because a click must have one honest verdict behind it.
//
// The THINKING axis was always per-entry (`setReasoningIncluded` addresses one entry and never
// cascaded): the flag removes one entry's thinking from its projection copy, which is no one
// else's pairing problem (../harness.ts `setReasoningIncluded`).

/** The tool-call id recorded on the event that OPENS one segment, or undefined when the
 *  record cannot name one. */
export const blockCallIdOf = (
    events: readonly unknown[],
    block: { kind?: string; eventFrom?: number }
): string | undefined => {
    if (block.kind !== 'tool' || block.eventFrom === undefined) return undefined;

    // ONLY the opening event, never the whole `eventFrom..eventTo` range: a settled tool
    // block's range runs over its `tool_result`, and a parallel call recorded in between
    // would otherwise lend this segment somebody else's id. The projector mints the segment
    // FROM this index, so the event here IS the opening one, and both spellings of the id
    // are evidence — `call.id` on a `tool_call` (src/server/turn-projector.ts:2113),
    // `callId` on a `tool_result` (src/types/index.ts:2525-2532).
    const event = events[block.eventFrom] as { call?: { id?: unknown }; callId?: unknown } | undefined;

    if (typeof event?.call?.id === 'string' && event.call.id.length > 0) return event.call.id;
    if (typeof event?.callId === 'string' && event.callId.length > 0) return event.callId;

    return undefined;
};

/**
 * The transcript ENTRY one call id belongs to, or undefined when this transcript has no
 * entry for it. Per entry, not per unit (R8): the entry is the assistant entry whose
 * `toolCalls` carries the id — the request the recorded call is part of — and call ids are
 * conversation-unique (`assertToolCallIds`), so that owner IS the only one. An orphan result
 * (its owner is gone, e.g. a host edit) has no request entry to name, so it is its own
 * entry, exactly as the core projection treats it.
 */
export const transcriptEntryOfCall = (
    messages: readonly HarnessMessage[],
    callId: string
): HarnessMessage | undefined => {
    // A type PREDICATE, not a cast: the assistant member is the only one of the
    // `HarnessMessage` union carrying `toolCalls`, and the predicate is what keeps the
    // compiler inside that member instead of widening `owner` back to the union.
    const owner = messages.find(
        (message): message is Extract<HarnessMessage, { role: 'assistant' }> =>
            message.role === 'assistant' && (message.toolCalls ?? []).some((call) => call.id === callId)
    );

    if (owner !== undefined) return owner;

    // No owner: the only entry that can carry this call id is the result itself.
    return messages.find((message) => message.role === 'tool' && message.toolCallId === callId);
};

/** The recorded thinking text ONE `reasoning` segment answers with, read off the block
 *  detail payload the store already served, or undefined when this segment is not a
 *  thinking window (or the record holds no bytes for it).
 *
 *  This IS the segment's only identity (uplift T7): the projector mints a reasoning block
 *  with `kind` plus the opening event index (src/server/turn-projector.ts:2136) and no
 *  entry reference, while the payload this returns is the recorded `reasoning` deltas of
 *  one attempt, concatenated IN ORDER (./sessions.ts `blockPayloadOf` ->
 *  `recordedStreamText`). The writer closes at every request boundary (
 *  src/server/turn-projector.ts `closeWriters`), so those bytes are exactly the one
 *  assistant entry's `reasoning` — which is the field T6's flag sits beside. */
export const blockReasoningTextOf = (block: { kind?: string; text?: unknown }): string | undefined =>
    block.kind === 'reasoning' && typeof block.text === 'string' && block.text.length > 0 ? block.text : undefined;

/** The ONE live assistant entry whose `reasoning` is exactly this recorded thinking text,
 *  or undefined when the transcript names none OR names more than one.
 *
 *  The ambiguity guard is the whole point: `included` is a verdict about ONE entry, so an
 *  entry the server cannot single out must stay ABSENT (../shared/turn-display.ts
 *  `ContextBlock.included`) rather than be guessed at. Comparing the WHOLE string is what
 *  makes this an exact read — a prefix or a `includes()` match would put somebody else's
 *  flag on this segment. A withheld entry still carries its `reasoning` (T6 withholds it
 *  from the PROJECTION COPY only, src/core/agent.ts `withoutWithheldReasoning`), so the
 *  join keeps naming the same entry after the switch is thrown, which is what lets the
 *  dialog read the verdict BACK. */
export const transcriptEntryOfReasoning = (
    messages: readonly HarnessMessage[],
    text: string
): Extract<HarnessMessage, { role: 'assistant' }> | undefined => {
    let found: Extract<HarnessMessage, { role: 'assistant' }> | undefined;

    for (const message of messages) {
        if (message.role !== 'assistant' || message.reasoning !== text) continue;

        // A SECOND candidate ends the search: two entries that streamed the same thinking
        // is a server that cannot say which one this segment came from.
        if (found !== undefined) return undefined;

        found = message;
    }

    return found;
};

/** The recorded ANSWER text ONE `assistant` segment shows — the concatenated `text` deltas of
 *  the block's own event range — or undefined when this segment is not an answer window (or the
 *  record holds no bytes for it).
 *
 *  R5 review, FIX C: this is the third identity the dialog and the bar needed, stated the way the
 *  thinking identity is stated. An answer window has no call id (`blockCallIdOf` is the tool
 *  kind's, and the projector mints an answer from `text` deltas, never from a `tool_call`), so the
 *  entry join could never name it; its bytes ARE its identity, read through the SAME
 *  ./sessions.ts `recordedStreamText` the block detail answers its `text` pane with. That is the
 *  rule, not a convenience: two derivations of "this segment's recorded answer" would let the bar
 *  and the dialog resolve two different entries for one segment, which is the one thing the
 *  `included` figure cannot survive. */
export const blockAnswerTextOf = (
    turn: SessionTurn,
    block: { kind?: string; eventFrom?: number; eventTo?: number }
): string | undefined =>
    block.kind === 'assistant' && typeof block.eventFrom === 'number' && typeof block.eventTo === 'number'
        ? recordedStreamText(turn, 'text', block.eventFrom, block.eventTo)
        : undefined;

/** The ONE live assistant entry whose `content` is exactly this recorded answer text, or
 *  undefined when the transcript names none OR names more than one.
 *
 *  THE SAME GUARD AS THE THINKING JOIN, for the same reason (see `transcriptEntryOfReasoning`
 *  above): `included` is a verdict about ONE entry, so an entry the server cannot single out
 *  stays ABSENT (../shared/turn-display.ts `ContextBlock.included`) rather than guessed at.
 *
 *  WHY AN EXACT COMPARISON IS ENOUGH, AND WHERE IT STOPS. The projector mints ONE answer block per
 *  RUN of prose, not per turn — `closeWriters` detaches the text writer at every request boundary
 *  and the `record.text === undefined` branch opens a fresh block for the next run
 *  (src/server/turn-projector.ts:2124-2160) — so a turn that streamed text, called a tool, then
 *  streamed more text produced TWO segments over TWO ranges, each one exactly one entry's
 *  `content`, and BOTH resolve, each to the entry that streamed it. Per-run blocks are what make an
 *  exact-bytes match a per-entry match. What the comparison cannot resolve is an entry the
 *  transcript cannot single out: the same answer text twice in one conversation (two candidates,
 *  and a `find` that preferred the newest would be picking a flag rather than reading one), or an
 *  answer whose entry a host Transcript save has since removed. Both answer `undefined`. A
 *  withheld entry keeps its `content` (the flag moves the entry out of the PROJECTION, never out of
 *  the document), so the join keeps naming the same entry after the switch is thrown and the
 *  dialog can read the verdict BACK. */
export const transcriptEntryOfAnswer = (
    messages: readonly HarnessMessage[],
    text: string
): Extract<HarnessMessage, { role: 'assistant' }> | undefined => {
    if (text.length === 0) return undefined;

    let found: Extract<HarnessMessage, { role: 'assistant' }> | undefined;

    for (const message of messages) {
        if (message.role !== 'assistant' || message.content !== text) continue;

        // A SECOND candidate ends the search: two entries carrying the same answer text is a
        // server that cannot say which one this segment streamed.
        if (found !== undefined) return undefined;

        found = message;
    }

    return found;
};

/** A structural COPY of `messages` with ONE entry's thinking flag written; the input is
 *  never mutated, exactly like `messagesWithInclusion` below.
 *
 *  THE STORAGE RULE IS CORE'S, mirrored from `setReasoningIncluded` (../harness.ts) and
 *  `withoutWithheldReasoning` (../core/agent.ts): a literal `false` is
 *  the ONLY stored value and switching the thinking back on REMOVES the key, so an
 *  unflagged transcript stays byte-identical forever and a document diff never shows a
 *  change that did not happen. Nothing cascades on either axis now (R8): the write lands on
 *  the one assistant entry, its `reasoning` text is never touched, and its `included`
 *  axis is never touched — the entry keeps travelling, only its thinking stops riding. */
export const messagesWithReasoningInclusion = (
    messages: readonly HarnessMessage[],
    entry: Extract<HarnessMessage, { role: 'assistant' }>,
    included: boolean
): HarnessMessage[] =>
    messages.map((message) => {
        const copy = { ...message } as HarnessMessage & { reasoningIncluded?: boolean };

        if (message !== entry) return copy;

        if (included) delete copy.reasoningIncluded;
        else copy.reasoningIncluded = false;

        return copy;
    });

/** A structural COPY of `messages` with ONE entry's flag written; the input is never
 *  mutated, so the caller's live transcript stays untouched until the store installs it.
 *
 *  ONE entry only (R8): no unit fan-out, no sibling result moves with the click. Core's
 *  storage rule is mirrored exactly — `writeIncluded` (../harness.ts) and `withIncluded`
 *  (../core/agent.ts) keep a literal `false` as the ONLY stored value, and switching an entry
 *  back on REMOVES the key. Writing `included: true` would put a value on the wire that the
 *  snapshot reader drops, and a document diff would show a change that never happened.
 */
export const messagesWithInclusion = (
    messages: readonly HarnessMessage[],
    entry: HarnessMessage,
    included: boolean
): HarnessMessage[] =>
    messages.map((message) => {
        const copy = { ...message } as HarnessMessage & { included?: boolean };

        if (message !== entry) return copy;

        if (included) delete copy.included;
        else copy.included = false;

        return copy;
    });

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/**
 * Build the API over a live store/registry/catalogue. The construction signature is
 * unchanged (every existing adapter call still typechecks); the three new options are all
 * optional with correct defaults.
 */
export const createHarnessApi = ({
    store,
    defaults,
    settings,
    registry = createHarnessRegistry(),
    catalogue = createToolCatalogue(),
    runtime = loadRuntimeConfiguration(),
    events = createHarnessEventHub(),
    databaseRoot,
    capabilities
}: HarnessApiOptions): HarnessApi => {
    // The core (harness-owned) descriptors are built once: they are listed alongside the
    // catalogue and carry `sessionBound`, which is what makes a global call require a
    // session (here: refuse with 403). Metadata comes from src/core/metadata.ts, the same
    // copy the harness registers, so a descriptor cannot advertise a different schema.
    const coreEntries = createCoreToolEntries();
    const toolEntries = (): CatalogueEntry[] => [...coreEntries, ...catalogue.entries];

    // R3: the runtime's GLOBAL tool switch, reached THROUGH the store that owns it, so this
    // dispatcher never builds a second disabled set: a `PATCH /tools/{tool_id}` here writes
    // the same live set every harness consults while it builds a request's tool list
    // (./tool-settings.ts, ./sessions.ts `buildHarness`, ../harness.ts).
    const toolSettings = store.toolSettings;

    // The enablement field every catalogue row carries, read live at the moment the row is
    // built. The switch applies to EVERY listed entry — a harness-owned core tool is
    // disabled exactly like a catalogue preset (R5) — so a row states one figure and there is
    // nothing beside it to explain why a write would be refused.
    const toolEnablementOf = (name: string): { enabled: boolean } => ({
        enabled: toolSettings.isEnabled(name)
    });

    // T19: the global agent overlay, reached THROUGH the registry (its owner). Every agent
    // read resolves effective text through it, and every agent write commits through it.
    const agentState = registry.agentState();

    // T19: commit ONE agent decision as a single unit. `store.mutateRegistry` already owns a
    // rollback for everything the registry holds (the overlay travels in its snapshot), and it
    // commits `state.json` inside that unit; the overlay file is the second half. The order is
    // deliberate:
    //   - if `state.json` fails, `mutateRegistry` restores the captured snapshot (overlay
    //     included) and `agents.json` was never touched, so the 500 the client gets matches a
    //     disk that never changed;
    //   - if the OVERLAY write is the one that fails, the in-memory decision is put back before
    //     the failure propagates, so no channel can disagree with the refusal.
    const commitAgentEdit = async <T>(mutate: () => T): Promise<T> => {
        const previous = registry.agentRecords();

        const result = await store.mutateRegistry(mutate);

        try {
            writeHarnessAgentRecords(databaseRoot, registry.agentRecords());
        } catch (error) {
            registry.restoreAgentRecords(previous);

            throw error;
        }

        return result;
    };

    // Session display titles. There is no durable title field on the session record
    // (persistence.ts is not this owner's), and the contract names the field, so it is
    // process state; the write route says so in its receipt-free behaviour.
    const titles = new Map<string, string>();

    // `PATCH /config` overlays the SHIPPED provider defaults in-process. Effective values
    // are what `/config`, a session's `endpoint` block, and a NEW session's merged settings
    // use; the shipped `defaults`/`store.defaults` remain the reset target.
    const shipped: ProviderDefaults = {
        base_url: defaults.baseURL,
        model: defaults.model,
        has_api_key: defaults.hasApiKey
    };

    // ------------------------------------------------------------------
    // T28: the credential layer (the reason this block is not one settings object).
    //
    // Three things used to be conflated, and each is now separate:
    //   1. `globalSettings.apiKey` — the ACTUAL key this process may send ('' when it has
    //      none). It comes from the private `settings` channel or from an explicit
    //      `PATCH /config settings.api_key`. It is never derived from a boolean, and it is
    //      never serialized to a client;
    //   2. `globalSettings.hasKey` — the client-visible CLAIM (`has_api_key`), which a
    //      key-free front end may state without handing this API the secret;
    //   3. `credentialBaseURL` — the provider the current key belongs to (origin + base
    //      path). A `base_url` patch moves the DEFAULT ENDPOINT, not whose secret it is, so
    //      the scope follows only an explicit `api_key` write.
    //
    // The defect this replaces: `effectiveDefaults()` used to return the literal string
    // 'configured' whenever `defaults.hasApiKey` was true, so `POST /models` (and a
    // settings-free `POST /sessions`) sent `Authorization: Bearer configured` to the real
    // provider instead of the configured secret.
    // ------------------------------------------------------------------

    // The credential this process started with, and the provider it belongs to. An omitted
    // `settings` channel means BOTH are empty: no key, and nothing for a key to be scoped to.
    const bootCredential: ProviderCredential = {
        apiKey: settings === undefined ? '' : settings.apiKey.trim(),
        baseURL: settings === undefined ? '' : settings.baseURL
    };

    const globalSettings = {
        baseURL: defaults.baseURL,
        model: defaults.model,
        // The key is never read back over HTTP, so the API keeps the real value for OUTBOUND
        // requests plus whatever an operator hands it in a write body — and nothing else.
        apiKey: bootCredential.apiKey,
        hasKey: defaults.hasApiKey
    };

    // T28: the provider `globalSettings.apiKey` was issued for. Moved only by an explicit
    // `api_key` write (see `patchConfig`), never by a `base_url` patch.
    let credentialBaseURL = bootCredential.baseURL;

    // T28: an injected `settings` channel is the authoritative statement about this process's
    // credential. Without one, `defaults.hasApiKey` is the deployment's own claim and is the
    // only thing `/config` can honestly report.
    const declaresCredential = settings !== undefined;

    // T16: a saved `PATCH /config` result is applied at construction, so the operator's global
    // defaults survive a restart instead of vanishing on the next boot. The credential is NOT part
    // of that record (state.json holds no secret), so an api key set over HTTP stays process-only,
    // which is exactly what the write document says about it.
    const savedGlobalSettings = store.globalSettings;

    if (savedGlobalSettings !== undefined) {
        if (savedGlobalSettings.baseURL !== undefined) globalSettings.baseURL = savedGlobalSettings.baseURL;
        if (savedGlobalSettings.model !== undefined) globalSettings.model = savedGlobalSettings.model;
    }

    const effectiveDefaults = (): { baseURL: string; model: string; apiKey: string } => ({
        baseURL: globalSettings.baseURL,
        model: globalSettings.model,
        // T28: the real key, or '' — never a placeholder standing in for one. This is the
        // INTERNAL effective view (`context.defaults`, consumed by the provider-call paths);
        // the client-visible projection is `effectiveProviderDefaults()`, key-free by contract.
        apiKey: globalSettings.apiKey
    });

    const effectiveProviderDefaults = (): ProviderDefaults => ({
        base_url: globalSettings.baseURL,
        model: globalSettings.model,
        // T28: a boolean is never used as a credential, and it is never consulted at all once
        // the process states its own key — an injected `settings` object with `apiKey: ''`
        // means no key, whatever the advertised defaults claim.
        has_api_key:
            globalSettings.apiKey.trim().length > 0 || (globalSettings.hasKey && !declaresCredential)
    });

    /**
     * T28: the credential and its provider scope for ONE outbound provider call. Handed to
     * `mergeSettings` as the third argument so the scope check compares against the provider
     * the key belongs to, never against a base URL the merge may have just moved.
     */
    const providerCredential = (): ProviderCredential => ({
        apiKey: globalSettings.apiKey,
        baseURL: credentialBaseURL
    });

    void shipped;

    const advertisedCapabilities: ServiceCapabilities = {
        ...HARNESS_SERVICE_CAPABILITIES,
        // T19: `agent_writes` is backed by the global agent-override layer
        // (./harnesses/agent-state.ts + `<root>/harness/agents.json`), so the shipped value
        // in the contract stands and nothing is advertised that this build cannot do. A
        // deployment can still withhold the capability through `options.capabilities` (a
        // read-only front end), which is what that override exists for.
        ...(capabilities ?? {})
    };

    const context: ReadContext = {
        hub: events,
        catalogue,
        // R3/TRUTHFUL ROWS: the harness-owned entries travel with the read context so a
        // SESSION tool row resolves a runtime name (`delegate`, `records`, `threadSend`, ...)
        // exactly the way a GLOBAL row does — `toolEntryOf` below. Without it the session pane
        // fell back to the "no catalogue entry" defaults and described `delegate` as a created,
        // searchable, non-session-bound tool while this same dispatcher listed it as core.
        coreEntries,
        defaults: effectiveDefaults(),
        runtime,
        titles,
        createdToolLimit: HARNESS_SERVICE_LIMITS.created_tools,
        // The trusted profiles: instruction provenance for a definition read, a session
        // roster row, and an agent detail all resolve through this list.
        //
        // T19: a GETTER rather than a captured array. The global agent overlay changes when
        // `PATCH /agents/:id` lands, and a snapshot taken at construction would keep every
        // provenance read reporting the pre-edit text for the life of the process. A getter
        // costs one fresh merge per read (the catalogue is eight entries) and can never be
        // stale.
        get profiles() {
            return registry.agents();
        },
        agentState
    };

    // The read model caches `defaults`, and `/config` may change them; refresh the same
    // object in place so a config write is visible to every later read without a rebuild.
    const syncDefaults = (): void => {
        const next = effectiveDefaults();

        context.defaults.baseURL = next.baseURL;
        context.defaults.model = next.model;
        context.defaults.apiKey = next.apiKey;
    };

    // ------------------------------------------------------------------
    // T16: live store changes -> the hub -> the stream
    //
    // The store announces each live change as IDENTITY ONLY (see `StoreStreamSignal` in
    // ./sessions.ts). This observer is the only place that turns such a signal into (a) the
    // counters of the resources that actually moved and (b) the one small wire body the
    // contract streams, rebuilt from the live record the REST owner is allowed to read. No
    // snapshot, no compiled view, no raw `watch()`: a turn update costs its row (a cache read
    // of the projector the recorder already maintains), a display update costs the ops the
    // recorder already produced, and a conversation update costs one roster row.
    //
    // COUNTER DOMAINS (this is what keeps HTTP reads and WS frames identical, and keeps ONE
    // change from moving a number twice):
    //   - the STORE owns the live per-resource counters: `turn`, `turns`, `turn_display`,
    //     `turn_events` (all three turn kinds move together because the contract DEFINES the
    //     display and event revisions to equal the owning turn's), `usage`, `actions`,
    //     `thread`, `threads`, `transcript`, `transcript_messages`;
    //   - the REST handlers own what only a request can know: `session`, `sessions`, `queue`,
    //     `definition`, `session_agents`, `session_tools`, `commands`, `harnesses`, `agents`,
    //     `tools`, `config`. The REST routes that used to bump a store-owned key no longer do,
    //     because the store's signal for the same change fires inside the same synchronous
    //     mutation and moves it once.
    // ------------------------------------------------------------------

    // One conversation's roster row, rebuilt cheaply for a stream update: the thread RECORD plus
    // the store's own label, and the transcript read is bounded to that ONE conversation (its
    // entries are what the row's counts and preview state).
    const threadRowForStream = (
        record: SessionRecord,
        id: string
    ): ReturnType<typeof threadRowOf> | undefined => {
        const thread = record.harness.thread(id);

        if (thread === undefined) return undefined;

        return threadRowOf(record, thread, record.threadLabels.get(id), liveThreadMessages(record, id), {
            withPreview: true
        });
    };

    /** The transcript counts a `transcript.updated` frame carries. */
    const transcriptCountsForStream = (record: SessionRecord, id: string, revision: number) =>
        transcriptSignalOf(id, revision, liveThreadMessages(record, id), record.invalidThreads.has(id));

    /** A conversation's messages, or empty when the harness has no such conversation (a stale unreadable record). */
    const liveThreadMessages = (record: SessionRecord, id: string): import('../harness').HarnessMessage[] => {
        if (record.invalidThreads.has(id)) return [];

        try {
            return record.harness.threadMessages(id);
        } catch {
            return [];
        }
    };

    /** The last usage figures announced per turn (dedupe key for `usage.updated`). */
    const announcedUsage = new Map<string, string>();

    // The live signal -> hub translation. Installed once per API instance; the store calls it
    // synchronously inside the mutation that produced the change, so a REST response, a header
    // revision, and a WS frame all quote the same number.
    store.setStreamObserver((signal) => {
        const record = store.peekSession(signal.sessionId);

        // A removed session has nothing to rebuild: the ids in the signal are still fanned out
        // by the invalidation kinds below, and a subscription to a gone session ends anyway.
        if (record === undefined) return;

        const sessionKey = resourceKeyOf('session', record.id);

        switch (signal.kind) {
            case 'session.state': {
                const revision = events.bumpRevision('session', record.id);

                void revision;

                events.publish({
                    kind: 'session.updated',
                    resources: [sessionKey],
                    target: sessionKey,
                    payload: { session: sessionStatePatchOf(record, context) }
                });

                return;
            }
            case 'turn.upsert': {
                // The three turn kinds are folds of one record, so they move together: a client
                // comparing a display revision against a turn read has one figure to compare.
                const key = resourceKeyOf('turn', turnKey(record.id, signal.turnId));
                const displayKey = resourceKeyOf('turn_display', turnKey(record.id, signal.turnId));
                const eventsKey = resourceKeyOf('turn_events', turnKey(record.id, signal.turnId));
                const turnsKey = resourceKeyOf('turns', record.id);

                events.bumpRevision('turn', turnKey(record.id, signal.turnId));
                events.bumpRevision('turn_display', turnKey(record.id, signal.turnId));
                events.bumpRevision('turn_events', turnKey(record.id, signal.turnId));
                events.bumpRevision('turns', record.id);

                const projector = store.peekTurnProjector(record, signal.turnId);

                events.publish({
                    kind: 'turn.upsert',
                    resources: [key, displayKey, eventsKey, turnsKey],
                    target: key,
                    ...(projector === undefined ? {} : { payload: { turn: turnRowOf(projector, signal.turnId) } })
                });

                return;
            }
            case 'turn.removed': {
                const turnsKey = resourceKeyOf('turns', record.id);

                events.bumpRevision('turns', record.id);

                events.publish({
                    kind: 'turn.removed',
                    resources: [turnsKey],
                    target: resourceKeyOf('turn', turnKey(record.id, signal.turnId)),
                    payload: { turn_id: signal.turnId }
                });

                return;
            }
            case 'display.ops': {
                const key = resourceKeyOf('turn_display', turnKey(record.id, signal.turnId));

                // The three turn kinds are folds of ONE record, so a display change moves all of
                // them: the contract defines the display and event revisions to EQUAL the owning
                // turn's, and moving only one would create a comparison that cannot be made.
                events.bumpRevision('turn', turnKey(record.id, signal.turnId));
                events.bumpRevision('turn_display', turnKey(record.id, signal.turnId));
                events.bumpRevision('turn_events', turnKey(record.id, signal.turnId));

                events.publish({
                    kind: 'display.ops',
                    resources: [key],
                    target: key,
                    // The recorder's ops are the projector's member union; the wire record is the
                    // generated closed superset (see PROJECTION DELTAS in
                    // ../shared/harness-api.ts), so the widening is asserted at this boundary and
                    // the bytes are untouched.
                    ops: signal.ops as unknown as Parameters<typeof events.publish>[0]['ops']
                });

                return;
            }
            case 'usage.updated': {
                const usageKey = resourceKeyOf('usage', record.id);

                const projector = store.peekTurnProjector(record, signal.turnId);
                const patch = usagePatchOf(
                    record,
                    signal.turnId,
                    context,
                    projector === undefined ? undefined : (projector.summary() as unknown as { latestInput?: number })
                );

                if (patch === undefined) return;

                // `usage.updated` is a FIGURE update: the store may announce the terminal tally on
                // more than one frame of the same transition, and a client that applied two
                // identical patches would be no worse off, but a stream that repeated them would
                // look like two changes. One announcement per distinct figure set, keyed by the
                // turn, is the honest rule.
                const figure = JSON.stringify([patch.usage, patch.latest_input, patch.cached_input]);
                const previous = announcedUsage.get(signal.turnId);

                if (previous === figure) return;

                announcedUsage.set(signal.turnId, figure);

                events.bumpRevision('usage', record.id);

                events.publish({
                    kind: 'usage.updated',
                    resources: [usageKey],
                    target: resourceKeyOf('turn', turnKey(record.id, signal.turnId)),
                    payload: { usage_patch: patch, turn_id: signal.turnId }
                });

                return;
            }
            case 'action.opened': {
                const actionsKey = resourceKeyOf('actions', record.id);
                const pending = record.pendingActions.get(signal.requestId);

                events.bumpRevision('actions', record.id);

                if (pending === undefined) {
                    events.publish({ kind: 'action.closed', resources: [actionsKey], payload: { action_closed: { request_id: signal.requestId, reason: 'ended' as const } } });

                    return;
                }

                events.publish({
                    kind: 'action.opened',
                    resources: [actionsKey],
                    target: actionsKey,
                    payload: { action: pendingActionRowOf(record, pending) }
                });

                return;
            }
            case 'action.closed': {
                const actionsKey = resourceKeyOf('actions', record.id);

                events.bumpRevision('actions', record.id);

                events.publish({
                    kind: 'action.closed',
                    resources: [actionsKey],
                    target: actionsKey,
                    payload: { action_closed: { request_id: signal.requestId, reason: signal.reason } }
                });

                return;
            }
            case 'thread.upsert': {
                const threadsKey = resourceKeyOf('threads', record.id);
                // The hub keys a conversation as `session:thread`; the local is named apart from
                // the `threadKey` builder so the two cannot shadow each other.
                const conversationKey = resourceKeyOf('thread', threadKey(record.id, signal.threadId));

                events.bumpRevision('threads', record.id);
                events.bumpRevision('thread', threadKey(record.id, signal.threadId));

                const row = threadRowForStream(record, signal.threadId);

                if (row === undefined) return;

                events.publish({
                    kind: 'thread.upsert',
                    resources: [threadsKey, conversationKey],
                    target: conversationKey,
                    payload: { thread: row }
                });

                return;
            }
            case 'thread.removed': {
                const threadsKey = resourceKeyOf('threads', record.id);

                events.bumpRevision('threads', record.id);
                events.bumpRevision('thread', threadKey(record.id, signal.threadId));

                events.publish({
                    kind: 'thread.removed',
                    resources: [threadsKey],
                    target: resourceKeyOf('thread', threadKey(record.id, signal.threadId)),
                    payload: { thread_id: signal.threadId }
                });

                return;
            }
            case 'transcript.updated': {
                const key = threadKey(record.id, signal.threadId);
                const transcriptKey = resourceKeyOf('transcript', key);
                const messagesKey = resourceKeyOf('transcript_messages', key);

                events.bumpRevision('transcript', key);
                events.bumpRevision('transcript_messages', key);

                const signalBody = transcriptCountsForStream(record, signal.threadId, events.getRevision('transcript', key));

                events.publish({
                    kind: 'transcript.updated',
                    resources: [transcriptKey, messagesKey],
                    target: transcriptKey,
                    payload: { transcript: signalBody }
                });

                return;
            }
            case 'records.updated': {
                // The record store is ONE session-level counter domain (`records`), whatever the
                // mutation touched: the panel's question is "is my projection current", not "which
                // collection moved", and the affected names are on the REST delta anyway.
                const recordsKey = resourceKeyOf('records', record.id);

                events.bumpRevision('records', record.id);

                events.publish({
                    kind: 'records.updated',
                    resources: [recordsKey],
                    target: recordsKey,
                    // Revisions only, never a record: `store_rev` is where the replay feed
                    // continues (the `?since=` cursor of the REST delta) and `collections_rev`
                    // moving is the client's cue to take a fresh snapshot instead of a delta.
                    payload: {
                        records: {
                            store_rev: signal.storeRev,
                            collections_rev: signal.collectionsRev
                        }
                    }
                });

                return;
            }
        }
    });

    // ------------------------------------------------------------------
    // Publishing (the realtime owner's single source of change)
    // ------------------------------------------------------------------

    // One call per mutation: report the counters the mutation moved and fan the update out,
    // so a REST write is observable on the stream without the transport polling anything. The
    // route owns the `bumpRevision` calls (publishing never advances a counter), which is what
    // lets a response body and a stream frame quote the same figure.
    // One published change: bump the listed resource counters and fan the update out, so a
    // REST write is observable on the stream without the transport polling anything.
    //
    // `ResourceInput` is spelled out (rather than inferred) because several call sites build
    // these arrays with a conditional spread, which widens a literal kind to `string` and
    // would silently accept a kind the contract does not define.
    type ResourceInput = { resource: StreamResourceKind; id?: string | null };

    const publish = (kind: WsUpdateKind, resources: readonly ResourceInput[], payload?: unknown): void => {
        events.publish({
            kind,
            resources: resources.map((entry) => resourceKeyOf(entry.resource, entry.id)),
            payload
        });
    };

    /** Stamp the contract's epoch/revision headers on a JSON result (adapters may forward). */
    const withHeaders = (result: { kind: 'json'; status: number; body: unknown }, revision?: number): HarnessApiResult => ({
        ...result,
        headers: {
            [HARNESS_EPOCH_HEADER]: events.epoch,
            ...(revision === undefined ? {} : { [HARNESS_REVISION_HEADER]: String(revision) })
        }
    });

    const json = (status: number, body: unknown, revision?: number): HarnessApiResult =>
        withHeaders({ kind: 'json', status, body }, revision);

    // ------------------------------------------------------------------
    // Route context and handlers
    // ------------------------------------------------------------------

    type Ctx = {
        request: HarnessApiRequest;
        method: string;
        mount: string;
        query: URLSearchParams;
        params: Record<string, string>;
        body: <T>() => Promise<T>;
    };

    type Handler = (ctx: Ctx) => Promise<HarnessApiResult> | HarnessApiResult;

    // ---- helpers over the live store record (bounded: never `get()`/`list()`) ----

    const requireSession = (id: string): SessionRecord => store.liveSession(id);

    const requireTurn = (record: SessionRecord, turnId: string) => {
        const turn = store.peekTurn(record, turnId);

        if (turn === undefined) throw missing('turn', turnId, record.id);

        return turn;
    };

    const requireThread = (record: SessionRecord, threadId: string) => {
        const thread = record.harness.thread(threadId);
        const invalid = record.invalidThreads.get(threadId);

        if (thread === undefined && invalid === undefined) throw missing('thread', threadId, record.id);

        return thread;
    };

    /** The messages of one conversation, or the empty list for an unreadable transcript. */
    const transcriptMessagesOf = (record: SessionRecord, threadId: string): import('../harness').HarnessMessage[] => {
        if (record.invalidThreads.has(threadId)) return [];

        try {
            return record.harness.threadMessages(threadId);
        } catch {
            // A thread that exists only in the invalid map has no live transcript; the raw
            // value is the useful part, and the metadata route states why it is empty.
            return [];
        }
    };

    /** Every label the store has for a conversation (the one user-facing name, `#RR3`). */
    const labelOf = (record: SessionRecord, threadId: string): string | undefined => record.threadLabels.get(threadId);

    /** The conversations this segment's recorded events could belong to, in the order the
     *  join is allowed to try them. Search order is a claim, not a hunt, and BOTH joins use
     *  it: the conversation the TURN belongs to first — that is where a delegated section's
     *  call or thinking lives, and `SessionTurn.threadId` is the store's own join
     *  (./protocol.ts:137) — then every other conversation this session owns. The fallback
     *  exists for one shape only: a record whose turn row carries no thread join (a legacy
     *  document). A candidate is accepted only when its transcript really holds what the
     *  segment names, so a fallback can never switch an identically-named call, or an
     *  identically-thinking entry, in the wrong conversation. */
    const threadCandidatesOf = (record: SessionRecord, turn: SessionTurn): string[] => [
        ...(turn.threadId === undefined ? [] : [turn.threadId]),
        ...record.harness.threads()
            .map((thread) => thread.id)
            .filter((id) => id !== turn.threadId)
    ];

    /**
     * T7: the conversation and the ONE transcript entry a context segment's text is built
     * from (`blockCallIdOf` + `transcriptEntryOfCall` above), or undefined when no live entry
     * answers the recorded call id. One entry, never a unit (R8) — the read, the write and the
     * receipt all resolve through here, so the chip and the transcript cannot disagree.
     */
    const blockEntryOf = (
        record: SessionRecord,
        turn: SessionTurn,
        block: { kind?: string; eventFrom?: number }
    ): { threadId: string; callId: string; messages: HarnessMessage[]; entry: HarnessMessage } | undefined => {
        const callId = blockCallIdOf(turn.events, block);

        if (callId === undefined) return undefined;

        for (const threadId of threadCandidatesOf(record, turn)) {
            // An unreadable transcript has no live entries to address (`transcriptMessagesOf`
            // answers []), so it is passed over rather than reported as "this call is not in
            // the transcript" — the reader's problem there is the broken document, and the
            // transcript routes say so.
            if (record.invalidThreads.has(threadId)) continue;

            const messages = transcriptMessagesOf(record, threadId);
            const entry = transcriptEntryOfCall(messages, callId);

            if (entry !== undefined) return { threadId, callId, messages, entry };
        }

        return undefined;
    };

    /**
     * THE SECOND JOIN (trimmer uplift T7): the conversation and the ONE assistant entry a
     * `reasoning` segment's thinking was streamed by, or undefined when the recorded bytes
     * name none — not a thinking window, no recorded bytes, no live entry carries that
     * exact `reasoning`, or more than one entry does.
     *
     * `block` here is the block DETAIL the store already served, so `text` is the segment's
     * recorded thinking (./sessions.ts `blockPayloadOf`). Both routes that state or write a
     * thinking verdict read it from that one source, which is what keeps a read and a write
     * from resolving different entries.
     */
    const blockThoughtOf = (
        record: SessionRecord,
        turn: SessionTurn,
        block: { kind?: string; text?: unknown }
    ): { threadId: string; messages: HarnessMessage[]; entry: Extract<HarnessMessage, { role: 'assistant' }> } | undefined => {
        const text = blockReasoningTextOf(block);

        if (text === undefined) return undefined;

        for (const threadId of threadCandidatesOf(record, turn)) {
            if (record.invalidThreads.has(threadId)) continue;

            const messages = transcriptMessagesOf(record, threadId);
            const entry = transcriptEntryOfReasoning(messages, text);

            if (entry !== undefined) return { threadId, messages, entry };
        }

        return undefined;
    };

    /**
     * THE THIRD JOIN (R5 review, FIX C): the conversation and the ONE assistant entry an
     * `assistant` segment's ANSWER was streamed by, or undefined when the recorded bytes name
     * none — not an answer window, no recorded bytes, no live entry whose `content` is exactly
     * those bytes, or more than one entry is.
     *
     * WHY IT WAS MISSING, AND WHY IT IS HONEST NOW. An answer window is the text half of an
     * assistant entry, so the call-id join could never name it and every verdict about it stayed
     * ABSENT: the bar offered no dim for a turn's whole answer, the chip offered no switch, and a
     * reader who withheld an answer from the prompt saw nothing move. The thinking join already
     * proved the pattern for a window with no id — the recorded bytes ARE the identity, compared
     * exactly and refused on ambiguity (`transcriptEntryOfAnswer`) — and the same
     * `recordedStreamText` this uses is the one the block detail's `text` pane answers with, so
     * the bar, the dialog and the write all name one entry.
     *
     * WHAT STAYS ABSENT, deliberately: an answer whose text an earlier assistant entry repeats
     * verbatim (two candidates, and the join refuses rather than preferring one — a bar that put a
     * toggle on whichever entry a `find` reached first would be inventing a verdict), and an answer
     * whose entry is no longer in the transcript at all (a host Transcript save can delete it while
     * the turn record keeps its events). Both are the transcript declining to name one entry, and
     * the surfaces then state the policy the way they did before this join existed — never a
     * borrowed flag. A split answer is NOT one of them: the projector mints one answer block per
     * run of prose, so each run resolves to the entry that streamed it and each gets its own switch
     * (`transcriptEntryOfAnswer` above, and ./view.test.ts pins both runs).
     */
    const blockAnswerOf = (
        record: SessionRecord,
        turn: SessionTurn,
        block: { kind?: string; eventFrom?: number; eventTo?: number }
    ): { threadId: string; messages: HarnessMessage[]; entry: Extract<HarnessMessage, { role: 'assistant' }> } | undefined => {
        const text = blockAnswerTextOf(turn, block);

        if (text === undefined) return undefined;

        for (const threadId of threadCandidatesOf(record, turn)) {
            if (record.invalidThreads.has(threadId)) continue;

            const messages = transcriptMessagesOf(record, threadId);
            const entry = transcriptEntryOfAnswer(messages, text);

            if (entry !== undefined) return { threadId, messages, entry };
        }

        return undefined;
    };

    /** The entry's own inclusion, spelled the way the plugin API spells
     *  `HarnessContextEntry.included` (../harness.ts `createEntries`): the flag is per entry
     *  (R8), so this is a one-entry read — no "every member on, or it is off" rule any more. */
    const entryIncludedOf = (entry: HarnessMessage): boolean => entry.included !== false;

    /** The SAME tri-state spelling on the thinking axis: the flag's absence means the
     *  thinking rides in the requests that follow, and only a literal `false` withholds it
     *  (src/types/index.ts:223-246, written by src/harness.ts:8955-8999). */
    const thoughtIncludedOf = (entry: Extract<HarnessMessage, { role: 'assistant' }>): boolean =>
        entry.reasoningIncluded !== false;

    /**
     * R7 (T4b): the LIVE verdict of ONE context segment — does what this segment SHOWS still ride
     * in the requests that follow — spelled exactly the way the bar reads it
     * (../shared/turn-display.ts `ContextBlock.included`, and the single client rule
     * ../frontend/view-context.ts `contextBlockIsExcluded`: only a literal `false` dims).
     *
     * WHY IT IS JOINED AND NOT FOLDED: the compiled bar is a fold of one TURN's events and never
     * sees a transcript, so the projector can only mint its static per-kind `inPrompt`
     * (./turn-projector.ts). The verdict below is a fact about the CONVERSATION's committed
     * entries, read at request time through the same three joins the block detail route uses
     * (`blockEntryOf` for a recorded call, `blockThoughtOf` for recorded thinking, `blockAnswerOf`
     * for a recorded answer), which is what makes a reader's toggle, another tab's toggle, and a
     * plugin's `setIncluded` all show up on the next read of the bar with no compiled-cache
     * staleness.
     *
     * THE THREE VERDICTS (the tri-state is the whole point — the client treats ABSENT as
     * "unknown", NOT as "excluded", so defaulting it would dim most of every bar on a false
     * claim, ../frontend/view-context.ts:348-375):
     *   - ABSENT (`undefined`) — no transcript entry stands behind this segment at all, or the
     *     transcript cannot SINGLE one out. That is every `system` block (N instruction entries,
     *     one segment), the `user` prompt (no opening event, hence no call id) and a `steer`; a
     *     thinking window whose bytes match no entry or several entries; and an ANSWER window whose
     *     recorded bytes single out no ONE assistant entry — an answer an earlier assistant entry
     *     repeats verbatim, or an answer whose entry a host Transcript save has since removed
     *     (../shared/turn-display.ts `ContextBlock.included` documents the same list; a SPLIT
     *     answer is not on it, because the projector mints one answer block per run of prose and
     *     each run resolves to the entry that streamed it — `transcriptEntryOfAnswer`). The
     *     renderer states the policy and offers no control, so this function must NEVER invent a
     *     boolean here — not `true` and not `false`;
     *   - `true` — the axis resolves and is switched ON;
     *   - `false` — the axis resolves and is switched OFF, and ONLY for a segment nothing of
     *     reaches the prompt any more (see the tool rule below).
     *
     * WHICH AXIS, PER KIND (mirrors the read/write pair, ./api.ts `getSessionTurnBlock` and
     * `patchSessionTurnBlock`, so the bar, the chip and the transcript state one figure):
     *   - a `reasoning` block names no call, so the entry join answers nothing for it and the
     *     THINKING axis decides — the flag T6 put beside the thinking (`reasoningIncluded`) lives
     *     on the one assistant entry whose `reasoning` field IS these recorded bytes;
     *   - an `assistant` block names no call either, and its recorded answer bytes are the identity
     *     that resolves the ENTRY (FIX C) — the same text-is-the-key rule the thinking join uses,
     *     with the same refusal on ambiguity, so a withheld answer now dims the way a withheld
     *     thinking window does;
     *   - every other block is decided by the ENTRY the segment resolves to, per entry and with no
     *     unit cascade (R8 removed the fan-out).
     *
     * THE TOOL RULE (why a withheld REQUEST does not dim the segment): a tool's request and its
     * response are ONE bar segment (`argsChars` + `resultChars` on the same block,
     * ../shared/turn-display.ts `chars`) while `included` is ONE boolean, so a half-included round
     * cannot be drawn half-dimmed — the shipped client states this as a deliberate limitation
     * (../frontend/view-context.ts:367-373: "producers publish `false` only for a unit nothing of
     * reaches the prompt"). R8 made the write per entry, and `projectTranscript` lets a withheld
     * request's RESULT ride as an ownerless entry (../harness.ts:6751-6856). So a tool segment is
     * `false` ONLY when every entry behind it is withheld: the request alone, or the result alone,
     * still leaves bytes of this segment in the prompt, and those answer `true` (opaque).
     */
    const contextSegmentIncludedOf = (
        record: SessionRecord,
        turn: SessionTurn,
        block: ContextBlock
    ): boolean | undefined => {
        if (block.kind === 'reasoning') {
            // THE SEGMENT'S VERDICT IS THE THINKING AXIS, and nothing else — the ratified rule
            // (../shared/turn-display.ts `ContextBlock.included`), and pinned from both sides in
            // ./view.test.ts. It is worth stating what that means next to FIX C's answer join,
            // because the pair is visible on one bar: when an ENTRY leaves the request, the answer
            // window beside this one goes OFF (its `content` is really gone) while this window keeps
            // answering ON, because the thinking flag was never touched. That is not a drift
            // between the two surfaces — it is two axes each stating its own flag, and the reason
            // the bar may not invent a merged verdict (a "nothing of this entry rides" boolean would
            // be a third figure the write does not move).
            // The segment's identity is its recorded bytes (a thinking window carries no id of its
            // own, ./turn-projector.ts mints its block id from the OPENING EVENT INDEX), and the
            // bytes come from the same reader the block detail route uses — one derivation, so the
            // bar and the dialog cannot resolve two different entries for one segment.
            const text = recordedStreamText(turn, 'reasoning', block.eventFrom, block.eventTo);

            if (text === undefined) return undefined;

            const thought = blockThoughtOf(record, turn, { kind: block.kind, text });

            return thought === undefined ? undefined : thoughtIncludedOf(thought.entry);
        }

        // ONE JOIN PER KIND, in the same order the read and the write dispatch (the doc above is
        // the rule): a recorded CALL for a tool segment, recorded ANSWER BYTES for an answer
        // window (FIX C). `blockEntryOf` answers nothing for a kind that mints no call id, which
        // is why the two can share one variable — and why an unresolved segment of ANY kind still
        // answers `undefined` rather than a boolean.
        const target = block.kind === 'assistant' ? blockAnswerOf(record, turn, block) : blockEntryOf(record, turn, block);

        // No entry behind the segment: NO verdict. This is the case the client calls
        // "unaddressable", and it is where a fabricated `true` would be as wrong as a `false`.
        if (target === undefined) return undefined;

        if (target.entry.included !== false) return true;

        // THE OTHER HALF OF A TOOL SEGMENT. `transcriptEntryOfCall` prefers the OWNING assistant
        // entry, so reaching here means the request is withheld; the recorded answer is a separate
        // entry (the tool message for this call id — the lookup `transcriptEntryOfCall` itself
        // falls back to when no owner survives) and it keeps travelling, which keeps the result
        // bytes of THIS segment in the prompt. Same for the mirror case: an orphan result the
        // reader switched off while its owner's request still rides. The `in` test is the type
        // guard that the ANSWER join (which carries no call id) cannot reach this branch at all:
        // an answer window is one entry, and there is no sibling of it to keep riding.
        if (block.kind === 'tool' && 'callId' in target) {
            const sibling = target.messages.find(
                (message) => message.role === 'tool' && message.toolCallId === target.callId && message !== target.entry
            );

            if (sibling !== undefined && sibling.included !== false) return true;
        }

        return false;
    };

    /**
     * R7 (T4b): the turn's compiled bar with the live verdict on every segment that HAS one —
     * the stamp the display route applies so the lane knows, on FIRST PAINT, which segments are
     * out of the context (the dim is `opacity: 0.2`, decided by the shipped reader rule from
     * `included === false`).
     *
     * NOT A REWRITE of the fold: `inPrompt`, every count, stamp and identity field is the
     * projector's own figure, byte-identical, and only the ONE field this file owns is added. A
     * segment whose verdict is ABSENT is returned untouched (the fold's object is reused), so the
     * tree carries no `included` key at all for a policy/unknown segment — the shape
     * ../frontend/display-project.ts copies only when the wire stated it. A segment whose verdict
     * already matches is left alone too, which keeps this a no-op allocation for the common case.
     */
    const displaySectionsWithInclusionOf = (
        record: SessionRecord,
        turn: SessionTurn,
        sections: TurnSection[]
    ): TurnSection[] =>
        sections.map((section) => {
            const context = section.context;

            if (context === undefined || context.length === 0) return section;

            let moved = false;
            const blocks = context.map((block) => {
                const verdict = contextSegmentIncludedOf(record, turn, block);

                if (verdict === undefined || block.included === verdict) return block;

                moved = true;

                return { ...block, included: verdict };
            });

            return moved ? { ...section, context: blocks } : section;
        });

    // ---- root / health / config -------------------------------------------------

    // The boot document: identity, links, capabilities, limits, epoch, clock. CONSTANT SIZE
    // - no catalogue, no defaults, no sessions - which is the whole point of the contract's
    // boot rule (a client that boots this way pays one small request, not 50 MB).
    const root: Handler = (ctx) => {
        const links: Record<string, string> = {
            self: ctx.mount,
            health: `${ctx.mount}/health`,
            config: `${ctx.mount}/config`,
            harnesses: `${ctx.mount}/harnesses`,
            agents: `${ctx.mount}/agents`,
            tools: `${ctx.mount}/tools`,
            // T5 (R2/R3): the built-in plugin catalogue (R3's Plugins pane reads it).
            plugins: `${ctx.mount}/plugins`,
            models: `${ctx.mount}/models`,
            sessions: `${ctx.mount}/sessions`,
            stream: `${ctx.mount}/stream`
        };

        const info: ServiceInfo = {
            api_root: ctx.mount,
            service: 'noobscript-harness',
            api_version: 'v1',
            server_time: Date.now(),
            epoch: events.epoch,
            capabilities: advertisedCapabilities,
            limits: HARNESS_SERVICE_LIMITS,
            links
        };

        return json(200, info);
    };

    const health: Handler = () =>
        json(200, {
            ok: true as const,
            sessions: store.size,
            epoch: events.epoch
        });

    // GLOBAL configuration: the session-visible provider defaults plus read-only
    // deployment runtime facts. A session's own merged settings are per-session state and
    // are reported on the session, never here.
    const configDocument = (): GlobalConfigDocument => ({
        defaults: effectiveProviderDefaults(),
        runtime: runtimeSettingsOf(context.runtime),
        writable_fields: ['settings.base_url', 'settings.model', 'settings.api_key'],
        revision: events.getRevision('config')
    });

    const getConfig: Handler = () => json(200, configDocument(), events.getRevision('config'));

    const patchConfig: Handler = async (ctx) => {
        const body = requireObjectBody<GlobalConfigUpdateRequest>(await ctx.body());

        requireKnownFields(body, ['settings']);

        if (body.settings === undefined) {
            throw new HttpError(400, 'A config patch requires a "settings" object.');
        }

        const settings = body.settings as Record<string, unknown>;

        requireKnownFields(settings, ['base_url', 'model', 'api_key']);

        const keys = Object.keys(settings);

        if (keys.length === 0) throw new HttpError(400, 'A config patch must change at least one setting.');

        // T39 (regression): the patch is DECIDED on a candidate copy of the live settings and only
        // a fully valid candidate is committed. Two defects lived in the previous write-as-you-go
        // loop, and both were invisible until a later route read the damage:
        //   1. no length bound was applied here, so `PATCH /config {base_url: <2049 chars>}`
        //      answered 200 and POISONED `defaults` — every later `POST /sessions` then failed with
        //      the shared validator's 400 ("A provider base URL cannot exceed 2048 characters.")
        //      for a body the client never sent. The caps are therefore imported from
        //      ./config.ts (the single source `mergeSettings` uses, ./config.ts:424-430) and applied
        //      here with the SAME message, so the route that sets the default answers exactly what
        //      the route that consumes it does;
        //   2. the empty-URL refusal (and any refusal below the first key) ran AFTER earlier keys
        //      had already mutated `globalSettings`, so `{base_url: '', model: 'x'}` answered 400
        //      while still moving `model`. A refused patch must mutate nothing.
        // `issuedKey`/`resetKey` keep the T28 credential rule order-independent: the scope of a new
        // credential is assigned from the FINAL base URL, never from key order.
        let nextBaseURL = globalSettings.baseURL;
        let nextModel = globalSettings.model;
        let nextApiKey: string | undefined;
        let issuedKey = false;
        let resetKey = false;

        // A runtime knob in this body is a 400 NAMING it, which is how "deployment-only"
        // stays enforceable instead of being prose. They are not in the allowed set above,
        // so the only realistic mistake is a nested one; keep the message specific.
        for (const key of keys) {
            const value = settings[key];

            if (value === null) {
                // `null` = "back to the shipped default" (the reset target is `defaults`).
                if (key === 'base_url') nextBaseURL = defaults.baseURL;
                else if (key === 'model') nextModel = defaults.model;
                // T28: resetting the key restores the SHIPPED credential together with the
                // provider it belongs to — not "no key", and not the same key pointed at an
                // endpoint a later `base_url` patch happened to move.
                else resetKey = true;

                continue;
            }

            if (typeof value !== 'string') {
                throw new HttpError(400, `"settings.${key}" must be a string or null.`);
            }

            if (key === 'base_url') nextBaseURL = value.trim();
            else if (key === 'model') nextModel = value.trim();
            // T28: an explicit key write issues a NEW process-only credential. Its scope is
            // assigned after validation (see `issuedKey`) so the pair stays well-defined whatever
            // order the body's keys arrive in, and a body the route refuses never retargets the
            // live credential.
            else {
                nextApiKey = value.trim();
                issuedKey = true;
            }
        }

        // Bounds and the non-empty rule, all BEFORE the commit below. The caps measure the
        // TRIMMED value, because that is the string `mergeSettings` later validates and sends.
        if (nextBaseURL.length > MAX_BASE_URL_LENGTH) {
            throw new HttpError(400, `A provider base URL cannot exceed ${MAX_BASE_URL_LENGTH} characters.`);
        }

        if (nextModel.length > MAX_MODEL_LENGTH) {
            throw new HttpError(400, `A model name cannot exceed ${MAX_MODEL_LENGTH} characters.`);
        }

        if (nextBaseURL.trim().length === 0) {
            throw new HttpError(400, 'A provider base URL cannot be empty.');
        }

        // ---- COMMIT: nothing above can fail now, so a 400 left the settings untouched. ----
        globalSettings.baseURL = nextBaseURL;
        globalSettings.model = nextModel;

        if (resetKey) {
            globalSettings.apiKey = bootCredential.apiKey;
            globalSettings.hasKey = defaults.hasApiKey;
            credentialBaseURL = bootCredential.baseURL;
        }

        // T28: the new credential belongs to the endpoint in effect once the whole patch is
        // applied — a body that sets `base_url` and `api_key` together issues the key FOR that
        // provider, and nothing else may receive it.
        if (issuedKey) {
            globalSettings.apiKey = nextApiKey ?? '';
            credentialBaseURL = globalSettings.baseURL;

            // T28: the key must never be echoed, and the `has_api_key` claim follows a credential
            // this process actually issued; an explicit empty string means "no key", which the
            // credential rule and the advertisement both enforce. A `null` write instead restores
            // the shipped claim, which the reset branch above did — it is not a key write.
            globalSettings.hasKey = globalSettings.apiKey.trim().length > 0;
        }

        syncDefaults();

        // T16: the change is DURABLE before the answer (base URL and model only; the credential
        // never enters the document), so a restart does not quietly revert the deployment.
        await store.updateGlobalSettings({
            ...(settings.base_url !== undefined ? { baseURL: (settings.base_url as string | null) } : {}),
            ...(settings.model !== undefined ? { model: (settings.model as string | null) } : {})
        });

        const revision = events.bumpRevision('config');

        publish('config.updated', [{ resource: 'config' }]);

        return json(200, configDocument(), revision);
    };

    // ---- harness definitions ----------------------------------------------------

    // The card projection needs the tool set this host can actually register, so the same
    // `describeHarness` rule the frozen copies use decides the list (R9-R11 pairing).
    const cardOf = (preset: HarnessPreset): HarnessCardPage['items'][number] => {
        const descriptor = describeHarness(preset, catalogue);

        return harnessCardOf(preset, events, descriptor.tools);
    };

    const definitionResponseOf = (preset: HarnessPreset): HarnessDefinitionResponse => {
        const descriptor = describeHarness(preset, catalogue);

        return {
            harness: harnessDefinitionOf(
                preset,
                events,
                descriptor.tools,
                descriptor.coreTools ?? [],
                instructionSummaryOf(preset, registry.agents(), agentState)
            )
        };
    };

    const getHarnesses: Handler = (ctx) => {
        const limit = resolveLimit(ctx.query.get('limit'));
        const cursor = decodeCursor(ctx.query.get('cursor'));
        const search = paramOf(ctx.query, 'q');

        const all = registry.list();
        const filtered =
            search === undefined
                ? all
                : all.filter((preset) =>
                      `${preset.name} ${preset.title} ${preset.description}`.toLowerCase().includes(search.toLowerCase())
                  );

        const page = slicePage(filtered, cursor, limit, filtered.length);

        return json(
            200,
            pageMeta(
                { items: page.items.map((preset) => cardOf(preset)), next: page.next },
                events.getRevision('harnesses')
            )
        );
    };

    const postHarness: Handler = async (ctx) => {
        const body = requireObjectBody<CreateHarnessRequest>(await ctx.body());

        requireKnownFields(body, [
            'name',
            'title',
            'description',
            'primary',
            'subagents',
            'agent_models',
            'agent_instructions',
            'agent_colors'
        ]);

        if (typeof body.name !== 'string' || body.name.length === 0) {
            throw new HttpError(400, 'A harness definition requires a "name".');
        }

        if (typeof body.primary !== 'string' || body.primary.length === 0) {
            throw new HttpError(400, 'A harness definition requires a "primary" agent.');
        }

        // Semantic validation (known agents, duplicates, reserved names, bounds) belongs to
        // the registry, which throws a `HarnessRegistryError` with the right status. The
        // commit is durable BEFORE the 201 and rolls back on a failed write (T5).
        const preset = await store.mutateRegistry(() =>
            registry.create({
                name: body.name,
                ...(body.title === undefined ? {} : { title: body.title }),
                ...(body.description === undefined ? {} : { description: body.description }),
                primary: body.primary,
                ...(body.subagents === undefined ? {} : { subagents: body.subagents }),
                // snake_case at the edge, camelCase in the domain (see NAMING above).
                ...(body.agent_models === undefined ? {} : { agentModels: body.agent_models }),
                ...(body.agent_instructions === undefined ? {} : { agentInstructions: body.agent_instructions }),
                // R2: display colors ride the same edge. Membership and the hex shape are the
                // registry's decision (`normalizeAgentColors`), which is where a 400 naming the
                // agent comes from; this handler only moves bytes.
                ...(body.agent_colors === undefined ? {} : { agentColors: body.agent_colors })
            })
        );

        events.bumpRevision('harnesses');
        events.bumpRevision('definition', preset.name);
        publish('catalogue.updated', [{ resource: 'harnesses' }, { resource: 'definition', id: preset.name }]);

        return json(201, definitionResponseOf(preset), events.getRevision('definition', preset.name));
    };

    const getHarnessOne: Handler = (ctx) => {
        const preset = registry.find(ctx.params.harness_name);

        if (preset === undefined) throw missing('harness', ctx.params.harness_name);

        return json(200, definitionResponseOf(preset), events.getRevision('definition', preset.name));
    };

    const patchHarness: Handler = async (ctx) => {
        const body = requireObjectBody<UpdateHarnessRequest>(await ctx.body());

        requireKnownFields(body, [
            'title',
            'description',
            'primary',
            'subagents',
            'agent_models',
            'agent_instructions',
            'agent_colors'
        ]);

        if (
            body.title === undefined &&
            body.description === undefined &&
            body.primary === undefined &&
            body.subagents === undefined &&
            body.agent_models === undefined &&
            body.agent_instructions === undefined &&
            body.agent_colors === undefined
        ) {
            throw new HttpError(400, 'A patch must change at least one field.');
        }

        // An existing session keeps its frozen copy, so this affects FUTURE sessions only -
        // which is why a saved conversation survives the deletion of its harness.
        const preset = await store.mutateRegistry(() =>
            registry.update(ctx.params.harness_name, {
                ...(body.title === undefined ? {} : { title: body.title }),
                ...(body.description === undefined ? {} : { description: body.description }),
                ...(body.primary === undefined ? {} : { primary: body.primary }),
                ...(body.subagents === undefined ? {} : { subagents: body.subagents }),
                // Present = REPLACE the map; `{}` is the explicit clear.
                ...(body.agent_models === undefined ? {} : { agentModels: body.agent_models }),
                ...(body.agent_instructions === undefined ? {} : { agentInstructions: body.agent_instructions }),
                // R2: same replace semantics for the color map.
                ...(body.agent_colors === undefined ? {} : { agentColors: body.agent_colors })
            })
        );

        events.bumpRevision('harnesses');
        const revision = events.bumpRevision('definition', preset.name);

        publish('catalogue.updated', [{ resource: 'harnesses' }, { resource: 'definition', id: preset.name }]);

        return json(200, definitionResponseOf(preset), revision);
    };

    const deleteHarness: Handler = async (ctx) => {
        const name = ctx.params.harness_name;

        // `registry.remove` throws 404 for an unknown or already-deleted name; a deleted
        // BUILT-IN leaves a tombstone so a restart does not re-ship it.
        const removed = await store.mutateRegistry(() => registry.remove(name));

        const tombstoned = removed.builtin && registry.deletedBuiltins().includes(name);

        events.bumpRevision('harnesses');
        events.bumpRevision('definition', name);
        publish('catalogue.updated', [{ resource: 'harnesses' }]);

        const result: DeleteHarnessResult = {
            deleted: true,
            harness_name: name,
            tombstoned,
            // The tombstone is durable (persistence.ts writes `deleted`), so a restart does
            // NOT resurrect a shipped card the operator removed.
            restored_by_restart: false
        };

        // Every page read stamps its own collection revision in the contract header (a receipt
        // without a revision simply carries none), so a client can order a read against a stream
        // frame from the response headers alone.
        return json(200, result, (result as { revision?: number }).revision);
    };

    const getHarnessInstructions: Handler = (ctx) => {
        const preset = registry.find(ctx.params.harness_name);

        if (preset === undefined) throw missing('harness', ctx.params.harness_name);

        const items = instructionSummaryOf(preset, registry.agents(), agentState);

        const response: HarnessInstructionIndexResponse = {
            harness_name: preset.name,
            total: items.length,
            items
        };

        // Not paged: membership is bounded by the definition, so the whole index is already
        // the bounded projection.
        return json(200, response);
    };

    const getHarnessInstructionText: Handler = (ctx) => {
        const preset = registry.find(ctx.params.harness_name);

        if (preset === undefined) throw missing('harness', ctx.params.harness_name);

        const agent = ctx.params.agent_id;

        if (!preset.agents.includes(agent)) {
            throw new HttpError(404, `Agent "${agent}" is not a member of harness "${preset.name}".`);
        }

        const response = instructionTextOf(preset, agent, registry.agents()) as HarnessInstructionTextResponse;

        return json(200, response);
    };

    // ---- global agents ----------------------------------------------------------

    /** The harnesses that select one profile, so a client can show what a removal would strand. */
    const referencedBy = (profile: string): string[] =>
        registry
            .list()
            .filter((preset) => preset.agents.includes(profile))
            .map((preset) => preset.name);

    const getAgents: Handler = (ctx) => {
        const limit = resolveLimit(ctx.query.get('limit'));
        const cursor = decodeCursor(ctx.query.get('cursor'));

        const profiles = registry.agents();
        const page = slicePage(profiles, cursor, limit, profiles.length);

        const result: AgentSummaryPage = pageMeta(
            { items: page.items.map((profile) => agentSummaryOf(profile, agentState)), next: page.next },
            events.getRevision('agents')
        );

        // Every page read stamps its own collection revision in the contract header (a receipt
        // without a revision simply carries none), so a client can order a read against a stream
        // frame from the response headers alone.
        return json(200, result, (result as { revision?: number }).revision);
    };

    const findProfile = (name: string) => registry.agents().find((profile) => profile.name === name);

    const getAgentOne: Handler = (ctx) => {
        const profile = findProfile(ctx.params.agent_id);

        if (profile === undefined) throw missing('agent', ctx.params.agent_id);

        const response: AgentProfileResponse = {
            agent: agentProfileOf(profile, events, referencedBy(profile.name), agentState)
        };

        return json(200, response, events.getRevision('agents', profile.name));
    };

    // T19: these two WRITE. The overrides live in the global agent layer
    // (./harnesses/agent-state.ts), which never mutates the frozen catalogue objects: an
    // effective profile is always a fresh merge. The write is committed INSIDE
    // `store.mutateRegistry`, so the overlay file and the harness entries share ONE durable
    // unit and one rollback (a failed write restores the captured snapshot, agent decisions
    // included). The layer is read when a NEW session builds its agents, which is what makes
    // "future sessions only" structural: an existing session's brains are already-built
    // objects nothing here reaches.
    const patchAgent: Handler = async (ctx) => {
        const name = ctx.params.agent_id;
        const body = requireObjectBody<UpdateAgentRequest>(await ctx.body());

        requireKnownFields(body, ['title', 'description', 'instruction', 'guidelines']);

        // An unknown id is 404, and so is a RETIRED one: a retired profile is out of the
        // selectable catalogue, and this contract has no agent-create route that could
        // revive it (the shipped catalogue is the only source of a profile).
        if (agentState.effective(name) === undefined) throw missing('agent', name);

        const stated = (['title', 'description', 'instruction', 'guidelines'] as const).some((field) =>
            Object.prototype.hasOwnProperty.call(body, field)
        );

        if (!stated) throw new HttpError(400, 'A patch must change at least one field.');

        // An explicit `null` RESTORES the shipped catalogue value for that field (the layer
        // removes the override), while an omitted field is no change.
        const patch: AgentProfilePatch = {
            ...(Object.prototype.hasOwnProperty.call(body, 'title') ? { title: body.title ?? null } : {}),
            ...(Object.prototype.hasOwnProperty.call(body, 'description')
                ? { description: body.description ?? null }
                : {}),
            ...(Object.prototype.hasOwnProperty.call(body, 'instruction')
                ? { instruction: body.instruction ?? null }
                : {}),
            ...(Object.prototype.hasOwnProperty.call(body, 'guidelines')
                ? { guidelines: body.guidelines ?? null }
                : {})
        };

        const profile = await commitAgentEdit(() => registry.patchAgent(name, patch));

        events.bumpRevision('agents');
        const revision = events.bumpRevision('agents', name);

        publish(
            'agent.registry_updated',
            [{ resource: 'agents' }, { resource: 'agents', id: name }],
            { agent_id: name }
        );

        const response: AgentProfileResponse = {
            agent: agentProfileOf(profile, events, referencedBy(name), agentState)
        };

        return json(200, response, revision);
    };

    const deleteAgent: Handler = async (ctx) => {
        const name = ctx.params.agent_id;

        // Same 404 rule as the patch: an unknown id and an already-retired one are both
        // "nothing to remove", and a repeat DELETE must not answer a second success.
        if (agentState.effective(name) === undefined) throw missing('agent', name);

        await commitAgentEdit(() => registry.retireAgent(name));

        const tombstoned = registry.deletedAgents().includes(name);

        events.bumpRevision('agents');
        const revision = events.bumpRevision('agents', name);

        publish(
            'agent.registry_updated',
            [{ resource: 'agents' }, { resource: 'agents', id: name }],
            { agent_id: name, retired: true }
        );

        const result: DeleteAgentResult = {
            deleted: true,
            agent_id: name,
            tombstoned,
            // Honest durability: with a database root the tombstone is in
            // `<root>/harness/agents.json`, so a restart does NOT resurrect the profile.
            // Without one the overlay is process state and the shipped catalogue wins on
            // the next start - which is exactly what this field tells the client.
            restored_by_restart: databaseRoot === undefined
        };

        return json(200, result, revision);
    };

    // ---- tool catalogue ---------------------------------------------------------

    const getTools: Handler = (ctx) => {
        const limit = resolveLimit(ctx.query.get('limit'));
        const cursor = decodeCursor(ctx.query.get('cursor'));
        const group = paramOf(ctx.query, 'group');
        const availability = enumParamOf(ctx.query, 'availability', ['available', 'unconfigured'] as const);

        let entries = toolEntries();

        if (group !== undefined) entries = entries.filter((entry) => entry.group === group);

        if (availability !== undefined) {
            entries = entries.filter((entry) => (entry.availability?.state ?? 'available') === availability);
        }

        const page = slicePage(entries, cursor, limit, entries.length);

        const result = pageMeta(
            {
                items: page.items.map((entry) => toolSummaryOf(entry, entry.name, undefined, toolEnablementOf(entry.name))),
                next: page.next
            },
            events.getRevision('tools')
        );

        // Every page read stamps its own collection revision in the contract header (a receipt
        // without a revision simply carries none), so a client can order a read against a stream
        // frame from the response headers alone.
        return json(200, result, (result as { revision?: number }).revision);
    };

    const getToolOne: Handler = (ctx) => {
        const name = ctx.params.tool_id;
        // ONE resolver for both surfaces (./api-reads.ts `toolEntryOf`): the harness-owned
        // entries first, then the callable catalogue, so a global row and a session row about
        // the same name state the same group/visibility/session-bound facts.
        const entry = toolEntryOf(name, context);

        if (entry === undefined) throw missing('tool', name);

        const response: ToolDetailResponse = { tool: toolDetailOf(entry, name, toolEnablementOf(name)) };

        return json(200, response);
    };

    // `PATCH /tools/{tool_id}` — R3's GLOBAL tool switch, one boolean, for every session.
    //
    // WRITE-ANYTIME (R1): no `assertIdleForToolMutation` here, unlike the session-scoped
    // switch (./api.ts `setSessionToolEnabled`), and the difference is real rather than
    // convenient. That route mutates ONE live harness (an entry leaves a cap slot or a
    // declaration a run was promised), so it needs its session quiet; this one changes a
    // deployment-wide ANSWER that the runtime re-reads when it builds the NEXT request's
    // tool list (../harness.ts `declared`, the launch gate, and `toolRequest`'s forbidden
    // report). Nothing is un-registered, no schema disappears mid-turn, and a run in flight
    // keeps exactly the declarations it was given — so there is no disagreement to 409
    // about, and the Tools page stays reachable while a thread is running.
    //
    // DURABLE BEFORE THE ANSWER (the plugins precedent): the commit runs inside
    // `store.updateToolEnabled` and a failed write is a 500 whose in-process value stays
    // applied, because the sessions already honour it and a rollback would claim a failure
    // the running conversations did not have.
    const patchTool: Handler = async (ctx) => {
        const name = ctx.params.tool_id;
        // ONE resolver for both surfaces (./api-reads.ts `toolEntryOf`): the harness-owned
        // entries first, then the callable catalogue, so a global row and a session row about
        // the same name state the same group/visibility/session-bound facts.
        const entry = toolEntryOf(name, context);

        // Identity FIRST, so a typo on a name that does not exist is a 404 and never a
        // 403 about protection or a 400 about a body the client has not sent yet.
        if (entry === undefined) throw missing('tool', name);

        const body = requireObjectBody<ToolSettingsUpdate>(await ctx.body());

        requireKnownFields(body, ['enabled']);

        if (typeof body.enabled !== 'boolean') {
            throw new HttpError(400, '"enabled" must be a boolean (true runs the tool, false disables it for every session).');
        }

        // R5: NO protected-name exception here. A harness-owned core tool takes this write
        // exactly like a catalogue entry — the switch gates what an AGENT may reach, so
        // disabling `toolRequest` or `tasks` hides it from every model declaration and
        // nothing else. The only refusals left are the route's 404 (unknown name, checked
        // first) and the store's 400 (blank name), both thrown before any mutation, so a
        // refused switch is a no-op. An idempotent write is accepted: the contract's
        // switches never punish a client for stating the current state.
        await store.updateToolEnabled(name, body.enabled);

        const response: ToolDetailResponse = { tool: toolDetailOf(entry, name, toolEnablementOf(name)) };

        // The collection revision is the tool settings store's own counter (one bump per
        // accepted switch), on the same rule `GET /plugins` uses for its pane: `tools`
        // enablement is not a `StreamResourceKind` update, and the Tools pane rereads on
        // save. The catalogue's own hub revision is unaffected — no registration changed.
        return json(200, response, toolSettings.revision());
    };

    // Global execution resolves through the DEPLOYMENT catalogue only: there is no session
    // field to reach another session's registry, and a harness-owned control tool has no
    // standalone implementation at all (hence 403, not 400 - it is a policy refusal).
    const postToolExecution: Handler = async (ctx) => {
        const name = ctx.params.tool_id;
        // ONE resolver for both surfaces (./api-reads.ts `toolEntryOf`): the harness-owned
        // entries first, then the callable catalogue, so a global row and a session row about
        // the same name state the same group/visibility/session-bound facts.
        const entry = toolEntryOf(name, context);

        if (entry === undefined) throw missing('tool', name);

        const body = requireObjectBody<{ parameters?: unknown }>(await ctx.body());

        requireKnownFields(body, ['parameters']);

        const started = Date.now();

        if (entry.sessionBound === true) {
            throw new HttpError(
                403,
                `Tool "${name}" runs inside a session; call it through ${ctx.mount}/sessions/{session_id}/tools/${name}/executions.`
            );
        }

        if (!Object.prototype.hasOwnProperty.call(body, 'parameters') && body.parameters === undefined) {
            // `parameters` is optional on this contract; an absent field is an empty argument
            // box, exactly like `{ "parameters": {} }`.
            body.parameters = {};
        }

        if (entry.tool === undefined) {
            // Listed but unconfigured: a tool failure reported as DATA (200 ok:false), with
            // the catalogue hint (variable names, never values) as the message.
            return json(200, toolCallFailure(
                entry.availability?.hint ?? `Tool "${name}" is not configured on this server.`,
                Date.now() - started
            ));
        }

        try {
            // Same resolver the model path uses, in 'direct' mode: both documented argument
            // shapes keep working, and a wrong type becomes a readable tool error.
            const raw = body.parameters === null ? {} : body.parameters;
            const parameters = resolveToolParameters(entry.parameters, raw, 'direct');
            const value = await entry.tool(parameters as never);

            return json(200, successfulToolResult(value, started));
        } catch (error) {
            return json(200, toolCallFailure(boundErrorMessage(error), Date.now() - started));
        }
    };

    // ---- plugins (T5 / R2-R3, session-scoped by R4) -----------------------------

    // The PROCESS/TEMPLATE store, reached THROUGH the store that owns it, so this dispatcher
    // never builds a second catalogue: a `PATCH /v1/harness/plugins/{plugin_id}` here writes
    // the map that every session CREATED AFTER IT copies down (./plugins.ts
    // `copyPluginSettingsStore`, ./sessions.ts `create`), and the map the two global routes
    // report. A session's own values come from `requireSession(id).plugins` — R4's per-session
    // store, whose live provider is the one that session's harness reads (./sessions.ts
    // `buildHarness`).
    const plugins = store.pluginSettings;

    // One declared descriptor -> one wire `PluginSetting`. The spellings already match (the
    // spec copied them from `HarnessPluginSettingDescriptor`), so this is a presence filter,
    // not a rename: an unset optional stays absent rather than becoming `undefined` on the wire.
    const pluginSettingOf = (entry: HarnessPluginSettingDescriptor): PluginSetting => ({
        key: entry.key,
        label: entry.label,
        type: entry.type,
        default: entry.default,
        ...(entry.min === undefined ? {} : { min: entry.min }),
        ...(entry.max === undefined ? {} : { max: entry.max }),
        ...(entry.step === undefined ? {} : { step: entry.step }),
        ...(entry.description === undefined ? {} : { description: entry.description }),
        // The 2026-11-13 display fields (group + nesting), same presence rule as every other
        // optional key: a plugin that declares neither keeps the exact wire key set it had before
        // they existed, which is what `src/server/plugins-api.test.ts` pins row by row. `group` is
        // projected field by field rather than passed through, so only the two contract keys can
        // reach the wire (closed object) and the plugin's own metadata literal is never shared
        // with a client that might mutate it — the same reason `pluginRowOf` copies `tags`.
        ...(entry.group === undefined ? {} : { group: { id: entry.group.id, title: entry.group.title } }),
        ...(entry.parentKey === undefined ? {} : { parentKey: entry.parentKey })
    });

    /**
     * One built-in plugin as an operator sees it: the metadata the plugin file itself declares
     * (via the generated manifest) beside the EFFECTIVE values THIS SCOPE reads right now.
     *
     * THE SHARED ROW BUILDER (R4). `settings` is the store the value half of the row resolves
     * through — the process/template store for `GET /plugins` and `PATCH /plugins/{plugin_id}`,
     * a session's own store for `GET /sessions/{id}/plugins`, `GET
     * /sessions/{id}/plugins/{plugin_id}` and its PATCH. Nothing else about the row changes, so
     * the two surfaces are the SAME `PluginSummary` schema (`PluginSummary` is referenced by
     * `PluginSummaryPage` and `PluginDetailResponse` on all five routes — the contract states
     * the shape identity, and this function is the only builder of it), which is what lets the
     * next task render one settings pane against either scope.
     *
     * `values` comes from the store's settings-view resolution, so a row and a live plugin can
     * never disagree; `settings[].default` is the reset target a `null` patch restores.
     * `enabled` is R2's switch — the reserved key the hook gate consults (./plugins.ts,
     * ../plugin/host.ts), read through the same live store, so a row that says `false` means
     * the plugin is not running its hooks IN THAT SCOPE right now (the template scope's row
     * states what the NEXT session created here will run with).
     */
    const pluginRowOf = (settings: HarnessPluginSettingsStore, metadata: HarnessPluginMetadata): PluginSummary => {
        const tags = metadata.tags === undefined ? undefined : [...metadata.tags];
        const hooks = metadata.hooks === undefined ? undefined : [...metadata.hooks];

        return {
            name: metadata.name,
            title: metadata.title,
            ...(metadata.description === undefined ? {} : { description: metadata.description }),
            // Declared-only, like `description`: a plugin that never prompts emits NO key, so
            // every other row keeps the exact key set it had before this field existed
            // (src/server/plugins-api.test.ts pins the shipped catalogue's key sets). This one
            // DOES rename on the way out — `metadata.systemPrompt` (internal camelCase,
            // ../types/index.ts) -> `system_prompt` (wire snake_case, ../server/harness.swagger.yaml
            // `PluginSummary`) — the same mapping every other REST key here makes.
            ...(metadata.systemPrompt === undefined ? {} : { system_prompt: metadata.systemPrompt }),
            ...(metadata.version === undefined ? {} : { version: metadata.version }),
            ...(tags === undefined || tags.length === 0 ? {} : { tags }),
            ...(hooks === undefined || hooks.length === 0 ? {} : { hooks }),
            // Every row on this route is auto-scanned from `src/plugins`, so `builtin` is true;
            // the field stays explicit (never inferred client-side) for the same reason the
            // harness card states it.
            builtin: metadata.builtin ?? true,
            // R2 — read live from the same store the harness's gate consults, so the row
            // and the runtime answer with one voice. A plugin that declares no `enabled`
            // setting still has one (the reserved key); `values` stays declared-only.
            enabled: settings.enabled(metadata.name),
            settings: (metadata.settings ?? []).map(pluginSettingOf),
            values: settings.values(metadata.name)
        };
    };

    // `GET /plugins` — the loaded catalogue plus what each plugin is set to. Answerable with no
    // harness and no model, in the manifest's stable order (path-ascending from the scan).
    //
    // R4 SCOPE: the rows report the PROCESS/TEMPLATE store — the values the NEXT session created
    // here copies down. They are deliberately NOT "what every running session reads" any more;
    // `GET /sessions/{id}/plugins` is that question, per session, with the identical row shape.
    const getPlugins: Handler = (ctx) => {
        const limit = resolveLimit(ctx.query.get('limit'));
        const cursor = decodeCursor(ctx.query.get('cursor'));
        const search = paramOf(ctx.query, 'q');

        const all = [...plugins.descriptors];
        const filtered =
            search === undefined
                ? all
                : all.filter((metadata) =>
                      `${metadata.name} ${metadata.title} ${metadata.description ?? ''} ${
                          (metadata.tags ?? []).join(' ')
                      }`
                          .toLowerCase()
                          .includes(search.toLowerCase())
                  );

        const page = slicePage(filtered, cursor, limit, filtered.length);

        // The collection revision is the plugin settings store's own counter (one bump per
        // accepted PATCH). It is NOT a hub counter: `plugins` is not a `StreamResourceKind`, and
        // adding one would change the stream's bounded per-scope baseline set for a pane that
        // rereads on open and on save. Same epoch, so a client's staleness test still holds.
        return json(
            200,
            pageMeta({ items: page.items.map((metadata) => pluginRowOf(plugins, metadata)), next: page.next }, plugins.revision())
        );
    };

    // `PATCH /plugins/{plugin_id}` — edit one plugin's settings, including its `enabled` switch.
    //
    // IMMEDIATE and durable: the store applies the value to the live map the harness reads, then
    // the document carrying it is written BEFORE the answer (the store's rule for every
    // structural mutation, ./sessions.ts `updatePluginSettings`). No stream publish: there is no
    // `plugins` update kind in the contract's vocabulary, and the Plugins pane rereads.
    //
    // WRITE-ANYTIME by design (R1): there is NO idle gate here, unlike a session's tool switch
    // (`assertIdleForToolMutation`). A setting write is not a structural change to a harness — no
    // registration moves, no schema the model was promised disappears — and the page has to stay
    // usable while a conversation is running, so the value simply takes effect on the next turn
    // of every session. `{settings:{enabled:false}}` is the one-click global off switch; the
    // response row reports the new state, so the client never re-reads to confirm its own click.
    //
    // R4 SCOPE: this writes the PROCESS/TEMPLATE store, so what it changes is (a) every session
    // created AFTER the write and (b) nothing that already exists. The pre-R4 wording "changes
    // what an existing session reads on its next turn" moved to the session route below
    // (`PATCH /sessions/{session_id}/plugins/{plugin_id}`), and `./plugins-api.test.ts` pins
    // both halves of the new rule.
    const patchPlugin: Handler = async (ctx) => {
        const name = ctx.params.plugin_id;
        const body = requireObjectBody<PluginSettingsUpdate>(await ctx.body());

        requireKnownFields(body, ['settings']);

        if (body.settings === undefined) {
            throw new HttpError(400, 'A plugin settings patch requires a "settings" object.');
        }

        // Validation (unknown plugin => 404, unknown key / wrong type / out-of-range => 400) is
        // the store's decision and throws BEFORE it mutates anything, so this handler only moves
        // bytes - the same split `patchHarness` follows with the definition registry.
        await store.updatePluginSettings(name, { ...body.settings });

        const metadata = plugins.metadata(name);

        if (metadata === undefined) throw missing('plugin', name);

        const revision = plugins.revision();

        return json(200, { plugin: pluginRowOf(plugins, metadata) } satisfies PluginDetailResponse, revision);
    };

    // ---- session plugin settings (R4) -------------------------------------------
    //
    // THE SESSION-SCOPED PAIR. Same row schema, same body schema, same validation and status
    // codes as the two routes above, and one different word: SCOPE. Everything here reads and
    // writes `requireSession(id).plugins` — the store that session's harness holds the live
    // provider of — so:
    //
    //   - a PATCH here changes what THAT session reads on its very next turn, with no rebuild,
    //     because the provider is a live reference into that session's own map (the identical
    //     mechanism R2 proved process-wide, now per session);
    //   - it changes nothing else: no other session, and not the template a later session
    //     copies. That isolation is the requirement, and the response rows of both scopes are
    //     the evidence a client can read in the same request cycle;
    //   - the collection `revision` (body and `X-Harness-Revision` header) is THAT SESSION'S
    //     store counter — 0 until this session has accepted a PATCH, one bump per accepted
    //     PATCH. It is a per-session staleness test, exactly like the global counter is a
    //     template staleness test, and the two counters never move each other: a client
    //     watching a session's plugins pane is not invalidated by someone editing the template,
    //     and vice versa. Documented in the contract on both new paths.
    //
    // The plugin CATALOGUE is not session state: every session's store is seeded from the same
    // generated manifest, so rows, declared settings and defaults are identical everywhere and
    // only the resolved `enabled`/`values` differ.

    // `GET /sessions/{session_id}/plugins` — this session's plugin rows.
    const getSessionPlugins: Handler = (ctx) => {
        // Identity FIRST: an unknown session is a 404 before any paging parameter is read.
        const record = requireSession(ctx.params.session_id);

        const limit = resolveLimit(ctx.query.get('limit'));
        const cursor = decodeCursor(ctx.query.get('cursor'));
        const search = paramOf(ctx.query, 'q');

        // The session's own store answers `descriptors` too (the same generated manifest), so
        // the page is built exactly like the global one and cannot drift into a second
        // catalogue. Filter, order and paging are the global route's rules, unchanged.
        const all = [...record.plugins.descriptors];
        const filtered =
            search === undefined
                ? all
                : all.filter((metadata) =>
                      `${metadata.name} ${metadata.title} ${metadata.description ?? ''} ${
                          (metadata.tags ?? []).join(' ')
                      }`
                          .toLowerCase()
                          .includes(search.toLowerCase())
                  );

        const page = slicePage(filtered, cursor, limit, filtered.length);

        const result = pageMeta(
            {
                items: page.items.map((metadata) => pluginRowOf(record.plugins, metadata)),
                next: page.next
            },
            record.plugins.revision()
        );

        // Same header rule as every other page here: the revision the read landed at travels on
        // the response too, so a client can order it against a stream frame. HERE it is this
        // SESSION's counter, so the header is a staleness test for this session's pane only.
        return json(200, result, record.plugins.revision());
    };

    // `GET /sessions/{session_id}/plugins/{plugin_id}` — one row, this session's values.
    const getSessionPlugin: Handler = (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const name = ctx.params.plugin_id;

        // Plugin identity is the second 404 (session first), and it is answered by the
        // catalogue, which every session shares — so an unknown plugin is 404 on a session route
        // exactly like it is on the global one.
        const metadata = record.plugins.metadata(name);

        if (metadata === undefined) throw missing('plugin', name, record.id);

        const response: PluginDetailResponse = { plugin: pluginRowOf(record.plugins, metadata) };

        return json(200, response, record.plugins.revision());
    };

    // `PATCH /sessions/{session_id}/plugins/{plugin_id}` — edit one plugin FOR THIS SESSION.
    //
    // WRITE-ANYTIME, and for the same reason the global route is: a settings write moves no
    // registration and removes no schema the model was promised. That is the deliberate split
    // from a session's TOOL switch (`assertIdleForToolMutation`), which mutates one live harness
    // and therefore needs the session idle — plugin settings are declarative values a live
    // provider re-reads, so this route has no 409 path at all.
    //
    // DURABLE BEFORE THE ANSWER: `store.updateSessionPluginSettings` commits the session's copy
    // into the whole-document checkpoint before it resolves, so a 200 here survives a restart
    // (the same receipt rule as every other structural write, and pinned across a real restart
    // by ./plugins-api.test.ts). A failed write leaves the value applied in memory and reports
    // the 500, because the session already runs with it — rolling back would claim a failure the
    // running conversation did not have.
    const patchSessionPlugin: Handler = async (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const name = ctx.params.plugin_id;

        // Identity (session, then plugin existence via the store's own 404) resolves before the
        // BODY is read, the order `patchTool` sets: a wrong id is a 404, never a 400 about a
        // body the client has not sent.
        const body = requireObjectBody<PluginSettingsUpdate>(await ctx.body());

        requireKnownFields(body, ['settings']);

        if (body.settings === undefined) {
            throw new HttpError(400, 'A plugin settings patch requires a "settings" object.');
        }

        // Unknown key / wrong type / out-of-range => the store's 400, thrown BEFORE it mutates
        // (validate-all-then-mutate), so a refused patch is a no-op on this session.
        await store.updateSessionPluginSettings(record.id, name, { ...body.settings });

        // Re-read the record: nothing here replaces a session, but reading it again is what
        // keeps the row honest if a future write path does.
        const current = requireSession(record.id);
        const metadata = current.plugins.metadata(name);

        if (metadata === undefined) throw missing('plugin', name, current.id);

        const response: PluginDetailResponse = { plugin: pluginRowOf(current.plugins, metadata) };

        return json(200, response, current.plugins.revision());
    };

    // ---- model discovery --------------------------------------------------------

    const postModels: Handler = async (ctx) => {
        const body = requireObjectBody<ModelDiscoveryRequest>(await ctx.body());

        requireKnownFields(body, ['settings']);

        const input = settingsInputOf(body.settings as Record<string, unknown> | undefined, 'body');

        // T28: the effective defaults go in KEY-FREE (`apiKey: ''`) because the advertised
        // defaults document is not a credential source; the real key arrives through the
        // private `settings` channel, scoped to the provider that issued it. `mergeSettings`
        // enforces the credential rule (a foreign base URL with no explicit key gets no
        // server key).
        //
        // A body-less discovery call is therefore resolved entirely from the injected
        // settings — this route never reads `process.env` for a URL or a key, which is what
        // made an omitted `settings` body depend on whatever the machine happened to export.
        const settings = mergeSettings(
            { baseURL: context.defaults.baseURL, model: context.defaults.model, apiKey: '' },
            input,
            providerCredential()
        );

        if (settings.baseURL.trim().length === 0) {
            throw new HttpError(400, 'Set a provider base URL before listing models.');
        }

        try {
            const ids = await listModelsWithRetry({
                baseURL: settings.baseURL,
                apiKey: settings.apiKey.trim().length === 0 ? undefined : settings.apiKey
            });

            const payload: ModelIndex = { models: ids, observed_at: Date.now() };

            return json(200, payload);
        } catch (error) {
            if (error instanceof ModelListError) {
                throw new HttpError(error.kind === 'configuration' ? 400 : 502, error.message);
            }

            throw error;
        }
    };

    // ---- sessions ---------------------------------------------------------------

    const sessionResponseOf = (record: SessionRecord): SessionResponse => ({
        session: sessionResourceOf(record, context)
    });

    const getSessions: Handler = (ctx) => {
        const limit = resolveLimit(ctx.query.get('limit'));
        const cursor = decodeCursor(ctx.query.get('cursor'));
        const status = enumParamOf(ctx.query, 'status', ['idle', 'running', 'error'] as const);
        const harness = paramOf(ctx.query, 'harness');

        // The live records, projected to rows: `store.list()` would deep-copy every turn of
        // every session, which is the payload class this route exists to remove.
        let records = store.liveSessions();

        if (status !== undefined) records = records.filter((record) => record.status === status);
        if (harness !== undefined) records = records.filter((record) => record.preset.name === harness);

        const page = slicePage(records, cursor, limit, records.length);

        // The collection counter is the `(session, null)` key: the same kind a per-session
        // counter uses, with no id. That is how a client tells "the rail changed" (an item was
        // added or removed) from "this row changed" (its own revision moved).
        const result: SessionSummaryPage = pageMeta(
            { items: page.items.map((record) => sessionSummaryOf(record, context)), next: page.next },
            events.getRevision('session', null)
        );

        // Every page read stamps its own collection revision in the contract header (a receipt
        // without a revision simply carries none), so a client can order a read against a stream
        // frame from the response headers alone.
        return json(200, result, (result as { revision?: number }).revision);
    };

    const postSession: Handler = async (ctx) => {
        const body = requireObjectBody<CreateSessionRequest>(await ctx.body());

        requireKnownFields(body, ['harness', 'title', 'settings', 'messages']);

        if (typeof body.harness !== 'string' || body.harness.length === 0) {
            throw new HttpError(400, 'A session requires a harness name.');
        }

        // ISSUE 0005 (C) — the optional SEEDED TRANSCRIPT, validated BEFORE anything exists.
        //
        // WHY THE ORDER MATTERS: `messages` is the one piece of recorded state a client may hand the
        // built-in session API (importing a history, forking at turn N). A transcript PUT deliberately
        // accepts a broken document (it is stored raw as `unreadable`, because an operator's editor
        // buffer is the user's own data). A SEED has no such reader-repair story: a half-created session
        // whose conversation is an unreadable placeholder is a broken session, so the seed is refused
        // with a 400 and NOTHING is created — the same "validate before the mutation" discipline the
        // submit route applies to `attachments`.
        //
        // The reader IS the runtime's own (`readHarnessMessages`, src/core/snapshot.ts), so a seed that
        // passes here is a document `snapshot()` and `restore()` also accept, and the ids it mints
        // (`msg-<n>`, backfilled per entry) are exactly what the transcript read will show later. An
        // empty array is a VALID seed — "start this conversation with no transcript at all" — and so is
        // a list with no `system` entry, which is the client's decision, not a server error.
        //
        // The detached copy the reader returns IS what gets written: it is the client's document with
        // every entry validated and every absent `messageId` backfilled (`msg-<n>`), so the transcript
        // the session ends up with is exactly the list this route accepted. The store write below
        // re-validates it, and that reader is idempotent (an id already present is carried verbatim).
        let seed: HarnessMessage[] | undefined;

        if (body.messages !== undefined) {
            try {
                seed = readHarnessMessages(body.messages, 'body.messages');
            } catch (error) {
                throw new HttpError(400, messageOf(error));
            }
        }

        const input = settingsInputOf(body.settings as Record<string, unknown> | undefined, 'body');

        // A session is created from the CURRENT global defaults, so a `/config` patch is
        // visible to the next session without restarting the process.
        //
        // T28: the credential is decided once, by the same rule the discovery route uses.
        //   - a client key or THIS process's credential (injected, or an operator's
        //     `/config` api_key write) is forwarded as an explicit key only when the scoped
        //     merge actually resolved one for the session's provider;
        //   - when no credential resolves, the field is left UNSET so the store applies its
        //     own scoped rule — the store owns the deployment settings, and inventing a value
        //     here (the old 'configured' placeholder) is what put a non-secret bearer token on
        //     the wire for every settings-free create.
        const effective = mergeSettings(
            { baseURL: context.defaults.baseURL, model: context.defaults.model, apiKey: '' },
            input,
            providerCredential()
        );

        const session = await store.create(body.harness, {
            baseURL: effective.baseURL,
            model: effective.model,
            ...(effective.apiKey.trim().length === 0 ? {} : { apiKey: effective.apiKey })
        });

        const record = store.liveSession(session.id);

        // ISSUE 0005 (C) — the seed is written through the SAME store call the transcript PUT makes
        // (`store.updateThreadTranscript`, src/server/sessions.ts:9170), so it inherits that write's
        // whole contract instead of re-deriving a weaker one: the shared `readHarnessMessages` validation
        // (a second, idempotent pass), the runtime's live-work guard (409), the in-place install the
        // harness's own `snapshot()` projects, the durable `persistOrThrow` BEFORE this route answers,
        // and the `transcript.updated` signal that moves the `transcript` / `transcript_messages`
        // counters and reaches a watching stream (the hub listener above, not a second publish here).
        //
        // THE TARGET is the entry agent's DEFAULT conversation, `agent:<primary>`: `src/harness.ts` keeps
        // one per configured agent on a freshly built harness (see the `threads()` note there), so this
        // row exists on every session this route can create. The primary is read from the definition THIS
        // session froze (`record.definition.primary`), not from the registry entry, which may have moved
        // since the create.
        //
        // REPLACE, not append: the seed is a transcript DOCUMENT, exactly like the PUT it reuses. A
        // client that wants its history in front of the trusted instruction sends a `system` entry too —
        // a transcript write is the operator surface where that is legal; the harness DEFINITION's prompt
        // text stays trusted-catalogue-only (src/agents/types.ts).
        //
        // The only realistic failures left at this point are the live-work guard and an I/O failure (a
        // closed database root); both map through the outer catch to their own status. The body was
        // already validated, so a malformed seed can never reach here and leave a half-built session.
        if (seed !== undefined) {
            const seedThreadId = `${THREAD_AGENT_PREFIX}${record.definition.primary}`;

            await store.updateThreadTranscript(record.id, seedThreadId, seed);

            // Same counter split as `putTranscript` below: the store's signal has already moved
            // `transcript`/`transcript_messages`, and the conversation ROW is the REST-owned counter for a
            // content change like this one, so a client holding the thread row can tell the transcript
            // moved before the first turn ran.
            events.bumpRevision('thread', threadKey(record.id, seedThreadId));
        }

        if (typeof body.title === 'string' && body.title.trim().length > 0) {
            // T16: durable through the store (the document carrying the title is written before
            // this 201 answers), so a named session is still named after a restart.
            await store.renameSession(record.id, body.title);
        }

        // A fresh resource's counter starts at 1 (contract: revisions restart at 1 for a
        // freshly created resource, and the sessions collection moved too).
        const revision = events.bumpRevision('session', record.id);

        events.bumpRevision('definition', record.id);
        events.bumpRevision('turns', record.id);
        events.bumpRevision('threads', record.id);
        // A new row moves the rail's collection counter too, so a client holding the previous
        // page can tell "a session appeared" from "this row changed".
        events.bumpRevision('session', null);
        publish('session.updated', [{ resource: 'session', id: record.id }, { resource: 'session', id: null }]);

        return json(201, sessionResponseOf(record), revision);
    };

    const getSession: Handler = (ctx) => {
        const record = requireSession(ctx.params.session_id);

        return json(200, sessionResponseOf(record), events.getRevision('session', record.id));
    };

    const patchSession: Handler = async (ctx) => {
        const body = requireObjectBody<UpdateSessionRequest>(await ctx.body());

        requireKnownFields(body, ['agent_models', 'title']);

        const record = requireSession(ctx.params.session_id);

        if (body.agent_models === undefined && body.title === undefined) {
            throw new HttpError(400, 'A patch must change at least one field.');
        }

        let result = record;

        if (body.agent_models !== undefined) {
            // The contract MERGES a session model patch (an agent absent from the body keeps
            // its model), while the store's setter replaces the map - so merge here, against
            // the live brains, before handing the whole map over.
            const current = agentModelsOf(record);
            const merged = { ...current, ...body.agent_models };

            await store.setAgentModels(record.id, merged);
            result = store.liveSession(record.id);
        }

        if (body.title !== undefined) {
            if (body.title === null) {
                titles.delete(record.id);
                await store.renameSession(record.id, null);
            } else if (typeof body.title === 'string') {
                const trimmed = body.title.trim();

                titles.delete(record.id);
                // Durable, and `result` is re-read below so the response quotes the saved value.
                await store.renameSession(record.id, trimmed.length === 0 ? null : trimmed);
            } else {
                throw new HttpError(400, '"title" must be a string or null.');
            }

            result = store.liveSession(record.id);
        }

        const revision = events.bumpRevision('session', record.id);

        events.bumpRevision('session_agents', record.id);
        publish('session.updated', [
            { resource: 'session', id: record.id },
            { resource: 'session_agents', id: record.id }
        ], {
            id: record.id,
            revision,
            ...(body.agent_models === undefined ? {} : { agent_models: body.agent_models })
        });

        return json(200, sessionResponseOf(result), revision);
    };

    const deleteSession: Handler = async (ctx) => {
        const record = requireSession(ctx.params.session_id);

        // Counts read off the live record BEFORE the removal: afterwards the record is gone
        // and the receipt could only guess. `store.remove` is the durable boundary, and a
        // miss (removed by another client between the two) is the honest 404.
        const lanes = [...record.lanes.values()];
        const abortedTurns =
            lanes.filter((lane) => (lane as ThreadLaneInfo).active !== undefined).length + (record.busy ? 1 : 0);
        const droppedQueued =
            record.queue.length + lanes.reduce((total, lane) => total + (lane as ThreadLaneInfo).queue.length, 0);

        if (!(await store.remove(record.id))) throw missing('session', record.id);

        titles.delete(record.id);

        // The rail's collection counter moves with an added/removed row (see `getSessions`).
        const revision = events.bumpRevision('session', null);

        publish('session.updated', [{ resource: 'session', id: null }]);

        const result: DeleteSessionResult = {
            deleted: true,
            session_id: record.id,
            aborted_turns: abortedTurns,
            dropped_queued_tasks: droppedQueued
        };

        return json(200, result, revision);
    };

    const getSessionDefinition: Handler = (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const source = registry.find(record.definition.name);

        // `current` compares the frozen copy with the live definition of the same name. A
        // removed harness is never current, which is exactly what a saved session restoring
        // from its own record means.
        const current = source !== undefined && JSON.stringify(describeHarness(source, catalogue)) === JSON.stringify(record.definition);

        const response: SessionDefinitionResponse = {
            definition: sessionDefinitionOf(record, context, { current })
        };

        return json(200, response, events.getRevision('definition', record.id));
    };

    const getSessionUsage: Handler = (ctx) => {
        const record = requireSession(ctx.params.session_id);

        // A server-computed fold of the per-turn tallies: counts walked off the live records,
        // and `usage` absent (never zero) when no provider reported anything.
        return json(200, usageFoldOf(record, context), events.getRevision('usage', record.id));
    };

    // The usage fold lives in ./api-reads.ts (`usageFoldOf`): it walks the recorded turns
    // for their `usage` tallies only, copies nothing, and states per-conversation shares.

    const getSessionCommands: Handler = (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const limit = resolveLimit(ctx.query.get('limit'));
        const cursor = decodeCursor(ctx.query.get('cursor'));

        const rows = commandRowsOf(record);
        const page = slicePage(rows, cursor, limit, rows.length);

        const result: CommandPage = pageMeta({ items: page.items, next: page.next }, events.getRevision('commands', record.id));

        // Every page read stamps its own collection revision in the contract header (a receipt
        // without a revision simply carries none), so a client can order a read against a stream
        // frame from the response headers alone.
        return json(200, result, (result as { revision?: number }).revision);
    };

    const getSessionQueue: Handler = (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const limit = resolveLimit(ctx.query.get('limit'));
        const cursor = decodeCursor(ctx.query.get('cursor'));

        const rows = queueRowsOf(record);
        const page = slicePage(rows, cursor, limit, rows.length);

        const result: QueuedTaskPage = pageMeta({ items: page.items, next: page.next }, events.getRevision('queue', record.id));

        // Every page read stamps its own collection revision in the contract header (a receipt
        // without a revision simply carries none), so a client can order a read against a stream
        // frame from the response headers alone.
        return json(200, result, (result as { revision?: number }).revision);
    };

    // T4 (data plane): the record store read behind the live records/tasks panels.
    //
    // ONE path, two shapes, exactly as the contract states them: no `since` answers the
    // whole store (every collection's field spec and entries, plus the retained feed), and
    // `?since=N` answers only the feed after store position `N`. The rule is "bootstrap
    // once, then page" — a panel that is already showing the store pays for what moved.
    //
    // READ-ONLY by construction: it projects the harness handle's `records()` /
    // `recordsChanges()` and calls no tool, so a browser polling this route moves no
    // revision, writes no journal event, and cannot disturb the model's context. The
    // revision stamped here is the hub's `records` counter — the same figure a
    // `records.updated` frame quotes — which is what makes "read at or above the frame's
    // revision wins" the one ordering rule a client needs.
    const getSessionRecords: Handler = (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const revision = events.getRevision('records', record.id);
        const raw = paramOf(ctx.query, 'since');

        if (raw === undefined) return json(200, recordsSnapshotOf(record, revision), revision);

        // A malformed cursor is a CALLER error and stays a 400. Only a cursor that parses
        // and is no longer answerable is a `reset`, and the two must stay distinguishable:
        // a client has to know whether the server trimmed the window or it sent junk.
        if (!/^\d+$/.test(raw)) {
            throw new HttpError(400, 'Query parameter "since" must be a non-negative integer.');
        }

        const since = Number(raw);

        // A digit string longer than the safe-integer range parses fine but cannot be a
        // real store position (the feed is bounded at 200), so it is refused rather than
        // silently clamped into a `reset` the client did not ask for.
        if (!Number.isSafeInteger(since)) {
            throw new HttpError(400, 'Query parameter "since" must be a non-negative integer within the safe integer range.');
        }

        return json(200, recordsDeltaOf(record, since, revision), revision);
    };

    // The 202/200 acceptance receipt of ONE durable submit, extracted so `POST /tasks` and
    // `POST .../threads/:threadId/resume` cannot state the same acceptance differently (the
    // resume contract promises the identical `TaskReceipt` shape, R1). Pure: it reads the live
    // record and the store's answer, and mutates nothing.
    const taskReceiptOf = (
        mount: string,
        sessionId: string,
        live: SessionRecord,
        submitted: EnqueuedTask,
        sessionRevision: number
    ): TaskReceipt => {
        // T39 (regression): the contract's `TaskReceipt.queue_position` is an ORDINAL with
        // `minimum: 1` (./harness.swagger.yaml:5001-5005 — "equal to `GET .../queue`'s
        // ordering"), while `QueuedTask.position` is the 0-based array slot of the same ordering
        // (./harness.swagger.yaml:5101-5104). Deriving the receipt figure straight from
        // `row.position` therefore reported the FIRST queued task as slot `0`, which the contract
        // forbids and which read as "no place in line". `findIndex` over the same projection keeps
        // the two figures consistent: receipt N == queue page row N-1.
        //
        // A submit that is NOT in a backlog has no position at all: it either became the active
        // run or was steered into one (both report `status` without `queue_position`), which is
        // the intended concurrent plain-thread behaviour.
        const queuedAt = queueRowsOf(live).findIndex((row) => row.turn_id === submitted.turn.id);

        return {
            session_id: sessionId,
            turn_id: submitted.turn.id,
            status: submitted.turn.status,
            thread_id: submitted.turn.threadId ?? submitted.steeredThreadId ?? submitted.turn.threadId ?? '',
            ...(submitted.steered === true ? { steered: true } : {}),
            ...(submitted.steeredThreadId === undefined ? {} : { steered_thread_id: submitted.steeredThreadId }),
            ...(queuedAt === -1 ? {} : { queue_position: queuedAt + 1 }),
            session_revision: sessionRevision,
            accepted_at: Date.now(),
            links: {
                turn: `${mount}/sessions/${sessionId}/turns/${submitted.turn.id}`,
                turns: `${mount}/sessions/${sessionId}/turns`,
                thread:
                    submitted.turn.threadId === undefined
                        ? `${mount}/sessions/${sessionId}/turns`
                        : `${mount}/sessions/${sessionId}/threads/${submitted.turn.threadId}`,
                stream: `${mount}/stream`
            }
        };
    };

    // The durable submit. 202 + a receipt, never the aggregate: the receipt names the turn,
    // its status, the conversation it landed in, the new session revision, and the links to
    // re-read; the content itself arrives on the stream.
    const postSessionTask: Handler = async (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const body = requireObjectBody<SubmitTaskRequest>(await ctx.body());

        requireKnownFields(body, ['input', 'attachments', 'references', 'thread_id']);

        if (typeof body.input !== 'string') throw new HttpError(400, 'A task must be a string.');

        // Validation (empty/200k/attachments/references) and the queue/steer/thread rules
        // live in the store, so this route and a direct embedder cannot disagree.
        const submitted = await store.dispatch(
            record.id,
            body.input,
            body.attachments as HarnessAttachment[] | undefined,
            body.references,
            body.thread_id
        );

        const live = store.liveSession(record.id);

        const sessionRevision = events.bumpRevision('session', record.id);

        // T16 counter domains: the store's own `turn.upsert` signal already moved `turns` and the
        // `turn`/`turn_display`/`turn_events` trio (and the conversation row when a thread was
        // named), so this path moves only what only a request can know: the queue view.
        events.bumpRevision('queue', record.id);

        // The receipt is built from the live backlog BEFORE the publish, exactly as it was
        // before `taskReceiptOf` existed: the queue ordinal describes the backlog as this
        // request left it, not as a lane pump may have drained it by the time the frame is
        // written.
        const receipt = taskReceiptOf(ctx.mount, record.id, live, submitted, sessionRevision);

        // T16: the submit itself does NOT publish a `turn.upsert` body - the store's live signal
        // for the queued row already carries the contract's one-row payload, and a second body for
        // the same change would be a second number for one revision. What only this request knows
        // is the session row and the queue view, so those are what it announces.
        publish('session.updated', [{ resource: 'session', id: record.id }, { resource: 'queue', id: record.id }], {
            session: sessionStatePatchOf(live, context)
        });

        return json(202, receipt, sessionRevision);
    };

    // The durable resume of ONE stopped conversation (R1, POST .../threads/:threadId/resume).
    //
    // The store owns the whole decision (which turn to re-run, and every 404/409 state guard);
    // this route's only job is to answer with the SAME `TaskReceipt` a normal submit answers with,
    // so the browser's receipt→`turn.upsert` handling is reused verbatim (the fixed contract).
    // `200` rather than `202`: the caller asked for one already-recorded task to be re-run, not
    // for a new one to be accepted — but execution is still server-owned and never awaited, so
    // the body is the acceptance receipt of that REQUEUED row, not its answer. It names the SAME
    // `turn_id` the stop left behind, because the resume re-runs that turn in place (same id, same
    // index); a command-shaped input is the one case that cannot be requeued, and its receipt
    // therefore names the command turn the command path minted (./sessions.ts `resumeThread`).
    const postThreadResume: Handler = async (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const threadId = ctx.params.thread_id;

        // An unknown conversation in a known session is 404 here, before the store is asked
        // anything — the same guard the cancel route runs, so `resume` cannot 404 differently
        // from `cancel` for one typo'd id.
        requireThread(record, threadId);

        // R1/R3: the re-run itself composes the existing lane pump (`requeueTurnInPlace`), with
        // the command path kept for a command-shaped input; a refusal (not stopped, nothing
        // recorded for it to re-run, the answer already reached, or a turn/revive already
        // in flight) is the store's SessionError, and the dispatcher renders its status and
        // message unchanged so the client shows the server's own sentence.
        const submitted = await store.resumeThread(record.id, threadId);

        const live = store.liveSession(record.id);

        // Same counter domains as a normal submit: the store's own live signals already moved
        // `turns`/`turn`/`turn_display`/`turn_events`, and `resumeThread`'s roster signal moved
        // `threads`/`thread` (a conversation that accepted a continuation is a changed row, so
        // the observer reads the ONE projected row instead of a second hint body here). What only
        // this request can know is the session row and the queue view.
        const sessionRevision = events.bumpRevision('session', record.id);

        events.bumpRevision('queue', record.id);

        const receipt = taskReceiptOf(ctx.mount, record.id, live, submitted, sessionRevision);

        publish('session.updated', [{ resource: 'session', id: record.id }, { resource: 'queue', id: record.id }], {
            session: sessionStatePatchOf(live, context)
        });

        return json(200, receipt, sessionRevision);
    };

    const postSessionReset: Handler = async (ctx) => {
        const record = requireSession(ctx.params.session_id);

        // Counts read off the live record BEFORE the reset (a reset discards them), which is
        // the whole receipt: what went, and the new revision. The store's 409 for a running
        // conversation is its own honest answer.
        const discardedTurns = record.turns.length;
        const discardedThreads = record.harness.threads().filter((thread) => thread.origin === 'host').length;
        const droppedQueued = record.queue.length;

        await store.reset(record.id);

        // T16 counter domains: the store's snapshot frame already moved `session`. A reset drops
        // rows in bulk without a per-row signal, so the collection counters stay REST-owned here.
        const revision = events.getRevision('session', record.id);

        events.bumpRevision('turns', record.id);
        events.bumpRevision('threads', record.id);
        events.bumpRevision('queue', record.id);

        publish(
            'turn.removed',
            [
                { resource: 'session', id: record.id },
                { resource: 'turns', id: record.id },
                { resource: 'threads', id: record.id },
                { resource: 'queue', id: record.id }
            ],
            { session_id: record.id, discarded_turns: discardedTurns }
        );

        const result: ResetSessionResult = {
            reset: true,
            session_id: record.id,
            discarded_turns: discardedTurns,
            discarded_threads: discardedThreads,
            dropped_queued_tasks: droppedQueued,
            revision
        };

        return json(200, result, revision);
    };

    const postSessionCancel: Handler = async (ctx) => {
        const record = requireSession(ctx.params.session_id);
        // An absent body (or `{}`) cancels the active run only; `all` also drops the queued
        // backlog. `readBody` answers `{}` when nothing was sent, so a body-less cancel is
        // never a 400, while a malformed one still is (`.catch` covers an adapter that
        // throws on a missing stream rather than synthesizing the empty object).
        const body = requireObjectBody<CancelSessionRequest>(await ctx.body().catch(() => ({})));

        requireKnownFields(body, ['all']);

        // T39 (regression): `all` is a BOOLEAN or the request is refused before anything is
        // cancelled. The field-set check alone accepted `{all:'yes'}` and ran it as `all:false`
        // (a truthy string is not `=== true`), so a client that asked for the backlog to be
        // dropped got a 200 receipt claiming `dropped_queued_tasks: 0` and a run that kept the
        // backlog. The legacy surface's wording is kept verbatim.
        if (body.all !== undefined && typeof body.all !== 'boolean') {
            throw new HttpError(400, '`all` must be a boolean when present.');
        }

        const lanes = [...record.lanes.values()];
        const activeTurn =
            record.turns.find((turn) => turn.status === 'running') ?? (record.busy ? record.turns[record.turns.length - 1] : undefined);
        const droppedQueued =
            body.all === true
                ? record.queue.length + lanes.reduce((total, lane) => total + (lane as ThreadLaneInfo).queue.length, 0)
                : 0;

        const cancelled = await store.cancel(record.id, { all: body.all === true });

        // T16 counter domains: the store's terminal turn frame moved `turn`, and its snapshot
        // frame moved `session`; dropping the queued backlog is the REST-owned part.
        const revision = events.getRevision('session', record.id);

        if (cancelled) {
            events.bumpRevision('queue', record.id);

            // The conditional spread needs its element type spelled out: an untyped `[]`
            // branch widens `resource` to `string`, which would accept a kind the contract
            // does not define.
            const touched: ResourceInput[] = [
                { resource: 'session', id: record.id },
                { resource: 'queue', id: record.id },
                ...(activeTurn === undefined
                    ? []
                    : ([{ resource: 'turn', id: turnKey(record.id, activeTurn.id) }] as ResourceInput[]))
            ];

            publish('session.updated', touched, { session_id: record.id, cancelled: true });
        }

        const result: CancelSessionResult = {
            cancelled,
            session_id: record.id,
            dropped_queued_tasks: droppedQueued,
            ...(activeTurn === undefined ? {} : { active_turn_id: activeTurn.id }),
            revision
        };

        return json(200, result, revision);
    };

    const getSessionActions: Handler = (ctx) => {
        const record = requireSession(ctx.params.session_id);

        // Live requests only, in the order they were opened. A request restored from disk is
        // expired (its promise no longer exists) and is therefore never listed. `turn_id` is
        // the store's own join: the conversation's owning turn, or the running turn when the
        // question came from the session's root run.
        const actions = [...record.pendingActions.values()].map((pending) => pendingActionRowOf(record, pending));

        const response: PendingActionListResponse = {
            session_id: record.id,
            actions,
            revision: events.getRevision('actions', record.id)
        };

        return json(200, response);
    };

    /** The turn a pending question belongs to (its conversation's owning turn). */
    function owningTurnFor(record: SessionRecord, threadId?: string) {
        if (threadId === undefined) {
            const active = record.turns.find((turn) => turn.status === 'running');

            return active;
        }

        return [...record.turns].reverse().find((turn) => turn.threadId === threadId);
    }

    const postActionAnswer: Handler = async (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const requestId = ctx.params.request_id;
        const body = requireObjectBody<AnswerActionRequest>(await ctx.body());

        requireKnownFields(body, ['choice']);

        if (body.choice === undefined) throw new HttpError(400, 'An action answer requires a "choice".');

        // snake_case at the edge: the wire says `option_id`, the recorded domain choice says
        // `optionId`. The store re-validates the choice against the RECORDED request, so an
        // option id the model never offered is a 400 rather than an answer it must trust.
        const choice = normalizeChoice(body.choice);

        store.answerAction(record.id, requestId, choice);

        const revision = events.bumpRevision('actions', record.id);

        publish('action.closed', [{ resource: 'actions', id: record.id }], { request_id: requestId });

        const result: AnswerActionResult = { ok: true, request_id: requestId, resolved_at: Date.now() };

        return json(200, result, revision);
    };

    const normalizeChoice = (choice: unknown): { kind: 'option'; optionId: string } | { kind: 'custom'; text: string } => {
        const value = requireObjectBody<Record<string, unknown>>(choice, 'A "choice" must be an object.');

        if (value.kind === 'option') {
            requireKnownFields(value, ['kind', 'option_id']);

            if (typeof value.option_id !== 'string') {
                throw new HttpError(400, 'An option choice requires a string "option_id".');
            }

            return { kind: 'option', optionId: value.option_id };
        }

        if (value.kind === 'custom') {
            requireKnownFields(value, ['kind', 'text']);

            if (typeof value.text !== 'string') throw new HttpError(400, 'A custom choice requires string "text".');

            return { kind: 'custom', text: value.text };
        }

        throw new HttpError(400, 'A "choice" must be { kind: "option", option_id } or { kind: "custom", text }.');
    };

    // ---- session agents ---------------------------------------------------------

    const getSessionAgents: Handler = (ctx) => {
        const record = requireSession(ctx.params.session_id);

        const agents = sessionAgentRowsOf(record, context);

        const response: SessionAgentListResponse = {
            session_id: record.id,
            total: agents.length,
            agents,
            revision: events.getRevision('session_agents', record.id)
        };

        return json(200, response);
    };

    const findAgentBinding = (record: SessionRecord, agentId: string) =>
        sessionAgentRowsOf(record, context).find((binding) => binding.agent_id === agentId);

    const getSessionAgent: Handler = (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const binding = findAgentBinding(record, ctx.params.agent_id);

        if (binding === undefined) throw missing('agent', ctx.params.agent_id, record.id);

        const response: SessionAgentResponse = { agent: binding };

        return json(200, response, binding.revision);
    };

    // ------------------------------------------------------------------
    // T28 (the T27 follow-up): the durability gate for session-scoped agent writes.
    //
    // `presetFromRecord` (./harnesses/registry.ts:686) chooses a session's factory from the
    // RECORDED `template`, and only the 'live' and 'flaky' branches build it from the record's
    // OWN `primary`/`subagents`/`agentModels`/`agentInstructions` (lines 709-724). The other
    // two shapes cannot honour a session-local roster at all:
    //   - `template: 'scripted'` (the shipped `demo`, ./harnesses/presets.ts:289) resolves the
    //     shipped factory BY NAME and ignores the saved team (registry.ts:692-708), so a member
    //     bound into the session's own preset copy is simply gone after a restart — the write
    //     answered 201 and behaved as if it had never happened;
    //   - a TEMPLATE-LESS (injected) preset must get its factory back from the registry, and
    //     that branch ERRORS when the saved team differs from the entry's (registry.ts:725-751),
    //     which drops the whole session on restore — worse than losing the member.
    //
    // The store already writes the session's preset copy (./sessions.ts:4559-4572), so this is
    // not a missing implementation: it is a deployment whose durable record cannot represent
    // the change. Refusing BEFORE the mutation is therefore the honest answer — the same shape
    // as the idle gate, a retryable 409 that names the reason, instead of a success the next
    // restart takes back.
    //
    // SCOPE: the two MEMBERSHIP writes (`POST` bind, `DELETE` unbind). A per-member model or
    // instruction override does not change the team a restart resolves — it retunes a seed inside
    // the roster the record already carries — so those writes (and the session-level
    // `agent_models` patch) stay available on every template, which is what
    // ./api-canonical.test.ts pins for an injected preset.
    // ------------------------------------------------------------------
    const assertDurableRoster = (record: SessionRecord, operation: string): void => {
        const template = record.preset.template;

        if (template === 'live' || template === 'flaky') return;

        const reason =
            template === 'scripted'
                ? `harness "${record.preset.name}" replays its shipped scripted factory, which ignores the session's own team`
                : `harness "${record.preset.name}" was injected in memory, so a saved team that differs from the registry entry cannot be rebuilt`;

        throw new HttpError(
            409,
            `Cannot ${operation} in session "${record.id}": ${reason}, so a session-scoped agent change would not survive a restart. Create a live harness (POST ${HARNESS_API_ROOT}/harnesses) to bind agents durably.`
        );
    };

    const patchSessionAgent: Handler = async (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const agentId = ctx.params.agent_id;
        const body = requireObjectBody<UpdateSessionAgentRequest>(await ctx.body());

        requireKnownFields(body, ['model', 'instruction']);

        if (findAgentBinding(record, agentId) === undefined) throw missing('agent', agentId, record.id);

        if (body.model === undefined && body.instruction === undefined) {
            throw new HttpError(400, 'A patch must change at least one field.');
        }

        // T27: a session-level INSTRUCTION override is now backed by the runtime
        // (`harness.setAgentInstruction`, via `store.setSessionAgentInstruction`). The store
        // replaces only the member's leading system block and its reset baseline, records the
        // raw override in the session's own preset copy, and commits the document before the
        // answer — which is what the previous refusal named as missing. The value is forwarded
        // verbatim (`null` clears the override and restores the effective profile text); the
        // store composes the guidelines, never this dispatcher.
        //
        // T28: unlike a MEMBERSHIP change (see `assertDurableRoster`), an override never changes
        // the team a restart resolves — it retunes a seed inside the roster the record already
        // carries — so the contract keeps this write (and the session-level `agent_models` patch)
        // available on every template, including a scripted or injected one.
        if (body.instruction !== undefined) {
            if (body.instruction !== null && typeof body.instruction !== 'string') {
                throw new HttpError(400, '"instruction" must be a string or null.');
            }

            await store.setSessionAgentInstruction(
                record.id,
                agentId,
                body.instruction === null ? null : body.instruction
            );
        }

        if (body.model === undefined) {
            // Instruction-only patch: the revisions and the receipt below are the same, and the
            // model half is genuinely unchanged.
            const revision = events.bumpRevision('session_agents', record.id);

            events.bumpRevision('session', record.id);
            publish('agent.registry_updated', [
                { resource: 'session_agents', id: record.id },
                { resource: 'session', id: record.id }
            ], { agent_id: agentId, fields: ['instruction'] });

            const updated = findAgentBinding(store.liveSession(record.id), agentId);

            const response: SessionAgentResponse = { agent: updated ?? findAgentBinding(record, agentId)! };

            return json(200, response, revision);
        }

        const merged = { ...agentModelsOf(record), [agentId]: body.model === null ? record.settings.model : String(body.model) };

        await store.setAgentModels(record.id, merged);

        const revision = events.bumpRevision('session_agents', record.id);

        events.bumpRevision('session', record.id);
        publish('agent.registry_updated', [
            { resource: 'session_agents', id: record.id },
            { resource: 'session', id: record.id }
        ], { agent_id: agentId });

        const updated = findAgentBinding(store.liveSession(record.id), agentId);

        const response: SessionAgentResponse = { agent: updated ?? findAgentBinding(record, agentId)! };

        return json(200, response, revision);
    };

    const postSessionAgent: Handler = async (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const body = requireObjectBody<CreateSessionAgentRequest>(await ctx.body());

        // Closed body: nothing here supplies an implementation, a tool list, or a transport,
        // which is what makes binding an existing trusted profile safe.
        requireKnownFields(body, ['name', 'profile', 'model', 'instruction', 'role']);

        for (const field of ['name', 'profile', 'model', 'instruction'] as const) {
            const value = body[field];

            if (value !== undefined && typeof value !== 'string') {
                throw new HttpError(400, `"${field}" must be a string when supplied.`);
            }
        }

        if (body.role !== undefined && body.role !== 'primary' && body.role !== 'subagent') {
            throw new HttpError(400, '"role" must be "primary" or "subagent".');
        }

        // T28: BODY validation keeps precedence over the durability gate below. The store is
        // still the authority (./sessions.ts:4744-4761 owns this rule and its exact wording);
        // this mirror exists only so an invalid binding answers 400 on ANY session, instead of a
        // 409 about a harness template the client cannot change. A blank name is mirrored for the
        // same reason. The store's remaining semantic refusals (already a member, roster full,
        // retired profile, primary role, the idle gate) all stay the store's.
        const bindingName = typeof body.name === 'string' ? body.name.trim() : '';

        if (bindingName.length === 0) {
            throw new HttpError(400, 'A session agent binding needs a non-blank "name".');
        }

        // An omitted `profile` binds the profile the name spells (./sessions.ts:4750-4754).
        const bindingProfile =
            typeof body.profile === 'string' && body.profile.trim().length > 0 ? body.profile.trim() : bindingName;

        if (bindingProfile !== bindingName) {
            // The alias case the contract mentions: the roster key must BE the trusted profile id,
            // because that is what a restart resolves through `agentFromProfile(name)`
            // (./harnesses/toolbox.ts) and the durable preset record carries no alias map
            // (`HarnessPresetRecord` = primary / subagents / agents / agentModels /
            // agentInstructions, ./persistence.ts).
            throw new HttpError(
                400,
                `A session agent binding must use its profile's own name: "name" is "${bindingName}" but "profile" is "${bindingProfile}". The roster key is the trusted profile id, which is what a restart rebuilds this session's team from.`
            );
        }

        // T28: durability first, before the roster moves (see `assertDurableRoster`). A 409 here
        // is the honest version of a 201 that a restart takes back.
        assertDurableRoster(record, 'bind an agent');

        // The store owns every semantic refusal and states it as a SessionError the dispatcher
        // maps to its own status: 400 blank/identity mismatch/oversized instruction (and, R7, an
        // unusable session-defined name), 409 already a member (including a case-only clash),
        // roster full, retired profile, primary role, or a session with live/queued work.
        //
        // R7: a name that is NOT a catalogue profile is no longer a 404. It creates a
        // SESSION-DEFINED agent — its own model and instruction, durable in the session's preset
        // (`customAgents`) and rebuilt by `agentsFromProfiles` on the next start — which is what
        // lets one conversation own an agent the harness definition never declared.
        await store.addSessionAgent(record.id, {
            name: body.name,
            profile: body.profile,
            model: body.model,
            instruction: body.instruction,
            role: body.role
        });

        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const revision = events.bumpRevision('session_agents', record.id);

        events.bumpRevision('session', record.id);
        publish('agent.registry_updated', [
            { resource: 'session_agents', id: record.id },
            { resource: 'session', id: record.id }
        ], { agent_id: name, action: 'added' });

        // Read the binding back from the LIVE record, not from the pre-write snapshot
        // `requireSession` handed out, so the receipt describes the roster the write produced.
        const created = findAgentBinding(store.liveSession(record.id), name);

        if (created === undefined) {
            // Unreachable in practice (the store appends the member before it commits), but the
            // response type has no empty variant, and a 500 beats inventing a receipt.
            throw new HttpError(500, `Agent "${name}" was bound but is not in the session roster.`);
        }

        const response: SessionAgentResponse = { agent: created };

        return json(201, response, revision);
    };

    const deleteSessionAgent: Handler = async (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const agentId = ctx.params.agent_id;

        // T28: precedence first. A member that does not exist keeps its 404 (the same read the
        // PATCH route uses), because "wrong id" says more than a template refusal does. Only a
        // removal that WOULD move the roster is then subject to the durability gate.
        if (findAgentBinding(record, agentId) === undefined) throw missing('agent', agentId, record.id);

        // T28: a removal is as much a team change as an addition — the scripted/injected factory
        // puts the member back on restore, and for an injected preset a saved team that differs
        // from the registry entry fails to restore at all.
        assertDurableRoster(record, 'unbind an agent');

        // R6: the store refuses a member that still owns a conversation (409 naming the thread
        // ids), so a removal never deletes history behind the caller's back. `detachedThreads`
        // stays on the receipt because the contract declares it, and it is 0 on every accepted
        // removal — the conversations belong to the session, not to the agent.
        const { detachedThreads } = await store.removeSessionAgent(record.id, agentId);

        const revision = events.bumpRevision('session_agents', record.id);

        events.bumpRevision('session', record.id);
        publish('agent.registry_updated', [
            { resource: 'session_agents', id: record.id },
            { resource: 'session', id: record.id }
        ], { agent_id: agentId, action: 'removed' });

        const response: DeleteSessionAgentResult = {
            deleted: true,
            agent_id: agentId,
            session_id: record.id,
            detached_threads: detachedThreads,
            revision
        };

        return json(200, response, revision);
    };

    // The instruction subresource is writable through the same operation the binding PATCH
    // uses, so a client that is looking at the text has one call. `PATCH` sends
    // `{ "instruction": "…" | null }`; the store decides what `null` restores, and a blank or
    // non-string value is refused before anything moves.
    const patchSessionAgentInstruction: Handler = async (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const agentId = ctx.params.agent_id;
        const body = requireObjectBody<{ instruction?: string | null }>(await ctx.body());

        requireKnownFields(body, ['instruction']);

        if (body.instruction === undefined) {
            throw new HttpError(400, 'A patch must supply "instruction".');
        }

        if (body.instruction !== null && typeof body.instruction !== 'string') {
            throw new HttpError(400, '"instruction" must be a string or null.');
        }

        // T28: an override retunes a seed inside the roster the record already carries; it does
        // not change the team a restart resolves, so it stays available on every template
        // (`assertDurableRoster` gates MEMBERSHIP only).
        await store.setSessionAgentInstruction(record.id, agentId, body.instruction);

        const revision = events.bumpRevision('session_agents', record.id);

        publish('agent.registry_updated', [{ resource: 'session_agents', id: record.id }], {
            agent_id: agentId,
            fields: ['instruction']
        });

        // The read model for this subresource is the existing GET; re-run it so the receipt is
        // the same document the client would get back, with `source` now naming the layer the
        // session actually runs.
        return await getSessionAgentInstruction(ctx);
    };

    const getSessionAgentInstruction: Handler = (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const agentId = ctx.params.agent_id;

        if (!record.definition.agents.includes(agentId)) {
            throw new HttpError(404, `Agent "${agentId}" is not a member of session "${record.id}".`);
        }

        const override = (record.preset.agentInstructions ?? {})[agentId];
        const brains = record.harness.agents as Record<string, { instructions: readonly string[] }>;
        const live = brains[agentId] === undefined ? undefined : brains[agentId]!.instructions.join('\n');

        // R7: a SESSION-DEFINED member (./sessions.ts `addSessionAgent` with a name that is not a
        // catalogue profile). It has no `AgentProfile`, so there is no shipped text to fall back
        // on and no guideline block to report: the durable base in `preset.customAgents`, or the
        // session override on top of it, IS the whole prompt. `source: 'session'` is the contract
        // value for exactly that provenance, and the live brain's own text is reported when the
        // roster exposes the brain (the same priority the profile branch below uses).
        const custom = Object.prototype.hasOwnProperty.call(record.preset.customAgents ?? {}, agentId)
            ? record.preset.customAgents![agentId]
            : undefined;

        if (custom !== undefined) {
            const instruction = live ?? (typeof override === 'string' ? override : custom);

            const response: SessionInstructionTextResponse = {
                session_id: record.id,
                agent_id: agentId,
                source: 'session',
                instruction,
                // No trusted guidelines exist for an agent this conversation invented, and an
                // empty list is the honest answer rather than another profile's rules.
                guidelines: [],
                chars: instruction.length
            };

            return json(200, response);
        }

        // T19: the text this route reports is the text the session RUNS. The live brain holds
        // the system messages it was seeded with, so that is the source of truth; the profile
        // (which now carries the GLOBAL override) is only the fallback for a session whose
        // agents are not exposed. `source` then names the layer the live text actually came
        // from, which is how a client can tell a pre-edit session from a post-edit one instead
        // of being told about an override this conversation never ran.
        const profile = registry.agents().find((candidate) => candidate.name === agentId) ?? agentState.shipped(agentId);
        const globalInstruction = agentState.overridesOf(agentId).instruction;
        const instruction = live ?? (typeof override === 'string' ? override : profile?.instruction ?? '');

        const source = typeof override === 'string'
            ? 'harness'
            : globalInstruction !== undefined && (live === undefined || live.includes(globalInstruction))
                ? 'global'
                : 'catalogue';

        const response: SessionInstructionTextResponse = {
            session_id: record.id,
            agent_id: agentId,
            source,
            instruction,
            guidelines: [...(profile?.guidelines ?? [])],
            chars: instruction.length
        };

        return json(200, response);
    };

    // ---- session toolbox --------------------------------------------------------

    const getSessionTools: Handler = (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const limit = resolveLimit(ctx.query.get('limit'));
        const cursor = decodeCursor(ctx.query.get('cursor'));
        const enabledRaw = paramOf(ctx.query, 'enabled');
        const origin = enumParamOf(ctx.query, 'origin', ['catalogue', 'discovered', 'created'] as const);

        let enabledFilter: boolean | undefined;

        if (enabledRaw !== undefined) {
            if (enabledRaw !== 'true' && enabledRaw !== 'false') {
                throw new HttpError(400, 'Query parameter "enabled" must be true or false.');
            }

            enabledFilter = enabledRaw === 'true';
        }

        let rows = sessionToolRowsOf(record, context);

        if (enabledFilter !== undefined) rows = rows.filter((row) => row.enabled === enabledFilter);
        if (origin !== undefined) rows = rows.filter((row) => row.origin === origin);

        const page = slicePage(rows, cursor, limit, rows.length);
        const createdCount = createdToolNames(record).length;

        const result: SessionToolPage = {
            ...pageMeta({ items: page.items, next: page.next }, events.getRevision('session_tools', record.id)),
            budget: { used: createdCount, limit: context.createdToolLimit }
        };

        // Every page read stamps its own collection revision in the contract header (a receipt
        // without a revision simply carries none), so a client can order a read against a stream
        // frame from the response headers alone.
        return json(200, result, (result as { revision?: number }).revision);
    };

    const getSessionTool: Handler = (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const name = ctx.params.tool_id;

        const rows = sessionToolRowsOf(record, context);

        if (!rows.some((row) => row.name === name)) throw missing('tool', name, record.id);

        const response: SessionToolResponse = { tool: sessionToolDetailOf(record, name, context) };

        return json(200, response);
    };

    const getSessionToolSource: Handler = (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const source = sessionToolSourceOf(record, ctx.params.tool_id);

        if (source === undefined) {
            throw new HttpError(
                404,
                `Tool "${ctx.params.tool_id}" has no installed source revision in session "${record.id}".`
            );
        }

        const response: SessionToolSourceResponse = source;

        return json(200, response);
    };

    // T19: session-tool configuration is a mutation of the LIVE harness, so it obeys the
    // idle rule. In worker mode every lane runs against its own replica of the session's
    // harness, and an enabled switch or unregister applied to the coordinator's handle
    // would silently disagree with what a run in flight still executes. A 409 naming the
    // lane work is therefore the legitimate answer, not a missing capability.
    const assertIdleForToolMutation = (record: SessionRecord, route: string): void => {
        const activeLanes = [...record.lanes.values()].filter(
            (lane) => (lane as ThreadLaneInfo).active !== undefined
        ).length;

        if (record.busy || activeLanes > 0) {
            throw new HttpError(
                409,
                `${route} needs the session idle: ${activeLanes > 0 ? `${activeLanes} conversation lane(s) are running` : 'a run is in progress'}. Stop or wait for the work in flight, then retry.`
            );
        }
    };

    // One enabled switch, answered in the SAME registration envelope a source update uses
    // (the contract has one response shape for PATCH). A gate change never mints a source
    // revision, so `source_revision` restates the installed one and `created`/`replaced`
    // are both false - the honest statement that the code did not change.
    const setSessionToolEnabled = async (
        record: SessionRecord,
        name: string,
        enabled: boolean,
        ctx: Ctx
    ): Promise<HarnessApiResult> => {
        const row = sessionToolRowsOf(record, context).find((candidate) => candidate.name === name);

        if (row === undefined) throw missing('tool', name, record.id);

        // A `protected` entry is one this session's kernel refuses to switch at all: a core
        // declaration (always in context, never a cap slot) or a pending-only runtime control
        // such as `toolCancel`. The figure is the KERNEL's answer, not this dispatcher's guess:
        // ./api-reads.ts `sessionToolRowsOf` sets `protected = !harness.isToolSwitchable(name)`,
        // which is the same predicate the `toolManage enable|disable` switch below refuses with
        // (../harness.ts `occupiesSearchableSlot`). That identity is the whole point — the row
        // a client rendered and the status this route answers are one fact stated twice, so no
        // row that LOOKS clickable can come back refused, and a refusal is stated before the
        // click (403 here, per the published contract) instead of after it.
        //
        // The scope note still holds: this is the SESSION-scoped route. The GLOBAL route above
        // has no such exception — every listed tool is switchable there (R5).
        if (row.protected) {
            throw new HttpError(
                403,
                `Tool "${name}" is harness-owned in session "${record.id}"; a protected entry cannot be enabled or disabled.`
            );
        }

        assertIdleForToolMutation(record, `PATCH ${ctx.mount}/sessions/${record.id}/tools/${name}`);

        try {
            record.harness.runtime.manageTool(undefined, {
                operation: enabled ? 'enable' : 'disable',
                name
            });
        } catch (error) {
            if (isInstanceOf(error, SessionError)) throw error;

            // The runtime owns the rules this route cannot restate up front (an idle check
            // race, a name that stopped being registered between the row and the write), so its
            // message becomes the 409/400 boundary. The core-declaration sentence is NOT
            // reachable from a pane that reads its rows: a name the kernel will not switch is
            // `protected` and stopped at the 403 above, which is exactly the contract
            // ./harness.swagger.yaml publishes for this route (403, never 409, for a row the
            // session cannot switch).
            throw new HttpError(409, boundErrorMessage(error));
        }

        // The durable session document is written from the harness snapshot, whose enabled
        // set just changed; the same commit boundary a registration uses runs here.
        await store.persistRegistry();

        const revision = events.bumpRevision('session_tools', record.id);

        publish('tool.registry_updated', [{ resource: 'session_tools', id: record.id }], {
            name,
            enabled
        });

        const response: SessionToolRegistrationResponse = {
            registration: {
                name,
                source_revision: record.harness.toolSource(name)?.revision ?? '',
                created: false,
                replaced: false,
                budget: {
                    // A FRESH snapshot, for the same reason the registration route takes one:
                    // the store's cached `core` is only as current as the last committed
                    // mutation, and this receipt has to state the budget as of THIS write.
                    used: store.liveSession(record.id).core.createdToolCount,
                    limit: context.createdToolLimit
                }
            }
        };

        return json(200, response, revision);
    };

    // Registration goes through the SAME kernel the model's `toolCreate`/`toolRegistry` use,
    // so validation, budget, collision rules, and immediate enablement are identical. The
    // receipt is metadata only (no function, schema body, or source text is echoed).
    const registerSessionTool = async (
        record: SessionRecord,
        body: Record<string, unknown>,
        ctx: Ctx,
        mode: 'create' | 'update'
    ): Promise<HarnessApiResult> => {
        const name = mode === 'create' ? String(body.name ?? '') : ctx.params.tool_id;

        if (mode === 'create' && name.length === 0) throw new HttpError(400, 'A created tool requires a "name".');

        const candidate: Record<string, unknown> = { name };

        if (typeof body.description === 'string') candidate.description = body.description;
        else if (mode === 'create') throw new HttpError(400, 'A created tool requires a "description".');

        if (body.tags !== undefined) {
            if (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== 'string')) {
                throw new HttpError(400, '"tags" must be an array of strings.');
            }

            // Tags are REQUIRED on create: an untagged tool could never be discovered.
            candidate.tags = body.tags;
        } else if (mode === 'create') {
            throw new HttpError(400, 'A created tool requires "tags".');
        }

        if (body.parameters !== undefined) candidate.parameters = body.parameters;
        if (body.visibility !== undefined) candidate.visibility = body.visibility;
        if (body.source !== undefined) candidate.source = body.source;
        if (body.module_text !== undefined) candidate.moduleText = body.module_text;
        if (body.source_path !== undefined) candidate.sourcePath = body.source_path;
        if (body.dependencies !== undefined) candidate.dependencies = body.dependencies;

        if (mode === 'update' && !sessionToolRowsOf(record, context).some((row) => row.name === name)) {
            throw missing('tool', name, record.id);
        }

        if (mode === 'update' && candidate.source === undefined && candidate.moduleText === undefined) {
            // Metadata-only updates (description/tags/visibility/parameters) are declarative
            // writes the registration kernel owns, so a source-less update still goes through
            // it: one path decides what a published revision is, and a metadata edit can
            // never desynchronise the definition from the captured source.
            //
            // T19: the INSTALLED revision supplies the text, preferring the module form (the
            // form every created and folder-backed tool carries) and falling back to the
            // legacy function body. Only a name with NO captured revision at all - a tool
            // registered from an already-constructed definition, i.e. a built-in - has nothing
            // to re-publish, and that refusal is stated instead of silently doing nothing.
            const installed = record.harness.toolSource(name);

            if (installed?.moduleText !== undefined) candidate.moduleText = installed.moduleText;
            else if (installed?.source !== undefined) candidate.source = installed.source;
            else {
                throw capabilityDenied(
                    'a metadata-only update of a tool with no captured source revision (a constructed definition)',
                    `PATCH ${ctx.mount}/sessions/${record.id}/tools/${name}`
                );
            }
        }

        try {
            // T39 (regression): the create path has to observe the PRIOR registration itself, because
            // `harness.toolCreate` (../harness.ts:2452-2483) returns only the compiled definition and
            // throws away the kernel's own report. Hardcoding `created: true, replaced: false` made
            // this receipt contradict three things at once: the kernel rule for the identical write
            // (`acceptTool` computes `existed` and answers `created: !existed, replaced: existed`,
            // ../harness.ts:1292-1293 and :1386-1399), the budget figure in the SAME receipt (a
            // re-registration does not spend a creation slot, so `used` correctly stayed flat), and
            // the PATCH path below, which reports `registered.replaced` from the kernel.
            //
            // `existed` is "this session's live registry already had this name", exactly the kernel's
            // test — NOT "a static catalogue entry was displaced": the catalogue is never mutated by
            // this route (a detached-catalogue call still runs the shipped definition).
            const hadPriorRegistration =
                (record.harness.tools as Record<string, unknown>)[name] !== undefined;
            const previousRevision = record.harness.toolSource(name)?.revision;

            // TWO domain paths, deliberately chosen per mode:
            //   - create  -> `harness.createTool`, the SAME host path the model's `toolCreate`
            //     uses, so validation, the lifetime creation budget, collision rules, and
            //     immediate enablement are identical, and the session's created-tool accounting
            //     (which the budget below reports) actually moves;
            //   - update  -> `harness.registerTool`, the kernel's atomic replacement, which
            //     publishes a NEW revision and reports the previous one.
            // A registration compiles the candidate and NEVER runs it.
            const created =
                mode === 'create'
                    ? record.harness.toolCreate(candidate as never)
                    : undefined;

            const registered =
                created === undefined
                    ? await record.harness.registerTool(candidate as never)
                    : (({
                          name: created.name,
                          revision: record.harness.toolSource(created.name)?.revision ?? '',
                          created: !hadPriorRegistration,
                          replaced: hadPriorRegistration,
                          ...(previousRevision === undefined ? {} : { previousRevision }),
                          checks: record.harness.toolSource(created.name)?.checks ?? [],
                          sourcePath: record.harness.toolSource(created.name)?.sourcePath
                      }) as unknown as Awaited<ReturnType<typeof record.harness.registerTool>>);

            // The document must not claim a registry the live harness already changed, so the
            // store's own durable commit boundary runs here (a no-op for an in-memory store).
            await store.persistRegistry();

            const revision = events.bumpRevision('session_tools', record.id);

            publish('tool.registry_updated', [{ resource: 'session_tools', id: record.id }], {
                name,
                created: registered.created
            });

            // T27: the figure comes from the store's refreshed `core` (see
            // `SessionStore.persistRegistry`), not from a throwaway snapshot. The same write is
            // now what the persisted document says, what the next read answers, and what the
            // restart replays — the receipt stopped being the only place the new number existed.
            const usedTools = store.liveSession(record.id).core.createdToolCount;

            const response: SessionToolRegistrationResponse = {
                registration: {
                    name: registered.name,
                    source_revision: registered.revision,
                    created: registered.created,
                    replaced: registered.replaced,
                    ...(registered.previousRevision === undefined ? {} : { previous_revision: registered.previousRevision }),
                    ...(registered.sourcePath === undefined ? {} : { source_path: registered.sourcePath }),
                    ...(registered.checks.length === 0 ? {} : { checks: [...registered.checks] }),
                    budget: {
                        used: usedTools,
                        limit: context.createdToolLimit
                    }
                }
            };

            return json(mode === 'create' ? 201 : 200, response, revision);
        } catch (error) {
            // A compile/validation failure is a 400 and the PREVIOUS revision stays callable;
            // a budget collision is the store's/kernel's 409, mapped by the outer catch.
            if (isInstanceOf(error, SessionError)) throw error;

            const message = boundErrorMessage(error);

            if (/budget|limit/i.test(message)) {
                throw new HttpError(409, message);
            }

            throw new HttpError(400, message);
        }
    };

    const postSessionTool: Handler = async (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const body = requireObjectBody<CreateSessionToolRequest>(await ctx.body());

        requireKnownFields(body, [
            'name',
            'description',
            'tags',
            'parameters',
            'source',
            'module_text',
            'source_path',
            'dependencies',
            'visibility',
            'replace'
        ]);

        if (body.replace === true) {
            throw capabilityDenied(
                'an atomic replace-on-create registration',
                `POST ${ctx.mount}/sessions/${record.id}/tools with "replace"`
            );
        }

        return await registerSessionTool(record, body as unknown as Record<string, unknown>, ctx, 'create');
    };

    const patchSessionTool: Handler = async (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const body = requireObjectBody<Record<string, unknown>>(await ctx.body());

        requireKnownFields(body, [
            'description',
            'tags',
            'parameters',
            'visibility',
            'enabled',
            'source',
            'module_text',
            'dependencies',
            'replace'
        ]);

        if (Object.keys(body).length === 0) throw new HttpError(400, 'A patch must change at least one field.');

        if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
            throw new HttpError(400, '"enabled" must be a boolean.');
        }

        // `enabled` is the reversible discovery gate; everything else is the registration
        // kernel's declaration. A patch that names ONLY the gate is now a real runtime write
        // (T19: `toolManage enable|disable`), so the capability refusal it used to answer is
        // gone rather than kept as a placeholder.
        const contentOnly = Object.keys(body).filter((key) => key !== 'enabled');

        if (contentOnly.length === 0) {
            return await setSessionToolEnabled(record, ctx.params.tool_id, body.enabled === true, ctx);
        }

        const result = await registerSessionTool(record, body, ctx, 'update');

        // A patch that restates BOTH the declaration and the gate applies the gate after the
        // registration, because a source update enables the name at once and the caller's
        // `enabled: false` is the later, more specific instruction. The registration envelope
        // stays the answer (the contract has one response shape for this route).
        if (typeof body.enabled === 'boolean') {
            const name = ctx.params.tool_id;

            assertIdleForToolMutation(record, `PATCH ${ctx.mount}/sessions/${record.id}/tools/${name}`);

            try {
                record.harness.runtime.manageTool(undefined, {
                    operation: body.enabled ? 'enable' : 'disable',
                    name
                });

                await store.persistRegistry();
                events.bumpRevision('session_tools', record.id);
            } catch (error) {
                if (isInstanceOf(error, HttpError) || isInstanceOf(error, SessionError)) throw error;

                throw new HttpError(409, boundErrorMessage(error));
            }
        }

        return result;
    };

    // T19: a real unregister. The runtime drops the implementation, the captured source
    // revision, the owning-path association, the created-tool record, and the enabled slot in
    // one step (see src/harness.ts `toolManage remove`), and the harness observer commits the
    // new snapshot, so a restart does not resurrect the name.
    const deleteSessionTool: Handler = async (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const name = ctx.params.tool_id;
        const row = sessionToolRowsOf(record, context).find((candidate) => candidate.name === name);

        if (row === undefined) throw missing('tool', name, record.id);

        // Two different refusals, kept distinct because they mean different things to a
        // client: a `protected` entry — the same kernel-stated figure the `enabled` PATCH above
        // refuses with, i.e. a core declaration or a pending-only runtime control — is not a
        // user-level edit at all -> 403. A name this session merely INHERITS from the catalogue
        // with no session-local registration and no enabled slot has nothing to remove -> 400.
        // Note what that identity means for an ORDINARY toolbox row (`syntax`, `files`, a
        // created tool): it is switchable, therefore not protected, therefore removable — the
        // runtime `remove` operation is the one that decides, and it never disagrees with the
        // row the client clicked.
        if (row.protected) {
            throw new HttpError(
                403,
                `Tool "${name}" is harness-owned in session "${record.id}"; a protected entry cannot be unregistered.`
            );
        }

        // The LIVE created-tool records, read BEFORE the removal: the store's cached `core`
        // states the last committed snapshot, and this receipt has to say what THIS removal did.
        const createdNow = (record.harness.snapshot().createdTools ?? []).map((entry) => entry.name);
        const removedCreated = createdNow.includes(name);
        const installedSource = record.harness.toolSource(name) !== undefined;

        if (!removedCreated && !installedSource && row.origin !== 'discovered') {
            throw new HttpError(
                400,
                `Tool "${name}" is inherited by session "${record.id}" and has no session-local registration to remove.`
            );
        }

        assertIdleForToolMutation(record, `DELETE ${ctx.mount}/sessions/${record.id}/tools/${name}`);

        try {
            record.harness.runtime.manageTool(undefined, { operation: 'remove', name });
        } catch (error) {
            if (isInstanceOf(error, SessionError)) throw error;

            throw new HttpError(409, boundErrorMessage(error));
        }

        // Same durable boundary a registration uses: the document is written from the harness
        // snapshot, and the removal just changed it.
        await store.persistRegistry();

        const revision = events.bumpRevision('session_tools', record.id);

        publish('tool.registry_updated', [{ resource: 'session_tools', id: record.id }], {
            name,
            removed: true
        });

        const result: DeleteSessionToolResult = {
            deleted: true,
            tool_id: name,
            session_id: record.id,
            removed_created: removedCreated,
            // T27 disclosure (still unsupported, and the reason is now the runtime's, not the
            // dispatcher's): restoring an INHERITED baseline needs a copy of the definition this
            // session overrode. The registration kernel keeps only the INSTALLED revision
            // (`harness.toolSource(name)` returns one source per name, and `registerTool` reports
            // the previous revision's identity but does not retain its bytes — see
            // `HarnessToolRegistrationResult.previousRevision`), so after an override there is no
            // second copy to hand back. The receipt therefore states `false` rather than leaving
            // a client to infer a restore, and the honest fix is a superseded-revision retention
            // in the source registry, which is outside this owner's files.
            restored_inherited: false
        };

        return json(200, result, revision);
    };

    // Manual execution inside one session: EVERY name resolves in that session's LIVE
    // registry, so a replaced preset, a created tool, and a session-owned core tool all run
    // the implementation that session actually holds. A busy session is a 409 (a manual
    // mutation must not race a streaming run), which the store owns.
    const postSessionToolExecution: Handler = async (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const name = ctx.params.tool_id;
        const body = requireObjectBody<{ parameters?: unknown }>(await ctx.body());

        requireKnownFields(body, ['parameters']);

        if (!sessionToolRowsOf(record, context).some((row) => row.name === name)) {
            throw missing('tool', name, record.id);
        }

        const scope = toolExecutionScopeOf(name);

        if (!scope.manual) {
            throw new HttpError(403, `Tool "${name}" is not callable manually.`);
        }

        const started = Date.now();

        try {
            const value = await store.callTool(record.id, name, body.parameters as never);

            return json(200, successfulToolResult(value, started));
        } catch (error) {
            // A name the session does not register, or a busy session, is a request failure
            // (404/409) rather than tool data. Everything else is the tool answering a
            // failure, which is a 200 `ok: false`.
            if (isInstanceOf(error, SessionError)) throw error;

            return json(200, toolCallFailure(boundErrorMessage(error), Date.now() - started));
        }
    };

    // ---- threads (conversations) ------------------------------------------------

    const threadRowsOf = (record: SessionRecord, opts: { withPreview?: boolean } = {}) => {
        const threads = record.harness.threads().filter((thread) => thread.origin === 'host');

        // `sequence` order is the roster's stable order (creation order per session).
        return [...threads]
            .sort((left, right) => left.sequence - right.sequence)
            .map((thread) =>
                threadRowOf(
                    record,
                    thread,
                    labelOf(record, thread.id),
                    // The transcript is read ONLY for the rows a page actually returns, and
                    // only when a preview was asked for: the roster page itself stays
                    // transcript-free by counting entries through the same call the
                    // metadata route uses.
                    transcriptMessagesOf(record, thread.id),
                    opts
                )
            );
    };

    const getSessionThreads: Handler = (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const limit = resolveLimit(ctx.query.get('limit'));
        const cursor = decodeCursor(ctx.query.get('cursor'));
        const agent = paramOf(ctx.query, 'agent');
        const status = enumParamOf(ctx.query, 'status', ['idle', 'running', 'stopped'] as const);

        let rows = threadRowsOf(record);

        if (agent !== undefined) rows = rows.filter((row) => row.agent === agent);
        if (status !== undefined) rows = rows.filter((row) => row.status === status);

        const page = slicePage(rows, cursor, limit, rows.length);

        const result: ThreadSummaryPage = pageMeta({ items: page.items, next: page.next }, events.getRevision('threads', record.id));

        // Every page read stamps its own collection revision in the contract header (a receipt
        // without a revision simply carries none), so a client can order a read against a stream
        // frame from the response headers alone.
        return json(200, result, (result as { revision?: number }).revision);
    };

    const getSessionThread: Handler = (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const threadId = ctx.params.thread_id;

        requireThread(record, threadId);

        const rows = threadRowsOf(record);
        const row = rows.find((entry) => entry.id === threadId);

        if (row === undefined) throw missing('thread', threadId, record.id);

        const messages = transcriptMessagesOf(record, threadId);

        const response: ThreadResponse = {
            thread: threadResourceOf(record, row, messages, context, {
                transcriptBytes: messages.length === 0 ? 0 : Buffer.byteLength(JSON.stringify(messages), 'utf8')
            })
        };

        return json(200, response, events.getRevision('thread', threadKey(record.id, threadId)));
    };

    const postSessionThread: Handler = async (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const body = requireObjectBody<CreateSessionThreadRequest>(await ctx.body());

        requireKnownFields(body, ['agent', 'label', 'owner_thread_id']);

        if (typeof body.agent !== 'string' || body.agent.length === 0) {
            throw new HttpError(400, 'A conversation requires an "agent".');
        }

        if (!record.definition.agents.includes(body.agent)) {
            throw new HttpError(400, `Agent "${body.agent}" is not a member of session "${record.id}".`);
        }

        if (body.owner_thread_id !== undefined) requireThread(record, body.owner_thread_id);

        // Nothing runs until a task names it, so opening a conversation is free. The record
        // the runtime returns is the authority for the new id/sequence; the label shown here
        // is the store's own (a client-supplied label is display metadata on the record, and
        // the roster's user-facing `#RRn` name is minted by the store).
        const created = record.harness.createThread(body.agent, {
            ...(body.label === undefined ? {} : { label: body.label }),
            ...(body.owner_thread_id === undefined ? {} : { ownerThreadId: body.owner_thread_id })
        } as never);

        // The document must not claim fewer conversations than the live harness holds, so the
        // store's own durable commit boundary runs here (a no-op for an in-memory store).
        await store.persistRegistry();

        const revision = events.bumpRevision('threads', record.id);

        publish('thread.upsert', [{ resource: 'threads', id: record.id }], {
            thread_id: created.id,
            agent: body.agent
        });

        // Read the row back through the SAME projection the roster route uses, so a create
        // and a later list can never state the same conversation differently.
        const row = threadRowsOf(store.liveSession(record.id)).find((entry) => entry.id === created.id);

        if (row === undefined) throw missing('thread', created.id, record.id);

        const response: ThreadResponse = {
            thread: threadResourceOf(store.liveSession(record.id), row, [], context)
        };

        return json(201, response, revision);
    };

    const deleteSessionThread: Handler = async (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const threadId = ctx.params.thread_id;

        requireThread(record, threadId);

        // The cascade is the part a client must report: descendants and owning turns are
        // counted from the roster BEFORE the removal, then stated in the receipt.
        const descendants = record.harness
            .threads()
            .filter((thread) => thread.origin === 'host' && isDescendant(record, thread.id, threadId)).length;
        const removedTurns = record.turns.filter((turn) => turn.threadId === threadId).length;

        await store.deleteThread(record.id, threadId);

        // T16 counter domains: the store signalled `turn.removed` for every removed row and
        // `thread.removed` for every deleted conversation, which moved `turns`, `threads`, and
        // the conversation counters. Only the session row is REST-owned here; the receipt quotes
        // the roster figure the store just moved.
        events.bumpRevision('session', record.id);

        const revision = events.getRevision('threads', record.id);

        publish('thread.removed', [
            { resource: 'threads', id: record.id },
            { resource: 'session', id: record.id },
            { resource: 'turns', id: record.id }
        ], { thread_id: threadId });

        const result: DeleteThreadResult = {
            deleted: true,
            thread_id: threadId,
            session_id: record.id,
            removed_descendants: descendants,
            removed_turns: removedTurns,
            revision
        };

        return json(200, result, revision);
    };

    /** True when `candidate` is `threadId` or a descendant of it (the store's own rule). */
    const isDescendant = (record: SessionRecord, candidate: string, ancestor: string): boolean => {
        if (candidate === ancestor) return false;

        let thread = record.harness.thread(candidate);
        let depth = 0;

        while (thread !== undefined && depth < 64) {
            if (thread.ownerThreadId === ancestor) return true;

            thread = thread.ownerThreadId === undefined ? undefined : record.harness.thread(thread.ownerThreadId);
            depth += 1;
        }

        return false;
    };

    const postThreadCancel: Handler = async (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const threadId = ctx.params.thread_id;

        requireThread(record, threadId);

        // Counted BEFORE the stop: this is the named conversation's own backlog at
        // the moment the call begins (the contract's stated floor).
        const droppedQueued = record.lanes.get(threadId)?.queue.length ?? 0;

        // R4 (T10): the receipt is the STORE's answer, not a constant. `cancelled`
        // says whether this call actually terminated work (an aborted run, a released
        // reference park, dropped queued turns), and `status` is where the conversation
        // really stands afterwards. The store also cascades the stop to owner-linked
        // children and may drop a legacy backlog, so a claimed total here would be a
        // guess; the named-thread figures stay exactly as documented.
        const stopped = await store.cancelThread(record.id, threadId);

        // D1 (T14): the status is the CONVERSATION's own state as the harness reports it,
        // read AFTER the stop. The roster projection is not a usable source here: it only
        // publishes `origin === 'host'` rows (./sessions.ts `snapshot` ~:3704), so the
        // default `agent:<name>` conversation has no row at all, and the previous
        // `?? 'stopped'` fallback quoted a constant the record never confirmed. The harness
        // thread record IS the source the roster row is projected from, so a host thread
        // still answers with exactly the value its roster row carries (the contract's
        // wording) while an `agent:` conversation answers with its real state.
        // `requireThread` above guarantees this thread exists, so the fallback is only for
        // a thread the runtime removed underneath this call.
        const stoppedStatus = record.harness.thread(threadId)?.status ?? 'stopped';

        // T16 counter domains: the store signalled `thread.upsert` for the stop, which moved the
        // conversation and roster counters; the session row is the REST-owned figure here.
        const revision = events.getRevision('thread', threadKey(record.id, threadId));

        events.bumpRevision('session', record.id);
        publish('thread.upsert', [
            { resource: 'thread', id: threadKey(record.id, threadId) },
            { resource: 'threads', id: record.id }
        ], { thread_id: threadId, status: stoppedStatus });

        // T12 contract sync: the wire pair is now the GENERATED shape itself — the spec
        // documents `cancelled` as an honest boolean and `status` as the conversation's
        // post-stop status (`CancelThreadResult`, ../shared/harness-api.ts:1613 from
        // ./harness.swagger.yaml:6748), so no widening cast or dropped annotation is needed
        // here. The literals `true`/`"stopped"` were the answer this route used to hardcode.
        const result: CancelThreadResult = {
            cancelled: stopped.cancelled,
            thread_id: threadId,
            session_id: record.id,
            status: stoppedStatus,
            dropped_queued_tasks: droppedQueued,
            revision
        };

        return json(200, result, revision);
    };

    // ---- transcript -------------------------------------------------------------

    const getTranscriptMetadata: Handler = (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const threadId = ctx.params.thread_id;
        const thread = requireThread(record, threadId);
        const messages = transcriptMessagesOf(record, threadId);
        const agent = thread?.agent ?? record.invalidThreads.get(threadId)?.agent ?? '';

        const response: TranscriptMetadataResponse = {
            transcript: transcriptMetadataOf(record, threadId, agent, messages, context)
        };

        return json(200, response, events.getRevision('transcript', threadKey(record.id, threadId)));
    };

    const getTranscriptMessages: Handler = (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const threadId = ctx.params.thread_id;
        const thread = requireThread(record, threadId);
        const limit = resolveLimit(ctx.query.get('limit'));
        const cursor = decodeCursor(ctx.query.get('cursor'));
        const role = enumParamOf(ctx.query, 'role', ['system', 'user', 'assistant', 'tool'] as const);

        const invalid = record.invalidThreads.get(threadId);
        const messages = transcriptMessagesOf(record, threadId);

        // The cursor addresses recorded POSITIONS, so a role filter must not renumber the
        // collection: `total` stays the whole transcript's entry count.
        const rows: import('../harness').HarnessMessage[] = [];
        let served = 0;
        let collected = 0;

        for (let index = 0; index < messages.length; index += 1) {
            const entry = messages[index];

            if (role !== undefined && entry.role !== role) continue;

            if (served < cursor) {
                served += 1;
                continue;
            }

            if (collected >= limit) break;

            rows.push(entry);
            served += 1;
            collected += 1;
        }

        const result: TranscriptMessagePage = {
            ...pageMeta({ items: rows, next: served < messages.length && rows.length === limit ? served : null }, events.getRevision('transcript_messages', threadKey(record.id, threadId))),
            thread_id: threadId,
            agent: thread?.agent ?? record.invalidThreads.get(threadId)?.agent ?? '',
            transcript_state: invalid === undefined ? 'ok' : 'unreadable',
            total: messages.length
        };

        // Every page read stamps its own collection revision in the contract header (a receipt
        // without a revision simply carries none), so a client can order a read against a stream
        // frame from the response headers alone.
        return json(200, result, (result as { revision?: number }).revision);
    };

    const getTranscriptDocument: Handler = (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const threadId = ctx.params.thread_id;
        const thread = requireThread(record, threadId);
        const invalid = record.invalidThreads.get(threadId);
        const messages = transcriptMessagesOf(record, threadId);
        // An unreadable transcript edits its RAW value: that is the text the user is fixing.
        const value = invalid === undefined ? messages : invalid.messages;

        const response: TranscriptDocumentResponse = {
            session_id: record.id,
            thread_id: threadId,
            agent: thread?.agent ?? invalid?.agent ?? '',
            revision: events.getRevision('transcript', threadKey(record.id, threadId)),
            transcript_state: invalid === undefined ? 'ok' : 'unreadable',
            document: JSON.stringify(value, null, 2),
            content_type: 'application/json'
        };

        return json(200, response, response.revision);
    };

    const putTranscript: Handler = async (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const threadId = ctx.params.thread_id;
        const body = requireObjectBody<UpdateThreadTranscriptRequest>(await ctx.body());

        requireKnownFields(body, ['messages', 'if_revision']);

        // `messages` must be PRESENT: a service loader that reduced a malformed body to `{}`
        // must not silently EMPTY a transcript.
        if (!Object.prototype.hasOwnProperty.call(body, 'messages')) {
            throw new HttpError(400, 'A transcript update requires a "messages" value.');
        }

        requireThread(record, threadId);

        const key = threadKey(record.id, threadId);
        const current = events.getRevision('transcript', key);

        // THE one optimistic lock in this contract, refused with 409 naming the current
        // revision and writing nothing.
        if (body.if_revision !== undefined) {
            if (typeof body.if_revision !== 'number' || !Number.isInteger(body.if_revision)) {
                throw new HttpError(400, '"if_revision" must be an integer.');
            }

            if (body.if_revision !== current) {
                throw new HttpError(
                    409,
                    `This transcript is at revision ${current}; the write expected ${body.if_revision}. Re-read before writing.`
                );
            }
        }

        // A structurally broken value is a SUCCESSFUL write: it is stored raw as unreadable,
        // the live transcript becomes a valid placeholder, and the receipt explains it. The
        // invalid transcript is never installed into the model's context.
        const write = await store.updateThreadTranscript(record.id, threadId, body.messages);

        // T16 counter domains: the store's `transcript.updated` signal already moved
        // `transcript` and `transcript_messages`; the receipt quotes that figure, and the
        // conversation row is the REST-owned counter for a content change like this one.
        const revision = events.getRevision('transcript', key);

        events.bumpRevision('thread', key);

        const unreadable = record.invalidThreads.has(threadId);
        const messages = transcriptMessagesOf(store.liveSession(record.id), threadId);

        publish('transcript.updated', [{ resource: 'transcript', id: key }], {
            thread_id: threadId,
            revision,
            message_count: messages.length,
            transcript_state: unreadable ? 'unreadable' : 'ok'
        });

        void write;

        const receipt: TranscriptWriteReceipt = {
            session_id: record.id,
            thread_id: threadId,
            accepted_as: unreadable ? 'raw' : 'transcript',
            message_count: messages.length,
            revision,
            ...(unreadable
                ? {
                      invalid: {
                          error: record.invalidThreads.get(threadId)!.error,
                          stored_type: storedTypeOf(record.invalidThreads.get(threadId)!.messages)
                      }
                  }
                : {}),
            links: {
                transcript: `${ctx.mount}/sessions/${record.id}/threads/${threadId}/transcript`,
                messages: `${ctx.mount}/sessions/${record.id}/threads/${threadId}/transcript/messages?limit=25`,
                document: `${ctx.mount}/sessions/${record.id}/threads/${threadId}/transcript/document`
            }
        };

        return json(200, receipt, revision);
    };

    // ---- turns ------------------------------------------------------------------

    const getSessionTurns: Handler = (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const limit = resolveLimit(ctx.query.get('limit'));
        const cursor = decodeCursor(ctx.query.get('cursor'));
        const threadId = paramOf(ctx.query, 'thread_id');
        const status = paramOf(ctx.query, 'status');
        const order = enumParamOf(ctx.query, 'order', ['asc', 'desc'] as const) ?? 'asc';

        if (status !== undefined) {
            const allowed = ['queued', 'running', 'done', 'error', 'cancelled'] as readonly string[];

            if (!allowed.includes(status)) {
                throw new HttpError(400, `Query parameter "status" must be one of: ${allowed.join(', ')}.`);
            }
        }

        // Rows come from the per-turn projection cache in INDEX order, then the filters apply
        // and the cursor slices what survives. No turn record is copied on this path.
        const ordered = [...record.turns].sort((left, right) =>
            order === 'asc' ? left.index - right.index : right.index - left.index
        );

        const filtered = ordered.filter(
            (turn) =>
                (threadId === undefined || turn.threadId === threadId) &&
                (status === undefined || turn.status === status)
        );

        const page = slicePage(filtered, cursor, limit, filtered.length);
        // Both producers emit the same wire row shape (the cached projection, or an honest
        // row straight from the record); the annotation stops the union leaking into the
        // page type, which is what the contract's closed `TurnSummary` object requires.
        const items: TurnSummaryPage['items'] = page.items.map((turn) => {
            const projector = store.peekTurnProjector(record, turn.id);

            if (projector === undefined) return fallbackTurnRow(turn) as TurnSummaryPage['items'][number];

            return turnRowOf(projector, turn.id) as TurnSummaryPage['items'][number];
        });

        const result: TurnSummaryPage = pageMeta({ items, next: page.next }, events.getRevision('turns', record.id));

        // Every page read stamps its own collection revision in the contract header (a receipt
        // without a revision simply carries none), so a client can order a read against a stream
        // frame from the response headers alone.
        return json(200, result, (result as { revision?: number }).revision);
    };

    // A turn the store has never projected (a restored document that predates the display
    // cache) still gets an honest row straight from its record.
    const fallbackTurnRow = (turn: SessionRecord['turns'][number]) => ({
        id: turn.id,
        index: turn.index,
        promptPreview: promptPreview(turn.prompt),
        promptChars: turn.prompt.length,
        status: turn.status,
        state: turn.status === 'running' ? 'streaming' : turn.status === 'done' || turn.status === 'error' || turn.status === 'cancelled' ? turn.status : 'queued',
        ...(turn.threadId === undefined ? {} : { threadId: turn.threadId }),
        ...(turn.threadLabel === undefined ? {} : { threadLabel: turn.threadLabel }),
        ...(turn.startedAt === undefined ? {} : { startedAt: turn.startedAt }),
        updatedAt: turn.updatedAt,
        ...(turn.usage === undefined ? {} : { usage: { ...turn.usage } }),
        sectionCount: 0,
        stepCount: 0,
        activeAgents: [],
        blocks: []
    });

    const getSessionTurn: Handler = (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const turn = requireTurn(record, ctx.params.turn_id);

        const response: TurnResponse = { turn: turnResourceOf(record, turn, context) };

        return json(200, response, events.getRevision('turn', turnKey(record.id, turn.id)));
    };

    const getSessionTurnDisplay: Handler = (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const turnId = ctx.params.turn_id;

        // Kept (not discarded): the inclusion stamp below joins each segment against THIS turn's
        // record — the recorded call id and the recorded thinking bytes are the join's inputs — and
        // `turn.events` is the live record, exactly like the two detail reads use it.
        const turn = requireTurn(record, turnId);

        const projector = store.peekTurnProjector(record, turnId);

        if (projector === undefined) throw missing('turn', turnId, record.id);

        // The projector emits a discriminated UNION of narrower member types, while the wire
        // record is one closed object whose kind-specific fields are optional (see
        // PROJECTION DELTAS in src/shared/harness-api.ts). A member satisfies the record; the
        // record does not narrow back to the member, so the widening is asserted here, at the
        // boundary, rather than loosening the projector's internal model.
        const display = projector.display();

        const response: TurnDisplayResponse = {
            display: {
                ...display,
                // R7 (T4b): the bar the lane paints. Every figure stays the projector's own; the
                // ONE thing added here is the live `included` verdict per segment, joined at read
                // time from the conversation's committed entries. This is what makes the dim
                // correct on FIRST PAINT — the fold cannot carry it (it never sees a transcript)
                // and the projector's per-kind `inPrompt` is a fallback, not a verdict. A segment
                // the join cannot name keeps NO key, which is what the reader shows as opaque with
                // no control (../frontend/view-context.ts `contextBlockIsExcluded`).
                sections: displaySectionsWithInclusionOf(record, turn, display.sections),
                // One counter per comparison: the tree is a pure fold of the turn record, so
                // its revision IS the turn's (the contract defines `turn_display` that way).
                revision: events.getRevision('turn', turnKey(record.id, turnId))
            } as unknown as TurnDisplayResponse['display']
        };

        return json(200, response, response.display.revision);
    };

    const getSessionTurnEvents: Handler = (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const turnId = ctx.params.turn_id;
        const turn = requireTurn(record, turnId);
        const limit = resolveLimit(ctx.query.get('limit'));
        const cursor = decodeCursor(ctx.query.get('cursor'));
        const type = paramOf(ctx.query, 'type');

        const { rows, total, partial } = turnEventRowsOf(turn, cursor, limit, type);
        const next = rows.length === limit && rows[rows.length - 1] !== undefined && rows[rows.length - 1].index + 1 < turn.events.length
            ? // The next cursor addresses the ordinal AFTER the last event served, so a
              // filtered page resumes where it stopped instead of rescanning.
              rows[rows.length - 1].index + 1
            : null;

        const result: TurnEventPage = {
            ...pageMeta({ items: rows, next }, events.getRevision('turn', turnKey(record.id, turnId))),
            turn_id: turnId,
            total_events: total,
            partial
        };

        return json(200, result, result.revision);
    };

    const getSessionTurnStep: Handler = (ctx) => {
        const record = requireSession(ctx.params.session_id);

        requireTurn(record, ctx.params.turn_id);

        const detail = store.stepDetail(record.id, ctx.params.turn_id, ctx.params.step_id);

        const response: TurnStepDetailResponse = { detail };

        return json(200, response, events.getRevision('turn', turnKey(record.id, ctx.params.turn_id)));
    };

    const getSessionTurnBlock: Handler = (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const turn = requireTurn(record, ctx.params.turn_id);

        // Same projection delta as the display read: the store answers the internal union
        // member, the wire record is the closed superset. The bytes are identical.
        const block = store.blockDetail(
            record.id,
            ctx.params.turn_id,
            ctx.params.block_id
        ) as unknown as TurnBlockDetailResponse['block'];

        // T7: the reader-facing inclusion state — the PER-ENTRY figure the segment dialog's chip
        // switches, published here for the clicked segment. The projector cannot carry it (the flag
        // is a fact about the CONVERSATION's transcript while the compiled bar is a fold of one
        // TURN's events), so it is joined at read time, which is also what makes a plugin's
        // `setIncluded` (or another tab's toggle) visible on the next click instead of hiding
        // behind a stale compiled cache. ABSENT when NO join resolves an entry — for a call, for a
        // thinking window, or for an answer window (FIX C added the third join, so the turn's
        // answer is a switchable segment whenever its recorded bytes single out one assistant
        // entry): the client then keeps its per-kind `inPrompt` verdict and shows no control
        // (../shared/turn-display.ts `included`).
        //
        // HOW THIS DIFFERS FROM THE BAR (R7/T4b), which publishes the same field name from the
        // SAME joins in the display read (`contextSegmentIncludedOf`, applied by
        // `getSessionTurnDisplay`): the bar answers for the WHOLE SEGMENT, this route answers for
        // the ENTRY this chip switches. They are the same figure in every case but one — a tool
        // round whose recorded call is resolved and whose request entry is withheld while its
        // result entry still rides (R8 per-entry write, ../harness.ts `projectTranscript` letting
        // the answer travel as an ownerless entry). The dialog then honestly says "this entry is
        // switched off", while the bar honestly says "bytes of this segment are still in the
        // prompt", because a tool's request and answer are ONE segment and the client can only
        // draw it whole (../frontend/view-context.ts `contextBlockIsExcluded`, and the live
        // `context:set` this write emits below carries the BAR's figure for exactly that reason).
        // R5 review, FIX C: the ANSWER join takes its place in this chain rather than a new field
        // beside it. An `assistant` segment mints no call id, so this route used to answer `absent`
        // for every turn's whole answer — no chip, nothing to click — even though the recorded
        // bytes name one assistant entry whenever the answer streamed in one run. Same rule as the
        // thinking join below: exact bytes, one entry or none, never a borrowed flag.
        const target = block.kind === 'assistant' ? blockAnswerOf(record, turn, block) : blockEntryOf(record, turn, block);

        // Uplift T7 (F8): the thinking axis. A `reasoning` segment names no call, so the
        // entry join answers nothing for it and the thought join gets its turn — the flag
        // T6 added lives on the entry that streamed this thinking, so this is the read that
        // can say whether a model's own prior thinking rides in the requests that follow (the
        // bar stamps the same axis off the same join, `contextSegmentIncludedOf`). The static
        // per-kind `inPrompt: false` stays on the block UNTOUCHED: it is the fallback verdict
        // for a server that cannot name the entry, not a claim about the segment class
        // (../shared/turn-display.ts `inPrompt`).
        const thought = target === undefined ? blockThoughtOf(record, turn, block) : undefined;
        const verdict =
            target !== undefined
                ? entryIncludedOf(target.entry)
                : thought !== undefined
                  ? thoughtIncludedOf(thought.entry)
                  : undefined;

        const response: TurnBlockDetailResponse = {
            block: verdict === undefined ? block : { ...block, included: verdict }
        };

        return json(200, response, events.getRevision('turn', turnKey(record.id, ctx.params.turn_id)));
    };

    // T7 (R6/R7), extended by trimmer uplift T7: the ONE write the segment dialog makes,
    // which now reaches TWO canonical axes:
    //   - `included` — the segment's OWN prompt axis, written the way core's `setIncluded`
    //     writes it (ONE entry, in place, `false` the only stored value — R8 removed the
    //     unit fan-out, so a click moves exactly the entry this segment names);
    //   - `reasoningIncluded` — the THINKING axis, written the way core's
    //     `setReasoningIncluded` writes it (ONE assistant entry, `false` the only stored
    //     value, ../harness.ts `setReasoningIncluded`).
    //
    // WHY ITS OWN ROUTE AND NOT THE WHOLE-DOCUMENT PUT. `PUT .../transcript` replaces every
    // entry from a document the CLIENT read earlier, so a toggle would be a cross-modal
    // read-modify-write: a run committing a result, or a plugin's own `setIncluded`, landing
    // in between would be silently rewritten by the client's stale copy (a tool result
    // committed mid-dialog is exactly that). This route names the ENTRY, reads the transcript
    // itself at the moment of the write, and moves ONE flag on ONE entry, so
    // there is no window to lose anything in. The shipped semantics still apply end to end:
    // the flag is installed through `updateThreadTranscript` — the same validation, the same
    // running refusal, the same durable-before-response rule, the same `transcript.updated`
    // signal — and written exactly the way core writes it.
    //
    // WHICH ENTRY A FIELD MEANS (one rule, mirroring the read): a field resolves through the
    // join that can name THIS segment's entry — `included` through the entry join for a call,
    // through the thought join for a thinking window (for a thinking window, what rides in the
    // prompt IS its thinking, which is why the read publishes its `included` from that flag), and
    // through the ANSWER join for an answer window, where the recorded answer bytes name the one
    // assistant entry whose `content` they are (R5 review, FIX C — what rides in the prompt IS
    // that content, so the entry flag is the segment's figure and the bar dims with it);
    // `reasoningIncluded` names the thinking axis EXPLICITLY and resolves only through the
    // thought join. The three joins are keyed on mutually exclusive evidence — a call id, recorded
    // `reasoning` bytes, recorded `text` bytes — so AT MOST ONE join can ever resolve for one
    // block, and one body moves one document. A segment whose requested axis names no live entry
    // is refused 409, exactly as before this change.
    const patchSessionTurnBlock: Handler = async (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const turn = requireTurn(record, ctx.params.turn_id);
        const body = requireObjectBody<PatchTurnBlockRequest>(await ctx.body());

        requireKnownFields(body, ['included', 'reasoningIncluded']);

        // AT LEAST ONE axis, then every axis present STRICTLY a boolean — the same strictness
        // core's own controls apply to their arguments (src/harness.ts:8887-8934 for `setIncluded`,
        // :8955-8999 for `setReasoningIncluded`): `'false'` and `0` are typos on this surface, not
        // values to coerce, and every check happens before anything is written.
        if (body.included === undefined && body.reasoningIncluded === undefined) {
            throw new HttpError(400, 'A context segment write requires at least one of "included" and "reasoningIncluded".');
        }

        if (body.included !== undefined && typeof body.included !== 'boolean') {
            throw new HttpError(400, 'A context segment inclusion write requires a boolean "included" value.');
        }

        if (body.reasoningIncluded !== undefined && typeof body.reasoningIncluded !== 'boolean') {
            throw new HttpError(400, 'A context segment write requires a boolean "reasoningIncluded" value.');
        }

        // The same resolvers the read uses, so an unknown segment is 404 and a blank id is 400
        // HERE exactly as they are there, and the metadata both joins read (kind, `eventFrom`,
        // the recorded thinking text) comes from the record rather than from the client.
        const block = store.blockDetail(record.id, ctx.params.turn_id, ctx.params.block_id);
        // WHICH AXIS EACH FIELD ADDRESSES, for this segment. On a thinking segment BOTH fields
        // mean the thinking axis, because the only flag that decides whether a thinking window
        // rides in the next request is that entry's `reasoningIncluded`; on any other segment
        // `included` means the ONE entry behind the recorded call (R8 — the assistant entry that
        // asked for it, or the result itself when its owner is gone), and `reasoningIncluded`
        // names an axis this segment's recorded bytes cannot reach.
        const isThinkingSegment = block.kind === 'reasoning';
        const entryRequested = !isThinkingSegment && body.included !== undefined;
        const thinkingRequested = isThinkingSegment || body.reasoningIncluded !== undefined;
        const entryTarget = entryRequested
            ? block.kind === 'assistant'
                ? blockAnswerOf(record, turn, block)
                : blockEntryOf(record, turn, block)
            : undefined;
        const thoughtTarget = thinkingRequested ? blockThoughtOf(record, turn, block) : undefined;

        // EACH REQUESTED AXIS IS CHECKED ON ITS OWN, the thinking axis first: on a segment that
        // records a call, a body naming both axes must REFUSE rather than write the entry and drop
        // the field that cannot land — half a receipt would misstate what the click did. A segment
        // whose requested axis names no live entry is a 409, not a quiet no-op: the reader is
        // looking at a real segment whose field cannot be written to it, and 404 would claim the
        // segment is gone.
        if (thinkingRequested && thoughtTarget === undefined) {
            throw new HttpError(
                409,
                `Context segment "${block.id}" has no thinking entry to switch: the recorded thinking is not the exact reasoning of one assistant entry in this conversation's transcript.`
            );
        }

        if (entryRequested && entryTarget === undefined) {
            // TWO JOINS CAN FAIL HERE and they fail for different reasons, so the sentence names
            // the one that did: a call that is not in the transcript, versus an answer the answer
            // join could not single out (FIX C). The tool wording is byte-identical to what this
            // route has always answered, pinned by ./view.test.ts.
            throw new HttpError(
                409,
                block.kind === 'assistant'
                    ? `Context segment "${block.id}" has no transcript entry to switch: the recorded answer is not the exact content of one assistant entry in this conversation's transcript.`
                    : `Context segment "${block.id}" has no transcript entry to switch: the call it recorded is not in this conversation's transcript.`
            );
        }

        // THE WRITE: one structural copy of one conversation's transcript, one flag on one
        // entry. The explicit field decides the thinking axis (`reasoningIncluded` NAMES it),
        // and on a thinking segment the two fields address the same entry — so a body carrying
        // both can only ever state one verdict, and it is the explicit one.
        const thinkingValue = typeof body.reasoningIncluded === 'boolean' ? body.reasoningIncluded : (body.included as boolean);
        const patched =
            entryTarget !== undefined
                ? messagesWithInclusion(entryTarget.messages, entryTarget.entry, body.included as boolean)
                : messagesWithReasoningInclusion(thoughtTarget!.messages, thoughtTarget!.entry, thinkingValue);
        const target = entryTarget ?? thoughtTarget!;

        // Async because it is durable before the response (./sessions.ts
        // `updateThreadTranscript`); a RUNNING conversation refuses from inside it with 409,
        // which is the honest answer — the run owns the transcript it is appending to, and a
        // mid-run flag change would be rewritten by the run itself.
        await store.updateThreadTranscript(record.id, target.threadId, patched);

        // Read the state BACK instead of echoing the request: the receipt is then the PERSISTED
        // verdict, so the dialog paints what the server holds (R6: no optimistic state), even if
        // the entry moved between the click and the write. An entry re-resolves through its call
        // id; a thinking entry re-resolves through the SAME recorded thinking text, which it
        // keeps carrying whatever its flag says — T6 withholds thinking from the PROJECTION COPY
        // only (../core/agent.ts `withoutWithheldReasoning`), never from the canonical entry. An
        // ANSWER entry re-resolves through its `content` for exactly the same reason (FIX C): the
        // flag moves the entry out of the request, never out of the document, so the join keeps
        // naming it and the receipt states the figure the next read will publish.
        const live = store.liveSession(record.id);
        const liveMessages = transcriptMessagesOf(live, target.threadId);
        const afterEntry =
            entryTarget === undefined
                ? undefined
                : 'callId' in entryTarget
                  ? transcriptEntryOfCall(liveMessages, entryTarget.callId)
                  : blockAnswerOf(live, turn, block)?.entry;
        const afterThought = thoughtTarget === undefined ? undefined : (blockThoughtOf(live, turn, block) ?? thoughtTarget);
        const key = threadKey(record.id, target.threadId);
        const revision = events.getRevision('transcript', key);

        // T16 counter domains, same as the transcript PUT: the store's own `transcript.updated`
        // signal already moved `transcript` and `transcript_messages`, so the receipt quotes
        // that figure; the conversation row is the REST-owned counter for a content change,
        // and which entries — and which entries' thinking — the model reads IS content.
        events.bumpRevision('thread', key);

        const messages = transcriptMessagesOf(live, target.threadId);
        const unreadable = live.invalidThreads.has(target.threadId);

        publish('transcript.updated', [{ resource: 'transcript', id: key }], {
            thread_id: target.threadId,
            revision,
            message_count: messages.length,
            transcript_state: unreadable ? 'unreadable' : 'ok'
        });

        // The receipt states the figures a reader can act on: `included` is the verdict the
        // NEXT detail read publishes for THIS segment — the entry's for a call, the thinking's
        // for a thinking window, from the same join, so the chip and the read cannot disagree —
        // and `reasoning_included` is the thinking axis itself, reported whenever this block
        // names a thinking entry. On a thinking segment the two are the same figure by
        // construction; on a tool segment only `included` exists, exactly as before.
        const included =
            afterEntry !== undefined
                ? entryIncludedOf(afterEntry)
                : afterThought !== undefined
                  ? thoughtIncludedOf(afterThought.entry)
                  : (entryTarget !== undefined ? entryIncludedOf(entryTarget.entry) : thoughtIncludedOf(thoughtTarget!.entry));
        const reasoningIncluded = afterThought === undefined ? undefined : thoughtIncludedOf(afterThought.entry);

        // R7 (T4b): THE LIVE REPAINT, so the lane dims without a reload. The write above is a
        // transcript write, and the store's own signal for it (`transcript.updated`,
        // ./sessions.ts `updateThreadTranscript`) names only a CONVERSATION — a bar segment is
        // addressed by turn and block, so only this route, which holds both, can announce the
        // segment's new verdict. One frame, one op, the same emission pattern the recorder's
        // `display.ops` signal uses above (all three turn counters move together, because the
        // contract defines the display and event revisions to EQUAL the owning turn's).
        //
        // THE FIGURE IS THE BAR'S, not the receipt's. `included` below in the receipt is the
        // per-entry verdict the chip switched; the op carries the SEGMENT verdict from
        // `contextSegmentIncludedOf`, i.e. exactly what the NEXT display read of this turn
        // publishes, so the dim a click produces cannot be undone by the refresh that follows it.
        // For a tool round that means a withheld REQUEST keeps the segment OPAQUE while its answer
        // still travels — the half-segment limitation the shipped reader already states
        // (../frontend/view-context.ts `contextBlockIsExcluded`) — and for a thinking window it
        // means the dim lands on the same frame as the write. ABSENT (no entry) is not patchable
        // and is not announced: a `context:set` has no way to say "unknown" again, and this route
        // has already refused any write whose axis names no entry.
        const barVerdict = contextSegmentIncludedOf(live, turn, block);

        if (barVerdict !== undefined) {
            const displayKey = resourceKeyOf('turn_display', turnKey(record.id, turn.id));

            events.bumpRevision('turn', turnKey(record.id, turn.id));
            events.bumpRevision('turn_display', turnKey(record.id, turn.id));
            events.bumpRevision('turn_events', turnKey(record.id, turn.id));

            events.publish({
                kind: 'display.ops',
                resources: [displayKey],
                target: displayKey,
                ops: [
                    {
                        op: 'context:set',
                        turnId: turn.id,
                        sectionId: block.sectionId,
                        blockId: block.id,
                        patch: { included: barVerdict }
                    }
                ]
            });
        }

        const receipt: TurnBlockWriteReceipt = {
            session_id: record.id,
            turn_id: turn.id,
            block_id: block.id,
            included,
            ...(reasoningIncluded === undefined ? {} : { reasoning_included: reasoningIncluded }),
            thread_id: target.threadId,
            revision,
            links: {
                block: `${ctx.mount}/sessions/${record.id}/turns/${turn.id}/blocks/${encodeURIComponent(block.id)}`,
                transcript: `${ctx.mount}/sessions/${record.id}/threads/${target.threadId}/transcript`
            }
        };

        return json(200, receipt, revision);
    };

    const getSessionTurnAttachment: Handler = (ctx) => {
        const record = requireSession(ctx.params.session_id);
        const turn = requireTurn(record, ctx.params.turn_id);
        const attachment = (turn.attachments ?? []).find((entry) => entry.id === ctx.params.attachment_id);

        if (attachment === undefined) {
            throw missing('attachment', ctx.params.attachment_id, record.id);
        }

        // This is the one route that carries `data`: the descriptor rows on every other read
        // exist precisely so the bytes stay here until a client asks for them.
        const response: AttachmentResponse = { attachment };

        return json(200, response);
    };

    // ---- stream -----------------------------------------------------------------

    // The realtime transport answers this with a 101 upgrade (./stream/**, the other owner).
    // A plain GET that reaches the JSON dispatcher asked for an upgrade it did not send, so
    // the answer is 400; when the deployment withholds the transport the answer is 403, which
    // is what `capabilities.websocket_stream` promised.
    const streamRoute: Handler = (ctx) => {
        if (!advertisedCapabilities.websocket_stream) {
            throw capabilityDenied('a live stream on this deployment', `GET ${ctx.mount}/stream`);
        }

        throw new HttpError(400, 'GET /stream expects a WebSocket upgrade (Sec-WebSocket-Key/Version) for the harness.v1 subprotocol.');
    };

    // `attachmentDescriptorOf`, `promptPreview`, and `storedTypeOf` are re-used below; the
    // read model owns the bounds so a preview length is decided in exactly one file.

    // ------------------------------------------------------------------
    // Route table (every path in HARNESS_PATH_TEMPLATES, every method the
    // contract declares). A path that exists but not for this method is a
    // 405, which is why the table is grouped by path rather than by verb.
    // ------------------------------------------------------------------

    type MethodTable = Partial<Record<'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', Handler>>;

    const routes: Partial<Record<keyof typeof HARNESS_PATH_TEMPLATES, MethodTable>> = {
        root: { GET: root },
        health: { GET: health },
        config: { GET: getConfig, PATCH: patchConfig },
        harnesses: { GET: getHarnesses, POST: postHarness },
        harnessesByHarnessName: { GET: getHarnessOne, PATCH: patchHarness, DELETE: deleteHarness },
        harnessesByHarnessNameInstructions: { GET: getHarnessInstructions },
        harnessesByHarnessNameInstructionsByAgentId: { GET: getHarnessInstructionText },
        agents: { GET: getAgents },
        agentsByAgentId: { GET: getAgentOne, PATCH: patchAgent, DELETE: deleteAgent },
        tools: { GET: getTools },
        // R3: the identified read plus the one global write a catalogue entry has.
        toolsByToolId: { GET: getToolOne, PATCH: patchTool },
        toolsByToolIdExecutions: { POST: postToolExecution },
        // T5 (R2/R3): the built-in plugin catalogue and the one writable field it has.
        plugins: { GET: getPlugins },
        pluginsByPluginId: { PATCH: patchPlugin },
        models: { POST: postModels },
        sessions: { GET: getSessions, POST: postSession },
        sessionsBySessionId: { GET: getSession, PATCH: patchSession, DELETE: deleteSession },
        sessionsBySessionIdDefinition: { GET: getSessionDefinition },
        sessionsBySessionIdUsage: { GET: getSessionUsage },
        sessionsBySessionIdCommands: { GET: getSessionCommands },
        sessionsBySessionIdQueue: { GET: getSessionQueue },
        // The record store read (snapshot / `?since=` delta). Named `records`, never
        // `tasks`, because `sessionsBySessionIdTasks` below is the RUN QUEUE submit and a
        // record collection called `tasks` is a different thing entirely.
        sessionsBySessionIdRecords: { GET: getSessionRecords },
        sessionsBySessionIdTasks: { POST: postSessionTask },
        sessionsBySessionIdReset: { POST: postSessionReset },
        sessionsBySessionIdCancel: { POST: postSessionCancel },
        sessionsBySessionIdActions: { GET: getSessionActions },
        sessionsBySessionIdActionsByRequestIdAnswer: { POST: postActionAnswer },
        sessionsBySessionIdAgents: { GET: getSessionAgents, POST: postSessionAgent },
        sessionsBySessionIdAgentsByAgentId: { GET: getSessionAgent, PATCH: patchSessionAgent, DELETE: deleteSessionAgent },
        // T27: the instruction subresource gained its write verb. The binding PATCH already
        // accepts `instruction`; this is the same store operation reached from the document a
        // client is looking at, and it returns that same document after the write.
        sessionsBySessionIdAgentsByAgentIdInstruction: { GET: getSessionAgentInstruction, PATCH: patchSessionAgentInstruction },
        sessionsBySessionIdTools: { GET: getSessionTools, POST: postSessionTool },
        sessionsBySessionIdToolsByToolId: { GET: getSessionTool, PATCH: patchSessionTool, DELETE: deleteSessionTool },
        sessionsBySessionIdToolsByToolIdSource: { GET: getSessionToolSource },
        sessionsBySessionIdToolsByToolIdExecutions: { POST: postSessionToolExecution },
        // R4: the session-scoped plugin pair. Same generated row schema as the two global plugin
        // routes above, one different scope — `record.plugins` instead of the process store.
        sessionsBySessionIdPlugins: { GET: getSessionPlugins },
        sessionsBySessionIdPluginsByPluginId: { GET: getSessionPlugin, PATCH: patchSessionPlugin },
        sessionsBySessionIdThreads: { GET: getSessionThreads, POST: postSessionThread },
        sessionsBySessionIdThreadsByThreadId: { GET: getSessionThread, DELETE: deleteSessionThread },
        sessionsBySessionIdThreadsByThreadIdCancel: { POST: postThreadCancel },
        // R1: the stop's counterpart. Same path shape as `cancel`, one verb, no body.
        sessionsBySessionIdThreadsByThreadIdResume: { POST: postThreadResume },
        sessionsBySessionIdThreadsByThreadIdTranscript: { GET: getTranscriptMetadata, PUT: putTranscript },
        sessionsBySessionIdThreadsByThreadIdTranscriptMessages: { GET: getTranscriptMessages },
        sessionsBySessionIdThreadsByThreadIdTranscriptDocument: { GET: getTranscriptDocument },
        sessionsBySessionIdTurns: { GET: getSessionTurns },
        sessionsBySessionIdTurnsByTurnId: { GET: getSessionTurn },
        sessionsBySessionIdTurnsByTurnIdDisplay: { GET: getSessionTurnDisplay },
        sessionsBySessionIdTurnsByTurnIdEvents: { GET: getSessionTurnEvents },
        sessionsBySessionIdTurnsByTurnIdStepsByStepId: { GET: getSessionTurnStep },
        sessionsBySessionIdTurnsByTurnIdBlocksByBlockId: { GET: getSessionTurnBlock, PATCH: patchSessionTurnBlock },
        sessionsBySessionIdTurnsByTurnIdAttachmentsByAttachmentId: { GET: getSessionTurnAttachment },
        stream: { GET: streamRoute }
    };

    // ------------------------------------------------------------------
    // Dispatch
    // ------------------------------------------------------------------

    const dispatch = async (request: HarnessApiRequest): Promise<HarnessApiResult> => {
        const method = request.method.toUpperCase();
        const mount = request.mount;

        // T13 removed the second mount. A request addressed to a stale prefix (an older
        // client still calling `/api/...`) is a 404 that NAMES the canonical root: an alias
        // would keep the old surface alive behind a flag nobody can see.
        if (mount !== HARNESS_API_ROOT) {
            throw new HttpError(404, `This server serves ${HARNESS_API_ROOT}; "${mount}" is not mounted.`);
        }

        const segments = relativeSegments(request.pathname, mount);

        if (segments === undefined) {
            throw new HttpError(404, `Unknown API route: ${method} ${request.pathname}`);
        }

        const matched = matchRoute(segments);

        if (matched === undefined) {
            throw new HttpError(404, `Unknown API route: ${method} ${request.pathname}`);
        }

        const table = routes[matched.id];
        const handler = table?.[method as keyof MethodTable];

        if (handler === undefined) {
            const allowed = table === undefined ? [] : (Object.keys(table) as string[]);

            // A body-less 405 must not consume the body (an adapter may not have drained it).
            throw new HttpError(
                405,
                `Use ${allowed.length === 0 ? 'GET' : allowed.join(', ')} for ${mount}${segments.length === 0 ? '' : `/${segments.join('/')}`}.`
            );
        }

        const ctx: Ctx = {
            request,
            method,
            mount,
            query: queryOf(request),
            params: matched.params,
            // Bodies are read lazily: a route that rejects before looking at the body (an
            // unknown id) never consumes it.
            body: <T>() => request.readBody<T>()
        };

        return await handler(ctx);
    };

    const api = (async (request: HarnessApiRequest): Promise<HarnessApiResult> => {
        try {
            return await dispatch(request);
        } catch (error) {
            // One error envelope for every failure (spec `ApiErrorBody`), so a client has one
            // error path. Statuses come from the layers that own the semantics:
            // HttpError (this dispatcher), SessionError (the store), HarnessRegistryError
            // (the definition registry), and ModelListError (a provider call).
            if (isInstanceOf(error, HttpError)) {
                return { kind: 'json', status: error.status, body: { error: { message: messageOf(error) } } };
            }

            if (
                isInstanceOf(error, SessionError) ||
                isInstanceOf(error, HarnessRegistryError) ||
                isInstanceOf(error, AgentStateError) ||
                isInstanceOf(error, HarnessPluginSettingsError) ||
                // R3: the global tool switch's 400/403, status-carrying like the plugin one.
                isInstanceOf(error, HarnessToolSettingsError)
            ) {
                return {
                    kind: 'json',
                    status: error.status,
                    body: { error: { message: messageOf(error) } }
                };
            }

            if (error instanceof SettingsError) {
                return { kind: 'json', status: 400, body: { error: { message: messageOf(error) } } };
            }

            if (error instanceof ModelListError) {
                return {
                    kind: 'json',
                    status: error.kind === 'configuration' ? 400 : 502,
                    body: { error: { message: messageOf(error) } }
                };
            }

            return { kind: 'json', status: 500, body: { error: { message: messageOf(error) } } };
        }
    }) as HarnessApi;

    // The stream hook the realtime owner integrates with. Attached to the function object so
    // `createHarnessApi(...)` keeps returning a plain callable for every existing adapter.
    Object.defineProperty(api, 'events', { value: events, enumerable: true });
    Object.defineProperty(api, 'epoch', { value: events.epoch, enumerable: true });

    return api;
};

/** The live-store read context type, re-exported so a test can build one directly. */
export type { ReadContext };

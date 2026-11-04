// The browser client for the harness control plane — CANONICAL CONTRACT ONLY (T14).
//
// One root, one vocabulary: every request this module makes is built from
// `HARNESS_ROUTES` (../shared/harness-api.ts, generated from
// src/server/harness.swagger.yaml) against `HARNESS_API_ROOT` = `/v1/harness`.
// The legacy `/api` mount, the `/views` mirror, and the `text/event-stream`
// observer are GONE from this file: the UI has no backward compatibility to
// carry, and realtime lives in ./stream.ts (the `harness.v1` WebSocket), so the
// SSE parsers have no caller left.
//
// WHY THE SHAPE OF EVERY FUNCTION HERE IS "SMALL + NAMED":
// the payload rule of the contract is that a client never receives a document it
// did not ask for. `GET /sessions/{id}` answers a metadata row (no turns, no
// threads, no definition); the turn rows, thread roster, queue, actions, usage,
// definition, toolbox, agents, and commands are each their OWN bounded page. So
// the boot cost of this UI is a constant, and a 6-session catalogue costs
// `limit` rows instead of ~50 MB of recorded events.
//
// Paging: every collection read takes an explicit `cursor`/`limit` and returns
// the generated page DTO (`PageMeta` + `items`). `pageParams` clamps `limit` into
// `HARNESS_PAGE_LIMIT` (default 25, max 100) so a caller cannot ask for an
// unbounded page by accident. Nothing in this module loops pages implicitly —
// the caller (./view-api.ts, ./main.ts) decides when the user asked for more.
//
// Revisions/epochs: `requestResource` returns the parsed body PLUS the
// `X-Harness-Epoch` / `X-Harness-Revision` headers, which is how a caller learns
// the counter it is comparing a stream frame against. `request` stays the
// body-only path used by every read that does not reconcile a revision.
//
// ROOT RESOLUTION (unchanged semantics, canonical default):
//   1. `?apiRoot=` on the page URL (validated, runtime → trust-gated);
//   2. server-injected config (`window.__HARNESS_CONFIG__.apiRoot` or
//      `<meta name="harness-api-root">`), also runtime → trust-gated;
//   3. build-time `VITE_HARNESS_API` (operator data → trusted);
//   4. on a GitHub Pages host: the local/LAN gateway chain in ./deployment.ts
//      (every entry already names `/v1/harness`), probed by `ensureApiRoot`;
//   5. `HARNESS_API_ROOT` (`/v1/harness`) — the standalone and the gateway mount
//      answer the same path, so there is no per-mount root any more.
//
// TRUST: sources 1 and 2 are RUNTIME and therefore untrusted. The UI posts the
// provider key saved in this browser to whatever root it resolves, so an absolute
// root from a query string or injected config must be same-origin with the page,
// a loopback host, or one of the compiled chain entries (../shared/origin.ts).
// Source 3 is compiled into the bundle by the operator and is deliberately
// trusted: a cross-origin `VITE_HARNESS_API` is a supported deployment.

import { HARNESS_API_ROOT, HARNESS_EPOCH_HEADER, HARNESS_PAGE_LIMIT, HARNESS_REVISION_HEADER, HARNESS_ROUTES } from '../shared/harness-api';
import { isTrustedRuntimeOrigin } from '../shared/origin';
import { STATIC_API_CANDIDATES, isStaticPagesHost } from './deployment';
import type {
    ActionChoiceInput,
    AgentProfile,
    AgentProfileResponse,
    AgentSummary,
    HarnessInstructionSummaryEntry,
    AgentSummaryPage,
    AttachmentResponse,
    CancelSessionRequest,
    CancelSessionResult,
    CommandPage,
    CreateHarnessRequest as HarnessCreateRequest,
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
    HarnessCard,
    HarnessCardPage,
    HarnessDefinition,
    HarnessDefinitionResponse,
    HarnessInstructionIndexResponse,
    HarnessInstructionTextResponse,
    HealthResponse,
    ModelDiscoveryRequest,
    ModelIndex,
    PageMeta,
    PendingActionListResponse,
    ProviderDefaults,
    QueuedTask,
    QueuedTaskPage,
    ResetSessionResult,
    RunnerSettingsInput,
    SessionAgentBinding,
    SessionAgentListResponse,
    SessionAgentResponse,
    SessionDefinitionResponse,
    SessionInstructionTextResponse,
    SessionResource,
    SessionResponse,
    SessionSummary,
    SessionSummaryPage,
    SessionToolDetail,
    SessionToolPage,
    SessionToolRegistrationResponse,
    SessionToolResponse,
    SessionToolSourceResponse,
    SessionUsageResponse,
    SubmitTaskRequest,
    TaskReceipt,
    ThreadResource,
    ThreadResponse,
    ThreadSummary,
    ThreadSummaryPage,
    ToolCallResult,
    ToolDetail,
    ToolDetailResponse,
    ToolSummary,
    ToolSummaryPage,
    TranscriptDocumentResponse,
    TranscriptMessagePage,
    TranscriptMetadata,
    TranscriptMetadataResponse,
    TranscriptWriteReceipt,
    UpdateAgentRequest,
    UpdateHarnessRequest,
    UpdateSessionAgentRequest,
    UpdateSessionRequest,
    UpdateSessionToolRequest,
    UpdateThreadTranscriptRequest
} from '../shared/harness-api';
import type { HarnessEvent, HarnessUsage } from '../types';
// The display subtree uses the GENERATED aliases in ../shared/harness-api (they ARE
// ../shared/turn-display.ts's models). Naming them here is what makes this module's
// returns "the wire contract", and ./display-project.ts is the single place that
// narrows them into the projector's union for the renderers.
import type {
    ServiceCapabilities,
    ServiceInfo,
    TurnBlockDetail,
    TurnDisplay,
    TurnStepDetail,
    TurnSummary
} from '../shared/harness-api';

// ---------------------------------------------------------------------------
// The boot document the shell renders
// ---------------------------------------------------------------------------

// What the shell needs before it can draw a first frame, assembled from four
// bounded reads (see `loadBootstrap`): the service document, the FIRST page of
// harness cards, the FIRST page of tool rows, and the FIRST page of session rows.
// It deliberately carries NO display data and no per-agent instruction text: a
// card page is metadata, and the definition read (with `agent_models` and the
// instruction summary) is one identified read away.
export type HarnessBootstrap = {
    // `ServiceInfo.api_root` verbatim — what the server itself says it is mounted at.
    rootPath: string;
    // Identity, capability advertisement and limits. The UI uses `capabilities` to
    // hide an affordance instead of discovering a 403 by clicking it, and `limits`
    // to validate a submit before sending it.
    info: ServiceInfo;
    // Definition cards, first page only, in the shape the rail renders.
    presets: HarnessCardView[];
    // Catalogue rows, first page only, in the shape the tools view renders.
    tools: ToolRowView[];
    // Trusted profile rows, first page only (no instruction TEXT on a row).
    agents: AgentRowView[];
    // Key-free provider defaults from GET /config (`base_url`, `model`, `has_api_key`).
    defaults: ProviderDefaults;
    // Session rows, first page only: metadata + counters, never turns or threads.
    sessions: SessionSummary[];
    // Paging cursors of the four seed pages, so the shell can extend a directory
    // without re-reading it (`null` = that page was the whole collection).
    cursors: { harnesses: string | null; tools: string | null; agents: string | null; sessions: string | null };
};

// The default root when nothing is pinned. The legacy `/api` is gone: standalone
// and gateway-mounted deployments answer `HARNESS_API_ROOT` (spec: "the one API
// root"), so a relative default is correct on every host that serves an API.
const FALLBACK_ROOT = HARNESS_API_ROOT;

// A root is a path prefix (`/v1/harness`) or an absolute http(s) URL origin+path.
// Anything else (a scheme like `javascript:`, a protocol-relative `//host`, a
// query, a hash, or embedded userinfo) is rejected: this value ends up in every
// request URL, so it must not be able to carry credentials or change meaning
// when concatenated.
//
// This function is SYNTAX only. Whether an absolute origin may be used depends
// on the source: `resolveRoot` applies the same-origin/loopback rule to runtime
// sources, and trusts the build-time value (see the header).
export const normalizeApiRoot = (value: string | null | undefined, fallback: string): string => {
    const raw = (value ?? '').trim();
    if (raw.length === 0) return fallback;

    // Absolute URL: require http(s), no search/hash/userinfo.
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
        let parsed: URL;
        try {
            parsed = new URL(raw);
        } catch {
            throw new Error(`"${raw}" is not a valid API root URL.`);
        }

        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('The API root must be an http(s) URL.');
        }

        if (parsed.search.length > 0 || parsed.hash.length > 0) {
            throw new Error('The API root cannot carry a query string or a fragment.');
        }

        if (parsed.username.length > 0 || parsed.password.length > 0) {
            throw new Error('The API root cannot carry credentials.');
        }

        return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '') || parsed.origin;
    }

    // Relative roots must be rooted paths. `//host` would be protocol-relative
    // and silently point at another origin; a bare segment would resolve under
    // whatever page URL this bundle happened to be served from.
    if (!raw.startsWith('/') || raw.startsWith('//')) {
        throw new Error('A relative API root must start with a single "/".');
    }

    if (raw.includes('?') || raw.includes('#')) {
        throw new Error('The API root cannot carry a query string or a fragment.');
    }

    // A backslash is a path separator for a browser's special-scheme URL parser:
    // fetch("/\evil.example/x") resolves to a DIFFERENT origin, even though the
    // value looks like a rooted path here. Reject it (and control characters,
    // which the parser strips) so a relative root cannot escape this origin.
    if (raw.includes('\\') || /[\u0000-\u001f\u007f]/.test(raw)) {
        throw new Error('A relative API root cannot contain backslashes or control characters.');
    }

    // A trailing slash would produce `//sessions`; strip every one. A root of
    // just "/" becomes "" so `${root}${path}` stays correct.
    return raw.replace(/\/+$/, '');
};

// Server-injected config, for a host that renders this bundle itself. Read
// defensively: the global is not typed and may be absent, partial, or hostile.
const injectedRoot = (): string | undefined => {
    const config = (globalThis as { __HARNESS_CONFIG__?: { apiRoot?: unknown } }).__HARNESS_CONFIG__;
    if (typeof config?.apiRoot === 'string') return config.apiRoot;

    const meta = globalThis.document?.querySelector<HTMLMetaElement>('meta[name="harness-api-root"]');
    return meta?.content;
};

// Resolve once at module load: every later request uses the same root, and the
// query parameter is not consulted per request (a change means a reload).
//
// The one exception is the STATIC-HOST chain (./deployment.ts): on a GitHub Pages
// host the documented sources name nothing, and the answer is not knowable
// synchronously — it is whichever local/LAN gateway actually answers. `resolveRoot`
// therefore returns the chain to probe, `ensureApiRoot` walks it, and `API_ROOT`
// moves to the winner before the first catalogue request.
type ResolvedRoot = {
    root: string;
    // The ordered roots to probe, or `undefined` when the root is explicit (a
    // query/injected/build-time value) or same-origin: those are pinned by the
    // operator or the URL, so probing somewhere else would silently replace a
    // deliberate choice with a guess.
    candidates: readonly string[] | undefined;
};

const resolveRoot = (): ResolvedRoot => {
    const query = new URLSearchParams(globalThis.location?.search ?? '').get('apiRoot') ?? undefined;

    // An absolute (origin+path) root is the only kind that can point somewhere
    // else; a rooted path stays on the page's origin by construction.
    const isAbsolute = (root: string): boolean => /^https?:\/\//i.test(root);

    // An invalid *query* value is ignored rather than fatal: a hand-edited URL must
    // not stop the UI from booting against its documented default. An ABSENT/blank
    // value must return undefined, not the fallback, or the later sources would
    // never be consulted.
    //
    // `trusted` is false for both runtime sources: they may only name the page's own
    // origin or a loopback host, because the saved provider key travels here. The
    // build-time value is operator-controlled and may be cross-origin.
    const attempt = (value: string | undefined, trusted: boolean): string | undefined => {
        if (value === undefined || value.trim().length === 0) return undefined;

        try {
            const root = normalizeApiRoot(value, FALLBACK_ROOT);

            // A root that names one of the compiled static candidates exactly is
            // operator data too — it is baked into this bundle by the build, so a
            // link cannot point the saved key at a host the deployment does not
            // already dial.
            const compiled = STATIC_API_CANDIDATES.includes(root);

            if (
                !trusted &&
                !compiled &&
                isAbsolute(root) &&
                !isTrustedRuntimeOrigin(root, globalThis.location?.origin)
            ) {
                return undefined;
            }

            return root;
        } catch {
            return undefined;
        }
    };

    const explicit =
        attempt(query, false) ??
        attempt(injectedRoot(), false) ??
        attempt(import.meta.env.VITE_HARNESS_API, true);

    if (explicit !== undefined) return { root: explicit, candidates: undefined };

    // Nothing was pinned. A Pages host has no API of its own, so the canonical
    // relative root is a guaranteed 404 there; the local/LAN chain is the honest
    // default and its first entry is the host the offline pane names while the
    // probe runs. Every other host (the harness server itself, the Vite dev/preview
    // proxy, the service gateway) serves `/v1/harness` on its own origin.
    if (isStaticPagesHost()) return { root: STATIC_API_CANDIDATES[0], candidates: STATIC_API_CANDIDATES };

    return { root: FALLBACK_ROOT, candidates: undefined };
};

// The public resolution surface: the root this page would use before the static
// probe moves it. Kept as a function so a caller (or a test) can re-resolve
// without re-importing the module graph.
export const resolveApiRoot = (): string => resolveRoot().root;

const initialRoot = resolveRoot();

// `let`, not `const`: `ensureApiRoot` moves the live binding to the candidate that
// answered. Every request URL is built through `url` below, which reads the current
// value, and an ESM live binding means importers observe the move too.
export let API_ROOT = initialRoot.root;

const staticCandidates = initialRoot.candidates;

// The chain this page probes, in order, or `[]` when its root is pinned and
// nothing is probed. The startup/offline panes render it so a failure names every
// host that was tried, not just the one the last request went to.
export const apiRootCandidates = (): readonly string[] => staticCandidates ?? [];

// One path segment per call: every route in this module comes from
// `HARNESS_ROUTES`, whose builders already include the canonical root. The
// client therefore prefixes the CURRENT (possibly probed/moved) root and strips
// the contract's own root off the builder output, which keeps the two in
// lockstep with one rule instead of two.
const pathOf = (route: string): string => {
    const stripped = route.startsWith(HARNESS_API_ROOT) ? route.slice(HARNESS_API_ROOT.length) : route;

    return stripped.length === 0 ? '' : stripped;
};

const url = (route: string): string => `${API_ROOT}${pathOf(route)}`;

// Shared with ./view-api.ts and ./stream.ts so every surface builds its URLs from
// the SAME (possibly probed/moved) root. A live-binding getter rather than a
// value, because `ensureApiRoot` moves the root after module load on a static host.
export const apiUrl = (route: string): string => url(route);

// The WebSocket endpoint for the realtime plane, derived from the SAME root so a
// deployment that mounts the API under an absolute origin gets a socket to that
// origin. `https:` must dial `wss:` or the browser refuses the upgrade.
export const streamSocketUrl = (): string => {
    // The endpoint every REST call already uses, as an absolute-or-root-relative
    // http(s) URL: `https://host/v1/harness/stream` or `/v1/harness/stream`.
    const endpoint = apiUrl(HARNESS_ROUTES.stream());

    // A root that names another origin carries its own host; the scheme swap is the
    // only difference, so an absolute `VITE_HARNESS_API` dials the socket there.
    if (/^https:\/\//i.test(endpoint)) return `wss://${endpoint.slice('https://'.length)}`;
    if (/^http:\/\//i.test(endpoint)) return `ws://${endpoint.slice('http://'.length)}`;

    // A root-relative path upgrades on THIS page's origin, matching its scheme.
    const origin = globalThis.location?.origin ?? 'http://localhost';
    const scheme = origin.startsWith('https:') ? 'wss:' : 'ws:';

    return `${scheme}//${origin.slice(origin.indexOf('//') + 2)}${endpoint}`;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// The single error envelope of the contract (`ErrorBody`), flattened to the
// server's own sentence so a failure stays actionable. A non-JSON error body
// (a proxy's HTML page) degrades to the status line.
const readError = async (response: Response): Promise<string> => {
    try {
        const body = (await response.json()) as { error?: { message?: string } };
        if (typeof body.error?.message === 'string') return body.error.message;
    } catch {
        // Not JSON, or the body was already consumed.
    }

    return `HTTP ${response.status} ${response.statusText}`.trim();
};

// The transport every request in this package goes through. `accept` lists extra
// statuses that are NOT failures: their body is parsed like a success (a DELETE
// whose 404 means "already gone"). A successful status is not proof of the wire
// contract either — a proxy with no upstream answers 200 with HTML — so a parse
// failure becomes a sentence naming the route, which the offline pane renders.
export const request = async <T>(
    path: string,
    init?: RequestInit,
    accept?: readonly number[]
): Promise<T> => (await requestResource<T>(path, init, accept)).data;

// The same transport, plus the two headers the contract stamps on every response:
// the server epoch (`HARNESS_EPOCH_HEADER`, changes on every restart and
// invalidates stream cursors) and the revision the read landed at
// (`HARNESS_REVISION_HEADER`). A caller that reconciles a live frame against a
// REST read needs both; a caller that only paints a body uses `request`.
export type ResourceRead<T> = {
    data: T;
    // Absent when the server (or a proxy in front of it) did not stamp the header.
    epoch?: string;
    revision?: number;
};

export const requestResource = async <T>(
    path: string,
    init?: RequestInit,
    accept?: readonly number[]
): Promise<ResourceRead<T>> => {
    let response: Response;

    try {
        response = await fetch(url(path), {
            ...init,
            headers: {
                'Content-Type': 'application/json',
                'X-Harness-Client': 'ui',
                ...(init?.headers ?? {})
            }
        });
    } catch (error) {
        // An aborted request is a deliberate cancellation (a superseded model
        // lookup), not an unreachable server; keep the original reason.
        if (init?.signal?.aborted) throw error;
        throw new Error(`The harness server is unreachable: ${messageOf(error)}`);
    }

    if (!response.ok && !(accept !== undefined && accept.includes(response.status))) {
        throw new Error(await readError(response));
    }

    const meta = (value: string | null): string | undefined => (value === null ? undefined : value);
    const epoch = meta(response.headers.get(HARNESS_EPOCH_HEADER));
    const revisionRaw = meta(response.headers.get(HARNESS_REVISION_HEADER));
    const revision = revisionRaw === undefined ? undefined : Number(revisionRaw);

    try {
        return {
            data: (await response.json()) as T,
            ...(epoch === undefined ? {} : { epoch }),
            ...(revision === undefined || Number.isNaN(revision) ? {} : { revision })
        };
    } catch {
        // An ACCEPTED status (a 404 whose body is a proxy's HTML page) is not a
        // parse failure worth reporting: the caller already knows the answer.
        if (accept !== undefined && accept.includes(response.status)) {
            return { data: undefined as unknown as T, ...(epoch === undefined ? {} : { epoch }) };
        }

        throw new Error(
            `The harness server returned a non-JSON response for ${pathOf(path).length > 0 ? pathOf(path) : '/'} (HTTP ${response.status}).`
        );
    }
};

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

// Query string for one collection read. `limit` is clamped into the contract's
// bounds so a client cannot request an unbounded page; `cursor` is sent verbatim
// (it is opaque, base64url of `epoch:sequence`) and omitted on the first page.
// Filters are passed as a partial record and every `undefined` is dropped, so a
// caller never sends `?status=undefined` and never invents a filter spelling: the
// keys come from the spec's query parameters (`limit`, `cursor`, `order`,
// `thread_id`, `status`, `agent`, `origin`, `enabled`, `role`, `q`, `group`,
// `availability`, `harness`).
export type PageQuery = {
    limit?: number;
    cursor?: string | null;
    order?: 'asc' | 'desc';
    status?: string;
    thread_id?: string;
    agent?: string;
    role?: string;
    origin?: string;
    enabled?: boolean;
    q?: string;
    group?: string;
    harness?: string;
    availability?: string;
};

export const pageParams = (query: PageQuery = {}): string => {
    const params = new URLSearchParams();
    const limit = query.limit === undefined ? HARNESS_PAGE_LIMIT.default : query.limit;

    // Clamp rather than throw: a caller that asks for 500 gets the contract's
    // largest page, and a caller that asks for 0 gets its smallest one.
    const bounded = Math.max(
        HARNESS_PAGE_LIMIT.min,
        Math.min(HARNESS_PAGE_LIMIT.max, Math.trunc(Number.isFinite(limit) ? limit : HARNESS_PAGE_LIMIT.default))
    );

    params.set('limit', String(bounded));

    if (typeof query.cursor === 'string' && query.cursor.length > 0) params.set('cursor', query.cursor);
    if (query.order !== undefined) params.set('order', query.order);
    if (query.status !== undefined) params.set('status', query.status);
    if (query.thread_id !== undefined) params.set('thread_id', query.thread_id);
    if (query.agent !== undefined) params.set('agent', query.agent);
    if (query.role !== undefined) params.set('role', query.role);
    if (query.origin !== undefined) params.set('origin', query.origin);
    if (query.enabled !== undefined) params.set('enabled', String(query.enabled));
    if (query.q !== undefined) params.set('q', query.q);
    if (query.group !== undefined) params.set('group', query.group);
    if (query.harness !== undefined) params.set('harness', query.harness);
    if (query.availability !== undefined) params.set('availability', query.availability);

    // `?` only when there is something to send: the root and health reads carry
    // no query, and an empty `?` would be a different cache key for no reason.
    const text = params.toString();

    return text.length === 0 ? '' : `?${text}`;
};

// One page boundary a client can hand back to `pageParams`: the items plus the
// cursor to continue from (`null` = end of collection) and the collection
// revision the page was assembled at, which is the figure a stream frame is
// compared against within one epoch.
export type Page<T> = { items: T[]; nextCursor: string | null; revision: number; limit: number };

const pageOf = <T>(body: PageMeta & { items: T[] }): Page<T> => ({
    items: Array.isArray(body.items) ? body.items : [],
    nextCursor: body.next_cursor ?? null,
    revision: body.revision,
    limit: body.limit
});

// ---------------------------------------------------------------------------
// Static-host failover
// ---------------------------------------------------------------------------

// One bounded `GET {root}/health` per candidate. A dead loopback port refuses
// instantly, but a dead LAN address can hang on an unanswered SYN, so the probe is
// capped — otherwise a Pages page waits for a TCP timeout before reaching the next
// candidate. `AbortSignal.timeout` is used when the engine has it; without it the
// probe is still correct, just uncapped.
const PROBE_TIMEOUT_MS = 2500;

const probeRoot = async (root: string): Promise<boolean> => {
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(PROBE_TIMEOUT_MS) : undefined;

    try {
        const response = await fetch(`${root}${pathOf(HARNESS_ROUTES.health())}`, {
            headers: { 'Content-Type': 'application/json', 'X-Harness-Client': 'ui' },
            ...(signal === undefined ? {} : { signal })
        });

        if (!response.ok) return false;

        // A 200 is not proof of the contract: a captive portal or a proxy error page
        // answers HTML with a success status. `HealthResponse` is
        // `{ ok: true, sessions: n, epoch: s }`, so require the marker.
        const body = (await response.json()) as { ok?: unknown };

        return body.ok === true;
    } catch {
        // Refused, blocked (mixed content / CORS / PNA), timed out, or not JSON.
        return false;
    }
};

// Walk the static-host chain and pin the root to the first gateway that answers.
// Returns the root every later request uses (including the socket URL ./stream.ts
// derives, because both read `API_ROOT`). When the root is pinned this performs NO
// request: a deliberate root is never replaced by a guess.
export const ensureApiRoot = async (): Promise<string> => {
    if (staticCandidates === undefined) return API_ROOT;

    for (const candidate of staticCandidates) {
        if (await probeRoot(candidate)) {
            API_ROOT = candidate;

            return candidate;
        }
    }

    // Nothing answered. Stay on the FIRST candidate (this machine's gateway): it is
    // the host the offline pane should name, because starting a server locally is
    // the action that fixes it. Retry is a full reload, which re-probes.
    API_ROOT = staticCandidates[0];

    return API_ROOT;
};

// ---------------------------------------------------------------------------
// Root, health, configuration
// ---------------------------------------------------------------------------

// `GET /v1/harness` — the boot document: identity, capabilities, limits, links.
// Constant size, no catalogues, no sessions (spec: "Nothing else.").
export const getServiceInfo = (): Promise<ServiceInfo> =>
    request<ServiceInfo>(HARNESS_ROUTES.root());

// `GET /v1/harness/health` — liveness plus the epoch. Also the static-host probe.
export const getHealth = (): Promise<HealthResponse> =>
    request<HealthResponse>(HARNESS_ROUTES.health());

// `GET /v1/harness/config` — global defaults (key-free) + read-only runtime facts.
// The session's own merged settings are per-session state, reported on the session.
export const getGlobalConfig = (): Promise<GlobalConfigDocument> =>
    request<GlobalConfigDocument>(HARNESS_ROUTES.config());

// `PATCH /v1/harness/config` — patch the provider defaults. `api_key` is
// write-only: it travels in this body and never appears in any response.
export const updateGlobalConfig = (settings: GlobalConfigUpdateRequest['settings']): Promise<GlobalConfigDocument> =>
    request<GlobalConfigDocument>(HARNESS_ROUTES.config(), { method: 'PATCH', body: JSON.stringify({ settings }) });

// ---------------------------------------------------------------------------
// Harness definitions (cards → identified read → lazy instruction text)
// ---------------------------------------------------------------------------

// `GET /harnesses` — one page of definition CARDS. A card omits the per-agent
// instruction text, the per-agent model map, and the resolved core-tool set.
export const listHarnesses = (query: PageQuery = {}): Promise<Page<HarnessCard>> =>
    request<HarnessCardPage>(`${HARNESS_ROUTES.harnesses()}${pageParams(query)}`).then(pageOf);

// `GET /harnesses/{name}` — one definition in full (core tools, `agent_models`,
// instruction SUMMARY without text). The configuration dialog reads this once, on
// an explicit open, instead of every view frame carrying every member's prompt.
export const getHarness = async (name: string): Promise<HarnessDefinition | undefined> => {
    const body = await request<HarnessDefinitionResponse | undefined>(
        HARNESS_ROUTES.harnessesByHarnessName(encodeURIComponent(name)),
        {},
        [404]
    );

    return body?.harness;
};

export const createHarness = (input: HarnessCreateRequest): Promise<HarnessDefinition> =>
    request<HarnessDefinitionResponse>(HARNESS_ROUTES.harnesses(), {
        method: 'POST',
        body: JSON.stringify(input)
    }).then((body) => body.harness);

export const updateHarness = (name: string, input: UpdateHarnessRequest): Promise<HarnessDefinition> =>
    request<HarnessDefinitionResponse>(HARNESS_ROUTES.harnessesByHarnessName(encodeURIComponent(name)), {
        method: 'PATCH',
        body: JSON.stringify(input)
    }).then((body) => body.harness);

// `DELETE /harnesses/{name}` — removal receipt. A built-in's name is tombstoned so
// a restart does not re-ship it (`tombstoned` / `restored_by_restart` state that).
// An unknown name is a 404, which for a delete IS the desired end state, so it is
// accepted at the transport and reported as `undefined` rather than thrown.
// An ACCEPTED 404 is not a receipt: its body is the contract's `ErrorBody`
// (`{ error: { message } }`), which satisfies NO field of `DeleteHarnessResult`.
// `requestResource` only substitutes `undefined` for an accepted status whose body
// cannot be parsed (./api.ts:461), so the accepted-status body is dropped HERE —
// the same rule `getHarness` follows by unwrapping `.harness`. Discriminated on the
// receipt's required literal, so a real answer always survives.
export const deleteHarness = async (name: string): Promise<DeleteHarnessResult | undefined> => {
    const body = await request<DeleteHarnessResult | undefined>(
        HARNESS_ROUTES.harnessesByHarnessName(encodeURIComponent(name)),
        { method: 'DELETE' },
        [404]
    );

    return body !== undefined && body.deleted === true ? body : undefined;
};

// `GET /harnesses/{name}/instructions` — one row per member with provenance and
// length, NO text, not paged (the member set is bounded by the definition).
export const getHarnessInstructionIndex = (name: string): Promise<HarnessInstructionIndexResponse> =>
    request<HarnessInstructionIndexResponse>(
        HARNESS_ROUTES.harnessesByHarnessNameInstructions(encodeURIComponent(name))
    );

// `GET /harnesses/{name}/instructions/{agent}` — ONE member's effective text.
export const getHarnessInstructionText = (name: string, agent: string): Promise<HarnessInstructionTextResponse> =>
    request<HarnessInstructionTextResponse>(
        HARNESS_ROUTES.harnessesByHarnessNameInstructionsByAgentId(encodeURIComponent(name), encodeURIComponent(agent))
    );

// ---------------------------------------------------------------------------
// Agents (trusted profiles)
// ---------------------------------------------------------------------------

export const listAgents = (query: PageQuery = {}): Promise<Page<AgentSummary>> =>
    request<AgentSummaryPage>(`${HARNESS_ROUTES.agents()}${pageParams(query)}`).then(pageOf);

export const getAgent = (agentId: string): Promise<AgentProfile> =>
    request<AgentProfileResponse>(HARNESS_ROUTES.agentsByAgentId(encodeURIComponent(agentId))).then((body) => body.agent);

export const updateAgent = (agentId: string, input: UpdateAgentRequest): Promise<AgentProfile> =>
    request<AgentProfileResponse>(HARNESS_ROUTES.agentsByAgentId(encodeURIComponent(agentId)), {
        method: 'PATCH',
        body: JSON.stringify(input)
    }).then((body) => body.agent);

export const deleteAgent = (agentId: string): Promise<DeleteAgentResult> =>
    request<DeleteAgentResult>(HARNESS_ROUTES.agentsByAgentId(encodeURIComponent(agentId)), { method: 'DELETE' });

// ---------------------------------------------------------------------------
// Tools (catalogue + playground)
// ---------------------------------------------------------------------------

export const listTools = (query: PageQuery = {}): Promise<Page<ToolSummary>> =>
    request<ToolSummaryPage>(`${HARNESS_ROUTES.tools()}${pageParams(query)}`).then(pageOf);

export const getTool = (name: string): Promise<ToolDetail> =>
    request<ToolDetailResponse>(HARNESS_ROUTES.toolsByToolId(encodeURIComponent(name))).then((body) => body.tool);

// `POST /tools/{id}/executions` — the manual playground call. Both outcomes are a
// 200; the caller branches on `ok`, never on the status code.
export const executeGlobalTool = (name: string, parameters?: unknown): Promise<ToolCallResult> =>
    request<ToolCallResult>(HARNESS_ROUTES.toolsByToolIdExecutions(encodeURIComponent(name)), {
        method: 'POST',
        body: JSON.stringify({ parameters })
    });

// `POST /sessions/{id}/tools/{id}/executions` — the same untyped argument value
// resolved inside a session's registry, so a session-bound core tool
// (toolRequest/toolCreate/task/delegate) changes THAT conversation.
export const executeSessionTool = (
    sessionId: string,
    name: string,
    parameters?: unknown
): Promise<ToolCallResult> =>
    request<ToolCallResult>(
        HARNESS_ROUTES.sessionsBySessionIdToolsByToolIdExecutions(
            encodeURIComponent(sessionId),
            encodeURIComponent(name)
        ),
        { method: 'POST', body: JSON.stringify({ parameters }) }
    );

// Kept for the tool runner (./ui/tools.ts): a session id selects the session
// registry, its absence the deployment catalogue. One name, one call site.
export const callTool = (
    name: string,
    parameters: unknown,
    sessionId?: string
): Promise<ToolCallResult> =>
    sessionId === undefined || sessionId.length === 0
        ? executeGlobalTool(name, parameters)
        : executeSessionTool(sessionId, name, parameters);

// `POST /models` — provider discovery. `api_key` is write-only and travels in
// this body (never a query string), and `signal` abandons a superseded lookup.
export const listProviderModels = async (
    settings: RunnerSettingsInput,
    signal?: AbortSignal
): Promise<string[]> => {
    const body = await request<ModelIndex>(HARNESS_ROUTES.models(), {
        method: 'POST',
        body: JSON.stringify({ settings } satisfies ModelDiscoveryRequest),
        ...(signal === undefined ? {} : { signal })
    });

    return Array.isArray(body.models) ? body.models : [];
};

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

// `GET /sessions` — one page of session ROWS (metadata + counters). A rail of a
// hundred long conversations is therefore a constant-size response.
export const listSessions = (query: PageQuery = {}): Promise<Page<SessionSummary>> =>
    request<SessionSummaryPage>(`${HARNESS_ROUTES.sessions()}${pageParams(query)}`).then(pageOf);

// `GET /sessions/{id}` — the identified read: a row plus the live model map, the
// key-free endpoint view, the tool/action counts, and where turns run. Still no
// turns, threads, transcripts, display trees, or the frozen definition.
export const getSession = (id: string): Promise<SessionResource> =>
    request<SessionResponse>(HARNESS_ROUTES.sessionsBySessionId(encodeURIComponent(id))).then((body) => body.session);

export const createSession = (input: CreateSessionRequest): Promise<SessionResource> =>
    request<SessionResponse>(HARNESS_ROUTES.sessions(), {
        method: 'POST',
        body: JSON.stringify(input)
    }).then((body) => body.session);

// `PATCH /sessions/{id}` — `agent_models` MERGES, `title` replaces (null clears).
// History, definition and endpoint settings are immutable over HTTP.
export const updateSession = (id: string, input: UpdateSessionRequest): Promise<SessionResource> =>
    request<SessionResponse>(HARNESS_ROUTES.sessionsBySessionId(encodeURIComponent(id)), {
        method: 'PATCH',
        body: JSON.stringify(input)
    }).then((body) => body.session);

export const deleteSession = (id: string): Promise<DeleteSessionResult> =>
    request<DeleteSessionResult>(HARNESS_ROUTES.sessionsBySessionId(encodeURIComponent(id)), { method: 'DELETE' });

// Same DELETE with `keepalive` for the unload path: best effort, never depended
// upon (a plain fetch started from `pagehide` may be cancelled before it leaves).
export const deleteSessionOnUnload = (id: string): Promise<DeleteSessionResult> =>
    request<DeleteSessionResult>(HARNESS_ROUTES.sessionsBySessionId(encodeURIComponent(id)), {
        method: 'DELETE',
        keepalive: true
    });

// `POST /sessions/{id}/reset` — a receipt of what was discarded, never the emptied
// aggregate. The caller clears its window from the receipt instead of re-reading.
export const resetSession = (id: string): Promise<ResetSessionResult> =>
    request<ResetSessionResult>(HARNESS_ROUTES.sessionsBySessionIdReset(encodeURIComponent(id)), { method: 'POST' });

// `POST /sessions/{id}/cancel` — `{ all: true }` drains the queue as well; an
// absent body cancels the active run only and leaves queued tasks untouched.
export const cancelSession = (id: string, all = false): Promise<CancelSessionResult> =>
    request<CancelSessionResult>(HARNESS_ROUTES.sessionsBySessionIdCancel(encodeURIComponent(id)), {
        method: 'POST',
        ...(all ? { body: JSON.stringify({ all: true } satisfies CancelSessionRequest) } : {})
    });

// `GET /sessions/{id}/definition` — the frozen definition this session captured,
// read only when the configuration panel is opened.
export const getSessionDefinition = (id: string): Promise<SessionDefinitionResponse['definition']> =>
    request<SessionDefinitionResponse>(HARNESS_ROUTES.sessionsBySessionIdDefinition(encodeURIComponent(id))).then(
        (body) => body.definition
    );

// `GET /sessions/{id}/usage` — the server-computed fold, honest about unknowns.
// Lazy: opened from the details dialog, never on the transcript path.
export const getSessionUsage = (id: string): Promise<SessionUsageResponse> =>
    request<SessionUsageResponse>(HARNESS_ROUTES.sessionsBySessionIdUsage(encodeURIComponent(id)));

// `GET /sessions/{id}/commands` — the slash-command registry for the composer.
// Lazy: fetched when the composer sees its first `/`, not at session open.
export const listSessionCommands = (id: string, query: PageQuery = {}): Promise<Page<CommandPage['items'][number]>> =>
    request<CommandPage>(`${HARNESS_ROUTES.sessionsBySessionIdCommands(encodeURIComponent(id))}${pageParams(query)}`).then(pageOf);

// `GET /sessions/{id}/queue` — waiting tasks with a bounded PROMPT PREVIEW plus the
// exact recorded length, so a queue panel never becomes a multi-megabyte read.
export const listQueue = (id: string, query: PageQuery = {}): Promise<Page<QueuedTask>> =>
    request<QueuedTaskPage>(`${HARNESS_ROUTES.sessionsBySessionIdQueue(encodeURIComponent(id))}${pageParams(query)}`).then(pageOf);

// `GET /sessions/{id}/actions` — the owner questions still waiting (live only, at
// most the contract's `pending_actions` bound), with routing fields so a
// reconnected client answers the right conversation.
export const listPendingActions = (id: string): Promise<PendingActionListResponse> =>
    request<PendingActionListResponse>(HARNESS_ROUTES.sessionsBySessionIdActions(encodeURIComponent(id)));

// `POST /sessions/{id}/actions/{requestId}/answer` — one option id or free text.
// This resolves a question the running turn is paused on; it enqueues nothing.
export const answerAction = async (
    sessionId: string,
    requestId: string,
    choice: ActionChoiceInput
): Promise<boolean> => {
    const body = await request<{ ok: boolean }>(
        HARNESS_ROUTES.sessionsBySessionIdActionsByRequestIdAnswer(
            encodeURIComponent(sessionId),
            encodeURIComponent(requestId)
        ),
        { method: 'POST', body: JSON.stringify({ choice }) }
    );

    if (body.ok !== true) throw new Error('The harness server did not accept the answer.');

    return true;
};

// ---------------------------------------------------------------------------
// Session agents and toolbox
// ---------------------------------------------------------------------------

// `GET /sessions/{id}/agents` — the live roster. Not paged by contract: membership
// comes from the frozen definition plus the roster budget, so it is already bounded.
export const listSessionAgents = (id: string): Promise<SessionAgentListResponse> =>
    request<SessionAgentListResponse>(HARNESS_ROUTES.sessionsBySessionIdAgents(encodeURIComponent(id)));

export const createSessionAgent = (id: string, input: CreateSessionAgentRequest): Promise<SessionAgentBinding> =>
    request<SessionAgentResponse>(HARNESS_ROUTES.sessionsBySessionIdAgents(encodeURIComponent(id)), {
        method: 'POST',
        body: JSON.stringify(input)
    }).then((body) => body.agent);

export const updateSessionAgent = (
    id: string,
    agentId: string,
    input: UpdateSessionAgentRequest
): Promise<SessionAgentBinding> =>
    request<SessionAgentResponse>(
        HARNESS_ROUTES.sessionsBySessionIdAgentsByAgentId(encodeURIComponent(id), encodeURIComponent(agentId)),
        { method: 'PATCH', body: JSON.stringify(input) }
    ).then((body) => body.agent);

export const deleteSessionAgent = (id: string, agentId: string): Promise<DeleteSessionAgentResult> =>
    request<DeleteSessionAgentResult>(
        HARNESS_ROUTES.sessionsBySessionIdAgentsByAgentId(encodeURIComponent(id), encodeURIComponent(agentId)),
        { method: 'DELETE' }
    );

// `GET .../agents/{id}/instruction` — the effective text ONE member runs with,
// plus provenance. The roster row carries only `instruction_chars`/`source`.
export const getSessionAgentInstruction = (id: string, agentId: string): Promise<SessionInstructionTextResponse> =>
    request<SessionInstructionTextResponse>(
        HARNESS_ROUTES.sessionsBySessionIdAgentsByAgentIdInstruction(
            encodeURIComponent(id),
            encodeURIComponent(agentId)
        )
    );

// `GET /sessions/{id}/tools` — toolbox rows (catalogue projection + session facts),
// argument schema, source text and results deliberately absent from every row.
export const listSessionTools = (id: string, query: PageQuery = {}): Promise<Page<SessionToolPage['items'][number]> & { budget: SessionToolPage['budget'] }> =>
    request<SessionToolPage>(`${HARNESS_ROUTES.sessionsBySessionIdTools(encodeURIComponent(id))}${pageParams(query)}`).then(
        (body) => ({ ...pageOf(body), budget: body.budget })
    );

export const getSessionTool = (id: string, name: string): Promise<SessionToolDetail> =>
    request<SessionToolResponse>(
        HARNESS_ROUTES.sessionsBySessionIdToolsByToolId(encodeURIComponent(id), encodeURIComponent(name))
    ).then((body) => body.tool);

export const createSessionTool = (
    id: string,
    input: CreateSessionToolRequest
): Promise<SessionToolRegistrationResponse['registration']> =>
    request<SessionToolRegistrationResponse>(HARNESS_ROUTES.sessionsBySessionIdTools(encodeURIComponent(id)), {
        method: 'POST',
        body: JSON.stringify(input)
    }).then((body) => body.registration);

export const updateSessionTool = (
    id: string,
    name: string,
    input: UpdateSessionToolRequest
): Promise<SessionToolRegistrationResponse['registration']> =>
    request<SessionToolRegistrationResponse>(
        HARNESS_ROUTES.sessionsBySessionIdToolsByToolId(encodeURIComponent(id), encodeURIComponent(name)),
        { method: 'PATCH', body: JSON.stringify(input) }
    ).then((body) => body.registration);

export const deleteSessionTool = (id: string, name: string): Promise<DeleteSessionToolResult> =>
    request<DeleteSessionToolResult>(
        HARNESS_ROUTES.sessionsBySessionIdToolsByToolId(encodeURIComponent(id), encodeURIComponent(name)),
        { method: 'DELETE' }
    );

// `GET .../tools/{id}/source` — the installed source revision, read only when the
// editor opens the file.
export const getSessionToolSource = (id: string, name: string): Promise<SessionToolSourceResponse> =>
    request<SessionToolSourceResponse>(
        HARNESS_ROUTES.sessionsBySessionIdToolsByToolIdSource(
            encodeURIComponent(id),
            encodeURIComponent(name)
        )
    );

// ---------------------------------------------------------------------------
// Turns (rows → display → events → step/block/attachment detail)
// ---------------------------------------------------------------------------

// `GET /sessions/{id}/turns` — the compact ROWS. `order: 'desc'` answers newest
// first for a tail-following client, which is what a session open asks for; the
// cursor then walks OLDER rows, which is what "load older" is.
export const listTurns = (id: string, query: PageQuery = {}): Promise<Page<TurnSummary>> =>
    request<PageMeta & { items: TurnSummary[] }>(
        `${HARNESS_ROUTES.sessionsBySessionIdTurns(encodeURIComponent(id))}${pageParams(query)}`
    ).then(pageOf);

// `GET /sessions/{id}/turns/{turnId}` — the durable record as metadata + COUNTS,
// including the VERBATIM prompt (rows carry a preview). One identified read.
export const getTurn = (id: string, turnId: string): Promise<TurnSummary & { prompt?: string }> =>
    request<{ turn: TurnSummary & { prompt?: string } }>(
        HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnId(encodeURIComponent(id), encodeURIComponent(turnId))
    ).then((body) => body.turn);

// `GET .../turns/{turnId}/display` — ONE turn's compiled display tree. The rule
// this route exists for: a page of rows never carries trees, and a tree is fetched
// only for a turn the reader is actually looking at.
export const getTurnDisplay = (id: string, turnId: string): Promise<TurnDisplay> =>
    request<{ display: TurnDisplay }>(
        HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnIdDisplay(encodeURIComponent(id), encodeURIComponent(turnId))
    ).then((body) => body.display);

// `GET .../turns/{turnId}/events` — verbatim recorded events, paired with their
// recorded times, paged. Opt-in (raw transcript/export surfaces only).
export const listTurnEvents = (
    id: string,
    turnId: string,
    query: PageQuery = {}
): Promise<Page<{ index: number; at?: number; event: HarnessEvent }> & { totalEvents: number; partial: boolean }> =>
    request<PageMeta & { turn_id: string; total_events: number; partial: boolean; items: { index: number; at?: number; event: HarnessEvent }[] }>(
        `${HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnIdEvents(encodeURIComponent(id), encodeURIComponent(turnId))}${pageParams(query)}`
    ).then((body) => ({ ...pageOf(body), totalEvents: body.total_events, partial: body.partial }));

// `GET .../turns/{t}/steps/{s}` — the recorded OPENING event and recorded RESULT of
// one step, verbatim, as one pair. Reached by one click and nothing else.
export const getStepDetail = (id: string, turnId: string, stepId: string): Promise<TurnStepDetail> =>
    request<{ detail: TurnStepDetail }>(
        HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnIdStepsByStepId(
            encodeURIComponent(id),
            encodeURIComponent(turnId),
            encodeURIComponent(stepId)
        )
    ).then((body) => body.detail);

// `GET .../turns/{t}/blocks/{b}` — one context segment answered with its recorded
// bytes. This is the only way a segment's text reaches the browser.
export const getBlockDetail = (id: string, turnId: string, blockId: string): Promise<TurnBlockDetail> =>
    request<{ block: TurnBlockDetail }>(
        HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnIdBlocksByBlockId(
            encodeURIComponent(id),
            encodeURIComponent(turnId),
            encodeURIComponent(blockId)
        )
    ).then((body) => body.block);

// `GET .../turns/{t}/attachments/{a}` — ONE attachment's bytes, on demand. Rows and
// trees carry descriptors (identity, marker, size, `has_bytes`) only.
export const getAttachment = (id: string, turnId: string, attachmentId: string): Promise<AttachmentResponse['attachment']> =>
    request<AttachmentResponse>(
        HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnIdAttachmentsByAttachmentId(
            encodeURIComponent(id),
            encodeURIComponent(turnId),
            encodeURIComponent(attachmentId)
        )
    ).then((body) => body.attachment);

// ---------------------------------------------------------------------------
// Threads + transcripts
// ---------------------------------------------------------------------------

// `GET /sessions/{id}/threads` — the roster as SIGNALS. The committed transcript
// (each entry bounded at 65,536 bytes) is deliberately absent, which is what makes
// a 256-conversation roster a bounded read.
export const listThreads = (id: string, query: PageQuery = {}): Promise<Page<ThreadSummary>> =>
    request<ThreadSummaryPage>(`${HARNESS_ROUTES.sessionsBySessionIdThreads(encodeURIComponent(id))}${pageParams(query)}`).then(pageOf);

export const getThread = (id: string, threadId: string): Promise<ThreadResource> =>
    request<ThreadResponse>(
        HARNESS_ROUTES.sessionsBySessionIdThreadsByThreadId(encodeURIComponent(id), encodeURIComponent(threadId))
    ).then((body) => body.thread);

export const createSessionThread = (id: string, input: CreateSessionThreadRequest): Promise<ThreadResource> =>
    request<ThreadResponse>(HARNESS_ROUTES.sessionsBySessionIdThreads(encodeURIComponent(id)), {
        method: 'POST',
        body: JSON.stringify(input)
    }).then((body) => body.thread);

// `POST .../threads/{id}/cancel` and `DELETE .../threads/{id}` answer receipts that
// name what moved (`revision`), not a post-mutation document: the stream is the
// document's update plane, so a stop no longer costs a full view round trip.
export const cancelSessionThread = (id: string, threadId: string): Promise<{ cancelled: boolean; thread_id: string; session_id: string; status: 'stopped'; dropped_queued_tasks: number; revision: number }> =>
    request(
        HARNESS_ROUTES.sessionsBySessionIdThreadsByThreadIdCancel(
            encodeURIComponent(id),
            encodeURIComponent(threadId)
        ),
        { method: 'POST' }
    );

export const deleteSessionThread = (id: string, threadId: string): Promise<DeleteThreadResult> =>
    request<DeleteThreadResult>(
        HARNESS_ROUTES.sessionsBySessionIdThreadsByThreadId(encodeURIComponent(id), encodeURIComponent(threadId)),
        { method: 'DELETE' }
    );

// `GET .../threads/{id}/transcript` — the cheap head: size, counts, revision,
// validity, role counts. Lets a client decide whether a paged read or a document
// read is the cheaper next step.
export const getTranscriptMetadata = (id: string, threadId: string): Promise<TranscriptMetadata> =>
    request<TranscriptMetadataResponse>(
        HARNESS_ROUTES.sessionsBySessionIdThreadsByThreadIdTranscript(
            encodeURIComponent(id),
            encodeURIComponent(threadId)
        )
    ).then((body) => body.transcript);

// `GET .../threads/{id}/transcript/messages` — paged entries, optional `role`
// filter. A tool entry's content is bounded at 65,536 bytes, which is exactly why
// this route is paged rather than embedded in a session read.
export const listTranscriptMessages = (
    id: string,
    threadId: string,
    query: PageQuery = {}
): Promise<Page<TranscriptMessagePage['items'][number]> & { total: number; agent: string; state: TranscriptMessagePage['transcript_state'] }> =>
    request<TranscriptMessagePage>(
        `${HARNESS_ROUTES.sessionsBySessionIdThreadsByThreadIdTranscriptMessages(
            encodeURIComponent(id),
            encodeURIComponent(threadId)
        )}${pageParams(query)}`
    ).then((body) => ({
        ...pageOf(body),
        total: body.total,
        agent: body.agent,
        state: body.transcript_state
    }));

// `GET .../threads/{id}/transcript/document` — the whole transcript as one JSON
// TEXT document: the editor's and the export surface, and the counterpart of the
// whole-document PUT. Separate from the paged read on purpose, so "display" and
// "edit" stay differently sized operations.
export const getTranscriptDocument = (id: string, threadId: string): Promise<TranscriptDocumentResponse> =>
    request<TranscriptDocumentResponse>(
        HARNESS_ROUTES.sessionsBySessionIdThreadsByThreadIdTranscriptDocument(
            encodeURIComponent(id),
            encodeURIComponent(threadId)
        )
    );

// `PUT .../threads/{id}/transcript` — replace the whole document. `if_revision` is
// the optimistic-concurrency guard: a stale draft is refused rather than silently
// overwriting the other writer. `messages` is deliberately `unknown`: a
// structurally broken value is a SUCCESSFUL write reported in the receipt.
export const putTranscriptDocument = (
    id: string,
    threadId: string,
    messages: unknown,
    ifRevision?: number
): Promise<TranscriptWriteReceipt> => {
    const body: UpdateThreadTranscriptRequest = {
        messages,
        ...(ifRevision === undefined ? {} : { if_revision: ifRevision })
    };

    return request<TranscriptWriteReceipt>(
        HARNESS_ROUTES.sessionsBySessionIdThreadsByThreadIdTranscript(
            encodeURIComponent(id),
            encodeURIComponent(threadId)
        ),
        { method: 'PUT', body: JSON.stringify(body) }
    );
};

// ---------------------------------------------------------------------------
// Submit (the only write on the transcript path)
// ---------------------------------------------------------------------------

// `POST /sessions/{id}/tasks` (202) — the durable submit. The answer is a
// RECEIPT: what was accepted, where it was put, and which resources moved. It
// never echoes the session or a turn record, because the receipt plus the
// stream's `turn.upsert` frame plus a bounded `/turns` page carry the same
// information at a fraction of the size. `thread_id` absent opens a new
// standalone conversation; a running target folds the input in as a STEER.
export type SubmitTaskInput = {
    input: string;
    attachments?: SubmitTaskRequest['attachments'];
    references?: SubmitTaskRequest['references'];
    threadId?: string;
};

export const submitTask = (id: string, submit: SubmitTaskInput): Promise<TaskReceipt> => {
    const body: SubmitTaskRequest = {
        input: submit.input,
        ...(submit.threadId === undefined || submit.threadId.length === 0
            ? {}
            : { thread_id: submit.threadId }),
        ...(submit.attachments === undefined || submit.attachments.length === 0
            ? {}
            : { attachments: submit.attachments }),
        ...(submit.references === undefined || submit.references.length === 0
            ? {}
            : { references: submit.references })
    };

    return request<TaskReceipt>(HARNESS_ROUTES.sessionsBySessionIdTasks(encodeURIComponent(id)), {
        method: 'POST',
        body: JSON.stringify(body)
    });
};

// ---------------------------------------------------------------------------
// Contract rows -> the descriptor shapes the panes render
// ---------------------------------------------------------------------------

// A definition card/definition as the rail and the configuration dialog render it.
// The contract spells these rows snake_case and splits "card" from "identified
// read"; the panes want ONE shape with camelCase conveniences, and they must not
// crash on the fields the card omits (`agent_models`, `agent_instructions` and the
// resolved core-tool set exist only on the identified read). Absent stays absent —
// `contract.ts` already reads each of these defensively.
export type HarnessCardView = {
    name: string;
    title: string;
    description: string;
    requiresEndpoint: boolean;
    primary: string;
    subagents: string[];
    agents: string[];
    tools: string[];
    builtin: boolean;
    definitionRevision: number;
    agentModels?: Record<string, string>;
    agentInstructions?: Record<string, string>;
    coreTools?: string[];
    instructionSummary?: HarnessInstructionSummaryEntry[];
};

export const descriptorOf = (card: HarnessCard | HarnessDefinition): HarnessCardView => ({
    name: card.name,
    title: card.title,
    description: card.description,
    requiresEndpoint: card.requires_endpoint,
    primary: card.primary,
    subagents: [...card.subagents],
    agents: [...card.agents],
    tools: [...card.tools],
    builtin: card.builtin,
    definitionRevision: card.definition_revision,
    ...('agent_models' in card && card.agent_models !== undefined ? { agentModels: { ...card.agent_models } } : {}),
    ...('agent_instructions' in card && card.agent_instructions !== undefined
        ? { agentInstructions: { ...card.agent_instructions } }
        : {}),
    ...('core_tools' in card && card.core_tools !== undefined ? { coreTools: [...card.core_tools] } : {}),
    ...('instruction_summary' in card && card.instruction_summary !== undefined
        ? { instructionSummary: card.instruction_summary }
        : {})
});

// A catalogue row as the tools view renders it. `session_bound` is the contract's
// spelling of "this entry only runs inside a conversation".
export type ToolRowView = {
    name: string;
    group: string;
    description: string;
    tags: string[];
    visibility: 'core' | 'searchable';
    sessionBound: boolean;
    availability?: ToolSummary['availability'];
};

export const toolRowOf = (tool: ToolSummary | ToolDetail): ToolRowView => ({
    name: tool.name,
    group: tool.group,
    description: tool.description,
    tags: [...tool.tags],
    visibility: tool.visibility,
    sessionBound: tool.session_bound,
    ...(tool.availability === undefined ? {} : { availability: tool.availability })
});

// A trusted-profile row as the picker renders it. A row carries no instruction TEXT
// (that is the identified read), so the picker's "preview" stays empty rather than
// claiming a prompt this read never published.
export type AgentRowView = {
    name: string;
    title: string;
    description: string;
    instruction: string;
    guidelines: string[];
    hasInstructionOverride: boolean;
    hasGlobalOverride: boolean;
};

export const agentRowOf = (agent: AgentSummary | AgentProfile): AgentRowView => ({
    name: agent.name,
    title: agent.title,
    description: agent.description,
    ...('instruction' in agent && typeof agent.instruction === 'string'
        ? { instruction: agent.instruction }
        : { instruction: '' }),
    ...('guidelines' in agent && Array.isArray(agent.guidelines) ? { guidelines: [...agent.guidelines] } : { guidelines: [] }),
    ...('has_instruction_override' in agent
        ? { hasInstructionOverride: agent.has_instruction_override === true }
        : { hasInstructionOverride: (agent as AgentProfile).instruction_source === 'global' }),
    ...('has_global_override' in agent
        ? { hasGlobalOverride: agent.has_global_override === true }
        : { hasGlobalOverride: (agent as AgentProfile).instruction_source === 'global' })
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

// The shell's first paint, in ONE round of concurrent bounded reads:
//
//   GET /                      -> ServiceInfo        (constant size: identity, capabilities, limits)
//   GET /config                -> GlobalConfigDocument (key-free defaults + runtime facts)
//   GET /harnesses?limit=25    -> first page of CARDS
//   GET /tools?limit=25        -> first page of rows
//   GET /agents?limit=25       -> first page of summaries (no instruction text)
//   GET /sessions?limit=25     -> first page of ROWS (metadata + counters only)
//
// Nothing here reads a turn, a thread, a transcript, or a display tree, and no
// read is unbounded: a deployment with 100 sessions and 40k recorded events boots
// with the same bytes as one with a single empty session. Catalogue pages beyond
// the first are pulled by the panes that list them (the harness rail's search, the
// tools view, the agent picker), which is where a larger page is actually justified.
//
// The static-host chain is walked first (see `ensureApiRoot`), so on a Pages
// deployment every one of these requests already points at the live gateway.
export const loadBootstrap = async (): Promise<HarnessBootstrap> => {
    await ensureApiRoot();

    const [info, config, harnesses, tools, agents, sessions] = await Promise.all([
        getServiceInfo(),
        getGlobalConfig(),
        listHarnesses(),
        listTools(),
        listAgents(),
        listSessions()
    ]);

    return {
        rootPath: info.api_root,
        info,
        presets: harnesses.items.map(descriptorOf),
        tools: tools.items.map(toolRowOf),
        agents: agents.items.map(agentRowOf),
        defaults: config.defaults,
        sessions: sessions.items,
        cursors: {
            harnesses: harnesses.nextCursor,
            tools: tools.nextCursor,
            agents: agents.nextCursor,
            sessions: sessions.nextCursor
        }
    };
};

// Re-exported so the display facade (./view-api.ts) and the shell import the
// paging bounds from one place instead of restating them.
export { HARNESS_PAGE_LIMIT };

// The per-turn usage figure the details panel reads (a row on the turn, not on the
// session root any more), re-exported for the facade's mapping.
export type { HarnessUsage, SessionSummary, SessionResource, ThreadSummary, TurnSummary };

// The browser client for the harness server.
//
// The UI has no harness code of its own. It loads the server catalogue and
// session list, creates a session, submits tasks, and renders the SSE stream the
// server sends back. The same client works against both supported mounts:
//
//   - `/v1/harness` — canonical @underload/service root, which serves the
//     bootstrap document at GET root;
//   - `/api`        — standalone node server, whose root is a 404 and whose
//     per-resource routes (`/harnesses`, `/tools`, `/sessions`) are the source.
//
// The root is chosen at runtime, in this order (see `resolveRoot`):
//   1. `?apiRoot=` on the page URL (validated; a bad value falls back silently);
//   2. server-injected config (`window.__HARNESS_CONFIG__.apiRoot` or a
//      `<meta name="harness-api-root">` element), for a host that serves this
//      bundle and knows where its API lives;
//   3. build-time `VITE_HARNESS_API`;
//   4. on a GitHub Pages host (a static host with no API of its own): the
//      local/LAN gateway chain in ./deployment.ts, probed in order by
//      `ensureApiRoot` — localhost first, then the standard LAN host;
//   5. `/api`.
//
// The root is only ever a base URL/prefix. No credential, query string or hash
// is accepted on it, so a secret can never be pushed into a URL by this module.
//
// TRUST: sources 1 and 2 are RUNTIME and therefore untrusted. The UI posts the
// provider key saved in this browser to whatever root it resolves, so an absolute
// root from a query string or injected config must be same-origin with the page,
// a loopback host, or one of the compiled chain entries (src/shared/origin.ts,
// shared with the service's Origin gate). The chain is baked into this bundle by
// the build, so naming one exactly is no wider a trust than dialing it by default.
// Otherwise a crafted link such as `?apiRoot=https://evil.example/api` would
// receive the saved credential on the next model lookup or session creation.
// Source 3 is compiled into the bundle by the operator and is deliberately
// trusted: a cross-origin `VITE_HARNESS_API` is a supported deployment, and it
// cannot be changed by a URL the user is tricked into opening.

import { isTrustedRuntimeOrigin } from '../shared/origin';
import { STATIC_API_CANDIDATES, isStaticPagesHost } from './deployment';
import type { HarnessActionChoice, HarnessAttachment } from '../types';
import type { HarnessTurnReference } from './ui/references';
import type {
    AgentDescriptor,
    CancelThreadResult,
    CreateHarnessRequest,
    DeleteThreadResult,
    HarnessDescriptor,
    HarnessIndex,
    ModelIndex,
    RunnerSettings,
    SessionSnapshot,
    SessionStreamItem,
    SessionTurn,
    SubmitTaskResult,
    ToolCallResult,
    ToolDescriptor,
    ToolIndex,
    UpdateHarnessRequest,
    // Needed locally for updateSession() and re-exported below.
    UpdateSessionRequest
} from '../server/protocol';

// Payload of GET `/v1/harness`. `src/server/api.ts` owns this shape (HarnessBootstrap)
// but protocol.ts is not ours to extend, so the browser mirrors the fields it
// consumes. Keep in sync with src/server/api.ts `HarnessBootstrap`.
//
// `agents` is part of the agreed contract (the bootstrap document now carries the
// same agent presets as GET /agents). It stays optional so an older server still
// boots; main.ts then derives a minimal library from the descriptors.
export type HarnessBootstrap = {
    rootPath: string;
    presets: HarnessDescriptor[];
    tools: ToolDescriptor[];
    defaults: HarnessIndex['defaults'];
    sessions: SessionSnapshot[];
    agents?: AgentDescriptor[];
};

const FALLBACK_ROOT = '/api';

// A root is a path prefix (`/v1/harness`) or an absolute http(s) URL origin+path.
// Anything else (a scheme like `javascript:`, a protocol-relative `//host`, a
// query, a hash, or embedded userinfo) is rejected: this value ends up in every
// request URL, so it must not be able to carry credentials or change meaning
// when concatenated.
//
// This function is SYNTAX only. Whether an absolute origin may be used depends
// on the source: `resolveApiRoot` applies the same-origin/loopback rule to
// runtime sources, and trusts the build-time value (see the header).
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
    // fetch("/\\evil.example/x") resolves to a DIFFERENT origin, even though the
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
// query parameter is not consulted per request (a change means a reload, which
// also resets the transient view — the server snapshot is re-fetched on boot).
//
// The one exception is the STATIC-HOST chain (./deployment.ts): on a GitHub Pages
// host the documented sources name nothing, and the answer is not knowable
// synchronously — it is whichever local/LAN gateway actually answers. `resolveRoot`
// therefore returns the chain to probe, `ensureApiRoot` walks it, and `API_ROOT`
// moves to the winner before the first catalogue request.
type ResolvedRoot = {
    root: string;
    // The ordered roots to probe, or `undefined` when the root is explicit (a
    // query/injected/build-time value) or same-origin. Those are pinned by the
    // operator or the URL, so probing somewhere else would silently replace a
    // deliberate choice with a guess.
    candidates: readonly string[] | undefined;
};

const resolveRoot = (): ResolvedRoot => {
    const query = new URLSearchParams(globalThis.location?.search ?? '').get('apiRoot') ?? undefined;

    // An absolute (origin+path) root is the only kind that can point somewhere
    // else; a rooted path stays on the page's origin by construction. The test
    // is intentionally anchored on the normalized value, whose only absolute
    // form is http(s) — normalizeApiRoot rejects every other scheme.
    const isAbsolute = (root: string): boolean => /^https?:\/\//i.test(root);

    // An invalid *query* value is ignored rather than fatal: a hand-edited URL
    // must not stop the UI from booting against its documented default. An
    // invalid injected root is also ignored for the same reason.
    //
    // An ABSENT/blank value must return undefined, not the fallback: otherwise
    // the first `attempt` (the query) would always answer "/api" and the later
    // sources — injected config, VITE_HARNESS_API — would never be consulted.
    //
    // `trusted` is false for both runtime sources: they may only name the page's
    // own origin or a loopback host, because the saved provider key travels to
    // this root. The build-time value is operator-controlled and may be
    // cross-origin, so it skips the origin check (still syntactically validated).
    const attempt = (value: string | undefined, trusted: boolean): string | undefined => {
        if (value === undefined || value.trim().length === 0) return undefined;

        try {
            const root = normalizeApiRoot(value, FALLBACK_ROOT);

            // A root that names one of the compiled static candidates exactly is
            // operator data too — it is baked into this bundle by the build, so a
            // link cannot point the saved key at a host the deployment does not
            // already dial. Without this, the LAN entry (neither same-origin nor
            // loopback) could never be selected by hand.
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

    // Nothing was pinned. A Pages host has no API of its own, so `/api` is a
    // guaranteed 404 there; the local/LAN chain is the honest default, and the
    // first entry doubles as the root the connecting pane names while the probe
    // runs. Every other host (the harness server itself, the Vite dev/preview
    // proxy, the service gateway) serves the API on its own origin, so the
    // documented relative fallback stays correct there.
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
// value, and an ESM live binding means importers (and the test namespace) observe
// the move too. The name stays exported because it is the published "which root am
// I talking to" surface — the connecting pane prints it.
export let API_ROOT = initialRoot.root;

const staticCandidates = initialRoot.candidates;

// The chain this page probes, in order, or `[]` when its root is pinned and
// nothing is probed. The startup/offline panes render it so a failure names every
// host that was tried, not just the one the last request went to.
export const apiRootCandidates = (): readonly string[] => staticCandidates ?? [];

const url = (path: string): string => `${API_ROOT}${path}`;

// One bounded `GET <root>/health` per candidate. A dead loopback port refuses
// instantly, but a dead LAN address can hang on an unanswered SYN, so the probe is
// capped — otherwise a Pages page waits for a TCP timeout before reaching the next
// candidate. `AbortSignal.timeout` is used when the engine has it; without it the
// probe is still correct, just uncapped.
const PROBE_TIMEOUT_MS = 2500;
const HEALTH_PATH = '/health';

const probeRoot = async (root: string): Promise<boolean> => {
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(PROBE_TIMEOUT_MS) : undefined;

    try {
        const response = await fetch(`${root}${HEALTH_PATH}`, {
            headers: { 'Content-Type': 'application/json', 'X-Harness-Client': 'ui' },
            ...(signal === undefined ? {} : { signal })
        });

        if (!response.ok) return false;

        // A 200 is not proof of the contract: a captive portal or a proxy error
        // page answers HTML with a success status. The health body is
        // `{ ok: true, sessions: n }` (../server/api.ts), so require the marker.
        const body = (await response.json()) as { ok?: unknown };

        return body.ok === true;
    } catch {
        // Refused, blocked (mixed content / CORS / PNA), timed out, or not JSON.
        return false;
    }
};

// Walk the static-host chain and pin the root to the first gateway that answers.
// Returns the root every later request uses.
//
// Called by `loadBootstrap` — the first thing the shell does — so every consumer of
// this client gets the failover without knowing about it, and the SSE/session
// requests that follow are already pointed at the live host. When the root is
// pinned (a query, injected config, `VITE_HARNESS_API`, or any non-Pages host)
// this is a no-op that performs NO request: a deliberate root is never replaced by
// a guess, and a same-origin deployment pays nothing for this fix.
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
    // the action that fixes it. The pane lists the whole chain, and Retry is a full
    // reload, which re-probes.
    API_ROOT = staticCandidates[0];

    return API_ROOT;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const readError = async (response: Response): Promise<string> => {
    try {
        const body = (await response.json()) as { error?: { message?: string } };
        if (typeof body.error?.message === 'string') return body.error.message;
    } catch {
        // Not JSON, or the body was already consumed.
    }

    return `HTTP ${response.status} ${response.statusText}`.trim();
};

// `accept` lists extra statuses that are NOT failures: their body is parsed like a
// success. The only caller that needs this is `deleteHarness`, where a 404 ("the
// harness is already gone") is the caller's desired end state rather than an error.
// Everything else keeps flattening a non-2xx answer into one Error with the server's
// own message (`readError`), so a real failure stays actionable.
const request = async <T>(
    path: string,
    init?: RequestInit,
    accept?: readonly number[]
): Promise<T> => {
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

    // An accepted status falls through to the parse below; `deleteHarness` reads the
    // "already gone" answer out of the body instead of catching an Error.
    if (!response.ok && !(accept !== undefined && accept.includes(response.status))) {
        throw new Error(await readError(response));
    }

    // A successful status is not proof of the wire contract: a Vite/nginx proxy
    // with no upstream commonly answers 200 with an HTML error page or plain text.
    // `response.json()` would then throw a raw SyntaxError ("Unexpected token '<'")
    // that names neither the route nor the server, so the UI's offline pane would
    // show a parser message. Keep the failure inside this abstraction and make it
    // actionable: the caller renders this text verbatim.
    try {
        return (await response.json()) as T;
    } catch {
        // An ACCEPTED status (a 404 whose body is a proxy's HTML page) is not a
        // parse failure worth reporting: the caller already knows the answer.
        if (accept !== undefined && accept.includes(response.status)) return undefined as unknown as T;

        throw new Error(
            `The harness server returned a non-JSON response for ${path.length > 0 ? path : '/'} (HTTP ${response.status}).`
        );
    }
};

export const listHarnesses = (): Promise<HarnessIndex> => request<HarnessIndex>('/harnesses');

export const listTools = (): Promise<ToolIndex> => request<ToolIndex>('/tools');

// GET /agents — the trusted preset library the picker offers. Harnesses are built
// by choosing one of these agents, never by typing a new instruction here. The
// index document also carries the same list, so this route is the standalone/
// refresh path rather than the only source.
export const listAgents = async (): Promise<AgentDescriptor[]> => {
    const body = await request<{ agents: AgentDescriptor[] }>('/agents');
    return Array.isArray(body.agents) ? body.agents : [];
};

// POST /harnesses — create a user harness. The server answers 201 with the
// descriptor it actually stored, which is what the UI renders (never a local
// guess: names can be normalised server-side).
export const createHarness = async (input: CreateHarnessRequest): Promise<HarnessDescriptor> => {
    const body = await request<{ harness: HarnessDescriptor }>('/harnesses', {
        method: 'POST',
        body: JSON.stringify(input)
    });

    return body.harness;
};

// PATCH /harnesses/:name — change the agent team of a harness. The response is
// the authoritative descriptor; callers replace their cached copy with it.
export const updateHarness = async (
    name: string,
    input: UpdateHarnessRequest
): Promise<HarnessDescriptor> => {
    const body = await request<{ harness: HarnessDescriptor }>(`/harnesses/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        body: JSON.stringify(input)
    });

    return body.harness;
};

// DELETE /harnesses/:name (R6) — permanently remove ONE harness definition.
//
// The server (src/server/api.ts -> harness registry) removes the entry durably,
// built-ins included, and answers `{ deleted: true }`. It NEVER touches sessions:
// conversations already started in this harness keep their frozen definition and stay
// in the roster, so the caller must not drop them when the row disappears.
//
// An unknown harness is a 404. For a delete that IS the desired end state (the row is
// gone either way), so the 404 is accepted at the transport and reported as
// `deleted: false` instead of throwing; every other failure keeps the server's own
// message. The name is URL-encoded because harness names are user data.
export const deleteHarness = async (name: string): Promise<boolean> => {
    const body = await request<{ deleted?: boolean } | undefined>(
        `/harnesses/${encodeURIComponent(name)}`,
        { method: 'DELETE' },
        [404]
    );

    return body?.deleted === true;
};
// bootstrap document; the standalone `/api` root is a deliberate 404. Callers
// use `loadBootstrap` rather than this directly.
export const getBootstrap = (): Promise<HarnessBootstrap> => request<HarnessBootstrap>('');

// Every session the server holds, newest last (the store keeps insertion order).
export const listSessions = async (): Promise<SessionSnapshot[]> => {
    const body = await request<{ sessions: SessionSnapshot[] }>('/sessions');
    return body.sessions;
};

// One call that works against either mount: try the canonical bootstrap first,
// then fall back to the standalone resource routes. The fallback is not a
// compatibility hack — it is the documented standalone contract (its root is a
// 404) — so it runs for any bootstrap failure, including a reverse proxy that
// strips or rewrites the root document. If both fail, the fallback's error is the
// one worth reporting: it names the route the UI actually needs.
//
// This is also where the static-host chain is walked (see `ensureApiRoot`): the
// Pages deployment has no API on its own origin, so the first catalogue request
// must go to whichever local/LAN gateway answers, not to a pinned guess.
export const loadBootstrap = async (): Promise<HarnessBootstrap> => {
    await ensureApiRoot();

    try {
        return await getBootstrap();
    } catch {
        // Deliberately discard the root failure: a 404 from `/api` is expected,
        // and its message would mask the useful error if the server is down.
    }

    const [index, tools, sessions] = await Promise.all([listHarnesses(), listTools(), listSessions()]);

    // The harness index carries the agent library on the new server. Read it
    // defensively: an older index has no `agents`, and the UI then derives a
    // minimal library from the descriptors (main.ts) instead of failing boot.
    const agents = index.agents;

    return {
        // Standalone has no advertised filesystem root; the UI treats "" as
        // "not reported" and never prints it as a path.
        rootPath: '',
        presets: index.harnesses,
        tools: tools.tools,
        defaults: index.defaults,
        sessions,
        ...(Array.isArray(agents) ? { agents } : {})
    };
};

// The provider catalogue, fetched by the harness server.
//
// Only the endpoint settings travel: the browser must never ask for the server
// key back, and it must not learn whether one is configured beyond what
// /api/harnesses already advertises. The key is posted (never appended to the
// URL) so a configured server key can still be used when the field is blank.
// `signal` lets the UI abandon a superseded request when the base URL changes.
export const listProviderModels = async (
    settings: Pick<RunnerSettings, 'baseURL' | 'apiKey'>,
    signal?: AbortSignal
): Promise<string[]> => {
    const body = await request<ModelIndex>('/models', {
        method: 'POST',
        body: JSON.stringify({ settings: { baseURL: settings.baseURL, apiKey: settings.apiKey } }),
        signal
    });

    return body.models;
};

export const createSession = async (harness: string, settings: RunnerSettings): Promise<SessionSnapshot> => {
    const body = await request<{ session: SessionSnapshot }>('/sessions', {
        method: 'POST',
        body: JSON.stringify({ harness, settings })
    });

    return body.session;
};

export const getSession = async (id: string): Promise<SessionSnapshot> => {
    const body = await request<{ session: SessionSnapshot }>(`/sessions/${encodeURIComponent(id)}`);
    return body.session;
};

// Body of PATCH /sessions/:id (R2). The ONLY session field this client may change
// is the live per-agent model map: the team and its promotion order stay frozen for
// an existing conversation (that is the conversation guarantee), while a model is
// a per-request choice, so the server re-reads it before the NEXT model request and
// leaves an in-flight run alone.
//
// The server answers with the same `{ session }` envelope as GET /sessions/:id, so
// the caller applies it exactly like a re-read snapshot.
//
// Re-exported from the wire contract instead of redeclared: the package root
// exports the server barrel and this client barrel side by side (src/index.ts), so
// a second, structurally identical declaration would make the name ambiguous.
export type { UpdateSessionRequest } from '../server/protocol';

export const updateSession = async (
    id: string,
    input: UpdateSessionRequest
): Promise<SessionSnapshot> => {
    const body = await request<{ session: SessionSnapshot }>(`/sessions/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(input)
    });

    return body.session;
};

export const resetSession = async (id: string): Promise<SessionSnapshot> => {
    const body = await request<{ session: SessionSnapshot }>(`/sessions/${encodeURIComponent(id)}/reset`, {
        method: 'POST'
    });

    return body.session;
};

// DELETE /sessions/:id — PERMANENT removal (R8). The server aborts an active run,
// discards retained queue records, closes /events watchers and rewrites state.json
// before answering `{ deleted: true }` (src/server/api.ts -> SessionStore.remove).
// An unknown id is a 404 that `request` surfaces as an Error whose message contains
// `Unknown session`; main.ts treats that as "already gone" (the desired end state)
// rather than a failed delete, so the wire contract stays exactly this method/path.
export const deleteSession = async (id: string): Promise<void> => {
    await request<{ deleted: boolean }>(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
};

// Same DELETE, sent with `keepalive: true` for the unload path (R7). A plain fetch
// started from `pagehide` may be cancelled before it leaves the browser, which would
// orphan the record; keepalive lets an empty-bodied DELETE finish (the browser caps it
// at ~64 KiB, and this request has no body). Callers treat it as BEST EFFORT: a mobile
// background-kill can still drop it, and nothing may depend on the answer.
export const deleteSessionOnUnload = async (id: string): Promise<void> => {
    await request<{ deleted: boolean }>(
        `/sessions/${encodeURIComponent(id)}`,
        { method: 'DELETE', keepalive: true }
    );
};

// POST /sessions/:id/threads/:threadId/cancel (R5/R7).
//
// Stops ONE persistent runtime thread and everything it owns (the runtime aborts
// its active work and marks the thread stopped; child threads it owns go with it).
// Sibling threads keep running — that is the point of independent threads — so this
// is NOT the session-wide Stop (`cancelSession(id, true)`).
//
// The answer is `{ cancelled, session }`, always carrying the post-stop snapshot.
// Callers reconcile from it rather than assume the thread is stopped:
// `cancelled: false` means there was nothing to abort (already idle/stopped) and
// the roster in `session` is still the truth.
export const cancelSessionThread = async (
    id: string,
    threadId: string
): Promise<CancelThreadResult> =>
    request<CancelThreadResult>(
        `/sessions/${encodeURIComponent(id)}/threads/${encodeURIComponent(threadId)}/cancel`,
        { method: 'POST' }
    );

// DELETE /sessions/:id/threads/:threadId (R7).
//
// Permanently removes one STOPPED/IDLE thread. A running thread answers 409
// (`request` surfaces that as an Error); the UI never offers delete for a running
// thread, and this is the server's backstop. The answer carries the authoritative
// snapshot after the deletion, so the caller reconciles from it: the deleted
// thread's turns disappear from `turns` and the roster, and any focus/reference that
// pointed at them is cleared from THAT answer, never from a stale local frame.
export const deleteSessionThread = async (
    id: string,
    threadId: string
): Promise<DeleteThreadResult> =>
    request<DeleteThreadResult>(
        `/sessions/${encodeURIComponent(id)}/threads/${encodeURIComponent(threadId)}`,
        { method: 'DELETE' }
    );

export const cancelSession = async (id: string, all = false): Promise<boolean> => {
    // `all: true` is the Stop-all signal: the server aborts the active run AND
    // cancels every retained queued task, so one press drains the queue instead
    // of leaving the next task to start on its own. The field is omitted unless
    // requested so the legacy no-body cancel (active run only) is still sent by
    // any caller that wants it.
    const body = await request<{ cancelled: boolean }>(`/sessions/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
        ...(all ? { body: JSON.stringify({ all: true }) } : {})
    });

    return body.cancelled;
};

// POST /sessions/:id/actions/:requestId/answer (N3).
//
// Answers ONE pending actionRequest with either an option id or custom text. This
// is NOT a task submission: it resolves a question the running turn is paused on,
// so the composer/queue must not enqueue anything and the request is allowed while
// the session is busy. Both ids are URL-encoded (a request id is server-generated
// but still data), and the body is exactly `{ choice }` per the frozen contract.
// The server answers `{ ok: true }`; anything else is surfaced by `request` as an
// Error with the server's message, which the card shows without losing the user's
// selection.
export const answerAction = async (
    sessionId: string,
    requestId: string,
    choice: HarnessActionChoice
): Promise<boolean> => {
    const body = await request<{ ok: boolean }>(
        `/sessions/${encodeURIComponent(sessionId)}/actions/${encodeURIComponent(requestId)}/answer`,
        {
            method: 'POST',
            body: JSON.stringify({ choice })
        }
    );

    // The contract's only success body is `{ ok: true }`. A 200 that says
    // otherwise is a refusal the card must present as a recoverable error, not a
    // silent "answered" state.
    if (body.ok !== true) throw new Error('The harness server did not accept the answer.');

    return true;
};

// POST /sessions/:id/tasks (R4 queue).
//
// The server records the task, puts it behind whatever is already running, and
// answers 202 IMMEDIATELY with the session snapshot plus the turn record. That
// fast answer is what keeps the composer usable: the request that submits a task
// is not the request that runs it. Execution and streaming are observed on the
// long-lived GET /sessions/:id/events stream below.
// `steered: true` is present only when the submit was folded into a RUNNING thread;
// `turn` is then the turn that OWNS that run (see run() in main.ts: the optimistic
// steering row is discarded instead of being kept as an unbound queued ghost).
export type EnqueueTaskResult = SubmitTaskResult;

// Body of POST /sessions/:id/tasks. `attachments` is OPTIONAL and omitted when the
// draft has none, so a text-only submit stays byte-identical to the pre-attachment
// contract. The server validates the same array with shared/attachments.ts; this
// client passes records the composer already built through that validator.
//
// `references` (T5 R2) is the agreed optional array of EXACT block bindings
// `{ turnId, threadId?, label }`; `undefined` threadId means the turn's root
// block. It is omitted when empty, so a plain typed `#LABEL` (which the server
// resolves to the latest matching turn) keeps the old body shape.
//
// `threadId` (R5/R6/R7) is the PERSISTENT runtime thread this task targets:
//   - ABSENT  -> the server opens a NEW standalone thread (or, on a legacy server,
//                the session's one implicit conversation — identical old body);
//   - idle/stopped target -> a new turn runs in that SAME conversation;
//   - running target      -> the input is queued as a STEERING user message at the
//                            thread's next safe model boundary, and the 202 may
//                            return the OWNING turn (same id) instead of a new one.
// The field is omitted when there is no target, so a legacy body is byte-identical.
export const enqueueTask = async (
    id: string,
    input: string,
    attachments?: readonly HarnessAttachment[],
    references?: readonly HarnessTurnReference[],
    threadId?: string
): Promise<EnqueueTaskResult> => {
    const body: Record<string, unknown> = { input };

    if (threadId !== undefined && threadId.length > 0) body.threadId = threadId;

    if (attachments !== undefined && attachments.length > 0) body.attachments = attachments;
    if (references !== undefined && references.length > 0) {
        // Copy every entry to a plain wire object: undefined `threadId` is omitted
        // (the root signal) and no draft-only field can leak into the request.
        body.references = references.map((reference) => ({
            turnId: reference.turnId,
            ...(reference.threadId === undefined ? {} : { threadId: reference.threadId }),
            label: reference.label
        }));
    }

    return request<EnqueueTaskResult>(`/sessions/${encodeURIComponent(id)}/tasks`, {
        method: 'POST',
        body: JSON.stringify(body)
    });
};

// POST /tools/:name — call one tool on the server.
//
// `sessionId` is only meaningful for a `sessionBound` core tool (toolRequest,
// toolCreate, task, delegate): the server runs it inside that session's
// harness, so discovery, runtime tools, the task list and delegation change the
// conversation the user is looking at. It is omitted for a catalogue tool, whose
// request body therefore stays byte-identical to the pre-R8 contract.
export const callTool = (
    name: string,
    parameters: unknown,
    sessionId?: string
): Promise<ToolCallResult> =>
    request<ToolCallResult>(`/tools/${encodeURIComponent(name)}`, {
        method: 'POST',
        body: JSON.stringify({
            parameters,
            ...(sessionId === undefined || sessionId.length === 0 ? {} : { sessionId })
        })
    });

// Read a `text/event-stream` body and hand every `data:` payload to the caller.
// The server sends one JSON `SessionStreamItem` per frame, so a frame never
// contains a literal newline.
//
// Shared by both stream routes on purpose: POST /messages (legacy, one task and a
// terminal frame) and GET /events (the queue observer). Parsing must be identical
// or the two paths would disagree about the same server.
const readEventStream = async (
    body: ReadableStream<Uint8Array>,
    onItem: (item: SessionStreamItem) => void
): Promise<void> => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const handle = (block: string): void => {
        const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');

        if (data.length === 0) return;

        let item: SessionStreamItem;
        try {
            item = JSON.parse(data) as SessionStreamItem;
        } catch {
            return;
        }

        onItem(item);
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let index: number;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            if (block.trim().length > 0) handle(block);
        }
    }

    if (buffer.trim().length > 0) handle(buffer);
};

// POST /sessions/:id/messages — the LEGACY single-task stream.
//
// Retained for compatibility (an older UI, a script) but the frontend no
// longer uses it: a task is enqueued with POST /tasks and observed with
// GET /events, so the composer is not tied to the run's duration. The parsing and
// terminal-snapshot contract are unchanged.
export const submitMessage = async (
    id: string,
    input: string,
    onItem: (item: SessionStreamItem) => void,
    signal: AbortSignal
): Promise<SessionSnapshot> => {
    let response: Response;

    try {
        response = await fetch(url(`/sessions/${encodeURIComponent(id)}/messages`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Harness-Client': 'ui' },
            body: JSON.stringify({ input }),
            signal
        });
    } catch (error) {
        if (signal.aborted) throw error;
        throw new Error(`The harness server is unreachable: ${messageOf(error)}`);
    }

    if (!response.ok) {
        throw new Error(await readError(response));
    }

    if (response.body === null) {
        throw new Error('The harness server returned an empty stream.');
    }

    let snapshot: SessionSnapshot | undefined;
    await readEventStream(response.body, (item) => {
        if (item.type === 'snapshot' || item.type === 'failed') snapshot = item.session;
        onItem(item);
    });

    if (snapshot === undefined) {
        throw new Error('The harness stream ended without a terminal frame.');
    }

    return snapshot;
};

// GET /sessions/:id/events — the QUEUE OBSERVER (R4).
//
// One long-lived subscription per selected session. The server opens with a
// `snapshot` of the whole session (so a late/reloaded observer hydrates the queue),
// then streams `turn` upserts and `event` frames for every task in FIFO order, and
// emits a fresh `snapshot` when the queue drains.
//
// Aborting `signal` only UNSUBSCRIBES: it never cancels work. Execution belongs to
// the server and continues after the page is gone, which is why the composer can
// return immediately and why switching a view must not stop the queue. The promise
// resolves when the server closes the stream and rejects on a transport/HTTP
// failure; the caller treats either as an observation problem, never as a task
// failure, and falls back to GET /sessions/:id.
export const observeSession = async (
    id: string,
    onItem: (item: SessionStreamItem) => void,
    signal: AbortSignal
): Promise<void> => {
    let response: Response;

    try {
        response = await fetch(url(`/sessions/${encodeURIComponent(id)}/events`), {
            headers: { Accept: 'text/event-stream', 'X-Harness-Client': 'ui' },
            signal
        });
    } catch (error) {
        if (signal.aborted) throw error;
        throw new Error(`The harness server is unreachable: ${messageOf(error)}`);
    }

    if (!response.ok) {
        throw new Error(await readError(response));
    }

    if (response.body === null) {
        throw new Error('The harness server returned an empty event stream.');
    }

    await readEventStream(response.body, onItem);
};

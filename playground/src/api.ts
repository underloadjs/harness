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
// The root is chosen at runtime, in this order (see `resolveApiRoot`):
//   1. `?apiRoot=` on the page URL (validated; a bad value falls back silently);
//   2. server-injected config (`window.__HARNESS_CONFIG__.apiRoot` or a
//      `<meta name="harness-api-root">` element), for a host that serves this
//      bundle and knows where its API lives;
//   3. build-time `VITE_HARNESS_API`;
//   4. `/api`.
//
// The root is only ever a base URL/prefix. No credential, query string or hash
// is accepted on it, so a secret can never be pushed into a URL by this module.
//
// TRUST: sources 1 and 2 are RUNTIME and therefore untrusted. The UI posts the
// provider key saved in this browser to whatever root it resolves, so an absolute
// root from a query string or injected config must be same-origin with the page
// or a loopback host (server/origin.ts, shared with the service's Origin gate).
// Otherwise a crafted link such as `?apiRoot=https://evil.example/api` would
// receive the saved credential on the next model lookup or session creation.
// Source 3 is compiled into the bundle by the operator and is deliberately
// trusted: a cross-origin `VITE_HARNESS_API` is a supported deployment, and it
// cannot be changed by a URL the user is tricked into opening.

import { isTrustedRuntimeOrigin } from '../../server/origin';
import type {
    AgentDescriptor,
    CreateHarnessRequest,
    HarnessDescriptor,
    HarnessIndex,
    ModelIndex,
    RunnerSettings,
    SessionSnapshot,
    SessionStreamItem,
    ToolCallResult,
    ToolDescriptor,
    ToolIndex,
    UpdateHarnessRequest
} from '../../server/protocol';

// Payload of GET `/v1/harness`. `server/api.ts` owns this shape (HarnessBootstrap)
// but protocol.ts is not ours to extend, so the browser mirrors the fields it
// consumes. Keep in sync with server/api.ts `HarnessBootstrap`.
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
export const resolveApiRoot = (): string => {
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

            if (!trusted && isAbsolute(root) && !isTrustedRuntimeOrigin(root, globalThis.location?.origin)) {
                return undefined;
            }

            return root;
        } catch {
            return undefined;
        }
    };

    return (
        attempt(query, false) ??
        attempt(injectedRoot(), false) ??
        attempt(import.meta.env.VITE_HARNESS_API, true) ??
        FALLBACK_ROOT
    );
};

export const API_ROOT = resolveApiRoot();

const url = (path: string): string => `${API_ROOT}${path}`;

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

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
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

    if (!response.ok) {
        throw new Error(await readError(response));
    }

    return (await response.json()) as T;
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

// GET root. Only the canonical mount (`/v1/harness`) answers this with the
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
export const loadBootstrap = async (): Promise<HarnessBootstrap> => {
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

export const resetSession = async (id: string): Promise<SessionSnapshot> => {
    const body = await request<{ session: SessionSnapshot }>(`/sessions/${encodeURIComponent(id)}/reset`, {
        method: 'POST'
    });

    return body.session;
};

export const deleteSession = async (id: string): Promise<void> => {
    await request<{ deleted: boolean }>(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
};

export const cancelSession = async (id: string): Promise<boolean> => {
    const body = await request<{ cancelled: boolean }>(`/sessions/${encodeURIComponent(id)}/cancel`, {
        method: 'POST'
    });

    return body.cancelled;
};

// POST /tools/:name — call one tool on the server.
//
// `sessionId` is only meaningful for a `sessionBound` core tool (toolRequest,
// toolCreate, todoManage, agentDelegate): the server runs it inside that session's
// harness, so discovery, runtime tools, todos and delegation change the
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

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let snapshot: SessionSnapshot | undefined;

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

        if (item.type === 'snapshot' || item.type === 'failed') snapshot = item.session;
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

    if (snapshot === undefined) {
        throw new Error('The harness stream ended without a terminal frame.');
    }

    return snapshot;
};

// The canonical browser client: root resolution, the shared transport, paging, and the
// routes every pane is built on (T23 migration of the H4/R4/R6/R8 suites).
//
// WHAT CHANGED WITH THE CANONICAL CONTRACT (and why each old expectation moved)
//   - `API_ROOT` defaults to `/v1/harness` (../shared/harness-api.ts:39). The legacy `/api`
//     mount is gone from the client: standalone and gateway-mounted deployments answer the
//     SAME path, so there is no per-mount root and no root-404 fallback chain.
//   - `getBootstrap()` (one document at the root) is gone. `loadBootstrap()` now COMPOSES
//     six bounded reads — `GET /`, `/config`, `/harnesses?limit=25`, `/tools?limit=25`,
//     `/agents?limit=25`, `/sessions?limit=25` — so booting against 100 sessions costs the
//     same bytes as against one (./api.ts:1287).
//   - `enqueueTask` → `submitTask`, which answers a `TaskReceipt`, not `{ session, turn }`.
//   - `observeSession` (SSE `GET /sessions/:id/events`) is gone: realtime lives in
//     ./stream.ts over the `harness.v1` WebSocket, pinned in ./stream.test.ts. What stays
//     in THIS file is the socket's URL derivation, because it must follow the same resolved
//     root as every REST call.
//   - Deletes and cancels answer receipts. `deleteHarness` reports `undefined` for an
//     unknown name ("already gone" is the end state) instead of the legacy boolean.
//
// WHAT THIS FILE STILL OWNS UNCHANGED: the credential-root resolution and trust rule (a
// runtime root may only name the page's own origin or a loopback host, because the saved
// provider key is posted there), the header/error/accept semantics of the transport, and
// the encoding of every id that is user data.
//
// WHAT THIS FILE NOW ALSO OWNS: the saved "Harness server URL" (`API_ROOT_STORAGE_KEY` /
// `storedApiRoot` / `saveApiRootSetting`) — step 2 of the resolution ladder, written by
// the Endpoint & model dialog. To the trust rule above it is the one exception by
// design: it can only have been typed in this browser, so it may name another origin
// (like the build-time value), it outranks that value and the injected config, and only
// `?apiRoot=` still beats it.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts api.test.ts

import { HARNESS_PAGE_LIMIT, HARNESS_ROUTES } from '../shared/harness-api';
import type { GlobalConfigDocument, HarnessCard, ServiceInfo, ToolSummary, AgentSummary, SessionSummary } from '../shared/harness-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_ROOT_STORAGE_KEY, normalizeApiRoot, saveApiRootSetting, storedApiRoot } from './api';

const CANONICAL = '/v1/harness';

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

type Call = { method: string; url: string; body: unknown; keepalive: boolean | undefined };

let calls: Call[] = [];

// A stub that records every request and THROWS for a route it does not declare, so a
// client that invents a read (or falls back to a mount it no longer uses) fails here.
const serve = (routes: Record<string, unknown>, statuses: Record<string, number> = {}): void => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const method = (init?.method ?? 'GET').toUpperCase();
            const url = String(input);

            calls.push({
                method,
                url,
                body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
                keepalive: init?.keepalive
            });

            const key = `${method} ${url}`;
            const value = routes[key] ?? routes[url];

            if (value === undefined) throw new Error(`unexpected request: ${method} ${url}`);

            return new Response(JSON.stringify(value), {
                status: statuses[key] ?? statuses[url] ?? 200,
                headers: { 'Content-Type': 'application/json' }
            });
        })
    );
};

// ---------------------------------------------------------------------------
// Fixtures: the constant-size boot documents
// ---------------------------------------------------------------------------

const info: ServiceInfo = {
    api_root: '/v1/harness',
    service: 'underload-harness',
    api_version: 'v1',
    build_version: '1.2.3',
    server_time: 1_700_000_000_000,
    epoch: 'epoch-7',
    capabilities: {
        websocket_stream: true,
        tool_execution: true,
        tool_registration: true,
        transcript_editing: true,
        command_dispatch: true,
        model_discovery: true,
        harness_definition_writes: true,
        agent_writes: true,
        persistent_threads: true
    },
    limits: {
        body_bytes: 1_000_000,
        submit_body_bytes: 16_777_216,
        input_chars: 200_000,
        pending_tasks: 100,
        thread_records: 256,
        attachments_per_turn: 4,
        attachment_bytes: 4_194_304,
        total_attachment_bytes: 8_388_608,
        result_references: 16,
        pending_actions: 4,
        steer_records: 64,
        created_tools: 32,
        tool_result_bytes: 65_536,
        page_limit_default: 25,
        page_limit_max: 100
    },
    links: { sessions: '/v1/harness/sessions', stream: '/v1/harness/stream' }
};

const config: GlobalConfigDocument = {
    defaults: { base_url: 'http://provider/v1', model: 'm1', has_api_key: false },
    writable_fields: ['settings.base_url', 'settings.model', 'settings.api_key'],
    revision: 2
};

// A CARD: no instruction text, no per-agent model map, no resolved core-tool set.
const card: HarnessCard = {
    name: 'demo',
    title: 'Demo',
    description: 'demo preset',
    requires_endpoint: false,
    primary: 'instruct',
    subagents: [],
    agents: ['instruct'],
    tools: ['read'],
    builtin: true,
    definition_revision: 3
};

const tool: ToolSummary = {
    name: 'read',
    group: 'files',
    description: 'Read a file.',
    tags: ['files'],
    visibility: 'core',
    session_bound: false
};

const agentRow: AgentSummary = {
    name: 'instruct',
    title: 'Instruct',
    description: 'General agent.',
    has_instruction_override: false,
    has_global_override: false
};

const sessionRow: SessionSummary = {
    id: 's1',
    harness: 'demo',
    status: 'idle',
    model: 'm1',
    created_at: 1,
    updated_at: 2,
    turn_count: 0,
    thread_count: 0,
    revision: 4
};

const pageOf = <T>(items: T[], next_cursor: string | null = null) => ({
    limit: HARNESS_PAGE_LIMIT.default,
    next_cursor,
    observed_at: 1_700_000_000_000,
    revision: 9,
    items
});

beforeEach(() => {
    vi.resetModules();
    calls = [];
    window.history.replaceState(null, '', '/');
    // The saved server URL lives in localStorage (./api.ts `API_ROOT_STORAGE_KEY`), and
    // the store is a per-file singleton — without this a value saved by one test would
    // decide the root of the next one.
    localStorage.clear();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    delete (globalThis as { __HARNESS_CONFIG__?: unknown }).__HARNESS_CONFIG__;
});

// ---------------------------------------------------------------------------
// Root syntax (unchanged): what may end up in front of every request URL
// ---------------------------------------------------------------------------

describe('normalizeApiRoot', () => {
    it('keeps rooted paths and strips trailing slashes', () => {
        expect(normalizeApiRoot('/v1/harness/', CANONICAL)).toBe('/v1/harness');
        // A root of "/" means the origin itself; the concatenation stays correct.
        expect(normalizeApiRoot('/', CANONICAL)).toBe('');
        expect(normalizeApiRoot('', CANONICAL)).toBe(CANONICAL);
        expect(normalizeApiRoot(undefined, CANONICAL)).toBe(CANONICAL);
    });

    it('accepts absolute http(s) roots without a trailing slash', () => {
        expect(normalizeApiRoot('http://127.0.0.1:5000/v1/harness/', CANONICAL)).toBe(
            'http://127.0.0.1:5000/v1/harness'
        );
        expect(normalizeApiRoot('https://api.example.test/v1/harness', CANONICAL)).toBe(
            'https://api.example.test/v1/harness'
        );
        // An origin-only URL is a valid mount at the root path.
        expect(normalizeApiRoot('https://api.example.test/', CANONICAL)).toBe('https://api.example.test');
    });

    it('rejects anything that is not a plain path or http(s) origin', () => {
        const invalid = [
            'v1/harness', // relative without a leading slash
            '//evil.example/api', // protocol-relative: silently another origin
            '/\\evil.example/api', // backslash: the URL parser treats it as "//"
            '/\\/evil.example/api', // same, with the slash after it escaped
            '/v1/harness\u0000', // control characters are stripped/reinterpreted by fetch
            'javascript:alert(1)',
            'ftp://example.test/api',
            '/v1/harness?apiKey=secret', // a secret must never travel in a URL
            '/v1/harness#fragment',
            'http://user:pass@example.test/v1/harness',
            'http://example.test/v1/harness?key=secret'
        ];

        for (const value of invalid) {
            expect(() => normalizeApiRoot(value, CANONICAL)).toThrow();
        }
    });
});

// ---------------------------------------------------------------------------
// Root resolution and the credential trust rule (F1) — semantics preserved
// ---------------------------------------------------------------------------

describe('resolveApiRoot', () => {
    it('defaults to the canonical /v1/harness root', async () => {
        const module = await import('./api');
        expect(module.API_ROOT).toBe('/v1/harness');
    });

    it('never probes off a Pages host', async () => {
        // This page's host serves the API itself (or the Vite proxy does), so the
        // relative fallback is correct and the local/LAN chain of
        // ./api-static-host.test.ts must stay out of the way: no candidates, and
        // `ensureApiRoot` makes no request.
        const urls: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            urls.push(String(input));

            throw new TypeError('Failed to fetch');
        }));

        const module = await import('./api');

        expect(module.apiRootCandidates()).toEqual([]);
        expect(await module.ensureApiRoot()).toBe('/v1/harness');
        expect(urls).toEqual([]);
    });

    it('takes a rooted path from ?apiRoot', async () => {
        window.history.replaceState(null, '', '/?apiRoot=%2Fv1%2Fharness%2F');
        const module = await import('./api');
        expect(module.API_ROOT).toBe('/v1/harness');
    });

    it('takes an absolute http(s) root from ?apiRoot', async () => {
        window.history.replaceState(null, '', '/?apiRoot=https%3A%2F%2F127.0.0.1%3A5000%2Fv1%2Fharness');
        const module = await import('./api');
        expect(module.API_ROOT).toBe('https://127.0.0.1:5000/v1/harness');
    });

    it('ignores an invalid override instead of refusing to boot', async () => {
        window.history.replaceState(null, '', '/?apiRoot=javascript%3Aalert(1)');
        const module = await import('./api');
        expect(module.API_ROOT).toBe(CANONICAL);
    });

    it('refuses a cross-origin absolute ?apiRoot', async () => {
        // F1: the saved provider key is posted to the resolved root, so a runtime
        // override may only name the page's own origin or a loopback host.
        window.history.replaceState(null, '', '/?apiRoot=https%3A%2F%2Fevil.example%2Fv1%2Fharness');
        const module = await import('./api');
        expect(module.API_ROOT).toBe(CANONICAL);
    });

    it('refuses a query root that escapes the origin only after URL decoding', async () => {
        // %5C decodes to a backslash; fetch() would resolve "/\evil.example/x" against
        // the page as "//evil.example/x" — another origin.
        window.history.replaceState(null, '', '/?apiRoot=%2F%5Cevil.example%2Fv1%2Fharness');
        const module = await import('./api');
        expect(module.API_ROOT).toBe(CANONICAL);
    });

    it('accepts same-origin and loopback absolute roots', async () => {
        const origin = window.location.origin;

        window.history.replaceState(null, '', `/?apiRoot=${encodeURIComponent(`${origin}/v1/harness`)}`);
        let module = await import('./api');
        expect(module.API_ROOT).toBe(`${origin}/v1/harness`);

        vi.resetModules();
        window.history.replaceState(null, '', '/?apiRoot=http%3A%2F%2Flocalhost%3A5000%2Fv1%2Fharness');
        module = await import('./api');
        expect(module.API_ROOT).toBe('http://localhost:5000/v1/harness');

        vi.resetModules();
        window.history.replaceState(null, '', '/?apiRoot=http%3A%2F%2F%5B%3A%3A1%5D%3A5000%2Fv1%2Fharness');
        module = await import('./api');
        expect(module.API_ROOT).toBe('http://[::1]:5000/v1/harness');
    });

    it('applies the same trust rule to injected config', async () => {
        (globalThis as { __HARNESS_CONFIG__?: { apiRoot?: string } }).__HARNESS_CONFIG__ = {
            apiRoot: 'https://evil.example/v1/harness'
        };

        let module = await import('./api');
        expect(module.API_ROOT).toBe(CANONICAL);

        vi.resetModules();
        (globalThis as { __HARNESS_CONFIG__?: { apiRoot?: string } }).__HARNESS_CONFIG__ = {
            apiRoot: 'http://127.0.0.1:5000/v1/harness'
        };
        module = await import('./api');
        expect(module.API_ROOT).toBe('http://127.0.0.1:5000/v1/harness');
    });

    it('trusts a cross-origin build-time VITE_HARNESS_API', async () => {
        // Build-time config is compiled by the operator, not taken from a URL a user can
        // be tricked into opening, so it may name another origin.
        vi.stubEnv('VITE_HARNESS_API', 'https://api.example.test/v1/harness');

        const module = await import('./api');
        expect(module.API_ROOT).toBe('https://api.example.test/v1/harness');
    });

    it('sends a saved provider key only to the validated root', async () => {
        window.history.replaceState(null, '', '/?apiRoot=https%3A%2F%2Fevil.example%2Fv1%2Fharness');

        serve({ 'POST /v1/harness/sessions': { session: sessionRow } });

        const module = await import('./api');
        const settings = { base_url: 'http://provider/v1', api_key: 'saved-provider-key', model: 'm1' };

        await module.createSession({ harness: 'demo', settings });

        // The hostile root was discarded, so the key goes to the page's canonical mount
        // and is never part of a URL.
        expect(calls).toEqual([
            {
                method: 'POST',
                url: '/v1/harness/sessions',
                body: { harness: 'demo', settings },
                keepalive: undefined
            }
        ]);
    });

    it('routes every request through the resolved root', async () => {
        window.history.replaceState(null, '', '/?apiRoot=%2Fv1%2Fharness');

        serve({ 'GET /v1/harness/sessions/a%2Fb': { session: sessionRow } });

        const module = await import('./api');
        expect(await module.getSession('a/b')).toEqual(sessionRow);

        // Session ids are path segments and must be encoded, never interpolated.
        expect(calls).toEqual([
            { method: 'GET', url: '/v1/harness/sessions/a%2Fb', body: undefined, keepalive: undefined }
        ]);
    });
});

// ---------------------------------------------------------------------------
// The saved "Harness server URL" — the Endpoint & model dialog's own setting
// ---------------------------------------------------------------------------
//
// This is the source that makes the UI independent of the server it was served by:
// the reader types a control-plane root, it is validated and persisted by
// `saveApiRootSetting`, and the NEXT load (the dialog reloads on Apply) resolves it as
// step 2 of the ladder. It outranks the injected config and `VITE_HARNESS_API` — an
// operator bundle must be re-pointable without a rebuild — and only `?apiRoot=` beats
// it, because that parameter is the documented per-load override.

describe('the saved server URL', () => {
    it('becomes the root every request and the socket dial', async () => {
        localStorage.setItem(API_ROOT_STORAGE_KEY, 'https://harness.example.test/v1/harness');
        serve({ 'GET https://harness.example.test/v1/harness/health': { ok: true, sessions: 0, epoch: 'e' } });

        const module = await import('./api');

        expect(module.API_ROOT).toBe('https://harness.example.test/v1/harness');
        expect(await module.getHealth()).toEqual({ ok: true, sessions: 0, epoch: 'e' });
        expect(calls).toEqual([
            {
                method: 'GET',
                url: 'https://harness.example.test/v1/harness/health',
                body: undefined,
                keepalive: undefined
            }
        ]);

        // The realtime plane follows the SAME root, and an https host must dial `wss:`.
        expect(module.streamSocketUrl()).toBe('wss://harness.example.test/v1/harness/stream');
    });

    it('trusts a cross-origin absolute root that a runtime source must refuse', async () => {
        // F1 keeps refusing `https://evil.example` from a query string: a link must not
        // take the saved provider key. The same host SAVED in this browser is a
        // deliberate choice, so it is accepted — that is the whole feature.
        window.history.replaceState(null, '', '/?apiRoot=https%3A%2F%2Fevil.example%2Fv1%2Fharness');
        let module = await import('./api');
        expect(module.API_ROOT).toBe(CANONICAL);

        vi.resetModules();
        window.history.replaceState(null, '', '/');
        localStorage.setItem(API_ROOT_STORAGE_KEY, 'https://evil.example/v1/harness');
        module = await import('./api');
        expect(module.API_ROOT).toBe('https://evil.example/v1/harness');
    });

    it('outranks the injected config and VITE_HARNESS_API, and only ?apiRoot= beats it', async () => {
        localStorage.setItem(API_ROOT_STORAGE_KEY, 'https://saved.example.test/v1/harness');
        vi.stubEnv('VITE_HARNESS_API', 'https://built.example.test/v1/harness');
        (globalThis as { __HARNESS_CONFIG__?: { apiRoot?: string } }).__HARNESS_CONFIG__ = {
            apiRoot: 'https://injected.example.test/v1/harness'
        };

        const saved = await import('./api');
        expect(saved.API_ROOT).toBe('https://saved.example.test/v1/harness');

        vi.resetModules();
        window.history.replaceState(null, '', '/?apiRoot=http%3A%2F%2Flocalhost%3A5000%2Fv1%2Fharness');
        const overridden = await import('./api');
        expect(overridden.API_ROOT).toBe('http://localhost:5000/v1/harness');

        // A BROKEN query value is ignored, so the saved root still applies: the reader's
        // setting is not held hostage by a hand-edited address bar.
        vi.resetModules();
        window.history.replaceState(null, '', '/?apiRoot=javascript%3Aalert(1)');
        const brokenQuery = await import('./api');
        expect(brokenQuery.API_ROOT).toBe('https://saved.example.test/v1/harness');
    });

    it('ignores a stored value that cannot be a root instead of refusing to boot', async () => {
        // Reachable when the store is edited by hand or by another tab: `resolveRoot`
        // never trusts the raw string, so an unusable entry falls through to the
        // documented default rather than throwing during module load.
        for (const value of ['javascript:alert(1)', '//evil.example/api', 'v1/harness', '/v1/harness?k=secret', '']) {
            vi.resetModules();
            localStorage.setItem(API_ROOT_STORAGE_KEY, value);

            const module = await import('./api');
            expect(module.API_ROOT).toBe(CANONICAL);
        }
    });

    it('normalizes a hand-written entry the same way the write path does', async () => {
        localStorage.setItem(API_ROOT_STORAGE_KEY, '  https://harness.example.test/v1/harness///  ');
        let module = await import('./api');
        expect(module.API_ROOT).toBe('https://harness.example.test/v1/harness');

        vi.resetModules();
        localStorage.setItem(API_ROOT_STORAGE_KEY, ' /v1/harness/ ');
        module = await import('./api');
        expect(module.API_ROOT).toBe('/v1/harness');
    });
});

describe('saveApiRootSetting / storedApiRoot', () => {
    it('round-trips the normalized value and clears the key (never stores an empty string)', () => {
        expect(storedApiRoot()).toBeUndefined();

        expect(saveApiRootSetting('http://127.0.0.1:5000/v1/harness/')).toBe(
            'http://127.0.0.1:5000/v1/harness'
        );
        expect(localStorage.getItem(API_ROOT_STORAGE_KEY)).toBe('http://127.0.0.1:5000/v1/harness');
        expect(storedApiRoot()).toBe('http://127.0.0.1:5000/v1/harness');

        // `null`, blank and `undefined` all REMOVE the key, which is what makes the next
        // load resolve automatically again; an empty string left behind would be a saved
        // value that means nothing.
        expect(saveApiRootSetting(null)).toBeUndefined();
        expect(localStorage.getItem(API_ROOT_STORAGE_KEY)).toBeNull();

        expect(saveApiRootSetting('   ')).toBeUndefined();
        expect(localStorage.getItem(API_ROOT_STORAGE_KEY)).toBeNull();

        saveApiRootSetting('/v1/harness');
        expect(saveApiRootSetting(undefined)).toBeUndefined();
        expect(localStorage.getItem(API_ROOT_STORAGE_KEY)).toBeNull();
        expect(storedApiRoot()).toBeUndefined();
    });

    it('refuses a root that normalizes away to the origin instead of storing an empty string', () => {
        // `normalizeApiRoot` keeps `/` as `''` (./api.ts:244) because `${root}${path}`
        // must stay correct — and `storedApiRoot` reports `''` as "nothing saved". So
        // persisting `''` here would ACCEPT the value on Apply and hand the NEXT load
        // back to automatic resolution: a save that silently reverts. The refusal is the
        // fix, and it is limited to the write path (query/injected roots keep the old
        // semantics, pinned above).
        for (const typed of ['/', ' / ', '  /  ']) {
            expect(() => saveApiRootSetting(typed)).toThrow(
                'The API root cannot be just "/"; use an absolute origin or a path such as /v1/harness.'
            );

            expect(localStorage.getItem(API_ROOT_STORAGE_KEY)).toBeNull();
            expect(storedApiRoot()).toBeUndefined();
        }

        // Every longer all-slash form is refused EARLIER, by the rule that rejects a
        // protocol-relative root (`//host` hides another origin behind a rooted path).
        // Same outcome — a refusal and nothing stored — different sentence, so it is
        // pinned rather than assumed.
        for (const typed of ['//', '///']) {
            expect(() => saveApiRootSetting(typed)).toThrow(
                'A relative API root must start with a single "/".'
            );

            expect(localStorage.getItem(API_ROOT_STORAGE_KEY)).toBeNull();
            expect(storedApiRoot()).toBeUndefined();
        }
    });

    it('still saves an absolute origin that carries no path', () => {
        // The refusal above is about the ROOT collapsing to nothing. A bare origin URL
        // is a deliberate "dial this host at its root" and normalizes to a non-empty
        // value, so it must keep working after that guard.
        expect(saveApiRootSetting('http://localhost:8180')).toBe('http://localhost:8180');
        expect(localStorage.getItem(API_ROOT_STORAGE_KEY)).toBe('http://localhost:8180');
        expect(storedApiRoot()).toBe('http://localhost:8180');

        // The trailing-slash form is the same host and lands on the same bytes.
        expect(saveApiRootSetting('http://localhost:8180/')).toBe('http://localhost:8180');
        expect(localStorage.getItem(API_ROOT_STORAGE_KEY)).toBe('http://localhost:8180');
    });

    it('refuses to SAVE in a browser with no local storage, and treats a CLEAR as already done', () => {
        // A store that is ABSENT (not one that throws) used to make every branch fall
        // through the optional chain and report success: Apply saved nothing, then
        // reloaded onto the automatic root. That is the silent-revert bug, so the write
        // path now fails loudly and the dialog keeps the reader's typed value.
        //
        // The clear is the other half, and it is NOT symmetric (T5): with no store there is
        // nothing to remove, and `storedApiRoot()` already answers "no setting" — which is
        // exactly what Reset and an empty Apply ask for. Throwing there made Reset an error
        // line the reader could not act on, so a blank value returns `undefined` and the
        // caller reloads onto automatic resolution, the same place it would land anyway.
        // Hence the guard order inside `saveApiRootSetting`: blank first, store check after.
        //
        // Approach: `vi.stubGlobal('localStorage', undefined)` replaces the jsdom global
        // SLOT that `globalThis.localStorage` reads (restored by `vi.unstubAllGlobals()`,
        // which `afterEach` also calls); no descriptor juggling is needed.
        vi.stubGlobal('localStorage', undefined);

        expect(storedApiRoot()).toBeUndefined();

        // A value that has to be KEPT is the only failure.
        expect(() => saveApiRootSetting('http://localhost:8180/v1/harness')).toThrow(
            'This browser does not expose local storage, so the harness server URL cannot be saved.'
        );

        // The store check still runs BEFORE `normalizeApiRoot`, so a malformed URL in a
        // no-storage browser names the storage, not the syntax. Unchanged by the reorder:
        // only the blank branch moved above the guard.
        expect(() => saveApiRootSetting('//evil.example/api')).toThrow(
            'This browser does not expose local storage, so the harness server URL cannot be saved.'
        );

        // Every clear form succeeds without a store, silently and with no key written.
        for (const cleared of [null, undefined, '', '   ']) {
            expect(saveApiRootSetting(cleared)).toBeUndefined();
        }

        vi.unstubAllGlobals();

        // Nothing was written while the store was gone, and the same value saves fine
        // once it is back: the throw came from the missing store, not from the value.
        expect(localStorage.getItem(API_ROOT_STORAGE_KEY)).toBeNull();
        expect(saveApiRootSetting('http://localhost:8180/v1/harness')).toBe(
            'http://localhost:8180/v1/harness'
        );
    });

    it('rejects every value that is not a plain path or http(s) origin, and writes nothing', () => {
        // The dialog shows these exact sentences, so they are pinned, not paraphrased.
        const refused: Array<[string, string]> = [
            ['v1/harness', 'A relative API root must start with a single "/".'],
            ['//evil.example/api', 'A relative API root must start with a single "/".'],
            ['localhost:8180/v1/harness', 'The API root must be an http(s) URL.'],
            ['/v1/harness?apiKey=secret', 'The API root cannot carry a query string or a fragment.'],
            ['/v1/harness#mount', 'The API root cannot carry a query string or a fragment.'],
            ['http://user:pass@example.test/v1/harness', 'The API root cannot carry credentials.'],
            ['/\\evil.example/api', 'A relative API root cannot contain backslashes or control characters.']
        ];

        for (const [value, message] of refused) {
            expect(() => saveApiRootSetting(value)).toThrow(message);
            expect(localStorage.getItem(API_ROOT_STORAGE_KEY)).toBeNull();
        }
    });

    it('surfaces a store that refuses the write, because the caller is about to reload', () => {
        const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('SecurityError');
        });

        expect(() => saveApiRootSetting('/v1/harness')).toThrow(
            'Could not save the harness server URL in this browser: SecurityError'
        );

        setItem.mockRestore();
    });

    it('reads a blocked store as no setting at all, so resolution keeps working', () => {
        const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('SecurityError');
        });

        localStorage.setItem(API_ROOT_STORAGE_KEY, '/v1/harness');
        expect(storedApiRoot()).toBeUndefined();

        getItem.mockRestore();
        expect(storedApiRoot()).toBe('/v1/harness');
    });

    it('surfaces a store that refuses the clear, because the caller is about to reload', () => {
        // Reset used to swallow this, on the theory that an unreachable store already
        // behaves as "nothing saved". That is wrong for a store that CAN read but cannot
        // remove: the saved root survives the reload, so Reset is a silent no-op and the
        // reader is left on the host they just asked to leave.
        localStorage.setItem(API_ROOT_STORAGE_KEY, '/v1/harness');

        const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
            throw new Error('SecurityError');
        });

        expect(() => saveApiRootSetting(null)).toThrow(
            'Could not clear the saved harness server URL in this browser: SecurityError'
        );

        removeItem.mockRestore();

        // The exact reason the throw matters: the key is STILL there, so a reload would
        // have re-resolved the same saved root.
        expect(localStorage.getItem(API_ROOT_STORAGE_KEY)).toBe('/v1/harness');
        expect(storedApiRoot()).toBe('/v1/harness');
    });
});

// ---------------------------------------------------------------------------
// The transport: markers, counters, and one error path
// ---------------------------------------------------------------------------

describe('the shared transport', () => {
    it('stamps the client markers and reads the epoch/revision headers back', async () => {
        const seen: Array<{ headers: Record<string, string> }> = [];

        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                seen.push({ headers: (init?.headers ?? {}) as Record<string, string> });

                return new Response(JSON.stringify({ session: sessionRow }), {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Harness-Epoch': 'epoch-7',
                        'X-Harness-Revision': '12'
                    }
                });
            })
        );

        const module = await import('./api');
        const read = await module.requestResource<{ session: SessionSummary }>(HARNESS_ROUTES.sessionsBySessionId('s1'));

        expect(read).toEqual({ data: { session: sessionRow }, epoch: 'epoch-7', revision: 12 });
        expect(seen).toEqual([
            { headers: { 'Content-Type': 'application/json', 'X-Harness-Client': 'ui' } }
        ]);
    });

    it('omits a counter the server did not stamp instead of inventing one', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
        );

        const module = await import('./api');

        expect(await module.requestResource(HARNESS_ROUTES.health())).toEqual({ data: { ok: true } });
    });

    it('flattens the one error envelope and never swallows it', async () => {
        serve({ 'GET /v1/harness/health': { error: { message: 'The store is closed.' } } }, { 'GET /v1/harness/health': 503 });

        const module = await import('./api');

        await expect(module.getHealth()).rejects.toThrow('The store is closed.');
    });

    it('degrades a non-JSON failure body to the status line', async () => {
        // A proxy with no upstream answers its own HTML page, which is not the
        // contract's envelope.
        vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway', headers: { 'Content-Type': 'text/html' } })));

        const module = await import('./api');

        await expect(module.getHealth()).rejects.toThrow('HTTP 502 Bad Gateway');
    });

    it('names the route when a successful response is not JSON', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream unavailable', { status: 200, headers: { 'Content-Type': 'text/plain' } })));

        const module = await import('./api');

        // The message carries the contract-relative path, not the mount, so the offline
        // pane can name the operation that failed.
        await expect(module.getSession('a/b')).rejects.toThrow(
            'The harness server returned a non-JSON response for /sessions/a%2Fb (HTTP 200).'
        );
    });

    it('keeps an abort as an abort instead of rewriting it as an unreachable server', async () => {
        const controller = new AbortController();
        controller.abort();

        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new DOMException('The operation was aborted.', 'AbortError');
        }));

        const module = await import('./api');

        await expect(
            module.listProviderModels({ model: 'm1' }, controller.signal)
        ).rejects.toThrow('The operation was aborted');
    });

    it('wraps a real connection failure in one actionable sentence', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new TypeError('connect ECONNREFUSED 127.0.0.1:5000');
        }));

        const module = await import('./api');

        await expect(module.getServiceInfo()).rejects.toThrow(
            'The harness server is unreachable: connect ECONNREFUSED 127.0.0.1:5000'
        );
    });

    it('builds the realtime socket on the SAME root as the REST reads', async () => {
        const module = await import('./api');
        const origin = window.location.origin;
        const scheme = origin.startsWith('https:') ? 'wss:' : 'ws:';

        // Root-relative API -> a socket on this page's origin, at the contract path.
        expect(module.streamSocketUrl()).toBe(`${scheme}//${origin.slice(origin.indexOf('//') + 2)}/v1/harness/stream`);
    });

    it('dials the socket at an absolute build-time root, with the matching scheme', async () => {
        vi.stubEnv('VITE_HARNESS_API', 'https://api.example.test/v1/harness');

        const module = await import('./api');

        expect(module.streamSocketUrl()).toBe('wss://api.example.test/v1/harness/stream');
    });
});

// ---------------------------------------------------------------------------
// Boot: six bounded reads, no document, no fallback mount
// ---------------------------------------------------------------------------

describe('loadBootstrap', () => {
    it('composes the boot from six first-page reads and nothing heavier', async () => {
        serve({
            'GET /v1/harness': info,
            'GET /v1/harness/config': config,
            'GET /v1/harness/harnesses?limit=25': pageOf([card]),
            'GET /v1/harness/tools?limit=25': pageOf([tool]),
            'GET /v1/harness/agents?limit=25': pageOf([agentRow]),
            'GET /v1/harness/sessions?limit=25': pageOf([sessionRow], 'cursor-sessions')
        });

        const module = await import('./api');
        const bootstrap = await module.loadBootstrap();

        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'GET /v1/harness',
            'GET /v1/harness/config',
            'GET /v1/harness/harnesses?limit=25',
            'GET /v1/harness/tools?limit=25',
            'GET /v1/harness/agents?limit=25',
            'GET /v1/harness/sessions?limit=25'
        ]);

        // The whole boot, exactly. Note what is NOT here: no turn, thread, transcript or
        // display read, and the document the legacy root used to answer is not requested.
        expect(bootstrap).toEqual({
            rootPath: '/v1/harness',
            info,
            presets: [
                {
                    name: 'demo',
                    title: 'Demo',
                    description: 'demo preset',
                    requiresEndpoint: false,
                    primary: 'instruct',
                    subagents: [],
                    agents: ['instruct'],
                    tools: ['read'],
                    builtin: true,
                    definitionRevision: 3
                }
            ],
            tools: [
                {
                    name: 'read',
                    group: 'files',
                    description: 'Read a file.',
                    tags: ['files'],
                    visibility: 'core',
                    sessionBound: false
                }
            ],
            // A row carries no instruction TEXT, so the picker's preview stays empty
            // rather than claiming a prompt this read never published.
            agents: [
                {
                    name: 'instruct',
                    title: 'Instruct',
                    description: 'General agent.',
                    instruction: '',
                    guidelines: [],
                    hasInstructionOverride: false,
                    hasGlobalOverride: false
                }
            ],
            defaults: config.defaults,
            sessions: [sessionRow],
            cursors: { harnesses: null, tools: null, agents: null, sessions: 'cursor-sessions' }
        });
    });

    it('surfaces the failure when the server is unreachable', async () => {
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            throw new TypeError(`connect ECONNREFUSED ${String(input)}`);
        }));

        const module = await import('./api');

        await expect(module.loadBootstrap()).rejects.toThrow('The harness server is unreachable');
    });

    it('names a non-JSON boot answer instead of a raw SyntaxError', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream unavailable', { status: 200, headers: { 'Content-Type': 'text/plain' } })));

        const module = await import('./api');

        await expect(module.loadBootstrap()).rejects.toThrow(/non-JSON response/);
    });

    it('patches the provider defaults with the whole-field document the contract asks for', async () => {
        serve({ 'PATCH /v1/harness/config': { ...config, revision: 3 } });

        const module = await import('./api');

        expect((await module.updateGlobalConfig({ model: 'm2' })).revision).toBe(3);
        expect(calls).toEqual([
            { method: 'PATCH', url: '/v1/harness/config', body: { settings: { model: 'm2' } }, keepalive: undefined }
        ]);
    });
});

// ---------------------------------------------------------------------------
// Tools: the two execution scopes, stated by the path
// ---------------------------------------------------------------------------

describe('tool calls', () => {
    it('sends the catalogue call and the session call to different routes', async () => {
        serve({
            'POST /v1/harness/tools/read/executions': { ok: true, result: { enabled: [] }, duration_ms: 3 },
            'POST /v1/harness/tools/toolRequest/executions': { ok: true, result: {}, duration_ms: 2 },
            'POST /v1/harness/sessions/session-1/tools/toolRequest/executions': { ok: true, result: {}, duration_ms: 1 }
        });

        const module = await import('./api');

        // Both outcomes are a 200; the caller branches on `ok`, never on the status.
        expect(await module.callTool('read', { path: 'a.txt' })).toEqual({
            ok: true,
            result: { enabled: [] },
            duration_ms: 3
        });
        await module.callTool('toolRequest', { tags: ['web'] }, 'session-1');
        // An empty id is "no session" for this purpose, not a session lookup.
        await module.callTool('toolRequest', { tags: ['web'] }, '');

        expect(calls.map((call) => [call.method, call.url, call.body])).toEqual([
            ['POST', '/v1/harness/tools/read/executions', { parameters: { path: 'a.txt' } }],
            ['POST', '/v1/harness/sessions/session-1/tools/toolRequest/executions', { parameters: { tags: ['web'] } }],
            ['POST', '/v1/harness/tools/toolRequest/executions', { parameters: { tags: ['web'] } }]
        ]);
    });

    it('posts provider discovery with the key in the body, never the URL', async () => {
        serve({ 'POST /v1/harness/models': { models: ['m1', 'm2'], observed_at: 1 } });

        const module = await import('./api');

        expect(await module.listProviderModels({ base_url: 'http://provider/v1', api_key: 'secret', model: 'm1' })).toEqual(['m1', 'm2']);
        expect(calls).toEqual([
            {
                method: 'POST',
                url: '/v1/harness/models',
                body: { settings: { base_url: 'http://provider/v1', api_key: 'secret', model: 'm1' } },
                keepalive: undefined
            }
        ]);
    });

    it('answers an empty model list when the provider served nothing usable', async () => {
        serve({ 'POST /v1/harness/models': { models: [], observed_at: 1 } });

        const module = await import('./api');

        expect(await module.listProviderModels({})).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Definition and session writes
// ---------------------------------------------------------------------------

describe('harness mutations', () => {
    it('pages cards, creates a definition, and patches one by encoded name', async () => {
        const custom = { ...card, name: 'release-captain', title: 'Release captain' };

        serve({
            'GET /v1/harness/agents?limit=25': pageOf([agentRow]),
            'POST /v1/harness/harnesses': { harness: custom },
            'PATCH /v1/harness/harnesses/a%2Fb': { harness: custom }
        });

        const module = await import('./api');

        expect((await module.listAgents()).items).toEqual([agentRow]);
        expect(
            await module.createHarness({ name: 'release-captain', title: 'Release captain', primary: 'instruct', subagents: ['helper'] })
        ).toEqual(custom);
        expect(await module.updateHarness('a/b', { primary: 'helper', subagents: ['instruct'] })).toEqual(custom);

        expect(calls.map((call) => [call.method, call.url, call.body])).toEqual([
            ['GET', '/v1/harness/agents?limit=25', undefined],
            [
                'POST',
                '/v1/harness/harnesses',
                { name: 'release-captain', title: 'Release captain', primary: 'instruct', subagents: ['helper'] }
            ],
            ['PATCH', '/v1/harness/harnesses/a%2Fb', { primary: 'helper', subagents: ['instruct'] }]
        ]);
    });
});

// R6 — the harness delete receipt, and the unload-only session delete.
describe('harness delete (R6)', () => {
    it('deletes one harness by encoded name and answers the removal receipt', async () => {
        const receipt = {
            deleted: true,
            harness_name: 'a/b',
            tombstoned: true,
            restored_by_restart: false
        };
        serve({ 'DELETE /v1/harness/harnesses/a%2Fb': receipt });

        const module = await import('./api');

        expect(await module.deleteHarness('a/b')).toEqual(receipt);
        expect(calls).toEqual([
            { method: 'DELETE', url: '/v1/harness/harnesses/a%2Fb', body: undefined, keepalive: undefined }
        ]);
    });

    it('treats a 404 as already gone instead of an error', async () => {
        serve(
            { 'DELETE /v1/harness/harnesses/ghost': { error: { message: 'Unknown harness ghost' } } },
            { 'DELETE /v1/harness/harnesses/ghost': 404 }
        );

        const module = await import('./api');

        // "It is already gone" IS the desired end state for a delete, so the caller gets a
        // resolved value rather than a thrown error. The declared contract of this function
        // is `DeleteHarnessResult | undefined` (./api.ts:665) and its own comment says the
        // 404 is "reported as `undefined`"; the legacy `false` is gone with the legacy
        // boolean return.
        //
        // PRODUCT DEFECT (T23 evidence, asserted from the contract not the implementation):
        // `requestResource` only substitutes `undefined` when an accepted status has a
        // NON-JSON body (./api.ts:461). A contract-conformant 404 carries an `ErrorBody`
        // JSON envelope, so this call currently resolves to
        // `{ error: { message: 'Unknown harness ghost' } }` — an object typed as
        // `DeleteHarnessResult` that satisfies none of its fields. Fix the client (drop the
        // accepted-status body, like `getHarness` does by unwrapping `.harness`), not this
        // assertion.
        expect(await module.deleteHarness('ghost')).toBeUndefined();
        expect(calls).toEqual([
            { method: 'DELETE', url: '/v1/harness/harnesses/ghost', body: undefined, keepalive: undefined }
        ]);
    });

    it('resolves rather than rejects when the accepted 404 has no readable body', async () => {
        // The half of the same rule the transport DOES honour: an accepted status whose
        // body is not JSON (a proxy's HTML page) is not a parse failure worth reporting.
        vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>not found</html>', { status: 404, headers: { 'Content-Type': 'text/html' } })));

        const module = await import('./api');

        expect(await module.deleteHarness('ghost')).toBeUndefined();
    });

    it('rejects a real failure with the server message and never swallows it', async () => {
        serve(
            { 'DELETE /v1/harness/harnesses/alpha': { error: { message: 'The registry could not be written' } } },
            { 'DELETE /v1/harness/harnesses/alpha': 500 }
        );

        const module = await import('./api');

        await expect(module.deleteHarness('alpha')).rejects.toThrow('The registry could not be written');
    });

    it('sends the unload cleanup with keepalive and the normal delete without it', async () => {
        serve({
            'DELETE /v1/harness/sessions/s1': { deleted: true, session_id: 's1', aborted_turns: 0, dropped_queued_tasks: 0 },
            'DELETE /v1/harness/sessions/s2': { deleted: true, session_id: 's2', aborted_turns: 1, dropped_queued_tasks: 2 }
        });

        const module = await import('./api');

        await module.deleteSession('s1');
        await module.deleteSessionOnUnload('s2');

        // R7: only the unload path asks the browser to keep the request alive, because a
        // plain fetch started from `pagehide` may never leave.
        expect(calls.map((call) => [call.url, call.keepalive])).toEqual([
            ['/v1/harness/sessions/s1', undefined],
            ['/v1/harness/sessions/s2', true]
        ]);
    });
});

describe('task queue (R4)', () => {
    it('submits with POST /tasks and answers the 202 receipt', async () => {
        const receipt = {
            session_id: 'a/b',
            turn_id: 'u9',
            status: 'queued',
            thread_id: 'th-a',
            queue_position: 1,
            session_revision: 8,
            accepted_at: 2_500,
            links: {
                turn: '/v1/harness/sessions/a%2Fb/turns/u9',
                turns: '/v1/harness/sessions/a%2Fb/turns?limit=25',
                thread: '/v1/harness/sessions/a%2Fb/threads/th-a',
                stream: '/v1/harness/stream'
            }
        };
        serve({ 'POST /v1/harness/sessions/a%2Fb/tasks': receipt });

        const module = await import('./api');
        const answer = await module.submitTask('a/b', { input: 'queued task' });

        // A receipt, not `{ session, turn }`: the row itself arrives on the stream.
        expect(answer).toEqual(receipt);
        expect(calls).toEqual([
            { method: 'POST', url: '/v1/harness/sessions/a%2Fb/tasks', body: { input: 'queued task' }, keepalive: undefined }
        ]);
    });

    it('cancels the active task and the retained queue with an explicit all body', async () => {
        serve({
            'POST /v1/harness/sessions/s1/cancel': {
                cancelled: true,
                session_id: 's1',
                dropped_queued_tasks: 2,
                revision: 9
            }
        });

        const module = await import('./api');

        expect((await module.cancelSession('s1', true)).cancelled).toBe(true);
        // An absent body means "active run only" — the contract's reading of `{}`.
        expect((await module.cancelSession('s1')).cancelled).toBe(true);

        expect(calls.map((call) => [call.url, call.body])).toEqual([
            ['/v1/harness/sessions/s1/cancel', { all: true }],
            ['/v1/harness/sessions/s1/cancel', undefined]
        ]);
    });

    it('reads the queue as bounded previews with exact lengths', async () => {
        const page = {
            ...pageOf([{ id: 'u9', index: 9, prompt_preview: 'the first 200 characters', prompt_chars: 400, agent: 'instruct', enqueued_at: 1 }], null),
            session_id: 's1'
        };
        serve({ 'GET /v1/harness/sessions/s1/queue?limit=25': page });

        const module = await import('./api');
        const read = await module.listQueue('s1');

        expect(read).toEqual({
            items: page.items,
            nextCursor: null,
            revision: 9,
            limit: HARNESS_PAGE_LIMIT.default
        });
    });
});

describe('session model updates', () => {
    it('PATCHes the live model map in snake_case and unwraps the GET-session envelope', async () => {
        // The session's `agent_models` map is live; the route answers with the same
        // `{ session }` envelope as GET /sessions/{id}, which `updateSession` unwraps.
        const moved = { ...sessionRow, agent_models: { writer: 'm2' } };
        serve({ 'PATCH /v1/harness/sessions/a%2Fb': { session: moved } });

        const module = await import('./api');

        expect(await module.updateSession('a/b', { agent_models: { writer: 'm2' } })).toEqual(moved);
        expect(calls).toEqual([
            {
                method: 'PATCH',
                url: '/v1/harness/sessions/a%2Fb',
                body: { agent_models: { writer: 'm2' } },
                keepalive: undefined
            }
        ]);
    });

    it('reports the server message when a session patch is rejected', async () => {
        serve(
            { 'PATCH /v1/harness/sessions/s1': { error: { message: 'That model is not available.' } } },
            { 'PATCH /v1/harness/sessions/s1': 400 }
        );

        const module = await import('./api');

        await expect(module.updateSession('s1', { agent_models: {} })).rejects.toThrow('That model is not available.');
    });
});

// R8: permanent session removal. One DELETE on `/v1/harness/sessions/{session_id}`, no
// body, and a 404 keeps surfacing the server's own message so the shell can recognise
// "Unknown session" as already-gone rather than inventing a second route.
describe('session deletion', () => {
    it('sends DELETE /sessions/{id} with no body and answers the disposal receipt', async () => {
        const receipt = { deleted: true, session_id: 'a/b', aborted_turns: 1, dropped_queued_tasks: 0 };
        serve({ 'DELETE /v1/harness/sessions/a%2Fb': receipt });

        const module = await import('./api');

        expect(await module.deleteSession('a/b')).toEqual(receipt);
        expect(calls).toEqual([
            { method: 'DELETE', url: '/v1/harness/sessions/a%2Fb', body: undefined, keepalive: undefined }
        ]);
    });

    it('surfaces the server 404 message for an unknown session', async () => {
        serve(
            { 'DELETE /v1/harness/sessions/s1': { error: { message: 'Unknown session "s1".' } } },
            { 'DELETE /v1/harness/sessions/s1': 404 }
        );

        const module = await import('./api');

        // Unlike a harness delete, a session DELETE does not accept the 404: the caller
        // decides whether "unknown" is already-gone, because a rail row can be stale.
        await expect(module.deleteSession('s1')).rejects.toThrow('Unknown session "s1".');
    });
});

// T4/R2: the card/definition -> descriptor mapper. The rail and the configuration dialog
// render ONE camelCase shape, and the identity-colour map is the third optional field of
// the identified read (`agent_colors`, ../shared/harness-api.ts:459). Two facts the shell
// depends on: a stated map arrives mapped and copied, and an unstated one stays ABSENT — a
// fabricated `{}` would make every CARD claim "nothing is coloured", which is a different
// statement than not publishing the field at all (../shared/harness-api.ts:422).
describe('descriptor rows', () => {
    // A contract CARD: identity and team, and nothing else. Typed as a plain record so a
    // case can also read the field back off the object it handed in.
    const card = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
        name: 'painted',
        title: 'Painted',
        description: 'A harness with configured colours.',
        requires_endpoint: true,
        primary: 'instruct',
        subagents: ['summarizer'],
        agents: ['instruct', 'summarizer'],
        tools: ['read'],
        builtin: true,
        definition_revision: 3,
        ...overrides
    });

    it('maps agent_colors onto agentColors on an identified definition, copying the map', async () => {
        const module = await import('./api');
        const definition = card({
            agent_colors: { instruct: '#ff6600', summarizer: '#4ade80' },
            agent_models: { instruct: 'gpt-5' },
            core_tools: ['task']
        });
        const view = module.descriptorOf(definition as never);

        expect(view.agentColors).toEqual({ instruct: '#ff6600', summarizer: '#4ade80' });
        // The rest of the row is unmoved by the new field.
        expect(view.name).toBe('painted');
        expect(view.agentModels).toEqual({ instruct: 'gpt-5' });
        expect(view.coreTools).toEqual(['task']);

        // A COPY, not the wire object: writing through the view cannot rewrite the response
        // body another caller may still be holding.
        (view.agentColors as Record<string, string>).instruct = '#000000';

        expect(definition.agent_colors).toEqual({ instruct: '#ff6600', summarizer: '#4ade80' });
        expect(view.agentColors).toEqual({ instruct: '#000000', summarizer: '#4ade80' });
    });

    it('leaves agentColors absent for a card row, and reads a null wire field as no colours', async () => {
        const module = await import('./api');

        // The common case: a CARD never publishes the field, and the mapper must not invent
        // one. `contract.ts` already reads an absent map as "nothing configured".
        expect(Object.prototype.hasOwnProperty.call(module.descriptorOf(card() as never), 'agentColors')).toBe(false);

        // A JSON `null` is not a map. The mapper keeps the sibling behaviour (a non-undefined
        // value spreads into an empty map), and the accessor the panes actually read turns that
        // into the same "nothing configured" answer as an absent key — which is the fact that
        // decides what gets painted, so that is what is pinned here.
        const { agentColorsOf } = await import('./contract');
        const nulled = module.descriptorOf(card({ agent_colors: null }) as never);

        expect(agentColorsOf(nulled)).toEqual({});

        // An EMPTY map IS information ("this definition states every member is uncoloured"),
        // so it survives as an empty own map rather than vanishing.
        const cleared = module.descriptorOf(card({ agent_colors: {} }) as never);

        expect(Object.prototype.hasOwnProperty.call(cleared, 'agentColors')).toBe(true);
        expect(cleared.agentColors).toEqual({});
    });
});

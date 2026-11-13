// @vitest-environment-options {"url": "https://underloadjs.github.io/harness/"}
//
// The GitHub Pages deployment: how the client finds the harness server.
//
// THE BUG THIS PINS (the Pages deployment being offline): ci.yml publishes
// src/frontend/dist to https://underloadjs.github.io/harness/, a host that serves
// the bundle and no API. The client's documented fallback root is the
// origin-relative `/api`, so every request landed on github.io's 404 HTML page and
// the UI reported "The harness server returned a non-JSON response". The fix is the
// compiled local/LAN chain in ./deployment.ts, probed in order by `ensureApiRoot`
// (localhost first, then the standard LAN host), plus the https-Pages entry in the
// service's Origin gate.
//
// This file runs on a Pages URL (the docblock on line 1), because the whole
// behaviour is keyed on the page's own host: jsdom's `location` cannot be
// reassigned or redefined, so the host is set per file rather than per test. The
// sibling ./api.test.ts keeps the loopback host and pins that this chain never
// engages off Pages.
//
// The chain is the LAST automatic source. Anything the reader saves in the Endpoint &
// model dialog ("Harness server URL", ./api.ts `API_ROOT_STORAGE_KEY`) is step 2 of the
// ladder and therefore silences the probe here — which is the point of the setting on a
// host that has no API of its own.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    HARNESS_PAGE_LIMIT,
    HARNESS_SERVICE_CAPABILITIES,
    HARNESS_SERVICE_LIMITS
} from '../shared/harness-api';
import { LOCAL_AREA_NETWORK_HOST_NAME, STATIC_API_CANDIDATES, isStaticPagesHost } from './deployment';
import { API_ROOT_STORAGE_KEY } from './api';

// One harness definition, as the canonical `GET /harnesses` page publishes it: the
// contract's resources are snake_case (../shared/harness-api.ts), so the card spells
// `requires_endpoint`/`definition_revision` and the shell's `descriptorOf`
// (./api.ts:1203) is what turns it back into the camelCase view the UI renders.
const card = {
    name: 'demo',
    title: 'Demo',
    description: 'demo preset',
    requires_endpoint: false,
    primary: 'demo',
    subagents: [],
    agents: ['writer'],
    tools: [],
    builtin: true,
    definition_revision: 1
};

// The exact view `descriptorOf(card)` produces — the value `loadBootstrap().presets`
// must carry when the boot documents came from the probed gateway.
const cardView = {
    name: 'demo',
    title: 'Demo',
    description: 'demo preset',
    requiresEndpoint: false,
    primary: 'demo',
    subagents: [],
    agents: ['writer'],
    tools: [],
    builtin: true,
    definitionRevision: 1
};

const defaults = { base_url: 'http://provider/v1', model: 'm1', has_api_key: false };

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

// One page of a canonical collection (shared/harness-api.ts page envelope: `items`,
// `limit`, `next_cursor`, `observed_at`, `revision`). Every catalogue here is empty
// except the harness list, because the assertion is about WHICH root answered.
const pageOf = <T>(items: T[]): Response =>
    json({ items, limit: HARNESS_PAGE_LIMIT.default, next_cursor: null, observed_at: 1_700_000_000_000, revision: 1 });

// Stand in for the gateway(s) a Pages page may dial. Every root in `live` answers its
// health probe and the whole boot control plane the shell dials on that root (the
// service document, the global config and one page per catalogue — ./api.ts
// `loadBootstrap`); every other URL — including a root that is NOT live — rejects the
// way an unlistened port or a blocked mixed-content request does, with a network error
// rather than an HTTP status. A path the gateway knows nothing about still gets the
// service's own 404, so a request aimed at the wrong root cannot pass silently.
const stubGateways = (live: readonly string[]): string[] => {
    const calls: string[] = [];

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            calls.push(url);

            const root = live.find((candidate) => url === candidate || url.startsWith(`${candidate}/`));

            if (root === undefined) throw new TypeError('Failed to fetch');

            if (url === `${root}/health`) {
                expect((init?.headers as Record<string, string>)['X-Harness-Client']).toBe('ui');

                return json({ ok: true, sessions: 0 });
            }

            // The page reads carry a `?limit=` (`pageParams` in ./api.ts: the collections at the
            // default, the tools catalogue at the contract's maximum — R4). The ROUTE is what
            // this stub dispatches on, so the query is dropped before matching, and every page
            // it answers is final (`next_cursor: null`), so no cursor walk starts here.
            const path = url.slice(root.length).split('?')[0];

            if (path === '') {
                return json({
                    api_root: root,
                    service: 'harness',
                    api_version: 'v1',
                    server_time: 1_700_000_000_000,
                    epoch: 'test-epoch',
                    capabilities: HARNESS_SERVICE_CAPABILITIES,
                    limits: HARNESS_SERVICE_LIMITS,
                    links: {}
                });
            }

            if (path === '/config') {
                return json({
                    defaults,
                    writable_fields: ['settings.base_url', 'settings.model', 'settings.api_key'],
                    revision: 1
                });
            }

            if (path === '/harnesses') return pageOf([card]);
            if (path === '/tools' || path === '/agents' || path === '/sessions') return pageOf([]);

            return json({ error: { message: 'Unknown API route.' } }, 404);
        })
    );

    return calls;
};

beforeEach(() => {
    vi.resetModules();
    // The saved "Harness server URL" (./api.ts `API_ROOT_STORAGE_KEY`) is step 2 of the
    // ladder, so a leaked entry would pin the root of the NEXT test and silence the
    // probe it is meant to exercise. The URL is reset for the same reason: several tests
    // below put `?apiRoot=` in the address bar.
    localStorage.clear();
    window.history.replaceState(null, '', '/harness/');
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

describe('the Pages host', () => {
    it('is detected from the page hostname alone', () => {
        expect(isStaticPagesHost()).toBe(true);
    });

    it('dials the local gateway first and the standard LAN host last', () => {
        // The exact chain, pinned here so a change to ./deployment.ts is a
        // deliberate act: localhost before 127.0.0.1 (the gateway binds IPv4 while a
        // Windows browser prefers ::1 for `localhost`), and the LAN host last so a
        // machine with its own server never reads a stale shared transcript.
        expect([...STATIC_API_CANDIDATES]).toEqual([
            'http://localhost:5000/v1/harness',
            'http://127.0.0.1:5000/v1/harness',
            `http://${LOCAL_AREA_NETWORK_HOST_NAME}:5000/v1/harness`
        ]);
        expect(LOCAL_AREA_NETWORK_HOST_NAME).toBe('192.168.50.109');
    });

    it('replaces the origin-relative /api fallback with the chain', async () => {
        // `/api` on github.io is a guaranteed 404, so it must not be the default here.
        const calls = stubGateways([STATIC_API_CANDIDATES[0]]);
        const module = await import('./api');

        expect(module.API_ROOT).toBe(STATIC_API_CANDIDATES[0]);
        expect(module.apiRootCandidates()).toEqual(STATIC_API_CANDIDATES);
        // Resolution alone makes no request: only `ensureApiRoot`/`loadBootstrap` probes.
        expect(calls).toEqual([]);
    });
});

describe('ensureApiRoot on a Pages host', () => {
    it('keeps the first gateway that answers and routes the catalogue through it', async () => {
        // The common Pages case on a dev laptop: nothing on `localhost` (the gateway
        // binds IPv4 while the browser prefers ::1), everything on `127.0.0.1`.
        const live = STATIC_API_CANDIDATES[1];
        const calls = stubGateways([live]);

        const module = await import('./api');
        const root = await module.ensureApiRoot();

        expect(root).toBe(live);
        expect(module.API_ROOT).toBe(live);

        // Probed in order: the first candidate refused, the second answered.
        expect(calls).toEqual([`${STATIC_API_CANDIDATES[0]}/health`, `${live}/health`]);

        const bootstrap = await module.loadBootstrap();

        expect(bootstrap.presets).toEqual([cardView]);
        expect(bootstrap.defaults).toEqual(defaults);

        // T17: the boot is one round of canonical control-plane reads (service document,
        // global config, one page per catalogue), and EVERY one of them is dialled on the
        // root the probe pinned — not on github.io, and not on the candidate that never
        // answered. The chain is walked again inside `loadBootstrap` (./api.ts:1297),
        // because `ensureApiRoot` re-walks rather than memoising; the second walk stops at
        // the same winner, so no request below ever leaves `live`.
        expect(calls.filter((call) => call.endsWith('/health'))).toEqual([
            `${STATIC_API_CANDIDATES[0]}/health`,
            `${live}/health`,
            `${STATIC_API_CANDIDATES[0]}/health`,
            `${live}/health`
        ]);
        expect(calls.filter((call) => !call.endsWith('/health'))).toEqual([
            live,
            `${live}/config`,
            `${live}/harnesses?limit=${HARNESS_PAGE_LIMIT.default}`,
            // R4 (Tools Catalogue): the tools page is dialled at the contract's MAXIMUM size
            // and followed to the end, so a catalogue larger than a default page reaches the
            // Tools view complete.
            `${live}/tools?limit=${HARNESS_PAGE_LIMIT.max}`,
            `${live}/agents?limit=${HARNESS_PAGE_LIMIT.default}`,
            `${live}/sessions?limit=${HARNESS_PAGE_LIMIT.default}`
        ]);
        expect(calls).toContain(live);
    });

    it('falls through to the LAN host when nothing local answers', async () => {
        const live = STATIC_API_CANDIDATES[2];
        const calls = stubGateways([live]);

        const module = await import('./api');

        expect(await module.ensureApiRoot()).toBe(live);
        expect(calls).toEqual(STATIC_API_CANDIDATES.map((root) => `${root}/health`));
    });

    it('stays on the local root when no gateway answers, so the offline pane names it', async () => {
        stubGateways([]);

        const module = await import('./api');

        expect(await module.ensureApiRoot()).toBe(STATIC_API_CANDIDATES[0]);
        expect(module.API_ROOT).toBe(STATIC_API_CANDIDATES[0]);

        // The failure the shell renders is the transport error, and the pane lists
        // the whole chain (main.ts `showOffline` + `apiRootCandidates`). The root
        // stays the local gateway because starting a server there is the action
        // that fixes it.
        await expect(module.loadBootstrap()).rejects.toThrow('The harness server is unreachable');
    });

    it('ignores a 200 that is not the health contract', async () => {
        // A captive portal or a proxy error page answers HTML with a success status;
        // only `{ ok: true }` may pin a root.
        const calls: string[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input);
                calls.push(url);

                return url.endsWith('/health')
                    ? new Response('<!doctype html><h1>Portal</h1>', { status: 200, headers: { 'Content-Type': 'text/html' } })
                    : json(bootstrapBody);
            })
        );

        const module = await import('./api');

        expect(await module.ensureApiRoot()).toBe(STATIC_API_CANDIDATES[0]);
        expect(calls).toEqual(STATIC_API_CANDIDATES.map((root) => `${root}/health`));
    });
});

describe('a pinned root on a Pages host', () => {
    it('disables the probe entirely', async () => {
        window.history.replaceState(null, '', '/harness/?apiRoot=%2Fv1%2Fharness');
        const calls = stubGateways([STATIC_API_CANDIDATES[0]]);

        const module = await import('./api');

        expect(module.API_ROOT).toBe('/v1/harness');
        expect(module.apiRootCandidates()).toEqual([]);
        expect(await module.ensureApiRoot()).toBe('/v1/harness');
        // No health request: a deliberate root is never replaced by a guess.
        expect(calls).toEqual([]);
    });

    it('trusts a runtime root that names a compiled candidate exactly', async () => {
        // The LAN entry is neither same-origin nor loopback, so the runtime trust
        // rule would refuse it — but it is operator data baked into this bundle, so
        // selecting it by hand is no wider a trust than dialing it by default.
        const lan = STATIC_API_CANDIDATES[2];
        window.history.replaceState(null, '', `/harness/?apiRoot=${encodeURIComponent(lan)}`);

        const module = await import('./api');

        expect(module.API_ROOT).toBe(lan);
        expect(module.apiRootCandidates()).toEqual([]);
    });

    it('still refuses a foreign runtime root', async () => {
        // The saved provider key may not be pushed to an arbitrary host by a link.
        window.history.replaceState(null, '', '/harness/?apiRoot=https%3A%2F%2Fevil.example%2Fapi');
        stubGateways([STATIC_API_CANDIDATES[0]]);

        const module = await import('./api');

        expect(module.API_ROOT).toBe(STATIC_API_CANDIDATES[0]);
    });

    it('honours a saved server URL and silences the chain', async () => {
        // The dialog's "Harness server URL" outranks the Pages chain, and a host that is
        // NEITHER same-origin NOR loopback is still accepted: the value was typed into
        // this browser, so the provider key goes where the reader chose. Whether that
        // host actually answers is the service Origin gate's and the browser's decision,
        // not the resolver's.
        localStorage.setItem(API_ROOT_STORAGE_KEY, 'https://harness.example.test/v1/harness');
        const calls = stubGateways([STATIC_API_CANDIDATES[0]]);

        const module = await import('./api');

        expect(module.API_ROOT).toBe('https://harness.example.test/v1/harness');
        // No candidates and no health probe: a pinned root is never replaced by a guess.
        expect(module.apiRootCandidates()).toEqual([]);
        expect(await module.ensureApiRoot()).toBe('https://harness.example.test/v1/harness');
        expect(calls).toEqual([]);
    });

    it('lets a saved rooted path beat the chain and dial the Pages origin itself', async () => {
        // The other thing the setting is for on Pages: pointing the UI at a proxy that
        // answers `/api` on the SAME host. A rooted path is same-origin by construction,
        // so it pins without a probe exactly as `?apiRoot=/v1/harness` does.
        localStorage.setItem(API_ROOT_STORAGE_KEY, '/api');
        const calls = stubGateways([STATIC_API_CANDIDATES[0]]);

        const module = await import('./api');

        expect(module.API_ROOT).toBe('/api');
        expect(module.apiRootCandidates()).toEqual([]);
        expect(await module.ensureApiRoot()).toBe('/api');
        expect(calls).toEqual([]);
    });

    it('prefers a build-time VITE_HARNESS_API over the chain', async () => {
        vi.stubEnv('VITE_HARNESS_API', 'https://api.example.test/v1/harness');
        const calls = stubGateways([]);

        const module = await import('./api');

        expect(module.API_ROOT).toBe('https://api.example.test/v1/harness');
        expect(await module.ensureApiRoot()).toBe('https://api.example.test/v1/harness');
        expect(calls).toEqual([]);
    });
});

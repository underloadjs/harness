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
// Run: npx vitest run --config src/frontend/vitest.config.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_AREA_NETWORK_HOST_NAME, STATIC_API_CANDIDATES, isStaticPagesHost } from './deployment';

const descriptor = {
    name: 'demo',
    title: 'Demo',
    description: 'demo preset',
    requiresEndpoint: false,
    agents: ['writer'],
    tools: []
};

const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };

const bootstrapBody = { rootPath: 'D:/repo', presets: [descriptor], tools: [], defaults, sessions: [] };

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

// Stand in for the gateway(s) a Pages page may dial. Every root in `live` answers
// its health probe and its bootstrap document; every other URL — including a root
// that is NOT live — rejects the way an unlistened port or a blocked mixed-content
// request does, with a network error rather than an HTTP status.
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

            if (url === root) return json(bootstrapBody);

            return json({ error: { message: 'Unknown API route.' } }, 404);
        })
    );

    return calls;
};

beforeEach(() => {
    vi.resetModules();
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

        // Probed in order, and every later request follows the winner.
        expect(calls).toEqual([`${STATIC_API_CANDIDATES[0]}/health`, `${live}/health`]);

        const bootstrap = await module.loadBootstrap();

        expect(bootstrap.presets).toEqual([descriptor]);
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

    it('prefers a build-time VITE_HARNESS_API over the chain', async () => {
        vi.stubEnv('VITE_HARNESS_API', 'https://api.example.test/v1/harness');
        const calls = stubGateways([]);

        const module = await import('./api');

        expect(module.API_ROOT).toBe('https://api.example.test/v1/harness');
        expect(await module.ensureApiRoot()).toBe('https://api.example.test/v1/harness');
        expect(calls).toEqual([]);
    });
});

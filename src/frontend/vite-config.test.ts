// Regression tests for the dev-server `/api` proxy and its dual-stack binding.
//
// Three failures are pinned here:
//
// 1. `main.ts` imports `./api`, which Vite rewrites to `/api.ts`. A plain
//    `'/api'` proxy prefix captured that source module and answered it with the
//    upstream's connection error, so the entry module graph never ran and
//    `showOffline` could not render. The proxy key must only match the API mount.
//
// 2. With the dev server exposed to the LAN, a LAN browser sends a non-loopback
//    Origin. `changeOrigin` rewrites Host to 127.0.0.1:5000, but the forwarded
//    Origin stayed `http://<LAN-IP>:<port>`, so the harness service gate
//    (../server/service.ts `isAllowedOrigin`) answered 403. The proxy now stamps
//    the target origin on the outgoing request. The roundtrip test below starts a
//    real Vite server on an ephemeral port against a loopback fixture and proves
//    the fixture sees matching Host/Origin plus the rewritten path.
//
// 3. The bind was IPv4-only (`0.0.0.0`) while Vite printed
//    `Local: http://localhost:<port>`. `dns.lookup('localhost')` returns `::1`
//    (family 6) first on Windows, so a client that dials `::1` was refused while
//    the printed `Network` URL worked — and if another process owned `::1:<port>`
//    the browser got THAT server's 404 instead of the harness. The dev binding is
//    now the `::` wildcard, which Node opens dual-stack, so one listener answers
//    both loopback families and the LAN address. The roundtrip test dials both
//    loopback addresses with a `localhost` Host header, exactly as a browser on
//    this machine does.
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer as createViteServer } from 'vite';
import {
    API_PROXY_KEY,
    DEFAULT_DEV_API,
    DEV_SERVER_HOST,
    apiProxyRoutes,
    createApiProxy,
    createApiProxyRoutes
} from './vite-proxy';

// Every test that starts real servers removes its cache directory. The array is
// only populated by helper code that reached the start step, so a failed setup
// cannot leak a temp directory past the suite.
const cacheDirectories: string[] = [];

afterEach(() => {
    while (cacheDirectories.length > 0) {
        const directory = cacheDirectories.pop();
        if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
    }
});

// Raw node:http request (not fetch): the jsdom test environment can shadow the
// global fetch, while this needs explicit Host control, a chosen address family
// (the `host` argument is a literal, never resolved) and a bounded body.
const requestThrough = (
    host: string,
    port: number,
    path: string,
    headers: Record<string, string>
): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
        const request = httpRequest(
            {
                host,
                port,
                path,
                method: 'GET',
                headers
            },
            (response) => {
                let body = '';
                response.setEncoding('utf8');
                response.on('data', (chunk: string) => {
                    body += chunk;
                });
                response.on('end', () => {
                    resolve({ status: response.statusCode ?? 0, body });
                });
            }
        );

        request.on('error', reject);
        request.end();
    });

describe('vite API proxy', () => {
    it('proxies /api and /api/... but never the api.ts source module', () => {
        const pattern = new RegExp(API_PROXY_KEY);

        // The mount and every route under it still reach the upstream.
        expect(
            ['/api', '/api/', '/api/harnesses', '/api/sessions/x', '/api/models'].map((path) => pattern.test(path))
        ).toEqual([true, true, true, true, true]);

        // `./api` (rewritten to /api.ts) and other api-prefixed modules stay on
        // Vite. The old `'/api'` prefix matched all of these.
        expect(['/api.ts', '/apiRoot', '/main.ts', '/v1/harness', '/'].map((path) => pattern.test(path))).toEqual([
            false,
            false,
            false,
            false,
            false
        ]);
    });

    it('applies the anchored key to both dev and preview through one route map', () => {
        expect(API_PROXY_KEY).toBe('^/api(?:/|$)');
        expect(Object.keys(apiProxyRoutes)).toEqual(['^/api(?:/|$)']);

        // Factory output is deterministic: the shell environment cannot change
        // what this test pins. The config passes HARNESS_DEV_API into the same
        // factory, so this is the route shape both launch modes install.
        const routes = createApiProxyRoutes(DEFAULT_DEV_API);
        expect(Object.keys(routes)).toEqual([API_PROXY_KEY]);

        const route = routes[API_PROXY_KEY];
        const mount = createApiProxy(DEFAULT_DEV_API);

        expect(route.target).toBe(mount.target);
        expect(route.changeOrigin).toBe(true);
        expect(DEFAULT_DEV_API).toBe('http://127.0.0.1:5000/v1/harness');
        expect(route.target).toBe('http://127.0.0.1:5000');

        // The outgoing Origin must equal the target origin; with changeOrigin
        // rewriting Host, this is what makes the harness gate see same-origin.
        expect(route.headers).toEqual({ origin: 'http://127.0.0.1:5000' });

        // The rewrite still maps the browser's `/api` onto the service mount.
        expect(route.rewrite('/api')).toBe('/v1/harness');
        expect(route.rewrite('/api/sessions')).toBe('/v1/harness/sessions');
    });

    it('stamps the target origin for a custom mount and port', () => {
        // The standalone API launcher is the documented HARNESS_DEV_API target.
        // A custom origin must be stamped as-is, including its port, while the
        // mount and target keep the usual trailing-slash normalization.
        const proxy = createApiProxy('https://harness.example.test:8443/custom/api/');

        expect(proxy).toMatchObject({
            target: 'https://harness.example.test:8443',
            changeOrigin: true,
            headers: { origin: 'https://harness.example.test:8443' }
        });
        expect(proxy.rewrite('/api/sessions')).toBe('/custom/api/sessions');
        expect(proxy.rewrite('/api')).toBe('/custom/api');
    });
});

describe('dev server dual-stack LAN binding', () => {
    it('binds the :: wildcard and serves both loopback families plus a LAN origin', async () => {
        // The shared constant is the value `vite.config.ts` puts in
        // `server.host`; preview is deliberately untouched and stays loopback.
        // `::` is Vite's IPv6 wildcard, which Node opens dual-stack: the IPv4-only
        // `0.0.0.0` value refused `::1`, and that is the address `localhost`
        // resolves to first here.
        expect(DEV_SERVER_HOST).toBe('::');

        // Loopback fixture stands in for the service mount. It records exactly
        // what the Vite proxy sent, so a wrong Origin or Host fails the test.
        const observed: Array<{ url?: string; host?: string; origin?: string }> = [];
        const backend = createHttpServer((request, response) => {
            observed.push({
                url: request.url,
                host: request.headers.host,
                origin: request.headers.origin
            });
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ ok: true }));
        });

        await new Promise<void>((resolve, reject) => {
            backend.once('error', reject);
            backend.listen(0, '127.0.0.1', () => resolve());
        });

        const backendPort = (backend.address() as AddressInfo).port;
        const backendOrigin = `http://127.0.0.1:${backendPort}`;
        // Real Vite cache directory, isolated and removed by afterEach. Use the
        // OS temp root here (not the repo) because this is throwaway server state,
        // not an agent scratch probe.
        const cacheDirectory = mkdtempSync(join(tmpdir(), 'harness-vite-config-'));
        cacheDirectories.push(cacheDirectory);

        let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;

        try {
            vite = await createViteServer({
                configFile: false,
                // Vitest's import.meta.url is not a file URL, so use the test
                // process cwd. This proxy roundtrip serves no application files;
                // any existing directory is enough for Vite's root.
                root: process.cwd(),
                cacheDir: cacheDirectory,
                logLevel: 'silent',
                appType: 'custom',
                server: {
                    // Same host the production config sets (imported constant);
                    // port 0 keeps the test off the user's :5180 dev server.
                    host: DEV_SERVER_HOST,
                    port: 0,
                    strictPort: false,
                    proxy: createApiProxyRoutes(`${backendOrigin}/v1/harness`)
                }
            });

            await vite.listen();

            const address = vite.httpServer?.address() as AddressInfo;
            // Port 0 asked the OS for an ephemeral port. Assert the bind Vite
            // actually made: the IPv6 wildcard (dual-stack), not IPv4 or a
            // single loopback address.
            expect(address.address).toBe('::');
            expect(address.family).toBe('IPv6');
            expect(Number.isInteger(address.port) && address.port > 0).toBe(true);

            const port = address.port;

            // A browser on this machine opens either loopback form for the same
            // printed `Local` URL, so both families must reach THIS server and
            // proxy. The Host header is the `localhost:<port>` a localhost page
            // sends; `origin` is the loopback page origin, which the proxy must
            // replace with the target's.
            const loopback = `/api/health?probe=1`;
            const viaIpv4 = await requestThrough('127.0.0.1', port, loopback, {
                host: `localhost:${port}`,
                origin: `http://localhost:${port}`
            });
            const viaIpv6 = await requestThrough('::1', port, loopback, {
                host: `localhost:${port}`,
                origin: `http://localhost:${port}`
            });

            // This is what a browser at http://192.168.1.20:<port> sends when the
            // page calls a relative `/api`. Vite must accept the request and the
            // upstream must see the target origin + target Host, not the LAN one.
            const viaLan = await requestThrough('127.0.0.1', port, loopback, {
                origin: 'http://192.168.1.20:5181'
            });

            expect(viaIpv4).toEqual({ status: 200, body: '{"ok":true}' });
            expect(viaIpv6).toEqual({ status: 200, body: '{"ok":true}' });
            expect(viaLan).toEqual({ status: 200, body: '{"ok":true}' });

            // One entry per request, in order; every one carries the rewritten
            // mount path plus the target Host/Origin pair the gate compares.
            expect(observed).toEqual([
                {
                    url: '/v1/harness/health?probe=1',
                    host: `127.0.0.1:${backendPort}`,
                    origin: backendOrigin
                },
                {
                    url: '/v1/harness/health?probe=1',
                    host: `127.0.0.1:${backendPort}`,
                    origin: backendOrigin
                },
                {
                    url: '/v1/harness/health?probe=1',
                    host: `127.0.0.1:${backendPort}`,
                    origin: backendOrigin
                }
            ]);
        } finally {
            if (vite !== undefined) await vite.close();
            await new Promise<void>((resolve, reject) => {
                backend.close((error) => (error ? reject(error) : resolve()));
            });
        }
    }, 30_000);
});

// The `/api` dev/preview proxy, kept out of `vite.config.ts` so it can be unit
// tested without evaluating the whole Vite config (whose `import.meta.url` root
// is not a file URL under Vitest).
//
// Both `yarn dev:frontend` and `yarn preview:frontend` use this single factory,
// so the two launch modes can never drift onto different APIs.

// Where the harness API lives during UI development. The service gateway is the
// normal host; the optional standalone launcher (`yarn dev:server`) serves the
// same API at `/api` on :5181. Set HARNESS_DEV_API to that mount to develop the
// UI against it without changing the client:
//
//     HARNESS_DEV_API=http://127.0.0.1:5181/api yarn dev:frontend
//
// LAN development (R7/R8): the dev server binds the dual-stack wildcard, so a
// phone/another machine loads the page from `http://<LAN-IP>:<printed port>/`. The
// browser then
// sends its own non-loopback `Origin` to Vite, and Vite's server-to-server proxy
// request would forward that Origin while `changeOrigin` rewrites Host to the
// target. The harness service gate (../server/service.ts, `isAllowedOrigin`)
// requires Origin host === request Host, so the forwarded LAN Origin was a 403.
//
// The proxy therefore stamps the TARGET origin on every outgoing request. Host
// and Origin then agree at the service (or standalone API) and the existing gate
// passes without relaxing it. This header rewrite is local to the Vite proxy: it
// does not broaden the service's Origin/CORS trust, and a browser outside this
// proxy still gets the original gate. Do not remove this when changing the
// target: any HARNESS_DEV_API mount (http or https, any host/port) must stamp its
// own `URL.origin` so origin and Host stay a pair.
export const DEFAULT_DEV_API = 'http://127.0.0.1:5000/v1/harness';

// LAN + loopback opt-in for `yarn dev:frontend` (R7, R11). Lives beside the proxy
// config helpers because `vite.config.ts` cannot be imported by Vitest (its
// `import.meta.url` root is not a file URL under the test runner). The regression
// test starts a real Vite server with this value; the config uses the same
// constant.
//
// `'::'` is Vite's IPv6 wildcard host — a member of Vite's internal
// `wildcardHosts` set, so the banner still prints `Local: http://localhost:<port>`
// plus the IPv4 `Network:` URLs (vite/dist/node/chunks/node.js
// `resolveServerUrls`, `resolveHostname`). Node binds that host dual-stack
// (`ipv6Only` defaults to false), so the ONE listener answers `127.0.0.1`, `::1`
// AND the LAN IPv4 address.
//
// Why dual-stack and not `0.0.0.0` (the previous value): `localhost` is not
// necessarily IPv4. `dns.lookup('localhost', { all: true })` on Windows returns
// `::1` (family 6) first, and browsers prefer it, so an IPv4-only bind left the
// advertised `Local` URL pointing at a family nothing served. Two observed
// outcomes (2026-10-29, this machine):
//   - nothing on `::1:<port>` -> `localhost` answers ECONNREFUSED while the
//     printed `Network` URL works;
//   - another process already on `::1:<port>` (a stale Vite dev server from a
//     different config) -> `localhost` reaches THAT process, which answered 404,
//     while `http://<LAN-IP>:5180/` served the harness UI. Windows allows the
//     overlapping bind (IPv4 wildcard + IPv6 specific) without any error, so Vite
//     never fell forward and the printed `Local` line was simply false.
// Dual-stack keeps the advertised loopback URL true with no second listener and
// no widened trust: only the dev workflow listens here, and preview stays pinned
// to loopback in `vite.config.ts`.
//
// Caveat: this requires an enabled IPv6 stack (default on Windows/macOS/Linux).
// On an IPv6-disabled host the bind fails loudly instead of silently serving
// half the port — and that is also the only case where `localhost` cannot
// resolve to `::1`, so no loopback family is lost.
//
// Limit, measured with a live probe on Windows: a listener that already holds
// `::1:<port>` (e.g. a stale dev server from another project) keeps that traffic
// even after this dual-stack bind succeeds — a specific address wins over a later
// wildcard bind and Windows reports no EADDRINUSE for the pair. No host option can
// reclaim it, so when `Local` still fails after restart the fix is to stop the
// foreign owner (README “LAN development” has the port check), not to change this
// value.
export const DEV_SERVER_HOST = '::';

export type ApiProxy = {
    target: string;
    // Rewrites the outgoing Host header to the target (http-proxy semantics).
    changeOrigin: boolean;
    // Overrides request headers on the proxied request. `origin` is the target's
    // URL.origin, making the request same-origin for the harness gate.
    headers: { origin: string };
    rewrite: (path: string) => string;
};

// The `/api` proxy must match the API mount, not every module whose filename
// begins with "api". `main.ts` imports `./api` (the browser client), which Vite
// rewrites to `/api.ts`; with a plain `'/api'` prefix the proxy intercepted that
// source module and answered it with the upstream's connection error, so the
// whole entry module graph failed and the page stayed blank — even though the
// offline pane in main.ts (`showOffline`) was ready to render. Anchoring the
// match to "/api" alone or "/api/..." keeps `/api.ts` (and any other `api*`
// module) on the Vite side. Vite treats a proxy key starting with `^` as a
// RegExp (https://vite.dev/config/server-options#server-proxy).
export const API_PROXY_KEY = '^/api(?:/|$)';

// Build the `/api` proxy from one mount base. The browser always asks for
// `/api/...`; the target's path is the server's mount, so the same helper serves
// both hosts:
//
//   http://127.0.0.1:5000/v1/harness -> /api/health => /v1/harness/health
//   http://127.0.0.1:5181/api        -> /api/health => /api/health
//
// Validated once here because this value ends up as every UI request's target.
// A trailing slash is normalized away so the default does not produce `//`.
export const createApiProxy = (base: string): ApiProxy => {
    let url: URL;

    try {
        url = new URL(base);
    } catch {
        throw new Error(`HARNESS_DEV_API is not a valid URL: ${base}`);
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('HARNESS_DEV_API must be an http(s) URL.');
    }

    if (url.search.length > 0 || url.hash.length > 0) {
        throw new Error('HARNESS_DEV_API cannot carry a query string or a fragment.');
    }

    const mount = url.pathname.replace(/\/+$/, '');
    // `URL.origin` is scheme + host + non-default port, exactly the value the
    // service gate compares with the outgoing Host header. Using `url.host`
    // directly keeps the target and header in lockstep for custom ports too.
    const origin = `${url.protocol}//${url.host}`;

    return {
        target: origin,
        changeOrigin: true,
        headers: { origin },
        rewrite: (path: string) => path.replace(/^\/api/, mount)
    };
};

// One route map for both launch modes. Exposed as a factory so a test can pin the
// default target without depending on the shell's HARNESS_DEV_API.
export const createApiProxyRoutes = (base: string = DEFAULT_DEV_API): Record<string, ApiProxy> => ({
    [API_PROXY_KEY]: createApiProxy(base)
});

// The routes the Vite config actually installs. Kept at module scope so dev and
// preview share the exact same object (and therefore the same target/rewrite).
export const apiProxyRoutes: Record<string, ApiProxy> = createApiProxyRoutes(
    process.env.HARNESS_DEV_API?.trim() || DEFAULT_DEV_API
);

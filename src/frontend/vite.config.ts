// Vite config for the harness UI application build and dev server.
//
// Three consumers:
//   - `yarn build:frontend` emits src/frontend/dist, which a single-process host
//     may serve statically (see ../server/start.ts `staticRoot`).
//   - `yarn dev:frontend` runs ONLY Vite. It never imports or starts the harness
//     server; the API is expected to already be running, normally as the
//     @underload/service gateway on :5000 (`yarn start-service` at the repo root).
//   - `yarn preview:frontend` serves the built UI with the same `/api` proxy.
//
// The UI is a browser client only: it calls the API, and the server owns every
// harness. Both dev and preview therefore rewrite the client's default `/api`
// root onto `HARNESS_DEV_API` (default: the service mount
// `http://127.0.0.1:5000/v1/harness`). A page-level `?apiRoot=` or a build-time
// `VITE_HARNESS_API` still replaces this default at runtime; see
// src/frontend/api.ts `resolveApiRoot`.
//
// `base` comes from PLAYGROUND_BASE (name kept for deployment compatibility) so
// the same build can be mounted under a subpath. The UI is normally served by the
// harness server, which mounts the build at `/`.
//
// DEV BINDING (R7/R11): `yarn dev:frontend` listens dual-stack (see
// DEV_SERVER_HOST in ./vite-proxy.ts) so the machine itself can use EITHER
// `http://localhost:<port>/` or `http://127.0.0.1:<port>/` while a phone or
// another machine on the trusted LAN uses the printed Network URL
// (`http://<LAN-IP>:<port>/`). `localhost` resolves to `::1` first on Windows, so
// an IPv4-only bind made the printed `Local` line lie: either ECONNREFUSED, or —
// when another process already held `::1:<port>` — that other server's 404 while
// the LAN URL kept working. Both families must reach this listener, not just the
// LAN address. When :5180 is busy on every family Vite tries the next free port
// (commonly :5181), so use the printed port rather than assuming 5180; if
// `Local` and `Network` disagree about whether the page loads, a foreign
// process is squatting one address family on that port (README “LAN
// development” has the one-line check). Preview is intentionally unchanged
// (loopback): only the dev workflow is LAN-facing.
//
// Exposing Vite also exposes the no-auth, unsandboxed harness API through its
// `/api` proxy. Keep this on a trusted network and allow the port only there;
// README's Server and UI section documents that warning.

import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { DEV_SERVER_HOST, apiProxyRoutes } from './vite-proxy.ts';

// The proxy lives in `./vite-proxy.ts` so its routing key (which must NOT capture
// the `/api.ts` source module) is unit-testable. Re-exported here for callers that
// already import the config helpers.
export { API_PROXY_KEY, DEFAULT_DEV_API, apiProxyRoutes, createApiProxy, createApiProxyRoutes } from './vite-proxy.ts';
export type { ApiProxy } from './vite-proxy.ts';

// Normalize a deployment subpath to a leading+trailing slash. The default is
// root, which is where the static handler mounts the build.
const normalizeBase = (value: string | undefined): string => {
    if (value === undefined) return '/';

    const trimmed = value.replace(/^\/+/, '').replace(/\/+$/, '');
    return trimmed.length === 0 ? '/' : `/${trimmed}/`;
};

export default defineConfig({
    root: fileURLToPath(new URL('.', import.meta.url)),
    base: normalizeBase(process.env.PLAYGROUND_BASE),
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        sourcemap: true
    },
    // Vite only. The harness API is a separate process: normally the
    // @underload/service gateway on :5000 (`yarn start-service`). This dev server
    // answers the UI and proxies its `/api` calls; it never starts a server.
    // `host: '::'` is the LAN opt-in (R7/R11) and a dual-stack wildcard, so the
    // same listener answers `localhost` (::1), `127.0.0.1` and the LAN IPv4
    // address. Vite still falls forward from :5180 when that port is busy and
    // prints the real Network URL.
    server: {
        host: DEV_SERVER_HOST,
        port: 5180,
        proxy: apiProxyRoutes
    },
    // Vite preview inherits `server.host` when `preview.host` is unset, so pin
    // it back to loopback: only the dev workflow opts into LAN binding (R7).
    // Without this line, the wildcard `server.host` above would silently expose
    // `yarn preview:frontend` on the LAN too. Node resolves `localhost` to `::1`
    // first on Windows, so preview listens on IPv6 loopback; it is deliberately
    // NOT dual-stack, because reaching both loopback families needs a wildcard
    // bind, and a wildcard bind is exactly the LAN opt-in. Preview therefore
    // stays reachable at `http://localhost:<port>/`, the URL Vite prints for it.
    preview: {
        host: 'localhost',
        port: 5180,
        proxy: apiProxyRoutes
    }
});

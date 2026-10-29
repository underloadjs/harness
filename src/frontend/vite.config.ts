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

import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { apiProxyRoutes } from './vite-proxy.ts';

// The proxy lives in `./vite-proxy.ts` so its routing key (which must NOT capture
// the `/api.ts` source module) is unit-testable. Re-exported here for callers that
// already import the config helpers.
export {
    API_PROXY_KEY,
    DEFAULT_DEV_API,
    apiProxyRoutes,
    createApiProxy,
    createApiProxyRoutes
} from './vite-proxy.ts';
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
    server: {
        port: 5180,
        proxy: apiProxyRoutes
    },
    preview: {
        port: 5180,
        proxy: apiProxyRoutes
    }
});

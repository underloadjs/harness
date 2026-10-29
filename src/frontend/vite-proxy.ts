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
export const DEFAULT_DEV_API = 'http://127.0.0.1:5000/v1/harness';

export type ApiProxy = {
    target: string;
    changeOrigin: boolean;
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

    return {
        target: `${url.protocol}//${url.host}`,
        changeOrigin: true,
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

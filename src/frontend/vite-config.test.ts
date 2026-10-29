// Regression test for the dev-server proxy that made the UI blank when the API
// was down.
//
// `main.ts` imports `./api`, which Vite rewrites to `/api.ts`. A plain `'/api'`
// proxy prefix captured that source module and answered it with the upstream's
// connection error, so the entry module graph never ran and `showOffline` could
// not render. The proxy key must only match the API mount itself.
import { describe, expect, it } from 'vitest';
import {
    API_PROXY_KEY,
    DEFAULT_DEV_API,
    apiProxyRoutes,
    createApiProxy,
    createApiProxyRoutes
} from './vite-proxy';

describe('vite API proxy', () => {
    it('proxies /api and /api/... but never the api.ts source module', () => {
        const pattern = new RegExp(API_PROXY_KEY);

        // The mount and every route under it still reach the upstream.
        expect(
            ['/api', '/api/', '/api/harnesses', '/api/sessions/x', '/api/models'].map((path) =>
                pattern.test(path)
            )
        ).toEqual([true, true, true, true, true]);

        // `./api` (rewritten to /api.ts) and other api-prefixed modules stay on
        // Vite. The old `'/api'` prefix matched all of these.
        expect(
            ['/api.ts', '/apiRoot', '/main.ts', '/v1/harness', '/'].map((path) => pattern.test(path))
        ).toEqual([false, false, false, false, false]);
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

        // The rewrite still maps the browser's `/api` onto the service mount.
        expect(route.rewrite('/api')).toBe('/v1/harness');
        expect(route.rewrite('/api/sessions')).toBe('/v1/harness/sessions');
    });
});

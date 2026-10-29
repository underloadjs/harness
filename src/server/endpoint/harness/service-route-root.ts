// The canonical bootstrap document at GET /v1/harness.
//
// Split from `service-route.ts` because the service loader registers the literal
// `route` string with `app.all(...)`, and Hono's wildcard `/v1/harness/*` does
// not match the bare `/v1/harness` path. Both modules call the same handler
// factory, so they share the lazy runtime and its session store.
//
// GET /v1/harness answers `{ rootPath, presets, tools, defaults, sessions }`
// (see HarnessBootstrap in ../../api.ts). Any other method is a 405 and
// unknown subpaths are 404s handled by the wildcard module.
//
// Cross-references:
//   - ./service-route.ts — everything below the mount
//   - ../../api.ts — dispatch + bootstrap shape

import { createHarnessServiceHandler, SERVICE_ROOT_ROUTE } from '../../service';

export default {
    route: SERVICE_ROOT_ROUTE,
    handler: createHarnessServiceHandler()
};

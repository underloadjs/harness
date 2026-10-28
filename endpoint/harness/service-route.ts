// Every canonical harness route below `/v1/harness`.
//
// This file is discovered by @underload/service: it scans endpoint folders from
// the repository root for `service-route*.ts` modules whose default export is
// `{ route, handler }`. The loader installs `app.all(route)`, parses the body,
// and calls the handler with `(context, parameters, variables)`.
//
// No port is declared on purpose. A port would move this endpoint onto an
// isolated worker server and the gateway would answer with a 307 redirect; the
// harness API is cheap to host in-process and must share the service's single
// listener. It also must not open a listener of its own (the runtime is a store,
// not a server).
//
// Cross-references:
//   - ./service-route-root.ts — the bare `/v1/harness` bootstrap document
//   - ../../server/service.ts — adapter, origin gate, raw SSE response
//   - ../../server/runtime.ts — lazy singleton runtime created on first request
//
// The sibling root module exists because Hono's `/v1/harness/*` wildcard does
// not match the bare `/v1/harness` path; both use the same handler factory and
// therefore the same shared runtime.

import { createHarnessServiceHandler, SERVICE_WILDCARD_ROUTE } from '../../server/service';

export default {
    route: SERVICE_WILDCARD_ROUTE,
    handler: createHarnessServiceHandler()
};

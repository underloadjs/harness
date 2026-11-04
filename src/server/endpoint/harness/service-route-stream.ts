// The WebSocket stream route on the @underload/service gateway: GET /v1/harness/stream.
//
// Declared as its OWN endpoint module (rather than riding `service-route.ts`'s wildcard) for one
// mechanical reason: the loader attaches an `upgrade` handler to a DECLARED route, and an exact path
// is matched unambiguously. `/v1/harness/*` would also match this path, and letting both claim it
// would make registration order decide whether the handshake happens.
//
// Both halves of the operation live here:
//   - `upgrade`  — the real `101` handshake on the gateway's own listener (same host, same port,
//     same root; no extra port is invented), served from the SAME root-keyed runtime as REST, so the
//     epoch in `welcome` is the epoch on `X-Harness-Epoch`;
//   - `handler`  — what a plain HTTP request for this path gets: the loader still needs a handler
//     (it validates that every endpoint module has one), and a non-upgrade GET is a 400 by contract.
//
// `body: 'raw'` asks the loader to skip its pre-parse so the harness bounds the body itself while
// streaming (see ../../service.ts "BODY BOUNDS"). A stream GET has no body anyway; the flag matters
// for the sibling REST module, and keeping both modules honest is why it is declared here too.
//
// Cross-references:
//   - ../../service.ts — createHarnessServiceHandler / createHarnessServiceUpgrade / SERVICE_STREAM_ROUTE
//   - ../../stream/    — the transport, the broker, and the conversation
//   - ./service-route.ts / ./service-route-root.ts — the REST halves of the same mount

import {
    createHarnessServiceHandler,
    createHarnessServiceUpgrade,
    SERVICE_STREAM_ROUTE
} from '../../service';

export default {
    route: SERVICE_STREAM_ROUTE,
    handler: createHarnessServiceHandler(),
    upgrade: createHarnessServiceUpgrade(),
    body: 'raw' as const
};

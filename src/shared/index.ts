// Shared, isomorphic modules used by BOTH the server and the browser client.
//
// Only code that is safe to evaluate in either runtime belongs here. Today that
// is `origin.ts`: the loopback/same-origin rules are one definition shared by the
// service's inbound Origin gate (../server/service.ts) and the browser client's
// outbound API-root gate (../frontend/api.ts). Moving it out of `server/` is what
// keeps the frontend tree free of a runtime dependency on server code.
//
// Cross-references:
//   - ./origin.ts            — LOOPBACK_HOSTNAMES, isLoopbackHostname, isTrustedRuntimeOrigin
//   - ./attachments.ts       — the one attachment validator, its size constants,
//                              and the marker helper shared by composer + server
//   - ./agent-results.ts     — block labels, result-block projection, reference
//                              parsing/validation, and delimited prompt composition
//   - ../server/service.ts   — inbound gate
//   - ../frontend/api.ts     — outbound gate
//   - ../shared             — also reachable as `@underload/harness/shared`
export * from './origin';
export * from './attachments';
export * from './agent-results';

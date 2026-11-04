// The Node root of @underload/harness.
//
// `exports["."]` maps the `node`/`import` conditions here, so a Node host always
// gets the reusable server API in addition to the library:
//
//   - library      — `./harness` (harness/agent/tool + every public type)
//   - shared       — `./shared` (origin/loopback rules)
//   - server       — `./server` (startHarnessServer, runtime, service adapter,
//                    dispatcher, SessionStore, protocol, presets)
//   - frontend     — `./frontend` (browser client: api + contract + ui panels),
//                    included here because every module in it is import-safe
//                    without a DOM: no stylesheet is imported and no element is
//                    created until a function is called.
//
// IMPORT SAFETY: importing this file starts nothing. `startHarnessServer` binds a
// port only when called, and the service routes build their runtime lazily on the
// first request, so `import '@underload/harness'` never opens a listener.
//
// The browser root is `./browser.ts` (exports["."].browser): library + shared +
// frontend, never the server tree, whose `node:http` imports no browser can load.
// Node-only names are therefore absent from the browser build by design.
export * from './harness';
export * from './shared';
export * from './server';
export * from './frontend';
// The runtime and the browser client both describe pending background calls. The
// two shapes are identical and frozen (T3); the RUNTIME one is authoritative, so
// name it explicitly to resolve the star-export ambiguity.
export type { HarnessPendingTool } from './harness';
// T27: the same class of ambiguity for the display wire row. `TurnSummary` is DECLARED
// once (src/shared/turn-display.ts:1019) and reaches this root twice — through
// `./server` (./server/protocol.ts re-exports the shared display contract) and through
// `./frontend` (./frontend/api.ts:1322 re-exports it for browser callers). Star exports
// resolve ambiguity by name, not by declaration, so TS2308 fires even though both sides
// are the identical type. Naming the declaring module explicitly keeps exactly the API a
// consumer already gets (one `TurnSummary`, the shared definition) and cannot change any
// shape, because the type is the same declaration either way.
export type { TurnSummary } from './shared/turn-display';

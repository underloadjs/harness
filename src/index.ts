// The Node root of @underload/harness.
//
// `exports["."]` maps the `node`/`import` conditions here, so a Node host always
// gets the reusable server API in addition to the engine:
//
//   - engine       — `./engine` (harness/agent/tool + every public type and the
//                    engine's isomorphic helpers)
//   - server       — `./server` (startHarnessServer, runtime, service adapter,
//                    dispatcher, SessionStore, protocol, presets)
//
// The reusable browser client lives in `@loadscript/harness`; this package does not
// ship or re-export a frontend.
//
// IMPORT SAFETY: importing this file starts nothing. `startHarnessServer` binds a
// port only when called, and the service routes build their runtime lazily on the
// first request, so `import '@underload/harness'` never opens a listener.
//
// The browser root is `./engine/browser.ts` (exports["."].browser): engine only,
// never the server tree, whose `node:http` imports no browser can load. Node-only
// names are therefore absent from the browser build by design.
export * from './engine';
export * from './server';

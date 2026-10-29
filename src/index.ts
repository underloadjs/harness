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

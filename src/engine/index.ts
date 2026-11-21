// The engine root of @underload/harness.
//
// Everything reachable from here is the harness itself and its own isomorphic
// helpers. This tree imports nothing from `src/server`, so it can be copied on its
// own and run as a library: `harness({ ... })` returns the callable handle, and every
// action a consumer needs is on that handle.
//
//   - `./harness` — harness/agent/tool + every public type
//   - `./shared`  — attachment, run-identity and result helpers the engine uses
//
// The Node package root (`src/index.ts`) adds the server barrel on top of this one;
// the browser root (`src/engine/browser.ts`) does not.
export * from './harness';
export * from './shared';

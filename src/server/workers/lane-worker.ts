// The lane worker ENTRY - the module a lane thread loads.
//
// HOW THIS FILE IS REACHED
// ------------------------
// `node:worker_threads` cannot evaluate TypeScript, so the thread is spawned with the
// plain-JS bootstrap ./worker-boot.mjs (see its header for why that file is `.mjs`). That
// bootstrap starts Vite's own module runner, and THIS module is what the runner imports:
// Vite resolves every specifier below (extension-less siblings, directory `index.ts`,
// `node:*` builtins, external packages) and transforms the TypeScript. The coordinator side
// is ./lane-host.ts, which resolves the path and hands it to ./worker-runner.ts.
//
// WHY THERE ARE NO RESOLVE HOOKS HERE ANYMORE
// -------------------------------------------
// The deleted `module.registerHooks` shim existed only because raw Node could not resolve
// this repo's extension-less relative specifiers (`from './protocol'`) while type-stripping
// a `.ts` entry. Under the runner Vite's resolver does that job - the same job the bundler
// used to do - so the entry is just a module again. Node's own type-transform spawn flag is
// gone with it (and that flag is removed upstream in Node 26).
//
// WHY THE LOOP IS DYNAMICALLY IMPORTED, AND WHY THE EXPORT IS CALLED
// ------------------------------------------------------------------
//  1. The entry must not pull the loop's graph in statically: the loop registers the
//     `parentPort` listener, and a worker does not service `parentPort` while its module body
//     is still evaluating (measured on Node 24) - so evaluation has to finish first, and the
//     awaited import below is the only runtime statement in this entry (the `export {}` at the
//     end is a type-level marker).
//  2. Naming and CALLING the export is not decoration. A consumer that treats this package as
//     side-effect-free (`"sideEffects": false` in the manifest) may drop a dynamically
//     imported module whose exports it never reads; measured on the old bundle, an entry that
//     only awaited the import compiled to a 1 KB file that answered nothing and exited 0.
//     `startLaneWorker()` is a no-op unless `workerData` carries the boot marker ./lane-host.ts
//     sends, so importing this entry from a test still has no side effect.
//
// Cross-references:
//   - ./worker-boot.mjs   - the file the Worker is really spawned with
//   - ./worker-runner.ts  - the shared Vite server that serves this module
//   - ./lane-host.ts      - resolves this path and spawns the thread
//   - ./lane-worker-loop.ts - the message loop this entry evaluates

// The loop registers its own `parentPort` listener and stays alive from the message loop.
// The specifier carries its extension because the source tree IS the published layout: there
// is no bundle for a bundler to resolve it into.
const laneWorkerLoop = await import('./lane-worker-loop.ts');

laneWorkerLoop.startLaneWorker();

// This entry exports nothing - it is an executable, not an API - and the empty export is what
// makes the top-level `await` above a module-level await instead of a syntax error.
export {};

// The lane worker's durability arm - see ./io-worker-loop.ts for what runs on the thread.
//
// HOW THIS FILE IS REACHED
// ------------------------
// Same shape as ./lane-worker.ts: the thread is spawned with the plain-JS bootstrap
// ./worker-boot.mjs, that bootstrap starts Vite's module runner, and the runner imports THIS
// module. Vite resolves the graph (`node:*` builtins stay native, everything else the harness
// imports is transformed) and evaluates the TypeScript. ./io-client.ts resolves the path and
// hands it to ./worker-runner.ts.
//
// WHY THERE ARE NO RESOLVE HOOKS HERE ANYMORE
// -------------------------------------------
// The `module.registerHooks` shim this entry used to install existed only because raw Node
// could not resolve this repo's extension-less specifiers (`from '../persistence'`). The
// runner's resolver does that, so the entry holds no Node-specific machinery at all - which
// also retires the note about hooks having to precede the graph: with no hooks, load order is
// simply the runner's own.
//
// WHY THE LOOP IS DYNAMICALLY IMPORTED, AND WHY THE EXPORT IS CALLED
// ------------------------------------------------------------------
// The loop registers the `parentPort` listener, and a worker does not service `parentPort`
// while its module body is still evaluating (measured on Node 24), so the loop has to be
// loaded AFTER this body - the awaited import below is the entry's last statement.
//
// THE CALL IS NOT OPTIONAL. The package manifest says `"sideEffects": false`, so a consumer
// may drop a dynamically imported module whose exports are never used: an entry that only
// awaited the import compiled to a 1 KB bundle that never contained the loop, and the worker
// exited with code 0 without answering `hello` (measured on this config). Naming the export is
// what keeps the loop in the graph - and the call is a no-op unless `workerData` carries the
// marker ./io-client.ts sends, so importing this entry from a test stays side-effect free.
//
// Cross-references:
//   - ./worker-boot.mjs   - the file the Worker is really spawned with
//   - ./worker-runner.ts  - the shared Vite server that serves this module
//   - ./io-client.ts      - resolves this path and spawns the thread
//   - ./io-worker-loop.ts - the operation table and message loop this entry evaluates
//   - ./io-protocol.ts    - the boot marker the client passes in `workerData`

// The loop registers its own `parentPort` listener and answers from the message loop. The
// specifier carries its extension because the source tree is the published layout.
const loop = await import('./io-worker-loop.ts');

loop.startIoWorker();

// This entry exports nothing - it is an executable, not an API - and the empty export is what
// makes the top-level `await` above a module-level await instead of a syntax error.
export {};

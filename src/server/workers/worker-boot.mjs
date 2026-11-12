// The WORKER-THREAD BOOTSTRAP: the one file a `new Worker(...)` is spawned with.
//
// WHY THIS FILE EXISTS, AND WHY IT IS PLAIN JS (`.mjs`)
// ----------------------------------------------------
// `node:worker_threads` loads its entry with RAW Node: the file has to be parseable by
// whatever Node is installed, before any tool of this repo gets a chance to transform it.
// This monorepo never runs its own `.ts` through Node (AGENTS.md: `vite`, `vite-node`,
// `vitest` only - and this Node build reports `process.features.typescript === false`, so
// it could not strip types even if we asked). So the spawn entry cannot be `.ts`, and the
// repo ships no `dist/` build either (packages publish `src/*.ts` only - no bundle step to
// produce a compiled entry from).
//
// The resolution: this checked-in `.mjs` holds NO LOGIC - it is a bootstrap that starts
// VITE'S OWN module runner (the same one Vitest 4 uses after dropping vite-node) inside the
// worker thread and hands it the `.ts` entry. Every module of the real graph is then
// resolved and transformed by Vite, over the MessagePort the spawner transferred in
// `workerData.port`, and served by the ONE shared Vite server in the parent
// (./worker-runner.ts). That is the documented worker-thread shape of the environment API:
// https://vite.dev/guide/api-environment-runtimes.
//
// What used to live here (raw Node plus its experimental type-transform spawn flag, and
// hand-written `module.registerHooks` resolvers) is gone: the flag is removed upstream in
// Node 26, and the hooks only re-implemented the resolution Vite's own resolver performs.
//
// Cross-references:
//   - ./worker-runner.ts  - the parent side: the shared Vite server and this file's path
//   - ./lane-worker.ts    - the lane entry the runner imports for a lane worker
//   - ./io-worker.ts      - the durability entry the runner imports for an IO worker

import { workerData } from 'node:worker_threads';
import { ModuleRunner } from 'vite/module-runner';

// Wire protocol with ./worker-runner.ts. Kept as literals here because a `.mjs` file with
// no build step cannot import the TS module that owns them; the TS side declares the same
// two strings (worker-runner.ts `HARNESS_RUNNER_INVOKE` / `HARNESS_RUNNER_INVOKE_REPLY`).
const INVOKE = 'harness:runner:invoke';
const INVOKE_REPLY = 'harness:runner:invoke-reply';

const entry = workerData?.entry;
const port = workerData?.port;

// A missing field is a programming error in the spawner, and it has to say so: without the
// entry there is nothing to run, and without the port the runner can resolve nothing.
if (typeof entry !== 'string' || entry.length === 0) {
    throw new Error('worker-boot.mjs needs workerData.entry (the module-runner url of the worker entry).');
}

if (!port || typeof port.on !== 'function' || typeof port.postMessage !== 'function') {
    throw new Error('worker-boot.mjs needs workerData.port (the MessagePort attached to the harness Vite runner server).');
}

// ---------------------------------------------------------------------------
// The transport: Vite's `invoke` RPC relayed over the dedicated MessagePort.
// ---------------------------------------------------------------------------
// The runner only ever asks for two things through `invoke` - `fetchModule` (resolve +
// transform) and `getBuiltins` (which specifiers are Node builtins and may therefore be
// imported natively instead of transformed). Both are answered by the parent's shared
// server. Replies are matched by id, never by arrival order, because the runner fetches
// concurrently.

let nextInvokeId = 0;

/** @type {Map<string, { resolve: (value: unknown) => void, reject: (error: Error) => void }>} */
const pending = new Map();

const failPending = (message) => {
    for (const [, waiter] of pending) waiter.reject(new Error(message));
    pending.clear();
};

port.on('message', (message) => {
    if (!message || message.type !== INVOKE_REPLY) return;

    const waiter = pending.get(message.id);

    if (waiter === undefined) return;

    pending.delete(message.id);

    // The runner's own contract: `invoke` resolves with `{ result }` or `{ error }`, and
    // Vite revives the error on this side (module-runner `reviveInvokeError`). Rejecting
    // here instead would lose the `error` channel's fields (plugin, frame, loc).
    if (message.ok) waiter.resolve({ result: message.value });
    else waiter.resolve({ error: message.error });
});

// The parent closed the port (worker torn down, or the shared server shut down). An
// in-flight `fetchModule` can never be answered, so it has to fail loudly: the runner's
// `import()` rejects, the entry dies, and the coordinator reports the worker error instead
// of waiting out a handshake timeout.
port.on('close', () => failPending('The harness Vite runner port closed before the module fetch was answered.'));

const transport = {
    invoke: (payload) =>
        new Promise((resolve, reject) => {
            // ModuleRunner hands a custom transport its envelope
            // `{ type: 'custom', event: 'vite:invoke', data: { id, name, data } }`.
            const request = payload?.data;

            if (request === undefined) {
                reject(new Error('worker-boot.mjs received an invoke payload without a request body.'));
                return;
            }

            const id = String(++nextInvokeId);

            pending.set(id, { resolve, reject });
            port.postMessage({ type: INVOKE, id, name: request.name, args: request.data });
        })
};

// ---------------------------------------------------------------------------
// The runner, then the entry.
// ---------------------------------------------------------------------------
// `hmr: false` - a worker thread never hot-updates; the coordinator replaces the whole
// thread when the code changes. `sourcemapInterceptor: false` keeps the bootstrap cheap and
// side-effect free: enabling it would install a process-wide `Error.prepareStackTrace` /
// source-map hook in a thread whose stacks the coordinator already reports.
const runner = new ModuleRunner({ transport, hmr: false, sourcemapInterceptor: false });

// The awaited import is the whole point of this file: `entry` is the `.ts` worker entry
// (lane or IO), fetched through the parent's Vite server. Its module body installs the
// `parentPort` listener, and the thread then stays alive on its own message loop.
await runner.import(entry);

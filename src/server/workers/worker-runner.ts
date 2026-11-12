// The PARENT side of the worker module graph: one shared Vite dev server, and the port
// transport that serves it to every worker thread (./worker-boot.mjs).
//
// WHY A VITE SERVER HERE AT ALL
// -----------------------------
// A worker thread has to load `.ts` (this repo ships source, never a `dist/` bundle), and
// `node:worker_threads` loads its entry with raw Node - which cannot parse or resolve this
// repo's TypeScript. The answer is Vite's own `ModuleRunner` running inside the thread
// (./worker-boot.mjs), fetching every transformed module from a server that already exists
// in this process. One server per PROCESS, not per lane: a fresh `createServer` costs ~16 ms
// and ~40 MB, while an extra lane on the already-warm server costs ~2 ms and ~10 MB
// (measured, Temp/plan-r5). Per-lane environments are not needed either - one environment
// answers every runner, and the module graph it holds is the same source graph regardless of
// which lane asked for a module.
//
// WHY IT IS LAZY
// --------------
// Default execution is `'inline'` (../config.ts), where no worker is ever spawned and no
// Vite server must exist. The server is created by the FIRST `openHarnessWorkerSession`
// call - i.e. by the first real lane/IO worker - and closed again when the last one is
// released, so an inline server never pays for it (AC6).
//
// WHY `consumer: 'server'`
// ------------------------
// It is what selects the module-runner transform (`dev.moduleRunnerTransform` defaults to
// `consumer === 'server'`) and a non-empty `resolve.builtins`, which is what `getBuiltins`
// answers with - the runner uses that list to hand `node:*` imports to Node instead of
// trying to transform them. `consumer: 'node'` is not a valid value in Vite 8 and silently
// produces an empty builtin list.
//
// Cross-references:
//   - ./worker-boot.mjs   - the thread side (transport `invoke`, then `runner.import(entry)`)
//   - ./lane-host.ts      - spawns lane workers through `openHarnessWorkerSession`
//   - ./io-client.ts      - spawns the IO worker through `openHarnessWorkerSession`
//   - ../package-root.ts  - `packagePath`, which locates the published `.mjs` bootstrap

import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { createServer, type DevEnvironment, type ViteDevServer } from 'vite';
import { PACKAGE_ROOT, packagePath } from '../package-root';

// Environment name for the runner environment. Vite requires `/^[\w$]+$/`; it is also the
// only environment besides the default `client`/`ssr` pair this process creates.
export const HARNESS_RUNNER_ENVIRONMENT = 'harnessWorker';

// The bootstrap a `Worker` is spawned with. It is plain JS on purpose (see the header of
// ./worker-boot.mjs) and it is resolved through `packagePath` rather than
// `new URL('./worker-boot.mjs', import.meta.url)`, because Vite's asset plugin rewrites the
// latter into an emitted asset - the same trap ../package-root.ts documents for the `.env`.
export const HARNESS_WORKER_BOOT_SCRIPT = packagePath('src', 'server', 'workers', 'worker-boot.mjs');

// Wire protocol with ./worker-boot.mjs (the two literals there must match these).
export const HARNESS_RUNNER_INVOKE = 'harness:runner:invoke';
export const HARNESS_RUNNER_INVOKE_REPLY = 'harness:runner:invoke-reply';

// The `fetchModule` / `getBuiltins` pair the runner is allowed to ask for. Exported as the
// documentation of the protocol, not enforced as a type: the payloads arrive over a port.
const FETCH_MODULE = 'fetchModule';
const GET_BUILTINS = 'getBuiltins';

// One server per process, created on demand. The promise (not the instance) is cached so a
// second caller waits for the first `createServer` instead of starting a third one.
let runnerServer: Promise<ViteDevServer> | undefined;

// Live worker sessions. The server is closed when the last one is released, which is what
// lets a long-lived process start and stop worker mode without keeping ~40 MB and a file
// watcher alive forever.
let liveSessions = 0;

// Test/diagnostic hook: `true` from the first worker spawn until the last one is released.
// AC6 (inline mode creates no server) is asserted through this.
export const harnessRunnerServerStarted = (): boolean => runnerServer !== undefined;

const startRunnerServer = (): Promise<ViteDevServer> => {
    runnerServer ??= createServer({
        // No repo/package vite.config.ts: those configs build bundles (and the harness one
        // runs a whole browser build). The runner needs the resolver and the TS transform
        // only, so the configuration is declared here, in full.
        configFile: false,
        root: PACKAGE_ROOT,
        logLevel: 'warn',

        // Middleware mode: the http server exists but never listens, and `hmr: false` means
        // no WebSocket server at all. The only client of this server is the port transport.
        server: {
            middlewareMode: true,
            hmr: false,
            // No chokidar watcher: the runners are per-thread and short-lived, and a lane
            // that needs new code is a lane the coordinator replaces with a new thread.
            watch: null
        },

        environments: {
            [HARNESS_RUNNER_ENVIRONMENT]: {
                // See the header: this is what turns on the module-runner transform and the
                // Node builtin list.
                consumer: 'server',

                resolve: {
                    // This repo imports sibling modules without extensions (`from
                    // './protocol'`). Node's ESM resolver requires the extension; Vite's
                    // defaults accept extension-less specifiers and directory `index.ts`,
                    // which is exactly the resolution the deleted `registerHooks` shims
                    // hand-rolled.
                    extensions: ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json']
                },

                dev: {
                    // Nothing pre-transforms on this server, and dev sourcemaps are inlined
                    // into the fetched code by `fetchModule` regardless.
                    preTransformRequests: false,
                    warmup: [],

                    // No per-transform source map. The threads run with
                    // `sourcemapInterceptor: false` (./worker-boot.mjs), so nothing consumes a
                    // map - and generating one is real CPU work on the COORDINATOR's event loop,
                    // which is what a lane turn's responsiveness budget pays for.
                    sourcemap: false
                }
            }
        }
    }).catch((error: unknown) => {
        // A failed `createServer` must not be cached: the next worker spawn retries (and an
        // inline fallback would be a lie, so the error simply propagates to the worker).
        runnerServer = undefined;
        throw error;
    });

    return runnerServer;
};

// Close the shared server. Idempotent, and safe to call while a worker still holds the port
// (the port itself is not the server).
export const closeHarnessRunnerServer = async (): Promise<void> => {
    const pending = runnerServer;

    runnerServer = undefined;

    if (pending === undefined) return;

    const server = await pending.catch(() => undefined);

    await server?.close().catch(() => undefined);
};

// A Vite transform failure is an `Error` with the useful parts in extra fields (plugin, loc,
// frame, id). Those fields are what makes a worker failure debuggable, and structured clone
// of an Error does not reliably carry them, so they are copied out explicitly and Vite's own
// `reviveInvokeError` re-attaches them on the thread side.
const serializeError = (error: unknown): Record<string, unknown> => {
    if (error instanceof Error) {
        const { name, message, stack, ...rest } = error as Error & Record<string, unknown>;

        return { ...rest, name, message, stack };
    }

    return { message: String(error) };
};

// The environment every runner is served from, initialised on first use (`fetchModule`
// needs the plugin container, and `init()` is guarded against running twice).
const runnerEnvironment = async (server: ViteDevServer): Promise<DevEnvironment> => {
    const environment = server.environments[HARNESS_RUNNER_ENVIRONMENT];

    if (environment === undefined) {
        throw new Error(`The harness Vite runner server has no "${HARNESS_RUNNER_ENVIRONMENT}" environment.`);
    }

    await environment.init();

    return environment;
};

// One answered invoke. Errors travel as `{ ok: false }` - never as a thrown value, because a
// throw here would be an unhandled rejection in the parent and would leave the worker
// waiting for a reply that will never come.
const serveRunnerInvoke = async (port: MessagePort, message: { id: string; name: string; args?: unknown[] }): Promise<void> => {
    const reply = (ok: boolean, value: unknown, error?: Record<string, unknown>): void => {
        try {
            port.postMessage({ type: HARNESS_RUNNER_INVOKE_REPLY, id: message.id, ok, value, error });
        } catch {
            // The port closed while the module was being transformed (the worker was
            // terminated). The thread is gone; nothing to report to.
        }
    };

    try {
        const server = await startRunnerServer();
        const environment = await runnerEnvironment(server);

        if (message.name === FETCH_MODULE) {
            // The runner's own argument tuple (`fetchModule(id, importer, options)`), which is
            // what `InvokeMethods['fetchModule']` sends - taken from the method type so the
            // port payload cannot drift from the server signature.
            const [id, importer, options] = (message.args ?? []) as Parameters<DevEnvironment['fetchModule']>;

            reply(true, await environment.fetchModule(id, importer, options));
            return;
        }

        if (message.name === GET_BUILTINS) {
            // Same mapping Vite's own hot channel uses for this invoke.
            reply(
                true,
                environment.config.resolve.builtins.map((builtin) =>
                    typeof builtin === 'string'
                        ? { type: 'string', value: builtin }
                        : { type: 'RegExp', source: builtin.source, flags: builtin.flags }
                )
            );
            return;
        }

        throw new Error(`Unknown harness runner invoke "${message.name}".`);
    } catch (error) {
        reply(false, undefined, serializeError(error));
    }
};

// A worker entry path -> the url `ModuleRunner.import()` and `fetchModule` understand. Files
// under the root get the ordinary root-relative url; anything else (a scratch entry under a
// repo-root `Temp/`) needs Vite's `/@fs/` prefix.
const toRunnerUrl = (entryPath: string): string => {
    const posix = entryPath.split('\\').join('/');
    const root = PACKAGE_ROOT.split('\\').join('/');
    const prefix = root.endsWith('/') ? root : `${root}/`;

    if (posix.startsWith(prefix)) return `/${posix.slice(prefix.length)}`;

    return posix.startsWith('/') ? `/@fs${posix}` : `/@fs/${posix}`;
};

export type HarnessWorkerSession = {
    // The plain-JS bootstrap the `Worker` is spawned with.
    bootScript: string;
    // What the runner imports inside the thread (the `.ts` entry, as a Vite url).
    entryUrl: string;
    // The dedicated transport port: put it in `workerData` and in `transferList`.
    transportPort: MessagePort;
    // Closes the parent-side port and releases the shared server. Idempotent.
    dispose: () => void;
};

// Everything a worker spawn needs on the module side. Additive by design: the caller keeps
// its own `MessagePort`/`workerData` protocol and its own lane/IO semantics; this only adds
// one port and swaps the spawn entry for ./worker-boot.mjs.
export const openHarnessWorkerSession = (entryPath: string): HarnessWorkerSession => {
    const channel = new MessageChannel();
    const port = channel.port1;

    // A MessagePort keeps its side of the event loop alive. The parent must not be held open
    // by a transport (the server keeps the process alive), while the THREAD side stays
    // referenced so the thread cannot exit mid-import.
    port.unref();

    let disposed = false;

    const dispose = (): void => {
        if (disposed) return;

        disposed = true;
        port.close();

        liveSessions = Math.max(0, liveSessions - 1);

        if (liveSessions === 0) void closeHarnessRunnerServer();
    };

    liveSessions += 1;

    port.on('message', (message: { type?: string; id?: string; name?: string; args?: unknown[] }) => {
        if (message?.type !== HARNESS_RUNNER_INVOKE || typeof message.id !== 'string' || typeof message.name !== 'string') return;

        void serveRunnerInvoke(port, { id: message.id, name: message.name, args: message.args });
    });

    // The thread is gone (terminate, crash, or exit): drop the port, and with it the last
    // reference to the shared server.
    port.on('close', dispose);

    return { bootScript: HARNESS_WORKER_BOOT_SCRIPT, entryUrl: toRunnerUrl(entryPath), transportPort: channel.port2, dispose };
};

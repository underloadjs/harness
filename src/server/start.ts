// The standalone harness server (EXPLICIT, optional).
//
// This module is the implementation behind `startHarnessServer`, re-exported from
// the server barrel (`./index.ts`) and therefore reachable from the package root.
// Importing it binds nothing: the listener is created inside the function, so no
// package import can start a server.
//
// The production host is the @underload/service gateway, which discovers
// `./endpoint/harness/service-route*.ts` and answers /v1/harness in-process; this
// file remains for local development and for a single-process deployment that also
// serves the built UI (`../frontend/dist`, when present).
//
// PERSISTENCE (R3b): pass `databaseRoot` to resume `<root>/harness/state.json`.
// Omitted is the previous in-memory server (the default used by direct tests).

import http from 'node:http';
import { createHarnessRegistry, createToolCatalogue, describeHarness, restoreHarnessRegistry } from './harnesses';
import type { HarnessRegistry, ToolCatalogue } from './harnesses';
import { loadConfiguration, resolveRuntimeConfiguration } from './config';
import type { ServerRuntimeConfiguration } from './config';
import { loadEnvironmentFile } from './environment';
import { createHarnessHandler } from './handler';
import type { HarnessHandler } from './handler';
// The mount constant is the REST owner's single source of truth (./api.ts); the stream path is
// derived from it rather than repeated here, so the two can never disagree.
import { STANDALONE_MOUNT } from './api';
import { packagePath } from './package-root';
import type { RunnerSettings } from './harnesses/types';
import type { HarnessIndex } from './protocol';
import { SessionStore } from './sessions';
// T15: the update stream. This listener owns its own broker (one epoch for this process), attaches
// it to the SAME http.Server that answers the REST mount — no second port, no second root — and
// closes it before the listener tears down. The hub beside it is the single source of the epoch and
// the resource revisions (T13), so REST headers and stream frames are always the same numbers.
import { bridgeEventHub, createHarnessStreamMount, createStreamSources, hubStreamSources } from './stream';
import type { HarnessStreamMount } from './stream';
import { createHarnessEventHub } from './api-events';
import type { HarnessEventHub } from './api-events';
// Same subsystem boundary as ./runtime.ts: the worker readiness gate lives with the
// worker code, not with the server entry points.
import { assertWorkerRuntimeReady } from './workers';
import {
    HarnessPersistence,
    HarnessPersistenceError,
    normalizeHarnessDatabaseRoot
} from './persistence';
import { createStaticHandler } from './static';

export type StartServerOptions = {
    port?: number;
    host?: string;
    // `null` disables static serving (used by tests).
    staticRoot?: string | null;
    settings?: RunnerSettings;
    // Advertised to clients as the starting point for the endpoint fields.
    defaults?: HarnessIndex['defaults'];
    // Durable database root (R3b). Omitted => the previous in-memory server;
    // supplied => sessions/registry/core state live under `<root>/harness/` and a
    // restart resumes them. The service host instead passes DATABASE_ROOT through
    // its endpoint `variables.root` (see ./service.ts).
    databaseRoot?: string | null;
    // Direct-call catalogue. Omitted means "build it now, after `.env` loading".
    // Tests inject one to pin a configured/unconfigured search without
    // touching the test runner's environment.
    catalogue?: ToolCatalogue;
    // The in-memory harness registry shared by the store and the API. Omitted
    // means the shipped catalogue; tests inject one to add scripted harnesses.
    registry?: HarnessRegistry;
    // Server RUNTIME override (R3), merged over `HARNESS_THREAD_EXECUTION` and the
    // other `HARNESS_WORKER_*` variables and validated the same way. `worker` is
    // refused by this build until the lane coordinator lands, and the refusal is an
    // error rather than a silent inline fallback.
    runtime?: Partial<ServerRuntimeConfiguration>;
    // T15: inject the update-stream mount (an embedder that already owns a broker, or a test with a
    // fixed epoch). Omitted means "create one for this listener", which is the normal case: the
    // standalone process then has exactly one epoch and one subscription set, shared by REST and WS.
    stream?: HarnessStreamMount;
    // T15/T13: inject the epoch/revision hub (a host that already publishes domain changes into one).
    // Omitted means "create it", which is what mints the process epoch REST and WS both report.
    events?: HarnessEventHub;
};

export type HarnessServer = {
    port: number;
    host: string;
    url: string;
    store: SessionStore;
    // The resolved, validated runtime this listener executes with (R3).
    runtime: ServerRuntimeConfiguration;
    // Present when a database root was supplied; the resolved root and file owner.
    persistence?: HarnessPersistence;
    // T15: the live update stream mounted at `/v1/harness/stream` on THIS listener (`ws://` on the
    // same host and port as `url`). Exposed so an embedder can publish, count connections, or close
    // it independently of the listener.
    stream: HarnessStreamMount;
    // The shared epoch/revision hub (T13) this listener publishes through: `events.epoch` is the
    // epoch both the REST headers and the stream `welcome` carry.
    events: HarnessEventHub;
    close: () => Promise<void>;
};

const DEFAULT_PORT = 5181;
const DEFAULT_HOST = '127.0.0.1';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const sendNotFound = (response: http.ServerResponse): void => {
    if (response.headersSent) {
        response.end();
        return;
    }

    response.statusCode = 404;
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.end('Not found');
};

const sendFailure = (response: http.ServerResponse, error: unknown): void => {
    if (response.headersSent) {
        response.destroy();
        return;
    }

    response.statusCode = 500;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(
        JSON.stringify({
            error: { message: error instanceof Error ? error.message : String(error) }
        })
    );
};

export const startHarnessServer = async (options: StartServerOptions = {}): Promise<HarnessServer> => {
    // Load before configuration and before any session constructs a harness: the
    // provider defaults are read here, and search keys are captured once at
    // harness construction. Idempotent when the CLI already loaded the same file.
    loadEnvironmentFile();

    const configuration = loadConfiguration();

    // R3: resolve and validate the runtime BEFORE any listener is created, so a bad
    // `HARNESS_WORKER_*` value or an unsupported execution mode aborts startup with
    // the variable name instead of serving a silently different model.
    const runtime = resolveRuntimeConfiguration(configuration.runtime, options.runtime);
    assertWorkerRuntimeReady(runtime);

    // Built after loadEnvironmentFile() on purpose: search resolves its
    // provider key here, once, and the handler keeps the snapshot for its whole
    // lifetime. A keyless host still gets the entry, marked unconfigured.
    const catalogue = options.catalogue ?? createToolCatalogue();

    // ONE registry: the store resolves a session through it and the API creates
    // and patches through it, so a harness created over HTTP is immediately
    // runnable and an override is visible to the next session.
    const registry = options.registry ?? createHarnessRegistry();

    // R3b: rebuild the registry from disk BEFORE any session is constructed, then
    // hand the validated session records to the store. A corrupt/unknown document
    // throws here and aborts startup instead of serving an empty database.
    const root = normalizeHarnessDatabaseRoot(options.databaseRoot);
    const persistence = root === undefined ? undefined : new HarnessPersistence(root);
    const database = persistence?.load();

    if (database !== undefined && persistence !== undefined) {
        try {
            // T5: the deleted-builtin tombstones are replayed FIRST, so a shipped
            // default the operator removed stays removed across this restart.
            restoreHarnessRegistry(registry, database.registry, database.deleted);
        } catch (error) {
            throw new HarnessPersistenceError(
                persistence.file,
                `The saved harness registry could not be restored: ${messageOf(error)}`
            );
        }
    }

    // The store owns no catalogue, so bind the describer here: every session's
    // frozen `harnessDefinition` reflects what THIS host can actually run
    // (search only when a key resolved).
    // ONE provider-settings object per listener (T28): the store builds harnesses with it and
    // the dispatcher authenticates its own provider calls (`POST /models`) with the SAME
    // credential. Reading `configuration.settings` twice would let a session and a discovery
    // call disagree about the provider after a `.env` change, and the API would then have only
    // the key-free `defaults` document to work from — which is how a placeholder reached the
    // Authorization header.
    //
    // T5 (R2/R3) + R4: this listener's PLUGIN SETTINGS STORE is created inside that SessionStore,
    // seeded from `database.pluginSettings`, and read back by `GET/PATCH /v1/harness/plugins`
    // through `store.pluginSettings` — one per process, exactly like the store itself, so no
    // separate construction is needed here (see ./runtime.ts for the same note). With R4 that
    // store is the PROCESS/TEMPLATE: every session copies it at creation (`copyPluginSettingsStore`)
    // and answers `GET/PATCH /v1/harness/sessions/{id}/plugins/**` from its own copy, so a global
    // write moves the sessions created after it, not the ones already running.
    const serverSettings = options.settings ?? configuration.settings;

    const store = new SessionStore(
        serverSettings,
        registry,
        (preset) => describeHarness(preset, catalogue),
        {
            ...(persistence === undefined ? {} : { persistence }),
            ...(database === undefined ? {} : { database }),
            // R1/R3: the standalone listener hands the store the SAME resolved runtime it
            // reports on `startHarnessServer().runtime`, so an operator's
            // HARNESS_THREAD_EXECUTION=worker is what the sessions actually get.
            runtime
        }
    );

    // D4: a worker-mode listener does not bind its port until the IO worker has answered the
    // protocol handshake. `ioReady()` is `undefined` unless this store offloads durability, so
    // an inline host is unchanged; when it is present, a rejection means the thread is already
    // terminated and every write issued before the handshake failed with the same reason
    // (./workers/io-client.ts, contract 8) - there is no inline fallback to fall back to.
    //
    // Awaiting BEFORE `http.createServer` also means a deployment with a missing worker entry
    // never opens a socket it then has to close.
    const readiness = store.ioReady();

    if (readiness !== undefined) await readiness;

    // T15: one stream broker for this listener, plus the epoch/revision hub the dispatcher publishes
    // through. Building them binds nothing: no timers, no buffers, and no socket until a client
    // upgrades, so an API-only host is unchanged. The path FOLLOWS the REST mount (the same constant
    // the dispatcher is mounted on), so REST and WS can never end up under two different roots, and
    // the epoch is the hub's, so `welcome` and `X-Harness-Epoch` carry one value.
    const events = options.events ?? createHarnessEventHub();

    const stream =
        options.stream ??
        createHarnessStreamMount({
            path: `${STANDALONE_MOUNT}/stream`,
            sources: hubStreamSources(events, createStreamSources({ store, registry }))
        });

    // Every REST write published into the hub becomes exactly one stream fan-out.
    const detachStreamBridge = bridgeEventHub(events, stream.broker);

    // T28: when the host supplies settings without an advertised document, the document is
    // derived from those SAME settings, so `/config` can never report a different provider than
    // the one sessions and discovery actually dial. `hasApiKey` remains an advertisement only.
    const defaults =
        options.defaults ??
        (options.settings === undefined
            ? configuration.defaults
            : {
                  baseURL: serverSettings.baseURL,
                  model: serverSettings.model,
                  hasApiKey: serverSettings.apiKey.trim().length > 0
              });

    const api: HarnessHandler = createHarnessHandler({
        store,
        defaults,
        // T28: the private channel — the real credential for this process (see above).
        settings: serverSettings,
        // T28: the SAME validated runtime the store enforces and `startHarnessServer().runtime`
        // reports. Without this the dispatcher re-parses the environment and can state a
        // different execution model than the sessions are actually running under.
        runtime,
        registry,
        catalogue,
        // T15 integration point: the dispatcher and the store publish through THIS hub and THIS
        // broker, so a REST write's revision and the frame it causes share one epoch.
        stream,
        events
    });

    // Default static root: the UI application build inside the package. Resolved
    // through ./package-root.ts rather than `new URL('../frontend/dist', ...)` so the
    // value is identical in the source tree (src/server -> src/frontend/dist) and in
    // the bundle (dist/<chunk> -> src/frontend/dist), and so Vite never treats the
    // path as an asset to inline.
    const staticRoot =
        options.staticRoot === null
            ? undefined
            : (options.staticRoot ?? packagePath('src', 'frontend', 'dist'));
    const serveStatic = staticRoot === undefined ? undefined : createStaticHandler(staticRoot);

    const server = http.createServer((request, response) => {
        void (async () => {
            try {
                if (await api(request, response)) return;
                if (serveStatic !== undefined && (await serveStatic(request, response))) return;
                sendNotFound(response);
            } catch (error) {
                sendFailure(response, error);
            }
        })();
    });

    // T15: the WebSocket upgrade rides the SAME listener as the REST mount (same host, same port,
    // same `/v1/harness` root). Without this listener Node destroys an upgrade socket, which is how
    // "the service has it, the standalone does not" would otherwise happen silently.
    const detachStream = stream.attach(server);

    const host = options.host ?? DEFAULT_HOST;
    const requestedPort = options.port ?? DEFAULT_PORT;

    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
            server.off('listening', onListening);
            reject(error);
        };
        const onListening = (): void => {
            server.off('error', onError);
            resolve();
        };

        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(requestedPort, host);
    });

    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : requestedPort;

    return {
        port,
        host,
        url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`,
        store,
        runtime,
        stream,
        events,
        ...(persistence === undefined ? {} : { persistence }),
        close: async (): Promise<void> => {
            // T15: stop the hub -> stream fan-out first, then close every live stream with 1001
            // (`going_away`, "host shutdown while background work drains") BEFORE the listener stops,
            // so a client sees an honest close code rather than a dropped socket. Detaching the
            // `upgrade` listener means a reused port can never resurrect a dead broker.
            detachStreamBridge();
            detachStream();
            stream.close(1001);

            // D4: `dispose()` queues the graceful document and FIRES the IO drain; awaiting
            // `drainIo()` here - the same cached promise - is what turns "the process may exit
            // now" into "the last document is on disk". A write that did not make it is reported
            // through `notePersistenceError` and carried in the summary, never thrown, so the
            // listener below is still closed.
            store.dispose();

            await store.drainIo('server close');

            server.closeAllConnections?.();

            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            });
        }
    };
};

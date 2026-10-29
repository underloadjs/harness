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
import { loadConfiguration } from './config';
import { loadEnvironmentFile } from './environment';
import { createHarnessHandler } from './handler';
import type { HarnessHandler } from './handler';
import { packagePath } from './package-root';
import type { RunnerSettings } from './harnesses/types';
import type { HarnessIndex } from './protocol';
import { SessionStore } from './sessions';
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
    // Tests inject one to pin a configured/unconfigured webSearch without
    // touching the test runner's environment.
    catalogue?: ToolCatalogue;
    // The in-memory harness registry shared by the store and the API. Omitted
    // means the shipped catalogue; tests inject one to add scripted harnesses.
    registry?: HarnessRegistry;
};

export type HarnessServer = {
    port: number;
    host: string;
    url: string;
    store: SessionStore;
    // Present when a database root was supplied; the resolved root and file owner.
    persistence?: HarnessPersistence;
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

    // Built after loadEnvironmentFile() on purpose: webSearch resolves its
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
            restoreHarnessRegistry(registry, database.registry);
        } catch (error) {
            throw new HarnessPersistenceError(
                persistence.file,
                `The saved harness registry could not be restored: ${messageOf(error)}`
            );
        }
    }

    // The store owns no catalogue, so bind the describer here: every session's
    // frozen `harnessDefinition` reflects what THIS host can actually run
    // (webSearch only when a key resolved).
    const store = new SessionStore(
        options.settings ?? configuration.settings,
        registry,
        (preset) => describeHarness(preset, catalogue),
        {
            ...(persistence === undefined ? {} : { persistence }),
            ...(database === undefined ? {} : { database })
        }
    );

    const api: HarnessHandler = createHarnessHandler({
        store,
        defaults: options.defaults ?? configuration.defaults,
        registry,
        catalogue
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
        ...(persistence === undefined ? {} : { persistence }),
        close: () =>
            new Promise<void>((resolve, reject) => {
                store.dispose();
                server.closeAllConnections?.();
                server.close((error) => (error ? reject(error) : resolve()));
            })
    };
};

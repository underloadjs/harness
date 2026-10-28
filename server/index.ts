// The standalone harness server.
//
// It serves the API and, when `playground/dist` exists, the built UI. Nothing in
// the harness package depends on it: the CLI runs the same presets without a
// server, and the server is only an HTTP skin over them.

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createToolCatalogue } from '../harnesses';
import type { ToolCatalogue } from '../harnesses';
import { loadConfiguration } from './config';
import { loadEnvironmentFile } from './environment';
import { createHarnessHandler } from './handler';
import type { HarnessHandler } from './handler';
import type { RunnerSettings } from '../harnesses/types';
import type { HarnessIndex } from './protocol';
import { SessionStore } from './sessions';
import { createStaticHandler } from './static';

export type StartServerOptions = {
    port?: number;
    host?: string;
    // `null` disables static serving (used by tests).
    staticRoot?: string | null;
    settings?: RunnerSettings;
    // Advertised to clients as the starting point for the endpoint fields.
    defaults?: HarnessIndex['defaults'];
    // Direct-call catalogue. Omitted means "build it now, after `.env` loading".
    // Tests inject one to pin a configured/unconfigured websearch without
    // touching the test runner's environment.
    catalogue?: ToolCatalogue;
};

export type HarnessServer = {
    port: number;
    host: string;
    url: string;
    store: SessionStore;
    close: () => Promise<void>;
};

const DEFAULT_PORT = 5181;
const DEFAULT_HOST = '127.0.0.1';

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
    const store = new SessionStore(options.settings ?? configuration.settings);

    // Built after loadEnvironmentFile() on purpose: websearch resolves its
    // provider key here, once, and the handler keeps the snapshot for its whole
    // lifetime. A keyless host still gets the entry, marked unconfigured.
    const catalogue = options.catalogue ?? createToolCatalogue();

    const api: HarnessHandler = createHarnessHandler({
        store,
        defaults: options.defaults ?? configuration.defaults,
        catalogue
    });

    const staticRoot =
        options.staticRoot === null
            ? undefined
            : (options.staticRoot ?? fileURLToPath(new URL('../playground/dist', import.meta.url)));
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
        close: () =>
            new Promise<void>((resolve, reject) => {
                store.dispose();
                server.closeAllConnections?.();
                server.close((error) => (error ? reject(error) : resolve()));
            })
    };
};

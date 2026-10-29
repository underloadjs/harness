// Explicit standalone harness API launcher (`yarn dev:server`).
//
// WHY THIS FILE EXISTS: the frontend launch (`yarn dev:frontend`) is Vite only.
// Before this split the frontend launcher called `startHarnessServer()` in-process
// and proxied `/api` at an ephemeral port, which meant a UI dev session always
// started a second harness server even when @underload/service was already running
// on :5000. The two launches are now independent:
//
//   yarn dev:frontend   Vite on :5180, `/api` -> the service on :5000
//   yarn dev:server     this file: the standalone Node API on :5181 (no Vite)
//
// This is NOT a package entry and is never exported from a barrel. Importing
// `@underload/harness` or `@underload/harness/server` cannot reach it, so the
// import-safety contract is unchanged. The listener is created only when this
// module is executed by `vite-node`.
//
// The service gateway remains the normal host (`yarn start-service` at the repo
// root; it discovers `src/server/endpoint/harness/service-route*.ts`). Run this
// launcher only when a separate standalone API process is wanted. It disables
// static serving (`staticRoot: null`) so it starts no UI at all; `startHarnessServer`
// still supports `staticRoot` for an embedder that wants a single-process UI host.
//
// Usage:
//   yarn dev:server [--port 5181] [--host 127.0.0.1] [--database-root <path>]
//
// `--database-root` is passed straight to `startHarnessServer`, which persists
// under `<root>/harness/state.json`. Omit it for the previous in-memory server.
// Environment/config behaviour is the same as every other Node entry: the
// package-root `.env` is loaded by `startHarnessServer` before configuration and
// harness construction.

import { parseArgs } from 'node:util';
import { startHarnessServer } from './index';

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const printUsage = (): void => {
    console.log(`@underload/harness — standalone API server

Usage:
  yarn dev:server [options]

This process serves the harness API only (mount /api) and starts no UI or Vite
dev server. In normal development the @underload/service gateway already hosts
/v1/harness on :5000; use that instead unless a separate process is needed.

Options:
  --port <port>           Server port (default: 5181; 0 = OS-assigned)
  --host <host>           Server host (default: 127.0.0.1)
  --database-root <path>  Durable database root (<root>/harness/state.json)
  -h, --help              Show this help
`);
};

const main = async (): Promise<void> => {
    let parsed;

    try {
        parsed = parseArgs({
            allowPositionals: false,
            options: {
                port: { type: 'string' },
                host: { type: 'string' },
                'database-root': { type: 'string' },
                help: { type: 'boolean', short: 'h', default: false }
            }
        });
    } catch (error) {
        process.stderr.write(`${messageOf(error)}\n\n`);
        printUsage();
        process.exitCode = 1;
        return;
    }

    const { values } = parsed;

    if (values.help) {
        printUsage();
        return;
    }

    // 0 is valid and means "let the OS pick a free port"; everything else must be
    // a real TCP port. Rejecting early keeps `startHarnessServer`'s bind error from
    // being the only feedback for a typo.
    const port = values.port === undefined ? undefined : Number(values.port);

    if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65_535)) {
        process.stderr.write(`invalid port: ${values.port}\n`);
        process.exitCode = 1;
        return;
    }

    try {
        const server = await startHarnessServer({
            ...(port === undefined ? {} : { port }),
            ...(values.host === undefined ? {} : { host: values.host }),
            ...(values['database-root'] === undefined
                ? {}
                : { databaseRoot: values['database-root'] }),
            // API only: never serve src/frontend/dist from this launcher.
            staticRoot: null
        });

        console.log(`Harness server listening at ${server.url}`);
        console.log(`  API  ${server.url}/api`);
        if (server.persistence !== undefined) console.log(`  DB   ${server.persistence.file}`);
        console.log('Ctrl+C to stop.');

        const shutdown = (): void => {
            void server.close().then(
                () => process.exit(0),
                () => process.exit(1)
            );
        };

        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
    } catch (error) {
        process.stderr.write(`harness server failed: ${messageOf(error)}\n`);
        process.exitCode = 1;
    }
};

await main();

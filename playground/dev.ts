// Development launcher for the harness UI.
//
// Starts the standalone harness server on an ephemeral port and points Vite's
// `/api` proxy at it. The browser therefore talks to a real server process in
// development, exactly as it does under `yarn serve` in production — the Vite
// config never imports the server or the package source.

import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { startHarnessServer } from '../server/index';

const configFile = fileURLToPath(new URL('./vite.config.ts', import.meta.url));
const api = await startHarnessServer({ port: 0, staticRoot: null });

const vite = await createServer({
    configFile,
    server: {
        proxy: {
            '/api': {
                target: api.url,
                changeOrigin: true
            }
        }
    }
});

await vite.listen();
vite.printUrls();
console.log(`  API  ${api.url}/api`);

const shutdown = (): void => {
    void Promise.allSettled([vite.close(), api.close()]).then(() => process.exit(0));
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

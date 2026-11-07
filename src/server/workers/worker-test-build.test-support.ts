// Vite-build a SOURCE worker entry for the integration tests.
//
// The production source mode evaluates the `.ts` entry with Node's own TypeScript
// transform. A Node build compiled without that transform cannot run it (see
// ./io-client.ts's execArgv), but Vitest already has Vite available. Building the
// current entry through Vite gives the tests the same code the build would ship,
// without depending on the test runner's Node binary.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

export const WORKER_TEST_PACKAGE_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
// The bundle discovers the PACKAGE root by walking up for `package.json`, so its
// scratch directory has to stay under the package (a repo-root Temp/ would make the
// package root resolve to the monorepo and break package-relative tool folders).
const TEMP_ROOT = join(WORKER_TEST_PACKAGE_ROOT, 'Temp');

export type BuiltTestWorker = { entry: string; dispose: () => void };

export const buildTestWorkerEntry = async (source: string): Promise<BuiltTestWorker> => {
    mkdirSync(TEMP_ROOT, { recursive: true });

    const outDir = mkdtempSync(join(TEMP_ROOT, 'harness-worker-build-'));

    await build({
        configFile: false,
        root: WORKER_TEST_PACKAGE_ROOT,
        logLevel: 'silent',
        build: {
            outDir,
            emptyOutDir: true,
            minify: false,
            sourcemap: false,
            lib: {
                entry: { worker: source },
                formats: ['es']
            },
            rollupOptions: {
                // The worker graph is fs/in-process only: Node builtins stay runtime
                // imports and package dependencies keep Node's own resolution, exactly
                // as the published bundle emits them.
                external: (id) =>
                    id.startsWith('node:') ||
                    id.startsWith('\0') ||
                    (!id.startsWith('.') && !isAbsolute(id)),
                output: {
                    entryFileNames: 'underload-harness.worker.mjs',
                    chunkFileNames: 'chunks/[name]-[hash].mjs'
                }
            }
        }
    });

    return {
        entry: join(outDir, 'underload-harness.worker.mjs'),
        dispose: () => rmSync(outDir, { recursive: true, force: true })
    };
};

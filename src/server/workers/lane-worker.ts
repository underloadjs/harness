// The lane worker ENTRY - the file a `Worker` is spawned with.
//
// TWO LOAD MODES, ONE FILE
// ------------------------
//   - BUILT (`dist/underload-harness.worker.mjs`): the shipped bundle. Its imports are
//     already resolved by the bundler, so nothing is needed here except to evaluate the loop.
//   - SOURCE (`src/server/workers/lane-worker.ts`): dev, `vite-node`, and the test run, where
//     no build exists yet. Node can evaluate TypeScript directly (type stripping is on in
//     Node >=23.6, and ./lane-host.ts adds `--experimental-transform-types` for the
//     parameter properties this repo's classes use), but it cannot resolve this repo's
//     extension-less relative specifiers (`from './protocol'`). The synchronous resolve hooks
//     below map them onto `.ts` files and directory `index.ts` entries, which is exactly the
//     job Vite's resolver does in a build.
//
// WHY `import.meta.url` DECIDES
// -----------------------------
// The same module knows which layout it is in by its own address: a `.ts` URL means the
// source tree, anything else means a bundle. No flag, no environment variable, and no
// chance of a built worker trying to install hooks it does not need (or a source worker
// failing to install the ones it does).
//
// Cross-references:
//   - ./lane-host.ts        - resolves this path and spawns the Worker
//   - ./lane-worker-loop.ts - the message loop this entry evaluates
//   - ../../../vite.config.ts - emits this entry as underload-harness.worker.mjs

import { existsSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const SOURCE_LAYOUT = import.meta.url.endsWith('.ts');

const isFile = (url: URL): boolean => {
    try {
        return existsSync(url) && statSync(fileURLToPath(url)).isFile();
    } catch {
        return false;
    }
};

if (SOURCE_LAYOUT) {
    registerHooks({
        resolve(specifier, context, nextResolve) {
            // Only relative specifiers need help; bare specifiers (`typescript`, `dotenv`)
            // and explicit .json/.mjs/.node paths resolve normally.
            if (!specifier.startsWith('.') || /\.(?:mjs|cjs|json|node|ts)$/.test(specifier)) {
                return nextResolve(specifier, context);
            }

            const candidates = specifier.endsWith('.js')
                ? // A TypeScript source written against NodeNext may spell a sibling `.js`.
                  [new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL)]
                : [
                      new URL(`${specifier}.ts`, context.parentURL),
                      // A directory import (`from './core'`) means `core/index.ts` here, the
                      // same reading every bundler in this repo uses.
                      new URL(`${specifier.replace(/\/+$/, '')}/index.ts`, context.parentURL)
                  ];

            for (const candidate of candidates) {
                if (isFile(candidate)) {
                    // No `format`: Node's own translator decides. Declaring `module` here
                    // would send a `.ts` file through the JavaScript compiler and lose the
                    // type stripping this mode depends on (measured: SyntaxError
                    // "Unexpected token '{'" from compileSourceTextModule).
                    return { url: candidate.href, shortCircuit: true };
                }
            }

            return nextResolve(specifier, context);
        }
    });
}

// The loop registers its own `parentPort` listener and stays alive from the message loop:
// a worker does not service `parentPort` while its module body is still evaluating (measured
// on Node 24), so evaluation must finish before any turn can run.
const laneWorkerLoop = await import('./lane-worker-loop.ts');

// The export is REFERENCED and CALLED, not merely imported: an unreferenced dynamic import is
// shaken down to an empty namespace by the bundler (measured in `dist/`), which would ship a
// worker that answers nothing. This call is what keeps the built entry alive.
laneWorkerLoop.startLaneWorker();

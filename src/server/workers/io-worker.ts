// The lane worker's durability arm - see ./io-worker-loop.ts for what runs on the thread.
//
// TWO LOAD MODES, ONE FILE
// ------------------------
//   - BUILT (`dist/underload-harness.io-worker.mjs`): the shipped bundle. Its imports were
//     resolved by the bundler, so this entry only has to evaluate the loop.
//   - SOURCE (`src/server/workers/io-worker.ts`): dev, `vite-node`, and the test run, where
//     no build exists yet. Node evaluates TypeScript directly (type stripping is on since
//     Node >=23.6, and ./io-client.ts adds `--experimental-transform-types` for the
//     parameter properties ../persistence.ts and ../journal.ts use), but it cannot resolve
//     this repo's extension-less relative specifiers (`from '../persistence'`). The resolve
//     hooks below map them onto `.ts` files and directory `index.ts` entries - the job
//     Vite's resolver does in a build.
//
// WHY THE HOOKS CANNOT LIVE IN THE LOOP MODULE
// --------------------------------------------
// A module's own static imports are resolved BEFORE its body runs, so a hook registered in
// the body of the file that imports `../persistence` is already too late. The entry
// therefore holds no imports of the graph it needs resolved, and loads the loop with a
// dynamic import AFTER the hooks are installed. (./lane-worker.ts makes the same split for
// the same reason; keeping both entries shaped alike is what stops a future reader from
// "simplifying" one of them into a broken state.)
//
// WHY `import.meta.url` DECIDES
// -----------------------------
// The module knows which layout it is in by its own address: a `.ts` URL means the source
// tree, anything else means a bundle. No flag, no environment variable, and no chance of a
// built worker installing hooks it does not need - or a source worker failing to install the
// ones it does.
//
// Cross-references:
//   - ./io-client.ts      - resolves this path and spawns the Worker
//   - ./io-worker-loop.ts - the operation table and message loop this entry evaluates
//   - ./io-protocol.ts    - the boot marker the client passes in `workerData`
//   - ../../../vite.config.ts - emits this entry (see `ioWorkerEntryCandidates`)

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
            // Only relative specifiers need help. Bare specifiers (`@underload/harness`) and
            // explicit .json/.mjs/.node/.ts paths resolve through Node's own rules, and the
            // worker graph needs nothing else (it is fs-only by design - see
            // ./io-client.test.ts, which asserts the built bundle imports nothing but node:
            // builtins).
            if (!specifier.startsWith('.') || /\.(?:mjs|cjs|json|node|ts)$/.test(specifier)) {
                return nextResolve(specifier, context);
            }

            const candidates = specifier.endsWith('.js')
                ? // A TypeScript source written against NodeNext may spell a sibling `.js`.
                  [new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL)]
                : [
                      new URL(`${specifier}.ts`, context.parentURL),
                      // A directory import (`from '../shared'`) means `shared/index.ts` here,
                      // the same reading every bundler in this repo uses.
                      new URL(`${specifier.replace(/\/+$/, '')}/index.ts`, context.parentURL)
                  ];

            for (const candidate of candidates) {
                if (isFile(candidate)) {
                    // No `format`: Node's own translator decides, which is what keeps the
                    // type stripping of a `.ts` file intact.
                    return { url: candidate.href, shortCircuit: true };
                }
            }

            return nextResolve(specifier, context);
        }
    });
}

// The loop registers its own `parentPort` listener and answers from the message loop: a
// worker does not service `parentPort` while its module body is still evaluating (measured
// on Node 24), so evaluation has to finish before the coordinator's `hello` can be
// answered. The dynamic specifier carries its extension on purpose - the built bundle
// resolves it into a sibling chunk in dist/.
//
// THE CALL IS NOT OPTIONAL. The package manifest says `"sideEffects": false`, so a bundler
// is free to drop a dynamically imported module whose exports are never used, and it does:
// an entry that only awaited the import compiled to a 1 KB bundle that never contained the
// loop, and the worker exited with code 0 without answering `hello` (measured on this
// config). Naming the export is what makes the loop part of the build - and the call is a
// no-op unless `workerData` carries the marker ./io-client.ts sends, so importing this
// entry from a test still has no side effect.
const loop = await import('./io-worker-loop.ts');

loop.startIoWorker();

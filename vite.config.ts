// Vite config for the @underload/harness npm build.
//
// One library build emits every public entry as ESM, matching the `exports` map
// in package.json:
//
//   src/index.ts          -> dist/underload-harness.mjs         (Node root)
//   src/browser.ts        -> dist/underload-harness.browser.mjs (browser root)
//   src/server/index.ts   -> dist/underload-harness.server.mjs  (@underload/harness/server)
//   src/frontend/index.ts -> dist/underload-harness.frontend.mjs(@underload/harness/frontend)
//   src/shared/index.ts   -> dist/underload-harness.shared.mjs  (@underload/harness/shared)
//
// Why more than one entry: a browser cannot load the server tree (`node:http`,
// sessions, presets) and a Node host must not be forced through the browser
// client, so the root export is resolved by CONDITION (`browser` vs `node`) to a
// different entry. Rollup still shares the library/shared chunks between them.
//
// The application shell (src/frontend/index.html + main.ts, which imports CSS) is
// NOT part of this build: it is the separate `build:frontend` app build, whose
// output (src/frontend/dist) is what the standalone server serves statically.
import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Every entry is addressed by source path so a missing file fails the build
// instead of silently emitting an empty module.
const entry = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

// Node builtins must stay external under BOTH spellings.
//
//   - `node:fs` — what our own sources import.
//   - `fs`      — what CommonJS dependencies use. `dotenv` (bundled into the server
//                 entry) does `require('fs')` / `require('path')` / `require('os')`
//                 / `require('crypto')`. A lib build is browser-platform by default,
//                 so Vite resolved those bare specifiers to an empty
//                 `__vite-browser-external` stub and warned — which made the
//                 PUBLISHED `loadEnvironmentFile()` throw `r.resolve is not a
//                 function` (dotenv's `path`) and therefore `startHarnessServer()`
//                 fail at its first line. Externalising the bare names keeps the
//                 Node semantics the server entry documents.
//
// Scratch regression check: `scripts/check-package-runtime.mjs` exercises the built
// dotenv path and a real listener against `dist/`.
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nodeBuiltins = builtinModules.filter((id) => !id.startsWith('node:')).map(escapeRegExp);

// `dotenv` is external as well, and declared in `dependencies`.
//
// It is CommonJS that calls `require('fs')`/`require('path')`. Bundling it into an
// ESM output makes rolldown keep those calls as a runtime `require`, which an ESM
// module does not have (`Calling require for "fs" in an environment that doesn't
// expose the require function`) — the built `loadEnvironmentFile()` then fails at
// import time and takes `startHarnessServer()` with it. Externalising it keeps Node's
// own CJS interop, and only the server entry ever imports it (the browser graph has
// no environment/dotenv module at all).
const external = [/^node:/, new RegExp(`^(?:${nodeBuiltins.join('|')})$`), /^dotenv$/];

export default defineConfig({
    build: {
        lib: {
            entry: {
                index: entry('./src/index.ts'),
                browser: entry('./src/browser.ts'),
                server: entry('./src/server/index.ts'),
                frontend: entry('./src/frontend/index.ts'),
                shared: entry('./src/shared/index.ts')
            },
            formats: ['es']
        },
        rollupOptions: {
            external,
            output: {
                // Keep the documented root filename stable (`main`/`module` in
                // package.json) and give every other entry an explicit name.
                entryFileNames: (chunk) =>
                    chunk.name === 'index'
                        ? 'underload-harness.mjs'
                        : `underload-harness.${chunk.name}.mjs`
                // Presets load their implementation through `import()` (see
                // src/tools/catalogue.ts). Those must stay deferred chunks: inlining
                // them would hoist every `node:fs`/`child_process`/`vm` import into
                // the entry and make importing the package pay for all ten tools.
                // That is the default (code splitting enabled) — never set
                // `codeSplitting: false` / `inlineDynamicImports: true` here.
            }
        },
        sourcemap: true,
        emptyOutDir: true
    }
});

// Vite config for the @underload/harness npm build.
//
// Two library builds emit every public entry as ESM, matching the `exports` map
// in package.json:
//
//   src/index.ts          -> dist/underload-harness.mjs         (Node root)
//   src/browser.ts        -> dist/underload-harness.browser.mjs (browser root)
//   src/server/index.ts   -> dist/underload-harness.server.mjs  (@underload/harness/server)
//   src/frontend/index.ts -> dist/underload-harness.frontend.mjs(@underload/harness/frontend)
//   src/shared/index.ts   -> dist/underload-harness.shared.mjs  (@underload/harness/shared)
//
// Why two builds: a browser cannot load the server tree (`node:http`, sessions,
// presets) OR the Node-only source compiler (`node:fs`, TypeScript). A single
// multi-entry graph shares `src/harness.ts` between the Node and browser roots,
// which would place the compiler in the browser chunk. The browser entry is
// therefore built first with `core/tool-source` aliased to its browser stub; the
// remaining entries are built afterward into the same (now non-empty) dist.
//
// The application shell (src/frontend/index.html + main.ts, which imports CSS) is
// NOT part of this build: it is the separate `build:frontend` app build, whose
// output (src/frontend/dist) is what the standalone server serves statically.
import { builtinModules } from 'node:module';
import { readFileSync } from 'node:fs';
import { build as viteBuild, defineConfig, type UserConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// The published package declares its runtime requirements in `dependencies`.
// Reading the manifest here (instead of hard-coding `dotenv`) keeps the build
// honest when the runtime compiler adds a dependency later: the kernel owner only
// changes package.json, and that package stays external automatically.
const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
    dependencies?: Record<string, string>;
};

// Every entry is addressed by source path so a missing file fails the build
// instead of silently emitting an empty module.
const entry = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

// Node builtins must stay external under BOTH spellings.
//
//   - `node:fs` — what our own sources import.
//   - `fs`      — what CommonJS dependencies use. `dotenv` does `require('fs')` /
//                 `require('path')` / `require('os')` / `require('crypto')`. A lib
//                 build is browser-platform by default, so Vite resolved those bare
//                 specifiers to an empty `__vite-browser-external` stub and warned
//                 — which made the PUBLISHED `loadEnvironmentFile()` throw
//                 `r.resolve is not a function` (dotenv's `path`) and therefore
//                 `startHarnessServer()` fail at its first line. Externalising the
//                 bare names keeps the Node semantics the server entry documents
//                 (dotenv itself is external too, below).
//
// Scratch regression check: `scripts/check-package-runtime.mjs` exercises the built
// dotenv path and a real listener against `dist/`.
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nodeBuiltins = builtinModules.filter((id) => !id.startsWith('node:')).map(escapeRegExp);

// Every `dependencies` entry is external, including its subpaths. `dotenv` is the
// current entry and the reason the mechanism matters.
//
// `dotenv` is CommonJS that calls `require('fs')`/`require('path')`. Bundling it
// into an ESM output makes rolldown keep those calls as a runtime `require`, which
// an ESM module does not have (`Calling require for "fs" in an environment that
// doesn't expose the require function`) — the built `loadEnvironmentFile()` then
// fails at import time and takes `startHarnessServer()` with it. Externalising it
// keeps Node's own CJS interop, and only the server entry ever imports it (the
// browser graph has no environment/dotenv module at all).
//
// `devDependencies` are deliberately NOT external: `marked`, `dompurify`, and
// `highlight.js` are bundled into the browser entry, and a published install only
// guarantees `dependencies` are present. `typescript` (the runtime compiler used
// by src/core/tool-source.ts) is intentionally in `dependencies`, so it stays
// external and ships with the package — see scripts/check-package-types.mjs,
// which fails if dist imports an undeclared runtime dependency.
const dependencyExternal = Object.keys(manifest.dependencies ?? {}).map(
    (dependency) => new RegExp(`^${escapeRegExp(dependency)}(?:/.*)?$`)
);
const external = [/^node:/, new RegExp(`^(?:${nodeBuiltins.join('|')})$`), ...dependencyExternal];

// The BROWSER entry is a separate build on purpose.
//
// A single multi-entry build shares `src/harness.ts` between the Node and browser
// roots, and `harness.ts` reaches the source compiler through `core/tool-source`.
// Sharing that module puts `node:fs`/TypeScript in the browser graph. The browser
// build therefore runs FIRST with a single, explicit alias that swaps the
// compiler for `core/tool-source-browser.ts` (a small, honest stub that rejects
// source registration), then the Node/shared build fills the rest of dist.
// Splitting the graph is what keeps the browser import genuinely free of Node
// builtins and TypeScript while preserving the rest of the browser public surface.
//
// T21 note: tool DISCOVERY needs no alias here. `core/tool-discovery` reaches its
// Node runtime through `core/tool-scan`, which loads `node:fs`/`typescript` via a
// single dynamic `import(/* @vite-ignore */ specifier)` and reports
// `supportsToolScan === false` in a browser. Discovery then returns the GENERATED
// `core/tool-manifest.ts` data (the T19 browser fallback), so the browser graph
// contains the manifest and the generated loaders, never a Node built-in. Do not
// alias `./tool-discovery` to the manifest: the manifest exports DATA + the loader,
// not the `discoverToolMetadata` function a caller imports.
const root = fileURLToPath(new URL('.', import.meta.url));

const browserConfig: UserConfig = {
    root,
    resolve: {
        alias: [
            // Only `core/index` imports this specifier. The alias is scoped to the
            // browser build, so the Node graph still gets the real compiler.
            {
                find: /^\.\/tool-source$/,
                replacement: entry('./src/core/tool-source-browser.ts')
            }
        ]
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        lib: {
            entry: entry('./src/browser.ts'),
            formats: ['es'],
            fileName: () => 'underload-harness.browser.mjs'
        },
        rollupOptions: {
            external,
            // Keep client helpers and lazy preset bodies as ordinary chunks; the
            // browser root is the only static entry of this build.
            output: {
                entryFileNames: 'underload-harness.browser.mjs'
            }
        },
        sourcemap: true
    }
};

const nodeConfig: UserConfig = {
    build: {
        // The browser build already emptied dist and emitted its entry. The Node
        // build must add to that directory, not erase it.
        emptyOutDir: false,
        lib: {
            entry: {
                index: entry('./src/index.ts'),
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
        sourcemap: true
    }
};

export default defineConfig(async (environment) => {
    // A dev server never builds. Only `vite build` needs the two-phase graph.
    if (environment.command === 'build') {
        // `configFile: false` prevents this configuration from being loaded again.
        await viteBuild({ configFile: false, ...browserConfig });
    }

    return nodeConfig;
});

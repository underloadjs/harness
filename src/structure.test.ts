// Structure + import-safety contract for the R1/R2 layout.
//
// What this file pins (all deterministic, all read from the source tree):
//   1. the application tree lives under src/ (frontend + server + shared) and the
//      old top-level folders are gone;
//   2. package.json resolves SOURCE FIRST for a dev/test host: `main`/`module`/
//      `types` are `./src/index.ts` and every published subpath declares a
//      `development` condition onto its raw `./src/*.ts` entry, placed BEFORE the
//      runtime conditions. The `types` conditions intentionally stay on explicit
//      `./dist/*.d.ts` targets (no implicit `.d.ts` sibling resolution) because a
//      NodeNext consumer cannot read `src/*.ts` — its relative specifiers are
//      extensionless. `dist/` is therefore the npm-distribution bundle ONLY: no
//      workspace run evaluates a stale build (items 8-9 below are the proofs);
//   3. the frontend and server launches are separate — `dev:frontend` is Vite
//      only, `dev:server` is the explicit standalone API, and the @underload/service
//      gateway still owns the normal listener (imports bind nothing);
//   4. each root entry composes the layers it is allowed to reach (Node root:
//      library + shared + server + client; browser root: library + shared +
//      client, never the server tree);
//   5. the client barrel contains neither the app shell nor a stylesheet;
//   6. importing the Node root binds no listener and re-exports the whole surface;
//   7. the @underload/service endpoint modules keep the folder/name contract the
//      loader discovers (`endpoint/` + `service-route*.ts` default export);
//   8. Vite's OWN resolver maps all six published specifiers to the `src/*.ts`
//      development entries and never to `dist/`, so the manifest conditions (not a
//      hand-written alias table) are what make `vitest run` build-free;
//   9. ../tsconfig.json `paths` mirror those same `development` targets file for
//      file, so editors, `tsc --noEmit` and the suite all mean the same module.
//
// Cross-references:
//   - ../package.json             — "exports" / "files" / "main|module|types" asserted below
//   - ../tsconfig.json            — `paths`, asserted as a mirror of `exports.development`
//   - ../vitest.config.ts         — deliberately has NO `resolve.alias` block; it
//     relies on the `development` condition asserted here
//   - ../scripts/check-package-types.mjs — the built-package check that enforces the
//     same rule for a published consumer (F3: every subpath needs a `./src/*.ts`
//     `development` target)
//   - ../tsconfig.build.json — emits dist/<entry>.d.ts for these entries
//   - ../vite.config.ts       — the six library entries (browser root, then index/
//     server/frontend/shared plus the `worker` lane-worker executable)
//   - ./server/service-start.test.ts — the end-to-end proof that the real service
//     gateway serves /v1/harness from the moved endpoint folder

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// `src/` — this file sits at its root.
const SRC = fileURLToPath(new URL('.', import.meta.url));
const PACKAGE_ROOT = path.resolve(SRC, '..');

const readText = (relativePath: string): string =>
    fs.readFileSync(path.join(PACKAGE_ROOT, relativePath), 'utf8');

// Removes JSONC comment SYNTAX only: `//` runs to the end of the line and `/* */`
// blocks, but never inside a string literal.
//
// Why not the plain regex pair: ../tsconfig.json comments legitimately contain
// `dist/*.d.ts` and `src/*.ts`, and `/\*[\s\S]*?\*\/` reads the `/*` inside
// `dist/*.d.ts` as a block-comment opener, swallowing every `paths` entry up to the
// `*/` of the `"**/*.ts"` glob (i.e. exactly the block this file asserts on). The
// same pair also mangles the `"**/*.test.ts"` globs in ../tsconfig.build.json.
const stripJsonComments = (text: string): string => {
    let out = '';
    let inString = false;

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];

        if (inString) {
            // Inside a string only `\x` escapes are structural, so a `//` (a URL, a
            // glob) is copied verbatim.
            out += char;
            if (char === '\\') {
                out += next ?? '';
                index += 1;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
            out += char;
        } else if (char === '/' && next === '/') {
            // Line comment: skip to the newline and keep it, so a parse error still
            // reports the original line number.
            while (index < text.length && text[index] !== '\n') index += 1;
            out += '\n';
        } else if (char === '/' && next === '*') {
            // Block comment: skip through the closing `*/`, keeping only its newlines
            // (same reason: line numbers must survive).
            index += 2;
            const end = text.indexOf('*/', index);
            out += (end === -1 ? text.slice(index) : text.slice(index, end)).replace(/[^\n]/g, '');
            index = end === -1 ? text.length : end + 1;
        } else {
            out += char;
        }
    }

    return out;
};

// tsconfig files are JSONC; comments are stripped before parsing.
const readConfig = (relativePath: string): Record<string, any> =>
    JSON.parse(stripJsonComments(readText(relativePath))) as Record<string, any>;

// Ordered list of `export * from '<specifier>'` targets in a barrel. Explicit
// named re-exports (`export { ... }`) are intentionally ignored: this asserts the
// layer composition, not every symbol.
const starExports = (source: string): string[] =>
    [...source.matchAll(/^export \* from '([^']+)';$/gm)].map((match) => match[1]);

type PackageManifest = {
    main: string;
    module: string;
    types: string;
    exports: Record<string, Record<string, string>>;
    scripts: Record<string, string>;
};

const manifest = JSON.parse(readText('package.json')) as PackageManifest;

// One flattened row per string target of the exports map. `condition` keeps the
// dotted path from the subpath (root `browser.types` => `..browser.types`), so a
// test can classify a target by its FINAL condition key while `subpath` says which
// published entry it belongs to.
type ExportTarget = { subpath: string; condition: string; target: string };

const flattenExportTargets = (exportsMap: unknown): ExportTarget[] => {
    const targets: ExportTarget[] = [];
    const walk = (subpath: string, condition: string, value: unknown): void => {
        if (typeof value === 'string') {
            targets.push({ subpath, condition, target: value });
            return;
        }
        for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
            walk(subpath, `${condition}.${key}`, nested);
        }
    };
    for (const [subpath, value] of Object.entries(exportsMap as Record<string, unknown>)) {
        walk(subpath, subpath, value);
    }
    return targets;
};

const exportTargets: ExportTarget[] = flattenExportTargets(manifest.exports);

// The two declared condition families. Everything that is neither is a published
// RUNTIME condition (`node` / `import` / `default`, including the ones nested under
// the `browser` group) and must be a dist bundle.
const isTypesCondition = (condition: string): boolean => condition.endsWith('types');
const isDevelopmentCondition = (condition: string): boolean => condition.endsWith('development');

// `development` targets grouped by subpath, in declaration order. Root and
// ./frontend declare the condition twice (top level + inside `browser`); a missing
// entry means that subpath silently falls back to the bundle in a dev/test run.
const developmentTargetsBySubpath: Record<string, string[]> = {};
for (const { subpath, condition, target } of exportTargets) {
    if (!isDevelopmentCondition(condition)) continue;
    (developmentTargetsBySubpath[subpath] ??= []).push(target);
}

// The six published code specifiers, in the order the manifest declares them, with
// the single source file each one must resolve to. `./package.json` is a manifest
// re-export, not a code entry, so it is not part of this table.
const PUBLISHED_SPECIFIERS = [
    { subpath: '.', specifier: '@underload/harness', source: './src/index.ts' },
    { subpath: './server', specifier: '@underload/harness/server', source: './src/server/index.ts' },
    { subpath: './worker', specifier: '@underload/harness/worker', source: './src/server/workers/lane-worker.ts' },
    { subpath: './io-worker', specifier: '@underload/harness/io-worker', source: './src/server/workers/io-worker.ts' },
    { subpath: './frontend', specifier: '@underload/harness/frontend', source: './src/frontend/index.ts' },
    { subpath: './shared', specifier: '@underload/harness/shared', source: './src/shared/index.ts' }
] as const;

describe('package layout', () => {
    it('keeps the application tree under src/ and removes the old top-level folders', () => {
        const topLevel = fs.readdirSync(PACKAGE_ROOT);
        const legacy = ['cli', 'endpoint', 'harnesses', 'playground', 'server'];

        expect(topLevel.filter((name) => legacy.includes(name))).toEqual([]);

        // The three application folders plus the untouched library tree. Files at
        // the root are not pinned one by one: the library's own tests are added by
        // other workstreams, so only the folder contract and the published entries
        // are part of this layout.
        const folders = fs
            .readdirSync(SRC, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort();
        expect(folders).toEqual([
            'agents',
            'core',
            'frontend',
            'plugin',
            // R2/R3/R4: the auto-discovered built-in plugins. `src/plugins` is the
            // scanned folder (one `*.plugin.ts` per plugin); `src/plugin` stays the
            // host/loader. The manifest generator requires the folder to exist.
            'plugins',
            'server',
            'shared',
            'tools',
            'transport',
            'types',
            'util'
        ]);

        // Each layer has exactly one barrel/entry: the published targets.
        for (const entry of [
            'src/index.ts',
            'src/browser.ts',
            'src/server/index.ts',
            'src/frontend/index.ts',
            'src/frontend/main.ts',
            'src/shared/index.ts',
            'src/harness.ts'
        ]) {
            expect(fs.existsSync(path.join(PACKAGE_ROOT, entry))).toBe(true);
        }
    });

    it('publishes every entry with environment-matched types', () => {
        // Exact map. Two rules hold at once:
        //   - every condition declares `types` explicitly (no implicit `.d.ts`
        //     sibling resolution), and the ROOT resolves its TYPES by environment
        //     too — `browser` first (so a browser consumer gets dist/browser.d.ts),
        //     then the Node/`types` path. A single unconditional root `types` would
        //     shadow the browser condition and hand a browser consumer the Node
        //     server surface;
        //   - every published subpath declares `development` BEFORE the runtime
        //     conditions, pointing at the raw `src/*.ts` entry. Vite/Vitest/vite-node
        //     select `development` in dev + test mode, so a workspace run evaluates
        //     the source being edited; `node`/`import`/`default` (the dist bundles)
        //     are what an installed production consumer gets.
        expect(manifest.exports).toEqual({
            '.': {
                browser: {
                    types: './dist/browser.d.ts',
                    development: './src/browser.ts',
                    default: './dist/underload-harness.browser.mjs'
                },
                types: './dist/index.d.ts',
                development: './src/index.ts',
                node: './dist/underload-harness.mjs',
                import: './dist/underload-harness.mjs',
                default: './dist/underload-harness.mjs'
            },
            './server': {
                types: './dist/server/index.d.ts',
                development: './src/server/index.ts',
                import: './dist/underload-harness.server.mjs',
                default: './dist/underload-harness.server.mjs'
            },
            // T5 (R1): the lane-worker EXECUTABLE. It is published as a subpath so an
            // installed host can spawn `dist/underload-harness.worker.mjs` by specifier;
            // ./../vite.config.ts emits it as a library entry named `worker`.
            './worker': {
                types: './dist/server/workers/lane-worker.d.ts',
                development: './src/server/workers/lane-worker.ts',
                import: './dist/underload-harness.worker.mjs',
                default: './dist/underload-harness.worker.mjs'
            },
            // D4 (R1/R2/R4): the IO-worker EXECUTABLE, published as its own subpath for the
            // same reason `./worker` is - an installed host spawns `dist/underload-harness
            // .io-worker.mjs` by specifier (./workers/io-client.ts resolves exactly this pair:
            // `IO_WORKER_PACKAGE_SPECIFIER` + `IO_WORKER_DIST_FILE`). ../vite.config.ts emits it
            // as the library entry keyed `io-worker`; renaming either side breaks the resolver.
            './io-worker': {
                types: './dist/server/workers/io-worker.d.ts',
                development: './src/server/workers/io-worker.ts',
                import: './dist/underload-harness.io-worker.mjs',
                default: './dist/underload-harness.io-worker.mjs'
            },
            './frontend': {
                browser: {
                    types: './dist/frontend/index.d.ts',
                    development: './src/frontend/index.ts',
                    default: './dist/underload-harness.frontend.mjs'
                },
                types: './dist/frontend/index.d.ts',
                development: './src/frontend/index.ts',
                import: './dist/underload-harness.frontend.mjs',
                default: './dist/underload-harness.frontend.mjs'
            },
            './shared': {
                types: './dist/shared/index.d.ts',
                development: './src/shared/index.ts',
                import: './dist/underload-harness.shared.mjs',
                default: './dist/underload-harness.shared.mjs'
            },
            './package.json': './package.json'
        });

        // The library/Node root is resolved from SOURCE by a dev/test host: `main`,
        // `module` and `types` all name `src/index.ts` (the field a bundler or `tsc`
        // reads when it has no `exports` support), while the published runtime
        // conditions above still hand an installed consumer the dist bundle.
        expect(manifest.main).toBe('./src/index.ts');
        expect(manifest.module).toBe('./src/index.ts');
        expect(manifest.types).toBe('./src/index.ts');

        // Source-first coverage: every published CODE subpath carries a
        // `development` target (../scripts/check-package-types.mjs:239-247 fails the
        // release for the same omission). `./package.json` is a manifest re-export and
        // intentionally has none.
        expect(Object.keys(developmentTargetsBySubpath)).toEqual([
            '.',
            './server',
            './worker',
            './io-worker',
            './frontend',
            './shared'
        ]);
    });

    it('publishes only targets inside "files", each with a matching extension', () => {
        // Publish coverage: an export target outside `files` is a 404 after install,
        // and each condition family has its own target rule — a `types` target must be
        // an emitted `.d.ts`, a `development` target must be a real `src/*.ts` file, and
        // a runtime target must be a bundled `.mjs`. Anything else cannot resolve for a
        // consumer (or, for `development`, cannot be edited).
        const files = manifest.files ?? [];
        // Production self-modification needs the editable source tree beside
        // dist: the runtime compiler reads these files rather than compiled
        // package artifacts alone.
        expect(files).toEqual([
            'dist',
            'src',
            '!src/**/*.test.ts',
            '!src/**/*.test.tsx',
            '!src/**/*.spec.ts',
            '!src/**/*.spec.tsx',
            '!src/**/__snapshots__/**',
            '!src/frontend/dist/**',
            '!src/**/node_modules/**',
            '!src/**/.vite/**'
        ]);

        // Rows come from the module-level walk shared with the resolution tests.
        const published = exportTargets.filter(({ subpath }) => subpath !== './package.json');
        // 31 = root 8 (browser.types/development/default, types, development, node,
        // import, default) + ./server 4 (types/development/import/default) + ./worker 4
        // (T5 lane-worker executable) + ./io-worker 4 (D4 IO-worker executable) +
        // ./frontend 7 (browser.types/development/default + types/development/import/
        // default) + ./shared 4.
        expect(published.length).toBe(31);

        // Family 1 — `types`: the emitted declarations. A NodeNext consumer cannot
        // read `src/*.ts` (its relative specifiers are extensionless), so these stay
        // under dist/ even though the dev/test runtime does not.
        const typeTargets = published.filter(({ condition }) => isTypesCondition(condition));
        expect(typeTargets.map(({ target }) => target)).toEqual([
            './dist/browser.d.ts',
            './dist/index.d.ts',
            './dist/server/index.d.ts',
            './dist/server/workers/lane-worker.d.ts',
            './dist/server/workers/io-worker.d.ts',
            './dist/frontend/index.d.ts',
            './dist/frontend/index.d.ts',
            './dist/shared/index.d.ts'
        ]);

        // Family 2 — `development`: raw TypeScript entries, the dev/test answer. They
        // must exist on disk, because the point of source-first resolution is that the
        // file being edited IS the file a workspace run evaluates.
        const developmentTargets = published.filter(({ condition }) => isDevelopmentCondition(condition));
        expect(developmentTargets.map(({ target }) => target)).toEqual([
            './src/browser.ts',
            './src/index.ts',
            './src/server/index.ts',
            './src/server/workers/lane-worker.ts',
            './src/server/workers/io-worker.ts',
            './src/frontend/index.ts',
            './src/frontend/index.ts',
            './src/shared/index.ts'
        ]);
        for (const { target } of developmentTargets) {
            expect(fs.existsSync(path.join(PACKAGE_ROOT, target))).toBe(true);
        }

        // Family 3 — every remaining condition is a published RUNTIME target, and an
        // installed host only ever loads the bundled `.mjs` inside `files`.
        const runtimeTargets = published.filter(
            ({ condition }) => !isTypesCondition(condition) && !isDevelopmentCondition(condition)
        );
        expect(runtimeTargets.map(({ target }) => target)).toEqual([
            './dist/underload-harness.browser.mjs',
            './dist/underload-harness.mjs',
            './dist/underload-harness.mjs',
            './dist/underload-harness.mjs',
            './dist/underload-harness.server.mjs',
            './dist/underload-harness.server.mjs',
            './dist/underload-harness.worker.mjs',
            './dist/underload-harness.worker.mjs',
            './dist/underload-harness.io-worker.mjs',
            './dist/underload-harness.io-worker.mjs',
            './dist/underload-harness.frontend.mjs',
            './dist/underload-harness.frontend.mjs',
            './dist/underload-harness.frontend.mjs',
            './dist/underload-harness.shared.mjs',
            './dist/underload-harness.shared.mjs'
        ]);

        // Exact per-family counts, 8 types + 8 development + 15 runtime = 31. The
        // prefix/extension rule of each family (dist/.d.ts, src/.ts, dist/.mjs) is
        // already pinned by the three full-list assertions above.
        expect([typeTargets.length, developmentTargets.length, runtimeTargets.length]).toEqual([8, 8, 15]);
    });

    it('resolves every published specifier to source, never to dist, for a dev/test host', async () => {
        // The build-free claim in ../vitest.config.ts is only true because of the
        // `development` conditions asserted above, so the proof goes through Vite's OWN
        // resolver instead of a re-implementation: `createServer` runs in dev mode, where
        // Vite selects `development` ahead of `node`/`import`/`default`. `ssr: true`
        // matches the node test environment of ./vitest.config.ts (the client chain would
        // answer `src/browser.ts` for the root — a different, also-source file).
        //
        // `configFile: false` keeps the probe about manifest conditions only, and
        // `cacheDir` points at the repository root Temp/ (AGENTS.md scratch policy) so a
        // nested dev server can never disturb the optimize-deps cache of the suite that is
        // running this file.
        const { createServer } = await import('vite');
        const scratch = path.join(
            fileURLToPath(new URL('../../../../Temp/', import.meta.url)),
            `harness-resolution-${process.pid}-${Date.now()}`
        );
        // Absolute ids come back with platform separators; normalizing both sides keeps
        // the comparison an exact string equality.
        const toPosix = (value: string): string => value.replace(/\\/g, '/');

        const server = await createServer({
            configFile: false,
            root: PACKAGE_ROOT,
            cacheDir: scratch,
            logLevel: 'silent'
        });

        try {
            const resolvedIds: Record<string, string> = {};
            const expectedIds: Record<string, string> = {};
            for (const { specifier, source } of PUBLISHED_SPECIFIERS) {
                const resolved = await server.pluginContainer.resolveId(specifier, undefined, { ssr: true });
                // An unresolved specifier is recorded as 'undefined', so the exact
                // comparison below fails instead of skipping the assertion.
                resolvedIds[specifier] = resolved ? toPosix(resolved.id) : 'undefined';
                expectedIds[specifier] = toPosix(path.join(PACKAGE_ROOT, source));
            }

            expect(resolvedIds).toEqual(expectedIds);

            // Belt for the headline rule: no published specifier may reach the bundle.
            expect(Object.values(resolvedIds).some((id) => id.includes('/dist/'))).toBe(false);
        } finally {
            await server.close();
            fs.rmSync(scratch, { recursive: true, force: true });
        }
    });

    it('keeps tsconfig paths and the package development targets on the same files', () => {
        // Three mirrors of one specifier map: package.json `exports.*.development`
        // (Vite / Vitest / vite-node), ../tsconfig.json `paths` (editors and
        // `tsc --noEmit`), and the real files on disk. They must name the SAME file or a
        // test silently typechecks one module while executing another. `paths` is needed
        // at all because the published `types` conditions stay on `dist/*.d.ts`, which a
        // workspace run must not be typed against.
        const paths = readConfig('tsconfig.json').compilerOptions.paths as Record<string, string[]>;

        // Exact key set: the six published specifiers, no stale alias left behind.
        expect(Object.keys(paths).sort()).toEqual([
            '@underload/harness',
            '@underload/harness/frontend',
            '@underload/harness/io-worker',
            '@underload/harness/server',
            '@underload/harness/shared',
            '@underload/harness/worker'
        ]);

        // Exact per-subpath declaration multiset, in manifest order. This is also the
        // "every subpath carries one" proof: a subpath without a `development` target
        // would be missing from this object.
        expect(developmentTargetsBySubpath).toEqual({
            '.': ['./src/browser.ts', './src/index.ts'],
            './server': ['./src/server/index.ts'],
            './worker': ['./src/server/workers/lane-worker.ts'],
            './io-worker': ['./src/server/workers/io-worker.ts'],
            './frontend': ['./src/frontend/index.ts', './src/frontend/index.ts'],
            './shared': ['./src/shared/index.ts']
        });

        for (const { subpath, specifier, source } of PUBLISHED_SPECIFIERS) {
            // The top-level (non-`browser`) declaration of the condition is the entry a
            // host resolves by bare name; `paths` mirrors exactly that one.
            const topLevel = exportTargets
                .filter(({ subpath: row, condition }) => row === subpath && condition === `${subpath}.development`)
                .map(({ target }) => target);

            expect(topLevel).toEqual([source]);
            expect(paths[specifier]).toEqual(topLevel);
        }

        // The nested `browser` declarations are the other half of the mirror: the
        // browser-safe roots, never the Node server surface.
        const browserDevelopment = exportTargets
            .filter(({ condition }) => condition.endsWith('browser.development'))
            .map(({ subpath, target }) => `${subpath} -> ${target}`);
        expect(browserDevelopment).toEqual([
            '. -> ./src/browser.ts',
            './frontend -> ./src/frontend/index.ts'
        ]);
    });

    it('splits the frontend and server launches without starting one from the other', () => {
        // R1/R2: `dev:frontend` is Vite ONLY (no in-process API); the optional
        // `dev:server` is the standalone Node API (no Vite, no UI). Normal hosting
        // remains the @underload/service gateway (`yarn start-service` at the repo
        // root), which discovers the endpoint modules on its own.
        //
        // The list is asserted as "required scripts exist, forbidden aliases do not"
        // rather than an exact key set: build/release scripts are extended by other
        // workstreams and the invariant is about launch separation, not count.
        for (const script of ['build', 'build:types', 'cli', 'dev:frontend', 'dev:server', 'test', 'test:frontend', 'test:package', 'typecheck']) {
            expect(typeof manifest.scripts[script]).toBe('string');
        }
        for (const forbidden of ['start', 'serve', 'server']) {
            expect(manifest.scripts[forbidden]).toBeUndefined();
        }

        // Exact commands: the frontend script is the Vite dev server, the server
        // script is the standalone launcher. Neither may reference the other layer.
        expect(manifest.scripts['dev:frontend']).toBe('vite --config src/frontend/vite.config.ts');
        expect(manifest.scripts['dev:server']).toBe('vite-node src/server/dev.ts');
        expect(manifest.scripts['dev:frontend']).not.toMatch(/vite-node|src\/server/);
        expect(manifest.scripts['dev:server']).not.toMatch(/--config|src\/frontend/);

        // No script runs the deleted combined launcher or the CLI's explicit
        // `--serve` opt-in: those are typed by a user, never a package script.
        for (const command of Object.values(manifest.scripts)) {
            expect(command).not.toContain('src/frontend/dev.ts');
            expect(command).not.toContain('--serve');
            expect(command).not.toContain('startHarnessServer');
        }
    });

    it('keeps CI on the current frontend scripts and startup wording', () => {
        // The workflow is a second consumer of package.json. It used to name the
        // removed playground scripts, so assert both the current commands and that
        // every `npm run <script>` in the workflow resolves to a real script.
        const workflow = readText('.github/workflows/ci.yml');

        expect(workflow).toContain('run: npm run test:frontend');
        expect(workflow).toContain('run: npm run build:frontend');

        // Retired launch/build names must not survive in the workflow or its
        // comments: the startup split is Vite-only frontend + explicit standalone
        // server, with @underload/service as the normal host.
        for (const retired of [
            'test:playground',
            'build:playground',
            'dev:playground',
            'preview:playground',
            'yarn serve',
            'src/frontend/dev.ts'
        ]) {
            expect(workflow).not.toContain(retired);
        }

        // Every `npm run` target in the workflow must exist in this manifest.
        for (const match of workflow.matchAll(/npm run ([a-z0-9:_-]+)/g)) {
            expect(typeof manifest.scripts[match[1]]).toBe('string');
        }
    });

    it('proxies the canonical /v1/harness root (REST and the stream upgrade) at the running service', async () => {
        // R1 + T14: the browser dials the SAME path it uses in production - `/v1/harness/...` -
        // because `/api` is gone from the contract (src/shared/harness-api.ts:39
        // `HARNESS_API_ROOT`, mirrored by `API_ROOT` in src/frontend/api.ts). Both Vite modes
        // therefore forward the canonical path to the service mount on :5000 with an IDENTITY
        // rewrite, and `ws: true` carries the realtime upgrade (`GET /v1/harness/stream`) to that
        // same host/port. No UI launch needs an embedded API.
        //
        // A page-level `?apiRoot=` or build-time `VITE_HARNESS_API` still overrides the fallback
        // at runtime (src/frontend/api.ts `resolveApiRoot`); this pins only the default.
        //
        // HARNESS_DEV_API is read at config-module load. Clear it for this import so the
        // assertion is independent of the shell that runs the suite.
        const previous = process.env.HARNESS_DEV_API;
        delete process.env.HARNESS_DEV_API;

        try {
            const config = (await import('./frontend/vite.config')).default as any;
            // The proxy key is anchored to the API mount and Vite treats a leading `^` as a RegExp,
            // so it matches exactly `/v1/harness` and `/v1/harness/...` - never an unrelated source
            // module or page route, which would blank the UI when the upstream is down. Pin the
            // exact key at both launch seams.
            const proxyKey = '^/v1/harness(?:/|$)';
            expect(Object.keys(config.server.proxy)).toEqual([proxyKey]);
            expect(Object.keys(config.preview.proxy)).toEqual([proxyKey]);

            const devProxy = config.server.proxy[proxyKey];
            const previewProxy = config.preview.proxy[proxyKey];

            // One object for both modes: dev and preview can never drift.
            expect(devProxy).toBe(previewProxy);
            expect(devProxy.target).toBe('http://127.0.0.1:5000');
            expect(devProxy.changeOrigin).toBe(true);

            // Same host for both planes: the HTTP upgrade is proxied too, so the socket dials the
            // page origin like every REST call. Without `ws` the REST reads work and the realtime
            // plane silently 404s at Vite (./vite-proxy.ts:90-93).
            expect(devProxy.ws).toBe(true);

            // The service gate requires Origin host === request Host; the proxy stamps the target
            // origin so a LAN page keeps working without widening that gate.
            expect(devProxy.headers).toEqual({ origin: 'http://127.0.0.1:5000' });

            // Identity rewrite: canonical path in, the same path out - including the stream path
            // and a query string (a page size or cursor must survive the proxy).
            expect(devProxy.rewrite('/v1/harness')).toBe('/v1/harness');
            expect(devProxy.rewrite('/v1/harness/stream')).toBe('/v1/harness/stream');
            expect(devProxy.rewrite('/v1/harness/sessions/s-1/events?limit=25')).toBe(
                '/v1/harness/sessions/s-1/events?limit=25'
            );
        } finally {
            if (previous === undefined) delete process.env.HARNESS_DEV_API;
            else process.env.HARNESS_DEV_API = previous;
        }
    });

    it('can point the same proxy at the separate standalone launcher', async () => {
        // R2 + T14: `yarn dev:server` publishes the SAME canonical root on :5181
        // (`STANDALONE_MOUNT === HARNESS_API_ROOT`, ./server/api.ts:270-274), so pointing
        // HARNESS_DEV_API at the standalone launcher is an identity rewrite exactly like the
        // service mount. The helper still swaps the prefix for a host that publishes the API
        // somewhere else - the only case where the browser's canonical path and the upstream path
        // differ - which is what keeps `?apiRoot=`-style deployments working.
        const { createApiProxy, DEFAULT_DEV_API } = await import('./frontend/vite.config');
        const standalone = createApiProxy('http://127.0.0.1:5181/v1/harness');

        expect(DEFAULT_DEV_API).toBe('http://127.0.0.1:5000/v1/harness');
        expect(standalone.target).toBe('http://127.0.0.1:5181');
        expect(standalone.changeOrigin).toBe(true);
        expect(standalone.ws).toBe(true);
        expect(standalone.headers).toEqual({ origin: 'http://127.0.0.1:5181' });
        expect(standalone.rewrite('/v1/harness')).toBe('/v1/harness');
        expect(standalone.rewrite('/v1/harness/sessions/s-1/events')).toBe('/v1/harness/sessions/s-1/events');

        // A trailing slash on the mount is normalized (no `//` in the URL).
        const trailing = createApiProxy('http://127.0.0.1:5000/v1/harness/');
        expect(trailing.rewrite('/v1/harness/health')).toBe('/v1/harness/health');

        // A non-canonical upstream swaps only the mount, and the stream upgrade follows it.
        const custom = createApiProxy('http://127.0.0.1:5181/api');
        expect(custom.rewrite('/v1/harness/stream')).toBe('/api/stream');
        expect(custom.rewrite('/v1/harness')).toBe('/api');
    });

    it('keeps both dev launchers out of every imported surface', () => {
        // R1/R2: the old frontend launcher (which called startHarnessServer) is
        // gone, and the standalone launcher is an executable entry, not a barrel
        // member. Importing the package therefore cannot reach either listener.
        expect(fs.existsSync(path.join(PACKAGE_ROOT, 'src/frontend/dev.ts'))).toBe(false);

        for (const barrel of [
            'src/index.ts',
            'src/browser.ts',
            'src/server/index.ts',
            'src/frontend/index.ts'
        ]) {
            expect(readText(barrel)).not.toContain("'./dev'");
        }

        // Vite config is UI-only: no server import, no launcher call.
        const viteConfig = readText('src/frontend/vite.config.ts');
        expect(viteConfig).not.toContain('startHarnessServer');
        expect(viteConfig).not.toContain("'../server");

        // The standalone launcher starts the Node server only; it must not import
        // Vite or touch the frontend tree.
        const serverDev = readText('src/server/dev.ts');
        expect(serverDev).not.toContain("from 'vite'");
        expect(serverDev).not.toContain("from '../frontend");
        expect(serverDev).toContain("from './index'");
    });

    it('builds and verifies the published artifacts', () => {
        // The declaration build is a script (two emits + specifier fix), publish runs
        // the built-package type check AND the built-package runtime smoke: a release
        // cannot ship declarations a NodeNext consumer cannot read, or a bundle whose
        // own server entry cannot start.
        //
        // T21: the descriptor manifest is GENERATED from the tool entries, so `build`
        // refreshes it first and `typecheck`/`test` refuse to run against a stale one
        // (`--check`). A new `.tool.ts` therefore reaches the catalogue, the server
        // inventory and the lazy loaders without any hand-maintained table edit.
        expect(manifest.scripts['tools:manifest']).toBe(
            'vite-node scripts/generate-tool-manifest.mjs'
        );
        expect(manifest.scripts['tools:manifest:check']).toBe(
            'vite-node scripts/generate-tool-manifest.mjs --check'
        );
        // R2/R3/R4: the PLUGIN manifest is generated the same way — plain `node`, because
        // the scanner only walks files and reads literals (no TypeScript loader needed),
        // unlike the tool scanner which imports the AST reader through vite-node.
        expect(manifest.scripts['plugins:manifest']).toBe(
            'node scripts/generate-plugin-manifest.mjs'
        );
        expect(manifest.scripts['plugins:manifest:check']).toBe(
            'node scripts/generate-plugin-manifest.mjs --check'
        );
        expect(manifest.scripts['build']).toBe(
            'npm run tools:manifest && npm run plugins:manifest && vite build && npm run build:types'
        );
        expect(manifest.scripts['typecheck']).toBe(
            'npm run tools:manifest:check && npm run plugins:manifest:check && tsc --noEmit'
        );
        expect(manifest.scripts['test']).toBe(
            'npm run tools:manifest:check && npm run plugins:manifest:check && vitest run'
        );
        expect(manifest.scripts['build:types']).toBe('node scripts/build-declarations.mjs');
        expect(manifest.scripts['test:package']).toBe('node scripts/check-package-types.mjs');
        expect(manifest.scripts['test:package:runtime']).toBe('node scripts/check-package-runtime.mjs');
        expect(manifest.scripts['test:package:files']).toBe(
            'node --test scripts/package-files.test.mjs'
        );
        expect(manifest.scripts['test:package:tools']).toBe(
            'node scripts/check-package-tools.mjs'
        );
        expect(manifest.scripts.prepublishOnly).toBe(
            'npm run typecheck && npm run test && npm run build && npm run test:package:files && npm run test:package && npm run test:package:runtime && npm run test:package:tools'
        );

        for (const script of [
            'scripts/build-declarations.mjs',
            'scripts/fix-declaration-specifiers.mjs',
            'scripts/check-package-types.mjs',
            'scripts/check-package-runtime.mjs',
            'scripts/generate-tool-manifest.mjs',
            // R2/R3/R4: the plugin manifest pipeline — CLI, scanner, renderer. All three
            // must exist because the scanner and renderer are imported by
            // src/plugin/manifest.test.ts, not only by the CLI.
            'scripts/generate-plugin-manifest.mjs',
            'scripts/plugin-manifest-scan.mjs',
            'scripts/plugin-manifest-render.mjs',
            'tsconfig.entries.json'
        ]) {
            expect(fs.existsSync(path.join(PACKAGE_ROOT, script))).toBe(true);
        }

        // Regression guard for the build fix: the server bundle needs the BARE Node
        // builtins and `dotenv` external. Bundled dotenv emitted `require('fs')` for a
        // browser stub and the built `loadEnvironmentFile()` threw at runtime.
        const viteConfig = readText('vite.config.ts');
        expect(viteConfig).toContain("from 'node:module'");
        expect(viteConfig).toContain('builtinModules');
        expect(viteConfig).toContain('dotenv');
        expect(viteConfig).toContain('external,');
    });
});

describe('entry composition', () => {
    it('Node root = library + shared + server + client', () => {
        // The Node root includes the browser client because every module in
        // src/frontend/index.ts is import-safe without a DOM (no stylesheet, no
        // module-scope element creation).
        expect(starExports(readText('src/index.ts'))).toEqual([
            './harness',
            './shared',
            './server',
            './frontend'
        ]);
    });

    it('browser root = library + shared + client, never the server tree', () => {
        expect(starExports(readText('src/browser.ts'))).toEqual([
            './harness',
            './shared',
            './frontend'
        ]);
    });

    it('server barrel stars the transport-neutral modules', () => {
        // The barrel is the published `@underload/harness/server` surface. Other
        // workstreams may add server modules (e.g. persistence), so this pins the
        // required layering rather than an exact list: every transport-neutral module
        // is present, and the browser client is never pulled in.
        const exported = starExports(readText('src/server/index.ts'));

        expect(exported).toEqual(
            expect.arrayContaining([
                './start',
                './protocol',
                './config',
                './environment',
                './package-root',
                './handler',
                './runtime',
                './service',
                './sessions',
                './static'
            ])
        );
        expect(exported).not.toContain('./frontend');
        expect(exported).not.toContain('./browser');
    });

    it('client barrel exports the reusable modules but not the app shell', () => {
        expect(starExports(readText('src/frontend/index.ts'))).toEqual([
            './api',
            './contract',
            './extensions',
            './ui/activity',
            './ui/agents',
            './ui/create-harness',
            './ui/dialog',
            './ui/file-links',
            './ui/file-preview',
            './ui/markdown',
            './ui/model-order',
            './ui/panels',
            './ui/preview',
            './ui/time',
            './ui/tokens',
            './ui/tools',
            './ui/turns'
        ]);

        const client = readText('src/frontend/index.ts');
        // `main.ts` boots the DOM and imports the stylesheet: it must stay out.
        expect(client).not.toContain("'./main'");
        expect(client).not.toContain('.css');
    });

    it('the app shell owns the stylesheet so no barrel import applies CSS', () => {
        expect(readText('src/frontend/main.ts')).toContain("import './styles.css';");
        // The client graph never reaches a Node built-in (browser-safe).
        expect(readText('src/frontend/api.ts')).not.toContain("from 'node:");
        expect(readText('src/frontend/contract.ts')).not.toContain("from 'node:");
    });
});

describe('import safety', () => {
    it('importing the Node root binds no listener and exports the whole surface', async () => {
        // Spied before the dynamic import so any import-time listen() call would be
        // observed. `startHarnessServer` creates its server inside the function.
        const httpCreateServer = vi.spyOn(http, 'createServer');
        const netCreateServer = vi.spyOn(net, 'createServer');

        const root = await import('./index');

        expect(httpCreateServer).not.toHaveBeenCalled();
        expect(netCreateServer).not.toHaveBeenCalled();

        // Library.
        expect(typeof root.harness).toBe('function');
        expect(typeof root.agent).toBe('function');
        // Shared.
        expect(root.LOOPBACK_HOSTNAMES.has('localhost')).toBe(true);
        expect(typeof root.isLoopbackHostname).toBe('function');
        // Server (explicit API — owning it is optional, binding it is not implied).
        expect(typeof root.startHarnessServer).toBe('function');
        expect(root.SERVICE_MOUNT).toBe('/v1/harness');
        expect(root.SERVICE_ROOT_ROUTE).toBe('/v1/harness');
        expect(root.SERVICE_WILDCARD_ROUTE).toBe('/v1/harness/*');
        // One API root for both hosts: the standalone launcher and the service gateway publish
        // the SAME mount (./server/api.ts:270-274, `STANDALONE_MOUNT === SERVICE_MOUNT ===
        // HARNESS_API_ROOT`). The old `/api` standalone mount is gone from the contract, so no
        // client, proxy or adapter has to know which host answered.
        expect(root.STANDALONE_MOUNT).toBe('/v1/harness');
        expect(root.STANDALONE_MOUNT).toBe(root.SERVICE_MOUNT);
        expect(typeof root.createHarnessRuntime).toBe('function');
        expect(typeof root.createHarnessServiceHandler).toBe('function');
        expect(typeof root.SessionStore).toBe('function');
        // The roster/role-contract pass: the published catalogue is exactly the real
        // production configurations — SEVEN live cards, DEFAULT FIRST, and that is the
        // WHOLE surface. The scripted `demo` and the `flaky` failure example used to be
        // exported behind FIXTURE_PRESETS / ALL_PRESET_TEMPLATES; they are deleted, so the
        // published root no longer has a fixture tier to leak into a picker. Order is a
        // contract, not a preference (../server/harnesses/presets.ts): it is what
        // `GET /harnesses` returns, what a picker renders, and the order the frontend
        // palette assigns tones by.
        expect(root.presets.map((preset) => preset.name)).toEqual([
            'general',
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner',
            'debugger'
        ]);
        // TITLES MOVED, IDS DID NOT. `research`/`workspace`/`planner` keep their
        // persisted ids while the visible titles became Explore/Analyst/Manager,
        // because the id is stored in every record and `agentProfile()` has no alias
        // (../agents/index.ts:21-26). Pinning both columns is what keeps that
        // decoupling from silently becoming a rename.
        expect(root.presets.map((preset) => preset.title)).toEqual([
            'General',
            'Instruct',
            'Explore',
            'Analyst',
            'Reviewer',
            'Manager',
            'Debugger'
        ]);
        // The default card is also the ONLY live card with no team: `subagents: []`
        // means the runtime never registers `delegate` for it (src/harness.ts
        // `activation: 'subagents'`), so the exact empty-allowlist set is ['general'].
        expect(
            root.presets.filter((preset) => preset.subagents.length === 0).map((preset) => preset.name)
        ).toEqual(['general']);
        // The deleted fixtures are gone from the published surface, not hidden behind it:
        // a root that still exported `FIXTURE_PRESETS` or `ALL_PRESET_TEMPLATES` would be
        // offering a scripted card and a throwing tool to any host that imports the
        // package. A test that wants one builds it itself
        // (../server/harnesses/fixture-presets.test-support.ts).
        expect(root.FIXTURE_PRESETS).toBeUndefined();
        expect(root.ALL_PRESET_TEMPLATES).toBeUndefined();
        // Client (import-safe under Node; no DOM work at module scope). The browser's
        // fallback root is the canonical mount, not the retired `/api`.
        expect(root.API_ROOT).toBe('/v1/harness');
        expect(typeof root.createTurnBoard).toBe('function');
        expect(typeof root.loadBootstrap).toBe('function');

        httpCreateServer.mockRestore();
        netCreateServer.mockRestore();
    });
});

describe('service discovery contract', () => {
    it('keeps the discovered endpoint folder and route modules', async () => {
        // @underload/service scans for folders named `endpoint`/`endpoints` and
        // imports `service-route*.ts`, so both the folder name and the module
        // shape are part of this package's contract.
        const wildcard = await import('./server/endpoint/harness/service-route');
        const root = await import('./server/endpoint/harness/service-route-root');

        expect(wildcard.default.route).toBe('/v1/harness/*');
        expect(root.default.route).toBe('/v1/harness');
        expect(typeof wildcard.default.handler).toBe('function');
        expect(typeof root.default.handler).toBe('function');
    });
});

describe('declaration build', () => {
    it('emits the inner tree without the root entries, then the entries separately', () => {
        // Why the split: tsc references an inferred type through the shortest
        // re-export path. With `src/index.ts` in the inner program, `Tool` in
        // src/tools/files/*.ts emitted as `import("../..")` — the NODE ROOT — so
        // `dist/harness.d.ts` (and the browser entry) transitively reached
        // `dist/server/**` and its `node:http` types. Excluding the entries makes tsc
        // reference the declaring module (`../../types`) instead.
        const build = readConfig('tsconfig.build.json');
        expect(build.exclude).toContain('src/index.ts');
        expect(build.exclude).toContain('src/browser.ts');

        const entries = readConfig('tsconfig.entries.json');
        // `include: []` keeps the inherited root-level `.ts` configs out of the
        // program (they are outside rootDir); `files` is then exactly the entries plus
        // the ambient Vite types the client's `import.meta.env` needs.
        expect(entries.files).toEqual(['src/index.ts', 'src/browser.ts', 'src/frontend/vite-env.d.ts']);
        expect(entries.include).toEqual([]);
        expect(entries.compilerOptions).toMatchObject({
            emitDeclarationOnly: true,
            rootDir: 'src',
            outDir: '.entries'
        });
    });

    it('rewrites emitted specifiers to the emitted declaration paths', async () => {
        // Unit test of the post-process that makes the tree NodeNext-readable; it
        // runs against a synthetic emit (created in the repo's Temp/) so the
        // published build does not have to run here.
        const { fixDeclarationSpecifiers } = await import('../scripts/fix-declaration-specifiers.mjs');
        const scratch = path.join(fileURLToPath(new URL('../../../../Temp/', import.meta.url)), `harness-declarations-${process.pid}-${Date.now()}`);
        const write = (relative: string, text: string): string => {
            const file = path.join(scratch, relative);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, text, 'utf8');
            return file;
        };

        try {
            // Emitted shapes: file target, directory target, `import("…")` and an
            // already-fixed specifier (which must be verified, not doubled).
            write('dist/a.d.ts', "export * from './b';\n");
            write('dist/b.d.ts', "export * from './sub';\n");
            write('dist/sub/index.d.ts', 'export declare const value: number;\n');
            write('dist/dir/user.d.ts', 'export declare const tool: import("..").Tool;\n');
            write('dist/index.d.ts', 'export type Tool = unknown;\n');
            write('dist/fixed.d.ts', "export * from './b.js';\n");
            // A comment that mentions a path must not be rewritten.
            write('dist/comment.d.ts', "// see './b'\nexport declare const note: string;\n");

            const result = fixDeclarationSpecifiers({ directory: path.join(scratch, 'dist') });

            expect(result).toEqual({
                directory: path.join(scratch, 'dist'),
                scanned: 7,
                rewritten: [
                    path.join(scratch, 'dist', 'a.d.ts'),
                    path.join(scratch, 'dist', 'b.d.ts'),
                    path.join(scratch, 'dist', 'dir', 'user.d.ts')
                ],
                unresolved: []
            });

            // Exact emitted text after the fix.
            expect(fs.readFileSync(path.join(scratch, 'dist', 'a.d.ts'), 'utf8')).toBe("export * from './b.js';\n");
            expect(fs.readFileSync(path.join(scratch, 'dist', 'b.d.ts'), 'utf8')).toBe("export * from './sub/index.js';\n");
            expect(fs.readFileSync(path.join(scratch, 'dist', 'dir', 'user.d.ts'), 'utf8')).toBe(
                'export declare const tool: import("../index.js").Tool;\n'
            );
            // Already fixed, and the comment, are untouched.
            expect(fs.readFileSync(path.join(scratch, 'dist', 'fixed.d.ts'), 'utf8')).toBe("export * from './b.js';\n");
            expect(fs.readFileSync(path.join(scratch, 'dist', 'comment.d.ts'), 'utf8')).toBe(
                "// see './b'\nexport declare const note: string;\n"
            );

            // Idempotent: a second run has nothing left to rewrite.
            expect(fixDeclarationSpecifiers({ directory: path.join(scratch, 'dist') })).toEqual({
                directory: path.join(scratch, 'dist'),
                scanned: 7,
                rewritten: [],
                unresolved: []
            });
        } finally {
            fs.rmSync(scratch, { recursive: true, force: true });
        }
    });

    it('reports a specifier that resolves to nothing instead of dropping it', async () => {
        // A silent omission would publish a declaration that cannot be resolved, so
        // the build fails: the helper reports it and the CLI exits non-zero.
        const { fixDeclarationSpecifiers } = await import('../scripts/fix-declaration-specifiers.mjs');
        const scratch = path.join(fileURLToPath(new URL('../../../../Temp/', import.meta.url)), `harness-declarations-bad-${process.pid}-${Date.now()}`);

        try {
            fs.mkdirSync(path.join(scratch, 'dist'), { recursive: true });
            fs.writeFileSync(path.join(scratch, 'dist', 'bad.d.ts'), "export * from './missing';\n", 'utf8');

            const result = fixDeclarationSpecifiers({ directory: path.join(scratch, 'dist') });

            expect(result.unresolved).toEqual([
                { file: path.join(scratch, 'dist', 'bad.d.ts'), specifier: './missing' }
            ]);
            // The original text is preserved, so the failure is visible in a diff too.
            expect(fs.readFileSync(path.join(scratch, 'dist', 'bad.d.ts'), 'utf8')).toBe("export * from './missing';\n");
        } finally {
            fs.rmSync(scratch, { recursive: true, force: true });
        }
    });
});


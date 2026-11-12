// Structure + import-safety contract for the R1/R2 layout.
//
// What this file pins (all deterministic, all read from the source tree):
//   1. the application tree lives under src/ (frontend + server + shared) and the
//      old top-level folders are gone;
//   2. package.json resolves SOURCE FIRST for every consumer, dev or installed:
//      `main`/`module`/`types` are `./src/index.ts`, and EVERY target of EVERY
//      published subpath (the `types` conditions and the `default` runtime
//      conditions, including the pair nested under the root `browser` group) names
//      the raw `./src/*.ts` entry. There is no `development` condition and no dist
//      target: the package is published as source, so an installed host loads the
//      same file a workspace run edits. `dist/` is therefore not a resolution target
//      at all — items 8-9 below are the proofs;
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
//      entries and never to `dist/`, so the manifest targets (not a hand-written
//      alias table) are what make `vitest run` build-free;
//   9. ../tsconfig.json `paths` mirror those same `default` targets file for
//      file, so editors, `tsc --noEmit` and the suite all mean the same module.
//
// Cross-references:
//   - ../package.json             — "exports" / "files" / "main|module|types" asserted below
//   - ../tsconfig.json            — `paths`, asserted as a mirror of the `default` targets
//   - ../vitest.config.ts         — deliberately has NO `resolve.alias` block; every
//     published condition already names `src/*.ts`, so no condition trick is needed
//   - ../scripts/check-package-types.mjs — the built-package check that enforces the
//     same rule for a published consumer (F3: every subpath needs a `./src/*.ts`
//     runtime target)
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
// Type-only pin (issue 0002): the vocabulary of the published compile result is part
// of the ROOT type surface, so a host that types `compiled.record` or a
// `tools: { name: { tool, source } }` catalogue can name it without reaching for a
// subpath. A value assertion cannot catch a TYPE name; an import of a name the root
// does not export is a `tsc` error, which is how such an omission reaches CI.
import type {
    CompiledToolSourceModule,
    HarnessConfiguredTool,
    HarnessToolSourceAttachment,
    ToolCompileCandidate,
    ToolSourceCompileOptions,
    ToolSourceEvaluateMode,
    ToolSourceDependency,
    ToolSourceLiveDependency,
    ToolSourceRecord
} from './index';

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

// The only named condition family left is `types`. Everything else is a RUNTIME
// condition (`default`, including the one nested under the root `browser` group),
// and under the src-only contract both families name the SAME raw `src/*.ts`
// entry: the published package IS the source, there is no dist to choose between.
const isTypesCondition = (condition: string): boolean => condition.endsWith('types');

// Runtime targets grouped by subpath, in declaration order. The root declares the
// condition twice (top level + inside `browser`) because a browser host and a Node
// host load different roots; a missing entry would mean that subpath resolves to
// something other than the source file being edited. `./package.json` is a manifest
// re-export, not a code entry, so it is left out of the table entirely.
const runtimeTargetsBySubpath: Record<string, string[]> = {};
for (const { subpath, condition, target } of exportTargets) {
    if (subpath === './package.json' || isTypesCondition(condition)) continue;
    (runtimeTargetsBySubpath[subpath] ??= []).push(target);
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
        //     too — `browser` first (so a browser consumer is typed against
        //     src/browser.ts), then the Node/`types` path. A single unconditional root
        //     `types` would shadow the browser condition and hand a browser consumer
        //     the Node server surface;
        //   - every target of every published subpath is the raw `src/*.ts` entry.
        //     There is no `development` condition and no dist target: this package is
        //     published as source, so a workspace run and an installed consumer load
        //     the SAME file — the one that is edited, typechecked and tested here.
        expect(manifest.exports).toEqual({
            '.': {
                browser: {
                    types: './src/browser.ts',
                    default: './src/browser.ts'
                },
                types: './src/index.ts',
                default: './src/index.ts'
            },
            './server': {
                types: './src/server/index.ts',
                default: './src/server/index.ts'
            },
            // T5 (R1): the lane-worker EXECUTABLE. It is published as a subpath so an
            // installed host can spawn the worker by specifier; src-only means it
            // spawns the real src/server/workers/lane-worker.ts.
            './worker': {
                types: './src/server/workers/lane-worker.ts',
                default: './src/server/workers/lane-worker.ts'
            },
            // D4 (R1/R2/R4): the IO-worker EXECUTABLE, published as its own subpath for the
            // same reason `./worker` is - an installed host spawns it by specifier
            // (./workers/io-client.ts resolves exactly this pair:
            // `IO_WORKER_PACKAGE_SPECIFIER` + `IO_WORKER_DIST_FILE`). src-only means that
            // specifier answers src/server/workers/io-worker.ts directly, so the worker a
            // host spawns is the file under test; renaming either side breaks the resolver.
            './io-worker': {
                types: './src/server/workers/io-worker.ts',
                default: './src/server/workers/io-worker.ts'
            },
            // ./frontend needs no nested `browser` group: its single entry is already
            // browser-safe, so the top-level pair answers every environment.
            './frontend': {
                types: './src/frontend/index.ts',
                default: './src/frontend/index.ts'
            },
            './shared': {
                types: './src/shared/index.ts',
                default: './src/shared/index.ts'
            },
            './package.json': './package.json'
        });

        // The legacy `main`/`module`/`types` fields (the ones a bundler or `tsc` reads
        // when it has no `exports` support) name the same source file as the map, so an
        // old resolver cannot land anywhere else.
        expect(manifest.main).toBe('./src/index.ts');
        expect(manifest.module).toBe('./src/index.ts');
        expect(manifest.types).toBe('./src/index.ts');

        // Source-first coverage: every published CODE subpath carries a runtime target
        // (../scripts/check-package-types.mjs fails the release for the same omission).
        // `./package.json` is a manifest re-export and intentionally has none.
        expect(Object.keys(runtimeTargetsBySubpath)).toEqual([
            '.',
            './server',
            './worker',
            './io-worker',
            './frontend',
            './shared'
        ]);

        // Issue 0002 published the standalone tool-source compile on the ROOT and
        // deliberately added NO `./core` subpath: a second public door into the kernel
        // would put two surfaces in charge of one contract (registration, the source
        // record, and the compile all share `core/tool-source.ts`). The exhaustive
        // subpath list above is the general guard; this one names the entry the issue
        // could have shipped and did not.
        expect(manifest.exports['./core']).toBeUndefined();
    });

    it('publishes only targets inside "files", each with a matching extension', () => {
        // Publish coverage: an export target outside `files` is a 404 after install.
        // There is one target rule now, and it is the same for both condition families:
        // a `types` target and a runtime (`default`) target must both name a real
        // `src/*.ts` file — that file is what an installed consumer loads and what a
        // workspace run edits, so it has to be in the tarball and on disk.
        const files = manifest.files ?? [];
        // The published payload is the source tree alone. `dist` is absent on purpose:
        // no export names it, and the runtime compiler reads these source files rather
        // than compiled package artifacts.
        expect(files).toEqual([
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
        // 14 = root 4 (browser.types/default + types/default) + ./server 2 + ./worker 2
        // (T5 lane-worker executable) + ./io-worker 2 (D4 IO-worker executable) +
        // ./frontend 2 + ./shared 2.
        expect(published.length).toBe(14);

        // Family 1 — `types`: the same `.ts` entries the runtime loads, so a consumer's
        // editor reads the source of truth instead of a generated `.d.ts` that can be
        // stale. Declaration order is manifest order.
        const typeTargets = published.filter(({ condition }) => isTypesCondition(condition));
        expect(typeTargets.map(({ target }) => target)).toEqual([
            './src/browser.ts',
            './src/index.ts',
            './src/server/index.ts',
            './src/server/workers/lane-worker.ts',
            './src/server/workers/io-worker.ts',
            './src/frontend/index.ts',
            './src/shared/index.ts'
        ]);

        // Family 2 — every remaining condition is a RUNTIME target (`default`, plus the
        // one nested under the root `browser` group). Same seven entries; the pair for
        // each subpath is one file, never a bundle.
        const runtimeTargets = published.filter(({ condition }) => !isTypesCondition(condition));
        expect(runtimeTargets.map(({ target }) => target)).toEqual([
            './src/browser.ts',
            './src/index.ts',
            './src/server/index.ts',
            './src/server/workers/lane-worker.ts',
            './src/server/workers/io-worker.ts',
            './src/frontend/index.ts',
            './src/shared/index.ts'
        ]);

        // Every declared target must exist on disk — a typo here is a 404 for the
        // consumer, and under src-only there is no build step to paper over it.
        for (const { target } of published) {
            expect(fs.existsSync(path.join(PACKAGE_ROOT, target))).toBe(true);
        }

        // Exact per-family counts, 7 types + 7 runtime = 14. The prefix/extension rule
        // (every target is `./src/*.ts`) is already pinned by the two full-list
        // assertions above.
        expect([typeTargets.length, runtimeTargets.length]).toEqual([7, 7]);
    });

    it('resolves every published specifier to source, never to dist, for a dev/test host', async () => {
        // The build-free claim in ../vitest.config.ts is only true because of the
        // targets asserted above, so the proof goes through Vite's OWN resolver instead
        // of a re-implementation: with every condition naming `src/*.ts`, whichever
        // condition Vite selects (dev, SSR, or the client chain) the answer is a source
        // file. `ssr: true` matches the node test environment of ./vitest.config.ts;
        // the client chain answers `src/browser.ts` for the root — a different, also
        // source file, which is why the expected ids below are per-specifier.
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

    it('keeps tsconfig paths and the package runtime targets on the same files', () => {
        // Three mirrors of one specifier map: package.json `exports.*.default`
        // (Vite / Vitest / vite-node and every installed host), ../tsconfig.json
        // `paths` (editors and `tsc --noEmit`), and the real files on disk. They must
        // name the SAME file or a test silently typechecks one module while executing
        // another. `paths` is still needed because a workspace `tsc` resolves the bare
        // name through node_modules only via `exports`, and the alias keeps editor
        // jumps and the executed module identical.
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
        // "every subpath carries one" proof: a subpath without a runtime target
        // would be missing from this object.
        expect(runtimeTargetsBySubpath).toEqual({
            '.': ['./src/browser.ts', './src/index.ts'],
            './server': ['./src/server/index.ts'],
            './worker': ['./src/server/workers/lane-worker.ts'],
            './io-worker': ['./src/server/workers/io-worker.ts'],
            './frontend': ['./src/frontend/index.ts'],
            './shared': ['./src/shared/index.ts']
        });

        for (const { subpath, specifier, source } of PUBLISHED_SPECIFIERS) {
            // The top-level (non-`browser`) declaration of the condition is the entry a
            // host resolves by bare name; `paths` mirrors exactly that one.
            const topLevel = exportTargets
                .filter(({ subpath: row, condition }) => row === subpath && condition === `${subpath}.default`)
                .map(({ target }) => target);

            expect(topLevel).toEqual([source]);
            expect(paths[specifier]).toEqual(topLevel);
        }

        // The nested `browser` declaration is the other half of the mirror: the
        // browser-safe root, never the Node server surface. Only the root needs it —
        // ./frontend's single entry is already browser-safe.
        const browserRuntime = exportTargets
            .filter(({ condition }) => condition.endsWith('browser.default'))
            .map(({ subpath, target }) => `${subpath} -> ${target}`);
        expect(browserRuntime).toEqual(['. -> ./src/browser.ts']);
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
        // (issue 0004) The context estimator is on the published surface too: a host
        // trimming its own transcript must measure with the SAME `ceil(chars / 4)` the
        // UI context bar and the `context-compaction` plugin use, and `context-overflow`
        // is the one name its own floor and the provider's answer share. Both are values,
        // so a name missing from the root barrel fails here rather than in a consumer.
        expect(root.estimateContextTokens([{ role: 'user', content: 'x'.repeat(400) }])).toBe(100);
        expect(root.CONTEXT_OVERFLOW_CODE).toBe('context-overflow');
        // (issue 0002) The published READ-ONLY tool-source compile rides the same root,
        // and on Node it is the REAL implementation, not the browser stub: a compile
        // through the root answers with the checks it ran and a revision. The flag a
        // host branches on is next to it, and the harness's own helper
        // (`prepareToolSourceRecord`) stays internal — a published name would be a
        // second door to the same contract.
        const compiled = root.compileToolSourceModule({
            name: 'structureProbe',
            moduleText: `export const metadata = { name: 'structureProbe', description: 'Pins the root export.', tags: ['test'], parameters: { type: 'object', properties: {}, additionalProperties: false } };\n\nexport const execute = () => 'published';\n`
        });

        expect(compiled.name).toBe('structureProbe');
        expect(compiled.description).toBe('Pins the root export.');
        expect(compiled.tags).toEqual(['test']);
        expect(compiled.visibility).toBe('searchable');
        expect(compiled.checks).toEqual([
            'transpile:syntax',
            'load:module',
            'contract:tool',
            'schema:json'
        ]);
        expect(compiled.record.revision).toBe(compiled.revision);
        expect(compiled.record.format).toBe('module');
        expect(await compiled.definition?.execute({ parameters: {} } as never)).toBe('published');
        expect(root.supportsToolCompilation).toBe(true);
        expect((root as unknown as Record<string, unknown>).prepareToolSourceRecord).toBeUndefined();

        // Every TYPE the result needs is nameable from the root, and the value the root
        // returns is assignable to the published result type — runtime shape and type
        // surface cannot drift apart silently.
        const publishedResult: CompiledToolSourceModule = compiled;
        const candidate: ToolCompileCandidate = {
            name: 'structureProbe',
            moduleText: compiled.record.moduleText
        };
        const options: ToolSourceCompileOptions = {
            evaluate: 'syntax' satisfies ToolSourceEvaluateMode,
            cache: false
        };
        const dependency: ToolSourceDependency = { path: './helper.ts', text: 'export const value = 1;' };
        const liveDependency: ToolSourceLiveDependency = {
            path: 'tools/catalogue',
            revision: compiled.revision
        };
        const record: ToolSourceRecord = compiled.record;

        // (issue 0003) The shared-catalogue shape is published too: a host types its
        // catalogue once and passes the same object to every instance.
        const attachment: HarnessToolSourceAttachment = {
            moduleText: compiled.record.moduleText,
            dependencies: [dependency]
        };
        const catalogueEntry: HarnessConfiguredTool = {
            tool: publishedResult.definition as never,
            source: attachment
        };

        expect([
            publishedResult.revision,
            candidate.name,
            options.evaluate,
            options.cache,
            dependency.path,
            liveDependency.path,
            record.name,
            attachment.dependencies?.length,
            'tool' in catalogueEntry
        ]).toEqual([
            compiled.revision,
            'structureProbe',
            'syntax',
            false,
            './helper.ts',
            'tools/catalogue',
            'structureProbe',
            1,
            true
        ]);
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
            'debugger',
            // The tool-less card trails the roles (issue 0005-D): it is not a role, so it never
            // joins a team and never displaces a picker row a user already knows.
            'chat'
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
            'Debugger',
            'Chat'
        ]);
        // TWO cards have no team: the default (a load-bearing contract, src/harness.ts
        // `activation: 'subagents'` means `delegate` is never registered for it) and the tool-less
        // `chat` card (issue 0005-D — no team, so no delegation row either, on a harness that has
        // no catalogue tool to hand off). The exact empty-allowlist set is those two names.
        expect(
            root.presets.filter((preset) => preset.subagents.length === 0).map((preset) => preset.name)
        ).toEqual(['general', 'chat']);
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


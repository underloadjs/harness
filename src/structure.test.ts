// Structure + import-safety contract for the R1/R2 layout.
//
// What this file pins (all deterministic, all read from the source tree):
//   1. the application tree lives under src/ (server + shared) and the moved UI
//      tree is gone;
//   2. package.json resolves SOURCE FIRST for every consumer, dev or installed:
//      `main`/`module`/`types` are `./src/index.ts`, and EVERY target of EVERY
//      published subpath (the `types` conditions and the `default` runtime
//      conditions, including the pair nested under the root `browser` group) names
//      the raw `./src/*.ts` entry. There is no `development` condition and no dist
//      target: the package is published as source, so an installed host loads the
//      same file a workspace run edits. `dist/` is therefore not a resolution target
//      at all — items 8-9 below are the proofs;
//   3. the standalone server launch is separate from the UI app, which now lives in
//      `@loadscript/harness`;
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
//   - ../scripts/check-package-types.ts — the published-SOURCE check that enforces the
//     same rule for a real consumer install (every subpath needs a `./src/*.ts`
//     runtime target, nothing may point at `dist/`, and no built artifact may ship)
//   - ../src/structure.test.ts — the in-repo mirror of the same manifest rules (no dist);
//     the moved client's own structure lives with `@loadscript/harness`
//   - ../scripts/check-package-types.ts — the published-SOURCE check that enforces the
//     same rule for a real consumer install (every subpath needs a `./src/*.ts`
//     runtime target, nothing may point at `dist/`, and no built artifact may ship)
//
// Node environment ON PURPOSE: every assertion here reads the source tree through
// `fileURLToPath(import.meta.url)` (./openai.ts, package.json, the tsconfigs). Under the
// repository ROOT config (../../../vitest.config.ts, `environment: 'jsdom'`) that call
// threw `TypeError: The URL must be of scheme file` at COLLECTION time — the whole file
// was an unrunnable suite in a root `yarn vitest run`. The package's own vitest.config.ts
// already pins `node`; the docblock keeps that true for the root run too. Same reasoning
// as service/src/server/start.test.ts:1-9.
// @vitest-environment node

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
// `src/*.ts` and a stale `**/dist/*` exclude entry, and `/\*[\s\S]*?\*\/` reads the
// `/*` inside those globs as a block-comment opener, swallowing every `paths` entry
// up to the `*/` of the `"**/*.ts"` glob (i.e. exactly the block this file asserts on).
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
    { subpath: './shared', specifier: '@underload/harness/shared', source: './src/engine/shared/index.ts' },
    { subpath: './shared/harness-api', specifier: '@underload/harness/shared/harness-api', source: './src/engine/shared/harness-api.ts' },
    { subpath: './shared/harness-stream', specifier: '@underload/harness/shared/harness-stream', source: './src/engine/shared/harness-stream.ts' },
    { subpath: './shared/turn-display', specifier: '@underload/harness/shared/turn-display', source: './src/engine/shared/turn-display.ts' },
    { subpath: './shared/run-identity', specifier: '@underload/harness/shared/run-identity', source: './src/engine/shared/run-identity.ts' },
    { subpath: './server/turn-projector', specifier: '@underload/harness/server/turn-projector', source: './src/server/turn-projector.ts' },
    { subpath: './types', specifier: '@underload/harness/types', source: './src/engine/types/index.ts' }
] as const;

describe('package layout', () => {
    it('keeps the engine under src/engine and the server tree under src/server', () => {
        const topLevel = fs.readdirSync(PACKAGE_ROOT);
        const legacy = ['cli', 'endpoint', 'harnesses', 'playground', 'server'];

        expect(topLevel.filter((name) => legacy.includes(name))).toEqual([]);

        // Two layers, one folder each. The engine owns every library module and all
        // of its tests; the server owns the API wrapper and the endpoint modules.
        const folders = fs
            .readdirSync(SRC, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort();
        expect(folders).toEqual(['engine', 'server']);

        const engineFolders = fs
            .readdirSync(path.join(SRC, 'engine'), { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort();
        expect(engineFolders).toEqual([
            'agents',
            'core',
            'plugin',
            // R2/R3/R4: the auto-discovered built-in plugins. `engine/plugins` is
            // the scanned folder (one `*.plugin.ts` per plugin); `engine/plugin`
            // stays the host/loader. The manifest generator requires the folder.
            'plugins',
            'shared',
            'tools',
            'transport',
            'types',
            'util'
        ]);

        // Each layer has exactly one barrel/entry: the published targets.
        for (const entry of [
            'src/index.ts',
            'src/engine/browser.ts',
            'src/server/index.ts',
            'src/engine/shared/index.ts',
            'src/engine/harness.ts'
        ]) {
            expect(fs.existsSync(path.join(PACKAGE_ROOT, entry))).toBe(true);
        }
    });

    it('publishes every entry with environment-matched types', () => {
        // Exact map. Two rules hold at once:
        //   - every condition declares `types` explicitly (no implicit `.d.ts`
        //     sibling resolution), and the ROOT resolves its TYPES by environment
        //     too — `browser` first (so a browser consumer is typed against
        //     src/engine/browser.ts), then the Node/`types` path. A single unconditional root
        //     `types` would shadow the browser condition and hand a browser consumer
        //     the Node server surface;
        //   - every target of every published subpath is the raw `src/*.ts` entry.
        //     There is no `development` condition and no dist target: this package is
        //     published as source, so a workspace run and an installed consumer load
        //     the SAME file — the one that is edited, typechecked and tested here.
        expect(manifest.exports).toEqual({
            '.': {
                browser: {
                    types: './src/engine/browser.ts',
                    default: './src/engine/browser.ts'
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
            // (./workers/io-client.ts resolves exactly this specifier:
            // `IO_WORKER_PACKAGE_SPECIFIER`). src-only means that
            // specifier answers src/server/workers/io-worker.ts directly, so the worker a
            // host spawns is the file under test; renaming either side breaks the resolver.
            './io-worker': {
                types: './src/server/workers/io-worker.ts',
                default: './src/server/workers/io-worker.ts'
            },
            // The reusable browser client moved to `@loadscript/harness`; this
            // package no longer publishes a `./frontend` entry.
            './shared': {
                types: './src/engine/shared/index.ts',
                default: './src/engine/shared/index.ts'
            },
            './shared/harness-api': {
                types: './src/engine/shared/harness-api.ts',
                default: './src/engine/shared/harness-api.ts'
            },
            './shared/harness-stream': {
                types: './src/engine/shared/harness-stream.ts',
                default: './src/engine/shared/harness-stream.ts'
            },
            './shared/turn-display': {
                types: './src/engine/shared/turn-display.ts',
                default: './src/engine/shared/turn-display.ts'
            },
            './shared/run-identity': {
                types: './src/engine/shared/run-identity.ts',
                default: './src/engine/shared/run-identity.ts'
            },
            './server/turn-projector': {
                types: './src/server/turn-projector.ts',
                default: './src/server/turn-projector.ts'
            },
            './types': {
                types: './src/engine/types/index.ts',
                default: './src/engine/types/index.ts'
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
        // (../scripts/check-package-types.ts fails the release for the same omission).
        // `./package.json` is a manifest re-export and intentionally has none.
        expect(Object.keys(runtimeTargetsBySubpath)).toEqual([
            '.',
            './server',
            './worker',
            './io-worker',
            './shared',
            './shared/harness-api',
            './shared/harness-stream',
            './shared/turn-display',
            './shared/run-identity',
            './server/turn-projector',
            './types'
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
            '!src/**/node_modules/**',
            '!src/**/.vite/**'
        ]);

        // Rows come from the module-level walk shared with the resolution tests.
        const published = exportTargets.filter(({ subpath }) => subpath !== './package.json');
        // 24 = root 4 (browser.types/default + types/default) + ./server 2 + ./worker 2
        // (T5 lane-worker executable) + ./io-worker 2 (D4 IO-worker executable) +
        // ./shared 2 + the four shared contract files 8 + ./server/turn-projector 2 +
        // ./types 2.
        expect(published.length).toBe(24);

        // Family 1 — `types`: the same `.ts` entries the runtime loads, so a consumer's
        // editor reads the source of truth instead of a generated `.d.ts` that can be
        // stale. Declaration order is manifest order.
        const typeTargets = published.filter(({ condition }) => isTypesCondition(condition));
        expect(typeTargets.map(({ target }) => target)).toEqual([
            './src/engine/browser.ts',
            './src/index.ts',
            './src/server/index.ts',
            './src/server/workers/lane-worker.ts',
            './src/server/workers/io-worker.ts',
            './src/engine/shared/index.ts',
            './src/engine/shared/harness-api.ts',
            './src/engine/shared/harness-stream.ts',
            './src/engine/shared/turn-display.ts',
            './src/engine/shared/run-identity.ts',
            './src/server/turn-projector.ts',
            './src/engine/types/index.ts'
        ]);

        // Family 2 — every remaining condition is a RUNTIME target (`default`, plus the
        // one nested under the root `browser` group). Same twelve entries; the pair for
        // each subpath is one file, never a bundle.
        const runtimeTargets = published.filter(({ condition }) => !isTypesCondition(condition));
        expect(runtimeTargets.map(({ target }) => target)).toEqual([
            './src/engine/browser.ts',
            './src/index.ts',
            './src/server/index.ts',
            './src/server/workers/lane-worker.ts',
            './src/server/workers/io-worker.ts',
            './src/engine/shared/index.ts',
            './src/engine/shared/harness-api.ts',
            './src/engine/shared/harness-stream.ts',
            './src/engine/shared/turn-display.ts',
            './src/engine/shared/run-identity.ts',
            './src/server/turn-projector.ts',
            './src/engine/types/index.ts'
        ]);

        // Every declared target must exist on disk — a typo here is a 404 for the
        // consumer, and under src-only there is no build step to paper over it.
        for (const { target } of published) {
            expect(fs.existsSync(path.join(PACKAGE_ROOT, target))).toBe(true);
        }

        // Exact per-family counts, 12 types + 12 runtime = 24. The prefix/extension rule
        // (every target is `./src/*.ts`) is already pinned by the two full-list
        // assertions above.
        expect([typeTargets.length, runtimeTargets.length]).toEqual([12, 12]);
    });

    it('resolves every published specifier to source, never to dist, for a dev/test host', async () => {
        // The build-free claim in ../vitest.config.ts is only true because of the
        // targets asserted above, so the proof goes through Vite's OWN resolver instead
        // of a re-implementation: with every condition naming `src/*.ts`, whichever
        // condition Vite selects (dev, SSR, or the client chain) the answer is a source
        // file. `ssr: true` matches the node test environment of ./vitest.config.ts;
        // the client chain answers `src/engine/browser.ts` for the root — a different, also
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

        // Exact key set: the published specifiers, no stale alias left behind.
        expect(Object.keys(paths).sort()).toEqual([
            '@underload/harness',
            '@underload/harness/io-worker',
            '@underload/harness/server',
            '@underload/harness/server/turn-projector',
            '@underload/harness/shared',
            '@underload/harness/shared/harness-api',
            '@underload/harness/shared/harness-stream',
            '@underload/harness/shared/run-identity',
            '@underload/harness/shared/turn-display',
            '@underload/harness/types',
            '@underload/harness/worker'
        ]);

        // Exact per-subpath declaration multiset, in manifest order. This is also the
        // "every subpath carries one" proof: a subpath without a runtime target
        // would be missing from this object.
        expect(runtimeTargetsBySubpath).toEqual({
            '.': ['./src/engine/browser.ts', './src/index.ts'],
            './server': ['./src/server/index.ts'],
            './worker': ['./src/server/workers/lane-worker.ts'],
            './io-worker': ['./src/server/workers/io-worker.ts'],
            './shared': ['./src/engine/shared/index.ts'],
            './shared/harness-api': ['./src/engine/shared/harness-api.ts'],
            './shared/harness-stream': ['./src/engine/shared/harness-stream.ts'],
            './shared/turn-display': ['./src/engine/shared/turn-display.ts'],
            './shared/run-identity': ['./src/engine/shared/run-identity.ts'],
            './server/turn-projector': ['./src/server/turn-projector.ts'],
            './types': ['./src/engine/types/index.ts']
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
        // browser-safe root, never the Node server surface. Only the root needs it.
        const browserRuntime = exportTargets
            .filter(({ condition }) => condition.endsWith('browser.default'))
            .map(({ subpath, target }) => `${subpath} -> ${target}`);
        expect(browserRuntime).toEqual(['. -> ./src/engine/browser.ts']);
    });

    it('keeps the standalone server launch separate from the UI app', () => {
        // The UI build and dev server live in `@loadscript/harness` now; this
        // package only ships the optional standalone Node API launcher.
        expect(typeof manifest.scripts['dev:server']).toBe('string');
        expect(typeof manifest.scripts['cli']).toBe('string');
        expect(manifest.scripts['dev:server']).toBe('vite-node src/server/dev.ts');
        expect(manifest.scripts['dev:server']).not.toMatch(/--config|src\/frontend/);

        for (const forbidden of ['start', 'serve', 'server']) {
            expect(manifest.scripts[forbidden]).toBeUndefined();
        }
        // The UI launch scripts moved with the UI.
        for (const moved of ['build:frontend', 'dev:frontend', 'preview:frontend', 'test:frontend']) {
            expect(manifest.scripts[moved]).toBeUndefined();
        }

        // No script runs the deleted combined launcher or the CLI's explicit
        // `--serve` opt-in: those are typed by a user, never a package script.
        for (const command of Object.values(manifest.scripts)) {
            expect(command).not.toContain('src/frontend/dev.ts');
            expect(command).not.toContain('--serve');
            expect(command).not.toContain('startHarnessServer');
        }
    });

    it('keeps CI off the moved UI scripts', () => {
        // The workflow is a second consumer of package.json. The UI build/test
        // steps moved to `@loadscript/harness`, so this workflow must not name
        // scripts this manifest no longer has.
        const workflow = readText('.github/workflows/ci.yml');

        for (const moved of ['test:frontend', 'build:frontend']) {
            expect(workflow).not.toContain(`run: npm run ${moved}`);
        }

        // Retired launch/build names must not survive in the workflow or its
        // comments.
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

    it('keeps both dev launchers out of every imported surface', () => {
        // R1/R2: the old frontend launcher (which called startHarnessServer) is
        // gone, and the standalone launcher is an executable entry, not a barrel
        // member. Importing the package therefore cannot reach either listener.
        expect(fs.existsSync(path.join(PACKAGE_ROOT, 'src/frontend'))).toBe(false);

        for (const barrel of [
            'src/index.ts',
            'src/engine/browser.ts',
            'src/server/index.ts'
        ]) {
            expect(readText(barrel)).not.toContain("'./dev'");
        }

        // The standalone launcher starts the Node server only; it must not import
        // Vite or touch a UI tree.
        const serverDev = readText('src/server/dev.ts');
        expect(serverDev).not.toContain("from 'vite'");
        expect(serverDev).not.toContain("from '../frontend");
        expect(serverDev).toContain("from './index'");
    });

    it('builds and verifies the published artifacts', () => {
        // Publish runs the package type check, the suite, the manifest refresh AND all
        // three published-shape checks: a release cannot ship a manifest that resolves
        // to a file a real consumer install does not have, or a source tree whose own
        // server entry cannot start.
        //
        // T21: the descriptor manifest is GENERATED from the tool entries, so `build`
        // refreshes it first and `typecheck`/`test` refuse to run against a stale one
        // (`--check`). A new `.tool.ts` therefore reaches the catalogue, the server
        // inventory and the lazy loaders without any hand-maintained table edit.
        expect(manifest.scripts['tools:manifest']).toBe(
            'vite-node scripts/generate-tool-manifest.ts'
        );
        expect(manifest.scripts['tools:manifest:check']).toBe(
            'vite-node scripts/generate-tool-manifest.ts --check'
        );
        // R2/R3/R4: the PLUGIN manifest is generated the same way. It used to run under plain
        // `node` (the scanner only walks files and reads literals), but root AGENTS.md makes
        // `vite-node` the only runner for repo code, so both manifest generators now share one
        // spelling and every script is TypeScript.
        expect(manifest.scripts['plugins:manifest']).toBe(
            'vite-node scripts/generate-plugin-manifest.ts'
        );
        expect(manifest.scripts['plugins:manifest:check']).toBe(
            'vite-node scripts/generate-plugin-manifest.ts --check'
        );
        // `build` refreshes the two GENERATED manifests and nothing else. The package is
        // published as TypeScript source, so there is no library bundle and no declaration
        // emit to run before publish. The deployable UI build moved to `@loadscript/harness`.
        expect(manifest.scripts['build']).toBe('npm run tools:manifest && npm run plugins:manifest');
        expect(manifest.scripts['build']).not.toContain('vite build');
        expect(manifest.scripts['build:frontend']).toBeUndefined();
        expect(manifest.scripts['typecheck']).toBe(
            'npm run tools:manifest:check && npm run plugins:manifest:check && tsc --noEmit'
        );
        expect(manifest.scripts['test']).toBe(
            'npm run tools:manifest:check && npm run plugins:manifest:check && vitest run'
        );
        // AGENTS.md runtime policy: every launcher of a repo script is `vite-node` (a script) or
        // `vitest` (a suite) — never raw `node`, never `node --test`.
        // Retired with the declaration pipeline: `tsc` here is `--noEmit` only, and an
        // installed consumer reads the published `src/*.ts` through the `types`
        // conditions, so no script may emit a `dist/` tree or `.d.ts` files.
        expect(manifest.scripts['build:types']).toBeUndefined();
        expect(manifest.scripts['test:package']).toBe('vite-node scripts/check-package-types.ts');
        expect(manifest.scripts['test:package:runtime']).toBe('vite-node scripts/check-package-runtime.ts');
        expect(manifest.scripts['test:package:files']).toBe(
            'vitest run scripts/package-files.test.ts'
        );
        expect(manifest.scripts['test:package:tools']).toBe(
            'vite-node scripts/check-package-tools.ts'
        );
        expect(manifest.scripts.prepublishOnly).toBe(
            'npm run typecheck && npm run test && npm run build && npm run test:package:files && npm run test:package && npm run test:package:runtime && npm run test:package:tools'
        );

        for (const script of [
            'scripts/check-package-types.ts',
            'scripts/check-package-runtime.ts',
            'scripts/generate-tool-manifest.ts',
            // R2/R3/R4: the plugin manifest pipeline — CLI, scanner, renderer. All three
            // must exist because the scanner and renderer are imported by
            // src/plugin/manifest.test.ts, not only by the CLI.
            'scripts/generate-plugin-manifest.ts',
            'scripts/plugin-manifest-scan.ts',
            'scripts/plugin-manifest-render.ts',
            // AGENTS.md makes every tooling script a `.ts` file under vite-node/vitest, so the
            // published-shape helper and BOTH ported suites must exist too: `package-files.ts`
            // is imported by the three `check-package-*` scripts and by `package-files.test.ts`,
            // and `generate-harness-contract.test.ts` is the vitest replacement for the retired
            // `test:contract` `node --test` run.
            'scripts/package-files.ts',
            'scripts/package-files.test.ts',
            'scripts/generate-harness-contract.ts',
            'scripts/generate-harness-contract.test.ts',
            'scripts/scratch.ts',
            'scripts/verify-read-fixes.ts'
        ]) {
            expect(fs.existsSync(path.join(PACKAGE_ROOT, script))).toBe(true);
        }
    });
});

describe('entry composition', () => {
    it('Node root = engine + server', () => {
        // The engine barrel carries the library and its shared helpers; the server
        // barrel is the API surface an endpoint route consumes.
        expect(starExports(readText('src/index.ts'))).toEqual([
            './engine',
            './server'
        ]);
    });

    it('browser root = library + shared, never the server tree', () => {
        expect(starExports(readText('src/engine/browser.ts'))).toEqual([
            './harness',
            './shared'
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
        // THE RANK SURFACE REPLACES THE TEAM FIELD (R6/R15). `HarnessPreset.subagents` is gone, so
        // "has no team" is now a statement about `ranks`: `delegate` registers exactly when the map
        // spans TWO OR MORE distinct letters (src/engine/harness.ts `activation: 'delegation'`, and
        // ./server/harnesses/toolbox.ts `coreToolNames` projects the same rule). TWO cards have no
        // delegation target: the default — a load-bearing contract, one member at one rank — and the
        // tool-less `chat` card (issue 0005-D: one member, so no target either, on a harness that has
        // no catalogue tool to hand off). The exact single-rank set is those two names.
        expect(
            root.presets
                .filter((preset) => new Set(Object.values(preset.ranks)).size < 2)
                .map((preset) => preset.name)
        ).toEqual(['general', 'chat']);
        // RESOLVED, NOT SPARSE. A published card states every member's rank (./server/harnesses/
        // registry.ts `sortedRanks`, filled by ./server/harnesses/toolbox.ts `resolveRosterRanks`),
        // its entry is a member of its own roster, and the shipped shape is the kernel's own default
        // for a single team: the entry at Rank A, every other member at Rank B. Pinned per card
        // because `delegate`'s per-caller target list is derived from exactly this map.
        for (const preset of root.presets) {
            expect([...preset.agents].sort()).toEqual(Object.keys(preset.ranks).sort());
            expect(preset.entry).toBe(preset.agents[0]);
            expect(preset.ranks[preset.entry]).toBe('A');
            expect(
                Object.fromEntries(
                    preset.agents.map((agent) => [agent, agent === preset.entry ? 'A' : 'B'])
                )
            ).toEqual(preset.ranks);
        }
        // The deleted fixtures are gone from the published surface, not hidden behind it:
        // a root that still exported `FIXTURE_PRESETS` or `ALL_PRESET_TEMPLATES` would be
        // offering a scripted card and a throwing tool to any host that imports the
        // package. A test that wants one builds it itself
        // (../server/harnesses/fixture-presets.test-support.ts).
        expect(root.FIXTURE_PRESETS).toBeUndefined();
        expect(root.ALL_PRESET_TEMPLATES).toBeUndefined();
        // The browser client is no longer part of this root; `@loadscript/harness`
        // owns it.

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

describe('retired build layer', () => {
    it('keeps the whole build pipeline gone, not merely unused', () => {
        // The package used to run THREE builds: `vite build` over six library entries
        // (the root vite.config.ts), a two-pass declaration emit (`tsconfig.build.json`
        // for the inner tree, `tsconfig.entries.json` for the root entries), and a
        // post-process that rewrote emitted specifiers for a NodeNext consumer
        // (`scripts/fix-declaration-specifiers.ts`). Publishing `src/*.ts` makes every
        // one of them dead weight — and dead weight beside a source-only manifest is
        // exactly how a stale `dist/` ends up answering a consumer instead of the
        // sources the manifest claims. Each entry is therefore pinned ABSENT.
        for (const retired of [
            'vite.config.ts',
            'tsconfig.build.json',
            'tsconfig.entries.json',
            'scripts/build-declarations.ts',
            'scripts/fix-declaration-specifiers.ts',
            'dist',
            '.entries'
        ]) {
            expect(fs.existsSync(path.join(PACKAGE_ROOT, retired))).toBe(false);
        }

        // Nothing consumes the retired root config either: the worker runner
        // starts Vite with `configFile: false`
        // (./server/workers/worker-runner.ts:78).
        expect(fs.existsSync(path.join(PACKAGE_ROOT, 'src/frontend'))).toBe(false);
    });

    it('keeps the one TypeScript config no-emit', () => {
        // One config, one mode: `typecheck` runs `tsc --noEmit`. `declaration`/`outDir`
        // are the emit settings the retired pipeline needed, and `allowImportingTsExtensions`
        // is only legal while nothing emits — so `noEmit: true` is the contract that keeps
        // the `.ts`-extension import in src/frontend/vite.config.ts compiling at all.
        expect(fs.readdirSync(PACKAGE_ROOT).filter((entry) => entry.startsWith('tsconfig'))).toEqual(['tsconfig.json']);

        const config = readConfig('tsconfig.json');
        expect(config.compilerOptions.noEmit).toBe(true);
        expect(config.compilerOptions.declaration).toBeUndefined();
        expect(config.compilerOptions.outDir).toBeUndefined();
    });

    it('publishes source only: no built artifact, no emitted declaration twin', async () => {
        // The same rule scripts/check-package-types.ts enforces on an installed copy,
        // read straight off the repository tree. ../scripts/package-files.ts is the shared
        // spelling, so the suite and the release check can never drift apart.
        const { PERMITTED_BUILD_ARTIFACT, isBuiltArtifact, publishedFiles } = await import(
            '../scripts/package-files.ts'
        );

        const packed: string[] = publishedFiles();
        expect(
            packed.filter((file: string) => isBuiltArtifact(file, new Set(packed))),
            'a built artifact is part of the published shape'
        ).toEqual([]);

        // The ONE non-TypeScript runtime file: the IO-worker bootstrap `node:worker_threads`
        // loads with raw Node, which cannot parse this repo's TypeScript. Everything it
        // runs is `.ts`, fetched through Vite's ModuleRunner
        // (./server/workers/io-client.ts:408-420 + ./server/workers/worker-boot.mjs).
        expect(PERMITTED_BUILD_ARTIFACT).toBe('src/server/workers/worker-boot.mjs');
        expect(packed).toContain(PERMITTED_BUILD_ARTIFACT);

        // Exact non-`.ts` inventory: the worker bootstrap, the server's OpenAPI
        // document, and the engine's programmatic contract as markdown (the engine is
        // a callable TypeScript object, so it has no OpenAPI document of its own). The
        // UI assets moved to `@loadscript/harness`.
        expect(packed.filter((file: string) => !file.endsWith('.ts'))).toEqual([
            'src/harness-engine.md',
            'src/harness-server.swagger.yaml',
            'src/server/workers/worker-boot.mjs'
        ]);

        // No hand-written ambient declarations remain in this package (the two
        // that existed belonged to the moved client).
        expect(packed.filter((file: string) => file.endsWith('.d.ts'))).toEqual([]);
    });
});

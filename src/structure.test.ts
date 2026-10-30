// Structure + import-safety contract for the R1/R2 layout.
//
// What this file pins (all deterministic, all read from the source tree):
//   1. the application tree lives under src/ (frontend + server + shared) and the
//      old top-level folders are gone;
//   2. package.json publishes every entry with an EXPLICIT `types` target per
//      condition (no implicit `.d.ts` sibling resolution) and keeps the library
//      root stable;
//   3. the frontend and server launches are separate — `dev:frontend` is Vite
//      only, `dev:server` is the explicit standalone API, and the @underload/service
//      gateway still owns the normal listener (imports bind nothing);
//   4. each root entry composes the layers it is allowed to reach (Node root:
//      library + shared + server + client; browser root: library + shared +
//      client, never the server tree);
//   5. the client barrel contains neither the app shell nor a stylesheet;
//   6. importing the Node root binds no listener and re-exports the whole surface;
//   7. the @underload/service endpoint modules keep the folder/name contract the
//      loader discovers (`endpoint/` + `service-route*.ts` default export).
//
// Cross-references:
//   - ../tsconfig.build.json — emits dist/<entry>.d.ts for these entries
//   - ../vite.config.ts      — the five library entries
//   - ../package.json        — "exports" asserted below
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
        // Exact map: every condition declares `types` explicitly (no implicit `.d.ts`
        // sibling resolution), and the ROOT resolves its TYPES by environment too —
        // `browser` first (so a browser consumer gets dist/browser.d.ts), then the
        // Node/`types` path. A single unconditional root `types` would shadow the
        // browser condition and hand a browser consumer the Node server surface.
        expect(manifest.exports).toEqual({
            '.': {
                browser: {
                    types: './dist/browser.d.ts',
                    default: './dist/underload-harness.browser.mjs'
                },
                types: './dist/index.d.ts',
                node: './dist/underload-harness.mjs',
                import: './dist/underload-harness.mjs',
                default: './dist/underload-harness.mjs'
            },
            './server': {
                types: './dist/server/index.d.ts',
                import: './dist/underload-harness.server.mjs',
                default: './dist/underload-harness.server.mjs'
            },
            './frontend': {
                browser: {
                    types: './dist/frontend/index.d.ts',
                    default: './dist/underload-harness.frontend.mjs'
                },
                types: './dist/frontend/index.d.ts',
                import: './dist/underload-harness.frontend.mjs',
                default: './dist/underload-harness.frontend.mjs'
            },
            './shared': {
                types: './dist/shared/index.d.ts',
                import: './dist/underload-harness.shared.mjs',
                default: './dist/underload-harness.shared.mjs'
            },
            './package.json': './package.json'
        });

        // The stable library/Node-root filenames the `main`/`module` fields promise.
        expect(manifest.main).toBe('./dist/underload-harness.mjs');
        expect(manifest.module).toBe('./dist/underload-harness.mjs');
        expect(manifest.types).toBe('./dist/index.d.ts');
    });

    it('publishes only targets inside "files", each with a matching extension', () => {
        // Publish coverage: an export target outside `files` is a 404 after install,
        // and a `types` target that is not `.d.ts` (or a runtime target that is not
        // `.mjs`) cannot resolve for a consumer.
        const files = manifest.files ?? [];
        expect(files).toEqual(['dist']);

        const targets: { subpath: string; condition: string; target: string }[] = [];
        const walk = (subpath: string, condition: string, value: unknown): void => {
            if (typeof value === 'string') {
                targets.push({ subpath, condition, target: value });
                return;
            }
            for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
                walk(subpath, `${condition}.${key}`, nested);
            }
        };
        for (const [subpath, value] of Object.entries(manifest.exports)) walk(subpath, subpath, value);

        const published = targets.filter(({ subpath }) => subpath !== './package.json');
        expect(published.length).toBe(17);
        for (const { condition, target } of published) {
            expect(target.startsWith('./dist/')).toBe(true);
            expect(target.endsWith(condition.endsWith('types') ? '.d.ts' : '.mjs')).toBe(true);
        }
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

    it('points the Vite dev and preview /api proxy at the already-running service', async () => {
        // R1: the browser's fallback root is `/api` (src/frontend/api.ts), and the
        // service gateway mounts the same API at `/v1/harness` on :5000. Both Vite
        // modes must rewrite the prefix, so no UI launch ever needs an embedded API.
        // A page-level `?apiRoot=` or build-time `VITE_HARNESS_API` still overrides
        // the fallback at runtime; this pins only the default.
        //
        // HARNESS_DEV_API is read at config-module load. Clear it for this import so
        // the assertion is independent of the shell that runs the suite.
        const previous = process.env.HARNESS_DEV_API;
        delete process.env.HARNESS_DEV_API;

        try {
            const config = (await import('./frontend/vite.config')).default as any;
            // The proxy key is anchored to the API mount so it cannot capture the
            // `api.ts` client module (`/api.ts`), which would blank the UI when the
            // upstream is down. Pin the exact key at both launch seams.
            const proxyKey = '^/api(?:/|$)';
            expect(Object.keys(config.server.proxy)).toEqual([proxyKey]);
            expect(Object.keys(config.preview.proxy)).toEqual([proxyKey]);

            const devProxy = config.server.proxy[proxyKey];
            const previewProxy = config.preview.proxy[proxyKey];

            // One object for both modes: dev and preview can never drift.
            expect(devProxy).toBe(previewProxy);
            expect(devProxy.target).toBe('http://127.0.0.1:5000');
            expect(devProxy.changeOrigin).toBe(true);
            expect(devProxy.rewrite('/api')).toBe('/v1/harness');
            expect(devProxy.rewrite('/api/sessions/s-1/events')).toBe('/v1/harness/sessions/s-1/events');
        } finally {
            if (previous === undefined) delete process.env.HARNESS_DEV_API;
            else process.env.HARNESS_DEV_API = previous;
        }
    });

    it('can point the same proxy at the separate standalone launcher', async () => {
        // R2: `yarn dev:server` mounts the API at `/api` on :5181. The proxy helper
        // replaces the client's `/api` prefix with the target's mount, so the same
        // UI works against the standalone server with HARNESS_DEV_API set.
        const { createApiProxy, DEFAULT_DEV_API } = await import('./frontend/vite.config');
        const standalone = createApiProxy('http://127.0.0.1:5181/api');

        expect(DEFAULT_DEV_API).toBe('http://127.0.0.1:5000/v1/harness');
        expect(standalone.target).toBe('http://127.0.0.1:5181');
        expect(standalone.changeOrigin).toBe(true);
        expect(standalone.rewrite('/api')).toBe('/api');
        expect(standalone.rewrite('/api/sessions/s-1/events')).toBe('/api/sessions/s-1/events');

        // A trailing slash on the mount is normalized (no `//` in the URL).
        const trailing = createApiProxy('http://127.0.0.1:5000/v1/harness/');
        expect(trailing.rewrite('/api/health')).toBe('/v1/harness/health');
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
        expect(manifest.scripts['build']).toBe('vite build && npm run build:types');
        expect(manifest.scripts['build:types']).toBe('node scripts/build-declarations.mjs');
        expect(manifest.scripts['test:package']).toBe('node scripts/check-package-types.mjs');
        expect(manifest.scripts['test:package:runtime']).toBe('node scripts/check-package-runtime.mjs');
        expect(manifest.scripts.prepublishOnly).toBe(
            'npm run typecheck && npm run test && npm run build && npm run test:package && npm run test:package:runtime'
        );

        for (const script of [
            'scripts/build-declarations.mjs',
            'scripts/fix-declaration-specifiers.mjs',
            'scripts/check-package-types.mjs',
            'scripts/check-package-runtime.mjs',
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
        expect(root.STANDALONE_MOUNT).toBe('/api');
        expect(typeof root.createHarnessRuntime).toBe('function');
        expect(typeof root.createHarnessServiceHandler).toBe('function');
        expect(typeof root.SessionStore).toBe('function');
        expect(root.presets.map((preset) => preset.name)).toEqual([
            'instruct',
            'research',
            'workspace',
            'reviewer',
            'planner',
            'demo',
            'flaky'
        ]);
        // Client (import-safe under Node; no DOM work at module scope).
        expect(root.API_ROOT).toBe('/api');
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
    // tsconfig files are JSONC; comments are stripped before parsing.
    const readConfig = (relativePath: string): Record<string, any> =>
        JSON.parse(
            readText(relativePath)
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/^\s*\/\/.*$/gm, '')
        ) as Record<string, any>;

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


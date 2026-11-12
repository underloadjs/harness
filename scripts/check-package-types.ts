// Published-package check for the SOURCE-ONLY contract: does the artifact a consumer
// actually installs resolve, type-check, and run — without a build step anywhere?
//
// WHAT CHANGED, AND WHY (root AGENTS.md §c)
// -----------------------------------------
// This package no longer emits a library build. There is no `dist/`, no `.mjs`/`.cjs`,
// and no declaration emit: `main`/`module`/`types` and EVERY `exports` condition name
// the raw `./src/*.ts` entry, and `files` publishes `src` alone. So the checks that
// used to guard the emitted tree are retargeted, not deleted:
//
//   F1  the manifest drifts away from the source-only contract. A `dist/`/`.mjs`/
//       `.d.ts` target sneaking back into `exports` is invisible in-repo (Vite,
//       vitest and vite-node resolve source either way) and 404s the moment the
//       release stops producing it. §1 pins every condition to `./src/*.ts` and
//       §1c pins the packed tree to editable TypeScript (plus the one permitted
//       `.mjs`, see ./package-files.ts).
//   F2  the packed shape must be the resolution shape. Every export target has to be
//       inside `files` (an unexported-but-packed file is invisible, a packed-but-
//       missing target is a 404) and every subpath must answer BOTH `types` and a
//       runtime condition with the SAME file — one file, no stale twin.
//   F3  the published SOURCE declares its own requirements. This is the check whose
//       premise used to be bundling: the library build inlined the browser-only
//       devDependencies (`marked`, `dompurify`, `highlight.js`) and externalised
//       `dependencies`, so "the install can run it" was a build-config property.
//       Under source-only, a consumer's bundler resolves those bare specifiers in
//       ITS OWN install, so every bare specifier in a published source file must be
//       a `dependencies`/`peerDependencies`/`optionalDependencies` entry, a builtin,
//       or this package's own name. `vite` is a peerDependency precisely because
//       src/server/workers/worker-runner.ts imports it (§1d is what keeps that
//       pairing from rotting).
//   F4  the browser root must stay free of the Node server surface. It used to be
//       proved against `dist/browser.d.ts` plus a browser-build alias
//       (`./tool-source` -> `tool-source-browser.ts`). There is no bundle and no
//       alias any more, so §2 walks the REAL source graph from `src/browser.ts` and
//       fails if the Node root or the server barrel becomes reachable. The old
//       "no `node:` specifier anywhere in the browser graph" half of that assertion
//       was a bundling artifact (it only held because the build swapped the source
//       compiler out) and is deliberately not re-expressed: in a source-only publish
//       the browser graph is the source graph.
//
// The consumers import the package BY NAME from a copied, published shape of the
// package (package.json + `files` contents) inside a scratch `node_modules`, so the
// resolution being tested is the manifest's, not a `paths` alias.
//
// WHAT THE SOURCE-ONLY CONTRACT COSTS (deliberate, same ruling as
// packages/underload/dashboard): a consumer compiling with `module`/`moduleResolution:
// NodeNext` reads `src/index.ts`, whose relative specifiers are extensionless
// (`./core`), and TS2834 fires once per such specifier. Emitting `.d.ts` with explicit
// `.js` specifiers is what used to pay that cost; the source-only ruling retires the
// emit, so the pinned consumer mode is `moduleResolution: Bundler` — what Vite,
// vitest, vite-node and every bundler consumer in this workspace actually use.
// A source consumer also needs `vite/client` in `types`: src/frontend/api.ts reads
// `import.meta.env`, which that ambient declaration provides.
//
// USAGE
//     yarn vite-node scripts/check-package-types.ts           # no build step needed
//     yarn vite-node scripts/check-package-types.ts --scratch <dir>  # scratch override
//     yarn vite-node scripts/check-package-types.ts --keep     # keep the fixtures
//
// Scratch defaults to <workspace>/Temp/underload-harness/package-types (root
// AGENTS.md); `--scratch` and `TEMP`/`TMP`/`TMPDIR` are resolved by ./scratch.ts.
//
// Run it any time: nothing has to be built first. `prepublishOnly` chains it, so a
// release cannot ship a manifest or a source tree a real consumer cannot read.
//
// Cross-references:
//   - ./package-files.ts   — resolved `files` shape, source root, built-artifact rules
//   - ./scratch.ts         — repository Temp scratch root
//   - ../package.json      — `exports`, `files`, `test:package`
//   - src/structure.test.ts — the in-repo mirror of the same manifest rules (no dist)
//   - src/browser.ts       — the browser root §2 walks

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import {
    EDITABLE_SOURCE_ROOT,
    PACKAGE_ROOT,
    PERMITTED_BUILD_ARTIFACT,
    copyPublishedPackage,
    isBuiltArtifact,
    isPublished,
    publishedFiles,
    readPackageManifest
} from './package-files.ts';
import { applyScratchEnvironment, resolveScratchRoot } from './scratch.ts';

const require = createRequire(import.meta.url);

// A failed check is one message plus exit 1, never a stack trace. `never` keeps the
// control flow honest at every `fail(...)` call site.
const fail = (message: string): never => {
    console.error(`package types: ${message}`);
    process.exit(1);
};

// A manifest export target after condition-flattening: which subpath, which condition
// inside that subpath, and the file it resolves to.
type ExportTarget = { subpath: string; condition: string; target: string };

// Every path the manifest publishes, flattened: `{ subpath, condition, target }`.
// `unknown` in, because `exports` conditions are arbitrary nested JSON; only leaves
// that are strings become targets.
const exportTargets = (exportsMap: Record<string, unknown>): ExportTarget[] => {
    const targets: ExportTarget[] = [];

    const walk = (subpath: string, condition: string, value: unknown): void => {
        if (typeof value === 'string') {
            targets.push({ subpath, condition, target: value });
            return;
        }
        if (value === undefined || value === null) return;
        for (const [key, nested] of Object.entries(value as Record<string, unknown>)) walk(subpath, `${condition}.${key}`, nested);
    };

    for (const [subpath, value] of Object.entries(exportsMap)) walk(subpath, subpath, value);
    return targets;
};

// `./package.json` is a manifest re-export, not a code entry: it is always published
// and is exempt from the source-target rule.
const isManifestSubpath = (subpath: string): boolean => subpath === './package.json';

const isTypesCondition = (condition: string): boolean => condition.endsWith('.types');

// Resolve the TypeScript CLI without assuming where it is installed. It is a
// dependency CLI (not a repo `.ts` file), so spawning it through `process.execPath`
// stays inside the runner policy (root AGENTS.md exemption 2).
const resolveTsc = (): string => {
    const candidates = [
        path.join(PACKAGE_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
        ...Array.from({ length: 4 }, (_, index) =>
            path.join(PACKAGE_ROOT, ...Array.from({ length: index + 1 }, () => '..'), 'node_modules', 'typescript', 'bin', 'tsc')
        )
    ];

    for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate;
    }

    try {
        return path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
    } catch {
        return fail('typescript is not installed; run the package install first.');
    }
};

const tsc = resolveTsc();
const manifest = readPackageManifest(PACKAGE_ROOT);

if (manifest.type !== 'module') fail('package.json must stay "type": "module" (the published source is ESM)');

// A source-only publish must not grow a build layer back. `<package>/dist` and the
// declaration-staging directory are git-ignored precisely so a stale artifact can
// never be mistaken for part of the package — and if one exists on disk here, the
// packaging story being told by `files` is a lie worth failing on.
for (const staleRoot of ['dist', '.entries', 'build']) {
    if (existsSync(path.join(PACKAGE_ROOT, staleRoot))) {
        fail(`${staleRoot}/ exists — this package publishes ${EDITABLE_SOURCE_ROOT}/*.ts only; drop the emit (root AGENTS.md §c)`);
    }
}

// The resolved packed shape: positive `files` roots minus negation patterns.
const published = publishedFiles({ root: PACKAGE_ROOT, manifest });

// 1. Manifest shape: every condition resolves SOURCE, exists, and is packed.
const targets = exportTargets(manifest.exports ?? {}).filter(({ subpath }) => !isManifestSubpath(subpath));
const missing = targets.filter(({ target }) => !existsSync(path.join(PACKAGE_ROOT, target)));
if (missing.length > 0) fail(`missing export target(s): ${missing.map(({ target }) => target).join(', ')}`);

const outside = targets.filter(({ target }) => !isPublished(target, { root: PACKAGE_ROOT, manifest }));
if (outside.length > 0) fail(`export target(s) outside "files": ${outside.map(({ target }) => target).join(', ')}`);

// 1a. The ONE target rule (it replaced the old `.d.ts`/`.mjs` pair, which was exactly
// the opposite of the current policy): `types` and every runtime condition must name
// the same raw entry under `src/`. A `.d.ts` here means a declaration this package no
// longer emits; a `.mjs`/`.cjs` or any `dist/` segment means a bundle it no longer
// builds; a `development` condition means two answers to one specifier, which src-only
// publishing retired on purpose (the workspace run and the installed consumer must
// evaluate the same file).
const BUILD_TARGET = /(?:^|\/)dist\/|\.(?:mjs|cjs|d\.ts|js)$/iu;

for (const { condition, target } of targets) {
    if (!target.startsWith(`./${EDITABLE_SOURCE_ROOT}/`) || !target.endsWith('.ts')) {
        fail(`${condition} must point at a raw ./${EDITABLE_SOURCE_ROOT}/*.ts entry: ${target}`);
    }
    if (BUILD_TARGET.test(target)) fail(`${condition} names a build artifact: ${target}`);
}

// 1b. Legacy fields: a resolver that ignores `exports` still lands on source.
for (const field of ['main', 'module', 'types'] as const) {
    const value = manifest[field];
    if (typeof value !== 'string' || !value.startsWith(`./${EDITABLE_SOURCE_ROOT}/`) || !value.endsWith('.ts')) {
        fail(`"${field}" must point at a ./${EDITABLE_SOURCE_ROOT}/*.ts entry, got ${JSON.stringify(value)}`);
    }
}

// 1c. Every condition GROUP answers `types` and a runtime condition with the SAME
// file — one module, never a declaration twin that can drift from the runtime it
// describes. A group is one nesting level of the map (`.`, `./server`, the nested
// `./browser` group inside the root entry, ...), which is exactly the unit a resolver
// picks: it never mixes a target from the browser group with the Node/`default` one.
// The root entry legitimately holds TWO groups (`.` -> src/index.ts and `./.browser`
// -> src/browser.ts), so grouping is by condition parent, not by subpath.
const conditionGroup = (condition: string): string => condition.slice(0, Math.max(condition.lastIndexOf('.'), 0));

const groups = new Map<string, ExportTarget[]>();
for (const target of targets) {
    const key = conditionGroup(target.condition);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [target]);
    else group.push(target);
}

// The root entry adds exactly one extra group (the nested `browser` pair); every other
// subpath has exactly one. A new nested group is therefore an explicit decision.
const subpaths = new Set(targets.map(({ subpath }) => subpath));
if (groups.size !== subpaths.size + 1) {
    fail(`expected one condition group per subpath plus the root "browser" group, got ${[...groups.keys()].join(', ')}`);
}

for (const [group, entries] of groups) {
    const types = entries.filter(({ condition }) => isTypesCondition(condition)).map(({ target }) => target);
    const runtime = entries.filter(({ condition }) => !isTypesCondition(condition)).map(({ target }) => target);

    if (types.length === 0) fail(`condition group "${group}" publishes no "types" target`);
    if (runtime.length === 0) fail(`condition group "${group}" publishes no runtime ("default") target`);
    if (new Set([...types, ...runtime]).size !== 1) {
        fail(`condition group "${group}" resolves to more than one file (${[...new Set([...types, ...runtime])].join(' vs ')}); src-only means one entry per group`);
    }
}

// 1d. The editable source model IS the published payload: the runtime compiler's
// inputs (tasks/task-harness-self-modifying-tools.md §2/§8) ship in the tarball, so a
// deployed agent can read and rewrite them through
// `fileURLToPath(new URL('../src/', import.meta.url))` — the sibling `dist/` that used
// to sit next to them is gone, so `src/` alone must carry the contract.
const sourceFiles = published.filter((file) => file.startsWith(`${EDITABLE_SOURCE_ROOT}/`));
if (sourceFiles.length === 0) fail(`"files" must publish the editable source tree under ${EDITABLE_SOURCE_ROOT}/`);

const sourceEntry = `${EDITABLE_SOURCE_ROOT}/index.ts`;
if (!isPublished(sourceEntry, { root: PACKAGE_ROOT, manifest })) fail(`${sourceEntry} is not published`);
if (!existsSync(path.join(PACKAGE_ROOT, sourceEntry))) fail(`${sourceEntry} is missing from the source tree`);

// Tests, snapshots, and the frontend app-build output must never ship as source.
const testSources = sourceFiles.filter(
    (file) => /\.(?:test|spec)\.(?:ts|tsx)$/.test(file) || file.includes('/__snapshots__/')
);
if (testSources.length > 0) fail(`test sources leaked into "files": ${testSources.slice(0, 5).join(', ')}`);

const generatedSources = sourceFiles.filter((file) => file.startsWith(`${EDITABLE_SOURCE_ROOT}/frontend/dist/`));
if (generatedSources.length > 0) fail(`generated browser output leaked into "files": ${generatedSources.slice(0, 5).join(', ')}`);

// The headline source-only rule, over the PACKED tree: the payload is TypeScript
// source, the hand-written ambient declarations, and the one permitted worker
// bootstrap. `src/frontend/dist` is already excluded above (it is the app build, not a
// library artifact), so anything else that looks emitted fails here — including a
// `foo.d.ts` twin of a `foo.ts`, which is what a resurrected `tsc --declaration` emit
// would leave behind.
const packedSet = new Set(published);
const builtArtifacts = sourceFiles.filter((file) => isBuiltArtifact(file, packedSet));
if (builtArtifacts.length > 0) {
    fail(`published source carries built artifact(s): ${builtArtifacts.join(', ')} — this package ships ${EDITABLE_SOURCE_ROOT}/*.ts, no emit`);
}
if (!sourceFiles.includes(PERMITTED_BUILD_ARTIFACT)) {
    fail(`${PERMITTED_BUILD_ARTIFACT} is not published — it is the entry ` +
        '`node:worker_threads` spawns, and raw Node cannot load a `.ts` (src/server/workers/worker-boot.mjs)');
}

// Every tool must have an inspectable, independently compilable source entry. The
// kernel owns the exact per-tool files; packaging only guarantees the tree is present
// and is not empty.
const toolSources = sourceFiles.filter((file) => file.startsWith(`${EDITABLE_SOURCE_ROOT}/tools/`) && file.endsWith('.ts'));
if (toolSources.length === 0) fail('no tool source files are published under src/tools/');

// 1e. Undeclared-dependency scan over the PUBLISHED source (F3). Scanning `dist` used
// to answer "what does the shipped bundle need"; it now answers "what does a consumer
// resolve in its own install", so the scanned tree is every shipped, non-test `.ts`
// file and the declared set includes peers (the runtime worker graph imports `vite`).
// devDependencies stay OUT of the set on purpose: `marked`, `dompurify` and
// `highlight.js` are imported by the published client, which is exactly why they are
// `dependencies` and not devDependencies.
// The bare specifiers a published source file may use without a manifest entry:
// Node builtins, this package's own name (a self-referencing import resolves through
// its own `exports`), and every declared dependency group.
const declaredDependencies = new Set<string>([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys((manifest.peerDependencies ?? {}) as Record<string, string>),
    ...Object.keys((manifest.optionalDependencies ?? {}) as Record<string, string>),
    ...(typeof manifest.name === 'string' ? [manifest.name] : [])
]);
const builtins = new Set([...builtinModules, ...builtinModules.map((id) => `node:${id}`)]);

// npm package name of a bare specifier: `@scope/pkg/sub` -> `@scope/pkg`.
const packageNameOf = (specifier: string): string =>
    specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : (specifier.split('/')[0] ?? '');

// A comment line is not a runtime requirement: these sources document their imports in
// prose (`// a \`import { WebSocketServer } from 'ws'\` here would resolve, but…`).
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/u;
// Published dev launchers (`src/frontend/vite.config.ts`, `vitest.config.ts`) ship
// inside `src/` because they live next to the app they configure, and they import
// `vite`/`vitest` from devDependencies. No consumer ever imports them, so they are not
// part of the runtime graph this scan answers questions about.
const DEV_CONFIG_FILE = /(?:^|\/)(?:vite|vitest)\.config\.tsx?$/u;
const IMPORT_SHAPED = /^[a-zA-Z@][\w@/.-]*$/u;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu;

// Two import shapes, and each one is discriminated differently, because these sources
// carry a lot of model-facing prose inside string literals and prose says things like
// `switching from "offset" to "afterId"`:
//
//   FROM_LINE   a `… from '<specifier>'` that ENDS the statement (only `;`, a closing
//               paren/bracket of a re-export, or a trailing comment may follow). A
//               prose match is always followed by more prose, so it fails this shape,
//               while a real multi-line `import {\n a\n} from 'x';` still answers it.
//   CALLED      `import('<specifier>')` / `require('<specifier>')`: the call syntax is
//               unambiguous, so it counts anywhere on the line (a dynamic import in the
//               middle of an expression would otherwise be missed).
const FROM_LINE = /\bfrom\s*['"]([^'"]+)['"]\s*[);,}]*\s*(?:\/\/.*)?$/gu;
const CALLED = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]/gu;

const runtimeImports = new Map<string, string>();

for (const file of sourceFiles) {
    if (!/\.tsx?$/u.test(file) || /\.(?:test|spec)\.tsx?$/u.test(file)) continue;
    if (DEV_CONFIG_FILE.test(file)) continue;

    const text = readFileSync(path.join(PACKAGE_ROOT, file), 'utf8');

    for (const line of text.split(/\r?\n/u)) {
        if (COMMENT_LINE.test(line)) continue;

        for (const pattern of [FROM_LINE, CALLED]) {
            for (const match of line.matchAll(pattern)) {
                const specifier = match[1];
                if (!IMPORT_SHAPED.test(specifier)) continue;
                if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) continue;

                const name = packageNameOf(specifier);
                if (!NPM_NAME.test(name)) continue;
                if (builtins.has(name) || declaredDependencies.has(name)) continue;

                if (!runtimeImports.has(name)) runtimeImports.set(name, file);
            }
        }
    }
}

if (runtimeImports.size > 0) {
    fail(
        `published ${EDITABLE_SOURCE_ROOT} imports undeclared runtime dependency/dependencies: ` +
            `${[...runtimeImports].map(([name, file]) => `${name} (in ${file})`).join(', ')} — ` +
            'move them from devDependencies to dependencies (or declare them as peers) in package.json'
    );
}

// 2. The BROWSER root must not reach the Node server surface (F4) — over the real
//    source graph, which is what a consumer's bundler walks now.
const resolveSourceSpecifier = (fromFile: string, specifier: string): string | undefined => {
    // Vite's resolver accepts extensionless specifiers and directory `index.ts`; so
    // does this walk, in the same candidate order (exact file, then `.ts`/`.tsx`,
    // then the directory barrel, then JS — the published tree has one `.mjs`).
    const base = path.resolve(path.dirname(fromFile), specifier);

    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), `${base}.mjs`, `${base}.js`]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }

    return undefined;
};

// Static-and-dynamic specifiers only (relative ones are followed; bare names are
// collected so the walk can report how it leaves the package).
const RELATIVE_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.[^'"]+)['"]/g;

const browserEntry = path.join(PACKAGE_ROOT, EDITABLE_SOURCE_ROOT, 'browser.ts');
if (!existsSync(browserEntry)) fail(`${EDITABLE_SOURCE_ROOT}/browser.ts is missing — the browser condition has no entry`);

const browserFiles = new Set<string>();
const browserPending = [browserEntry];

while (browserPending.length > 0) {
    const file = browserPending.pop();
    if (file === undefined || browserFiles.has(file)) continue;
    browserFiles.add(file);

    for (const match of readFileSync(file, 'utf8').matchAll(RELATIVE_SPECIFIER)) {
        const resolved = resolveSourceSpecifier(file, match[1]);
        if (resolved !== undefined) browserPending.push(resolved);
    }
}

// The Node root re-exports the server tree (listener, sessions, presets), so reaching
// it from the browser root means a browser bundle would pay for `node:http`.
const nodeRoot = path.join(PACKAGE_ROOT, EDITABLE_SOURCE_ROOT, 'index.ts');
const serverRoot = path.join(PACKAGE_ROOT, EDITABLE_SOURCE_ROOT, 'server', 'index.ts');

if (browserFiles.has(nodeRoot)) {
    fail('the browser source graph reaches src/index.ts (the Node root) — one barrel grew a server import');
}
if (browserFiles.has(serverRoot)) {
    fail('the browser source graph reaches src/server/index.ts — a browser consumer would get the listener surface');
}

// 3. Type-check real consumers against a copied, published shape of the package.
const scratchRoot = resolveScratchRoot({ kind: 'package-types' });
applyScratchEnvironment(scratchRoot);

const keep = process.argv.includes('--keep');
const work = mkdtempSync(path.join(scratchRoot, 'run-'));
const packageCopy = path.join(work, 'node_modules', '@underload', 'harness');

mkdirSync(packageCopy, { recursive: true });
writeFileSync(path.join(packageCopy, 'package.json'), JSON.stringify(manifest, null, 4), 'utf8');
copyPublishedPackage({ sourceRoot: PACKAGE_ROOT, targetRoot: packageCopy, manifest, entries: published });

// A consumer project: `files` plus a tsconfig and one entry module. `tsconfig` stays
// a plain JSON object because each consumer spells its own module/moduleResolution.
const consumer = (name: string, tsconfig: Record<string, unknown>, source: string): string => {
    const directory = path.join(work, name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, private: true, type: 'module' }, null, 4), 'utf8');
    writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify(tsconfig, null, 4), 'utf8');
    writeFileSync(path.join(directory, 'index.ts'), source, 'utf8');
    return directory;
};

// `types: ["node", "vite/client"]`: the server source reads `node:*` builtins, and
// src/frontend/api.ts reads `import.meta.env`, whose type comes from vite's ambient
// client declarations — a cost of type-checking SOURCE instead of a `.d.ts` surface.
// `DOM` is required because the root re-exports the browser client's DOM signatures
// (documented limitation).
const baseOptions = {
    target: 'ESNext',
    strict: true,
    noEmit: true,
    // `skipLibCheck: false` would also re-check every third-party `.d.ts` the source
    // graph pulls in (`typescript`, `ws`, `marked`, `vite/client`). Those are the
    // dependency's own problem and were already outside the published surface when the
    // proof ran against emitted declarations; the harness source itself is checked in
    // full either way, because it is `.ts` and it is in the program.
    skipLibCheck: true,
    lib: ['ESNext', 'DOM', 'DOM.Iterable'],
    types: ['node', 'vite/client']
};

const nodeConsumer = consumer(
    'consumer-node',
    {
        // `moduleResolution: Bundler` is the mode a source-only library is consumed
        // with (see the header for the NodeNext/TS2834 ruling).
        compilerOptions: { ...baseOptions, module: 'ESNext', moduleResolution: 'Bundler' },
        include: ['index.ts']
    },
    `import { agent, harness, tool, openAICompatible, MAX_EXTRA_BODY_BYTES, PROVIDER_REQUEST_BODY_CODE, STRUCTURED_OUTPUT_INVALID_CODE, STRUCTURED_SCHEMA_INVALID_CODE, estimateContextTokens, CONTEXT_OVERFLOW_CODE } from '@underload/harness';
import { startHarnessServer } from '@underload/harness/server';
import { LOOPBACK_HOSTNAMES, isLoopbackHostname } from '@underload/harness/shared';
import { API_ROOT, loadBootstrap } from '@underload/harness/frontend';

// The Node root exposes BOTH surfaces: server APIs and the reusable client.
export const serverKind: string = typeof startHarnessServer;
export const loopback: boolean = isLoopbackHostname('localhost') && LOOPBACK_HOSTNAMES.size > 0;
export const clientRoot: string = API_ROOT;
export const bootstrap = loadBootstrap();
export const factories = { agent, harness, tool };

// issue 0001: the request-body extension, the response format and the structured
// agent setting must reach a published consumer's types, in both the object and the
// function form, plus the transport's options argument and the caps.
export const extensionBrain = agent({
    model: 'm',
    provider: {
        baseURL: 'http://x/v1',
        extraBody: { stream_options: { include_usage: true } },
        responseFormat: { jsonSchema: { name: 'answer', schema: { type: 'object' }, strict: true } }
    },
    structured: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }
});
export const dialectTransport = openAICompatible(
    { baseURL: 'http://x/v1', extraBody: (request) => ({ seed: request.tools?.length ?? 0 }) },
    { buildBody: (body, request) => ({ ...body, tenant: request.model }) }
);
export const bodyCap: number = MAX_EXTRA_BODY_BYTES;
export const bodyCode: string = PROVIDER_REQUEST_BODY_CODE;
export const structuredCodes: string[] = [STRUCTURED_SCHEMA_INVALID_CODE, STRUCTURED_OUTPUT_INVALID_CODE];

// issue 0004: the estimator, the overflow code and BOTH spellings of the context
// floor are published API. A published consumer reads them from the published SOURCE
// — the number a host measures with, the name it classifies with, and the two
// settings the pre-request guard accepts.
export const fittedTokens: number = estimateContextTokens([{ role: 'user', content: 'hi' }]);
export const overflowCode: string = CONTEXT_OVERFLOW_CODE;
export const guardedBrain = agent({
    model: 'm',
    maxPromptTokens: 4000,
    provider: { baseURL: 'http://x/v1', contextWindow: 8192 }
});
`
);

const browserConsumer = consumer(
    'consumer-browser',
    {
        compilerOptions: { ...baseOptions, module: 'ESNext', moduleResolution: 'Bundler', customConditions: ['browser'] },
        include: ['index.ts']
    },
    `import { agent, createTurnBoard, loadBootstrap, estimateContextTokens, CONTEXT_OVERFLOW_CODE } from '@underload/harness';
// @ts-expect-error - the "browser" condition must resolve src/browser.ts, which
// deliberately has no Node server surface. If this import ever type-checks, the
// condition mapping regressed and a browser bundle could reach node:http types.
import { startHarnessServer } from '@underload/harness';

export const client = { agent, createTurnBoard, loadBootstrap };

// issue 0001: a browser host configures the request body exactly like a Node host,
// so the new provider fields and the structured-agent setting must resolve from the
// browser types too — they are wire configuration, not server configuration.
export const browserBrain = agent({
    model: 'm',
    provider: {
        baseURL: 'https://x/v1',
        extraBody: { stream_options: { include_usage: true } },
        responseFormat: 'json'
    },
    structured: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }
});

// issue 0004: a browser host owns its own transcript, so the context floor and the
// estimator must resolve from the browser types too — they are transcript
// configuration, not server configuration.
export const browserGuard = agent({
    model: 'm',
    maxPromptTokens: 4000,
    provider: { baseURL: 'https://x/v1', contextWindow: 8192 }
});
export const browserTokens: number = estimateContextTokens([{ role: 'user', content: 'hi' }]);
export const browserOverflow: string = CONTEXT_OVERFLOW_CODE;
`
);

const runTsc = (directory: string): { status: number; output: string } => {
    const result = spawnSync(process.execPath, [tsc, '-p', directory], { encoding: 'utf8' });
    return { status: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
};

const results = [
    { name: 'Bundler consumer (published source)', directory: nodeConsumer },
    { name: 'browser consumer (customConditions)', directory: browserConsumer }
].map((entry) => ({ ...entry, ...runTsc(entry.directory) }));

if (!keep) rmSync(work, { recursive: true, force: true });

let failed = false;
for (const result of results) {
    if (result.status === 0) {
        console.log(`package types: ${result.name} OK`);
        continue;
    }
    failed = true;
    console.error(`package types: ${result.name} FAILED\n${result.output}`);
}

if (failed) process.exit(1);

console.log(
    `package types: ${browserFiles.size} browser-graph file(s) stay off the server tree; ` +
        `${targets.length} export target(s) and ${published.length} file(s) published from ${(manifest.files ?? []).join(', ')} ` +
        `with 0 undeclared import(s), no dist/ and no built artifact beyond ${PERMITTED_BUILD_ARTIFACT}`
);

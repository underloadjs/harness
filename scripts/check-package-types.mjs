// Built-package type check: proves the PUBLISHED artifact resolves for real
// consumers, instead of trusting the source tree.
//
// It answers the two defects that a source-only test cannot see:
//   F1  declarations must be NodeNext-clean. `tsc` preserves extensionless source
//       specifiers, so the emitted tree is post-processed by
//       ./fix-declaration-specifiers.mjs. This script asserts the built tree is in
//       its fixed state (`--check`: nothing left to rewrite, nothing unresolved)
//       and then type-checks a real `moduleResolution: NodeNext` consumer.
//   F2  types must follow the runtime CONDITION. A browser consumer
//       (`customConditions: ["browser"]`) must resolve `dist/browser.d.ts` — client
//       API present, Node server API absent — while a Node consumer resolves
//       `dist/index.d.ts` and sees both.
//
// The consumers import the package BY NAME from a copied, published shape of the
// package (package.json + `files` contents) inside a scratch `node_modules`, so the
// resolution being tested is the manifest's, not a `paths` alias.
//
// USAGE
//     node scripts/check-package-types.mjs                 # checks <package>/dist
//     node scripts/check-package-types.mjs --scratch <dir> # scratch root override
//     node scripts/check-package-types.mjs --keep          # keep the fixtures
//
// Scratch defaults to <workspace>/Temp/underload-harness/package-types (root
// AGENTS.md); `--scratch` and `TEMP`/`TMP`/`TMPDIR` are resolved by ./scratch.mjs.
//
// The consumer fixture is the RESOLVED `files` shape, not the raw entries: `src`
// publishes the editable TypeScript tree beside `dist`, so copyPublishedPackage()
// applies the manifest's negation patterns (tests, snapshots, generated
// src/frontend/dist) and the checks below assert that source contract explicitly.
//
// Run it after `yarn build`. `prepublishOnly` chains it, so a release cannot ship
// declarations or sources that a NodeNext consumer cannot read.
//
// Cross-references:
//   - ./package-files.mjs              — resolved `files` shape + source layout roots
//   - ./scratch.mjs                    — repository Temp scratch root
//   - ./fix-declaration-specifiers.mjs — the post-process this verifies
//   - ../package.json                  — `exports`, `files`, `test:package`
//   - ../tsconfig.build.json           — the declaration emit

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    BUILD_ROOT,
    EDITABLE_SOURCE_ROOT,
    PACKAGE_ROOT,
    copyPublishedPackage,
    isPublished,
    publishedFiles,
    readPackageManifest
} from './package-files.mjs';
import { applyScratchEnvironment, resolveScratchRoot } from './scratch.mjs';

const require = createRequire(import.meta.url);

const fail = (message) => {
    console.error(`package types: ${message}`);
    process.exit(1);
};

// Every path the manifest publishes, flattened: `{ subpath, condition, target }`.
const exportTargets = (exportsMap) => {
    /** @type {{ subpath: string, condition: string, target: string }[]} */
    const targets = [];

    const walk = (subpath, condition, value) => {
        if (typeof value === 'string') {
            targets.push({ subpath, condition, target: value });
            return;
        }
        for (const [key, nested] of Object.entries(value)) walk(subpath, `${condition}.${key}`, nested);
    };

    for (const [subpath, value] of Object.entries(exportsMap)) walk(subpath, subpath, value);
    return targets;
};

// `./package.json` is a manifest re-export, not a code entry: it is always published
// and is exempt from the .mjs/.d.ts target rule.
const isManifestSubpath = (subpath) => subpath === './package.json';

// Resolve the TypeScript CLI without assuming where it is installed.
const resolveTsc = () => {
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
const distDir = path.join(PACKAGE_ROOT, BUILD_ROOT);

if (manifest.type !== 'module') fail('package.json must stay "type": "module" (ESM-only build)');
if (!existsSync(distDir)) fail('dist/ is missing — run `yarn build` first');

// The resolved packed shape: positive `files` roots minus negation patterns.
const published = publishedFiles({ root: PACKAGE_ROOT, manifest });

// 1. Every published target must exist and be inside the `files` allow-list.
const targets = exportTargets(manifest.exports ?? {}).filter(({ subpath }) => !isManifestSubpath(subpath));
const missing = targets.filter(({ target }) => !existsSync(path.join(PACKAGE_ROOT, target)));
if (missing.length > 0) fail(`missing export target(s): ${missing.map(({ target }) => target).join(', ')}`);

const outside = targets.filter(
    ({ target }) => !isPublished(target, { root: PACKAGE_ROOT, manifest })
);
if (outside.length > 0) fail(`export target(s) outside "files": ${outside.map(({ target }) => target).join(', ')}`);

// 1b. The editable source model must ship BESIDE the build.
//
// tasks/task-harness-self-modifying-tools.md §2/§8: `dist/` is generated and is
// not editable source. The packaged contract is `<package>/src/**/*.ts` next to
// `<package>/dist/**`, so a runtime module can resolve sources without a manifest
// lookup: `fileURLToPath(new URL('../src/', import.meta.url))`.
const sourceFiles = published.filter((file) => file.startsWith(`${EDITABLE_SOURCE_ROOT}/`));
if (sourceFiles.length === 0) {
    fail(`"files" must publish the editable source tree under ${EDITABLE_SOURCE_ROOT}/ beside ${BUILD_ROOT}/`);
}

const sourceEntry = `${EDITABLE_SOURCE_ROOT}/index.ts`;
if (!isPublished(sourceEntry, { root: PACKAGE_ROOT, manifest })) fail(`${sourceEntry} is not published`);
if (!existsSync(path.join(PACKAGE_ROOT, sourceEntry))) fail(`${sourceEntry} is missing from the source tree`);

// Tests, snapshots, and generated browser output must never be shipped as source.
const testSources = sourceFiles.filter(
    (file) => /\.(?:test|spec)\.(?:ts|tsx)$/.test(file) || file.includes('/__snapshots__/')
);
if (testSources.length > 0) {
    fail(`test sources leaked into "files": ${testSources.slice(0, 5).join(', ')}`);
}
const generatedSources = sourceFiles.filter((file) =>
    file.startsWith(`${EDITABLE_SOURCE_ROOT}/frontend/${BUILD_ROOT}/`)
);
if (generatedSources.length > 0) {
    fail(`generated browser output leaked into "files": ${generatedSources.slice(0, 5).join(', ')}`);
}

// Every tool must have an inspectable, independently compilable source entry.
// The kernel owns the exact per-tool files; packaging only guarantees the tree is
// present and is not empty.
const toolSources = sourceFiles.filter(
    (file) => file.startsWith(`${EDITABLE_SOURCE_ROOT}/tools/`) && file.endsWith('.ts')
);
if (toolSources.length === 0) fail('no tool source files are published under src/tools/');

// 1c. Every non-builtin bare import left in `dist` must be a declared
// `dependencies` entry. Vite externalises `dependencies` (../vite.config.ts), so
// this is where "the production install can actually run the build" is checked:
// the runtime compiler (`typescript`, added by the kernel) must not remain a
// devDependency that a published install omits.
const runtimeImports = new Set();
const packageNameOf = (specifier) =>
    specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
const walkDist = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            walkDist(file);
            continue;
        }
        if (!/\.(?:mjs|js)$/.test(file)) continue;

        const text = readFileSync(file, 'utf8');
        for (const match of text.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)) {
            const specifier = match[1];
            if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) continue;

            const name = packageNameOf(specifier);
            // The regex also matches arbitrary string literals in minified code;
            // only npm-shaped names can be missing dependencies.
            if (/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)) runtimeImports.add(name);
        }
    }
};
walkDist(distDir);

const builtins = new Set([...builtinModules, ...builtinModules.map((id) => `node:${id}`)]);
const missingDependencies = [...runtimeImports].filter(
    (name) => !builtins.has(name) && manifest.dependencies?.[name] === undefined
);
if (missingDependencies.length > 0) {
    fail(
        `dist imports undeclared runtime dependency/dependencies: ${missingDependencies.join(', ')} — ` +
            'move them from devDependencies to dependencies in package.json'
    );
}

for (const { subpath, condition, target } of targets) {
    if (isManifestSubpath(subpath)) continue;
    if (condition.endsWith('types') && !target.endsWith('.d.ts')) fail(`${condition} must point at a .d.ts: ${target}`);
    if (!condition.endsWith('types') && !target.endsWith('.mjs')) fail(`${condition} must point at a .mjs: ${target}`);
}

// 2. The built declarations must already be in their fixed state.
const { declarationSpecifiers, fixDeclarationSpecifiers } = await import(
    pathToFileURL(path.join(PACKAGE_ROOT, 'scripts', 'fix-declaration-specifiers.mjs'))
);
const declarationState = fixDeclarationSpecifiers({ directory: distDir, checkOnly: true });

if (declarationState.unresolved.length > 0) {
    fail(
        `unresolved declaration specifier(s): ${declarationState.unresolved
            .map(({ file, specifier }) => `${specifier} in ${path.relative(PACKAGE_ROOT, file)}`)
            .join(', ')}`
    );
}
if (declarationState.rewritten.length > 0) {
    fail(
        `declarations are not post-processed (${declarationState.rewritten.length} file(s)); ` +
            'run `yarn build:types` / `node scripts/fix-declaration-specifiers.mjs`'
    );
}

// 3. The BROWSER types closure must not reach the Node server surface.
//
//    The browser condition resolves `dist/browser.d.ts`; this walks its relative
//    declaration graph and fails if the Node root (`dist/index.d.ts`) or any
//    `dist/server/**` module is reachable. Without this, one inferred type emitted as
//    `import("../..")` silently pulls `node:http` into a browser type-check.
const declarationGraph = (entry) => {
    const seen = new Set();
    const bare = new Set();
    const pending = [path.resolve(entry)];

    while (pending.length > 0) {
        const file = pending.pop();
        if (seen.has(file) || !existsSync(file)) continue;
        seen.add(file);

        for (const specifier of declarationSpecifiers(readFileSync(file, 'utf8'))) {
            if (!specifier.startsWith('.')) {
                bare.add(specifier);
                continue;
            }
            // The build is post-processed, so relative specifiers end in `.js`;
            // the declaration is the `.d.ts` sibling.
            const resolved = path.resolve(path.dirname(file), specifier).replace(/\.js$/i, '.d.ts');
            if (existsSync(resolved)) pending.push(resolved);
        }
    }

    return { files: seen, bare };
};

const browserEntry = path.join(distDir, 'browser.d.ts');
if (!existsSync(browserEntry)) fail('dist/browser.d.ts is missing — the browser condition has no types');
const browserGraph = declarationGraph(browserEntry);
const nodeRoot = path.join(distDir, 'index.d.ts');

// The Node root itself must be unreachable (it re-exports the server tree).
if (browserGraph.files.has(nodeRoot)) {
    fail('the browser types reach dist/index.d.ts (the Node root) — an inferred type was emitted against it');
}

// And nothing reachable may pull a Node built-in: those are ambient @types/node
// modules a browser consumer does not have, and they are exactly what the server
// tree brings in (`node:http`, `node:fs`, …). Type-only imports of the wire
// contract (`../server/protocol`) are fine and expected — they carry no `node:`.
const nodeImporters = [...browserGraph.files].filter((file) =>
    declarationSpecifiers(readFileSync(file, 'utf8')).some((specifier) => specifier.startsWith('node:'))
);
if (nodeImporters.length > 0) {
    fail(
        `the browser types pull Node built-ins via ${nodeImporters
            .map((file) => path.relative(distDir, file))
            .join(', ')}`
    );
}

// 4. Type-check real consumers against a copied, published shape of the package.
const scratchRoot = resolveScratchRoot({ kind: 'package-types' });
applyScratchEnvironment(scratchRoot);

const keep = process.argv.includes('--keep');
const work = mkdtempSync(path.join(scratchRoot, 'run-'));
const packageCopy = path.join(work, 'node_modules', '@underload', 'harness');

mkdirSync(packageCopy, { recursive: true });
writeFileSync(path.join(packageCopy, 'package.json'), JSON.stringify(manifest, null, 4), 'utf8');
copyPublishedPackage({ sourceRoot: PACKAGE_ROOT, targetRoot: packageCopy, manifest, entries: published });

// A consumer project: `files` plus a tsconfig and one entry module.
const consumer = (name, tsconfig, source) => {
    const directory = path.join(work, name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'tsconfig.json'), JSON.stringify(tsconfig, null, 4), 'utf8');
    writeFileSync(path.join(directory, 'index.ts'), source, 'utf8');
    return directory;
};

// `types: ["node"]` is required by the server declarations (`node:http` is an ambient
// module). `DOM` is required because the root re-exports the browser client's DOM
// signatures (documented limitation).
const baseOptions = {
    target: 'ESNext',
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    lib: ['ESNext', 'DOM', 'DOM.Iterable']
};

const nodeConsumer = consumer(
    'consumer-nodenext',
    {
        compilerOptions: {
            ...baseOptions,
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            types: ['node']
        },
        include: ['index.ts']
    },
    `import { agent, harness, tool } from '@underload/harness';
import { startHarnessServer } from '@underload/harness/server';
import { LOOPBACK_HOSTNAMES, isLoopbackHostname } from '@underload/harness/shared';
import { API_ROOT, loadBootstrap } from '@underload/harness/frontend';

// The Node root exposes BOTH surfaces: server APIs and the reusable client.
export const serverKind: string = typeof startHarnessServer;
export const loopback: boolean = isLoopbackHostname('localhost') && LOOPBACK_HOSTNAMES.size > 0;
export const clientRoot: string = API_ROOT;
export const bootstrap = loadBootstrap();
export const factories = { agent, harness, tool };
`
);

const browserConsumer = consumer(
    'consumer-browser',
    {
        compilerOptions: { ...baseOptions, module: 'ESNext', moduleResolution: 'Bundler', customConditions: ['browser'] },
        include: ['index.ts']
    },
    `import { agent, createTurnBoard, loadBootstrap } from '@underload/harness';
// @ts-expect-error - the "browser" condition must resolve dist/browser.d.ts, which
// deliberately has no Node server surface. If this import ever type-checks, the
// condition mapping regressed and a browser bundle could reach node:http types.
import { startHarnessServer } from '@underload/harness';

export const client = { agent, createTurnBoard, loadBootstrap };
`
);

const runTsc = (directory) => {
    const result = spawnSync(process.execPath, [tsc, '-p', directory], { encoding: 'utf8' });
    return { status: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
};

const results = [
    { name: 'NodeNext consumer', directory: nodeConsumer },
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
    `package types: ${declarationState.scanned} declaration file(s) are NodeNext-clean; ` +
        `${targets.length} export target(s) and ${published.length} file(s) published from ${manifest.files.join(', ')}`
);

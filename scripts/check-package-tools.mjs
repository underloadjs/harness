// Production end-to-end check for self-modifying tools (acceptance 20).
//
// WHY THIS EXISTS
// ---------------
// Unit tests exercise the kernel through the development source tree. This check
// exercises the INSTALLED package shape instead:
//
//   published `files` -> copied package under repository Temp/
//   copied `dist/` entry -> the production runtime (no source import, no rebuild)
//   copied `src/` tree   -> the editable tool sources a deployed agent inspects
//
// The scenario edits real files in the copied `src/` tree, registers them through
// the ORDINARY model-facing `toolRegistry` tool via `harness.executeTool`, invokes
// the installed revision, replaces it repeatedly (including editing a local helper
// only), and finally drives one scripted model turn that registers and then calls a
// tool without any discovery round.
//
// WHAT IT ASSERTS (acceptance map)
// --------------------------------
//   §2/§8  published source ships beside dist; TypeScript is a runtime dependency.
//   §3/§5  every captured tool context receives the exact same harness reference;
//          agents, conversation state, and harness memory survive replacement.
//   §5     successful registration is a completion barrier and publishes metadata,
//          schema, and implementation together; the result names the revision.
//   §5     syntax, top-level-load, and invalid-export failures never publish:
//          the old definition object, metadata, schema, and source revision stay;
//          a failed NEW name creates no entry.
//   §6/§15/§16  toolRegistry replaces itself twice; the old invocation completes;
//          the replacement registers another tool and remains usable after a
//          failed attempt to replace itself.
//   §7     tool-to-tool calls resolve through H.callTool at CALL time, so a later
//          definition is observed (no fixed imported implementation).
//   §11    the registering agent can call a newly registered tool on the next
//          model request without toolRequest/discovery.
//
// WHAT IT DOES NOT DO
// -------------------
// - It does not build, typecheck, or run the repository test suite. Run it after
//   `yarn build`; a stale dist fails the production-entry check loudly.
// - It does not perform a clean `npm pack` + `npm install --omit=dev`. Runtime
//   dependencies are linked from the already-installed node_modules so no network
//   is required; the output states this explicitly. A clean production install is
//   a stronger packaging check, not a prerequisite for the runtime scenario.
// - It does not claim transpilation is semantic type checking. The kernel reports
//   `transpile:syntax`; this script asserts that exact report.
//
// USAGE
//     node scripts/check-package-tools.mjs                 # after yarn build
//     node scripts/check-package-tools.mjs --scratch <dir> --keep
//
// Scratch always lives under repository-root Temp/ (see ./scratch.mjs), and
// TEMP/TMP/TMPDIR are redirected there for this process and any child.
//
// Cross-references:
//   - ./package-files.mjs        — published-file resolution + copy helper
//   - ./scratch.mjs              — repository Temp scratch root
//   - ./check-package-runtime.mjs — non-self-modifying package smoke
//   - ../src/core/tool-source.ts — compiler and source-record contract
//   - ../src/harness.ts          — registerTool/executeTool/callTool kernel
//   - ../src/tools/runtime/toolRegistry.tool.ts — ordinary registration tool

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
    BUILD_ROOT,
    EDITABLE_SOURCE_ROOT,
    PACKAGE_ROOT,
    copyPublishedPackage,
    publishedFiles,
    readPackageManifest
} from './package-files.mjs';
import { applyScratchEnvironment, resolveScratchRoot } from './scratch.mjs';

const DIST_ENTRY = path.join(PACKAGE_ROOT, BUILD_ROOT, 'underload-harness.mjs');
const EXPECTED_CHECKS = ['transpile:syntax', 'load:module', 'contract:tool', 'schema:json'];
// Known shipped source entries. The runtime list is the harness-owned core
// surface (src/tools/runtime/, moved out of the old top-level `runtime-tools/`
// folder by T21); the app list is the server catalogue's independent entries. The
// list is kept explicit so a missing published entry is a failure rather than
// silent coverage loss. The inventory below also reports dynamically discovered
// files, so a newly landed entry is counted without this script inventing its name.
const RUNTIME_SOURCE_ENTRIES = [
    'actionRequest.tool.ts',
    'agentDelegate.tool.ts',
    'agentManage.tool.ts',
    'agentResult.tool.ts',
    'chapterManage.tool.ts',
    'locationManage.tool.ts',
    'profileManage.tool.ts',
    'threadFork.tool.ts',
    'threadList.tool.ts',
    'threadSend.tool.ts',
    'todoManage.tool.ts',
    'toolCancel.tool.ts',
    'toolCreate.tool.ts',
    'toolList.tool.ts',
    'toolManage.tool.ts',
    'toolRegistry.tool.ts',
    'toolRequest.tool.ts',
    'webFetch.tool.ts',
    'webSearch.tool.ts'
];
const WEB_SOURCE_ENTRIES = ['webFetch.tool.ts', 'webSearch.tool.ts'];
// App tool entries (T25): DERIVED from the server tools folders, never a hand list.
// The layout is the contract: `src/server/tools/shared` is the shared toolbox and
// `src/server/tools/examples` is opt-in per harness. A new `*.tool.ts` in either
// folder is counted here without this script knowing its name.
const APP_TOOLS_ROOT = ['server', 'tools'];
const APP_TOOL_FOLDERS = ['shared', 'examples'];
// Preset implementation entries. These are shipped and independently loadable, but
// the default harness registers the lazy catalogue proxies rather than source
// revisions, so this check inventories their files without claiming a startup
// source record for them.
const PRESET_SOURCE_ENTRIES = [
    'tools/command/commandRun.tool.ts',
    'tools/command/gitDiff.tool.ts',
    'tools/files/fileEdit.tool.ts',
    'tools/files/fileGlob.tool.ts',
    'tools/files/fileList.tool.ts',
    'tools/files/fileRead.tool.ts',
    'tools/files/fileWrite.tool.ts',
    'tools/syntax/syntaxCheck.tool.ts'
];
// Runtime entries that this no-subagent/no-interaction harness registers at
// startup. Each must have a source record captured by the SAME operation runtime
// registration uses. Paths are relative to the package source root and point at
// the shipped `src/tools/runtime/` tree (T21 moved them from `runtime-tools/`).
const STARTUP_SOURCE_ENTRIES = {
    toolRegistry: 'tools/runtime/toolRegistry.tool.ts',
    toolRequest: 'tools/runtime/toolRequest.tool.ts',
    toolList: 'tools/runtime/toolList.tool.ts',
    toolManage: 'tools/runtime/toolManage.tool.ts',
    toolCreate: 'tools/runtime/toolCreate.tool.ts',
    todoManage: 'tools/runtime/todoManage.tool.ts',
    profileManage: 'tools/runtime/profileManage.tool.ts',
    chapterManage: 'tools/runtime/chapterManage.tool.ts',
    locationManage: 'tools/runtime/locationManage.tool.ts',
    agentManage: 'tools/runtime/agentManage.tool.ts',
    agentResult: 'tools/runtime/agentResult.tool.ts'
};

const FIXTURE_ROOT = 'self-modify-fixture';
const PROBE_PATH = `${FIXTURE_ROOT}/probe.ts`;
const HELPER_PATH = `${FIXTURE_ROOT}/helper.ts`;
const NESTED_PATH = `${FIXTURE_ROOT}/nested.ts`;
const MODEL_PROBE_PATH = `${FIXTURE_ROOT}/model-probe.ts`;
const REGISTRY_V2_PATH = `${FIXTURE_ROOT}/registry-v2.ts`;
const REGISTRY_V3_PATH = `${FIXTURE_ROOT}/registry-v3.ts`;
const REGISTRY_CHILD_PATH = `${FIXTURE_ROOT}/registry-child.ts`;
const REGISTRY_BROKEN_PATH = `${FIXTURE_ROOT}/registry-broken.ts`;

const fail = (message) => {
    console.error(`package tools: ${message}`);
    process.exit(1);
};

if (!existsSync(DIST_ENTRY)) {
    fail('dist/ has no production entry - run `yarn build` first');
}

const scratchRoot = resolveScratchRoot({ kind: 'package-tools' });
applyScratchEnvironment(scratchRoot);
const keep = process.argv.includes('--keep');
const work = mkdtempSync(path.join(scratchRoot, 'run-'));
const packageRoot = path.join(work, 'package');
const copiedSourceRoot = path.join(packageRoot, EDITABLE_SOURCE_ROOT);
// The scenario imports THIS entry, not <package>/dist: the copied package is the
// installed layout under test, and its sibling src/ is the editable source root.
const copiedDistEntry = path.join(packageRoot, BUILD_ROOT, path.basename(DIST_ENTRY));

// Result bookkeeping mirrors check-package-runtime.mjs: every assertion runs
// inside a check, so one failure is reported and the remaining checks still
// produce evidence instead of crashing the process on an unhandled rejection.
const results = [];
const check = async (name, fn) => {
    try {
        const detail = await fn();
        results.push({ name, ok: true });
        console.log(`  OK   ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
    } catch (error) {
        results.push({ name, ok: false, error: String(error) });
        console.error(`  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
};

// Return the rejection reason; a resolved action is itself a failed expectation.
const rejectionOf = async (action) => {
    try {
        await action();
    } catch (error) {
        return error;
    }
    throw new Error('expected the registration to fail, but it resolved');
};

const writeSource = (relative, text) => {
    const target = path.join(copiedSourceRoot, relative);
    assert.ok(target.startsWith(copiedSourceRoot + path.sep), `fixture escaped src/: ${relative}`);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text, 'utf8');
    return target;
};

// ---------------------------------------------------------------------------
// Fixture sources
// ---------------------------------------------------------------------------
//
// The probe is split into an entry and a local helper so the check can prove a
// helper-only edit changes the captured revision and the executed behaviour. The
// entry text stays IDENTICAL between V1 and V2; only helper.ts changes. V3 edits
// both. Every implementation records the context it actually received in a global
// sink so the host test (not the tool) decides whether identity was preserved.

const probeSource = (entryComment = '') => `// Editable fixture entry for scripts/check-package-tools.mjs.
import { tool } from '../core';
import { helperTag, probeRevision } from './helper';

const sink = (entry: Record<string, unknown>) => {
    const captures = (globalThis as any).__UNDERLOAD_TOOL_CHECK__;
    if (Array.isArray(captures)) captures.push(entry);
};

export const probe = tool({
    name: 'probe',
    description: 'Fixture probe V1',
    tags: ['fixture', 'self-modifying'],
    parameters: {
        type: 'object',
        properties: {
            payload: { type: 'string' },
            nested: { type: 'boolean' }
        },
        required: ['payload'],
        additionalProperties: false
    },
    execute: async (context: any) => {
        const harness = context.harness;
        const previous = harness.memory.get('probe-runs') ?? [];
        sink({
            kind: 'probe',
            revision: probeRevision,
            helper: helperTag,
            payload: context.parameters.payload,
            harness,
            agent: context.agent,
            agents: context.agents,
            messages: context.agent ? context.agent.messages.length : -1,
            memoryRuns: previous,
            contextCallTool: typeof context.callTool,
            harnessCallTool: typeof harness.callTool
        });
        harness.memory.set('probe-runs', [...previous, context.parameters.payload]);

        const result: any = {
            revision: probeRevision,
            helper: helperTag,
            payload: context.parameters.payload
        };

        // Resolve the sibling at CALL time through the live harness. Replacing
        // nested.ts after this source was installed must be observed here.
        if (context.parameters.nested === true) {
            result.nested = await harness.callTool('nested', {
                payload: context.parameters.payload,
                mode: 'live'
            });
        }

        return result;
    }
});
${entryComment}`;

const helperSource = (version) => `// Local helper captured with the editable entry revision.
export const probeRevision = ${version};
export const helperTag = 'helper-v${version}';
// helper edit ${version}
`;

const nestedSource = (version) => `// Editable sibling resolved through the LIVE registry, never imported.
import { tool } from '../core';

export const nested = tool({
    name: 'nested',
    description: 'Fixture nested tool V${version}',
    tags: ['fixture', 'nested'],
    parameters: {
        type: 'object',
        properties: {
            payload: { type: 'string' },
            mode: { type: 'string' }
        },
        required: ['payload']
    },
    execute: async (context: any) => ({
        version: 'nested-v${version}',
        payload: context.parameters.payload,
        mode: context.parameters.mode
    })
});
`;

const modelProbeSource = `// Editable fixture registered by the MODEL through toolRegistry.
import { tool } from '../core';

const sink = (entry: Record<string, unknown>) => {
    const captures = (globalThis as any).__UNDERLOAD_TOOL_CHECK__;
    if (Array.isArray(captures)) captures.push(entry);
};

export const modelProbe = tool({
    name: 'modelProbe',
    description: 'Fixture tool registered during a scripted model turn',
    tags: ['fixture', 'model'],
    parameters: {
        type: 'object',
        properties: {
            payload: { type: 'string' },
            note: { type: 'string' }
        },
        required: ['payload']
    },
    execute: async (context: any) => {
        const harness = context.harness;
        sink({
            kind: 'model-probe',
            harness,
            agent: context.agent,
            agents: context.agents,
            messages: context.agent ? context.agent.messages.length : -1,
            memoryRuns: harness.memory.get('probe-runs'),
            payload: context.parameters.payload
        });
        return { revision: 'model-probe', payload: context.parameters.payload };
    }
});
`;

// Replacement registries are ordinary editable modules. They delegate to the
// kernel method, never to the currently registered model-facing tool (that would
// recurse through the tool being replaced).
const registrySource = (version) => `// Replacement toolRegistry fixture V${version}.
import { TOOL_REGISTRY_METADATA } from '../core/metadata';
import type { HarnessToolRegistrationCandidate, ToolContext } from '../types';

export const metadata = TOOL_REGISTRY_METADATA;

export const execute = async (context: ToolContext) => {
    const harness = context.harness;

    if (harness === undefined) {
        throw new Error('fixture toolRegistry V${version} requires the live harness reference');
    }

    const parameters = (context.parameters ?? {}) as Record<string, unknown>;

    if (parameters.definition !== undefined) {
        throw new Error('fixture toolRegistry V${version} rejects prebuilt definitions');
    }

    const candidate: HarnessToolRegistrationCandidate = {
        ...(typeof parameters.name === 'string' ? { name: parameters.name } : {}),
        ...(typeof parameters.description === 'string' ? { description: parameters.description } : {}),
        ...(Array.isArray(parameters.tags) ? { tags: parameters.tags as string[] } : {}),
        ...(typeof parameters.parameters === 'object' && parameters.parameters !== null
            ? { parameters: parameters.parameters as Record<string, unknown> }
            : {}),
        ...(parameters.visibility === 'core' || parameters.visibility === 'searchable'
            ? { visibility: parameters.visibility as 'core' | 'searchable' }
            : {}),
        ...(typeof parameters.source === 'string' ? { source: parameters.source } : {}),
        ...(typeof parameters.moduleText === 'string' ? { moduleText: parameters.moduleText } : {}),
        ...(typeof parameters.sourcePath === 'string' ? { sourcePath: parameters.sourcePath } : {})
    };

    const result = await harness.registerTool(candidate);
    return { ...result, registry: 'v${version}' };
};
`;

const registryChildSource = `// Fixture registered BY a replacement toolRegistry, not by the original.
import { tool } from '../core';

export const registryChild = tool({
    name: 'registryChild',
    description: 'Fixture child registered by a replacement registry',
    tags: ['fixture', 'registry-child'],
    parameters: {
        type: 'object',
        properties: {
            payload: { type: 'string' },
            note: { type: 'string' }
        },
        required: ['payload']
    },
    execute: async (context: any) => ({ ok: true, payload: context.parameters.payload })
});
`;

// ---------------------------------------------------------------------------
// Published package fixture
// ---------------------------------------------------------------------------

const manifest = readPackageManifest(PACKAGE_ROOT);
const published = publishedFiles({ root: PACKAGE_ROOT, manifest });
const copied = copyPublishedPackage({
    sourceRoot: PACKAGE_ROOT,
    targetRoot: packageRoot,
    manifest
});

// npm always includes the root manifest; copyPublishedPackage models `files`, so
// write package.json explicitly. Without it, module resolution and package-root
// discovery from dist/ would not reflect an installed package.
copyFileSync(path.join(PACKAGE_ROOT, 'package.json'), path.join(packageRoot, 'package.json'));

const findInstalledDependency = (dependency) => {
    let current = PACKAGE_ROOT;

    while (true) {
        const candidate = path.join(current, 'node_modules', dependency);
        if (existsSync(path.join(candidate, 'package.json'))) return candidate;

        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }

    throw new Error(`runtime dependency "${dependency}" is not installed`);
};

// Explicit dependency resolution: link exactly the production dependencies named
// by the manifest into the copied package's node_modules. This avoids relying on
// an incidental parent-directory lookup, while still using installed packages and
// no network. A clean `--omit=dev` install is intentionally NOT performed here.
const dependencyNames = Object.keys(manifest.dependencies ?? {});
const linkedDependencies = dependencyNames.map((dependency) => {
    const target = findInstalledDependency(dependency);
    const link = path.join(packageRoot, 'node_modules', dependency);
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return { dependency, target };
});

console.log(
    `package tools: copied ${published.length} published file(s); linked runtime dependencies ${dependencyNames.join(', ')}; clean production install NOT performed`
);

// Fixture files are written into the COPIED src/ tree, which is what the copied
// dist/ entry resolves as its editable source root. The repository source tree is
// never modified and never imported by this script.
writeSource(HELPER_PATH, helperSource(1));
writeSource(PROBE_PATH, probeSource());
writeSource(NESTED_PATH, nestedSource(1));
writeSource(MODEL_PROBE_PATH, modelProbeSource);
writeSource(REGISTRY_V2_PATH, registrySource(2));
writeSource(REGISTRY_V3_PATH, registrySource(3));
writeSource(REGISTRY_CHILD_PATH, registryChildSource);
writeSource(REGISTRY_BROKEN_PATH, 'export const toolRegistry = (\n');

// ---------------------------------------------------------------------------
// Production entry
// ---------------------------------------------------------------------------

await check('published shape ships editable src beside built dist', () => {
    const sourceEntry = path.join(copiedSourceRoot, 'index.ts');
    const registrySourcePath = path.join(copiedSourceRoot, 'tools', 'runtime', 'toolRegistry.tool.ts');

    assert.ok(existsSync(sourceEntry), 'copied src/index.ts is missing');
    assert.ok(existsSync(registrySourcePath), 'copied src/tools/runtime/toolRegistry.tool.ts is missing');
    assert.ok(existsSync(copiedDistEntry), 'copied dist production entry is missing');
    assert.equal(path.dirname(copiedSourceRoot), path.dirname(path.join(packageRoot, BUILD_ROOT)));

    const publishedTests = copied.filter((file) => /\.(?:test|spec)\.(?:ts|tsx)$/.test(file));
    assert.deepEqual(publishedTests, [], 'test files were published as source');

    return {
        files: copied.length,
        source: `${EDITABLE_SOURCE_ROOT}/index.ts`,
        dist: `${BUILD_ROOT}/${path.basename(DIST_ENTRY)}`
    };
});

await check('TypeScript is a resolvable runtime dependency of the copied package', () => {
    assert.equal(typeof manifest.dependencies?.typescript, 'string', 'typescript is not a runtime dependency');

    const requireFromCopied = createRequire(path.join(packageRoot, 'package.json'));
    const resolved = requireFromCopied.resolve('typescript');
    const loaded = requireFromCopied('typescript');
    // Read the linked dependency's manifest directly: package `exports` maps are
    // allowed to hide package.json, and the dependency version is packaging
    // evidence this check reports rather than behaviour under test.
    const typescriptDirectory = linkedDependencies.find(
        (entry) => entry.dependency === 'typescript'
    ).target;
    const version = JSON.parse(
        readFileSync(path.join(typescriptDirectory, 'package.json'), 'utf8')
    ).version;

    assert.equal(typeof loaded.transpileModule, 'function');
    assert.match(version, /^\d+\.\d+\.\d+/);

    return {
        dependencies: linkedDependencies.map(({ dependency }) => dependency),
        typescript: path.relative(packageRoot, resolved).split(path.sep).join('/'),
        version
    };
});

let production;
let writer;
let H;

try {
    // Import the COPIED production entry. Importing the repository dist would let
    // package-root discovery fall back to the repository src tree and would not
    // prove the installed shape works.
    production = await import(pathToFileURL(copiedDistEntry).href);
    assert.equal(typeof production.agent, 'function', 'production entry does not export agent');
    assert.equal(typeof production.harness, 'function', 'production entry does not export harness');
} catch (error) {
    fail(`production entry could not be imported from the copied package: ${error instanceof Error ? error.message : String(error)}`);
}

// Capture sink shared with every dynamically loaded fixture. The fixture modules
// run in this process (the kernel evaluates them with new Function); this is an
// observation channel for the check, not part of the public tool contract.
const captures = [];
globalThis.__UNDERLOAD_TOOL_CHECK__ = captures;

// One scripted model turn sequence, fully offline:
//   1. register modelProbe through the ordinary core toolRegistry;
//   2. call modelProbe on the NEXT request without toolRequest/discovery;
//   3. finish with text.
// Requests are recorded so the check can assert what the model was actually
// offered, rather than trusting that "registration made it available".
const modelRequests = [];
const scriptedStream = async function* stream(request) {
    modelRequests.push(request);
    const turn = modelRequests.length;

    if (turn === 1) {
        yield {
            type: 'done',
            stopReason: 'tool_calls',
            toolCalls: [
                {
                    id: 'model-register',
                    name: 'toolRegistry',
                    arguments: JSON.stringify({ name: 'modelProbe', sourcePath: MODEL_PROBE_PATH })
                }
            ]
        };
        return;
    }

    if (turn === 2) {
        yield {
            type: 'done',
            stopReason: 'tool_calls',
            toolCalls: [
                {
                    id: 'model-invoke',
                    name: 'modelProbe',
                    arguments: JSON.stringify({ payload: 'from-model' })
                }
            ]
        };
        return;
    }

    if (turn === 3) {
        yield { type: 'text', delta: 'model finished' };
        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        return;
    }

    throw new Error(`unexpected scripted model request ${turn}`);
};

try {
    writer = production.agent({ model: 'offline/scripted', stream: scriptedStream });
    H = production.harness({ agents: { writer }, presets: false });
} catch (error) {
    fail(`production harness could not start from the copied package: ${error instanceof Error ? error.message : String(error)}`);
}

// Fail with one actionable list before running the scenario. These are the
// contracts the kernel owner must expose for the self-modification loop; a stale
// dist that predates the feature is the most likely cause.
await check('production harness exposes the self-modification API', () => {
    assert.equal(typeof H.registerTool, 'function', 'H.registerTool is missing');
    assert.equal(typeof H.callTool, 'function', 'H.callTool is missing');
    assert.equal(typeof H.toolSource, 'function', 'H.toolSource is missing');
    assert.equal(typeof H.toolSources, 'function', 'H.toolSources is missing');
    assert.equal(typeof H.executeTool, 'function', 'H.executeTool is missing');
    assert.equal(typeof H.memory?.get, 'function', 'H.memory is missing');
    assert.equal(H.agent, writer);
    assert.equal(H.agents.writer, writer);

    const registrySource = H.toolSource('toolRegistry');
    assert.ok(registrySource, 'toolRegistry has no captured source revision');
    assert.equal(registrySource.sourcePath, 'tools/runtime/toolRegistry.tool.ts');
    assert.deepEqual(registrySource.dependencies, []);

    return { tool: 'toolRegistry', source: registrySource.sourcePath };
});

// Shipped source inventory. This is deliberately file-based (the copied src tree)
// rather than an import: the production package is the subject, and a source tree
// that lost an entry must fail before the synthetic fixtures divert attention.
await check('shipped source entry inventory is present in the copied package', () => {
    const runtimeDirectory = path.join(copiedSourceRoot, 'tools', 'runtime');
    const runtimeEntries = readdirSync(runtimeDirectory)
        .filter((name) => name.endsWith('.ts'))
        .sort();

    // T25: app entries are discovered, not listed. Each folder is scanned
    // recursively for `*.tool.ts`; the inventory reports what is actually shipped,
    // so a new entry needs no edit here and a DELETED one still fails the
    // non-empty/`*.tool.ts` assertions below.
    const appDirectories = APP_TOOL_FOLDERS.map((folder) =>
        path.join(copiedSourceRoot, ...APP_TOOLS_ROOT, folder)
    );
    const appEntries = appDirectories
        .flatMap((directory) =>
            readdirSync(directory)
                .filter((name) => name.endsWith('.tool.ts'))
                .map((name) => `${path.basename(directory)}/${name}`)
        )
        .sort();

    // Known entries must exist. Extra entries are reported, not rejected: a future
    // source entry landing in the same directory is not a regression in this check.
    for (const name of RUNTIME_SOURCE_ENTRIES) {
        assert.ok(runtimeEntries.includes(name), `runtime source entry is missing: ${name}`);
    }

    // The two app folders are the whole exclusion contract: `shared` is the shared
    // toolbox, `examples` is opt-in. Both must exist and both must ship at least the
    // entries the presets advertise, or the toolbox silently loses a tool.
    for (const folder of APP_TOOL_FOLDERS) {
        const directory = path.join(copiedSourceRoot, ...APP_TOOLS_ROOT, folder);
        assert.ok(existsSync(directory), `app tools folder is missing: ${folder}`);
        assert.ok(
            appEntries.some((entry) => entry.startsWith(`${folder}/`)),
            `app tools folder ships no *.tool.ts entry: ${folder}`
        );
    }

    const additionalRuntime = runtimeEntries.filter(
        (name) => !RUNTIME_SOURCE_ENTRIES.includes(name)
    );

    for (const relative of [
        ...RUNTIME_SOURCE_ENTRIES.map((name) => `tools/runtime/${name}`),
        ...appEntries.map((name) => `${APP_TOOLS_ROOT.join('/')}/${name}`),
        ...PRESET_SOURCE_ENTRIES
    ]) {
        const file = path.join(copiedSourceRoot, relative);
        assert.ok(existsSync(file), `shipped source entry is missing: ${relative}`);
        assert.ok(readFileSync(file, 'utf8').trim().length > 0, `shipped source entry is empty: ${relative}`);
    }

    // T14 web entries are not established yet. Report any dynamically discovered
    // web-looking app entries instead of inventing names or failing their absence.
    const webEntries = appEntries.filter((name) => /web/i.test(name));
    return {
        runtime: runtimeEntries.length,
        app: appEntries.length,
        preset: PRESET_SOURCE_ENTRIES.length,
        additionalRuntime,
        appEntries,
        webEntries
    };
});

// Startup registration (server/application bootstrap) must expose the exact source
// records the shared kernel captured. No direct source import is used: these are
// records on the live production harness.
await check('startup registration exposes source records for harness-owned core entries', () => {
    const records = Object.entries(STARTUP_SOURCE_ENTRIES).map(([name, sourcePath]) => {
        const source = H.toolSource(name);
        assert.ok(source, `startup tool "${name}" has no source record`);
        assert.equal(source.name, name);
        assert.equal(source.format, 'module');
        assert.equal(source.sourcePath, sourcePath);
        assert.deepEqual(source.dependencies, []);
        assert.deepEqual(source.checks, EXPECTED_CHECKS);
        assert.match(source.revision, /^[0-9a-f]{16}$/);
        return { name, sourcePath, revision: source.revision };
    });

    return { entries: records.length };
});

// Actual shipped app tool source (not a synthetic fixture). It is registered by the
// ordinary toolRegistry from the copied src path, gets a source record, and executes
// with its exact standalone result. T25: the path is the discovered app entry
// (server/tools/shared/textCount.tool.ts), not the old tool-sources copy.
await check('shipped app source entry compiles, registers, invokes, and keeps its record', async () => {
    const sourcePath = 'server/tools/shared/textCount.tool.ts';
    const result = await H.executeTool('toolRegistry', { name: 'textCount', sourcePath });

    assert.equal(result.name, 'textCount');
    assert.equal(result.created, true);
    assert.equal(result.replaced, false);
    assert.equal(result.sourcePath, sourcePath);
    assert.deepEqual(result.checks, EXPECTED_CHECKS);

    const source = H.toolSource('textCount');
    assert.ok(source, 'textCount has no source record');
    assert.equal(source.format, 'module');
    assert.equal(source.sourcePath, sourcePath);
    assert.deepEqual(source.dependencies, []);
    assert.deepEqual(source.checks, EXPECTED_CHECKS);

    assert.deepEqual(H.tools.textCount.tags, ['text', 'words', 'count']);
    assert.deepEqual(await H.executeTool('textCount', { text: 'héllo 😀' }), {
        words: 2,
        characters: 8
    });

    return { name: 'textCount', source: sourcePath };
});

// T14 web entries are opt-in at runtime: credentials/provider closure belong to a
// configured harness. Compile/register the shipped source entries to prove they are
// independently loadable without making a network call or inventing a provider.
await check('opt-in web source entries compile and keep source records', async () => {
    const installed = [];

    for (const file of WEB_SOURCE_ENTRIES) {
        const name = file.replace(/\.tool\.ts$/, '');
        const sourcePath = `tools/runtime/${file}`;
        const result = await H.executeTool('toolRegistry', { name, sourcePath });

        assert.equal(result.name, name);
        assert.equal(result.created, true);
        assert.equal(result.replaced, false);
        assert.equal(result.sourcePath, sourcePath);
        assert.deepEqual(result.checks, EXPECTED_CHECKS);

        const source = H.toolSource(name);
        assert.ok(source, `${name} has no source record`);
        assert.equal(source.format, 'module');
        assert.equal(source.sourcePath, sourcePath);
        assert.deepEqual(source.dependencies, []);
        assert.deepEqual(source.checks, EXPECTED_CHECKS);
        installed.push(name);
    }

    // The entries are registered but not invoked: execution needs the configured
    // provider closure and would be a network operation.
    return { compiled: installed };
});

// ---------------------------------------------------------------------------
// Inventory freedom: a brand-new .tool.ts needs no catalogue/registry edit
// ---------------------------------------------------------------------------
//
// T21: the public preset surface is derived from the generated descriptor
// manifest, and discovery reads the filesystem. So a tool that simply LANDS in the
// package's default tools tree must be discoverable — and loadable — without any
// hand-maintained inventory being touched. This probe writes such a file into the
// COPIED package (never the repository source tree) and proves both halves.
const BRAND_NEW_PATH = 'tools/probe-auto/brandNew.tool.ts';

await check('a brand-new .tool.ts is discovered and loadable with no inventory edit', async () => {
    writeSource(
        BRAND_NEW_PATH,
        `// Brand-new package entry written by scripts/check-package-tools.mjs (T21).
import { tool } from '../../core';

// TWO properties on purpose: the single-property rule would hand \`execute\` the
// bare \`value\` string, and this fixture asserts the whole-object path.
export const metadata = {
    name: 'brandNew',
    description: 'A tool that only exists because its file exists.',
    tags: ['fixture', 'inventory-free'],
    visibility: 'searchable' as const,
    parameters: {
        type: 'object',
        properties: {
            value: { type: 'string' },
            note: { type: 'string' }
        },
        required: ['value'],
        additionalProperties: false
    }
};

export const registration = { group: 'preset', activation: 'always', order: 950 };

export const execute = async (context: any) => ({ echoed: context.parameters.value });

export const brandNew = tool({ ...metadata, execute });

export default brandNew;
`
    );

    // The public preset table is the GENERATED one: it must NOT contain the new
    // name, which is the proof that nothing regenerated and no inventory was edited.
    assert.equal(
        Object.prototype.hasOwnProperty.call(production.presetTools, 'brandNew'),
        false,
        'the shipped preset table already contained the fixture name'
    );

    // THE PROOF: a default harness (presets enabled) SCANS the copied package's
    // tools tree at construction. If the brand-new entry needed any hand-maintained
    // inventory — a catalogue row, a name list, a manual import switch — it would be
    // absent here, because none of those were touched.
    const scanWriter = production.agent({ model: 'offline/scripted', stream: scriptedStream });
    const scanning = production.harness({ agents: { writer: scanWriter } });

    const discovered = scanning.tools.brandNew;
    assert.ok(discovered, 'a brand-new .tool.ts was not discovered by a default harness');
    assert.equal(discovered.description, 'A tool that only exists because its file exists.');
    assert.deepEqual(discovered.tags, ['fixture', 'inventory-free']);

    // The source record proves the entry was compiled from ITS OWN path, not from a
    // generated manifest row (the manifest is a build artifact of the repository and
    // cannot know about a file added to an installed copy).
    const record = scanning.toolSource('brandNew');
    assert.ok(record, 'the brand-new entry has no source record');
    assert.equal(record.sourcePath, BRAND_NEW_PATH);

    // And it is loadable and callable through the ordinary startup path.
    assert.deepEqual(await scanning.executeTool('brandNew', { value: 'inventory-free' }), {
        echoed: 'inventory-free'
    });

    // A preset the package DOES ship keeps working in the same harness, so the new
    // row joined the catalogue rather than replacing it.
    assert.ok(scanning.tools.fileRead, 'the shipped preset catalogue is missing fileRead');

    return { discovered: BRAND_NEW_PATH, executed: 'brandNew' };
});

// ---------------------------------------------------------------------------
// Host path: register V1, invoke, then replace from the same editable path
// ---------------------------------------------------------------------------

const initialRegistryDefinition = H.tools.toolRegistry;
// Guard the inspection call for a stale dist: the API check above reports the
// missing method, and the scenario then fails per-check instead of crashing here.
const initialRegistryRevision =
    typeof H.toolSource === 'function' ? H.toolSource('toolRegistry')?.revision : undefined;

let probeV1Definition;
let probeV1Revision;

await check('H.executeTool registers a shipped editable source through toolRegistry', async () => {
    const result = await H.executeTool('toolRegistry', {
        name: 'probe',
        sourcePath: PROBE_PATH
    });

    assert.equal(result.name, 'probe');
    assert.equal(result.created, true);
    assert.equal(result.replaced, false);
    assert.equal(result.sourcePath, PROBE_PATH);
    assert.equal(result.previousRevision, undefined);
    assert.deepEqual(result.checks, EXPECTED_CHECKS);

    const source = H.toolSource('probe');
    assert.ok(source, 'installed probe has no source record');
    assert.equal(source.name, 'probe');
    assert.equal(source.format, 'module');
    assert.equal(source.sourcePath, PROBE_PATH);
    assert.deepEqual(source.checks, EXPECTED_CHECKS);
    assert.equal(source.revision, result.revision);
    assert.match(source.revision, /^[0-9a-f]{16}$/);
    assert.deepEqual(
        source.dependencies.map((dependency) => dependency.path),
        [HELPER_PATH]
    );
    assert.match(source.dependencies[0].text, /helper-v1/);
    assert.deepEqual(H.tools.probe.tags, ['fixture', 'self-modifying']);
    assert.deepEqual(H.tools.probe.parameters, {
        type: 'object',
        properties: {
            payload: { type: 'string' },
            nested: { type: 'boolean' }
        },
        required: ['payload'],
        additionalProperties: false
    });

    probeV1Definition = H.tools.probe;
    probeV1Revision = result.revision;
    assert.ok(probeV1Definition);
    return { revision: result.revision, files: [PROBE_PATH, HELPER_PATH] };
});

await check('V1 invocation receives the exact live harness and writes harness memory', async () => {
    const result = await H.executeTool('probe', { payload: 'host-v1' });
    const captured = captures.at(-1);

    assert.deepEqual(result, { revision: 1, helper: 'helper-v1', payload: 'host-v1' });
    assert.ok(captured && captured.kind === 'probe');
    assert.equal(captured.harness, H);
    assert.equal(captured.agent, writer);
    assert.equal(captured.agents, H.agents);
    assert.equal(captured.messages, 0);
    assert.deepEqual(captured.memoryRuns, []);
    assert.equal(captured.contextCallTool, 'function');
    assert.equal(captured.harnessCallTool, 'function');
    assert.deepEqual(H.memory.get('probe-runs'), ['host-v1']);

    return { harnessIdentity: captured.harness === H, memory: ['host-v1'] };
});

await check('replacing nested from the same source path is observed by a live call', async () => {
    const first = await H.executeTool('toolRegistry', {
        name: 'nested',
        sourcePath: NESTED_PATH
    });
    assert.equal(first.created, true);
    const nestedV1 = H.tools.nested;
    const nestedV1Revision = first.revision;

    const v1Result = await H.executeTool('nested', { payload: 'before', mode: 'host' });
    assert.deepEqual(v1Result, { version: 'nested-v1', payload: 'before', mode: 'host' });

    // Edit the SAME path. The probe was installed before this replacement and
    // must resolve the new definition at call time through H.callTool.
    writeSource(NESTED_PATH, nestedSource(2));
    const second = await H.executeTool('toolRegistry', {
        name: 'nested',
        sourcePath: NESTED_PATH
    });

    assert.equal(second.created, false);
    assert.equal(second.replaced, true);
    assert.equal(second.previousRevision, nestedV1Revision);
    assert.notEqual(second.revision, nestedV1Revision);
    assert.notEqual(H.tools.nested, nestedV1);

    const result = await H.executeTool('probe', { payload: 'host-v2', nested: true });
    assert.deepEqual(result, {
        revision: 1,
        helper: 'helper-v1',
        payload: 'host-v2',
        nested: { version: 'nested-v2', payload: 'host-v2', mode: 'live' }
    });
    assert.deepEqual(H.memory.get('probe-runs'), ['host-v1', 'host-v2']);

    return { nestedRevisions: [nestedV1Revision, second.revision], observed: 'nested-v2' };
});

let probeV2Definition;
let probeV2Revision;

await check('helper-only edit changes the source revision and the installed behaviour', async () => {
    // Entry text is untouched between V1 and V2; only helper.ts changes. A source
    // record that ignored dependencies would keep the old revision and old text.
    const entryBefore = readFileSync(path.join(copiedSourceRoot, PROBE_PATH), 'utf8');
    writeSource(HELPER_PATH, helperSource(2));
    const entryAfter = readFileSync(path.join(copiedSourceRoot, PROBE_PATH), 'utf8');
    assert.equal(entryAfter, entryBefore, 'the helper-only step changed the entry text');

    const result = await H.executeTool('toolRegistry', {
        name: 'probe',
        sourcePath: PROBE_PATH,
        description: 'Fixture probe V2',
        parameters: {
            type: 'object',
            properties: {
                payload: { type: 'string' },
                nested: { type: 'boolean' },
                label: { type: 'string' }
            },
            required: ['payload']
        }
    });

    assert.equal(result.name, 'probe');
    assert.equal(result.created, false);
    assert.equal(result.replaced, true);
    assert.equal(result.previousRevision, probeV1Revision);
    assert.notEqual(result.revision, probeV1Revision);
    assert.equal(result.sourcePath, PROBE_PATH);
    assert.deepEqual(result.checks, EXPECTED_CHECKS);

    const source = H.toolSource('probe');
    assert.equal(source.revision, result.revision);
    assert.match(source.dependencies[0].text, /helper-v2/);

    assert.notEqual(H.tools.probe, probeV1Definition);
    assert.equal(H.tools.probe.description, 'Fixture probe V2');
    assert.deepEqual(H.tools.probe.parameters, {
        type: 'object',
        properties: {
            payload: { type: 'string' },
            nested: { type: 'boolean' },
            label: { type: 'string' }
        },
        required: ['payload']
    });

    const invocation = await H.executeTool('probe', { payload: 'host-v3' });
    const captured = captures.at(-1);
    assert.deepEqual(invocation, { revision: 2, helper: 'helper-v2', payload: 'host-v3' });
    assert.equal(captured.harness, H);
    assert.deepEqual(captured.memoryRuns, ['host-v1', 'host-v2']);
    assert.deepEqual(H.memory.get('probe-runs'), ['host-v1', 'host-v2', 'host-v3']);

    probeV2Definition = H.tools.probe;
    probeV2Revision = result.revision;
    return { revision: result.revision, helper: 'helper-v2' };
});

let probeV3Definition;
let probeV3Revision;

await check('V3 edits entry and helper on the same path and preserves harness state', async () => {
    writeSource(HELPER_PATH, helperSource(3));
    writeSource(PROBE_PATH, probeSource('// V3 entry edit: the same path is recompiled, not cached.'));

    const result = await H.executeTool('toolRegistry', {
        name: 'probe',
        sourcePath: PROBE_PATH,
        description: 'Fixture probe V3',
        parameters: {
            type: 'object',
            properties: {
                payload: { type: 'string' },
                nested: { type: 'boolean' },
                label: { type: 'string' },
                note: { type: 'string' }
            },
            required: ['payload']
        }
    });

    assert.equal(result.name, 'probe');
    assert.equal(result.created, false);
    assert.equal(result.replaced, true);
    assert.equal(result.previousRevision, probeV2Revision);
    assert.notEqual(result.revision, probeV2Revision);
    assert.deepEqual(result.checks, EXPECTED_CHECKS);

    const source = H.toolSource('probe');
    assert.equal(source.revision, result.revision);
    assert.match(source.dependencies[0].text, /helper-v3/);

    assert.notEqual(H.tools.probe, probeV2Definition);
    assert.equal(H.tools.probe.description, 'Fixture probe V3');

    const invocation = await H.executeTool('probe', { payload: 'host-v4' });
    const captured = captures.at(-1);
    assert.deepEqual(invocation, { revision: 3, helper: 'helper-v3', payload: 'host-v4' });
    assert.equal(captured.harness, H);
    assert.equal(captured.agent, writer);
    assert.equal(captured.messages, 0);
    assert.deepEqual(captured.memoryRuns, ['host-v1', 'host-v2', 'host-v3']);
    assert.deepEqual(H.memory.get('probe-runs'), ['host-v1', 'host-v2', 'host-v3', 'host-v4']);
    assert.equal(H.agents.writer, writer);
    assert.equal(H.agent, writer);

    probeV3Definition = H.tools.probe;
    probeV3Revision = result.revision;
    return {
        revisions: [probeV1Revision, probeV2Revision, probeV3Revision],
        memory: H.memory.get('probe-runs')
    };
});

// ---------------------------------------------------------------------------
// Failed registration must never publish
// ---------------------------------------------------------------------------

await check('syntax failure, top-level throw, and invalid exports preserve V3', async () => {
    const failures = [];

    // 1. TypeScript/JavaScript syntax failure.
    writeSource(PROBE_PATH, 'export const probe = (\n');
    const syntax = await rejectionOf(() =>
        H.executeTool('toolRegistry', { name: 'probe', sourcePath: PROBE_PATH })
    );
    assert.match(String(syntax.message), /^Tool source could not be transpiled:/);
    assert.ok(String(syntax.message).includes(PROBE_PATH), 'diagnostic omitted the editable source path');
    failures.push(String(syntax.message).split('\n')[0]);

    // 2. Valid syntax, top-level evaluation throws before exports are usable.
    writeSource(PROBE_PATH, "throw new Error('fixture-top-level');\nexport const probe = 1;\n");
    const loading = await rejectionOf(() =>
        H.executeTool('toolRegistry', { name: 'probe', sourcePath: PROBE_PATH })
    );
    assert.equal(
        String(loading.message),
        `Tool source "${PROBE_PATH}" could not be loaded: fixture-top-level`
    );
    failures.push(String(loading.message));

    // 3. Valid module, no acceptable tool export and no metadata + execute pair.
    writeSource(PROBE_PATH, 'export const probe = 1;\nexport default 42;\n');
    const invalid = await rejectionOf(() =>
        H.executeTool('toolRegistry', { name: 'probe', sourcePath: PROBE_PATH })
    );
    assert.equal(
        String(invalid.message),
        'Tool module did not export a tool: expected a named/default Tool, or `metadata` + `execute` exports.'
    );
    failures.push(String(invalid.message));

    // Registry entry itself: same definition object, same metadata, same schema,
    // same captured revision. Publication never partially replaced it.
    assert.equal(H.tools.probe, probeV3Definition);
    assert.equal(H.tools.probe.description, 'Fixture probe V3');
    assert.deepEqual(H.tools.probe.parameters, {
        type: 'object',
        properties: {
            payload: { type: 'string' },
            nested: { type: 'boolean' },
            label: { type: 'string' },
            note: { type: 'string' }
        },
        required: ['payload']
    });
    assert.equal(H.toolSource('probe').revision, probeV3Revision);

    // The old implementation is still runnable after all three failures.
    const invocation = await H.executeTool('probe', { payload: 'after-failures' });
    assert.deepEqual(invocation, { revision: 3, helper: 'helper-v3', payload: 'after-failures' });

    return { failures: failures.length, revision: probeV3Revision };
});

await check('failed registration of a NEW name creates no entry', async () => {
    // Inline source with a syntax error: the candidate is named by the request,
    // not by a readable module, so this exercises the new-name path directly.
    const error = await rejectionOf(() =>
        H.executeTool('toolRegistry', {
            name: 'candidateOnly',
            moduleText: 'export const candidateOnly = (\n'
        })
    );

    assert.match(String(error.message), /^Tool source could not be transpiled:/);
    assert.equal(H.tools.candidateOnly, undefined);
    assert.equal(H.toolSource('candidateOnly'), undefined);

    return { name: 'candidateOnly', registered: false };
});

// ---------------------------------------------------------------------------
// Model path: register through toolRegistry, then call without discovery
// ---------------------------------------------------------------------------

await check('scripted model registers and invokes a tool without a discovery round', async () => {
    const answer = await H('go');

    assert.equal(answer.content, 'model finished');
    assert.equal(answer.stopReason, 'stop');
    assert.deepEqual(answer.toolCalls, []);
    assert.equal(modelRequests.length, 3);

    assert.ok(
        modelRequests[0].tools.some((declaration) => declaration.name === 'toolRegistry'),
        'the first request did not declare the core toolRegistry tool'
    );
    assert.ok(
        modelRequests[1].tools.some((declaration) => declaration.name === 'modelProbe'),
        'modelProbe was not declared on the request immediately after registration'
    );
    assert.equal(
        modelRequests[1].tools.some((declaration) => declaration.name === 'toolRequest'),
        true,
        'the core discovery tool disappeared from the request'
    );

    const registration = JSON.parse(
        writer.messages.find((message) => message.role === 'tool' && message.toolCallId === 'model-register').content
    );
    assert.equal(registration.name, 'modelProbe');
    assert.equal(registration.created, true);
    assert.equal(registration.replaced, false);
    assert.equal(registration.sourcePath, MODEL_PROBE_PATH);
    assert.deepEqual(registration.checks, EXPECTED_CHECKS);

    const invocation = writer.messages.find(
        (message) => message.role === 'tool' && message.toolCallId === 'model-invoke'
    );
    assert.equal(invocation.name, 'modelProbe');
    assert.equal(invocation.content, '{"revision":"model-probe","payload":"from-model"}');

    const captured = captures.filter((entry) => entry.kind === 'model-probe').at(-1);
    assert.ok(captured, 'modelProbe did not record its execution context');
    assert.equal(captured.harness, H);
    assert.equal(captured.agent, writer);
    assert.equal(captured.agents, H.agents);
    assert.equal(captured.messages, 4);
    assert.deepEqual(captured.memoryRuns, [
        'host-v1',
        'host-v2',
        'host-v3',
        'host-v4',
        'after-failures'
    ]);

    assert.deepEqual(
        writer.messages.map((message) => message.role),
        ['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant']
    );
    assert.equal(writer.messages[0].content, 'go');
    assert.equal(writer.messages[5].content, 'model finished');
    assert.equal(H.memory.get('probe-runs').length, 5);

    return {
        requests: modelRequests.length,
        declaredAfterRegistration: modelRequests[1].tools.some((tool) => tool.name === 'modelProbe'),
        result: invocation.content
    };
});

// ---------------------------------------------------------------------------
// toolRegistry replaces itself twice, registers tools, survives failure
// ---------------------------------------------------------------------------

await check('toolRegistry V1 replaces itself with V2 while its invocation completes', async () => {
    const v1Definition = H.tools.toolRegistry;
    assert.equal(v1Definition, initialRegistryDefinition);

    // This call executes the ORIGINAL registry tool. Inside that invocation the
    // kernel publishes V2; V1 must still return a normal success result.
    const result = await H.executeTool('toolRegistry', {
        name: 'toolRegistry',
        sourcePath: REGISTRY_V2_PATH
    });

    assert.equal(result.name, 'toolRegistry');
    assert.equal(result.created, false);
    assert.equal(result.replaced, true);
    assert.equal(result.previousRevision, initialRegistryRevision);
    assert.notEqual(result.revision, initialRegistryRevision);
    assert.equal(result.sourcePath, REGISTRY_V2_PATH);
    assert.deepEqual(result.checks, EXPECTED_CHECKS);

    assert.notEqual(H.tools.toolRegistry, v1Definition);
    const source = H.toolSource('toolRegistry');
    assert.equal(source.sourcePath, REGISTRY_V2_PATH);
    assert.equal(source.revision, result.revision);

    return { from: initialRegistryRevision, to: result.revision };
});

let registryV2Definition;
let registryV2Revision;

await check('replacement registry V2 registers another tool through the harness kernel', async () => {
    registryV2Definition = H.tools.toolRegistry;
    registryV2Revision = H.toolSource('toolRegistry').revision;

    const result = await H.executeTool('toolRegistry', {
        name: 'registryChild',
        sourcePath: REGISTRY_CHILD_PATH
    });

    assert.equal(result.registry, 'v2');
    assert.equal(result.name, 'registryChild');
    assert.equal(result.created, true);
    assert.equal(result.replaced, false);
    assert.equal(result.sourcePath, REGISTRY_CHILD_PATH);
    assert.deepEqual(result.checks, EXPECTED_CHECKS);
    assert.ok(H.tools.registryChild);
    assert.equal(H.toolSource('registryChild').sourcePath, REGISTRY_CHILD_PATH);

    const invocation = await H.executeTool('registryChild', { payload: 'child-v2' });
    assert.deepEqual(invocation, { ok: true, payload: 'child-v2' });

    return { registry: result.registry, child: result.name };
});

await check('a failed self-replacement leaves V2 installed and usable', async () => {
    const result = await rejectionOf(() =>
        H.executeTool('toolRegistry', {
            name: 'toolRegistry',
            sourcePath: REGISTRY_BROKEN_PATH
        })
    );

    assert.match(String(result.message), /^Tool source could not be transpiled:/);
    assert.equal(H.tools.toolRegistry, registryV2Definition);
    assert.equal(H.toolSource('toolRegistry').revision, registryV2Revision);
    assert.equal(H.toolSource('toolRegistry').sourcePath, REGISTRY_V2_PATH);

    // V2 must still be able to register after its own failed replacement.
    const child = await H.executeTool('toolRegistry', {
        name: 'registryChildTwo',
        sourcePath: REGISTRY_CHILD_PATH
    });
    assert.equal(child.registry, 'v2');
    assert.equal(child.created, true);
    assert.ok(H.tools.registryChildTwo);

    return { preserved: REGISTRY_V2_PATH, stillUsable: child.registry };
});

await check('replacement registry V2 replaces itself with V3, then V3 registers another tool', async () => {
    const v2Definition = H.tools.toolRegistry;

    // Second self-replacement: V2 executes and publishes V3.
    const replacement = await H.executeTool('toolRegistry', {
        name: 'toolRegistry',
        sourcePath: REGISTRY_V3_PATH
    });

    assert.equal(replacement.registry, 'v2');
    assert.equal(replacement.name, 'toolRegistry');
    assert.equal(replacement.created, false);
    assert.equal(replacement.replaced, true);
    assert.equal(replacement.previousRevision, registryV2Revision);
    assert.notEqual(replacement.revision, registryV2Revision);
    assert.equal(replacement.sourcePath, REGISTRY_V3_PATH);
    assert.notEqual(H.tools.toolRegistry, v2Definition);
    assert.equal(H.toolSource('toolRegistry').sourcePath, REGISTRY_V3_PATH);

    const registryV3Revision = replacement.revision;
    assert.equal(H.toolSource('toolRegistry').revision, registryV3Revision);

    // V3 now registers a third child, proving the second replacement's tool is
    // itself an ordinary registration entry and can reach the kernel.
    const child = await H.executeTool('toolRegistry', {
        name: 'registryChildThree',
        sourcePath: REGISTRY_CHILD_PATH
    });
    assert.equal(child.registry, 'v3');
    assert.equal(child.name, 'registryChildThree');
    assert.equal(child.created, true);
    assert.equal(child.replaced, false);
    assert.ok(H.tools.registryChildThree);

    const invocation = await H.executeTool('registryChildThree', { payload: 'child-v3' });
    assert.deepEqual(invocation, { ok: true, payload: 'child-v3' });

    const sources = H.toolSources();
    assert.ok(sources.some((source) => source.name === 'toolRegistry' && source.sourcePath === REGISTRY_V3_PATH));
    assert.ok(sources.some((source) => source.name === 'registryChild'));
    assert.ok(sources.some((source) => source.name === 'registryChildTwo'));
    assert.ok(sources.some((source) => source.name === 'registryChildThree'));

    return {
        registry: ['tools/runtime/toolRegistry.tool.ts', REGISTRY_V2_PATH, REGISTRY_V3_PATH],
        children: ['registryChild', 'registryChildTwo', 'registryChildThree']
    };
});

// ---------------------------------------------------------------------------
// Final invariants across the whole scenario
// ---------------------------------------------------------------------------

await check('all tool contexts saw one strict-identical harness and intact state', () => {
    const probeCaptures = captures.filter((entry) => entry.kind === 'probe');
    const modelCaptures = captures.filter((entry) => entry.kind === 'model-probe');

    assert.equal(probeCaptures.length, 5);
    assert.equal(modelCaptures.length, 1);
    assert.deepEqual(
        probeCaptures.map((entry) => entry.revision),
        [1, 1, 2, 3, 3]
    );
    assert.deepEqual(
        probeCaptures.map((entry) => entry.helper),
        ['helper-v1', 'helper-v1', 'helper-v2', 'helper-v3', 'helper-v3']
    );

    for (const entry of [...probeCaptures, ...modelCaptures]) {
        assert.equal(entry.harness, H, 'a tool received a different harness reference');
        assert.equal(entry.agent, writer, 'a tool received a different primary agent');
        assert.equal(entry.agents, H.agents, 'a tool received a different agents record');
    }

    assert.equal(H.agent, writer);
    assert.equal(H.agents.writer, writer);
    assert.deepEqual(H.memory.get('probe-runs'), [
        'host-v1',
        'host-v2',
        'host-v3',
        'host-v4',
        'after-failures'
    ]);
    assert.deepEqual(
        writer.messages.map((message) => message.role),
        ['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant']
    );

    const probeSource = H.toolSource('probe');
    assert.equal(probeSource.sourcePath, PROBE_PATH);
    assert.match(probeSource.dependencies[0].text, /helper-v3/);
    assert.equal(H.toolSource('probe').revision, probeV3Revision);
    assert.equal(new Set([probeV1Revision, probeV2Revision, probeV3Revision]).size, 3);

    return {
        captures: probeCaptures.length + modelCaptures.length,
        harness: 'strict-identical',
        memory: H.memory.get('probe-runs')
    };
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (!keep) rmSync(work, { recursive: true, force: true });

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
    fail(`${failed.length} check(s) failed: ${failed.map((result) => result.name).join(', ')}`);
}

console.log(`package tools: ${results.length} check(s) OK`);

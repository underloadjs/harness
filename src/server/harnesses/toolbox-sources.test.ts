// Production startup must COMPILE shipped tools from source (T14/F1).
//
// F1 found that `createToolboxHarness` passed constructed `Tool` definitions
// (lazy preset proxies + app objects) through `configuration.tools`, so startup
// took the non-compiling `prepareDefinition` branch and `H.toolSource(...)` was
// undefined for shipped tools. These tests pin the corrected production path:
//
//   - the shared toolbox is supplied as concrete `SHARED_TOOL_SOURCES` paths;
//   - a preset built through `createToolboxHarness` exposes real module revisions
//     for both a package tool (read) and an app tool (timeNow);
//   - the runtime replacement path compiles and publishes a new revision for the
//     same name;
//   - host `extraTools` definitions still override sources LAST.
//
// Every assertion is exact; no provider network call is made (constructing a
// harness only builds transports).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agent, harness, tool } from '../../harness';
import type { HarnessProgress } from '../../harness';
import { discoverToolMetadata } from '../../core';
import {
    SHARED_APP_TOOL_FOLDER,
    SHARED_APP_TOOL_NAMES,
    SHARED_APP_TOOL_SOURCES,
    SHARED_TOOL_NAMES,
    SHARED_TOOL_SOURCES,
    SHARED_TOOLS,
    agentsFromProfiles,
    createToolboxHarness
} from './toolbox';
import { APP_TOOL_FOLDERS, appToolSourcesFrom, scanAppToolDescriptors } from './tools';
import { createHarnessRegistry, findPreset } from './index';
import { FLAKY_FIXTURE, PRODUCTION_WITH_FIXTURES, SCRIPTED_FIXTURE } from './fixture-presets.test-support';

const SETTINGS = {
    baseURL: 'http://provider.test/v1',
    apiKey: 'server-secret',
    model: 'test-model'
};

const progress: HarnessProgress = async () => undefined;

const stubNoSearchKeys = (): void => {
    vi.stubEnv('EXA_API_KEY', '');
    vi.stubEnv('TAVILY_API_KEY', '');
};

// POSIX form of an absolute folder path, matching how folder discovery reports
// descriptor source paths.
const posix = (value: string): string => value.split(path.sep).join('/');

// A scripted transport that never emits anything: a library harness is only
// constructed here, never run.
const scriptedNoop = () =>
    (async function* stream() {
        yield { type: 'done' as const, stopReason: 'stop' as const, toolCalls: [] };
    })();

afterEach(() => {
    vi.unstubAllEnvs();
});

// The exact shipped source map: package presets then app tools (T25: the app half
// is discovered from `src/server/tools/shared`, so its paths are the new ones).
const EXPECTED_SOURCE_PATHS = {
    syntax: 'tools/syntax/syntax.tool.ts',
    read: 'tools/files/read.tool.ts',
    write: 'tools/files/write.tool.ts',
    edit: 'tools/files/edit.tool.ts',
    files: 'tools/files/files.tool.ts',
    glob: 'tools/files/glob.tool.ts',
    grep: 'tools/files/grep.tool.ts',
    shell: 'tools/command/shell.tool.ts',
    gitDiff: 'tools/command/gitDiff.tool.ts',
    // R3/R4: the byte-retrieval preset ships as an editable entry like the rest.
    download: 'tools/webdownload/download.tool.ts',
    timeNow: 'server/tools/shared/timeNow.tool.ts',
    textCount: 'server/tools/shared/textCount.tool.ts',
    diceRoll: 'server/tools/shared/diceRoll.tool.ts',
    noteSearch: 'server/tools/shared/noteSearch.tool.ts',
    textSummarize: 'server/tools/shared/textSummarize.tool.ts'
};

describe('production toolbox source compilation', () => {
    it('covers every advertised shared tool with one concrete source path', () => {
        expect(Object.keys(SHARED_TOOL_SOURCES)).toEqual([...SHARED_TOOL_NAMES]);
        expect(SHARED_TOOL_SOURCES).toEqual(EXPECTED_SOURCE_PATHS);
    });

    it('creates a preset whose shipped tools have real compiled revisions', () => {
        stubNoSearchKeys();

        const preset = findPreset('instruct');
        if (preset === undefined) throw new Error('missing instruct preset');

        // Production path: preset factory -> createToolboxHarness -> harness()
        // -> toolSources compilation. No provider turn is run.
        const harness = preset.create(SETTINGS, progress);

        const read = harness.toolSource('read');
        expect(read).toMatchObject({
            name: 'read',
            sourcePath: 'tools/files/read.tool.ts',
            format: 'module',
            dependencies: [],
            checks: ['transpile:syntax', 'load:module', 'contract:tool', 'schema:json']
        });
        expect(read?.revision).toMatch(/^[0-9a-f]{16}$/);
        expect(read?.revision).not.toBe('definition');

        const timeNow = harness.toolSource('timeNow');
        expect(timeNow).toMatchObject({
            name: 'timeNow',
            sourcePath: 'server/tools/shared/timeNow.tool.ts',
            format: 'module',
            dependencies: [],
            checks: ['transpile:syntax', 'load:module', 'contract:tool', 'schema:json']
        });
        expect(timeNow?.revision).toMatch(/^[0-9a-f]{16}$/);
        expect(timeNow?.revision).not.toBe('definition');

        // The advertised shared set is exactly the compiled source set (plus any
        // environment tool this host configured, which is keyless here).
        for (const name of SHARED_TOOL_NAMES) {
            expect(harness.toolSource(name)).toBeDefined();
        }
    });

    it('compiles and publishes a runtime replacement for a source-backed tool', async () => {
        stubNoSearchKeys();

        const harness = createToolboxHarness(
            {
                agents: agentsFromProfiles(['instruct'], SETTINGS),
                primary: 'instruct'
            },
            SETTINGS,
            progress
        );

        const previous = harness.toolSource('timeNow')?.revision;
        expect(previous).toMatch(/^[0-9a-f]{16}$/);

        const moduleText = `
export const metadata = {
    name: 'timeNow',
    description: 'Replacement clock used by the source-compilation test.',
    tags: ['time', 'replacement'],
    parameters: { type: 'object', properties: {}, additionalProperties: false }
};
export const execute = async () => ({ replaced: true });
`;

        const registered = await harness.registerTool({ name: 'timeNow', moduleText });

        expect(registered).toMatchObject({
            name: 'timeNow',
            created: false,
            replaced: true,
            previousRevision: previous,
            checks: ['transpile:syntax', 'load:module', 'contract:tool', 'schema:json']
        });
        expect(registered.revision).toMatch(/^[0-9a-f]{16}$/);
        expect(registered.revision).not.toBe(previous);
        expect(harness.toolSource('timeNow')).toMatchObject({
            name: 'timeNow',
            moduleText,
            format: 'module'
        });
        expect(await harness.executeTool('timeNow', {})).toEqual({ replaced: true });
    });

    it('registers the flaky fixture extra tool as a definition, with no source record', () => {
        stubNoSearchKeys();

        // The `flaky` PRESET and its `src/server/tools/examples` folder are deleted, so
        // `testFlaky` is no longer a scanned SOURCE entry — the test fixture supplies it as
        // a constructed Tool through `createToolboxHarness({ extraTools })`. That is the
        // other documented registration path: a definition is registered last and wins
        // over a source of the same name, but it has no editable file, so it gets no
        // content-addressed `toolSource` revision. Asserting the ABSENCE is what keeps that
        // distinction honest instead of quietly claiming a source-backed revision.
        const harness = FLAKY_FIXTURE.create(SETTINGS, progress);

        expect(harness.tools.testFlaky).toBeDefined();
        expect(harness.toolSource('testFlaky')).toBeUndefined();

        // The shared toolbox next to it is still compiled from its editable entries.
        expect(harness.toolSource('timeNow')).toMatchObject({
            sourcePath: 'server/tools/shared/timeNow.tool.ts',
            format: 'module'
        });
    });

    it('drops the example tool when a registry rebuilds the flaky template', () => {
        stubNoSearchKeys();

        // The fixture is injected, so the registry that rebuilds its template is built
        // with the templates named explicitly.
        const registry = createHarnessRegistry(PRODUCTION_WITH_FIXTURES);
        const rebuilt = registry.update('flaky', { primary: 'workspace' });
        const harness = rebuilt.create(SETTINGS, progress);

        // The rebuild goes through the toolbox factory (that is what the template selects)
        // and attaches no example source, because this build ships none. The card's declared
        // tool list is rewritten to match — see the `downgradedFlaky` branch in ./registry.ts.
        expect(rebuilt.tools).toEqual([...SHARED_TOOL_NAMES]);
        expect(harness.tools.testFlaky).toBeUndefined();
        expect(harness.toolSource('testFlaky')).toBeUndefined();
        expect(harness.toolSource('timeNow')).toMatchObject({
            sourcePath: 'server/tools/shared/timeNow.tool.ts'
        });
    });

    it('compiles the scripted fixture timeNow from its editable source entry', () => {
        stubNoSearchKeys();

        // The scripted fixture is not in `findPreset`'s catalogue; it is injected, so the
        // object is used directly.
        const harness = SCRIPTED_FIXTURE.create(SETTINGS, progress);

        // The fixture keeps its one-tool SET, but the tool is a real compiled
        // revision rather than a prebuilt definition passed through `tools`.
        expect(harness.toolSource('timeNow')).toMatchObject({
            name: 'timeNow',
            revision: expect.stringMatching(/^[0-9a-f]{16}$/),
            sourcePath: 'server/tools/shared/timeNow.tool.ts',
            dependencies: [],
            format: 'module',
            checks: ['transpile:syntax', 'load:module', 'contract:tool', 'schema:json']
        });
        expect(harness.toolSource('read')).toBeUndefined();
    });

    it('lets host extraTools definitions override a source-backed name last', async () => {
        stubNoSearchKeys();

        const hostTime = tool<Record<string, never>, { host: true }>({
            description: 'Host-provided time override.',
            tags: ['host', 'time'],
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            execute: () => ({ host: true })
        });

        const harness = createToolboxHarness(
            {
                agents: agentsFromProfiles(['instruct'], SETTINGS),
                primary: 'instruct',
                extraTools: { timeNow: hostTime }
            },
            SETTINGS,
            progress
        );

        // The definition override is committed after the source map, so the host
        // implementation wins and the source revision for that name is dropped.
        expect(await harness.executeTool('timeNow', {})).toEqual({ host: true });
        expect(harness.toolSource('timeNow')).toBeUndefined();
        expect(harness.toolSource('read')).toBeDefined();
    });
});

// T25: the app toolbox is DERIVED from the server tools folders, and those folders
// are opt-in. These pin both halves of that contract.
describe('server tools folder derivation (T25)', () => {
    it('derives the shared source map from the folder scan, not from a hand list', () => {
        // The scan is the authority: the declared map must equal the discovered
        // entries of `src/server/tools/shared`, in registration order.
        const scanned = discoverToolMetadata({
            folders: [SHARED_APP_TOOL_FOLDER]
        }).filter((descriptor) => descriptor.origin === 'folder');

        expect(
            scanned
                .filter((descriptor) => descriptor.sourcePath.startsWith(posix(SHARED_APP_TOOL_FOLDER) + '/'))
                .map((descriptor) => [descriptor.name, descriptor.metadata.description])
        ).toEqual(
            SHARED_TOOL_NAMES.filter((name) => SHARED_APP_TOOL_NAMES.includes(name)).map((name) => [
                name,
                SHARED_TOOLS[name].description
            ])
        );

        // Every app entry lives under the dedicated server folder, and none of them
        // is under the package's default tools root — that separation is what keeps
        // them out of a library harness.
        for (const sourcePath of Object.values(SHARED_APP_TOOL_SOURCES)) {
            expect(sourcePath).toMatch(/^server\/tools\/shared\/[A-Za-z]+\.tool\.ts$/);
        }
    });

    it('ships one app tool folder and keeps the app tools out of a library harness', () => {
        stubNoSearchKeys();

        // There used to be a second, opt-in folder (`examples`, holding `testFlaky`) whose
        // whole job was to be excluded from the shared set by not being `shared`. The
        // example preset is deleted, so the folder is gone and the shared folder IS the
        // app catalogue — no name filter, and no second map to keep in step.
        expect(APP_TOOL_FOLDERS).toEqual([SHARED_APP_TOOL_FOLDER]);
        expect(SHARED_APP_TOOL_NAMES).toEqual([
            'timeNow',
            'textCount',
            'diceRoll',
            'noteSearch',
            'textSummarize'
        ]);
        expect(SHARED_TOOL_NAMES).not.toContain('testFlaky');

        // A LIBRARY harness (no server folders configured) never sees them: the app
        // entries live outside the package's default `src/tools` root.
        const library = harness({
            agents: { writer: agent({ model: 'offline/scripted', stream: scriptedNoop() }) }
        });

        expect(library.tools.timeNow).toBeUndefined();
        expect(library.tools.testFlaky).toBeUndefined();
        expect(library.toolSource('timeNow')).toBeUndefined();
        expect(library.tools.read).toBeDefined();

        // `testFlaky` is not catalogued anywhere in this build: it exists only as the
        // fixture's constructed definition, so a library harness cannot reach it even by
        // name. (The fixture's own harness registers it — pinned above.)
    });

    it('derives a catalogue for a folder that gained a brand-new entry, with no map edit', async () => {
        // A throwaway folder under repo Temp/ (never the shipped source tree, so no
        // other test can observe the fixture). The entries use the `metadata` +
        // `execute` export shape, which the compiler supports without any import, so
        // the fixture is independent of this package's directory depth.
        const root = fileURLToPath(new URL('../../../../../../Temp/t25-folder-fixture/', import.meta.url));
        await rm(root, { recursive: true, force: true });
        await mkdir(root, { recursive: true });

        // Two entries written in the OPPOSITE alphabetical order to their declared
        // `registration.order`, so the test proves order comes from the metadata and
        // not from file names.
        const entry = (name: string, order: number, marker: string): string => `export const metadata = {
    name: '${name}',
    description: 'Fixture entry ${marker}.',
    tags: ['fixture', 'inventory-free'],
    parameters: { type: 'object', properties: {}, additionalProperties: false }
};

export const registration = { group: 'external', activation: 'always', order: ${order}, listed: true };

export const execute = async () => ({ marker: '${marker}' });
`;

        try {
            await writeFile(path.join(root, 'zzzFirst.tool.ts'), entry('zzzFirst', 1010, 'first'), 'utf8');
            await writeFile(path.join(root, 'aaaSecond.tool.ts'), entry('aaaSecond', 1020, 'second'), 'utf8');

            const descriptors = scanAppToolDescriptors([root]);
            const sources = appToolSourcesFrom(descriptors, root);

            // Both entries are discovered, ordered by `registration.order` (zzzFirst
            // 1010 before aaaSecond 1020), with no hand-maintained inventory involved.
            expect(descriptors.map((descriptor) => descriptor.name)).toEqual(['zzzFirst', 'aaaSecond']);
            expect(Object.keys(sources)).toEqual(['zzzFirst', 'aaaSecond']);

            // The new entries are compiled from their own discovered paths and run.
            const live = createToolboxHarness(
                {
                    agents: agentsFromProfiles(['instruct'], SETTINGS),
                    primary: 'instruct',
                    extraToolSources: sources
                },
                SETTINGS,
                progress
            );

            expect(live.toolSource('aaaSecond')).toMatchObject({
                name: 'aaaSecond',
                format: 'module',
                dependencies: [],
                checks: ['transpile:syntax', 'load:module', 'contract:tool', 'schema:json']
            });
            expect(await live.executeTool('zzzFirst', {})).toEqual({ marker: 'first' });
            expect(await live.executeTool('aaaSecond', {})).toEqual({ marker: 'second' });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

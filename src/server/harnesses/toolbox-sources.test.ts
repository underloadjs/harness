// Production startup must COMPILE shipped tools from source (T14/F1).
//
// F1 found that `createToolboxHarness` passed constructed `Tool` definitions
// (lazy preset proxies + app objects) through `configuration.tools`, so startup
// took the non-compiling `prepareDefinition` branch and `H.toolSource(...)` was
// undefined for shipped tools. These tests pin the corrected production path:
//
//   - the shared toolbox is supplied as concrete `SHARED_TOOL_SOURCES` paths;
//   - a preset built through `createToolboxHarness` exposes real module revisions
//     for both a package tool (fileRead) and an app tool (timeNow);
//   - the runtime replacement path compiles and publishes a new revision for the
//     same name;
//   - host `extraTools` definitions still override sources LAST.
//
// Every assertion is exact; no provider network call is made (constructing a
// harness only builds transports).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { tool } from '../../harness';
import type { HarnessProgress } from '../../harness';
import {
    SHARED_TOOL_NAMES,
    SHARED_TOOL_SOURCES,
    agentsFromProfiles,
    createToolboxHarness
} from './toolbox';
import { createHarnessRegistry, findPreset } from './index';

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

afterEach(() => {
    vi.unstubAllEnvs();
});

// The exact shipped source map: package presets then app tools.
const EXPECTED_SOURCE_PATHS = {
    syntaxCheck: 'tools/syntax/syntaxCheck.ts',
    fileRead: 'tools/files/fileRead.ts',
    fileWrite: 'tools/files/fileWrite.ts',
    fileEdit: 'tools/files/fileEdit.ts',
    fileList: 'tools/files/fileList.ts',
    fileGlob: 'tools/files/fileGlob.ts',
    commandRun: 'tools/command/commandRun.ts',
    gitDiff: 'tools/command/gitDiff.ts',
    timeNow: 'server/harnesses/tool-sources/timeNow.ts',
    textCount: 'server/harnesses/tool-sources/textCount.ts',
    diceRoll: 'server/harnesses/tool-sources/diceRoll.ts',
    noteSearch: 'server/harnesses/tool-sources/noteSearch.ts',
    textSummarize: 'server/harnesses/tool-sources/textSummarize.ts'
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

        const fileRead = harness.toolSource('fileRead');
        expect(fileRead).toMatchObject({
            name: 'fileRead',
            sourcePath: 'tools/files/fileRead.ts',
            format: 'module',
            dependencies: [],
            checks: ['transpile:syntax', 'load:module', 'contract:tool', 'schema:json']
        });
        expect(fileRead?.revision).toMatch(/^[0-9a-f]{16}$/);
        expect(fileRead?.revision).not.toBe('definition');

        const timeNow = harness.toolSource('timeNow');
        expect(timeNow).toMatchObject({
            name: 'timeNow',
            sourcePath: 'server/harnesses/tool-sources/timeNow.ts',
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

    it('compiles the flaky example extra tool from its editable source entry', () => {
        stubNoSearchKeys();

        const preset = findPreset('flaky');
        if (preset === undefined) throw new Error('missing flaky preset');

        const harness = preset.create(SETTINGS, progress);

        // Shipped exception in the tool SET, not in the registration path.
        expect(harness.toolSource('testFlaky')).toMatchObject({
            name: 'testFlaky',
            revision: expect.stringMatching(/^[0-9a-f]{16}$/),
            sourcePath: 'server/harnesses/tool-sources/testFlaky.ts',
            dependencies: [],
            format: 'module',
            checks: ['transpile:syntax', 'load:module', 'contract:tool', 'schema:json']
        });
        // The shared toolbox is still compiled alongside it.
        expect(harness.toolSource('timeNow')).toMatchObject({
            sourcePath: 'server/harnesses/tool-sources/timeNow.ts',
            format: 'module'
        });
    });

    it('keeps the flaky extra source through a registry template rebuild', () => {
        stubNoSearchKeys();

        const registry = createHarnessRegistry();
        const rebuilt = registry.update('flaky', { primary: 'workspace' });
        const harness = rebuilt.create(SETTINGS, progress);

        expect(harness.toolSource('testFlaky')).toMatchObject({
            name: 'testFlaky',
            revision: expect.stringMatching(/^[0-9a-f]{16}$/),
            sourcePath: 'server/harnesses/tool-sources/testFlaky.ts',
            dependencies: [],
            format: 'module',
            checks: ['transpile:syntax', 'load:module', 'contract:tool', 'schema:json']
        });
    });

    it('compiles the scripted demo timeNow from its editable source entry', () => {
        stubNoSearchKeys();

        const preset = findPreset('demo');
        if (preset === undefined) throw new Error('missing demo preset');

        const harness = preset.create(SETTINGS, progress);

        // The fixture keeps its one-tool SET, but the tool is a real compiled
        // revision rather than a prebuilt definition passed through `tools`.
        expect(harness.toolSource('timeNow')).toMatchObject({
            name: 'timeNow',
            revision: expect.stringMatching(/^[0-9a-f]{16}$/),
            sourcePath: 'server/harnesses/tool-sources/timeNow.ts',
            dependencies: [],
            format: 'module',
            checks: ['transpile:syntax', 'load:module', 'contract:tool', 'schema:json']
        });
        expect(harness.toolSource('fileRead')).toBeUndefined();
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
        expect(harness.toolSource('fileRead')).toBeDefined();
    });
});

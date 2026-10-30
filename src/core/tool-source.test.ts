// Focused compiler regressions for the self-modifying tool kernel.
//
// These tests pin the compiler's production identity rules independently of the
// harness integration suite:
//   - live framework imports never capture harness source or create a second
//     tool()/HarnessError identity;
//   - the static dependency graph is captured before load/revision hashing, so a
//     dynamic literal import is part of the revision even before it executes;
//   - a supplied captured revision never re-reads changed files on disk;
//   - non-literal local resolution is rejected with an actionable diagnostic;
//   - the installed metadata/schema and live preset catalogue are part of the
//     complete revision identity.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareToolCandidate } from './tool-source';
import { prepareToolCandidate as prepareBrowserCandidate } from './tool-source-browser';
import type { ToolSourceRecord } from './tool-source';

// Scratch lives under the repository-root Temp/ directory as required by the
// root AGENTS.md; the package tests run with cwd = package root.
const SCRATCH = fileURLToPath(new URL('../../../../../Temp/tool-source-compiler/', import.meta.url));
const CORE_ENTRY = fileURLToPath(new URL('./index.ts', import.meta.url));
const CATALOGUE_ENTRY = fileURLToPath(new URL('../tools/catalogue.ts', import.meta.url));

const sourceFile = (name: string): string => join(SCRATCH, name);

const write = (name: string, text: string): string => {
    const target = sourceFile(name);
    writeFileSync(target, text, 'utf8');
    return target;
};

// A module that imports its helper only inside execute: the static AST walk must
// capture it anyway.
const dynamicHelperEntry = (): string => `
import { tool } from ${JSON.stringify(CORE_ENTRY)};
import type { ToolContext } from ${JSON.stringify(fileURLToPath(new URL('../types/index.ts', import.meta.url)))};

export const probe = tool({
    name: 'probe',
    description: 'Dynamic helper probe.',
    tags: ['test', 'compiler'],
    parameters: { type: 'object', properties: {} },
    execute: async (_context: ToolContext) => {
        const helper = await import('./helper');
        return helper.helperValue;
    }
});
`;

const helperSource = (value: string): string =>
    `export const helperValue = ${JSON.stringify(value)};\n`;

describe('tool source compiler', () => {
    beforeEach(() => {
        rmSync(SCRATCH, { recursive: true, force: true });
        mkdirSync(SCRATCH, { recursive: true });
    });

    afterEach(() => {
        rmSync(SCRATCH, { recursive: true, force: true });
    });

    it('imports the live core namespace without capturing framework source', () => {
        const prepared = prepareToolCandidate({
            name: 'liveCoreProbe',
            moduleText: `
import { tool } from ${JSON.stringify(CORE_ENTRY)};

export const liveCoreProbe = tool({
    name: 'liveCoreProbe',
    description: 'Uses the live tool factory.',
    tags: ['test', 'compiler'],
    parameters: { type: 'object', properties: {} },
    execute: () => 'live-core'
});
`
        });

        expect(prepared.record.format).toBe('module');
        expect(prepared.record.dependencies).toEqual([]);
        expect(prepared.record.moduleText).toContain('liveCoreProbe');
        expect(prepared.record.checks).toEqual([
            'transpile:syntax',
            'load:module',
            'contract:tool',
            'schema:json'
        ]);
        expect(prepared.tool.name).toBe('liveCoreProbe');
    });

    it('captures a literal dynamic local import before load and hashing', async () => {
        const entryPath = write('probe.ts', dynamicHelperEntry());
        write('helper.ts', helperSource('captured-v1'));

        const prepared = prepareToolCandidate({ name: 'probe', sourcePath: entryPath });

        // The helper is reachable only through import() inside execute. It must
        // still be part of the captured revision.
        expect(prepared.record.dependencies).toHaveLength(1);
        expect(prepared.record.dependencies[0].path).toBe(
            sourceFile('helper.ts').split('\\').join('/')
        );
        expect(prepared.record.dependencies[0].text).toBe(helperSource('captured-v1'));

        const result = await prepared.tool.execute({ parameters: {} } as never);
        expect(result).toBe('captured-v1');
    });

    it('uses captured bytes instead of changed disk for a supplied revision', async () => {
        const entryPath = write('probe.ts', dynamicHelperEntry());
        write('helper.ts', helperSource('captured-v1'));

        const first = prepareToolCandidate({ name: 'probe', sourcePath: entryPath });
        const captured: ToolSourceRecord = first.record;

        // A later call with the captured revision must compile the captured helper
        // even though the file on disk now says something else.
        write('helper.ts', helperSource('disk-v2'));

        const restored = prepareToolCandidate({
            name: 'probe',
            sourcePath: captured.sourcePath,
            moduleText: captured.moduleText,
            dependencies: captured.dependencies
        });

        expect(restored.record.dependencies).toEqual(captured.dependencies);
        expect(restored.record.dependencies[0].text).toBe(helperSource('captured-v1'));
        expect(restored.revision).toBe(first.revision);

        // A fresh disk registration DOES see the edit, proving the previous case
        // was not just a cached module graph.
        const fresh = prepareToolCandidate({ name: 'probe', sourcePath: entryPath });
        expect(fresh.record.dependencies[0].text).toBe(helperSource('disk-v2'));
        expect(fresh.revision).not.toBe(first.revision);

        // The captured revision also survives deleted files: sourcePath is an
        // identity label for relative resolution, not a requirement to exist.
        rmSync(SCRATCH, { recursive: true, force: true });
        const afterDelete = prepareToolCandidate({
            name: 'probe',
            sourcePath: captured.sourcePath,
            moduleText: captured.moduleText,
            dependencies: captured.dependencies
        });
        expect(afterDelete.record.sourcePath).toBe(captured.sourcePath);
        expect(afterDelete.record.dependencies).toEqual(captured.dependencies);
        expect(afterDelete.revision).toBe(first.revision);
        await expect(afterDelete.tool.execute({ parameters: {} } as never)).resolves.toBe(
            'captured-v1'
        );
    });

    it('rejects non-literal import()/require() local resolution with a diagnostic', () => {
        expect(() =>
            prepareToolCandidate({
                name: 'computedImport',
                moduleText: `
export const metadata = { name: 'computedImport', description: 'x', tags: ['x'] };
const helper = './helper';
export const execute = () => import(helper);
`
            })
        ).toThrow(/non-literal import\(\) specifier/);

        expect(() =>
            prepareToolCandidate({
                name: 'computedRequire',
                moduleText: `
export const metadata = { name: 'computedRequire', description: 'x', tags: ['x'] };
const helper = './helper';
export const execute = () => require(helper);
`
            })
        ).toThrow(/non-literal require\(\) specifier/);
    });

    it('rejects a captured revision that omits a referenced local helper', () => {
        expect(() =>
            prepareToolCandidate({
                name: 'missingHelper',
                moduleText: `
import { helperValue } from './helper';
export const metadata = { name: 'missingHelper', description: 'x', tags: ['x'] };
export const execute = () => helperValue;
`,
                dependencies: []
            })
        ).toThrow(/captured revision does not include that local module/);
    });

    it('includes installed metadata/schema identity in the revision', () => {
        const moduleText = `
export const metadata = { name: 'revisionProbe', description: 'base', tags: ['x'] };
export const execute = () => 'base';
`;

        const base = prepareToolCandidate({ name: 'revisionProbe', moduleText });
        const retagged = prepareToolCandidate({
            name: 'revisionProbe',
            moduleText,
            description: 'override'
        });

        expect(retagged.revision).not.toBe(base.revision);
        expect(retagged.record.revision).toBe(retagged.revision);
        expect(retagged.tool.description).toBe('override');
    });

    it('deep-clones a supplied schema before install and revision hashing', () => {
        // The caller keeps ownership of this object. Mutating it after prepare must
        // not alter the installed schema or describe a different revision.
        const parameters = {
            type: 'object',
            properties: { value: { type: 'string', description: 'original' } },
            required: ['value']
        };
        const moduleText = `
export const metadata = { name: 'schemaOwnership', description: 'schema owner', tags: ['test'] };
export const execute = () => 'ok';
`;
        const prepared = prepareToolCandidate({
            name: 'schemaOwnership',
            moduleText,
            parameters
        });
        const revision = prepared.revision;

        parameters.properties.value.description = 'mutated';
        parameters.required.push('mutated');

        expect(prepared.tool.parameters).toEqual({
            type: 'object',
            properties: { value: { type: 'string', description: 'original' } },
            required: ['value']
        });
        expect(prepared.revision).toBe(revision);
        expect(prepared.record.revision).toBe(revision);
    });

    it('includes legacy body metadata and schema identity in the revision', () => {
        const source = "return 'same-body';";
        const base = prepareToolCandidate({
            name: 'legacyRevision',
            description: 'base',
            tags: ['test'],
            source
        });
        const changedDescription = prepareToolCandidate({
            name: 'legacyRevision',
            description: 'changed',
            tags: ['test'],
            source
        });
        const changedSchema = prepareToolCandidate({
            name: 'legacyRevision',
            description: 'base',
            tags: ['test'],
            parameters: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value']
            },
            source
        });

        expect(changedDescription.revision).not.toBe(base.revision);
        expect(changedSchema.revision).not.toBe(base.revision);
        expect(changedDescription.record.revision).toBe(changedDescription.revision);
        expect(changedSchema.record.revision).toBe(changedSchema.revision);
    });

    it('requires moduleText for non-empty captured dependencies but allows path-only capture', () => {
        const entryPath = write('capturedEntry.ts', dynamicHelperEntry());
        write('helper.ts', helperSource('path-only'));

        expect(() =>
            prepareToolCandidate({
                name: 'capturedDependencies',
                sourcePath: entryPath,
                dependencies: [
                    {
                        path: sourceFile('helper.ts'),
                        text: helperSource('supplied')
                    }
                ]
            })
        ).toThrow(/captured dependencies without moduleText/);

        // An empty array captures nothing: this stays a normal disk path capture.
        const pathOnly = prepareToolCandidate({
            name: 'probe',
            sourcePath: entryPath,
            dependencies: []
        });
        expect(pathOnly.record.dependencies).toEqual([
            {
                path: sourceFile('helper.ts').split('\\').join('/'),
                text: helperSource('path-only')
            }
        ]);
    });

    it('resolves absolute supplied dependencies for inline and relative importers', async () => {
        const helperText = helperSource('aliased-value');
        const helperPath = write('helper.ts', helperText);
        const inlineText = `
import { helperValue } from './helper';

export const metadata = { name: 'absoluteAliasInline', description: 'aliases', tags: ['test'] };
export const execute = () => helperValue;
`;
        const inline = prepareToolCandidate({
            name: 'absoluteAliasInline',
            moduleText: inlineText,
            dependencies: [{ path: helperPath, text: helperText }]
        });

        // Labels stay inspectable exactly as supplied (posix-normalised).
        expect(inline.record.dependencies).toEqual([
            { path: helperPath.split('\\').join('/'), text: helperText }
        ]);
        await expect(inline.tool.execute({ parameters: {} } as never)).resolves.toBe(
            'aliased-value'
        );

        const relativeText = `
import { helperValue } from './helper';

export const metadata = { name: 'absoluteAliasRelative', description: 'aliases', tags: ['test'] };
export const execute = () => helperValue;
`;
        const relative = prepareToolCandidate({
            name: 'absoluteAliasRelative',
            sourcePath: 'nested/absoluteAliasRelative.ts',
            moduleText: relativeText,
            dependencies: [{ path: helperPath, text: helperText }]
        });

        await expect(relative.tool.execute({ parameters: {} } as never)).resolves.toBe(
            'aliased-value'
        );
    });

    it('does not guess between ambiguous dependency basenames', () => {
        expect(() =>
            prepareToolCandidate({
                name: 'ambiguousAlias',
                moduleText: `
import { helperValue } from './helper';

export const metadata = { name: 'ambiguousAlias', description: 'ambiguous', tags: ['test'] };
export const execute = () => helperValue;
`,
                dependencies: [
                    {
                        path: join(SCRATCH, 'first', 'helper.ts'),
                        text: helperSource('first')
                    },
                    {
                        path: join(SCRATCH, 'second', 'helper.ts'),
                        text: helperSource('second')
                    }
                ]
            })
        ).toThrow(/captured revision does not include that local module/);
    });

    it('rejects a Tool-like export missing tags with an actionable error', () => {
        expect(() =>
            prepareToolCandidate({
                name: 'missingTags',
                moduleText: `
export function missingTags() {}
missingTags.description = 'missing tags';
missingTags.execute = async () => 'x';
export default missingTags;
`
            })
        ).toThrow('Tool "missingTags" requires at least one tag.');
    });

    it('validates visibility and normalizes Tool-like tags', () => {
        expect(() =>
            prepareToolCandidate({
                name: 'invalidVisibility',
                moduleText: `
export function invalidVisibility() {}
invalidVisibility.description = 'invalid visibility';
invalidVisibility.tags = ['Test', ' test ', ''];
invalidVisibility.visibility = 'internal';
invalidVisibility.execute = async () => 'x';
export default invalidVisibility;
`
            })
        ).toThrow(
            'Tool "invalidVisibility" visibility must be one of: core, searchable. Received "internal".'
        );

        // The metadata + execute export path must not silently downgrade an
        // invalid visibility to the searchable default.
        expect(() =>
            prepareToolCandidate({
                name: 'metadataVisibility',
                moduleText: `
export const metadata = {
    name: 'metadataVisibility',
    description: 'invalid metadata visibility',
    tags: ['test'],
    visibility: 'internal'
};
export const execute = async () => 'x';
`
            })
        ).toThrow(
            'Tool "metadataVisibility" visibility must be one of: core, searchable. Received "internal".'
        );

        const prepared = prepareToolCandidate({
            name: 'normalizedTags',
            moduleText: `
export function normalizedTags() {}
normalizedTags.description = 'normalized tags';
normalizedTags.tags = [' Test ', 'test', '', 'TEST'];
normalizedTags.visibility = 'searchable';
normalizedTags.execute = async () => 'x';
export default normalizedTags;
`
        });

        expect(prepared.tool.tags).toEqual(['test']);
    });

    it('rejects source registration honestly in the browser compiler stub', () => {
        expect(() =>
            prepareBrowserCandidate({
                name: 'browserTool',
                moduleText: 'export const browserTool = 1;'
            })
        ).toThrow(
            'Tool source compilation is unavailable in the browser build (candidate "browserTool").'
        );
    });

    it('captures live preset catalogue metadata as a deterministic identity', () => {
        const prepared = prepareToolCandidate({
            name: 'catalogueProbe',
            moduleText: `
import { tool } from ${JSON.stringify(CORE_ENTRY)};
import { PRESET_TOOLS } from ${JSON.stringify(CATALOGUE_ENTRY)};

export const catalogueProbe = tool({
    ...PRESET_TOOLS.syntaxCheck,
    name: 'catalogueProbe',
    execute: () => true
});
`
        });

        expect(prepared.record.dependencies).toEqual([]);
        const catalogue = prepared.record.liveDependencies?.find(
            (dependency) => dependency.path === 'tools/catalogue'
        );
        expect(catalogue).toBeDefined();
        expect(catalogue?.revision).toMatch(/^[0-9a-f]{16}$/);
    });
});

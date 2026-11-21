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
//     complete revision identity;
//   - the published read-only compile (`compileToolSourceModule`) reports exactly the
//     checks it ran, pays no evaluation in `evaluate: 'syntax'`, and serves a repeated
//     compile from the process cache without evaluating the module again (issue 0002).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileToolSourceModule, prepareToolSourceRecord, prepareToolCandidate } from './tool-source';
import { prepareToolCandidate as prepareBrowserCandidate } from './tool-source-browser';
import { tool } from './tool';
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
    ...PRESET_TOOLS.syntax,
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

// ---------------------------------------------------------------------------
// Issue 0002 — `compileToolSourceModule`, the published READ-ONLY compile.
//
// Pinned in this file (the kernel's own file, so no harness and therefore no
// registry is involved — the "publishes nothing" half of the same contract lives
// in src/harness.tool-catalogue.test.ts, where a registry exists to be read):
//   - the default mode does the registration path's own work and reports exactly
//     the checks it ran (`load:module` included);
//   - `evaluate: 'syntax'` costs NO evaluation: the module below counts its own
//     evaluations on `globalThis`, the metadata reported is the CANDIDATE's
//     rather than the module's, and the result carries no `definition` key;
//   - a candidate that cannot describe itself in that mode is refused with the
//     three ways out, not with an empty result;
//   - the compile cache serves the same revision without re-evaluating, is keyed
//     on the mode, never caches a failure, and `{ cache: false }` re-evaluates;
//   - a supplied `definition` is returned by identity, and the revision it
//     derives equals `prepareToolSourceRecord`'s for the same bytes.
// ---------------------------------------------------------------------------

// The canonical editable module shape (declarative metadata + execute) plus the
// evaluation probe. Every compile/registration evaluates a FRESH CommonJS graph, so
// `globalThis` is the only observer of "was this module evaluated at all" — exactly
// the fact the `evaluate` switch and the compile cache are defined by.
const compiledEntryText = (value: string): string => `
export const metadata = {
    name: 'compileProbe',
    description: 'Report the probe value.',
    tags: ['test', 'compiler'],
    parameters: { type: 'object', properties: {}, additionalProperties: false }
};

globalThis.__compileProbeEvaluations = (globalThis.__compileProbeEvaluations ?? 0) + 1;

export const execute = () => ${JSON.stringify(value)};
`;

// A candidate whose top-level code runs and throws: in 'load' mode that throw IS the
// validation failure; in 'syntax' mode it must never happen.
const throwingEntryText = (message: string): string => `
export const metadata = {
    name: 'throwingProbe',
    description: 'Throws while loading.',
    tags: ['test', 'compiler'],
    parameters: { type: 'object', properties: {}, additionalProperties: false }
};

globalThis.__compileProbeEvaluations = (globalThis.__compileProbeEvaluations ?? 0) + 1;

throw new Error(${JSON.stringify(message)});

export const execute = () => 'unreachable';
`;

// The probe counter, read as a number (the candidate module writes it).
const evaluations = (): number =>
    (globalThis as { __compileProbeEvaluations?: number }).__compileProbeEvaluations ?? 0;

describe('compileToolSourceModule (issue 0002: compile, validate, publish nothing)', () => {
    beforeEach(() => {
        // Reset the probe so every case starts from a known count and the exact
        // `before + 1` arithmetic below stays meaningful.
        (globalThis as { __compileProbeEvaluations?: number }).__compileProbeEvaluations = 0;
    });

    it('loads the module and reports the registration checks with no registry involved', async () => {
        const compiled = compileToolSourceModule({
            name: 'compileProbe',
            moduleText: compiledEntryText('loaded')
        });

        // The metadata is the MODULE's, because the module was evaluated.
        expect(compiled.name).toBe('compileProbe');
        expect(compiled.description).toBe('Report the probe value.');
        expect(compiled.tags).toEqual(['test', 'compiler']);
        expect(compiled.parameters).toEqual({
            type: 'object',
            properties: {},
            additionalProperties: false
        });
        expect(compiled.visibility).toBe('searchable');
        expect(compiled.checks).toEqual([
            'transpile:syntax',
            'load:module',
            'contract:tool',
            'schema:json'
        ]);
        expect(evaluations()).toBe(1);
        await expect(compiled.definition?.execute({ parameters: {} } as never)).resolves.toBe(
            'loaded'
        );

        // The record is the shape `toolSource()` reports, so a host comparing the two
        // surfaces is comparing like with like.
        expect(compiled.record.name).toBe('compileProbe');
        expect(compiled.record.revision).toBe(compiled.revision);
        expect(compiled.record.format).toBe('module');
        expect(compiled.record.dependencies).toEqual([]);
        expect(compiled.record.checks).toEqual([
            'transpile:syntax',
            'load:module',
            'contract:tool',
            'schema:json'
        ]);
    });

    it('reports the candidate metadata and never loads in syntax mode', () => {
        const compiled = compileToolSourceModule(
            {
                // Every field here DIFFERS from the module's own metadata, so these
                // assertions cannot pass by reading the module.
                name: 'compileProbe',
                description: 'Declared by the caller.',
                tags: ['Test', 'Caller'],
                parameters: { type: 'object', properties: { city: { type: 'string' } } },
                moduleText: compiledEntryText('loaded')
            },
            { evaluate: 'syntax' }
        );

        // Nothing was evaluated, and the result says so by NOT carrying the key.
        expect('definition' in compiled).toBe(false);
        expect(evaluations()).toBe(0);
        expect(compiled.description).toBe('Declared by the caller.');
        expect(compiled.tags).toEqual(['test', 'caller']);
        expect(compiled.parameters).toEqual({
            type: 'object',
            properties: { city: { type: 'string' } }
        });
        expect(compiled.visibility).toBe('searchable');
        expect(compiled.checks).toEqual(['transpile:syntax', 'schema:json']);
        expect(compiled.record.checks).toEqual(['transpile:syntax', 'schema:json']);
    });

    it('omits schema:json and the parameters key when syntax mode has no schema', () => {
        const compiled = compileToolSourceModule(
            { name: 'compileProbe', moduleText: compiledEntryText('loaded') },
            { evaluate: 'syntax' }
        );

        expect(compiled.checks).toEqual(['transpile:syntax']);
        expect('parameters' in compiled).toBe(false);
        expect(compiled.description).toBe('');
        expect(compiled.tags).toEqual([]);
        expect(evaluations()).toBe(0);
    });

    it('refuses a syntax-mode candidate that cannot name itself, naming the three ways out', () => {
        expect(() =>
            compileToolSourceModule({ moduleText: compiledEntryText('loaded') }, { evaluate: 'syntax' })
        ).toThrow(
            'Tool source "<inline-tool-module>" was compiled without loading, so its name cannot be read from the module. Pass `name` on the candidate, supply a `definition`, or use evaluate: "load" to get a validated definition.'
        );
    });

    it('treats a throwing top level as a validation failure, never as an evaluation in syntax mode', () => {
        // 'syntax' never evaluates: an endpoint can answer about untrusted source
        // without paying its side effects.
        const checked = compileToolSourceModule(
            { name: 'throwingProbe', moduleText: throwingEntryText('top-level side effect ran') },
            { evaluate: 'syntax' }
        );
        expect(checked.checks).toEqual(['transpile:syntax']);
        expect(evaluations()).toBe(0);

        // 'load' runs the module, so the candidate's own throw IS the refusal.
        expect(() =>
            compileToolSourceModule({
                name: 'throwingProbe',
                moduleText: throwingEntryText('top-level side effect ran')
            })
        ).toThrow('top-level side effect ran');
    });

    it('serves a repeated compile of the same input without evaluating it again', () => {
        const first = compileToolSourceModule({
            name: 'compileProbe',
            moduleText: compiledEntryText('cached')
        });
        expect(evaluations()).toBe(1);

        const again = compileToolSourceModule({
            name: 'compileProbe',
            moduleText: compiledEntryText('cached')
        });

        // Same revision, and the probe proves the cached module was NOT re-evaluated.
        expect(again.revision).toBe(first.revision);
        expect(again.checks).toEqual(first.checks);
        expect(evaluations()).toBe(1);

        // A compile-produced definition is cloned per call, so a cache hit shares no
        // object one caller could mutate into the next caller's result.
        expect(again.definition).not.toBe(first.definition);
        expect(again.record).toEqual(first.record);

        // `{ cache: false }` re-runs the whole operation.
        const uncached = compileToolSourceModule(
            { name: 'compileProbe', moduleText: compiledEntryText('cached') },
            { cache: false }
        );
        expect(uncached.revision).toBe(first.revision);
        expect(evaluations()).toBe(2);
    });

    it('keys the compile cache on the mode and never caches a failure', () => {
        const candidate = { name: 'compileProbe', moduleText: compiledEntryText('mode') };

        // A syntax answer must not serve the load call: the mode is part of the key.
        const syntax = compileToolSourceModule(candidate, { evaluate: 'syntax' });
        expect(syntax.checks).toEqual(['transpile:syntax']);
        expect(evaluations()).toBe(0);

        const loaded = compileToolSourceModule(candidate);
        expect(loaded.checks).toEqual([
            'transpile:syntax',
            'load:module',
            'contract:tool',
            'schema:json'
        ]);
        expect(evaluations()).toBe(1);

        // A failing candidate is reported again on the next call: a validation
        // endpoint must never serve a stale answer about source that can fail.
        expect(() =>
            compileToolSourceModule({
                name: 'throwingProbe',
                moduleText: throwingEntryText('refused twice')
            })
        ).toThrow('refused twice');
        expect(evaluations()).toBe(2);
        expect(() =>
            compileToolSourceModule({
                name: 'throwingProbe',
                moduleText: throwingEntryText('refused twice')
            })
        ).toThrow('refused twice');
        expect(evaluations()).toBe(3);
    });

    it('reports a syntax error in either mode with the transpile diagnostic', () => {
        const brokenText =
            'export const metadata = { name: "brokenProbe", description: "Does not parse", tags: ["test"], parameters: { type: "object" } };\n\nexport const execute = () => ;\n';

        // The diagnostic is the transpile's own, quoted verbatim: the candidate name
        // is the module label, so the position is readable as line:column of the text
        // the caller passed.
        const diagnostic = 'Tool source could not be transpiled: brokenProbe:3:30: Expression expected.';

        expect(() =>
            compileToolSourceModule({ name: 'brokenProbe', moduleText: brokenText })
        ).toThrow(diagnostic);
        expect(() =>
            compileToolSourceModule(
                { name: 'brokenProbe', moduleText: brokenText },
                { evaluate: 'syntax' }
            )
        ).toThrow(diagnostic);
        expect(evaluations()).toBe(0);
    });

    it('describes a supplied definition by identity and derives the revision from its bytes', () => {
        const definition = tool({
            name: 'compileProbe',
            description: 'A definition the caller already owns.',
            tags: ['test', 'compiler'],
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            execute: () => 'caller-owned'
        });
        const moduleText = compiledEntryText('loaded');

        const compiled = compileToolSourceModule({
            name: 'compileProbe',
            moduleText,
            definition
        });

        // The object the caller holds is the object the result carries — in BOTH
        // modes — and its module is never evaluated.
        expect(compiled.definition).toBe(definition);
        expect(evaluations()).toBe(0);
        expect(compiled.description).toBe('A definition the caller already owns.');
        expect(compiled.checks).toEqual(['transpile:syntax', 'contract:tool', 'schema:json']);
        expect(compiled.record.checks).toEqual([
            'transpile:syntax',
            'contract:tool',
            'schema:json'
        ]);

        const syntaxCompiled = compileToolSourceModule(
            { name: 'compileProbe', moduleText, definition },
            { evaluate: 'syntax' }
        );
        expect(syntaxCompiled.definition).toBe(definition);
        expect(syntaxCompiled.revision).toBe(compiled.revision);
        expect(evaluations()).toBe(0);

        // The identity the harness installs for the same definition + bytes is THIS
        // revision, which is what lets ONE compile serve many harness instances.
        expect(prepareToolSourceRecord({ name: 'compileProbe', moduleText }, definition)).toEqual({
            record: compiled.record,
            revision: compiled.revision
        });
    });
});

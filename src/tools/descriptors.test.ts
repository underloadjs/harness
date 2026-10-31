// T24 + T27: the Node tool catalogue is DERIVED LIVE, not read from the generated
// manifest, AND its bodies are compiled from the SAME live entries.
//
// T24 (catalogue): the library scanned `tools/**/*.tool.ts` while
// `presetTools`/`PRESET_TOOLS`/the server shared catalogue served the STALE
// generated rows, so a brand-new entry was registered by `harness({})` but
// invisible (and unloadable) in the catalogue.
//
// T27 (bodies): a manifest-KNOWN label kept the generated `import()` chunk, so one
// row was described by two revisions — live-scan metadata, built-chunk body. Editing
// `src/tools/**/*.tool.ts` without `npm run tools:manifest` + `vite build` served the
// OLD body. `loadPresetTool` now compiles every source-backed row's editable
// `sourcePath`, so metadata and executable body are one revision for every label.
//
// What is mocked here, and why it is the honest simulation of a stale manifest:
//   `../core/tool-manifest` is replaced with the REAL rows MINUS `syntaxCheck` —
//   exactly the bytes a manifest generated before `syntaxCheck.tool.ts` existed
//   would contain — with `fileRead`'s metadata doctored to stale values. Its
//   generated loader is POISONED: on a source-backed (Node) catalogue reaching it at
//   all is the regression, so it records the label and throws instead of loading a
//   possibly-obsolete build artifact. The filesystem is NOT mocked, so the live
//   scanner sees the real entries. Nothing is written into the package source tree:
//   a fixture `.tool.ts` there would be picked up by every other test in this package.
//
// Deterministic throughout: exact arrays, exact metadata objects, an exact loader
// call log (always empty here), and executions whose results are literals.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Every generated-loader label this process resolves, in call order. A source-backed
// catalogue must keep this empty: the generated loader is a BUILD ARTIFACT.
const generatedLoads = vi.hoisted(() => [] as string[]);

// The stale-manifest simulation (see the header). `syntaxCheck` is a SHIPPED preset,
// so this is a real row disappearing from the generated table while its file stays on
// disk — the precise T24 failure mode, with no invented tool. `fileRead` keeps its
// row but carries STALE metadata, which proves the catalogue reads the ENTRY, not the
// manifest, when both exist. The loader is poisoned for the same reason: T27 says a
// Node catalogue never executes a generated chunk.
vi.mock('../core/tool-manifest', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../core/tool-manifest')>();

    return {
        ...actual,
        BUILTIN_TOOL_DESCRIPTORS: actual.BUILTIN_TOOL_DESCRIPTORS.filter(
            (descriptor) => descriptor.name !== 'syntaxCheck'
        ).map((descriptor) =>
            descriptor.name === 'fileRead'
                ? {
                      ...descriptor,
                      metadata: {
                          ...descriptor.metadata,
                          description: 'STALE MANIFEST DESCRIPTION',
                          tags: ['stale', 'manifest']
                      }
                  }
                : descriptor
        ),
        loadDiscoveredTool: async (label: string) => {
            generatedLoads.push(label);
            // Poisoned on purpose: a source-backed catalogue compiles `sourcePath`,
            // so any call here means a body would have come from an older build.
            throw new Error(
                `The generated tool chunk must not be used for a source-backed catalogue (label "${label}").`
            );
        }
    };
});

const { BUILTIN_TOOL_DESCRIPTORS } = await import('../core/tool-manifest');
const {
    EXTERNAL_DESCRIPTORS,
    PRESET_DESCRIPTORS,
    RUNTIME_DESCRIPTORS,
    TOOL_DESCRIPTORS,
    descriptorMetadata,
    descriptorOf,
    descriptorSourcePath,
    isAlwaysDeclared,
    isCoreRegistered,
    loadPresetTool
} = await import('./descriptors');
const { PRESET_TOOL_NAMES, PRESET_TOOLS } = await import('./catalogue');
const { presetTools } = await import('./index');

// The full package catalogue, in registration order. Duplicated literally on
// purpose: this is the contract a stale manifest must not be able to shorten.
const ALL_PACKAGE_NAMES = [
    'toolRegistry',
    'toolRequest',
    'toolList',
    'toolManage',
    'toolCreate',
    'todoManage',
    'profileManage',
    'chapterManage',
    'locationManage',
    'agentManage',
    'agentResult',
    'agentDelegate',
    'threadFork',
    'actionRequest',
    'toolCancel',
    'syntaxCheck',
    'fileRead',
    'fileWrite',
    'fileEdit',
    'fileList',
    'fileGlob',
    'commandRun',
    'gitDiff',
    'webSearch',
    'webFetch',
    'threadSend',
    'threadList'
];

const PRESET_NAMES = [
    'syntaxCheck',
    'fileRead',
    'fileWrite',
    'fileEdit',
    'fileList',
    'fileGlob',
    'commandRun',
    'gitDiff'
];

// Scratch fixtures live under the repo-root Temp/ (AGENTS.md), never OS temp.
const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SCRATCH_ROOT = path.join(PACKAGE_ROOT, '..', '..', '..', 'Temp', 't27', 'catalogue-fixtures');

afterAll(() => {
    fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

describe('live Node descriptor catalogue (T24)', () => {
    it('is not shortened by a stale generated manifest', () => {
        // The mock really is stale: the generated table no longer knows syntaxCheck.
        expect(BUILTIN_TOOL_DESCRIPTORS.map((descriptor) => descriptor.name)).not.toContain(
            'syntaxCheck'
        );
        expect(BUILTIN_TOOL_DESCRIPTORS).toHaveLength(26);

        // The live scan still reports the whole package tree, in scan order.
        expect(TOOL_DESCRIPTORS.map((descriptor) => descriptor.name)).toEqual(ALL_PACKAGE_NAMES);
        expect(PRESET_TOOL_NAMES).toEqual(PRESET_NAMES);
        expect(Object.keys(presetTools)).toEqual(PRESET_NAMES);
    });

    it('reads entry literals, not stale manifest metadata, for a row both know', () => {
        // fileRead EXISTS in the stale manifest, with a doctored description/tags.
        // The catalogue must publish the entry's own literal: the manifest is a
        // build artifact and can be arbitrarily old. Comparing against the entry's
        // exported constant is the exact statement of that contract (importing a
        // `.tool` module is safe in this Node test and is what pins the equality).
        const staleRow = BUILTIN_TOOL_DESCRIPTORS.find(
            (descriptor) => descriptor.name === 'fileRead'
        );
        expect(staleRow?.metadata.description).toBe('STALE MANIFEST DESCRIPTION');
        expect(staleRow?.metadata.tags).toEqual(['stale', 'manifest']);

        return import('./files/fileRead.tool').then((entry) => {
            expect(PRESET_TOOLS.fileRead).toEqual({
                name: entry.FILE_READ_METADATA.name,
                description: entry.FILE_READ_METADATA.description,
                tags: [...entry.FILE_READ_METADATA.tags],
                parameters: entry.FILE_READ_METADATA.parameters,
                visibility: entry.FILE_READ_METADATA.visibility
            });
            expect(PRESET_TOOLS.fileRead.tags).toEqual(['files', 'read', 'filesystem']);
            expect(descriptorOf('fileRead')!.metadata.tags).toEqual([
                'files',
                'read',
                'filesystem'
            ]);
        });
    });

    it('derives the exact descriptor row of a manifest-unknown entry', () => {
        // Field-for-field against the entry's own literals; the whole row is
        // asserted, not a subset, so a drifted projection fails here.
        expect(descriptorOf('syntaxCheck')).toEqual({
            name: 'syntaxCheck',
            metadata: PRESET_TOOLS.syntaxCheck,
            sourcePath: 'tools/syntax/syntaxCheck.tool.ts',
            label: 'tools/syntax/syntaxCheck.tool.ts',
            origin: 'package',
            group: 'preset',
            activation: 'always',
            order: 160,
            sessionBound: false,
            listed: false,
            alwaysDeclared: false
        });
        expect(descriptorSourcePath('syntaxCheck')).toBe('tools/syntax/syntaxCheck.tool.ts');
    });

    it('agrees with the harness, which registers the same fresh entry', async () => {
        // The whole point of the correction: catalogue and harness must not disagree.
        // The harness scans on construction, so the entry it registers is exactly the
        // row the catalogue publishes — no manifest involved on either side.
        const { agent, harness } = await import('../harness');

        const writer = harness({
            agents: {
                writer: agent({
                    model: 'test/model',
                    stream: async function* () {
                        return;
                    }
                })
            }
        });

        expect(writer.tools.syntaxCheck).toBeDefined();
        expect(writer.tools.syntaxCheck.description).toBe(PRESET_TOOLS.syntaxCheck.description);
        expect(writer.tools.syntaxCheck.tags).toEqual([
            'code',
            'syntax',
            'javascript',
            'python',
            'validation'
        ]);
        // Registered from the same editable entry the catalogue lists.
        expect(writer.toolSource('syntaxCheck')?.sourcePath).toBe(
            'tools/syntax/syntaxCheck.tool.ts'
        );
        await expect(
            writer.executeTool('syntaxCheck', { code: 'let x = 1;', language: 'javascript' })
        ).resolves.toBe(true);
    });

    it('keeps the preset and runtime projections disjoint and correctly grouped', () => {
        expect(PRESET_DESCRIPTORS.map((descriptor) => descriptor.name)).toEqual(PRESET_NAMES);
        // RUNTIME_DESCRIPTORS is the server's listable core set: `listed !== false`
        // and no session-only capability rows.
        expect(RUNTIME_DESCRIPTORS.map((descriptor) => descriptor.name)).toEqual([
            'toolRegistry',
            'toolRequest',
            'toolList',
            'toolManage',
            'toolCreate',
            'todoManage',
            'profileManage',
            'chapterManage',
            'locationManage',
            'agentManage',
            'agentResult',
            'agentDelegate',
            'actionRequest',
            'threadFork'
        ]);
        // A package catalogue can never contain a host-folder row.
        expect(EXTERNAL_DESCRIPTORS).toEqual([]);
    });

    it('classifies rows from their own registration literals', () => {
        const row = (name: string) => {
            const descriptor = descriptorOf(name);
            expect(descriptor).toBeDefined();
            return descriptor!;
        };

        // toolRegistry is always-registered but never in the DECLARED projection.
        expect(isCoreRegistered(row('toolRegistry'))).toBe(true);
        expect(isAlwaysDeclared(row('toolRegistry'))).toBe(false);
        // toolCreate is declared always but policy-gated at registration time.
        expect(isAlwaysDeclared(row('toolCreate'))).toBe(true);
        // Capability rows are neither.
        expect(isCoreRegistered(row('agentDelegate'))).toBe(false);
        expect(isAlwaysDeclared(row('agentDelegate'))).toBe(false);
    });

    it('executes a manifest-unknown preset through its editable source', async () => {
        // No generated `import()` branch exists for this label, so the loader must
        // compile it from source instead of rejecting with
        // `No generated tool loader for ...`. This is the half that made the T24 bug
        // visible to a caller rather than just to a catalogue listing.
        expect(presetTools.syntaxCheck.description).toBe(PRESET_TOOLS.syntaxCheck.description);
        expect(presetTools.syntaxCheck.tags).toEqual([
            'code',
            'syntax',
            'javascript',
            'python',
            'validation'
        ]);

        await expect(
            presetTools.syntaxCheck({ code: 'const a = 1;', language: 'javascript' })
        ).resolves.toBe(true);

        // The generated loader was never consulted for it: source compilation was
        // used, exactly once per call (the proxy caches a successful resolve).
        expect(generatedLoads).toEqual([]);

        // `loadPresetTool` is the same seam the proxy uses; a direct call resolves
        // to a callable Tool carrying the entry's own metadata.
        const loaded = await loadPresetTool('syntaxCheck');
        expect(loaded.name).toBe('syntaxCheck');
        expect(loaded.description).toBe(PRESET_TOOLS.syntaxCheck.description);
        expect(await loaded({ code: 'const b = 2;', language: 'javascript' })).toBe(true);
        expect(generatedLoads).toEqual([]);
    });

    it('keeps metadata and body on ONE source revision for a manifest-known preset (T27)', async () => {
        // The T27 correction, stated in both halves for a label the generated manifest
        // DOES know (fileRead). The manifest copy of this row is doctored and the
        // generated loader is poisoned, so either half coming from the build artifact
        // fails this test loudly.
        const entry = await import('./files/fileRead.tool');

        // Half 1 — metadata: the entry's own literal, never the doctored manifest row.
        expect(PRESET_TOOLS.fileRead).toEqual({
            name: entry.FILE_READ_METADATA.name,
            description: entry.FILE_READ_METADATA.description,
            tags: [...entry.FILE_READ_METADATA.tags],
            parameters: entry.FILE_READ_METADATA.parameters,
            visibility: entry.FILE_READ_METADATA.visibility
        });
        expect(presetTools.fileRead.tags).toEqual(['files', 'read', 'filesystem']);
        // The compiled path IS the row's scanned entry, which is what makes the two
        // halves one revision.
        expect(descriptorSourcePath('fileRead')).toBe('tools/files/fileRead.tool.ts');

        // Half 2 — executable body: the REAL implementation, not a generated chunk.
        // A fixture under Temp/ keeps the assertion independent of the repository.
        const folder = path.join(SCRATCH_ROOT, 'fresh-body');
        fs.mkdirSync(folder, { recursive: true });
        const target = path.join(folder, 'alpha.txt');
        fs.writeFileSync(target, 'alpha', 'utf8');

        const expected = {
            files: [
                {
                    path: target,
                    content: 'alpha',
                    startLine: 1,
                    endLine: 1,
                    truncated: false,
                    nextLine: null,
                    nextColumn: null,
                    bytes: 5
                }
            ],
            truncated: false,
            bytes: 5,
            contentBudget: 65536
        };

        // Proxy path (what `presetTools` exposes) and the direct seam both run the
        // entry body compiled from `tools/files/fileRead.tool.ts`.
        await expect(presetTools.fileRead([target])).resolves.toEqual(expected);
        const loaded = await loadPresetTool('fileRead');
        expect(loaded.name).toBe('fileRead');
        expect(loaded.description).toBe(entry.FILE_READ_METADATA.description);
        await expect(loaded([target])).resolves.toEqual(expected);

        // The build artifact was never consulted, in either half.
        expect(generatedLoads).toEqual([]);
    });

    it('executes a manifest-known preset from its editable source, not the generated chunk', async () => {
        // Previously this label kept its generated `import()`; T27 moved it to source
        // compilation because the generated chunk is a build artifact of an OLDER
        // revision (live metadata + stale body = the incoherence T27 removes). The
        // poisoned loader above turns any regression into a failure here.
        generatedLoads.length = 0;
        const folder = path.join(SCRATCH_ROOT, 'listing');
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, 'alpha.txt'), 'a', 'utf8');
        fs.writeFileSync(path.join(folder, 'beta.txt'), 'b', 'utf8');
        fs.writeFileSync(path.join(folder, 'gamma.txt'), 'c', 'utf8');

        const listing = await presetTools.fileList({ paths: [folder], limit: 2 });

        const posixFolder = folder.replace(/\\/g, '/');
        const first = `${posixFolder}/alpha.txt`;
        const second = `${posixFolder}/beta.txt`;

        // `bytes` is the UTF-8 size of THIS page's entries (the strings above), not
        // of the files they name.
        expect(listing).toEqual({
            entries: [first, second],
            truncated: true,
            nextOffset: 2,
            offset: 0,
            limit: 2,
            bytes: Buffer.byteLength(first, 'utf8') + Buffer.byteLength(second, 'utf8'),
            contentBudget: 65536
        });

        // The generated loader resolved NOTHING: the body came from the entry source.
        expect(generatedLoads).toEqual([]);
    });
});

describe('descriptor mutation isolation (T24)', () => {
    it('hands out detached metadata from descriptorMetadata and descriptorOf', () => {
        const first = descriptorMetadata('fileRead');
        first.tags.push('mutated');
        (first.parameters.properties as Record<string, unknown>).injected = true;

        // A later read is the entry's literal again: the process snapshot was never
        // exposed.
        expect(descriptorMetadata('fileRead').tags).toEqual(['files', 'read', 'filesystem']);
        expect(descriptorMetadata('fileRead').parameters).not.toHaveProperty(
            'properties.injected'
        );

        const row = descriptorOf('fileRead')!;
        row.metadata.tags.push('mutated-row');
        row.metadata.parameters.extra = 1;

        expect(descriptorOf('fileRead')!.metadata.tags).toEqual([
            'files',
            'read',
            'filesystem'
        ]);
        expect(descriptorOf('fileRead')!.metadata.parameters).not.toHaveProperty('extra');
    });

    it('does not alias the exported lists to each other', () => {
        // Every projection is built from the PRIVATE snapshot with a fresh clone, so
        // editing one exported list cannot reach another list, and cannot reach the
        // snapshot that later reads resolve from.
        const before = TOOL_DESCRIPTORS.map((descriptor) => descriptor.name);

        PRESET_DESCRIPTORS[0].metadata.tags.push('mutated-preset');
        PRESET_DESCRIPTORS[0].order = -1;
        TOOL_DESCRIPTORS[0].metadata.tags.push('mutated-all');

        // toolRegistry is row 0 of BOTH exported lists, and the two rows are
        // different objects: the runtime list never sees the TOOL_DESCRIPTORS edit.
        expect(RUNTIME_DESCRIPTORS[0].name).toBe('toolRegistry');
        expect(RUNTIME_DESCRIPTORS[0].metadata.tags).toEqual([
            'tools',
            'registry',
            'source',
            'self-modifying',
            'compile'
        ]);
        expect(TOOL_DESCRIPTORS.map((descriptor) => descriptor.name)).toEqual(before);
        expect(descriptorOf('syntaxCheck')!.order).toBe(160);
        expect(descriptorMetadata('syntaxCheck').tags).toEqual([
            'code',
            'syntax',
            'javascript',
            'python',
            'validation'
        ]);
    });

    it('does not let a mutated catalogue row corrupt a freshly built proxy', () => {
        // `lazyTool` copies name/description/tags/schema from a detached row, so a
        // consumer editing PRESET_TOOLS cannot change what a later proxy declares.
        PRESET_TOOLS.fileRead.tags.push('mutated-catalogue');
        (PRESET_TOOLS.fileRead.parameters.properties as Record<string, unknown>).injected = true;

        expect(presetTools.fileRead.tags).toEqual(['files', 'read', 'filesystem']);
        expect(presetTools.fileRead.parameters).not.toHaveProperty('properties.injected');
        expect(descriptorMetadata('fileRead').tags).toEqual(['files', 'read', 'filesystem']);
    });
});

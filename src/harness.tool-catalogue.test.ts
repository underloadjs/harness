// Shared tool catalogue: ONE compiled definition, MANY harness instances
// (issue 0002 + issue 0003).
//
// The REGISTRY side of the pair. The compile itself — both `evaluate` modes, the
// cache, the check lists, the name-less refusal — is pinned in
// `src/core/tool-source.test.ts`; this file is where a registry exists to be looked
// at, so it pins what the published entry must NOT do and what the shared-catalogue
// shape must keep:
//   - `compileToolSourceModule` publishes NOTHING: a harness built after a compile
//     does not know the name, and a candidate whose top-level code throws is a
//     validation failure that leaves the registry exactly as it was;
//   - `tools: { name: { tool, source } }` takes a prebuilt definition beside the bytes
//     it was compiled from, so N instances built from ONE catalogue object each
//     register the tool and each report the SAME revision the compile reported —
//     `toolSource()`/`toolSources()` survive a shared catalogue, which is what the
//     Tools tab and the replace flow are built on;
//   - the registry is PER INSTANCE: replacing the name in one harness moves that
//     harness's revision and leaves every other instance's tool and revision alone;
//   - a configured `Tool` with no attachment still answers `undefined` from
//     `toolSource()` — the historical shape and its documented meaning;
//   - an attachment is validated at construction, naming the tool, because a host
//     that asked for a revision deserves to be told why it got none.
//
// Every case here is construction-only: the registry is built and mutated during
// `harness({...})`/`registerTool`, so no turn runs and no transport is consulted.
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { agent, compileToolSourceModule, harness, tool } from '@underload/harness';
import type { HarnessStream } from '@underload/harness';

// Offline transport (never driven).
const stream: HarnessStream = async function* () {
    yield { type: 'text', delta: 'ok' };
    yield { type: 'done', stopReason: 'stop', toolCalls: [] };
};

const writerAgent = () => agent({ model: 'test/model', stream });

// A configuration with NO preset/tool catalogue, so `tools` and `toolSources()`
// report exactly what these tests put in them plus the harness-owned baseline.
const offline = (tools?: Record<string, unknown>) => ({
    agents: { writer: writerAgent() },
    presets: false as const,
    ...(tools === undefined ? {} : { tools: tools as never })
});

// The canonical editable module shape (declarative metadata + execute) for `name`,
// returning `value`. Same shape as src/core/tool-source.test.ts so a revision here
// and a revision there are comparable.
const entryText = (name: string, value: string): string => `
export const metadata = {
    name: ${JSON.stringify(name)},
    description: 'Report the probe value.',
    tags: ['test', 'catalogue'],
    parameters: { type: 'object', properties: {}, additionalProperties: false }
};

export const execute = () => ${JSON.stringify(value)};
`;

// The prebuilt definition half of a catalogue entry.
const probeTool = (name: string, value: string) =>
    tool({
        name,
        description: 'Report the probe value.',
        tags: ['test', 'catalogue'],
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: () => value
    });

// One name's installed source record, filtered rather than "contained": the harness
// owns baseline source records of its own, and a membership check would pass even if
// this registration produced none.
const sourceOf = (writer: ReturnType<typeof harness>, name: string) =>
    writer
        .toolSources()
        .filter((source) => source.name === name)
        .map((source) => source.revision);

describe('shared tool catalogue (issue 0002 publish nothing, issue 0003 one catalogue many instances)', () => {
    it('compiles a candidate without publishing it into any registry', () => {
        const compiled = compileToolSourceModule({
            name: 'compileOnly',
            moduleText: entryText('compileOnly', 'nowhere')
        });

        // The compile succeeded and reported a revision, and NOTHING was registered:
        // a harness built afterwards (after, not before — a shared process registry
        // would show up here) does not know the name.
        expect(compiled.name).toBe('compileOnly');
        expect(compiled.checks).toEqual([
            'transpile:syntax',
            'load:module',
            'contract:tool',
            'schema:json'
        ]);

        const writer = harness(offline());
        expect(writer.tools.compileOnly).toBeUndefined();
        expect(writer.toolSource('compileOnly')).toBeUndefined();
        expect(sourceOf(writer, 'compileOnly')).toEqual([]);
    });

    it('treats a throwing top level as a validation failure that changes no registration', async () => {
        const throwingText = `
export const metadata = {
    name: 'throwingProbe',
    description: 'Throws while loading.',
    tags: ['test', 'catalogue'],
    parameters: { type: 'object', properties: {}, additionalProperties: false }
};

throw new Error('top-level side effect ran');

export const execute = () => 'unreachable';
`;
        const writer = harness(offline());

        // The registration path refuses and publishes nothing (unchanged semantics).
        await expect(
            writer.registerTool({ name: 'throwingProbe', moduleText: throwingText })
        ).rejects.toThrow('top-level side effect ran');
        expect(writer.tools.throwingProbe).toBeUndefined();
        expect(writer.toolSource('throwingProbe')).toBeUndefined();
        expect(sourceOf(writer, 'throwingProbe')).toEqual([]);

        // The published compile answers the SAME question about the same candidate
        // without ever evaluating it, and it too changes nothing.
        const checked = compileToolSourceModule(
            { name: 'throwingProbe', moduleText: throwingText },
            { evaluate: 'syntax' }
        );
        expect(checked.checks).toEqual(['transpile:syntax']);
        expect(checked.visibility).toBe('searchable');
        expect(writer.tools.throwingProbe).toBeUndefined();
        expect(sourceOf(writer, 'throwingProbe')).toEqual([]);
    });

    it('installs one catalogue entry into two instances with the compile revision', async () => {
        const definition = probeTool('catalogueProbe', 'from-catalogue');
        const moduleText = entryText('catalogueProbe', 'from-catalogue');

        // ONE object, passed to both instances — the shape a host keeps when it
        // compiles its user tools at startup (issue 0003).
        const catalogue = { catalogueProbe: { tool: definition, source: { moduleText } } };
        const compiled = compileToolSourceModule({ name: 'catalogueProbe', moduleText, definition });

        const first = harness(offline(catalogue));
        const second = harness(offline(catalogue));

        // Each instance holds its OWN wrapper: `configuration.tools` builds one per
        // harness (the shared definition object is never mutated), so two instances
        // built from one catalogue share the implementation and not the registry
        // entry. The metadata is the caller's, verbatim.
        expect(first.tools.catalogueProbe).not.toBe(second.tools.catalogueProbe);
        expect(first.tools.catalogueProbe?.name).toBe('catalogueProbe');
        expect(first.tools.catalogueProbe?.description).toBe('Report the probe value.');
        expect(first.tools.catalogueProbe?.tags).toEqual(['test', 'catalogue']);
        expect(first.tools.catalogueProbe?.visibility).toBe('searchable');

        // And each instance answers the inspect surface with the revision the compile
        // reported, so "what is installed" and "what I compiled" are one fact.
        expect(first.toolSource('catalogueProbe')?.revision).toBe(compiled.revision);
        expect(second.toolSource('catalogueProbe')?.revision).toBe(compiled.revision);
        expect(second.toolSource('catalogueProbe')).toEqual(first.toolSource('catalogueProbe'));
        expect(sourceOf(first, 'catalogueProbe')).toEqual([compiled.revision]);
        expect(sourceOf(second, 'catalogueProbe')).toEqual([compiled.revision]);

        // The record carries the bytes the caller supplied, not a re-evaluated module.
        expect(first.toolSource('catalogueProbe')?.moduleText).toBe(moduleText);
        expect(first.toolSource('catalogueProbe')?.format).toBe('module');
        expect(first.toolSource('catalogueProbe')?.checks).toEqual([
            'transpile:syntax',
            'contract:tool',
            'schema:json'
        ]);

        // Both instances run the SAME implementation.
        expect(
            await second.tools.catalogueProbe?.execute({ parameters: {} } as never)
        ).toBe('from-catalogue');
    });

    it('replaces in one instance without touching another instance or its revision', async () => {
        const definition = probeTool('catalogueProbe', 'from-catalogue');
        const moduleText = entryText('catalogueProbe', 'from-catalogue');
        const replacedText = entryText('catalogueProbe', 'replaced-in-first');
        const catalogue = { catalogueProbe: { tool: definition, source: { moduleText } } };

        const compiled = compileToolSourceModule({ name: 'catalogueProbe', moduleText, definition });
        const replacedRevision = compileToolSourceModule({
            name: 'catalogueProbe',
            moduleText: replacedText,
            definition
        }).revision;

        const first = harness(offline(catalogue));
        const second = harness(offline(catalogue));
        const secondBefore = second.toolSource('catalogueProbe');

        const result = await first.registerTool({
            name: 'catalogueProbe',
            definition,
            moduleText: replacedText
        });

        // A replacement moves the revision, and the new revision is exactly what the
        // compile of the new bytes reports — the two surfaces cannot drift.
        expect(result.revision).toBe(replacedRevision);
        expect(first.toolSource('catalogueProbe')?.revision).toBe(replacedRevision);
        expect(first.toolSource('catalogueProbe')?.moduleText).toBe(replacedText);

        // The sibling instance is untouched: same record, same installed object.
        expect(second.toolSource('catalogueProbe')).toEqual(secondBefore);
        expect(second.toolSource('catalogueProbe')?.revision).toBe(compiled.revision);
        // A replacement through `registerTool` publishes the caller's definition object
        // as-is (no wrapper — the wrapper is the `configuration.tools` path), while the
        // sibling keeps the wrapper it built at construction: per-instance state, and
        // the sibling's implementation still answers with its own bytes' value.
        expect(first.tools.catalogueProbe).toBe(definition);
        expect(second.tools.catalogueProbe).not.toBe(definition);
        expect(await second.tools.catalogueProbe?.execute({ parameters: {} } as never)).toBe(
            'from-catalogue'
        );
        expect(sourceOf(second, 'catalogueProbe')).toEqual([compiled.revision]);
    });

    it('derives the same record from an attached absolute sourcePath, reading bytes only', async () => {
        // 0003A: the `sourcePath` form points at an editable entry the harness reads for
        // its captured bytes. The file lives outside every configured folder, so nothing
        // else in this harness saw it — and `toolSource()` still reports the revision the
        // standalone compile derived from the same path.
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalogue-path-'));
        try {
            const sourcePath = path.join(root, 'probed.tool.ts');
            const text = entryText('probed', 'disk');
            fs.writeFileSync(sourcePath, text, 'utf8');

            // The prebuilt definition keeps its OWN metadata (`configured`, not the file's
            // `probed`), so a revision match proves the record came from this attachment.
            const definition = probeTool('configured', 'prebuilt');
            const compiled = compileToolSourceModule({ name: 'configured', sourcePath, definition });
            expect(compiled.checks).toEqual([
                'transpile:syntax',
                'contract:tool',
                'schema:json'
            ]);

            const writer = harness(
                offline({ configured: { tool: definition, source: { sourcePath } } })
            );

            // Registered and callable, and the attached bytes were captured verbatim — raw
            // source, not transpiled output — beside the definition they describe.
            expect(writer.tools.configured?.name).toBe('configured');
            expect(await writer.tools.configured?.execute({ parameters: {} } as never)).toBe(
                'prebuilt'
            );

            const { sourcePath: recordedPath, ...record } = writer.toolSource('configured')!;
            expect(record).toEqual({
                name: 'configured',
                revision: compiled.revision,
                moduleText: text,
                dependencies: [],
                format: 'module',
                // The record reports exactly what construction established for these bytes:
                // the transpile, the contract check of the definition beside them, and the
                // JSON schema — no `'load:module'`, because a supplied definition is never
                // loaded (src/core/tool-source.ts, prepareCompiledToolSource).
                checks: ['transpile:syntax', 'contract:tool', 'schema:json']
            });
            expect(recordedPath).toBe(sourcePath);

            // Reading a file for bytes is not discovery: the entry's own name was never
            // registered, so the attachment did not smuggle a second tool in.
            expect(writer.tools.probed).toBeUndefined();
            expect(sourceOf(writer, 'probed')).toEqual([]);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('keeps the historical no-record shape for a configured definition with no attachment', async () => {
        const definition = probeTool('bareProbe', 'bare');
        const writer = harness(offline({ bareProbe: definition }));

        // Registered and callable, with no editable source revision — the meaning of
        // `undefined` here is documented and unchanged (src/types/index.ts, toolSource).
        expect(writer.tools.bareProbe?.name).toBe('bareProbe');
        expect(writer.tools.bareProbe?.description).toBe('Report the probe value.');
        expect(await writer.tools.bareProbe?.execute({ parameters: {} } as never)).toBe('bare');
        expect(writer.toolSource('bareProbe')).toBeUndefined();
        expect(sourceOf(writer, 'bareProbe')).toEqual([]);
    });

    it('refuses a malformed source attachment at construction, naming the tool', () => {
        const definition = probeTool('probe', 'value');
        const moduleText = entryText('probe', 'value');

        // A wrapper with no callable `tool` is not a tool.
        expect(() =>
            harness(offline({ probe: { tool: { description: 'not a tool' } } }))
        ).toThrow('Tool "probe" is not a tool: create it with tool({...}).');

        // An attachment that is not an object describes nothing.
        expect(() =>
            harness(offline({ probe: { tool: definition, source: 'bytes' } }))
        ).toThrow('Tool "probe" source attachment must be an object with moduleText or sourcePath.');

        // An attachment with neither entry form cannot back a revision.
        expect(() =>
            harness(offline({ probe: { tool: definition, source: {} } }))
        ).toThrow(
            'Tool "probe" source attachment needs moduleText or sourcePath: an attachment with neither describes no revision.'
        );

        // `dependencies` keeps its element shape, because the revision hashes those bytes.
        expect(() =>
            harness(offline({ probe: { tool: definition, source: { moduleText, dependencies: 'nope' } } }))
        ).toThrow('Tool "probe" source attachment dependencies must be an array of { path, text }.');
    });
});

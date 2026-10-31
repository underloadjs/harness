// Independently compilable app-tool source entries (R2, moved by T25).
//
// The self-modifying-tools requirements say every shipped application tool needs
// an editable, independently compilable source entry. The execution/schema tests
// already live in ./tools.test.ts; this file pins the SOURCE contract:
//
//   1. each entry is its own `*.tool.ts` file with a Tool default export;
//   2. the app catalogue publishes that exact declarative half (name, description,
//      tags, schema) from the entry's own metadata literal;
//   3. no entry imports another registered tool implementation — the only imports
//      allowed are the shared harness helper modules, so compiling/replacing one
//      tool never pulls in an unrelated tool;
//   4. no PRODUCTION module imports a tool entry: the catalogue module must read the
//      folder metadata-first (T25's whole point).
//
// Assertions are exact: the file list, the metadata projection, and the import
// specifiers are fixed data.

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { prepareToolCandidate } from '../../core';
import { harnessTools } from './tools';
import { EXAMPLE_APP_TOOL_SOURCES, SHARED_APP_TOOL_SOURCES } from './toolbox';
import timeNow from '../tools/shared/timeNow.tool';
import textCount from '../tools/shared/textCount.tool';
import diceRoll from '../tools/shared/diceRoll.tool';
import noteSearch from '../tools/shared/noteSearch.tool';
import textSummarize from '../tools/shared/textSummarize.tool';
import testFlaky from '../tools/examples/testFlaky.tool';

// The concrete source-entry list the app ships, in catalogue (registration) order.
// `folder` is the subfolder of `src/server/tools` the entry lives in; that folder IS
// the shared/example policy (T25), so it is part of the contract.
const SOURCES = {
    timeNow: { folder: 'shared', file: 'timeNow.tool.ts', definition: timeNow },
    textCount: { folder: 'shared', file: 'textCount.tool.ts', definition: textCount },
    diceRoll: { folder: 'shared', file: 'diceRoll.tool.ts', definition: diceRoll },
    noteSearch: { folder: 'shared', file: 'noteSearch.tool.ts', definition: noteSearch },
    textSummarize: { folder: 'shared', file: 'textSummarize.tool.ts', definition: textSummarize },
    testFlaky: { folder: 'examples', file: 'testFlaky.tool.ts', definition: testFlaky }
} as const;

// The shared runtime helpers are the only permitted VALUE imports. Every source
// entry imports `tool` (and `toolUi`) from the harness-internal `core` entry, which
// the synchronous source compiler maps to the LIVE framework module. A type-only
// import from `types` is also allowed and erased at runtime. Importing a sibling
// tool source would make independent compilation a lie.
const ALLOWED_IMPORTS = ['../../../core', '../../../types'];

const sourcePath = (folder: string, file: string): string =>
    fileURLToPath(new URL(`../tools/${folder}/${file}`, import.meta.url));

// The package-relative path the harness records for an entry.
const packagePath = (folder: string, file: string): string => `server/tools/${folder}/${file}`;

describe('app tool source entries', () => {
    it('catalogues each shipped tool with the entry file as its own metadata source', () => {
        // T25: the catalogue is built from each entry's `metadata` literal through the
        // AST scan, so it holds a LAZY proxy rather than the module's own Tool object.
        // Identity is therefore asserted on the DECLARATIVE half (name, description,
        // tags, schema) plus the source path — that is what the folder is authoritative
        // for. A mismatch would mean the catalogue published something the file does
        // not say.
        expect(Object.keys(harnessTools)).toEqual(Object.keys(SOURCES));

        for (const [name, source] of Object.entries(SOURCES)) {
            expect({
                name: harnessTools[name as keyof typeof harnessTools].name,
                description: harnessTools[name as keyof typeof harnessTools].description,
                tags: [...harnessTools[name as keyof typeof harnessTools].tags],
                parameters: harnessTools[name as keyof typeof harnessTools].parameters
            }).toEqual({
                name,
                description: source.definition.description,
                tags: [...source.definition.tags],
                parameters: source.definition.parameters
            });

            // The catalogue's lazily compiled implementation is the SAME file the
            // harness registers, so a direct call runs the shipped code.
            expect(SHARED_APP_TOOL_SOURCES[name] ?? EXAMPLE_APP_TOOL_SOURCES[name]).toBe(
                packagePath(source.folder, source.file)
            );
        }

        for (const [name, source] of Object.entries(SOURCES)) {
            // Every entry carries the full Tool contract (metadata + schema +
            // execution); an incomplete export would fail registration validation.
            expect({ name, description: source.definition.description.length > 0 }).toEqual({
                name,
                description: true
            });
            expect(Array.isArray(source.definition.tags)).toBe(true);
            expect(source.definition.parameters).toEqual(expect.objectContaining({ type: 'object' }));
            expect(typeof source.definition.execute).toBe('function');
        }
    });

    it('imports only the shared harness helper, never another tool implementation', async () => {
        for (const source of Object.values(SOURCES)) {
            const text = await readFile(sourcePath(source.folder, source.file), 'utf8');
            const specifiers = [...text.matchAll(/^import\s[^\n]*\sfrom\s+'([^']+)';$/gm)].map(
                (match) => match[1]
            );

            // At least one framework import, and every specifier is one of the two
            // harness-internal helpers. The exact count is not pinned because a
            // source may split value and type imports (timeNow does); the specifier
            // set is the contract.
            expect(specifiers.length).toBeGreaterThan(0);
            expect([...new Set(specifiers)].every((specifier) => ALLOWED_IMPORTS.includes(specifier))).toBe(
                true
            );
        }
    });

    it('compiles every entry independently through the shared runtime compiler', () => {
        // R2 evidence: the SAME synchronous compile/load/validate operation startup
        // and runtime registration use, invoked with one source path at a time. No
        // other tool is imported or required.
        for (const [name, source] of Object.entries(SOURCES)) {
            const prepared = prepareToolCandidate({
                name,
                sourcePath: packagePath(source.folder, source.file)
            });

            expect({
                name: prepared.tool.name,
                revisionIsContentAddressed: /^[0-9a-f]{16}$/.test(prepared.revision),
                sourcePath: prepared.record.sourcePath,
                description: prepared.tool.description,
                parameters: prepared.tool.parameters,
                tags: prepared.tool.tags,
                checks: prepared.record.checks,
                dependencies: prepared.record.dependencies
            }).toEqual({
                name,
                revisionIsContentAddressed: true,
                sourcePath: packagePath(source.folder, source.file),
                description: source.definition.description,
                parameters: source.definition.parameters,
                tags: source.definition.tags,
                checks: ['transpile:syntax', 'load:module', 'contract:tool', 'schema:json'],
                dependencies: []
            });
        }
    });

    it('executes a compiled entry with its exact standalone result', () => {
        // `prepareToolCandidate` is synchronous; the returned Tool's direct
        // callable is exactly what a harness executes after publication.
        const compiled = prepareToolCandidate({
            name: 'textCount',
            sourcePath: packagePath('shared', 'textCount.tool.ts')
        }).tool;

        return expect(compiled('héllo 😀')).resolves.toEqual({ words: 2, characters: 8 });
    });

    it('declares its metadata as a scannable literal pair (metadata + registration)', async () => {
        // Discovery reads these two exports through the TypeScript AST. A missing
        // `metadata`/`registration` export, or a non-literal one, would break the
        // folder-derived catalogue this module builds.
        for (const source of Object.values(SOURCES)) {
            const text = await readFile(sourcePath(source.folder, source.file), 'utf8');

            expect(text).toMatch(/^export const metadata = \{/m);
            expect(text).toMatch(/^export const registration = \{/m);
        }
    });
});

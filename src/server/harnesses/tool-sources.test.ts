// Independently compilable app-tool source entries (R2).
//
// The self-modifying-tools requirements say every shipped application tool needs
// an editable, independently compilable source entry. The execution/schema tests
// already live in ./tools.test.ts; this file pins the SOURCE contract:
//
//   1. each entry has its own file with a Tool default export;
//   2. the app catalogue re-exports that exact definition (no shadow copy);
//   3. no entry imports another registered tool implementation — the only import
//      allowed is the shared harness helper module, so compiling/replacing one
//      tool never pulls in an unrelated tool.
//
// Assertions are exact: the file list, the identity map, and the import specifiers
// are fixed data.

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { prepareToolCandidate } from '../../core';
import { harnessTools } from './tools';
import timeNow from './tool-sources/timeNow';
import textCount from './tool-sources/textCount';
import diceRoll from './tool-sources/diceRoll';
import noteSearch from './tool-sources/noteSearch';
import textSummarize from './tool-sources/textSummarize';
import testFlaky from './tool-sources/testFlaky';

// The concrete source-entry list the app ships. Keep this in step with the R2
// startup wiring: the kernel registers by name, and the edited source path is what
// an agent inspects and replaces.
const SOURCES = {
    timeNow: { file: 'timeNow.ts', definition: timeNow },
    textCount: { file: 'textCount.ts', definition: textCount },
    diceRoll: { file: 'diceRoll.ts', definition: diceRoll },
    noteSearch: { file: 'noteSearch.ts', definition: noteSearch },
    textSummarize: { file: 'textSummarize.ts', definition: textSummarize },
    testFlaky: { file: 'testFlaky.ts', definition: testFlaky }
} as const;

// The shared runtime helpers are the only permitted VALUE imports. Every source
// entry imports `tool` (and `toolUi`) from the harness-internal `core` entry, which
// the synchronous source compiler maps to the LIVE framework module. A type-only
// import from `types` is also allowed and erased at runtime. Importing a sibling
// tool source would make independent compilation a lie.
const ALLOWED_IMPORTS = ['../../../core', '../../../types'];

const sourcePath = (file: string): string =>
    fileURLToPath(new URL(`./tool-sources/${file}`, import.meta.url));

describe('app tool source entries', () => {
    it('exports each shipped tool as its own default Tool entry', () => {
        // Exact identity, not a structural copy: the catalogue is composed from
        // these modules, so replacing the source entry changes the registered
        // definition.
        expect(Object.keys(SOURCES).map((name) => harnessTools[name as keyof typeof harnessTools])).toEqual(
            Object.values(SOURCES).map((source) => source.definition)
        );

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
            const text = await readFile(sourcePath(source.file), 'utf8');
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

    it('compiles every entry independently through the shared runtime compiler', async () => {
        // R2 evidence: the SAME synchronous compile/load/validate operation startup
        // and runtime registration use, invoked with one source path at a time. No
        // other tool is imported or required.
        for (const [name, source] of Object.entries(SOURCES)) {
            const prepared = prepareToolCandidate({
                name,
                sourcePath: `server/harnesses/tool-sources/${source.file}`
            });

            expect({
                name: prepared.tool.name,
                revisionIsContentAddressed: /^[0-9a-f]{16}$/.test(prepared.revision),
                description: prepared.tool.description,
                parameters: prepared.tool.parameters,
                tags: prepared.tool.tags,
                checks: prepared.record.checks,
                dependencies: prepared.record.dependencies
            }).toEqual({
                name,
                revisionIsContentAddressed: true,
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
            sourcePath: 'server/harnesses/tool-sources/textCount.ts'
        }).tool;

        return expect(compiled('héllo 😀')).resolves.toEqual({ words: 2, characters: 8 });
    });
});

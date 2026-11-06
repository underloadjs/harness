// Lazy preset loading (R1b) — proven against the REAL compiled tool bodies.
//
// HISTORY
// -------
// This file used to mock `./files/read.tool` and `./files/edit.tool` and
// count those mock factories, because the generated loader `import()`ed those
// modules. T27 changed the Node body source: `loadPresetTool` now compiles every
// source-backed descriptor's editable `sourcePath` through `prepareToolCandidate`,
// so a `.tool` module is no longer reached through vitest's module registry and such
// a mock would intercept nothing (the tests would silently assert against the real
// body while believing they asserted against a fake).
//
// WHAT IS MEASURED NOW
// --------------------
// The seam that matters is the COMPILER, so it is the one counted:
// `vi.mock('../core', ...)` wraps `prepareToolCandidate` — the exact symbol
// `src/tools/descriptors.ts` reaches through its `await import('../core')` — while
// every other core export stays real. That gives an exact compile count per step:
//
//   1. enumerating the catalogue (import + metadata reads) compiles NOTHING;
//   2. the first execution of a proxy compiles exactly once, and the proxy's own
//      resolve cache keeps the second call at the same count (src/tools/lazy.ts);
//   3. `loadPresetTool` holds NO cross-call body cache: two direct calls compile
//      twice. That is the "no cache retains an obsolete compiled body" guarantee —
//      each resolve reads the entry as it exists on disk at that moment;
//   4. both the callable path and the harness `execute` path defer to first use and
//      return the real body's exact result.
//
// Fixtures are written under the repo-root Temp/ (AGENTS.md), never OS temp, and
// every result asserted here is the real tool's full output object.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Every candidate handed to the runtime compiler, in call order. The `sourcePath`
// recorded alongside each one is what proves the body comes from the descriptor's
// editable entry rather than from a build artifact.
const compiles = vi.hoisted(() => [] as { sourcePath?: string; expectedName?: string }[]);

// Count compilations at the ONE seam the descriptor loader uses. Everything else in
// the core barrel stays the real implementation, so the compiled body is genuine.
vi.mock('../core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../core')>();

    return {
        ...actual,
        prepareToolCandidate: (
            candidate: Parameters<typeof actual.prepareToolCandidate>[0],
            options?: Parameters<typeof actual.prepareToolCandidate>[1]
        ) => {
            compiles.push({
                ...(candidate.sourcePath === undefined ? {} : { sourcePath: candidate.sourcePath }),
                ...(options?.expectedName === undefined
                    ? {}
                    : { expectedName: options.expectedName })
            });

            return actual.prepareToolCandidate(candidate, options);
        }
    };
});

// Repo-root Temp/, so fixtures never land in OS temp.
const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const SCRATCH_ROOT = path.join(PACKAGE_ROOT, '..', '..', '..', 'Temp', 't27', 'laziness-fixtures');

const READ_TARGET = path.join(SCRATCH_ROOT, 'read.txt');
const EDIT_TARGET = path.join(SCRATCH_ROOT, 'edit.txt');

// One fresh fixture set per test: `edit` mutates its target, so the exact
// expected bytes below depend on starting from these contents every time.
const prepareFixtures = (): void => {
    fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
    fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
    fs.writeFileSync(READ_TARGET, 'alpha', 'utf8');
    fs.writeFileSync(EDIT_TARGET, 'before value', 'utf8');
};

// The exact result of reading the 5-byte fixture. `wireBytes` is the serialized
// length of the response, so it depends on the length of this scratch path and is
// matched rather than hardcoded; every other field is asserted exactly.
const readAlphaExpected = () => ({
    files: [
        {
            path: READ_TARGET,
            content: 'alpha',
            startLine: 1,
            endLine: 1,
            truncated: false,
            nextLine: null,
            nextColumn: null,
            nextByte: null,
            bytes: 5,
            sizeBytes: 5
        }
    ],
    truncated: false,
    bytes: 5,
    wireBytes: expect.any(Number),
    contentBudget: 262_144,
    skipped: 0
});

afterAll(() => {
    fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
});

describe('lazy preset tools', () => {
    it('exposes metadata without compiling any body, then compiles once on first call', async () => {
        prepareFixtures();
        compiles.length = 0;

        // Nothing has been compiled yet.
        expect(compiles).toEqual([]);

        const { presetTools } = await import('./index');

        // Full metadata is available — the description the model reads, the tags
        // discovery matches (or the visibility flag), and the schema the harness
        // declares — with no body compiled.
        expect(presetTools.read.name).toBe('read');
        // The description is pinned in full by the manifest consistency check, so
        // restating the whole string here only makes every wording change break two
        // tests. What THIS test is about is that the complete descriptor — prose
        // included — is readable with no body compiled, so it asserts the shape and a
        // few load-bearing phrases rather than the exact sentence.
        expect(presetTools.read.description.length).toBeGreaterThan(1000);
        for (const phrase of [
            'Read a BOUNDED window of one or more UTF-8 text files',
            'startByte',
            'nextByte',
            '256 KiB budget measured on the SERIALIZED JSON',
            'EBINARY',
            'maxLines 5000'
        ]) {
            expect(presetTools.read.description).toContain(phrase);
        }
        expect(presetTools.read.tags).toEqual(['files', 'read', 'filesystem']);
        // Core by catalogue metadata (R18): declared up front, but that changes no
        // laziness property — the body still compiles only on first call.
        expect(presetTools.read.visibility).toBe('core');
        expect(presetTools.read.parameters).toEqual({
            type: 'object',
            properties: {
                paths: {
                    type: 'array',
                    maxItems: 100,
                    items: {
                        oneOf: [
                            { type: 'string' },
                            {
                                type: 'object',
                                properties: {
                                    path: {
                                        type: 'string',
                                        description:
                                            'File to read, absolute or relative to the working directory.'
                                    },
                                    startLine: {
                                        type: 'integer',
                                        minimum: 1,
                                        description:
                                            '1-based first line to return. Defaults to 1.'
                                    },
                                    startColumn: {
                                        type: 'integer',
                                        minimum: 0,
                                        description:
                                            '0-based UTF-8 byte offset within startLine, for continuing a giant line. Defaults to 0.'
                                    },
                                    startByte: {
                                        type: 'integer',
                                        minimum: 0,
                                        description:
                                            'Absolute 0-based UTF-8 byte offset to seek to, skipping the line count. Feed back a previous nextByte. Defaults to null (count from the start).'
                                    },
                                    maxLines: {
                                        type: 'integer',
                                        minimum: 1,
                                        maximum: 20_000,
                                        description:
                                            'Maximum lines to return. Defaults to 5000 and is capped at 20000.'
                                    }
                                },
                                required: ['path'],
                                additionalProperties: false
                            }
                        ]
                    },
                    description:
                        'Files to read, in the order the results are returned. A string reads a default window; an object selects a line/byte range.'
                }
            },
            required: ['paths'],
            additionalProperties: false
        });

        // Still nothing compiled: metadata is descriptor data, not a body.
        expect(compiles).toEqual([]);

        // First execution compiles the entry the descriptor was scanned from.
        await expect(presetTools.read([READ_TARGET])).resolves.toEqual(readAlphaExpected());
        expect(compiles).toEqual([
            { sourcePath: 'tools/files/read.tool.ts', expectedName: 'read' }
        ]);

        // The proxy caches its successful resolve: a second call compiles nothing.
        await expect(presetTools.read([READ_TARGET])).resolves.toEqual(readAlphaExpected());
        expect(compiles).toHaveLength(1);
    });

    it('recompiles on every direct loadPresetTool call (no cross-call body cache)', async () => {
        prepareFixtures();
        compiles.length = 0;

        const { loadPresetTool } = await import('./descriptors');

        // Two direct resolutions, two compilations: the seam deliberately keeps no
        // compiled body, so an entry edited between calls is never served stale.
        const first = await loadPresetTool('read');
        const second = await loadPresetTool('read');

        expect(compiles).toEqual([
            { sourcePath: 'tools/files/read.tool.ts', expectedName: 'read' },
            { sourcePath: 'tools/files/read.tool.ts', expectedName: 'read' }
        ]);

        // Both are genuinely usable and carry the entry's own metadata.
        expect(first.name).toBe('read');
        expect(second.name).toBe('read');
        expect(first.description).toBe(second.description);
        await expect(first([READ_TARGET])).resolves.toEqual(readAlphaExpected());
        // Invoking a resolved tool compiles nothing further.
        expect(compiles).toHaveLength(2);
    });

    it('defers the harness execute path as well', async () => {
        prepareFixtures();
        compiles.length = 0;

        const { presetTools } = await import('./index');

        // `execute` is what the harness calls; it must defer exactly like the
        // callable and reach the real body.
        await expect(
            presetTools.edit.execute({
                parameters: [{ path: EDIT_TARGET, oldString: 'before', newString: 'after' }]
            })
        ).resolves.toEqual([{ path: EDIT_TARGET, replacements: 1, bytes: 11 }]);
        expect(compiles).toEqual([
            { sourcePath: 'tools/files/edit.tool.ts', expectedName: 'edit' }
        ]);
        expect(fs.readFileSync(EDIT_TARGET, 'utf8')).toBe('after value');

        // The callable shares the same proxy resolve: still one compile, and the
        // second edit applies to the bytes the first one wrote.
        await expect(
            presetTools.edit([
                { path: EDIT_TARGET, oldString: 'after', newString: 'final' }
            ])
        ).resolves.toEqual([{ path: EDIT_TARGET, replacements: 1, bytes: 11 }]);
        expect(compiles).toHaveLength(1);
        expect(fs.readFileSync(EDIT_TARGET, 'utf8')).toBe('final value');
    });
});

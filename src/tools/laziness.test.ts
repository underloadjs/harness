// Lazy preset loading (R1b) — proven against the REAL compiled tool bodies.
//
// HISTORY
// -------
// This file used to mock `./files/fileRead.tool` and `./files/fileEdit.tool` and
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

// One fresh fixture set per test: `fileEdit` mutates its target, so the exact
// expected bytes below depend on starting from these contents every time.
const prepareFixtures = (): void => {
    fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
    fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
    fs.writeFileSync(READ_TARGET, 'alpha', 'utf8');
    fs.writeFileSync(EDIT_TARGET, 'before value', 'utf8');
};

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
        expect(presetTools.fileRead.name).toBe('fileRead');
        expect(presetTools.fileRead.description).toBe(
            'Read a BOUNDED window of one or more UTF-8 text files. Each `paths` item is either a path string (defaults below) or { path, startLine, startColumn, maxLines }. Returns { files: [{ path, content, startLine, endLine, truncated, nextLine, nextColumn, bytes, error? }], truncated, bytes, contentBudget }. Defaults: startLine 1, startColumn 0, maxLines 200 (hard maximum 5000). `content` is raw text whose first line is file line `startLine`, so line numbering is metadata rather than prefixes. When an entry is truncated, request { path, startLine: nextLine, startColumn: nextColumn } to continue; nextColumn is 0 at a line boundary and non-zero only when a single huge line was cut mid-line. The whole batch shares a fixed 64 KiB UTF-8 CONTENT budget (not counting JSON escaping), split fairly between the requested files, and reading stops at that budget instead of loading huge files or lines wholesale. A call accepts at most 100 paths. A path that does not exist is reported IN PLACE as its own ordered entry with empty `content`, `bytes` 0, and `error: { code: "ENOENT", message }`; it consumes no content budget and the other files are still read. Every other failure - an invalid request, a directory (use fileList or fileGlob for those), binary bytes (NUL or invalid UTF-8) encountered while streaming the file, or any other filesystem error - rejects the whole call, so a short answer never looks complete. Binary detection covers decoded chunks, not the whole file beyond the last chunk read. A window at a deep line rescans from the start to count lines. Paths are absolute or relative to the working directory.'
        );
        expect(presetTools.fileRead.tags).toEqual(['files', 'read', 'filesystem']);
        // Core by catalogue metadata (R18): declared up front, but that changes no
        // laziness property — the body still compiles only on first call.
        expect(presetTools.fileRead.visibility).toBe('core');
        expect(presetTools.fileRead.parameters).toEqual({
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
                                    maxLines: {
                                        type: 'integer',
                                        minimum: 1,
                                        maximum: 5000,
                                        description:
                                            'Maximum lines to return. Defaults to 200 and is capped at 5000.'
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
        await expect(presetTools.fileRead([READ_TARGET])).resolves.toEqual({
            files: [
                {
                    path: READ_TARGET,
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
        });
        expect(compiles).toEqual([
            { sourcePath: 'tools/files/fileRead.tool.ts', expectedName: 'fileRead' }
        ]);

        // The proxy caches its successful resolve: a second call compiles nothing.
        await expect(presetTools.fileRead([READ_TARGET])).resolves.toEqual({
            files: [
                {
                    path: READ_TARGET,
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
        });
        expect(compiles).toHaveLength(1);
    });

    it('recompiles on every direct loadPresetTool call (no cross-call body cache)', async () => {
        prepareFixtures();
        compiles.length = 0;

        const { loadPresetTool } = await import('./descriptors');

        // Two direct resolutions, two compilations: the seam deliberately keeps no
        // compiled body, so an entry edited between calls is never served stale.
        const first = await loadPresetTool('fileRead');
        const second = await loadPresetTool('fileRead');

        expect(compiles).toEqual([
            { sourcePath: 'tools/files/fileRead.tool.ts', expectedName: 'fileRead' },
            { sourcePath: 'tools/files/fileRead.tool.ts', expectedName: 'fileRead' }
        ]);

        // Both are genuinely usable and carry the entry's own metadata.
        expect(first.name).toBe('fileRead');
        expect(second.name).toBe('fileRead');
        expect(first.description).toBe(second.description);
        await expect(first([READ_TARGET])).resolves.toEqual({
            files: [
                {
                    path: READ_TARGET,
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
        });
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
            presetTools.fileEdit.execute({
                parameters: [{ path: EDIT_TARGET, oldString: 'before', newString: 'after' }]
            })
        ).resolves.toEqual([{ path: EDIT_TARGET, replacements: 1, bytes: 11 }]);
        expect(compiles).toEqual([
            { sourcePath: 'tools/files/fileEdit.tool.ts', expectedName: 'fileEdit' }
        ]);
        expect(fs.readFileSync(EDIT_TARGET, 'utf8')).toBe('after value');

        // The callable shares the same proxy resolve: still one compile, and the
        // second edit applies to the bytes the first one wrote.
        await expect(
            presetTools.fileEdit([
                { path: EDIT_TARGET, oldString: 'after', newString: 'final' }
            ])
        ).resolves.toEqual([{ path: EDIT_TARGET, replacements: 1, bytes: 11 }]);
        expect(compiles).toHaveLength(1);
        expect(fs.readFileSync(EDIT_TARGET, 'utf8')).toBe('final value');
    });
});

// Lazy preset loading (R1b) — proven with mocked implementation modules.
//
// If anything imported an implementation eagerly, the mock factory below would run
// during `import('./index')`. The counters therefore measure the real property we
// care about: metadata is enumerable with zero implementation imports, and the body
// is imported exactly once, on first execution.
//
// Two tools are mocked so the callable path and the harness `execute` path are
// each covered. T14: the modules are `./files/fileRead` and `./files/fileEdit`, and
// the batched file tools take the array their single schema property declares.

import { describe, expect, it, vi } from 'vitest';

const loads = vi.hoisted(() => ({ fileRead: 0, fileEdit: 0 }));

// A fake implementation is just the callable the proxy delegates to. Keeping it
// minimal avoids re-implementing Tool metadata here (a function's `name` is
// read-only, so Object.assign would throw for example).
vi.mock('./files/fileRead', () => {
    loads.fileRead += 1;

    return {
        fileRead: async (paths: (string | { path: string })[]) => {
            const files = paths.map((target) => {
                const path = typeof target === 'string' ? target : target.path;
                const content = `mocked read:${path}`;
                return {
                    path,
                    content,
                    startLine: 1,
                    endLine: 1,
                    truncated: false,
                    nextLine: null,
                    nextColumn: null,
                    bytes: Buffer.byteLength(content, 'utf8')
                };
            });

            return {
                files,
                truncated: false,
                bytes: files.reduce((total, file) => total + file.bytes, 0),
                contentBudget: 65536
            };
        }
    };
});

// fileEdit also needs an `execute`, because the harness calls that property
// directly instead of invoking the callable.
vi.mock('./files/fileEdit', () => {
    loads.fileEdit += 1;

    const fileEdit = async (edits: { oldString: string }[]) =>
        edits.map((edit) => ({ path: 'x', replacements: 1, bytes: edit.oldString.length }));

    Object.assign(fileEdit, {
        execute: async ({ parameters }: { parameters: { oldString: string }[] }) =>
            `mocked execute:${parameters[0].oldString}`
    });

    return { fileEdit };
});

describe('lazy preset tools', () => {
    it('exposes metadata without loading any implementation, then loads once on call', async () => {
        // Nothing has been imported yet: both counters start at zero.
        expect(loads).toEqual({ fileRead: 0, fileEdit: 0 });

        const { presetTools } = await import('./index');

        // Full metadata is available — the description the model reads, the tags
        // discovery matches (or the visibility flag), and the schema the harness
        // declares - with no body.
        expect(presetTools.fileRead.name).toBe('fileRead');
        expect(presetTools.fileRead.description).toBe(
            'Read a BOUNDED window of one or more UTF-8 text files. Each `paths` item is either a path string (defaults below) or { path, startLine, startColumn, maxLines }. Returns { files: [{ path, content, startLine, endLine, truncated, nextLine, nextColumn, bytes }], truncated, bytes, contentBudget }. Defaults: startLine 1, startColumn 0, maxLines 200 (hard maximum 5000). `content` is raw text whose first line is file line `startLine`, so line numbering is metadata rather than prefixes. When an entry is truncated, request { path, startLine: nextLine, startColumn: nextColumn } to continue; nextColumn is 0 at a line boundary and non-zero only when a single huge line was cut mid-line. The whole batch shares a fixed 64 KiB UTF-8 CONTENT budget (not counting JSON escaping), split fairly between the requested files, and reading stops at that budget instead of loading huge files or lines wholesale. A call accepts at most 100 paths. One missing or unreadable path, or binary bytes (NUL or invalid UTF-8) encountered while streaming the file, rejects the whole call, so a short answer never looks complete. Binary detection covers decoded chunks, not the whole file beyond the last chunk read. A window at a deep line rescans from the start to count lines. Paths are absolute or relative to the working directory.'
        );
        expect(presetTools.fileRead.tags).toEqual(['files', 'read', 'filesystem']);
        // Core by catalogue metadata (R18): declared up front, but that changes no
        // laziness property — the body still loads only on first call.
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
                                        description: '1-based first line to return. Defaults to 1.'
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

        // Still no implementation import.
        expect(loads).toEqual({ fileRead: 0, fileEdit: 0 });

        await expect(presetTools.fileRead(['a.txt'])).resolves.toEqual({
            files: [
                {
                    path: 'a.txt',
                    content: 'mocked read:a.txt',
                    startLine: 1,
                    endLine: 1,
                    truncated: false,
                    nextLine: null,
                    nextColumn: null,
                    bytes: 17
                }
            ],
            truncated: false,
            bytes: 17,
            contentBudget: 65536
        });
        expect(loads.fileRead).toBe(1);

        // The module is cached: a second call does not re-import.
        await expect(presetTools.fileRead(['b.txt'])).resolves.toEqual({
            files: [
                {
                    path: 'b.txt',
                    content: 'mocked read:b.txt',
                    startLine: 1,
                    endLine: 1,
                    truncated: false,
                    nextLine: null,
                    nextColumn: null,
                    bytes: 17
                }
            ],
            truncated: false,
            bytes: 17,
            contentBudget: 65536
        });
        expect(loads.fileRead).toBe(1);
    });

    it('defers the harness execute path as well', async () => {
        const { presetTools } = await import('./index');

        await expect(
            presetTools.fileEdit.execute({ parameters: [{ oldString: 'before' }] })
        ).resolves.toBe('mocked execute:before');
        expect(loads.fileEdit).toBe(1);

        await expect(presetTools.fileEdit([{ oldString: 'after' }])).resolves.toEqual([
            { path: 'x', replacements: 1, bytes: 5 }
        ]);
        expect(loads.fileEdit).toBe(1);
    });
});

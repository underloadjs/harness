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
        fileRead: async (paths: string[]) => paths.map((path) => ({ path, content: `mocked read:${path}` }))
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
            'Read one or more UTF-8 text files and return their contents. Pass an array of paths and get an ordered array of { path, content } entries in the same order. One missing or unreadable path rejects the whole call, so a short answer never looks complete. Paths are absolute or relative to the working directory.'
        );
        expect(presetTools.fileRead.tags).toEqual(['files', 'read', 'filesystem']);
        // Searchable by catalogue metadata: discovery must enable it, but that
        // changes no laziness property.
        expect(presetTools.fileRead.visibility).toBe('searchable');
        expect(presetTools.fileRead.parameters).toEqual({
            type: 'object',
            properties: {
                paths: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Files to read, absolute or relative to the working directory, in the order the results are returned.'
                }
            },
            required: ['paths'],
            additionalProperties: false
        });

        // Still no implementation import.
        expect(loads).toEqual({ fileRead: 0, fileEdit: 0 });

        await expect(presetTools.fileRead(['a.txt'])).resolves.toEqual([
            { path: 'a.txt', content: 'mocked read:a.txt' }
        ]);
        expect(loads.fileRead).toBe(1);

        // The module is cached: a second call does not re-import.
        await expect(presetTools.fileRead(['b.txt'])).resolves.toEqual([
            { path: 'b.txt', content: 'mocked read:b.txt' }
        ]);
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

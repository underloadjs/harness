// Lazy preset loading (R1b) — proven with mocked implementation modules.
//
// If anything imported an implementation eagerly, the mock factory below would run
// during `import('./index')`. The counters therefore measure the real property we
// care about: metadata is enumerable with zero implementation imports, and the body
// is imported exactly once, on first execution.
//
// Two tools are mocked so the callable path and the harness `execute` path are
// each covered.

import { describe, expect, it, vi } from 'vitest';

const loads = vi.hoisted(() => ({ readFile: 0, editFile: 0 }));

// A fake implementation is just the callable the proxy delegates to. Keeping it
// minimal avoids re-implementing Tool metadata here (a function's `name` is
// read-only, so Object.assign would throw for example).
vi.mock('./files/readFile', () => {
    loads.readFile += 1;

    return { readFile: async (path: string) => `mocked read:${path}` };
});

// editFile also needs an `execute`, because the harness calls that property
// directly instead of invoking the callable.
vi.mock('./files/editFile', () => {
    loads.editFile += 1;

    const editFile = async (parameters: { oldString: string }) => `mocked edit:${parameters.oldString}`;

    Object.assign(editFile, {
        execute: async ({ parameters }: { parameters: { oldString: string } }) =>
            `mocked execute:${parameters.oldString}`
    });

    return { editFile };
});

describe('lazy preset tools', () => {
    it('exposes metadata without loading any implementation, then loads once on call', async () => {
        // Nothing has been imported yet: both counters start at zero.
        expect(loads).toEqual({ readFile: 0, editFile: 0 });

        const { presetTools } = await import('./index');

        // Full metadata is available — the description the model reads, the tags
        // getTools matches, and the schema the harness declares — with no body.
        expect(presetTools.readFile.name).toBe('readFile');
        expect(presetTools.readFile.description).toBe('Read a UTF-8 text file from disk and return its contents. Throws when the file does not exist or is not readable.');
        expect(presetTools.readFile.tags).toEqual(['files', 'read', 'filesystem']);
        expect(presetTools.readFile.visibility).toBe('searchable');
        expect(presetTools.readFile.parameters).toEqual({
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Path to the file, absolute or relative to the working directory.' }
            },
            required: ['path'],
            additionalProperties: false
        });

        // Still no implementation import.
        expect(loads).toEqual({ readFile: 0, editFile: 0 });

        await expect(presetTools.readFile('a.txt')).resolves.toBe('mocked read:a.txt');
        expect(loads.readFile).toBe(1);

        // The module is cached: a second call does not re-import.
        await expect(presetTools.readFile('b.txt')).resolves.toBe('mocked read:b.txt');
        expect(loads.readFile).toBe(1);
    });

    it('defers the harness execute path as well', async () => {
        const { presetTools } = await import('./index');

        await expect(presetTools.editFile.execute({ parameters: { oldString: 'before' } })).resolves.toBe(
            'mocked execute:before'
        );
        expect(loads.editFile).toBe(1);

        await expect(presetTools.editFile({ oldString: 'after' })).resolves.toBe('mocked edit:after');
        expect(loads.editFile).toBe(1);
    });
});

// locationManage — the per-harness session location store (core/location.ts).
//
// Unit tests for the factory: exact result envelopes, trimming/defaults, partial
// update semantics, validation errors (all non-destructive), defensive copies,
// reset, and isolation. Harness integration lives in src/harness.records.test.ts;
// the full metadata/schema pin lives in src/harness.metadata.test.ts.

import { describe, expect, it } from 'vitest';
import { createLocationTool } from './location';

const empty = {
    locations: [],
    counts: { total: 0 }
};

describe('createLocationTool', () => {
    it('exposes the exact wire name, core visibility, and location tags', () => {
        const { tool } = createLocationTool();

        expect(tool.name).toBe('locationManage');
        expect(tool.visibility).toBe('core');
        expect(tool.tags).toEqual(['location', 'locations', 'place', 'places', 'setting', 'world']);
    });

    it('starts empty and lists an empty snapshot', async () => {
        const { tool } = createLocationTool();

        expect(await tool({ action: 'list' })).toEqual(empty);
    });

    it('adds a trimmed location with defaults and monotonic ids', async () => {
        const { tool } = createLocationTool();

        expect(
            await tool({
                action: 'add',
                name: '  The Archive  ',
                description: '  A buried library.  ',
                notes: '  damp  '
            })
        ).toEqual({
            locations: [
                { id: '1', name: 'The Archive', description: 'A buried library.', notes: 'damp' }
            ],
            location: {
                id: '1',
                name: 'The Archive',
                description: 'A buried library.',
                notes: 'damp'
            },
            counts: { total: 1 }
        });

        expect(await tool({ action: 'add', name: 'Harbour', description: 'A port.' })).toEqual({
            locations: [
                { id: '1', name: 'The Archive', description: 'A buried library.', notes: 'damp' },
                { id: '2', name: 'Harbour', description: 'A port.', notes: '' }
            ],
            location: { id: '2', name: 'Harbour', description: 'A port.', notes: '' },
            counts: { total: 2 }
        });
    });

    it('gets one location by id without changing the list', async () => {
        const { tool } = createLocationTool();
        await tool({ action: 'add', name: 'The Archive', description: 'A buried library.' });

        expect(await tool({ action: 'get', id: '1' })).toEqual({
            locations: [
                { id: '1', name: 'The Archive', description: 'A buried library.', notes: '' }
            ],
            location: {
                id: '1',
                name: 'The Archive',
                description: 'A buried library.',
                notes: ''
            },
            counts: { total: 1 }
        });
    });

    it('updates only the supplied fields (partial semantics)', async () => {
        const { tool } = createLocationTool();
        await tool({
            action: 'add',
            name: 'The Archive',
            description: 'A buried library.',
            notes: 'first'
        });
        await tool({ action: 'add', name: 'Harbour', description: 'A port.' });

        expect(await tool({ action: 'update', id: '1', description: 'A flooded library.' })).toEqual({
            locations: [
                {
                    id: '1',
                    name: 'The Archive',
                    description: 'A flooded library.',
                    notes: 'first'
                },
                { id: '2', name: 'Harbour', description: 'A port.', notes: '' }
            ],
            location: {
                id: '1',
                name: 'The Archive',
                description: 'A flooded library.',
                notes: 'first'
            },
            counts: { total: 2 }
        });

        // Notes may be cleared with an explicit empty string; name is untouched.
        expect(await tool({ action: 'update', id: '1', notes: '' })).toEqual({
            locations: [
                { id: '1', name: 'The Archive', description: 'A flooded library.', notes: '' },
                { id: '2', name: 'Harbour', description: 'A port.', notes: '' }
            ],
            location: {
                id: '1',
                name: 'The Archive',
                description: 'A flooded library.',
                notes: ''
            },
            counts: { total: 2 }
        });
    });

    it('validates the whole update before applying any field (atomic)', async () => {
        const { tool } = createLocationTool();
        await tool({ action: 'add', name: 'The Archive', description: 'A buried library.' });

        await expect(
            tool({ action: 'update', id: '1', name: 'Changed', notes: 7 } as never)
        ).rejects.toThrow('locationManage "notes" must be a string when provided.');

        expect(await tool({ action: 'list' })).toEqual({
            locations: [{ id: '1', name: 'The Archive', description: 'A buried library.', notes: '' }],
            counts: { total: 1 }
        });
    });

    it('removes one location and returns the removed record', async () => {
        const { tool } = createLocationTool();
        await tool({ action: 'add', name: 'Keep me', description: 'Stays.' });
        await tool({ action: 'add', name: 'Remove me', description: 'Goes.' });

        expect(await tool({ action: 'remove', id: '2' })).toEqual({
            locations: [{ id: '1', name: 'Keep me', description: 'Stays.', notes: '' }],
            removed: { id: '2', name: 'Remove me', description: 'Goes.', notes: '' },
            counts: { total: 1 }
        });
    });

    it('rejects a non-object argument with a readable error', async () => {
        const { tool } = createLocationTool();

        await expect(tool(null as never)).rejects.toThrow(
            'locationManage expects an object with an "action" (add, list, get, update, remove).'
        );
        await expect(tool([] as never)).rejects.toThrow(
            'locationManage expects an object with an "action" (add, list, get, update, remove).'
        );
    });

    it('rejects a missing, unknown, or non-string action', async () => {
        const { tool } = createLocationTool();
        const message =
            'locationManage requires "action" to be one of: add, list, get, update, remove.';

        await expect(tool({} as never)).rejects.toThrow(message);
        await expect(tool({ action: 'move' } as never)).rejects.toThrow(message);
        await expect(tool({ action: 1 } as never)).rejects.toThrow(message);
    });

    it('rejects a missing or blank add name/description without consuming an id', async () => {
        const { tool } = createLocationTool();

        await expect(tool({ action: 'add', description: 'No name.' })).rejects.toThrow(
            'locationManage "add" requires a non-empty "name" string.'
        );
        await expect(tool({ action: 'add', name: '  ', description: 'Blank name.' })).rejects.toThrow(
            'locationManage "add" requires a non-empty "name" string.'
        );
        await expect(tool({ action: 'add', name: 'No description' })).rejects.toThrow(
            'locationManage "add" requires a non-empty "description" string.'
        );
        await expect(tool({ action: 'add', name: 'Blank', description: '  ' })).rejects.toThrow(
            'locationManage "add" requires a non-empty "description" string.'
        );

        expect(await tool({ action: 'list' })).toEqual(empty);

        expect(await tool({ action: 'add', name: 'Fresh', description: 'First.' })).toEqual({
            locations: [{ id: '1', name: 'Fresh', description: 'First.', notes: '' }],
            location: { id: '1', name: 'Fresh', description: 'First.', notes: '' },
            counts: { total: 1 }
        });
    });

    it('rejects missing, blank, or unknown ids for get/update/remove', async () => {
        const { tool } = createLocationTool();
        await tool({ action: 'add', name: 'One', description: 'First.' });

        await expect(tool({ action: 'get' })).rejects.toThrow(
            'locationManage "get" requires a non-empty "id" string.'
        );
        await expect(tool({ action: 'update', id: '  ', notes: 'x' })).rejects.toThrow(
            'locationManage "update" requires a non-empty "id" string.'
        );
        await expect(tool({ action: 'remove' })).rejects.toThrow(
            'locationManage "remove" requires a non-empty "id" string.'
        );

        await expect(tool({ action: 'get', id: '99' })).rejects.toThrow(
            'locationManage has no location with id "99".'
        );
        await expect(tool({ action: 'update', id: '99', name: 'x' })).rejects.toThrow(
            'locationManage has no location with id "99".'
        );
        await expect(tool({ action: 'remove', id: '99' })).rejects.toThrow(
            'locationManage has no location with id "99".'
        );

        expect(await tool({ action: 'list' })).toEqual({
            locations: [{ id: '1', name: 'One', description: 'First.', notes: '' }],
            counts: { total: 1 }
        });
    });

    it('rejects an update that names no mutable field', async () => {
        const { tool } = createLocationTool();
        await tool({ action: 'add', name: 'One', description: 'First.' });

        await expect(tool({ action: 'update', id: '1' })).rejects.toThrow(
            'locationManage "update" requires at least one of: name, description, notes.'
        );

        expect(await tool({ action: 'list' })).toEqual({
            locations: [{ id: '1', name: 'One', description: 'First.', notes: '' }],
            counts: { total: 1 }
        });
    });

    it('rejects invalid field types consistently across actions', async () => {
        const { tool } = createLocationTool();
        await tool({ action: 'add', name: 'One', description: 'First.' });

        await expect(tool({ action: 'list', name: 7 } as never)).rejects.toThrow(
            'locationManage "name" must be a string when provided.'
        );
        await expect(tool({ action: 'list', description: false } as never)).rejects.toThrow(
            'locationManage "description" must be a string when provided.'
        );
        await expect(tool({ action: 'list', notes: 7 } as never)).rejects.toThrow(
            'locationManage "notes" must be a string when provided.'
        );
        await expect(tool({ action: 'list', id: 1 } as never)).rejects.toThrow(
            'locationManage "id" must be a string when provided.'
        );
    });

    it('returns defensive copies of the list, location, and removed', async () => {
        const { tool } = createLocationTool();

        const added = await tool({ action: 'add', name: 'Original', description: 'Original.' });
        added.locations[0].name = 'mutated';
        added.location!.notes = 'mutated notes';

        const listed = await tool({ action: 'list' });
        listed.locations[0].description = 'mutated description';

        const updated = await tool({ action: 'update', id: '1', notes: 'real notes' });
        updated.location!.name = 'mutated again';

        expect(await tool({ action: 'list' })).toEqual({
            locations: [
                { id: '1', name: 'Original', description: 'Original.', notes: 'real notes' }
            ],
            counts: { total: 1 }
        });

        const removed = await tool({ action: 'remove', id: '1' });
        removed.removed!.name = 'mutated removal';

        expect(removed.removed!.name).toBe('mutated removal');
        expect(await tool({ action: 'list' })).toEqual(empty);
    });

    it('resets the list and the id sequence', async () => {
        const { tool, reset } = createLocationTool();
        await tool({ action: 'add', name: 'One', description: 'First.' });
        await tool({ action: 'add', name: 'Two', description: 'Second.' });

        reset();

        expect(await tool({ action: 'list' })).toEqual(empty);
        expect(await tool({ action: 'add', name: 'Fresh', description: 'After reset.' })).toEqual({
            locations: [{ id: '1', name: 'Fresh', description: 'After reset.', notes: '' }],
            location: { id: '1', name: 'Fresh', description: 'After reset.', notes: '' },
            counts: { total: 1 }
        });
    });

    it('keeps separate factory instances isolated', async () => {
        const first = createLocationTool();
        const second = createLocationTool();

        await first.tool({ action: 'add', name: 'Only in first', description: 'Mine.' });

        expect(await second.tool({ action: 'list' })).toEqual(empty);
        expect(await first.tool({ action: 'list' })).toEqual({
            locations: [{ id: '1', name: 'Only in first', description: 'Mine.', notes: '' }],
            counts: { total: 1 }
        });
    });
});

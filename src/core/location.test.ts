// locationManage — the per-harness session location store (core/location.ts).
//
// Unit tests for the factory: exact result envelopes, trimming/defaults, partial
// update semantics, validation errors (all non-destructive), defensive copies,
// reset, isolation, and the R9 bounds (record cap, field caps, pagination, byte
// budget, compact mutation results). Harness integration lives in
// src/harness.records.test.ts; the full metadata/schema pin lives in
// src/harness.metadata.test.ts.

import { describe, expect, it } from 'vitest';
import {
    createLocationTool,
    LOCATION_LIST_MAX_LIMIT,
    LOCATION_MAX_NAME,
    LOCATION_MAX_RECORDS,
    LOCATION_MAX_TEXT
} from './location';
import type { LocationChangeResult, LocationListResult, LocationResult } from './location';

// `LocationResult` is a union (page vs. change). These helpers narrow it in tests
// without widening the production contract.
const listOf = (result: LocationResult): LocationListResult => result as LocationListResult;
const changeOf = (result: LocationResult): LocationChangeResult => result as LocationChangeResult;

// The default page cursor: offset 0, the default limit, and no further pages.
const firstPage = { offset: 0, limit: 20, hasMore: false };

const empty = {
    locations: [],
    counts: { total: 0 },
    page: firstPage
};

// Deterministic ASCII filler: UTF-8 size equals string length, so the
// byte-budget assertions below stay exact.
const filler = (length: number): string => 'x'.repeat(length);

describe('createLocationTool', () => {
    it('exposes the exact wire name, core visibility, and location tags', () => {
        const { tool } = createLocationTool();

        expect(tool.name).toBe('locationManage');
        expect(tool.visibility).toBe('core');
        expect(tool.tags).toEqual(['location', 'locations', 'place', 'places', 'setting', 'world']);
    });

    it('starts empty and lists an empty page', async () => {
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
            location: {
                id: '1',
                name: 'The Archive',
                description: 'A buried library.',
                notes: 'damp'
            },
            counts: { total: 1 }
        });

        expect(await tool({ action: 'add', name: 'Harbour', description: 'A port.' })).toEqual({
            location: { id: '2', name: 'Harbour', description: 'A port.', notes: '' },
            counts: { total: 2 }
        });

        // The list is a separate, bounded page call.
        expect(await tool({ action: 'list' })).toEqual({
            locations: [
                { id: '1', name: 'The Archive', description: 'A buried library.', notes: 'damp' },
                { id: '2', name: 'Harbour', description: 'A port.', notes: '' }
            ],
            counts: { total: 2 },
            page: firstPage
        });
    });

    it('gets one location by id without changing the store', async () => {
        const { tool } = createLocationTool();
        await tool({ action: 'add', name: 'The Archive', description: 'A buried library.' });

        expect(await tool({ action: 'get', id: '1' })).toEqual({
            location: { id: '1', name: 'The Archive', description: 'A buried library.', notes: '' },
            counts: { total: 1 }
        });
    });

    it('updates only the supplied fields (partial semantics)', async () => {
        const { tool } = createLocationTool();
        await tool({
            action: 'add',
            name: 'The Archive',
            description: 'A buried library.',
            notes: 'damp'
        });

        // Notes only: name and description are untouched.
        expect(await tool({ action: 'update', id: '1', notes: 'dry' })).toEqual({
            location: {
                id: '1',
                name: 'The Archive',
                description: 'A buried library.',
                notes: 'dry'
            },
            counts: { total: 1 }
        });

        // Notes may be cleared to the empty string.
        expect(await tool({ action: 'update', id: '1', notes: '' })).toEqual({
            location: {
                id: '1',
                name: 'The Archive',
                description: 'A buried library.',
                notes: ''
            },
            counts: { total: 1 }
        });
    });

    it('validates the whole update before applying any field (atomic)', async () => {
        const { tool } = createLocationTool();
        await tool({ action: 'add', name: 'The Archive', description: 'A buried library.' });

        // `name` is valid, `description` is blank: nothing may be applied.
        await expect(
            tool({ action: 'update', id: '1', name: 'Changed', description: '   ' })
        ).rejects.toThrow('locationManage "update" requires a non-empty "description" string.');

        // An oversized later field must not leave the earlier one applied either.
        await expect(
            tool({
                action: 'update',
                id: '1',
                name: 'Changed',
                notes: filler(LOCATION_MAX_TEXT + 1)
            })
        ).rejects.toThrow(
            'locationManage "notes" is 4001 characters; the limit is 4000. Shorten it and retry.'
        );

        expect(await tool({ action: 'list' })).toEqual({
            locations: [
                { id: '1', name: 'The Archive', description: 'A buried library.', notes: '' }
            ],
            counts: { total: 1 },
            page: firstPage
        });
    });

    it('removes one location and returns the removed record and counts only', async () => {
        const { tool } = createLocationTool();
        await tool({ action: 'add', name: 'Keep me', description: 'Stays.' });
        await tool({ action: 'add', name: 'Remove me', description: 'Goes.' });

        expect(await tool({ action: 'remove', id: '2' })).toEqual({
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
        await expect(tool({ action: 'visit' } as never)).rejects.toThrow(message);
        await expect(tool({ action: 1 } as never)).rejects.toThrow(message);
    });

    it('rejects a missing or blank add name/description without consuming an id', async () => {
        const { tool } = createLocationTool();

        await expect(tool({ action: 'add', description: 'No name.' })).rejects.toThrow(
            'locationManage "add" requires a non-empty "name" string.'
        );
        await expect(tool({ action: 'add', name: '   ', description: 'Blank name.' })).rejects.toThrow(
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
            location: { id: '1', name: 'Fresh', description: 'First.', notes: '' },
            counts: { total: 1 }
        });
    });

    it('rejects fields over their character caps and accepts exactly the cap', async () => {
        const { tool } = createLocationTool();

        await expect(
            tool({ action: 'add', name: filler(LOCATION_MAX_NAME + 1), description: 'Fine.' })
        ).rejects.toThrow(
            'locationManage "name" is 201 characters; the limit is 200. Shorten it and retry.'
        );
        await expect(
            tool({ action: 'add', name: 'Fine', description: filler(LOCATION_MAX_TEXT + 1) })
        ).rejects.toThrow(
            'locationManage "description" is 4001 characters; the limit is 4000. Shorten it and retry.'
        );
        await expect(
            tool({ action: 'add', name: 'Fine', description: 'Fine.', notes: filler(LOCATION_MAX_TEXT + 1) })
        ).rejects.toThrow(
            'locationManage "notes" is 4001 characters; the limit is 4000. Shorten it and retry.'
        );

        expect(await tool({ action: 'list' })).toEqual(empty);

        const added = changeOf(
            await tool({
                action: 'add',
                name: filler(LOCATION_MAX_NAME),
                description: filler(LOCATION_MAX_TEXT),
                notes: filler(LOCATION_MAX_TEXT)
            })
        );

        expect(added.location!.name.length).toBe(200);
        expect(added.location!.description.length).toBe(4000);
        expect(added.location!.notes.length).toBe(4000);
    });

    it('caps the store at 200 locations and never drops a stored location', async () => {
        const { tool } = createLocationTool();

        for (let index = 1; index <= LOCATION_MAX_RECORDS; index++) {
            await tool({ action: 'add', name: `Location ${index}`, description: 'One.' });
        }

        await expect(
            tool({ action: 'add', name: 'One too many', description: 'Two.' })
        ).rejects.toThrow(
            'locationManage already holds the maximum of 200 locations; remove one before adding another.'
        );

        const listed = listOf(await tool({ action: 'list', limit: LOCATION_LIST_MAX_LIMIT }));

        expect(listed.counts).toEqual({ total: 200 });
        expect(listed.locations.length).toBe(100);
        expect(listed.locations[0]).toEqual({
            id: '1',
            name: 'Location 1',
            description: 'One.',
            notes: ''
        });

        // A freed slot continues the id sequence: ids are never recycled.
        await tool({ action: 'remove', id: '1' });
        expect(
            changeOf(await tool({ action: 'add', name: 'Replacement', description: 'Again.' })).location
        ).toEqual({ id: '201', name: 'Replacement', description: 'Again.', notes: '' });
    });

    it('paginates the list with default offset 0 and limit 20', async () => {
        const { tool } = createLocationTool();

        for (let index = 1; index <= 25; index++) {
            await tool({ action: 'add', name: `Location ${index}`, description: 'One.' });
        }

        const first = listOf(await tool({ action: 'list' }));

        expect(first.page).toEqual({ offset: 0, limit: 20, hasMore: true, nextOffset: 20 });
        expect(first.locations.length).toBe(20);
        expect(first.counts).toEqual({ total: 25 });

        const second = listOf(await tool({ action: 'list', offset: 20 }));

        // `nextOffset` is absent on the last page rather than null.
        expect(second.page).toEqual({ offset: 20, limit: 20, hasMore: false });
        expect(second.locations.map((location) => location.id)).toEqual([
            '21',
            '22',
            '23',
            '24',
            '25'
        ]);

        expect(await tool({ action: 'list', offset: 25 })).toEqual({
            locations: [],
            counts: { total: 25 },
            page: { offset: 25, limit: 20, hasMore: false }
        });
    });

    it('rejects an out-of-range offset or limit and validates them on every action', async () => {
        const { tool } = createLocationTool();

        await expect(tool({ action: 'list', limit: 0 } as never)).rejects.toThrow(
            'locationManage "limit" must be an integer between 1 and 100 when provided.'
        );
        await expect(tool({ action: 'list', limit: 101 } as never)).rejects.toThrow(
            'locationManage "limit" must be an integer between 1 and 100 when provided.'
        );
        await expect(tool({ action: 'list', offset: -1 } as never)).rejects.toThrow(
            'locationManage "offset" must be a non-negative integer when provided.'
        );
        await expect(
            tool({ action: 'add', name: 'One', description: 'Two.', offset: 1.5 } as never)
        ).rejects.toThrow('locationManage "offset" must be a non-negative integer when provided.');

        expect(await tool({ action: 'list' })).toEqual(empty);
    });

    it('stops a page before the 64 KiB UTF-8 budget so 100 * 4 KB cannot flood context', async () => {
        const { tool } = createLocationTool();

        for (let index = 1; index <= 100; index++) {
            await tool({ action: 'add', name: 'n', description: filler(LOCATION_MAX_TEXT) });
        }

        const oversized = listOf(await tool({ action: 'list', limit: LOCATION_LIST_MAX_LIMIT }));

        // Exactly 16 max-length locations fit under the budget: the serialized
        // page is 64808 UTF-8 bytes (16 records, 15 commas, 2 brackets).
        expect(oversized.locations.length).toBe(16);
        expect(Buffer.byteLength(JSON.stringify(oversized.locations), 'utf8')).toBe(64808);
        expect(oversized.page).toEqual({ offset: 0, limit: 100, hasMore: true, nextOffset: 16 });
        expect(oversized.counts).toEqual({ total: 100 });
    });

    it('walks every location across budget-trimmed pages without gaps', async () => {
        const { tool } = createLocationTool();

        for (let index = 1; index <= 100; index++) {
            await tool({ action: 'add', name: 'n', description: filler(LOCATION_MAX_TEXT) });
        }

        const ids: string[] = [];
        const offsets: number[] = [];
        let offset = 0;
        let hasMore = true;

        while (hasMore) {
            const listed = listOf(await tool({ action: 'list', offset, limit: LOCATION_LIST_MAX_LIMIT }));

            offsets.push(listed.page.offset);
            ids.push(...listed.locations.map((location) => location.id));
            hasMore = listed.page.hasMore;

            if (hasMore) offset = listed.page.nextOffset!;
        }

        expect(offsets).toEqual([0, 16, 32, 48, 64, 80, 96]);
        expect(ids).toEqual(Array.from({ length: 100 }, (_, index) => String(index + 1)));
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
            counts: { total: 1 },
            page: firstPage
        });
    });

    it('rejects an update that names no mutable field', async () => {
        const { tool } = createLocationTool();
        await tool({ action: 'add', name: 'One', description: 'First.' });

        await expect(tool({ action: 'update', id: '1' })).rejects.toThrow(
            'locationManage "update" requires at least one of: name, description, notes.'
        );

        expect(await tool({ action: 'get', id: '1' })).toEqual({
            location: { id: '1', name: 'One', description: 'First.', notes: '' },
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

    it('returns defensive copies of the page, location, and removed', async () => {
        const { tool } = createLocationTool();

        const added = changeOf(
            await tool({ action: 'add', name: 'Original', description: 'Original description.' })
        );
        added.location!.name = 'mutated';

        const listed = listOf(await tool({ action: 'list' }));
        listed.locations[0].description = 'mutated description';

        const updated = changeOf(await tool({ action: 'update', id: '1', notes: 'real notes' }));
        updated.location!.name = 'mutated again';

        expect(await tool({ action: 'list' })).toEqual({
            locations: [
                {
                    id: '1',
                    name: 'Original',
                    description: 'Original description.',
                    notes: 'real notes'
                }
            ],
            counts: { total: 1 },
            page: firstPage
        });

        const removed = changeOf(await tool({ action: 'remove', id: '1' }));
        removed.removed!.description = 'mutated removal';

        expect(removed.removed!.description).toBe('mutated removal');
        expect(await tool({ action: 'list' })).toEqual(empty);
    });

    it('resets the list and the id sequence', async () => {
        const { tool, reset } = createLocationTool();
        await tool({ action: 'add', name: 'One', description: 'First.' });
        await tool({ action: 'add', name: 'Two', description: 'Second.' });

        reset();

        expect(await tool({ action: 'list' })).toEqual(empty);
        expect(await tool({ action: 'add', name: 'Fresh', description: 'After reset.' })).toEqual({
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
            counts: { total: 1 },
            page: firstPage
        });
    });
});

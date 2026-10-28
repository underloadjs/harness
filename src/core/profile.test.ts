// profileManage — the per-harness session profile store (core/profile.ts).
//
// Unit tests for the factory: exact result envelopes, trimming/defaults,
// partial update semantics, validation errors (all non-destructive), defensive
// copies, reset, isolation, and the R9 bounds (record cap, field caps, trait
// caps, pagination, byte budget, compact mutation results). Harness integration
// (declaration, sharing, reservation) lives in src/harness.records.test.ts; the
// full metadata/schema pin lives in src/harness.metadata.test.ts.

import { describe, expect, it } from 'vitest';
import {
    createProfileTool,
    PROFILE_LIST_MAX_LIMIT,
    PROFILE_MAX_NAME,
    PROFILE_MAX_RECORDS,
    PROFILE_MAX_TEXT,
    PROFILE_MAX_TRAITS,
    PROFILE_MAX_TRAIT
} from './profile';
import type { ProfileChangeResult, ProfileListResult, ProfileResult } from './profile';

// `ProfileResult` is a union (page vs. change). These helpers narrow it in tests
// without widening the production contract.
const listOf = (result: ProfileResult): ProfileListResult => result as ProfileListResult;
const changeOf = (result: ProfileResult): ProfileChangeResult => result as ProfileChangeResult;

// The default page cursor: offset 0, the default limit, and no further pages.
const firstPage = { offset: 0, limit: 20, hasMore: false };

const empty = {
    profiles: [],
    counts: { total: 0 },
    page: firstPage
};

// Deterministic ASCII filler: UTF-8 size equals string length, so the
// byte-budget assertions below stay exact.
const filler = (length: number): string => 'x'.repeat(length);

const elena = {
    id: '1',
    name: 'Elena',
    description: 'A cartographer.',
    traits: ['brave', 'loyal'],
    notes: 'keeps maps'
};

describe('createProfileTool', () => {
    it('exposes the exact wire name, core visibility, and profile tags', () => {
        const { tool } = createProfileTool();

        expect(tool.name).toBe('profileManage');
        expect(tool.visibility).toBe('core');
        expect(tool.tags).toEqual(['profile', 'profiles', 'character', 'characters', 'person', 'people']);
    });

    it('starts empty and lists an empty page', async () => {
        const { tool } = createProfileTool();

        expect(await tool({ action: 'list' })).toEqual(empty);
    });

    it('adds a trimmed profile with defaults, deduplicated traits, and a compact result', async () => {
        const { tool } = createProfileTool();

        expect(
            await tool({
                action: 'add',
                name: '  Elena  ',
                description: '  A cartographer.  ',
                traits: [' brave ', 'brave', 'loyal'],
                notes: '  keeps maps  '
            })
        ).toEqual({
            profile: elena,
            counts: { total: 1 }
        });

        // Optional fields default to a stable empty shape rather than disappearing.
        expect(
            await tool({ action: 'add', name: 'Professor Vance', description: 'A rival.' })
        ).toEqual({
            profile: {
                id: '2',
                name: 'Professor Vance',
                description: 'A rival.',
                traits: [],
                notes: ''
            },
            counts: { total: 2 }
        });

        // The list is a separate, bounded page call.
        expect(await tool({ action: 'list' })).toEqual({
            profiles: [
                elena,
                { id: '2', name: 'Professor Vance', description: 'A rival.', traits: [], notes: '' }
            ],
            counts: { total: 2 },
            page: firstPage
        });
    });

    it('gets one profile by id without changing the store', async () => {
        const { tool } = createProfileTool();
        await tool({ action: 'add', name: 'Elena', description: 'A cartographer.' });

        expect(await tool({ action: 'get', id: '1' })).toEqual({
            profile: { id: '1', name: 'Elena', description: 'A cartographer.', traits: [], notes: '' },
            counts: { total: 1 }
        });
    });

    it('updates only the supplied fields (partial semantics)', async () => {
        const { tool } = createProfileTool();
        await tool({
            action: 'add',
            name: 'Elena',
            description: 'A cartographer.',
            traits: ['brave'],
            notes: 'first'
        });
        await tool({ action: 'add', name: 'Vance', description: 'A rival.' });

        // Notes only: name, description, and traits are untouched.
        expect(await tool({ action: 'update', id: '1', notes: 'revised' })).toEqual({
            profile: {
                id: '1',
                name: 'Elena',
                description: 'A cartographer.',
                traits: ['brave'],
                notes: 'revised'
            },
            counts: { total: 2 }
        });

        // An explicitly empty traits array clears them, and notes may be cleared.
        expect(await tool({ action: 'update', id: '1', traits: [], notes: '' })).toEqual({
            profile: {
                id: '1',
                name: 'Elena',
                description: 'A cartographer.',
                traits: [],
                notes: ''
            },
            counts: { total: 2 }
        });

        expect(await tool({ action: 'list' })).toEqual({
            profiles: [
                { id: '1', name: 'Elena', description: 'A cartographer.', traits: [], notes: '' },
                { id: '2', name: 'Vance', description: 'A rival.', traits: [], notes: '' }
            ],
            counts: { total: 2 },
            page: firstPage
        });
    });

    it('validates the whole update before applying any field (atomic)', async () => {
        const { tool } = createProfileTool();
        await tool({ action: 'add', name: 'Elena', description: 'A cartographer.' });

        // `name` is valid, `description` is blank: nothing may be applied.
        await expect(
            tool({ action: 'update', id: '1', name: 'Changed', description: '   ' })
        ).rejects.toThrow('profileManage "update" requires a non-empty "description" string.');

        // An oversized later field must not leave the earlier one applied either.
        await expect(
            tool({ action: 'update', id: '1', name: 'Changed', notes: filler(PROFILE_MAX_TEXT + 1) })
        ).rejects.toThrow(
            'profileManage "notes" is 4001 characters; the limit is 4000. Shorten it and retry.'
        );

        expect(await tool({ action: 'list' })).toEqual({
            profiles: [
                { id: '1', name: 'Elena', description: 'A cartographer.', traits: [], notes: '' }
            ],
            counts: { total: 1 },
            page: firstPage
        });
    });

    it('removes one profile and returns the removed record and counts only', async () => {
        const { tool } = createProfileTool();
        await tool({ action: 'add', name: 'Keep me', description: 'Stays.' });
        await tool({ action: 'add', name: 'Remove me', description: 'Goes.' });

        expect(await tool({ action: 'remove', id: '2' })).toEqual({
            removed: { id: '2', name: 'Remove me', description: 'Goes.', traits: [], notes: '' },
            counts: { total: 1 }
        });
    });

    it('rejects a non-object argument with a readable error', async () => {
        const { tool } = createProfileTool();

        await expect(tool(null as never)).rejects.toThrow(
            'profileManage expects an object with an "action" (add, list, get, update, remove).'
        );
        await expect(tool([] as never)).rejects.toThrow(
            'profileManage expects an object with an "action" (add, list, get, update, remove).'
        );
    });

    it('rejects a missing, unknown, or non-string action', async () => {
        const { tool } = createProfileTool();
        const message =
            'profileManage requires "action" to be one of: add, list, get, update, remove.';

        await expect(tool({} as never)).rejects.toThrow(message);
        await expect(tool({ action: 'archive' } as never)).rejects.toThrow(message);
        await expect(tool({ action: 1 } as never)).rejects.toThrow(message);
    });

    it('rejects a missing or blank add name/description without consuming an id', async () => {
        const { tool } = createProfileTool();

        await expect(tool({ action: 'add', description: 'No name.' })).rejects.toThrow(
            'profileManage "add" requires a non-empty "name" string.'
        );
        await expect(tool({ action: 'add', name: '   ', description: 'Blank name.' })).rejects.toThrow(
            'profileManage "add" requires a non-empty "name" string.'
        );
        await expect(tool({ action: 'add', name: 'No description' })).rejects.toThrow(
            'profileManage "add" requires a non-empty "description" string.'
        );
        await expect(tool({ action: 'add', name: 'Blank', description: '  ' })).rejects.toThrow(
            'profileManage "add" requires a non-empty "description" string.'
        );

        expect(await tool({ action: 'list' })).toEqual(empty);

        // The failed adds did not consume ids.
        expect(await tool({ action: 'add', name: 'Fresh', description: 'First.' })).toEqual({
            profile: { id: '1', name: 'Fresh', description: 'First.', traits: [], notes: '' },
            counts: { total: 1 }
        });
    });

    it('rejects fields over their character caps and accepts exactly the cap', async () => {
        const { tool } = createProfileTool();

        await expect(
            tool({ action: 'add', name: filler(PROFILE_MAX_NAME + 1), description: 'Fine.' })
        ).rejects.toThrow(
            'profileManage "name" is 201 characters; the limit is 200. Shorten it and retry.'
        );
        await expect(
            tool({ action: 'add', name: 'Fine', description: filler(PROFILE_MAX_TEXT + 1) })
        ).rejects.toThrow(
            'profileManage "description" is 4001 characters; the limit is 4000. Shorten it and retry.'
        );
        await expect(
            tool({ action: 'add', name: 'Fine', description: 'Fine.', notes: filler(PROFILE_MAX_TEXT + 1) })
        ).rejects.toThrow(
            'profileManage "notes" is 4001 characters; the limit is 4000. Shorten it and retry.'
        );

        // Nothing was stored by the rejected writes.
        expect(await tool({ action: 'list' })).toEqual(empty);

        const added = changeOf(
            await tool({
                action: 'add',
                name: filler(PROFILE_MAX_NAME),
                description: filler(PROFILE_MAX_TEXT),
                notes: filler(PROFILE_MAX_TEXT)
            })
        );

        expect(added.profile!.name.length).toBe(200);
        expect(added.profile!.description.length).toBe(4000);
        expect(added.profile!.notes.length).toBe(4000);
    });

    it('caps traits at 32 entries of at most 200 characters', async () => {
        const { tool } = createProfileTool();

        // Too many entries, checked on the raw array (duplicates count too).
        await expect(
            tool({
                action: 'add',
                name: 'Elena',
                description: 'A cartographer.',
                traits: Array.from({ length: PROFILE_MAX_TRAITS + 1 }, () => 'brave')
            })
        ).rejects.toThrow('profileManage "traits" has 33 entries; the limit is 32.');

        // One entry over the per-trait cap.
        await expect(
            tool({
                action: 'add',
                name: 'Elena',
                description: 'A cartographer.',
                traits: ['brave', filler(PROFILE_MAX_TRAIT + 1)]
            })
        ).rejects.toThrow(
            'profileManage "traits" entry 2 is 201 characters; the limit is 200.'
        );

        expect(await tool({ action: 'list' })).toEqual(empty);

        // The exact caps are accepted.
        const added = changeOf(
            await tool({
                action: 'add',
                name: 'Elena',
                description: 'A cartographer.',
                traits: [filler(PROFILE_MAX_TRAIT), ...Array.from({ length: 31 }, (_, index) => `t${index}`)]
            })
        );

        expect(added.profile!.traits.length).toBe(32);
        expect(added.profile!.traits[0].length).toBe(200);
    });

    it('caps the store at 200 profiles and never drops a stored profile', async () => {
        const { tool } = createProfileTool();

        for (let index = 1; index <= PROFILE_MAX_RECORDS; index++) {
            await tool({ action: 'add', name: `Profile ${index}`, description: 'One.' });
        }

        await expect(tool({ action: 'add', name: 'One too many', description: 'Two.' })).rejects.toThrow(
            'profileManage already holds the maximum of 200 profiles; remove one before adding another.'
        );

        const listed = listOf(await tool({ action: 'list', limit: PROFILE_LIST_MAX_LIMIT }));

        expect(listed.counts).toEqual({ total: 200 });
        expect(listed.profiles.length).toBe(100);
        expect(listed.profiles[0]).toEqual({
            id: '1',
            name: 'Profile 1',
            description: 'One.',
            traits: [],
            notes: ''
        });

        // A freed slot continues the id sequence: ids are never recycled.
        await tool({ action: 'remove', id: '1' });
        expect(changeOf(await tool({ action: 'add', name: 'Replacement', description: 'Again.' })).profile).toEqual({
            id: '201',
            name: 'Replacement',
            description: 'Again.',
            traits: [],
            notes: ''
        });
    });

    it('paginates the list with default offset 0 and limit 20', async () => {
        const { tool } = createProfileTool();

        for (let index = 1; index <= 25; index++) {
            await tool({ action: 'add', name: `Profile ${index}`, description: 'One.' });
        }

        const first = listOf(await tool({ action: 'list' }));

        expect(first.page).toEqual({ offset: 0, limit: 20, hasMore: true, nextOffset: 20 });
        expect(first.profiles.length).toBe(20);
        expect(first.counts).toEqual({ total: 25 });

        const second = listOf(await tool({ action: 'list', offset: 20 }));

        // `nextOffset` is absent on the last page rather than null.
        expect(second.page).toEqual({ offset: 20, limit: 20, hasMore: false });
        expect(second.profiles.map((profile) => profile.id)).toEqual([
            '21',
            '22',
            '23',
            '24',
            '25'
        ]);

        expect(await tool({ action: 'list', offset: 25 })).toEqual({
            profiles: [],
            counts: { total: 25 },
            page: { offset: 25, limit: 20, hasMore: false }
        });
    });

    it('rejects an out-of-range offset or limit and validates them on every action', async () => {
        const { tool } = createProfileTool();

        await expect(tool({ action: 'list', limit: 0 } as never)).rejects.toThrow(
            'profileManage "limit" must be an integer between 1 and 100 when provided.'
        );
        await expect(tool({ action: 'list', limit: 101 } as never)).rejects.toThrow(
            'profileManage "limit" must be an integer between 1 and 100 when provided.'
        );
        await expect(tool({ action: 'list', offset: -1 } as never)).rejects.toThrow(
            'profileManage "offset" must be a non-negative integer when provided.'
        );
        await expect(
            tool({ action: 'add', name: 'One', description: 'Two.', offset: 2.5 } as never)
        ).rejects.toThrow('profileManage "offset" must be a non-negative integer when provided.');

        expect(await tool({ action: 'list' })).toEqual(empty);
    });

    it('stops a page before the 64 KiB UTF-8 budget so 100 * 4 KB cannot flood context', async () => {
        const { tool } = createProfileTool();

        for (let index = 1; index <= 100; index++) {
            await tool({ action: 'add', name: 'n', description: filler(PROFILE_MAX_TEXT) });
        }

        const oversized = listOf(await tool({ action: 'list', limit: PROFILE_LIST_MAX_LIMIT }));

        // Exactly 16 max-length profiles fit under the budget: the serialized
        // page is 65000 UTF-8 bytes (16 records, 15 commas, 2 brackets).
        expect(oversized.profiles.length).toBe(16);
        expect(Buffer.byteLength(JSON.stringify(oversized.profiles), 'utf8')).toBe(65000);
        expect(oversized.page).toEqual({ offset: 0, limit: 100, hasMore: true, nextOffset: 16 });
        expect(oversized.counts).toEqual({ total: 100 });
    });

    it('walks every profile across budget-trimmed pages without gaps', async () => {
        const { tool } = createProfileTool();

        for (let index = 1; index <= 100; index++) {
            await tool({ action: 'add', name: 'n', description: filler(PROFILE_MAX_TEXT) });
        }

        const ids: string[] = [];
        const offsets: number[] = [];
        let offset = 0;
        let hasMore = true;

        while (hasMore) {
            const listed = listOf(await tool({ action: 'list', offset, limit: PROFILE_LIST_MAX_LIMIT }));

            offsets.push(listed.page.offset);
            ids.push(...listed.profiles.map((profile) => profile.id));
            hasMore = listed.page.hasMore;

            if (hasMore) offset = listed.page.nextOffset!;
        }

        expect(offsets).toEqual([0, 16, 32, 48, 64, 80, 96]);
        expect(ids).toEqual(Array.from({ length: 100 }, (_, index) => String(index + 1)));
    });

    it('rejects missing, blank, or unknown ids for get/update/remove', async () => {
        const { tool } = createProfileTool();
        await tool({ action: 'add', name: 'One', description: 'First.' });

        await expect(tool({ action: 'get' })).rejects.toThrow(
            'profileManage "get" requires a non-empty "id" string.'
        );
        await expect(tool({ action: 'update', id: '  ', notes: 'x' })).rejects.toThrow(
            'profileManage "update" requires a non-empty "id" string.'
        );
        await expect(tool({ action: 'remove' })).rejects.toThrow(
            'profileManage "remove" requires a non-empty "id" string.'
        );

        await expect(tool({ action: 'get', id: '99' })).rejects.toThrow(
            'profileManage has no profile with id "99".'
        );
        await expect(tool({ action: 'update', id: '99', name: 'x' })).rejects.toThrow(
            'profileManage has no profile with id "99".'
        );
        await expect(tool({ action: 'remove', id: '99' })).rejects.toThrow(
            'profileManage has no profile with id "99".'
        );

        expect(await tool({ action: 'list' })).toEqual({
            profiles: [{ id: '1', name: 'One', description: 'First.', traits: [], notes: '' }],
            counts: { total: 1 },
            page: firstPage
        });
    });

    it('rejects an update that names no mutable field', async () => {
        const { tool } = createProfileTool();
        await tool({ action: 'add', name: 'One', description: 'First.' });

        await expect(tool({ action: 'update', id: '1' })).rejects.toThrow(
            'profileManage "update" requires at least one of: name, description, traits, notes.'
        );

        expect(await tool({ action: 'get', id: '1' })).toEqual({
            profile: { id: '1', name: 'One', description: 'First.', traits: [], notes: '' },
            counts: { total: 1 }
        });
    });

    it('rejects invalid field types consistently across actions', async () => {
        const { tool } = createProfileTool();
        await tool({ action: 'add', name: 'One', description: 'First.' });

        await expect(tool({ action: 'list', name: 7 } as never)).rejects.toThrow(
            'profileManage "name" must be a string when provided.'
        );
        await expect(tool({ action: 'list', description: false } as never)).rejects.toThrow(
            'profileManage "description" must be a string when provided.'
        );
        await expect(tool({ action: 'list', notes: 7 } as never)).rejects.toThrow(
            'profileManage "notes" must be a string when provided.'
        );
        await expect(tool({ action: 'list', id: 1 } as never)).rejects.toThrow(
            'profileManage "id" must be a string when provided.'
        );
        await expect(tool({ action: 'list', traits: 'brave' } as never)).rejects.toThrow(
            'profileManage "traits" must be an array of non-empty strings when provided.'
        );
        await expect(tool({ action: 'list', traits: ['brave', 7] } as never)).rejects.toThrow(
            'profileManage "traits" must be an array of non-empty strings when provided.'
        );
        await expect(tool({ action: 'list', traits: ['  '] } as never)).rejects.toThrow(
            'profileManage "traits" must be an array of non-empty strings when provided.'
        );
    });

    it('returns defensive copies of the page, profile, removed, and traits', async () => {
        const { tool } = createProfileTool();

        const added = changeOf(
            await tool({
                action: 'add',
                name: 'Original',
                description: 'Original description.',
                traits: ['original']
            })
        );
        added.profile!.name = 'mutated';
        added.profile!.traits.push('mutated trait');

        const listed = listOf(await tool({ action: 'list' }));
        listed.profiles[0].notes = 'mutated notes';

        const updated = changeOf(await tool({ action: 'update', id: '1', notes: 'real notes' }));
        updated.profile!.traits.push('mutated again');

        // Only the real update is visible: every mutation above hit a copy.
        expect(await tool({ action: 'list' })).toEqual({
            profiles: [
                {
                    id: '1',
                    name: 'Original',
                    description: 'Original description.',
                    traits: ['original'],
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
        const { tool, reset } = createProfileTool();
        await tool({ action: 'add', name: 'One', description: 'First.' });
        await tool({ action: 'add', name: 'Two', description: 'Second.' });

        reset();

        expect(await tool({ action: 'list' })).toEqual(empty);
        expect(await tool({ action: 'add', name: 'Fresh', description: 'After reset.' })).toEqual({
            profile: { id: '1', name: 'Fresh', description: 'After reset.', traits: [], notes: '' },
            counts: { total: 1 }
        });
    });

    it('keeps separate factory instances isolated', async () => {
        const first = createProfileTool();
        const second = createProfileTool();

        await first.tool({ action: 'add', name: 'Only in first', description: 'Mine.' });

        expect(await second.tool({ action: 'list' })).toEqual(empty);
        expect(await first.tool({ action: 'list' })).toEqual({
            profiles: [
                { id: '1', name: 'Only in first', description: 'Mine.', traits: [], notes: '' }
            ],
            counts: { total: 1 },
            page: firstPage
        });
    });
});

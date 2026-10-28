// profileManage — the per-harness session profile store (core/profile.ts).
//
// Unit tests for the factory: exact result envelopes, trimming/defaults,
// partial update semantics, validation errors (all non-destructive), defensive
// copies, reset, and isolation. Harness integration (declaration, sharing,
// reservation) lives in src/harness.records.test.ts; the full metadata/schema pin
// lives in src/harness.metadata.test.ts.

import { describe, expect, it } from 'vitest';
import { createProfileTool } from './profile';

const empty = {
    profiles: [],
    counts: { total: 0 }
};

describe('createProfileTool', () => {
    it('exposes the exact wire name, core visibility, and profile tags', () => {
        const { tool } = createProfileTool();

        expect(tool.name).toBe('profileManage');
        expect(tool.visibility).toBe('core');
        expect(tool.tags).toEqual(['profile', 'profiles', 'character', 'characters', 'person', 'people']);
    });

    it('starts empty and lists an empty snapshot', async () => {
        const { tool } = createProfileTool();

        expect(await tool({ action: 'list' })).toEqual(empty);
    });

    it('adds a trimmed profile with defaults, deduplicated traits, and ids', async () => {
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
            profiles: [
                {
                    id: '1',
                    name: 'Elena',
                    description: 'A cartographer.',
                    traits: ['brave', 'loyal'],
                    notes: 'keeps maps'
                }
            ],
            profile: {
                id: '1',
                name: 'Elena',
                description: 'A cartographer.',
                traits: ['brave', 'loyal'],
                notes: 'keeps maps'
            },
            counts: { total: 1 }
        });

        // Optional fields default to a stable empty shape rather than disappearing.
        expect(
            await tool({ action: 'add', name: 'Professor Vance', description: 'A rival.' })
        ).toEqual({
            profiles: [
                {
                    id: '1',
                    name: 'Elena',
                    description: 'A cartographer.',
                    traits: ['brave', 'loyal'],
                    notes: 'keeps maps'
                },
                {
                    id: '2',
                    name: 'Professor Vance',
                    description: 'A rival.',
                    traits: [],
                    notes: ''
                }
            ],
            profile: {
                id: '2',
                name: 'Professor Vance',
                description: 'A rival.',
                traits: [],
                notes: ''
            },
            counts: { total: 2 }
        });
    });

    it('gets one profile by id without changing the list', async () => {
        const { tool } = createProfileTool();
        await tool({ action: 'add', name: 'Elena', description: 'A cartographer.' });

        expect(await tool({ action: 'get', id: '1' })).toEqual({
            profiles: [
                { id: '1', name: 'Elena', description: 'A cartographer.', traits: [], notes: '' }
            ],
            profile: {
                id: '1',
                name: 'Elena',
                description: 'A cartographer.',
                traits: [],
                notes: ''
            },
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
            profiles: [
                {
                    id: '1',
                    name: 'Elena',
                    description: 'A cartographer.',
                    traits: ['brave'],
                    notes: 'revised'
                },
                { id: '2', name: 'Vance', description: 'A rival.', traits: [], notes: '' }
            ],
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
            profiles: [
                { id: '1', name: 'Elena', description: 'A cartographer.', traits: [], notes: '' },
                { id: '2', name: 'Vance', description: 'A rival.', traits: [], notes: '' }
            ],
            profile: {
                id: '1',
                name: 'Elena',
                description: 'A cartographer.',
                traits: [],
                notes: ''
            },
            counts: { total: 2 }
        });
    });

    it('validates the whole update before applying any field (atomic)', async () => {
        const { tool } = createProfileTool();
        await tool({ action: 'add', name: 'Elena', description: 'A cartographer.' });

        // `name` is valid, `description` is blank: nothing may be applied.
        await expect(
            tool({ action: 'update', id: '1', name: 'Changed', description: '   ' })
        ).rejects.toThrow('profileManage "update" requires a non-empty "description" string.');

        expect(await tool({ action: 'list' })).toEqual({
            profiles: [
                { id: '1', name: 'Elena', description: 'A cartographer.', traits: [], notes: '' }
            ],
            counts: { total: 1 }
        });
    });

    it('removes one profile and returns the removed record', async () => {
        const { tool } = createProfileTool();
        await tool({ action: 'add', name: 'Keep me', description: 'Stays.' });
        await tool({ action: 'add', name: 'Remove me', description: 'Goes.' });

        expect(await tool({ action: 'remove', id: '2' })).toEqual({
            profiles: [{ id: '1', name: 'Keep me', description: 'Stays.', traits: [], notes: '' }],
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
            profiles: [{ id: '1', name: 'Fresh', description: 'First.', traits: [], notes: '' }],
            profile: { id: '1', name: 'Fresh', description: 'First.', traits: [], notes: '' },
            counts: { total: 1 }
        });
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
            counts: { total: 1 }
        });
    });

    it('rejects an update that names no mutable field', async () => {
        const { tool } = createProfileTool();
        await tool({ action: 'add', name: 'One', description: 'First.' });

        await expect(tool({ action: 'update', id: '1' })).rejects.toThrow(
            'profileManage "update" requires at least one of: name, description, traits, notes.'
        );

        expect(await tool({ action: 'list' })).toEqual({
            profiles: [{ id: '1', name: 'One', description: 'First.', traits: [], notes: '' }],
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

    it('returns defensive copies of the list, profile, removed, and traits', async () => {
        const { tool } = createProfileTool();

        const added = await tool({
            action: 'add',
            name: 'Original',
            description: 'Original description.',
            traits: ['original']
        });
        added.profiles[0].name = 'mutated';
        added.profile!.traits.push('mutated trait');

        const listed = await tool({ action: 'list' });
        listed.profiles[0].notes = 'mutated notes';

        const updated = await tool({ action: 'update', id: '1', notes: 'real notes' });
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
            counts: { total: 1 }
        });

        const removed = await tool({ action: 'remove', id: '1' });
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
            profiles: [
                { id: '1', name: 'Fresh', description: 'After reset.', traits: [], notes: '' }
            ],
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
            counts: { total: 1 }
        });
    });
});

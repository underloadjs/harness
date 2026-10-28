// chapterManage — the per-harness session chapter tracker (core/chapter.ts).
//
// Unit tests for the factory: summary-only lists/results, body only from `get`,
// the order sort, partial update semantics, status counts, validation errors (all
// non-destructive), defensive copies, reset, and isolation. Harness integration
// lives in src/harness.records.test.ts; the full metadata/schema pin lives in
// src/harness.metadata.test.ts.

import { describe, expect, it } from 'vitest';
import { createChapterTool } from './chapter';

const empty = {
    chapters: [],
    counts: { total: 0, planned: 0, draft: 0, complete: 0 }
};

describe('createChapterTool', () => {
    it('exposes the exact wire name, core visibility, and chapter tags', () => {
        const { tool } = createChapterTool();

        expect(tool.name).toBe('chapterManage');
        expect(tool.visibility).toBe('core');
        expect(tool.tags).toEqual(['chapter', 'chapters', 'story', 'writing', 'outline', 'book']);
    });

    it('starts empty and lists an empty snapshot', async () => {
        const { tool } = createChapterTool();

        expect(await tool({ action: 'list' })).toEqual(empty);
    });

    it('adds a chapter with defaults and returns a summary without the body', async () => {
        const { tool } = createChapterTool();

        expect(
            await tool({
                action: 'add',
                title: '  Arrival  ',
                summary: '  They land.  ',
                content: '  The ship settles.  '
            })
        ).toEqual({
            chapters: [{ id: '1', title: 'Arrival', summary: 'They land.', status: 'planned' }],
            chapter: { id: '1', title: 'Arrival', summary: 'They land.', status: 'planned' },
            counts: { total: 1, planned: 1, draft: 0, complete: 0 }
        });
    });

    it('stores content, status, and order, and returns order only when supplied', async () => {
        const { tool } = createChapterTool();

        expect(
            await tool({
                action: 'add',
                title: 'Descent',
                summary: 'Into the dark.',
                content: ' Body ',
                status: 'draft',
                order: 2
            })
        ).toEqual({
            chapters: [
                { id: '1', title: 'Descent', summary: 'Into the dark.', status: 'draft', order: 2 }
            ],
            chapter: {
                id: '1',
                title: 'Descent',
                summary: 'Into the dark.',
                status: 'draft',
                order: 2
            },
            counts: { total: 1, planned: 0, draft: 1, complete: 0 }
        });

        // `get` is the only action that returns the body.
        expect(await tool({ action: 'get', id: '1' })).toEqual({
            chapters: [
                { id: '1', title: 'Descent', summary: 'Into the dark.', status: 'draft', order: 2 }
            ],
            chapter: {
                id: '1',
                title: 'Descent',
                summary: 'Into the dark.',
                status: 'draft',
                order: 2
            },
            content: 'Body',
            counts: { total: 1, planned: 0, draft: 1, complete: 0 }
        });
    });

    it('lists ordered chapters first (ascending), then unordered ones in insertion order', async () => {
        const { tool } = createChapterTool();
        await tool({ action: 'add', title: 'A', summary: 'First.' });
        await tool({ action: 'add', title: 'B', summary: 'Second.', status: 'draft', order: 2 });
        await tool({ action: 'add', title: 'C', summary: 'Third.', status: 'complete', order: 1 });
        await tool({ action: 'add', title: 'D', summary: 'Fourth.' });

        expect(await tool({ action: 'list' })).toEqual({
            chapters: [
                { id: '3', title: 'C', summary: 'Third.', status: 'complete', order: 1 },
                { id: '2', title: 'B', summary: 'Second.', status: 'draft', order: 2 },
                { id: '1', title: 'A', summary: 'First.', status: 'planned' },
                { id: '4', title: 'D', summary: 'Fourth.', status: 'planned' }
            ],
            counts: { total: 4, planned: 2, draft: 1, complete: 1 }
        });
    });

    it('updates only the supplied fields (partial semantics) and can rewrite order', async () => {
        const { tool } = createChapterTool();
        await tool({
            action: 'add',
            title: 'Descent',
            summary: 'Into the dark.',
            content: 'Old body.',
            status: 'draft',
            order: 3
        });
        await tool({ action: 'add', title: 'Arrival', summary: 'They land.' });

        // Title only: body, status, and order are untouched (the body is proven
        // by `get`, since update never echoes it).
        expect(await tool({ action: 'update', id: '1', title: '  The Descent  ' })).toEqual({
            chapters: [
                { id: '1', title: 'The Descent', summary: 'Into the dark.', status: 'draft', order: 3 },
                { id: '2', title: 'Arrival', summary: 'They land.', status: 'planned' }
            ],
            chapter: {
                id: '1',
                title: 'The Descent',
                summary: 'Into the dark.',
                status: 'draft',
                order: 3
            },
            counts: { total: 2, planned: 1, draft: 1, complete: 0 }
        });

        expect(await tool({ action: 'get', id: '1' })).toEqual({
            chapters: [
                { id: '1', title: 'The Descent', summary: 'Into the dark.', status: 'draft', order: 3 },
                { id: '2', title: 'Arrival', summary: 'They land.', status: 'planned' }
            ],
            chapter: {
                id: '1',
                title: 'The Descent',
                summary: 'Into the dark.',
                status: 'draft',
                order: 3
            },
            content: 'Old body.',
            counts: { total: 2, planned: 1, draft: 1, complete: 0 }
        });

        // Status, content, and order are all patchable; counts follow status.
        expect(
            await tool({
                action: 'update',
                id: '1',
                status: 'complete',
                content: '',
                order: 1
            })
        ).toEqual({
            chapters: [
                { id: '1', title: 'The Descent', summary: 'Into the dark.', status: 'complete', order: 1 },
                { id: '2', title: 'Arrival', summary: 'They land.', status: 'planned' }
            ],
            chapter: {
                id: '1',
                title: 'The Descent',
                summary: 'Into the dark.',
                status: 'complete',
                order: 1
            },
            counts: { total: 2, planned: 1, draft: 0, complete: 1 }
        });

        // An empty body is a real value, reported by `get` rather than omitted.
        expect((await tool({ action: 'get', id: '1' })).content).toBe('');
    });

    it('validates the whole update before applying any field (atomic)', async () => {
        const { tool } = createChapterTool();
        await tool({ action: 'add', title: 'One', summary: 'First.' });

        // Title is valid, summary is blank: nothing may be applied.
        await expect(
            tool({ action: 'update', id: '1', title: 'Changed', summary: '  ' })
        ).rejects.toThrow('chapterManage "update" requires a non-empty "summary" string.');

        expect(await tool({ action: 'get', id: '1' })).toEqual({
            chapters: [{ id: '1', title: 'One', summary: 'First.', status: 'planned' }],
            chapter: { id: '1', title: 'One', summary: 'First.', status: 'planned' },
            content: '',
            counts: { total: 1, planned: 1, draft: 0, complete: 0 }
        });
    });

    it('removes one chapter and returns a summary without the body', async () => {
        const { tool } = createChapterTool();
        await tool({ action: 'add', title: 'Keep', summary: 'Stays.' });
        await tool({ action: 'add', title: 'Remove', summary: 'Goes.', content: 'Secret body.' });

        expect(await tool({ action: 'remove', id: '2' })).toEqual({
            chapters: [{ id: '1', title: 'Keep', summary: 'Stays.', status: 'planned' }],
            removed: { id: '2', title: 'Remove', summary: 'Goes.', status: 'planned' },
            counts: { total: 1, planned: 1, draft: 0, complete: 0 }
        });
    });

    it('rejects a non-object argument with a readable error', async () => {
        const { tool } = createChapterTool();

        await expect(tool(null as never)).rejects.toThrow(
            'chapterManage expects an object with an "action" (add, list, get, update, remove).'
        );
        await expect(tool([] as never)).rejects.toThrow(
            'chapterManage expects an object with an "action" (add, list, get, update, remove).'
        );
    });

    it('rejects a missing, unknown, or non-string action', async () => {
        const { tool } = createChapterTool();
        const message =
            'chapterManage requires "action" to be one of: add, list, get, update, remove.';

        await expect(tool({} as never)).rejects.toThrow(message);
        await expect(tool({ action: 'move' } as never)).rejects.toThrow(message);
        await expect(tool({ action: 1 } as never)).rejects.toThrow(message);
    });

    it('rejects a missing or blank add title/summary without consuming an id', async () => {
        const { tool } = createChapterTool();

        await expect(tool({ action: 'add', summary: 'No title.' })).rejects.toThrow(
            'chapterManage "add" requires a non-empty "title" string.'
        );
        await expect(tool({ action: 'add', title: '  ', summary: 'Blank title.' })).rejects.toThrow(
            'chapterManage "add" requires a non-empty "title" string.'
        );
        await expect(tool({ action: 'add', title: 'No summary' })).rejects.toThrow(
            'chapterManage "add" requires a non-empty "summary" string.'
        );
        await expect(tool({ action: 'add', title: 'Blank', summary: '  ' })).rejects.toThrow(
            'chapterManage "add" requires a non-empty "summary" string.'
        );

        expect(await tool({ action: 'list' })).toEqual(empty);

        expect(await tool({ action: 'add', title: 'Fresh', summary: 'First.' })).toEqual({
            chapters: [{ id: '1', title: 'Fresh', summary: 'First.', status: 'planned' }],
            chapter: { id: '1', title: 'Fresh', summary: 'First.', status: 'planned' },
            counts: { total: 1, planned: 1, draft: 0, complete: 0 }
        });
    });

    it('rejects missing, blank, or unknown ids for get/update/remove', async () => {
        const { tool } = createChapterTool();
        await tool({ action: 'add', title: 'One', summary: 'First.' });

        await expect(tool({ action: 'get' })).rejects.toThrow(
            'chapterManage "get" requires a non-empty "id" string.'
        );
        await expect(tool({ action: 'update', id: '  ', title: 'x' })).rejects.toThrow(
            'chapterManage "update" requires a non-empty "id" string.'
        );
        await expect(tool({ action: 'remove' })).rejects.toThrow(
            'chapterManage "remove" requires a non-empty "id" string.'
        );

        await expect(tool({ action: 'get', id: '99' })).rejects.toThrow(
            'chapterManage has no chapter with id "99".'
        );
        await expect(tool({ action: 'update', id: '99', title: 'x' })).rejects.toThrow(
            'chapterManage has no chapter with id "99".'
        );
        await expect(tool({ action: 'remove', id: '99' })).rejects.toThrow(
            'chapterManage has no chapter with id "99".'
        );

        expect(await tool({ action: 'list' })).toEqual({
            chapters: [{ id: '1', title: 'One', summary: 'First.', status: 'planned' }],
            counts: { total: 1, planned: 1, draft: 0, complete: 0 }
        });
    });

    it('rejects an update that names no mutable field', async () => {
        const { tool } = createChapterTool();
        await tool({ action: 'add', title: 'One', summary: 'First.' });

        await expect(tool({ action: 'update', id: '1' })).rejects.toThrow(
            'chapterManage "update" requires at least one of: title, summary, content, status, order.'
        );

        expect(await tool({ action: 'get', id: '1' })).toEqual({
            chapters: [{ id: '1', title: 'One', summary: 'First.', status: 'planned' }],
            chapter: { id: '1', title: 'One', summary: 'First.', status: 'planned' },
            content: '',
            counts: { total: 1, planned: 1, draft: 0, complete: 0 }
        });
    });

    it('rejects invalid status, order, and field types consistently across actions', async () => {
        const { tool } = createChapterTool();
        await tool({ action: 'add', title: 'One', summary: 'First.' });

        await expect(tool({ action: 'add', title: 'X', summary: 'Y', status: 'done' } as never)).rejects.toThrow(
            'chapterManage "status" must be one of: planned, draft, complete when provided.'
        );
        await expect(tool({ action: 'list', status: 'done' } as never)).rejects.toThrow(
            'chapterManage "status" must be one of: planned, draft, complete when provided.'
        );
        await expect(tool({ action: 'add', title: 'X', summary: 'Y', order: 1.5 } as never)).rejects.toThrow(
            'chapterManage "order" must be an integer when provided.'
        );
        await expect(tool({ action: 'list', order: '1' } as never)).rejects.toThrow(
            'chapterManage "order" must be an integer when provided.'
        );
        await expect(tool({ action: 'list', id: 1 } as never)).rejects.toThrow(
            'chapterManage "id" must be a string when provided.'
        );
        await expect(tool({ action: 'list', title: 7 } as never)).rejects.toThrow(
            'chapterManage "title" must be a string when provided.'
        );
        await expect(tool({ action: 'list', summary: 7 } as never)).rejects.toThrow(
            'chapterManage "summary" must be a string when provided.'
        );
        await expect(tool({ action: 'list', content: 7 } as never)).rejects.toThrow(
            'chapterManage "content" must be a string when provided.'
        );
    });

    it('returns defensive copies of the list, chapter, and removed', async () => {
        const { tool } = createChapterTool();

        const added = await tool({
            action: 'add',
            title: 'Original',
            summary: 'Original summary.',
            content: 'Original body.'
        });
        added.chapters[0].title = 'mutated';
        added.chapter!.status = 'complete';

        const listed = await tool({ action: 'list' });
        listed.chapters[0].summary = 'mutated summary';

        const fetched = await tool({ action: 'get', id: '1' });
        fetched.chapter!.title = 'mutated again';

        // Only the real state is visible: every mutation above hit a copy.
        expect(await tool({ action: 'list' })).toEqual({
            chapters: [{ id: '1', title: 'Original', summary: 'Original summary.', status: 'planned' }],
            counts: { total: 1, planned: 1, draft: 0, complete: 0 }
        });
        expect(fetched.content).toBe('Original body.');

        const removed = await tool({ action: 'remove', id: '1' });
        removed.removed!.title = 'mutated removal';

        expect(removed.removed!.title).toBe('mutated removal');
        expect(await tool({ action: 'list' })).toEqual(empty);
    });

    it('resets the list and the id sequence', async () => {
        const { tool, reset } = createChapterTool();
        await tool({ action: 'add', title: 'One', summary: 'First.' });
        await tool({ action: 'add', title: 'Two', summary: 'Second.' });

        reset();

        expect(await tool({ action: 'list' })).toEqual(empty);
        expect(await tool({ action: 'add', title: 'Fresh', summary: 'After reset.' })).toEqual({
            chapters: [{ id: '1', title: 'Fresh', summary: 'After reset.', status: 'planned' }],
            chapter: { id: '1', title: 'Fresh', summary: 'After reset.', status: 'planned' },
            counts: { total: 1, planned: 1, draft: 0, complete: 0 }
        });
    });

    it('keeps separate factory instances isolated', async () => {
        const first = createChapterTool();
        const second = createChapterTool();

        await first.tool({ action: 'add', title: 'Only in first', summary: 'Mine.' });

        expect(await second.tool({ action: 'list' })).toEqual(empty);
        expect(await first.tool({ action: 'list' })).toEqual({
            chapters: [{ id: '1', title: 'Only in first', summary: 'Mine.', status: 'planned' }],
            counts: { total: 1, planned: 1, draft: 0, complete: 0 }
        });
    });
});

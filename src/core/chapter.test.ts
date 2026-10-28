// chapterManage — the per-harness session chapter tracker (core/chapter.ts).
//
// Unit tests for the factory: summary-only lists/results, body only from `get`,
// the order sort, partial update semantics, status counts, validation errors (all
// non-destructive), defensive copies, reset, isolation, and the R9 bounds
// (record cap, field caps, pagination after the sort, byte budget, compact
// mutation results). Harness integration lives in src/harness.records.test.ts;
// the full metadata/schema pin lives in src/harness.metadata.test.ts.

import { describe, expect, it } from 'vitest';
import {
    CHAPTER_LIST_MAX_LIMIT,
    CHAPTER_MAX_NAME,
    CHAPTER_MAX_RECORDS,
    CHAPTER_MAX_TEXT,
    createChapterTool
} from './chapter';
import type { ChapterChangeResult, ChapterListResult, ChapterResult } from './chapter';

// `ChapterResult` is a union (page vs. change). These helpers narrow it in tests
// without widening the production contract.
const listOf = (result: ChapterResult): ChapterListResult => result as ChapterListResult;
const changeOf = (result: ChapterResult): ChapterChangeResult => result as ChapterChangeResult;

// The default page cursor: offset 0, the default limit, and no further pages.
const firstPage = { offset: 0, limit: 20, hasMore: false };

const empty = {
    chapters: [],
    counts: { total: 0, planned: 0, draft: 0, complete: 0 },
    page: firstPage
};

// Deterministic ASCII filler: UTF-8 size equals string length, so the
// byte-budget assertions below stay exact.
const filler = (length: number): string => 'x'.repeat(length);

describe('createChapterTool', () => {
    it('exposes the exact wire name, core visibility, and chapter tags', () => {
        const { tool } = createChapterTool();

        expect(tool.name).toBe('chapterManage');
        expect(tool.visibility).toBe('core');
        expect(tool.tags).toEqual(['chapter', 'chapters', 'story', 'writing', 'outline', 'book']);
    });

    it('starts empty and lists an empty page', async () => {
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
            counts: { total: 4, planned: 2, draft: 1, complete: 1 },
            page: firstPage
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

        // An oversized later field must not leave the earlier one applied either.
        await expect(
            tool({ action: 'update', id: '1', title: 'Changed', content: filler(CHAPTER_MAX_TEXT + 1) })
        ).rejects.toThrow(
            'chapterManage "content" is 4001 characters; the limit is 4000. Shorten it and retry.'
        );

        expect(await tool({ action: 'get', id: '1' })).toEqual({
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
            chapter: { id: '1', title: 'Fresh', summary: 'First.', status: 'planned' },
            counts: { total: 1, planned: 1, draft: 0, complete: 0 }
        });
    });

    it('rejects fields over their character caps and accepts exactly the cap', async () => {
        const { tool } = createChapterTool();

        await expect(
            tool({ action: 'add', title: filler(CHAPTER_MAX_NAME + 1), summary: 'Fine.' })
        ).rejects.toThrow(
            'chapterManage "title" is 201 characters; the limit is 200. Shorten it and retry.'
        );
        await expect(
            tool({ action: 'add', title: 'Fine', summary: filler(CHAPTER_MAX_TEXT + 1) })
        ).rejects.toThrow(
            'chapterManage "summary" is 4001 characters; the limit is 4000. Shorten it and retry.'
        );
        await expect(
            tool({
                action: 'add',
                title: 'Fine',
                summary: 'Fine.',
                content: filler(CHAPTER_MAX_TEXT + 1)
            })
        ).rejects.toThrow(
            'chapterManage "content" is 4001 characters; the limit is 4000. Shorten it and retry.'
        );

        expect(await tool({ action: 'list' })).toEqual(empty);

        const added = changeOf(
            await tool({
                action: 'add',
                title: filler(CHAPTER_MAX_NAME),
                summary: filler(CHAPTER_MAX_TEXT),
                content: filler(CHAPTER_MAX_TEXT)
            })
        );

        expect(added.chapter!.title.length).toBe(200);
        expect(added.chapter!.summary.length).toBe(4000);
        // The body is not echoed, but it was stored in full.
        expect((await tool({ action: 'get', id: '1' })).content).toBe(filler(CHAPTER_MAX_TEXT));
    });

    it('caps the store at 200 chapters and never drops a stored chapter', async () => {
        const { tool } = createChapterTool();

        for (let index = 1; index <= CHAPTER_MAX_RECORDS; index++) {
            await tool({ action: 'add', title: `Chapter ${index}`, summary: 'One.' });
        }

        await expect(
            tool({ action: 'add', title: 'One too many', summary: 'Two.' })
        ).rejects.toThrow(
            'chapterManage already holds the maximum of 200 chapters; remove one before adding another.'
        );

        const listed = listOf(await tool({ action: 'list', limit: CHAPTER_LIST_MAX_LIMIT }));

        expect(listed.counts).toEqual({ total: 200, planned: 200, draft: 0, complete: 0 });
        expect(listed.chapters.length).toBe(100);
        expect(listed.chapters[0]).toEqual({
            id: '1',
            title: 'Chapter 1',
            summary: 'One.',
            status: 'planned'
        });

        // A freed slot continues the id sequence: ids are never recycled.
        await tool({ action: 'remove', id: '1' });
        expect(
            changeOf(await tool({ action: 'add', title: 'Replacement', summary: 'Again.' })).chapter
        ).toEqual({ id: '201', title: 'Replacement', summary: 'Again.', status: 'planned' });
    });

    it('paginates after the order sort with default offset 0 and limit 20', async () => {
        const { tool } = createChapterTool();

        // Descending order against ascending ids, so the sorted page order is
        // the exact reverse of insertion: ids 25,24,...,1.
        for (let index = 1; index <= 25; index++) {
            await tool({
                action: 'add',
                title: `C${index}`,
                summary: 'One.',
                order: 100 - index
            });
        }

        const first = listOf(await tool({ action: 'list' }));

        expect(first.page).toEqual({ offset: 0, limit: 20, hasMore: true, nextOffset: 20 });
        expect(first.chapters.map((chapter) => chapter.id)).toEqual(
            Array.from({ length: 20 }, (_, index) => String(25 - index))
        );
        expect(first.counts).toEqual({ total: 25, planned: 25, draft: 0, complete: 0 });

        const second = listOf(await tool({ action: 'list', offset: 20 }));

        // `nextOffset` is absent on the last page rather than null.
        expect(second.page).toEqual({ offset: 20, limit: 20, hasMore: false });
        expect(second.chapters.map((chapter) => chapter.id)).toEqual(['5', '4', '3', '2', '1']);

        expect(await tool({ action: 'list', offset: 25 })).toEqual({
            chapters: [],
            counts: { total: 25, planned: 25, draft: 0, complete: 0 },
            page: { offset: 25, limit: 20, hasMore: false }
        });
    });

    it('rejects an out-of-range offset or limit and validates them on every action', async () => {
        const { tool } = createChapterTool();

        await expect(tool({ action: 'list', limit: 0 } as never)).rejects.toThrow(
            'chapterManage "limit" must be an integer between 1 and 100 when provided.'
        );
        await expect(tool({ action: 'list', limit: 101 } as never)).rejects.toThrow(
            'chapterManage "limit" must be an integer between 1 and 100 when provided.'
        );
        await expect(tool({ action: 'list', offset: -1 } as never)).rejects.toThrow(
            'chapterManage "offset" must be a non-negative integer when provided.'
        );
        await expect(
            tool({ action: 'add', title: 'One', summary: 'Two.', offset: 1.5 } as never)
        ).rejects.toThrow('chapterManage "offset" must be a non-negative integer when provided.');

        expect(await tool({ action: 'list' })).toEqual(empty);
    });

    it('stops a page before the 64 KiB UTF-8 budget so 100 * 4 KB cannot flood context', async () => {
        const { tool } = createChapterTool();

        for (let index = 1; index <= 100; index++) {
            await tool({ action: 'add', title: 't', summary: filler(CHAPTER_MAX_TEXT) });
        }

        const oversized = listOf(await tool({ action: 'list', limit: CHAPTER_LIST_MAX_LIMIT }));

        // Exactly 16 max-length summaries fit under the budget: the serialized
        // page is 64888 UTF-8 bytes (16 records, 15 commas, 2 brackets).
        expect(oversized.chapters.length).toBe(16);
        expect(Buffer.byteLength(JSON.stringify(oversized.chapters), 'utf8')).toBe(64888);
        expect(oversized.page).toEqual({ offset: 0, limit: 100, hasMore: true, nextOffset: 16 });
        expect(oversized.counts).toEqual({ total: 100, planned: 100, draft: 0, complete: 0 });
    });

    it('walks every chapter across budget-trimmed pages without gaps', async () => {
        const { tool } = createChapterTool();

        for (let index = 1; index <= 100; index++) {
            await tool({ action: 'add', title: 't', summary: filler(CHAPTER_MAX_TEXT) });
        }

        const ids: string[] = [];
        const offsets: number[] = [];
        let offset = 0;
        let hasMore = true;

        while (hasMore) {
            const listed = listOf(await tool({ action: 'list', offset, limit: CHAPTER_LIST_MAX_LIMIT }));

            offsets.push(listed.page.offset);
            ids.push(...listed.chapters.map((chapter) => chapter.id));
            hasMore = listed.page.hasMore;

            if (hasMore) offset = listed.page.nextOffset!;
        }

        expect(offsets).toEqual([0, 16, 32, 48, 64, 80, 96]);
        expect(ids).toEqual(Array.from({ length: 100 }, (_, index) => String(index + 1)));
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
            counts: { total: 1, planned: 1, draft: 0, complete: 0 },
            page: firstPage
        });
    });

    it('rejects an update that names no mutable field', async () => {
        const { tool } = createChapterTool();
        await tool({ action: 'add', title: 'One', summary: 'First.' });

        await expect(tool({ action: 'update', id: '1' })).rejects.toThrow(
            'chapterManage "update" requires at least one of: title, summary, content, status, order.'
        );

        expect(await tool({ action: 'get', id: '1' })).toEqual({
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

    it('returns defensive copies of the page, chapter, and removed', async () => {
        const { tool } = createChapterTool();

        const added = changeOf(
            await tool({
                action: 'add',
                title: 'Original',
                summary: 'Original summary.',
                content: 'Original body.'
            })
        );
        added.chapter!.title = 'mutated';

        const listed = listOf(await tool({ action: 'list' }));
        listed.chapters[0].summary = 'mutated summary';

        const fetched = await tool({ action: 'get', id: '1' });
        fetched.chapter!.title = 'mutated again';

        // Only the real state is visible: every mutation above hit a copy.
        expect(await tool({ action: 'list' })).toEqual({
            chapters: [{ id: '1', title: 'Original', summary: 'Original summary.', status: 'planned' }],
            counts: { total: 1, planned: 1, draft: 0, complete: 0 },
            page: firstPage
        });
        expect(fetched.content).toBe('Original body.');

        const removed = changeOf(await tool({ action: 'remove', id: '1' }));
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
            counts: { total: 1, planned: 1, draft: 0, complete: 0 },
            page: firstPage
        });
    });
});

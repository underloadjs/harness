// todoManage — the per-harness session todo list (core/todo.ts).
//
// These are unit tests for the factory: exact result envelopes, defaults,
// validation errors, defensive copies, reset/isolation, and the R9 bounds
// (record cap, text cap, pagination, byte budget, compact mutation results).
// The harness integration (declaration, turns, shared agents, reserved names)
// lives in src/harness.todo.test.ts; the metadata/schema pin lives in
// src/harness.metadata.test.ts (the schema is owned by ./metadata.ts).
//
// Design notes:
//   - state lives in the factory closure, so two createTodoTool() calls (and two
//     harnesses) never share todos;
//   - ids are decimal strings, monotonic per instance, and restart at "1" after
//     reset();
//   - every returned todo is a copy;
//   - `list` returns one bounded page { todos, counts, page }; every mutation
//     returns only the changed item and the counts.

import { describe, expect, it } from 'vitest';
import { createTodoTool, TODO_LIST_MAX_LIMIT, TODO_MAX_RECORDS, TODO_MAX_TEXT } from './todo';
import type { TodoChangeResult, TodoListResult, TodoResult } from './todo';

// `TodoResult` is a union (page vs. change). These helpers narrow it in tests
// without widening the production contract.
const listOf = (result: TodoResult): TodoListResult => result as TodoListResult;
const changeOf = (result: TodoResult): TodoChangeResult => result as TodoChangeResult;

// The default page cursor: offset 0, the default limit, and no further pages.
const firstPage = { offset: 0, limit: 20, hasMore: false };

const empty = {
    todos: [],
    counts: { total: 0, completed: 0, remaining: 0 },
    page: firstPage
};

// A deterministic filler todo: every character is ASCII, so UTF-8 size equals
// string length and the byte-budget assertions below stay exact.
const filler = (length: number): string => 'x'.repeat(length);

describe('createTodoTool', () => {
    it('exposes the exact wire name, core visibility, and todo tags', () => {
        const { tool } = createTodoTool();

        expect(tool.name).toBe('todoManage');
        expect(tool.visibility).toBe('core');
        expect(tool.tags).toEqual(['todo', 'todos', 'task', 'tasks', 'checklist', 'plan']);
    });

    it('starts empty and lists an empty page', async () => {
        const { tool } = createTodoTool();

        expect(await tool({ action: 'list' })).toEqual(empty);
    });

    it('adds trimmed todos with monotonic string ids, counts, and no store snapshot', async () => {
        const { tool } = createTodoTool();

        expect(await tool({ action: 'add', text: '  Draft the plan  ' })).toEqual({
            todo: { id: '1', text: 'Draft the plan', completed: false },
            counts: { total: 1, completed: 0, remaining: 1 }
        });

        expect(await tool({ action: 'add', text: 'Write tests' })).toEqual({
            todo: { id: '2', text: 'Write tests', completed: false },
            counts: { total: 2, completed: 0, remaining: 2 }
        });

        // The list is only paid for on `list`, and only one page at a time.
        expect(await tool({ action: 'list' })).toEqual({
            todos: [
                { id: '1', text: 'Draft the plan', completed: false },
                { id: '2', text: 'Write tests', completed: false }
            ],
            counts: { total: 2, completed: 0, remaining: 2 },
            page: firstPage
        });
    });

    it('checks by default, unchecks with completed: false, and supports the uncheck alias', async () => {
        const { tool } = createTodoTool();
        await tool({ action: 'add', text: 'Ship it' });

        expect(await tool({ action: 'check', id: '1' })).toEqual({
            todo: { id: '1', text: 'Ship it', completed: true },
            counts: { total: 1, completed: 1, remaining: 0 }
        });

        // `check` + completed:false is the documented alias for unchecking.
        expect(await tool({ action: 'check', id: '1', completed: false })).toEqual({
            todo: { id: '1', text: 'Ship it', completed: false },
            counts: { total: 1, completed: 0, remaining: 1 }
        });

        await tool({ action: 'check', id: '1' });

        // The explicit alias always unchecks.
        expect(await tool({ action: 'uncheck', id: '1' })).toEqual({
            todo: { id: '1', text: 'Ship it', completed: false },
            counts: { total: 1, completed: 0, remaining: 1 }
        });
    });

    it('removes one todo and returns the removed item and counts only', async () => {
        const { tool } = createTodoTool();
        await tool({ action: 'add', text: 'Keep me' });
        await tool({ action: 'add', text: 'Remove me' });

        expect(await tool({ action: 'remove', id: '2' })).toEqual({
            removed: { id: '2', text: 'Remove me', completed: false },
            counts: { total: 1, completed: 0, remaining: 1 }
        });
    });

    it('rejects a non-object argument with a readable error', async () => {
        const { tool } = createTodoTool();

        await expect(tool(null as never)).rejects.toThrow(
            'todoManage expects an object with an "action" (add, remove, check, uncheck, list).'
        );
        await expect(tool([] as never)).rejects.toThrow(
            'todoManage expects an object with an "action" (add, remove, check, uncheck, list).'
        );
    });

    it('rejects a missing, unknown, or non-string action', async () => {
        const { tool } = createTodoTool();
        const message = 'todoManage requires "action" to be one of: add, remove, check, uncheck, list.';

        await expect(tool({} as never)).rejects.toThrow(message);
        await expect(tool({ action: 'archive' } as never)).rejects.toThrow(message);
        await expect(tool({ action: 1 } as never)).rejects.toThrow(message);
    });

    it('rejects a missing, blank, or non-string add text without mutating', async () => {
        const { tool } = createTodoTool();
        const message = 'todoManage "add" requires a non-empty "text" string.';

        await expect(tool({ action: 'add' })).rejects.toThrow(message);
        await expect(tool({ action: 'add', text: '   ' })).rejects.toThrow(message);
        await expect(tool({ action: 'add', text: 7 } as never)).rejects.toThrow(
            'todoManage "text" must be a string when provided.'
        );

        expect(await tool({ action: 'list' })).toEqual(empty);
    });

    it('rejects text longer than the 4000-character cap and accepts exactly 4000', async () => {
        const { tool } = createTodoTool();

        // Rejected, not truncated: the stored text is exactly what was sent.
        await expect(tool({ action: 'add', text: filler(TODO_MAX_TEXT + 1) })).rejects.toThrow(
            'todoManage "text" is 4001 characters; the limit is 4000. Shorten it and retry.'
        );

        // Nothing was stored, and no id was consumed.
        expect(await tool({ action: 'list' })).toEqual(empty);

        const added = changeOf(await tool({ action: 'add', text: filler(TODO_MAX_TEXT) }));

        expect(added.todo!.id).toBe('1');
        expect(added.todo!.text.length).toBe(4000);
        expect(added.counts).toEqual({ total: 1, completed: 0, remaining: 1 });
    });

    it('caps the store at 200 todos and never drops a stored todo', async () => {
        const { tool } = createTodoTool();

        for (let index = 1; index <= TODO_MAX_RECORDS; index++) {
            await tool({ action: 'add', text: `Todo ${index}` });
        }

        // The 201st add is an actionable error, not a silent eviction.
        await expect(tool({ action: 'add', text: 'One too many' })).rejects.toThrow(
            'todoManage already holds the maximum of 200 todos; remove one before adding another.'
        );

        // All 200 are still there, and the refused add consumed no id.
        const listed = listOf(await tool({ action: 'list', limit: TODO_LIST_MAX_LIMIT }));

        expect(listed.counts).toEqual({ total: 200, completed: 0, remaining: 200 });
        expect(listed.todos.length).toBe(100);
        expect(listed.todos[0]).toEqual({ id: '1', text: 'Todo 1', completed: false });

        // Freeing a slot lets the next id be 201: ids are monotonic, never reused.
        await tool({ action: 'remove', id: '1' });
        expect(changeOf(await tool({ action: 'add', text: 'Replacement' })).todo).toEqual({
            id: '201',
            text: 'Replacement',
            completed: false
        });
    });

    it('paginates the list with default offset 0 and limit 20', async () => {
        const { tool } = createTodoTool();

        for (let index = 1; index <= 25; index++) {
            await tool({ action: 'add', text: `Todo ${index}` });
        }

        const first = listOf(await tool({ action: 'list' }));

        expect(first.page).toEqual({ offset: 0, limit: 20, hasMore: true, nextOffset: 20 });
        expect(first.todos.length).toBe(20);
        expect(first.todos[0].id).toBe('1');
        expect(first.todos[19].id).toBe('20');
        // Counts are store-wide, not page-wide.
        expect(first.counts).toEqual({ total: 25, completed: 0, remaining: 25 });

        const second = listOf(await tool({ action: 'list', offset: 20 }));

        // `nextOffset` is absent on the last page rather than null.
        expect(second.page).toEqual({ offset: 20, limit: 20, hasMore: false });
        expect(second.todos.map((todo) => todo.id)).toEqual(['21', '22', '23', '24', '25']);

        // An offset past the end is an empty page, not an error.
        expect(await tool({ action: 'list', offset: 25 })).toEqual({
            todos: [],
            counts: { total: 25, completed: 0, remaining: 25 },
            page: { offset: 25, limit: 20, hasMore: false }
        });
    });

    it('rejects an out-of-range offset or limit and validates them on every action', async () => {
        const { tool } = createTodoTool();

        await expect(tool({ action: 'list', limit: 0 } as never)).rejects.toThrow(
            'todoManage "limit" must be an integer between 1 and 100 when provided.'
        );
        await expect(tool({ action: 'list', limit: 101 } as never)).rejects.toThrow(
            'todoManage "limit" must be an integer between 1 and 100 when provided.'
        );
        await expect(tool({ action: 'list', limit: 2.5 } as never)).rejects.toThrow(
            'todoManage "limit" must be an integer between 1 and 100 when provided.'
        );
        await expect(tool({ action: 'list', offset: -1 } as never)).rejects.toThrow(
            'todoManage "offset" must be a non-negative integer when provided.'
        );
        await expect(tool({ action: 'list', offset: 1.5 } as never)).rejects.toThrow(
            'todoManage "offset" must be a non-negative integer when provided.'
        );

        // A cursor on a mutating action is validated too, not ignored.
        await expect(tool({ action: 'add', text: 'One', limit: 500 } as never)).rejects.toThrow(
            'todoManage "limit" must be an integer between 1 and 100 when provided.'
        );

        expect(await tool({ action: 'list' })).toEqual(empty);
    });

    it('stops a page before the 64 KiB UTF-8 budget so 100 * 4 KB cannot flood context', async () => {
        const { tool } = createTodoTool();

        for (let index = 1; index <= 100; index++) {
            await tool({ action: 'add', text: filler(TODO_MAX_TEXT) });
        }

        const oversized = listOf(await tool({ action: 'list', limit: TODO_LIST_MAX_LIMIT }));

        // Exactly 16 max-length todos fit under the budget (ASCII text, so the
        // serialized JSON is 64632 bytes: 16 * ~4040 minus the trailing comma).
        expect(oversized.todos.length).toBe(16);
        expect(Buffer.byteLength(JSON.stringify(oversized.todos), 'utf8')).toBe(64632);
        expect(oversized.page).toEqual({ offset: 0, limit: 100, hasMore: true, nextOffset: 16 });
        expect(oversized.counts).toEqual({ total: 100, completed: 0, remaining: 100 });
    });

    it('walks every todo across budget-trimmed pages without gaps', async () => {
        const { tool } = createTodoTool();

        for (let index = 1; index <= 100; index++) {
            await tool({ action: 'add', text: filler(TODO_MAX_TEXT) });
        }

        const ids: string[] = [];
        const offsets: number[] = [];
        let offset = 0;
        let hasMore = true;

        // Follow `nextOffset` exactly as a model would, and stop at the last page.
        while (hasMore) {
            const listed = listOf(await tool({ action: 'list', offset, limit: TODO_LIST_MAX_LIMIT }));

            offsets.push(listed.page.offset);
            ids.push(...listed.todos.map((todo) => todo.id));
            hasMore = listed.page.hasMore;

            if (hasMore) offset = listed.page.nextOffset!;
        }

        // 100 records at 16 per page: 6 full pages plus a 4-record tail.
        expect(offsets).toEqual([0, 16, 32, 48, 64, 80, 96]);
        expect(ids).toEqual(
            Array.from({ length: 100 }, (_, index) => String(index + 1))
        );
    });

    it('rejects a missing or blank id for remove/check/uncheck without mutating', async () => {
        const { tool } = createTodoTool();
        await tool({ action: 'add', text: 'One' });

        await expect(tool({ action: 'remove' })).rejects.toThrow(
            'todoManage "remove" requires a non-empty "id" string.'
        );
        await expect(tool({ action: 'check', id: '  ' })).rejects.toThrow(
            'todoManage "check" requires a non-empty "id" string.'
        );
        await expect(tool({ action: 'uncheck' })).rejects.toThrow(
            'todoManage "uncheck" requires a non-empty "id" string.'
        );

        expect(await tool({ action: 'list' })).toEqual({
            todos: [{ id: '1', text: 'One', completed: false }],
            counts: { total: 1, completed: 0, remaining: 1 },
            page: firstPage
        });
    });

    it('rejects an unknown id without mutating or recycling it', async () => {
        const { tool } = createTodoTool();
        await tool({ action: 'add', text: 'One' });

        await expect(tool({ action: 'check', id: '99' })).rejects.toThrow(
            'todoManage has no todo with id "99".'
        );
        await expect(tool({ action: 'remove', id: '99' })).rejects.toThrow(
            'todoManage has no todo with id "99".'
        );
        await expect(tool({ action: 'uncheck', id: '99' })).rejects.toThrow(
            'todoManage has no todo with id "99".'
        );

        expect(await tool({ action: 'list' })).toEqual({
            todos: [{ id: '1', text: 'One', completed: false }],
            counts: { total: 1, completed: 0, remaining: 1 },
            page: firstPage
        });
    });

    it('rejects invalid optional field types consistently across actions', async () => {
        const { tool } = createTodoTool();

        await expect(tool({ action: 'list', completed: 'yes' } as never)).rejects.toThrow(
            'todoManage "completed" must be a boolean when provided.'
        );
        await expect(tool({ action: 'remove', id: 1 } as never)).rejects.toThrow(
            'todoManage "id" must be a string when provided.'
        );
        await expect(tool({ action: 'add', text: 'One', id: 1 } as never)).rejects.toThrow(
            'todoManage "id" must be a string when provided.'
        );

        expect(await tool({ action: 'list' })).toEqual(empty);
    });

    it('returns defensive copies of the page, todo, and removed', async () => {
        const { tool } = createTodoTool();

        const added = changeOf(await tool({ action: 'add', text: 'Original' }));
        added.todo!.completed = true;

        const listed = listOf(await tool({ action: 'list' }));
        listed.todos[0].text = 'mutated';

        const checked = changeOf(await tool({ action: 'check', id: '1' }));
        checked.todo!.text = 'mutated again';

        expect(await tool({ action: 'list' })).toEqual({
            todos: [{ id: '1', text: 'Original', completed: true }],
            counts: { total: 1, completed: 1, remaining: 0 },
            page: firstPage
        });

        const removed = changeOf(await tool({ action: 'remove', id: '1' }));
        removed.removed!.text = 'mutated removal';

        // The removed item is gone from the live list, and mutating the copy
        // could not have changed what was already returned to the caller.
        expect(removed.removed!.text).toBe('mutated removal');
        expect(await tool({ action: 'list' })).toEqual(empty);
    });

    it('resets the list and the id sequence', async () => {
        const { tool, reset } = createTodoTool();
        await tool({ action: 'add', text: 'One' });
        await tool({ action: 'add', text: 'Two' });

        reset();

        expect(await tool({ action: 'list' })).toEqual(empty);
        expect(await tool({ action: 'add', text: 'Fresh' })).toEqual({
            todo: { id: '1', text: 'Fresh', completed: false },
            counts: { total: 1, completed: 0, remaining: 1 }
        });
    });

    it('keeps separate factory instances isolated', async () => {
        const first = createTodoTool();
        const second = createTodoTool();

        await first.tool({ action: 'add', text: 'Only in first' });

        expect(await first.tool({ action: 'list' })).toEqual({
            todos: [{ id: '1', text: 'Only in first', completed: false }],
            counts: { total: 1, completed: 0, remaining: 1 },
            page: firstPage
        });
        expect(await second.tool({ action: 'list' })).toEqual(empty);
    });
});

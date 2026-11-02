// task — the per-harness session task list (core/task.ts).
//
// Unit tests for the factory: the exact patch contract (add / partial patch /
// remove / read), the ONE result envelope every success shares, validation
// errors, atomicity, defensive copies, reset/isolation, and the R9 bounds
// (record cap, text cap, pagination, byte budget).
//
// Expectations are derived from the approved wire design, not from the
// implementation's output:
//   - `task({tasks?, remove?, offset?, limit?})`, everything optional;
//   - no arguments / `{}` / `null` is a READ;
//   - an entry with no `id` ADDS (text required); an entry with a known `id`
//     PATCHES partially; an unknown id is rejected;
//   - `remove` deletes exact ids;
//   - duplicate/conflicting entries are rejected and the WHOLE patch is validated
//     before anything mutates;
//   - every success returns `{ tasks, counts { total, completed, pending }, page }`
//     — the same bounded page, with no action wrapper;
//   - bounds are unchanged: 200 records, 4000 characters, 20/100 page, 64 KiB.
//
// The harness integration lives in src/harness.task.test.ts; the metadata/schema
// pin lives in src/harness.metadata.test.ts (the schema is owned by the entry).

import { describe, expect, it } from 'vitest';
import {
    readTaskStoreState,
    createTaskTool,
    TASK_LIST_MAX_LIMIT,
    TASK_MAX_RECORDS,
    TASK_MAX_TEXT
} from './task';
import type { TaskParameters, TaskResult } from './task';

// The no-argument invocations of the wire design. `tool()` is typed to take its
// parameter object, so the "caller sent nothing" cases are expressed honestly.
const noArgs = (tool: (value: TaskParameters) => Promise<TaskResult>) =>
    tool(undefined as unknown as TaskParameters);

// The default page cursor: offset 0, the documented default limit, one page only.
const firstPage = { offset: 0, limit: 20, hasMore: false };

// The empty read: every success carries the same three keys, so an empty store
// still answers with a page and zeroed counts (no `todos` key, no action echo).
const empty = {
    tasks: [],
    counts: { total: 0, completed: 0, pending: 0 },
    page: firstPage
};

// A deterministic filler task: every character is ASCII, so the UTF-8 size equals
// the string length and the byte-budget assertions below stay exact.
const filler = (length: number): string => 'x'.repeat(length);

describe('createTaskTool', () => {
    it('exposes the exact wire name, core visibility, and task tags', () => {
        const { tool } = createTaskTool();

        expect(tool.name).toBe('task');
        expect(tool.visibility).toBe('core');
        expect(tool.tags).toEqual(['task', 'tasks', 'todo', 'todos', 'checklist', 'plan']);
    });

    // -----------------------------------------------------------------------
    // Read (no request => read)
    // -----------------------------------------------------------------------
    it('reads an empty list for every kind of no-argument call', async () => {
        const { tool } = createTaskTool();

        expect(await noArgs(tool)).toEqual(empty);
        expect(await tool({})).toEqual(empty);
        expect(await tool(null as unknown as TaskParameters)).toEqual(empty);
        expect(await tool({ tasks: [] })).toEqual(empty);
        expect(await tool({ remove: [] })).toEqual(empty);
    });

    it('reads the current page after a mutation instead of echoing only the change', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: [{ text: 'Draft plan' }] });

        expect(await tool({})).toEqual({
            tasks: [{ id: '1', text: 'Draft plan', completed: false }],
            counts: { total: 1, completed: 0, pending: 1 },
            page: firstPage
        });
    });

    it('rejects an argument that is neither nothing nor an object', async () => {
        const { tool } = createTaskTool();

        const message = 'task expects an object with optional "tasks" and "remove" arrays.';

        await expect(tool('list' as unknown as TaskParameters)).rejects.toThrow(message);
        await expect(tool([1, 2] as unknown as TaskParameters)).rejects.toThrow(message);
    });

    // -----------------------------------------------------------------------
    // Add (entry without id)
    // -----------------------------------------------------------------------
    it('adds trimmed tasks with monotonic string ids and returns the bounded list', async () => {
        const { tool } = createTaskTool();

        expect(await tool({ tasks: [{ text: '  Draft the plan  ' }] })).toEqual({
            tasks: [{ id: '1', text: 'Draft the plan', completed: false }],
            counts: { total: 1, completed: 0, pending: 1 },
            page: firstPage
        });

        // A second call appends, and the response carries BOTH rows in order.
        expect(await tool({ tasks: [{ text: 'Review it', completed: true }] })).toEqual({
            tasks: [
                { id: '1', text: 'Draft the plan', completed: false },
                { id: '2', text: 'Review it', completed: true }
            ],
            counts: { total: 2, completed: 1, pending: 1 },
            page: firstPage
        });
    });

    it('adds every entry of one call in order, each with its own id', async () => {
        const { tool } = createTaskTool();

        const result = await tool({ tasks: [{ text: 'One' }, { text: 'Two' }, { text: 'Three' }] });

        expect(result.tasks).toEqual([
            { id: '1', text: 'One', completed: false },
            { id: '2', text: 'Two', completed: false },
            { id: '3', text: 'Three', completed: false }
        ]);
        expect(result.counts).toEqual({ total: 3, completed: 0, pending: 3 });
    });

    it('requires text on a new entry and never invents an empty task', async () => {
        const { tool } = createTaskTool();

        await expect(tool({ tasks: [{ completed: true }] })).rejects.toThrow(
            'task "tasks[0]" needs "text" to add a task, or an existing "id" to change one.'
        );
        await expect(tool({ tasks: [{}] })).rejects.toThrow(
            'task "tasks[0]" needs "text" to add a task, or an existing "id" to change one.'
        );
        await expect(tool({ tasks: [{ text: '   ' }] })).rejects.toThrow(
            'task "tasks[0]" requires a non-empty "text" string.'
        );
        // Nothing was stored, and the next add still gets id "1".
        expect(await tool({ tasks: [{ text: 'First' }] })).toEqual({
            tasks: [{ id: '1', text: 'First', completed: false }],
            counts: { total: 1, completed: 0, pending: 1 },
            page: firstPage
        });
    });

    // -----------------------------------------------------------------------
    // Patch (entry with an existing id) — partial, omitted fields unchanged
    // -----------------------------------------------------------------------
    it('patches only the fields an entry names', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: [{ text: 'Draft plan' }, { text: 'Ship it' }] });

        // completed only: the text of id "1" must be untouched, and id "2" intact.
        expect(await tool({ tasks: [{ id: '1', completed: true }] })).toEqual({
            tasks: [
                { id: '1', text: 'Draft plan', completed: true },
                { id: '2', text: 'Ship it', completed: false }
            ],
            counts: { total: 2, completed: 1, pending: 1 },
            page: firstPage
        });

        // text only: the completed flag of id "1" must survive the rename.
        expect(await tool({ tasks: [{ id: '1', text: 'Rewrite the plan' }] })).toEqual({
            tasks: [
                { id: '1', text: 'Rewrite the plan', completed: true },
                { id: '2', text: 'Ship it', completed: false }
            ],
            counts: { total: 2, completed: 1, pending: 1 },
            page: firstPage
        });

        // Reopening a completed task is just another partial patch.
        expect((await tool({ tasks: [{ id: '1', completed: false }] })).tasks[0]).toEqual({
            id: '1',
            text: 'Rewrite the plan',
            completed: false
        });
    });

    it('applies patches, removals, and additions of one call in that order', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: [{ text: 'One' }, { text: 'Two' }, { text: 'Three' }] });

        const result = await tool({
            tasks: [{ id: '1', completed: true }, { text: 'Four' }],
            remove: ['2']
        });

        expect(result.tasks).toEqual([
            { id: '1', text: 'One', completed: true },
            // id "2" is gone; the survivor keeps its place and the addition
            // is appended after it, with the next id from the counter.
            { id: '3', text: 'Three', completed: false },
            { id: '4', text: 'Four', completed: false }
        ]);
        expect(result.counts).toEqual({ total: 3, completed: 1, pending: 2 });
    });

    it('ignores a patch entry that names an id and changes no field', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: [{ text: 'Keep me' }] });

        expect(await tool({ tasks: [{ id: '1' }] })).toEqual({
            tasks: [{ id: '1', text: 'Keep me', completed: false }],
            counts: { total: 1, completed: 0, pending: 1 },
            page: firstPage
        });
    });

    // -----------------------------------------------------------------------
    // Remove
    // -----------------------------------------------------------------------
    it('removes exact ids and reports the remaining list', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: [{ text: 'One' }, { text: 'Two' }, { text: 'Three' }] });

        expect(await tool({ remove: ['1', '3'] })).toEqual({
            tasks: [{ id: '2', text: 'Two', completed: false }],
            counts: { total: 1, completed: 0, pending: 1 },
            page: firstPage
        });
    });

    it('never reuses a removed id within one instance', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: [{ text: 'Temporary' }] });
        await tool({ remove: ['1'] });

        expect((await tool({ tasks: [{ text: 'Fresh' }] })).tasks).toEqual([
            { id: '2', text: 'Fresh', completed: false }
        ]);
    });

    // -----------------------------------------------------------------------
    // Rejections: unknown ids, duplicates, conflicts, types — all non-mutating
    // -----------------------------------------------------------------------
    it('rejects unknown ids in both halves of a patch', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: [{ text: 'Only one' }] });

        await expect(tool({ tasks: [{ id: '99', completed: true }] })).rejects.toThrow(
            'task has no task with id "99".'
        );
        await expect(tool({ remove: ['99'] })).rejects.toThrow('task has no task with id "99".');

        // The store is exactly as it was: same row, same completed flag, same ids.
        expect(await tool({})).toEqual({
            tasks: [{ id: '1', text: 'Only one', completed: false }],
            counts: { total: 1, completed: 0, pending: 1 },
            page: firstPage
        });
    });

    it('rejects duplicate and conflicting entries before mutating anything', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: [{ text: 'One' }, { text: 'Two' }] });

        await expect(
            tool({ tasks: [{ id: '1', completed: true }, { id: '1', text: 'Renamed' }] })
        ).rejects.toThrow('task "tasks" changes id "1" more than once; send one entry per id.');

        await expect(
            tool({ tasks: [{ id: '1', completed: true }], remove: ['1'] })
        ).rejects.toThrow(
            'task id "1" appears in both "tasks" and "remove"; change it or remove it, not both.'
        );

        await expect(tool({ remove: ['1', '1'] })).rejects.toThrow(
            'task "remove" lists id "1" more than once.'
        );

        // A rejected batch that also carried a valid addition burns nothing: the
        // list still has two rows and the next id is still "3".
        expect(await tool({})).toEqual({
            tasks: [
                { id: '1', text: 'One', completed: false },
                { id: '2', text: 'Two', completed: false }
            ],
            counts: { total: 2, completed: 0, pending: 2 },
            page: firstPage
        });

        expect((await tool({ tasks: [{ text: 'Three' }] })).tasks.map((task) => task.id)).toEqual([
            '1',
            '2',
            '3'
        ]);
    });

    it('rejects a late invalid entry without applying the valid earlier ones', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: [{ text: 'One' }] });

        await expect(
            tool({ tasks: [{ id: '1', completed: true }, { text: 'Two' }, 'nope'] })
        ).rejects.toThrow('task "tasks[2]" must be an object with an optional "id", "text", and "completed".');

        expect(await tool({})).toEqual({
            tasks: [{ id: '1', text: 'One', completed: false }],
            counts: { total: 1, completed: 0, pending: 1 },
            page: firstPage
        });
    });

    it('reports every field type error instead of ignoring the wrong value', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: [{ text: 'One' }] });

        await expect(tool({ tasks: 'nope' as unknown as TaskParameters['tasks'] })).rejects.toThrow(
            'task "tasks" must be an array of task objects when provided.'
        );
        await expect(tool({ remove: 'nope' as unknown as TaskParameters['remove'] })).rejects.toThrow(
            'task "remove" must be an array of task id strings when provided.'
        );
        await expect(tool({ tasks: [{ id: 7, completed: true }] })).rejects.toThrow(
            'task "tasks[0].id" must be a string when provided.'
        );
        await expect(tool({ tasks: [{ id: '  ', completed: true }] })).rejects.toThrow(
            'task "tasks[0].id" must be a non-empty task id string.'
        );
        await expect(tool({ tasks: [{ id: '1', text: 5 }] })).rejects.toThrow(
            'task "text" must be a string when provided.'
        );
        await expect(tool({ tasks: [{ id: '1', completed: 'yes' }] })).rejects.toThrow(
            'task "completed" must be a boolean when provided.'
        );
        await expect(tool({ remove: [''] })).rejects.toThrow(
            'task "remove[0]" must be a non-empty task id string.'
        );
        await expect(tool({ remove: [7] })).rejects.toThrow(
            'task "remove[0]" must be a non-empty task id string.'
        );
    });

    // -----------------------------------------------------------------------
    // R9 bounds (numbers unchanged by the rename)
    // -----------------------------------------------------------------------
    it('rejects text past the 4000-character cap and accepts exactly the cap', async () => {
        const { tool } = createTaskTool();

        await expect(tool({ tasks: [{ text: filler(TASK_MAX_TEXT + 1) }] })).rejects.toThrow(
            'task "text" is 4001 characters; the limit is 4000. Shorten it and retry.'
        );

        const added = await tool({ tasks: [{ text: filler(TASK_MAX_TEXT) }] });

        expect(added.tasks).toEqual([
            { id: '1', text: filler(TASK_MAX_TEXT), completed: false }
        ]);
        expect(added.counts).toEqual({ total: 1, completed: 0, pending: 1 });
    });

    it('holds at most 200 tasks and rejects an over-cap batch without storing it', async () => {
        const { tool } = createTaskTool();

        for (let index = 1; index <= TASK_MAX_RECORDS; index++) {
            await tool({ tasks: [{ text: `Task ${index}` }] });
        }

        await expect(tool({ tasks: [{ text: 'One too many' }] })).rejects.toThrow(
            'task would hold 201 tasks; the maximum is 200. Remove one before adding another.'
        );

        // The cap is computed on the RESULT of the call, so one call may remove and
        // add in the same breath and stay inside the bound.
        const restated = await tool({ remove: ['1', '2'], tasks: [{ text: 'New tail' }] });

        expect(restated.counts).toEqual({ total: 199, completed: 0, pending: 199 });
        expect(restated.tasks[0]).toEqual({ id: '3', text: 'Task 3', completed: false });
        // The response is still one bounded page (20 rows starting at id "3"),
        // so the appended tail is read through the cursor: 199 rows means the
        // last page starts at offset 196 and holds the new id "201".
        expect(restated.tasks.map((task) => task.id)).toEqual(
            Array.from({ length: 20 }, (_, index) => String(index + 3))
        );

        expect((await tool({ offset: 196, limit: 3 })).tasks).toEqual([
            { id: '199', text: 'Task 199', completed: false },
            { id: '200', text: 'Task 200', completed: false },
            { id: '201', text: 'New tail', completed: false }
        ]);
    });

    it('defaults to a 20-item page and exposes the cursor while more rows exist', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: Array.from({ length: 25 }, (_, index) => ({ text: `Task ${index + 1}` })) });

        // One call added 25 rows; the answer is still exactly one bounded page.
        const first = await tool({});

        expect(first.tasks.map((task) => task.id)).toEqual(
            Array.from({ length: 20 }, (_, index) => String(index + 1))
        );
        expect(first.counts).toEqual({ total: 25, completed: 0, pending: 25 });
        expect(first.page).toEqual({ offset: 0, limit: 20, hasMore: true, nextOffset: 20 });

        const second = await tool({ offset: first.page.nextOffset as number });

        expect(second.tasks.map((task) => task.id)).toEqual(['21', '22', '23', '24', '25']);
        expect(second.counts).toEqual({ total: 25, completed: 0, pending: 25 });
        expect(second.page).toEqual({ offset: 20, limit: 20, hasMore: false });
    });

    it('honours an explicit limit and never trims the cursor of a full page', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: Array.from({ length: 5 }, (_, index) => ({ text: `T${index + 1}` })) });

        const page = await tool({ offset: 1, limit: 2 });

        expect(page.tasks.map((task) => task.id)).toEqual(['2', '3']);
        expect(page.page).toEqual({ offset: 1, limit: 2, hasMore: true, nextOffset: 3 });

        // An offset past the end is a valid empty page, not an error.
        expect(await tool({ offset: 9 })).toEqual({
            tasks: [],
            counts: { total: 5, completed: 0, pending: 5 },
            page: { offset: 9, limit: 20, hasMore: false }
        });
    });

    it('truncates a page at the 64 KiB serialized budget and still reports the cursor', async () => {
        const { tool } = createTaskTool();

        await tool({
            tasks: Array.from({ length: 100 }, () => ({ text: filler(TASK_MAX_TEXT) }))
        });

        // Exact arithmetic for this fixture, not a range check. One row serializes
        // to 4039 bytes ({"id":"N","text":<4000>,"completed":false}) and the budget
        // counts one comma per row, so ids 1..9 cost 4040 and ids 10..16 cost 4041:
        // 9*4040 + 7*4041 = 64647 bytes, and the 17th row (68688) does not fit.
        const page = await tool({ limit: TASK_LIST_MAX_LIMIT });

        expect(page.tasks.map((task) => task.id)).toEqual(
            Array.from({ length: 16 }, (_, index) => String(index + 1))
        );
        expect(page.counts).toEqual({ total: 100, completed: 0, pending: 100 });
        expect(page.page).toEqual({ offset: 0, limit: 100, hasMore: true, nextOffset: 16 });
    });

    it('rejects an out-of-range cursor instead of clamping it', async () => {
        const { tool } = createTaskTool();

        const limitMessage = 'task "limit" must be an integer between 1 and 100 when provided.';

        await expect(tool({ limit: 0 })).rejects.toThrow(limitMessage);
        await expect(tool({ limit: 101 })).rejects.toThrow(limitMessage);
        await expect(tool({ limit: 2.5 })).rejects.toThrow(limitMessage);
        await expect(tool({ limit: '20' })).rejects.toThrow(limitMessage);
        await expect(tool({ offset: -1 })).rejects.toThrow(
            'task "offset" must be a non-negative integer when provided.'
        );
        await expect(tool({ offset: 1.5 })).rejects.toThrow(
            'task "offset" must be a non-negative integer when provided.'
        );

        // A stray cursor beside a patch is reported too, and the patch is not applied.
        await expect(tool({ tasks: [{ text: 'A' }], limit: 500 })).rejects.toThrow(limitMessage);
        expect(await tool({})).toEqual(empty);
    });

    // -----------------------------------------------------------------------
    // Copies, reset, isolation
    // -----------------------------------------------------------------------
    it('hands out copies so a caller cannot mutate the store through a result', async () => {
        const { tool } = createTaskTool();

        const added = await tool({ tasks: [{ text: 'Original' }] });

        added.tasks[0].text = 'Mutated in place';
        added.tasks[0].completed = true;

        expect((await tool({})).tasks).toEqual([{ id: '1', text: 'Original', completed: false }]);
    });

    it('restarts ids on reset() and keeps instances isolated', async () => {
        const first = createTaskTool();
        const second = createTaskTool();

        await first.tool({ tasks: [{ text: 'Only here' }] });

        expect(await second.tool({})).toEqual(empty);

        first.reset();

        expect(await first.tool({})).toEqual(empty);
        expect((await first.tool({ tasks: [{ text: 'Again' }] })).tasks).toEqual([
            { id: '1', text: 'Again', completed: false }
        ]);
        // The other instance is untouched by a sibling reset.
        expect((await second.tool({})).tasks).toEqual([]);
    });

    // -----------------------------------------------------------------------
    // Persistence hooks (R3a) — the store stays `records.todos` shaped
    // -----------------------------------------------------------------------
    it('snapshots a detached copy and restores a validated replacement', async () => {
        const { tool, snapshot, restore } = createTaskTool();

        await tool({ tasks: [{ text: 'Persist me' }, { text: 'Done', completed: true }] });

        expect(snapshot()).toEqual({
            items: [
                { id: '1', text: 'Persist me', completed: false },
                { id: '2', text: 'Done', completed: true }
            ],
            nextId: 3
        });

        const saved = snapshot();

        saved.items[0].text = 'Edited after the snapshot';
        saved.nextId = 99;

        expect((await tool({})).tasks[0]).toEqual({
            id: '1',
            text: 'Persist me',
            completed: false
        });

        restore({ items: [{ id: '7', text: 'Restored', completed: true }], nextId: 8 });

        expect(await tool({})).toEqual({
            tasks: [{ id: '7', text: 'Restored', completed: true }],
            counts: { total: 1, completed: 1, pending: 0 },
            page: firstPage
        });

        // The restored counter wins: the next add continues from it.
        expect((await tool({ tasks: [{ text: 'Next' }] })).tasks).toEqual([
            { id: '7', text: 'Restored', completed: true },
            { id: '8', text: 'Next', completed: false }
        ]);
    });

    it('rejects an invalid restore and leaves the live store untouched', async () => {
        const { tool, restore } = createTaskTool();

        await tool({ tasks: [{ text: 'Still here' }] });

        await expect(() => restore({ items: [{ id: '1', text: 'a', completed: false }], nextId: 1 })).toThrow(
            'todo state.nextId must be greater than the largest id (1); received 1.'
        );
        await expect(() =>
            restore({ items: [{ id: '1', text: 'a', completed: false }, { id: '1', text: 'b', completed: false }], nextId: 2 })
        ).toThrow('todo state contains the duplicate id "1".');
        await expect(() =>
            restore({
                items: Array.from({ length: 201 }, (_, index) => ({
                    id: String(index + 1),
                    text: 'a',
                    completed: false
                })),
                nextId: 202
            })
        ).toThrow('todo state holds 201 todos; the maximum is 200.');

        expect(await tool({})).toEqual({
            tasks: [{ id: '1', text: 'Still here', completed: false }],
            counts: { total: 1, completed: 0, pending: 1 },
            page: firstPage
        });
    });

    it('exposes the pure store reader for the snapshot path', () => {
        const state = readTaskStoreState({
            items: [{ id: '1', text: 'Read me', completed: true }],
            nextId: 2
        });

        expect(state).toEqual({
            items: [{ id: '1', text: 'Read me', completed: true }],
            nextId: 2
        });

        // The reader copies: the caller cannot reach the validated array it returns.
        const again = readTaskStoreState(state);

        again.items[0].text = 'Changed';

        expect(state.items[0].text).toBe('Read me');
    });
});

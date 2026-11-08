// task — the per-harness session task list (core/task.ts).
//
// Unit tests for the factory: the exact patch contract (add / partial patch /
// remove / read), the ONE result envelope every success shares, validation
// errors, atomicity, defensive copies, reset/isolation, the R9 bounds (record
// cap, text cap, pagination, byte budget), and the T1 concurrency surface:
// per-record `rev` + attribution, guarded writes and compare-and-swap, claims
// with leases, `releaseThread`, the bounded change feed behind `since`, keyset
// paging through `afterId`, and the opt-in disjoint merge.
//
// Expectations are derived from the approved wire design, not from the
// implementation's output:
//   - `task({tasks?, remove?, expects?, claim?, release?, takeover?, leaseMs?,
//     since?, offset?, limit?, afterId?, mergeDisjoint?})`, everything optional;
//   - no arguments / `{}` / `null` is a READ;
//   - an entry with no `id` ADDS (text required); an entry with a known `id`
//     PATCHES partially; an unknown id is rejected;
//   - `remove` deletes exact ids;
//   - duplicate/conflicting entries are rejected and the WHOLE patch is validated
//     before anything mutates;
//   - every success returns `{ tasks, counts { total, completed, pending }, page,
//     storeRev }` — the same bounded page, with no action wrapper; the three
//     `changes*` keys appear ONLY when the call passed `since`;
//   - `rev` is CONTENT-only (1 on add, +1 only for a real text/completed change);
//     claim/release/takeover/renew never move it, while `storeRev` moves once per
//     RECORDED event;
//   - an agent-identified patch/removal must carry its `expects` token; a token
//     that no longer matches rejects the whole call and leaves items, nextId,
//     storeRev and the change log untouched;
//   - bounds are unchanged for the list (200 records, 4000 characters, 20/100
//     page, 64 KiB) and pinned for the new parts (lease default 15 min, clamped
//     into 1 min..24 h; a 200-entry log window; at most 50 entries per result).
//
// The harness integration lives in src/harness.task.test.ts; the metadata/schema
// pin lives in src/harness.metadata.test.ts (the schema is owned by the entry).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createTaskTool,
    readTaskStoreState,
    TASK_DEFAULT_LEASE_MS,
    TASK_LIST_MAX_LIMIT,
    TASK_MAX_CHANGES,
    TASK_MAX_CHANGES_IN_RESULT,
    TASK_MAX_LEASE_MS,
    TASK_MAX_RECORDS,
    TASK_MAX_TEXT,
    TASK_MIN_LEASE_MS,
    TASK_RESPONSE_BUDGET_BYTES
} from './task';
import type { TaskResult, TaskToolset } from './task';
// Every rejection this tool raises is a HarnessError (src/core/task.ts), so the
// claim-blocked tests below can assert the TYPE as well as the exact text.
import { HarnessError } from '../util';
import type { Agent, TaskChange, TaskChangeOp, TaskItem, TaskParameters } from '../types';

// THE FROZEN CLOCK. Every timestamp the store writes comes from Date, so the
// whole suite runs at one instant (the lease tests move it on purpose) and each
// expectation can name the EXACT ISO string instead of a regex or a range.
const EPOCH_ISO = '2026-01-01T00:00:00.000Z';
const EPOCH_MS = Date.parse(EPOCH_ISO);

// The default expiry of a claim taken at the frozen instant.
const LEASE_ISO = new Date(EPOCH_MS + TASK_DEFAULT_LEASE_MS).toISOString();

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(EPOCH_MS);
});

afterEach(() => {
    vi.useRealTimers();
});

// The no-argument invocations of the wire design. `tool()` is typed to take its
// parameter object, so the "caller sent nothing" cases are expressed honestly.
const noArgs = (tool: (value: TaskParameters) => Promise<TaskResult>) =>
    tool(undefined as unknown as TaskParameters);

// A malformed argument object. A model (or a restored JSON file) can send any
// shape at all, which the parameter type deliberately forbids, so every "wrong
// type" case goes through this one cast instead of repeating `as unknown as`.
const bad = (value: unknown): TaskParameters => value as TaskParameters;

// THE DEFAULT PAGE CURSOR. Offset mode: no `afterId`/`nextAfterId` keys at all.
const firstPage = { offset: 0, limit: 20, hasMore: false };

// The empty read: every success carries the same keys, so an empty store still
// answers with a page, zeroed counts and storeRev 0 (no `todos` key, no action echo).
const empty = {
    tasks: [],
    counts: { total: 0, completed: 0, pending: 0 },
    page: firstPage,
    storeRev: 0
};

// A deterministic filler task: every character is ASCII, so the UTF-8 size equals
// the string length and the byte-budget assertions below stay exact.
const filler = (length: number): string => 'x'.repeat(length);

// THE CALLER IDENTITY. The harness builds a ToolContext with `agent` and
// `threadId` from the run, never from arguments, so an "agent call" in these
// tests is the same execute() with those two fields set. An agent with a name but
// no thread is a legitimate shape (a manual executeTool call runs as the primary
// agent outside any thread).
const asAgent = (
    toolset: TaskToolset,
    identity: { name: string; threadId?: string },
    parameters: TaskParameters
): Promise<TaskResult> =>
    toolset.tool.execute({
        parameters,
        agent: { name: identity.name } as Agent,
        ...(identity.threadId === undefined ? {} : { threadId: identity.threadId })
    });

// Captures the value a call rejects WITH, so a test can assert both the thrown
// TYPE and the EXACT message. `rejects.toThrow(string)` is only a substring match,
// and `rejects.toBeInstanceOf` alone would let a reworded message through.
const rejection = async (call: Promise<unknown>): Promise<unknown> => {
    try {
        await call;
    } catch (error) {
        return error;
    }

    throw new Error('expected the call to reject, but it resolved');
};

type ItemShape = {
    completed?: boolean;
    rev?: number;
    by?: string;
    threadId?: string;
    // `at: null` suppresses updatedAt entirely — a record that came from a pre-T1
    // snapshot and has never been written since.
    at?: string | null;
    owner?: string;
    ownerThreadId?: string;
    leaseUntil?: number;
};

// One stored record, with the exact key set the tool is required to produce. A
// direct (identity-less) write sets `updatedAt` but has nobody to credit, so
// `updatedBy`/`updatedThreadId` stay ABSENT rather than `undefined`.
const task = (id: string, text: string, shape: ItemShape = {}): TaskItem => ({
    id,
    text,
    completed: shape.completed ?? false,
    rev: shape.rev ?? 1,
    ...(shape.by === undefined ? {} : { updatedBy: shape.by }),
    ...(shape.threadId === undefined ? {} : { updatedThreadId: shape.threadId }),
    ...(shape.at === null ? {} : { updatedAt: shape.at ?? EPOCH_ISO }),
    ...(shape.owner === undefined ? {} : { owner: shape.owner }),
    ...(shape.ownerThreadId === undefined ? {} : { ownerThreadId: shape.ownerThreadId }),
    ...(shape.leaseUntil === undefined ? {} : { leaseUntil: shape.leaseUntil })
});

// One change-log entry in the canonical key order (`rev, id, op, by, threadId,
// at, fields, itemRev`), with the identity/extra keys present only when the event
// actually carried them.
const event = (
    rev: number,
    id: string,
    op: TaskChangeOp,
    shape: {
        by?: string;
        threadId?: string;
        at?: string;
        fields?: Array<'text' | 'completed'>;
        itemRev?: number;
    } = {}
): TaskChange => ({
    rev,
    id,
    op,
    ...(shape.by === undefined ? {} : { by: shape.by }),
    ...(shape.threadId === undefined ? {} : { threadId: shape.threadId }),
    at: shape.at ?? EPOCH_ISO,
    ...(shape.fields === undefined ? {} : { fields: shape.fields }),
    ...(shape.itemRev === undefined ? {} : { itemRev: shape.itemRev })
});

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
            tasks: [task('1', 'Draft plan')],
            counts: { total: 1, completed: 0, pending: 1 },
            page: firstPage,
            storeRev: 1
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
            tasks: [task('1', 'Draft the plan')],
            counts: { total: 1, completed: 0, pending: 1 },
            page: firstPage,
            storeRev: 1
        });

        // A second call appends, and the response carries BOTH rows in order.
        expect(await tool({ tasks: [{ text: 'Review it', completed: true }] })).toEqual({
            tasks: [task('1', 'Draft the plan'), task('2', 'Review it', { completed: true })],
            counts: { total: 2, completed: 1, pending: 1 },
            page: firstPage,
            storeRev: 2
        });
    });

    it('adds every entry of one call in order, each with its own id', async () => {
        const { tool } = createTaskTool();

        const result = await tool({ tasks: [{ text: 'One' }, { text: 'Two' }, { text: 'Three' }] });

        expect(result.tasks).toEqual([
            task('1', 'One'),
            task('2', 'Two'),
            task('3', 'Three')
        ]);
        expect(result.counts).toEqual({ total: 3, completed: 0, pending: 3 });
        // Three records is three store events, one per addition.
        expect(result.storeRev).toBe(3);
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
        // Nothing was stored, and the next add still gets id "1" and storeRev 1.
        expect(await tool({ tasks: [{ text: 'First' }] })).toEqual({
            tasks: [task('1', 'First')],
            counts: { total: 1, completed: 0, pending: 1 },
            page: firstPage,
            storeRev: 1
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
                task('1', 'Draft plan', { completed: true, rev: 2 }),
                task('2', 'Ship it')
            ],
            counts: { total: 2, completed: 1, pending: 1 },
            page: firstPage,
            storeRev: 3
        });

        // text only: the completed flag of id "1" must survive the rename.
        expect(await tool({ tasks: [{ id: '1', text: 'Rewrite the plan' }] })).toEqual({
            tasks: [
                task('1', 'Rewrite the plan', { completed: true, rev: 3 }),
                task('2', 'Ship it')
            ],
            counts: { total: 2, completed: 1, pending: 1 },
            page: firstPage,
            storeRev: 4
        });

        // Reopening a completed task is just another partial patch.
        expect((await tool({ tasks: [{ id: '1', completed: false }] })).tasks[0]).toEqual(
            task('1', 'Rewrite the plan', { rev: 4 })
        );
    });

    it('applies patches, removals, and additions of one call in that order', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: [{ text: 'One' }, { text: 'Two' }, { text: 'Three' }] });

        const result = await tool({
            tasks: [{ id: '1', completed: true }, { text: 'Four' }],
            remove: ['2']
        });

        expect(result.tasks).toEqual([
            task('1', 'One', { completed: true, rev: 2 }),
            // id "2" is gone; the survivor keeps its place and the addition
            // is appended after it, with the next id from the counter.
            task('3', 'Three'),
            task('4', 'Four')
        ]);
        expect(result.counts).toEqual({ total: 3, completed: 1, pending: 2 });
        // 3 adds, then update + remove + add: six recorded events.
        expect(result.storeRev).toBe(6);
    });

    it('ignores a patch entry that names an id and changes no field', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: [{ text: 'Keep me' }] });

        expect(await tool({ tasks: [{ id: '1' }] })).toEqual({
            tasks: [task('1', 'Keep me')],
            counts: { total: 1, completed: 0, pending: 1 },
            page: firstPage,
            storeRev: 1
        });

        // Restating the stored values is the same no-op: no rev bump, no storeRev
        // bump, and no attribution churn.
        const restated = await tool({ tasks: [{ id: '1', text: 'Keep me', completed: false }] });

        expect(restated.tasks).toEqual([task('1', 'Keep me')]);
        expect(restated.storeRev).toBe(1);

        // ...and the log still holds exactly the one add event.
        expect((await tool({ since: 0 })).changes).toEqual([event(1, '1', 'add', { itemRev: 1 })]);
    });

    // -----------------------------------------------------------------------
    // Remove
    // -----------------------------------------------------------------------
    it('removes exact ids and reports the remaining list', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: [{ text: 'One' }, { text: 'Two' }, { text: 'Three' }] });

        expect(await tool({ remove: ['1', '3'] })).toEqual({
            tasks: [task('2', 'Two')],
            counts: { total: 1, completed: 0, pending: 1 },
            page: firstPage,
            storeRev: 5
        });
    });

    it('never reuses a removed id within one instance', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: [{ text: 'Temporary' }] });
        await tool({ remove: ['1'] });

        expect((await tool({ tasks: [{ text: 'Fresh' }] })).tasks).toEqual([task('2', 'Fresh')]);
    });

    // -----------------------------------------------------------------------
    // Rejections: unknown ids, duplicates, conflicts, types — all non-mutating
    // -----------------------------------------------------------------------
    it('rejects unknown ids in every half of a patch', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: [{ text: 'Only one' }] });

        await expect(tool({ tasks: [{ id: '99', completed: true }] })).rejects.toThrow(
            'task has no task with id "99".'
        );
        await expect(tool({ remove: ['99'] })).rejects.toThrow('task has no task with id "99".');
        await expect(tool({ claim: ['99'] })).rejects.toThrow('task has no task with id "99".');
        await expect(tool({ release: ['99'] })).rejects.toThrow('task has no task with id "99".');
        await expect(tool({ takeover: ['99'] })).rejects.toThrow('task has no task with id "99".');

        // The store is exactly as it was: same row, same flag, same ids, same rev.
        expect(await tool({})).toEqual({
            tasks: [task('1', 'Only one')],
            counts: { total: 1, completed: 0, pending: 1 },
            page: firstPage,
            storeRev: 1
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

        // One id, one OPERATION per call, across the ownership verbs too.
        await expect(tool({ claim: ['1', '1'] })).rejects.toThrow(
            'task "claim" lists id "1" more than once.'
        );
        await expect(tool({ claim: ['1'], release: ['1'] })).rejects.toThrow(
            'task id "1" appears in both "claim" and "release"; one operation per id per call.'
        );
        await expect(tool({ tasks: [{ id: '1', completed: true }], takeover: ['1'] })).rejects.toThrow(
            'task id "1" appears in both "tasks" and "takeover"; one operation per id per call.'
        );

        // A rejected batch that also carried a valid addition burns nothing: the
        // list still has two rows, the next id is still "3", and storeRev is still 2.
        expect(await tool({})).toEqual({
            tasks: [task('1', 'One'), task('2', 'Two')],
            counts: { total: 2, completed: 0, pending: 2 },
            page: firstPage,
            storeRev: 2
        });

        expect((await tool({ tasks: [{ text: 'Three' }] })).tasks.map((item) => item.id)).toEqual([
            '1',
            '2',
            '3'
        ]);
    });

    it('rejects a late invalid entry without applying the valid earlier ones', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: [{ text: 'One' }] });

        await expect(
            tool(bad({ tasks: [{ id: '1', completed: true }, { text: 'Two' }, 'nope'] }))
        ).rejects.toThrow(
            'task "tasks[2]" must be an object with an optional "id", "text", and "completed".'
        );

        expect(await tool({})).toEqual({
            tasks: [task('1', 'One')],
            counts: { total: 1, completed: 0, pending: 1 },
            page: firstPage,
            storeRev: 1
        });
    });

    it('reports every field type error instead of ignoring the wrong value', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: [{ text: 'One' }] });

        await expect(tool(bad({ tasks: 'nope' }))).rejects.toThrow(
            'task "tasks" must be an array of task objects when provided.'
        );
        await expect(tool(bad({ remove: 'nope' }))).rejects.toThrow(
            'task "remove" must be an array of task id strings when provided.'
        );
        await expect(tool(bad({ tasks: [{ id: 7, completed: true }] }))).rejects.toThrow(
            'task "tasks[0].id" must be a string when provided.'
        );
        await expect(tool({ tasks: [{ id: '  ', completed: true }] })).rejects.toThrow(
            'task "tasks[0].id" must be a non-empty task id string.'
        );
        await expect(tool(bad({ tasks: [{ id: '1', text: 5 }] }))).rejects.toThrow(
            'task "text" must be a string when provided.'
        );
        await expect(tool(bad({ tasks: [{ id: '1', completed: 'yes' }] }))).rejects.toThrow(
            'task "completed" must be a boolean when provided.'
        );
        await expect(tool({ remove: [''] })).rejects.toThrow(
            'task "remove[0]" must be a non-empty task id string.'
        );
        await expect(tool(bad({ remove: [7] }))).rejects.toThrow(
            'task "remove[0]" must be a non-empty task id string.'
        );

        // T1 argument shapes.
        await expect(tool(bad({ claim: 'nope' }))).rejects.toThrow(
            'task "claim" must be an array of task id strings when provided.'
        );
        await expect(tool(bad({ release: [7] }))).rejects.toThrow(
            'task "release[0]" must be a non-empty task id string.'
        );
        await expect(tool(bad({ expects: 'nope' }))).rejects.toThrow(
            'task "expects" must be an array of { id, rev } objects when provided.'
        );
        await expect(tool(bad({ expects: ['1'] }))).rejects.toThrow(
            'task "expects[0]" must be an object with an "id" and a "rev".'
        );
        await expect(tool(bad({ expects: [{ rev: 1 }] }))).rejects.toThrow(
            'task "expects[0].id" must be a non-empty task id string.'
        );
        await expect(tool(bad({ expects: [{ id: '1' }] }))).rejects.toThrow(
            'task "expects[0].rev" must be a positive integer (the revision you read).'
        );
        await expect(tool({ expects: [{ id: '1', rev: 0 }] })).rejects.toThrow(
            'task "expects[0].rev" must be a positive integer (the revision you read).'
        );
        await expect(tool({ expects: [{ id: '1', rev: 1 }, { id: '1', rev: 1 }] })).rejects.toThrow(
            'task "expects" lists id "1" more than once.'
        );
        await expect(tool(bad({ mergeDisjoint: 'yes' }))).rejects.toThrow(
            'task "mergeDisjoint" must be a boolean when provided.'
        );
        await expect(tool(bad({ leaseMs: 'x' }))).rejects.toThrow(
            'task "leaseMs" must be a positive finite number of milliseconds when provided.'
        );
        await expect(tool({ leaseMs: 0 })).rejects.toThrow(
            'task "leaseMs" must be a positive finite number of milliseconds when provided.'
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

        expect(added.tasks).toEqual([task('1', filler(TASK_MAX_TEXT))]);
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
        expect(restated.tasks[0]).toEqual(task('3', 'Task 3'));
        // The response is still one bounded page (20 rows starting at id "3"), so
        // the appended tail is read through the cursor: 199 rows means the last page
        // starts at offset 196 and holds the new id "201".
        expect(restated.tasks.map((item) => item.id)).toEqual(
            Array.from({ length: 20 }, (_, index) => String(index + 3))
        );

        expect((await tool({ offset: 196, limit: 3 })).tasks).toEqual([
            task('199', 'Task 199'),
            task('200', 'Task 200'),
            task('201', 'New tail')
        ]);
        // 200 adds + (2 removals + 1 addition) = 203 recorded events.
        expect(restated.storeRev).toBe(203);
    });

    // -----------------------------------------------------------------------
    // Pagination: offset mode (the pre-T1 shape) and keyset mode (`afterId`)
    // -----------------------------------------------------------------------
    it('defaults to a 20-item page and exposes the cursor while more rows exist', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: Array.from({ length: 25 }, (_, index) => ({ text: `Task ${index + 1}` })) });

        // One call added 25 rows; the answer is still exactly one bounded page.
        const first = await tool({});

        expect(first.tasks.map((item) => item.id)).toEqual(
            Array.from({ length: 20 }, (_, index) => String(index + 1))
        );
        expect(first.counts).toEqual({ total: 25, completed: 0, pending: 25 });
        expect(first.page).toEqual({ offset: 0, limit: 20, hasMore: true, nextOffset: 20 });
        expect(first.storeRev).toBe(25);

        const second = await tool({ offset: first.page.nextOffset as number });

        expect(second.tasks.map((item) => item.id)).toEqual(['21', '22', '23', '24', '25']);
        expect(second.counts).toEqual({ total: 25, completed: 0, pending: 25 });
        expect(second.page).toEqual({ offset: 20, limit: 20, hasMore: false });
    });

    it('honours an explicit limit and never trims the cursor of a full page', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: Array.from({ length: 5 }, (_, index) => ({ text: `T${index + 1}` })) });

        const page = await tool({ offset: 1, limit: 2 });

        expect(page.tasks.map((item) => item.id)).toEqual(['2', '3']);
        expect(page.page).toEqual({ offset: 1, limit: 2, hasMore: true, nextOffset: 3 });

        // An offset past the end is a valid empty page, not an error. Offset mode
        // echoes the requested cursor even when nothing is there.
        expect(await tool({ offset: 9 })).toEqual({
            tasks: [],
            counts: { total: 5, completed: 0, pending: 5 },
            page: { offset: 9, limit: 20, hasMore: false },
            storeRev: 5
        });
    });

    it('truncates a page at the 64 KiB serialized budget and still reports the cursor', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: Array.from({ length: 100 }, () => ({ text: filler(TASK_MAX_TEXT) })) });

        // Exact arithmetic for this fixture, not a range check. One row serializes
        // to 4085 bytes ({"id":"N","text":<4000>,"completed":false,"rev":1,
        // "updatedAt":"2026-01-01T00:00:00.000Z"}) and the budget counts one comma
        // per row, so ids 1..9 cost 4086 and ids 10..16 cost 4087:
        // 9*4086 + 7*4087 = 65383 bytes, and the 17th row (69470) does not fit.
        const page = await tool({ limit: TASK_LIST_MAX_LIMIT });

        expect(page.tasks.map((item) => item.id)).toEqual(
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
        await expect(tool(bad({ limit: '20' }))).rejects.toThrow(limitMessage);
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

    it('walks every record through afterId while another agent removes records', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: Array.from({ length: 25 }, (_, index) => ({ text: `T${index + 1}` })) });

        const seen: string[] = [];
        const pages: TaskResult['page'][] = [];
        let afterId = '0';

        for (let guard = 0; guard < 12; guard++) {
            const page = await tool({ afterId, limit: 4 });

            seen.push(...page.tasks.map((item) => item.id));
            pages.push(page.page);

            if (!page.page.hasMore) break;

            afterId = page.page.nextAfterId as string;

            // Remove a record BEFORE the cursor after the first page. Offset paging
            // would then silently skip the record that slid into the vacated slot;
            // the id cursor cannot, because "everything above 4" is stable.
            if (guard === 0) await tool({ remove: ['2'] });
        }

        // Every record is seen exactly once: the id "2" removal landed AFTER the
        // page that carried it, and the pages below it shifted by one slot without
        // the walk noticing (offset paging would have skipped id "5" there).
        expect(seen).toEqual(Array.from({ length: 25 }, (_, index) => String(index + 1)));
        // The second page reports the EFFECTIVE index of its first record (3, because
        // 1/3/4 precede 5), and it never carries an offset-mode cursor.
        expect(pages[1]).toEqual({
            offset: 3,
            limit: 4,
            hasMore: true,
            afterId: '4',
            nextAfterId: '8'
        });
        // The final page reports no next cursor, and echoes the one it was taken after.
        expect(pages[pages.length - 1]).toEqual({
            offset: 23,
            limit: 4,
            hasMore: false,
            afterId: '24'
        });
    });

    it('reports an empty keyset page at the ordered length', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: [{ text: 'A' }, { text: 'B' }] });

        expect(await tool({ afterId: '9' })).toEqual({
            tasks: [],
            counts: { total: 2, completed: 0, pending: 2 },
            page: { offset: 2, limit: 20, hasMore: false, afterId: '9' },
            storeRev: 2
        });
    });

    it('refuses to combine the two cursors in one call', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: [{ text: 'A' }] });

        // Explicit offset 0 still counts as "the caller chose offset mode".
        await expect(tool({ afterId: '1', offset: 0 })).rejects.toThrow(
            'task "afterId" and "offset" cannot be combined.'
        );
        await expect(tool({ afterId: '1', offset: 4 })).rejects.toThrow(
            'task "afterId" and "offset" cannot be combined.'
        );
    });

    it('rejects a malformed keyset cursor', async () => {
        const { tool } = createTaskTool();

        await expect(tool({ afterId: 'abc' })).rejects.toThrow(
            'task "afterId" must be a decimal task id string when provided.'
        );
        await expect(tool({ afterId: '1.5' })).rejects.toThrow(
            'task "afterId" must be a decimal task id string when provided.'
        );
        await expect(tool({ afterId: 4 as unknown as string })).rejects.toThrow(
            'task "afterId" must be a decimal task id string when provided.'
        );
        await expect(tool({ afterId: '9'.repeat(20) })).rejects.toThrow(
            'task "afterId" is larger than a safe integer.'
        );
    });

    it('truncates a keyset page at the byte budget and cursors from the last included id', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: Array.from({ length: 100 }, () => ({ text: filler(TASK_MAX_TEXT) })) });

        // Same 16-row arithmetic as the offset-mode budget test, but the cursor is an
        // id: whoever reads on passes "16" back, never an index.
        const page = await tool({ afterId: '0', limit: TASK_LIST_MAX_LIMIT });

        expect(page.tasks.map((item) => item.id)).toEqual(
            Array.from({ length: 16 }, (_, index) => String(index + 1))
        );
        expect(page.page).toEqual({
            offset: 0,
            limit: 100,
            hasMore: true,
            afterId: '0',
            nextAfterId: '16'
        });
    });

    it('pages a restored store whose array order is not numeric', async () => {
        const { tool, restore } = createTaskTool();

        // A hand-edited file may list records out of id order. Keyset paging sorts a
        // copy by numeric id, so the walk is still total and still gap-free.
        restore({
            items: [
                { id: '3', text: 'C', completed: false },
                { id: '1', text: 'A', completed: false },
                { id: '2', text: 'B', completed: true }
            ],
            nextId: 4
        });

        const page = await tool({ afterId: '1', limit: 2 });

        expect(page.tasks.map((item) => item.id)).toEqual(['2', '3']);
        expect(page.page).toEqual({ offset: 1, limit: 2, hasMore: false, afterId: '1' });
        // An old file has no revision history: the store restarts at 0.
        expect(page.storeRev).toBe(0);
    });

    // -----------------------------------------------------------------------
    // T1: content revisions
    // -----------------------------------------------------------------------
    it('starts a new record at rev 1 and bumps it only for a real content change', async () => {
        const { tool } = createTaskTool();

        const added = await tool({ tasks: [{ text: 'One' }] });

        expect(added.tasks[0].rev).toBe(1);
        expect(added.storeRev).toBe(1);

        expect((await tool({ tasks: [{ id: '1', text: 'Two' }] })).tasks[0].rev).toBe(2);
        expect((await tool({ tasks: [{ id: '1', completed: true }] })).tasks[0].rev).toBe(3);

        // Both fields at once is still ONE revision step, and the log names both.
        const renamed = await tool({ tasks: [{ id: '1', text: 'Three', completed: false }] });

        expect(renamed.tasks[0].rev).toBe(4);
        expect(renamed.storeRev).toBe(4);
        expect(renamed.changes).toBeUndefined();
        expect((await tool({ since: 3 })).changes).toEqual([
            event(4, '1', 'update', { fields: ['text', 'completed'], itemRev: 4 })
        ]);
    });

    // -----------------------------------------------------------------------
    // T1: attribution
    // -----------------------------------------------------------------------
    it('attributes a content write to the calling agent and thread', async () => {
        const toolset = createTaskTool();

        await toolset.tool({ tasks: [{ text: 'Seed' }] });

        const result = await asAgent(
            toolset,
            { name: 'writer', threadId: 'thread-9' },
            { tasks: [{ id: '1', text: 'Rewritten' }], expects: [{ id: '1', rev: 1 }] }
        );

        expect(result.tasks[0]).toEqual(
            task('1', 'Rewritten', { rev: 2, by: 'writer', threadId: 'thread-9' })
        );
        // The change entry carries the same identity.
        expect((await toolset.tool({ since: 1 })).changes).toEqual([
            event(2, '1', 'update', {
                by: 'writer',
                threadId: 'thread-9',
                fields: ['text'],
                itemRev: 2
            })
        ]);
    });

    it('writes no identity keys on a direct call and keeps the earlier author on a later patch', async () => {
        const toolset = createTaskTool();

        const added = await asAgent(toolset, { name: 'a', threadId: 't-a' }, { tasks: [{ text: 'Seed' }] });

        // Exactly the keys the contract allows: no `updated*: undefined` placeholders.
        expect(Object.keys(added.tasks[0] as TaskItem)).toEqual([
            'id',
            'text',
            'completed',
            'rev',
            'updatedBy',
            'updatedThreadId',
            'updatedAt'
        ]);

        // A later direct write has no identity to credit, so the previous author
        // stays and only the timestamp moves.
        vi.setSystemTime(EPOCH_MS + 5_000);

        expect(await toolset.tool({ tasks: [{ id: '1', completed: true }] })).toEqual({
            tasks: [
                task('1', 'Seed', {
                    completed: true,
                    rev: 2,
                    by: 'a',
                    threadId: 't-a',
                    at: '2026-01-01T00:00:05.000Z'
                })
            ],
            counts: { total: 1, completed: 1, pending: 0 },
            page: firstPage,
            storeRev: 2
        });
    });

    // -----------------------------------------------------------------------
    // T1: guarded writes and compare-and-swap
    // -----------------------------------------------------------------------
    it('requires an expects token for every guarded patch and removal', async () => {
        const toolset = createTaskTool();

        await asAgent(toolset, { name: 'a', threadId: 't-a' }, { tasks: [{ text: 'One' }, { text: 'Two' }] });

        await expect(
            asAgent(toolset, { name: 'b', threadId: 't-b' }, { tasks: [{ id: '1', completed: true }] })
        ).rejects.toThrow('guarded write: pass expects [{ id, rev }] for task "1" (read it first).');

        await expect(
            asAgent(toolset, { name: 'b', threadId: 't-b' }, { remove: ['2'] })
        ).rejects.toThrow('guarded write: pass expects [{ id, rev }] for task "2" (read it first).');

        // A brand-new record needs no token: there is nothing to overwrite.
        expect(
            (
                await asAgent(toolset, { name: 'b', threadId: 't-b' }, { tasks: [{ text: 'Three' }] })
            ).counts
        ).toEqual({ total: 3, completed: 0, pending: 3 });

        // And an unthreaded agent call is still an identified caller.
        await expect(asAgent(toolset, { name: 'b' }, { tasks: [{ id: '1', completed: true }] })).rejects.toThrow(
            'guarded write: pass expects [{ id, rev }] for task "1" (read it first).'
        );
    });

    it('permits a blind write when the caller has no identity', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: [{ text: 'Driver' }] });

        expect((await tool({ tasks: [{ id: '1', completed: true }] })).tasks[0]).toEqual(
            task('1', 'Driver', { completed: true, rev: 2 })
        );
        expect((await tool({ remove: ['1'] })).counts).toEqual({ total: 0, completed: 0, pending: 0 });
    });

    it('rejects a stale write atomically and names the concurrent editor', async () => {
        const toolset = createTaskTool();

        await toolset.tool({ tasks: [{ text: 'Shared' }, { text: 'Other' }] });

        // b renames id "1": rev 2, storeRev 3, attributed to b.
        await asAgent(
            toolset,
            { name: 'scribe', threadId: 't-b' },
            { tasks: [{ id: '1', text: 'Renamed by scribe' }], expects: [{ id: '1', rev: 1 }] }
        );

        // a still believes both records are at rev 1. Its token for id "2" is
        // correct, but a rejection is atomic: nothing in the call is applied.
        await expect(
            asAgent(
                toolset,
                { name: 'a', threadId: 't-a' },
                {
                    tasks: [{ id: '1', completed: true }, { id: '2', completed: true }],
                    expects: [
                        { id: '1', rev: 1 },
                        { id: '2', rev: 1 }
                    ]
                }
            )
        ).rejects.toThrow(
            'task "1" changed since revision 1 (now 2, last edited by "scribe"); re-read and retry; changed fields: text.'
        );

        expect(await toolset.tool({})).toEqual({
            tasks: [task('1', 'Renamed by scribe', { rev: 2, by: 'scribe', threadId: 't-b' }), task('2', 'Other')],
            counts: { total: 2, completed: 0, pending: 2 },
            page: firstPage,
            storeRev: 3
        });
        // The log did not grow either: a rejected call records nothing.
        expect(toolset.snapshot().changes).toHaveLength(3);
    });

    it('says so when the record a token points at is gone', async () => {
        const toolset = createTaskTool();

        await toolset.tool({ tasks: [{ text: 'Doomed' }] });
        await toolset.tool({ remove: ['1'] });

        await expect(toolset.tool({ expects: [{ id: '1', rev: 1 }] })).rejects.toThrow(
            'task "1" was removed since revision 1; re-read the list.'
        );
        expect(toolset.snapshot().storeRev).toBe(2);
    });

    // -----------------------------------------------------------------------
    // T1 REMOVED-SINCE PRECEDENCE (review fix). The token — not the half of the
    // call that spelled the id — is the proof of which record is gone, so the
    // removed-since answer is produced BEFORE any entry lookup: src/core/task.ts
    // readPatch step 3 (tokens) runs before step 4 (lookups). A call that sent no
    // token keeps the old `task has no task with id "<id>".` answer.
    // -----------------------------------------------------------------------
    it('answers removed-since for any call that tokens a deleted id, whatever named it', async () => {
        const toolset = createTaskTool();

        // Two records (storeRev 2), then id "1" is deleted by a blind driver call
        // (storeRev 3). Id "2" survives at rev 1 and nextId is already 3.
        await toolset.tool({ tasks: [{ text: 'Doomed' }, { text: 'Survivor' }] });
        await toolset.tool({ remove: ['1'] });

        const REMOVED = 'task "1" was removed since revision 1; re-read the list.';

        // (1) A `tasks` PATCH of the gone id, with its token: removed-since, not the
        // generic no-task error the entry lookup used to win with.
        await expect(
            asAgent(
                toolset,
                { name: 'a', threadId: 't-a' },
                { tasks: [{ id: '1', completed: true }], expects: [{ id: '1', rev: 1 }] }
            )
        ).rejects.toThrow(REMOVED);

        // (2) A REMOVE of the gone id, with its token: the same answer.
        await expect(
            asAgent(
                toolset,
                { name: 'a', threadId: 't-a' },
                { remove: ['1'], expects: [{ id: '1', rev: 1 }] }
            )
        ).rejects.toThrow(REMOVED);

        // (3) An OWNERSHIP verb on the gone id, with its token: tokens guard the
        // claim lists exactly like the content lists.
        await expect(
            asAgent(
                toolset,
                { name: 'a', threadId: 't-a' },
                { claim: ['1'], expects: [{ id: '1', rev: 1 }] }
            )
        ).rejects.toThrow(REMOVED);

        // (4) A token for the gone id beside a live patch of ANOTHER record: the
        // removal is the fact the caller needs first, so it outranks the coverage
        // error the untouched token would produce (src/harness.task.test.ts pins the
        // same precedence through the harness).
        await expect(
            asAgent(
                toolset,
                { name: 'a', threadId: 't-a' },
                {
                    tasks: [{ id: '2', completed: true }],
                    expects: [
                        { id: '1', rev: 1 },
                        { id: '2', rev: 1 }
                    ]
                }
            )
        ).rejects.toThrow(REMOVED);

        // (5) NO TOKEN: the untouched half of the contract. A patch, a removal and a
        // claim of an id the store does not have all keep the unknown-id message, and
        // a blind direct call is never told about a guard it never asked for.
        await expect(toolset.tool({ tasks: [{ id: '1', completed: true }] })).rejects.toThrow(
            'task has no task with id "1".'
        );
        await expect(toolset.tool({ remove: ['1'] })).rejects.toThrow(
            'task has no task with id "1".'
        );
        await expect(
            asAgent(toolset, { name: 'a', threadId: 't-a' }, { tasks: [{ id: '1', completed: true }] })
        ).rejects.toThrow('task has no task with id "1".');

        // (6) A token for a LIVE record this call does not change stays the structural
        // error — step 3 only answers for records that are actually gone.
        await expect(
            asAgent(
                toolset,
                { name: 'a', threadId: 't-a' },
                { tasks: [{ text: 'Fresh' }], expects: [{ id: '2', rev: 1 }] }
            )
        ).rejects.toThrow('task "expects" names id "2", which this call does not change.');

        // ATOMICITY across all eight rejections: the survivor is byte-identical, the id
        // counter did not burn a slot for the rejected "Fresh" add, and neither the
        // store revision nor the change log moved.
        expect(toolset.snapshot()).toEqual({
            items: [task('2', 'Survivor')],
            nextId: 3,
            storeRev: 3,
            changes: [
                event(1, '1', 'add', { itemRev: 1 }),
                event(2, '2', 'add', { itemRev: 1 }),
                event(3, '1', 'remove')
            ]
        });
    });

    it('rejects an expects token for an id this call does not change', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: [{ text: 'A' }, { text: 'B' }] });

        await expect(
            tool({
                tasks: [{ id: '1', completed: true }],
                expects: [
                    { id: '1', rev: 1 },
                    { id: '2', rev: 1 }
                ]
            })
        ).rejects.toThrow('task "expects" names id "2", which this call does not change.');

        // A token beside a claim is fine: the ownership verbs may be guarded too.
        expect((await tool({ tasks: [{ id: '1', completed: true }], expects: [{ id: '1', rev: 1 }] })).tasks[0].rev).toBe(2);
    });

    // -----------------------------------------------------------------------
    // T1: claims, leases, takeovers, releases
    // -----------------------------------------------------------------------
    it('claims a record with a default lease without touching rev', async () => {
        const toolset = createTaskTool();

        await toolset.tool({ tasks: [{ text: 'Work' }] });

        const claimed = await asAgent(toolset, { name: 'a', threadId: 't-a' }, { claim: ['1'] });

        expect(claimed.tasks[0]).toEqual(
            task('1', 'Work', {
                by: 'a',
                threadId: 't-a',
                owner: 'a',
                ownerThreadId: 't-a',
                leaseUntil: EPOCH_MS + TASK_DEFAULT_LEASE_MS
            })
        );
        // A claim is an ownership event, not a content change.
        expect(claimed.tasks[0].rev).toBe(1);
        expect(claimed.storeRev).toBe(2);
        expect((await toolset.tool({ since: 1 })).changes).toEqual([
            event(2, '1', 'claim', { by: 'a', threadId: 't-a' })
        ]);
    });

    it('renews its own claim silently and treats another thread as a different holder', async () => {
        const toolset = createTaskTool();

        await toolset.tool({ tasks: [{ text: 'Work' }] });

        const first = await asAgent(toolset, { name: 'a', threadId: 't-a' }, { claim: ['1'] });

        // Same agent, same thread: a heartbeat. The lease is re-issued from the
        // current instant, and nothing else about the store moves.
        vi.setSystemTime(EPOCH_MS + 60_000);

        const renewed = await asAgent(toolset, { name: 'a', threadId: 't-a' }, { claim: ['1'] });

        expect(renewed.storeRev).toBe(first.storeRev);
        expect(renewed.tasks[0].rev).toBe(1);
        expect(renewed.tasks[0].leaseUntil).toBe(EPOCH_MS + 60_000 + TASK_DEFAULT_LEASE_MS);
        expect(toolset.snapshot().changes).toEqual([
            event(1, '1', 'add', { itemRev: 1 }),
            event(2, '1', 'claim', { by: 'a', threadId: 't-a' })
        ]);

        // Same agent, different thread: the holder pair is the AGENT plus the
        // THREAD, so this is somebody else and the live claim blocks them — with
        // the RENEWED expiry, because the heartbeat re-issued the lease.
        await expect(
            asAgent(toolset, { name: 'a', threadId: 't-b' }, { claim: ['1'] })
        ).rejects.toThrow(
            `task "1" is claimed by "a" until ${new Date(EPOCH_MS + 60_000 + TASK_DEFAULT_LEASE_MS).toISOString()}; release it or take it over first.`
        );

        // T1 REVIEW FIX: a blocked claim is a HarnessError like every other
        // rejection in this tool (src/core/task.ts claimMessage used to `throw` a
        // bare string). The message text is a wire value — harness.ts renders it as
        // `Tool "task" failed: <message>` — so it must stay byte-identical while the
        // thrown value becomes typed. All three blocked paths are covered.
        const BLOCKED = `task "1" is claimed by "a" until ${new Date(EPOCH_MS + 60_000 + TASK_DEFAULT_LEASE_MS).toISOString()}; release it or take it over first.`;

        for (const parameters of [
            { claim: ['1'] },
            { release: ['1'] },
            { tasks: [{ id: '1', completed: true }], expects: [{ id: '1', rev: 1 }] }
        ] as TaskParameters[]) {
            const error = await rejection(asAgent(toolset, { name: 'b', threadId: 't-b' }, parameters));

            expect(error).toBeInstanceOf(HarnessError);
            expect((error as HarnessError).message).toBe(BLOCKED);
        }

        // The lease renewal also proves the rejection left the store untouched: the
        // heartbeat lease is still the only claim and nothing was logged.
        expect(toolset.snapshot().items[0].owner).toBe('a');
        expect(toolset.snapshot().changes).toEqual([
            event(1, '1', 'add', { itemRev: 1 }),
            event(2, '1', 'claim', { by: 'a', threadId: 't-a' })
        ]);
    });

    it('blocks a foreign write while a claim is live, then clears the expired claim first', async () => {
        const toolset = createTaskTool();

        await toolset.tool({ tasks: [{ text: 'Work' }] });
        await asAgent(toolset, { name: 'a', threadId: 't-a' }, { claim: ['1'] });

        const patch = { tasks: [{ id: '1', completed: true }], expects: [{ id: '1', rev: 1 }] };

        await expect(asAgent(toolset, { name: 'b', threadId: 't-b' }, patch)).rejects.toThrow(
            `task "1" is claimed by "a" until ${LEASE_ISO}; release it or take it over first.`
        );
        await expect(
            asAgent(toolset, { name: 'b', threadId: 't-b' }, { remove: ['1'], expects: [{ id: '1', rev: 1 }] })
        ).rejects.toThrow(`task "1" is claimed by "a" until ${LEASE_ISO}; release it or take it over first.`);
        expect(toolset.snapshot().storeRev).toBe(2);

        // The holder is never blocked by its own claim.
        const byHolder = await asAgent(toolset, { name: 'a', threadId: 't-a' }, patch);

        expect(byHolder.tasks[0]).toEqual(
            task('1', 'Work', {
                completed: true,
                rev: 2,
                by: 'a',
                threadId: 't-a',
                owner: 'a',
                ownerThreadId: 't-a',
                leaseUntil: EPOCH_MS + TASK_DEFAULT_LEASE_MS
            })
        );
        expect(byHolder.storeRev).toBe(3);

        // Past the lease the same foreign call goes through, and the abandoned
        // claim is cleared and logged BEFORE the update it unlocked.
        vi.setSystemTime(EPOCH_MS + TASK_DEFAULT_LEASE_MS + 2_000);

        const afterExpiry = await asAgent(
            toolset,
            { name: 'c', threadId: 't-c' },
            { tasks: [{ id: '1', text: 'Finished by c' }], expects: [{ id: '1', rev: 2 }] }
        );
        const at = '2026-01-01T00:15:02.000Z';

        expect(afterExpiry.tasks[0]).toEqual(
            task('1', 'Finished by c', {
                completed: true,
                rev: 3,
                by: 'c',
                threadId: 't-c',
                at
            })
        );
        expect(afterExpiry.storeRev).toBe(5);
        expect((await toolset.tool({ since: 3 })).changes).toEqual([
            event(4, '1', 'release', { by: 'c', threadId: 't-c', at }),
            event(5, '1', 'update', { by: 'c', threadId: 't-c', at, fields: ['text'], itemRev: 3 })
        ]);
    });

    it('releases for its holder, ignores an unowned release, and refuses a foreign one', async () => {
        const toolset = createTaskTool();

        await toolset.tool({ tasks: [{ text: 'Work' }] });
        await asAgent(toolset, { name: 'a', threadId: 't-a' }, { claim: ['1'] });

        await expect(
            asAgent(toolset, { name: 'b', threadId: 't-b' }, { release: ['1'] })
        ).rejects.toThrow(`task "1" is claimed by "a" until ${LEASE_ISO}; release it or take it over first.`);

        // The holder gives it back: the claim keys disappear entirely.
        const released = await asAgent(toolset, { name: 'a', threadId: 't-a' }, { release: ['1'] });

        expect(released.tasks[0]).toEqual(task('1', 'Work', { by: 'a', threadId: 't-a' }));
        expect(released.storeRev).toBe(3);

        // Releasing what nobody holds is a success with no event at all.
        const again = await asAgent(toolset, { name: 'a', threadId: 't-a' }, { release: ['1'] });

        expect(again.storeRev).toBe(3);
        expect(toolset.snapshot().changes).toEqual([
            event(1, '1', 'add', { itemRev: 1 }),
            event(2, '1', 'claim', { by: 'a', threadId: 't-a' }),
            event(3, '1', 'release', { by: 'a', threadId: 't-a' })
        ]);

        // An expired foreign claim may be released: the lock lifted is news.
        await asAgent(toolset, { name: 'a', threadId: 't-a' }, { claim: ['1'] });
        vi.setSystemTime(EPOCH_MS + TASK_DEFAULT_LEASE_MS + 3_000);

        const cleared = await asAgent(toolset, { name: 'b', threadId: 't-b' }, { release: ['1'] });
        const at = '2026-01-01T00:15:03.000Z';

        expect(cleared.storeRev).toBe(5);
        expect(cleared.tasks[0].owner).toBeUndefined();
        expect((await toolset.tool({ since: 4 })).changes).toEqual([
            event(5, '1', 'release', { by: 'b', threadId: 't-b', at })
        ]);
    });

    it('takes over a live claim deliberately', async () => {
        const toolset = createTaskTool();

        await toolset.tool({ tasks: [{ text: 'Work' }] });
        await asAgent(toolset, { name: 'a', threadId: 't-a' }, { claim: ['1'] });

        // b moves in even though a's lease is still live — that is the whole point
        // of `takeover` (the holder's thread is gone, the work must continue).
        const taken = await asAgent(toolset, { name: 'b', threadId: 't-b' }, { takeover: ['1'] });

        expect(taken.tasks[0]).toEqual(
            task('1', 'Work', {
                by: 'b',
                threadId: 't-b',
                owner: 'b',
                ownerThreadId: 't-b',
                leaseUntil: EPOCH_MS + TASK_DEFAULT_LEASE_MS
            })
        );
        expect(taken.tasks[0].rev).toBe(1);
        // A takeover is recorded as a claim: from a reader's side the holder changed.
        expect((await toolset.tool({ since: 2 })).changes).toEqual([
            event(3, '1', 'claim', { by: 'b', threadId: 't-b' })
        ]);

        // The new holder owns the record now.
        expect(
            (
                await asAgent(
                    toolset,
                    { name: 'b', threadId: 't-b' },
                    { tasks: [{ id: '1', completed: true }], expects: [{ id: '1', rev: 1 }] }
                )
            ).tasks[0].completed
        ).toBe(true);

        // A takeover by the current holder is only a renewal.
        expect((await asAgent(toolset, { name: 'b', threadId: 't-b' }, { takeover: ['1'] })).storeRev).toBe(4);
    });

    it('requires an agent identity for the ownership verbs', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: [{ text: 'Work' }] });

        const message =
            'task "claim", "release" and "takeover" need an agent identity; call the tool through a harness.';

        await expect(tool({ claim: ['1'] })).rejects.toThrow(message);
        await expect(tool({ release: ['1'] })).rejects.toThrow(message);
        await expect(tool({ takeover: ['1'] })).rejects.toThrow(message);
    });

    it('clamps a lease into the documented bounds and refuses a lease with nothing to lease', async () => {
        const toolset = createTaskTool();

        await toolset.tool({ tasks: [{ text: 'A' }, { text: 'B' }, { text: 'C' }] });

        const short = await asAgent(toolset, { name: 'a', threadId: 't' }, { claim: ['1'], leaseMs: 1 });

        expect(short.tasks[0].leaseUntil).toBe(EPOCH_MS + TASK_MIN_LEASE_MS);

        const long = await asAgent(toolset, { name: 'a', threadId: 't' }, { claim: ['2'], leaseMs: 10 * 24 * 60 * 60_000 });

        expect(long.tasks[1].leaseUntil).toBe(EPOCH_MS + TASK_MAX_LEASE_MS);

        const defaulted = await asAgent(toolset, { name: 'a', threadId: 't' }, { takeover: ['3'] });

        expect(defaulted.tasks[2].leaseUntil).toBe(EPOCH_MS + TASK_DEFAULT_LEASE_MS);

        await expect(
            toolset.tool({ tasks: [{ id: '1', text: 'Renamed' }], leaseMs: 60_000 })
        ).rejects.toThrow('task "leaseMs" needs a "claim" or "takeover" id to apply to.');
    });

    it('clears only the asked-for thread through releaseThread', async () => {
        const toolset = createTaskTool();

        await toolset.tool({ tasks: [{ text: 'One' }, { text: 'Two' }, { text: 'Three' }] });

        await asAgent(toolset, { name: 'a', threadId: 'thread-1' }, { claim: ['1'] });
        await asAgent(toolset, { name: 'b', threadId: 'thread-2' }, { claim: ['2'] });
        await asAgent(toolset, { name: 'a', threadId: 'thread-1' }, { claim: ['3'] });
        expect(toolset.snapshot().storeRev).toBe(6);

        // Two records belonged to thread-1; thread-2 keeps its lock.
        expect(toolset.releaseThread('thread-1')).toBe(2);

        const state = toolset.snapshot();

        expect(state.items.map((item) => item.owner)).toEqual([undefined, 'b', undefined]);
        expect(state.items.map((item) => item.leaseUntil)).toEqual([undefined, EPOCH_MS + TASK_DEFAULT_LEASE_MS, undefined]);
        expect(state.items.map((item) => item.rev)).toEqual([1, 1, 1]);
        expect(state.storeRev).toBe(8);
        expect(state.changes?.slice(-2)).toEqual([
            event(7, '1', 'release', { threadId: 'thread-1' }),
            event(8, '3', 'release', { threadId: 'thread-1' })
        ]);

        // Nothing left for that thread: the second call is a silent zero.
        expect(toolset.releaseThread('thread-1')).toBe(0);
        expect(toolset.snapshot().storeRev).toBe(8);
        // A thread that never claimed anything is also a zero.
        expect(toolset.releaseThread('thread-99')).toBe(0);
    });

    it('applies one call in the order claim, release, patch, remove, add', async () => {
        const toolset = createTaskTool();

        await toolset.tool({ tasks: [{ text: 'One' }, { text: 'Two' }, { text: 'Three' }] });

        await asAgent(
            toolset,
            { name: 'a', threadId: 't-a' },
            {
                tasks: [{ id: '1', completed: true }, { text: 'Four' }],
                remove: ['2'],
                claim: ['3'],
                expects: [
                    { id: '1', rev: 1 },
                    { id: '2', rev: 1 }
                ]
            }
        );

        // The log is the proof of the apply order: claim, then patch, then removal,
        // then the addition.
        expect(toolset.snapshot().changes).toEqual([
            event(1, '1', 'add', { itemRev: 1 }),
            event(2, '2', 'add', { itemRev: 1 }),
            event(3, '3', 'add', { itemRev: 1 }),
            event(4, '3', 'claim', { by: 'a', threadId: 't-a' }),
            event(5, '1', 'update', { by: 'a', threadId: 't-a', fields: ['completed'], itemRev: 2 }),
            event(6, '2', 'remove', { by: 'a', threadId: 't-a' }),
            event(7, '4', 'add', { by: 'a', threadId: 't-a', itemRev: 1 })
        ]);
    });

    // -----------------------------------------------------------------------
    // T1: the `since` change feed
    // -----------------------------------------------------------------------
    it('returns the events since a revision for every kind of change', async () => {
        const toolset = createTaskTool();

        const added = await asAgent(toolset, { name: 'a', threadId: 't-a' }, { tasks: [{ text: 'Feed' }] });

        // No `since` -> none of the three change keys are present at all.
        expect(Object.keys(added)).toEqual(['tasks', 'counts', 'page', 'storeRev']);

        await asAgent(
            toolset,
            { name: 'a', threadId: 't-a' },
            { tasks: [{ id: '1', completed: true }], expects: [{ id: '1', rev: 1 }] }
        );
        await asAgent(toolset, { name: 'a', threadId: 't-a' }, { claim: ['1'] });
        await asAgent(toolset, { name: 'a', threadId: 't-a' }, { release: ['1'] });
        const removed = await asAgent(
            toolset,
            { name: 'a', threadId: 't-a' },
            { remove: ['1'], expects: [{ id: '1', rev: 2 }] }
        );

        expect(removed.storeRev).toBe(5);

        const feed = await toolset.tool({ since: 0 });

        expect(feed.changes).toEqual([
            event(1, '1', 'add', { by: 'a', threadId: 't-a', itemRev: 1 }),
            event(2, '1', 'update', { by: 'a', threadId: 't-a', fields: ['completed'], itemRev: 2 }),
            event(3, '1', 'claim', { by: 'a', threadId: 't-a' }),
            event(4, '1', 'release', { by: 'a', threadId: 't-a' }),
            event(5, '1', 'remove', { by: 'a', threadId: 't-a' })
        ]);
        expect(feed.changesHasMore).toBe(false);
        expect(feed.changesTruncated).toBe(false);

        // A reader that saw revision 3 gets exactly what it missed, oldest first.
        expect((await toolset.tool({ since: 3 })).changes).toEqual([
            event(4, '1', 'release', { by: 'a', threadId: 't-a' }),
            event(5, '1', 'remove', { by: 'a', threadId: 't-a' })
        ]);

        // Up to date -> an empty feed, and the flags say nothing is pending.
        const current = await toolset.tool({ since: 5 });

        expect(current.changes).toEqual([]);
        expect(current.changesHasMore).toBe(false);
        expect(current.changesTruncated).toBe(false);
        expect(current.tasks).toEqual([]);
    });

    it('caps the feed at 50 entries and reports that more remain', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: Array.from({ length: 60 }, (_, index) => ({ text: `T${index + 1}` })) });

        // limit 1 keeps the PAGE small on purpose, so the only thing that can cut
        // the feed here is the entry cap.
        const feed = await tool({ since: 0, limit: 1 });

        expect(feed.changes).toHaveLength(TASK_MAX_CHANGES_IN_RESULT);
        expect(feed.changes?.[0]).toEqual(event(1, '1', 'add', { itemRev: 1 }));
        expect(feed.changes?.[TASK_MAX_CHANGES_IN_RESULT - 1]).toEqual(
            event(TASK_MAX_CHANGES_IN_RESULT, '50', 'add', { itemRev: 1 })
        );
        expect(feed.changesHasMore).toBe(true);
        expect(feed.changesTruncated).toBe(false);

        // Resuming from the last reported revision continues the walk.
        const next = await tool({ since: TASK_MAX_CHANGES_IN_RESULT, limit: 1 });

        expect(next.changes).toHaveLength(10);
        expect(next.changes?.[0]).toEqual(event(51, '51', 'add', { itemRev: 1 }));
        expect(next.changesHasMore).toBe(false);
    });

    it('flags a feed the trimmed window can no longer cover', async () => {
        const toolset = createTaskTool();
        const { tool } = toolset;

        // 200 adds fill the window exactly; the 201st event pushes the add of id "1"
        // out of it, so a reader at since 0 has already missed one event.
        await tool({
            tasks: Array.from({ length: TASK_MAX_RECORDS }, (_, index) => ({ text: `T${index + 1}` }))
        });
        await tool({ tasks: [{ id: '1', completed: true }] });

        // The window itself is bounded: the oldest entry is gone, not hidden.
        expect(toolset.snapshot().changes).toHaveLength(TASK_MAX_CHANGES);
        expect(toolset.snapshot().changes?.[0].rev).toBe(2);

        const feed = await tool({ since: 0, limit: 1 });

        expect(feed.changes).toHaveLength(TASK_MAX_CHANGES_IN_RESULT);
        // The oldest retained event is rev 2, so rev 1 is gone.
        expect(feed.changes?.[0]).toEqual(event(2, '2', 'add', { itemRev: 1 }));
        expect(feed.changesTruncated).toBe(true);
        expect(feed.changesHasMore).toBe(true);

        // A reader still inside the window is never told it missed anything.
        const inside = await tool({ since: 200, limit: 1 });

        expect(inside.changes).toEqual([
            event(201, '1', 'update', { fields: ['completed'], itemRev: 2 })
        ]);
        expect(inside.changesTruncated).toBe(false);
        expect(inside.changesHasMore).toBe(false);
    });

    it('rejects a since ahead of the store', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: [{ text: 'One' }] });

        await expect(tool({ since: 2 })).rejects.toThrow(
            'task "since" is revision 2, ahead of the store (storeRev 1); read the list first.'
        );
        await expect(tool({ since: -1 })).rejects.toThrow(
            'task "since" must be a non-negative integer when provided.'
        );
        await expect(tool({ since: 1.5 })).rejects.toThrow(
            'task "since" must be a non-negative integer when provided.'
        );
    });

    it('serves the page first and cuts the feed when the result hits the byte budget', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: Array.from({ length: 100 }, () => ({ text: filler(TASK_MAX_TEXT) })) });

        // The 16-row page already fills almost the whole 64 KiB budget, so the page
        // wins and the feed is cut: one entry fits (the first always does, it is
        // ~75 bytes) and the rest is reported as pending rather than dropped.
        const feed = await tool({ since: 0, limit: TASK_LIST_MAX_LIMIT });

        expect(feed.tasks.map((item) => item.id)).toEqual(
            Array.from({ length: 16 }, (_, index) => String(index + 1))
        );
        expect(feed.changes).toEqual([event(1, '1', 'add', { itemRev: 1 })]);
        expect(feed.changesHasMore).toBe(true);
        expect(feed.changesTruncated).toBe(false);
    });

    it('hands out detached copies of the feed as well as the page', async () => {
        const { tool } = createTaskTool();

        await tool({ tasks: [{ text: 'One' }] });
        await tool({ tasks: [{ id: '1', completed: true }] });

        const feed = await tool({ since: 0 });

        feed.tasks[0].rev = 99;
        (feed.changes as TaskChange[])[0].id = 'mutated';
        (feed.changes as TaskChange[])[1].fields?.push('text');

        expect((await tool({ since: 0 })).changes).toEqual([
            event(1, '1', 'add', { itemRev: 1 }),
            event(2, '1', 'update', { fields: ['completed'], itemRev: 2 })
        ]);
    });

    // -----------------------------------------------------------------------
    // T1: opt-in disjoint merge
    // -----------------------------------------------------------------------
    it('applies a stale patch when the concurrent change touched other fields', async () => {
        const toolset = createTaskTool();

        await toolset.tool({ tasks: [{ text: 'Shared' }] });

        // b renames the record: rev 2, storeRev 2.
        await asAgent(
            toolset,
            { name: 'b', threadId: 't-b' },
            { tasks: [{ id: '1', text: 'Renamed' }], expects: [{ id: '1', rev: 1 }] }
        );

        // a still holds a rev-1 token, but only writes `completed`: the fields are
        // disjoint, so both edits survive and a is the writer of record now.
        const merged = await asAgent(
            toolset,
            { name: 'a', threadId: 't-a' },
            {
                tasks: [{ id: '1', completed: true }],
                expects: [{ id: '1', rev: 1 }],
                mergeDisjoint: true
            }
        );

        expect(merged.tasks[0]).toEqual(
            task('1', 'Renamed', { completed: true, rev: 3, by: 'a', threadId: 't-a' })
        );
        expect(merged.storeRev).toBe(3);
        expect((await toolset.tool({ since: 2 })).changes).toEqual([
            event(3, '1', 'update', { by: 'a', threadId: 't-a', fields: ['completed'], itemRev: 3 })
        ]);
    });

    it('refuses a disjoint merge when the concurrent change touched a field the patch sets', async () => {
        const toolset = createTaskTool();

        await toolset.tool({ tasks: [{ text: 'Shared' }] });
        await asAgent(
            toolset,
            { name: 'b', threadId: 't-b' },
            { tasks: [{ id: '1', text: 'Renamed' }], expects: [{ id: '1', rev: 1 }] }
        );

        await expect(
            asAgent(
                toolset,
                { name: 'a', threadId: 't-a' },
                {
                    tasks: [{ id: '1', text: 'Conflict', completed: true }],
                    expects: [{ id: '1', rev: 1 }],
                    mergeDisjoint: true
                }
            )
        ).rejects.toThrow(
            'task "1" changed since revision 1 (now 2, last edited by "b"); "mergeDisjoint" cannot merge "text" because this patch sets it too.'
        );

        expect(toolset.snapshot().storeRev).toBe(2);
    });

    it('refuses a disjoint merge when the log cannot cover the whole gap', async () => {
        const toolset = createTaskTool();

        // A restored store whose window starts at itemRev 3: the caller's rev-1
        // token has an invisible step (the update to itemRev 2 is gone with the
        // trimmed head of the log), so coverage is unknown and the write stays
        // rejected exactly like a plain stale one.
        toolset.restore({
            items: [
                {
                    id: '1',
                    text: 'Renamed',
                    completed: false,
                    rev: 3,
                    updatedBy: 'b',
                    updatedAt: EPOCH_ISO
                }
            ],
            nextId: 2,
            storeRev: 4,
            changes: [
                { rev: 4, id: '1', op: 'update', by: 'b', at: EPOCH_ISO, fields: ['text'], itemRev: 3 }
            ]
        });

        await expect(
            asAgent(
                toolset,
                { name: 'a', threadId: 't-a' },
                {
                    tasks: [{ id: '1', completed: true }],
                    expects: [{ id: '1', rev: 1 }],
                    mergeDisjoint: true
                }
            )
        ).rejects.toThrow(
            'task "1" changed since revision 1 (now 3, last edited by "b"); re-read and retry; changed fields: text.'
        );
        expect(toolset.snapshot().storeRev).toBe(4);
    });

    it('refuses a disjoint merge across a removal and re-creation of the same id', async () => {
        const toolset = createTaskTool();

        // The rev sequence looks complete (1 -> 2), but the record in between was
        // deleted and re-created: a different record, with different meaning.
        toolset.restore({
            items: [{ id: '1', text: 'Fresh', completed: false, rev: 2, updatedBy: 'b', updatedAt: EPOCH_ISO }],
            nextId: 2,
            storeRev: 3,
            changes: [
                { rev: 1, id: '1', op: 'remove', by: 'b', at: EPOCH_ISO },
                { rev: 2, id: '1', op: 'add', by: 'b', at: EPOCH_ISO, itemRev: 1 },
                { rev: 3, id: '1', op: 'update', by: 'b', at: EPOCH_ISO, fields: ['text'], itemRev: 2 }
            ]
        });

        await expect(
            asAgent(
                toolset,
                { name: 'a', threadId: 't-a' },
                {
                    tasks: [{ id: '1', completed: true }],
                    expects: [{ id: '1', rev: 1 }],
                    mergeDisjoint: true
                }
            )
        ).rejects.toThrow(
            'task "1" changed since revision 1 (now 2, last edited by "b"); re-read and retry; changed fields: text.'
        );
    });

    it('never merges a stale removal', async () => {
        const toolset = createTaskTool();

        await toolset.tool({ tasks: [{ text: 'Shared' }] });
        await asAgent(
            toolset,
            { name: 'b', threadId: 't-b' },
            { tasks: [{ id: '1', text: 'Renamed' }], expects: [{ id: '1', rev: 1 }] }
        );

        await expect(
            asAgent(
                toolset,
                { name: 'a', threadId: 't-a' },
                { remove: ['1'], expects: [{ id: '1', rev: 1 }], mergeDisjoint: true }
            )
        ).rejects.toThrow(
            'task "1" changed since revision 1 (now 2, last edited by "b"); re-read and retry; changed fields: text.'
        );
        expect(toolset.snapshot().items).toHaveLength(1);
    });

    // -----------------------------------------------------------------------
    // Copies, reset, isolation
    // -----------------------------------------------------------------------
    it('hands out copies so a caller cannot mutate the store through a result', async () => {
        const { tool } = createTaskTool();

        const added = await tool({ tasks: [{ text: 'Original' }] });

        (added.tasks[0] as TaskItem).text = 'Mutated in place';
        added.tasks[0].completed = true;
        added.tasks[0].rev = 42;

        expect((await tool({})).tasks).toEqual([task('1', 'Original')]);
    });

    it('restarts ids, the revision and the log on reset() and keeps instances isolated', async () => {
        const first = createTaskTool();
        const second = createTaskTool();

        await first.tool({ tasks: [{ text: 'Only here' }] });

        expect(await second.tool({})).toEqual(empty);

        first.reset();

        expect(await first.tool({})).toEqual(empty);
        // reset() clears the change log and the revision, not just the rows.
        expect((await first.tool({ since: 0 })).changes).toEqual([]);
        expect(first.snapshot()).toEqual({ items: [], nextId: 1, storeRev: 0, changes: [] });
        expect((await first.tool({ tasks: [{ text: 'Again' }] })).tasks).toEqual([task('1', 'Again')]);
        // The other instance is untouched by a sibling reset.
        expect((await second.tool({})).tasks).toEqual([]);
    });

    // -----------------------------------------------------------------------
    // Persistence hooks (R3a + T1) — the store stays `records.todos` shaped
    // -----------------------------------------------------------------------
    it('snapshots every concurrency field as a detached copy and restores it whole', async () => {
        const toolset = createTaskTool();
        const { tool, snapshot } = toolset;

        await tool({ tasks: [{ text: 'Persist me' }, { text: 'Done', completed: true }] });
        await asAgent(
            toolset,
            { name: 'coder', threadId: 'thread-1' },
            { tasks: [{ id: '1', completed: true }], expects: [{ id: '1', rev: 1 }] }
        );
        await asAgent(toolset, { name: 'coder', threadId: 'thread-1' }, { claim: ['2'] });

        expect(snapshot()).toEqual({
            items: [
                task('1', 'Persist me', { completed: true, rev: 2, by: 'coder', threadId: 'thread-1' }),
                task('2', 'Done', {
                    completed: true,
                    by: 'coder',
                    threadId: 'thread-1',
                    owner: 'coder',
                    ownerThreadId: 'thread-1',
                    leaseUntil: EPOCH_MS + TASK_DEFAULT_LEASE_MS
                })
            ],
            nextId: 3,
            storeRev: 4,
            changes: [
                event(1, '1', 'add', { itemRev: 1 }),
                event(2, '2', 'add', { itemRev: 1 }),
                event(3, '1', 'update', {
                    by: 'coder',
                    threadId: 'thread-1',
                    fields: ['completed'],
                    itemRev: 2
                }),
                event(4, '2', 'claim', { by: 'coder', threadId: 'thread-1' })
            ]
        });

        const saved = snapshot();

        saved.items[0].text = 'Edited after the snapshot';
        saved.items[1].owner = 'someone else';
        saved.nextId = 99;
        saved.storeRev = 99;
        (saved.changes as TaskChange[]).push(event(5, '1', 'remove'));

        // The live store did not feel any of that.
        expect((await tool({})).tasks[0]).toEqual(
            task('1', 'Persist me', { completed: true, rev: 2, by: 'coder', threadId: 'thread-1' })
        );
        expect(toolset.snapshot().storeRev).toBe(4);

        // Restoring the saved copy brings the whole picture back, claims included.
        toolset.restore(saved);

        expect((await tool({})).tasks).toEqual([
            task('1', 'Edited after the snapshot', {
                completed: true,
                rev: 2,
                by: 'coder',
                threadId: 'thread-1'
            }),
            task('2', 'Done', {
                completed: true,
                by: 'coder',
                threadId: 'thread-1',
                owner: 'someone else',
                ownerThreadId: 'thread-1',
                leaseUntil: EPOCH_MS + TASK_DEFAULT_LEASE_MS
            })
        ]);

        // The restored counter and revision win.
        expect((await tool({ tasks: [{ text: 'Next' }] })).storeRev).toBe(100);
        expect((await tool({ since: 99 })).changes).toEqual([
            event(100, '99', 'add', { itemRev: 1 })
        ]);
    });

    it('restores a pre-T1 file with rev 1, storeRev 0 and an empty log', async () => {
        const toolset = createTaskTool();

        toolset.restore({ items: [{ id: '7', text: 'Old file', completed: true }], nextId: 8 });

        expect(toolset.snapshot()).toEqual({
            items: [{ id: '7', text: 'Old file', completed: true, rev: 1 }],
            nextId: 8,
            storeRev: 0,
            changes: []
        });
        expect(await toolset.tool({})).toEqual({
            tasks: [{ id: '7', text: 'Old file', completed: true, rev: 1 }],
            counts: { total: 1, completed: 1, pending: 0 },
            page: firstPage,
            storeRev: 0
        });

        // An old record is guarded like a new one: its revision is 1, so a caller
        // that read it must present exactly that token.
        const patched = await asAgent(
            toolset,
            { name: 'a', threadId: 't-a' },
            { tasks: [{ id: '7', completed: false }], expects: [{ id: '7', rev: 1 }] }
        );

        expect(patched.tasks[0]).toEqual(
            task('7', 'Old file', { rev: 2, by: 'a', threadId: 't-a' })
        );
        expect(patched.storeRev).toBe(1);
    });

    it('rejects an invalid restore and leaves the live store untouched', async () => {
        const toolset = createTaskTool();

        await toolset.tool({ tasks: [{ text: 'Still here' }] });

        await expect(() =>
            toolset.restore({ items: [{ id: '1', text: 'a', completed: false }], nextId: 1 })
        ).toThrow('todo state.nextId must be greater than the largest id (1); received 1.');
        await expect(() =>
            toolset.restore({
                items: [
                    { id: '1', text: 'a', completed: false },
                    { id: '1', text: 'b', completed: false }
                ],
                nextId: 2
            })
        ).toThrow('todo state contains the duplicate id "1".');
        await expect(() =>
            toolset.restore({
                items: Array.from({ length: 201 }, (_, index) => ({
                    id: String(index + 1),
                    text: 'a',
                    completed: false
                })),
                nextId: 202
            })
        ).toThrow('todo state holds 201 todos; the maximum is 200.');

        expect(await toolset.tool({})).toEqual({
            tasks: [task('1', 'Still here')],
            counts: { total: 1, completed: 0, pending: 1 },
            page: firstPage,
            storeRev: 1
        });
    });

    it('rejects every malformed concurrency field a corrupted file can carry', async () => {
        const { restore } = createTaskTool();

        const base = { id: '1', text: 'a', completed: false };

        // Record fields.
        expect(() => restore({ items: [{ ...base, rev: 0 }], nextId: 2 })).toThrow(
            'todo state.items[0].rev must be between 1 and Infinity.'
        );
        expect(() => restore({ items: [{ ...base, rev: 1.5 }], nextId: 2 })).toThrow(
            'todo state.items[0].rev must be a safe integer.'
        );
        expect(() => restore({ items: [{ ...base, leaseUntil: 'soon' }], nextId: 2 })).toThrow(
            'todo state.items[0].leaseUntil must be a finite positive number.'
        );
        expect(() => restore({ items: [{ ...base, owner: '', leaseUntil: 10 }], nextId: 2 })).toThrow(
            'todo state.items[0].owner must be at least 1 characters.'
        );
        // A lease without a holder protects nothing.
        expect(() => restore({ items: [{ ...base, leaseUntil: 10 }], nextId: 2 })).toThrow(
            'todo state.items[0].leaseUntil needs "owner".'
        );
        expect(() => restore({ items: [{ ...base, owner: 7 }], nextId: 2 })).toThrow(
            'todo state.items[0].owner must be a string.'
        );
        expect(() => restore({ items: [{ ...base, status: 'x' }], nextId: 2 })).toThrow(
            'todo state.items[0] has an unknown field "status".'
        );

        // Store revision.
        expect(() => restore({ items: [], nextId: 1, storeRev: -1 })).toThrow(
            'todo state.storeRev must be between 0 and Infinity.'
        );
        expect(() => restore({ items: [], nextId: 1, storeRev: 'x' })).toThrow(
            'todo state.storeRev must be a safe integer.'
        );

        // Change entries: shape, op, fields, and the revision bounds.
        const change = { rev: 1, id: '1', op: 'add', at: EPOCH_ISO, itemRev: 1 };

        expect(() => restore({ items: [], nextId: 1, storeRev: 1, changes: 'x' })).toThrow(
            'todo state.changes must be an array.'
        );
        expect(() => restore({ items: [], nextId: 1, storeRev: 1, changes: [{ ...change, op: 'rename' }] })).toThrow(
            'todo state.changes[0].op must be one of: add, update, remove, claim, release.'
        );
        expect(() => restore({ items: [], nextId: 1, storeRev: 1, changes: [{ ...change, note: 'x' }] })).toThrow(
            'todo state.changes[0] has an unknown field "note".'
        );
        expect(() => restore({ items: [], nextId: 1, storeRev: 1, changes: [{ ...change, rev: 2 }] })).toThrow(
            'todo state.changes[0].rev must be between 1 and 1.'
        );
        expect(() =>
            restore({ items: [], nextId: 1, storeRev: 1, changes: [{ ...change, fields: ['text', 'text'] }] })
        ).toThrow('todo state.changes[0].fields lists "text" more than once.');
        expect(() =>
            restore({ items: [], nextId: 1, storeRev: 1, changes: [{ ...change, fields: ['status'] }] })
        ).toThrow('todo state.changes[0].fields entries must be one of: text, completed.');
        expect(() =>
            restore({ items: [], nextId: 1, storeRev: 1, changes: [{ ...change, fields: ['text', 'completed', 'text'] }] })
        ).toThrow('todo state.changes[0].fields must list at most 2 fields.');
        expect(() =>
            restore({ items: [], nextId: 1, storeRev: 1, changes: [{ ...change, itemRev: 0 }] })
        ).toThrow('todo state.changes[0].itemRev must be between 1 and Infinity.');
        // storeRev behind the newest event, and an unsorted window, are both data loss.
        expect(() =>
            restore({
                items: [],
                nextId: 1,
                storeRev: 1,
                changes: [change, { ...change, rev: 2, op: 'remove' }]
            })
        ).toThrow('todo state.changes[1].rev must be between 1 and 1.');
        expect(() =>
            restore({
                items: [],
                nextId: 1,
                storeRev: 5,
                changes: [{ ...change, rev: 5 }, { ...change, rev: 3, op: 'remove' }]
            })
        ).toThrow('todo state.changes must be ordered by a rising rev; 3 follows 5.');
        expect(() =>
            restore({
                items: [],
                nextId: 1,
                storeRev: 0,
                changes: Array.from({ length: TASK_MAX_CHANGES + 1 }, (_, index) => ({
                    ...change,
                    rev: 1
                }))
            })
        ).toThrow(`todo state.changes holds ${TASK_MAX_CHANGES + 1} changes; the maximum is ${TASK_MAX_CHANGES}.`);

        // A field that names a change rev below storeRev but out of order at the
        // store level is caught by the ordering rule, not the per-entry bound.
        expect(() =>
            restore({
                items: [],
                nextId: 1,
                storeRev: 1,
                changes: [{ ...change, rev: 1 }, { ...change, rev: 1, op: 'remove' }]
            })
        ).toThrow('todo state.changes must be ordered by a rising rev; 1 follows 1.');
    });

    it('exposes the pure store reader for the snapshot path', () => {
        const state = readTaskStoreState({
            items: [{ id: '1', text: 'Read me', completed: true }],
            nextId: 2
        });

        // A pre-T1 record defaults to the revision it was created with, and the
        // store defaults to revision 0 with an empty window.
        expect(state).toEqual({
            items: [{ id: '1', text: 'Read me', completed: true, rev: 1 }],
            nextId: 2,
            storeRev: 0,
            changes: []
        });

        const rich = readTaskStoreState({
            items: [
                {
                    id: '1',
                    text: 'Guarded',
                    completed: false,
                    rev: 3,
                    updatedBy: 'a',
                    updatedThreadId: 't-a',
                    updatedAt: EPOCH_ISO,
                    owner: 'b',
                    ownerThreadId: 't-b',
                    leaseUntil: EPOCH_MS + 60_000
                }
            ],
            nextId: 2,
            storeRev: 4,
            changes: [
                { rev: 3, id: '1', op: 'update', by: 'a', threadId: 't-a', at: EPOCH_ISO, fields: ['text'], itemRev: 3 },
                { rev: 4, id: '1', op: 'claim', by: 'b', threadId: 't-b', at: EPOCH_ISO }
            ]
        });

        expect(rich).toEqual({
            items: [
                task('1', 'Guarded', {
                    rev: 3,
                    by: 'a',
                    threadId: 't-a',
                    owner: 'b',
                    ownerThreadId: 't-b',
                    leaseUntil: EPOCH_MS + 60_000
                })
            ],
            nextId: 2,
            storeRev: 4,
            changes: [
                event(3, '1', 'update', { by: 'a', threadId: 't-a', fields: ['text'], itemRev: 3 }),
                event(4, '1', 'claim', { by: 'b', threadId: 't-b' })
            ]
        });

        // The reader copies: the caller cannot reach the validated arrays it returns.
        const again = readTaskStoreState(rich);

        again.items[0].text = 'Changed';
        again.items[0].rev = 99;
        (again.changes as TaskChange[])[0].id = 'Changed';

        expect(rich.items[0].text).toBe('Guarded');
        expect(rich.items[0].rev).toBe(3);
        expect((rich.changes as TaskChange[])[0].id).toBe('1');
    });
});

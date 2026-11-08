// The unified record engine — the guarantees R3 promises and Decisions B/C/D/G/L/M/N/O/P
// define. Written against the requirements in
// docs/tasks/2026-11-08-records-engine.md, not against the implementation's output: every
// expectation below is an exact value the document or the old store contracts fix.
//
// Why this file drives the ENGINE rather than a harness: the harness integration (one
// store per session, `tasks` core, the routed runtime method) is pinned in
// src/harness.task.test.ts and src/harness.records.test.ts. What lives here is the set of
// rules that only the engine can answer — per-collection revisions and change windows,
// global ids, `define`/`drop` permanence, coded rejections, and the R9 stale payload.
//
// Identity model used throughout: the engine takes `by`/`threadId` from the caller context,
// never from arguments (task's rule, kept). `caller()` below is that context.

import { describe, expect, it } from 'vitest';
import { createRecordEngine, RECORD_ERROR_CODES } from './records';
import type { RecordEntry, RecordsResult } from '../types';

// One caller identity. `by` is what makes a write guarded and attributed; omit it for the
// identity-less direct/driver call that may still write blind.
const caller = (by?: string, threadId?: string) => ({
    ...(by === undefined ? {} : { by }),
    ...(threadId === undefined ? {} : { threadId })
});

// The engine speaks ToolContext, so these helpers build the minimal context the record
// tools read (`parameters`, `agent?.name`, `threadId`) and call the routed surface — the
// same door the harness routes a lane write through (Decision A).
const run = async (
    engine: ReturnType<typeof createRecordEngine>,
    tool: 'records' | 'tasks' | 'chapters' | 'profiles' | 'locations',
    parameters: Record<string, unknown>,
    by?: string,
    threadId?: string
): Promise<RecordsResult & Record<string, unknown>> =>
    (await engine.executeRecords(tool, {
        parameters,
        ...(by === undefined ? {} : { agent: { name: by } as never }),
        ...(threadId === undefined ? {} : { threadId })
    } as never)) as RecordsResult & Record<string, unknown>;

const tasks = (
    engine: ReturnType<typeof createRecordEngine>,
    parameters: Record<string, unknown>,
    by?: string,
    threadId?: string
) => run(engine, 'tasks', parameters, by, threadId);

const addTasks = async (engine: ReturnType<typeof createRecordEngine>, count: number, by = 'author') => {
    for (let index = 0; index < count; index += 1) {
        await tasks(engine, { tasks: [{ text: `task ${index + 1}` }] }, by);
    }
};

// The stable code a rejection must carry (Decision O): `error.name`, `error.code`, and the
// first token of the message, so a wrapper and a wire consumer can branch without prose.
const expectCode = async (
    call: Promise<unknown>,
    code: string
): Promise<{ message: string; details?: unknown }> => {
    try {
        await call;
    } catch (error) {
        const failure = error as { name: string; code?: string; message: string; details?: unknown };

        expect(failure.code).toBe(code);
        expect(failure.name).toBe(code);
        expect(failure.message.startsWith(`${code}: `)).toBe(true);

        return { message: failure.message, ...(failure.details === undefined ? {} : { details: failure.details }) };
    }

    throw new Error(`expected a ${code} rejection, and the call succeeded`);
};

describe('records engine — one store, one id space (F3)', () => {
    it('draws ids from one counter across collections, so a chapter never reuses a task id', async () => {
        const engine = createRecordEngine();

        await addTasks(engine, 3);
        const chapter = (await run(
            engine,
            'chapters',
            { action: 'add', title: 'Opening', summary: 'Cold open' },
            'author'
        )) as { chapter: RecordEntry };

        // Globally unique: the three tasks took 1..3, so the first chapter is 4 — the
        // consequence Decision K/F3 accept deliberately.
        expect(chapter.chapter.id).toBe('4');
        expect(chapter.chapter.rev).toBe(1);
        expect(chapter.chapter.updatedBy).toBe('author');

        // `afterId` is "ids greater than X" FILTERED TO THE COLLECTION: the tasks live at
        // 1..3, so a task walk from cursor 3 is empty rather than returning chapter 4.
        const after = await tasks(engine, { afterId: '3' });

        expect(after.tasks).toEqual([]);
        expect(after.page).toEqual({ offset: 3, limit: 20, hasMore: false, afterId: '3' });
    });

    it('persists every collection under one snapshot map and restores it whole', async () => {
        const engine = createRecordEngine();

        await addTasks(engine, 1);
        await run(engine, 'profiles', { action: 'add', name: 'Ada', description: 'Engineer' }, 'author');

        const saved = JSON.parse(JSON.stringify(engine.snapshot()));

        expect(Object.keys(saved.collections).sort()).toEqual([
            'chapters',
            'locations',
            'profiles',
            'tasks'
        ]);
        // One store-level counter, not four (T3).
        expect(saved.nextId).toBe(3);

        engine.reset();
        expect((await tasks(engine, {})).counts).toEqual({ total: 0, completed: 0, pending: 0 });

        engine.restore(saved);

        const restoredTasks = await tasks(engine, {});

        expect(restoredTasks.tasks).toEqual([
            {
                id: '1',
                text: 'task 1',
                completed: false,
                rev: 1,
                updatedBy: 'author',
                updatedAt: restoredTasks.tasks![0].updatedAt
            }
        ]);
        expect(saved.nextId).toBe(3);
    });
});

describe('records engine — per-collection revisions and change windows (Decision B)', () => {
    it('keeps `since` on one collection free of another collection events', async () => {
        const engine = createRecordEngine();

        const first = await tasks(engine, { tasks: [{ text: 'Keep an eye on this' }] }, 'author');
        const watermark = first.storeRev as number;

        // Ten unrelated writes somewhere else must not wake a task reader, and must not
        // touch the task collection's storeRev.
        for (let index = 0; index < 10; index += 1) {
            await run(engine, 'chapters', { action: 'add', title: `C${index}`, summary: 's' }, 'editor');
        }

        const feed = await tasks(engine, { since: watermark });

        expect(feed.storeRev).toBe(1);
        expect(feed.changes).toEqual([]);
        expect(feed.changesHasMore).toBe(false);
        expect(feed.changesTruncated).toBe(false);

        // The chapters LIST carries no storeRev (its historical shape), so the
        // collection's own revision is read through the engine surface.
        const chapterFeed = await run(engine, 'records', { collection: 'chapters', since: 0 });

        expect(chapterFeed.storeRev).toBe(10);
        expect((chapterFeed.changes as unknown[]).length).toBe(10);
    });

    it('keeps mergeDisjoint provable after a burst of writes to a DIFFERENT collection', async () => {
        const engine = createRecordEngine();

        const read = await tasks(engine, { tasks: [{ text: 'Base' }] }, 'author');
        const base = (read.tasks as RecordEntry[])[0];

        // The eviction symptom F6 named: with ONE shared window, 240 writes elsewhere
        // would push the task events out of the 200-entry FIFO and turn a provable merge
        // into a refusal. Per-collection windows make the burst irrelevant — spread over
        // TWO collections so neither one hits its own 200-record store bound.
        for (let index = 0; index < 120; index += 1) {
            await run(engine, 'chapters', { action: 'add', title: `Burst ${index}`, summary: 's' }, 'editor');
        }

        for (let index = 0; index < 120; index += 1) {
            await run(engine, 'profiles', { action: 'add', name: `P${index}`, description: 'd' }, 'editor');
        }

        // A concurrent task edit lands (the only change in the task window). It carries
        // its token, because an identified write is guarded (Decision N's CAS rule).
        await tasks(
            engine,
            { tasks: [{ id: base.id, completed: true }], expects: [{ id: base.id, rev: base.rev }] },
            'editor',
            'thread-editor'
        );

        // Now the stale patch that touches a DIFFERENT field must still apply.
        const merged = await tasks(
            engine,
            {
                tasks: [{ id: base.id, text: 'Rewritten' }],
                expects: [{ id: base.id, rev: base.rev }],
                mergeDisjoint: true
            },
            'author',
            'thread-author'
        );

        expect((merged.tasks as RecordEntry[])[0]).toEqual({
            id: '1',
            text: 'Rewritten',
            completed: true,
            // rev 2 came from the concurrent `completed` change and rev 3 from this
            // merged `text` change: a disjoint merge still pays a revision, it only
            // skips the refusal.
            rev: 3,
            updatedBy: 'author',
            updatedThreadId: 'thread-author',
            updatedAt: (merged.tasks as RecordEntry[])[0].updatedAt
        });
    });
});

describe('records engine — no locks, and one complete conflict answer (Decision P, R9)', () => {
    it('accepts every patch unless it is stale, and the refusal carries the current values', async () => {
        const engine = createRecordEngine();

        const read = await tasks(engine, { tasks: [{ text: 'Shared' }] }, 'researcher');
        const base = (read.tasks as RecordEntry[])[0];

        // Thread A wins the race, token in hand.
        await tasks(
            engine,
            { tasks: [{ id: '1', text: 'Thread A won' }], expects: [{ id: '1', rev: 1 }] },
            'coder',
            'thread-a'
        );

        // Thread B sent the same `expects` rev. Nothing about WHO it is blocks the write
        // (Decision N: authorship grants nothing); only staleness does.
        const failure = await expectCode(
            tasks(
                engine,
                { tasks: [{ id: '1', text: 'Thread B late' }], expects: [{ id: '1', rev: base.rev }] },
                'writer',
                'thread-b'
            ),
            RECORD_ERROR_CODES.staleRecord
        );

        // R9: the caller learns the reason AND the current record, so it never re-reads.
        expect(failure.message).toContain('changed since revision 1 (now 2, last edited by "coder"');
        expect(failure.message).toContain('changed fields: text');
        expect(failure.message).toContain(
            'current: {"id":"1","text":"Thread A won","completed":false,"rev":2,"updatedBy":"coder","updatedThreadId":"thread-a"'
        );

        const details = failure.details as {
            expectedRev: number;
            currentRev: number;
            updatedBy: string;
            changedFields: string[];
            entry: RecordEntry;
        };

        expect(details.expectedRev).toBe(1);
        expect(details.currentRev).toBe(2);
        expect(details.updatedBy).toBe('coder');
        expect(details.changedFields).toEqual(['text']);
        expect(details.entry).toEqual({
            id: '1',
            text: 'Thread A won',
            completed: false,
            rev: 2,
            updatedBy: 'coder',
            updatedThreadId: 'thread-a',
            updatedAt: details.entry.updatedAt
        });

        // There is no owner field to strand: after the conflict, ANY thread may write
        // immediately with the current token.
        const retry = await tasks(
            engine,
            { tasks: [{ id: '1', text: 'Thread B retried' }], expects: [{ id: '1', rev: 2 }] },
            'writer',
            'thread-b'
        );

        expect((retry.tasks as RecordEntry[])[0].text).toBe('Thread B retried');
        expect((retry.tasks as RecordEntry[])[0].updatedBy).toBe('writer');
        expect(Object.keys((retry.tasks as RecordEntry[])[0]).sort()).toEqual([
            // Plain lexicographic order: 'updatedAt' sorts before 'updatedBy'.
            'completed',
            'id',
            'rev',
            'text',
            'updatedAt',
            'updatedBy',
            'updatedThreadId'
        ]);
    });

    it('refuses an identified write that skipped its token, and lets an anonymous one through', async () => {
        const engine = createRecordEngine();

        await tasks(engine, { tasks: [{ text: 'Blind' }] });

        const guarded = await expectCode(
            tasks(engine, { tasks: [{ id: '1', completed: true }] }, 'author'),
            RECORD_ERROR_CODES.guardedWrite
        );

        expect(guarded.message).toBe(
            'guarded-write: guarded write: pass "expects" [{ id, rev }] for task "1" (read it first).'
        );

        // The pre-T1 host/driver path stays: no identity, no token required.
        await tasks(engine, { tasks: [{ id: '1', completed: true }] });
        const page = await tasks(engine, {});

        expect((page.tasks as RecordEntry[])[0].completed).toBe(true);
    });
});

describe('records engine — coded rejections (Decision O)', () => {
    it('refuses an unknown collection naming what IS defined, never an empty page', async () => {
        const engine = createRecordEngine();

        const failure = await expectCode(
            run(engine, 'records', { collection: 'tsak' }),
            RECORD_ERROR_CODES.unknownCollection
        );

        expect(failure.message).toContain('records has no collection "tsak"');
        expect(failure.message).toContain('defined collections: tasks, chapters, profiles, locations');
        expect((failure.details as { defined: string[] }).defined).toEqual([
            'tasks',
            'chapters',
            'profiles',
            'locations'
        ]);
    });

    it('codes a field over its cap and an over-cap add, and burns no id for either', async () => {
        const engine = createRecordEngine();

        await addTasks(engine, 200);

        const tooLong = await expectCode(
            tasks(engine, { tasks: [{ text: 'x'.repeat(4_001) }] }, 'author'),
            RECORD_ERROR_CODES.fieldTooLong
        );

        expect(tooLong.message).toBe(
            'field-too-long: tasks "text" is 4001 characters; the limit is 4000. Shorten it and retry.'
        );

        const full = await expectCode(
            tasks(engine, { tasks: [{ text: 'One too many' }] }, 'author'),
            RECORD_ERROR_CODES.storeFull
        );

        expect(full.message).toBe(
            'store-full: tasks would hold 201 tasks; the maximum is 200. Remove one before adding another.'
        );

        // A rejected add never consumes an id (the profile store's stance, kept engine-wide).
        const page = await tasks(engine, { limit: 1, offset: 199 });

        expect((page.tasks as RecordEntry[])[0].id).toBe('200');

        // Removals ARE netted off the capacity check, so one call may restate a full list.
        const restated = await tasks(
            engine,
            { tasks: [{ text: 'Replacement' }], remove: ['200'], expects: [{ id: '200', rev: 1 }] },
            'author'
        );

        expect(restated.counts).toEqual({ total: 200, completed: 0, pending: 200 });
    });
});

describe('records engine — collections are declared, extensible, and permanent (Decisions C, M)', () => {
    const definition = {
        name: 'notes',
        fields: [
            { key: 'body', type: 'text', required: true, maxLength: 500 },
            { key: 'pinned', type: 'boolean', default: false }
        ]
    };

    it('registers a new collection and serves it under the name the agent chose', async () => {
        const engine = createRecordEngine();

        const defined = await run(engine, 'records', { define: definition }, 'author');

        expect(defined.collection).toBe('notes');

        const added = await run(
            engine,
            'records',
            { collection: 'notes', entries: [{ body: 'Ship the engine' }] },
            'author'
        );

        expect(added.entries).toEqual([
            {
                id: '1',
                body: 'Ship the engine',
                pinned: false,
                rev: 1,
                updatedBy: 'author',
                updatedAt: (added.entries as RecordEntry[])[0].updatedAt
            }
        ]);
        expect(added.counts).toEqual({ total: 1 });
    });

    it('refuses to re-define a name that exists, and to drop a collection that is not empty', async () => {
        const engine = createRecordEngine();

        await run(engine, 'records', { define: definition }, 'author');

        // A silent merge would let an agent change a live contract mid-session.
        await expectCode(
            run(engine, 'records', { define: { ...definition, maxRecords: 5 } }, 'author'),
            RECORD_ERROR_CODES.collectionExists
        );

        await expectCode(
            run(engine, 'records', { collection: 'tasks', drop: true }, 'author'),
            RECORD_ERROR_CODES.collectionPermanent
        );

        await run(engine, 'records', { collection: 'notes', entries: [{ body: 'one' }] }, 'author');
        await expectCode(
            run(engine, 'records', { collection: 'notes', drop: true }, 'author'),
            RECORD_ERROR_CODES.collectionNotEmpty
        );

        // Empty, and defined by an agent: droppable.
        await run(engine, 'records', { collection: 'notes', remove: ['1'], expects: [{ id: '1', rev: 1 }] }, 'author');
        const dropped = await run(engine, 'records', { collection: 'notes', drop: true }, 'author');

        expect(dropped.collection).toBe('notes');
        await expectCode(run(engine, 'records', { collection: 'notes' }), RECORD_ERROR_CODES.unknownCollection);
    });

    it('rediscovera a defined collection after snapshot/restore, with its entries', async () => {
        const engine = createRecordEngine();

        await run(engine, 'records', { define: definition }, 'author');
        await run(engine, 'records', { collection: 'notes', entries: [{ body: 'kept' }] }, 'author');

        const saved = JSON.parse(JSON.stringify(engine.snapshot()));

        engine.restore(saved);

        const reread = await run(engine, 'records', { collection: 'notes' });

        expect((reread.entries as RecordEntry[])[0].body).toBe('kept');
        // The definition persisted too, so the caps still bind after a restart.
        await expectCode(
            run(engine, 'records', { collection: 'notes', entries: [{ body: 'x'.repeat(501) }] }, 'author'),
            RECORD_ERROR_CODES.fieldTooLong
        );
    });
});

describe('records engine — chapters: declared facets, sort and projection (F9)', () => {
    it('projects the body out of a page and back into a single get, and counts by status', async () => {
        const engine = createRecordEngine();

        await run(engine, 'chapters', { action: 'add', title: 'Late', summary: 'z', order: 20 }, 'author');
        const first = (await run(
            engine,
            'chapters',
            { action: 'add', title: 'First', summary: 'a', content: 'a whole body', order: 1, status: 'draft' },
            'author'
        )) as { chapter: RecordEntry };

        // `content` is getOnly: a mutation result carries the summary, not the body.
        expect(Object.keys(first.chapter)).toEqual([
            'id',
            'title',
            'summary',
            'status',
            'order',
            'rev',
            'updatedBy',
            'updatedAt'
        ]);
        // Ids come from the store-level counter in insertion order: 'Late' was added
        // first, so it is 1 and 'First' is 2 — the sort below reorders the VIEW only.
        expect(first.chapter.id).toBe('2');

        const list = await run(engine, 'chapters', { action: 'list' });

        // `order` ascending (ordered first, then insertion order), and the page counts come
        // from the whole collection.
        expect((list.chapters as RecordEntry[]).map((entry) => entry.title)).toEqual(['First', 'Late']);
        expect(list.counts).toEqual({ total: 2, planned: 1, draft: 1, complete: 0 });

        const got = await run(engine, 'chapters', { action: 'get', id: '2' });

        // The documented wrapper shape for `get` is `{ chapter, content, counts }`
        // (knowledge.md:971 and the tool's own description): the body is a SIBLING of the
        // summary, and the summary carries no body. Key order is the canonical field order
        // minus `content`.
        const chapter = got.chapter as RecordEntry;

        expect(got.content).toBe('a whole body');
        expect(Object.keys(chapter)).toEqual(['id', 'title', 'summary', 'status', 'order', 'rev', 'updatedBy', 'updatedAt']);
        expect(chapter.id).toBe('2');
        expect(got.counts).toEqual({ total: 2, planned: 1, draft: 1, complete: 0 });
    });
});

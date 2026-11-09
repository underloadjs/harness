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
import type { RecordChange, RecordEntry, RecordsResult } from '../types';

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

// ---------------------------------------------------------------------------
// R4 — the stale-record advice. `mergeDisjoint` used to be recommended on every
// refusal, including the two calls where it cannot help: a removal (the schemas
// promise it never merges one) and a patch that had already sent it. The advice is
// now composed from what the caller actually sent.
// ---------------------------------------------------------------------------
describe('records engine — the stale refusal only recommends what the caller can use (R4)', () => {
    // Two records, each moved to rev 2 by a third party: id "1" by a `text` change
    // (so a later `text` patch clashes) and id "2" by a `completed` change.
    const raced = async (engine: ReturnType<typeof createRecordEngine>) => {
        await run(engine, 'tasks', { tasks: [{ text: 'One' }, { text: 'Two' }, { text: 'Three' }] }, 'author');
        await run(
            engine,
            'tasks',
            { tasks: [{ id: '1', text: 'One by editor' }], expects: [{ id: '1', rev: 1 }] },
            'editor'
        );
        await run(
            engine,
            'tasks',
            { tasks: [{ id: '2', completed: true }], expects: [{ id: '2', rev: 1 }] },
            'editor'
        );
    };

    it('T4.1: a removal with a stale token never mentions mergeDisjoint, flagged or not', async () => {
        const engine = createRecordEngine();

        await raced(engine);

        // The observed case: the caller HAD sent the flag, and was told to send it.
        const flagged = await expectCode(
            run(
                engine,
                'tasks',
                { remove: ['2'], expects: [{ id: '2', rev: 1 }], mergeDisjoint: true },
                'latecomer'
            ),
            RECORD_ERROR_CODES.staleRecord
        );

        expect(flagged.message).toContain(
            'tasks "2" changed since revision 1 (now 2, last edited by "editor"'
        );
        expect(flagged.message).toContain('retry with "expects" [{ id: "2", rev: 2 }].');
        expect(flagged.message.includes('mergeDisjoint')).toBe(false);

        // Same answer without the flag: the flag was never an option for a removal. The
        // refusal above changed nothing, so id "2" is still at rev 2 and still stale.
        const plain = await expectCode(
            run(engine, 'tasks', { remove: ['2'], expects: [{ id: '2', rev: 1 }] }, 'latecomer'),
            RECORD_ERROR_CODES.staleRecord
        );

        expect(plain.message.includes('mergeDisjoint')).toBe(false);
        expect(plain.message).toContain('retry with "expects" [{ id: "2", rev: 2 }].');
    });

    it('T4.1: a stale patch that already set mergeDisjoint names the clashing field instead of re-recommending it', async () => {
        const engine = createRecordEngine();

        await raced(engine);

        // The provable case: the refusal at `mergeConcurrentFields`'s clash check, which
        // already named the field — now pinned, because R4 asks for it on this path.
        const clash = await expectCode(
            run(
                engine,
                'tasks',
                { tasks: [{ id: '1', text: 'One by the latecomer' }], expects: [{ id: '1', rev: 1 }], mergeDisjoint: true },
                'latecomer'
            ),
            RECORD_ERROR_CODES.staleRecord
        );

        expect(clash.message).toBe(
            'stale-record: tasks "1" changed since revision 1 (now 2, last edited by "editor"); ' +
                '"mergeDisjoint" cannot merge "text" because this patch sets it too.'
        );
        expect(clash.message.includes('or pass "mergeDisjoint": true')).toBe(false);
        expect((clash.details as { clash: string[] }).clash).toEqual(['text']);
    });

    it('T4.1: a stale patch WITHOUT the flag keeps the advice sentence verbatim', async () => {
        const engine = createRecordEngine();

        await raced(engine);

        const failure = await expectCode(
            run(engine, 'tasks', { tasks: [{ id: '1', text: 'late' }], expects: [{ id: '1', rev: 1 }] }, 'latecomer'),
            RECORD_ERROR_CODES.staleRecord
        );

        // Unchanged wording — three existing pins (harness.task.test.ts,
        // server/workers/lane-authority.test.ts) quote this sentence exactly.
        expect(failure.message).toContain(
            'changed fields: text; retry with "expects" [{ id: "1", rev: 2 }] or pass "mergeDisjoint": true. current: '
        );
        expect((failure.details as { changedFields: string[] }).changedFields).toEqual(['text']);
        expect((failure.details as { clash?: string[] }).clash).toBeUndefined();
    });

    it('T4: a stale patch with the flag whose coverage aged out says the flag is spent, and claims no clash', async () => {
        const engine = createRecordEngine();

        // 101 adds, then id "1" moves to rev 2 at event 102, then 300 more events push
        // every id-"1" entry out of the 200-event FIFO window. The token is still stale;
        // the LOG can no longer show why, which is the sub-case where no clash exists.
        await run(engine, 'tasks', { tasks: [{ text: 'target' }, ...Array.from({ length: 100 }, (_, index) => ({ text: `filler ${index}` }))] }, 'author');
        await run(engine, 'tasks', { tasks: [{ id: '1', text: 'target v2' }], expects: [{ id: '1', rev: 1 }] }, 'editor');

        const fillers = Array.from({ length: 100 }, (_, index) => String(index + 2));

        for (let round = 0; round < 3; round += 1) {
            await run(engine, 'tasks', { tasks: fillers.map((id) => ({ id, completed: round % 2 === 0 })) });
        }

        const window = engine.snapshot().collections.tasks as { storeRev: number; changes: RecordChange[] };

        expect(window.storeRev).toBe(402);
        expect(window.changes.some((change) => change.id === '1' && change.op === 'update')).toBe(false);

        const failure = await expectCode(
            run(
                engine,
                'tasks',
                { tasks: [{ id: '1', text: 'holey' }], expects: [{ id: '1', rev: 1 }], mergeDisjoint: true },
                'latecomer'
            ),
            RECORD_ERROR_CODES.staleRecord
        );

        // No re-recommendation, and no invented clash: the sentence states only what the
        // engine knows — the flag is set and the window cannot back a merge up.
        expect(failure.message).toContain(
            'retry with "expects" [{ id: "1", rev: 2 }]; "mergeDisjoint" is already set, ' +
                'and the change window no longer covers every revision since 1, so it cannot prove this patch disjoint. current: '
        );
        expect(failure.message.includes('or pass "mergeDisjoint": true')).toBe(false);
        expect(failure.message.includes('cannot merge')).toBe(false);

        const details = failure.details as { changedFields?: string[]; clash?: string[] };

        expect(details.changedFields).toBeUndefined();
        expect(details.clash).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// R5 — a token naming an id that is not in THIS collection used to answer one
// fabricated sentence for every miss: "was removed since revision N; the id is free
// again". The id counter is global, so the record was often live in another
// collection, and ids are never re-claimed inside a session. The three cases are now
// told apart, with the change log as the only evidence for claiming a removal.
// ---------------------------------------------------------------------------
describe('records engine — a token for an absent id tells the truth (R5)', () => {
    it('T5.1: names the collection that owns the id, and never claims a removal or a free id', async () => {
        const engine = createRecordEngine();

        await run(engine, 'tasks', { tasks: [{ text: 'A task' }] }, 'author');

        const profile = (await run(
            engine,
            'profiles',
            { action: 'add', name: 'Ada', description: 'Engineer' },
            'author'
        )) as { profile: RecordEntry };
        const foreignId = profile.profile.id;

        const failure = await expectCode(
            run(
                engine,
                'tasks',
                { tasks: [{ id: foreignId, text: 'mine now' }], expects: [{ id: foreignId, rev: 1 }] },
                'author'
            ),
            RECORD_ERROR_CODES.staleRecord
        );

        expect(failure.message).toBe(
            `stale-record: tasks id "${foreignId}" belongs to "profiles" — re-read that collection.`
        );
        expect(failure.message.includes('was removed')).toBe(false);
        expect(failure.message.includes('free again')).toBe(false);
        // No `removed` detail: nothing was removed.
        expect(failure.details).toEqual({
            id: foreignId,
            expectedRev: 1,
            currentRev: 0,
            updatedBy: 'unknown',
            collection: 'profiles'
        });

        // The owner is the truth: the profile is live where the message says it is.
        const owner = (await run(engine, 'profiles', { action: 'get', id: foreignId })) as {
            profile: RecordEntry;
        };

        expect(owner.profile.id).toBe(foreignId);
        expect(owner.profile.rev).toBe(1);

        // The same miss reported through the engine surface names the same owner.
        await expectCode(
            run(
                engine,
                'records',
                { collection: 'tasks', entries: [{ id: foreignId, text: 'mine now' }], expects: [{ id: foreignId, rev: 1 }] },
                'author'
            ),
            RECORD_ERROR_CODES.staleRecord
        );
    });

    it('T5.2/T5.3: a genuine removal keeps the removed-since wording, minus the free-id promise', async () => {
        const engine = createRecordEngine();

        await run(engine, 'tasks', { tasks: [{ text: 'Doomed' }] }, 'author');
        await run(engine, 'tasks', { remove: ['1'], expects: [{ id: '1', rev: 1 }] }, 'author');

        const failure = await expectCode(
            run(engine, 'tasks', { tasks: [{ id: '1', text: 'ghost' }], expects: [{ id: '1', rev: 1 }] }, 'author'),
            RECORD_ERROR_CODES.staleRecord
        );

        expect(failure.message).toBe(
            'stale-record: tasks "1" was removed since revision 1 — re-read the list and add or retry.'
        );
        expect(failure.message.includes('free again')).toBe(false);
        // T5.3: the detail survives, because the log really does hold the removal.
        expect((failure.details as { removed: boolean }).removed).toBe(true);

        // And the promise that was dropped was false: ids are never re-claimed, so the
        // next add takes a NEW id rather than the removed one.
        const added = (await run(engine, 'tasks', { tasks: [{ text: 'Next' }] }, 'author')) as {
            tasks: RecordEntry[];
        };

        expect(added.tasks.map((task) => task.id)).toEqual(['2']);
    });

    it('T5.2/T5.3: an id this collection never had claims neither a removal nor a free id', async () => {
        const engine = createRecordEngine();

        await run(engine, 'tasks', { tasks: [{ text: 'Only one' }] }, 'author');

        const failure = await expectCode(
            run(engine, 'tasks', { tasks: [{ id: '9999', text: 'never' }], expects: [{ id: '9999', rev: 1 }] }, 'author'),
            RECORD_ERROR_CODES.staleRecord
        );

        expect(failure.message).toBe(
            'stale-record: tasks has no task with id "9999" and this collection\'s change log holds no removal for it — ' +
                'it was never in "tasks", or its removal aged out of the 200-event window. Re-read the list.'
        );
        expect(failure.message.includes('was removed')).toBe(false);
        expect(failure.message.includes('free again')).toBe(false);
        // No `removed` key at all (T5.3), asserted on the whole details object.
        expect(failure.details).toEqual({
            id: '9999',
            expectedRev: 1,
            currentRev: 0,
            updatedBy: 'unknown'
        });
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

// ---------------------------------------------------------------------------
// R2 — offset pages and keyset pages enumerate DIFFERENT orders on a sortable
// collection, and the seam between them is where records used to be lost. The doc's
// fixture is used verbatim: five records whose prio order is not their id order.
// Nothing here hardcodes an id: the engine mints them from one global counter
// (F3), so the add result is the only trustworthy source.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// R1/T1.1 — the `tasks` batch reshape. For a single-id answer the engine DELETES
// `entries` and sets `entry` (src/core/records.ts, `plan.lookups.length === 1`), and
// for a one-record mutation it sets `entry` beside the page. The batch branch of
// `toWrapperResult` read only `entries`, so `?? []` turned a FOUND record into
// `{"tasks":[]}` and threw the record away — the opposite of what the tool's own
// schema promises at src/tools/runtime/tasks.tool.ts:70.
// ---------------------------------------------------------------------------
describe('records engine — the batch wrapper keeps the single-record answer (R1)', () => {
    it('T1.1: tasks with one id answers with entry, and several ids with entries', async () => {
        const engine = createRecordEngine();

        const added = await run(engine, 'tasks', { tasks: [{ text: 'Read me' }, { text: 'And me' }] }, 'author');
        const records = added.tasks as RecordEntry[];

        // A two-record add carries the page only: `entry` stays conditional on the
        // engine having exactly one affected record, so the fix is not "always emit it".
        expect(records).toHaveLength(2);
        expect(added.entry).toBeUndefined();

        const [first, second] = records;
        const single = await run(engine, 'tasks', { ids: [first.id as string] });

        // The record is back, whole: the projection a single-record `get` uses.
        expect(single.entry).toEqual({
            id: first.id,
            text: 'Read me',
            completed: false,
            rev: 1,
            updatedBy: 'author',
            updatedAt: first.updatedAt
        });
        // The plural stays an empty list for a one-id answer — that is the engine's
        // "entries deleted" contract, not the lost record.
        expect(single.tasks).toEqual([]);
        // Nothing else in the shape moved.
        expect(single.counts).toEqual({ total: 2, completed: 0, pending: 2 });
        expect(single.page).toEqual({ offset: 0, limit: 20, hasMore: false });
        expect(single.storeRev).toBe(2);

        // Several ids still answer with the list, and no `entry`.
        const several = await run(engine, 'tasks', { ids: [first.id as string, second.id as string] });

        expect(several.entry).toBeUndefined();
        expect((several.tasks as RecordEntry[]).map((task) => task.id)).toEqual([first.id, second.id]);

        // `entry` survives alongside a change feed too (the doc noted `records` already
        // did this; the wrapper must not lose it the way it lost the record).
        const withFeed = await run(engine, 'tasks', { ids: [first.id as string], since: 1 });

        expect((withFeed.entry as RecordEntry).id).toBe(first.id);
        expect((withFeed.changes as RecordChange[]).map((change) => [change.rev, change.op, change.id])).toEqual([
            [2, 'add', second.id]
        ]);
        expect(withFeed.changesHasMore).toBe(false);
        expect(withFeed.changesTruncated).toBe(false);

        // A single-record ADD carries `entry` as well as the page (R1's second half).
        const oneAdd = await run(engine, 'tasks', { tasks: [{ text: 'Just one' }] }, 'author');

        expect((oneAdd.entry as RecordEntry).text).toBe('Just one');
        expect((oneAdd.tasks as RecordEntry[])).toHaveLength(3);

        // A nonexistent id is still the loud `unknown-record`, never an empty list.
        await expectCode(
            run(engine, 'tasks', { ids: ['404'] }),
            RECORD_ERROR_CODES.unknownRecord
        );
    });

    // T1.1 EXTENSION — the batch branch dropped `result.removed` the same way it dropped
    // `entry`. The engine answers ANY call that deleted ≥1 record with `removed`, an ARRAY
    // of full copies (src/core/records.ts:2804-2813 mint the copies, :2853 attaches them);
    // `toWrapperResult` now surfaces ONE record — the singular `removed` — only when
    // exactly one was deleted, mirroring both `entry` (`affected.length === 1`, :2857) and
    // the action-wrapper branch (`removed: (result.removed ?? [])[0]`, :3253).
    it('T1.1 extension: tasks removing one record answers with removed, and a multi-record call never does', async () => {
        const engine = createRecordEngine();

        const added = await run(engine, 'tasks', { tasks: [{ text: 'Keep' }, { text: 'Drop' }] }, 'author');
        const [keep, drop] = added.tasks as RecordEntry[];

        // A removal by an identified caller is a guarded write, so it carries the token
        // it read (the same rule harness.task.test.ts pins).
        const single = await run(
            engine,
            'tasks',
            { remove: [drop.id as string], expects: [{ id: drop.id as string, rev: 1 }] },
            'author'
        );

        // The deleted record comes back WHOLE — text, `rev` and the writer attribution
        // included — beside the survivor page. This is the body the caller used to lose.
        expect(single.removed).toEqual({
            id: drop.id,
            text: 'Drop',
            completed: false,
            rev: 1,
            updatedBy: 'author',
            updatedAt: drop.updatedAt
        });
        expect((single.tasks as RecordEntry[]).map((task) => task.id)).toEqual([keep.id]);
        expect(single.counts).toEqual({ total: 1, completed: 0, pending: 1 });
        expect(single.page).toEqual({ offset: 0, limit: 20, hasMore: false });
        // Two adds + one removal = three recorded events.
        expect(single.storeRev).toBe(3);

        // `entry` and `removed` are SEPARATE facts: a removal puts nothing in `affected`
        // (:2857), so this one-record answer arrives as `removed` and not as `entry`.
        expect(single.entry).toBeUndefined();

        // MULTI-RECORD keeps the historical page-only shape — exactly as a two-record add
        // and a several-id read keep it for `entry`. The key is conditional, not always on.
        const twoMore = await run(engine, 'tasks', { tasks: [{ text: 'X' }, { text: 'Y' }] }, 'author');
        // A mutation answers with a PAGE of the whole collection, so the add result also
        // carries the surviving `keep` at the head — the two NEW records are the tail.
        const extra = (twoMore.tasks as RecordEntry[]).slice(-2);
        const multi = await run(
            engine,
            'tasks',
            {
                remove: extra.map((task) => task.id as string),
                expects: extra.map((task) => ({ id: task.id as string, rev: 1 }))
            },
            'author'
        );

        expect(multi.removed).toBeUndefined();
        expect(multi.entry).toBeUndefined();
        expect((multi.tasks as RecordEntry[]).map((task) => task.id)).toEqual([keep.id]);
        expect(multi.counts).toEqual({ total: 1, completed: 0, pending: 1 });

        // Nothing is LOST to a caller that removes several records: the un-wrapped
        // `records` surface returns the engine result verbatim (:3183), where `removed`
        // stays the full array of every record the call deleted.
        const seeded = await run(
            engine,
            'records',
            { collection: 'tasks', entries: [{ text: 'Z' }, { text: 'W' }] },
            'author'
        );
        const pair = (seeded.entries as RecordEntry[]).slice(-2);
        const engineRemoved = await run(
            engine,
            'records',
            {
                collection: 'tasks',
                remove: pair.map((entry) => entry.id as string),
                expects: pair.map((entry) => ({ id: entry.id as string, rev: 1 }))
            },
            'author'
        );

        expect((engineRemoved.removed as RecordEntry[]).map((entry) => [entry.id, entry.text])).toEqual([
            [pair[0].id, 'Z'],
            [pair[1].id, 'W']
        ]);
    });
});

describe('records engine — the two page orders and the cursor between them (R2)', () => {
    const SORTABLE_FIXTURE = {
        name: 'd2fixture',
        fields: [
            { key: 'label', type: 'text', required: true },
            { key: 'prio', type: 'integer', sortable: true }
        ]
    };

    // Builds the fixture and reports both orders, with the ids read out of the add.
    const sortableFixture = async (engine: ReturnType<typeof createRecordEngine>) => {
        await run(engine, 'records', { define: SORTABLE_FIXTURE }, 'author');

        const added = await run(
            engine,
            'records',
            {
                collection: 'd2fixture',
                entries: [
                    { label: 'A', prio: 5 },
                    { label: 'B', prio: 1 },
                    { label: 'C', prio: 9 },
                    { label: 'D', prio: 3 },
                    { label: 'E', prio: 7 }
                ]
            },
            'author'
        );

        // The mutation answer is an ordered PAGE, so it hands back the five records in
        // prio order — the labels are what map them to their minted ids.
        const byLabel = new Map(
            (added.entries as RecordEntry[]).map((entry) => [entry.label as string, entry.id])
        );
        const idOf = (label: string): string => byLabel.get(label) as string;

        return {
            idOf,
            // Page order = `prio` ascending; id order = insertion order (A..E).
            pageOrder: ['B', 'D', 'A', 'E', 'C'].map(idOf),
            idOrder: ['A', 'B', 'C', 'D', 'E'].map(idOf)
        };
    };

    // Walks to exhaustion in ONE mode and reports the ids seen plus every page object.
    const offsetWalk = async (
        engine: ReturnType<typeof createRecordEngine>,
        collection: string,
        limit: number
    ) => {
        const seen: string[] = [];
        const pages: RecordsResult['page'][] = [];
        let offset = 0;

        for (let guard = 0; guard < 10; guard += 1) {
            const result = await run(engine, 'records', { collection, offset, limit });

            seen.push(...(result.entries as RecordEntry[]).map((entry) => entry.id));
            pages.push(result.page);

            if (!result.page.hasMore) break;

            offset = result.page.nextOffset as number;
        }

        return { seen, pages };
    };

    const keysetWalk = async (
        engine: ReturnType<typeof createRecordEngine>,
        collection: string,
        afterId: string,
        limit: number
    ) => {
        const seen: string[] = [];
        const pages: RecordsResult['page'][] = [];

        for (let guard = 0; guard < 10; guard += 1) {
            const result = await run(engine, 'records', { collection, afterId, limit });

            seen.push(...(result.entries as RecordEntry[]).map((entry) => entry.id));
            pages.push(result.page);

            if (!result.page.hasMore) break;

            afterId = result.page.nextAfterId as string;
        }

        return { seen, pages };
    };

    it('T2.3a: walks a sortable collection to exhaustion by offset, seeing each record once in page order', async () => {
        const engine = createRecordEngine();
        const { pageOrder } = await sortableFixture(engine);

        const { seen, pages } = await offsetWalk(engine, 'd2fixture', 2);

        // Every record exactly once, in PAGE order (prio ascending) — the order R2 must
        // not silently turn into id order.
        expect(seen).toEqual(pageOrder);
        expect([...seen].sort()).toEqual([...pageOrder].sort());
        // The three pages, exactly: cursors only while `hasMore`, and `nextAfterId`
        // present on the two pages that offer one because this collection is sortable.
        expect(pages).toEqual([
            { offset: 0, limit: 2, hasMore: true, nextOffset: 2, nextAfterId: pageOrder[1] },
            { offset: 2, limit: 2, hasMore: true, nextOffset: 4, nextAfterId: pageOrder[3] },
            { offset: 4, limit: 2, hasMore: false }
        ]);
    });

    it('T2.3b: walks a sortable collection to exhaustion by keyset from below the smallest id, seeing each record once in id order', async () => {
        const engine = createRecordEngine();
        const { idOrder } = await sortableFixture(engine);

        // "Below the minimum id" is derived, not guessed: one below the smallest id the
        // fixture actually got.
        const belowMin = String(Math.min(...idOrder.map(Number)) - 1);

        const { seen, pages } = await keysetWalk(engine, 'd2fixture', belowMin, 2);

        // Every record exactly once, in ID order — the complete walk the reworded
        // `afterId` description promises (T2.2).
        expect(seen).toEqual(idOrder);
        expect(pages).toEqual([
            { offset: 0, limit: 2, hasMore: true, afterId: belowMin, nextAfterId: idOrder[1] },
            { offset: 2, limit: 2, hasMore: true, afterId: idOrder[1], nextAfterId: idOrder[3] },
            { offset: 4, limit: 2, hasMore: false, afterId: idOrder[3] }
        ]);
    });

    it('T2.3c: sets an offset page\'s nextAfterId to the MAXIMUM id it returned, not its last element', async () => {
        const engine = createRecordEngine();
        const { idOf, pageOrder, idOrder } = await sortableFixture(engine);

        const first = await run(engine, 'records', { collection: 'd2fixture', limit: 3 });
        const entries = first.entries as RecordEntry[];

        // limit 3 cuts the page after the prio-5 record, so the LAST element is that
        // record's id while the LARGEST id on the page belongs to the prio-3 record.
        // `nextAfterId` must be the largest one, or T2.1 is cosmetic.
        expect(entries.map((entry) => entry.id)).toEqual(pageOrder.slice(0, 3));
        expect(entries[entries.length - 1].id).toBe(idOf('A'));
        expect(first.page.nextAfterId).toBe(idOf('D'));
        expect(first.page.nextAfterId).not.toBe(entries[entries.length - 1].id);

        // The cursor is an id the walk has already returned, and it is the maximum of
        // the whole fixture's first three page-order records — i.e. resuming keyset
        // from it cannot skip a record this page carried with a smaller id.
        expect(idOrder.includes(first.page.nextAfterId as string)).toBe(true);
        expect(Number(first.page.nextAfterId)).toBe(
            Math.max(...pageOrder.slice(0, 3).map(Number))
        );

        // Page 2 (offset 3) reports the rest, and the last page carries no cursor.
        const second = await run(engine, 'records', {
            collection: 'd2fixture',
            offset: 3,
            limit: 3
        });

        expect((second.entries as RecordEntry[]).map((entry) => entry.id)).toEqual(
            pageOrder.slice(3)
        );
        expect(second.page).toEqual({ offset: 3, limit: 3, hasMore: false });
    });

    it('T2.3d: leaves an offset page of a NON-sortable collection without nextAfterId', async () => {
        const engine = createRecordEngine();

        await run(engine, 'tasks', { tasks: [{ text: 'one' }, { text: 'two' }, { text: 'three' }] }, 'author');

        const page = await run(engine, 'tasks', { limit: 2 });

        // `tasks` declares no sortable field, so its page order IS its id order and
        // `nextOffset` stays sufficient on its own — the exact page shape, which is the
        // assertion that `nextAfterId` is absent rather than merely unset-to-nothing.
        expect(page.page).toEqual({ offset: 0, limit: 2, hasMore: true, nextOffset: 2 });

        // A keyset page there is unchanged too: it keeps its own cursor and nothing else.
        const keyset = await run(engine, 'tasks', { afterId: '0', limit: 2 });

        expect(keyset.page).toEqual({
            offset: 0,
            limit: 2,
            hasMore: true,
            afterId: '0',
            nextAfterId: '2'
        });
    });
});

// ---------------------------------------------------------------------------
// R3 — `drop` + re-`define` used to rebuild the collection at storeRev 0, which
// stranded every client cursor and answered a perfectly good watermark with
// "ahead of the store". The engine now keeps a per-NAME high-water mark (runtime
// only; the snapshot keys stay exactly as they were) and gives a stranded token its
// own code.
// ---------------------------------------------------------------------------
describe('records engine — drop + re-define keeps the revision epoch (R3)', () => {
    const NOTES = {
        name: 'notes',
        fields: [{ key: 'body', type: 'text', required: true }]
    };

    // Emptying a collection is the only way to drop it (Decision M), so the epoch has
    // to be spent on adds and removals before the drop.
    const fillThenDrop = async (engine: ReturnType<typeof createRecordEngine>) => {
        await run(engine, 'records', { define: NOTES }, 'author');

        const added = await run(
            engine,
            'records',
            {
                collection: 'notes',
                entries: [{ body: 'one' }, { body: 'two' }, { body: 'three' }]
            },
            'author'
        );
        const ids = (added.entries as RecordEntry[]).map((entry) => entry.id);

        const emptied = await run(
            engine,
            'records',
            { collection: 'notes', remove: ids, expects: ids.map((id) => ({ id, rev: 1 })) },
            'author'
        );

        await run(engine, 'records', { collection: 'notes', drop: true }, 'author');

        // 3 adds + 3 removals, one event each, all in the collection's own window.
        expect(emptied.storeRev).toBe(6);

        return emptied.storeRev as number;
    };

    it('T3.1: continues storeRev across a drop and a re-define of the same name', async () => {
        const engine = createRecordEngine();

        const strandedAt = await fillThenDrop(engine);

        const redefined = await run(engine, 'records', { define: NOTES }, 'author');

        // Exactly one past the highest revision the DROPPED epoch reached, so no client
        // can hold a token that the new epoch has to call "the future", and no revision
        // number is ever re-used under the same name.
        expect(redefined.storeRev).toBe(strandedAt + 1);
        expect(redefined.storeRev).toBe(7);

        // A first-time name is untouched by all of this: storeRev 0, as before R3.
        expect(
            (
                await run(
                    engine,
                    'records',
                    { define: { name: 'fresh', fields: [{ key: 'body', type: 'text', required: true }] } },
                    'author'
                )
            ).storeRev
        ).toBe(0);
    });

    it('T3.2: a stranded token gets revision-epoch-reset, and invalid-input stays reserved for the future', async () => {
        const engine = createRecordEngine();

        await fillThenDrop(engine);
        await run(engine, 'records', { define: NOTES }, 'author');

        // The doc's reproduction: the watermark a client saved before the drop. It is
        // NOT ahead of the store (the store is now ahead of IT), so `invalid-input` was
        // the wrong diagnosis and the token could never be accepted again.
        const stranded = await expectCode(
            run(engine, 'records', { collection: 'notes', since: 3 }, 'author'),
            RECORD_ERROR_CODES.revisionEpochReset
        );

        expect(stranded.message).toBe(
            'revision-epoch-reset: notes "since" 3 predates the current change log ' +
                '(the collection was dropped and re-defined; storeRev is now 7) — resync from scratch.'
        );
        expect(stranded.details).toEqual({
            collection: 'notes',
            since: 3,
            epochFloor: 7,
            storeRev: 7
        });

        // The last revision of the dropped epoch is stranded for the same reason.
        await expectCode(
            run(engine, 'records', { collection: 'notes', since: 6 }, 'author'),
            RECORD_ERROR_CODES.revisionEpochReset
        );

        // `invalid-input` keeps its original meaning and wording: a revision the store
        // has genuinely not produced yet.
        const future = await expectCode(
            run(engine, 'records', { collection: 'notes', since: 8 }, 'author'),
            RECORD_ERROR_CODES.invalidInput
        );

        expect(future.message).toBe(
            'invalid-input: notes "since" is revision 8, ahead of the store (storeRev 7); read the list first.'
        );

        // A token AT the floor is accepted and resolves against the new log: the write
        // below is the only event after it.
        const wrote = await run(engine, 'records', { collection: 'notes', entries: [{ body: 'after' }] }, 'author');

        expect(wrote.storeRev).toBe(8);

        const feed = await run(engine, 'records', { collection: 'notes', since: 7 }, 'author');

        expect((feed.changes as RecordChange[]).map((change) => [change.rev, change.op, change.id])).toEqual(
            [[8, 'add', (wrote.entries as RecordEntry[])[0].id]]
        );
        expect(feed.changesTruncated).toBe(false);
        expect(feed.changesHasMore).toBe(false);
    });

    it('T3 stop-condition 4: reset() still rewinds every revision to 0 by design', async () => {
        const engine = createRecordEngine();

        await fillThenDrop(engine);
        expect((await run(engine, 'records', { define: NOTES }, 'author')).storeRev).toBe(7);

        engine.reset();

        // A reset is a declared clean start, not a drop: the defined collection goes
        // with it, and so does the epoch bookkeeping — otherwise a reset would refuse
        // the `since: 0` that is correct again by definition.
        await expectCode(
            run(engine, 'records', { collection: 'notes' }),
            RECORD_ERROR_CODES.unknownCollection
        );
        expect((await run(engine, 'records', { define: NOTES }, 'author')).storeRev).toBe(0);
        expect((await run(engine, 'records', { collection: 'notes', since: 0 })).storeRev).toBe(0);
        expect((await tasks(engine, {})).storeRev).toBe(0);
    });

    it('T3: the epoch is runtime-only — the snapshot keys stay exact and a restore reseeds it', async () => {
        const engine = createRecordEngine();

        await fillThenDrop(engine);
        await run(engine, 'records', { define: NOTES }, 'author');

        const saved = JSON.parse(JSON.stringify(engine.snapshot())) as {
            nextId: number;
            collections: Record<string, { definition: unknown; items: unknown[]; storeRev: number; changes: unknown[] }>;
        };

        // No new persisted key, so `readRecordsStoreState`'s exact-key validation (and
        // every snapshot written before R3) keeps working unchanged.
        expect(Object.keys(saved)).toEqual(['nextId', 'collections']);
        expect(Object.keys(saved.collections.notes)).toEqual([
            'definition',
            'items',
            'storeRev',
            'changes'
        ]);
        expect(saved.collections.notes.storeRev).toBe(7);

        engine.reset();
        engine.restore(saved);

        // Restored into a fresh engine, the persisted revision is answerable...
        expect((await run(engine, 'records', { collection: 'notes', since: 7 })).changes).toEqual([]);

        // ...and it seeds the high-water mark, so the NEXT drop + re-`define` stays
        // monotonic across the restart rather than falling back to 0.
        await run(engine, 'records', { collection: 'notes', drop: true }, 'author');
        expect((await run(engine, 'records', { define: NOTES }, 'author')).storeRev).toBe(8);
    });
});

// ---------------------------------------------------------------------------
// R6 — the read surface could answer "what records are here" but never "what IS this
// collection": a `define`d spec was write-only, which in the reported session cost four
// failed `define` calls discovering the accepted `count` shapes. `describe` reads the
// stored definition back, and a `records` call with no `collection` now lists the names
// instead of only being able to throw them.
// ---------------------------------------------------------------------------
describe('records engine — reading a collection\'s own spec back (R6)', () => {
    // Every cap a `define` may set, all non-default, so a describe answer that merely
    // echoed the engine defaults would fail this.
    const PROBEG = {
        name: 'probeg1',
        maxRecords: 7,
        fields: [
            { key: 'title', type: 'text', required: true, maxLength: 42 },
            { key: 'body', type: 'text', maxLength: 500, getOnly: true },
            { key: 'rank', type: 'integer', sortable: true, max: 999 },
            { key: 'kind', type: 'enum', values: ['note', 'task', 'someday'], count: true },
            { key: 'done', type: 'boolean', default: false, count: { key: 'done', complement: 'open' } }
        ]
    };

    // The shape `readFieldDefinition` actually STORES: it omits a key that was never
    // sent rather than storing it empty, and it normalizes nothing else.
    const STORED_PROBEG = {
        name: 'probeg1',
        fields: [
            { key: 'title', type: 'text', required: true, maxLength: 42 },
            { key: 'body', type: 'text', maxLength: 500, getOnly: true },
            { key: 'rank', type: 'integer', sortable: true, max: 999 },
            { key: 'kind', type: 'enum', values: ['note', 'task', 'someday'], count: true },
            { key: 'done', type: 'boolean', default: false, count: { key: 'done', complement: 'open' } }
        ],
        maxRecords: 7,
        // `define` cannot set the page budget (readDefineInput allows name/fields/
        // maxRecords only), so the verbatim answer here is the engine default — which is
        // still the number the store enforces, and the caller had no way to know it.
        responseBudgetBytes: 64 * 1024
    };

    it('T6.1: describe returns the stored definition verbatim, caps included', async () => {
        const engine = createRecordEngine();

        await run(engine, 'records', { define: PROBEG }, 'author');
        await run(engine, 'records', { collection: 'probeg1', entries: [{ title: 'Ship it', kind: 'task' }] }, 'author');

        const described = await run(engine, 'records', { collection: 'probeg1', describe: true }, 'author');

        expect(described.collection).toBe('probeg1');
        expect(described.definition).toEqual(STORED_PROBEG);

        // The envelope is the engine's own single shape: an empty page, the collection's
        // real counts and revision, and NOTHING written by the call.
        expect(described.entries).toEqual([]);
        expect(described.page).toEqual({ offset: 0, limit: 20, hasMore: false });
        expect(described.storeRev).toBe(1);
        expect(described.counts).toEqual({ total: 1, note: 0, task: 1, someday: 0, done: 0, open: 1 });

        // The answer is the TRUTH, not a copy of a wish: the caps it reports are the caps
        // the store enforces.
        await expectCode(
            run(engine, 'records', { collection: 'probeg1', entries: [{ title: 'x'.repeat(43), kind: 'note' }] }, 'author'),
            RECORD_ERROR_CODES.fieldTooLong
        );

        // And the returned object is DETACHED — widening a cap on an answer must not
        // widen it in the store (the same copy-on-the-way-out rule as an entry).
        (described.definition as { maxRecords: number }).maxRecords = 99;
        (described.definition as { fields: { values?: string[] }[] }).fields[3].values?.push('accidental');

        expect(
            (
                await run(engine, 'records', { collection: 'probeg1', describe: true }, 'author')
            ).definition
        ).toEqual(STORED_PROBEG);
    });

    it('T6.1: describe is a read on its own — a batch beside it and a non-boolean are refused', async () => {
        const engine = createRecordEngine();

        await run(engine, 'records', { define: PROBEG }, 'author');

        const mixed = await expectCode(
            run(engine, 'records', { collection: 'probeg1', describe: true, entries: [{ title: 'quiet', kind: 'note' }] }, 'author'),
            RECORD_ERROR_CODES.invalidInput
        );

        expect(mixed.message).toBe(
            'invalid-input: probeg1 "describe" reads a collection\'s definition on its own; send it without "entries", "remove", "ids", "since", "offset", "limit", "afterId" or "where".'
        );

        // Nothing was written by the refused call — and the facet keys are always present,
        // so an empty collection answers zeros rather than a bare `{ total: 0 }`.
        expect((await run(engine, 'records', { collection: 'probeg1' })).counts).toEqual({
            total: 0,
            note: 0,
            task: 0,
            someday: 0,
            done: 0,
            open: 0
        });

        await expectCode(
            run(engine, 'records', { collection: 'probeg1', describe: 'yes' }, 'author'),
            RECORD_ERROR_CODES.invalidInput
        );

        // `describe: false` is an ordinary read, not an error and not an answer.
        const plain = await run(engine, 'records', { collection: 'probeg1', describe: false }, 'author');

        expect(plain.definition).toBeUndefined();
        expect(plain.entries).toEqual([]);
    });

    // Review F5 — the guard used to refuse only `entries`/`remove`/`ids`, so every READ
    // control beside `describe: true` rode along unvalidated and silently did nothing.
    // `since: 999` was the worst case: the very same value is a loud "ahead of the store"
    // refusal on an ordinary read, and a refusal the caller never heard while asking for a
    // definition. All five controls are now refused, and only beside `describe: true`.
    it('T6.1/F5: describe refuses since, offset, limit, afterId and where beside it', async () => {
        const engine = createRecordEngine();

        await run(engine, 'records', { define: PROBEG }, 'author');

        const message =
            `invalid-input: probeg1 "describe" reads a collection's definition on its own; ` +
            'send it without "entries", "remove", "ids", "since", "offset", "limit", "afterId" or "where".';

        // The exact reported case: garbage `since` beside a describe.
        const stranded = await expectCode(
            run(engine, 'records', { collection: 'probeg1', describe: true, since: 999 }, 'author'),
            RECORD_ERROR_CODES.invalidInput
        );

        expect(stranded.message).toBe(message);

        // Every other read control, one at a time, so no single guard can be the only one
        // that fires. `offset`/`limit`/`afterId` are all VALID page values here — the
        // refusal is the combination, never the value.
        await expectCode(
            run(engine, 'records', { collection: 'probeg1', describe: true, offset: 0 }, 'author'),
            RECORD_ERROR_CODES.invalidInput
        );
        await expectCode(
            run(engine, 'records', { collection: 'probeg1', describe: true, limit: 5 }, 'author'),
            RECORD_ERROR_CODES.invalidInput
        );
        await expectCode(
            run(engine, 'records', { collection: 'probeg1', describe: true, afterId: '1' }, 'author'),
            RECORD_ERROR_CODES.invalidInput
        );

        // `where` is refused BEFORE its value is validated, so this never reaches the
        // field-name check: the combination is the caller's error.
        const filtered = await expectCode(
            run(engine, 'records', { collection: 'probeg1', describe: true, where: { kind: 'nope' } }, 'author'),
            RECORD_ERROR_CODES.invalidInput
        );

        expect(filtered.message).toBe(message);

        // The guard is scoped to `describe: true`. Off, the same `since: 999` is answered
        // by the ordinary rule and the same message, and the `limit` still pages.
        const stillFuture = await expectCode(
            run(engine, 'records', { collection: 'probeg1', describe: false, since: 999 }, 'author'),
            RECORD_ERROR_CODES.invalidInput
        );

        expect(stillFuture.message).toBe(
            'invalid-input: probeg1 "since" is revision 999, ahead of the store (storeRev 0); read the list first.'
        );

        const paged = await run(engine, 'records', { collection: 'probeg1', describe: false, limit: 5 }, 'author');

        expect(paged.page).toEqual({ offset: 0, limit: 5, hasMore: false });

        // A describe with NOTHING beside it still answers — the refusals above cost the
        // call nothing.
        expect(((await run(engine, 'records', { collection: 'probeg1', describe: true }, 'author')).definition as { name: string }).name).toBe('probeg1');
    });

    it('T6.2: a records call with no collection lists the names, and every unknown-collection wording is unchanged', async () => {
        const engine = createRecordEngine();

        const bare = await run(engine, 'records', {});

        // Sorted, so two harnesses answer identically; the built-ins are the whole set.
        expect(bare.collections).toEqual(['chapters', 'locations', 'profiles', 'tasks']);
        expect(bare.entries).toEqual([]);
        expect(bare.counts).toEqual({ total: 4 });
        // No single collection is addressed, so there is no store revision to report.
        expect(bare.storeRev).toBe(0);

        await run(engine, 'records', { define: PROBEG }, 'author');

        expect((await run(engine, 'records', {})).collections).toEqual([
            'chapters',
            'locations',
            'probeg1',
            'profiles',
            'tasks'
        ]);

        // A defined collection shows up in the list without tripping an error, and the
        // `unknown-collection` sentence keeps quoting names in DECLARATION order.
        const unknown = await expectCode(run(engine, 'records', { collection: 'tsak' }), RECORD_ERROR_CODES.unknownCollection);

        expect(unknown.message).toBe(
            'unknown-collection: records has no collection "tsak"; defined collections: tasks, chapters, profiles, locations, probeg1. Pass "define" to create a new one.'
        );
        expect(unknown.details).toEqual({
            collection: 'tsak',
            defined: ['tasks', 'chapters', 'profiles', 'locations', 'probeg1']
        });

        // `drop` with no collection is still the "requires a non-empty" refusal — the
        // bare-call listing is only for a call that sent neither `collection` nor `drop`.
        const dropped = await expectCode(run(engine, 'records', { drop: true }), RECORD_ERROR_CODES.unknownCollection);

        expect(dropped.message).toBe(
            'unknown-collection: records requires a non-empty "collection" string; defined collections: tasks, chapters, profiles, locations, probeg1.'
        );

        // An empty string is not an absent collection either.
        expect(
            (
                await expectCode(run(engine, 'records', { collection: '' }), RECORD_ERROR_CODES.unknownCollection)
            ).message
        ).toBe(dropped.message);
    });
});

// ---------------------------------------------------------------------------
// R7/T7.1 — a list read used to be `offset`/`limit`/`afterId`/`since` only, so
// `counts` said "2 of 55 are done" and finding those two still meant paging all 55.
// `where` is an equality map applied BEFORE ordering and paging, and a filtered read
// counts the FILTERED set — the only way a facet count and a page can be reconciled.
// An unfiltered read is untouched, which is what the last test below pins.
// ---------------------------------------------------------------------------
describe('records engine — equality filtering on a list read (R7)', () => {
    // No sortable field here, so page order IS id order and the page expectations below
    // are exact. Both facets (`kind` enum, `pinned` boolean) exist to show that the
    // FACET counts move with the filter, not just `total`.
    const ISSUES = {
        name: 'issues',
        fields: [
            { key: 'title', type: 'text', required: true },
            { key: 'kind', type: 'enum', values: ['open', 'done'], count: true },
            { key: 'pinned', type: 'boolean', default: false, count: { key: 'pinned', complement: 'loose' } }
        ]
    };

    const seedIssues = async (engine: ReturnType<typeof createRecordEngine>) => {
        await run(engine, 'records', { define: ISSUES }, 'author');

        const added = await run(
            engine,
            'records',
            {
                collection: 'issues',
                entries: [
                    { title: 'one', kind: 'open', pinned: true },
                    { title: 'two', kind: 'open' },
                    { title: 'three', kind: 'done', pinned: true },
                    { title: 'four', kind: 'open' },
                    { title: 'five', kind: 'done' },
                    { title: 'six', kind: 'done' }
                ]
            },
            'author'
        );

        return added.entries as RecordEntry[];
    };

    it('T7.1: a filtered page returns only the matching records', async () => {
        const engine = createRecordEngine();

        await seedIssues(engine);

        const filtered = await run(engine, 'records', { collection: 'issues', where: { kind: 'open' } });

        expect((filtered.entries as RecordEntry[]).map((entry) => entry.title)).toEqual(['one', 'two', 'four']);

        // AND across the keys.
        const both = await run(engine, 'records', {
            collection: 'issues',
            where: { kind: 'open', pinned: false }
        });

        expect((both.entries as RecordEntry[]).map((entry) => entry.title)).toEqual(['two', 'four']);

        // A filter that matches nothing is an empty page, not an error — and `total` says
        // so instead of quoting the collection's size.
        const none = await run(engine, 'records', { collection: 'issues', where: { kind: 'done', pinned: true, title: 'nope' } });

        expect(none.entries).toEqual([]);
        expect(none.counts).toEqual({ total: 0, open: 0, done: 0, pinned: 0, loose: 0 });
        expect(none.page).toEqual({ offset: 0, limit: 20, hasMore: false });
    });

    it('T7.1: hasMore and nextOffset are computed against the filtered set', async () => {
        const engine = createRecordEngine();

        await seedIssues(engine);

        // Three of six match `kind: open`, so limit 3 is the WHOLE filtered set: an
        // unfiltered read of six would report hasMore: true here, and the doc's complaint
        // was exactly a cursor that disagreed with the counts.
        const lastPage = await run(engine, 'records', { collection: 'issues', where: { kind: 'open' }, limit: 3 });

        expect((lastPage.entries as RecordEntry[]).map((entry) => entry.title)).toEqual(['one', 'two', 'four']);
        expect(lastPage.page).toEqual({ offset: 0, limit: 3, hasMore: false });

        // Walk the filtered set to exhaustion: two pages, and the offsets count MATCHES,
        // not the collection.
        const first = await run(engine, 'records', { collection: 'issues', where: { kind: 'done' }, limit: 2 });

        expect(first.page).toEqual({ offset: 0, limit: 2, hasMore: true, nextOffset: 2 });

        const second = await run(engine, 'records', {
            collection: 'issues',
            where: { kind: 'done' },
            offset: 2,
            limit: 2
        });

        expect((second.entries as RecordEntry[]).map((entry) => entry.title)).toEqual(['six']);
        expect(second.page).toEqual({ offset: 2, limit: 2, hasMore: false });

        // The same two modes over a collection that DECLARES a sortable field — R2's
        // fixture — so the filter and the page orders are exercised together rather than
        // one at a time.
        const sortable = createRecordEngine();

        await run(sortable, 'records', {
            define: {
                name: 'd2fixture',
                fields: [
                    { key: 'label', type: 'text', required: true },
                    { key: 'prio', type: 'integer', sortable: true }
                ]
            }
        }, 'author');
        await run(
            sortable,
            'records',
            {
                collection: 'd2fixture',
                entries: [
                    { label: 'A', prio: 5 },
                    { label: 'B', prio: 1 },
                    { label: 'C', prio: 9 },
                    { label: 'D', prio: 3 },
                    { label: 'E', prio: 7 }
                ]
            },
            'author'
        );

        // The same filter over a SORTABLE collection. Each `prio` in this fixture is
        // unique, so an equality term matches EXACTLY ONE record: both modes answer with
        // a one-record page, `hasMore: false`, and NO cursor at all. The case where a
        // filtered offset page does have matches behind it — and must then report
        // `nextAfterId` as the maximum id of the MATCHING page — is the F4 test below.
        const singleMatch = await run(sortable, 'records', {
            collection: 'd2fixture',
            where: { prio: 5 },
            limit: 1
        });

        expect((singleMatch.entries as RecordEntry[]).map((entry) => entry.label)).toEqual(['A']);
        expect(singleMatch.counts).toEqual({ total: 1 });
        expect(singleMatch.page).toEqual({ offset: 0, limit: 1, hasMore: false });

        // The keyset form of the same single match: the cursor is echoed, and a page that
        // is not truncated sets no `nextAfterId`.
        const singleMatchKeyset = await run(sortable, 'records', {
            collection: 'd2fixture',
            where: { prio: 1 },
            afterId: '0',
            limit: 1
        });

        expect((singleMatchKeyset.entries as RecordEntry[]).map((entry) => entry.label)).toEqual(['B']);
        expect(singleMatchKeyset.page).toEqual({
            offset: 0,
            limit: 1,
            hasMore: false,
            afterId: '0'
        });
    });

    // Review F4 — R2's cursor rule and R7's filter meet in ONE page shape neither group
    // pinned: a filtered OFFSET page of a SORTABLE collection that still has matches
    // behind it. `hasMore: true` must then carry `nextAfterId`, and it must be the MAXIMUM
    // id among the FILTERED page's entries — not its last element, and computed over the
    // matching records, not the whole collection.
    it('T7.1/F4: a filtered offset page of a sortable collection sets nextAfterId to the maximum id among the matches it returned', async () => {
        const engine = createRecordEngine();

        // `prio` is the sort key and is unique per record, so the equality term needs its
        // own field — `tag` splits the six into four matches and two non-matches.
        await run(
            engine,
            'records',
            {
                define: {
                    name: 'd2tags',
                    fields: [
                        { key: 'label', type: 'text', required: true },
                        { key: 'prio', type: 'integer', sortable: true },
                        { key: 'tag', type: 'text', required: true }
                    ]
                }
            },
            'author'
        );

        const added = await run(
            engine,
            'records',
            {
                collection: 'd2tags',
                entries: [
                    { label: 'A', prio: 6, tag: 'x' },
                    { label: 'B', prio: 7, tag: 'x' },
                    { label: 'C', prio: 9, tag: 'y' },
                    { label: 'D', prio: 3, tag: 'x' },
                    { label: 'E', prio: 8, tag: 'y' },
                    { label: 'F', prio: 1, tag: 'x' }
                ]
            },
            'author'
        );

        // Ids are minted, never guessed: the labels map them.
        const ids = new Map((added.entries as RecordEntry[]).map((entry) => [entry.label as string, entry.id as string]));
        const idOf = (label: string): string => ids.get(label) as string;
        const labels = (result: RecordsResult & Record<string, unknown>) =>
            (result.entries as RecordEntry[]).map((entry) => entry.label);

        // Four of six match `tag: x`. In PAGE order (prio ascending) they run F(1), D(3),
        // A(6), B(7) with ids 6, 4, 1, 2 — so a three-record page ENDS on the smallest id
        // it carries. A cursor taken from the last element would re-emit F and D.
        const first = await run(engine, 'records', { collection: 'd2tags', where: { tag: 'x' }, limit: 3 });

        expect(labels(first)).toEqual(['F', 'D', 'A']);
        // The counts are the FILTERED ones, so page and counts reconcile (R7's rule).
        expect(first.counts).toEqual({ total: 4 });
        expect(first.page).toEqual({
            offset: 0,
            limit: 3,
            hasMore: true,
            nextOffset: 3,
            nextAfterId: idOf('F')
        });

        // MAXIMUM, and explicitly not the last element, and not some id the filter had
        // thrown away: every id on this page is at or below the cursor.
        const pageIds = (first.entries as RecordEntry[]).map((entry) => Number(entry.id));

        expect(Number(first.page.nextAfterId)).toBe(Math.max(...pageIds));
        expect(first.page.nextAfterId).not.toBe((first.entries as RecordEntry[])[2].id);

        // What the cursor is FOR: resuming above it repeats nothing this page carried.
        const resumed = await run(engine, 'records', {
            collection: 'd2tags',
            where: { tag: 'x' },
            afterId: first.page.nextAfterId as string,
            limit: 3
        });

        expect(resumed.entries).toEqual([]);
        expect(resumed.page).toEqual({
            // Keyset mode reports the effective index — here the END of the four matches.
            offset: 4,
            limit: 3,
            hasMore: false,
            afterId: first.page.nextAfterId as string
        });

        // And the COMPLETE walk over a filtered set is still R2's: keyset from below the
        // smallest id, in ID order, every match exactly once. (Switching modes part-way is
        // the documented limit — a match that sorts later but carries a smaller id, B here,
        // is not reachable by the switch, which is why one walk must not mix the modes.)
        const belowMin = String(Math.min(...['A', 'B', 'D', 'F'].map((label) => Number(idOf(label)))) - 1);
        const walk = await run(engine, 'records', { collection: 'd2tags', where: { tag: 'x' }, afterId: belowMin, limit: 3 });

        expect(labels(walk)).toEqual(['A', 'B', 'D']);
        expect(walk.page).toEqual({
            offset: 0,
            limit: 3,
            hasMore: true,
            afterId: belowMin,
            nextAfterId: idOf('D')
        });

        const tail = await run(engine, 'records', {
            collection: 'd2tags',
            where: { tag: 'x' },
            afterId: walk.page.nextAfterId as string,
            limit: 3
        });

        expect(labels(tail)).toEqual(['F']);
        expect(tail.page).toEqual({
            offset: 3,
            limit: 3,
            hasMore: false,
            afterId: walk.page.nextAfterId as string
        });
    });

    it('T7.1: counts reflect the filter, and an unfiltered read still counts the whole collection', async () => {
        const engine = createRecordEngine();

        await seedIssues(engine);

        // The unfiltered shape, exactly as it was before R7: whole-collection facets while
        // the page is a slice. Stop-condition 5 — this must not move.
        const unfiltered = await run(engine, 'records', { collection: 'issues', limit: 2 });

        expect(unfiltered.counts).toEqual({ total: 6, open: 3, done: 3, pinned: 2, loose: 4 });
        expect((unfiltered.entries as RecordEntry[])).toHaveLength(2);
        expect(unfiltered.page).toEqual({ offset: 0, limit: 2, hasMore: true, nextOffset: 2 });

        // Filtered: `total` AND both facets are over the matching set, so the page and the
        // counts can finally be reconciled.
        const filtered = await run(engine, 'records', { collection: 'issues', where: { kind: 'open' }, limit: 2 });

        expect(filtered.counts).toEqual({ total: 3, open: 3, done: 0, pinned: 1, loose: 2 });
        expect(filtered.storeRev).toBe(unfiltered.storeRev);
    });

    it('T7.1: where and since cannot be combined, and a bad key or value type is refused by name', async () => {
        const engine = createRecordEngine();

        await seedIssues(engine);

        const combined = await expectCode(
            run(engine, 'records', { collection: 'issues', where: { kind: 'open' }, since: 0 }, 'author'),
            RECORD_ERROR_CODES.invalidInput
        );

        expect(combined.message).toBe(
            'invalid-input: issues "where" and "since" cannot be combined: the change feed is the unfiltered log of the whole collection.'
        );

        // A typo in a key must be a refusal naming the typo, never an empty page — the
        // collection's fields are invisible to the JSON Schema of a `define`d collection.
        const unknownKey = await expectCode(
            run(engine, 'records', { collection: 'issues', where: { status: 'open' } }, 'author'),
            RECORD_ERROR_CODES.invalidInput
        );

        expect(unknownKey.message).toBe(
            'invalid-input: issues "where" has no field "status"; filterable fields: title, kind, pinned.'
        );

        const wrongType = await expectCode(
            run(engine, 'records', { collection: 'issues', where: { pinned: 'yes' } }, 'author'),
            RECORD_ERROR_CODES.invalidInput
        );

        expect(wrongType.message).toBe(
            'invalid-input: issues "where.pinned" must be a boolean to filter a boolean field; got "yes".'
        );

        // An enum term has to be one the field declares.
        const wrongEnum = await expectCode(
            run(engine, 'records', { collection: 'issues', where: { kind: 'archived' } }, 'author'),
            RECORD_ERROR_CODES.invalidInput
        );

        expect(wrongEnum.message).toBe(
            'invalid-input: issues "where.kind" must be one of: open, done; got "archived".'
        );

        // An integer field will not accept a string term.
        await run(
            engine,
            'records',
            { define: { name: 'd2', fields: [{ key: 'prio', type: 'integer', sortable: true }] } },
            'author'
        );

        const wrongInteger = await expectCode(
            run(engine, 'records', { collection: 'd2', where: { prio: '5' } }, 'author'),
            RECORD_ERROR_CODES.invalidInput
        );

        expect(wrongInteger.message).toBe(
            'invalid-input: d2 "where.prio" must be an integer to filter an integer field; got "5".'
        );

        // `where` itself must be a map, and an array is not one.
        const notAMap = await expectCode(
            run(engine, 'records', { collection: 'issues', where: ['kind', 'open'] }, 'author'),
            RECORD_ERROR_CODES.invalidInput
        );

        expect(notAMap.message).toBe(
            'invalid-input: issues "where" must be an object of { field: value } equality terms when provided.'
        );

        // A `strings` field has no scalar equality term.
        const strings = createRecordEngine();

        await run(strings, 'records', {
            define: { name: 'tags', fields: [{ key: 'names', type: 'strings', maxItems: 4 }] }
        }, 'author');

        const stringsFilter = await expectCode(
            run(strings, 'records', { collection: 'tags', where: { names: 'brave' } }, 'author'),
            RECORD_ERROR_CODES.invalidInput
        );

        expect(stringsFilter.message).toBe(
            'invalid-input: tags "where" cannot filter the strings field "names"; an equality term is a text, integer, enum or boolean value.'
        );
    });

    // Review F3 — `where` beside `ids` was neither refused nor documented: `readIds`
    // answers with exactly the ids named, while `project` had already filtered the page
    // and the counts beside them, so one envelope carried two different sets.
    it('T7.1/F3: where cannot be combined with ids, the one lookup that answers without a page', async () => {
        const engine = createRecordEngine();

        const seeded = await seedIssues(engine);

        const combined = await expectCode(
            run(engine, 'records', { collection: 'issues', where: { kind: 'open' }, ids: [seeded[0].id as string] }, 'author'),
            RECORD_ERROR_CODES.invalidInput
        );

        expect(combined.message).toBe(
            'invalid-input: issues "where" and "ids" cannot be combined: "ids" answers with the records it names, ' +
                'so a filter would narrow only the page and the counts beside them.'
        );

        // Same rule through the WRAPPERS, which is where it is most likely to be hit by
        // accident: `tasks { where, ids }`, and an `action`-style `get`, whose schema
        // already calls `where` "For 'list' only" and which maps to `ids: [id]`.
        await expectCode(
            run(engine, 'tasks', { where: { completed: true }, ids: ['1'] }, 'author'),
            RECORD_ERROR_CODES.invalidInput
        );

        await run(engine, 'chapters', { action: 'add', title: 'One', summary: 'a' }, 'author');

        const throughGet = await expectCode(
            run(engine, 'chapters', { action: 'get', id: '1', where: { status: 'draft' } }, 'author'),
            RECORD_ERROR_CODES.invalidInput
        );

        expect(throughGet.message).toBe(
            'invalid-input: chapters "where" and "ids" cannot be combined: "ids" answers with the records it names, ' +
                'so a filter would narrow only the page and the counts beside them.'
        );

        // NOT refused: `entries`/`remove` are writes, and a mutation still answers with a
        // page — the one mode where a filter means something. Refusing them would have
        // taken R7's filtered mutation page away, so this pins the boundary. `seven` is
        // `done`, so it is NOT in the filtered set of three (`one` is the only pinned one).
        const mutated = await run(
            engine,
            'records',
            { collection: 'issues', entries: [{ title: 'seven', kind: 'done' }], where: { kind: 'open' } },
            'author'
        );

        expect(mutated.counts).toEqual({ total: 3, open: 3, done: 0, pinned: 1, loose: 2 });
        expect((mutated.entries as RecordEntry[]).map((entry) => entry.title)).toEqual(['one', 'two', 'four']);
    });

    it('T7.1: a getOnly field is withheld from the page but still filterable, and text terms meet the stored form', async () => {
        const engine = createRecordEngine();

        await run(engine, 'chapters', { action: 'add', title: 'Late', summary: 'z', content: 'Body B' }, 'author');
        await run(
            engine,
            'chapters',
            { action: 'add', title: 'First', summary: 'a', content: 'Body A', status: 'draft' },
            'author'
        );

        // `content` never rides a page, yet it is a declared field, so it is filterable.
        const byBody = await run(engine, 'chapters', { action: 'list', where: { content: 'Body A' } });

        expect((byBody.chapters as RecordEntry[]).map((chapter) => chapter.title)).toEqual(['First']);
        expect(byBody.counts).toEqual({ total: 1, planned: 0, draft: 1, complete: 0 });

        // A stored text is trimmed on the way in, so the term is trimmed to meet it —
        // otherwise a filter copied out of a prose context would silently match nothing.
        const padded = await run(engine, 'chapters', { action: 'list', where: { title: '  Late  ' } });

        expect((padded.chapters as RecordEntry[]).map((chapter) => chapter.title)).toEqual(['Late']);
        expect(padded.counts).toEqual({ total: 1, planned: 1, draft: 0, complete: 0 });

        // A term that is not a declared field is still refused through the WRAPPER, whose
        // own schema cannot know the engine's field set.
        await expectCode(
            run(engine, 'chapters', { action: 'list', where: { body: 'Body A' } }, 'author'),
            RECORD_ERROR_CODES.invalidInput
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

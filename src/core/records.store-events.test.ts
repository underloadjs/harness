// R2a/R3a — the record store's OBSERVATION plane (the live records/tasks panels).
//
// WHAT THIS FILE PINS. `createRecordEngine()` grew a store-wide feed and three readers
// (`onStoreChange`, `view`, `changesSince`) beside the per-collection change windows. The
// per-collection contract already has an owner — `./records.test.ts` pins Decision B's
// windows, `../harness.task.test.ts` and `../harness.records.test.ts` pin the tool
// envelopes — so this file is deliberately narrow: it pins ONLY the store-level rules the
// panels depend on, and the one rule that keeps the whole feature safe, namely that adding
// an observer changes nothing about what a write returns or persists.
//
// THE RULES, in the words the requirements use:
//   1. one notification per COMMITTED call, never per entry, and none for a read or a
//      rejection (a rejected call leaves the store where it was, so it has nothing to say);
//   2. `seq` is store-wide and monotonic ACROSS collections while `rev` inside an entry
//      stays that collection's own revision — a client cursors on `seq`, a CAS guard uses `rev`;
//   3. the collection SET has its own counter (`collectionsRev`): a `define`/`drop` mints no
//      record event, so it must move `collectionsRev` and leave `storeRev` alone;
//   4. `changesSince(since)` answers `reset: true` exactly when `since` is no longer
//      answerable (trimmed window, replaced store, a watermark above the head) — never for a
//      cursor that is merely current;
//   5. the feed is RUNTIME state: `snapshot()`'s key set must not grow.
//
// Cross-references:
//   - ./records.ts            — `pushChange` (the feed writer), `runCall` (the one notify
//                               site for a mutation), `view`/`changesSince` (lines ~3736-3778)
//   - ../types/index.ts       — `RecordStoreNotification` / `RecordStoreView` /
//                               `RecordStoreDelta` (lines ~1512-1575)
//   - ./records.test.ts       — the per-collection `RecordChange` entry shape this file's feed
//                               entries are built from, and the ToolContext helper pattern
//   - ../server/sessions.ts   — the host that turns a notification into a `records.updated`
//                               stream signal (pinned in ../server/api-records-live.test.ts)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecordEngine } from './records';
import type { RecordStoreDelta, RecordStoreNotification, RecordStoreView } from '../types';

// THE FROZEN CLOCK. Every store timestamp (an entry's `updatedAt`, a feed entry's `at`)
// comes from `Date`, so pinning Date gives each one exactly one expected value — the same
// policy `../harness.task.test.ts` uses. `toFake: ['Date']` keeps timers real.
const EPOCH_ISO = '2026-01-01T00:00:00.000Z';
const EPOCH_MS = Date.parse(EPOCH_ISO);

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(EPOCH_MS);
});

afterEach(() => {
    vi.useRealTimers();
});

type Engine = ReturnType<typeof createRecordEngine>;

// The engine speaks ToolContext, so this builds the minimal context the record tools read
// (`parameters`, `agent?.name`, `threadId`) and calls the routed surface — the same door a
// lane worker's write routes through (../server/workers/lane-authority.ts `contextFor`).
const run = async (
    engine: Engine,
    tool: 'records' | 'tasks' | 'chapters' | 'profiles' | 'locations',
    parameters: Record<string, unknown>,
    by?: string,
    threadId?: string
): Promise<Record<string, unknown>> =>
    (await engine.executeRecords(tool, {
        parameters,
        ...(by === undefined ? {} : { agent: { name: by } as never }),
        ...(threadId === undefined ? {} : { threadId })
    } as never)) as Record<string, unknown>;

// A recording subscriber. `stop` is the engine's own unsubscribe closure, so the test for
// unsubscribing exercises the real return value rather than a Set the test maintains.
const subscribe = (engine: Engine) => {
    const notifications: RecordStoreNotification[] = [];

    const stop = engine.onStoreChange((notification) => {
        notifications.push(notification);
    });

    return { notifications, stop };
};

describe('the store-wide notification — exactly one per committed call', () => {
    it('announces a committed batch once, carrying every entry it appended', async () => {
        const engine = createRecordEngine();
        const { notifications } = subscribe(engine);

        // One call, two entries. `completed: false` is the stored default, so the feed
        // entry describes the event, not the row — an add carries no `fields` list.
        await run(engine, 'tasks', { tasks: [{ text: 'One' }, { text: 'Two' }] }, 'writer', 'thread-1');

        expect(notifications).toEqual([
            {
                storeRev: 2,
                collectionsRev: 0,
                affectedCollections: ['tasks'],
                changes: [
                    {
                        seq: 1,
                        collection: 'tasks',
                        rev: 1,
                        id: '1',
                        op: 'add',
                        by: 'writer',
                        threadId: 'thread-1',
                        at: EPOCH_ISO,
                        itemRev: 1
                    },
                    {
                        seq: 2,
                        collection: 'tasks',
                        rev: 2,
                        id: '2',
                        op: 'add',
                        by: 'writer',
                        threadId: 'thread-1',
                        at: EPOCH_ISO,
                        itemRev: 1
                    }
                ],
                reason: 'mutate'
            }
        ]);
    });

    it('numbers the feed store-wide while each entry keeps its own collection revision', async () => {
        const engine = createRecordEngine();
        const { notifications } = subscribe(engine);

        // THE distinction a live panel cannot afford to blur: `seq` is the cursor across the
        // whole store (one monotonic watermark), `rev` is the per-collection revision a CAS
        // guard compares against. Two different collections, each at revision 1.
        await run(engine, 'tasks', { tasks: [{ text: 'Cross' }] }, 'writer');
        await run(engine, 'chapters', { action: 'add', title: 'Alpha', summary: 'cold open' }, 'writer');

        expect(notifications[1]).toEqual({
            storeRev: 2,
            collectionsRev: 0,
            affectedCollections: ['chapters'],
            changes: [
                {
                    seq: 2,
                    collection: 'chapters',
                    rev: 1,
                    id: '2',
                    op: 'add',
                    by: 'writer',
                    at: EPOCH_ISO,
                    itemRev: 1
                }
            ],
            reason: 'mutate'
        });
    });

    it('says nothing for a read, and leaves the watermark alone', async () => {
        const engine = createRecordEngine();
        const { notifications } = subscribe(engine);

        await run(engine, 'tasks', { tasks: [{ text: 'Only write' }] }, 'writer');
        const listed = await run(engine, 'tasks', {}, 'writer');

        expect(notifications).toHaveLength(1);
        expect(engine.view().storeRev).toBe(1);
        // The read itself is unchanged by the plane: a list page is a list page.
        expect((listed as { storeRev: number }).storeRev).toBe(1);
    });

    it('says nothing for a rejected call — a write that never committed has nothing to announce', async () => {
        const engine = createRecordEngine();
        const { notifications } = subscribe(engine);

        await run(engine, 'tasks', { tasks: [{ text: 'A' }] }, 'writer');

        // A guarded write against a revision that is not current: `stale-record`, and no
        // notification, because `runCall` never reaches its notify step.
        await expect(run(engine, 'tasks', { tasks: [{ id: '999', completed: true }], expects: [{ id: '999', rev: 1 }] }, 'editor')).rejects.toThrow();

        expect(notifications).toHaveLength(1);
        expect(engine.view().storeRev).toBe(1);
        // Collections are listed in declaration order, so index 1 is `chapters` — untouched by
        // the rejected call, which is the point: a refusal moved nothing anywhere.
        expect(engine.view().collections[1].count).toBe(0);
    });

    it('lists the fields an update actually changed, in the collection\'s canonical order', async () => {
        const engine = createRecordEngine();
        const { notifications } = subscribe(engine);

        await run(engine, 'tasks', { tasks: [{ text: 'A' }, { text: 'B' }] }, 'writer');

        // One call patching two entries: ONE notification, two entries, each naming the
        // field it moved. That `fields` list is what lets a panel repaint one cell.
        await run(engine, 'tasks', {
            tasks: [{ id: '1', completed: true }, { id: '2', completed: true }],
            expects: [
                { id: '1', rev: 1 },
                { id: '2', rev: 1 }
            ]
        }, 'editor');

        expect(notifications[1]).toEqual({
            storeRev: 4,
            collectionsRev: 0,
            affectedCollections: ['tasks'],
            changes: [
                {
                    seq: 3,
                    collection: 'tasks',
                    rev: 3,
                    id: '1',
                    op: 'update',
                    by: 'editor',
                    at: EPOCH_ISO,
                    fields: ['completed'],
                    itemRev: 2
                },
                {
                    seq: 4,
                    collection: 'tasks',
                    rev: 4,
                    id: '2',
                    op: 'update',
                    by: 'editor',
                    at: EPOCH_ISO,
                    fields: ['completed'],
                    itemRev: 2
                }
            ],
            reason: 'mutate'
        });
    });

    it('names a removal and stops: no field list, no item revision for a row that is gone', async () => {
        const engine = createRecordEngine();
        const { notifications } = subscribe(engine);

        await run(engine, 'tasks', { tasks: [{ text: 'A' }, { text: 'B' }] }, 'writer');
        await run(engine, 'tasks', {
            remove: ['1', '2'],
            expects: [
                { id: '1', rev: 1 },
                { id: '2', rev: 1 }
            ]
        }, 'editor');

        expect(notifications[1]).toEqual({
            storeRev: 4,
            collectionsRev: 0,
            affectedCollections: ['tasks'],
            changes: [
                { seq: 3, collection: 'tasks', rev: 3, id: '1', op: 'remove', by: 'editor', at: EPOCH_ISO },
                { seq: 4, collection: 'tasks', rev: 4, id: '2', op: 'remove', by: 'editor', at: EPOCH_ISO }
            ],
            reason: 'mutate'
        });
    });

    it('survives a listener that throws, because the write already committed', async () => {
        const engine = createRecordEngine();

        engine.onStoreChange(() => {
            throw new Error('dead transport');
        });

        const added = await run(engine, 'tasks', { tasks: [{ text: 'Commit anyway' }] }, 'writer');

        // The tool result is the caller's truth; a broken observer is not its problem. The
        // envelope below is the ordinary `tasks` add result (list page + counts + storeRev)
        // pinned in ../harness.task.test.ts — the observer changes none of it.
        expect(added).toEqual({
            tasks: [
                {
                    id: '1',
                    text: 'Commit anyway',
                    completed: false,
                    rev: 1,
                    updatedBy: 'writer',
                    updatedAt: EPOCH_ISO
                }
            ],
            counts: { total: 1, completed: 0, pending: 1 },
            entry: {
                id: '1',
                text: 'Commit anyway',
                completed: false,
                rev: 1,
                updatedBy: 'writer',
                updatedAt: EPOCH_ISO
            },
            page: { offset: 0, limit: 20, hasMore: false },
            storeRev: 1
        });
        expect(engine.view().storeRev).toBe(1);
    });

    it('stops announcing once the unsubscribe closure has run', async () => {
        const engine = createRecordEngine();
        const { notifications, stop } = subscribe(engine);

        await run(engine, 'tasks', { tasks: [{ text: 'First' }] }, 'writer');

        stop();

        await run(engine, 'tasks', { tasks: [{ text: 'Second' }] }, 'writer');

        expect(notifications).toHaveLength(1);
        // The feed itself keeps moving: the subscription is a fan-out, not the source.
        expect(engine.view().storeRev).toBe(2);
    });
});

describe('the collection set moves on its own counter, never on the feed', () => {
    // Why this matters: adding a collection mints no record event, so a client that compared
    // `storeRev` alone would see an advance with nothing to apply — or, worse, no advance and a
    // collection it does not know about. `collectionsRev` is the re-bootstrap cue.
    const notesDefinition = {
        name: 'notes',
        fields: [{ key: 'body', type: 'text', required: true }]
    };

    it('announces a define with no feed entries and an unchanged store watermark', async () => {
        const engine = createRecordEngine();
        const { notifications } = subscribe(engine);

        await run(engine, 'tasks', { tasks: [{ text: 'Two writes' }] }, 'writer');
        await run(engine, 'tasks', { tasks: [{ text: 'before the define' }] }, 'writer');
        await run(engine, 'records', { define: notesDefinition }, 'author');

        expect(notifications[2]).toEqual({
            storeRev: 2,
            collectionsRev: 1,
            affectedCollections: ['notes'],
            changes: [],
            reason: 'define'
        });

        // The new collection is immediately part of the bootstrap read, with its declared spec.
        const view = engine.view();

        expect(view.collections.map((collection) => collection.name)).toEqual([
            'tasks',
            'chapters',
            'profiles',
            'locations',
            'notes'
        ]);
        expect(view.collections[4]).toEqual({
            name: 'notes',
            fields: [{ key: 'body', type: 'text', required: true }],
            storeRev: 0,
            count: 0,
            entries: []
        });
    });

    it('announces a drop the same way, and a write to a defined collection ticks only the feed', async () => {
        const engine = createRecordEngine();
        const { notifications } = subscribe(engine);

        await run(engine, 'records', { define: notesDefinition }, 'author');
        await run(engine, 'records', { collection: 'notes', entries: [{ body: 'Ship it' }] }, 'author');
        // A drop refuses a non-empty collection (it would delete history), so the record goes
        // first — and that removal is itself a feed event, which is what the middle
        // notification pins.
        await run(engine, 'records', { collection: 'notes', remove: ['1'], expects: [{ id: '1', rev: 1 }] }, 'author');
        await run(engine, 'records', { collection: 'notes', drop: true }, 'author');

        expect(notifications[1]).toEqual({
            storeRev: 1,
            collectionsRev: 1,
            affectedCollections: ['notes'],
            changes: [{ seq: 1, collection: 'notes', rev: 1, id: '1', op: 'add', by: 'author', at: EPOCH_ISO, itemRev: 1 }],
            reason: 'mutate'
        });
        expect(notifications[2]).toEqual({
            storeRev: 2,
            collectionsRev: 1,
            affectedCollections: ['notes'],
            changes: [{ seq: 2, collection: 'notes', rev: 2, id: '1', op: 'remove', by: 'author', at: EPOCH_ISO }],
            reason: 'mutate'
        });
        expect(notifications[3]).toEqual({
            storeRev: 2,
            collectionsRev: 2,
            affectedCollections: ['notes'],
            changes: [],
            reason: 'drop'
        });

        // Four notifications for four calls, and the store-wide head moved exactly twice: only
        // the two record events tick the feed.
        expect(notifications).toHaveLength(4);
        expect(engine.view().storeRev).toBe(2);
        expect(engine.view().collectionsRev).toBe(2);
        expect(engine.view().collections.map((collection) => collection.name)).toEqual([
            'tasks',
            'chapters',
            'profiles',
            'locations'
        ]);
    });
});

describe('the reset rule — an honest reader says when a cursor is no longer answerable', () => {
    it('rewinds the store on reset: watermark 0, empty feed, and a `since` above the head is a reset', async () => {
        const engine = createRecordEngine();
        const { notifications } = subscribe(engine);

        await run(engine, 'tasks', { tasks: [{ text: 'A' }, { text: 'B' }] }, 'writer');
        engine.reset();

        expect(notifications[1]).toEqual({
            storeRev: 0,
            collectionsRev: 1,
            affectedCollections: [],
            changes: [],
            reason: 'reset'
        });

        const view: RecordStoreView = engine.view();

        expect(view.storeRev).toBe(0);
        expect(view.collections).toHaveLength(4);
        expect(view.changes).toEqual([]);

        // `since: 0` is CURRENT after a reset (the store genuinely is at 0), so it is not a
        // reset; `since: 5` is a watermark this store never had, so it is.
        expect(engine.changesSince(0)).toEqual({
            storeRev: 0,
            collectionsRev: 1,
            changes: [],
            reset: false
        } satisfies RecordStoreDelta);
        expect(engine.changesSince(5)).toEqual({
            storeRev: 0,
            collectionsRev: 1,
            changes: [],
            reset: true
        } satisfies RecordStoreDelta);
    });

    it('reseeds the watermark on restore and clears the feed, so every other cursor re-bootstraps', async () => {
        const engine = createRecordEngine();
        const { notifications } = subscribe(engine);

        await run(engine, 'tasks', { tasks: [{ text: 'R1' }] }, 'writer');
        await run(engine, 'chapters', { action: 'add', title: 'R', summary: 's' }, 'writer');

        // A JSON round-trip is what a host actually stores, so the restore input is the real one.
        const saved = JSON.parse(JSON.stringify(engine.snapshot()));

        engine.reset();
        engine.restore(saved);

        // Both collections reached revision 1, so the store-wide head resumes at 1: a persisted
        // watermark may never read as BEHIND its own log.
        expect(notifications.at(-1)).toEqual({
            storeRev: 1,
            collectionsRev: 2,
            affectedCollections: [],
            changes: [],
            reason: 'restore'
        });
        expect(engine.view()).toMatchObject({ storeRev: 1, collectionsRev: 2, changes: [] });
        expect(engine.changesSince(1)).toEqual({
            storeRev: 1,
            collectionsRev: 2,
            changes: [],
            reset: false
        });
        expect(engine.changesSince(0)).toEqual({
            storeRev: 1,
            collectionsRev: 2,
            changes: [],
            reset: true
        });
    });

    it('answers a cursor that is exactly current with an empty window and NO reset', async () => {
        const engine = createRecordEngine();

        await run(engine, 'tasks', { tasks: [{ text: 'A' }] }, 'writer');

        expect(engine.changesSince(1)).toEqual({
            storeRev: 1,
            collectionsRev: 0,
            changes: [],
            reset: false
        });
    });

    it('keeps the newest 200 entries across collections and reports a trimmed cursor as a reset', async () => {
        const engine = createRecordEngine();

        // TWO collections so no per-collection window is the binding constraint: only the
        // store-wide feed can produce this shape.
        for (let index = 0; index < 120; index += 1) {
            await run(engine, 'tasks', { tasks: [{ text: `T${index}` }] }, 'writer');
        }
        for (let index = 0; index < 90; index += 1) {
            await run(engine, 'chapters', { action: 'add', title: `C${index}`, summary: 's' }, 'writer');
        }

        const view = engine.view();

        expect(view.storeRev).toBe(210);
        expect(view.changes).toHaveLength(200);
        expect(view.changes[0].seq).toBe(11);
        expect(view.changes[199].seq).toBe(210);

        // The retained window starts at 11, so `since: 0` cannot be resumed — even though 200
        // entries come back. The flag is the point; the tail is a courtesy.
        expect(engine.changesSince(0).reset).toBe(true);
        expect(engine.changesSince(0).changes).toHaveLength(200);

        // A cursor inside the window resumes exactly: the 90 chapters adds, gap-free, and the
        // collection's OWN revision restarts at 1 while the store position keeps climbing.
        const resumed = engine.changesSince(120);

        expect(resumed.reset).toBe(false);
        expect(resumed.storeRev).toBe(210);
        expect(resumed.collectionsRev).toBe(0);
        expect(resumed.changes).toHaveLength(90);
        expect(resumed.changes[0]).toEqual({
            seq: 121,
            collection: 'chapters',
            rev: 1,
            id: '121',
            op: 'add',
            by: 'writer',
            at: EPOCH_ISO,
            itemRev: 1
        });
        expect(resumed.changes[89]).toEqual({
            seq: 210,
            collection: 'chapters',
            rev: 90,
            id: '210',
            op: 'add',
            by: 'writer',
            at: EPOCH_ISO,
            itemRev: 1
        });
        expect(resumed.changes.map((change) => change.seq)).toEqual(
            Array.from({ length: 90 }, (_, index) => 121 + index)
        );
    });
});

describe('the bootstrap projection — what a panel paints, not what the model reads', () => {
    it('lists every registered collection with its declared spec and its rows', async () => {
        const engine = createRecordEngine();

        await run(engine, 'tasks', { tasks: [{ text: 'One' }] }, 'writer', 'thread-1');
        await run(engine, 'chapters', { action: 'add', title: 'Alpha', summary: 'cold open', content: 'a whole body' }, 'writer');

        const view = engine.view();

        expect(view.storeRev).toBe(2);
        expect(view.collectionsRev).toBe(0);
        // Built-ins in declaration order, always present — an empty collection is still a row a
        // panel draws, because its field spec is the column list.
        expect(view.collections.map((collection) => collection.name)).toEqual(['tasks', 'chapters', 'profiles', 'locations']);

        expect(view.collections[0]).toEqual({
            name: 'tasks',
            fields: [
                { key: 'text', type: 'text', required: true, maxLength: 4000 },
                { key: 'completed', type: 'boolean', default: false, count: { key: 'completed', complement: 'pending' } }
            ],
            storeRev: 1,
            count: 1,
            entries: [
                {
                    id: '1',
                    text: 'One',
                    completed: false,
                    rev: 1,
                    updatedBy: 'writer',
                    updatedThreadId: 'thread-1',
                    updatedAt: EPOCH_ISO
                }
            ]
        });

        // THE getOnly RULE: a chapter body is a single-`get` field, so the projection leaves the
        // key OUT entirely. "No body" and "this read does not show bodies" are different facts,
        // and emptying the key would collapse them into the wrong one.
        expect(view.collections[1].entries[0]).toEqual({
            id: '2',
            title: 'Alpha',
            summary: 'cold open',
            status: 'planned',
            rev: 1,
            updatedBy: 'writer',
            updatedAt: EPOCH_ISO
        });
        expect('content' in (view.collections[1].entries[0] as object)).toBe(false);
    });

    it('hands out detached copies, so a renderer cannot write through the read', async () => {
        const engine = createRecordEngine();

        await run(engine, 'tasks', { tasks: [{ text: 'Original' }] }, 'writer');

        const first = engine.view();

        (first.collections[0].entries[0] as { text: string }).text = 'scribbled';
        first.changes[0].id = 'scribble';

        const second = engine.view();

        expect(second.collections[0].entries[0]).toEqual({
            id: '1',
            text: 'Original',
            completed: false,
            rev: 1,
            updatedBy: 'writer',
            updatedAt: EPOCH_ISO
        });
        expect(second.changes[0].id).toBe('1');

        // The delta is detached too — same rule, separate call.
        const delta = engine.changesSince(0);

        delta.changes[0].op = 'remove';

        expect(engine.changesSince(0).changes[0].op).toBe('add');
    });

    it('writes nothing: the plane observes, and the persisted snapshot gains no key', async () => {
        const engine = createRecordEngine();

        await run(engine, 'tasks', { tasks: [{ text: 'A' }] }, 'writer');
        engine.view();
        engine.changesSince(0);

        // The feed is RUNTIME state. `readRecordsStoreState` validates the persisted root with an
        // EXACT key set, so a new key here would break every existing restore.
        expect(Object.keys(engine.snapshot()).sort()).toEqual(['collections', 'nextId']);
    });

    it('leaves a write result byte-identical whether or not anyone is listening', async () => {
        // THE regression this whole plane must not become: an observer that changes what the
        // tool returns. Two engines, same call, one with a subscriber.
        const quiet = createRecordEngine();
        const watched = createRecordEngine();

        subscribe(watched);

        const quietResult = await run(quiet, 'tasks', { tasks: [{ text: 'Same' }] }, 'writer', 'thread-1');
        const watchedResult = await run(watched, 'tasks', { tasks: [{ text: 'Same' }] }, 'writer', 'thread-1');

        expect(watchedResult).toEqual(quietResult);
        expect(JSON.stringify(watched.snapshot())).toBe(JSON.stringify(quiet.snapshot()));
    });
});

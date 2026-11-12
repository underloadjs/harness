/**
 * Records client tests (T4 data plane, records-client.ts).
 *
 * Pins the read algorithm the two live scratch-board panels depend on, without a DOM:
 * bootstrap + watermarks, wake decisions, `seq`-ordered delta application with replay
 * skips, the pending placeholder + ONE coalesced body re-read (newest row only),
 * tombstones, the `reset` fallback, the feed cap, `historyOf` honesty, link plumbing
 * and disposal. The panel suites exercise the same store through mounted panels; this
 * file owns the invariants in isolation, so a regression names the layer it broke in.
 *
 * Run: npx vitest run --config src/frontend/vitest.config.ts
 */

import { describe, expect, it } from 'vitest';
import type {
    RecordChangeRow,
    RecordsDeltaResponse,
    RecordsSnapshotResponse
} from '../../shared/harness-api';
import {
    RECORDS_ERROR_CLIP,
    clipRecordError,
    createRecordsClient,
    recordsActorOf,
    recordsDisplayFieldOf,
    recordsDisplayValueOf,
    recordsEntryOf,
    recordsLabelOf,
    type RecordsClientOptions,
    type RecordsNotice,
    type RecordsReader
} from './records-client';

// -----------------------------------------------------------------------------
// Fixtures: a fixed clock, and reader doubles that record every call
// -----------------------------------------------------------------------------

// Fixed ISO stamps so a row's `at` is compared, never re-derived from wall clock.
const AT_1 = '2026-11-10T09:00:00.000Z';
const AT_2 = '2026-11-10T09:00:05.000Z';
const AT_3 = '2026-11-10T09:00:06.000Z';
const NOW = 1_794_300_000_000;

const TASKS_FIELDS = [
    { key: 'text', type: 'text' as const, required: true },
    { key: 'completed', type: 'boolean' as const, required: true }
];

// The one snapshot every scenario starts from unless it overrides a piece: `tasks`
// holds one finished record, so both projections (entries and feed) have content.
const SNAPSHOT: RecordsSnapshotResponse = {
    session_id: 'sess_a',
    revision: 7,
    store_rev: 1,
    collections_rev: 4,
    collections: [
        {
            name: 'tasks',
            store_rev: 1,
            count: 1,
            fields: TASKS_FIELDS,
            entries: [{ id: 'rec_a', rev: 1, text: 'Second', completed: true }]
        }
    ],
    changes: [
        { seq: 1, collection: 'tasks', rev: 1, id: 'rec_a', op: 'add', fields: ['text', 'completed'], item_rev: 0, at: AT_1 }
    ]
};

// A delta that carries nothing new. `collections_rev` matches SNAPSHOT so an applied
// batch never accidentally triggers a collection-set re-read.
const DELTA_BASE: RecordsDeltaResponse = {
    session_id: 'sess_a',
    revision: 8,
    store_rev: 3,
    collections_rev: 4,
    changes: [],
    reset: false
};

const rows = (...items: RecordChangeRow[]): RecordsDeltaResponse => ({
    ...DELTA_BASE,
    store_rev: items.length === 0 ? 0 : (items[items.length - 1]?.seq as number),
    changes: items
});

type HarnessOptions = {
    snapshot?: RecordsSnapshotResponse | (() => Promise<RecordsSnapshotResponse>);
    delta?: RecordsDeltaResponse | ((since: number) => Promise<RecordsDeltaResponse>);
    bodyRefreshMs?: number;
    feedLimit?: number;
};

/**
 * Builds a client over scripted reads. `settle()` drains the microtask chain the
 * readers start (every fake resolves immediately), so an awaited `pull` plus one
 * `settle()` observes a follow-up read — no sleeping, no fake timers to keep in sync
 * with the client's own debounce. The debounce itself is CAPTURED (`timers`) so a test
 * decides when bodies are re-read and can assert how many reads a burst costs.
 */
const harness = (options: HarnessOptions = {}) => {
    const notices: RecordsNotice[] = [];
    const calls = { snapshots: [] as string[], deltas: [] as { sessionId: string; since: number }[] };
    const timers: (() => void)[] = [];

    const reader: RecordsReader = {
        snapshot: async (sessionId) => {
            calls.snapshots.push(sessionId);
            const scripted = options.snapshot ?? SNAPSHOT;

            return typeof scripted === 'function' ? await scripted() : scripted;
        },
        delta: async (sessionId, since) => {
            calls.deltas.push({ sessionId, since });
            const scripted = options.delta ?? DELTA_BASE;

            return typeof scripted === 'function' ? await scripted(since) : scripted;
        }
    };

    const clientOptions: RecordsClientOptions = {
        sessionId: 'sess_a',
        reader,
        bodyRefreshMs: options.bodyRefreshMs ?? 150,
        ...(options.feedLimit === undefined ? {} : { feedLimit: options.feedLimit }),
        now: () => NOW,
        schedule: (run) => {
            timers.push(run);

            return () => {
                const index = timers.indexOf(run);
                if (index >= 0) timers.splice(index, 1);
            };
        },
        onNotice: (notice) => {
            notices.push(notice);
        }
    };

    return {
        client: createRecordsClient(clientOptions),
        notices,
        calls,
        timers,
        settle: async () => {
            for (let pass = 0; pass < 8; pass += 1) await Promise.resolve();
        }
    };
};

describe('records client — bootstrap', () => {
    it('is loading until the first snapshot lands, then ready with the store\'s watermarks', async () => {
        const h = harness();
        const { client } = h;

        expect(client.phase()).toBe('loading');
        expect(client.linkState()).toBe('unknown');
        expect(client.lastSyncAt()).toBe(0);
        expect(client.feed()).toEqual([]);
        expect(client.tasks()).toEqual([]);
        expect(client.fetching()).toBe(false);

        // The read is issued synchronously, so the corner box goes to `reading` in the
        // same turn the request is — a slow answer is a stated wait, not a badge sitting
        // on the last verdict (./records-client.ts `fetching`).
        const booting = client.boot();

        expect(client.fetching()).toBe(true);
        await booting;

        expect(client.phase()).toBe('ready');
        expect(client.error()).toBeUndefined();
        expect(client.stale()).toBe(false);
        expect(client.lastSyncAt()).toBe(NOW);
        expect(client.watermarks()).toEqual({ storeRev: 1, collectionsRev: 4, revision: 7 });
        expect(h.calls.snapshots).toEqual(['sess_a']);
        expect(h.calls.deltas).toEqual([]);

        // The retained window IS the feed: one row, resolved against the state AFTER
        // the event (a snapshot never knows the value before it), so only `after`.
        expect(client.feed()).toEqual([
            {
                seq: 1,
                collection: 'tasks',
                id: 'rec_a',
                op: 'add',
                rev: 1,
                itemRev: 0,
                at: AT_1,
                label: 'Second',
                known: true,
                changes: [
                    { field: 'text', after: 'Second' },
                    { field: 'completed', after: 'true' }
                ],
                source: 'snapshot'
            }
        ]);

        expect(client.tasks()).toEqual([{ id: 'rec_a', text: 'Second', completed: true, rev: 1, pending: false }]);
        expect(client.collection('tasks')).toEqual({
            name: 'tasks',
            storeRev: 1,
            count: 1,
            fields: TASKS_FIELDS,
            entries: [{ id: 'rec_a', values: { text: 'Second', completed: true }, rev: 1, pending: false }]
        });
        expect(client.feedTruncated()).toBe(false);

        // One wholesale replacement, and the bootstrapped rows handed to the painter —
        // wrapped in the two `fetch` notices that moved the corner box to `reading` and
        // back. They are chrome only: no rows, no collection, no verdict of their own
        // (their `phase`/`stale` are just the state at that instant), which is why the
        // panel repaints and says nothing on one.
        expect(h.notices.map((notice) => notice.reason)).toEqual(['fetch', 'boot', 'fetch']);
        expect(h.notices[0]).toEqual({
            reason: 'fetch',
            phase: 'loading',
            stale: false,
            link: 'unknown',
            rows: [],
            touched: [],
            replaced: false
        });
        expect(h.notices[1]).toEqual({
            reason: 'boot',
            phase: 'ready',
            stale: false,
            link: 'unknown',
            rows: expect.any(Array),
            touched: ['tasks'],
            replaced: true
        });
        expect(h.notices[2]).toEqual({
            reason: 'fetch',
            phase: 'ready',
            stale: false,
            link: 'unknown',
            rows: [],
            touched: [],
            replaced: false
        });
        expect(h.notices[1]?.rows).toHaveLength(1);
        // The answer landed, so nothing is outstanding and the box has its word back.
        expect(client.fetching()).toBe(false);
    });

    it('calls a snapshot with no collections and no events "empty", not "error"', async () => {
        const h = harness({
            snapshot: { session_id: 'sess_a', revision: 0, store_rev: 0, collections_rev: 0, collections: [], changes: [] }
        });
        await h.client.boot();

        expect(h.client.phase()).toBe('ready');
        expect(h.client.collections()).toEqual([]);
        expect(h.client.feed()).toEqual([]);
        expect(h.client.tasks()).toEqual([]);
        expect(h.client.feedTruncated()).toBe(false);
    });

    it('fails a first read into "error", then recovers on the next snapshot', async () => {
        let attempt = 0;
        const h = harness({
            snapshot: async () => {
                attempt += 1;
                if (attempt === 1) {
                    throw new Error('unexpected request: GET /v1/harness/sessions/3f2a9c1b-7788-4a11-9d22-112233445566/records');
                }

                return SNAPSHOT;
            }
        });

        await h.client.boot();

        const clipped = 'unexpected request: GET /v1/harness/sessions/3f2a9c1b/records';

        expect(h.client.phase()).toBe('error');
        expect(h.client.stale()).toBe(true);
        expect(h.client.error()).toBe(clipped);
        expect(h.client.feed()).toEqual([]);
        // A failed read ENDS the fetch: the box takes `reading` back out and the panel's
        // `error` state is what the reader is shown instead, so a dead store never leaves
        // a card saying `reading` forever.
        expect(h.notices.map((notice) => notice.reason)).toEqual(['fetch', 'boot', 'fetch']);
        expect(h.notices[1]).toEqual({
            reason: 'boot',
            phase: 'error',
            stale: true,
            link: 'unknown',
            rows: [],
            touched: [],
            replaced: false,
            error: clipped
        });
        expect(h.notices[2]).toEqual({
            reason: 'fetch',
            phase: 'error',
            stale: true,
            link: 'unknown',
            rows: [],
            touched: [],
            replaced: false
        });
        expect(h.client.fetching()).toBe(false);

        await h.client.refresh('boot');

        expect(h.client.phase()).toBe('ready');
        expect(h.client.error()).toBeUndefined();
        expect(h.client.stale()).toBe(false);
        expect(h.calls.snapshots).toEqual(['sess_a', 'sess_a']);
    });

    it('shortens id-shaped runs and caps the clip, so no uuid is ever rendered', () => {
        expect(clipRecordError('GET /v1/harness/sessions/3f2a9c1b-7788-4a11-9d22-112233445566/records failed')).toBe(
            'GET /v1/harness/sessions/3f2a9c1b/records failed'
        );
        expect(clipRecordError('no uuids 3f2a9c1b-7788-4a11-9d22-112233445566 here at all')).toBe('no uuids 3f2a9c1b here at all');
        expect(clipRecordError('plain sentence stays whole')).toBe('plain sentence stays whole');

        const long = clipRecordError(`${'x'.repeat(200)} boom`);
        expect(long).toBe(`${'x'.repeat(RECORDS_ERROR_CLIP)}…`);
        expect(clipRecordError('a'.repeat(RECORDS_ERROR_CLIP))).toBe('a'.repeat(RECORDS_ERROR_CLIP));
    });
});

describe('records client — wake decisions', () => {
    it('reads the delta only for a watermark above the one a read already stated', async () => {
        const h = harness({ delta: () => Promise.resolve(rows()) });
        await h.client.boot();

        // At the position (1) and below: covered, no read.
        h.client.frame({ store_rev: 1, collections_rev: 4 });
        h.client.frame({ store_rev: 0, collections_rev: 4 });
        await h.settle();
        expect(h.calls.deltas).toEqual([]);

        // A payload naming neither watermark carries nothing to act on.
        h.client.frame({});
        await h.settle();
        expect(h.calls.deltas).toEqual([]);
        expect(h.calls.snapshots).toEqual(['sess_a']);

        // Above the position: one delta read from the store position the last read gave.
        h.client.frame({ store_rev: 5, collections_rev: 4 });
        await h.settle();
        expect(h.calls.deltas).toEqual([{ sessionId: 'sess_a', since: 1 }]);
    });

    it('re-reads the snapshot for a collections_rev move, because a define/drop appends no rows', async () => {
        const h = harness();
        await h.client.boot();

        h.client.frame({ store_rev: 1, collections_rev: 5 });
        await h.settle();

        expect(h.calls.deltas).toEqual([]);
        expect(h.calls.snapshots).toEqual(['sess_a', 'sess_a']);
    });

    it('bootstraps on the first wake when the socket was down at mount', async () => {
        const h = harness();

        h.client.frame({ store_rev: 9, collections_rev: 4 });
        await h.settle();

        expect(h.calls.snapshots).toEqual(['sess_a']);
        expect(h.calls.deltas).toEqual([]);
        expect(h.client.phase()).toBe('ready');
    });

    it('coalesces a burst into the in-flight read plus exactly one follow-up', async () => {
        let release: (() => void) | undefined;
        const h = harness({
            delta: () =>
                new Promise<RecordsDeltaResponse>((resolve) => {
                    release = () => resolve({ ...DELTA_BASE, changes: [] });
                })
        });
        await h.client.boot();

        // The first frame starts the read; two more arrive while it is in flight.
        h.client.frame({ store_rev: 5, collections_rev: 4 });
        await Promise.resolve();
        const first = release;
        h.client.frame({ store_rev: 5, collections_rev: 4 });
        h.client.frame({ store_rev: 5, collections_rev: 4 });
        first?.();
        await h.settle();

        // The follow-up reads from the position the FIRST response stated, so a burst
        // costs two reads at most and never re-reads ground already applied.
        expect(h.calls.deltas).toEqual([
            { sessionId: 'sess_a', since: 1 },
            { sessionId: 'sess_a', since: 3 }
        ]);
    });
});

describe('records client — delta application', () => {
    it('applies rows in seq order, fills `before` for live rows, and drops replays', async () => {
        const h = harness({
            delta: () =>
                Promise.resolve(
                    rows(
                        // Out of order on the wire: the client must still apply 2 then 3.
                        { seq: 3, collection: 'tasks', rev: 3, id: 'rec_a', op: 'update', fields: ['text'], item_rev: 2, at: AT_3, by: 'agent', thread_id: 'ses_1' },
                        { seq: 2, collection: 'tasks', rev: 2, id: 'rec_a', op: 'update', fields: ['text'], item_rev: 1, at: AT_2 },
                        // A replay of the bootstrapped row: at/below the applied cursor.
                        { seq: 1, collection: 'tasks', rev: 1, id: 'rec_a', op: 'add', fields: ['text'], at: AT_1 }
                    )
                )
        });
        await h.client.boot();
        await h.client.pull('delta');

        expect(h.client.watermarks()).toEqual({ storeRev: 3, collectionsRev: 4, revision: 8 });
        expect(h.client.feed().map((row) => [row.seq, row.op, row.source])).toEqual([
            [1, 'add', 'snapshot'],
            [2, 'update', 'live'],
            [3, 'update', 'live']
        ]);

        // A live row knows the value the record held BEFORE (it was on screen) and not
        // the one after (the row carries no bodies) — the opposite half of a snapshot row.
        expect(h.client.feed()[1]?.changes).toEqual([{ field: 'text', before: 'Second' }]);
        expect(h.client.feed()[2]?.changes).toEqual([{ field: 'text', before: 'Second' }]);
        expect(h.client.feed()[2]).toMatchObject({ by: 'agent', threadId: 'ses_1', itemRev: 2, rev: 3 });

        // The staged entry carries the newest attribution, and the body read has NOT
        // happened yet: the debounce is armed exactly once for the whole batch.
        expect(h.client.tasks()).toEqual([
            { id: 'rec_a', text: 'Second', completed: true, rev: 2, by: 'agent', threadId: 'ses_1', at: AT_3, pending: false }
        ]);
        expect(h.timers).toHaveLength(1);
        expect(h.calls.snapshots).toEqual(['sess_a']);

        // Firing it resolves the newest row only (see the next test for the rule).
        h.timers.forEach((run) => run());
        await h.settle();

        expect(h.client.feed()[2]?.changes).toEqual([{ field: 'text', before: 'Second', after: 'Second' }]);
        expect(h.calls.snapshots).toEqual(['sess_a', 'sess_a']);
    });

    it('stages an unknown add as pending, then resolves it with one body re-read', async () => {
        let reads = 0;
        const h = harness({
            snapshot: async () => {
                reads += 1;
                if (reads === 1) {
                    return {
                        ...SNAPSHOT,
                        collections: [{ ...SNAPSHOT.collections[0]!, entries: [{ id: 'rec_a', rev: 1, text: 'Second', completed: true }] }],
                        changes: [{ seq: 1, collection: 'tasks', rev: 1, id: 'rec_a', op: 'add' as const, fields: ['text'], item_rev: 0, at: AT_1 }]
                    };
                }

                // The body read for the burst: the new record, with its text.
                return {
                    ...SNAPSHOT,
                    store_rev: 2,
                    collections: [{ ...SNAPSHOT.collections[0]!, count: 2, entries: [{ id: 'rec_a', rev: 1, text: 'Second', completed: true }, { id: 'rec_x', rev: 1, text: 'Write the tests', completed: false }] }],
                    changes: []
                };
            },
            delta: () => Promise.resolve(rows({ seq: 2, collection: 'tasks', rev: 2, id: 'rec_x', op: 'add', fields: ['text', 'completed'], item_rev: 0, at: AT_2 }))
        });
        await h.client.boot();
        await h.client.pull('delta');

        // Identity first: the record that just appeared is on screen with its text unknown.
        expect(h.client.tasks()).toEqual([
            { id: 'rec_a', text: 'Second', completed: true, rev: 1, pending: false },
            { id: 'rec_x', text: '', completed: false, rev: 0, at: AT_2, pending: true }
        ]);
        expect(h.client.feed()[1]).toEqual({
            seq: 2,
            collection: 'tasks',
            id: 'rec_x',
            op: 'add',
            rev: 2,
            itemRev: 0,
            at: AT_2,
            label: '',
            known: false,
            changes: [{ field: 'text' }, { field: 'completed' }],
            source: 'live'
        });
        expect(h.calls.snapshots).toEqual(['sess_a']);

        h.timers.forEach((run) => run());
        await h.settle();

        expect(h.client.tasks()).toEqual([
            { id: 'rec_a', text: 'Second', completed: true, rev: 1, pending: false },
            { id: 'rec_x', text: 'Write the tests', completed: false, rev: 1, pending: false }
        ]);
        expect(h.client.feed()[1]).toEqual({
            seq: 2,
            collection: 'tasks',
            id: 'rec_x',
            op: 'add',
            rev: 2,
            itemRev: 0,
            at: AT_2,
            label: 'Write the tests',
            known: true,
            changes: [{ field: 'text', after: 'Write the tests' }, { field: 'completed', after: 'false' }],
            source: 'live'
        });
        expect(h.calls.snapshots).toEqual(['sess_a', 'sess_a']);
    });

    it('backfills only the newest row of a record, so an intermediate value is never invented', async () => {
        let reads = 0;
        const h = harness({
            delta: () =>
                Promise.resolve(
                    rows(
                        { seq: 2, collection: 'tasks', rev: 2, id: 'rec_a', op: 'update', fields: ['text'], item_rev: 1, at: AT_2 },
                        { seq: 3, collection: 'tasks', rev: 3, id: 'rec_a', op: 'update', fields: ['text'], item_rev: 2, at: AT_3 }
                    )
                ),
            snapshot: async () => {
                reads += 1;
                if (reads === 1) return SNAPSHOT;

                return {
                    ...SNAPSHOT,
                    store_rev: 3,
                    revision: 9,
                    collections: [{ name: 'tasks', store_rev: 3, count: 1, fields: TASKS_FIELDS, entries: [{ id: 'rec_a', rev: 2, text: 'Third', completed: true }] }],
                    changes: []
                };
            }
        });
        await h.client.boot();
        await h.client.pull('delta');
        h.timers.forEach((run) => run());
        await h.settle();

        const [seed, first, second] = h.client.feed();

        expect([seed?.seq, first?.seq, second?.seq]).toEqual([1, 2, 3]);
        // Only seq 3 gets the value the re-read found; seq 2's intermediate value is
        // not knowable, and claiming it would be a fabricated history.
        expect(first?.changes).toEqual([{ field: 'text', before: 'Second' }]);
        expect(second?.changes).toEqual([{ field: 'text', before: 'Second', after: 'Third' }]);
        expect(second?.label).toBe('Third');
        expect(h.client.tasks()).toEqual([{ id: 'rec_a', text: 'Third', completed: true, rev: 2, pending: false }]);
        // The merged snapshot carried no rows above the applied cursor: no duplicates.
        expect(h.client.feed()).toHaveLength(3);
    });

    it('keeps the last good rows and reads as stale when a delta fails', async () => {
        let deltaReads = 0;
        const h = harness({
            delta: async () => {
                deltaReads += 1;
                if (deltaReads === 1) throw new Error('delta exploded');

                return rows();
            }
        });
        await h.client.boot();
        await h.client.pull('delta');

        expect(h.client.phase()).toBe('ready');
        expect(h.client.stale()).toBe(true);
        expect(h.client.error()).toBe('delta exploded');
        expect(h.client.feed()).toHaveLength(1);
        // The failure is the last thing the reader is TOLD; the `fetch` after it only
        // takes `reading` out of the corner box. The rows on screen are still the last
        // honest answer, which is what `stale` says.
        const data = h.notices.filter((notice) => notice.reason !== 'fetch');

        expect(data[data.length - 1]).toEqual({
            reason: 'error',
            phase: 'ready',
            stale: true,
            link: 'unknown',
            rows: [],
            touched: [],
            replaced: false,
            error: 'delta exploded'
        });
        expect(h.notices[h.notices.length - 1]?.reason).toBe('fetch');
        expect(h.client.fetching()).toBe(false);

        h.client.linkUp();
        await h.client.pull('delta');
        expect(h.client.stale()).toBe(false);
        expect(h.client.error()).toBeUndefined();
    });

    it('discards and re-bootstraps when the server answers a dead cursor with reset', async () => {
        let reads = 0;
        const h = harness({
            delta: async () => ({ ...DELTA_BASE, changes: [], reset: true }),
            snapshot: async () => {
                reads += 1;
                if (reads === 1) return SNAPSHOT;

                return {
                    session_id: 'sess_a',
                    revision: 12,
                    store_rev: 20,
                    collections_rev: 6,
                    collections: [
                        {
                            name: 'notes',
                            store_rev: 1,
                            count: 1,
                            fields: [{ key: 'title', type: 'text' as const, required: true }],
                            entries: [{ id: 'rec_n', rev: 1, title: 'Fresh' }]
                        }
                    ],
                    changes: [{ seq: 20, collection: 'notes', rev: 1, id: 'rec_n', op: 'add' as const, fields: ['title'], item_rev: 0, at: AT_3 }]
                } satisfies RecordsSnapshotResponse;
            }
        });
        await h.client.boot();
        expect(h.client.feed()).toHaveLength(1);

        await h.client.pull('delta');
        await h.settle();

        expect(reads).toBe(2);
        // The old generation is gone: no carry-over rows, and the new store's numbers.
        expect(h.client.feed().map((row) => [row.seq, row.collection])).toEqual([[20, 'notes']]);
        expect(h.client.watermarks()).toEqual({ storeRev: 20, collectionsRev: 6, revision: 12 });
        expect(h.client.collection('tasks')).toBeUndefined();
        expect(h.client.phase()).toBe('ready');
    });

    it('removes a record, keeps its feed rows, and still names what was removed', async () => {
        const h = harness({
            delta: () => Promise.resolve(rows({ seq: 2, collection: 'tasks', rev: 2, id: 'rec_a', op: 'remove', at: AT_2 }))
        });
        await h.client.boot();
        await h.client.pull('delta');
        await h.settle();

        expect(h.client.tasks()).toEqual([]);
        expect(h.client.collection('tasks')?.count).toBe(0);
        expect(h.client.feed().map((row) => [row.seq, row.op])).toEqual([
            [1, 'add'],
            [2, 'remove']
        ]);
        // The tombstone backs the label: "removed Second" is honest, "removed" alone is not.
        expect(h.client.feed()[1]).toMatchObject({ label: 'Second', known: true, changes: [] });
        // A remove dirties nothing, so no body read was armed.
        expect(h.timers).toHaveLength(0);
    });

    it('caps the accumulated feed and says the surface is a window', async () => {
        const five: RecordChangeRow[] = [1, 2, 3, 4, 5].map((seq) => ({
            seq,
            collection: 'tasks',
            rev: seq,
            id: `rec_${seq}`,
            op: 'add',
            fields: ['text'],
            item_rev: 0,
            at: AT_1
        }));
        const h = harness({ feedLimit: 3, delta: () => Promise.resolve(rows(...five)) });
        await h.client.boot();
        await h.client.pull('delta');
        await h.settle();

        expect(h.client.feed().map((row) => row.seq)).toEqual([3, 4, 5]);
        expect(h.client.feedTruncated()).toBe(true);
    });

    it('reports history honestly: complete for a record it saw whole, truncated when the store window says otherwise', async () => {
        const h = harness();
        await h.client.boot();

        expect(h.client.historyOf('tasks', 'rec_a')).toEqual({
            items: [
                {
                    seq: 1,
                    collection: 'tasks',
                    id: 'rec_a',
                    op: 'add',
                    rev: 1,
                    itemRev: 0,
                    at: AT_1,
                    label: 'Second',
                    known: true,
                    changes: [{ field: 'text', after: 'Second' }, { field: 'completed', after: 'true' }],
                    source: 'snapshot'
                }
            ],
            truncated: false
        });

        // A record whose only retained row starts at seq 5 has older events somewhere.
        const h2 = harness({
            snapshot: {
                ...SNAPSHOT,
                store_rev: 5,
                collections: [{ name: 'tasks', store_rev: 5, count: 1, fields: TASKS_FIELDS, entries: [{ id: 'rec_a', rev: 3, text: 'Third', completed: true }] }],
                changes: [{ seq: 5, collection: 'tasks', rev: 5, id: 'rec_a', op: 'update', fields: ['text'], item_rev: 2, at: AT_2 }]
            }
        });
        await h2.client.boot();

        const history = h2.client.historyOf('tasks', 'rec_a');
        expect(history.items.map((row) => row.seq)).toEqual([5]);
        expect(history.truncated).toBe(true);

        expect(h.client.historyOf('tasks', 'rec_missing')).toEqual({ items: [], truncated: false });
    });
});

describe('records client — the `fetching` flag behind the corner box', () => {
    it('is true only while an answer is outstanding, and stays true across the body-refresh debounce', async () => {
        let release: (() => void) | undefined;
        const h = harness({
            delta: () =>
                new Promise<RecordsDeltaResponse>((resolve) => {
                    release = () =>
                        resolve(rows({ seq: 2, collection: 'tasks', rev: 2, id: 'rec_x', op: 'add', fields: ['text'], item_rev: 0, at: AT_2 }));
                })
        });

        expect(h.client.fetching()).toBe(false);

        const booting = h.client.boot();

        expect(h.client.fetching()).toBe(true);
        await booting;
        expect(h.client.fetching()).toBe(false);

        const pulling = h.client.pull('delta');

        expect(h.client.fetching()).toBe(true);
        release?.();
        await pulling;

        // THE ANTI-FLICKER RULE. The delta named an `add` whose body it could not carry,
        // so it queued ONE debounced re-read — and that queued read is the same fetch
        // still finishing. Dropping the flag here would put `live` on screen for the whole
        // 150ms of the debounce and `reading` again after it, which is the flicker the
        // corner box replaced the skeleton to stop.
        expect(h.timers).toHaveLength(1);
        expect(h.client.fetching()).toBe(true);

        h.timers.forEach((run) => run());
        await h.settle();

        expect(h.client.fetching()).toBe(false);
        // The box moves at the EDGES of a read and nowhere in between: fetch → boot →
        // fetch, then fetch → delta → bodies → fetch. Only the two state notices carry
        // rows, and no notice is published twice for one transition.
        expect(h.notices.map((notice) => notice.reason)).toEqual(['fetch', 'boot', 'fetch', 'fetch', 'delta', 'bodies', 'fetch']);
        expect(
            h.notices
                .filter((notice) => notice.reason === 'fetch')
                .every((notice) => notice.rows.length === 0 && notice.touched.length === 0 && !notice.replaced)
        ).toBe(true);
    });

    it('holds the flag across a coalesced follow-up read, so a burst is ONE fetch', async () => {
        let release: (() => void) | undefined;
        const h = harness({
            delta: () =>
                new Promise<RecordsDeltaResponse>((resolve) => {
                    release = () => resolve({ ...DELTA_BASE, changes: [] });
                })
        });

        await h.client.boot();

        const fetches = (): number => h.notices.filter((notice) => notice.reason === 'fetch').length;
        const before = fetches();

        // Three wakes while one read is in flight: the burst is answered by that read plus
        // exactly one queued follow-up, and the queued pass is the SAME unanswered request.
        // Lowering the flag between the two would blink `live` for the length of one
        // microtask — invisible in a browser, but it is the same flicker, and it would make
        // the notice stream lie about how many reads the reader is waiting on.
        h.client.frame({ store_rev: 5, collections_rev: 4 });
        await Promise.resolve();
        const first = release;
        h.client.frame({ store_rev: 5, collections_rev: 4 });
        h.client.frame({ store_rev: 5, collections_rev: 4 });

        expect(h.client.fetching()).toBe(true);

        first?.();
        await h.settle();

        expect(h.calls.deltas).toHaveLength(2);
        // The follow-up is in flight, and the flag never came down to let it start.
        expect(h.client.fetching()).toBe(true);

        release?.();
        await h.settle();

        expect(h.client.fetching()).toBe(false);
        // Up once, down once, for two reads.
        expect(fetches()).toBe(before + 2);
    });

    it('takes the flag back down when a read is superseded, so a late answer never strands `reading`', async () => {
        let release: (() => void) | undefined;
        const h = harness({
            snapshot: () =>
                new Promise<RecordsSnapshotResponse>((resolve) => {
                    release = () => resolve(SNAPSHOT);
                })
        });

        const first = h.client.refresh('boot');

        expect(h.client.fetching()).toBe(true);

        // The panel goes away while that snapshot is still outstanding. The read still
        // answers, and its `finally` still closes the fetch — a disposed client publishes
        // nothing, but it must not leave the flag up for whatever reads it next.
        h.client.dispose();
        release?.();
        await first;

        expect(h.client.disposed()).toBe(true);
        expect(h.notices.map((notice) => notice.reason)).toEqual(['fetch']);
    });
});

describe('records client — realtime link state', () => {
    it('moves unknown → live → down → live, and only re-reads when the baseline owes an answer', async () => {
        const h = harness({ delta: () => Promise.resolve(rows()) });
        await h.client.boot();

        expect(h.client.linkState()).toBe('unknown');

        h.client.linkUp(11);
        expect(h.client.linkState()).toBe('live');
        // A baseline revision is the same counter a read answers in `revision`.
        expect(h.client.watermarks().revision).toBe(11);

        h.client.linkDown();
        expect(h.client.linkState()).toBe('down');
        expect(h.client.stale()).toBe(true);
        // Nothing is re-read while the baseline's answer is outstanding.
        expect(h.calls.deltas).toEqual([]);

        h.client.linkUp(12);
        await h.settle();
        // The resync answer arrives at the baseline: one delta recovers the gap.
        expect(h.calls.deltas).toEqual([{ sessionId: 'sess_a', since: 1 }]);
        expect(h.client.linkState()).toBe('live');

        h.client.linkError('unknown_resource: records for 3f2a9c1b-7788-4a11-9d22-112233445566');
        await h.settle();
        expect(h.client.linkState()).toBe('down');
        expect(h.client.error()).toBe('unknown_resource: records for 3f2a9c1b');
        // Already booted: the rows on screen are still the last honest answer.
        expect(h.client.phase()).toBe('ready');
        expect(h.client.feed()).toHaveLength(1);
    });

    it('makes a refused subscription the panel\'s error state when nothing was read', () => {
        const h = harness();
        h.client.linkError('unsupported filter');

        expect(h.client.phase()).toBe('error');
        expect(h.client.error()).toBe('unsupported filter');
        expect(h.client.linkState()).toBe('down');
    });
});

describe('records client — disposal', () => {
    it('stops reading, painting and timing out after dispose', async () => {
        const h = harness({ delta: () => Promise.resolve(rows()) });
        await h.client.boot();

        const painted = h.notices.length;
        const armed = h.timers.length;
        expect(armed).toBe(0);

        h.client.dispose();

        h.client.frame({ store_rev: 9, collections_rev: 9 });
        h.client.linkUp();
        h.client.linkDown();
        h.client.linkError('late');
        await h.client.pull('delta');
        await h.client.refresh('collections');
        await h.settle();

        expect(h.client.disposed()).toBe(true);
        expect(h.notices).toHaveLength(painted);
        expect(h.calls.deltas).toEqual([]);
        expect(h.calls.snapshots).toEqual(['sess_a']);
    });

    it('cancels an armed body refresh so a dead panel never re-reads', async () => {
        const h = harness({ delta: () => Promise.resolve(rows({ seq: 2, collection: 'tasks', rev: 2, id: 'rec_x', op: 'add', fields: ['text'], item_rev: 0, at: AT_2 })) });
        await h.client.boot();
        await h.client.pull('delta');

        expect(h.timers).toHaveLength(1);
        h.client.dispose();
        expect(h.timers).toHaveLength(0);

        await h.settle();
        expect(h.calls.snapshots).toEqual(['sess_a']);
    });
});

describe('records client — shared projection helpers', () => {
    it('picks the display field in the store\'s declared order, and labels only off a real body', () => {
        const tasksLike = { name: 'tasks', storeRev: 1, count: 0, fields: TASKS_FIELDS, entries: [] };
        const countFirst = {
            name: 'notes',
            storeRev: 1,
            count: 0,
            fields: [{ key: 'count', type: 'integer' as const, required: false }, { key: 'body', type: 'text' as const, required: true }],
            entries: []
        };
        const preferred = {
            name: 'notes',
            storeRev: 1,
            count: 0,
            fields: [{ key: 'count', type: 'integer' as const, required: false }, { key: 'title', type: 'text' as const, required: true }],
            entries: []
        };
        const stringsOnly = {
            name: 'tags',
            storeRev: 1,
            count: 0,
            fields: [{ key: 'names', type: 'strings' as const, required: true }],
            entries: []
        };

        expect(recordsDisplayFieldOf(tasksLike)).toBe('text');
        // A naming field the store declares wins over declaration order...
        expect(recordsDisplayFieldOf(preferred)).toBe('title');
        // ...and with nothing naming, the first field that is not a tag list does.
        expect(recordsDisplayFieldOf(countFirst)).toBe('count');
        expect(recordsDisplayFieldOf(stringsOnly)).toBe('names');

        expect(recordsLabelOf(tasksLike, { id: 'rec_a', values: { text: 'Ship it' }, rev: 1, pending: false })).toEqual({ label: 'Ship it', known: true });
        // An empty string is a fact, not a label: the panel then falls back to the id.
        expect(recordsLabelOf(tasksLike, { id: 'rec_a', values: { text: '' }, rev: 1, pending: false })).toEqual({ label: '', known: false });
        expect(recordsLabelOf(undefined, undefined)).toEqual({ label: '', known: false });
    });

    it('treats an absent actor as the harness, never as a name', () => {
        expect(recordsActorOf({})).toEqual({ name: 'system', kind: 'system' });
        expect(recordsActorOf({ by: '' })).toEqual({ name: 'system', kind: 'system' });
        expect(recordsActorOf({ by: 'agent', threadId: 'ses_1' })).toEqual({ name: 'agent', kind: 'agent' });
    });

    it('keeps "no body" distinct from an empty value', () => {
        expect(recordsDisplayValueOf(undefined)).toBeUndefined();
        expect(recordsDisplayValueOf(null)).toBeUndefined();
        expect(recordsDisplayValueOf('')).toBe('');
        expect(recordsDisplayValueOf(true)).toBe('true');
        expect(recordsDisplayValueOf(7)).toBe('7');
        expect(recordsDisplayValueOf(['a', 1, 'b'])).toBe('a, b');
        expect(recordsDisplayValueOf([])).toBeUndefined();
        expect(recordsDisplayValueOf({ nested: true })).toBe('{"nested":true}');
    });

    it('strips wire metadata out of a record\'s own values', () => {
        expect(
            recordsEntryOf({
                id: 'rec_a',
                rev: 3,
                text: 'Body',
                completed: false,
                updated_by: 'agent',
                updated_thread_id: 'ses_1',
                updated_at: AT_2
            })
        ).toEqual({
            id: 'rec_a',
            values: { text: 'Body', completed: false },
            rev: 3,
            by: 'agent',
            threadId: 'ses_1',
            at: AT_2,
            pending: false
        });
    });
});

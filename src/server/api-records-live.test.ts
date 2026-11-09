// T4 (data plane) — the record store, pinned from a browser's two doors: the REST read and
// the live stream.
//
// WHAT THIS PROVES
//   1. `GET /v1/harness/sessions/{id}/records` answers the STORE, not one collection: a
//      snapshot with every collection's declared spec and rows, and — with `?since=` — ONLY the
//      feed after that position, plus the engine's honest `reset`. Snake_case on the wire, even
//      though the engine speaks camelCase, and a `getOnly` field (a chapter body) is ABSENT from
//      a row rather than emptied.
//   2. A record write is observable WITHOUT being polled: the engine notifies the store, the
//      store signals the realtime owner, the hub moves ONE `records` counter, the bridge hands
//      the broker a frame, and a session-scope subscriber receives a `records.updated` frame that
//      carries the store's two watermarks and no record at all. Because the write goes through
//      `harness.runtime.executeRecords`, the same door a LANE WORKER's write routes through
//      (./workers/lane-authority.ts `contextFor`), this also proves worker mode is not a special
//      case: the canonical harness notifies, so one wiring covers both.
//   3. HTTP and the stream quote the SAME number: the `X-Harness-Revision` header of a records
//      read is the hub counter a `records.updated` frame reported, which is the rule that lets a
//      client order a read against a frame instead of reconciling two clocks.
//   4. The read is READ-ONLY and bounded: it calls no tool, bumps no counter, builds no aggregate
//      (`store.get`/`list` stay uncalled), and a malformed cursor is a 400 rather than a silent
//      clamp.
//
// Determinism: statuses, key sets, watermarks and counter arithmetic are asserted exactly. Only
// ids and timestamps are matched structurally — and the timestamp FORMAT is pinned, because the
// wire type calls it `at`/`updated_at` and a panel formats it.
//
// Cross-references:
//   - ./api.ts                    — `getSessionRecords` (the route) and `case 'records.updated'`
//                                   in the store observer
//   - ./api-reads.ts              — `recordsSnapshotOf` / `recordsDeltaOf` (the camelCase→wire
//                                   projection, the ONLY place the renaming happens)
//   - ./sessions.ts               — `buildHarness`'s `harness.onRecordsChange` subscription and
//                                   the `StoreStreamSignal` variant it emits
//   - ../core/records.ts          — the feed and the reset rule (pinned in
//                                   ../core/records.store-events.test.ts)
//   - ./harness.swagger.yaml      — `/v1/harness/sessions/{session_id}/records`, `RecordsSnapshot
//                                   Response`, `RecordsDeltaResponse`, `WsUpdateRecords`
//   - ./api-live-events.test.ts   — the hub/broker/bridge fixture this reuses

import { describe, expect, it, vi } from 'vitest';
import { agent, harness } from '../harness';
import type { HarnessPreset, RunnerSettings } from './harnesses/types';
import { createHarnessRegistry } from './harnesses';
import { HARNESS_EPOCH_HEADER, HARNESS_REVISION_HEADER } from '../shared/harness-api';
import type { HarnessStreamEvent } from './api-events';
import { createHarnessApi } from './api';
import type { HarnessApiRequest, HarnessApiResult } from './api';
import { createHarnessEventHub } from './api-events';
import { SessionStore } from './sessions';
import { createStreamBroker } from './stream/broker';
import { bridgeEventHub, hubStreamSources } from './stream/mount';
import type { RecordStoreNotification } from '../types';

const DEFAULTS: RunnerSettings = {
    baseURL: 'http://scripted.invalid/v1',
    apiKey: 'unused',
    model: 'scripted/test'
};

const API_DEFAULTS = { baseURL: 'http://scripted.invalid/v1', model: 'scripted/test', hasApiKey: false };

const MOUNT = '/v1/harness';

// A preset that never talks to a provider: everything here is driven by direct record writes, so
// the test controls the store's exact contents without a run in the way. `harness({...})` is the
// REAL handle builder, which matters — the routes under test read `harness.records()`,
// `harness.recordsChanges()` and subscribe `harness.onRecordsChange()`, and a partial fake handle
// would exercise none of them.
const quietPreset = (): HarnessPreset => ({
    name: 'records',
    title: 'Records',
    description: 'Scripted record-store preset',
    requiresEndpoint: false,
    primary: 'records',
    subagents: [],
    agents: ['records'],
    tools: [],
    builtin: true,
    editable: true,
    create: (settings, progress) =>
        harness({
            agents: {
                records: agent({
                    model: settings.model,
                    instruction: 'Scripted record agent.',
                    stream: async function* () {
                        yield { type: 'text', delta: 'unused' };
                        yield { type: 'done', stopReason: 'stop' as const, toolCalls: [] };
                    }
                })
            },
            primary: 'records',
            presets: false,
            report: { progress }
        })
});

const createContext = () => {
    const registry = createHarnessRegistry([quietPreset()]);
    const store = new SessionStore(DEFAULTS, registry);
    const hub = createHarnessEventHub();
    const api = createHarnessApi({ store, defaults: API_DEFAULTS, registry, events: hub });

    return { api, store, hub, registry };
};

const call = (
    api: ReturnType<typeof createHarnessApi>,
    method: string,
    pathname: string,
    body: unknown = {},
    searchParams?: string
): Promise<HarnessApiResult> =>
    api({ method, pathname, mount: MOUNT, searchParams, readBody: async <T,>() => body as T } as HarnessApiRequest);

const jsonOf = (result: HarnessApiResult): { status: number; body: Record<string, any>; headers: Record<string, string> } => {
    if (result.kind !== 'json') throw new Error(`Expected a JSON result, got ${result.kind}.`);

    return {
        status: result.status,
        body: result.body as Record<string, any>,
        headers: result.headers ?? {}
    };
};

/** Open a session and return its id. */
const openSession = async (api: ReturnType<typeof createHarnessApi>): Promise<string> => {
    const created = jsonOf(await call(api, 'POST', `${MOUNT}/sessions`, { harness: 'records' }));

    expect(created.status).toBe(201);

    return created.body.session.id as string;
};

// A record write through the ROUTED door — the one a lane worker's write uses
// (./workers/lane-authority.ts). Identity comes from the context, never from the arguments, so
// the attribution this read projects is the caller's, not the model's claim.
const writeTask = async (
    store: SessionStore,
    sessionId: string,
    parameters: Record<string, unknown>,
    by = 'writer'
): Promise<void> => {
    await store.liveSession(sessionId).harness.runtime.executeRecords('tasks', {
        parameters,
        agent: { name: by } as never,
        threadId: 'thread-1'
    } as never);
};

const readRecords = async (
    api: ReturnType<typeof createHarnessApi>,
    sessionId: string,
    since?: string
): Promise<ReturnType<typeof jsonOf>> =>
    jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/records`, {}, since === undefined ? undefined : `since=${since}`));

// An ISO-8601 instant, which is what the wire promises for `at` and `updated_at`. Pinned as a
// shape because the VALUE is the server clock; every other field in the same object is asserted
// literally.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('GET /sessions/{id}/records — the snapshot', () => {
    it('answers the whole store in one bounded read, in the contract key set', async () => {
        const { api, store } = createContext();
        const sessionId = await openSession(api);

        await writeTask(store, sessionId, { tasks: [{ text: 'Paint the barn' }] });

        const read = await readRecords(api, sessionId);

        expect(read.status).toBe(200);
        // `additionalProperties: false` on `RecordsSnapshotResponse`: these six keys and no other.
        expect(Object.keys(read.body).sort()).toEqual([
            'changes',
            'collections',
            'collections_rev',
            'revision',
            'session_id',
            'store_rev'
        ]);
        expect(read.body.session_id).toBe(sessionId);
        expect(read.body.store_rev).toBe(1);
        // No collection was defined or dropped, so the collection SET has not moved.
        expect(read.body.collections_rev).toBe(0);
        expect(read.body.revision).toBe(1);

        // Built-ins in declaration order, always present — an empty collection still ships its
        // field spec, because that spec is the panel's column list.
        expect(read.body.collections.map((collection: Record<string, any>) => collection.name)).toEqual([
            'tasks',
            'chapters',
            'profiles',
            'locations'
        ]);

        const tasks = read.body.collections[0];

        expect(Object.keys(tasks).sort()).toEqual(['count', 'entries', 'fields', 'name', 'store_rev']);
        expect(tasks.store_rev).toBe(1);
        expect(tasks.count).toBe(1);
        // A field descriptor carries what a renderer needs and nothing else: the caps, defaults,
        // count facets and `getOnly` flag stay engine-side (a `records describe` is the spec read).
        expect(tasks.fields).toEqual([
            { key: 'text', type: 'text', required: true },
            { key: 'completed', type: 'boolean', required: false }
        ]);
        // The row: `id`, the declared fields, `rev`, then the attribution triple — renamed to
        // snake_case for the wire while the engine keeps camelCase internally.
        expect(tasks.entries).toEqual([
            {
                id: '1',
                text: 'Paint the barn',
                completed: false,
                rev: 1,
                updated_by: 'writer',
                updated_thread_id: 'thread-1',
                updated_at: tasks.entries[0].updated_at
            }
        ]);
        expect(ISO_INSTANT.test(tasks.entries[0].updated_at)).toBe(true);

        // The feed travels with the bootstrap so the FIRST delta has somewhere to continue from.
        expect(read.body.changes).toEqual([
            {
                seq: 1,
                collection: 'tasks',
                rev: 1,
                id: '1',
                op: 'add',
                by: 'writer',
                thread_id: 'thread-1',
                at: read.body.changes[0].at,
                item_rev: 1
            }
        ]);
        expect(ISO_INSTANT.test(read.body.changes[0].at)).toBe(true);
    });

    it('leaves a getOnly field out of a row instead of emptying it', async () => {
        const { api, store } = createContext();
        const sessionId = await openSession(api);

        // A chapter body is the `getOnly` field: the model is never flooded with it, and the same
        // rule applies ten times harder to a browser list read.
        await store.liveSession(sessionId).harness.runtime.executeRecords('chapters', {
            parameters: { action: 'add', title: 'Alpha', summary: 'cold open', content: 'a whole body' },
            agent: { name: 'editor' } as never
        } as never);

        const read = await readRecords(api, sessionId);
        const chapters = read.body.collections[1];

        expect(chapters.count).toBe(1);
        expect(chapters.entries[0]).toEqual({
            id: '1',
            title: 'Alpha',
            summary: 'cold open',
            status: 'planned',
            rev: 1,
            updated_by: 'editor',
            updated_at: chapters.entries[0].updated_at
        });
        expect('content' in chapters.entries[0]).toBe(false);
        // `content` IS declared (so the panel knows the column exists) — it is the VALUE that is
        // withheld. The two are different facts.
        expect(chapters.fields.map((field: Record<string, any>) => field.key)).toEqual(['title', 'summary', 'content', 'status', 'order']);
        expect(chapters.store_rev).toBe(1);
    });

    it('names a collection that has never moved, with an empty row set', async () => {
        const { api } = createContext();
        const sessionId = await openSession(api);

        const read = await readRecords(api, sessionId);

        expect(read.body.store_rev).toBe(0);
        expect(read.body.revision).toBe(0);
        expect(read.body.changes).toEqual([]);
        expect(read.body.collections.map((collection: Record<string, any>) => [collection.name, collection.count, collection.store_rev])).toEqual([
            ['tasks', 0, 0],
            ['chapters', 0, 0],
            ['profiles', 0, 0],
            ['locations', 0, 0]
        ]);
        // An untouched store still answers, and the header quotes the same zero the body does.
        expect(read.headers[HARNESS_REVISION_HEADER]).toBe('0');
        expect(read.headers[HARNESS_EPOCH_HEADER]).toBeTruthy();
    });
});

describe('GET /sessions/{id}/records?since= — the delta and the reset rule', () => {
    it('answers only the feed after the cursor, and no collections at all', async () => {
        const { api, store } = createContext();
        const sessionId = await openSession(api);

        await writeTask(store, sessionId, { tasks: [{ text: 'One' }] });
        await writeTask(store, sessionId, { tasks: [{ text: 'Two' }] }, 'editor');

        const read = await readRecords(api, sessionId, '0');

        expect(read.status).toBe(200);
        // `RecordsDeltaResponse` is a different closed object: no `collections` key, and a
        // `reset` flag instead. A panel that already has the rows pays only for what moved.
        expect(Object.keys(read.body).sort()).toEqual(['changes', 'collections_rev', 'reset', 'revision', 'session_id', 'store_rev']);
        expect(read.body.reset).toBe(false);
        expect(read.body.store_rev).toBe(2);
        expect(read.body.changes).toHaveLength(2);
        expect(read.body.changes.map((change: Record<string, any>) => [change.seq, change.collection, change.id, change.op, change.by])).toEqual([
            [1, 'tasks', '1', 'add', 'writer'],
            [2, 'tasks', '2', 'add', 'editor']
        ]);
    });

    it('answers a current cursor with an empty window and NO reset', async () => {
        const { api, store } = createContext();
        const sessionId = await openSession(api);

        await writeTask(store, sessionId, { tasks: [{ text: 'One' }] });

        const read = await readRecords(api, sessionId, '1');

        expect(read.body).toEqual({
            session_id: sessionId,
            revision: 1,
            store_rev: 1,
            collections_rev: 0,
            changes: [],
            reset: false
        });
    });

    it('answers a cursor the store never had with reset, as a 200 — a stale cursor is a race, not an error', async () => {
        const { api, store } = createContext();
        const sessionId = await openSession(api);

        await writeTask(store, sessionId, { tasks: [{ text: 'One' }] });

        const read = await readRecords(api, sessionId, '9999');

        expect(read.status).toBe(200);
        expect(read.body.reset).toBe(true);
        expect(read.body.changes).toEqual([]);
        expect(read.body.store_rev).toBe(1);
    });

    it('resumes gap-free across a trimmed window: every seq above the cursor, in order', async () => {
        const { api, store } = createContext();
        const sessionId = await openSession(api);

        // 210 events across TWO collections, so the binding constraint is the store-wide feed
        // bound (200) and not one collection's own row bound: the store head keeps counting past
        // the trim, which is exactly the case `reset` exists for.
        for (let index = 0; index < 120; index += 1) {
            await writeTask(store, sessionId, { tasks: [{ text: `T${index}` }] });
        }
        for (let index = 0; index < 90; index += 1) {
            await store.liveSession(sessionId).harness.runtime.executeRecords('chapters', {
                parameters: { action: 'add', title: `C${index}`, summary: 's' },
                agent: { name: 'editor' } as never
            } as never);
        }

        const tail = await readRecords(api, sessionId, '200');

        expect(tail.body.reset).toBe(false);
        expect(tail.body.store_rev).toBe(210);
        expect(tail.body.changes).toHaveLength(10);
        expect(tail.body.changes.map((change: Record<string, any>) => change.seq)).toEqual([201, 202, 203, 204, 205, 206, 207, 208, 209, 210]);
        // The 90 chapters adds are seq 121..210, and each keeps its OWN collection revision
        // (`rev` restarts at 1): the store position is the cursor, the collection revision is the
        // CAS token, and one is never a stand-in for the other.
        expect(tail.body.changes.map((change: Record<string, any>) => [change.seq, change.collection, change.rev])).toEqual([
            [201, 'chapters', 81],
            [202, 'chapters', 82],
            [203, 'chapters', 83],
            [204, 'chapters', 84],
            [205, 'chapters', 85],
            [206, 'chapters', 86],
            [207, 'chapters', 87],
            [208, 'chapters', 88],
            [209, 'chapters', 89],
            [210, 'chapters', 90]
        ]);

        // The window starts at 11, so a cursor at 0 can no longer be resumed — and the answer
        // still hands over what IS retained rather than throwing it away.
        const aged = await readRecords(api, sessionId, '0');

        expect(aged.body.reset).toBe(true);
        expect(aged.body.changes).toHaveLength(200);
        expect(aged.body.changes[0].seq).toBe(11);
    });

    it('refuses a cursor that is not a non-negative integer, and never clamps it', async () => {
        const { api, store } = createContext();
        const sessionId = await openSession(api);

        await writeTask(store, sessionId, { tasks: [{ text: 'One' }] });

        // A malformed cursor is the CALLER'S bug; a `reset` is the server's. Collapsing the two
        // would leave a client unable to tell which one it has.
        // NOTE on what is NOT in this list: `+1` and `%201%20` both arrive as `1`, because a query
        // value is percent/plus-DECODED before this route sees it and the shared parameter reader
        // trims. That is the router's documented decoding, not this route clamping a bad cursor.
        for (const bad of ['abc', '-1', '1.5', '2abc', '1e3', '-0', '0x1']) {
            const read = jsonOf(await call(api, 'GET', `${MOUNT}/sessions/${sessionId}/records`, {}, `since=${bad}`));

            expect(read.status).toBe(400);
            expect(read.body.error.message).toBe('Query parameter "since" must be a non-negative integer.');
        }

        // An ABSENT or EMPTY `since` is the snapshot form: the route reads the parameter with the
        // same trim-to-undefined rule every other query parameter on this API uses, so `?since=`
        // means "no cursor" rather than "position zero" — the two differ once anything is stored.
        const snapshot = await readRecords(api, sessionId);

        expect(snapshot.status).toBe(200);
        expect(snapshot.body.store_rev).toBe(1);
        expect('reset' in snapshot.body).toBe(false);
    });

    it('404s an unknown session with the same wording every other session route uses', async () => {
        const { api } = createContext();

        const read = await readRecords(api, 'ses_missing');

        expect(read.status).toBe(404);
        expect(read.body.error.message).toBe('Unknown session "ses_missing".');
    });
});

describe('the record store is observable without being polled', () => {
    it('moves one records counter per committed mutation and wakes a session-scope subscriber', async () => {
        const { api, hub, store } = createContext();
        const sessionId = await openSession(api);

        const events: HarnessStreamEvent[] = [];
        const detach = api.events.subscribe((event) => events.push(event));

        // A broker fed by the SAME hub, with one session-scope subscription: the frame list below
        // is literally what a browser socket would receive.
        const frames: Record<string, any>[] = [];
        const broker = createStreamBroker(hubStreamSources(hub));
        const handle = broker.open((frame) => {
            frames.push(frame as unknown as Record<string, any>);

            return 'sent';
        });
        const unbridge = bridgeEventHub(hub, broker);

        const subscribed = handle.subscribe({
            subscription_id: 'panel',
            scope: 'session',
            ids: { session_id: sessionId },
            pace: 'ordered'
        });

        expect(subscribed.status).toBe('ok');

        // The baseline a records panel bootstraps against: `records` is a session-scope resource
        // kind, so it is one of the revision records the subscribe answer carries.
        const subscribedState = subscribed.status === 'ok' ? subscribed.state : undefined;

        expect(subscribedState?.revisions.map((record) => record.resource)).toContain('records');

        frames.length = 0;

        await writeTask(store, sessionId, { tasks: [{ text: 'Wake the panel' }] });

        const recordsEvents = events.filter((event) => event.kind === 'records.updated');

        expect(recordsEvents).toHaveLength(1);

        // ONE session-level counter domain, whatever the mutation touched, addressed by the
        // plain session id (not a composite) because the store belongs to the session.
        expect(recordsEvents[0].target).toEqual({ resource: 'records', id: sessionId });
        expect(recordsEvents[0].resources).toEqual([{ resource: 'records', id: sessionId }]);
        // The payload field is `records`, and its content is the two watermarks ONLY: a frame
        // never carries a record, which is what keeps a burst of edits cheap.
        expect(Object.keys(recordsEvents[0].payload as object)).toEqual(['records']);
        expect(recordsEvents[0].payload).toEqual({ records: { store_rev: 1, collections_rev: 0 } });
        expect(hub.getRevision('records', sessionId)).toBe(1);

        // The frame that reaches the socket: same kind, same payload, sequenced and cursor-bearing
        // like every other update on this stream.
        const panelFrames = frames.filter((frame) => frame.type === 'update' && frame.subscription_id === 'panel');

        expect(panelFrames).toHaveLength(1);
        expect(panelFrames[0].kind).toBe('records.updated');
        expect(panelFrames[0].records).toEqual({ store_rev: 1, collections_rev: 0 });
        expect(panelFrames[0].sequence).toBe(1);
        expect(typeof panelFrames[0].cursor).toBe('string');
        expect(typeof panelFrames[0].at).toBe('number');

        // HTTP and WS quote the SAME figure — the ordering rule a client depends on.
        const read = await readRecords(api, sessionId);

        expect(read.body.revision).toBe(1);
        expect(read.headers[HARNESS_REVISION_HEADER]).toBe('1');
        expect(frames.filter((frame) => frame.type === 'update' && frame.subscription_id === 'panel')).toHaveLength(1);

        // A batch is ONE frame: three entries, one committed call, one announcement. A panel that
        // got a frame per entry would render a batch as three repaints.
        frames.length = 0;

        await writeTask(store, sessionId, { tasks: [{ text: 'A' }, { text: 'B' }, { text: 'C' }] });

        expect(frames.filter((frame) => frame.kind === 'records.updated')).toHaveLength(1);
        expect(hub.getRevision('records', sessionId)).toBe(2);

        // A READ announces nothing: polling this route must not feed the stream that woke it.
        frames.length = 0;

        await readRecords(api, sessionId);
        await readRecords(api, sessionId, '1');

        expect(frames).toEqual([]);

        unbridge();
        detach();
    });

    it('does not tick the replayable feed for a collection-set move, and re-bootstraps on the flag', async () => {
        const { api, store } = createContext();
        const sessionId = await openSession(api);

        await writeTask(store, sessionId, { tasks: [{ text: 'Before' }] });

        // `define` mints no record event: `store_rev` stays, `collections_rev` moves, and the
        // panel's rule is "re-read the snapshot when collections_rev moved".
        await store.liveSession(sessionId).harness.runtime.executeRecords('records', {
            parameters: { define: { name: 'notes', fields: [{ key: 'body', type: 'text', required: true }] } },
            agent: { name: 'author' } as never
        } as never);

        const before = await readRecords(api, sessionId, '1');

        expect(before.body.store_rev).toBe(1);
        expect(before.body.collections_rev).toBe(1);
        expect(before.body.reset).toBe(false);
        expect(before.body.changes).toEqual([]);

        const snapshot = await readRecords(api, sessionId);

        expect(snapshot.body.collections.map((collection: Record<string, any>) => collection.name)).toEqual([
            'tasks',
            'chapters',
            'profiles',
            'locations',
            'notes'
        ]);
        // The new collection is addressable immediately, with its declared field spec.
        expect(snapshot.body.collections[4].fields).toEqual([{ key: 'body', type: 'text', required: true }]);
        // The define DID move the session's `records` counter (a live panel must be woken for it),
        // exactly like a record mutation.
        expect(snapshot.body.revision).toBe(2);
    });

    it('stays read-only: the projection calls no tool, moves no counter, and builds no aggregate', async () => {
        const { api, hub, store } = createContext();
        const sessionId = await openSession(api);

        await writeTask(store, sessionId, { tasks: [{ text: 'Once' }] });

        const revisionBefore = hub.getRevision('records', sessionId);
        const notificationCount = { seen: 0 };

        // A second observer, so "no notification" is proven on the engine seam itself and not only
        // inferred from the hub.
        const stop = store.liveSession(sessionId).harness.onRecordsChange((notification: RecordStoreNotification) => {
            notificationCount.seen += 1;
            void notification;
        });

        const getSpy = vi.spyOn(store, 'get');
        const listSpy = vi.spyOn(store, 'list');

        await readRecords(api, sessionId);
        await readRecords(api, sessionId, '0');

        expect(hub.getRevision('records', sessionId)).toBe(revisionBefore);
        expect(notificationCount.seen).toBe(0);
        // T13's cost rule, restated for this route: a records read walks the store's own live
        // state, it never rebuilds the session aggregate.
        expect(getSpy).not.toHaveBeenCalled();
        expect(listSpy).not.toHaveBeenCalled();

        stop();
    });

    it('reports attribution as ABSENT, not empty, when the caller has no identity', async () => {
        const { api, store } = createContext();
        const sessionId = await openSession(api);

        // A driver-style write with no agent in the context: "nobody wrote this" is a different
        // fact from "someone named nothing wrote this", so the keys stay off the row.
        await store.liveSession(sessionId).harness.runtime.executeRecords('tasks', {
            parameters: { tasks: [{ text: 'Anonymous' }] }
        } as never);

        const read = await readRecords(api, sessionId);
        const row = read.body.collections[0].entries[0];

        expect(row).toEqual({
            id: '1',
            text: 'Anonymous',
            completed: false,
            rev: 1,
            updated_at: row.updated_at
        });
        expect('updated_by' in row).toBe(false);
        expect('updated_thread_id' in row).toBe(false);
    });
});

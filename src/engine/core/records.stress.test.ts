// Stress probes for the records/tasks pair. Each `it` is one candidate defect found by
// reviewing src/core/records.ts and hammering the live tools; the expectation states the
// contract the tool description makes, and the assertion records what the engine actually
// does. Run with:
//   yarn vitest run packages/underload/harness/src/core/records.stress.test.ts
import { describe, expect, it } from 'vitest';
import { createRecordEngine } from './records';
import type { RecordsResult } from '../types';

type Eng = ReturnType<typeof createRecordEngine>;

const run = async (
    engine: Eng,
    tool: 'records' | 'tasks',
    parameters: Record<string, unknown>,
    by = 'agent'
): Promise<any> =>
    await engine.executeRecords(tool, {
        parameters,
        agent: { name: by } as never,
        threadId: 'thread-1'
    } as never);

const add = async (engine: Eng, collection: string, entries: unknown[]) =>
    run(engine, 'records', { collection, entries, limit: 1 });

const define = async (engine: Eng, definition: Record<string, unknown>) =>
    run(engine, 'records', { define: definition });

describe('stress: define / dispatch short-circuits', () => {
    it('D3: `define` beside a write silently DISCARDS the write', async () => {
        const engine = createRecordEngine();

        const result = await run(engine, 'records', {
            define: { name: 'notes', fields: [{ key: 'q', type: 'text' }] },
            entries: [{ q: 'must this exist?' }]
        });

        // The call succeeded and created the collection; the entry is gone.
        expect(result.collection).toBe('notes');
        expect(result.counts.total).toBe(0);

        const listed = await run(engine, 'records', { collection: 'notes' });
        expect(listed.entries).toEqual([]);
    });

    it('D3b: `define` beside `remove`/`ids`/`where`/`drop`/`describe` ignores them (it now echoes its own definition)', async () => {
        const engine = createRecordEngine();

        const dropped = await run(engine, 'records', {
            define: { name: 'notes', fields: [{ key: 'q', type: 'text' }] },
            drop: true
        });
        expect(dropped.collection).toBe('notes');

        const describeOnly = await run(engine, 'records', {
            collection: 'tasks',
            describe: true
        });
        expect(describeOnly.definition).toBeDefined();

        const both = await run(engine, 'records', {
            define: { name: 'notes2', fields: [{ key: 'q', type: 'text' }] },
            describe: true
        });
        // R5 CHANGED this pin: `define` now answers with the definition it stored, so the
        // key that used to be absent is here. What did NOT change is the short-circuit —
        // the `describe: true` beside it never answered on its own terms.
        expect(both.definition).toEqual({
            name: 'notes2',
            fields: [{ key: 'q', type: 'text' }],
            maxRecords: 200,
            // F7-4 (2026-11-25): the engine default again — 65,536 (64 KiB), which is the
            // top of the configurable range and ABOVE the 32,768-byte delivery cap on
            // purpose. F1-6 had moved this default to 24,576 to dodge the cap; the cap is
            // now enforced at serve time (`clampToDeliveryCap`) and the default is the
            // caller's request again.
            responseBudgetBytes: 65_536
        });
        expect(both.collection).toBe('notes2');
        // A define answer and a describe answer now share a shape (both carry `definition`
        // and `entries`), so the ignore is pinned by COMPARISON: the same define without
        // the extra control answers byte-identically, and the described collection holds
        // what define created - i.e. `describe` added nothing of its own.
        const bare = await run(engine, 'records', {
            define: { name: 'notes3', fields: [{ key: 'q', type: 'text' }] }
        });
        expect(Object.keys(bare)).toEqual(Object.keys(both));
        expect({ ...both, definition: null, collection: null }).toEqual({
            ...bare,
            definition: null,
            collection: null
        });
        // The echo is a CLONE, not the live definition (the defect D40 pins for
        // snapshot()): writing through the returned object must not reach the store.
        both.definition.name = 'mutated';
        both.definition.fields.push({ key: 'ghost', type: 'text' });
        const echoedBack = await run(engine, 'records', { collection: 'notes2', describe: true });
        expect(echoedBack.definition).toEqual({
            name: 'notes2',
            fields: [{ key: 'q', type: 'text' }],
            maxRecords: 200,
            // F7-4 (2026-11-25): the engine default again — 65,536, the top of the configurable
            // range, above the 32,768-byte delivery cap on purpose (the cap is enforced at
            // serve time by `clampToDeliveryCap`, not by shrinking this number).
            responseBudgetBytes: 65_536
        });
    });

    it('D73: a write with NO `collection` returns the collection list and drops the write', async () => {
        const engine = createRecordEngine();

        const result = await run(engine, 'records', { entries: [{ text: 'forgot collection' }] });

        expect(result.collections).toBeDefined();
        expect(result.entry).toBeUndefined();

        const tasks = await run(engine, 'tasks', {});
        expect(tasks.counts.total).toBe(0);
    });

    it('D17: `drop` beside read controls silently ignores them (the class Review F5 fixed for describe)', async () => {
        const engine = createRecordEngine();

        await define(engine, { name: 'temp', fields: [{ key: 'q', type: 'text' }] });

        // `since: 999` on a collection at storeRev 0 is an invalid-input on any other call.
        const dropped = await run(engine, 'records', {
            collection: 'temp',
            drop: true,
            since: 999,
            offset: 5,
            limit: 1
        });

        expect(dropped.collection).toBe('temp');
        expect(dropped.page.limit).toBe(20); // the caller's limit: 1 was ignored too
    });
});

describe('stress: counts facets', () => {
    it('D4: an enum facet value named "total" overwrites counts.total', async () => {
        const engine = createRecordEngine();

        await define(engine, {
            name: 'clash',
            fields: [
                { key: 'state', type: 'enum', values: ['total', 'open', 'done'], count: true },
                { key: 'z', type: 'text' }
            ]
        });
        await add(engine, 'clash', [
            { state: 'total', z: 'a' },
            { state: 'done', z: 'b' },
            { state: 'done', z: 'c' }
        ]);

        const listed = await run(engine, 'records', { collection: 'clash', limit: 1 });

        // Three records exist; `total` reports the facet for the value "total".
        expect(listed.counts.total).toBe(3);
    });

    it('D4b: a boolean complement named "total" overwrites counts.total', async () => {
        const engine = createRecordEngine();

        await define(engine, {
            name: 'clash2',
            fields: [
                { key: 'flag', type: 'boolean', count: { key: 'yes', complement: 'total' } },
                { key: 'z', type: 'text' }
            ]
        });
        await add(engine, 'clash2', [
            { flag: true, z: 'a' },
            { flag: false, z: 'b' }
        ]);

        const listed = await run(engine, 'records', { collection: 'clash2', limit: 1 });
        expect(listed.counts.total).toBe(2);
    });

    it('D4c: two facets may claim the same key, silently', async () => {
        const engine = createRecordEngine();

        await define(engine, {
            name: 'clash3',
            fields: [
                { key: 'flag', type: 'boolean', count: { key: 'shared' } },
                { key: 'state', type: 'enum', values: ['shared', 'other'], count: true }
            ]
        });
        await add(engine, 'clash3', [
            { flag: true, state: 'shared' },
            { flag: false, state: 'other' }
        ]);

        const listed = await run(engine, 'records', { collection: 'clash3', limit: 1 });
        // Both facets write counts.shared; the definition is accepted with no warning.
        expect(listed.counts.shared).toBe(1);
    });
});

describe('stress: `ids` reads', () => {
    it('D1: `ids` is silently ignored when the same call also writes', async () => {
        const engine = createRecordEngine();

        const created = await add(engine, 'tasks', [{ text: 'one' }, { text: 'two' }]);
        const ids = created.addedIds as string[];

        const result = await run(engine, 'tasks', {
            ids: [ids[1]],
            tasks: [{ id: ids[0], completed: true }],
            expects: [{ id: ids[0], rev: 1 }],
            limit: 1
        });

        // The caller asked to read ids[1] and patch ids[0]; ids[1] is nowhere in the answer.
        expect(JSON.stringify(result)).toContain(ids[1]);
    });

    it('D5: an `ids` read is bounded by responseBudgetBytes and hands back an IDS cursor', async () => {
        const engine = createRecordEngine();

        await define(engine, {
            name: 'bodies',
            fields: [{ key: 'body', type: 'text', maxLength: 4000, required: true }],
            responseBudgetBytes: 1024
        });

        const body = 'x'.repeat(400);
        await add(engine, 'bodies', [
            { body },
            { body: body + 'a' },
            { body: body + 'b' },
            { body: body + 'c' },
            { body: body + 'd' }
        ]);

        const listed = await run(engine, 'records', { collection: 'bodies', limit: 20 });
        const page = listed.page as Record<string, unknown>;
        expect(page.budgetTruncated).toBe(true);

        const read = await run(engine, 'records', {
            collection: 'bodies',
            ids: ['1', '2', '3', '4', '5']
        });

        // F-STORE M1 CHANGED this pin. This read used to be the one answer with no byte
        // budget at all: all five 400-character bodies came back under a 1,024-byte
        // collection budget (1,586 bytes of rows) while the page claimed the collection was
        // not exhausted. An `ids` read is now metered by the same budget as a page, so the
        // first row is admitted whole (the first row of any KIND is always admitted) and the
        // rest are withheld.
        expect(read.entries.map((entry: any) => entry.id)).toEqual(['1']);
        expect(read.entry).toBeUndefined();
        expect(read.budgetTruncated).toBe(true);
        // The cut is reported twice with two different meanings, and both are pinned: the
        // page flag says "the page echo stopped short of `limit`", the top-level flag says
        // "this answer withheld something". `nextOffset` counts positions in the DEDUPED
        // list of ids the caller asked for, not positions in the collection.
        expect(read.page).toEqual({
            offset: 0,
            limit: 20,
            hasMore: true,
            nextOffset: 1,
            budgetTruncated: true
        });

        // The continuation is the part that was broken: replaying the SAME ids call at the
        // cursor the engine returned now yields the next requested id (2), not a record the
        // caller already holds. The plural shape survives the cut - five distinct ids were
        // requested, so a one-row answer is still `entries`, never `entry`.
        const next = await run(engine, 'records', {
            collection: 'bodies',
            ids: ['1', '2', '3', '4', '5'],
            offset: 1
        });
        expect(next.entries.map((entry: any) => ({ id: entry.id, body: entry.body }))).toEqual([
            { id: '2', body: `${body}a` }
        ]);
        expect(next.entry).toBeUndefined();
        expect(next.page).toEqual({
            offset: 1,
            limit: 20,
            hasMore: true,
            nextOffset: 2,
            budgetTruncated: true
        });
    });

    it('D5b: an `ids` read IS bounded by responseBudgetBytes (the F13 inner<outer rule)', async () => {
        const engine = createRecordEngine();

        await define(engine, {
            name: 'huge',
            fields: [{ key: 'body', type: 'text', maxLength: 4000, required: true }],
            responseBudgetBytes: 1024
        });

        const minted: string[] = [];

        for (let index = 0; index < 40; index += 1) {
            const one = await add(engine, 'huge', [{ body: 'x'.repeat(4000) }]);
            minted.push(one.entry.id);
        }

        const page = await run(engine, 'records', { collection: 'huge', limit: 100 });
        const pageBytes = JSON.stringify(page.entries).length;

        const read = await run(engine, 'records', { collection: 'huge', ids: minted });
        const readBytes = JSON.stringify(read.entries).length;

        // F-STORE M1 CHANGED this pin. A page of these records used to be budgeted while an
        // `ids` read of the SAME 40 records was not (160,000+ characters of rows, past the
        // 32,768-byte delivery cap). Both shapes are now metered by the same cutter, so they
        // cost byte-for-byte the same amount: one 4,000-character row each.
        expect(pageBytes).toBe(4118);
        expect(readBytes).toBe(4118);
        expect(read.entries.length).toBe(1);
        expect(read.budgetTruncated).toBe(true);
        expect(read.page).toEqual({
            offset: 0,
            limit: 20,
            hasMore: true,
            nextOffset: 1,
            budgetTruncated: true
        });
    });
});

describe('stress: field-key shape', () => {
    it('D53: a field named `__proto__` is accepted but can never be written', async () => {
        const engine = createRecordEngine();

        await define(engine, {
            name: 'proto',
            fields: [
                { key: '__proto__', type: 'text', required: true },
                { key: 'ok', type: 'text' }
            ]
        });

        // A computed key is required here: `{ __proto__: 'value' }` in an object
        // literal sets no own property, so it could never exercise the engine.
        const added = await add(engine, 'proto', [{ ok: 'yes', ['__proto__']: 'first' }]);
        expect(added.entry['__proto__']).toBe('first');

        const patched = await run(engine, 'records', {
            collection: 'proto',
            entries: [{ id: added.entry.id, ok: 'y2', ['__proto__']: 'set' }],
            expects: [{ id: added.entry.id, rev: 1 }],
            limit: 1
        });
        expect(patched.entry['__proto__']).toBe('set');
    });

    it('D53b: an enum facet value named `__proto__` silently vanishes from counts', async () => {
        const engine = createRecordEngine();

        await define(engine, {
            name: 'protofacet',
            fields: [
                { key: 'state', type: 'enum', values: ['__proto__', 'other'], count: true },
                { key: 'z', type: 'text' }
            ]
        });
        await add(engine, 'protofacet', [
            { state: '__proto__', z: 'a' },
            { state: '__proto__', z: 'b' },
            { state: 'other', z: 'c' }
        ]);

        const listed = await run(engine, 'records', { collection: 'protofacet', limit: 1 });
        expect(listed.counts.other).toBe(1);
        expect((listed.counts as Record<string, unknown>)['__proto__']).toBe(2);
    });
});

describe('stress: snapshot aliasing', () => {
    it('D40: snapshot() hands out the LIVE definition object, not a copy', async () => {
        const engine = createRecordEngine();

        const snap = engine.snapshot() as any;
        const before = snap.collections.tasks.definition.fields[0].maxLength;

        // A host mutating the snapshot it was given (the module comment promises
        // "Copy out, so a snapshot never aliases live state").
        snap.collections.tasks.definition.fields[0].maxLength = 5;

        const tasks = await run(engine, 'tasks', { tasks: [{ text: 'x'.repeat(40) }] });
        expect(tasks.entry).toBeDefined(); // the live cap is still 4000
        expect(before).toBe(4000);
    });

    it('D41: view()/changesSince() hand out change entries whose `fields` array is shared', async () => {
        const engine = createRecordEngine();

        await run(engine, 'tasks', { tasks: [{ text: 'one' }] });
        await run(engine, 'tasks', { tasks: [{ id: '1', completed: true }], expects: [{ id: '1', rev: 1 }] });

        const view = engine.view();
        const update = view.changes.find((change) => change.op === 'update') as any;
        expect(update.fields).toEqual(['completed']);

        update.fields.push('text');

        const again = engine.view();
        const same = again.changes.find((change) => change.op === 'update') as any;
        expect(same.fields).toEqual(['completed']);
    });
});

describe('stress: wrapper schema vs engine surface', () => {
    it('D45: the action wrappers forward since/afterId but their schema refuses them', async () => {
        const engine = createRecordEngine();

        await run(engine, 'tasks', { tasks: [{ text: 'one' }] });

        // `tasks` (batch wrapper) declares since/afterId, so both work.
        const withSince = await run(engine, 'tasks', { since: 0, limit: 1 });
        expect(withSince.changes).toBeDefined();

        // The engine itself answers since/afterId for chapters too.
        const chapters = await run(engine, 'records', { collection: 'chapters', since: 0, limit: 1 });
        expect(chapters.changes).toBeDefined();
    });
});

describe('stress: where semantics', () => {
    it('D77: an empty `where: {}` is treated as a filter and collides with since/ids', async () => {
        const engine = createRecordEngine();

        await run(engine, 'tasks', { tasks: [{ text: 'one' }] });

        const filtered = await run(engine, 'tasks', { where: {} });
        expect(filtered.counts.total).toBe(1);

        await expect(run(engine, 'tasks', { where: {}, since: 0 })).rejects.toThrow(/cannot be combined/);
    });

    it('D2: a mutating call with `where` counts the filtered set while the write ignores it', async () => {
        const engine = createRecordEngine();

        await add(engine, 'tasks', [{ text: 'alpha' }, { text: 'beta' }]);

        const result = await run(engine, 'tasks', {
            tasks: [{ text: 'gamma' }],
            where: { completed: true },
            limit: 20
        });

        // counts.total says 0 (the filtered set) while the collection holds 3 tasks.
        expect(result.counts.total).toBe(0);
        const after = await run(engine, 'tasks', {});
        expect(after.counts.total).toBe(3);
    });
});

describe('stress: change feed floor', () => {
    it('D-: a trimmed window reports the floor and a stale since is refused', async () => {
        const engine = createRecordEngine();

        // 250 events without exceeding the 200-record cap: 200 adds, then 50 updates.
        const created = await run(engine, 'tasks', {
            tasks: Array.from({ length: 200 }, (_, index) => ({ text: `task ${index}` }))
        });
        const ids = created.addedIds as string[];

        for (let index = 0; index < 50; index += 1) {
            await run(engine, 'tasks', {
                tasks: [{ id: ids[index], completed: true }],
                expects: [{ id: ids[index], rev: 1 }],
                limit: 1
            });
        }

        const read = await run(engine, 'tasks', { limit: 1 });
        expect(read.storeRev).toBe(250);

        const stale = await run(engine, 'tasks', { since: 0, limit: 1 });
        expect(stale.changesTruncated).toBe(true);
        expect(stale.oldestAvailableRev).toBe(51);
    });
});

describe('stress: guarded write advice', () => {
    it('D-: a stale patch carries the current record (R9)', async () => {
        const engine = createRecordEngine();

        await add(engine, 'tasks', [{ text: 'one' }]);
        await run(engine, 'tasks', { tasks: [{ id: '1', completed: true }], expects: [{ id: '1', rev: 1 }] });

        try {
            await run(engine, 'tasks', { tasks: [{ id: '1', text: 'two' }], expects: [{ id: '1', rev: 1 }] });
            throw new Error('expected a stale rejection');
        } catch (error) {
            const message = (error as Error).message;
            expect(message).toContain('current:');
            expect(message).toContain('"rev":2');
        }
    });
});

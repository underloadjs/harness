// Authority-owned identity leases. These are the reviewer's reproductions: a minted
// id whose published counter must satisfy the CORE's own validator, two lanes that
// can never mint the same identity, and the counter-unit rules that make the
// difference between a valid snapshot and a rejected one.
//
// Cross-references:
//   - ./lane-identity.ts                 - the ledger under test
//   - ../../core/snapshot-validation.ts  - the `nextId > largest id` rule
//   - ../../../Temp/t3/probe-merge.ts    - the probe that proved the old merge invalid

import { describe, expect, it } from 'vitest';
import {
    CHAPTERS_COLLECTION,
    LOCATIONS_COLLECTION,
    PROFILES_COLLECTION,
    TASKS_COLLECTION,
    readRecordsStoreState
} from '../../core';

// The store validator the mint must satisfy (records-engine T3): ONE collection map
// with the store-level counter, so a lane-minted id set has to leave `nextId` one past
// the largest id — the F1 rule the core snapshot reader enforces.
const validateTasks = (items: unknown[], nextId: number) => () => {
    const store = readRecordsStoreState({
        nextId,
        collections: {
            tasks: { definition: TASKS_COLLECTION, items, storeRev: 0, changes: [] },
            chapters: { definition: CHAPTERS_COLLECTION, items: [], storeRev: 0, changes: [] },
            profiles: { definition: PROFILES_COLLECTION, items: [], storeRev: 0, changes: [] },
            locations: { definition: LOCATIONS_COLLECTION, items: [], storeRev: 0, changes: [] }
        }
    });

    // The assertions below were written against the per-store shape; the unified store
    // keeps the store-level counter ABOVE the collections, so the helper hands back the
    // `tasks` collection with the counter folded in — the same facts, one level up.
    return { ...store.collections.tasks, nextId: store.nextId };
};
import {
    ID_SPACES,
    ID_SPACE_CAPS,
    LIVE_RECORD_BOUNDS,
    counterSemanticsOf,
    createIdentityLedger,
    idOf,
    isIdSpace,
    publishCounter,
    publishedPatchOf,
    seedFromCounter
} from './lane-identity';

describe('counter units', () => {
    it('knows which core field each space publishes, because the units differ by one', () => {
        // A record store counts the NEXT id; thread and invocation counters count the
        // LAST used one (the core does `++sequence` before use).
        expect(counterSemanticsOf('record')).toBe('next-id');
        expect(counterSemanticsOf('record')).toBe('next-id');
        expect(counterSemanticsOf('thread')).toBe('last-used');
        expect(counterSemanticsOf('invocation')).toBe('last-used');
        expect(counterSemanticsOf('completedOrder')).toBe('last-used');
        expect(counterSemanticsOf('createdToolCount')).toBe('last-used');

        expect(publishCounter('record', 3)).toBe(4);
        expect(publishCounter('thread', 3)).toBe(3);
        expect(seedFromCounter('record', 4)).toBe(3);
        expect(seedFromCounter('thread', 3)).toBe(3);
        // A brand-new store (nextId 1) seeds the ledger at "nothing issued yet".
        expect(seedFromCounter('record', 1)).toBe(0);
    });

    it('mints only the created-tool budget, and bounds the live records elsewhere (T10 M1)', () => {
        // A mint cap on `thread`/`completedOrder`/`resultSequence` bounded the WRONG quantity:
        // those core numbers are LIVE RECORD counts (roster size, retained results), while a
        // lane burns ids on every spawn lease and ids are never reused. Only the created-tool
        // budget is a count of spends, so only it is a mint bound.
        expect(ID_SPACE_CAPS).toEqual({ createdToolCount: 32 });

        // Where the other three bounds actually live: the fold, against the live counts
        // (./lane-commit.ts CanonicalBounds.maxThreads / maxResults / maxCreatedTools).
        expect(LIVE_RECORD_BOUNDS).toEqual({ thread: 256, completedOrder: 64, resultSequence: 64, createdToolCount: 32 });
    });

    it('names exactly the spaces a replica would otherwise mint itself', () => {
        expect(ID_SPACES).toEqual([
            'thread',
            'invocation',
            'resultSequence',
            'completedOrder',
            'createdToolCount',
            'record'
        ]);
        expect(isIdSpace('record')).toBe(true);
        expect(isIdSpace('nonsense')).toBe(false);
    });
});

describe('createIdentityLedger', () => {
    it('mints ids one past what exists and publishes one past THOSE', () => {
        const ledger = createIdentityLedger({ 'record': 1 });
        const allocated = ledger.allocate('record', 3, 1);

        expect(allocated).toEqual({
            ok: true,
            lease: { space: 'record', start: 2, count: 3, laneEpoch: 1 },
            watermark: 4,
            published: 5
        });
        expect(ledger.publishedOf('record')).toBe(5);
    });

    it('reproduces F1: three minted records leave a nextId the core validator accepts', () => {
        // The old fold published the BLOCK START (10001) while ids 10001-10003 existed,
        // and readTaskStoreState threw
        // "todo state.nextId must be greater than the largest id (10003); received 10001".
        const ledger = createIdentityLedger({ 'record': 10_000 });
        const items: { id: string; text: string; completed: boolean }[] = [];

        for (let taken = 0; taken < 3; taken += 1) {
            const allocated = ledger.allocate('record', 1, 1);

            if (!allocated.ok) throw new Error('unexpected exhaustion');

            items.push({ id: idOf('record', allocated.lease.start), text: `task ${allocated.lease.start}`, completed: false });
        }

        expect(items.map((item) => item.id)).toEqual(['10001', '10002', '10003']);

        const nextId = ledger.publishedOf('record');

        expect(nextId).toBe(10_004);
        // The real core rule, not a restatement of it.
        expect(() => validateTasks(items, nextId)()).not.toThrow();
        expect(validateTasks(items, nextId)().nextId).toBe(10_004);

        // T1: a minted block still has the pre-T1 SHAPE (`{ items, nextId }`), and the
        // core reader completes it rather than guessing - every record starts at content
        // rev 1 and the store has no history until the session writes one. That default
        // is what lets a lane-minted store and a core-written one be the same document.
        expect(validateTasks(items, nextId)()).toEqual({
            // A collection state is its SPEC plus its entries (Decision M), and the
            // counter comes from the STORE (F3) — the helper folds the two together.
            definition: TASKS_COLLECTION,
            items: [
                { id: '10001', text: 'task 10001', completed: false, rev: 1 },
                { id: '10002', text: 'task 10002', completed: false, rev: 1 },
                { id: '10003', text: 'task 10003', completed: false, rev: 1 }
            ],
            nextId: 10_004,
            storeRev: 0,
            changes: []
        });
    });

    it('reproduces F2: two lanes never receive the same thread id or invocation id', () => {
        const ledger = createIdentityLedger({ thread: 1, invocation: 1 });

        const laneA = ledger.allocate('thread', 1, 1);
        const laneB = ledger.allocate('thread', 1, 2);
        const resultA = ledger.allocate('invocation', 1, 1);
        const resultB = ledger.allocate('invocation', 1, 2);

        if (!laneA.ok || !laneB.ok || !resultA.ok || !resultB.ok) throw new Error('unexpected exhaustion');

        expect(idOf('thread', laneA.lease.start)).toBe('thread-2');
        expect(idOf('thread', laneB.lease.start)).toBe('thread-3');
        expect([resultA.lease.start, resultB.lease.start]).toEqual([2, 3]);
        expect(idOf('invocation', resultA.lease.start)).toBe('2');
        // Thread ids keep the core's prefix; every other space is a decimal string.
        expect(idOf('record', 12)).toBe('12');
        expect(idOf('completedOrder', 12)).toBe('12');
    });

    it('hands out one contiguous range, so a lane mints without another round trip', () => {
        const ledger = createIdentityLedger({ thread: 1 });
        const leased = ledger.allocate('thread', 4, 9);

        if (!leased.ok) throw new Error('unexpected exhaustion');

        expect(leased.lease).toEqual({ space: 'thread', start: 2, count: 4, laneEpoch: 9 });
        expect(leased.watermark).toBe(5);
        expect(leased.published).toBe(5);

        // The next lane starts after the whole range, used or not: ids are never
        // reused, and decision D5 approves the gap.
        const nextLane = ledger.allocate('thread', 1, 10);

        if (!nextLane.ok) throw new Error('unexpected exhaustion');

        expect(nextLane.lease.start).toBe(6);
        expect(ledger.watermarkOf('thread')).toBe(6);
    });

    it('refuses to move backwards, so an old snapshot cannot reintroduce a used id', () => {
        const ledger = createIdentityLedger({ 'record': 1 });

        ledger.allocate('record', 2, 1);

        expect(ledger.observe('record', 1)).toEqual({
            code: 'stale-observe',
            // ONE id space for the whole store (F3), so the message names `record`, not a
            // per-collection space like the retired `'record'`.
            message: 'Observed record watermark 1 is behind the ledger at 3; the ledger stays at 3 so no id is reused.'
        });

        // Equal is not stale: it is the authority agreeing with the ledger.
        expect(ledger.observe('record', 3)).toBeUndefined();
        expect(ledger.observe('record', 50)).toBeUndefined();
        expect(ledger.publishedOf('record')).toBe(51);
        expect(ledger.observe('record', -1)).toEqual({
            code: 'stale-observe',
            message: 'Observed record watermark must be a non-negative integer; received -1.'
        });
    });

    it('folds in an id the authority minted itself, so a lane is never handed it', () => {
        const ledger = createIdentityLedger({ thread: 1 });

        // A coordinator-side createThread used id 2.
        expect(ledger.observe('thread', 2)).toBeUndefined();

        const next = ledger.allocate('thread', 1, 3);

        if (!next.ok) throw new Error('unexpected exhaustion');

        expect(next.lease.start).toBe(3);
    });

    it('lets a session respawn its lanes far past the roster bound without burning out identity (T10 M1)', () => {
        // The exact arithmetic of ./lane-host.ts `spawn`: 512 invocation ids plus 32 thread ids
        // reserved per lane start. Idle reclaim (`workerIdleMs`) is the NORMAL lifecycle, so one
        // session re-spawns its lanes many times over a working day.
        const LANE_RUN_ID_LEASE = 512;
        const LANE_THREAD_ID_LEASE = 32;
        const ledger = createIdentityLedger({ thread: 4, invocation: 0 });
        const outcomes: boolean[] = [];

        for (let attempt = 1; attempt <= 40; attempt += 1) {
            outcomes.push(ledger.allocate('invocation', LANE_RUN_ID_LEASE, attempt).ok);
            outcomes.push(ledger.allocate('thread', LANE_THREAD_ID_LEASE, attempt).ok);
        }

        // 40 spawns mint 1280 thread ids - five times MAX_THREAD_RECORDS - while the roster
        // still holds its 4 records. The retired cap refused the EIGHTH spawn ("The thread
        // identity space holds at most 256 ids; 228 are already used and 32 were requested")
        // without creating a single thread, and every turn of that conversation has thrown a
        // ServerRuntimeError ever since.
        expect(outcomes.every((ok) => ok)).toBe(true);
        expect(ledger.watermarkOf('thread')).toBe(4 + 40 * LANE_THREAD_ID_LEASE);
        expect(ledger.publishedOf('thread')).toBe(4 + 40 * LANE_THREAD_ID_LEASE);
        // A lease that mints is still a lease: each spawn received its own contiguous range.
        expect(ledger.watermarkOf('invocation')).toBe(40 * LANE_RUN_ID_LEASE);

        // The bound that matters did not disappear - it lives where the LIVE count is visible
        // (./lane-commit.ts `capacity-threads`, read from the core constant).
        expect(LIVE_RECORD_BOUNDS.thread).toBe(256);
    });

    it('refuses to mint past the created-tool lifetime budget, because that count IS the spend', () => {
        const ledger = createIdentityLedger({ createdToolCount: 31 });

        expect(ledger.allocate('createdToolCount', 1, 1).ok).toBe(true);
        expect(ledger.allocate('createdToolCount', 1, 1)).toEqual({
            ok: false,
            fault: {
                code: 'exhausted',
                message: 'The createdToolCount identity space holds at most 32 ids; 32 are already used and 1 were requested.'
            }
        });
    });

    it('refuses a lease of zero, a fraction, or an unknown space', () => {
        const ledger = createIdentityLedger();

        expect(ledger.allocate('thread', 0, 1)).toEqual({
            ok: false,
            fault: { code: 'invalid-count', message: 'An identity lease must request at least one id; thread requested 0.' }
        });
        expect(ledger.allocate('thread', 1.5, 1)).toEqual({
            ok: false,
            fault: { code: 'invalid-count', message: 'An identity lease must request at least one id; thread requested 1.5.' }
        });
        expect(ledger.allocate('nonsense' as (typeof ID_SPACES)[number], 1, 1)).toEqual({
            ok: false,
            fault: {
                code: 'unknown-space',
                message: `Unknown identity space "nonsense"; mint ids through one of: ${ID_SPACES.join(', ')}.`
            }
        });
    });

    it('reports the counters an applier must publish after a lane wrote', () => {
        const ledger = createIdentityLedger({ 'record': 1, thread: 1 });

        ledger.allocate('record', 2, 1);
        ledger.allocate('thread', 1, 1);

        expect(publishedPatchOf(ledger, ['record', 'thread'])).toEqual({ 'record': 4, thread: 2 });
        expect(ledger.watermarks()).toEqual({ 'record': 3, thread: 2 });
        expect(publishedPatchOf(ledger, [])).toEqual({});
    });

    it('lets a deployment raise a cap for a harness configured with more room', () => {
        const ledger = createIdentityLedger({ createdToolCount: 32 });

        // The default cap is the shipped lifetime budget, so this lane is stopped now.
        expect(ledger.allocate('createdToolCount', 1, 1).ok).toBe(false);

        ledger.withCap('createdToolCount', 64);

        expect(ledger.allocate('createdToolCount', 1, 1).ok).toBe(true);
        expect(ledger.capOf('createdToolCount')).toBe(64);
    });
});

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
import { readTaskStoreState } from '../../core/task';
import {
    ID_SPACES,
    ID_SPACE_CAPS,
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
        expect(counterSemanticsOf('record:todos')).toBe('next-id');
        expect(counterSemanticsOf('record:profiles')).toBe('next-id');
        expect(counterSemanticsOf('thread')).toBe('last-used');
        expect(counterSemanticsOf('invocation')).toBe('last-used');
        expect(counterSemanticsOf('completedOrder')).toBe('last-used');
        expect(counterSemanticsOf('createdToolCount')).toBe('last-used');

        expect(publishCounter('record:todos', 3)).toBe(4);
        expect(publishCounter('thread', 3)).toBe(3);
        expect(seedFromCounter('record:todos', 4)).toBe(3);
        expect(seedFromCounter('thread', 3)).toBe(3);
        // A brand-new store (nextId 1) seeds the ledger at "nothing issued yet".
        expect(seedFromCounter('record:todos', 1)).toBe(0);
    });

    it('caps each space at the bound the core already enforces', () => {
        expect(ID_SPACE_CAPS.thread).toBe(256);
        expect(ID_SPACE_CAPS.completedOrder).toBe(64);
        expect(ID_SPACE_CAPS.resultSequence).toBe(64);
        expect(ID_SPACE_CAPS.createdToolCount).toBe(32);
    });

    it('names exactly the spaces a replica would otherwise mint itself', () => {
        expect(ID_SPACES).toEqual([
            'thread',
            'invocation',
            'resultSequence',
            'completedOrder',
            'createdToolCount',
            'record:todos',
            'record:profiles',
            'record:chapters',
            'record:locations'
        ]);
        expect(isIdSpace('record:todos')).toBe(true);
        expect(isIdSpace('nonsense')).toBe(false);
    });
});

describe('createIdentityLedger', () => {
    it('mints ids one past what exists and publishes one past THOSE', () => {
        const ledger = createIdentityLedger({ 'record:todos': 1 });
        const allocated = ledger.allocate('record:todos', 3, 1);

        expect(allocated).toEqual({
            ok: true,
            lease: { space: 'record:todos', start: 2, count: 3, laneEpoch: 1 },
            watermark: 4,
            published: 5
        });
        expect(ledger.publishedOf('record:todos')).toBe(5);
    });

    it('reproduces F1: three minted records leave a nextId the core validator accepts', () => {
        // The old fold published the BLOCK START (10001) while ids 10001-10003 existed,
        // and readTaskStoreState threw
        // "todo state.nextId must be greater than the largest id (10003); received 10001".
        const ledger = createIdentityLedger({ 'record:todos': 10_000 });
        const items: { id: string; text: string; completed: boolean }[] = [];

        for (let taken = 0; taken < 3; taken += 1) {
            const allocated = ledger.allocate('record:todos', 1, 1);

            if (!allocated.ok) throw new Error('unexpected exhaustion');

            items.push({ id: idOf('record:todos', allocated.lease.start), text: `task ${allocated.lease.start}`, completed: false });
        }

        expect(items.map((item) => item.id)).toEqual(['10001', '10002', '10003']);

        const nextId = ledger.publishedOf('record:todos');

        expect(nextId).toBe(10_004);
        // The real core rule, not a restatement of it.
        expect(() => readTaskStoreState({ items, nextId })).not.toThrow();
        expect(readTaskStoreState({ items, nextId }).nextId).toBe(10_004);
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
        expect(idOf('record:todos', 12)).toBe('12');
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
        const ledger = createIdentityLedger({ 'record:todos': 1 });

        ledger.allocate('record:todos', 2, 1);

        expect(ledger.observe('record:todos', 1)).toEqual({
            code: 'stale-observe',
            message: 'Observed record:todos watermark 1 is behind the ledger at 3; the ledger stays at 3 so no id is reused.'
        });

        // Equal is not stale: it is the authority agreeing with the ledger.
        expect(ledger.observe('record:todos', 3)).toBeUndefined();
        expect(ledger.observe('record:todos', 50)).toBeUndefined();
        expect(ledger.publishedOf('record:todos')).toBe(51);
        expect(ledger.observe('record:todos', -1)).toEqual({
            code: 'stale-observe',
            message: 'Observed record:todos watermark must be a non-negative integer; received -1.'
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

    it('stops at the core bounds instead of minting past what the runtime keeps', () => {
        const ledger = createIdentityLedger({ thread: 255 });

        expect(ledger.capOf('thread')).toBe(256);
        expect(ledger.allocate('thread', 2, 1)).toEqual({
            ok: false,
            fault: {
                code: 'exhausted',
                message: 'The thread identity space holds at most 256 ids; 255 are already used and 2 were requested.'
            }
        });
        // Exactly to the bound is fine, and one past it is not.
        expect((ledger.allocate('thread', 1, 1) as { ok: boolean }).ok).toBe(true);
        expect(ledger.allocate('thread', 1, 1)).toEqual({
            ok: false,
            fault: {
                code: 'exhausted',
                message: 'The thread identity space holds at most 256 ids; 256 are already used and 1 were requested.'
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
        const ledger = createIdentityLedger({ 'record:todos': 1, thread: 1 });

        ledger.allocate('record:todos', 2, 1);
        ledger.allocate('thread', 1, 1);

        expect(publishedPatchOf(ledger, ['record:todos', 'thread'])).toEqual({ 'record:todos': 4, thread: 2 });
        expect(ledger.watermarks()).toEqual({ 'record:todos': 3, thread: 2 });
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

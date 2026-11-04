// Lane memory: faithful transfer, bounded declared windows, and compare-and-set
// against the authority. The cases reproduce T3 finding F4 exactly - including the
// three shapes the reviewer measured being destroyed by a JSON round trip, and the
// lost sibling delete.
//
// Cross-references:
//   - ./lane-memory.ts              - the rules under test
//   - ../../../Temp/t3/probe-memory.ts - the reviewer probe that produced the numbers

import { describe, expect, it } from 'vitest';
import {
    ABSENT_DIGEST,
    applyMemoryWindow,
    applyMemoryWrite,
    assessMemoryAccess,
    captureMemoryWindow,
    classifyMemoryValue,
    digestMemoryValue,
    digestsOfWindow,
    memoryMapFromWindow,
    serializeMemoryValue,
    syncMemoryMap
} from './lane-memory';

describe('classifyMemoryValue', () => {
    it('reports a function and a symbol as un-transferable, with the reason', () => {
        expect(classifyMemoryValue(() => 'live')).toEqual({
            transferable: false,
            kind: 'function',
            reason: 'a function is local to one thread'
        });
        expect(classifyMemoryValue(Symbol('tag'))).toEqual({
            transferable: false,
            kind: 'symbol',
            reason: 'a symbol has no transferred identity'
        });
    });

    it('accepts every shape JSON used to destroy or reject', () => {
        const cyclic: Record<string, unknown> = { name: 'node' };
        cyclic.self = cyclic;

        for (const value of [
            new Date(0),
            new Set([1, 2]),
            new Map([['k', 1]]),
            1n,
            cyclic,
            new Uint8Array([1, 2, 3]),
            { nested: [1, { deep: new Date(1) }] }
        ]) {
            expect(classifyMemoryValue(value)).toEqual({ transferable: true, kind: 'structured-cloneable' });
        }
    });

    it('names a value structuredClone itself refuses instead of throwing', () => {
        // A Proxy over a non-cloneable target is the realistic case: the map holds it,
        // and only the clone attempt knows.
        const refused = { get bad() { throw new Error('getter exploded'); } };

        expect(classifyMemoryValue(refused).transferable).toBe(false);
    });
});

describe('digestMemoryValue', () => {
    it('never confuses a Date with its ISO string, or a Set with an object', () => {
        const date = new Date('2026-11-04T00:00:00.000Z');
        const iso = date.toISOString();

        expect(digestMemoryValue(date)).not.toBe(digestMemoryValue(iso));
        expect(digestMemoryValue(new Set([1, 2]))).not.toBe(digestMemoryValue({ 0: 1, 1: 2 }));
        expect(digestMemoryValue([1, 2])).not.toBe(digestMemoryValue('1,2'));
    });

    it('distinguishes the numbers JSON flattens', () => {
        expect(digestMemoryValue(0)).not.toBe(digestMemoryValue(-0));
        expect(digestMemoryValue(Number.NaN)).toBe(digestMemoryValue(Number.NaN));
        expect(digestMemoryValue(1)).not.toBe(digestMemoryValue(1n));
        expect(digestMemoryValue('1')).not.toBe(digestMemoryValue(1));
    });

    it('survives a cycle and is stable for equal cyclic shapes', () => {
        const left: Record<string, unknown> = { name: 'a' };
        left.self = left;
        const right: Record<string, unknown> = { name: 'a' };
        right.self = right;

        expect(serializeMemoryValue(left)).toBe('o:{"name":s:"a","self":r:<cycle>}');
        expect(digestMemoryValue(left)).toBe(digestMemoryValue(right));

        const different: Record<string, unknown> = { name: 'b' };
        different.self = different;

        expect(digestMemoryValue(left)).not.toBe(digestMemoryValue(different));
    });

    it('ignores key order and collection insertion order, like an equality check should', () => {
        expect(digestMemoryValue({ a: 1, b: 2 })).toBe(digestMemoryValue({ b: 2, a: 1 }));
        expect(digestMemoryValue(new Set([1, 2]))).toBe(digestMemoryValue(new Set([2, 1])));
        expect(digestMemoryValue(new Map([['a', 1], ['b', 2]]))).toBe(digestMemoryValue(new Map([['b', 2], ['a', 1]])));
        // Arrays ARE ordered, so order matters there.
        expect(digestMemoryValue([1, 2])).not.toBe(digestMemoryValue([2, 1]));
    });

    it('carries the serialized length so a collision cannot hide a size change', () => {
        expect(digestMemoryValue('a:b').split(':')[1]).not.toBe(digestMemoryValue('ab').split(':')[1]);
    });

    it('marks absence with its own marker', () => {
        expect(digestMemoryValue(undefined)).toBe(ABSENT_DIGEST);
        expect(ABSENT_DIGEST).toBe('@absent');
    });
});

describe('captureMemoryWindow', () => {
    const authority = {
        'noteSearch.cache': [1, 2],
        'textSummarize.rate': 3,
        handler: () => 'live',
        when: new Date('2026-01-01T00:00:00.000Z')
    };

    it('ships only the declared keys, faithfully, with their digests', () => {
        const window = captureMemoryWindow(authority, ['noteSearch.cache', 'when'], 1);

        expect(window.entries.map((entry) => entry.key)).toEqual(['noteSearch.cache', 'when']);
        expect(window.entries[0].value).toEqual([1, 2]);
        // The Date arrives as a Date - the reviewer saw an ISO string here.
        expect(window.entries[1].value instanceof Date).toBe(true);
        expect((window.entries[1].value as Date).getTime()).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
        expect(window.entries[1].digest).toBe(digestMemoryValue(authority.when));
        expect(window.undeclared).toEqual(['textSummarize.rate', 'handler']);
    });

    it('names an un-transferable key instead of dropping it', () => {
        const window = captureMemoryWindow(authority, ['handler'], 1);

        expect(window.entries).toEqual([
            {
                key: 'handler',
                present: true,
                value: undefined,
                digest: 'untransferable',
                transferable: false,
                reason: 'a function is local to one thread'
            }
        ]);
    });

    it('reports a missing key as absent, and never aliases the authority map', () => {
        const map: Record<string, unknown> = { cache: { hits: 1 } };
        const window = captureMemoryWindow(map, ['cache', 'missing'], 4);

        expect(window.entries[1]).toEqual({ key: 'missing', present: false, value: undefined, digest: ABSENT_DIGEST, transferable: true });

        (window.entries[0].value as { hits: number }).hits = 99;

        expect(map.cache).toEqual({ hits: 1 });
    });
});

describe('the worker-side live map (F4: a sync must reach what the tools read)', () => {
    it('builds a live map from the declared window only', () => {
        const window = captureMemoryWindow({ a: 1, b: new Set([1]) }, ['a', 'b', 'c'], 1);

        expect(memoryMapFromWindow(window)).toEqual({ a: 1, b: new Set([1]) });
    });

    it('writes a sibling key INTO the live map and reports every key it moved', () => {
        const live = memoryMapFromWindow(captureMemoryWindow({ 'lane.key': 'mine' }, ['lane.key', 'sibling.key'], 1));

        const refreshed = captureMemoryWindow({ 'lane.key': 'mine', 'sibling.key': [7] }, ['lane.key', 'sibling.key'], 1);
        const moved = syncMemoryMap(live, refreshed);

        expect(moved).toEqual([
            { key: 'lane.key', status: 'set' },
            { key: 'sibling.key', status: 'set' }
        ]);
        expect(live['sibling.key']).toEqual([7]);
    });

    it('refuses to move an un-transferable key and leaves the live map alone', () => {
        const live: Record<string, unknown> = { handler: 'previous' };
        const refreshed = captureMemoryWindow({ handler: () => 'authority closure' }, ['handler'], 1);

        expect(syncMemoryMap(live, refreshed)).toEqual([{ key: 'handler', status: 'untransferable' }]);
        expect(live.handler).toBe('previous');
    });

    it('reproduces the lost sibling update: a lane that never read a key cannot delete it', () => {
        const authority: Record<string, unknown> = { 'noteSearch.cache': [1, 2] };
        const laneWindow = captureMemoryWindow(authority, [], 1);

        // The lane's projection is empty, and applying its window touches nothing.
        expect(applyMemoryWindow(authority, laneWindow)).toEqual([]);
        expect(authority['noteSearch.cache']).toEqual([1, 2]);
    });
});

describe('applyMemoryWrite', () => {
    it('applies a write that presents the digest it read, and returns the new one', () => {
        const memory: Record<string, unknown> = { cache: [1] };
        const read = digestMemoryValue(memory.cache);

        const applied = applyMemoryWrite(memory, { key: 'cache', expected: read, value: [1, 2] });

        expect(applied).toEqual({ key: 'cache', applied: true, status: 'applied', digest: digestMemoryValue([1, 2]) });
        expect(memory.cache).toEqual([1, 2]);
    });

    it('refuses a stale write and hands back the canonical digest', () => {
        const memory: Record<string, unknown> = { cache: 'sibling value' };

        const stale = applyMemoryWrite(memory, { key: 'cache', expected: digestMemoryValue('lane value'), value: 'lane value' });

        expect(stale.applied).toBe(false);
        expect(stale.status).toBe('stale');
        expect(stale.digest).toBe(digestMemoryValue('sibling value'));
        expect(memory.cache).toBe('sibling value');
    });

    it('refuses a first write when the key appeared in the meantime', () => {
        const memory: Record<string, unknown> = { cache: 'someone else' };

        expect(applyMemoryWrite(memory, { key: 'cache', expected: ABSENT_DIGEST, value: 'mine' }).status).toBe('stale');
    });

    it('names an un-transferable value with the key and the fix', () => {
        const memory: Record<string, unknown> = {};

        const rejected = applyMemoryWrite(memory, { key: 'handler', expected: ABSENT_DIGEST, value: () => 1 });

        expect(rejected.status).toBe('untransferable');
        expect(rejected.reason).toBe(
            'harness.memory["handler"] holds a function (a function is local to one thread); use a cloneable value or run this session with threadExecution "inline".'
        );
        expect('handler' in memory).toBe(false);
    });

    it('refuses a write to a key this lane was never given', () => {
        const memory: Record<string, unknown> = { 'sibling.key': [1] };

        expect(applyMemoryWrite(memory, { key: 'sibling.key', expected: digestMemoryValue([1]), value: [9], declared: false })).toEqual({
            key: 'sibling.key',
            applied: false,
            status: 'undeclared',
            digest: digestMemoryValue([1]),
            reason: 'this lane never read the key'
        });
        expect(memory['sibling.key']).toEqual([1]);
    });

    it('deletes under the same CAS rule', () => {
        const memory: Record<string, unknown> = { cache: [1] };
        const read = digestMemoryValue(memory.cache);

        expect(applyMemoryWrite(memory, { key: 'cache', expected: read, remove: true })).toEqual({
            key: 'cache',
            applied: true,
            status: 'deleted',
            digest: ABSENT_DIGEST
        });
        expect('cache' in memory).toBe(false);
    });

    it('keeps the transferred value detached from the writer', () => {
        const memory: Record<string, unknown> = {};
        const value = { hits: 1 };

        applyMemoryWrite(memory, { key: 'counter', expected: ABSENT_DIGEST, value });
        value.hits = 99;

        expect(memory.counter).toEqual({ hits: 1 });
    });
});

describe('applyMemoryWindow', () => {
    it('applies the lane writes and reports the sibling collision per key', () => {
        const authority: Record<string, unknown> = { mine: 1, theirs: 2 };
        const window = captureMemoryWindow(authority, ['mine', 'theirs'], 1);

        // A sibling moved `theirs` after this lane read it.
        authority.theirs = 99;
        (window.entries[0].value as number);
        const moved = { ...window, entries: window.entries.map((entry) => (entry.key === 'mine' ? { ...entry, value: 5 } : { ...entry, value: 3 })) };

        const outcomes = applyMemoryWindow(authority, moved, digestsOfWindow(window));

        expect(outcomes.map((outcome) => outcome.status)).toEqual(['applied', 'stale']);
        expect(authority.mine).toBe(5);
        expect(authority.theirs).toBe(99);
    });
});

describe('assessMemoryAccess', () => {
    it('collects literal keys and nothing else', () => {
        expect(
            assessMemoryAccess(`
                const stored = harness.memory.get('attempts');
                harness.memory.set("attempts", created);
                if (harness.memory.has('flaky.count')) harness.memory.delete('flaky.count');
                harness.threadMessages(id);
            `)
        ).toEqual({ keys: ['attempts', 'flaky.count'], dynamic: false });
    });

    it('treats a structural or computed reach as dynamic', () => {
        expect(assessMemoryAccess('Object.keys(harness.memory.data)')).toEqual({ keys: [], dynamic: true });
        expect(assessMemoryAccess('harness.memory.keys()')).toEqual({ keys: [], dynamic: true });
        expect(assessMemoryAccess('harness.memory.clear()')).toEqual({ keys: [], dynamic: true });
        expect(assessMemoryAccess('const value = harness.memory[key];')).toEqual({ keys: [], dynamic: true });
        expect(assessMemoryAccess('harness.memory.set(`attempt:${n}`, v)')).toEqual({ keys: [], dynamic: true });
    });

    it('reports a tool that never touches memory as bounded and empty', () => {
        expect(assessMemoryAccess('export const execute = (c) => c.parameters.text.length;')).toEqual({ keys: [], dynamic: false });
    });

    it('is reusable: a stateful scan does not leak matches into the next call', () => {
        const first = assessMemoryAccess("harness.memory.set('a', 1)");
        const second = assessMemoryAccess('no memory here');

        expect(first.keys).toEqual(['a']);
        expect(second).toEqual({ keys: [], dynamic: false });
    });
});

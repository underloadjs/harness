// tools/files/lock — one async mutex per real file (D4: no lost update).
//
// What this pins:
//   - two overlapping holders of one key never run at the same time, and they run in
//     arrival order;
//   - different keys DO run at the same time (the lock is per file, not global — a
//     global lock would serialize an unrelated multi-file batch for no reason);
//   - a throwing body still releases the lock, and a rejected neighbour does not
//     poison the queue behind it;
//   - release is idempotent, so a double release cannot hand one lock to two holders;
//   - `withFileLocks` deduplicates and SORTS, so two overlapping multi-file batches
//     make progress instead of deadlocking, whatever order their entries name;
//   - the key set is empty again once every holder is done (no growth with the number
//     of files the process has ever touched).
//
// No filesystem here: the lock is pure in-process bookkeeping, so the fixtures are
// promises and timers. The file-level consequence is proven in ./edit.test.ts and
// ./write.test.ts, where the race is reproduced against real files.

import { describe, expect, it } from 'vitest';
import { fileLockCount, withFileLock, withFileLocks } from './lock';

// A deferred the test controls, so "overlapping" is forced rather than raced.
const deferred = (): { promise: Promise<void>; release: () => void } => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { promise, release };
};

// Let the microtask/timer queue turn over so a queued acquirer has actually run.
const settle = async (rounds = 3): Promise<void> => {
    for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('withFileLock', () => {
    it('never overlaps two holders of one key and runs them in arrival order', async () => {
        const gate = deferred();
        const order: string[] = [];
        let inside = 0;
        let maxInside = 0;

        const hold = (label: string) =>
            withFileLock('one.txt', async () => {
                inside += 1;
                maxInside = Math.max(maxInside, inside);
                order.push(`enter:${label}`);
                if (label === 'first') await gate.promise;
                inside -= 1;
                order.push(`exit:${label}`);
            });

        const first = hold('first');
        await settle(1);
        const second = hold('second');
        await settle(1);

        // The second caller is queued, not running: the first still holds the lock.
        expect(order).toEqual(['enter:first']);
        expect(maxInside).toBe(1);

        gate.release();
        await Promise.all([first, second]);

        expect(order).toEqual(['enter:first', 'exit:first', 'enter:second', 'exit:second']);
        expect(maxInside).toBe(1);
    });

    it('lets different keys run at the same time', async () => {
        const gate = deferred();
        let enteredSecond = false;

        const first = withFileLock('a.txt', async () => {
            // Nothing about 'b.txt' should block while this is held.
            void withFileLock('b.txt', async () => {
                enteredSecond = true;
                await gate.promise;
            });
            await settle(2);
            expect(enteredSecond).toBe(true);
            gate.release();
        });

        await first;
    });

    it('releases when the body throws, and a failure does not poison the queue', async () => {
        // The expectation is attached IMMEDIATELY: a rejection that goes unobserved
        // while the test waits would surface as an unhandled rejection, and the point
        // of this test is that the failure stays the CALLER's failure rather than
        // leaking into the chain behind it.
        const failing = expect(
            withFileLock('throw.txt', async () => {
                throw new Error('boom');
            })
        ).rejects.toThrow('boom');

        await settle(1);
        const queued = withFileLock('throw.txt', async () => 'after');

        await failing;
        await expect(queued).resolves.toBe('after');
        expect(fileLockCount()).toBe(0);
    });

    it('hands the lock to exactly one holder at a time across a long queue', async () => {
        // A release that fired twice would resolve the chain twice and let two holders
        // in at once; a release that never fired would strand everyone behind it. Both
        // show up here: 8 queued callers, never more than one inside, all 8 finishing.
        let inside = 0;
        let maxInside = 0;

        const runs = Array.from({ length: 8 }, (_, index) =>
            withFileLock('queue.txt', async () => {
                inside += 1;
                maxInside = Math.max(maxInside, inside);
                await settle(1);
                inside -= 1;
                return index;
            })
        );

        await expect(Promise.all(runs)).resolves.toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
        expect(maxInside).toBe(1);
        expect(fileLockCount()).toBe(0);
    });

    it('drops its bookkeeping once every holder is done', async () => {
        const before = fileLockCount();

        await Promise.all([
            withFileLock('leak-a.txt', async () => 1),
            withFileLock('leak-b.txt', async () => 2),
            withFileLock('leak-a.txt', async () => 3)
        ]);

        expect(fileLockCount()).toBe(before);
    });
});

describe('withFileLocks', () => {
    it('deduplicates repeated keys and holds every distinct one', async () => {
        const held: string[] = [];

        const result = await withFileLocks(['b.txt', 'a.txt', 'b.txt'], async () => {
            held.push('inside');
            return 'ok';
        });

        expect(result).toBe('ok');
        expect(held).toEqual(['inside']);
        expect(fileLockCount()).toBe(0);
    });

    it('cannot deadlock when two batches take the same locks in opposite orders', async () => {
        // The reason the sort exists. Without it, batch 1 could hold x and wait for y
        // while batch 2 holds y and waits for x, forever.
        const run = (first: string, second: string) =>
            withFileLocks([first, second], async () => {
                // Yield inside the critical section so the other batch gets its turn
                // at whichever lock is still free.
                await settle(2);
                return `${first}+${second}`;
            });

        const a = run('x.txt', 'y.txt');
        const b = run('y.txt', 'x.txt');

        await expect(Promise.race([Promise.all([a, b]), settle(40).then(() => 'TIMEOUT')])).resolves.not.toBe(
            'TIMEOUT'
        );
        await expect(a).resolves.toBe('x.txt+y.txt');
        await expect(b).resolves.toBe('y.txt+x.txt');
        expect(fileLockCount()).toBe(0);
    });

    it('serializes two batches that share one file', async () => {
        const log: string[] = [];

        const batch = (shared: string, own: string, label: string) =>
            withFileLocks([shared, own], async () => {
                log.push(`enter:${label}`);
                await settle(2);
                log.push(`exit:${label}`);
            });

        await Promise.all([
            batch('shared.txt', 'one.txt', 'A'),
            batch('shared.txt', 'two.txt', 'B')
        ]);

        // Whichever arrives first fully finishes before the other starts, because they
        // share one lock — the property is "no interleaving", not a fixed order (the
        // arrival order of two promises created in the same tick is not contractual).
        const label = (line: string): string => line.slice(line.indexOf(':') + 1);
        const phase = (line: string): string => line.slice(0, line.indexOf(':'));

        expect(log).toHaveLength(4);
        expect(log.map(phase)).toEqual(['enter', 'exit', 'enter', 'exit']);
        expect(label(log[1])).toBe(label(log[0]));
        expect(label(log[3])).toBe(label(log[2]));
        expect(new Set([label(log[0]), label(log[2])])).toEqual(new Set(['A', 'B']));
    });
});

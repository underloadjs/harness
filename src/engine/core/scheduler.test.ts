// Scheduler task-outcome contract + the R4 wake contract.
//
// The board must distinguish a successful `undefined` result from a tool that
// threw/rejected `undefined`. JavaScript makes those payloads identical, so the
// settlement records `failed` independently of `error`. These tests pin that for
// natural settlement and for a late failure after cancellation.
//
// The second block pins what R4 left behind once the recurring background wake
// became the `async-ping` plugin's job: the board arms NO timer, and `wake()` is
// the only way anything is notified — grouped per scheduler agent, with that
// agent's exact pending board, and silent for a board with nothing on it.

import { describe, expect, it, vi } from 'vitest';
import { createTaskScheduler } from './scheduler';
import type { ScheduledTask, TaskScheduler } from './scheduler';

const createScheduler = (): TaskScheduler =>
    createTaskScheduler({
        onWake: () => undefined
    });

const schedule = <TResult>(
    scheduler: TaskScheduler,
    callId: string,
    run: () => Promise<TResult>
): Promise<ScheduledTask<TResult>> =>
    new Promise((resolve) => {
        scheduler.schedule({
            scope: 'scope',
            agent: 'agent',
            callId,
            name: 'tool',
            run,
            onSettled: (task) => resolve(task as ScheduledTask<TResult>)
        });
    });

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((success, failure) => {
        resolve = success;
        reject = failure;
    });
    return { promise, resolve, reject };
};

describe('task scheduler failure payload', () => {
    it('records a successful undefined result as not failed', async () => {
        const scheduler = createScheduler();

        const settled = schedule(scheduler, 'c1', async () => undefined);
        const task = await settled;
        scheduler.dispose();

        expect(task.status).toBe('completed');
        expect(task.failed).toBe(false);
        expect(task.error).toBeUndefined();
        expect(task.result).toBeUndefined();
    });

    it('records a synchronous throw of undefined as failed', async () => {
        const scheduler = createScheduler();

        const settled = schedule(scheduler, 'c2', async () => {
            throw undefined;
        });
        const task = await settled;
        scheduler.dispose();

        expect(task.status).toBe('completed');
        expect(task.failed).toBe(true);
        expect(task.error).toBeUndefined();
        expect(task.result).toBeUndefined();
    });

    it('records a promise rejection with undefined as failed', async () => {
        const scheduler = createScheduler();

        const settled = schedule(scheduler, 'c3', () => Promise.reject(undefined));
        const task = await settled;
        scheduler.dispose();

        expect(task.status).toBe('completed');
        expect(task.failed).toBe(true);
        expect(task.error).toBeUndefined();
    });

    it('keeps a late undefined failure inspectable after cancellation', async () => {
        const scheduler = createScheduler();
        const gate = deferred<never>();

        scheduler.schedule({
            scope: 'scope',
            agent: 'agent',
            callId: 'c4',
            name: 'tool',
            run: () => gate.promise,
            onSettled: () => undefined
        });

        const task = scheduler.find('scope', 'c4');
        expect(task).toBeDefined();
        scheduler.cancel('scope', 'c4');
        gate.reject(undefined);

        await task?.promise;

        expect(task?.status).toBe('cancelled');
        expect(task?.failed).toBe(true);
        expect(task?.error).toBeUndefined();
        scheduler.dispose();
    });
});

// ---------------------------------------------------------------------------
// R4 — the board owns NO timer; `wake()` is the only wake path
// ---------------------------------------------------------------------------
//
// The recurring background wake moved into the shipped `async-ping` plugin
// (../plugins/async-ping.plugin.ts). Two halves of that contract live here:
//   1. scheduling work must not arm anything (a stray board timer would resurrect
//      the heartbeat the plugin now owns);
//   2. `wake()` must group the pending set per scheduler agent and hand each agent
//      exactly its own board, because that payload IS the `wakeup` frame's `pending`
//      list — and a wake for an agent with nothing pending must not happen at all
//      (it would cost that agent a model turn to be told about an empty board).

type Wake = { agent: string; pending: { callId: string; name: string; elapsedMs: number }[] };

const createWakingScheduler = (
    wakes: Wake[],
    clock: { value: number } = { value: 1_000 }
): TaskScheduler =>
    createTaskScheduler({
        now: () => clock.value,
        onWake: (agent, pending) => {
            wakes.push({ agent, pending: pending.map((entry) => ({ ...entry })) });
        }
    });

// A held task: the gate never settles, so the board stays pending for the whole test.
const hold = (scheduler: TaskScheduler, agent: string, callId: string, name: string): void => {
    scheduler.schedule({
        scope: `scope-${agent}`,
        agent,
        callId,
        name,
        run: () => new Promise<string>(() => undefined),
        onSettled: () => undefined
    });
};

describe('background wake contract', () => {
    it('arms no timer of its own while work is pending', async () => {
        vi.useFakeTimers();
        try {
            const wakes: Wake[] = [];
            const scheduler = createWakingScheduler(wakes);

            hold(scheduler, 'writer', 'a1', 'slowAlpha');

            // The old board armed one interval here. Nothing may be waiting now, and
            // letting the whole (faked) 10 minutes pass must produce no wake.
            expect(vi.getTimerCount()).toBe(0);
            vi.advanceTimersByTime(600_000 * 3);
            expect(wakes).toEqual([]);

            scheduler.dispose();
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('wakes each pending agent once with exactly its own board', () => {
        const wakes: Wake[] = [];
        const clock = { value: 1_000 };
        const scheduler = createWakingScheduler(wakes, clock);

        hold(scheduler, 'writer', 'a1', 'slowAlpha');
        hold(scheduler, 'writer', 'b1', 'slowBeta');
        hold(scheduler, 'thread:thread-1', 'c1', 'slowGamma');

        // Elapsed is measured against the injected clock, so the numbers below are exact.
        clock.value = 601_000;
        scheduler.wake();

        expect(wakes).toEqual([
            {
                agent: 'writer',
                pending: [
                    { callId: 'a1', name: 'slowAlpha', elapsedMs: 600_000 },
                    { callId: 'b1', name: 'slowBeta', elapsedMs: 600_000 }
                ]
            },
            {
                agent: 'thread:thread-1',
                pending: [{ callId: 'c1', name: 'slowGamma', elapsedMs: 600_000 }]
            }
        ]);

        scheduler.dispose();
    });

    it('narrows a wake to the agent the plugin asked for', () => {
        const wakes: Wake[] = [];
        const scheduler = createWakingScheduler(wakes);

        hold(scheduler, 'writer', 'a1', 'slowAlpha');
        hold(scheduler, 'thread:thread-1', 'c1', 'slowGamma');

        scheduler.wake('thread:thread-1');

        // The other board keeps its work but is not disturbed by this ping.
        expect(wakes).toEqual([
            {
                agent: 'thread:thread-1',
                pending: [{ callId: 'c1', name: 'slowGamma', elapsedMs: 0 }]
            }
        ]);
        expect(scheduler.pending('writer').map((task) => task.callId)).toEqual(['a1']);

        scheduler.dispose();
    });

    it('never wakes an agent whose board is empty', () => {
        const wakes: Wake[] = [];
        const scheduler = createWakingScheduler(wakes);

        // Unknown identity, and a board that drained — both must stay silent.
        scheduler.wake('nobody');
        hold(scheduler, 'writer', 'a1', 'slowAlpha');
        scheduler.cancel('scope-writer', 'a1');
        scheduler.wake();
        scheduler.wake('writer');

        expect(wakes).toEqual([]);
        expect(scheduler.pendingList()).toEqual([]);

        scheduler.dispose();
    });

    it('wakes nobody after dispose', () => {
        const wakes: Wake[] = [];
        const scheduler = createWakingScheduler(wakes);

        hold(scheduler, 'writer', 'a1', 'slowAlpha');
        scheduler.dispose();
        scheduler.wake();

        // Teardown released everything, so a late plugin tick finds an empty board.
        expect(wakes).toEqual([]);
        expect(scheduler.pending()).toEqual([]);
    });
});

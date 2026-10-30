// Scheduler task-outcome contract.
//
// The board must distinguish a successful `undefined` result from a tool that
// threw/rejected `undefined`. JavaScript makes those payloads identical, so the
// settlement records `failed` independently of `error`. These tests pin that for
// natural settlement and for a late failure after cancellation.

import { describe, expect, it } from 'vitest';
import { createTaskScheduler } from './scheduler';
import type { ScheduledTask, TaskScheduler } from './scheduler';

const createScheduler = (): TaskScheduler =>
    createTaskScheduler({
        wakeIntervalMs: 60_000,
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

// Background task scheduler (T3).
//
// The harness uses this board to run tool calls CONCURRENTLY and to keep the run
// open while any of them is still in flight. It is deliberately small and
// transport-free:
//
//   - schedule() starts a promise-backed task immediately and records when it
//     started, so `pendingList()` can report elapsed time;
//   - every task owns an AbortController linked to the calling run's signal, so
//     one call can be cancelled without touching its siblings and a run abort
//     reaches all of them;
//   - a task settles EXACTLY ONCE. `cancel()` marks it cancelled and notifies the
//     owner synchronously; a later resolution is data on a dead task and is
//     ignored (the implementation cannot be preempted, so this is the only
//     honest way to release it);
//   - a single timer emits the recurring wake while anything is pending, and it
//     is cleared as soon as the board is empty or the board is disposed.
//
// Why not `worker_threads`: a tool is an arbitrary JavaScript closure captured by
// the host (file access, fetch, a harness's own `ctx.run`). It cannot be moved to
// a worker, and the point of the feature is that those ordinary closures stop
// blocking the conversation. Concurrency here is async scheduling, not parallel
// CPU execution.
//
// Cross-references:
//   - ../harness.ts          — owns one board per harness and delivers outcomes
//   - ../types               — HarnessPendingTool, the wire view of a task
//   - ./agent.ts             — serializes model turns; this module never does

import type { HarnessPendingTool } from '../types';
import { HarnessError } from '../util';

// A task's lifecycle. Only `pending` appears in the public pending list.
//   pending   — running, cancelable, reported
//   completed — settled naturally (result OR error are both "finished work")
//   cancelled — released by toolCancel; owner is notified, late result ignored
//   abandoned — released by a run/board teardown; nobody is notified
export type ScheduledTaskStatus = 'pending' | 'completed' | 'cancelled' | 'abandoned';

export type ScheduledTask<TResult = unknown> = {
    // Unique within the board: scope + call id. `scope` is the owning run, so two
    // agents (or two concurrent runs) may legally use the same model call id.
    id: string;
    scope: string;
    agent: string;
    callId: string;
    name: string;
    // Epoch milliseconds at launch. elapsedMs is `now - startedAt`.
    startedAt: number;
    controller: AbortController;
    status: ScheduledTaskStatus;
    result?: TResult;
    // True when the implementation threw or rejected. This is INDEPENDENT of
    // `error` because JavaScript may throw `undefined`; consumers must never infer
    // success from `error === undefined` (a successful `undefined` result looks
    // identical otherwise).
    failed: boolean;
    error?: unknown;
    // Resolves when the underlying function settles. Callers never await this to
    // decide a run is finished (the board is the source of truth); it exists for
    // tests and for an owner that explicitly wants the raw promise.
    promise: Promise<void>;
    // INTERNAL: settlement callback + parent-abort detach, kept on the record so
    // cancel() can notify without closing over the schedule() call. Underscore
    // names are not part of the wire view and are never serialized.
    _notify?: (task: ScheduledTask) => void;
    _detach?: () => void;
};

export type ScheduleSpec<TResult> = {
    // Owning run id (the harness uses a monotonically increasing number).
    scope: string;
    agent: string;
    callId: string;
    name: string;
    // The calling run's signal. The task's own controller aborts when this does.
    parent?: AbortSignal;
    // The work. It receives the task's own signal: a tool sees this one, so a
    // targeted cancel is observable while the run signal stays shared.
    run: (signal: AbortSignal) => Promise<TResult>;
    // Called exactly once for a natural settlement or a targeted cancel. NOT
    // called for abandonScope/dispose: those mean "nobody wants the answer".
    onSettled: (task: ScheduledTask<TResult>) => void;
};

export type TaskScheduler = {
    readonly wakeIntervalMs: number;
    schedule: <TResult>(spec: ScheduleSpec<TResult>) => ScheduledTask<TResult>;
    // Every pending task, optionally narrowed to one agent (the public views and
    // the `toolCancel` declaration are agent-scoped).
    pending: (agent?: string) => ScheduledTask[];
    // Pending tasks owned by exactly one run. `toolCancel` is scoped this way so
    // a caller can never cancel a sibling run's work.
    pendingOfScope: (scope: string) => ScheduledTask[];
    // The wire view. `now` is injectable so tests can pin elapsed values.
    pendingList: (agent?: string, now?: number) => HarnessPendingTool[];
    // Lookups used by toolCancel. Only pending tasks are returned.
    find: (scope: string, callId: string) => ScheduledTask | undefined;
    cancel: (scope: string, callId: string) => ScheduledTask | undefined;
    // Release every task of one run without notifying: used when a run fails,
    // rolls back, exhausts its iteration budget, or is cancelled.
    abandonScope: (scope: string) => void;
    dispose: () => void;
};

export type TaskSchedulerOptions = {
    // Recurring wake interval. 600000 (10 minutes) is the harness default.
    wakeIntervalMs: number;
    // Emitted once per agent with pending work on every tick. The harness routes
    // this through its per-agent mailbox, so it is never called concurrently
    // with a completion delivery for the same agent.
    onWake: (agent: string, pending: HarnessPendingTool[]) => void;
    // Clock injection for deterministic tests. Defaults to Date.now.
    now?: () => number;
};

// Build one scheduler. A harness owns exactly one, so wake timers are per
// harness and `reset()`/dispose never leaks a global interval.
export const createTaskScheduler = (options: TaskSchedulerOptions): TaskScheduler => {
    const now = options.now ?? (() => Date.now());
    const tasks = new Map<string, ScheduledTask>();

    // Timer handle for the recurring wake. Undefined = no timer running. One
    // interval for the whole board (grouped per agent on each tick) rather than
    // one per task keeps a burst of calls from multiplying timers.
    let timer: ReturnType<typeof setInterval> | undefined;

    const stopTimer = (): void => {
        if (timer === undefined) return;
        clearInterval(timer);
        timer = undefined;
    };

    // Debounce a pending task by agent so the public list is ordered by launch
    // time (insertion order after filtering), not map/string order.
    const pendingOf = (agent?: string): ScheduledTask[] =>
        [...tasks.values()].filter(
            (task) => task.status === 'pending' && (agent === undefined || task.agent === agent)
        );

    const wake = (): void => {
        // Group by agent so `wakeup` names one agent and carries only its calls.
        const agents = new Set<string>();
        for (const task of tasks.values()) {
            if (task.status === 'pending') agents.add(task.agent);
        }

        for (const agent of agents) {
            options.onWake(agent, pendingList(agent));
        }

        // A tick that drained everything (or a board disposed mid-tick) stops
        // the timer; there is no reason to keep an empty interval alive.
        if (pendingOf().length === 0) stopTimer();
    };

    const ensureTimer = (): void => {
        if (timer !== undefined) return;
        timer = setInterval(wake, options.wakeIntervalMs);
        // Never hold a Node process open for a heartbeat: a pending run already
        // keeps its own promise alive; a stray timer would keep a CLI alive after
        // the caller stopped caring.
        (timer as { unref?: () => void }).unref?.();
    };

    const pendingList = (agent?: string, at: number = now()): HarnessPendingTool[] =>
        pendingOf(agent)
            // Stable launch order. `tasks` preserves insertion order, so the sort
            // only matters if a future caller re-inserts; keep it explicit.
            .sort((left, right) => left.startedAt - right.startedAt)
            .map((task) => ({
                callId: task.callId,
                name: task.name,
                elapsedMs: Math.max(0, at - task.startedAt)
            }));

    const remove = (task: ScheduledTask): void => {
        tasks.delete(task.id);
        if (tasks.size === 0) stopTimer();
    };

    const schedule = <TResult>(spec: ScheduleSpec<TResult>): ScheduledTask<TResult> => {
        const id = `${spec.scope}\u0000${spec.callId}`;

        // Defensive uniqueness: a second task under the same id would silently
        // alias the first (cancel/pending views key on it, and its late result
        // could be attributed to the wrong call). The harness validates tool-call
        // ids before launching; this is the board's own guarantee for any caller.
        if (tasks.has(id)) {
            throw new HarnessError(
                `Tool call id "${spec.callId}" is already running in this run; refusing to overwrite an in-flight task.`
            );
        }

        const controller = new AbortController();

        // Forward a run-level abort into the per-call controller. The listener is
        // removed on settle so a long run with many calls does not accumulate one
        // forwarding listener per finished tool.
        const forwardAbort = (): void => controller.abort(spec.parent?.reason);
        if (spec.parent) {
            if (spec.parent.aborted) forwardAbort();
            else spec.parent.addEventListener('abort', forwardAbort, { once: true });
        }

        const task: ScheduledTask<TResult> = {
            id,
            scope: spec.scope,
            agent: spec.agent,
            callId: spec.callId,
            name: spec.name,
            startedAt: now(),
            controller,
            status: 'pending',
            failed: false,
            promise: Promise.resolve()
        };

        // Store the pieces cancel() needs. They close over `spec`, which the board
        // must not keep alive after settlement, so both are cleared in settle().
        const record = task as ScheduledTask;
        record._notify = spec.onSettled as (value: ScheduledTask) => void;
        record._detach = () => {
            if (spec.parent) spec.parent.removeEventListener('abort', forwardAbort);
        };

        tasks.set(id, record);
        ensureTimer();

        const settle = (
            status: 'completed',
            result: TResult | undefined,
            error: unknown,
            failed: boolean
        ): void => {
            task.status = status;
            task.result = result;
            task.failed = failed;
            task.error = error;
            record._detach?.();
            record._detach = undefined;
            remove(record);
            // Notify AFTER the task is out of the pending map: a delivery handler
            // that reads the pending list must never see the call it is
            // delivering as still pending.
            const notify = record._notify;
            record._notify = undefined;
            notify?.(record);
        };

        task.promise = (async () => {
            try {
                // A call launched into an already-aborted run must not start. The
                // harness checks this too; the board keeps that guarantee even for
                // a future direct caller.
                if (controller.signal.aborted) throw controller.signal.reason;
                const result = await spec.run(controller.signal);

                // Cancelled/abandoned while running: the result is data on a dead
                // task. Keep it for inspection but never notify twice.
                if (task.status !== 'pending') {
                    task.result = result;
                    return;
                }

                settle('completed', result, undefined, false);
            } catch (error) {
                // Keep the late failure inspectable too. `failed` is false for a
                // successful `undefined` result, so this flag is the only honest
                // record when the thrown value itself is undefined.
                task.failed = true;
                if (task.status !== 'pending') {
                    task.error = error;
                    return;
                }

                // A thrown tool is still COMPLETED work: the delivery layer turns
                // it into a failed tool result the model can read. `failed` records
                // the outcome independently of the thrown payload.
                settle('completed', undefined, error, true);
            }
        })();

        return task;
    };

    // Find a pending task by scope + call id. Completed tasks are removed from the
    // map, so a caller can never "cancel" something that already settled.
    const find = (scope: string, callId: string): ScheduledTask | undefined => {
        const task = tasks.get(`${scope}\u0000${callId}`);
        return task?.status === 'pending' ? task : undefined;
    };

    const cancel = (scope: string, callId: string): ScheduledTask | undefined => {
        const task = find(scope, callId);
        if (!task) return undefined;

        // Logical release FIRST: mark it dead so a late resolution cannot notify,
        // then remove it from the pending view, then abort the signal (a tool may
        // throw synchronously on abort and that must not look like a natural
        // settlement). Notify last so the owner sees a consistent board.
        task.status = 'cancelled';
        if (task.controller.signal.aborted === false) task.controller.abort();
        task._detach?.();
        task._detach = undefined;
        remove(task);
        const notify = task._notify;
        task._notify = undefined;
        notify?.(task);
        return task;
    };

    const abandonScope = (scope: string): void => {
        for (const task of tasks.values()) {
            if (task.scope !== scope) continue;
            // No onSettled: the run is gone (failed/rolled back/exhausted), and a
            // synthetic result would mutate a transcript nobody will read.
            task.status = 'abandoned';
            if (!task.controller.signal.aborted) task.controller.abort();
            task._detach?.();
            task._notify = undefined;
            tasks.delete(task.id);
        }
        if (tasks.size === 0) stopTimer();
    };

    const dispose = (): void => {
        stopTimer();
        for (const task of tasks.values()) {
            task.status = 'abandoned';
            if (!task.controller.signal.aborted) task.controller.abort();
            task._detach?.();
            task._notify = undefined;
        }
        tasks.clear();
    };

    return {
        wakeIntervalMs: options.wakeIntervalMs,
        schedule,
        pending: (agent?: string) => pendingOf(agent),
        pendingOfScope: (scope: string) =>
            pendingOf().filter((task) => task.scope === scope),
        pendingList,
        find,
        cancel,
        abandonScope,
        dispose
    };
};

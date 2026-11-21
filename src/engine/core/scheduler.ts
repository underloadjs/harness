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
//   - the board owns NO timer (R4). The recurring "you still have work running"
//     heartbeat used to be a `setInterval` armed here; it is now a policy of the
//     shipped `async-ping` plugin, which calls `wake()` on its own schedule
//     through `api.async.wake()`. The board only answers "who is pending right
//     now" and "notify them now".
//
// Why not `worker_threads`: a tool is an arbitrary JavaScript closure captured by
// the host (file access, fetch, a harness's own `ctx.run`). It cannot be moved to
// a worker, and the point of the feature is that those ordinary closures stop
// blocking the conversation. Concurrency here is async scheduling, not parallel
// CPU execution.
//
// Cross-references:
//   - ../harness.ts               — owns one board per harness and delivers outcomes
//   - ../types                    — HarnessPendingTool, the wire view of a task
//   - ./agent.ts                    — serializes model turns; this module never does
//   - ../plugins/async-ping.plugin.ts — the ONLY timer for the background wake (R4);
//                                       it drives `wake()` and reads `pendingList()`

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
    schedule: <TResult>(spec: ScheduleSpec<TResult>) => ScheduledTask<TResult>;
    // Every pending task, optionally narrowed to one agent (the public views and
    // the `toolCancel` declaration are agent-scoped).
    pending: (agent?: string) => ScheduledTask[];
    // Pending tasks owned by exactly one run. `toolCancel` is scoped this way so
    // a caller can never cancel a sibling run's work.
    pendingOfScope: (scope: string) => ScheduledTask[];
    // The wire view. `now` is injectable so tests can pin elapsed values.
    pendingList: (agent?: string, now?: number) => HarnessPendingTool[];
    // Trigger a wake NOW, optionally narrowed to one agent (R4). This exists for the
    // plugin framework: `api.async.wake()` lets the shipped `async-ping` plugin (or any
    // host plugin) drive the heartbeat policy — its own interval, backoff, or an
    // event-driven wake — instead of the board owning a fixed timer. The board stays
    // transport-free: it only answers "who is pending" and calls `onWake` once per
    // pending agent. A narrowed wake for an agent with nothing pending is a no-op — a
    // wake claims "you have work waiting", and a false claim would cost a model turn.
    wake: (agent?: string) => void;
    // Lookups used by toolCancel. Only pending tasks are returned.
    find: (scope: string, callId: string) => ScheduledTask | undefined;
    cancel: (scope: string, callId: string) => ScheduledTask | undefined;
    // Release every task of one run without notifying: used when a run fails,
    // rolls back, exhausts its iteration budget, or is cancelled.
    abandonScope: (scope: string) => void;
    dispose: () => void;
};

export type TaskSchedulerOptions = {
    // Called once per agent that HAS pending work, on every `wake()` call. The harness
    // routes this through its per-agent mailbox, so it is never called concurrently
    // with a completion delivery for the same agent. There is no interval option: the
    // board never schedules anything itself, it only wakes when asked (R4).
    onWake: (agent: string, pending: HarnessPendingTool[]) => void;
    // Clock injection for deterministic tests. Defaults to Date.now.
    now?: () => number;
};

// Build one scheduler. A harness owns exactly one, so the wake callback (and the
// per-harness plugin timers that drive it) can never reach another harness's board.
export const createTaskScheduler = (options: TaskSchedulerOptions): TaskScheduler => {
    const now = options.now ?? (() => Date.now());
    const tasks = new Map<string, ScheduledTask>();

    // Timer handle removed in R4: the recurring wake is the `async-ping` plugin's job
    // (../plugins/async-ping.plugin.ts), and it drives this board through `wake()`.
    // The board therefore holds NO handle and has nothing to stop on teardown.

    // Debounce a pending task by agent so the public list is ordered by launch
    // time (insertion order after filtering), not map/string order.
    const pendingOf = (agent?: string): ScheduledTask[] =>
        [...tasks.values()].filter(
            (task) => task.status === 'pending' && (agent === undefined || task.agent === agent)
        );

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

    // One wake per agent. `agents` is the already-decided set of scheduler identities
    // to notify; an agent with nothing pending is skipped, so a wake never claims
    // work that is not there (each false wake costs the agent a model turn).
    const wakeAgents = (agents: Iterable<string>): void => {
        for (const agent of agents) {
            if (pendingOf(agent).length === 0) continue;
            options.onWake(agent, pendingList(agent));
        }
    };

    const remove = (task: ScheduledTask): void => {
        tasks.delete(task.id);
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
    };

    // Teardown: every task is released and the board is empty. Nothing else is
    // required — R4 removed the board's own interval, so there is no handle to clear
    // here. A wake after dispose is therefore a no-op (the pending set is empty),
    // which is what keeps a late plugin tick from waking a dead board.
    const dispose = (): void => {
        for (const task of tasks.values()) {
            task.status = 'abandoned';
            if (!task.controller.signal.aborted) task.controller.abort();
            task._detach?.();
            task._notify = undefined;
        }
        tasks.clear();
    };

    // Public, plugin-facing wake. `agent` narrows to one conversation's board; an
    // unknown or drained agent changes nothing. Called with no argument it wakes every
    // agent that has pending work right now — the grouping the old board timer did on
    // each tick — so a plugin that wants a board-wide heartbeat needs one call, while
    // a plugin that pings per agent (async-ping, R4) never disturbs another board.
    // The pending set is read LIVE, so a wake racing a drain simply finds nothing.
    const wake = (agent?: string): void => {
        if (agent === undefined) {
            const agents = new Set<string>();
            for (const task of tasks.values()) {
                if (task.status === 'pending') agents.add(task.agent);
            }

            wakeAgents(agents);
            return;
        }

        wakeAgents([agent]);
    };

    return {
        schedule,
        pending: (agent?: string) => pendingOf(agent),
        pendingOfScope: (scope: string) =>
            pendingOf().filter((task) => task.scope === scope),
        pendingList,
        wake,
        find,
        cancel,
        abandonScope,
        dispose
    };
};

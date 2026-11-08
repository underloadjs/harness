// Background Ping — the recurring wake for background tool work (R4).
//
// WHAT THIS PLUGIN IS
// -------------------
// Before R4 the wake was a hardcoded `setInterval` inside the task board
// (core/scheduler.ts): while ANY tool call was pending, one board-wide timer fired
// every `wakeIntervalMs` (default 600000 ms = 10 minutes) and re-requested each
// agent that had work, so a paused agent could notice a hung call and `toolCancel`
// it. That behaviour now lives HERE — the core loop owns no timer for it.
//
// HOW IT WORKS
// ------------
//   - `async.pending` (a call joined an agent's board)  → arm ONE timer for that
//     scheduler identity, if it does not already have one. Per agent, not per call:
//     a burst of ten calls must stay one timer, exactly like the old board timer.
//     The event is emitted BEFORE `scheduler.schedule()` puts the task on the board
//     (harness.ts `launchToolCall`: the task starts immediately and may settle
//     synchronously), so the FIRST call of a turn is not yet visible through
//     `api.async.pending()`. The payload is the authoritative "work was announced"
//     signal at that point; reading the live board there would never arm a timer for a
//     single-call turn.
//   - each tick (a one-shot that reschedules itself, so the cadence is decided by
//     live state every time): re-read the board. Still pending → `api.async.wake()`
//     (the harness's per-agent mailbox emits the `wakeup` frame and gives the run
//     its turn) and re-arm. Empty already → stop; nothing is reported for work that
//     finished between ticks.
//   - `async.drained` (that agent's board became empty)  → clear its timer, so a
//     drained conversation never keeps a heartbeat alive.
//   - `run.failed` / `thread.stopped` / `thread.deleted` → sweep timers whose board is
//     now empty, and (for a thread) release that thread's own `thread:<id>` timer.
//     Teardowns that release work WITHOUT a delivery (a run abort or a rollback
//     releases the whole scope silently through `abandonScope`) never reach the
//     delivery path, so no `async.drained` fires for them.
//   - `harness.dispose` → clear everything. LIVE since T1.6: `harness()` exposes
//     `dispose()` and emits this exactly once on a settled boundary (`emitDispose` in
//     ../harness.ts), and the server reaches it through `disposeSession` in
//     ../server/sessions.ts — so this handler is real teardown behaviour, not a guard.
//
// WHY THE SETTING DEFAULT IS 600000
// ---------------------------------
// `harness({ wakeIntervalMs })` documents 600000 (10 minutes) as the background-work
// heartbeat. The setting keeps that exact number so the migrated plugin is
// behaviour-identical, and the harness seeds this key from `configuration.wakeIntervalMs`
// when the host supplies no settings provider (plugin/settings.ts), so an existing
// deployment changes nothing. When a host DOES supply its own provider and stores
// nothing for this key, the declared default (or `api.config.wakeIntervalMs`) applies.
//
// TIMERS MUST NEVER HOLD THE PROCESS OPEN
// ---------------------------------------
// Every handle is `unref()`d when the runtime has that method (Node). A pending run
// keeps its own promise alive; a heartbeat that also kept the event loop alive would
// hang a CLI after the caller stopped caring.
//
// Cross-references:
//   - ../core/scheduler.ts   — the timer this replaces; `wake()`/`pendingList()` are
//                              the two operations this plugin drives
//   - ../harness.ts          — the `async.pending`/`async.drained` emit sites and the
//                              `onWake` mailbox path (the `wakeup` event, unchanged)
//   - ../plugin/settings.ts  — how `intervalMs` resolves (stored → declared → fallback)
//   - ../plugin/manifest.ts  — generated: this file is auto-discovered
//   - ../plugin/host.ts      — how built-ins are applied
import type { HarnessPlugin, HarnessPluginApi, HarnessPluginMetadata } from '../types';

// The documented heartbeat, used when neither the setting nor `api.config` gives a
// usable number (a corrupt host document must not turn the ping into a 0 ms spin).
const DEFAULT_PING_INTERVAL_MS = 600_000;

// A static literal: scripts/generate-plugin-manifest.mjs refuses a `metadata` export
// that is not written as an object literal, because the manifest has to describe this
// plugin without executing it.
export const metadata = {
    name: 'async-ping',
    title: 'Background Ping',
    description:
        'Keeps a conversation waiting on background tool work moving by emitting a periodic ping with the calls that are still running, replacing the fixed scheduler heartbeat.',
    version: '1.0.0',
    tags: ['background', 'async', 'lifecycle'],
    builtin: true,
    hooks: [
        'async.pending',
        'async.drained',
        'run.failed',
        'thread.stopped',
        'thread.deleted',
        'harness.dispose'
    ],
    settings: [
        {
            key: 'intervalMs',
            label: 'Ping interval (ms)',
            type: 'number',
            default: 600000,
            min: 1000,
            step: 1000,
            description:
                'How often a still-running background tool is reported while work is pending. Defaults to the historical 10-minute wake.'
        }
    ]
} satisfies HarnessPluginMetadata;

export const setup: NonNullable<HarnessPlugin['setup']> = (api: HarnessPluginApi) => {
    // Scheduler identity → its pending one-shot handle. Keyed by the SAME value
    // `async.pending`/`async.drained` report and `api.async.pending()`/`api.async.wake()`
    // filter on: the display name for a registered agent or a default conversation,
    // `thread:<id>` for a host thread. Absent = not pinging.
    //
    // A ONE-SHOT timer that re-arms itself, deliberately not `setInterval`: the tick
    // decides whether the cadence continues, so a board that drained between ticks is
    // never rescheduled and a `clear()` cannot race a still-firing repeating handle
    // (which would fire again on its own cadence and double-ping).
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    // Resolve the interval at ARM time, not at setup: `api.settings` re-reads the host
    // provider on every call, so a settings change applies to the next ping instead of
    // requiring a restart. `wakeIntervalMs` is the legacy spelling of the same policy
    // and stays authoritative for a deployment that already passes it (the harness
    // seeds this setting from it), so the fallback chain is
    // stored setting → declared default → api.config → DEFAULT.
    const intervalOf = (): number => {
        const configured = api.settings.number(
            'intervalMs',
            api.config.wakeIntervalMs ?? DEFAULT_PING_INTERVAL_MS
        );

        // `settings.number` coerces by TYPE only, so an operator-stored 0, -5 or 0.4
        // reaches here. Anything that cannot drive a sane repeat falls back rather than
        // spinning the event loop with a zero-length interval. min/step stay UI hints.
        return Number.isFinite(configured) && configured >= 1
            ? configured
            : DEFAULT_PING_INTERVAL_MS;
    };

    // Stop one agent's ping. Idempotent: `async.drained` can race a tick that already
    // dropped the entry, and a teardown sweep may visit the same key twice.
    const clear = (agent: string): void => {
        const timer = timers.get(agent);
        if (timer === undefined) return;
        clearInterval(timer);
        timers.delete(agent);
    };

    const clearAll = (): void => {
        for (const timer of timers.values()) clearInterval(timer);
        timers.clear();
    };

    // Drop every timer whose board no longer holds anything. A run abort releases its
    // whole scope WITHOUT a delivery (the scheduler notifies nobody for abandoned
    // work), so no `async.drained` fires for it; without this sweep such a timer would
    // idle until its next tick. Live boards are deliberately untouched.
    const sweepDrained = (): void => {
        for (const agent of [...timers.keys()]) {
            if (api.async.pending(agent).length > 0) continue;
            clear(agent);
        }
    };

    // Arm one timer per agent. `hasWork` is what the CALLER knows about the transition:
    // `async.pending` is emitted BEFORE `scheduler.schedule()` starts the task (the task
    // may settle synchronously otherwise), so the LIVE board is still empty at that
    // moment and must not be used to decide — a single-call launch would never arm.
    // Nothing is armed for a transition that announces no work: a ping would report an
    // empty list and cost a model turn for nothing.
    const arm = (agent: string | undefined, hasWork: boolean): void => {
        // An empty/unknown identity cannot address a board — ignore rather than
        // inventing a shared `''` timer that would wake unrelated agents.
        if (agent === undefined || agent.length === 0 || !hasWork) return;
        if (timers.has(agent)) return;

        const intervalMs = intervalOf();

        const timer = setTimeout(() => tick(agent), intervalMs);

        // Node-only; a browser handle has no `unref`. Never let a heartbeat keep a
        // process alive on its own.
        (timer as unknown as { unref?: () => void }).unref?.();
        timers.set(agent, timer);
    };

    // One heartbeat. The entry is dropped BEFORE anything else happens, so the re-arm
    // at the end installs a fresh handle instead of being skipped by arm()'s `has()`
    // guard, and so a wake whose delivery drains the board (which emits
    // `async.drained` → clear()) can never leave a dead handle registered.
    const tick = (agent: string): void => {
        timers.delete(agent);

        // Re-read LIVE: work may have finished between ticks, and a wake would then
        // claim pending calls that no longer exist. This is also the last-resort
        // cleanup for a board released WITHOUT an `async.drained` event — today that is
        // `toolCancel` of an agent's last call (the release is acknowledged through
        // `immediateResult`, which reports the accurate pending list but does not emit
        // the drained transition) and any scope released by a run teardown. Such a
        // handle fires once, reports nothing, and is not rescheduled, so the observable
        // contract ("no wake for an empty board") holds even in that window.
        if (api.async.pending(agent).length === 0) return;

        // The board still has work: emit the `wakeup` (the harness routes it through
        // the agent's mailbox, which also gives the run its inspecting turn) and keep
        // pinging until it drains.
        api.async.wake(agent);
        arm(agent, true);
    };

    // Background work joined a board: start (or keep) its heartbeat. The payload list
    // is the transition's own claim, which is what the hook fires with before the task
    // exists on the board (see arm()).
    api.on('async.pending', (payload) => {
        arm(payload.agent, payload.pending.length > 0);
    });

    // That board is empty: stop pinging it.
    api.on('async.drained', (payload) => {
        clear(payload.agent);
    });

    // A thread's own board key: a host thread is scheduled as `thread:<id>`, so
    // stopping or purging it releases that timer immediately (its runs are being
    // aborted, and a wake for a dead board would be thrown away by the mailbox). For
    // an agent's DEFAULT conversation the scheduling key is the display agent name,
    // which other boards may legitimately share, so `clear()` is a no-op there and the
    // sweep handles it once that board is provably empty.
    const releaseThread = (threadId: string): void => {
        clear(`thread:${threadId}`);
        sweepDrained();
    };

    // Teardowns that never deliver a result (run abort / rollback / exhausted
    // iteration budget release the whole scope through `abandonScope` without a
    // notification) have no `async.drained`; the sweep removes only the timers that
    // are provably pointless. `run.failed` is the point where the harness has already
    // released the run's tasks, so the board reads empty here.
    api.on('run.failed', () => {
        sweepDrained();
    });

    // Both thread hooks are emitted through the bus's synchronous `fire()` (a handle
    // method cannot await), so reacting here costs no extra microtask boundary.
    api.on('thread.stopped', (payload) => {
        releaseThread(payload.id);
    });

    api.on('thread.deleted', (payload) => {
        releaseThread(payload.threadId);
    });

    // The teardown point, LIVE since T1.6: `harness()` exposes `dispose()` and emits this
    // exactly once on a settled boundary (`emitDispose`, ../harness.ts), and the server
    // reaches it through `disposeSession` (../server/sessions.ts) — so this clears every
    // heartbeat at the real end of the process, matching the header above.
    api.on('harness.dispose', () => {
        clearAll();
    });
};

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
// WHICH PENDING WORK IS WORTH A WAKE (the async-only trigger rule)
// ----------------------------------------------------------------
// The heartbeat fires for one reason: an ASYNC completion can land at any moment and
// the parked conversation cannot see it without a turn. A `mode: 'async'` call
// releases the batch gate on its own (`onWake` in ../harness.ts), so without a ping a
// long async call could settle into a run that has stopped asking.
//
// A `mode: 'sync'` call has no such problem. Its completion joins its message's sync
// group, and the run is re-entered by the LAST member of that group settling
// (success, failure, or cancellation) — a sync call therefore always wakes the agent
// by itself, whenever that happens. Waking it on a timer instead buys nothing and
// costs a model turn on a `status:'pending'` placeholder. So the rule is:
//
//   an agent is pinged ONLY while at least ONE pending call resolves to `mode:'async'`.
//
// The mode comes from the LIVE tool registry (`api.tools`, bound to the harness's own
// record in ../harness.ts) PLUS the generated discovery table
// (../core/tool-manifest `BUILTIN_TOOL_DESCRIPTORS`), because `HarnessPendingTool`
// carries only `{ callId, name, elapsedMs }` (../types/index.ts) — the pending list has
// no policy on it. Resolution order, per entry (it mirrors ../harness.ts
// `effectiveToolMode`, the harness's own rule, as closely as a plugin can):
//
//   1. registry HIT and the definition DECLARES a mode  → that mode; only 'async' counts.
//      This is every host tool (`tool({ mode })`, `addTool`, `toolCreate`).
//   2. registry HIT, no declared mode                   → the DISCOVERED ROW for that
//      name, and a row with no mode means 'sync'. THIS LOOKUP IS NOT OPTIONAL: a
//      discovered built-in publishes `metadata`/`registration`/`execute` and the harness
//      binds the row's policy to the definition through a PRIVATE WeakMap
//      (`modeDefinitions`, ../harness.ts). `api.tools.shell.mode` is therefore
//      `undefined` for `shell` even though `shell` is async — a plugin that read only
//      the definition object would classify `shell`, `delegate`, `threadFork` and
//      `actionRequest` as sync and remove the heartbeat from the exact tools it exists
//      for. The generated table is the same DATA the scanner read, so it answers for
//      every package entry.
//   3. registry HIT, no mode, no row                    → 'sync' — the documented
//      default (`DEFAULT_TOOL_MODE`, ../core/tool.ts) for a host definition that stated
//      nothing. No wake.
//   4. registry MISS (unknown / unregistered name)      → treated as ASYNC, WAKE ANYWAY.
//
// The last line is a deliberate ASYMMETRY, and step 2's replacement case is the one
// disclosed DIVERGENCE from the harness: a host that REPLACES a built-in wire name
// (`addTool({ shell })` with a mode-less definition) is effective-'sync' inside the
// harness, while this plugin sees the stale row and keeps pinging. Over-pinging is the
// safe direction — it costs at most one extra turn — where under-pinging would silently
// remove hang-visibility, which the heartbeat exists to provide.
//
// A host tool folder entry (`origin: 'folder'`) is the OPPOSITE case, and the earlier
// claim that it "pings" was measured false on this tree (reviewer probe
// `Temp/review-sleep/probe10.ts` + its `foldertool` fixture): a folder module declaring
// `registration.mode: 'async'` publishes a discovery row saying `mode:'async',
// origin:'folder'`, yet its registry object answers `.mode === undefined`, the harness
// PARKS the run (2 model requests, not the 3 an async release produces), and this plugin
// emits 0 wakeups. Mechanism: folder entries are registered by the ordered folder loop
// (`../harness.ts:6008-6019` → `registerAtStartup:3102`), while the ONLY site that binds a
// discovered mode to a published definition is `registerDescriptor` for PACKAGE rows
// (`../harness.ts:3945`, read by `effectiveToolMode:1928`), so `modeDefinitions` never
// sees a folder entry — and the generated table holds package rows only (see
// `DISCOVERED_MODES` below), so a folder name is a registry HIT with no row: step 3,
// 'sync'. Plugin and harness therefore AGREE today (a folder entry runs sync both
// places), which is why no shipped configuration loses hang-visibility. The risk is
// LATENT and points the other way: discovery ALREADY reports that row as async, so the
// moment core honours it the harness runs the call async while step 3 still answers
// 'sync', and this plugin UNDER-pings — the one direction this header promises to
// protect against. Until the `api.toolMode(name)` follow-up lands
// (docs/tasks/2026-11-19-heartbeat-async-only.md, task 2), the host-tool surfaces this
// plugin can actually see are a definition that DECLARES its mode — step 1, and a
// `harness({ tools })` entry does copy the declared mode onto the wrapper
// (`../harness.ts:6045`) — or a package row (step 2). Both divergences are recorded here
// rather than papered over.
//
// MIXED BOARDS STILL PING. One async + one sync pending ⇒ keep waking: the async
// completion is what releases the parked sync gate, so suppressing the ping because a
// sync call is also on the board would strand it. The predicate is therefore "at least
// one async entry", never "no sync entries".
//
// Both decision points apply it: `arm` (the `async.pending` payload is the only board
// view available before `schedule()`) and `tick` (the live board). `tick` DROPS its
// timer — no wake, no re-arm — when the async work it was armed for has settled and
// only sync calls remain, because the core emits `async.drained` only when the WHOLE
// board empties; without that, such a timer would ping a sync-parked run forever. The
// next `async.pending` re-arms it, so the plugin self-heals.
//
// WHAT GATING REMOVES (the `toolCancel` escape hatch)
// ---------------------------------------------------
// There is NO automatic hard tool timeout (../../knowledge.md:5311-5322): a hanging
// call ends only through an explicit `toolCancel` or the tool's own configured
// bound. The heartbeat used to be the only event that gave a PARKED run a model turn,
// so it was also the only chance to notice a hung call and cancel it. With this rule, a
// run parked on sync work alone gets no such turn: a `read`/`edit`/`fetch` call blocked
// on a wedged filesystem or socket keeps the run parked, and the model never sees the
// stall until the call settles. Consequences, stated plainly:
//   - the run still CANNOT hang forever silently — the caller owns the escape hatches.
//     `harness(...)`'s promise is awaited by the host, which can abort the run with the
//     `signal` it passed, or stop the thread (`threads.stop`), and the server's stop
//     button reaches the same door. Both release the park (pinned at
//     ../harness.sync-async.test.ts, "releases a parked batch gate when the run is
//     aborted").
//   - a STEER or any incoming message still wakes the parked run, and that turn CAN
//     call `toolCancel` — the park is a park, never a block (`run.syncWakers`).
//   - what is genuinely gone is the AUTONOMOUS chance, mid-park, for the agent itself to
//     notice and cancel. Tools with their own bound (`shell.timeoutMs`, `fetch`'s,
//     `delegate.timeoutMs`) are unaffected. A sync tool with no internal bound that
//     wedges is now a host problem, not a heartbeat problem.
//
// HOW IT WORKS
// ------------
//   - `async.pending` (a call joined an agent's board)  → arm ONE timer for that
//     scheduler identity, if it does not already have one AND the announced calls
//     include at least one async one (see the trigger rule above). Per agent, not per
//     call: a burst of ten calls must stay one timer, exactly like the old board timer.
//     The event is emitted BEFORE `scheduler.schedule()` puts the task on the board
//     (harness.ts `launchToolCall`: the task starts immediately and may settle
//     synchronously), so the FIRST call of a turn is not yet visible through
//     `api.async.pending()`. The payload is the authoritative "work was announced"
//     signal at that point; reading the live board there would never arm a timer for a
//     single-call turn.
//   - each tick (a one-shot that reschedules itself, so the cadence is decided by
//     live state every time): re-read the board. Still holding ASYNC work →
//     `api.async.wake()` (the harness's per-agent mailbox emits the `wakeup` frame and
//     gives the run its turn) and re-arm. Nothing async left — empty, or only sync
//     calls → stop; the work either finished between ticks (nothing is reported for it)
//     or is a sync group that will wake the agent itself when it settles.
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
// HOW ENABLEMENT INTERACTS WITH THE TIMERS (R2)
// ---------------------------------------------
// The framework gates this plugin's HOOKS while `enabled` is off, but the handles above
// are the plugin's own: a heartbeat armed before the switch was flipped would otherwise
// keep waking the conversation with nobody listening. So `arm` and `tick` re-read the
// reserved `enabled` key on every decision — a disable costs at most one interval, then
// the plugin holds no timer and emits no wake; a re-enable arms again on the next
// `async.pending`. This is also why the key is NOT declared in `metadata.settings`: the
// framework owns it (../server/plugins.ts, `RESERVED_ENABLED_DESCRIPTOR`) and a generated
// manifest entry would only give the UI a second control over one stored value.
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
//   - ../core/scheduler.ts        — the timer this replaces; `wake()`/`pendingList()` are
//                                   the two operations this plugin drives
//   - ../core/tool.ts             — `DEFAULT_TOOL_MODE` ('sync'): the policy an undeclared
//                                   definition runs under, which is why "no mode" means "no wake"
//   - ../core/tool-manifest.ts    — GENERATED `BUILTIN_TOOL_DESCRIPTORS`: the discovered
//                                   `registration.mode` of every package entry, which the
//                                   definition object does NOT carry (step 2 above)
//   - ../core/tool-metadata.ts    — `ToolRegistration.mode` / `DiscoveredTool.mode`, the
//                                   two row shapes this plugin reads a policy from
//   - ../harness.ts               — the `async.pending`/`async.drained` emit sites, the
//                                   `onWake` mailbox path (the `wakeup` event, unchanged),
//                                   `run.syncWakers` (what a wake releases), and
//                                   `effectiveToolMode` + `modeDefinitions` (the private
//                                   WeakMap that forces the table lookup)
//   - ../types/index.ts           — `HarnessPendingTool` (`{ callId, name, elapsedMs }`, no
//                                   policy) and `HarnessPluginApi.tools` (the live registry)
//   - ../plugin/settings.ts       — how `intervalMs` resolves (stored → declared → fallback)
//   - ../plugin/manifest.ts       — generated: this file is auto-discovered
//   - ../plugin/host.ts           — how built-ins are applied
import { BUILTIN_TOOL_DESCRIPTORS } from '../core/tool-manifest';
import type {
    HarnessPendingTool,
    HarnessPlugin,
    HarnessPluginApi,
    HarnessPluginMetadata,
    ToolMode
} from '../types';

// Registry name → the DISCOVERED turn policy of that package entry, built ONCE from the
// generated table (it is static data — the table is regenerated with the entries, and
// `src/core/tool-discovery.test.ts` fails when the committed bytes are stale).
//
// A row's `mode` is ABSENT when the entry declared none, which means 'sync'; the Map is
// therefore keyed on presence (`has`) as well as value, so "row exists, no policy" (sync)
// and "no row" (a host definition, or a folder entry the package table cannot describe)
// stay distinguishable. Duplicate names collapse to the LAST row, which is also what
// registration does: `registration` order puts a folder entry after the package entries,
// and the generated table only ever holds package rows (`origin: 'package'`).
const DISCOVERED_MODES = new Map<string, ToolMode | undefined>(
    BUILTIN_TOOL_DESCRIPTORS.map((row) => [row.name, row.mode])
);

// The documented heartbeat, used when neither the setting nor `api.config` gives a
// usable number (a corrupt host document must not turn the ping into a 0 ms spin).
const DEFAULT_PING_INTERVAL_MS = 600_000;

// A static literal: scripts/generate-plugin-manifest.ts refuses a `metadata` export
// that is not written as an object literal, because the manifest has to describe this
// plugin without executing it.
export const metadata = {
    name: 'async-ping',
    title: 'Background Ping',
    description:
        "Keeps a conversation waiting on background tool work moving by emitting a periodic ping only while at least one pending call resolves to mode 'async', replacing the fixed scheduler heartbeat.",
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
                "How often a conversation is pinged while at least one pending call resolves to mode 'async'. Defaults to the historical 10-minute wake."
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

    // Global enablement (R2). The framework gate already stops this plugin's HOOKS while
    // it is switched off (../plugin/host.ts, ../plugin/hooks.ts rule 9), but a heartbeat
    // this plugin armed BEFORE the switch was flipped is a `setTimeout` handle the bus has
    // no claim on: it would keep firing, keep waking the conversation, and keep re-arming
    // forever. So the two places that decide to WAKE or to CONTINUE read the same reserved
    // key, and a disable therefore takes effect within one interval - the tick drops its
    // own entry and neither wakes nor re-arms, so the plugin is genuinely stopped, not
    // merely unheard. `harness.dispose` is delivered even while disabled, so a teardown
    // still clears whatever survived the switch.
    const isEnabled = (): boolean => api.settings.boolean('enabled', true);

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

    // Does this pending entry resolve to ASYNC work (the only kind that justifies a
    // wake)? Four steps, documented in the header, mirroring ../harness.ts
    // `effectiveToolMode` as closely as a plugin can:
    //   1. a definition that DECLARES a mode answers for itself;
    //   2. otherwise the discovered ROW answers (a built-in's policy is in its
    //      `registration` literal and is bound to the definition through a private
    //      WeakMap, so the registry object alone is not enough);
    //   3. a registry hit with no row is a host definition that stated nothing, which is
    //      the documented 'sync' default — no wake;
    //   4. a name the registry cannot answer for is treated as async, so an unanswerable
    //      policy never silently removes hang-visibility.
    //
    // An OWN-key check guards the prototype: a plain `{}` registry would otherwise answer
    // for a name like 'toString' with an inherited function that has no `mode`, and step
    // 3 would misread it as a sync definition. (`hasOwnProperty` rather than
    // `Object.hasOwn`: this package compiles against the es5 lib, see tsconfig.json.)
    const isAsyncPending = (entry: HarnessPendingTool): boolean => {
        if (!Object.prototype.hasOwnProperty.call(api.tools, entry.name)) return true;

        const declared = api.tools[entry.name].mode;
        if (declared !== undefined) return declared === 'async';

        if (DISCOVERED_MODES.has(entry.name)) return DISCOVERED_MODES.get(entry.name) === 'async';

        return false;
    };

    // ONE async entry is enough — a mixed board still pings, because that async
    // completion is what releases the parked sync gate.
    const hasAsyncWork = (entries: readonly HarnessPendingTool[]): boolean =>
        entries.some(isAsyncPending);

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

    // Drop every timer whose board can no longer justify one — empty, or holding only
    // sync work. A run abort releases its whole scope WITHOUT a delivery (the scheduler
    // notifies nobody for abandoned work), so no `async.drained` fires for it; without
    // this sweep such a timer would idle until its next tick. A board that still holds
    // async work is deliberately untouched: that is the case the heartbeat exists for.
    const sweepDrained = (): void => {
        for (const agent of [...timers.keys()]) {
            if (hasAsyncWork(api.async.pending(agent))) continue;
            clear(agent);
        }
    };

    // Arm one timer per agent. `wakeWorthy` is what the CALLER knows about the
    // transition — the caller's own async-filtered view of the announced work (the
    // `hasAsyncWork` helper above is how `async.pending` and `tick` derive it). That
    // indirection is required because `async.pending` is emitted BEFORE
    // `scheduler.schedule()` starts the task (the task may settle synchronously
    // otherwise), so the LIVE board is still empty at that moment and must not be used
    // to decide — a single-call launch would never arm. Nothing is armed for a
    // transition that announces no async work: a ping would either report an empty list
    // or wake a run that a sync group re-enters on its own, and both cost a model turn.
    const arm = (agent: string | undefined, wakeWorthy: boolean): void => {
        // An empty/unknown identity cannot address a board — ignore rather than
        // inventing a shared `''` timer that would wake unrelated agents.
        if (agent === undefined || agent.length === 0 || !wakeWorthy) return;

        // Switched off: release the key instead of arming, so a re-enable starts a clean
        // heartbeat rather than resuming one whose board may have drained meanwhile.
        if (!isEnabled()) {
            clear(agent);
            return;
        }

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

        // Switched off between ticks: stop here. The entry is already dropped above, so
        // nothing is re-armed and no `wakeup` is emitted — the conversation is not woken
        // for a plugin the operator turned off, and no handle is left behind.
        if (!isEnabled()) return;

        // Re-read LIVE and require ASYNC work: work may have finished between ticks, and
        // a wake would then claim pending calls that no longer exist. This is also the
        // last-resort cleanup for a board released WITHOUT an `async.drained` event —
        // today that is `toolCancel` of an agent's last call (the release is
        // acknowledged through `immediateResult`, which reports the accurate pending
        // list but does not emit the drained transition) and any scope released by a run
        // teardown. Such a handle fires once, reports nothing, and is not rescheduled, so
        // the observable contract ("no wake for an empty board") holds even in that window.
        //
        // The async filter ALSO covers the case the core cannot: `async.drained` fires
        // only when the WHOLE board empties (../harness.ts), so a timer armed for an
        // async call is still live when that call settles and a sync call from the same
        // message remains. Dropping the handle here — no wake, no re-arm — is what stops
        // such a board from being pinged forever; the run is woken by the sync group
        // anyway, and the next `async.pending` re-arms the heartbeat if new background
        // work arrives.
        if (!hasAsyncWork(api.async.pending(agent))) return;

        // The board still has async work: emit the `wakeup` (the harness routes it
        // through the agent's mailbox, which also gives the run its inspecting turn and
        // releases a parked sync gate) and keep pinging until that work drains.
        api.async.wake(agent);
        arm(agent, true);
    };

    // Background work joined a board: start (or keep) its heartbeat — but only for an
    // announced ASYNC call. The payload list is the transition's own claim, which is
    // what the hook fires with before the task exists on the board (see arm()); it is
    // the live board PLUS this call, so filtering it is the earliest point at which the
    // policy is knowable. A sync-only announcement arms nothing, and a later async call
    // on the same board arms it then.
    api.on('async.pending', (payload) => {
        arm(payload.agent, hasAsyncWork(payload.pending));
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

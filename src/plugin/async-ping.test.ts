// The shipped `async-ping` preset plugin (src/plugins/async-ping.plugin.ts).
//
// WHAT THIS FILE PINS (R4)
// ------------------------
// The plugin OWNS the background-work heartbeat now: core/scheduler.ts arms nothing,
// so every behaviour the old board timer provided has to be observable HERE.
//
//   1. arm on `async.pending` — one timer per SCHEDULER identity (not per call), and
//      nothing at all for a board with nothing pending or an empty identity;
//   2. the cadence — exactly the declared 600000 ms default, exactly the seeded
//      `intervalMs`, re-read at every arm so a settings change applies to the next
//      ping, and an unusable stored value falls back to 600000 instead of spinning;
//   3. the tick — a live board gets exactly one `api.async.wake()` and is re-armed; a
//      board that drained between ticks is reported NOT AT ALL and is not rescheduled;
//   4. the teardown contract — `async.drained` clears that board's timer, a stopped or
//      purged thread releases its own timer, `run.failed` sweeps boards that were
//      abandoned WITHOUT a delivery (a run abort releases a scope silently), a live
//      board is never swept, and `harness.dispose` clears everything;
//   5. `unref()` on every handle, so a heartbeat can never hold a process open;
//   6. the subscription set matches `metadata.hooks`, because the manifest/Plugins pane
//      shows the declared list and an operator decides with it.
//
// WHY A HAND-WRITTEN CLOCK INSTEAD OF `vi.useFakeTimers()`
// -------------------------------------------------------
// The plugin only ever touches `setTimeout`/`clearInterval`, and the two facts that
// matter most here are the EXACT armed delay and whether the handle was `unref()`d.
// A stubbed global pair gives both as plain data (delay + unref count per handle)
// without depending on the shape of a runtime timer object or on fake-timer internals.
// The end-to-end numbers (elapsed times, the `wakeup` frame, timer cleanup through a
// real harness) are pinned in ../harness.background.test.ts.
//
// Cross-references:
//   - ../plugins/async-ping.plugin.ts  — the implementation under test
//   - ./settings.ts                    — the real stored → declared → fallback chain
//   - ../core/scheduler.ts             — the timer-free board this plugin drives
//   - ../harness.ts                    — the `async.pending`/`async.drained` emit sites
//   - ./manifest.test.ts               — the exact declared catalogue

import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
    HarnessLifecycleEvent,
    HarnessLifecyclePayloads,
    HarnessPendingTool,
    HarnessPluginApi
} from '@underload/harness';
import { createInMemoryPluginSettingsProvider, createPluginSettingsView } from './settings';
import { metadata, setup } from '../plugins/async-ping.plugin';

// ---------------------------------------------------------------------------
// Fake clock: records what the plugin armed, and fires it on demand.
// ---------------------------------------------------------------------------

type Armed = {
    // The delay the plugin asked for, exactly as passed.
    delay: number;
    // How many times this handle had `unref()` called on it.
    unrefs: number;
};

type FakeClock = {
    // Every handle the plugin currently holds, in arm order.
    armed: () => Armed[];
    // Fire every currently-armed handle ONCE (a one-shot is consumed), in arm order.
    fire: () => void;
    // Handles the plugin cleared without firing (proof a drain/teardown released them).
    cleared: () => number;
};

// Installs the stubs and returns the observable clock. The plugin resolves
// `setTimeout`/`clearInterval` from the global scope at CALL time, so stubbing here
// captures every timer it ever creates.
const useFakeClock = (): FakeClock => {
    let sequence = 0;
    let clearedCount = 0;

    // handle object → what it represents. A fired or cleared one-shot leaves the map,
    // so `armed()` is always exactly "what would still fire".
    const entries = new Map<object, { delay: number; unrefs: number; fn: () => void }>();

    const setTimeoutStub = (fn: () => void, delay?: number): object => {
        const entry = { delay: delay ?? 0, unrefs: 0, fn };
        const handle = {
            id: `timer-${++sequence}`,
            unref: () => {
                entry.unrefs += 1;
            },
            ref: () => undefined
        };
        entries.set(handle, entry);
        return handle;
    };

    const clearStub = (value: unknown): void => {
        if (value === null || typeof value !== 'object') return;
        if (!entries.delete(value)) return;
        clearedCount += 1;
    };

    vi.stubGlobal('setTimeout', setTimeoutStub);
    vi.stubGlobal('clearTimeout', clearStub);
    vi.stubGlobal('clearInterval', clearStub);

    return {
        armed: () =>
            [...entries.values()].map((entry) => ({
                delay: entry.delay,
                unrefs: entry.unrefs
            })),
        fire: () => {
            // Snapshot first: the plugin re-arms from inside the callback, and a
            // freshly armed handle must NOT fire in the same pass.
            const due = [...entries.entries()];
            for (const [handle, entry] of due) {
                entries.delete(handle);
                entry.fn();
            }
        },
        cleared: () => clearedCount
    };
};

// ---------------------------------------------------------------------------
// Fake plugin api: a board the test controls, and recordings for both accesses.
// ---------------------------------------------------------------------------

type FakeApi = {
    api: HarnessPluginApi;
    // Every `api.async.wake()` argument, in call order ('*' for the un-narrowed form).
    wakes: string[];
    // Drives the board the plugin reads through `api.async.pending()`.
    setPending: (agent: string, entries: HarnessPendingTool[]) => void;
    // Dispatches a lifecycle payload to the handlers the plugin subscribed.
    emit: <E extends HarnessLifecycleEvent>(event: E, payload: HarnessLifecyclePayloads[E]) => void;
    // Which events the plugin actually subscribed to, in registration order.
    events: () => HarnessLifecycleEvent[];
    // The live settings provider, so a test can change a value between arms.
    settingsProvider: ReturnType<typeof createInMemoryPluginSettingsProvider>;
};

// The board entries the plugin only ever counts; `elapsedMs` is irrelevant here
// because the plugin never renders a pending list itself.
const pendingEntry = (callId: string): HarnessPendingTool => ({
    callId,
    name: 'slow',
    elapsedMs: 0
});

// `seed` mirrors what harness.ts passes for `harness({ wakeIntervalMs })`;
// `wakeIntervalMs` is the same value on the api's config view.
const createFakeApi = (input: {
    seed?: Record<string, Record<string, unknown>>;
    wakeIntervalMs?: number;
} = {}): FakeApi => {
    const boards = new Map<string, HarnessPendingTool[]>();
    const wakes: string[] = [];
    const subscriptions: Array<{ event: HarnessLifecycleEvent; handler: (payload: never) => void }> = [];

    // The REAL read model: the assertions below therefore pin the actual fallback
    // chain (stored value → declared default → the plugin's own fallback), not a stub.
    const settingsProvider = createInMemoryPluginSettingsProvider([metadata], input.seed);
    const settings = createPluginSettingsView('async-ping', settingsProvider, metadata.settings);

    // Any control other than the three this plugin uses is a contract violation.
    const skip = (name: string): never => {
        throw new Error(`async-ping touched ${name}.`);
    };

    const api = {
        agents: {},
        tools: {},
        createAgent: () => skip('createAgent'),
        addTool: () => skip('addTool'),
        addCommand: () => skip('addCommand'),
        on: (event, handler) => {
            const registration = { event, handler: handler as (payload: never) => void };
            subscriptions.push(registration);
            return () => {
                const index = subscriptions.indexOf(registration);
                if (index >= 0) subscriptions.splice(index, 1);
            };
        },
        settings,
        threads: {
            list: () => skip('threads.list'),
            create: () => skip('threads.create'),
            delete: () => skip('threads.delete'),
            remove: () => skip('threads.remove'),
            stop: () => skip('threads.stop'),
            send: () => skip('threads.send'),
            steer: () => skip('threads.steer'),
            messages: () => skip('threads.messages'),
            replaceMessages: () => skip('threads.replaceMessages'),
            setStatus: () => skip('threads.setStatus')
        },
        enableTool: () => skip('enableTool'),
        disableTool: () => skip('disableTool'),
        enabledTools: () => skip('enabledTools'),
        async: {
            // Agent-scoped, exactly like the scheduler's `pendingList(agent)`.
            pending: (agent?: string) =>
                agent === undefined
                    ? [...boards.values()].flat()
                    : boards.get(agent) ?? [],
            wake: (agent?: string) => {
                wakes.push(`wake:${agent ?? '*'}`);
            }
        },
        config: { wakeIntervalMs: input.wakeIntervalMs ?? 600000 }
    } as unknown as HarnessPluginApi;

    return {
        api,
        wakes,
        setPending: (agent, entries) => {
            boards.set(agent, entries);
        },
        emit: (event, payload) => {
            // Sequential, like the bus: one emit reaches every subscriber in order.
            for (const registration of [...subscriptions]) {
                if (registration.event !== event) continue;
                registration.handler(payload as never);
            }
        },
        events: () => subscriptions.map((registration) => registration.event),
        settingsProvider
    };
};

// One wired-up plugin: fake clock + fake api + `setup()` already run.
const createHarness = (
    input: { seed?: Record<string, Record<string, unknown>>; wakeIntervalMs?: number } = {}
) => {
    const clock = useFakeClock();
    const board = createFakeApi(input);
    setup(board.api);

    return { clock, ...board };
};

// Convenience: a board with `count` calls and the matching `async.pending` signal.
const announce = (
    board: FakeApi,
    agent: string,
    callIds: string[]
): void => {
    board.setPending(agent, callIds.map(pendingEntry));
    board.emit('async.pending', { agent, pending: callIds.map(pendingEntry) });
};

// The plugin's timers are entirely inside the stubbed globals above, so no real
// (or fake) runtime timer exists in this file; unstubb­ing is the only cleanup.
afterEach(() => {
    vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Arming
// ---------------------------------------------------------------------------

describe('async-ping arming', () => {
    it('arms one 600000ms timer when a call joins a board', () => {
        const harness = createHarness();
        announce(harness, 'writer', ['a1']);

        // Exact delay and exact call list: nothing has fired yet.
        expect(harness.clock.armed()).toEqual([{ delay: 600_000, unrefs: 1 }]);
        expect(harness.wakes).toEqual([]);
    });

    it('keeps one timer for a burst of calls on the same board', () => {
        const harness = createHarness();
        announce(harness, 'writer', ['a1']);
        harness.emit('async.pending', {
            agent: 'writer',
            pending: [pendingEntry('a1'), pendingEntry('a2')]
        });

        expect(harness.clock.armed()).toEqual([{ delay: 600_000, unrefs: 1 }]);

        // One tick, one wake — the burst never becomes two heartbeats.
        harness.clock.fire();
        expect(harness.wakes).toEqual(['wake:writer']);
    });

    it('pings each board separately, in arm order', () => {
        const harness = createHarness();
        announce(harness, 'writer', ['a1']);
        announce(harness, 'thread:thread-1', ['b1']);

        expect(harness.clock.armed()).toEqual([
            { delay: 600_000, unrefs: 1 },
            { delay: 600_000, unrefs: 1 }
        ]);

        harness.clock.fire();
        expect(harness.wakes).toEqual(['wake:writer', 'wake:thread:thread-1']);
    });

    it('arms from the announced call, before the board can see it', () => {
        // The harness emits `async.pending` BEFORE `schedule()` (harness.ts
        // launchToolCall), so the live board is still empty here. Reading it to decide
        // would leave a single-call turn with no heartbeat at all.
        const harness = createHarness();
        harness.emit('async.pending', { agent: 'writer', pending: [pendingEntry('a1')] });

        expect(harness.clock.armed()).toEqual([{ delay: 600_000, unrefs: 1 }]);

        // The board caught up, so the tick reports it.
        harness.setPending('writer', [pendingEntry('a1')]);
        harness.clock.fire();
        expect(harness.wakes).toEqual(['wake:writer']);
    });

    it('arms nothing for a transition that announces no work', () => {
        const harness = createHarness();
        harness.setPending('writer', [pendingEntry('a1')]);

        // An empty payload claims nothing to report, so no heartbeat is worth arming.
        harness.emit('async.pending', { agent: 'writer', pending: [] });

        expect(harness.clock.armed()).toEqual([]);
        harness.clock.fire();
        expect(harness.wakes).toEqual([]);
    });

    it('ignores an empty agent identity', () => {
        const harness = createHarness();
        harness.setPending('writer', [pendingEntry('a1')]);
        harness.emit('async.pending', { agent: '', pending: [pendingEntry('a1')] });

        // A shared `''` timer would wake the wrong board.
        expect(harness.clock.armed()).toEqual([]);
        harness.clock.fire();
        expect(harness.wakes).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Interval resolution
// ---------------------------------------------------------------------------

describe('async-ping interval', () => {
    it('honours intervalMs seeded from the legacy wakeIntervalMs', () => {
        // Exactly what harness() does for `harness({ wakeIntervalMs: 250 })`.
        const harness = createHarness({
            seed: { 'async-ping': { intervalMs: 250 } },
            wakeIntervalMs: 250
        });
        announce(harness, 'writer', ['a1']);

        expect(harness.clock.armed()).toEqual([{ delay: 250, unrefs: 1 }]);
    });

    it('honours a host-stored intervalMs over the declared default', () => {
        const harness = createHarness({ seed: { 'async-ping': { intervalMs: 1500 } } });
        announce(harness, 'writer', ['a1']);

        expect(harness.clock.armed()).toEqual([{ delay: 1500, unrefs: 1 }]);
    });

    it('re-reads the setting on every re-arm so an operator change takes effect', () => {
        const harness = createHarness({ seed: { 'async-ping': { intervalMs: 600_000 } } });
        announce(harness, 'writer', ['a1']);
        expect(harness.clock.armed()).toEqual([{ delay: 600_000, unrefs: 1 }]);

        // The change lands between two pings, so the NEXT arm sees it: a handle that is
        // already waiting keeps its delay (nothing re-arms mid-flight), and no restart
        // is needed for a settings edit.
        harness.settingsProvider.set('async-ping', 'intervalMs', 500);
        harness.clock.fire();

        expect(harness.wakes).toEqual(['wake:writer']);
        expect(harness.clock.armed()).toEqual([{ delay: 500, unrefs: 1 }]);
    });

    it('falls back to 600000 when a stored interval cannot drive a repeat', () => {
        // min/step are UI hints, so 0 and a negative reach the plugin (plugin/settings.ts).
        for (const stored of [0, -250, Number.NaN]) {
            const harness = createHarness({ seed: { 'async-ping': { intervalMs: stored } } });
            announce(harness, 'writer', ['a1']);

            expect(harness.clock.armed()).toEqual([{ delay: 600_000, unrefs: 1 }]);
        }
    });
});

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

describe('async-ping heartbeat', () => {
    it('wakes a still-pending board and re-arms at the same interval', () => {
        const harness = createHarness();
        announce(harness, 'writer', ['a1']);

        harness.clock.fire();
        expect(harness.wakes).toEqual(['wake:writer']);
        expect(harness.clock.armed()).toEqual([{ delay: 600_000, unrefs: 1 }]);

        // Repeating: the third ping is another full interval later.
        harness.clock.fire();
        harness.clock.fire();
        expect(harness.wakes).toEqual(['wake:writer', 'wake:writer', 'wake:writer']);
    });

    it('reports nothing and stops when the board drained between ticks', () => {
        const harness = createHarness();
        announce(harness, 'writer', ['a1']);

        // A completion released the call; the timer was still armed.
        harness.setPending('writer', []);
        harness.clock.fire();

        expect(harness.wakes).toEqual([]);
        expect(harness.clock.armed()).toEqual([]);
    });

    it('wakes the board it was armed for and no other', () => {
        const harness = createHarness();
        announce(harness, 'writer', ['a1']);
        announce(harness, 'thread:thread-1', ['b1']);

        // Only the thread's work finished.
        harness.setPending('thread:thread-1', []);
        harness.clock.fire();

        expect(harness.wakes).toEqual(['wake:writer']);
        expect(harness.clock.armed()).toEqual([{ delay: 600_000, unrefs: 1 }]);
    });
});

// ---------------------------------------------------------------------------
// Teardown: no timer survives a board that stopped needing one
// ---------------------------------------------------------------------------

describe('async-ping teardown', () => {
    it('clears the timer on async.drained and never fires again', () => {
        const harness = createHarness();
        announce(harness, 'writer', ['a1']);

        harness.emit('async.drained', { agent: 'writer', pending: [] });

        expect(harness.clock.armed()).toEqual([]);
        expect(harness.clock.cleared()).toBe(1);

        harness.clock.fire();
        expect(harness.wakes).toEqual([]);
    });

    it('ignores a drained event for a board that was never armed', () => {
        const harness = createHarness();
        announce(harness, 'writer', ['a1']);

        harness.emit('async.drained', { agent: 'thread:thread-9', pending: [] });

        expect(harness.clock.armed()).toEqual([{ delay: 600_000, unrefs: 1 }]);
        expect(harness.clock.cleared()).toBe(0);
    });

    it('releases a stopped thread timer while its board still reads pending', () => {
        const harness = createHarness();
        announce(harness, 'thread:thread-1', ['b1']);

        // A stop aborts the run; its tasks are released later, in the run's finally.
        harness.emit('thread.stopped', {
            id: 'thread-1',
            agent: 'writer',
            origin: 'host',
            status: 'stopped',
            sequence: 1
        });

        expect(harness.clock.armed()).toEqual([]);
        expect(harness.clock.cleared()).toBe(1);
    });

    it('releases a purged thread timer', () => {
        const harness = createHarness();
        announce(harness, 'thread:thread-2', ['b1']);

        harness.emit('thread.deleted', { threadId: 'thread-2', agent: 'writer' });

        expect(harness.clock.armed()).toEqual([]);
        expect(harness.clock.cleared()).toBe(1);
    });

    it('sweeps a board abandoned without a drained event when a run fails', () => {
        const harness = createHarness();
        announce(harness, 'writer', ['a1']);
        announce(harness, 'thread:thread-1', ['b1']);

        // abandonScope: the tasks are gone and NO delivery (so no `async.drained`) runs.
        harness.setPending('writer', []);
        harness.emit('run.failed', {
            threadId: 'agent:writer',
            agent: 'writer',
            depth: 1,
            input: 'go',
            error: { name: 'HarnessError', message: 'provider down' }
        });

        // Only the empty board loses its timer; the live one keeps its heartbeat.
        expect(harness.clock.armed()).toEqual([{ delay: 600_000, unrefs: 1 }]);

        harness.clock.fire();
        expect(harness.wakes).toEqual(['wake:thread:thread-1']);
    });

    it('clears every timer on harness.dispose', () => {
        const harness = createHarness();
        announce(harness, 'writer', ['a1']);
        announce(harness, 'thread:thread-1', ['b1']);

        harness.emit('harness.dispose', {});

        expect(harness.clock.armed()).toEqual([]);
        expect(harness.clock.cleared()).toBe(2);
    });

    it('unrefs every handle so a heartbeat cannot hold the process open', () => {
        const harness = createHarness();
        announce(harness, 'writer', ['a1']);

        // Three handles: the original plus one per re-arm, each unref'd exactly once.
        harness.clock.fire();
        harness.clock.fire();
        expect(harness.clock.armed()).toEqual([{ delay: 600_000, unrefs: 1 }]);

        announce(harness, 'thread:thread-1', ['b1']);
        expect(harness.clock.armed()).toEqual([
            { delay: 600_000, unrefs: 1 },
            { delay: 600_000, unrefs: 1 }
        ]);
    });
});

// ---------------------------------------------------------------------------
// Declared contract
// ---------------------------------------------------------------------------

describe('async-ping subscriptions', () => {
    it('subscribes exactly the hooks its metadata declares, in that order', () => {
        const harness = createHarness();

        // The Plugins pane shows metadata.hooks; a setup() that registers something
        // else (or less) would make that display a lie.
        expect(harness.events()).toEqual([...(metadata.hooks ?? [])]);
    });
});

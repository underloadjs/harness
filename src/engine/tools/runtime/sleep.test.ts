// tools/runtime/sleep.test.ts — the entry contract and the timer behind `sleep`.
//
// WHAT THIS PINS, AND WHY EACH HALF EXISTS
// ----------------------------------------------------------------
// `sleep` is the only entry in the catalogue whose BODY is a clock, so the interesting
// failures are all about one armed timer: its exact delay, whether it holds the process
// open, whether a cancel releases it, and whether a bad argument arms anything at all.
// Every one of those is pinned with an exact value:
//
//   - the metadata/registration literals, whole, including `mode: 'sync'` (the mode IS
//     the wake: the settled call is what re-enters the parked run — harness.ts:1924-1928)
//     and `order: 145`, asserted both as a number and against its two neighbours
//     (`actionRequest` 140, `toolCancel` 150), the same way threadDelete.test.ts pins the
//     descending `threads`-group orders;
//   - the published schema bounds against the ENFORCED constants, and the ceiling against
//     `MODEL_TIMEOUT_MAX_MS` (core/agent-limits.ts:81). The entry restates 3600 as a
//     literal because a runtime entry keeps zero captured local dependencies, so this
//     file is the only thing standing between three numbers drifting apart;
//   - the armed delay as `seconds * 1000` EXACTLY, proven twice: by reading the delay the
//     entry passed to `setTimeout` (the async-ping.test.ts:69-120 stub, which also pins
//     `unrefs: 0` — the handle stays REFERENCED, because for a sleep the wait IS the
//     awaited work; that is the one deliberate exception to the `armWallClock` unref rule
//     of harness.ts:911-941, documented in the header of `sleep.tool.ts`), and by
//     vitest's OWN fake clock, where the call is still pending at 2499 ms and settles at
//     2500 ms. The second proof is the one that would catch an off-by-one the stub could
//     hide, and it is also where `vi.getTimerCount() === 0` proves the cancelled timer is
//     genuinely gone rather than merely ignored;
//   - BOTH argument shapes: a tool with exactly ONE property has its arguments UNWRAPPED
//     to that value (core/tool.ts `toolParameterKey` → resolveToolParameters), so the live
//     call hands over a bare NUMBER, while a hand-built `executeTool`/direct context can
//     carry the `{ seconds }` wrapper. Both are pinned through the same entry, exactly as
//     threadDelete.test.ts does for `thread`;
//   - the float guard: `0.1 * 1000` is 100.00000000000001 in IEEE-754, and an entry that
//     armed that delay could never be asserted as "exactly 100 ms" — so `0.1` arms 100 and
//     `2.5` arms 2500;
//   - cancellation on both paths (already-aborted signal → nothing is armed; abort while
//     armed → the timer is cleared and the listener is removed), and cancellation RETURNS
//     a result rather than throwing, with the time actually waited;
//   - the published description VERBATIM, including what it may NOT promise. A shortened
//     wait's `{ sleptMs, cancelled }` payload never reaches the model on the doors that
//     shorten it — `harness.ts:10305` answers with the harness's own notice and `toolCancel`
//     drops a result that arrives afterwards (`Temp/review-sleep/probe20.ts`) — so the
//     sentence about it claims only that the wait ends early and nothing waits out the rest
//     of the delay;
//   - the refusals: out-of-range, non-number, NaN, Infinity, a wrapper with no `seconds`,
//     and the proof that a refusal arms NOTHING;
//   - the entry's import discipline, pinned as the exact specifier list, because
//     `scripts/check-package-tools.ts` asserts `dependencies: []` on this file's startup
//     source record.
//
// The last group uses REAL timers, because handle state and loop-holding are exactly what
// a fake clock cannot falsify: one case waits real time to prove the pause really resolves
// and a real cancel really shortens it, and one asserts the M1 fix on the platform's own
// terms — `hasRef()` is true mid-wait, the process's live `Timeout` count rises by exactly
// one while the wait is in flight, and it falls back the moment the wait is spent or
// cancelled (that pair is the regression: an `unref()`-ed handle is absent from
// `process.getActiveResourcesInfo()`, which is how the shipped bug let an idle process
// exit mid-sleep). Elapsed real milliseconds are the only values in this file that are not
// known in advance, and only those are range-checked.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODEL_TIMEOUT_MAX_MS } from '../../core/agent-limits';
import type { ToolContext } from '../../types';
import { registration as actionRequestRegistration } from './actionRequest.tool';
import { registration as toolCancelRegistration } from './toolCancel.tool';
import {
    SLEEP_MAX_SECONDS,
    SLEEP_MIN_SECONDS,
    execute,
    metadata,
    registration,
    sleep,
    type SleepResult
} from './sleep.tool';

const sourceOf = (file: string): string =>
    readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');

// The two sentences the entry can produce, restated verbatim: they are what a DIRECT
// caller (`executeTool`, the standalone callable) receives, so a wording change has to be a
// deliberate one. A MODEL only reliably reads the second — on the doors that shorten a wait
// the harness answers with its own notice and discards this payload (`harness.ts:10305`,
// measured in `Temp/review-sleep/probe20.ts`), which is why the cancelled sentence is scoped
// to what the entry itself knows: its own elapsed time and its own cleared timer. The plural
// rule is part of the pin — `1 second` is not `1 seconds`.
const secondsLabel = (value: number): string => `${value} second${value === 1 ? '' : 's'}`;
const WOKE = (seconds: number): string =>
    `Slept for ${secondsLabel(seconds)}. The timer expired and the run is awake again.`;
const CANCELLED = (waited: number, asked: number): string =>
    `Sleep cancelled after ${secondsLabel(waited)} of the ${secondsLabel(asked)} requested; the timer was cleared and nothing waits out the rest of the delay.`;

// The reason a bare `controller.abort()` carries, which is what `reason` must report.
const ABORT_MESSAGE = 'This operation was aborted';

// A context with the SHORTEST honest shape: the live path hands `execute` the unwrapped
// value, so `parameters` is the number itself. `signal` is optional, exactly as
// types/index.ts:3104-3119 documents it (absent for a direct call).
const context = (parameters: unknown, signal?: AbortSignal): ToolContext =>
    signal === undefined
        ? ({ parameters } as ToolContext)
        : ({ parameters, signal } as ToolContext);

// Flushes the microtask queue so a promise that settled inside a fired timer callback can
// be observed. `vi.advanceTimersByTime` runs the callback synchronously, and the await
// behind `execute`'s resolver needs one turn to reach the test.
const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
};

// ---------------------------------------------------------------------------
// Clock helpers
// ---------------------------------------------------------------------------

// The async-ping.test.ts:69-120 stub, narrowed to what a one-shot wait needs: every
// `setTimeout` the entry creates is recorded with its delay and its `unref()` count — which
// must stay 0 for this entry (M1: the sleep's own handle is what keeps an idle host alive
// while the awaited wait runs) — and `clearTimeout` counts what was released without firing.
//
// vitest's Date mock is installed alongside (toFake: ['Date']) so `sleptMs` — which the
// entry measures with Date.now — is a KNOWN number: the fake clock only moves when this
// file says so. The timer registry itself is replaced by the stub, so the entry's handle
// is the only timer in the world here, and `armed()` is exactly "what would still fire".
const useRecordingClock = (): {
    armed: () => Array<{ delay: number; unrefs: number }>;
    cleared: () => number;
    fire: () => void;
} => {
    vi.useFakeTimers({ toFake: ['Date'] });

    let clearedCount = 0;
    const entries = new Map<object, { delay: number; unrefs: number; fn: () => void }>();

    vi.stubGlobal(
        'setTimeout',
        (fn: () => void, delay?: number): object => {
            const entry = { delay: delay ?? 0, unrefs: 0, fn };
            const handle = {
                id: `sleep-timer-${entries.size}`,
                unref: () => {
                    entry.unrefs += 1;
                },
                ref: () => undefined
            };

            entries.set(handle, entry);

            return handle;
        }
    );

    vi.stubGlobal('clearTimeout', (value: unknown): void => {
        if (value === null || typeof value !== 'object') return;
        if (!entries.delete(value)) return;
        clearedCount += 1;
    });

    return {
        armed: () =>
            [...entries.values()].map((entry) => ({ delay: entry.delay, unrefs: entry.unrefs })),
        cleared: () => clearedCount,
        fire: () => {
            // Snapshot first: a callback that armed another timer must not fire in the
            // same pass, which is how a re-arming bug would show up as an extra row.
            const due = [...entries.values()];

            entries.clear();

            for (const entry of due) entry.fn();
        }
    };
};

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('sleep entry — the declarative half', () => {
    it('publishes the metadata literal a model sees, in full', () => {
        expect(metadata).toEqual({
            name: 'sleep',
            description:
                'Pause this agent for a wall-clock delay and resume it when the timer expires. Pass `seconds`: how long to wait, from 0 to 3600 (one hour) — 0 yields the rest of the turn without waiting, and a fraction is honoured (0.5 waits half a second). The sleep is not a background task: this tool call stays open for exactly that long, and the timer expiring is what wakes the run and lets it continue, so use it when the wait itself is the work (let a child you spawned land, space out polls) rather than something to fill a turn with. A stop of the run, or a request to abandon this call, ends the wait early rather than failing it: the timer is cleared and nothing waits out the rest of the delay. Out-of-range or non-numeric values are refused before anything is waited.',
            // Tags are the ONLY discovery path for a searchable row: toolRequest matches a
            // query against these words, so an absent tag is an unreachable tool.
            tags: ['sleep', 'wait', 'delay', 'timer', 'pause', 'seconds', 'time'],
            visibility: 'searchable',
            parameters: {
                type: 'object',
                properties: {
                    seconds: {
                        type: 'number',
                        minimum: 0,
                        maximum: 3600,
                        description:
                            'How long to wait, in seconds: 0 to 3600 (one hour). A fraction is honoured (0.5 waits half a second); 0 returns without waiting. Values outside that range, and anything that is not a number, are refused and nothing is slept.'
                    }
                },
                required: ['seconds'],
                additionalProperties: false
            }
        });
    });

    it('registers always, sync, listed, and never always-declared', () => {
        // The whole literal, exactly: `mode: 'sync'` is the wake, `activation: 'always'`
        // is what puts a pause in a library harness AND a server session, and the absence
        // of `sessionBound` is the claim that a sleep needs no live session to run.
        expect(registration).toEqual({
            group: 'runtime',
            activation: 'always',
            mode: 'sync',
            order: 145,
            alwaysDeclared: false,
            listed: true
        });
        expect(registration).not.toHaveProperty('sessionBound');
        expect(registration).not.toHaveProperty('pendingOnly');
        expect(registration).not.toHaveProperty('control');
    });

    it('slots its order between actionRequest and toolCancel', () => {
        expect(actionRequestRegistration.order).toBe(140);
        expect(toolCancelRegistration.order).toBe(150);
        // Declared BEFORE the control that can cut the wait short, and inside the gap the
        // numbered orders were spaced to leave room for exactly this kind of insertion.
        expect(actionRequestRegistration.order).toBeLessThan(registration.order);
        expect(registration.order).toBeLessThan(toolCancelRegistration.order);
    });

    it('publishes the bounds it enforces, on the ceiling every model bound shares', () => {
        const seconds = (metadata.parameters.properties as Record<string, Record<string, unknown>>)
            .seconds;

        // The published schema is the door, so it may never be wider than the check inside
        // `execute` (docs/runtime-tools.md:206-222). Both halves name the same numbers.
        expect(seconds.minimum).toBe(SLEEP_MIN_SECONDS);
        expect(seconds.maximum).toBe(SLEEP_MAX_SECONDS);
        expect(SLEEP_MIN_SECONDS).toBe(0);
        expect(SLEEP_MAX_SECONDS).toBe(3600);
        // 3600 s is `MODEL_TIMEOUT_MAX_MS` in the unit this tool speaks: one ceiling for
        // every wall clock a model may set (delegate's and threadFork's `timeoutMs`).
        expect(SLEEP_MAX_SECONDS * 1000).toBe(MODEL_TIMEOUT_MAX_MS);
        // The prose carries the same facts a caller would otherwise have to guess, plus the
        // M2 wording: what a shortened wait is promised to do (end early, hold nothing) and
        // NOT the `{ sleptMs, cancelled }` payload a model never receives on those doors —
        // the wording that shipped before the review promised exactly that.
        expect(metadata.description).toContain('`seconds`');
        expect(metadata.description).toContain('0 to 3600 (one hour)');
        expect(metadata.description).toContain('the timer expiring is what wakes the run');
        expect(metadata.description).toContain('a fraction is honoured (0.5 waits half a second)');
        expect(metadata.description).toContain(
            'ends the wait early rather than failing it: the timer is cleared and nothing waits out the rest of the delay'
        );
        expect(metadata.description).not.toContain('the result then reports the seconds actually slept');
    });

    it('keeps its description out of the words other tools own as query needles', () => {
        // `core/discovery.ts:128-141` scores a description substring at 1 point, so an
        // innocent-looking word turns this row into a hit on somebody else's query. The
        // two that would be wrong: a "cancel" query belongs to `toolCancel` and a
        // "delegate" query to `delegate`, both DECLARED core rows that toolRequest answers
        // as `alreadyAvailable` rather than enabling — and `src/harness.already-available
        // .test.ts` pins exactly those two result sets as empty.
        expect(metadata.description.toLowerCase()).not.toContain('cancel');
        expect(metadata.description.toLowerCase()).not.toContain('delegate');
        // The tag vocabulary stays the honest discovery path.
        expect(metadata.tags).toEqual(['sleep', 'wait', 'delay', 'timer', 'pause', 'seconds', 'time']);
    });

    it('captures no local dependency, so its startup source record stays empty', () => {
        // scripts/check-package-tools.ts asserts `dependencies: []` on this entry's startup
        // record. The specifier list is the exact statement of that contract: the two
        // framework specifiers (type-only `CoreToolMetadata`, plus the `tool` builder
        // knowledge.tool.ts:124 and download.tool.ts:92 already value-import) and the
        // type-only `ToolContext`. Nothing relative to this folder, no `./metadata`.
        const specifiers = [...sourceOf('./sleep.tool.ts').matchAll(/from '([^']+)'/g)].map(
            (match) => match[1]
        );

        expect(specifiers).toEqual(['../../core', '../../core', '../../types']);
    });
});

describe('sleep.execute — the armed timer', () => {
    it('arms exactly seconds * 1000, keeps the handle referenced, and reports the whole duration', () => {
        const clock = useRecordingClock();
        const pending = execute(context(2.5));

        // One handle, the exact delay, and `unrefs: 0`. This is the entry's one deliberate
        // exception to the `armWallClock` rule (harness.ts:911-941): a wall-clock BOUND is
        // background work the host is not waiting on, while this timer IS the awaited work,
        // so it must hold the process open for the length of the wait. Any `unref()` here
        // fails this pin; the real-timer case below shows what that bug looked like.
        expect(clock.armed()).toEqual([{ delay: 2500, unrefs: 0 }]);

        vi.advanceTimersByTime(2500);
        clock.fire();

        return expect(pending).resolves.toEqual({
            sleptMs: 2500,
            sleptSeconds: 2.5,
            requestedSeconds: 2.5,
            cancelled: false,
            message: WOKE(2.5)
        });
    });

    it('takes the unwrapped number AND the { seconds } wrapper', () => {
        const clock = useRecordingClock();

        // The live path (exactly ONE property → unwrapped value, core/tool.ts
        // toolParameterKey → resolveToolParameters): a bare number.
        const bare = execute(context(2));

        expect(clock.armed()).toEqual([{ delay: 2000, unrefs: 0 }]);

        vi.advanceTimersByTime(2000);
        clock.fire();

        return bare.then((first) => {
            expect(first).toEqual({
                sleptMs: 2000,
                sleptSeconds: 2,
                requestedSeconds: 2,
                cancelled: false,
                message: WOKE(2)
            });

            // The wrapper shape a hand-built `executeTool` context can carry, and the
            // shape the schema advertises to the model.
            const wrapped = execute(context({ seconds: 3 }));

            expect(clock.armed()).toEqual([{ delay: 3000, unrefs: 0 }]);

            vi.advanceTimersByTime(3000);
            clock.fire();

            return expect(wrapped).resolves.toEqual({
                sleptMs: 3000,
                sleptSeconds: 3,
                requestedSeconds: 3,
                cancelled: false,
                message: WOKE(3)
            });
        });
    });

    it('rounds the arm delay to whole milliseconds (the float guard)', () => {
        const clock = useRecordingClock();

        execute(context(0.1));

        // `0.1 * 1000` is 100.00000000000001 in IEEE-754; arming THAT would make the
        // published delay unassertable, and arming 100.4 (from 0.0004) is the same bug.
        expect(clock.armed()).toEqual([{ delay: 100, unrefs: 0 }]);

        clock.fire();
        execute(context({ seconds: 0.0004 }));

        expect(clock.armed()).toEqual([{ delay: 0, unrefs: 0 }]);

        clock.fire();
    });

    it('accepts both bounds exactly: 0 arms a tick, 3600 arms one hour', () => {
        const clock = useRecordingClock();

        const zero = execute(context(SLEEP_MIN_SECONDS));

        expect(clock.armed()).toEqual([{ delay: 0, unrefs: 0 }]);

        vi.advanceTimersByTime(0);
        clock.fire();

        return zero.then((first) => {
            expect(first).toEqual({
                sleptMs: 0,
                sleptSeconds: 0,
                requestedSeconds: 0,
                cancelled: false,
                message: WOKE(0)
            });

            const ceiling = execute(context(SLEEP_MAX_SECONDS));

            expect(clock.armed()).toEqual([{ delay: 3600000, unrefs: 0 }]);

            vi.advanceTimersByTime(3600000);
            clock.fire();

            return expect(ceiling).resolves.toEqual({
                sleptMs: 3600000,
                sleptSeconds: 3600,
                requestedSeconds: 3600,
                cancelled: false,
                message: WOKE(3600)
            });
        });
    });

    it('settles nothing before the delay and everything after it, on vitest\'s own clock', () => {
        // The second, independent proof of the armed delay: this clock is vitest's, so the
        // entry cannot be passing a delay its own stub would happily echo back.
        vi.useFakeTimers();

        let settled: SleepResult | undefined;
        const pending = execute(context(2.5)).then((result) => {
            settled = result;
        });

        expect(vi.getTimerCount()).toBe(1);

        vi.advanceTimersByTime(2499);

        return flush().then(async () => {
            expect(settled).toBeUndefined();
            expect(vi.getTimerCount()).toBe(1);

            vi.advanceTimersByTime(1);
            await flush();

            expect(settled).toEqual({
                sleptMs: 2500,
                sleptSeconds: 2.5,
                requestedSeconds: 2.5,
                cancelled: false,
                message: WOKE(2.5)
            });
            // A fired one-shot is consumed: nothing is left to hold the process or the run.
            expect(vi.getTimerCount()).toBe(0);

            return pending;
        });
    });
});

describe('sleep.execute — cancellation', () => {
    it('clears the armed timer on abort and reports the time actually waited', () => {
        vi.useFakeTimers();

        const controller = new AbortController();
        const pending = execute(context(5, controller.signal));

        expect(vi.getTimerCount()).toBe(1);

        // Two seconds waited, then a cancel: `sleptMs` is what elapsed, NOT the 5 that was
        // asked for, which is the whole point of returning instead of throwing.
        vi.advanceTimersByTime(2000);
        controller.abort();

        expect(vi.getTimerCount()).toBe(0);

        return pending.then((result) => {
            expect(result).toEqual({
                sleptMs: 2000,
                sleptSeconds: 2,
                requestedSeconds: 5,
                cancelled: true,
                reason: ABORT_MESSAGE,
                message: CANCELLED(2, 5)
            });

            // A cleared handle never fires late: running the rest of the minute proves it.
            vi.advanceTimersByTime(60000);

            expect(vi.getTimerCount()).toBe(0);
        });
    });

    it('arms nothing at all for a signal that is already aborted', () => {
        vi.useFakeTimers();

        const controller = new AbortController();

        controller.abort();

        const pending = execute(context(30, controller.signal));

        // No timer exists, so there is nothing to clear and the run is released now.
        expect(vi.getTimerCount()).toBe(0);

        return expect(pending).resolves.toEqual({
            sleptMs: 0,
            sleptSeconds: 0,
            requestedSeconds: 30,
            cancelled: true,
            reason: ABORT_MESSAGE,
            message: CANCELLED(0, 30)
        });
    });

    it('removes its own abort listener on the settle path, and clears the timer on the abort path', () => {
        const clock = useRecordingClock();

        // A signal double that counts what the entry registers and what it releases, so
        // the two cleanup rules from core/agent.ts:761-766 are asserted rather than hoped
        // for. (A real AbortSignal exposes no listener accounting in this Node build, which
        // is why the accounting is done here.)
        const listeners: Array<{ fn: () => void; options: unknown }> = [];
        const addEventListener = vi.fn((_type: string, fn: () => void, options: unknown) => {
            listeners.push({ fn, options });
        });
        const removeEventListener = vi.fn(() => {
            listeners.shift();
        });
        const signal = {
            aborted: false,
            addEventListener,
            removeEventListener
        };

        const settled = execute(context(4, signal as unknown as AbortSignal));

        expect(addEventListener).toHaveBeenCalledTimes(1);
        expect(addEventListener.mock.calls[0][0]).toBe('abort');
        expect(addEventListener.mock.calls[0][2]).toEqual({ once: true });
        expect(removeEventListener).not.toHaveBeenCalled();

        vi.advanceTimersByTime(4000);
        clock.fire();

        return settled.then((result) => {
            expect(result).toEqual({
                sleptMs: 4000,
                sleptSeconds: 4,
                requestedSeconds: 4,
                cancelled: false,
                message: WOKE(4)
            });
            // The timer path drops the listener, so it cannot leak into a later run.
            expect(removeEventListener).toHaveBeenCalledTimes(1);
            expect(removeEventListener.mock.calls[0][0]).toBe('abort');
            expect(removeEventListener.mock.calls[0][1]).toBe(addEventListener.mock.calls[0][1]);
            expect(listeners).toEqual([]);
            // And the normal path never touches clearTimeout.
            expect(clock.cleared()).toBe(0);

            // --- the other path, on a fresh signal
            const cancelListeners: Array<() => void> = [];
            const cancelSignal = {
                aborted: false,
                addEventListener: vi.fn((_type: string, fn: () => void) => {
                    cancelListeners.push(fn);
                }),
                removeEventListener: vi.fn()
            };

            const cancelled = execute(context(9, cancelSignal as unknown as AbortSignal));

            vi.advanceTimersByTime(1000);
            cancelSignal.aborted = true;

            for (const fn of cancelListeners) fn();

            // A second dispatch of the same listener (a re-fire, or `once` plus an explicit
            // remove racing each other) must be a no-op, not a double clear.
            for (const fn of cancelListeners) fn();

            return cancelled.then((second) => {
                expect(second).toEqual({
                    sleptMs: 1000,
                    sleptSeconds: 1,
                    requestedSeconds: 9,
                    cancelled: true,
                    message: CANCELLED(1, 9)
                });
                expect(clock.cleared()).toBe(1);
                expect(cancelSignal.removeEventListener).toHaveBeenCalledTimes(1);
            });
        });
    });
});

describe('sleep.execute — refusals arm nothing', () => {
    // Every value the entry rejects, with the exact sentence it throws. A direct caller
    // skips JSON Schema (core/schema-validation.ts runs only on the model path), so these
    // messages are the door for that caller.
    const REFUSALS: Array<[string, unknown, string]> = [
        ['above the ceiling', 3601, 'sleep "seconds" must be between 0 and 3600. Received 3601.'],
        ['below the floor', -1, 'sleep "seconds" must be between 0 and 3600. Received -1.'],
        [
            'the wrapper above the ceiling',
            { seconds: 4000 },
            'sleep "seconds" must be between 0 and 3600. Received 4000.'
        ],
        [
            'a string',
            'soon',
            'sleep needs "seconds" as a number between 0 and 3600. Received "soon".'
        ],
        [
            'a wrapper string',
            { seconds: 'soon' },
            'sleep needs "seconds" as a number between 0 and 3600. Received "soon".'
        ],
        [
            'a wrapper boolean',
            { seconds: true },
            'sleep needs "seconds" as a number between 0 and 3600. Received true.'
        ],
        [
            'no seconds at all',
            {},
            'sleep needs "seconds" as a number between 0 and 3600. Received an object with no "seconds" ({}).'
        ],
        [
            'undefined',
            undefined,
            'sleep needs "seconds" as a number between 0 and 3600. Received undefined.'
        ],
        [
            'null',
            null,
            'sleep needs "seconds" as a number between 0 and 3600. Received null.'
        ],
        ['NaN', Number.NaN, 'sleep needs "seconds" as a number between 0 and 3600. Received NaN.'],
        [
            'Infinity',
            Number.POSITIVE_INFINITY,
            'sleep needs "seconds" as a number between 0 and 3600. Received Infinity.'
        ]
    ];

    it('throws the documented message and leaves no timer behind', () => {
        const clock = useRecordingClock();

        for (const [label, parameters, message] of REFUSALS) {
            expect(() => execute(context(parameters)), label).toThrow(new Error(message));
            // The refusal happens BEFORE the promise is built, so nothing is armed —
            // the case that would otherwise leave a cancelled run waiting on a sleep
            // that never reported a duration.
            expect(clock.armed(), label).toEqual([]);
        }
    });
});

describe('sleep — the callable export', () => {
    it('is a Tool under its own name, carrying the declared mode', () => {
        // The browser/scanner-less catalogue selects `module[descriptor.name]`
        // (tools/descriptors.ts:472), so this export is what makes the row loadable there.
        expect(typeof sleep).toBe('function');
        expect(sleep.name).toBe('sleep');
        expect(sleep.description).toBe(metadata.description);
        expect(sleep.tags).toEqual(['sleep', 'wait', 'delay', 'timer', 'pause', 'seconds', 'time']);
        expect(sleep.visibility).toBe('searchable');
        expect(sleep.parameters).toEqual(metadata.parameters);
        expect(sleep.mode).toBe(registration.mode);
    });

    it('runs standalone with either shape, and cannot be cancelled without a signal', async () => {
        // The builder's callable takes the PARAMETER VALUE ONLY and builds its own
        // `{ parameters: value }` context (core/tool.ts:152-157) — so a direct call has no
        // signal, and the wait always runs its length. Real timers: this is the one path
        // no fake clock can speak for.
        const direct = await sleep(0.02);

        expect(direct.requestedSeconds).toBe(0.02);
        expect(direct.cancelled).toBe(false);
        expect(direct.sleptMs).toBeGreaterThanOrEqual(15);
        expect(direct.sleptSeconds).toBe(direct.sleptMs / 1000);
        expect(direct.message).toBe(
            `Slept for ${Number((direct.sleptMs / 1000).toFixed(3))} seconds. The timer expired and the run is awake again.`
        );

        const wrapped = await sleep({ seconds: 0.02 } as unknown as number);

        expect(wrapped.requestedSeconds).toBe(0.02);
        expect(wrapped.cancelled).toBe(false);
    });
});

describe('sleep — real timers', () => {
    it('holds a real event loop until the delay is spent, and a real cancel ends early', async () => {
        // The stub pins the delay and the ABSENCE of `unref()`; what only a real clock can
        // prove is that the wait still fires in a real process and that a real abort really
        // releases it. Without this case a handle that never fired would pass every
        // fake-clock test above.
        const startedAt = Date.now();
        const result = await execute(context(0.05));
        const elapsed = Date.now() - startedAt;

        expect(result).toEqual({
            sleptMs: expect.any(Number),
            sleptSeconds: expect.any(Number),
            requestedSeconds: 0.05,
            cancelled: false,
            message: `Slept for ${Number((result.sleptMs / 1000).toFixed(3))} seconds. The timer expired and the run is awake again.`
        });
        // Elapsed real milliseconds are the only genuinely unknown values in this file.
        expect(elapsed).toBeGreaterThanOrEqual(40);
        expect(result.sleptMs).toBeGreaterThanOrEqual(40);
        expect(result.sleptSeconds).toBe(result.sleptMs / 1000);

        // A real cancel of a thirty-second wait: the promise settles now, not in half a
        // minute, and the number it reports is the short time it actually waited.
        const controller = new AbortController();
        const longWait = execute(context(30, controller.signal));

        await new Promise((resolve) => setTimeout(resolve, 10));
        controller.abort();

        const cancelled = await longWait;

        expect(cancelled.cancelled).toBe(true);
        expect(cancelled.requestedSeconds).toBe(30);
        expect(cancelled.sleptMs).toBeLessThan(5000);
        expect(cancelled.message).toBe(
            `Sleep cancelled after ${Number((cancelled.sleptMs / 1000).toFixed(3))} seconds of the 30 seconds requested; the timer was cleared and nothing waits out the rest of the delay.`
        );
    });

    it('arms a REFERENCED handle while the wait runs, and releases it on both settle paths', async () => {
        // M1, asserted with the platform's own instruments rather than a stub. An `unref()`-ed
        // Timeout is NOT reported by `process.getActiveResourcesInfo()` — that is exactly why
        // the shipped entry let an idle host exit in the middle of an awaited sleep
        // (Temp/review-sleep/probe21.ts printed the line before the call, then exited 0 with
        // no result and no warning). The real `setTimeout` is WRAPPED, never replaced, so
        // `execute` receives a genuine Node handle and `hasRef()` answers the one question
        // that matters here: would this keep the loop alive?
        const arm = globalThis.setTimeout;
        let handle: ReturnType<typeof setTimeout> | undefined;

        vi.stubGlobal(
            'setTimeout',
            (fn: () => void, ms?: number): ReturnType<typeof setTimeout> => {
                handle = arm(fn, ms);

                return handle;
            }
        );

        const liveTimeouts = (): number =>
            process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length;

        // --- the ABORT path: held while it waits, gone the instant the abort lands.
        const controller = new AbortController();
        const beforeAbort = liveTimeouts();
        const cancelled = execute(context(30, controller.signal));

        // `hasRef` is Node's own method; its absence would mean this suite stopped running in
        // the real Node world the rest of the file asserts against.
        expect(typeof handle?.hasRef).toBe('function');
        expect(handle?.hasRef()).toBe(true);

        // Both reads are synchronous, so the +1 can only come from THIS call's timer — and an
        // unref-ed handle would not be listed at all, which is the bug this pins.
        expect(liveTimeouts()).toBe(beforeAbort + 1);

        controller.abort();

        // `clearTimeout` runs inside the abort listener, so the hold is lifted without a
        // promise turn: measured before `await`, so nothing the runner does between turns can
        // move the count.
        expect(liveTimeouts()).toBe(beforeAbort);
        expect((await cancelled).cancelled).toBe(true);

        // --- the FIRE path: held for the whole delay, then consumed by the fire itself.
        const beforeFire = liveTimeouts();
        const woke = execute(context(0.02));

        expect(handle?.hasRef()).toBe(true);
        expect(liveTimeouts()).toBe(beforeFire + 1);

        const result = await woke;

        expect(result.cancelled).toBe(false);
        expect(result.requestedSeconds).toBe(0.02);
        // A fired one-shot stops holding the process; this is the assertion that separates
        // "referenced" from "leaked", and it is why removing `unref()` is not a handle leak.
        expect(liveTimeouts()).toBe(beforeFire);
    });
});

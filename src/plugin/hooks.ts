// Typed lifecycle hook bus (R2/R3 plugins).
//
// WHY A SEPARATE BUS INSTEAD OF `report.progress`
// ------------------------------------------------
// `report.progress` is an OUTPUT mirror: one callback that sees every event frame and
// must not change anything. A plugin hook is an INPUT: it can rewrite the request
// about to leave the harness (`turn.before`), and it runs at a point where the run is
// parked and waiting. Those two need different failure rules, so they live in
// different places:
//
//   - progress: a throwing reporter FAILS the run (harness.ts `emit`), because a live
//     consumer that lost sync must be visible;
//   - a hook: a throwing handler is SKIPPED and the run continues (fail-open, below),
//     because an optional extension must never be able to break a conversation.
//
// THE RULES
// ---------
//   1. SEQUENTIAL. Handlers run in registration order, one at a time, awaited. A
//      compaction hook and a logging hook interleaving would make the request
//      nondeterministic, and `turn.before` overrides are LAST NON-EMPTY WINS, which
//      only means something with a defined order.
//   2. FAIL-OPEN. A handler that throws (sync or async) is dropped; the remaining
//      handlers still run. This is the whole reason `emit` never rejects.
//   3. SNAPSHOT ITERATION. `emit` walks a copy, so a handler that subscribes or
//      unsubscribes during an emit cannot mutate the loop it is part of (and cannot
//      make a later handler skip).
//   4. SYNC POINTS EXIST. Thread create/delete/stop/pause happen inside synchronous
//      handle methods that a caller cannot await. `fire()` covers those: it starts the
//      handlers in order and swallows everything, including a rejected promise a
//      handler returned anyway. A sync emitter that awaited would have turned
//      `harness.createThread(...)` into a promise, which is exactly the shape change
//      the plugin host has always refused.
//   5. EMPTY IS FREE — AND THE EMITTER MUST PROVE IT. `has(event)` lets a call site
//      skip the emit entirely, which matters beyond cost: `await`ing a resolved promise
//      still yields a microtask, and the harness interleaves a delegated child's run
//      with its parent's event frames on exactly those boundaries. An unguarded
//      `await emit(...)` therefore changes OBSERVABLE event order even with zero plugins
//      installed (the server's delegation-order test caught this). Every harness emit
//      site is written `if (bus.has(event)) await bus.emit(...)`, and the factory payload
//      form keeps the argument construction behind the same check.
//   6. SUBSCRIBED-YET-INERT IS ALSO FREE — `emitMaybeSync`. Rule 5 stops covering cost
//      as soon as a hook becomes PERMANENT: the shipped `context-compaction` plugin
//      always registers `turn.before`, and on an under-limit turn (i.e. almost every
//      turn in production) its handler returns synchronously. `has()` is then true, so
//      the await happens anyway and the ordering loss returns. `emitMaybeSync` is the
//      answer: it runs the same sequential, fail-open round and returns
//      `{ sync: true, value }` while every handler stayed synchronous, switching to
//      `{ sync: false, promise }` only at the FIRST handler that produced a thenable.
//      A call site can therefore apply the result with no `await` on the hot path —
//      which is exactly the pre-plugin boundary `src/server/queue.test.ts` pins.
//
// Cross-references:
//   - ../types               — HarnessLifecycleEvent / Payloads / Handler, HarnessHookResult
//   - ./host.ts              — wraps `on` per plugin and owns this bus's lifetime
//   - ../harness.ts          — the only emitter (createThreadState, runAgent, requestTurn
//                              (`turn.before` via `emitMaybeSync`), launchToolCall,
//                              launchThreadFork, launchActionRequest, deliverTask,
//                              scheduler onWake)

import type {
    HarnessLifecycleEvent,
    HarnessLifecycleHandler,
    HarnessLifecyclePayloads,
    HarnessMessage,
    HarnessPluginApi
} from '../types';

// Diagnostics for a handler that threw. The harness does not fail a run for this, so
// without a reporter the failure would be invisible; the option exists so a host (or
// a test) can observe it.
export type HarnessHookErrorContext = {
    event: HarnessLifecycleEvent;
    owner: string;
    error: unknown;
};

// One subscription. `owner` is the plugin name (diagnostics only) and `api` is the
// per-plugin api handed back inside `turn.before`, so a handler sees ITS OWN scoped
// settings rather than another plugin's.
type HookEntry = {
    owner: string;
    api?: HarnessPluginApi;
    // Stored type-erased: the map keys the event, and the ONLY way a caller reaches a
    // handler is through the typed `on`/`emit` pair above, which cannot mix them.
    handler: (payload: never) => unknown;
};

// Merged result of one emit. Only `turn.before` can produce a transcript; every other
// event's result is an empty object, which callers ignore.
export type HarnessMergedHookResult = {
    transcript?: readonly HarnessMessage[];
};

// One round's outcome, told apart by a discriminant instead of by `await`: a caller
// that gets `{ sync: true }` applies the value on the SAME tick, with no microtask
// boundary, while `{ sync: false }` means a handler did real work and the boundary is
// the point. This is the mechanic behind rule 6 — a permanent hook that is currently
// inert costs exactly nothing, which `await`-only dispatch cannot promise.
export type HarnessMaybeAsync<T> =
    | { sync: true; value: T }
    | { sync: false; promise: Promise<T> };

// A payload may be given outright or as a factory. The factory form exists for two
// reasons that both matter at `turn.before`:
//   - it is only called when the event actually HAS listeners (rule 5: an unused hook
//     costs nothing), and
//   - it is called ONCE PER HANDLER, so a handler that runs after another handler has
//     already rewritten something observes the CURRENT value instead of a snapshot
//     taken before the round. Hook order is only observable if later handlers can see
//     what earlier ones did.
// The factory receives the owning plugin's api (when the bus has one) so a context
// object can be built with the right api baked in, rather than patched afterwards.
export type HarnessHookPayloadFactory<E extends HarnessLifecycleEvent> = (context: {
    api?: HarnessPluginApi;
}) => HarnessLifecyclePayloads[E];

export type HarnessHookBus = {
    // Subscribe. Returns an idempotent unsubscribe bound to THIS registration, so two
    // identical handlers from two plugins are independent.
    on: <E extends HarnessLifecycleEvent>(
        event: E,
        handler: HarnessLifecycleHandler<E>,
        registration?: { owner: string; api?: HarnessPluginApi }
    ) => () => void;
    // Awaited, sequential, fail-open. Resolves with the merged override (if any).
    // Hop count: this is the shape for a call site that is going to `await` regardless
    // (an optional hook with no permanent subscriber). A hook that is ALWAYS subscribed
    // and usually inert wants `emitMaybeSync` instead — see rule 6.
    emit: <E extends HarnessLifecycleEvent>(
        event: E,
        payload: HarnessLifecyclePayloads[E] | HarnessHookPayloadFactory<E>
    ) => Promise<HarnessMergedHookResult>;
    // Same sequential, fail-open round as `emit`, but it stays on the caller's tick
    // while no handler returns a promise. `turn.before` uses it because the shipped
    // `context-compaction` plugin subscribes permanently and returns synchronously
    // under the limit; awaiting that every turn moved observable event order.
    emitMaybeSync: <E extends HarnessLifecycleEvent>(
        event: E,
        payload: HarnessLifecyclePayloads[E] | HarnessHookPayloadFactory<E>
    ) => HarnessMaybeAsync<HarnessMergedHookResult>;
    // Synchronous fire-and-forget for a lifecycle point inside a sync handle method.
    fire: <E extends HarnessLifecycleEvent>(
        event: E,
        payload: HarnessLifecyclePayloads[E] | HarnessHookPayloadFactory<E>
    ) => void;
    // True when at least one handler is registered — the emitter's cheap skip test.
    has: (event: HarnessLifecycleEvent) => boolean;
    count: (event: HarnessLifecycleEvent) => number;
    // Every event that currently has listeners, plus the owners per event. This is
    // what the server reports as the LIVE hook surface of a plugin (declared
    // `metadata.hooks` is the intent; this is the fact).
    live: () => Partial<Record<HarnessLifecycleEvent, string[]>>;
    // Drop every subscription (harness teardown / tests).
    clear: () => void;
};

// A thenable, recognised structurally (a hand-rolled promise-like from a host plugin
// must be treated as async just like a native one). `fire` and `emitMaybeSync` both
// need this test, and neither may throw while performing it.
const isThenable = (value: unknown): value is PromiseLike<unknown> =>
    value !== null && typeof value === 'object' && typeof (value as PromiseLike<unknown>).then === 'function';

// An event name is only ever a plain string here, but a caller could pass anything,
// so the map is guarded on read rather than trusted.
const isEventName = (value: unknown): value is HarnessLifecycleEvent =>
    typeof value === 'string' && value.length > 0;

// Normalize one handler result into an override. A non-object, an object without a
// usable `transcript`, and an EMPTY array all mean "no override": an empty transcript
// is never a meaningful request body, and a hook that returns [] is almost certainly
// signalling "nothing to say" rather than "send no messages".
const overrideOf = (result: unknown): readonly HarnessMessage[] | undefined => {
    if (result === null || typeof result !== 'object' || Array.isArray(result)) return undefined;

    const transcript = (result as { transcript?: unknown }).transcript;
    if (!Array.isArray(transcript) || transcript.length === 0) return undefined;

    return transcript as readonly HarnessMessage[];
};

export type HarnessHookBusOptions = {
    // Called once per handler that threw. Absent = silent (still skipped).
    onHandlerError?: (context: HarnessHookErrorContext) => void;
};

// Build one bus. A harness owns exactly one, so subscriptions die with it and a test
// harness never inherits another test's hooks.
export const createHookBus = (options: HarnessHookBusOptions = {}): HarnessHookBus => {
    const registrations = new Map<HarnessLifecycleEvent, HookEntry[]>();

    const report = (event: HarnessLifecycleEvent, entry: HookEntry, error: unknown): void => {
        try {
            options.onHandlerError?.({ event, owner: entry.owner, error });
        } catch {
            // A diagnostics reporter must never become the failure it reports.
        }
    };

    const entriesOf = (event: HarnessLifecycleEvent): HookEntry[] => {
        if (!isEventName(event)) return [];
        return registrations.get(event) ?? [];
    };

    const on = <E extends HarnessLifecycleEvent>(
        event: E,
        handler: HarnessLifecycleHandler<E>,
        registration?: { owner: string; api?: HarnessPluginApi }
    ): (() => void) => {
        if (!isEventName(event)) {
            throw new TypeError(`Unknown lifecycle event: ${String(event)}.`);
        }

        if (typeof handler !== 'function') {
            throw new TypeError(`A "${event}" handler must be a function.`);
        }

        const entry: HookEntry = {
            owner: registration?.owner ?? '',
            ...(registration?.api === undefined ? {} : { api: registration.api }),
            handler: handler as unknown as (payload: never) => unknown
        };

        const list = registrations.get(event);
        if (list === undefined) registrations.set(event, [entry]);
        else list.push(entry);

        // Identity removal: `filter` keeps every OTHER entry, so a duplicate handler
        // registered twice still runs twice until each registration is removed.
        return (): void => {
            const current = registrations.get(event);
            if (current === undefined) return;

            const index = current.indexOf(entry);
            if (index < 0) return;

            current.splice(index, 1);
            if (current.length === 0) registrations.delete(event);
        };
    };

    // Resolve one handler's payload. A plain payload is handed over unchanged (no
    // copy): a record the emitter already detached is safe to share.
    const payloadFor = <E extends HarnessLifecycleEvent>(
        payload: HarnessLifecyclePayloads[E] | HarnessHookPayloadFactory<E>,
        api?: HarnessPluginApi
    ): HarnessLifecyclePayloads[E] =>
        typeof payload === 'function'
            ? (payload as HarnessHookPayloadFactory<E>)({ ...(api === undefined ? {} : { api }) })
            : payload;

    // The async tail of one round. `firstResult` is the promise returned by the handler
    // at `startIndex`; from that index on everything is awaited. Handler order, the
    // per-handler payload factory and fail-open are unchanged from the synchronous
    // prefix — the only difference is that the round is already on a microtask.
    const finishRound = async <E extends HarnessLifecycleEvent>(
        event: E,
        payload: HarnessLifecyclePayloads[E] | HarnessHookPayloadFactory<E>,
        snapshot: HookEntry[],
        startIndex: number,
        firstResult: PromiseLike<unknown>,
        transcript?: readonly HarnessMessage[]
    ): Promise<HarnessMergedHookResult> => {
        let current = transcript;

        for (let index = startIndex; index < snapshot.length; index += 1) {
            const entry = snapshot[index];

            try {
                // The handler at `startIndex` already RAN; only its result is still
                // outstanding. Later handlers are invoked one at a time, each with a
                // freshly resolved payload, so a later hook still sees what an earlier
                // one rewrote (rule 1).
                const result =
                    index === startIndex
                        ? await firstResult
                        : await (entry.handler as (p: unknown) => unknown)(
                              payloadFor(payload, entry.api)
                          );

                const override = overrideOf(result);
                if (override !== undefined) current = override;
            } catch (error) {
                // Fail-open, and a rejected handler promise lands here too: the round
                // still finishes for the handlers that survived (rule 2).
                report(event, entry, error);
            }
        }

        return current === undefined ? {} : { transcript: current };
    };

    const emitMaybeSync = <E extends HarnessLifecycleEvent>(
        event: E,
        payload: HarnessLifecyclePayloads[E] | HarnessHookPayloadFactory<E>
    ): HarnessMaybeAsync<HarnessMergedHookResult> => {
        // Snapshot up front (rule 3): a handler may (un)subscribe during this round, and
        // that must never change which handlers THIS round visits.
        const snapshot = [...entriesOf(event)];
        if (snapshot.length === 0) return { sync: true, value: {} };

        let transcript: readonly HarnessMessage[] | undefined;

        for (let index = 0; index < snapshot.length; index += 1) {
            const entry = snapshot[index];

            let result: unknown;

            try {
                result = (entry.handler as (p: unknown) => unknown)(
                    payloadFor(payload, entry.api)
                );
            } catch (error) {
                report(event, entry, error);
                continue;
            }

            // THE boundary: the first handler that produced a promise hands the rest of
            // the round to `finishRound`. Nothing before this line yielded.
            if (isThenable(result)) {
                return {
                    sync: false,
                    promise: finishRound(event, payload, snapshot, index, result, transcript)
                };
            }

            const override = overrideOf(result);
            if (override !== undefined) transcript = override;
        }

        return { sync: true, value: transcript === undefined ? {} : { transcript } };
    };

    // `emit` is the round with the await the caller asked for. The sync branch returns
    // an already-resolved promise instead of running through an `async` wrapper, so the
    // no-listener case costs one microtask rather than two — and every harness site has
    // already skipped it behind `has()`.
    const emit = <E extends HarnessLifecycleEvent>(
        event: E,
        payload: HarnessLifecyclePayloads[E] | HarnessHookPayloadFactory<E>
    ): Promise<HarnessMergedHookResult> => {
        const round = emitMaybeSync(event, payload);
        return round.sync ? Promise.resolve(round.value) : round.promise;
    };

    const fire = <E extends HarnessLifecycleEvent>(
        event: E,
        payload: HarnessLifecyclePayloads[E] | HarnessHookPayloadFactory<E>
    ): void => {
        for (const entry of [...entriesOf(event)]) {
            try {
                const result = (entry.handler as (p: unknown) => unknown)(
                    payloadFor(payload, entry.api)
                );

                // A sync emitter cannot await, so an async handler's rejection is
                // observed (and reported) but never changes the caller's path.
                if (isThenable(result)) {
                    result.then(undefined, (error: unknown) => {
                        report(event, entry, error);
                    });
                }
            } catch (error) {
                report(event, entry, error);
            }
        }
    };

    return {
        on,
        emit,
        emitMaybeSync,
        fire,
        has: (event: HarnessLifecycleEvent) => entriesOf(event).length > 0,
        count: (event: HarnessLifecycleEvent) => entriesOf(event).length,
        live: () => {
            const result: Partial<Record<HarnessLifecycleEvent, string[]>> = {};

            for (const [event, list] of registrations) {
                if (list.length === 0) continue;
                result[event] = list.map((entry) => entry.owner);
            }

            return result;
        },
        clear: () => {
            registrations.clear();
        }
    };
};

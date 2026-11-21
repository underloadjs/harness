// The lifecycle hook bus (src/plugin/hooks.ts).
//
// Pins the four rules the framework depends on, each of which exists because of a
// concrete failure it prevents:
//   - SEQUENTIAL + AWAITED: hook order is the only ordering a plugin author can rely
//     on, and a later handler must see what an earlier one did;
//   - FAIL-OPEN: an optional extension must never break a conversation;
//   - LAST NON-EMPTY transcript override wins, and an empty array is NOT an override;
//   - a SYNC emitter (`fire`) for the lifecycle points inside synchronous handle
//     methods, including a handler that returned a rejected promise anyway;
//   - `emitMaybeSync`: the same sequential, fail-open round, but WITHOUT a microtask
//     boundary while every handler stays synchronous. `turn.before` needs that because
//     the shipped `context-compaction` plugin subscribes permanently and is inert under
//     its limit (plugin/hooks.ts rule 6), and an unconditional `await` there moved
//     observer-visible event order in src/server/queue.test.ts.
//
// Every assertion is an exact value (no range checks), so a change in merge or ordering
// behavior fails loudly.

import { describe, expect, it } from 'vitest';
import { createHookBus } from './hooks';
import type { HarnessLifecycleEvent, HarnessMessage } from '../types';

// One user message, reused across the transcript assertions.
const user = (content: string): HarnessMessage => ({ role: 'user', content });

// The full `turn.before` payload, written once: the maybe-sync assertions below need it
// in every case, and its shape (not its content) is what they exercise.
const turnPayload = (messages: HarnessMessage[]) => ({
    threadId: 'agent:writer',
    agent: 'writer',
    iteration: 1,
    messages,
    estimatedTokens: 1,
    signal: new AbortController().signal,
    api: undefined as never,
    setTranscript: () => undefined,
    replaceHistory: () => undefined,
    pause: async () => undefined,
    resume: async () => undefined
});

describe('createHookBus', () => {
    it('runs handlers sequentially in registration order and awaits async ones', async () => {
        const bus = createHookBus();
        const order: string[] = [];

        bus.on('thread.created', () => {
            order.push('sync-a');
        });
        bus.on('thread.created', async () => {
            // An async handler must complete before the next one starts; without the
            // await, 'slow' would land last and a compaction hook could race a logger.
            await Promise.resolve();
            order.push('slow');
        });
        bus.on('thread.created', () => {
            order.push('sync-b');
        });

        await bus.emit('thread.created', { id: 'thread-1', agent: 'writer', origin: 'host', status: 'idle', sequence: 1 });

        expect(order).toEqual(['sync-a', 'slow', 'sync-b']);
    });

    it('skips a throwing handler and still runs the rest (fail-open)', async () => {
        const failures: Array<{ event: HarnessLifecycleEvent; owner: string; error: unknown }> = [];
        const bus = createHookBus({
            onHandlerError: (context) => failures.push(context)
        });
        const seen: string[] = [];

        bus.on(
            'thread.deleted',
            () => {
                throw new Error('boom');
            },
            { owner: 'broken' }
        );
        bus.on(
            'thread.deleted',
            async () => {
                await Promise.resolve();
                throw 'rejected-string';
            },
            { owner: 'async-broken' }
        );
        bus.on(
            'thread.deleted',
            () => {
                seen.push('survivor');
            },
            { owner: 'ok' }
        );

        // `emit` must RESOLVE: a rejecting hook is reported, never propagated.
        await expect(
            bus.emit('thread.deleted', { threadId: 'thread-1', agent: 'writer' })
        ).resolves.toEqual({});

        expect(seen).toEqual(['survivor']);
        expect(failures).toEqual([
            { event: 'thread.deleted', owner: 'broken', error: new Error('boom') },
            { event: 'thread.deleted', owner: 'async-broken', error: 'rejected-string' }
        ]);
    });

    it('merges a turn.before transcript override: last non-empty wins', async () => {
        const bus = createHookBus();

        bus.on('turn.before', () => ({ transcript: [user('first')] }));
        bus.on('turn.before', () => ({ transcript: [user('second')] }));

        const merged = await bus.emit('turn.before', () => ({
            threadId: 'thread-1',
            agent: 'writer',
            iteration: 1,
            messages: [user('original')],
            estimatedTokens: 3,
            signal: new AbortController().signal,
            api: undefined as never,
            setTranscript: () => undefined,
            replaceHistory: () => undefined,
            pause: async () => undefined,
            resume: async () => undefined
        }));

        expect(merged).toEqual({ transcript: [user('second')] });
    });

    it('treats an empty returned transcript as "no override"', async () => {
        const bus = createHookBus();

        bus.on('turn.before', () => ({ transcript: [] }));

        const merged = await bus.emit('turn.before', () => ({
            threadId: 'thread-1',
            agent: 'writer',
            iteration: 1,
            messages: [user('keep')],
            estimatedTokens: 1,
            signal: new AbortController().signal,
            api: undefined as never,
            setTranscript: () => undefined,
            replaceHistory: () => undefined,
            pause: async () => undefined,
            resume: async () => undefined
        }));

        // An empty request body is never what the caller meant; ignoring it keeps a
        // hook that returns nothing from silently sending no messages.
        expect(merged).toEqual({});
    });

    it('builds the payload once per handler so a later hook sees an earlier rewrite', async () => {
        const bus = createHookBus();
        const observed: number[] = [];
        let current = 0;

        bus.on('turn.after', () => {
            observed.push(current);
            current += 1;
        });
        bus.on('turn.after', () => {
            observed.push(current);
            current += 1;
        });

        // The factory form is what makes the value live per handler.
        await bus.emit('turn.after', () => ({
            agent: 'writer',
            depth: 1,
            input: 'go',
            iteration: 1,
            message: {
                role: 'assistant',
                content: 'ok',
                reasoning: '',
                toolCalls: [],
                model: 'm',
                stopReason: 'stop'
            },
            snapshot: current
        }));

        expect(observed).toEqual([0, 1]);
    });

    it('hands each handler its OWN registration api (scoped settings)', async () => {
        const bus = createHookBus();
        const apis: string[] = [];

        bus.on(
            'turn.before',
            (payload) => {
                apis.push((payload.api as { label: string }).label);
            },
            { owner: 'a', api: { label: 'a-api' } as never }
        );
        bus.on(
            'turn.before',
            (payload) => {
                apis.push((payload.api as { label: string }).label);
            },
            { owner: 'b', api: { label: 'b-api' } as never }
        );

        await bus.emit('turn.before', ({ api }) => ({
            threadId: 'thread-1',
            agent: 'writer',
            iteration: 1,
            messages: [],
            estimatedTokens: 0,
            signal: new AbortController().signal,
            api: api as never,
            setTranscript: () => undefined,
            replaceHistory: () => undefined,
            pause: async () => undefined,
            resume: async () => undefined
        }));

        expect(apis).toEqual(['a-api', 'b-api']);
    });

    it('unsubscribes exactly one registration, idempotently', async () => {
        const bus = createHookBus();
        let calls = 0;

        // Two identical handlers from two plugins must stay independent.
        const offFirst = bus.on('tool.before', () => {
            calls += 1;
        });
        bus.on('tool.before', () => {
            calls += 1;
        });

        const payload = { agent: 'writer', depth: 1, input: 'go', name: 'read', call: { id: 'c1', name: 'read', arguments: '{}' } };

        await bus.emit('tool.before', payload);
        expect(calls).toBe(2);

        offFirst();
        offFirst();

        expect(bus.count('tool.before')).toBe(1);
        await bus.emit('tool.before', payload);
        expect(calls).toBe(3);
    });

    it('costs nothing when nobody listens (has/count/live)', async () => {
        const bus = createHookBus();
        let built = 0;

        expect(bus.has('turn.before')).toBe(false);
        expect(bus.count('turn.before')).toBe(0);
        expect(bus.live()).toEqual({});

        // A factory payload is never invoked for an event with no listeners.
        await bus.emit('turn.before', () => {
            built += 1;
            return {
                threadId: 'thread-1',
                agent: 'writer',
                iteration: 1,
                messages: [],
                estimatedTokens: 0,
                signal: new AbortController().signal,
                api: undefined as never,
                setTranscript: () => undefined,
                replaceHistory: () => undefined,
                pause: async () => undefined,
                resume: async () => undefined
            };
        });

        expect(built).toBe(0);

        const off = bus.on('thread.stopped', () => undefined, { owner: 'pinger' });
        expect(bus.live()).toEqual({ 'thread.stopped': ['pinger'] });

        off();
        expect(bus.live()).toEqual({});
    });

    it('fire() reports a synchronous throw AND a rejected async handler without throwing', async () => {
        const failures: string[] = [];
        const bus = createHookBus({
            onHandlerError: (context) => failures.push(`${context.owner}:${(context.error as Error).message}`)
        });

        bus.on(
            'thread.created',
            () => {
                throw new Error('sync-boom');
            },
            { owner: 'sync' }
        );
        bus.on(
            'thread.created',
            async () => {
                throw new Error('async-boom');
            },
            { owner: 'async' }
        );

        // `fire` returns void: a createThread call cannot await a hook, so both failure
        // shapes must be observed rather than propagated.
        expect(() =>
            bus.fire('thread.created', {
                id: 'thread-1',
                agent: 'writer',
                origin: 'host',
                status: 'idle',
                sequence: 1
            })
        ).not.toThrow();

        // The sync throw is reported inline; the rejection lands on the microtask queue
        // (a fire-and-forget emitter has nothing to await), so one flush is enough.
        expect(failures).toEqual(['sync:sync-boom']);

        await Promise.resolve();

        expect(failures).toEqual(['sync:sync-boom', 'async:async-boom']);
    });

    it('rejects a non-function handler', () => {
        const bus = createHookBus();

        expect(() => bus.on('thread.idle', undefined as never)).toThrow(
            'A "thread.idle" handler must be a function.'
        );
        expect(() => bus.on(undefined as never, () => undefined)).toThrow(
            'Unknown lifecycle event: undefined.'
        );
    });

    it('clear() drops every subscription', async () => {
        const bus = createHookBus();
        let calls = 0;

        bus.on('harness.dispose', () => {
            calls += 1;
        });
        bus.clear();

        await bus.emit('harness.dispose', {});
        expect(calls).toBe(0);
        expect(bus.has('harness.dispose')).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// `emitMaybeSync` — rule 6 (plugin/hooks.ts): a PERMANENTLY subscribed hook that is
// currently inert must cost no microtask, because `turn.before` always HAS a listener
// (the shipped context-compaction plugin) and `has()` can therefore not save it.
// ---------------------------------------------------------------------------
//
// HOW "no microtask" is asserted exactly: a `queueMicrotask` probe is scheduled AFTER
// the emit call returns. A round that never yielded leaves the caller's next statement
// BEFORE the probe; a round that awaited leaves it AFTER. Both orders are exact, so each
// case below asserts a complete order rather than a timing property.
describe('emitMaybeSync', () => {
    it('stays on the caller tick when every handler is synchronous', async () => {
        // THE test for rule 6, written as the two shapes of harness call site. What
        // matters is not the emit's own tick (a wrapper cannot change a synchronous
        // caller's statements) but whether the CALLER resumes before a microtask that was
        // already queued — i.e. whether another actor's pending chain gets a turn between
        // the hook round and the provider request. That is exactly the interleaving
        // `src/server/queue.test.ts` observed.
        const bus = createHookBus();
        const order: string[] = [];

        // Which call site is emitting, so one bus can serve both shapes below.
        let label = 'awaited';
        bus.on('turn.before', () => {
            order.push(`handler:${label}`);
        });

        // The awaited shape (`await bus.emit(...)`), the pre-rule-6 harness.
        const awaited = async (): Promise<void> => {
            void Promise.resolve().then(() => order.push('competing:awaited'));
            await bus.emit('turn.before', turnPayload([user('go')]));
            order.push('resumed:awaited');
        };

        // The maybe-sync shape (`turn.before` in harness.ts today).
        const maybeSync = async (): Promise<void> => {
            label = 'sync';
            void Promise.resolve().then(() => order.push('competing:sync'));
            const round = bus.emitMaybeSync('turn.before', turnPayload([user('go')]));
            // Nothing to await: the round already finished, value included.
            expect(round).toEqual({ sync: true, value: {} });
            order.push('resumed:sync');
        };

        await awaited();
        await maybeSync();

        // The awaited path let the already-queued chain cut in front of the caller; the
        // maybe-sync path did not, so a synchronously inert hook is boundary-free.
        expect(order).toEqual([
            'handler:awaited',
            'competing:awaited',
            'resumed:awaited',
            'handler:sync',
            'resumed:sync',
            'competing:sync'
        ]);
    });

    it('costs nothing and builds nothing with no listener', () => {
        const bus = createHookBus();
        let built = 0;

        const round = bus.emitMaybeSync('turn.before', () => {
            built += 1;
            return turnPayload([user('go')]);
        });

        expect(round).toEqual({ sync: true, value: {} });
        // The factory form is still never invoked without a subscriber (rule 5).
        expect(built).toBe(0);
    });

    it('applies a synchronous transcript override on the same tick', () => {
        const bus = createHookBus();

        bus.on('turn.before', () => ({ transcript: [user('compacted')] }));

        const round = bus.emitMaybeSync('turn.before', turnPayload([user('go')]));

        expect(round).toEqual({ sync: true, value: { transcript: [user('compacted')] } });
    });

    it('runs the synchronous prefix immediately and defers only from the first promise', async () => {
        const bus = createHookBus();
        const order: string[] = [];

        bus.on('turn.before', () => {
            order.push('sync-1');
        });
        bus.on('turn.before', async () => {
            await Promise.resolve();
            order.push('async');
            return { transcript: [user('from-async')] };
        });
        bus.on('turn.before', () => {
            // Sequential dispatch: this handler may NOT have run at return time, even
            // though it is synchronous — otherwise a later hook would race an earlier
            // one's I/O and the round would be unordered.
            order.push('sync-2');
        });

        const round = bus.emitMaybeSync('turn.before', turnPayload([user('go')]));

        expect(order).toEqual(['sync-1']);
        expect(round.sync).toBe(false);

        const merged = await (round as { promise: Promise<unknown> }).promise;

        expect(merged).toEqual({ transcript: [user('from-async')] });
        expect(order).toEqual(['sync-1', 'async', 'sync-2']);
    });

    it('lets a later synchronous override win an earlier async one (last non-empty wins)', async () => {
        const bus = createHookBus();

        bus.on('turn.before', async () => ({ transcript: [user('from-async')] }));
        bus.on('turn.before', () => ({ transcript: [user('from-sync')] }));

        const round = bus.emitMaybeSync('turn.before', turnPayload([user('go')]));
        const merged = await (round as { promise: Promise<unknown> }).promise;

        expect(round.sync).toBe(false);
        expect(merged).toEqual({ transcript: [user('from-sync')] });
    });

    it('fails open on a synchronous throw and still returns synchronously', () => {
        const failures: string[] = [];
        const bus = createHookBus({
            onHandlerError: (context) => failures.push(`${context.owner}:${(context.error as Error).message}`)
        });
        const order: string[] = [];

        bus.on(
            'turn.before',
            () => {
                throw new Error('boom');
            },
            { owner: 'broken' }
        );
        bus.on(
            'turn.before',
            (payload) => {
                order.push(`survivor:${payload.messages.length}`);
            },
            { owner: 'ok' }
        );

        const round = bus.emitMaybeSync('turn.before', turnPayload([user('go')]));

        // A synchronous throw keeps the round synchronous: no promise appeared, so the
        // caller never had to await, and the healthy handler still ran.
        expect(round).toEqual({ sync: true, value: {} });
        expect(order).toEqual(['survivor:1']);
        expect(failures).toEqual(['broken:boom']);
    });

    it('fails open on a rejected handler and still runs the rest', async () => {
        const failures: string[] = [];
        const bus = createHookBus({
            onHandlerError: (context) => failures.push(`${context.owner}:${(context.error as Error).message}`)
        });
        const order: string[] = [];

        bus.on(
            'turn.before',
            async () => {
                await Promise.resolve();
                throw new Error('late boom');
            },
            { owner: 'async-broken' }
        );
        bus.on(
            'turn.before',
            () => {
                order.push('survivor');
                return { transcript: [user('kept')] };
            },
            { owner: 'ok' }
        );

        const round = bus.emitMaybeSync('turn.before', turnPayload([user('go')]));

        expect(round.sync).toBe(false);
        // The rejection is OBSERVED by the round, never propagated to the caller.
        await expect((round as { promise: Promise<unknown> }).promise).resolves.toEqual({
            transcript: [user('kept')]
        });
        expect(order).toEqual(['survivor']);
        expect(failures).toEqual(['async-broken:late boom']);
    });

    it('snapshots the handler list, like emit', () => {
        const bus = createHookBus();
        const order: string[] = [];

        bus.on('turn.before', () => {
            order.push('first');
            // A handler that subscribes mid-round must not extend THAT round (rule 3).
            bus.on('turn.before', () => {
                order.push('added-mid-round');
            });
        });

        const round = bus.emitMaybeSync('turn.before', turnPayload([user('go')]));

        expect(round).toEqual({ sync: true, value: {} });
        expect(order).toEqual(['first']);
        expect(bus.count('turn.before')).toBe(2);
    });

    it('emits through the awaited path with the same order and merging as before', async () => {
        // `emit` is now a wrapper over the maybe-sync round; this pins that the change
        // kept the documented semantics for every OTHER harness emit site (sequential,
        // fail-open, last non-empty override).
        const bus = createHookBus();
        const order: string[] = [];

        bus.on('turn.before', () => {
            order.push('sync');
            return { transcript: [user('first')] };
        });
        bus.on('turn.before', async () => {
            await Promise.resolve();
            order.push('async');
            return { transcript: [user('second')] };
        });

        await expect(bus.emit('turn.before', turnPayload([user('go')]))).resolves.toEqual({
            transcript: [user('second')]
        });
        expect(order).toEqual(['sync', 'async']);
    });
});

// ---------------------------------------------------------------------------
// Event bus v2 (T1) + the turn-decision reducer (T2.2)
// ---------------------------------------------------------------------------
//
// What each of these pins, and why it exists:
//   - WILDCARD: an audit plugin must subscribe ONCE and see every event exactly once
//     with a payload that NARROWS with the event name (open decision 6 — the mapped
//     union is the whole point; `payload: unknown` would put the `any` back);
//   - `host.state_change` is NOT part of the fan-out (T1.7), and `live()` expands a
//     wildcard into exactly the events it will be delivered, or the Plugins pane starts
//     lying (T1.2);
//   - PRIORITY: "whoever registered last wins" must stop being an accident of the
//     plugin array (R2), while staying STABLE inside one priority;
//   - BUDGET: one handler that never resolves used to park the turn forever, and losing
//     it must be visible (fail-open + reported, never fail-closed);
//   - the DECISION REDUCER is the single place (T2.2) where a round's transcript and
//     its run-level decision merge, so the harness's consumer cannot disagree with it.
describe('createHookBus — event bus v2', () => {
    // Every event a `'*'` subscription is delivered. Written out in full so adding an
    // event to the catalogue FAILS these assertions until its author decides whether an
    // audit plugin should receive it (plugin/hooks.ts `WILDCARD_DELIVERABLE`).
    const DELIVERED = [
        'thread.created',
        'thread.started',
        'thread.paused',
        'thread.resumed',
        'thread.stopped',
        'thread.idle',
        'thread.deleted',
        'run.started',
        'run.finished',
        'run.failed',
        'turn.before',
        'turn.after',
        'tool.before',
        'tool.after',
        'async.pending',
        'async.drained',
        'harness.dispose'
    ];

    it('delivers every emitted event to a wildcard exactly once, with the right payload', async () => {
        const bus = createHookBus();
        const seen: string[] = [];
        const deleted: unknown[] = [];
        const tokens: number[] = [];

        bus.on('*', (context) => {
            seen.push(context.event);

            // COMPILE-TIME evidence for open decision 6: `payload` narrows with `event`.
            // Without the mapped union these two property reads would not typecheck.
            if (context.event === 'thread.deleted') deleted.push(context.payload.threadId);
            if (context.event === 'turn.before') tokens.push(context.payload.estimatedTokens);
        });

        // A named subscriber alongside the wildcard, so "exactly once" is proven to mean
        // once per EMIT, not once per registration of any kind.
        bus.on('run.started', () => undefined, { owner: 'named' });

        bus.fire('thread.deleted', { threadId: 'thread-1', agent: 'writer' });
        await bus.emit('run.started', {
            threadId: 'thread-1',
            agent: 'writer',
            depth: 1,
            input: 'go'
        });
        bus.emitMaybeSync('turn.before', turnPayload([user('go')]));
        await bus.emit('harness.dispose', {});

        // `host.state_change` fires on every mutation and is opt-in by name, so a
        // wildcard that saw nothing else must still have seen exactly these four.
        expect(seen).toEqual(['thread.deleted', 'run.started', 'turn.before', 'harness.dispose']);
        expect(deleted).toEqual(['thread-1']);
        expect(tokens).toEqual([1]);
    });

    it('counts a wildcard as a listener for has()/count(), and expands it honestly in live()', async () => {
        const bus = createHookBus();

        const off = bus.on('*', () => undefined, { owner: 'auditor' });

        // Rule 5's guard must not skip an event just because nobody subscribed to THAT
        // event: an audit plugin is exactly the reason `has()` has to be true here.
        expect(bus.has('turn.before')).toBe(true);
        expect(bus.has('thread.deleted')).toBe(true);
        expect(bus.count('turn.before')).toBe(1);

        const live = bus.live();

        // T1.2 — one row per delivered event, the owner repeated, and NO invented `'*'`
        // key (the return type is keyed by HarnessLifecycleEvent).
        expect(Object.keys(live).sort()).toEqual([...DELIVERED].sort());
        expect(live['turn.before']).toEqual(['auditor']);
        expect(live['harness.dispose']).toEqual(['auditor']);

        // T1.7 — the host plane is excluded from the fan-out, so `live()` must not
        // claim a wildcard listener for it.
        expect(live['host.state_change']).toBeUndefined();
        expect(bus.has('host.state_change')).toBe(false);

        off();

        expect(bus.has('turn.before')).toBe(false);
        expect(bus.live()).toEqual({});
    });

    it('does not deliver host.state_change to a wildcard, and does to an explicit subscriber', async () => {
        const bus = createHookBus();
        const seen: string[] = [];

        bus.on('*', (context) => {
            seen.push(`wild:${context.event}`);
        });
        bus.on('host.state_change', (payload) => {
            seen.push(`named:${payload.reason}`);
        }, { owner: 'persistence-reader' });

        await bus.emit('host.state_change', { type: 'state_change', reason: 'agent_message' });
        await bus.emit('turn.before', turnPayload([user('go')]));

        expect(seen).toEqual(['named:agent_message', 'wild:turn.before']);
    });

    it('runs a priority-1 handler before a priority-0 handler registered earlier, stably within a priority', async () => {
        const bus = createHookBus();
        const order: string[] = [];

        bus.on('turn.before', () => void order.push('a:p0'), { owner: 'a' });
        bus.on('turn.before', () => void order.push('b:p0'), { owner: 'b' });
        bus.on('turn.before', () => void order.push('c:p1'), { owner: 'c', priority: 1 });
        // A priority below zero sorts AFTER the defaults, and ties keep registration
        // order — the same rule the named handlers follow, applied to a wildcard too.
        bus.on('*', () => void order.push('d:p-1'), { owner: 'd', priority: -1 });

        const round = bus.emitMaybeSync('turn.before', turnPayload([user('go')]));

        expect(round).toEqual({ sync: true, value: {} });
        expect(order).toEqual(['c:p1', 'a:p0', 'b:p0', 'd:p-1']);
    });

    it('drops a handler that never resolves at its budget, reports it, and keeps the round', async () => {
        const failures: Array<{ owner: string; kind?: string; message: string }> = [];
        const bus = createHookBus({
            onHandlerError: (context) => failures.push({
                owner: context.owner,
                kind: context.kind,
                message: (context.error as Error).message
            })
        });

        // A summarizer call that never comes back: before T1.4 this parked the turn
        // forever, and the run had no way to notice.
        bus.on('turn.before', () => new Promise<never>(() => undefined), {
            owner: 'slow-policy',
            timeoutMs: 5
        });
        bus.on('turn.before', () => ({ transcript: [user('kept')] }), { owner: 'fast-policy' });

        const round = bus.emitMaybeSync('turn.before', turnPayload([user('go')]));

        expect(round.sync).toBe(false);
        // Fail-OPEN: the healthy handler's override survives, the round resolves, and
        // the stuck handler contributes nothing whenever it finally would have.
        await expect((round as { promise: Promise<unknown> }).promise).resolves.toEqual({
            transcript: [user('kept')]
        });
        expect(failures).toEqual([
            {
                owner: 'slow-policy',
                kind: 'timed-out',
                message:
                    'A "slow-policy" handler for "turn.before" timed out after 5ms and was dropped (fail-open).'
            }
        ]);
    });

    it('arms no timer for a synchronous handler that carries a budget', async () => {
        const failures: string[] = [];
        const bus = createHookBus({
            onHandlerError: (context) => failures.push(`${String(context.kind)}:${(context.error as Error).message}`)
        });

        bus.on('turn.before', () => ({ transcript: [user('sync')] }), {
            owner: 'sync-policy',
            timeoutMs: 1
        });

        const round = bus.emitMaybeSync('turn.before', turnPayload([user('go')]));

        // Rule 6: the timer may only be armed at the moment a handler returns a thenable,
        // so a budget on a synchronous handler changes nothing on the hot path.
        expect(round).toEqual({ sync: true, value: { transcript: [user('sync')] } });

        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(failures).toEqual([]);
    });

    it('ignores AND reports an unparseable decision, keeping the transcript override (T2.2 rule 5)', async () => {
        const failures: Array<{ owner: string; kind?: string; message: string }> = [];
        const bus = createHookBus({
            onHandlerError: (context) => failures.push({
                owner: context.owner,
                kind: context.kind,
                message: (context.error as Error).message
            })
        });

        // The typo is in the DECISION only, so the handler's real work still counts.
        bus.on('turn.before', () => ({
            transcript: [user('kept')],
            decision: { action: 'halt' }
        }), { owner: 'typo-policy' });

        const merged = await bus.emit('turn.before', turnPayload([user('go')]));

        expect(merged).toEqual({ transcript: [user('kept')] });
        expect(failures).toEqual([
            {
                owner: 'typo-policy',
                kind: 'invalid-decision',
                message:
                    'A "typo-policy" handler for "turn.before" returned a decision this contract cannot parse and it was ignored: {"action":"halt"}.'
            }
        ]);
    });

    it('reports an unparseable decision on the async tail too, without failing the round', async () => {
        const failures: string[] = [];
        const bus = createHookBus({
            onHandlerError: (context) => failures.push(`${String(context.kind)}:${(context.error as Error).message}`)
        });

        bus.on('turn.before', async () => ({ decision: 'stop' }), { owner: 'string-decision' });
        bus.on('turn.before', () => ({ decision: { action: 'stop', reason: 'budget' } }), {
            owner: 'valid-policy'
        });

        const round = bus.emitMaybeSync('turn.before', turnPayload([user('go')]));

        expect(round.sync).toBe(false);
        await expect((round as { promise: Promise<unknown> }).promise).resolves.toEqual({
            decision: { action: 'stop', reason: 'budget' }
        });
        expect(failures).toEqual([
            'invalid-decision:A "string-decision" handler for "turn.before" returned a decision this contract cannot parse and it was ignored: "stop".'
        ]);
    });

    it('merges one round into { transcript, decision }: last wins per channel, replace normalizes into the transcript', async () => {
        const bus = createHookBus();

        // Rule 3 of the precedence list: a decision COMPOSES with an earlier rewrite —
        // the transcript is still decided, the run is additionally ended.
        bus.on('turn.before', () => ({ transcript: [user('first')] }), { owner: 'rewriter' });
        bus.on('turn.before', () => ({ decision: { action: 'stop', reason: 'out of budget' } }), {
            owner: 'budget'
        });

        expect(await bus.emit('turn.before', turnPayload([user('go')]))).toEqual({
            transcript: [user('first')],
            decision: { action: 'stop', reason: 'out of budget' }
        });

        // Rule 4: a later plugin can CLEAR that decision, and a `replace` decision lands
        // on the transcript channel so the consumer has one thing to read.
        const cleared = createHookBus();

        cleared.on('turn.before', () => ({ decision: { action: 'stop' } }), { owner: 'budget' });
        cleared.on('turn.before', () => ({ decision: { action: 'continue' } }), { owner: 'override' });
        cleared.on('turn.before', () => ({
            decision: { action: 'replace', transcript: [user('replaced')] }
        }), { owner: 'replacer' });

        expect(await cleared.emit('turn.before', turnPayload([user('go')]))).toEqual({
            transcript: [user('replaced')],
            decision: { action: 'replace', transcript: [user('replaced')] }
        });

        // Rule 4 again, by PRIORITY: the higher-priority policy speaks last for the
        // round, no matter where it sits in the plugin array.
        const ranked = createHookBus();

        ranked.on('turn.before', () => ({ decision: { action: 'pause', reason: 'cheap' } }), {
            owner: 'cheap-policy'
        });
        ranked.on('turn.before', () => ({ decision: { action: 'stop', reason: 'authority' } }), {
            owner: 'authoritative-policy',
            priority: 10
        });

        expect(await ranked.emit('turn.before', turnPayload([user('go')]))).toEqual({
            decision: { action: 'pause', reason: 'cheap' }
        });
    });

    it('refuses a non-finite priority or timeout at registration', () => {
        const bus = createHookBus();

        expect(() =>
            bus.on('turn.before', () => undefined, { owner: 'x', priority: Number.NaN })
        ).toThrow('A "turn.before" priority must be a finite number.');
        expect(() =>
            bus.on('turn.before', () => undefined, { owner: 'x', timeoutMs: -1 })
        ).toThrow('A "turn.before" timeoutMs must be a finite number >= 0.');

        // Nothing was registered on the way to the refusal.
        expect(bus.count('turn.before')).toBe(0);
    });

    it('accepts the "*" event name only as a subscription form, never as an event', () => {
        const bus = createHookBus();

        // `'*'` is not an event name, so an emit site that invented it finds no
        // listeners of its own — the wildcard fan-out is a dispatch rule, not an event.
        expect(bus.has('*' as HarnessLifecycleEvent)).toBe(false);

        bus.on('turn.before', () => undefined, { owner: 'named' });

        expect(bus.live()['*']).toBeUndefined();
        expect(bus.live()).toEqual({ 'turn.before': ['named'] });
    });
});

// ---------------------------------------------------------------------------
// RULE 9 — THE GLOBAL ENABLEMENT GATE (R2, the operator's plugin switch)
//
// The bus half of the gate, independent of the plugin host: a registration may carry a
// live `enabled()` predicate, and dispatch (`emit`/`emitMaybeSync`/`fire`), the `has()`
// guard and `count()` all consult it PER EVENT, while `live()` keeps reporting the
// subscription. `harness.dispose` is the one exempt event, and a gate that throws reads
// as enabled (fail-open, rule 2).
//
// The end-to-end side (a plugin host building the predicate out of a settings view) is
// pinned in ./host.test.ts; the REST and durability side in
// ../server/plugins.test.ts and ../server/plugins-api.test.ts.
// ---------------------------------------------------------------------------

describe('createHookBus — the enablement gate (rule 9)', () => {
    const disposePayload = {} as const;

    it('skips a gated-off owner on every dispatch path, and still fires harness.dispose', async () => {
        let enabled = false;
        const log: string[] = [];
        const bus = createHookBus();

        bus.on('run.started', () => log.push('named:run.started'), { owner: 'alpha', enabled: () => enabled });
        bus.on('*', (context) => log.push(`wild:${context.event}`), { owner: 'alpha', enabled: () => enabled });
        bus.on('harness.dispose', () => log.push('named:dispose'), { owner: 'alpha', enabled: () => enabled });

        // `fire` is the synchronous path a thread teardown uses; `emit` the awaited one.
        bus.fire('run.started', { agent: 'writer', depth: 0, input: 'x' });
        await bus.emit('run.started', { agent: 'writer', depth: 0, input: 'x' });

        expect(log).toEqual([]);

        // The teardown point is exempt for BOTH a named and a `'*'` registration, so a
        // disabled plugin still releases its own timers and handles. Order is the bus's
        // documented dispatch order (priority, then registration `seq`): the wildcard
        // registered second, so it runs second-last and the named dispose last... a `*`
        // registration flips the bus onto ordered dispatch, and `seq` decides the tie —
        // asserted as the exact array rather than as a set, because dispatch order is the
        // one thing a plugin author can rely on.
        bus.fire('harness.dispose', disposePayload);

        expect(log).toEqual(['wild:harness.dispose', 'named:dispose']);

        enabled = true;
        await bus.emit('run.started', { agent: 'writer', depth: 0, input: 'x' });

        // Same registrations, next emit, back on — no re-subscription happened. Here the
        // named `run.started` registration (seq 1) precedes the wildcard (seq 2), exactly as
        // the dispose pair above is ordered the other way (seq 2 before seq 3).
        expect(log).toEqual([
            'wild:harness.dispose',
            'named:dispose',
            'named:run.started',
            'wild:run.started'
        ]);
    });

    it('makes has() and count() answer for what a round would RUN, while live() keeps the subscription', async () => {
        let enabled = true;
        const bus = createHookBus();

        bus.on('turn.before', () => undefined, { owner: 'alpha', enabled: () => enabled });

        expect(bus.has('turn.before')).toBe(true);
        expect(bus.count('turn.before')).toBe(1);
        expect(bus.live()['turn.before']).toEqual(['alpha']);

        enabled = false;

        // `has()` false is what lets an emit site skip the payload construction as well as
        // the call — the argument every `if (bus.has(event))` guard in ../harness.ts makes,
        // applied to a disabled plugin exactly as to an unregistered one.
        expect(bus.has('turn.before')).toBe(false);
        expect(bus.count('turn.before')).toBe(0);

        // `live()` is the Plugins pane's declared-vs-subscribed comparison, and a disabled
        // plugin DID subscribe: that row does not go blank on a toggle.
        expect(bus.live()['turn.before']).toEqual(['alpha']);

        // `host.state_change` is not wildcard-deliverable and is unaffected either way.
        expect(bus.has('host.state_change')).toBe(false);
    });

    it('stays SYNCHRONOUS for a gated-off permanent subscriber (rule 6 preserved)', () => {
        const bus = createHookBus();

        bus.on('turn.before', () => ({ transcript: [user('compacted')] }), {
            owner: 'context-compaction',
            enabled: () => false
        });

        // A disabled compaction must be event-order identical to no compaction at all:
        // the round returns on the caller's tick with an empty merge, so `turn.before`
        // adds no microtask boundary (the regression src/server/queue.test.ts pins).
        const round = bus.emitMaybeSync('turn.before', turnPayload([user('go')]));

        expect(round.sync).toBe(true);

        if (!round.sync) throw new Error('A gated round must not hand the caller a promise.');

        expect(round.value).toEqual({});
    });

    it('treats a gate that THROWS as enabled, and never reports a skipped delivery as a handler error', async () => {
        const errors: unknown[] = [];
        const log: string[] = [];
        const bus = createHookBus({ onHandlerError: (context) => errors.push(context.error) });

        bus.on('run.started', () => log.push('ran'), {
            owner: 'alpha',
            enabled: () => {
                throw new Error('the host could not read its settings document');
            }
        });

        await bus.emit('run.started', { agent: 'writer', depth: 0, input: 'x' });

        // Fail-open: a broken settings read must not silence every hook in the process.
        expect(log).toEqual(['ran']);
        expect(errors).toEqual([]);

        // And an operator switch-off is silent by design — it is not a plugin failure.
        const other = createHookBus({ onHandlerError: (context) => errors.push(context.error) });

        other.on('run.started', () => log.push('never'), { owner: 'beta', enabled: () => false });
        await other.emit('run.started', { agent: 'writer', depth: 0, input: 'x' });

        expect(log).toEqual(['ran']);
        expect(errors).toEqual([]);
    });

    it('leaves a registration without a gate exactly as fast as before', async () => {
        const log: string[] = [];
        const bus = createHookBus();

        bus.on('run.started', () => log.push('a'), { owner: 'host' });
        bus.on('run.started', () => log.push('b'), { owner: 'alpha' });

        await bus.emit('run.started', { agent: 'writer', depth: 0, input: 'x' });

        // Registration order within one priority, unchanged by rule 9.
        expect(log).toEqual(['a', 'b']);
        expect(bus.has('run.started')).toBe(true);
    });
});

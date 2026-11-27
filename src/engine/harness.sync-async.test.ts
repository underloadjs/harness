// T2/R2+R3 — the SYNC/ASYNC turn-policy contract, black-box through the public package
// surface (no scheduler internals).
//
// Contract pinned here:
//   R2  One EFFECTIVE mode per tool: the discovered registration policy bound to the
//       published baseline definition, else the mode the definition declares through
//       tool({ mode }), else DEFAULT_TOOL_MODE ('sync'). The policy is carried by the
//       discovered row (scan -> descriptor -> generated manifest) and is keyed to the
//       definition OBJECT, so replacing a built-in wire name publishes a tool that
//       inherits nothing.
//   R3  Per assistant message, per run:
//         - N sync completions trigger EXACTLY ONE turn, after the last one settled
//           (success, failure, and cancellation all settle);
//         - an async completion triggers its own turn immediately, even while a sync
//           group from the same message is in flight, and no delivery is delayed by the
//           group;
//         - a lone sync call therefore starts its next turn AFTER it finished;
//         - groups are per run: two runs never share one.
//   R5  The PERIODIC wake answers for ASYNC pending work only. A run parked because its
//       outstanding calls are all `mode:'sync'` is never woken on the heartbeat (it is
//       woken by its own group settling), so a long sync call costs no placeholder
//       turn; a run with async work pending still is. Pinned by the `heartbeat policy`
//       block at the end of this file — the plugin-side halves of the same rule are in
//       src/plugin/async-ping.test.ts.
//
// Determinism: every gate below is resolved by the test, one at a time, so each request
// COUNT and each request PROJECTION is an exact expected value. Fake timers own the
// clock (no wall-clock assertions), exactly like src/harness.background.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent, harness, tool } from './index';
import type {
    Harness,
    HarnessEvent,
    HarnessMessage,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest,
    HarnessToolCall,
    Tool,
    ToolMode
} from './index';
import { discoverToolMetadata } from './core/tool-discovery';
import { DEFAULT_TOOL_MODE } from './core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
};

const deferred = <T>(): Deferred<T> => {
    let settleResolve!: (value: T) => void;
    let settleReject!: (reason: unknown) => void;

    const promise = new Promise<T>((resolve, reject) => {
        settleResolve = resolve;
        settleReject = reject;
    });

    return { promise, resolve: settleResolve, reject: settleReject };
};

// Run every queued job to its resting point WITHOUT advancing wall time: due timers
// plus the microtask queue, which is what a launch -> deliver -> wake -> re-request
// chain needs. A parked batch gate simply does not advance `seen`, which is the point.
const flush = async (): Promise<void> => {
    for (let pass = 0; pass < 12; pass += 1) {
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
    }
};

const call = (id: string, name: string, args = '{}'): HarnessToolCall => ({
    id,
    name,
    arguments: args
});

// A final answer: text, then a stop frame with no tool calls.
const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

// One tool-call turn.
const calls = (...requested: HarnessToolCall[]): HarnessStreamEvent[] => [
    { type: 'done', stopReason: 'tool_calls', toolCalls: requested }
];

// The exact transcript shape one request was shown. A DELIVERED tool result carries its
// serialized payload, while an outstanding call is a placeholder whose content is not
// contractual — so a test proves "this turn saw the whole batch" by the payload being
// present, and "this turn was bought by one async completion" by its absence.
const shape = (messages: readonly HarnessMessage[]): string[] =>
    messages.map((message) => {
        if (message.role === 'tool') return `tool:${message.toolCallId}:${message.content}`;
        if (message.role === 'assistant') {
            const ids = (message.toolCalls ?? []).map((entry) => entry.id).join('|');
            return `assistant:${message.content}:${ids}`;
        }
        return `${message.role}:${message.content}`;
    });

// A transport that replays `script` per request index (the last entry repeats, like a
// scripted model asked once more), recording every request's projection.
const scripted = (script: HarnessStreamEvent[][], seen: string[][]): HarnessStream => {
    let turn = 0;

    return async function* stream(request: HarnessStreamRequest) {
        const index = turn;
        turn += 1;
        seen.push(shape(request.messages));

        await Promise.resolve();

        const frames = index < script.length ? script[index] : script[script.length - 1];
        for (const frame of frames) yield frame;
    };
};

// One gated tool. `mode` is REQUIRED here (undefined = "declare nothing"): a test can
// never accidentally rely on the default without saying so in its own call site.
const gated = (name: string, mode: ToolMode | undefined, gate: Deferred<unknown>): Tool =>
    tool<{ value: string }, unknown>({
        description: `Gated ${mode ?? 'default'} tool ${name}.`,
        tags: ['test'],
        // Core, so the model can call it without a discovery round.
        visibility: 'core',
        ...(mode === undefined ? {} : { mode }),
        parameters: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false
        },
        execute: () => gate.promise
    });

type Fixture = {
    run: Harness;
    brain: ReturnType<typeof agent>;
    seen: string[][];
    events: HarnessEvent[];
};

// Move the clock by an exact amount and let the resulting work settle. The heartbeat
// tests below are the only ones in this file that let time pass at all: every R2/R3
// gate is resolved by the test itself, and a heartbeat boundary is the one trigger that
// is NOT under the test's hand.
const advance = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
    await flush();
};

// A single-agent harness with exactly these tools (no presets, so nothing else is
// declared and the recorded projections stay readable). `options.wakeIntervalMs` is
// the legacy heartbeat field: it seeds the `async-ping` plugin's `intervalMs` setting,
// so passing a small value here makes a wake boundary reachable in fake time
// (the chain is pinned end to end in src/harness.background.test.ts).
const fixture = (
    script: HarnessStreamEvent[][],
    tools: Record<string, Tool>,
    options: { wakeIntervalMs?: number } = {}
): Fixture => {
    const seen: string[][] = [];
    const events: HarnessEvent[] = [];
    const brain = agent({ model: 'test/model', stream: scripted(script, seen) });

    const run = harness({
        agents: { writer: brain },
        tools,
        presets: false,
        ...(options.wakeIntervalMs === undefined ? {} : { wakeIntervalMs: options.wakeIntervalMs }),
        report: { progress: async (event) => void events.push(event) }
    });

    return { run, brain, seen, events };
};

// The `wakeup` frames a run produced, narrowed to the fields a heartbeat test needs.
const wakeupsOf = (events: readonly HarnessEvent[]): Array<{ agent: string; reason: string }> =>
    events
        .filter((event) => event.type === 'wakeup')
        .map((event) => ({
            agent: (event as { agent: string }).agent,
            reason: (event as { reason: string }).reason
        }));

// The canonical tool results in transcript order: `<callId>:<content>`. Positions are
// the ORIGINAL call positions, so this also pins "out-of-order settlement never
// reorders the transcript".
const toolMessages = (messages: readonly HarnessMessage[]): string[] =>
    messages
        .filter(
            (message): message is Extract<HarnessMessage, { role: 'tool' }> =>
                message.role === 'tool'
        )
        .map((message) => `${message.toolCallId}:${message.content}`);

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// R2 — the policy is declared, scanned, and definition-bound
// ---------------------------------------------------------------------------

describe('tool turn policy (R2)', () => {
    it('refuses a mode that is neither sync nor async', () => {
        expect(() =>
            tool({
                description: 'Bogus mode.',
                tags: ['test'],
                execute: () => 'ok',
                // Validated like `visibility`: never coerced, never silently defaulted.
                mode: 'sometimes' as unknown as ToolMode
            })
        ).toThrow('A tool mode must be one of: sync, async. Received "sometimes".');
    });

    it('keeps "undeclared" distinguishable from "declared", and states the default', () => {
        const plain = tool({ description: 'Plain.', tags: ['test'], execute: () => 'ok' });

        // No key at all -> the harness applies the documented default, which is this
        // exact constant.
        expect(plain.mode).toBeUndefined();
        expect(DEFAULT_TOOL_MODE).toBe('sync');
        expect(
            tool({ description: 'Declared.', tags: ['test'], mode: 'async', execute: () => 'ok' }).mode
        ).toBe('async');
    });

    it('projects the declared policy of every shipped entry through discovery', () => {
        const rows = discoverToolMetadata();

        // EXACTLY these rows state a policy, with these exact values. Anything else
        // stays undeclared and is therefore effective-'sync'.
        const declared = rows
            .filter((row) => row.mode !== undefined)
            .map((row) => `${row.name}:${row.mode}`)
            .sort();

        expect(declared).toEqual([
            // R2: the question tool states 'sync' because the run that raised it has
            // nothing to look at until the owner answers (the same sentence the Rust
            // mirror states: "the run that raised the question is blocked inside the tool
            // call until its owner answers"). src/harness.action-request-hold.test.ts pins
            // the behaviour; this row is what stops the declaration drifting from it.
            'actionRequest:sync',
            'delegate:async',
            // R3/R4: `download` declares 'sync' because the file IS the input to
            // the next turn (same reasoning as read/search/fetch).
            'download:sync',
            'edit:sync',
            'fetch:sync',
            'read:sync',
            'search:sync',
            'shell:async',
            // `sleep` STATES 'sync' instead of inheriting the default, and the
            // declaration is load-bearing: a run parked on a sleep is re-entered by
            // its own settled call, with no async wake (the heartbeat-gating rule in
            // docs/tasks/2026-11-19-heartbeat-async-only.md keys off exactly this
            // stated mode).
            'sleep:sync',
            // Issue 0027: the release door STATES 'sync' rather than inheriting the
            // default, because its caller needs the receipt (`removedThreadIds`) in the
            // tool message of the same turn.
            'threadDelete:sync',
            'threadFork:async'
        ]);

        // The two controls state OPPOSITE policies, and each dispatch honours its own:
        // a `threadFork` branch is background work whose completion wakes the requester on
        // its own (a fork never holds its origin's batch), while an `actionRequest` holds
        // its run until the owner answers — the answer arrives out of band, and the
        // requester has nothing new to read until it does. `toolCancel` answers inline, so
        // it declares nothing and the default is inert for it.
        const byName = new Map(rows.map((row) => [row.name, row]));
        expect(byName.get('threadFork')?.mode).toBe('async');
        expect(byName.get('actionRequest')?.mode).toBe('sync');
        expect(byName.get('toolCancel')?.mode).toBeUndefined();
    });

    it('does not leak a built-in async policy onto a replacement of the same name', async () => {
        const gate = deferred<string>();
        // `shell`'s own row is async. A replacement registered under that wire name
        // declares nothing, so it must be effective-'sync': its pending call holds the
        // batch gate, and no turn happens until it settles.
        const world = fixture(
            [calls(call('c1', 'shell', '{"value":"x"}')), answer('replacement-answered')],
            { shell: gated('shell', undefined, gate) }
        );

        const running = world.run('go');
        await flush();
        expect(world.seen.length).toBe(1);

        gate.resolve('late-shell');
        await flush();
        expect(world.seen.length).toBe(2);

        await expect(running).resolves.toMatchObject({ content: 'replacement-answered' });
        expect(toolMessages(world.brain.messages)).toEqual(['c1:late-shell']);
    });

    it('honours a host-declared async mode on its own custom tool', async () => {
        const gate = deferred<string>();
        const world = fixture(
            [calls(call('k1', 'free', '{"value":"x"}')), answer('woke-early')],
            { free: gated('free', 'async', gate) }
        );

        const running = world.run('go');
        await flush();

        // Async: the run re-prompted with a placeholder while the call is outstanding.
        expect(world.seen.length).toBe(2);
        expect(world.seen[1].some((line) => line.includes('free-value'))).toBe(false);

        gate.resolve('free-value');
        await flush();

        await expect(running).resolves.toMatchObject({ content: 'woke-early' });
    });
});

// ---------------------------------------------------------------------------
// R3 — per-message sync grouping, async independence, run isolation
// ---------------------------------------------------------------------------

describe('sync batching (R3)', () => {
    it('holds the next turn for a lone sync call until that call finishes', async () => {
        const gate = deferred<string>();
        const world = fixture(
            [calls(call('c1', 'solo', '{"value":"x"}')), answer('after-sync')],
            { solo: gated('solo', 'sync', gate) }
        );

        const running = world.run('go');
        await flush();

        // Only the first request exists: the tool-call round is parked on its sync group.
        expect(world.seen.length).toBe(1);

        gate.resolve('solo-value');
        await flush();

        expect(world.seen.length).toBe(2);
        // The single follow-up turn is built AFTER the delivery, so it carries the real
        // result at the original call position.
        expect(world.seen[1]).toContain('tool:c1:solo-value');
        await expect(running).resolves.toMatchObject({ content: 'after-sync' });
        expect(toolMessages(world.brain.messages)).toEqual(['c1:solo-value']);
    });

    it('starts exactly ONE turn for three sync calls, whichever order they settle in', async () => {
        const one = deferred<string>();
        const two = deferred<string>();
        const three = deferred<string>();

        const world = fixture(
            [
                calls(
                    call('s1', 'one', '{"value":"1"}'),
                    call('s2', 'two', '{"value":"2"}'),
                    call('s3', 'three', '{"value":"3"}')
                ),
                answer('all-three')
            ],
            {
                one: gated('one', 'sync', one),
                two: gated('two', 'sync', two),
                three: gated('three', 'sync', three)
            }
        );

        const running = world.run('go');
        await flush();
        expect(world.seen.length).toBe(1);

        // Settlement order s3 -> s1: neither may start a turn on its own.
        three.resolve('three-value');
        await flush();
        expect(world.seen.length).toBe(1);

        one.resolve('one-value');
        await flush();
        expect(world.seen.length).toBe(1);

        // The LAST member drains the group: one wake, one request.
        two.resolve('two-value');
        await flush();
        expect(world.seen.length).toBe(2);

        expect(toolMessages(world.brain.messages)).toEqual([
            's1:one-value',
            's2:two-value',
            's3:three-value'
        ]);
        await expect(running).resolves.toMatchObject({ content: 'all-three' });
    });

    it('lets an async completion buy its own turn while the sync batch is still pending', async () => {
        const syncGate = deferred<string>();
        const asyncGate = deferred<string>();

        const world = fixture(
            [
                calls(
                    call('s1', 'syncTool', '{"value":"1"}'),
                    call('a1', 'asyncTool', '{"value":"2"}')
                ),
                answer('async-first'),
                answer('both-in')
            ],
            {
                syncTool: gated('syncTool', 'sync', syncGate),
                asyncTool: gated('asyncTool', 'async', asyncGate)
            }
        );

        const running = world.run('go');
        await flush();
        expect(world.seen.length).toBe(1);

        // The async call settles first and re-prompts the model on its own.
        asyncGate.resolve('async-value');
        await flush();

        expect(world.seen.length).toBe(2);
        expect(world.seen[1].filter((line) => line.startsWith('tool:a1'))).toEqual([
            'tool:a1:async-value'
        ]);
        // The sync call is still outstanding: its DELIVERED payload is not in that
        // projection (the placeholder text is not contractual, so the assertion keys on
        // the s1 line carrying the real result, not on any substring).
        expect(world.seen[1].filter((line) => line.startsWith('tool:s1:'))).not.toContain(
            'tool:s1:sync-value'
        );

        syncGate.resolve('sync-value');
        await flush();

        // The drained group buys the group's single turn, which now carries BOTH
        // outcomes, at their original positions.
        expect(world.seen.length).toBe(3);
        expect(world.seen[2].filter((line) => line.startsWith('tool:'))).toEqual([
            'tool:s1:sync-value',
            'tool:a1:async-value'
        ]);

        await expect(running).resolves.toMatchObject({ content: 'both-in' });

        // The sync GROUP never delayed a delivery: both tool_result frames were emitted,
        // in settlement order.
        expect(
            world.events
                .filter((event) => event.type === 'tool_result')
                .map((event) => (event as { callId: string; outcome: string }).callId)
        ).toEqual(['a1', 's1']);
    });

    it('counts a failed sync call and a cancelled sync call as settled', async () => {
        const failing = deferred<string>();
        const cancelling = deferred<string>();

        const world = fixture(
            [
                calls(
                    call('s1', 'willFail', '{"value":"1"}'),
                    call('s2', 'willCancel', '{"value":"2"}'),
                    // The control answers inline (it never becomes a task), so it joins
                    // no group; cancelling s2 settles that member.
                    call('c9', 'toolCancel', '{"callId":"s2"}')
                ),
                answer('settled')
            ],
            {
                willFail: gated('willFail', 'sync', failing),
                willCancel: gated('willCancel', 'sync', cancelling)
            }
        );

        const running = world.run('go');
        await flush();

        // s2 is settled (cancelled) but s1 is still running, so the group holds.
        expect(world.seen.length).toBe(1);

        failing.reject(new Error('boom'));
        await flush();

        // The failure drained the group: exactly one turn.
        expect(world.seen.length).toBe(2);
        expect(toolMessages(world.brain.messages)).toEqual([
            's1:Tool "willFail" failed: boom',
            's2:Tool call "willCancel" (s2) was cancelled before it completed; no result is available.',
            // F1-M6 (2026-11-27) — the cancel receipt names the conversation it released the work
            // in, as the trailing `threadId` key.
            'c9:{"cancelled":true,"callId":"s2","name":"willCancel","threadId":"agent:writer"}'
        ]);

        // A late result for the released call is data on a dead task: it must not wake
        // the run again.
        cancelling.resolve('ignored-late-value');
        await flush();
        expect(world.seen.length).toBe(2);

        await expect(running).resolves.toMatchObject({ content: 'settled' });

        // The structured outcomes are the honest three shapes.
        expect(
            world.events
                .filter((event) => event.type === 'tool_result')
                .map(
                    (event) =>
                        `${(event as { callId: string; outcome: string }).callId}:${
                            (event as { callId: string; outcome: string }).outcome
                        }`
                )
        ).toEqual(['c9:completed', 's2:cancelled', 's1:failed']);
    });

    it('keeps an async-only batch on one wake per completion', async () => {
        const alpha = deferred<string>();
        const beta = deferred<string>();

        const world = fixture(
            [
                calls(call('a1', 'alpha', '{"value":"1"}'), call('b1', 'beta', '{"value":"2"}')),
                answer('one-in'),
                answer('two-in')
            ],
            { alpha: gated('alpha', 'async', alpha), beta: gated('beta', 'async', beta) }
        );

        const running = world.run('go');
        await flush();

        // Unchanged background behaviour: an all-async batch does NOT hold the loop, so
        // the model was already re-prompted once with both calls pending.
        expect(world.seen.length).toBe(2);

        alpha.resolve('alpha-value');
        await flush();
        expect(world.seen.length).toBe(3);

        beta.resolve('beta-value');
        await flush();
        expect(world.seen.length).toBe(4);

        await expect(running).resolves.toMatchObject({ content: 'two-in' });
        expect(toolMessages(world.brain.messages)).toEqual([
            'a1:alpha-value',
            'b1:beta-value'
        ]);
    });

    it('groups each assistant message separately inside one run', async () => {
        const first = deferred<string>();
        const second = deferred<string>();
        const free = deferred<string>();

        // Message 1 = sync `s1` + async `a1`. The async completion re-prompts the model
        // while s1 still runs, and message 2 launches ANOTHER sync call. Draining batch
        // 2 must not consume batch 1's wake, and the run must not resolve while either
        // outstanding sync call is still owed a turn.
        const world = fixture(
            [
                calls(call('s1', 'first', '{"value":"1"}'), call('a1', 'free', '{"value":"2"}')),
                calls(call('s2', 'second', '{"value":"3"}')),
                answer('waiting'),
                answer('done')
            ],
            {
                first: gated('first', 'sync', first),
                second: gated('second', 'sync', second),
                free: gated('free', 'async', free)
            }
        );

        const running = world.run('go');
        await flush();

        // Batch 1 (sync s1 + async a1) is launched and the gate is parked on s1, so only
        // the first request exists yet: nothing re-prompted the model.
        expect(world.seen.length).toBe(1);

        // The async completion is what releases the gate: request 2 launches batch 2
        // (sync s2), and the run parks again with BOTH sync groups outstanding.
        free.resolve('free-value');
        await flush();
        expect(world.seen.length).toBe(2);

        // Batch 2 drains: exactly one turn for IT, while batch 1 stays grouped.
        second.resolve('second-value');
        await flush();
        expect(world.seen.length).toBe(3);

        // Only the two settled calls have results here: s1 belongs to the other group and
        // is still outstanding.
        expect(toolMessages(world.brain.messages)).toEqual([
            'a1:free-value',
            's2:second-value'
        ]);

        // Batch 1 is the last outstanding sync group; settling it buys its own turn.
        first.resolve('first-value');
        await flush();
        expect(world.seen.length).toBe(4);

        await expect(running).resolves.toMatchObject({ content: 'done' });
        // Canonical positions: message 1's results in CALL order (s1 then a1), then
        // message 2's result, no matter the settlement order above.
        expect(toolMessages(world.brain.messages)).toEqual([
            's1:first-value',
            'a1:free-value',
            's2:second-value'
        ]);
    });

    it('never shares a sync group between two concurrent runs', async () => {
        const firstGate = deferred<string>();
        const secondGate = deferred<string>();

        // Two harnesses: each run parks on its own group, and resolving one never starts
        // a turn in the other.
        const a = fixture([calls(call('c1', 'solo', '{"value":"a"}')), answer('a-done')], {
            solo: gated('solo', 'sync', firstGate)
        });
        const b = fixture([calls(call('c1', 'solo', '{"value":"b"}')), answer('b-done')], {
            solo: gated('solo', 'sync', secondGate)
        });

        const runA = a.run('go');
        const runB = b.run('go');
        await flush();

        expect(a.seen.length).toBe(1);
        expect(b.seen.length).toBe(1);

        secondGate.resolve('b-value');
        await flush();

        expect(b.seen.length).toBe(2);
        expect(a.seen.length).toBe(1);
        await expect(runB).resolves.toMatchObject({ content: 'b-done' });

        firstGate.resolve('a-value');
        await flush();

        expect(a.seen.length).toBe(2);
        await expect(runA).resolves.toMatchObject({ content: 'a-done' });
    });
});

// ---------------------------------------------------------------------------
// T4 independent verification — the two races the PARK itself introduces.
//
// Both are failure modes specific to holding the loop on a sync group: a parked
// gate that nothing ever releases (a cancelled run), and a gate that strands a
// call which had already settled inside its own launch round.
// ---------------------------------------------------------------------------

describe('batch gate races (T4 verification)', () => {
    // Settled-state capture WITHOUT awaiting: the run is still in flight while the
    // test aborts it, so the probe records the eventual outcome instead of blocking.
    const probe = (
        promise: Promise<unknown>
    ): { status: 'pending' | 'resolved' | 'rejected'; error?: unknown } => {
        const state: { status: 'pending' | 'resolved' | 'rejected'; error?: unknown } = {
            status: 'pending'
        };

        promise.then(
            () => {
                state.status = 'resolved';
            },
            (error) => {
                state.status = 'rejected';
                state.error = error;
            }
        );

        return state;
    };

    it('releases a parked batch gate when the run is aborted', async () => {
        const gate = deferred<string>();
        const controller = new AbortController();

        // One lone sync call: the scripted transport repeats, so ANY extra request
        // would be visible as seen.length > 1.
        const world = fixture([calls(call('c1', 'solo', '{"value":"x"}'))], {
            solo: gated('solo', 'sync', gate)
        });

        const running = probe(world.run('go', { signal: controller.signal }));
        await flush();

        // Parked on the group: the run is waiting, and the park spends no turns.
        expect(world.seen.length).toBe(1);
        expect(running.status).toBe('pending');

        controller.abort(new Error('gate aborted'));
        await flush();

        // THE CONTRACT: an abort releases the park. Without the signal listener in
        // waitForSyncBatch the run would hang here forever (status stays 'pending'),
        // because a cancelled run never delivers into a live transcript.
        expect(running.status).toBe('rejected');
        expect(String((running.error as Error).message)).toContain('gate aborted');

        // Issue 0036 R1: an aborted run no longer rolls back. It RETAINS the prompt and
        // the assistant turn that asked for the gated call, and that call — parked, then
        // abandoned by the abort — is answered by exactly ONE synthesized interrupted
        // result, which is what keeps the retained tail replayable by a provider. The
        // recurring-wakeup timer is still cleared rather than left armed behind the park.
        // The marker is matched by substring so the sentence itself stays re-wordable.
        expect(world.seen.length).toBe(1);
        const retained: unknown[] = JSON.parse(JSON.stringify(world.brain.messages));
        expect(world.brain.messages).toMatchObject([
            { role: 'user', content: 'go' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'c1', name: 'solo', arguments: '{"value":"x"}' }]
            },
            {
                role: 'tool',
                toolCallId: 'c1',
                name: 'solo',
                content: expect.stringContaining('cancelled or interrupted')
            }
        ]);
        expect(vi.getTimerCount()).toBe(0);

        // The abandoned sync member is released by abandonScope, so its late result
        // cannot resurrect the dead run or spend a turn. Retention means the transcript
        // is no longer empty here, so the surviving proof of "nothing happened" is that
        // the run stays at ONE request and the retained rows are byte-for-byte what the
        // abort left behind — the late 'late-value' payload was never appended.
        gate.resolve('late-value');
        await flush();
        expect(world.seen.length).toBe(1);
        expect(world.brain.messages).toEqual(retained);
    });

    it('spends no extra turn when a sync call settles inside its own launch round', async () => {
        // Microtask-only implementation: it is ALREADY settled when the loop reaches
        // the gate, so the group drained during the launch round and the park must be
        // skipped. This pins the pre-mode behaviour the gate must not regress: one
        // follow-up request built from the real result, never a placeholder turn.
        const instant = deferred<string>();
        instant.resolve('instant-value');

        const world = fixture(
            [calls(call('c1', 'instant', '{"value":"x"}')), answer('done')],
            { instant: gated('instant', 'sync', instant) }
        );

        const running = world.run('go');
        await flush();

        await expect(running).resolves.toMatchObject({ content: 'done' });
        expect(world.seen.length).toBe(2);
        expect(world.seen[1]).toContain('tool:c1:instant-value');
        expect(toolMessages(world.brain.messages)).toEqual(['c1:instant-value']);
        expect(vi.getTimerCount()).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// R5 — the PERIODIC wake answers for ASYNC pending work only.
//
// The heartbeat is a plugin (src/plugins/async-ping.plugin.ts) and every branch of its
// predicate is pinned case-by-case in src/plugin/async-ping.test.ts. What THIS block
// owns is the runtime consequence through a real harness: TURN COUNTS, `wakeup` FRAMES,
// and timer hygiene. `wakeIntervalMs: 250` seeds the plugin's `intervalMs` setting
// (harness() -> plugin settings provider -> api.settings -> the plugin's own timer);
// that seeding chain is pinned end to end in src/harness.background.test.ts.
//
// Why the rule exists: a `sync` group re-enters the model when its LAST member settles,
// so a sync-parked run is guaranteed a turn the moment it can act on anything. Waking it
// on a timer instead buys a `status:'pending'` placeholder turn — a model turn that
// cannot decide anything. An `async` completion has no such guarantee: it releases the
// parked gate on its own and the run has to be told.
//
// The policy source matters: a DISCOVERED built-in publishes no `mode` on its registry
// object at all (../harness.ts binds the row's policy in a private WeakMap), so the last
// two tests below pin the two directions of the plugin's discovery-table lookup —
// `read` (row says sync → stays quiet) and `shell` (row says async → keeps pinging, which
// is also the one disclosed divergence against a mode-less host replacement).
// ---------------------------------------------------------------------------

describe('heartbeat policy (R5 — async work only)', () => {
    // Settled-state capture WITHOUT awaiting: the run is still parked while the test
    // inspects the boundary, so "still pending" is an observation rather than an
    // inference from the request count.
    const probe = (
        promise: Promise<unknown>
    ): { status: 'pending' | 'resolved' | 'rejected' } => {
        const state: { status: 'pending' | 'resolved' | 'rejected' } = { status: 'pending' };
        promise.then(
            () => {
                state.status = 'resolved';
            },
            () => {
                state.status = 'rejected';
            }
        );
        return state;
    };

    it('never wakes a run parked on a lone sync call, and holds no heartbeat timer', async () => {
        const gate = deferred<string>();

        // The scripted transport REPEATS its last entry, so any wake at all would show
        // up as an extra request.
        const world = fixture(
            [calls(call('c1', 'solo', '{"value":"x"}')), answer('after-sync')],
            { solo: gated('solo', 'sync', gate) },
            { wakeIntervalMs: 250 }
        );

        const running = world.run('go');
        const state = probe(running);
        await flush();

        // Parked on the sync group: one request, and the run is genuinely waiting.
        expect(world.seen.length).toBe(1);
        expect(state.status).toBe('pending');

        // Four whole heartbeats pass. A sync-only board arms NO heartbeat, so there is
        // not even a handle to fire: no wake, no turn, and nothing left on the clock.
        await advance(1_000);
        expect(vi.getTimerCount()).toBe(0);
        expect(wakeupsOf(world.events)).toEqual([]);
        expect(world.seen.length).toBe(1);
        expect(state.status).toBe('pending');

        // The call's OWN settlement is the only releaser of the park: exactly one turn,
        // built from the real result — the run never saw a placeholder.
        gate.resolve('solo-value');
        await flush();

        expect(world.seen.length).toBe(2);
        expect(world.seen[1]).toContain('tool:c1:solo-value');
        expect(wakeupsOf(world.events)).toEqual([]);
        await expect(running).resolves.toMatchObject({ content: 'after-sync' });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('still wakes a run with async work pending at the heartbeat boundary', async () => {
        const gate = deferred<string>();

        const world = fixture(
            [
                calls(call('a1', 'long', '{"value":"x"}')),
                answer('parked-1'),
                answer('parked-2'),
                answer('settled')
            ],
            { long: gated('long', 'async', gate) },
            { wakeIntervalMs: 250 }
        );

        const running = world.run('go');
        await flush();

        // Unchanged R3 behaviour: an async call never parks the loop, so the launch
        // round already bought request 2 with the call outstanding.
        expect(world.seen.length).toBe(2);

        // 249 ms is not a boundary yet — and the heartbeat IS armed, because the board
        // holds async work (this is the timer the sync case above never created).
        await advance(249);
        expect(wakeupsOf(world.events)).toEqual([]);
        expect(world.seen.length).toBe(2);
        expect(vi.getTimerCount()).toBe(1);

        // Exactly 250 ms: one `wakeup`, one inspecting turn, and the plugin re-arms
        // while the work is still out (the contract src/harness.background.test.ts pins
        // at the historical 600000 ms cadence — this is the same rule at 250 ms).
        await advance(1);
        expect(wakeupsOf(world.events)).toEqual([
            { agent: 'writer', reason: 'pending-tools' }
        ]);
        expect(world.seen.length).toBe(3);
        expect(vi.getTimerCount()).toBe(1);

        // The completion still buys its own turn with the real payload, and the drained
        // board takes the heartbeat with it.
        gate.resolve('long-value');
        await flush();

        expect(world.seen.length).toBe(4);
        expect(toolMessages(world.brain.messages)).toEqual(['a1:long-value']);
        await expect(running).resolves.toMatchObject({ content: 'settled' });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('applies the DISCOVERED policy of a built-in name when the host definition declares none', async () => {
        const gate = deferred<string>();

        // A host tool registered under the discovered name `read` and declaring NO mode:
        // the harness parks on it (its effective mode is the 'sync' default — the same
        // shape `harness.sync-async.test.ts`'s replacement test pins), and the plugin
        // must agree by reading the generated ROW for `read`, because a discovered
        // definition object carries no `mode` of its own.
        const world = fixture(
            [calls(call('r1', 'read', '{"value":"x"}')), answer('read-settled')],
            { read: gated('read', undefined, gate) },
            { wakeIntervalMs: 250 }
        );

        const running = world.run('go');
        const state = probe(running);
        await flush();

        expect(world.seen.length).toBe(1);
        expect(state.status).toBe('pending');

        await advance(1_000);
        expect(vi.getTimerCount()).toBe(0);
        expect(wakeupsOf(world.events)).toEqual([]);
        expect(world.seen.length).toBe(1);

        gate.resolve('read-value');
        await flush();

        expect(world.seen.length).toBe(2);
        expect(world.seen[1]).toContain('tool:r1:read-value');
        await expect(running).resolves.toMatchObject({ content: 'read-settled' });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('over-pings — never under-pings — a mode-less replacement of an async built-in name', async () => {
        const gate = deferred<string>();

        // THE ONE DISCLOSED DIVERGENCE, pinned as an observation. `shell`'s row is
        // async; a host REPLACEMENT under that wire name declares nothing, so the
        // HARNESS treats it as sync and parks (../harness.ts `effectiveToolMode` binds
        // the policy to the definition, not the name). The plugin cannot see that
        // binding, so it sees the row and keeps the heartbeat. The run therefore gets a
        // wake the harness did not strictly need — one extra turn — which is the safe
        // direction: the alternative would be a silent loss of hang-visibility.
        const world = fixture(
            [calls(call('x1', 'shell', '{"value":"x"}')), answer('parked'), answer('late-shell')],
            { shell: gated('shell', undefined, gate) },
            { wakeIntervalMs: 250 }
        );

        const running = world.run('go');
        await flush();

        // Parked (the harness's sync rule), and armed (the plugin's row lookup).
        expect(world.seen.length).toBe(1);
        expect(vi.getTimerCount()).toBe(1);

        await advance(250);
        expect(wakeupsOf(world.events)).toEqual([
            { agent: 'writer', reason: 'pending-tools' }
        ]);
        expect(world.seen.length).toBe(2);

        // The call's own settlement is still what finishes the story.
        gate.resolve('shell-value');
        await flush();

        expect(toolMessages(world.brain.messages)).toEqual(['x1:shell-value']);
        await expect(running).resolves.toMatchObject({ content: 'late-shell' });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('drops the heartbeat once the async call settles and only a sync call is left', async () => {
        const asyncGate = deferred<string>();
        const syncGate = deferred<string>();

        // ONE message, one async call and one sync call: the sync member parks the loop
        // (R3) while the async member is exactly what a heartbeat is worth.
        const world = fixture(
            [
                calls(call('a1', 'branch', '{"value":"1"}'), call('s1', 'io', '{"value":"2"}')),
                answer('waiting'),
                answer('done')
            ],
            { branch: gated('branch', 'async', asyncGate), io: gated('io', 'sync', syncGate) },
            { wakeIntervalMs: 250 }
        );

        const running = world.run('go');
        await flush();

        // Parked: the async launch bought no turn, and the heartbeat is armed for it.
        expect(world.seen.length).toBe(1);
        expect(vi.getTimerCount()).toBe(1);

        // The async completion releases the park on its own (the R3 contract): turn 2.
        asyncGate.resolve('branch-value');
        await flush();
        expect(world.seen.length).toBe(2);

        // The board now reads SYNC-ONLY, and `async.drained` never fired for it (the
        // core emits that transition only when the WHOLE board empties), so the handle
        // is still armed. At the boundary it must drop itself: no wake, no re-arm, and
        // no timer left while the sync call keeps running.
        await advance(250);
        expect(wakeupsOf(world.events)).toEqual([]);
        expect(world.seen.length).toBe(2);
        expect(vi.getTimerCount()).toBe(0);

        // It stays silent for as long as the sync call takes — the board cannot be
        // trapped in a permanent heartbeat.
        await advance(2_000);
        expect(wakeupsOf(world.events)).toEqual([]);
        expect(world.seen.length).toBe(2);
        expect(vi.getTimerCount()).toBe(0);

        // And the sync group still delivers its one turn, with both real results.
        syncGate.resolve('io-value');
        await flush();

        expect(toolMessages(world.brain.messages)).toEqual(['a1:branch-value', 's1:io-value']);
        await expect(running).resolves.toMatchObject({ content: 'done' });
        expect(vi.getTimerCount()).toBe(0);
    });
});

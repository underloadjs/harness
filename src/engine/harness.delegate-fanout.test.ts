// R1 PROBE — a 4-way parallel `delegate` fan-out under the RANK model (executable repro).
//
// WHY THIS FILE EXISTS (it is a probe, not a feature contract). The Instruct app's rank-model
// update (`primary`/`subagents` → Rank A/Rank B) is reported to have broken delegation: the
// entry agent announced "four parallel delegate batteries" and the run then parked until the
// user aborted (`This operation was aborted`, i.e. the caller's own AbortSignal reason —
// src/harness.ts:9522 `abortErrorOf`). The existing suites cover ONE delegation at a time and
// THREE siblings in flight (./harness.delegation.test.ts:2963+); nothing measures the ORDERING
// of a 4-way fan-out, the same-agent case, or the no-timer park in that shape. Every assertion
// here therefore MEASURES overlap (start/end timestamps pushed by a manual-control transport)
// rather than restating a prose contract.
//
// What each probe pins (verdicts in the R1 report):
//   1. four delegates to four DISTINCT Rank B agents from the callable root   → concurrency?
//   2. four delegates to the SAME Rank B agent from the callable root         → serialization?
//   3. one child whose transport generation never resolves                    → park + timers?
//   4. nesting: a delegation issued from inside a delegated child (rank vs depth)
//   5. the SAME fan-out issued from a HOST thread instead of the default
//      conversation (`parent.threadState.record.origin === 'host'`,
//      src/harness.ts:14746-14764) — the path the server actually takes
//      (src/server/sessions.ts:10396-10400, `enqueue`'s "absent threadId opens a new
//      standalone host thread", src/server/sessions.ts:8791-8793).
//
// Determinism: every describe uses `vi.useFakeTimers()` and settles the harness with `flush()`
// (the idiom from ./harness.delegation.test.ts:168), so no probe sleeps and no stall depends on
// wall-clock luck. The transports below park on manual gates, so "in flight" is a fact the test
// controls, not a race it hopes to win.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent, harness } from './index';
import type { HarnessStream, HarnessStreamRequest } from './index';

// ---------------------------------------------------------------------------
// Helpers (deliberately local copies of the ./harness.delegation.test.ts idioms,
// so this probe cannot be broken by edits to another file's fixtures)
// ---------------------------------------------------------------------------

const deferred = <T,>() => {
    let settle!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
        settle = resolve;
    });

    return { promise, resolve: settle };
};

// Drains the harness's promise chain WITHOUT moving the clock (32 zero-advance
// passes: a launch → re-request → park chain spans more microtasks than one await).
const flush = async (): Promise<void> => {
    for (let pass = 0; pass < 64; pass += 1) {
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
    }
};

const advance = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
    await flush();
};

// Records the settled state of a promise IMMEDIATELY, so a test can prove the run
// is still pending at an instant without awaiting it.
const probe = <T,>(promise: Promise<T>): { status: 'pending' | 'resolved' | 'rejected'; value?: T; error?: unknown } => {
    const state: { status: 'pending' | 'resolved' | 'rejected'; value?: T; error?: unknown } = { status: 'pending' };

    promise.then(
        (value) => {
            state.status = 'resolved';
            state.value = value;
        },
        (error) => {
            state.status = 'rejected';
            state.error = error;
        }
    );

    return state;
};

const brain = (stream: HarnessStream): ReturnType<typeof agent> => agent({ model: 'merge/ds4-flash', stream });

// Turn script: turn N of the run consumes entry N (the last entry repeats forever),
// which is what lets a parent keep answering while children are still in flight.
// `seen` records every REQUEST the harness sent — the only place a PENDING delegation
// is visible, because the placeholder is a projection-only message and is never
// committed to the transcript (./harness.delegation.test.ts:2907+).
const scripted = (turns: Record<string, unknown>[][], seen?: HarnessStreamRequest[]): HarnessStream => {
    let index = 0;

    return (async function* stream(request: HarnessStreamRequest) {
        seen?.push(request);

        const frames = turns[index] ?? turns[turns.length - 1]!;
        index += 1;

        for (const frame of frames) yield frame as never;
    }) as unknown as HarnessStream;
};

const answer = (text: string): Record<string, unknown>[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

// ONE assistant message carrying N tool calls — the fan-out shape under test.
const callTurn = (calls: { id: string; name: string; arguments: string }[]): Record<string, unknown>[] => [
    { type: 'done', stopReason: 'tool_calls', toolCalls: calls }
];

const delegateTurn = (specs: { id: string; agent: string; input: string }[]): Record<string, unknown>[] =>
    callTurn(specs.map((spec) => ({ id: spec.id, name: 'delegate', arguments: `{"agent":"${spec.agent}","input":"${spec.input}"}` })));

// The last user message of a request == the delegated brief (each delegation opens a
// fresh conversation UNLESS it lands in the target's standing conversation, where the
// brief is still the newest user entry). Keying on it makes a shared transport answer
// per-brief, which is what lets one Agent instance serve 4 delegations honestly.
const briefOf = (request: HarnessStreamRequest): string => {
    const users = (request.messages ?? []).filter((message) => message.role === 'user');

    return String(users[users.length - 1]?.content ?? '');
};

// A transport whose WHOLE generation parks on a gate: the harness has the request, the
// generation is open, and nothing can resolve until the test says so. `log` records the
// exact instants the generation opened and closed, which IS the overlap measurement.
const gatedTransport = (
    key: string,
    gate: Promise<unknown>,
    answerText: string,
    log: string[],
    counters: { active: number; max: number }
): HarnessStream =>
    (async function* stream() {
        log.push(`open:${key}`);
        counters.active += 1;
        counters.max = Math.max(counters.max, counters.active);

        await gate;

        counters.active -= 1;
        log.push(`close:${key}`);
        yield { type: 'text', delta: answerText };
        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
    }) as unknown as HarnessStream;

// The same transport, keyed by the brief carried in the request — for a SHARED agent
// serving several delegations (one Agent instance, several runs).
const gatedTransportPerBrief = (
    gates: Map<string, Promise<unknown>>,
    log: string[],
    counters: { active: number; max: number }
): HarnessStream =>
    (async function* stream(request: HarnessStreamRequest) {
        const brief = briefOf(request);
        const key = brief.startsWith('task ') ? brief.slice(5) : brief;

        log.push(`open:${key}`);
        counters.active += 1;
        counters.max = Math.max(counters.max, counters.active);

        await (gates.get(key) ?? Promise.resolve());

        counters.active -= 1;
        log.push(`close:${key}`);
        yield { type: 'text', delta: `${key} finished` };
        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
    }) as unknown as HarnessStream;

// The RAW content of a call's tool message (a REFUSED call answers with text, not the
// JSON envelope — see the `Tool "…" failed: …` shape pinned at
// src/harness.creation-policy.test.ts:348).
const rawOf = (messages: readonly unknown[], callId: string): string => {
    const message = messages.find(
        (entry) =>
            (entry as { role?: string; toolCallId?: string }).role === 'tool' &&
            (entry as { toolCallId?: string }).toolCallId === callId
    ) as { content: string } | undefined;

    if (message === undefined) throw new Error(`no tool result for ${callId}`);

    return message.content;
};

// The tool message a REQUEST carries for a call id — i.e. what the model actually READS
// about that call this turn, including a projection-only `status: "pending"` placeholder.
const requestToolContent = (request: HarnessStreamRequest, callId: string): Record<string, any> => {
    const message = (request.messages ?? []).find(
        (entry) => (entry as { role?: string; toolCallId?: string }).role === 'tool' && (entry as { toolCallId?: string }).toolCallId === callId
    ) as { content: string } | undefined;

    if (message === undefined) throw new Error(`no tool message for ${callId} in the request`);

    return JSON.parse(message.content) as Record<string, any>;
};

// The `delegate` envelope a call ended up with, by call id.
const envelopeOf = (messages: readonly unknown[], callId: string): Record<string, any> => {
    const message = messages.find(
        (entry) =>
            (entry as { role?: string; toolCallId?: string }).role === 'tool' &&
            (entry as { toolCallId?: string }).toolCallId === callId
    ) as { content: string } | undefined;

    if (message === undefined) throw new Error(`no tool result for ${callId}`);

    return JSON.parse(message.content) as Record<string, any>;
};

const fanOutSpecs = ['alpha', 'beta', 'gamma', 'delta'].map((name, index) => ({
    id: `c${index}`,
    agent: name,
    input: `find ${name}`
}));

const counters = (): { active: number; max: number } => ({ active: 0, max: 0 });

// Count reported events of one type. The type names asserted below are the ones this
// probe OBSERVED on the progress reporter: start, text, tool_call, tool_result, done,
// attempt_commit, wakeup (there is no per-turn `agent_message` progress frame).
const countType = (events: readonly { type: string }[], type: string): number =>
    events.filter((event) => event.type === type).length;

// ---------------------------------------------------------------------------
// PROBE 1 — four delegates, four DISTINCT Rank B agents, one assistant message,
// from the CALLABLE ROOT (the entry agent's own default conversation).
// ---------------------------------------------------------------------------
describe('R1 fan-out probe: four delegates to four agents from the callable root', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('runs all four child generations in flight at once and answers them LIFO', async () => {
        const gates = fanOutSpecs.map(() => deferred<unknown>());
        const log: string[] = [];
        const tally = counters();

        const children = Object.fromEntries(
            fanOutSpecs.map((spec, index) => [
                spec.agent,
                brain(gatedTransport(spec.agent, gates[index]!.promise, `${spec.agent} finished`, log, tally))
            ])
        );

        const writerAgent = brain(scripted([delegateTurn(fanOutSpecs), answer('waiting'), answer('final')]));

        const writer = harness({
            agents: { writer: writerAgent, ...children },
            presets: false,
            // The shipped heartbeat is a timer; replacing it (the documented override path,
            // ./harness.delegation.test.ts:2671) keeps `vi.getTimerCount()` meaningful.
            plugins: [{ name: 'async-ping', setup: () => undefined }]
        });

        const running = probe(writer('go'));
        await flush();

        // THE MEASUREMENT: four generations opened, zero closed, high-water mark 4.
        // A serialized launch would read open:alpha, close:alpha, open:beta, … and max 1.
        expect(log).toEqual(['open:alpha', 'open:beta', 'open:gamma', 'open:delta']);
        expect(tally.max).toBe(4);
        expect(running.status).toBe('pending');

        // Each child owns its OWN conversation (the standing `agent:<name>` one, because the
        // caller is the callable root, src/harness.ts:14763 `defaultThreadOf`).
        expect(
            writer
                .threads()
                .filter((record) => fanOutSpecs.some((spec) => spec.agent === record.agent))
                .map((record) => record.id)
                .sort()
        ).toEqual(['agent:alpha', 'agent:beta', 'agent:delta', 'agent:gamma']);

        // Release in REVERSE start order: the closes must come back in reverse, which only a
        // genuinely concurrent set of generations can do.
        const closeOrder: string[] = [];

        for (const index of [3, 2, 1, 0]) {
            gates[index]!.resolve(undefined);
            await flush();
            closeOrder.push(log[log.length - 1]!);
        }

        expect(closeOrder).toEqual(['close:delta', 'close:gamma', 'close:beta', 'close:alpha']);

        await flush();
        expect(running.status).toBe('resolved');
        expect(running.value?.content).toBe('final');

        // Every fan-out call is answered by its OWN child's envelope (identity cannot drift).
        expect(
            fanOutSpecs.map((spec) => {
                const envelope = envelopeOf(writerAgent.messages, spec.id);

                return { agent: envelope.agent, content: envelope.content, status: envelope.status, threadId: envelope.threadId };
            })
        ).toEqual([
            { agent: 'alpha', content: 'alpha finished', status: 'completed', threadId: 'agent:alpha' },
            { agent: 'beta', content: 'beta finished', status: 'completed', threadId: 'agent:beta' },
            { agent: 'gamma', content: 'gamma finished', status: 'completed', threadId: 'agent:gamma' },
            { agent: 'delta', content: 'delta finished', status: 'completed', threadId: 'agent:delta' }
        ]);
    });
});

// ---------------------------------------------------------------------------
// PROBE 2 — the same fan-out aimed at ONE agent, still from the callable root.
// All four calls resolve to the SAME actor key `thread:agent:<name>`, so they queue
// behind each other in `acquireAgent` (src/harness.ts:14385-14450, awaited :14843).
// ---------------------------------------------------------------------------
describe('R1 fan-out probe: four delegates to the SAME agent from the callable root', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('serializes the four child generations one-at-a-time while the caller parks', async () => {
        const gates = new Map<string, Promise<unknown>>();
        const live = new Map<string, { promise: Promise<unknown>; resolve: (value: unknown) => void }>();

        for (const key of ['1', '2', '3', '4']) {
            const gate = deferred<unknown>();
            live.set(key, gate);
            gates.set(key, gate.promise);
        }

        const log: string[] = [];
        const tally = counters();
        const seenParent: HarnessStreamRequest[] = [];
        const helper = brain(gatedTransportPerBrief(gates, log, tally));
        const writerAgent = brain(
            scripted(
                [
                    delegateTurn(['1', '2', '3', '4'].map((key, index) => ({ id: `c${index}`, agent: 'helper', input: `task ${key}` }))),
                    answer('waiting'),
                    answer('final')
                ],
                seenParent
            )
        );

        const writer = harness({
            agents: { writer: writerAgent, helper },
            presets: false,
            plugins: [{ name: 'async-ping', setup: () => undefined }]
        });

        const running = probe(writer('go'));
        await flush();

        // THE MEASUREMENT: four calls launched, exactly ONE generation open. The other
        // three are queued behind the actor lock — nothing is lost, nothing overlaps.
        expect(log).toEqual(['open:1']);
        expect(tally.max).toBe(1);
        expect(running.status).toBe('pending');

        // The caller emits NOTHING while the queue drains. It spent exactly two model
        // requests — the fan-out turn, and the one turn that read four placeholders —
        // then parked: no further turn, no progress, no clock. This is the "announced the
        // batteries and then said nothing" shape.
        expect(seenParent.map((request) => (request.messages ?? []).filter((entry) => entry.role === 'assistant').length)).toEqual([0, 1]);
        expect(['c0', 'c1', 'c2', 'c3'].map((id) => requestToolContent(seenParent[1]!, id).status)).toEqual([
            'pending',
            'pending',
            'pending',
            'pending'
        ]);

        // Release one at a time: the next generation opens only after the previous closes,
        // i.e. strict open/close alternation. A parallel implementation would open all four.
        for (const key of ['1', '2', '3', '4']) {
            live.get(key)!.resolve(undefined);
            await flush();
        }

        expect(log).toEqual(['open:1', 'close:1', 'open:2', 'close:2', 'open:3', 'close:3', 'open:4', 'close:4']);
        expect(tally.max).toBe(1);

        await flush();
        expect(running.status).toBe('resolved');

        const envelopes = ['c0', 'c1', 'c2', 'c3'].map((id) => {
            const envelope = envelopeOf(writerAgent.messages, id);

            return { agent: envelope.agent, content: envelope.content, threadId: envelope.threadId };
        });

        // All four share the ONE standing conversation, and each still names its own child.
        expect(envelopes).toEqual([
            { agent: 'helper', content: '1 finished', threadId: 'agent:helper' },
            { agent: 'helper', content: '2 finished', threadId: 'agent:helper' },
            { agent: 'helper', content: '3 finished', threadId: 'agent:helper' },
            { agent: 'helper', content: '4 finished', threadId: 'agent:helper' }
        ]);

        // The serialization is transcript-visible: one conversation accumulated all four
        // briefs and answers, which is the documented standing-conversation behaviour.
        expect(writer.threadMessages('agent:helper').map((message) => message.role)).toEqual([
            'user',
            'assistant',
            'user',
            'assistant',
            'user',
            'assistant',
            'user',
            'assistant'
        ]);
    });
});

// ---------------------------------------------------------------------------
// PROBE 3 — the hang shape: three children answer, ONE child's transport
// generation never resolves. Does the parent turn ever conclude on its own, and
// is anything armed to end the wait? (DELEGATE_TIMEOUT_MS is +Infinity,
// src/core/agent-limits.ts:62, and armWallClock arms nothing for non-finite,
// src/harness.ts:911-941.)
// ---------------------------------------------------------------------------
describe('R1 fan-out probe: one child whose generation never resolves', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('parks the caller with NO timer armed until an external abort lands', async () => {
        const stuck = deferred<unknown>();
        const log: string[] = [];
        const tally = counters();

        const children = Object.fromEntries(
            fanOutSpecs.map((spec, index) => [
                spec.agent,
                brain(
                    index === 3
                        ? gatedTransport(spec.agent, stuck.promise, 'never', log, tally)
                        : gatedTransport(spec.agent, Promise.resolve(), `${spec.agent} finished`, log, tally)
                )
            ])
        );

        const seenParent: HarnessStreamRequest[] = [];
        const writerAgent = brain(scripted([delegateTurn(fanOutSpecs), answer('waiting'), answer('final')], seenParent));

        const writer = harness({
            agents: { writer: writerAgent, ...children },
            presets: false,
            plugins: [{ name: 'async-ping', setup: () => undefined }]
        });

        const controller = new AbortController();
        const running = probe(writer('go', { signal: controller.signal }));
        await flush();

        // Three children closed, the fourth is open forever; the caller has NOT concluded.
        expect(log.filter((entry) => entry.startsWith('close:'))).toEqual(['close:alpha', 'close:beta', 'close:gamma']);
        expect(log.filter((entry) => entry === 'open:delta')).toEqual(['open:delta']);
        expect(running.status).toBe('pending');

        // MEASUREMENT (why an all-immediate fan-out is NOT the same shape as a parked one):
        // a child that settles without real I/O is absorbed by the launch loop's settle
        // window (src/harness.ts:14223 `settleWindow` only coalesces work that settles
        // without real I/O), so the three fast generations never overlapped — the high-water
        // mark here is 1, against 4 in probe 1/6 where every child held its generation open.
        // A real battery does I/O, so probe 1/6 is the shape that matters; this row records
        // the coalescing so nobody reads "overlap" as unconditional.
        expect(tally.max).toBe(1);

        // THE CLOCK FACT: not one timer exists in the whole process. Nothing will ever
        // wake this run — the delegation carries no wall clock and the heartbeat was
        // overridden, so the park is a park, not a wait with a deadline.
        expect(vi.getTimerCount()).toBe(0);

        // Hours of clock, and the shape does not change: the three finished children are
        // already on the parent's record while the run stays parked on the fourth.
        await advance(3_600_000);
        expect(running.status).toBe('pending');
        await advance(3_600_000);
        expect(vi.getTimerCount()).toBe(0);
        expect(running.status).toBe('pending');

        expect(['c0', 'c1', 'c2'].map((id) => envelopeOf(writerAgent.messages, id).status)).toEqual([
            'completed',
            'completed',
            'completed'
        ]);

        // The stuck call is STILL unanswered in substance. Its only representation is the
        // projection-only PENDING placeholder in the last request the parent was sent —
        // never a timeout envelope, and nothing terminal is ever committed for it.
        const stuckPlaceholder = requestToolContent(seenParent[seenParent.length - 1]!, 'c3');
        expect(stuckPlaceholder.status).toBe('pending');
        expect(stuckPlaceholder.threadId).toBe('agent:delta');
        expect(stuckPlaceholder.note).toContain('toolCancel');
        expect(
            writerAgent.messages.some(
                (message) => (message as { role?: string; toolCallId?: string }).role === 'tool' && (message as { toolCallId?: string }).toolCallId === 'c3'
            )
        ).toBe(false);

        // Nothing in the run can end the park: the only exit is the caller's own abort.
        controller.abort();
        await flush();

        // The error the caller then sees IS the app's symptom string: `throwIfAborted`
        // throws the signal's own DOMException (src/harness.ts:9515 throws `signal.reason`,
        // src/harness.ts:9523 `abortErrorOf` mints name `AbortError` / message
        // `This operation was aborted`), and the run's terminal failure path re-wraps any
        // non-HarnessError as `new HarnessError(info.message, { cause })`
        // (src/harness.ts:14375 — the two frames this rejection's stack carries). So the
        // "This operation was aborted" the Instruct UI showed IS a caller-aborted run, not
        // a provider failure.
        expect(running.status).toBe('rejected');
        expect({ name: (running.error as Error).name, message: (running.error as Error).message }).toEqual({
            name: 'HarnessError',
            message: 'This operation was aborted'
        });
        expect((running.error as { cause?: unknown })?.cause).toBeInstanceOf(DOMException);

        // Let the parked generation unwind so the process has no dangling gate.
        stuck.resolve(undefined);
        await flush();
    });

    // The APP-SHAPE control: the shipped `async-ping` liveness plugin is NOT overridden
    // here, so the real deployment's timers (wakeIntervalMs, default 600000 —
    // src/harness.ts:632 `DEFAULT_WAKE_INTERVAL_MS`) are in play. Two things are pinned:
    // the heartbeat does NOT serialize the fan-out (all four generations are still open at
    // once), and it does NOT end the park — a wake is a heartbeat, not a deadline.
    it('keeps parking with the shipped liveness heartbeat armed', async () => {
        const gates = fanOutSpecs.map(() => deferred<unknown>());
        const log: string[] = [];
        const tally = counters();
        const events: { type: string; agent?: string }[] = [];

        const children = Object.fromEntries(
            fanOutSpecs.map((spec, index) => [
                spec.agent,
                brain(gatedTransport(spec.agent, gates[index]!.promise, `${spec.agent} finished`, log, tally))
            ])
        );

        const writerAgent = brain(scripted([delegateTurn(fanOutSpecs), answer('waiting'), answer('final')]));

        const writer = harness({
            agents: { writer: writerAgent, ...children },
            presets: false,
            report: { progress: (event: { type: string; agent?: string }) => events.push(event) }
        });

        const controller = new AbortController();
        const running = probe(writer('go', { signal: controller.signal }));
        await flush();

        // The heartbeat changes nothing about concurrency: four in flight, exactly as
        // probe 1 measured with the plugin overridden.
        expect(tally.max).toBe(4);
        expect(log).toEqual(['open:alpha', 'open:beta', 'open:gamma', 'open:delta']);

        // Release every child except the last one, then spend 30 minutes of session clock.
        for (const index of [0, 1, 2]) gates[index]!.resolve(undefined);
        await flush();

        expect(running.status).toBe('pending');

        // Snapshot the caller's OUTPUT stream, then spend half an hour of wakes on it.
        const emittedBefore = { done: countType(events, 'done'), text: countType(events, 'text') };

        await advance(1_800_000);

        // THE HEARTBEAT FACTS, measured: exactly ONE timer exists during the park (the wake
        // interval, 600000 ms — src/harness.ts:632), it fires on cadence (3 wakes across
        // 1800000 ms), and each wake RE-DRIVES the parked caller: one extra model turn and one
        // extra answer per wake, while the run STILL stays pending and the stuck call stays
        // open. The heartbeat therefore spends a provider request every ten minutes and ends
        // nothing — a wake is a heartbeat, not a deadline.
        expect({
            timersDuringPark: vi.getTimerCount(),
            log,
            wakeups: countType(events, 'wakeup'),
            newTurns: countType(events, 'done') - emittedBefore.done,
            newText: countType(events, 'text') - emittedBefore.text,
            status: running.status
        }).toEqual({
            timersDuringPark: 1,
            log: ['open:alpha', 'open:beta', 'open:gamma', 'open:delta', 'close:alpha', 'close:beta', 'close:gamma'],
            wakeups: 3,
            newTurns: 3,
            newText: 3,
            status: 'pending'
        });

        controller.abort();
        await flush();

        // The heartbeat never ended the wait; the caller's abort still had to.
        expect(running.status).toBe('rejected');
        expect((running.error as Error).message).toBe('This operation was aborted');

        gates[3]!.resolve(undefined);
        await flush();
    });
});

// ---------------------------------------------------------------------------
// PROBE 4 — nesting. A delegation issued from INSIDE a delegated child (the shape
// a "battery of sub-batteries" model would attempt), measured against BOTH guards:
// the strictly-downward rank rule (src/harness.ts:5651-5664) and the distinct-rank
// depth ceiling (src/harness.ts:14711-14727).
// ---------------------------------------------------------------------------
describe('R1 fan-out probe: nesting under two ranks', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('refuses a B→B delegation from inside a child with the RANK message, not the depth one', async () => {
        // entry `instruct` = Rank A, two Rank B workers: the shipped Instruct shape
        // (src/server/harnesses/presets.ts:211-220), narrowed to three members.
        const reviewer = brain(scripted([answer('reviewed')]));
        const helper = brain(scripted([delegateTurn([{ id: 'n1', agent: 'reviewer', input: 'review it' }]), answer('helper done')]));
        const instruct = brain(scripted([delegateTurn([{ id: 'c1', agent: 'helper', input: 'do the work' }]), answer('entry done')]));

        const writer = harness({
            agents: { instruct, helper, reviewer },
            entry: 'instruct',
            ranks: { instruct: 'A', helper: 'B', reviewer: 'B' },
            presets: false,
            plugins: [{ name: 'async-ping', setup: () => undefined }]
        });

        const message = await writer('go');
        await flush();

        expect(message.content).toBe('entry done');

        // The entry's delegation to Rank B SUCCEEDED at depth 2 == the ceiling (2 distinct
        // ranks), so a plain entry→B fan-out is never refused for depth.
        expect(envelopeOf(instruct.messages, 'c1')).toMatchObject({ agent: 'helper', content: 'helper done', status: 'completed' });

        // The nested call is refused, and the reason is the RANK ladder — the depth ceiling
        // (pinned elsewhere with its exact message in src/harness.creation-policy.test.ts:348)
        // is not what fires here.
        const nested = rawOf(helper.messages, 'n1');
        expect(nested).toContain('delegation is strictly downward');
        expect(nested).toContain('No agent in this harness is ranked below Rank B');

        // And the tool is not even DECLARED to a Rank B member, so a real model never sees the
        // door it is being refused at.
        const seen: HarnessStreamRequest[] = [];
        const probeAgent = brain(
            (async function* stream(request: HarnessStreamRequest) {
                seen.push(request);
                yield { type: 'text', delta: 'ok' };
                yield { type: 'done', stopReason: 'stop', toolCalls: [] };
            }) as unknown as HarnessStream
        );
        const junior = harness({ agents: { lead: brain(scripted([answer('lead done')])), worker: probeAgent }, entry: 'lead', ranks: { lead: 'A', worker: 'B' }, presets: false });
        await junior('go');
        expect((seen[0]?.tools ?? []).map((entry) => entry.name)).not.toContain('delegate');
    });
});

// ---------------------------------------------------------------------------
// PROBE 4b — the depth ceiling with THREE ranks and a HOST-THREAD caller: does the
// thread hop spend a level the rank ladder would have allowed? A run is one level
// below its parent (src/harness.ts:14711 `depth = (parent?.depth ?? 0) + 1`) and a
// host thread's child is a run like any other, so entry thread (1) → B (2) → C (3)
// must fit the 3-distinct-rank ceiling exactly.
// ---------------------------------------------------------------------------
describe('R1 fan-out probe: three nesting levels through host threads', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('lets a delegation issued from inside a host-thread child run at depth 3', async () => {
        const leaf = brain(scripted([answer('leaf facts')]));
        const mid = brain(scripted([delegateTurn([{ id: 'n1', agent: 'leaf', input: 'fetch facts' }]), answer('mid done')]));
        const lead = brain(scripted([delegateTurn([{ id: 'c1', agent: 'mid', input: 'do the work' }]), answer('lead done')]));

        const writer = harness({
            agents: { lead, mid, leaf },
            entry: 'lead',
            ranks: { lead: 'A', mid: 'B', leaf: 'C' },
            presets: false,
            plugins: [{ name: 'async-ping', setup: () => undefined }]
        });

        const parent = writer.createThread('lead');
        const message = await writer.sendThreadInput(parent.id, 'go');

        expect(message.content).toBe('lead done');

        // Depth 1 (host thread) → depth 2 (mid) → depth 3 (leaf): the whole ladder fits,
        // and each hop ran in its OWN host thread. A host-thread child's transcript lives on
        // its THREAD, not on the registry brain (src/harness.ts:14765-14772 selects
        // `runBrain = resolvedThread.agent`), so the results are read through `threadMessages`.
        const parentMessages = writer.threadMessages(parent.id);
        expect(envelopeOf(parentMessages, 'c1')).toMatchObject({ agent: 'mid', content: 'mid done', status: 'completed' });

        const midThread = writer.threads().find((record) => record.agent === 'mid' && record.origin === 'host')!;
        const leafThread = writer.threads().find((record) => record.agent === 'leaf' && record.origin === 'host')!;

        expect(envelopeOf(writer.threadMessages(midThread.id), 'n1')).toMatchObject({
            agent: 'leaf',
            content: 'leaf facts',
            status: 'completed',
            threadId: leafThread.id
        });
        expect([midThread.ownerThreadId, leafThread.ownerThreadId]).toEqual([parent.id, midThread.id]);
    });
});

// ---------------------------------------------------------------------------
// PROBE 5 — the SAME four-delegates-to-ONE-agent fan-out, issued from a HOST
// THREAD (the conversation shape the server's `enqueue` opens for every submit).
// The caller is a host conversation, so each child gets its OWN fresh thread
// (src/harness.ts:14746-14764) instead of the shared standing conversation.
// ---------------------------------------------------------------------------
describe('R1 fan-out probe: the same fan-out from a host thread', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('runs four delegates to ONE agent in four independent threads, concurrently', async () => {
        const gates = new Map<string, Promise<unknown>>();
        const live = new Map<string, { promise: Promise<unknown>; resolve: (value: unknown) => void }>();

        for (const key of ['1', '2', '3', '4']) {
            const gate = deferred<unknown>();
            live.set(key, gate);
            gates.set(key, gate.promise);
        }

        const log: string[] = [];
        const tally = counters();
        const helper = brain(gatedTransportPerBrief(gates, log, tally));
        const instruct = brain(
            scripted([
                delegateTurn(['1', '2', '3', '4'].map((key, index) => ({ id: `c${index}`, agent: 'helper', input: `task ${key}` }))),
                answer('waiting'),
                answer('final')
            ])
        );

        const writer = harness({
            agents: { instruct, helper },
            entry: 'instruct',
            ranks: { instruct: 'A', helper: 'B' },
            presets: false,
            plugins: [{ name: 'async-ping', setup: () => undefined }]
        });

        const parent = writer.createThread('instruct');
        const running = probe(writer.sendThreadInput(parent.id, 'go'));
        await flush();

        // THE DIFFERENTIAL vs probe 2: same fan-out, same target agent, HOST caller →
        // all four generations are open at once.
        expect(log.slice().sort()).toEqual(['open:1', 'open:2', 'open:3', 'open:4']);
        expect(tally.max).toBe(4);
        expect(running.status).toBe('pending');

        for (const key of ['1', '2', '3', '4']) live.get(key)!.resolve(undefined);
        await flush();
        expect(running.status).toBe('resolved');

        // Four DISTINCT host threads, each owned by the caller's thread — no shared
        // transcript, so the answer order cannot leak between siblings.
        const children = writer
            .threads()
            .filter((record) => record.agent === 'helper' && record.origin === 'host')
            .map((record) => record.id)
            .sort();

        expect(children).toEqual(['thread-2', 'thread-3', 'thread-4', 'thread-5']);

        const parentMessages = writer.threadMessages(parent.id);
        expect(['c0', 'c1', 'c2', 'c3'].map((id) => envelopeOf(parentMessages, id).threadId)).toEqual(children);

        // The agent's standing conversation stayed EMPTY — host delegations never fall
        // back into it (contrast probe 2, where all four briefs accumulated there).
        expect(writer.threadMessages('agent:helper')).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// PROBE 6 — is the launch loop itself the hazard? `for (const call of toolCalls)
// { throwIfAborted(run); await launchToolCall(...) }` (src/harness.ts:14208-14213)
// awaits each launch; a launch that had to WAIT for the child would serialize the
// fan-out and could never overlap. Pinned by the child ARRIVAL ORDER: with the
// first child's gate held and calls launched in order c0..c3, all four children
// still arrive, which is only possible if no launch waits.
// ---------------------------------------------------------------------------
describe('R1 fan-out probe: the launch loop does not wait for a child', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('launches all four calls in one turn without awaiting any of them', async () => {
        const gates = fanOutSpecs.map(() => deferred<unknown>());
        const arrivals: string[] = [];
        const tally = counters();

        const children = Object.fromEntries(
            fanOutSpecs.map((spec, index) => [
                spec.agent,
                brain(
                    (async function* stream() {
                        arrivals.push(spec.agent);
                        tally.active += 1;
                        tally.max = Math.max(tally.max, tally.active);

                        await gates[index]!.promise;

                        tally.active -= 1;
                        yield { type: 'text', delta: `${spec.agent} finished` };
                        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                    }) as unknown as HarnessStream
                )
            ])
        );

        // One child deliberately holds its generation open the whole time.
        const seenParent: HarnessStreamRequest[] = [];
        const writerAgent = brain(scripted([delegateTurn(fanOutSpecs), answer('waiting'), answer('final')], seenParent));
        const writer = harness({ agents: { writer: writerAgent, ...children }, presets: false, plugins: [{ name: 'async-ping', setup: () => undefined }] });

        const running = probe(writer('go'));
        await flush();

        expect(arrivals).toEqual(['alpha', 'beta', 'gamma', 'delta']);
        expect(running.status).toBe('pending');

        // Only after the first child is released does the parent re-request, and the
        // request it is then sent carries one placeholder per outstanding brief — the
        // proof that all four calls were live simultaneously inside the parent's own turn.
        const lastRequest = seenParent[seenParent.length - 1]!;

        expect(['c0', 'c1', 'c2', 'c3'].map((id) => requestToolContent(lastRequest, id).status)).toEqual([
            'pending',
            'pending',
            'pending',
            'pending'
        ]);
        expect(new Set(['c0', 'c1', 'c2', 'c3'].map((id) => requestToolContent(lastRequest, id).threadId)).size).toBe(4);

        for (const gate of gates) gate.resolve(undefined);
        await flush();
        expect(running.status).toBe('resolved');
        expect(tally.max).toBe(4);
    });
});

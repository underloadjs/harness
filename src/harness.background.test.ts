// Background tools (R1–R5): one actor stream per agent, tools as CONCURRENT async
// work (never worker threads), and a run that stays open until every call is
// drained. Authored as black-box behaviour through the public package surface —
// no scheduler internals are imported here.
//
// Contract pinned by this file:
//   R1  Every tool call of a turn starts before any of them completes, and the
//       model may take another turn while they are pending (`pending` on `done`,
//       `tool_result`, and the recurring `wakeup` event).
//   R2  A response with no tool calls while work is pending PAUSES the agent: the
//       harness promise stays unresolved until the last call settles, then the
//       model is re-requested with the real outcomes.
//   R3  Every provider request pairs each assistant `tool_calls` with exactly one
//       tool message (placeholders are projection-only; the canonical transcript
//       keeps the actual result at the original call position, in call order, even
//       when results arrive out of order).
//   R4  One model stream per agent at a time; `agentDelegate` stays pending while
//       the child runs, the parent stays free, same-agent followups are queued with
//       the child's transcript preserved, and only the primary sees delegation.
//       `toolCancel({callId})` releases one call, siblings continue, and a late
//       settlement of an uncooperative tool changes nothing.
//   R5  The recurring wake is 600000 ms by default, reports elapsed pending time,
//       repeats, and its timer is gone once the run is drained. Whole-run cancel
//       rolls back every actor, aborts children, and leaves the harness reusable.
//       A thrown/rejected tool is recoverable data; `maxIterations` still bounds a
//       run and its pending state is cleaned up on the rollback path.
//
// Clock policy: fake timers own the clock in every test. Tool promises are settled
// explicitly, so each `durationMs`/`elapsedMs` below is an exact number rather than
// a wall-clock approximation, and `getTimerCount()` can prove timer cleanup.
//
// ALIGNMENT NOTE (runtime was mid-implementation when this file was authored):
//   1. A paused (no tool calls, work pending) assistant message is expected to be
//      COMMITTED to the canonical transcript, exactly like a tool-call turn, and
//      the request projection is expected to insert placeholders ahead of it. If
//      the runtime treats a pause as provisional instead, the transcript
//      expectations in tests 1, 2, and 4 need that single decision flipped.
//   2. Placeholder tool-message CONTENT is not part of the published contract, so
//      it is asserted as "a string" and never by wording.
//   3. A cancelled call is expected to be delivered as an `isError: true` result
//      with outcome 'cancelled' (error-shaped for the provider, but a control
//      outcome); only its ids/flag/outcome are pinned, its text is implementation-
//      chosen. Cancelling an already settled call is a successful result with
//      `alreadySettled: true` and changes nothing (R2).
//   4. `toolCancel` is expected to be declared only while the calling agent has a
//      pending call (metadata.ts documents exactly that), so it is checked as a
//      declared name on pending requests and absent on the first request.
//   5. `maxIterations` is expected to count MODEL REQUESTS, so a turn taken while
//      tools are pending consumes one round. If the runtime counts only settled
//      tool rounds, the exhaustion test needs its bound re-derived.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type {
    HarnessEvent,
    HarnessMessage,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest,
    HarnessToolCall
} from '@underload/harness';

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

type WakeupEvent = Extract<HarnessEvent, { type: 'wakeup' }>;
type ToolResultEvent = Extract<HarnessEvent, { type: 'tool_result' }>;
type DoneEvent = Extract<HarnessEvent, { type: 'done' }>;

// What a stub transport recorded for one request. Deep copies, because the
// harness may keep appending to its live transcript after the request.
type SeenRequest = {
    messages: HarnessMessage[];
    toolNames: string[];
};

// Concurrency probe: a second overlapping turn on the SAME agent would push
// `active` above one, which the R4 tests refuse.
type Guard = { active: number; max: number };

type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
    readonly settled: boolean;
};

type RunState<T> = {
    status: 'pending' | 'resolved' | 'rejected';
    value?: T;
    error?: unknown;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const copyMessages = (messages: HarnessMessage[]): HarnessMessage[] =>
    JSON.parse(JSON.stringify(messages)) as HarnessMessage[];

const capture = (request: HarnessStreamRequest): SeenRequest => ({
    messages: copyMessages(request.messages),
    toolNames: (request.tools ?? []).map((declaration) => declaration.name)
});

// A compact, exact view of a transcript: roles plus ids/content, so a placement
// bug (a result appended late, or a placeholder persisted) is readable in the
// failure message instead of buried in a deep object diff.
const shape = (messages: HarnessMessage[]): string[] =>
    messages.map((message) => {
        if (message.role === 'tool') return `tool:${message.toolCallId}:${message.content}`;
        if (message.role === 'assistant') {
            const ids = (message.toolCalls ?? []).map((entry) => entry.id).join('|');
            return `assistant:${message.content}:${ids}`;
        }
        return `${message.role}:${message.content}`;
    });

// Drain the harness's promise chain WITHOUT moving the clock. Fake timers own
// time, so a plain `await Promise.resolve()` is not enough; several zero-advance
// passes let a launch → re-request → pause chain run to its resting point.
const flush = async (): Promise<void> => {
    for (let pass = 0; pass < 8; pass += 1) {
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
    }
};

// Move the clock by an exact amount, then let the resulting work settle. Every
// elapsed/duration assertion in this file depends on this being the only way time
// moves.
const advance = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
    await flush();
};

const deferred = <T>(): Deferred<T> => {
    let settleResolve!: (value: T) => void;
    let settleReject!: (reason: unknown) => void;
    let settled = false;

    const promise = new Promise<T>((resolve, reject) => {
        settleResolve = (value: T) => {
            settled = true;
            resolve(value);
        };
        settleReject = (reason: unknown) => {
            settled = true;
            reject(reason);
        };
    });

    return {
        promise,
        resolve: settleResolve,
        reject: settleReject,
        get settled() {
            return settled;
        }
    };
};

// Attach handlers immediately so a rejection never becomes unhandled, and expose
// the settled state so a test can prove a paused run is still open.
const probe = <T>(promise: Promise<T>): RunState<T> => {
    const state: RunState<T> = { status: 'pending' };
    promise.then(
        (value) => {
            state.status = 'resolved';
            state.value = value;
        },
        (error: unknown) => {
            state.status = 'rejected';
            state.error = error;
        }
    );
    return state;
};

const call = (id: string, name: string, args: string): HarnessToolCall => ({
    id,
    name,
    arguments: args
});

// A final answer: text then a stop frame with no tool calls.
const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

// One tool-call turn.
const calls = (...requested: HarnessToolCall[]): HarnessStreamEvent[] => [
    { type: 'done', stopReason: 'tool_calls', toolCalls: requested }
];

// A transport whose Nth request is chosen by `decide`. The yield boundary plus
// the guard is what makes an illegal overlapping turn observable.
const streamFrom = (
    decide: (turn: number, request: HarnessStreamRequest) => HarnessStreamEvent[],
    seen: SeenRequest[],
    guard?: Guard
): HarnessStream => {
    let turn = 0;

    return async function* stream(request) {
        const index = turn;
        turn += 1;
        seen.push(capture(request));

        if (guard) {
            guard.active += 1;
            guard.max = Math.max(guard.max, guard.active);
        }

        try {
            // A real await before the frames: a second concurrent turn on this
            // agent would then actually overlap here instead of being masked.
            await Promise.resolve();
            for (const frame of decide(index, request)) {
                yield frame;
            }
        } finally {
            if (guard) guard.active -= 1;
        }
    };
};

// A tool that reports its start and then stays pending until the test settles it.
const gatedTool = (name: string, gate: Deferred<string>, log: string[] = []) =>
    tool<string, string>({
        description: `Gated test tool ${name}.`,
        tags: ['test'],
        // Core, so the model sees it without a discovery round.
        visibility: 'core',
        parameters: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false
        },
        execute: ({ parameters }) => {
            log.push(`${name}:start:${parameters}`);
            return gate.promise;
        }
    });

// A cooperative background tool: its promise rejects when the CALL's signal
// aborts. The run-level abort reaches it through the per-call controller, which
// is what makes a whole-run cancel settle deterministically.
const abortableTool = (name: string, log: string[]) => {
    const gate = deferred<string>();
    let observed: AbortSignal | undefined;

    const definition = tool<string, string>({
        description: `Abortable test tool ${name}.`,
        tags: ['test'],
        visibility: 'core',
        parameters: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false
        },
        execute: ({ parameters, signal }) => {
            log.push(`${name}:start:${parameters}`);
            observed = signal;
            const abort = (): void => gate.reject(signal?.reason ?? new Error(`${name} aborted`));
            if (signal?.aborted === true) abort();
            else signal?.addEventListener('abort', abort, { once: true });
            return gate.promise;
        }
    });

    return { definition, gate, observedSignal: () => observed };
};

// A tool that deliberately ignores its abort signal: the harness must still
// release it logically and discard the late answer.
const stubbornTool = (name: string) => {
    const gate = deferred<string>();
    let observed: AbortSignal | undefined;

    const definition = tool<string, string>({
        description: `Uncooperative test tool ${name}.`,
        tags: ['test'],
        visibility: 'core',
        parameters: {
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false
        },
        execute: ({ signal }) => {
            observed = signal;
            return gate.promise;
        }
    });

    return { definition, gate, observedSignal: () => observed };
};

const wakeupsOf = (events: HarnessEvent[]): WakeupEvent[] =>
    events.filter((event): event is WakeupEvent => event.type === 'wakeup');

const resultsOf = (events: HarnessEvent[], name: string): ToolResultEvent[] =>
    events.filter(
        (event): event is ToolResultEvent => event.type === 'tool_result' && event.name === name
    );

const donesOf = (events: HarnessEvent[]): DoneEvent[] =>
    events.filter((event): event is DoneEvent => event.type === 'done');

const toolMessages = (messages: HarnessMessage[]): { toolCallId: string; name: string; content: string }[] =>
    messages
        .filter((message): message is Extract<HarnessMessage, { role: 'tool' }> => message.role === 'tool')
        .map((message) => ({
            toolCallId: message.toolCallId,
            name: message.name,
            content: message.content
        }));

// Strict wire pairing (R3): after every assistant message that requests tools,
// the next messages must be exactly one tool message per call, in call order and
// with no other role in between. Every tool message must belong to such a run —
// an orphan (a result appended late, or a duplicate) is a violation. Returns
// human-readable problems so a test can assert the aggregate is exactly empty.
const wireIssues = (seen: SeenRequest[]): string[] => {
    const issues: string[] = [];

    seen.forEach((request, requestIndex) => {
        const claimed = new Set<number>();

        request.messages.forEach((message, index) => {
            if (message.role !== 'assistant') return;
            const requested = message.toolCalls ?? [];
            if (requested.length === 0) return;

            const expected = requested.map((entry) => entry.id);
            const actual: string[] = [];
            let cursor = index + 1;

            while (cursor < request.messages.length && request.messages[cursor].role === 'tool') {
                const toolMessage = request.messages[cursor] as Extract<HarnessMessage, { role: 'tool' }>;
                actual.push(toolMessage.toolCallId);
                claimed.add(cursor);
                cursor += 1;
            }

            if (actual.join(',') !== expected.join(',')) {
                issues.push(
                    `request ${requestIndex} assistant#${index}: expected [${expected.join(',')}] but paired [${actual.join(',')}]`
                );
            }
        });

        request.messages.forEach((message, index) => {
            if (message.role !== 'tool') return;
            if (claimed.has(index)) return;
            const toolMessage = message as Extract<HarnessMessage, { role: 'tool' }>;
            issues.push(`request ${requestIndex} orphan tool#${index}: ${toolMessage.toolCallId}`);
        });
    });

    return issues;
};

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// R1/R2/R3 — concurrent launch, pending visibility, pause and resume
// ---------------------------------------------------------------------------

describe('background tool calls', () => {
    it('starts every call before any completes, answers while pending, and resumes on each completion', async () => {
        const alphaGate = deferred<string>();
        const betaGate = deferred<string>();
        const started: string[] = [];
        const seen: SeenRequest[] = [];
        const events: HarnessEvent[] = [];
        const guard: Guard = { active: 0, max: 0 };

        const writer = harness({
            agents: {
                writer: agent({
                    model: 'test/model',
                    stream: streamFrom(
                        (turn) => {
                            if (turn === 0) {
                                return calls(
                                    call('a1', 'alpha', '{"value":"A"}'),
                                    call('b1', 'beta', '{"value":"B"}')
                                );
                            }
                            if (turn === 1) return answer('waiting on both');
                            if (turn === 2) return answer('waiting on beta');
                            return answer('all tools finished');
                        },
                        seen,
                        guard
                    )
                })
            },
            tools: {
                alpha: gatedTool('alpha', alphaGate, started),
                beta: gatedTool('beta', betaGate, started)
            },
            presets: false,
            report: {
                progress: (event) => {
                    events.push(event);
                }
            }
        });

        const state = probe(writer('go'));
        await flush();

        // R1: both implementations entered, and neither had to finish first.
        expect(started).toEqual(['alpha:start:A', 'beta:start:B']);
        expect(alphaGate.settled).toBe(false);
        expect(betaGate.settled).toBe(false);
        expect(guard.max).toBe(1);

        // R2: the model took a second turn while both were pending, and that
        // response did not finish the run.
        expect(seen).toHaveLength(2);
        expect(state.status).toBe('pending');
        // The FIRST request predates the response it triggers, so it carries the
        // prompt only. The tool-call assistant block is the RESPONSE to it and is
        // visible from the second request onward (asserted just below).
        expect(seen[0].messages).toEqual([{ role: 'user', content: 'go' }]);
        // R3: the projection answers both calls, in call order, before the pause.
        expect(seen[1].messages).toEqual([
            { role: 'user', content: 'go' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'a1', name: 'alpha', arguments: '{"value":"A"}' },
                    { id: 'b1', name: 'beta', arguments: '{"value":"B"}' }
                ]
            },
            { role: 'tool', content: expect.any(String), toolCallId: 'a1', name: 'alpha' },
            { role: 'tool', content: expect.any(String), toolCallId: 'b1', name: 'beta' }
        ]);
        expect(seen[0].toolNames).toEqual([
            'toolRegistry',
            'toolRequest',
            'toolCreate',
            'todoManage',
            'profileManage',
            'chapterManage',
            'locationManage',
            'agentManage',
            'agentResult',
            'threadFork',
            'alpha',
            'beta'
        ]);

        // R4: the pause is reported as a done with the pending list, and the wake
        // timer has not fired at t=0.
        expect(donesOf(events)).toEqual([
            {
                type: 'done',
                agent: 'writer',
                message: expect.objectContaining({ content: 'waiting on both', toolCalls: [] }),
                pending: [
                    { callId: 'a1', name: 'alpha', elapsedMs: 0 },
                    { callId: 'b1', name: 'beta', elapsedMs: 0 }
                ]
            }
        ]);
        expect(wakeupsOf(events)).toEqual([]);

        // First completion: the real result lands at the original call position,
        // beta is still pending, and the run is still open.
        await advance(1500);
        alphaGate.resolve('A-done');
        await flush();

        expect(state.status).toBe('pending');
        expect(seen).toHaveLength(3);
        expect(seen[2].messages).toEqual([
            { role: 'user', content: 'go' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'a1', name: 'alpha', arguments: '{"value":"A"}' },
                    { id: 'b1', name: 'beta', arguments: '{"value":"B"}' }
                ]
            },
            { role: 'tool', content: 'A-done', toolCallId: 'a1', name: 'alpha' },
            { role: 'tool', content: expect.any(String), toolCallId: 'b1', name: 'beta' },
            { role: 'assistant', content: 'waiting on both' }
        ]);
        expect(resultsOf(events, 'alpha')).toEqual([
            {
                type: 'tool_result',
                agent: 'writer',
                name: 'alpha',
                callId: 'a1',
                content: 'A-done',
                isError: false,
                outcome: 'completed',
                durationMs: 1500,
                pending: [{ callId: 'b1', name: 'beta', elapsedMs: 1500 }]
            }
        ]);

        // Second completion drains the run.
        betaGate.resolve('B-done');
        await flush();

        expect(state.status).toBe('resolved');
        expect(state.value).toEqual({
            role: 'assistant',
            content: 'all tools finished',
            reasoning: '',
            toolCalls: [],
            model: 'test/model',
            stopReason: 'stop'
        });

        // R3: the canonical transcript keeps real results only, paired with their
        // own call; placeholders were projection-only.
        expect(shape(writer.agent.messages)).toEqual([
            'user:go',
            'assistant::a1|b1',
            'tool:a1:A-done',
            'tool:b1:B-done',
            'assistant:waiting on both:',
            'assistant:waiting on beta:',
            'assistant:all tools finished:'
        ]);
        expect(resultsOf(events, 'beta')).toEqual([
            {
                type: 'tool_result',
                agent: 'writer',
                name: 'beta',
                callId: 'b1',
                content: 'B-done',
                isError: false,
                outcome: 'completed',
                durationMs: 1500
            }
        ]);

        // R4: one stream per agent, and no timer survives a drained board.
        expect(guard.max).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
        expect(wireIssues(seen)).toEqual([]);
    });

    it('keeps call positions when results arrive out of order and coalesces completions without loss', async () => {
        const alphaGate = deferred<string>();
        const betaGate = deferred<string>();
        const gammaGate = deferred<string>();
        const started: string[] = [];
        const seen: SeenRequest[] = [];
        const events: HarnessEvent[] = [];
        const guard: Guard = { active: 0, max: 0 };

        const writer = harness({
            agents: {
                writer: agent({
                    model: 'test/model',
                    stream: streamFrom(
                        (turn, request) => {
                            if (turn === 0) {
                                return calls(
                                    call('a1', 'alpha', '{"value":"A"}'),
                                    call('b1', 'beta', '{"value":"B"}')
                                );
                            }
                            // A second tool round is legal while `alpha` and `beta`
                            // are still pending.
                            if (turn === 1) return calls(call('g1', 'gamma', '{"value":"G"}'));

                            // Once every real outcome is visible the model answers;
                            // before that each response is a pause.
                            const settled = new Set(
                                request.messages
                                    .filter((message) => message.role === 'tool')
                                    .map((message) => (message as { content: string }).content)
                            );
                            if (
                                settled.has('A-done') &&
                                settled.has('B-done') &&
                                settled.has('G-done')
                            ) {
                                return answer('everything settled');
                            }
                            return answer(`waiting-${turn}`);
                        },
                        seen,
                        guard
                    )
                })
            },
            tools: {
                alpha: gatedTool('alpha', alphaGate, started),
                beta: gatedTool('beta', betaGate, started),
                gamma: gatedTool('gamma', gammaGate, started)
            },
            presets: false,
            report: {
                progress: (event) => {
                    events.push(event);
                }
            }
        });

        const state = probe(writer('go'));
        await flush();

        // t=0: the launch turn, the extra tool round while pending, and the pause
        // that follows it.
        expect(started).toEqual(['alpha:start:A', 'beta:start:B', 'gamma:start:G']);
        expect(seen).toHaveLength(3);
        expect(state.status).toBe('pending');
        expect(toolMessages(seen[2].messages)).toEqual([
            { toolCallId: 'a1', name: 'alpha', content: expect.any(String) },
            { toolCallId: 'b1', name: 'beta', content: expect.any(String) },
            { toolCallId: 'g1', name: 'gamma', content: expect.any(String) }
        ]);

        // beta settles FIRST, at t=1000, while alpha and gamma are still running.
        await advance(1000);
        betaGate.resolve('B-done');
        await flush();

        expect(state.status).toBe('pending');
        expect(seen).toHaveLength(4);
        // The settled result keeps beta's call slot; the placeholders for alpha and
        // gamma keep theirs. Pairing is call order, never completion order.
        expect(toolMessages(seen[3].messages)).toEqual([
            { toolCallId: 'a1', name: 'alpha', content: expect.any(String) },
            { toolCallId: 'b1', name: 'beta', content: 'B-done' },
            { toolCallId: 'g1', name: 'gamma', content: expect.any(String) }
        ]);
        expect(resultsOf(events, 'beta')[0]).toEqual({
            type: 'tool_result',
            agent: 'writer',
            name: 'beta',
            callId: 'b1',
            content: 'B-done',
            isError: false,
            outcome: 'completed',
            durationMs: 1000,
            pending: [
                { callId: 'a1', name: 'alpha', elapsedMs: 1000 },
                { callId: 'g1', name: 'gamma', elapsedMs: 1000 }
            ]
        });

        // Both remaining calls settle in the SAME tick: one coalesced wake delivers
        // both outcomes — nothing is lost and no extra request is made.
        await advance(1000);
        alphaGate.resolve('A-done');
        gammaGate.resolve('G-done');
        await flush();

        expect(state.status).toBe('resolved');
        expect(state.value?.content).toBe('everything settled');
        expect(seen).toHaveLength(5);
        expect(toolMessages(seen[4].messages)).toEqual([
            { toolCallId: 'a1', name: 'alpha', content: 'A-done' },
            { toolCallId: 'b1', name: 'beta', content: 'B-done' },
            { toolCallId: 'g1', name: 'gamma', content: 'G-done' }
        ]);
        // Delivery order between two simultaneous completions decides which one's
        // `pending` field is already empty, so only the outcome is pinned here;
        // "no loss" is proven by both results appearing in the next request.
        expect(resultsOf(events, 'alpha')).toMatchObject([
            {
                type: 'tool_result',
                agent: 'writer',
                name: 'alpha',
                callId: 'a1',
                content: 'A-done',
                isError: false,
                outcome: 'completed',
                durationMs: 2000
            }
        ]);
        expect(resultsOf(events, 'gamma')).toMatchObject([
            {
                type: 'tool_result',
                agent: 'writer',
                name: 'gamma',
                callId: 'g1',
                content: 'G-done',
                isError: false,
                outcome: 'completed',
                durationMs: 2000
            }
        ]);

        // R3: canonical placement is call order for every call, whatever order the
        // promises settled in; placeholders never entered the transcript.
        expect(shape(writer.agent.messages)).toEqual([
            'user:go',
            'assistant::a1|b1',
            'tool:a1:A-done',
            'tool:b1:B-done',
            'assistant::g1',
            'tool:g1:G-done',
            'assistant:waiting-2:',
            'assistant:waiting-3:',
            'assistant:everything settled:'
        ]);
        expect(wireIssues(seen)).toEqual([]);
        expect(guard.max).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// R5 — recurring wake, elapsed reporting, timer cleanup
// ---------------------------------------------------------------------------

describe('recurring wakeup', () => {
    it('fires at 600000ms, repeats, reports elapsed pending time, and clears its timer', async () => {
        const alphaGate = deferred<string>();
        const betaGate = deferred<string>();
        const started: string[] = [];
        const seen: SeenRequest[] = [];
        const events: HarnessEvent[] = [];

        const writer = harness({
            agents: {
                writer: agent({
                    model: 'test/model',
                    // After the launch turn every request is a pause: nothing else
                    // is scripted, so the wake itself is the only thing that can
                    // produce a new request.
                    stream: streamFrom(
                        (turn) =>
                            turn === 0
                                ? calls(
                                      call('a1', 'slowAlpha', '{"value":"A"}'),
                                      call('b1', 'slowBeta', '{"value":"B"}')
                                  )
                                : answer(`waiting-${turn}`),
                        seen
                    )
                })
            },
            tools: {
                slowAlpha: gatedTool('slowAlpha', alphaGate, started),
                slowBeta: gatedTool('slowBeta', betaGate, started)
            },
            presets: false,
            report: {
                progress: (event) => {
                    events.push(event);
                }
            }
        });

        const state = probe(writer('go'));
        await flush();

        // 599999ms is not a tick yet.
        await advance(599_999);
        expect(wakeupsOf(events)).toEqual([]);
        expect(state.status).toBe('pending');

        // Exactly 600000ms: one wake carrying both calls and their elapsed time.
        await advance(1);
        expect(wakeupsOf(events)).toEqual([
            {
                type: 'wakeup',
                agent: 'writer',
                reason: 'pending-tools',
                pending: [
                    { callId: 'a1', name: 'slowAlpha', elapsedMs: 600_000 },
                    { callId: 'b1', name: 'slowBeta', elapsedMs: 600_000 }
                ]
            }
        ]);

        // Repeating: the next interval reports the doubled elapsed time.
        await advance(600_000);
        expect(wakeupsOf(events)).toEqual([
            {
                type: 'wakeup',
                agent: 'writer',
                reason: 'pending-tools',
                pending: [
                    { callId: 'a1', name: 'slowAlpha', elapsedMs: 600_000 },
                    { callId: 'b1', name: 'slowBeta', elapsedMs: 600_000 }
                ]
            },
            {
                type: 'wakeup',
                agent: 'writer',
                reason: 'pending-tools',
                pending: [
                    { callId: 'a1', name: 'slowAlpha', elapsedMs: 1_200_000 },
                    { callId: 'b1', name: 'slowBeta', elapsedMs: 1_200_000 }
                ]
            }
        ]);
        expect(state.status).toBe('pending');

        // Draining the board resolves the run, reports the full lifetime, and
        // leaves no timer behind.
        alphaGate.resolve('A-done');
        betaGate.resolve('B-done');
        await flush();

        expect(state.status).toBe('resolved');
        expect(state.value?.content).toBe(`waiting-${seen.length - 1}`);
        // The two calls settle together, so which result already sees the other as
        // drained is delivery-order dependent; the lifetime is not.
        expect(resultsOf(events, 'slowAlpha')).toMatchObject([
            {
                type: 'tool_result',
                agent: 'writer',
                name: 'slowAlpha',
                callId: 'a1',
                content: 'A-done',
                isError: false,
                outcome: 'completed',
                durationMs: 1_200_000
            }
        ]);
        expect(wakeupsOf(events)).toHaveLength(2);
        expect(vi.getTimerCount()).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// R4 — delegation: independent child, free parent, queued followup
// ---------------------------------------------------------------------------

describe('delegation under background tools', () => {
    it('keeps the parent free while a child runs, queues same-agent followups, and preserves transcripts', async () => {
        const slowGate = deferred<string>();
        const parentSeen: SeenRequest[] = [];
        const childSeen: SeenRequest[] = [];
        const parentGuard: Guard = { active: 0, max: 0 };
        const childGuard: Guard = { active: 0, max: 0 };
        let queuedWhileChildPending = false;

        const researcher = agent({
            model: 'test/child',
            stream: streamFrom(
                (turn, request) => {
                    const childMessages = request.messages;
                    const hasSlowCall = childMessages.some(
                        (message) =>
                            message.role === 'assistant' &&
                            (message.toolCalls ?? []).some((entry) => entry.id === 's1')
                    );
                    // A placeholder is indistinguishable from `{role:'tool'}` alone,
                    // so state is read from the REAL result content.
                    const hasSlowResult = childMessages.some(
                        (message) => message.role === 'tool' && message.content === 'slow-done'
                    );
                    const lastUser = [...childMessages]
                        .reverse()
                        .find((message) => message.role === 'user');

                    if (turn === 0) return calls(call('s1', 'slow', '{"value":"x"}'));
                    if (!hasSlowCall) return calls(call('s1', 'slow', '{"value":"x"}'));
                    if (!hasSlowResult) return answer('child-one-waiting');
                    if (lastUser?.content === 'one') return answer('child-one');
                    return answer('child-two');
                },
                childSeen,
                childGuard
            )
        });

        const writer = harness({
            agents: {
                writer: agent({
                    model: 'test/parent',
                    stream: streamFrom(
                        (turn, request) => {
                            if (turn === 0) {
                                return calls(
                                    call('d1', 'agentDelegate', '{"agent":"researcher","input":"one"}')
                                );
                            }

                            // Real delegate results are recognizable by their
                            // published envelope; a placeholder is not.
                            const settled = request.messages.filter(
                                (message) =>
                                    message.role === 'tool' &&
                                    (message.toolCallId === 'd1' || message.toolCallId === 'd2') &&
                                    message.content.startsWith('{"agent":"researcher"')
                            ).length;

                            // R4: the parent is free while the child is still
                            // running, so its very next turn can queue another
                            // followup to the same agent.
                            const queued = request.messages.some(
                                (message) =>
                                    message.role === 'assistant' &&
                                    (message.toolCalls ?? []).some((entry) => entry.id === 'd2')
                            );
                            if (!queued && settled === 0) {
                                queuedWhileChildPending = !slowGate.settled;
                                return calls(
                                    call('d2', 'agentDelegate', '{"agent":"researcher","input":"two"}')
                                );
                            }

                            if (settled === 0) return answer('parent waiting on first delegate');
                            if (settled === 1) return answer('parent waiting on second delegate');
                            return answer('parent-done');
                        },
                        parentSeen,
                        parentGuard
                    )
                }),
                researcher
            },
            // The child's only call must be a REGISTERED tool that stays pending;
            // otherwise the runtime answers the unknown name as an immediate error
            // result, the child finishes on its first turn, and the parent is never
            // exercised while delegation is in flight.
            tools: { slow: gatedTool('slow', slowGate) },
            primary: 'writer',
            subagents: ['researcher'],
            presets: false
        });

        const state = probe(writer('go'));
        await flush();

        // Parent free: it queued the followup while the child's tool was running.
        expect(queuedWhileChildPending).toBe(true);
        expect(parentSeen).toHaveLength(3);
        expect(parentSeen[1].messages).toEqual([
            { role: 'user', content: 'go' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'd1', name: 'agentDelegate', arguments: '{"agent":"researcher","input":"one"}' }
                ]
            },
            { role: 'tool', content: expect.any(String), toolCallId: 'd1', name: 'agentDelegate' }
        ]);
        // Allowlist/depth: a subagent never sees the delegation control.
        expect(childSeen[0].toolNames.filter((name) => name === 'agentDelegate')).toEqual([]);
        expect(state.status).toBe('pending');

        // The child's own tool completes; its first run answers, which settles d1.
        slowGate.resolve('slow-done');
        await flush();
        await flush();

        // The queued followup runs against the child's PRESERVED transcript.
        expect(childSeen).toHaveLength(4);
        expect(shape(childSeen[3].messages)).toEqual([
            'user:one',
            'assistant::s1',
            'tool:s1:slow-done',
            'assistant:child-one-waiting:',
            'assistant:child-one:',
            'user:two'
        ]);

        expect(state.status).toBe('resolved');
        expect(state.value?.content).toBe('parent-done');

        // Only answers cross back, at the original call positions.
        expect(
            toolMessages(writer.agent.messages).filter(
                (message) => message.toolCallId === 'd1' || message.toolCallId === 'd2'
            )
        ).toEqual([
            {
                toolCallId: 'd1',
                name: 'agentDelegate',
                content: '{"agent":"researcher","content":"child-one"}'
            },
            {
                toolCallId: 'd2',
                name: 'agentDelegate',
                content: '{"agent":"researcher","content":"child-two"}'
            }
        ]);
        expect(wireIssues(parentSeen)).toEqual([]);
        expect(wireIssues(childSeen)).toEqual([]);
        expect(parentGuard.max).toBe(1);
        expect(childGuard.max).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// T2/R1 — delegated answer extraction
// ---------------------------------------------------------------------------
//
// A delegated child can show a substantive answer and then, after a pending
// completion re-prompts it, take a final turn that is a NORMAL `stop` with
// whitespace-only text ("\n"). The delegate result must be the last substantive
// tool-free answer of THAT run. The regression is exercised through real pending
// work (a gated tool), never by assuming a particular turn index alone: the
// child answers while the call is in flight, which is exactly the state the
// reported session was in.

describe('delegated answer extraction', () => {
    // A child whose call stays pending, then answers for real, then stops blank.
    const gatedChild = (gate: Deferred<string>, facts: string, final: HarnessStreamEvent[]) =>
        agent({
            model: 'test/child',
            stream: streamFrom((turn) => {
                if (turn === 0) return calls(call('s1', 'slow', '{"value":"x"}'));
                if (turn === 1) return answer(facts);
                return final;
            }, [])
        });

    const parent = () =>
        agent({
            model: 'test/parent',
            stream: streamFrom((turn) =>
                turn === 0
                    ? calls(
                          call(
                              'd1',
                              'agentDelegate',
                              '{"agent":"researcher","input":"find facts"}'
                          )
                      )
                    : answer('parent-done'),
                []
            )
        });

    it('returns the last substantive child answer when the final turn is whitespace-only', async () => {
        const slowGate = deferred<string>();
        const events: HarnessEvent[] = [];
        const researcher = gatedChild(slowGate, 'the researched facts', answer('\n'));

        const writer = harness({
            agents: { writer: parent(), researcher },
            tools: { slow: gatedTool('slow', slowGate) },
            primary: 'writer',
            subagents: ['researcher'],
            presets: false,
            report: {
                progress: (event) => {
                    events.push(event);
                }
            }
        });

        const state = probe(writer('go'));
        await flush();

        // The child is paused on a REAL answer while its own call is pending:
        // this is the visible answer the reported session stopped on.
        expect(researcher.messages).toEqual([
            { role: 'user', content: 'find facts' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 's1', name: 'slow', arguments: '{"value":"x"}' }]
            },
            { role: 'assistant', content: 'the researched facts' }
        ]);
        expect(state.status).toBe('pending');

        slowGate.resolve('slow-done');
        await flush();

        expect(state.status).toBe('resolved');
        expect(state.value?.content).toBe('parent-done');

        // Only the answer crosses back — the substantive one, not the blank
        // terminal turn.
        expect(toolMessages(writer.agent.messages)).toEqual([
            {
                toolCallId: 'd1',
                name: 'agentDelegate',
                content: '{"agent":"researcher","content":"the researched facts"}'
            }
        ]);

        // The child's own transcript keeps the literal final turn: extraction
        // changes the DELEGATE RESULT, never history.
        expect(researcher.messages.at(-1)).toEqual({ role: 'assistant', content: '\n' });

        // Streaming is untouched: the substantive text was emitted as a delta,
        // and the blank terminal turn still streamed its own text.
        expect(
            events
                .filter(
                    (event): event is Extract<HarnessEvent, { type: 'text' }> =>
                        event.type === 'text' && event.agent === 'researcher'
                )
                .map((event) => event.delta)
        ).toEqual(['the researched facts', '\n']);

        expect(vi.getTimerCount()).toBe(0);
    });

    it('lets a genuinely later non-blank answer win', async () => {
        const slowGate = deferred<string>();
        const researcher = gatedChild(slowGate, 'the researched facts', answer('final facts'));

        const writer = harness({
            agents: { writer: parent(), researcher },
            tools: { slow: gatedTool('slow', slowGate) },
            primary: 'writer',
            subagents: ['researcher'],
            presets: false
        });

        const state = probe(writer('go'));
        await flush();
        slowGate.resolve('slow-done');
        await flush();

        expect(state.value?.content).toBe('parent-done');
        expect(toolMessages(writer.agent.messages)).toEqual([
            {
                toolCallId: 'd1',
                name: 'agentDelegate',
                content: '{"agent":"researcher","content":"final facts"}'
            }
        ]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('extracts the answer for a manual executeTool delegation too', async () => {
        const slowGate = deferred<string>();
        const researcher = gatedChild(slowGate, 'manual facts', answer('\n'));

        const writer = harness({
            agents: {
                lead: agent({ model: 'test/lead', stream: streamFrom(() => answer('lead'), []) }),
                researcher
            },
            primary: 'lead',
            subagents: ['researcher'],
            tools: { slow: gatedTool('slow', slowGate) },
            presets: false
        });

        const state = probe(
            writer.executeTool('agentDelegate', { agent: 'researcher', input: 'find facts' })
        );
        await flush();
        expect(state.status).toBe('pending');

        slowGate.resolve('slow-done');
        await flush();

        expect(state.status).toBe('resolved');
        expect(state.value).toEqual({ agent: 'researcher', content: 'manual facts' });

        // A manual delegation is still not a conversation turn on the caller.
        expect(writer.agent.messages).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not rescue a length-truncated final turn', async () => {
        const slowGate = deferred<string>();
        const truncated: HarnessStreamEvent[] = [
            { type: 'text', delta: '\n' },
            { type: 'done', stopReason: 'length', toolCalls: [] }
        ];
        const researcher = gatedChild(slowGate, 'the researched facts', truncated);

        const writer = harness({
            agents: {
                lead: agent({ model: 'test/lead', stream: streamFrom(() => answer('lead'), []) }),
                researcher
            },
            primary: 'lead',
            subagents: ['researcher'],
            tools: { slow: gatedTool('slow', slowGate) },
            presets: false
        });

        const state = probe(
            writer.executeTool('agentDelegate', { agent: 'researcher', input: 'find facts' })
        );
        await flush();
        slowGate.resolve('slow-done');
        await flush();

        // A truncation is a fact about the final turn, not a blank answer to
        // repair: the earlier text is NOT substituted.
        expect(state.value).toEqual({ agent: 'researcher', content: '\n' });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('leaves an ordinary ctx.run return untouched', async () => {
        const slowGate = deferred<string>();
        const researcher = gatedChild(slowGate, 'helper facts', answer('\n'));

        // ctx.run is the generic sibling-agent call, not delegation: it must keep
        // the literal final turn (T2/R2 — no broad semantic change).
        const ask = tool({
            description: 'Ask the researcher and return its raw answer.',
            tags: ['test'],
            visibility: 'core',
            execute: async ({ run }) => (await run!('researcher', 'find facts')).content
        });

        const writer = harness({
            agents: {
                writer: agent({
                    model: 'test/parent',
                    stream: streamFrom(
                        (turn) => (turn === 0 ? calls(call('q1', 'ask', '{}')) : answer('parent-done')),
                        []
                    )
                }),
                researcher
            },
            tools: { slow: gatedTool('slow', slowGate), ask },
            primary: 'writer',
            subagents: ['researcher'],
            presets: false
        });

        const state = probe(writer('go'));
        await flush();
        slowGate.resolve('slow-done');
        await flush();

        expect(state.value?.content).toBe('parent-done');
        expect(toolMessages(writer.agent.messages)).toEqual([
            { toolCallId: 'q1', name: 'ask', content: '\n' }
        ]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not carry an answer into a later run of the same agent', async () => {
        const slowGate = deferred<string>();

        // Turns 0-2 belong to the first delegated run, turn 3 to the second. The
        // second run never became substantive, so it must stay genuinely blank
        // even though the SAME agent answered in the previous run.
        const seen: SeenRequest[] = [];
        const researcher = agent({
            model: 'test/child',
            stream: streamFrom((turn) => {
                if (turn === 0) return calls(call('s1', 'slow', '{"value":"x"}'));
                if (turn === 1) return answer('first facts');
                return answer('\n');
            }, seen)
        });

        const writer = harness({
            agents: {
                lead: agent({ model: 'test/lead', stream: streamFrom(() => answer('lead'), []) }),
                researcher
            },
            primary: 'lead',
            subagents: ['researcher'],
            tools: { slow: gatedTool('slow', slowGate) },
            presets: false
        });

        const first = probe(
            writer.executeTool('agentDelegate', { agent: 'researcher', input: 'find facts' })
        );
        await flush();
        slowGate.resolve('slow-done');
        await flush();

        expect(first.value).toEqual({ agent: 'researcher', content: 'first facts' });

        const second = probe(
            writer.executeTool('agentDelegate', { agent: 'researcher', input: 'find more' })
        );
        await flush();

        expect(second.status).toBe('resolved');
        expect(second.value).toEqual({ agent: 'researcher', content: '\n' });
        expect(seen).toHaveLength(4);
        expect(vi.getTimerCount()).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// R4 — targeted cancellation
// ---------------------------------------------------------------------------

describe('toolCancel', () => {
    it('releases one pending call, keeps its sibling running, and ignores a late result', async () => {
        const stubborn = stubbornTool('stubborn');
        const siblingGate = deferred<string>();
        const seen: SeenRequest[] = [];
        const events: HarnessEvent[] = [];

        const writer = harness({
            agents: {
                writer: agent({
                    model: 'test/model',
                    stream: streamFrom(
                        (turn, request) => {
                            if (turn === 0) {
                                return calls(
                                    call('k1', 'stubborn', '{"value":"S"}'),
                                    call('k2', 'sibling', '{"value":"T"}')
                                );
                            }
                            if (turn === 1) {
                                // toolCancel exists only because work is pending.
                                return calls(call('k3', 'toolCancel', '{"callId":"k1"}'));
                            }
                            // State-based: once the sibling's REAL result is visible the
                            // run can finish; until then every response is a pause.
                            const siblingSettled = request.messages.some(
                                (message) =>
                                    message.role === 'tool' &&
                                    message.toolCallId === 'k2' &&
                                    message.content === 'sibling-done'
                            );
                            return siblingSettled
                                ? answer('cancelled and done')
                                : answer('waiting on sibling');
                        },
                        seen
                    )
                })
            },
            tools: {
                stubborn: stubborn.definition,
                sibling: gatedTool('sibling', siblingGate)
            },
            presets: false,
            report: {
                progress: (event) => {
                    events.push(event);
                }
            }
        });

        const state = probe(writer('go'));
        await flush();

        // The first request has no pending work, so the cancellation control is
        // not declared and costs no context.
        expect(seen[0].toolNames.filter((name) => name === 'toolCancel')).toEqual([]);
        // Once a call is in flight it is declared, because only then can it work.
        expect(seen[1].toolNames.filter((name) => name === 'toolCancel')).toEqual(['toolCancel']);

        // The targeted cancel aborts the call's own signal; the sibling's stays
        // live, so the sibling can still complete normally.
        expect(stubborn.observedSignal()?.aborted).toBe(true);
        expect(siblingGate.settled).toBe(false);
        // `pending` on this result depends on delivery order between the cancel
        // control and the cancelled call's own result, so only the fixed fields
        // are pinned; the live sibling is proven directly below.
        expect(resultsOf(events, 'toolCancel')).toMatchObject([
            {
                type: 'tool_result',
                agent: 'writer',
                name: 'toolCancel',
                callId: 'k3',
                content: '{"cancelled":true,"callId":"k1","name":"stubborn"}',
                isError: false,
                outcome: 'completed',
                durationMs: 0
            }
        ]);
        // A cancelled call is settled logically as an error-SHAPED result the model
        // must read (no value exists), but its structured outcome is `cancelled`, so
        // a consumer renders a control outcome instead of a tool failure.
        expect(resultsOf(events, 'stubborn')).toMatchObject([
            {
                type: 'tool_result',
                agent: 'writer',
                name: 'stubborn',
                callId: 'k1',
                content: expect.any(String),
                isError: true,
                outcome: 'cancelled'
            }
        ]);

        // The sibling keeps running; the cancelled call is out of the pending view.
        expect(state.status).toBe('pending');
        siblingGate.resolve('sibling-done');
        await flush();

        expect(state.status).toBe('resolved');
        expect(state.value?.content).toBe('cancelled and done');
        expect(resultsOf(events, 'sibling')).toEqual([
            {
                type: 'tool_result',
                agent: 'writer',
                name: 'sibling',
                callId: 'k2',
                content: 'sibling-done',
                isError: false,
                outcome: 'completed',
                durationMs: 0
            }
        ]);

        // A late settlement of the uncooperative tool is data on a dead call: no
        // transcript mutation and no second result event.
        const settledTranscript = copyMessages(writer.agent.messages);
        const resultCount = resultsOf(events, 'stubborn').length;
        stubborn.gate.resolve('late-answer');
        await flush();

        expect(writer.agent.messages).toEqual(settledTranscript);
        expect(resultsOf(events, 'stubborn')).toHaveLength(resultCount);
        expect(wireIssues(seen)).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });

    // R2: cancellation is a STATE to reach, not a one-shot transition. Repeating it
    // for an already cancelled call must succeed and change nothing — the caller's
    // intent (this call must not hold the run open) was already satisfied, so an
    // "already cancelled" error would only cost a turn.
    it('treats a repeated cancel of an already cancelled call as success', async () => {
        const stubborn = stubbornTool('stubborn');
        const siblingGate = deferred<string>();
        const seen: SeenRequest[] = [];
        const events: HarnessEvent[] = [];

        const writer = harness({
            agents: {
                writer: agent({
                    model: 'test/model',
                    stream: streamFrom(
                        (turn) => {
                            if (turn === 0) {
                                return calls(
                                    call('k1', 'stubborn', '{"value":"S"}'),
                                    call('k2', 'sibling', '{"value":"T"}')
                                );
                            }
                            // The sibling stays pending, so toolCancel is declared on
                            // both of these turns: that is exactly the situation in
                            // which a model repeats a cancel.
                            if (turn === 1) return calls(call('k3', 'toolCancel', '{"callId":"k1"}'));
                            if (turn === 2) return calls(call('k4', 'toolCancel', '{"callId":"k1"}'));
                            return answer('done');
                        },
                        seen
                    )
                })
            },
            tools: {
                stubborn: stubborn.definition,
                sibling: gatedTool('sibling', siblingGate)
            },
            presets: false,
            report: { progress: (event) => void events.push(event) }
        });

        const state = probe(writer('go'));
        await flush();

        // Both acknowledgements are successful control results, and the second one
        // says what it found instead of raising an error.
        const cancels = resultsOf(events, 'toolCancel');
        expect(cancels.map((event) => event.callId)).toEqual(['k3', 'k4']);
        expect(cancels.map((event) => event.outcome)).toEqual(['completed', 'completed']);
        expect(cancels.map((event) => event.isError)).toEqual([false, false]);
        expect(cancels.map((event) => event.content)).toEqual([
            '{"cancelled":true,"callId":"k1","name":"stubborn"}',
            '{"cancelled":true,"callId":"k1","name":"stubborn","alreadySettled":true}'
        ]);
        // The already-cancelled call keeps exactly one result, classified as a
        // control outcome rather than a failure.
        expect(resultsOf(events, 'stubborn').map((event) => event.outcome)).toEqual(['cancelled']);

        // The run is genuinely unblocked: the sibling finishes and the run ends.
        expect(state.status).toBe('pending');
        siblingGate.resolve('sibling-done');
        await flush();
        expect(state.status).toBe('resolved');
        expect(state.value?.content).toBe('done');
        expect(wireIssues(seen)).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });

    // R2: the same idempotence covers calls that FINISHED, including an execution
    // that failed: "cancel" means "do not wait for it", which is already true.
    it('treats a cancel of an already completed or failed call as success', async () => {
        const siblingGate = deferred<string>();
        const seen: SeenRequest[] = [];
        const events: HarnessEvent[] = [];

        const quick = tool<string, string>({
            description: 'Returns at once.',
            tags: ['test'],
            visibility: 'core',
            parameters: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
                additionalProperties: false
            },
            execute: () => 'quick-done'
        });

        const broken = tool<string, string>({
            description: 'Fails at once.',
            tags: ['test'],
            visibility: 'core',
            parameters: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
                additionalProperties: false
            },
            execute: () => {
                throw new Error('kaput');
            }
        });

        const writer = harness({
            agents: {
                writer: agent({
                    model: 'test/model',
                    stream: streamFrom(
                        (turn) => {
                            if (turn === 0) {
                                return calls(
                                    call('q1', 'quick', '{"value":"Q"}'),
                                    call('f1', 'broken', '{"value":"F"}'),
                                    call('k2', 'sibling', '{"value":"T"}')
                                );
                            }
                            if (turn === 1) {
                                return calls(
                                    call('c1', 'toolCancel', '{"callId":"q1"}'),
                                    call('c2', 'toolCancel', '{"callId":"f1"}')
                                );
                            }
                            return answer('done');
                        },
                        seen
                    )
                })
            },
            tools: {
                quick,
                broken,
                sibling: gatedTool('sibling', siblingGate)
            },
            presets: false,
            report: { progress: (event) => void events.push(event) }
        });

        const state = probe(writer('go'));
        await flush();

        // The two settled calls are classified by what actually happened.
        expect(resultsOf(events, 'quick').map((event) => event.outcome)).toEqual(['completed']);
        expect(resultsOf(events, 'broken').map((event) => event.outcome)).toEqual(['failed']);
        expect(resultsOf(events, 'broken').map((event) => event.content)).toEqual([
            'Tool "broken" failed: kaput'
        ]);

        // Cancelling either of them is a successful no-op, never "already completed".
        const cancels = resultsOf(events, 'toolCancel');
        expect(cancels.map((event) => event.callId)).toEqual(['c1', 'c2']);
        expect(cancels.map((event) => event.outcome)).toEqual(['completed', 'completed']);
        expect(cancels.map((event) => event.isError)).toEqual([false, false]);
        expect(cancels.map((event) => event.content)).toEqual([
            '{"cancelled":true,"callId":"q1","name":"quick","alreadySettled":true}',
            '{"cancelled":true,"callId":"f1","name":"broken","alreadySettled":true}'
        ]);

        siblingGate.resolve('sibling-done');
        await flush();
        expect(state.status).toBe('resolved');
        expect(state.value?.content).toBe('done');
        expect(wireIssues(seen)).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });

    // R2: idempotence must not become a blanket "yes". An id that never started in
    // THIS run — including a child run's own tool call — is rejected, so a foreign
    // id never looks like a cancellation this run performed.
    it('rejects an id this run never started, including a child run\'s call', async () => {
        const helperGate = deferred<string>();
        const seen: SeenRequest[] = [];
        const events: HarnessEvent[] = [];

        const helper = agent({
            model: 'test/child',
            stream: streamFrom(
                (turn) => (turn === 0 ? calls(call('h1', 'slow', '{"value":"x"}')) : answer('child done')),
                []
            )
        });

        const writer = harness({
            agents: {
                writer: agent({
                    model: 'test/parent',
                    stream: streamFrom(
                        (turn) => {
                            if (turn === 0) {
                                return calls(
                                    call('d1', 'agentDelegate', '{"agent":"helper","input":"work"}')
                                );
                            }
                            if (turn === 1) {
                                return calls(
                                    call('c1', 'toolCancel', '{"callId":"h1"}'),
                                    call('c2', 'toolCancel', '{"callId":"ghost"}')
                                );
                            }
                            return answer('done');
                        },
                        seen
                    )
                }),
                helper
            },
            primary: 'writer',
            subagents: ['helper'],
            tools: { slow: gatedTool('slow', helperGate) },
            presets: false,
            report: { progress: (event) => void events.push(event) }
        });

        const state = probe(writer('go'));
        await flush();

        // d1 is still pending, so both cancels run; neither id is this run's call.
        expect(resultsOf(events, 'toolCancel')).toMatchObject([
            {
                type: 'tool_result',
                agent: 'writer',
                name: 'toolCancel',
                callId: 'c1',
                content:
                    'No tool call "h1" was started in this run, so there is nothing to cancel. Pass the callId of a call this run started (see the pending list or the tool_call event).',
                isError: true,
                outcome: 'rejected'
            },
            {
                type: 'tool_result',
                agent: 'writer',
                name: 'toolCancel',
                callId: 'c2',
                content:
                    'No tool call "ghost" was started in this run, so there is nothing to cancel. Pass the callId of a call this run started (see the pending list or the tool_call event).',
                isError: true,
                outcome: 'rejected'
            }
        ]);

        // The child's call was NOT aborted by the rejected attempt.
        expect(helperGate.settled).toBe(false);
        helperGate.resolve('child work');
        await flush();
        expect(state.status).toBe('resolved');
        expect(state.value?.content).toBe('done');
        expect(wireIssues(seen)).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });

    // R1: the two error families are distinguishable without reading the text.
    it('classifies an unregistered tool as rejected and a throwing tool as failed', async () => {
        const seen: SeenRequest[] = [];
        const events: HarnessEvent[] = [];

        const broken = tool<string, string>({
            description: 'Fails at once.',
            tags: ['test'],
            visibility: 'core',
            parameters: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
                additionalProperties: false
            },
            execute: () => {
                throw new Error('kaput');
            }
        });

        const writer = harness({
            agents: {
                writer: agent({
                    model: 'test/model',
                    stream: streamFrom(
                        (turn) =>
                            turn === 0
                                ? calls(
                                      call('n1', 'missing', '{"value":"M"}'),
                                      call('f1', 'broken', '{"value":"F"}')
                                  )
                                : answer('done'),
                        seen
                    )
                })
            },
            tools: { broken },
            presets: false,
            report: { progress: (event) => void events.push(event) }
        });

        const state = probe(writer('go'));
        await flush();

        expect(state.status).toBe('resolved');
        expect(state.value?.content).toBe('done');

        const rejected = resultsOf(events, 'missing');
        const failed = resultsOf(events, 'broken');

        // Never executed: an invocation/dispatch error the model can fix.
        expect(rejected.map((event) => event.outcome)).toEqual(['rejected']);
        expect(rejected.map((event) => event.isError)).toEqual([true]);
        expect(rejected[0].content).toContain('Tool "missing" is not registered.');

        // Executed and threw: an operational failure.
        expect(failed.map((event) => event.outcome)).toEqual(['failed']);
        expect(failed.map((event) => event.isError)).toEqual([true]);
        expect(failed.map((event) => event.content)).toEqual(['Tool "broken" failed: kaput']);

        expect(wireIssues(seen)).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// R5 — whole-run cancel
// ---------------------------------------------------------------------------

describe('whole-run cancel', () => {
    it('rolls back every actor, aborts the child, clears timers, and leaves the harness reusable', async () => {
        const controller = new AbortController();
        const parentLog: string[] = [];
        const childLog: string[] = [];
        const parentWork = abortableTool('work', parentLog);
        const childWork = abortableTool('dig', childLog);
        const parentSeen: SeenRequest[] = [];
        const childSeen: SeenRequest[] = [];

        const researcher = agent({
            model: 'test/child',
            stream: streamFrom(
                (turn) => (turn === 0 ? calls(call('g1', 'dig', '{"value":"deep"}')) : answer('child-waiting')),
                childSeen
            )
        });

        const writer = harness({
            agents: {
                writer: agent({
                    model: 'test/parent',
                    stream: streamFrom(
                        (turn) => {
                            if (turn === 0) {
                                return calls(
                                    call('d1', 'agentDelegate', '{"agent":"researcher","input":"dig"}')
                                );
                            }
                            if (turn === 1) {
                                return calls(call('w1', 'work', '{"value":"parent"}'));
                            }
                            if (controller.signal.aborted) return answer('recovered');
                            return answer('parent-waiting');
                        },
                        parentSeen
                    )
                }),
                researcher
            },
            primary: 'writer',
            subagents: ['researcher'],
            tools: { work: parentWork.definition, dig: childWork.definition },
            presets: false
        });

        const state = probe(writer('go', { signal: controller.signal }));
        await flush();

        // Both actors are mid-call when the operator cancels the whole run.
        expect(parentLog).toEqual(['work:start:parent']);
        expect(childLog).toEqual(['dig:start:deep']);
        expect(parentWork.observedSignal()?.aborted).toBe(false);

        controller.abort(new Error('run aborted'));
        await flush();

        expect(state.status).toBe('rejected');
        expect(String((state.error as Error).message)).toContain('run aborted');
        expect(parentWork.observedSignal()?.aborted).toBe(true);
        expect(childWork.observedSignal()?.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);

        // Both histories rolled back to before the cancelled call.
        expect(writer.agent.messages).toEqual([]);
        expect(writer.agents.researcher.messages).toEqual([]);

        // Reusable afterwards: the same harness answers a fresh call.
        const next = probe(writer('again'));
        await flush();

        expect(next.status).toBe('resolved');
        expect(next.value?.content).toBe('recovered');
        expect(shape(writer.agent.messages)).toEqual(['user:again', 'assistant:recovered:']);
        expect(vi.getTimerCount()).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// R5 — failure recovery and the iteration bound
// ---------------------------------------------------------------------------

describe('failure paths', () => {
    it('feeds a rejected background tool back as an error result the model recovers from', async () => {
        const flakyGate = deferred<string>();
        const seen: SeenRequest[] = [];
        const events: HarnessEvent[] = [];

        const flaky = tool<string, string>({
            description: 'Rejects on demand.',
            tags: ['test'],
            visibility: 'core',
            parameters: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
                additionalProperties: false
            },
            execute: () => flakyGate.promise
        });

        const writer = harness({
            agents: {
                writer: agent({
                    model: 'test/model',
                    stream: streamFrom(
                        (turn, request) => {
                            if (turn === 0) return calls(call('f1', 'flaky', '{"value":"F"}'));
                            const failed = request.messages.some(
                                (message) =>
                                    message.role === 'tool' &&
                                    message.toolCallId === 'f1' &&
                                    message.content.includes('boom')
                            );
                            return failed ? answer('recovered') : answer('waiting on flaky');
                        },
                        seen
                    )
                })
            },
            tools: { flaky },
            presets: false,
            report: {
                progress: (event) => {
                    events.push(event);
                }
            }
        });

        const state = probe(writer('go'));
        await flush();
        expect(state.status).toBe('pending');

        await advance(250);
        flakyGate.reject(new Error('boom'));
        await flush();

        expect(state.status).toBe('resolved');
        expect(state.value?.content).toBe('recovered');
        // Throwing is recoverable DATA, not a run failure, and the message is the
        // same envelope an immediate tool failure produces.
        expect(resultsOf(events, 'flaky')).toEqual([
            {
                type: 'tool_result',
                agent: 'writer',
                name: 'flaky',
                callId: 'f1',
                content: 'Tool "flaky" failed: boom',
                isError: true,
                outcome: 'failed',
                durationMs: 250
            }
        ]);
        expect(wireIssues(seen)).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rolls back and abandons pending work when maxIterations is exhausted', async () => {
        const firstGate = deferred<string>();
        const secondGate = deferred<string>();
        const seen: SeenRequest[] = [];
        const events: HarnessEvent[] = [];

        const writer = harness({
            agents: {
                writer: agent({
                    model: 'test/model',
                    stream: streamFrom(
                        (turn) =>
                            turn === 0
                                ? calls(call('p1', 'first', '{"value":"1"}'))
                                : calls(call('p2', 'second', '{"value":"2"}')),
                        seen
                    )
                })
            },
            tools: {
                first: gatedTool('first', firstGate),
                second: gatedTool('second', secondGate)
            },
            presets: false,
            maxIterations: 2,
            report: {
                progress: (event) => {
                    events.push(event);
                }
            }
        });

        const state = probe(writer('go'));
        await flush();

        // Two tool rounds were spent while the calls were still pending.
        expect(seen).toHaveLength(2);
        expect(state.status).toBe('rejected');
        expect(String((state.error as Error).message)).toBe(
            'Agent "writer" requested tools more than 2 times without answering.'
        );

        // R5: the rollback path abandons the pending calls — no timer, no result,
        // and no transcript to mutate when they finally settle.
        expect(vi.getTimerCount()).toBe(0);
        expect(writer.agent.messages).toEqual([]);
        const beforeLateSettle = copyMessages(writer.agent.messages);
        const resultsBefore = events.filter((event) => event.type === 'tool_result').length;

        firstGate.resolve('late-first');
        secondGate.resolve('late-second');
        await flush();

        expect(writer.agent.messages).toEqual(beforeLateSettle);
        expect(events.filter((event) => event.type === 'tool_result')).toHaveLength(resultsBefore);
        expect(vi.getTimerCount()).toBe(0);
    });
});

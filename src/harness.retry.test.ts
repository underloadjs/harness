// harness() — model-request retries (R1/R3/R4).
//
// Pinned contract:
//   - a retried model request is reported as a `retry` event (agent, attempt,
//     maxAttempts, delayMs, failed error) and then the successful `done`;
//   - a failed attempt's tool calls never execute: the harness only launches calls
//     from a COMMITTED assistant message, and a failed attempt is never committed;
//   - a retry re-sends only the CURRENT request: tool results already in the
//     transcript stay, and no tool is re-run;
//   - retries are per REQUEST, so several requests in one run each get their own
//     budget and never replay an earlier tool.
//
// Run: npx vitest run src/harness.retry.test.ts

import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type { HarnessEvent, HarnessStream, HarnessStreamEvent, HarnessStreamRequest } from '@underload/harness';

// Canonical transcript entries now carry a minted `messageId` (context T1,
// src/core/message-id.ts): a stable ADDRESS for a turn, i.e. an identity field like a
// timestamp rather than part of the content these assertions pin. Stripping it DEEPLY
// keeps every expected value here exactly what it was, and the id itself is pinned
// exactly where it is the subject: src/harness.inclusion.test.ts (minting, `entries`,
// addressing by id), src/harness.snapshot.test.ts (persistence and restore-without-ids)
// and src/harness.fork.test.ts (ids COPIED across a fork).
const withoutIds = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutIds);

    if (typeof value === 'object' && value !== null) {
        const entries: [string, unknown][] = [];

        for (const [key, child] of Object.entries(value)) {
            // The only key dropped is the id; `undefined`-valued keys stay, so a
            // `toStrictEqual` comparison keeps its strictness about them.
            if (key === 'messageId') continue;
            entries.push([key, withoutIds(child)]);
        }

        return Object.fromEntries(entries);
    }

    return value;
};

const done = (): HarnessStreamEvent => ({ type: 'done', stopReason: 'stop', toolCalls: [] });

const answer = (text: string): HarnessStreamEvent[] => [{ type: 'text', delta: text }, done()];

const callTool = (id: string, name: string, args = '{}'): HarnessStreamEvent[] => [
    { type: 'done', stopReason: 'tool_calls', toolCalls: [{ id, name, arguments: args }] }
];

// Route every request through a callback so a test scripts by TRANSCRIPT, not by
// a global counter (retries make a counter ambiguous).
const routed = (route: (request: HarnessStreamRequest) => HarnessStreamEvent[]): HarnessStream =>
    async function* stream(request) {
        for (const frame of route(request)) yield frame;
    };

const latestUser = (request: HarnessStreamRequest): string => {
    for (let index = request.messages.length - 1; index >= 0; index--) {
        const message = request.messages[index];
        if (message.role === 'user') return message.content;
    }
    return '';
};

// A promise plus its settle functions, for a tool whose completion the test drives
// by hand (the only way to make a completion land WHILE a request is in flight).
type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

const deferred = <T>(): Deferred<T> => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
};

// Flush the harness's mailbox/scheduler microtasks. Generous pass count: one
// delivery walks mailbox -> wake -> request -> settle window.
const settle = async (): Promise<void> => {
    for (let pass = 0; pass < 64; pass++) await Promise.resolve();
};

// Wait until `condition` holds, flushing microtasks between checks. The harness
// advances through several mailbox hops (request -> launch -> settle -> next
// request), so a fixed number of flushes is not a reliable boundary.
const until = async (condition: () => boolean): Promise<void> => {
    for (let pass = 0; pass < 512; pass++) {
        if (condition()) return;
        await settle();
    }

    throw new Error('condition never became true');
};

// Drain a run while advancing fake timers: each `retry` frame precedes a real
// backoff `setTimeout`, which this helper fires.
const runWithTimers = async <T>(work: () => Promise<T>, events: HarnessEvent[]): Promise<T> => {
    const running = work();
    let seen = 0;

    // Advance until the promise settles, one announced backoff at a time.
    for (let pass = 0; pass < 64; pass++) {
        await vi.advanceTimersByTimeAsync(0);
        if (events.length > seen) {
            const retry = events.slice(seen).find((event) => event.type === 'retry');
            seen = events.length;
            if (retry !== undefined && retry.type === 'retry') {
                await vi.advanceTimersByTimeAsync(retry.delayMs);
                continue;
            }
        }

        const settled = await Promise.race([running.then(() => true, () => true), Promise.resolve(false)]);
        if (settled) break;
    }

    return running;
};

afterEach(() => {
    vi.useRealTimers();
});

describe('harness model-request retries', () => {
    it('reports the retry and recovers without rerunning tools', async () => {
        vi.useFakeTimers();

        const executed: string[] = [];
        const events: HarnessEvent[] = [];
        const seen: HarnessStreamRequest[] = [];
        let failedOnce = false;

        const probe = tool({
            description: 'Record one execution.',
            tags: ['test'],
            visibility: 'core',
            execute: () => {
                executed.push('probe');
                return 'probe-result';
            }
        });

        const stream = routed((request) => {
            seen.push(request);

            const results = request.messages.filter((message) => message.role === 'tool');

            // First request asks for the tool.
            if (results.length === 0) return callTool('c1', 'probe');

            // Second request fails once, then succeeds. Its tool result must survive
            // the retry untouched.
            if (!failedOnce) {
                failedOnce = true;
                return [{ type: 'error', message: 'HTTP 500: overloaded' }];
            }

            return answer('final answer');
        });

        const writer = harness({
            agents: { writer: agent({ model: 'm', stream }) },
            tools: { probe },
            presets: false,
            report: { progress: (event) => void events.push(event) }
        });

        const message = await runWithTimers(() => writer('go'), events);

        expect(message.content).toBe('final answer');
        // The tool ran exactly ONCE: the retried request re-sent the same tool result.
        expect(executed).toEqual(['probe']);

        // The retry frame names the agent, the attempt, the budget, the backoff and
        // the failed attempt's own error.
        expect(events.filter((event) => event.type === 'retry')).toEqual([
            {
                type: 'retry',
                agent: 'writer',
                attempt: 1,
                maxAttempts: 11,
                delayMs: 1_000,
                error: { message: 'HTTP 500: overloaded' }
            }
        ]);

        // The retried request carried the committed tool result: nothing was replayed
        // and nothing was dropped.
        expect(seen).toHaveLength(3);
        expect(seen[2].messages).toEqual(seen[1].messages);
        expect(
            seen[2].messages.filter((entry) => entry.role === 'tool').map((entry) => entry.content)
        ).toEqual(['probe-result']);

        // History holds one user turn, one tool-call turn, its result, and the answer.
        expect(withoutIds(writer.agent.messages)).toEqual([
            { role: 'user', content: 'go' },
            { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'probe', arguments: '{}' }] },
            { role: 'tool', content: 'probe-result', toolCallId: 'c1', name: 'probe' },
            { role: 'assistant', content: 'final answer' }
        ]);
    });

    it('never executes a tool call from a failed attempt', async () => {
        vi.useFakeTimers();

        const executed: string[] = [];
        const events: HarnessEvent[] = [];
        let attempt = 0;

        const dangerous = tool({
            description: 'Must never run from an abandoned attempt.',
            tags: ['test'],
            visibility: 'core',
            execute: () => {
                executed.push('dangerous');
                return 'ran';
            }
        });

        const stream = routed(() => {
            attempt += 1;
            // The FIRST attempt streams a complete tool-call turn and then fails;
            // its calls must never be launched.
            if (attempt === 1) {
                return [
                    ...callTool('bad', 'dangerous'),
                    { type: 'error', message: 'HTTP 502: gateway' }
                ];
            }

            return answer('safe answer');
        });

        const writer = harness({
            agents: { writer: agent({ model: 'm', stream }) },
            tools: { dangerous },
            presets: false,
            report: { progress: (event) => void events.push(event) }
        });

        const message = await runWithTimers(() => writer('go'), events);

        expect(message.content).toBe('safe answer');
        expect(executed).toEqual([]);
        expect(withoutIds(writer.agent.messages)).toEqual([
            { role: 'user', content: 'go' },
            { role: 'assistant', content: 'safe answer' }
        ]);
    });

    it('gives every request in a run its own retry budget', async () => {
        vi.useFakeTimers();

        const events: HarnessEvent[] = [];
        const perPrompt = new Map<string, number>();
        const executed: string[] = [];

        const probe = tool({
            description: 'Record one execution.',
            tags: ['test'],
            visibility: 'core',
            execute: () => {
                executed.push('probe');
                return 'probe-result';
            }
        });

        const stream = routed((request) => {
            const prompt = latestUser(request);
            const count = (perPrompt.get(prompt) ?? 0) + 1;
            perPrompt.set(prompt, count);

            const results = request.messages.filter((message) => message.role === 'tool');

            // Every request fails exactly once before succeeding, which proves the
            // budget is per request (a shared counter would exhaust).
            if (count === 1) return [{ type: 'error', message: `${prompt} down` }];
            if (prompt === 'first' && results.length === 0) return callTool('c1', 'probe');
            return answer(`${prompt} answer`);
        });

        const writer = harness({
            agents: { writer: agent({ model: 'm', stream }) },
            tools: { probe },
            presets: false,
            report: { progress: (event) => void events.push(event) }
        });

        const first = await runWithTimers(() => writer('first'), events);
        const second = await runWithTimers(() => writer('second'), events);

        expect(first.content).toBe('first answer');
        expect(second.content).toBe('second answer');
        expect(executed).toEqual(['probe']);
        // One retry per RUN: each run's first request failed once, and each request
        // got its own fresh budget (the second run's first request still retried).
        expect(events.filter((event) => event.type === 'retry')).toEqual([
            {
                type: 'retry',
                agent: 'writer',
                attempt: 1,
                maxAttempts: 11,
                delayMs: 1_000,
                error: { message: 'first down' }
            },
            {
                type: 'retry',
                agent: 'writer',
                attempt: 1,
                maxAttempts: 11,
                delayMs: 1_000,
                error: { message: 'second down' }
            }
        ]);
    });

    // F1: the EXACT live order that used to lose a committed tool round. The harness
    // emits `done` only for a tool-free response, so the tool-calling round gets no
    // `done`; `attempt_commit` is its only closing frame. Without it the next
    // request's `retry` looked like it belonged to the committed round and the UI
    // deleted it.
    it('closes a committed tool round with attempt_commit before the next retry', async () => {
        vi.useFakeTimers();

        const events: HarnessEvent[] = [];
        const executed: string[] = [];
        let failedOnce = false;

        const probe = tool({
            description: 'Record one execution.',
            tags: ['test'],
            visibility: 'core',
            execute: () => {
                executed.push('probe');
                return 'probe-result';
            }
        });

        const stream = routed((request) => {
            const results = request.messages.filter((message) => message.role === 'tool');

            // Round 1: a completed tool-call turn (no `done` reaches the consumer).
            if (results.length === 0) return callTool('c1', 'probe');

            // Round 2: the first attempt streams partial prose and fails, then the
            // retry answers.
            if (!failedOnce) {
                failedOnce = true;
                return [
                    { type: 'text', delta: 'partial draft' },
                    { type: 'error', message: 'HTTP 500: overloaded' }
                ];
            }

            return answer('final answer');
        });

        const writer = harness({
            agents: { writer: agent({ model: 'm', stream }) },
            tools: { probe },
            presets: false,
            report: { progress: (event) => void events.push(event) }
        });

        const message = await runWithTimers(() => writer('go'), events);

        expect(message.content).toBe('final answer');
        // The tool ran exactly ONCE: a retry re-sends only the model request.
        expect(executed).toEqual(['probe']);

        // Exact wire order. `attempt_commit` closes the committed tool round, after
        // that round's `tool_call` and before the tool's own `tool_result`; the
        // retry then belongs unambiguously to the NEXT request.
        expect(events.map((event) => event.type)).toEqual([
            'start',
            'tool_call',
            'attempt_commit',
            'tool_result',
            'text',
            'retry',
            'text',
            'done'
        ]);

        // The boundary names the request's successful attempt and its budget.
        expect(events[2]).toEqual({ type: 'attempt_commit', agent: 'writer', attempt: 1, maxAttempts: 11 });
        // The failed attempt's partial prose precedes its `retry` (the UI discards
        // everything between the previous boundary and this frame).
        expect(events[4]).toEqual({ type: 'text', agent: 'writer', delta: 'partial draft' });
        expect(events[5]).toEqual({
            type: 'retry',
            agent: 'writer',
            attempt: 1,
            maxAttempts: 11,
            delayMs: 1_000,
            error: { message: 'HTTP 500: overloaded' }
        });

        // History: the committed tool round survived, and the failed attempt's prose
        // was never committed.
        expect(withoutIds(writer.agent.messages)).toEqual([
            { role: 'user', content: 'go' },
            { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'probe', arguments: '{}' }] },
            { role: 'tool', content: 'probe-result', toolCallId: 'c1', name: 'probe' },
            { role: 'assistant', content: 'final answer' }
        ]);
    });

    // R3/F1: a text-only answer already has its `done`, so no extra boundary frame is
    // emitted. This keeps every existing sequence byte-identical.
    it('emits no attempt_commit for a text-only answer', async () => {
        vi.useFakeTimers();

        const events: HarnessEvent[] = [];
        const stream = routed(() => answer('just text'));

        const writer = harness({
            agents: { writer: agent({ model: 'm', stream }) },
            presets: false,
            report: { progress: (event) => void events.push(event) }
        });

        await writer('go');

        expect(events.map((event) => event.type)).toEqual(['start', 'text', 'done']);
        expect(events.filter((event) => event.type === 'attempt_commit')).toEqual([]);
    });

    // T8 defect 2: a text-only response that is SUPERSEDED (a completion landed
    // while its request was in flight) is still committed to history, but it gets no
    // `done`. Without its own boundary the UI would read its prose as abandoned
    // output and delete it on the next request's `retry` — silent data loss of an
    // answer the transcript kept.
    it('closes a superseded text-only response with attempt_commit', async () => {
        // Real timers: this test drives completions by hand, so it needs the real
        // mailbox/wake plumbing rather than a timer we have to pump.
        vi.useRealTimers();

        const events: HarnessEvent[] = [];
        const first = deferred<string>();
        const second = deferred<string>();
        // Suspends the request that is about to be superseded, so the second
        // completion provably lands WHILE it is in flight.
        const inFlight = deferred<void>();
        let inFlightResolved = false;
        inFlight.promise.then(() => {
            inFlightResolved = true;
        });
        const seenPrompts: string[] = [];

        const holdA = tool({
            description: 'Hold A.',
            tags: ['test'],
            visibility: 'core',
            // T2/R2: async (see holdB) — a completion that lands WHILE a request is in
            // flight is what supersedes the text-only response.
            mode: 'async',
            execute: () => first.promise
        });
        const holdB = tool({
            description: 'Hold B.',
            tags: ['test'],
            visibility: 'core',
            // T2/R2: async — the superseding completion has to be able to re-prompt the
            // model while this call is still running.
            mode: 'async',
            execute: () => second.promise
        });

        let request = 0;
        const stream: HarnessStream = async function* (input) {
            request += 1;
            seenPrompts.push(String(request));

            // Round 1: two background calls, both still running.
            if (request === 1) {
                yield {
                    type: 'done',
                    stopReason: 'tool_calls',
                    toolCalls: [
                        { id: 'a1', name: 'holdA', arguments: '{}' },
                        { id: 'b1', name: 'holdB', arguments: '{}' }
                    ]
                };
                return;
            }

            // Round 2: answer while both are pending -> a paused `done`.
            if (request === 2) {
                yield { type: 'text', delta: 'interim' };
                yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                return;
            }

            // Round 3: the response that gets SUPERSEDED. It streams prose, then waits
            // until the test settles B, which dirties the run.
            if (request === 3) {
                yield { type: 'text', delta: 'superseded prose' };
                inFlight.resolve();
                await second.promise;
                yield { type: 'done', stopReason: 'stop', toolCalls: [] };
                return;
            }

            yield { type: 'text', delta: 'final answer' };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        };

        const writer = harness({
            agents: { writer: agent({ model: 'm', stream }) },
            tools: { holdA, holdB },
            presets: false,
            report: { progress: (event) => void events.push(event) }
        });

        const running = writer('go');
        void running.catch(() => undefined);

        // Round 1 launches both calls; round 2 reports the pause.
        await until(() => events.some((event) => event.type === 'done'));
        expect(events.map((event) => event.type)).toEqual([
            'start',
            'tool_call',
            'tool_call',
            'attempt_commit',
            'text',
            'done'
        ]);

        // First completion wakes the run into round 3.
        first.resolve('A-done');
        await until(() => inFlightResolved);
        await settle();

        // Round 3 has streamed its prose and is suspended. Settling B now dirties the
        // run, so its tool-free response is superseded: no `done`, but it IS in
        // history, so it must carry a boundary.
        second.resolve('B-done');
        await settle();

        const message = await running;
        expect(message.content).toBe('final answer');

        expect(events.map((event) => event.type)).toEqual([
            'start',
            'tool_call',
            'tool_call',
            // round 1 committed (tool round, no `done`)
            'attempt_commit',
            'text',
            'done',
            // first completion
            'tool_result',
            // round 3 streamed, then was superseded
            'text',
            'tool_result',
            // ...so its committed prose is closed by its own boundary (T8)
            'attempt_commit',
            'text',
            'done'
        ]);

        // The boundary sits between the superseded prose and the next request. Index
        // layout: 0 start, 1-2 tool_call, 3 commit, 4 text, 5 done, 6 tool_result(A),
        // 7 superseded text, 8 tool_result(B), 9 commit, 10 text, 11 done.
        expect(events[7]).toEqual({ type: 'text', agent: 'writer', delta: 'superseded prose' });
        expect(events[9]).toEqual({ type: 'attempt_commit', agent: 'writer', attempt: 1, maxAttempts: 11 });

        // The transcript really did keep that response: the boundary describes a
        // committed answer, not a discarded one.
        expect(withoutIds(writer.agent.messages)).toEqual([
            { role: 'user', content: 'go' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'a1', name: 'holdA', arguments: '{}' },
                    { id: 'b1', name: 'holdB', arguments: '{}' }
                ]
            },
            { role: 'tool', content: 'A-done', toolCallId: 'a1', name: 'holdA' },
            { role: 'tool', content: 'B-done', toolCallId: 'b1', name: 'holdB' },
            { role: 'assistant', content: 'interim' },
            { role: 'assistant', content: 'superseded prose' },
            { role: 'assistant', content: 'final answer' }
        ]);
    });
});

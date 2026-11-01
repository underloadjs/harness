// core/agent.ts — model-request retries (R1/R2/R3).
//
// Pinned contract:
//   - ONE initial attempt plus TEN retries by default, with doubling waits of
//     1000 * 2 ** n ms for n = 0..9 (1s .. 512s);
//   - every failure shape is retried: a returned `error` frame (any HTTP status),
//     a thrown network error, and a stream that throws mid-flight;
//   - a successful attempt ends the sequence immediately;
//   - exhaustion (11 calls) preserves the LAST attempt's original error;
//   - cancellation is not an error to retry: it stops immediately, before an
//     attempt, during a backoff wait, and while a request is in flight;
//   - a failed attempt's partial text/reasoning/tool calls never reach the
//     committed history, and the retry re-sends the SAME request payload;
//   - `retry: false` (or `maxRetries: 0`) restores one-attempt behaviour.
//
// Run: npx vitest run src/core/agent.retry.test.ts

import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent } from '@underload/harness';
import type {
    AgentStreamEvent,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest
} from '@underload/harness';

// The documented default sequence: ten retries after the initial attempt.
const DEFAULT_DELAYS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 512_000];

const done = (): HarnessStreamEvent => ({ type: 'done', stopReason: 'stop', toolCalls: [] });

const collect = async (events: AsyncIterable<AgentStreamEvent>): Promise<AgentStreamEvent[]> => {
    const collected: AgentStreamEvent[] = [];
    for await (const event of events) {
        collected.push(event);
    }
    return collected;
};

// A transport that replays one scripted list PER REQUEST, so a test can script
// "fail, fail, succeed" without any timing assumption.
const scripted = (
    turns: HarnessStreamEvent[][],
    seen?: HarnessStreamRequest[]
): HarnessStream => {
    let index = 0;
    return async function* stream(request) {
        seen?.push(request);
        const frames = turns[index] ?? turns[turns.length - 1];
        index += 1;
        for (const frame of frames) {
            yield frame;
        }
    };
};

// Drive a stream to completion while advancing fake timers. A `retry` event is
// yielded BEFORE its backoff wait, so the helper starts the generator again (which
// registers the timer) and then advances past exactly that delay.
const runWithTimers = async (events: AsyncIterable<AgentStreamEvent>): Promise<AgentStreamEvent[]> => {
    const collected: AgentStreamEvent[] = [];
    const iterator = events[Symbol.asyncIterator]();

    let pending = iterator.next();

    while (true) {
        const next = await pending;
        if (next.done === true) break;

        collected.push(next.value);
        pending = iterator.next();

        if (next.value.type === 'retry') {
            // Resumes the generator to its backoff timer, then fires it.
            await vi.advanceTimersByTimeAsync(next.value.delayMs);
        }
    }

    return collected;
};

afterEach(() => {
    vi.useRealTimers();
});

describe('agent model-request retries', () => {
    it('retries with the ten doubling waits and succeeds on a later attempt', async () => {
        vi.useFakeTimers();

        const seen: HarnessStreamRequest[] = [];
        const brain = agent({
            model: 'm',
            stream: scripted(
                [
                    [{ type: 'error', message: 'HTTP 500: overloaded' }],
                    [{ type: 'text', delta: 'second' }, done()]
                ],
                seen
            )
        });

        const events = await runWithTimers(brain.stream('go'));

        // The failed attempt's error is reported, then the successful answer.
        expect(events).toEqual([
            {
                type: 'retry',
                attempt: 1,
                maxAttempts: 11,
                delayMs: 1_000,
                error: { message: 'HTTP 500: overloaded' }
            },
            { type: 'text', delta: 'second' },
            {
                type: 'done',
                message: {
                    role: 'assistant',
                    content: 'second',
                    reasoning: '',
                    toolCalls: [],
                    model: 'm',
                    stopReason: 'stop',
                    usage: undefined
                }
            }
        ]);

        // The retry re-sent the SAME request payload.
        expect(seen).toHaveLength(2);
        expect(seen[1]).toEqual(seen[0]);
        expect(seen[1].messages).toEqual([{ role: 'user', content: 'go' }]);

        expect(brain.messages).toEqual([
            { role: 'user', content: 'go' },
            { role: 'assistant', content: 'second' }
        ]);
    });

    it('uses the exact default delay sequence 1000 * 2 ** n for n = 0..9', async () => {
        vi.useFakeTimers();

        const seen: HarnessStreamRequest[] = [];
        const failures: HarnessStreamEvent[][] = DEFAULT_DELAYS.map((_, index) => [
            { type: 'error', message: `failure ${index + 1}` }
        ]);
        const brain = agent({ model: 'm', stream: scripted([...failures, [{ type: 'text', delta: 'ok' }, done()]], seen) });

        const events = await runWithTimers(brain.stream('go'));
        const retries = events.filter((event) => event.type === 'retry');

        expect(retries).toEqual(
            DEFAULT_DELAYS.map((delayMs, index) => ({
                type: 'retry',
                attempt: index + 1,
                maxAttempts: 11,
                delayMs,
                error: { message: `failure ${index + 1}` }
            }))
        );
        expect(DEFAULT_DELAYS).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 512_000]);
        // Ten retries plus the successful attempt.
        expect(seen).toHaveLength(11);
    });

    it('stops after eleven calls and preserves the last attempt error (any status)', async () => {
        vi.useFakeTimers();

        const seen: HarnessStreamRequest[] = [];
        // A 401 is retried exactly like a 5xx: the policy is "all model-call
        // failures", not "server errors only".
        const brain = agent({
            model: 'm',
            stream: scripted([[{ type: 'error', message: 'HTTP 401: unauthorized' }]], seen)
        });

        const events = await runWithTimers(brain.stream('go'));

        expect(seen).toHaveLength(11);
        // Ten retry notices, then the terminal error with the ORIGINAL message.
        expect(events.filter((event) => event.type === 'retry')).toHaveLength(10);
        expect(events.at(-1)).toEqual({ type: 'error', error: { message: 'HTTP 401: unauthorized' } });

        // Nothing was committed.
        expect(brain.messages).toEqual([]);
    });

    it('retries a truncated stream and a stream that throws mid-flight', async () => {
        vi.useFakeTimers();

        const seen: HarnessStreamRequest[] = [];
        const brain = agent({
            model: 'm',
            stream: scripted(
                [
                    // The transport itself throws before yielding anything.
                    [],
                    // A partial stream that throws mid-flight.
                    [{ type: 'text', delta: 'half' }],
                    [{ type: 'text', delta: 'full answer' }, done()]
                ],
                seen
            )
        });

        const events = await runWithTimers(brain.stream('go'));

        expect(events.filter((event) => event.type === 'retry')).toEqual([
            { type: 'retry', attempt: 1, maxAttempts: 11, delayMs: 1_000, error: { message: 'The model stream ended without a completion frame.' } },
            {
                type: 'retry',
                attempt: 2,
                maxAttempts: 11,
                delayMs: 2_000,
                error: { message: 'The model stream ended without a completion frame after partial output.' }
            }
        ]);
        expect(events.at(-1)).toMatchObject({ type: 'done', message: { content: 'full answer' } });
    });

    it('retries a transport that throws, keeping the thrown message', async () => {
        vi.useFakeTimers();

        let attempts = 0;
        const stream: HarnessStream = async function* () {
            attempts += 1;
            if (attempts === 1) throw new Error('socket hang up');
            yield { type: 'text', delta: 'recovered' };
            yield done();
        };

        const brain = agent({ model: 'm', stream });

        const events = await runWithTimers(brain.stream('go'));

        expect(events[0]).toEqual({
            type: 'retry',
            attempt: 1,
            maxAttempts: 11,
            delayMs: 1_000,
            error: { message: 'socket hang up' }
        });
        expect(events.at(-1)).toMatchObject({ type: 'done', message: { content: 'recovered' } });
        expect(attempts).toBe(2);
    });

    // R3: a failed attempt's partial output must not contaminate the committed
    // message, and its tool calls must never exist (so nothing can execute them).
    it('discards a failed attempt partial text and reasoning', async () => {
        vi.useFakeTimers();

        const seen: HarnessStreamRequest[] = [];
        let attempts = 0;
        const stream: HarnessStream = async function* (request) {
            seen.push(request);
            attempts += 1;

            if (attempts === 1) {
                // Partial output, then the stream breaks mid-flight: this attempt
                // never produced a completion frame.
                yield { type: 'reasoning', delta: 'thinking about it' };
                yield { type: 'text', delta: 'partial draft' };
                throw new Error('connection reset');
            }

            yield { type: 'text', delta: 'clean answer' };
            yield done();
        };

        const brain = agent({ model: 'm', stream });

        const events = await runWithTimers(brain.stream('go'));

        const last = events.at(-1);
        expect(last).toMatchObject({
            type: 'done',
            message: {
                content: 'clean answer',
                reasoning: '',
                toolCalls: []
            }
        });

        // Only the successful attempt is committed: no partial text and no reasoning
        // from the abandoned attempt.
        expect(brain.messages).toEqual([
            { role: 'user', content: 'go' },
            { role: 'assistant', content: 'clean answer' }
        ]);
        expect(JSON.stringify(brain.messages)).not.toContain('partial draft');
        expect(JSON.stringify(brain.messages)).not.toContain('thinking about it');
        expect(seen).toHaveLength(2);
    });

    // R3: a tool-call turn is a COMPLETED response, not a failure. The retry loop
    // must not re-send it, and the calls it names are the ones the caller executes.
    it('does not retry a completed tool-call turn', async () => {
        vi.useFakeTimers();

        const seen: HarnessStreamRequest[] = [];
        const brain = agent({
            model: 'm',
            stream: scripted(
                [
                    [
                        {
                            type: 'done',
                            stopReason: 'tool_calls',
                            toolCalls: [{ id: 'call_ok', name: 'real', arguments: '{}' }]
                        }
                    ]
                ],
                seen
            )
        });

        const events = await collect(brain.stream('go'));

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            type: 'done',
            message: { toolCalls: [{ id: 'call_ok', name: 'real', arguments: '{}' }] }
        });
        expect(seen).toHaveLength(1);
        expect(brain.messages.at(-1)).toEqual({
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_ok', name: 'real', arguments: '{}' }]
        });
    });

    // F3: the transport's `done` frame is the model's WHOLE answer. A throw that
    // arrives after it is the transport's own cleanup noise (a provider wrapper
    // rejecting from its finally), never a failed request. Retrying there would
    // re-send a request whose answer is already committed, so the UI — which had
    // closed the attempt window on `done` — would end up showing BOTH answers.
    it('does not retry a throw that arrives after the transport completed', async () => {
        vi.useFakeTimers();

        let calls = 0;
        const stream: HarnessStream = async function* () {
            calls += 1;
            yield { type: 'text', delta: 'answer' };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
            // Post-completion noise. The agent must not treat this as a failure.
            throw new Error('socket cleanup exploded');
        };

        const brain = agent({ model: 'm', stream });
        const events = await collect(brain.stream('go'));

        // Exactly the committed answer, and no retry anywhere in the stream.
        expect(events).toEqual([
            { type: 'text', delta: 'answer' },
            {
                type: 'done',
                message: {
                    role: 'assistant',
                    content: 'answer',
                    reasoning: '',
                    toolCalls: [],
                    model: 'm',
                    stopReason: 'stop'
                }
            }
        ]);
        expect(events.filter((event) => event.type === 'retry')).toEqual([]);
        expect(calls).toBe(1);

        // ONE assistant message: the answer was never replayed into a duplicate.
        expect(brain.messages).toEqual([
            { role: 'user', content: 'go' },
            { role: 'assistant', content: 'answer' }
        ]);
    });

    // F3, cleanup half: unwinding the transport is our own `return()` call, so a
    // transport that rejects from it must not turn a completed answer into a retry
    // either. The iterator is hand-driven precisely so this call is ours to guard.
    it('does not retry when the transport cleanup throws after completion', async () => {
        vi.useFakeTimers();

        let calls = 0;
        const stream: HarnessStream = () => {
            calls += 1;

            return {
                [Symbol.asyncIterator]() {
                    let sent = false;
                    return {
                        next: async (): Promise<IteratorResult<HarnessStreamEvent>> => {
                            if (sent) return { done: true, value: undefined };
                            sent = true;
                            return {
                                done: false,
                                value: { type: 'done', stopReason: 'stop', toolCalls: [] }
                            };
                        },
                        return: async (): Promise<IteratorResult<HarnessStreamEvent>> => {
                            throw new Error('provider finally rejected');
                        }
                    };
                }
            };
        };

        const brain = agent({ model: 'm', stream });
        const events = await collect(brain.stream('go'));

        expect(events).toEqual([
            {
                type: 'done',
                message: {
                    role: 'assistant',
                    content: '',
                    reasoning: '',
                    toolCalls: [],
                    model: 'm',
                    stopReason: 'stop'
                }
            }
        ]);
        expect(events.filter((event) => event.type === 'retry')).toEqual([]);
        expect(calls).toBe(1);
        expect(brain.messages).toEqual([
            { role: 'user', content: 'go' },
            { role: 'assistant', content: '' }
        ]);
    });

    // The one post-`done` signal that DOES fail the attempt: an explicit `error`
    // FRAME is the transport declaring the generation failed. Preserving that keeps
    // the "never executes a tool call from a failed attempt" contract intact.
    it('still fails the attempt when an explicit error frame follows the done', async () => {
        vi.useFakeTimers();

        let calls = 0;
        const stream: HarnessStream = async function* () {
            calls += 1;

            if (calls === 1) {
                yield {
                    type: 'done',
                    stopReason: 'tool_calls',
                    toolCalls: [{ id: 'never', name: 'dangerous', arguments: '{}' }]
                };
                yield { type: 'error', message: 'HTTP 502: gateway closed' };
                return;
            }

            yield { type: 'text', delta: 'recovered' };
            yield { type: 'done', stopReason: 'stop', toolCalls: [] };
        };

        const brain = agent({ model: 'm', stream });
        const events = await runWithTimers(brain.stream('go'));

        // The failed attempt's tool call was never committed, and the retry happened.
        expect(events.filter((event) => event.type === 'retry')).toEqual([
            {
                type: 'retry',
                attempt: 1,
                maxAttempts: 11,
                delayMs: 1_000,
                error: { message: 'HTTP 502: gateway closed' }
            }
        ]);
        expect(calls).toBe(2);
        expect(brain.messages).toEqual([
            { role: 'user', content: 'go' },
            { role: 'assistant', content: 'recovered' }
        ]);
    });

    // R2: cancellation is a control outcome, not a model-call error.
    it('does not retry when the signal is already aborted before the attempt', async () => {
        vi.useFakeTimers();

        let attempts = 0;
        const stream: HarnessStream = async function* () {
            attempts += 1;
            yield { type: 'error', message: 'should not run' };
        };

        const controller = new AbortController();
        const reason = new Error('user cancelled');
        controller.abort(reason);

        const brain = agent({ model: 'm', stream });

        const events = await collect(brain.stream('go', { signal: controller.signal }));

        expect(events).toEqual([{ type: 'error', error: { message: 'user cancelled' } }]);
        expect(attempts).toBe(0);
        expect(brain.messages).toEqual([]);
    });

    it('aborts immediately during a backoff wait and clears the timer', async () => {
        vi.useFakeTimers();

        let attempts = 0;
        const stream: HarnessStream = async function* () {
            attempts += 1;
            yield { type: 'error', message: 'HTTP 500: down' };
        };

        const controller = new AbortController();
        const brain = agent({ model: 'm', stream });

        const collected: AgentStreamEvent[] = [];
        const iterator = brain.stream('go', { signal: controller.signal })[Symbol.asyncIterator]();

        // First attempt fails; the retry frame announces the 1s backoff.
        const first = await iterator.next();
        expect(first.value).toMatchObject({ type: 'retry', attempt: 1, delayMs: 1_000 });

        // Cancel DURING the wait: the wait settles at once with the caller's reason.
        controller.abort(new Error('cancelled in backoff'));
        const second = await iterator.next();
        expect(second.value).toEqual({ type: 'error', error: { message: 'cancelled in backoff' } });
        expect((await iterator.next()).done).toBe(true);

        expect(attempts).toBe(1);
        // No timer is left behind by the abandoned backoff.
        expect(vi.getTimerCount()).toBe(0);
        expect(brain.messages).toEqual([]);
    });

    it('aborts an in-flight request without retrying it', async () => {
        vi.useFakeTimers();

        let attempts = 0;
        const controller = new AbortController();

        const stream: HarnessStream = async function* () {
            attempts += 1;
            // Behave like a provider that honours its abort signal.
            controller.abort(new Error('stopped mid-request'));
            throw controller.signal.reason;
        };

        const brain = agent({ model: 'm', stream });

        const events = await collect(brain.stream('go', { signal: controller.signal }));

        expect(events).toEqual([{ type: 'error', error: { message: 'stopped mid-request' } }]);
        expect(attempts).toBe(1);
        expect(brain.messages).toEqual([]);
    });

    it('honours retry: false and an explicit maxRetries budget', async () => {
        vi.useFakeTimers();

        const noRetrySeen: HarnessStreamRequest[] = [];
        const noRetry = agent({
            model: 'm',
            stream: scripted([[{ type: 'error', message: 'boom' }]], noRetrySeen),
            retry: false
        });
        const noRetryEvents = await collect(noRetry.stream('go'));

        expect(noRetryEvents).toEqual([{ type: 'error', error: { message: 'boom' } }]);
        expect(noRetrySeen).toHaveLength(1);

        const budgetSeen: HarnessStreamRequest[] = [];
        const budget = agent({
            model: 'm',
            stream: scripted([[{ type: 'error', message: 'boom' }]], budgetSeen),
            retry: { maxRetries: 2, baseDelayMs: 5 }
        });
        const budgetEvents = await runWithTimers(budget.stream('go'));

        expect(budgetSeen).toHaveLength(3);
        expect(budgetEvents.filter((event) => event.type === 'retry')).toEqual([
            { type: 'retry', attempt: 1, maxAttempts: 3, delayMs: 5, error: { message: 'boom' } },
            { type: 'retry', attempt: 2, maxAttempts: 3, delayMs: 10, error: { message: 'boom' } }
        ]);
    });

    it('validates the retry policy at construction', () => {
        expect(() => agent({ model: 'm', stream: scripted([[done()]]), retry: { maxRetries: -1 } })).toThrow(
            'retry.maxRetries must be a non-negative safe integer; received -1.'
        );
        expect(() => agent({ model: 'm', stream: scripted([[done()]]), retry: { baseDelayMs: 0 } })).toThrow(
            'retry.baseDelayMs must be a positive safe integer; received 0.'
        );
    });
});

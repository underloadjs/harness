// core/agent.ts — the provider failure classes and the retry policy each one gets.
//
// Pinned contract:
//   - `provider-connection` (nothing answered the dial) is NOT the transient kind: it
//     gets 1 initial attempt plus 2 retries with 250 ms and 500 ms waits — 750 ms of
//     waiting in total — and then fails terminally with the dialled host:port in the
//     message. The pre-T6 behaviour (the 1 s -> 512 s ladder, 1023 s / ~17.05 min of
//     waiting for a provider that is simply not listening) is the DEFECT, so every
//     expectation here is written from the required behaviour, not an output (AC2);
//   - `provider-timeout` is NOT terminal (2026-11-17, the unrecoverable-timeout report —
//     this file used to pin the opposite, and that pin is exactly what the report
//     complained about: a gateway that went silent 120 s into a stream produced ONE
//     attempt, zero `retry` frames and a permanently interrupted conversation). It gets
//     its own bounded ladder: 1 + 3 attempts, waits 2 s / 4 s / 8 s, every wait capped at
//     30 s, and a 900 s wall-clock deadline over the whole sequence that also counts the
//     provider time each attempt consumed. `retry.maxRetries` does not stretch it;
//   - `provider-rejected` (a deterministic refusal) and `provider-aborted` (the gateway's
//     own in-stream cancel) stay terminal on one attempt;
//   - `retry: false` (equivalently `maxRetries: 0`) is a HARD opt-out for EVERY class, the
//     class ladders included: one attempt, no `retry` frame, no wait. A non-zero
//     `maxRetries` does not stretch or shrink a class ladder; zero means "never re-send".
//   - `context-overflow` stays non-retried (AC3), and an unclassified frame (an HTTP
//     401 answer) keeps the policy it has always had — pinned AS IT IS TODAY: an
//     unclassified frame IS retried on the configured ladder, which is exactly why the
//     transport classifies time and connection failures explicitly instead of
//     silently reclassifying every 4xx (AC3);
//   - every retry event carries the transport diagnosis (`provider`) for a classified
//     failure and OMITS the key for an unclassified one (AC6);
//   - an aborted signal still stops before the first attempt, with the caller's own
//     reason (AC5).
//
// A terminal model-request failure surfaces to the caller as the `error` EVENT of
// `Agent.stream` (the shape pinned by src/core/agent.retry.test.ts), which is the
// frame a UI consumes — so that is what these assertions pin.
//
// Run: yarn vitest run src/core/agent.provider-failures.test.ts

import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent } from '@underload/harness';
import type { AgentStreamEvent, HarnessStream, HarnessStreamEvent } from '@underload/harness';

const CHAT_URL = 'http://localhost:8800/providers/private/v1/chat/completions';

const TIMEOUT_MESSAGE =
    'provider-timeout: the provider accepted the TCP connection at localhost:8800 but sent no response for 2 seconds.';

const CONNECTION_MESSAGE =
    'provider-connection: nothing answered on localhost:8800 — the request was dialled to ' +
    'http://localhost:8800/providers/private/v1/chat/completions. ECONNREFUSED (connect ECONNREFUSED 127.0.0.1:8800).';

const TIMEOUT_FRAME: HarnessStreamEvent = {
    type: 'error',
    code: 'provider-timeout',
    message: TIMEOUT_MESSAGE,
    details: {
        errorClass: 'provider-timeout',
        url: CHAT_URL,
        port: 8800,
        phase: 'response-head',
        timeoutMs: 2_000
    }
};

const CONNECTION_FRAME: HarnessStreamEvent = {
    type: 'error',
    code: 'provider-connection',
    message: CONNECTION_MESSAGE,
    details: { errorClass: 'provider-connection', url: CHAT_URL, port: 8800, errno: 'ECONNREFUSED' }
};

// The frame `transport/openai.ts` yields for the gateway's in-stream `aborted` code: a
// cancel that came from the PROVIDER, not from our signal. Terminal, and never retried.
const ABORTED_FRAME: HarnessStreamEvent = {
    type: 'error',
    code: 'provider-aborted',
    message:
        'provider-aborted: the provider reported a failure on the stream from ' +
        'http://localhost:8800/providers/private/v1. The request was cancelled before it completed, ' +
        'so it is not re-sent.',
    details: { errorClass: 'provider-aborted', url: CHAT_URL, port: 8800 }
};

const OVERFLOW_FRAME: HarnessStreamEvent = {
    type: 'error',
    code: 'context-overflow',
    message: 'context-overflow: HTTP 413 — this request is too large for the model context window.'
};

const AUTH_FRAME: HarnessStreamEvent = { type: 'error', message: 'HTTP 401: nope' };

// What `transport/openai.ts` yields for a gateway error with an unknown or ABSENT code
// (absent is a defensive/legacy INPUT shape, not a live producer: both gateway writers
// emit a coded envelope, the copy at repository/agentic/src/server/start-server.ts
// :294-303 and :599-669 included, where `code` is a required key of its frame type) and
// for a body that closed mid-answer: CODELESS, so the ladder it has always had, plus the
// `provider-transit` diagnosis the session layer reads to call the death a network one
// (Contract D).
const TRANSIT_FRAME: HarnessStreamEvent = {
    type: 'error',
    message: 'Upstream stream terminated',
    details: { errorClass: 'provider-transit', url: CHAT_URL, port: 8800 }
};

// A transport that fails the SAME way on every attempt, counting the requests, so a
// test pins the attempt COUNT instead of sleeping through a ladder.
const alwaysFailing = (frame: HarnessStreamEvent, attempts: { value: number }): HarnessStream => {
    return async function* stream() {
        attempts.value += 1;

        yield frame;
    };
};

const collect = async (events: AsyncIterable<AgentStreamEvent>): Promise<AgentStreamEvent[]> => {
    const collected: AgentStreamEvent[] = [];

    for await (const event of events) collected.push(event);

    return collected;
};

// Both channels a terminal failure can take (the `error` event, or a rejection), so a
// test can pin the CALLER-VISIBLE MESSAGE without re-pinning an unrelated channel.
const settle = async (events: AsyncIterable<AgentStreamEvent>): Promise<AgentStreamEvent[]> => {
    try {
        return await collect(events);
    } catch {
        return [];
    }
};

// Drives a ladder under FAKED timers. The agent yields the `retry` frame BEFORE it arms
// the backoff timer, so the pump resumes the generator (which arms it) and then advances
// the clock by exactly the frame's own `delayMs`.
//
// `attemptMs` stands in for the time the PROVIDER takes on every attempt — the reported
// defect was a gateway that delivered 526 chunks and then sat on the 120 s stream bound,
// so the timeout ladder's deadline has to measure that too, not only our sleeps. Vitest's
// fake timers move `Date.now()` with the same clock as `setTimeout`, which is what makes
// the 900 s deadline testable without a clock seam in the agent.
const runWithTimers = async (events: AsyncIterable<AgentStreamEvent>, attemptMs = 0): Promise<AgentStreamEvent[]> => {
    vi.useFakeTimers();

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

            // The next attempt's provider time (0 = an instant failure).
            if (attemptMs > 0) await vi.advanceTimersByTimeAsync(attemptMs);
        }
    }

    return collected;
};

afterEach(() => {
    vi.useRealTimers();
});

const build = (stream: HarnessStream, retry?: { maxRetries?: number; baseDelayMs?: number }) =>
    agent({
        name: 'writer',
        model: 'local/basalt',
        instruction: 'Write.',
        stream,
        ...(retry === undefined ? {} : { retry })
    });

// The timeout frame's diagnostics block, identical on every attempt of these tests, so
// the pinned events below stay readable.
const TIMEOUT_DIAGNOSTICS = {
    errorClass: 'provider-timeout',
    url: CHAT_URL,
    port: 8800,
    phase: 'response-head',
    timeoutMs: 2_000
};

describe('provider failure retry policy (T6)', () => {
    it('retries a dead dial 3 times in total with a 250 ms and a 500 ms wait, then fails terminally', async () => {
        const attempts = { value: 0 };

        // The DEFAULT transient ladder (10 retries, 1 s base) is configured on
        // purpose: a connection failure must not spend it, whatever the host asked
        // for, because a dial that reached nobody is a configuration condition.
        const writer = build(alwaysFailing(CONNECTION_FRAME, attempts), { maxRetries: 10, baseDelayMs: 1_000 });

        const events = await collect(writer.stream('go'));

        expect(events).toEqual([
            {
                type: 'retry',
                attempt: 1,
                maxAttempts: 3,
                delayMs: 250,
                error: { message: CONNECTION_MESSAGE, code: 'provider-connection' },
                provider: { errorClass: 'provider-connection', url: CHAT_URL, port: 8800, errno: 'ECONNREFUSED' }
            },
            {
                type: 'retry',
                attempt: 2,
                maxAttempts: 3,
                delayMs: 500,
                error: { message: CONNECTION_MESSAGE, code: 'provider-connection' },
                provider: { errorClass: 'provider-connection', url: CHAT_URL, port: 8800, errno: 'ECONNREFUSED' }
            },
            { type: 'error', error: { message: CONNECTION_MESSAGE, code: 'provider-connection' } }
        ]);

        // THREE requests, 750 ms of waiting in total (250 + 500). The same failure
        // cost 11 requests and 1023 s of waiting before T6.
        expect(attempts.value).toBe(3);
    });

    it('honours the `retry: false` opt-out for every class: one attempt, no ladder, no wait', async () => {
        // The class ladders deliberately IGNORE a NON-ZERO `retry.maxRetries` (widening the
        // transient ladder must not stretch a timeout's 4 dials). ZERO is a different
        // statement: the published contract (src/types/index.ts, `retry` — "`false` = one
        // attempt only") promises the caller it will not see a second request. Pinned for
        // all three classes, because the temptation is to read `maxRetries` as merely the
        // transient ladder's count.
        const oneAttempt = async (frame: HarnessStreamEvent) => {
            const attempts = { value: 0 };

            const events = await collect(build(alwaysFailing(frame, attempts), false).stream('go'));

            return { attempts: attempts.value, events };
        };

        const timeoutCase = await oneAttempt(TIMEOUT_FRAME);
        const connectionCase = await oneAttempt(CONNECTION_FRAME);
        const transitCase = await oneAttempt(TRANSIT_FRAME);

        expect([timeoutCase, connectionCase, transitCase]).toEqual([
            {
                attempts: 1,
                events: [{ type: 'error', error: { message: TIMEOUT_MESSAGE, code: 'provider-timeout' } }]
            },
            {
                attempts: 1,
                events: [{ type: 'error', error: { message: CONNECTION_MESSAGE, code: 'provider-connection' } }]
            },
            {
                // The codeless class: the class lives in the diagnostics block, so the
                // terminal record still carries only its message.
                attempts: 1,
                events: [{ type: 'error', error: { message: 'Upstream stream terminated' } }]
            }
        ]);
    });

    it('retries a provider time bound on its own bounded ladder: 4 attempts, waits 2 s / 4 s / 8 s, then fails', async () => {
        const attempts = { value: 0 };

        // The transient ladder's settings are deliberately WIDER than the timeout
        // ladder's (10 retries, 1 s base): widening the transient ladder says "my
        // provider blips" and must not buy a provider that already missed a time bound
        // eleven dials. Four attempts is the class's own total, whatever the host set.
        const writer = build(alwaysFailing(TIMEOUT_FRAME, attempts), { maxRetries: 10, baseDelayMs: 1_000 });

        const events = await runWithTimers(writer.stream('go'));

        // THREE retry frames (the reported defect emitted none at all), each naming the
        // class's total of 4 attempts and carrying the transport's diagnostics, then the
        // terminal error with the ORIGINAL message and code.
        expect(events).toEqual([
            {
                type: 'retry',
                attempt: 1,
                maxAttempts: 4,
                delayMs: 2_000,
                error: { message: TIMEOUT_MESSAGE, code: 'provider-timeout' },
                provider: TIMEOUT_DIAGNOSTICS
            },
            {
                type: 'retry',
                attempt: 2,
                maxAttempts: 4,
                delayMs: 4_000,
                error: { message: TIMEOUT_MESSAGE, code: 'provider-timeout' },
                provider: TIMEOUT_DIAGNOSTICS
            },
            {
                type: 'retry',
                attempt: 3,
                maxAttempts: 4,
                delayMs: 8_000,
                error: { message: TIMEOUT_MESSAGE, code: 'provider-timeout' },
                provider: TIMEOUT_DIAGNOSTICS
            },
            { type: 'error', error: { message: TIMEOUT_MESSAGE, code: 'provider-timeout' } }
        ]);

        // FOUR requests, 14 s of waiting in total (2 + 4 + 8) — the "at least several"
        // the report asked for, and still no comparison with the 1 s -> 512 s ladder this
        // class must never walk.
        expect(attempts.value).toBe(4);
    });

    it('caps every wait of the timeout ladder at 30 s, whatever the configured base', async () => {
        const attempts = { value: 0 };

        // A host that configured 20 s waits MEANS "longer between dials", so the ladder
        // honours the base and raises it no further: 20 s, then the 30 s ceiling twice,
        // instead of 20 s / 40 s / 80 s. The delays alone are the assertion; the attempt
        // count and the terminal record are pinned by the ladder test above.
        const writer = build(alwaysFailing(TIMEOUT_FRAME, attempts), { maxRetries: 10, baseDelayMs: 20_000 });

        const events = await runWithTimers(writer.stream('go'));

        expect(events.filter((event) => event.type === 'retry').map((event) => event.delayMs)).toEqual([
            20_000, 30_000, 30_000
        ]);

        expect(events.at(-1)).toEqual({
            type: 'error',
            error: { message: TIMEOUT_MESSAGE, code: 'provider-timeout' }
        });

        expect(attempts.value).toBe(4);
    });

    it('stops the timeout ladder at its 900 s wall-clock deadline even with attempts left', async () => {
        const attempts = { value: 0 };
        const writer = build(alwaysFailing(TIMEOUT_FRAME, attempts), { maxRetries: 10, baseDelayMs: 1_000 });

        // Each attempt stands 890 s at the provider — the reported shape (a gateway that
        // holds the stream open until the bound expires) with a host that raised the bound
        // to minutes. The clock the deadline measures, step by step:
        //   attempt 1 fails at      0 ms → next wait 2 000  →   2 000 ms ≤ 900 000 → retry
        //   attempt 2 fails at  2 000 ms → next wait 4 000  →   6 000 ms ≤ 900 000 → retry
        //   … the provider holds attempt 2 for 890 000 ms …
        //   attempt 3 fails at 896 000 ms → next wait 8 000 → 904 000 ms > 900 000 → STOP
        // so the ladder ends after THREE attempts with one attempt still unused, which is
        // the whole point of a deadline next to a count: the count bounds the dials, the
        // deadline bounds the wait the caller actually experiences.
        const events = await runWithTimers(writer.stream('go'), 890_000);

        expect(events).toEqual([
            {
                type: 'retry',
                attempt: 1,
                maxAttempts: 4,
                delayMs: 2_000,
                error: { message: TIMEOUT_MESSAGE, code: 'provider-timeout' },
                provider: TIMEOUT_DIAGNOSTICS
            },
            {
                type: 'retry',
                attempt: 2,
                maxAttempts: 4,
                delayMs: 4_000,
                error: { message: TIMEOUT_MESSAGE, code: 'provider-timeout' },
                provider: TIMEOUT_DIAGNOSTICS
            },
            { type: 'error', error: { message: TIMEOUT_MESSAGE, code: 'provider-timeout' } }
        ]);

        expect(attempts.value).toBe(3);
    });

    it('keeps a deterministic refusal terminal on one attempt (T8, AC3)', async () => {
        const attempts = { value: 0 };
        const writer = build(
            alwaysFailing(
                {
                    type: 'error',
                    code: 'provider-rejected',
                    message: 'provider-rejected: the provider answered with HTTP 401 and refused the request.'
                },
                attempts
            ),
            { maxRetries: 10, baseDelayMs: 1_000 }
        );

        const events = await collect(writer.stream('go'));

        expect(events).toEqual([
            {
                type: 'error',
                error: {
                    message: 'provider-rejected: the provider answered with HTTP 401 and refused the request.',
                    code: 'provider-rejected'
                }
            }
        ]);
        expect(attempts.value).toBe(1);
    });

    it('never retries a cancel the provider reported (provider-aborted)', async () => {
        const attempts = { value: 0 };

        // Same transient-ladder settings as the retrying tests above: the refusal to
        // retry comes from the CLASS, not from the policy.
        const writer = build(alwaysFailing(ABORTED_FRAME, attempts), { maxRetries: 10, baseDelayMs: 1_000 });

        const events = await collect(writer.stream('go'));

        expect(events).toEqual([
            {
                type: 'error',
                error: { message: ABORTED_FRAME.message, code: 'provider-aborted' }
            }
        ]);
        expect(attempts.value).toBe(1);
    });

    it('never retries a context overflow (AC3)', async () => {
        const attempts = { value: 0 };
        const writer = build(alwaysFailing(OVERFLOW_FRAME, attempts), { maxRetries: 10, baseDelayMs: 1_000 });

        const events = await collect(writer.stream('go'));

        expect(events).toEqual([
            {
                type: 'error',
                error: {
                    message: 'context-overflow: HTTP 413 — this request is too large for the model context window.',
                    code: 'context-overflow'
                }
            }
        ]);
        expect(attempts.value).toBe(1);
    });

    it('keeps a codeless provider-transit frame on the configured ladder, now with diagnostics (AC3)', async () => {
        const attempts = { value: 0 };

        const writer = build(alwaysFailing(TRANSIT_FRAME, attempts), { maxRetries: 2, baseDelayMs: 1 });

        const events = await collect(writer.stream('go'));

        expect(events).toEqual([
            {
                type: 'retry',
                attempt: 1,
                maxAttempts: 3,
                delayMs: 1,
                error: { message: 'Upstream stream terminated' },
                provider: { errorClass: 'provider-transit', url: CHAT_URL, port: 8800 }
            },
            {
                type: 'retry',
                attempt: 2,
                maxAttempts: 3,
                delayMs: 2,
                error: { message: 'Upstream stream terminated' },
                provider: { errorClass: 'provider-transit', url: CHAT_URL, port: 8800 }
            },
            // No `code` on the terminal record: the class is in the diagnostics block,
            // and inventing a code here would promise a retry policy this class does not
            // have.
            { type: 'error', error: { message: 'Upstream stream terminated' } }
        ]);

        expect(attempts.value).toBe(3);
    });

    it('keeps an unclassified 401 frame on the configured ladder, with no provider diagnostics (AC3)', async () => {
        const attempts = { value: 0 };
        const writer = build(alwaysFailing(AUTH_FRAME, attempts), { maxRetries: 3, baseDelayMs: 1 });

        const events = await collect(writer.stream('go'));
        const retries = events.filter((event) => event.type === 'retry');

        expect(retries).toEqual([
            { type: 'retry', attempt: 1, maxAttempts: 4, delayMs: 1, error: { message: 'HTTP 401: nope' } },
            { type: 'retry', attempt: 2, maxAttempts: 4, delayMs: 2, error: { message: 'HTTP 401: nope' } },
            { type: 'retry', attempt: 3, maxAttempts: 4, delayMs: 4, error: { message: 'HTTP 401: nope' } }
        ]);

        expect(events[events.length - 1]).toEqual({ type: 'error', error: { message: 'HTTP 401: nope' } });
        expect(attempts.value).toBe(4);
    });

    it('stops before the first attempt for an aborted signal, with the caller reason (AC5)', async () => {
        const attempts = { value: 0 };
        const writer = build(alwaysFailing(CONNECTION_FRAME, attempts));

        const controller = new AbortController();
        controller.abort(new Error('user stopped'));

        const events = await settle(writer.stream('go', { signal: controller.signal }));

        // No attempt was made at all, and the only thing the caller sees is its own
        // stop — never a provider failure, and never a retry.
        expect(attempts.value).toBe(0);
        expect(events).toEqual([{ type: 'error', error: { message: 'user stopped' } }]);
    });
});

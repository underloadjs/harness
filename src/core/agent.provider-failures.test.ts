// core/agent.ts — the T6 provider failure classes and the retry policy they get.
//
// Pinned contract:
//   - `provider-connection` (nothing answered the dial) is NOT the transient kind: it
//     gets 1 initial attempt plus 2 retries with 250 ms and 500 ms waits — 750 ms of
//     waiting in total — and then fails terminally with the dialled host:port in the
//     message. The pre-T6 behaviour (the 1 s -> 512 s ladder, 1023 s / ~17.05 min of
//     waiting for a provider that is simply not listening) is the DEFECT, so every
//     expectation here is written from the required behaviour, not an output (AC2);
//   - `provider-timeout` is TERMINAL on the attempt that tripped it: one request, no
//     backoff, no second five-minute wait (AC1);
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

import { describe, expect, it } from 'vitest';
import { agent } from '@underload/harness';
import type { AgentStreamEvent, HarnessStream, HarnessStreamEvent } from '@underload/harness';

const CHAT_URL = 'http://localhost:6660/providers/private/v1/chat/completions';

const TIMEOUT_MESSAGE =
    'provider-timeout: the provider accepted the TCP connection at localhost:6660 but sent no response for 2 seconds.';

const CONNECTION_MESSAGE =
    'provider-connection: nothing answered on localhost:6660 — the request was dialled to ' +
    'http://localhost:6660/providers/private/v1/chat/completions. ECONNREFUSED (connect ECONNREFUSED 127.0.0.1:6660).';

const TIMEOUT_FRAME: HarnessStreamEvent = {
    type: 'error',
    code: 'provider-timeout',
    message: TIMEOUT_MESSAGE,
    details: {
        errorClass: 'provider-timeout',
        url: CHAT_URL,
        port: 6660,
        phase: 'response-head',
        timeoutMs: 2_000
    }
};

const CONNECTION_FRAME: HarnessStreamEvent = {
    type: 'error',
    code: 'provider-connection',
    message: CONNECTION_MESSAGE,
    details: { errorClass: 'provider-connection', url: CHAT_URL, port: 6660, errno: 'ECONNREFUSED' }
};

const OVERFLOW_FRAME: HarnessStreamEvent = {
    type: 'error',
    code: 'context-overflow',
    message: 'context-overflow: HTTP 413 — this request is too large for the model context window.'
};

const AUTH_FRAME: HarnessStreamEvent = { type: 'error', message: 'HTTP 401: nope' };

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

const build = (stream: HarnessStream, retry?: { maxRetries?: number; baseDelayMs?: number }) =>
    agent({
        name: 'writer',
        model: 'local/basalt',
        instruction: 'Write.',
        stream,
        ...(retry === undefined ? {} : { retry })
    });

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
                provider: { errorClass: 'provider-connection', url: CHAT_URL, port: 6660, errno: 'ECONNREFUSED' }
            },
            {
                type: 'retry',
                attempt: 2,
                maxAttempts: 3,
                delayMs: 500,
                error: { message: CONNECTION_MESSAGE, code: 'provider-connection' },
                provider: { errorClass: 'provider-connection', url: CHAT_URL, port: 6660, errno: 'ECONNREFUSED' }
            },
            { type: 'error', error: { message: CONNECTION_MESSAGE, code: 'provider-connection' } }
        ]);

        // THREE requests, 750 ms of waiting in total (250 + 500). The same failure
        // cost 11 requests and 1023 s of waiting before T6.
        expect(attempts.value).toBe(3);
    });

    it('treats a provider time bound as terminal: one request, no backoff, no second bound', async () => {
        const attempts = { value: 0 };
        const writer = build(alwaysFailing(TIMEOUT_FRAME, attempts), { maxRetries: 10, baseDelayMs: 1_000 });

        const events = await collect(writer.stream('go'));

        expect(events).toEqual([{ type: 'error', error: { message: TIMEOUT_MESSAGE, code: 'provider-timeout' } }]);
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

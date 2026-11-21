// core/agent.ts — a `provider-rejected` attempt is TERMINAL, transient statuses are not
// (T8, AC3).
//
// The retry decision switches on the transport's MACHINE CODE and never on prose, so
// this file pins both halves of the cut-off:
//   - `provider-rejected` (the transport's name for an HTTP 400/401/403/404 answer,
//     transport/openai.ts) ends the sequence on the FIRST attempt — the provider refused
//     these bytes, and attempt 2 sends the same ones. That is the fix for "a bad key
//     reads exactly like a hang": 1 request instead of 1 + 10 retries and ~17 minutes of
//     backoff, and the status is in the message the caller sees (AC3);
//   - a 429 / 408 / 5xx answer, which the transport deliberately leaves CODELESS, keeps
//     walking the configured ladder, because TIME (not the request) is what fixes those —
//     that is the reason the cut-off stops at those four statuses;
//   - and because the rule is the code and not the words, a scripted provider that still
//     emits a codeless `HTTP 401` frame is retried exactly as src/core/agent.retry.test.ts
//     pins: nothing here reclassifies an answer the transport did not classify.
//
// Run: yarn vitest run src/core/agent.provider-rejected.test.ts

import { describe, expect, it } from 'vitest';
import { agent } from '../index';
import type { AgentStreamEvent, HarnessStream, HarnessStreamEvent } from '../index';

const rejected = (status: number, detail: string): HarnessStreamEvent => ({
    type: 'error',
    code: 'provider-rejected',
    message:
        `provider-rejected: the provider answered http://localhost:8800/providers/private/v1/chat/completions ` +
        `with HTTP ${status} and refused the request, so re-sending the same bytes would be refused again — ` +
        `this turn failed after one attempt instead of waiting out the retry ladder. The provider said: "${detail}"`
});

// The frames the transport produces for the statuses T8 deliberately left alone.
const FRAME_429: HarnessStreamEvent = { type: 'error', message: 'HTTP 429: slow down' };
const FRAME_408: HarnessStreamEvent = { type: 'error', message: 'HTTP 408: too slow' };
const FRAME_503: HarnessStreamEvent = { type: 'error', message: 'HTTP 503: upstream unavailable' };
// A codeless 401 — what a hand-scripted provider (or a proxy that rewrote the frame)
// still produces. The agent must not start classifying English.
const FRAME_CODELESS_401: HarnessStreamEvent = { type: 'error', message: 'HTTP 401: nope' };

// A transport that fails the SAME way every attempt, counting the requests, so the
// attempt COUNT is what gets pinned instead of a sleep.
const alwaysFailing = (frame: HarnessStreamEvent, attempts: { value: number }): HarnessStream =>
    async function* stream() {
        attempts.value += 1;

        yield frame;
    };

const collect = async (events: AsyncIterable<AgentStreamEvent>): Promise<AgentStreamEvent[]> => {
    const collected: AgentStreamEvent[] = [];

    for await (const event of events) collected.push(event);

    return collected;
};

const build = (stream: HarnessStream, retry: { maxRetries?: number; baseDelayMs?: number }) =>
    agent({
        name: 'writer',
        model: 'local/basalt',
        instruction: 'Write.',
        stream,
        retry
    });

// 1 ms / 2 ms waits: the ladder's SHAPE is the subject, and a real 1 s base delay would
// only make the suite slower.
const LADDER = { maxRetries: 2, baseDelayMs: 1 };

describe('a deterministic refusal is not retried (T8, AC3)', () => {
    it('spends exactly one attempt on a `provider-rejected` frame and reports the status verbatim', async () => {
        const attempts = { value: 0 };
        const frame = rejected(401, 'invalid api key');

        const events = await collect(build(alwaysFailing(frame, attempts), LADDER).stream());

        // No `retry` frame at all: the sequence ended on attempt 1.
        expect(events).toStrictEqual([
            {
                type: 'error',
                error: { message: String(frame.message), code: 'provider-rejected' }
            }
        ]);
        expect(attempts.value).toBe(1);
    });

    it('treats 400, 403 and 404 refusals the same way (one attempt each)', async () => {
        for (const status of [400, 403, 404]) {
            const attempts = { value: 0 };

            const events = await collect(build(alwaysFailing(rejected(status, 'refused'), attempts), LADDER).stream());

            expect(events.map((event) => event.type)).toStrictEqual(['error']);
            expect(attempts.value).toBe(1);
            expect((events[0] as { error: { message: string } }).error.message).toContain(`HTTP ${status}`);
        }
    });

    it('still walks the ladder for 429, 408 and 5xx, which time can fix', async () => {
        for (const frame of [FRAME_429, FRAME_408, FRAME_503]) {
            const attempts = { value: 0 };
            const message = String(frame.message);

            const events = await collect(build(alwaysFailing(frame, attempts), LADDER).stream());

            // The full configured ladder (3 attempts: 1 + 2 retries) and then the
            // codeless terminal frame — i.e. exactly the pre-T8 behaviour for these.
            expect(events).toStrictEqual([
                { type: 'retry', attempt: 1, maxAttempts: 3, delayMs: 1, error: { message } },
                { type: 'retry', attempt: 2, maxAttempts: 3, delayMs: 2, error: { message } },
                { type: 'error', error: { message } }
            ]);
            expect(attempts.value).toBe(3);
        }
    });

    it('retries a CODELESS 401 frame, because the decision is the code and never the prose', async () => {
        const attempts = { value: 0 };

        const events = await collect(build(alwaysFailing(FRAME_CODELESS_401, attempts), LADDER).stream());

        expect(events.map((event) => event.type)).toStrictEqual(['retry', 'retry', 'error']);
        expect(attempts.value).toBe(3);
        expect(events[events.length - 1]).toEqual({
            type: 'error',
            error: { message: 'HTTP 401: nope' }
        });
    });
});

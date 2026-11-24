// core/agent.ts — the operator's retry line of the per-attempt provider trace (2026-11-24).
//
// The transport's own pair of lines (../transport/openai.provider-attempt-log.test.ts) is the
// only record for a failure the retry owner never re-sends. What ONLY this file has is the
// LADDER — attempt N of M and the wait that follows — and the model id, which the published
// `retry` event has never carried (../types/index.ts `HarnessProviderAttemptDiagnostics` is
// frozen; a new field cascades into a forked type copy and a Rust port, so the model reaches an
// operator HERE). Pinned contract, written from the required behaviour:
//
//   1. one line per RETRIED attempt, naming the attempt number, the class total for THAT class,
//      the delay about to be waited, the model id, and the class the ladder actually acted on —
//      the frame's machine `code` when it has one, else the diagnostics' `errorClass`;
//   2. NO retry line for a failure that is not retried: a refusal, or `retry: false`, leaves the
//      transport's two lines and nothing from here, so a single failed request still leaves an
//      operator-readable trace (model + redacted URL + failure class) without a duplicate;
//   3. the trace is the whole record of an exhausted ladder: eleven dials of the reported
//      provider-transit failure leave ELEVEN attributable attempt lines;
//   4. the model it names is the request's own snapshot, printed even when it is not a string —
//      an odd model id must never be the thing that fails a request.
//
// The real transport is used wherever the point is the END-TO-END trace (a stubbed transport
// would pin this file's line against itself), and `console.error` is spied and restored in
// `afterEach` so no other suite inherits it.
//
// Run: yarn vitest run src/engine/core/agent.provider-attempt-log.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent } from '../index';
import type { AgentStreamEvent, HarnessStream, HarnessStreamEvent } from '../index';

const BASE_URL = 'http://localhost:8800/providers/private/v1';
const CHAT_URL = `${BASE_URL}/chat/completions`;

// The transport's two lines for the agent's request: a `Write.` system message plus a `go` user
// message, sent to `local/basalt`. Asserted here as well as in the transport's own file, because
// the pair — not either line alone — is the operator's trace.
const AGENT_ATTEMPT_LINE =
    `[harness] provider attempt: model=local/basalt · dial=${CHAT_URL} · stream=yes · messages=2 · body=119 bytes`;

const AGENT_FAILURE_LINE = (failureClass: string): string =>
    `[harness] provider attempt failed: model=local/basalt · dial=${CHAT_URL} · class=${failureClass}`;

const retryLine = (attempt: number, maxAttempts: number, delayMs: number, failureClass: string): string =>
    `[harness] provider attempt ${attempt} of ${maxAttempts} failed, retrying in ${delayMs}ms: ` +
    `model=local/basalt · class=${failureClass}`;

// The reported failure: a body that closed mid-answer, which the transport reports as a CODELESS
// frame carrying `errorClass: 'provider-transit'` — the exact event the live session emitted
// eleven times (`Upstream stream terminated`).
const TRANSIT_FRAME: HarnessStreamEvent = {
    type: 'error',
    message: 'Upstream stream terminated',
    details: { errorClass: 'provider-transit', url: CHAT_URL, port: 8800 }
};

// A frame that DOES carry a machine code, for the class-precedence assertion below.
const CONNECTION_FRAME: HarnessStreamEvent = {
    type: 'error',
    code: 'provider-connection',
    message:
        'provider-connection: nothing answered on localhost:8800 — the request was dialled to ' +
        `${CHAT_URL}. ECONNREFUSED (connect ECONNREFUSED 127.0.0.1:8800).`,
    details: { errorClass: 'provider-connection', url: CHAT_URL, port: 8800, errno: 'ECONNREFUSED' }
};

// A truncated SSE body: a delta, and then the stream ends with no `[DONE]` and no
// `finish_reason`, which is what the transport classes as provider-transit.
const HALF_BODY = 'data: {"choices":[{"delta":{"content":"half"}}]}\n\n';

let lines: string[] = [];

let stderr: { mockRestore: () => void };

beforeEach(() => {
    lines = [];

    stderr = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        lines.push(args.map((arg) => String(arg)).join(' '));
    });
});

afterEach(() => {
    stderr.mockRestore();
    vi.unstubAllGlobals();
});

const collect = async (events: AsyncIterable<AgentStreamEvent>): Promise<AgentStreamEvent[]> => {
    const collected: AgentStreamEvent[] = [];

    for await (const event of events) collected.push(event);

    return collected;
};

// A transport that fails the same way every attempt, so a test pins this file's line without
// touching the wire at all.
const alwaysFailing = (frame: HarnessStreamEvent): HarnessStream =>
    async function* stream(): AsyncGenerator<HarnessStreamEvent> {
        yield frame;
    };

const writer = (options: {
    stream?: HarnessStream;
    retry?: false | { maxRetries: number; baseDelayMs: number };
}): ReturnType<typeof agent> =>
    agent({
        name: 'writer',
        model: 'local/basalt',
        instruction: 'Write.',
        ...(options.stream === undefined ? { provider: { baseURL: BASE_URL } } : { stream: options.stream }),
        ...(options.retry === undefined ? {} : { retry: options.retry })
    });

describe('the retry line of the per-attempt provider trace (agent side)', () => {
    it('leaves eleven attributable attempt lines for the reported eleven-dial ladder', async () => {
        // The real transport, the reported failure, and the transient ladder the live session
        // walked: 1 + 10 attempts. `baseDelayMs: 1` keeps the run instant — the delays are what
        // the line must report, and they are the ladder's own doubling.
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(HALF_BODY, { status: 200, statusText: 'OK' }))
        );

        const events = await collect(writer({ retry: { maxRetries: 10, baseDelayMs: 1 } }).stream('go'));

        // The transient ladder's waits, in order: this is the number the operator waits.
        const delays = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];

        const expected: string[] = [];

        for (let attempt = 1; attempt <= 11; attempt++) {
            expected.push(AGENT_ATTEMPT_LINE, AGENT_FAILURE_LINE('provider-transit'));

            if (attempt <= 10) expected.push(retryLine(attempt, 11, delays[attempt - 1], 'provider-transit'));
        }

        // Thirty-two lines, in the order they were written: every dial is one triple of
        // "what we sent", "how the wire answered", "what the ladder will do next".
        expect(lines).toEqual(expected);

        // AC, stated the way the operator greps it: one attributable attempt line per dial.
        expect(lines.filter((line) => line.startsWith('[harness] provider attempt:'))).toHaveLength(11);
        expect(lines.filter((line) => line.startsWith('[harness] provider attempt failed:'))).toHaveLength(11);

        // The events are the historical ladder (10 `retry` frames then the terminal error),
        // unchanged by the trace: the `retry` payload still has no model field, which is exactly
        // why this line exists.
        expect(events.filter((event) => event.type === 'retry')).toHaveLength(10);
        expect(events.at(-1)).toMatchObject({ type: 'error' });
    });

    it('leaves one readable trace for a single failed request, and no retry line at all', async () => {
        // `retry: false` is the hard opt-out: one attempt, no `retry` frame — and therefore no
        // line from this file. The transport's pair still names the model, the redacted endpoint
        // and the failure class, which is the whole operator requirement for a refusal.
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                new Response(`{"error":"Model 'undefined' not found"}`, { status: 404, statusText: 'Not Found' })
            )
        );

        const events = await collect(writer({ retry: false }).stream('go'));

        expect(lines).toEqual([AGENT_ATTEMPT_LINE, AGENT_FAILURE_LINE('provider-rejected')]);
        expect(lines.filter((line) => line.includes('retrying in'))).toEqual([]);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ type: 'error', error: { code: 'provider-rejected' } });
    });

    it('names the diagnostics class when the frame carries no code', async () => {
        // The codeless class has no `code` to print, and the ladder acted on `details.errorClass`
        // — so the line names THAT, which is what makes `attempt 1..11 of 11` readable. The
        // class total is the CONFIGURED one here (3), because a codeless frame keeps the generic
        // ladder (../core/agent.ts).
        const writer3 = writer({ stream: alwaysFailing(TRANSIT_FRAME), retry: { maxRetries: 2, baseDelayMs: 1 } });

        await collect(writer3.stream('go'));

        expect(lines).toEqual([
            retryLine(1, 3, 1, 'provider-transit'),
            retryLine(2, 3, 2, 'provider-transit')
        ]);
    });

    it('names the machine code when the frame carries one, and the CLASS total', async () => {
        // A `provider-connection` failure gets its own 1 + 2 ladder whatever the host configured
        // (a wide transient ladder is a statement about blips, not about a dead port), and the
        // line reports THAT total — `1 of 3`, not `1 of 11`.
        const deadPort = writer({
            stream: alwaysFailing(CONNECTION_FRAME),
            retry: { maxRetries: 10, baseDelayMs: 1_000 }
        });

        await collect(deadPort.stream('go'));

        expect(lines).toEqual([
            retryLine(1, 3, 250, 'provider-connection'),
            retryLine(2, 3, 500, 'provider-connection')
        ]);
    });

    it('names the model of the attempt even when the model id is not a string', async () => {
        // The retry helper must not be the thing that fails a request, and the reported incident
        // was a model id the provider could not find — so a non-string model still NAMES itself
        // here. `model=42` is what the wire was handed.
        const retargeted = writer({ stream: alwaysFailing(TRANSIT_FRAME), retry: { maxRetries: 2, baseDelayMs: 1 } });

        retargeted.model(42 as unknown as string);

        await collect(retargeted.stream('go'));

        expect(lines).toEqual([
            '[harness] provider attempt 1 of 3 failed, retrying in 1ms: model=42 · class=provider-transit',
            '[harness] provider attempt 2 of 3 failed, retrying in 2ms: model=42 · class=provider-transit'
        ]);
    });
});

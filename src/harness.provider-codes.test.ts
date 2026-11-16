// harness.ts — a run-level provider failure keeps its MACHINE CODE (T8, AC1).
//
// Pinned contract (written from the required behaviour, not from an observed output):
//   - the `HarnessError` the harness re-throws from an agent `error` FRAME keeps that
//     frame's `code`, so BOTH channels a host can observe carry the machine name: the
//     rejection of `writer('go')` (its `code` and `name`) and the terminal `error`
//     EVENT, whose payload is `toErrorInfo(error)` (util/errors.ts adds `code` exactly
//     when the error has one). The pre-T8 line was
//     `throw new HarnessError(event.error.message)` (src/harness.ts, the agent-stream
//     switch), which dropped the code and forced every consumer — a session record, the
//     UI provider panel, a CLI — to parse English prose to learn that a provider timed
//     out (AC1);
//   - an UNCLASSIFIED frame still produces the byte-identical codeless payload: no
//     `code` key on the event and `name === 'HarnessError'` on the rejection, so nothing
//     about an ordinary failure moved (AC5);
//   - the retry bookkeeping T6 pinned is untouched: a `provider-timeout` emits NO retry
//     frame (core/agent.ts keeps it terminal, so a run that dies on a bound has never
//     spent a retry), while a `provider-connection` emits that class's two short retries
//     (250 ms, 500 ms) before failing terminally — the flag behind `retries-exhausted`
//     (`run.sawRetryFrame`) is set by the `retry` FRAME, which this change never touches.
//
// Run: yarn vitest run src/harness.provider-codes.test.ts

import { describe, expect, it } from 'vitest';
import {
    agent,
    harness,
    HarnessError,
    PROVIDER_CONNECTION_CODE,
    PROVIDER_REJECTED_CODE,
    PROVIDER_TIMEOUT_CODE
} from '@underload/harness';
import type { HarnessEvent, HarnessStream, HarnessStreamEvent } from '@underload/harness';

const CHAT_URL = 'http://localhost:6660/providers/private/v1/chat/completions';

// The exact frame texts the transport produces (transport/provider-timeouts.ts). They
// are pinned verbatim here because AC1 is about the CODE travelling with them, and a
// message that silently changed would otherwise hide in a code-only assertion.
const TIMEOUT_MESSAGE =
    'provider-timeout: the provider accepted the TCP connection at localhost:6660 but sent no response for 300 seconds.';

const CONNECTION_MESSAGE =
    'provider-connection: nothing answered on localhost:6660 — the request was dialled to ' +
    `${CHAT_URL}. ECONNREFUSED (connect ECONNREFUSED 127.0.0.1:6660).`;

const CODELESS_MESSAGE = 'HTTP 418: I am a teapot';

const TIMEOUT_FRAME: HarnessStreamEvent = {
    type: 'error',
    code: PROVIDER_TIMEOUT_CODE,
    message: TIMEOUT_MESSAGE,
    details: {
        errorClass: PROVIDER_TIMEOUT_CODE,
        url: CHAT_URL,
        port: 6660,
        phase: 'response-head',
        timeoutMs: 300_000
    }
};

const CONNECTION_FRAME: HarnessStreamEvent = {
    type: 'error',
    code: PROVIDER_CONNECTION_CODE,
    message: CONNECTION_MESSAGE,
    details: { errorClass: PROVIDER_CONNECTION_CODE, url: CHAT_URL, port: 6660, errno: 'ECONNREFUSED' }
};

// A frame with no machine code at all: the shape every unclassified provider failure has
// always had, and the regression guard for "passing the code through" not becoming
// "inventing a code".
const CODELESS_FRAME: HarnessStreamEvent = { type: 'error', message: CODELESS_MESSAGE };

// A transport that fails the SAME way on every attempt, counting the requests, so a test
// pins the attempt COUNT instead of sleeping through a ladder.
const alwaysFailing = (frame: HarnessStreamEvent, attempts: { value: number }): HarnessStream =>
    async function* stream() {
        attempts.value += 1;

        yield frame;
    };

/** A one-agent harness whose model request always answers `frame`. */
const failingHarness = (
    frame: HarnessStreamEvent,
    attempts: { value: number },
    // The agent's own retry policy. Left unset it is the shipped 1 + 10 ladder, whose
    // real 1 s..512 s waits a test has no reason to sit through; a bounded policy keeps
    // the assertion about the CODE instead of the clock.
    retry?: { maxRetries?: number; baseDelayMs?: number }
) => {
    const events: HarnessEvent[] = [];

    const writer = harness({
        agents: {
            writer: agent({
                model: 'm',
                stream: alwaysFailing(frame, attempts),
                ...(retry === undefined ? {} : { retry })
            })
        },
        presets: false,
        report: { progress: (event) => void events.push(event) }
    });

    return { writer, events };
};

/** Settles a failing run into its rejection, so both channels can be read. */
const rejectionOf = async (run: Promise<unknown>): Promise<unknown> => {
    try {
        await run;
    } catch (error) {
        return error;
    }

    throw new Error('Expected the run to fail, and it concluded.');
};

describe('run-level provider failures keep their machine code (T8, AC1)', () => {
    it('keeps `provider-timeout` on the rejection and on the terminal error event, after one request', async () => {
        const attempts = { value: 0 };
        const { writer, events } = failingHarness(TIMEOUT_FRAME, attempts);

        const failure = (await rejectionOf(writer('go'))) as HarnessError;

        // The caller-visible error keeps the class: `code` for a program, and `name`
        // (HarnessError sets it to the code) for a log line.
        expect(failure).toBeInstanceOf(HarnessError);
        expect(failure.code).toBe(PROVIDER_TIMEOUT_CODE);
        expect(failure.name).toBe(PROVIDER_TIMEOUT_CODE);
        // The message is preserved verbatim, not reworded into prose around the class.
        expect(failure.message).toBe(TIMEOUT_MESSAGE);

        // The event channel a UI and a durable record consume.
        expect(events.filter((event) => event.type === 'error')).toEqual([
            {
                type: 'error',
                agent: 'writer',
                error: { message: TIMEOUT_MESSAGE, code: PROVIDER_TIMEOUT_CODE }
            }
        ]);

        // A missed bound is terminal: ONE request, and no `retry` frame — which is also
        // what keeps a run that died this way out of `retries-exhausted`.
        expect(attempts.value).toBe(1);
        expect(events.filter((event) => event.type === 'retry')).toEqual([]);
    });

    it('keeps `provider-connection` after that class\u2019s capped 3 attempts, with its two short retries', async () => {
        const attempts = { value: 0 };
        const { writer, events } = failingHarness(CONNECTION_FRAME, attempts);

        const failure = (await rejectionOf(writer('go'))) as HarnessError;

        expect(failure.code).toBe(PROVIDER_CONNECTION_CODE);
        expect(failure.message).toBe(CONNECTION_MESSAGE);

        expect(events.filter((event) => event.type === 'error')).toEqual([
            {
                type: 'error',
                agent: 'writer',
                error: { message: CONNECTION_MESSAGE, code: PROVIDER_CONNECTION_CODE }
            }
        ]);

        // The capped ladder (core/agent-limits.ts), reported with the class's own total.
        expect(attempts.value).toBe(3);
        expect(
            events
                .filter((event) => event.type === 'retry')
                .map((event) => (event.type === 'retry' ? { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs } : event))
        ).toEqual([
            { attempt: 1, maxAttempts: 3, delayMs: 250 },
            { attempt: 2, maxAttempts: 3, delayMs: 500 }
        ]);
    });

    it('still reports an unclassified frame with no code key at all (AC5)', async () => {
        const attempts = { value: 0 };
        // A bounded policy: the CODELESS shape is the subject, and the shipped ladder
        // would spend real 1 s and 2 s waits proving nothing about this contract.
        const { writer, events } = failingHarness(CODELESS_FRAME, attempts, { maxRetries: 1, baseDelayMs: 1 });

        const failure = (await rejectionOf(writer('go'))) as HarnessError;

        expect(failure).toBeInstanceOf(HarnessError);
        expect(failure.name).toBe('HarnessError');
        // Asserted as a VALUE, not as key absence: `HarnessError` DECLARES `code?: string`
        // (util/errors.ts), and with class fields defined that own key exists with the
        // value `undefined` on every instance — the pre-T8 error looked the same way. The
        // contract is that no class was attached, which is `code === undefined` plus
        // `name === 'HarnessError'`; the WIRE payload below is where key absence is real.
        expect(failure.code).toBeUndefined();
        expect(failure.message).toBe(CODELESS_MESSAGE);
        // An unclassified frame still gets the ladder it has always had (two attempts
        // under this policy): keeping the code out of a codeless failure did not make it
        // terminal, which is the AC5 half of item 3.
        expect(attempts.value).toBe(2);
        expect(events.filter((event) => event.type === 'retry')).toHaveLength(1);

        const [errorEvent] = events.filter((event) => event.type === 'error');

        expect(errorEvent).toEqual({ type: 'error', agent: 'writer', error: { message: CODELESS_MESSAGE } });
        expect((errorEvent as { error: Record<string, unknown> }).error).not.toHaveProperty('code');
    });

    it('keeps `provider-rejected` end-to-end for a deterministic refusal (T8, AC3)', async () => {
        const REJECTED_MESSAGE =
            'provider-rejected: the provider answered ' +
            `${CHAT_URL} with HTTP 401 and refused the request, so re-sending the same bytes would be refused ` +
            'again — this turn failed after one attempt instead of waiting out the retry ladder.';

        const attempts = { value: 0 };
        const { writer, events } = failingHarness(
            { type: 'error', code: PROVIDER_REJECTED_CODE, message: REJECTED_MESSAGE },
            attempts
        );

        const failure = (await rejectionOf(writer('go'))) as HarnessError;

        expect(failure.code).toBe(PROVIDER_REJECTED_CODE);
        expect(attempts.value).toBe(1);
        expect(events.filter((event) => event.type === 'retry')).toEqual([]);
        expect(events.filter((event) => event.type === 'error')).toEqual([
            { type: 'error', agent: 'writer', error: { message: REJECTED_MESSAGE, code: PROVIDER_REJECTED_CODE } }
        ]);
    });
});

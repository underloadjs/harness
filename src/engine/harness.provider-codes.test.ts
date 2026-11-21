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
//   - the retry bookkeeping, which changed on 2026-11-17 (the unrecoverable-timeout
//     report — this file used to pin the opposite of it): a `provider-timeout` is NOT
//     terminal. It walks its own bounded ladder — 4 attempts, waits 2 s / 4 s / 8 s
//     (`core/agent-limits.ts`) — so a run that dies on a bound HAS spent retries by the
//     time it fails. A `provider-connection` keeps that class's capped 3 attempts with its
//     two short retries (250 ms, 500 ms). The flag behind `retries-exhausted`
//     (`run.sawRetryFrame`) is still set by the `retry` FRAME, which none of this touches,
//     and it is the carried `code` — not the ladder — that lets `classifyRunStopReason`
//     (src/harness.ts) report such a death as the `provider-network` stop reason;
//   - the terminal `error` EVENT also carries the transport's diagnosis as `error.provider`
//     (2026-11-17, same report), so a UI, a journal row and the session layer read the
//     class, the endpoint, the expired bound and the errno as FIELDS instead of parsing
//     them back out of the sentence. It is an echo of the frame's own `details` —
//     `providerDiagnosticsOf` (transport/provider-timeouts.ts) publishes only what the
//     attempt actually reported, so a connection death carries no `phase`/`timeoutMs`
//     (nothing answered the dial, so no bound expired) and a frame that carried no
//     `details` at all gains no `provider` key.
//
// WHY ONE TEST FAKES THE CLOCK: the `provider-timeout` ladder's waits have a 2 s FLOOR by
// design, so its three retries cost 14 s of real time — longer than this package's
// 15 s test timeout allows for comfort. `presets: false` leaves the run no other timer, so
// `vi.runAllTimersAsync()` drives that backoff in microseconds. The millisecond-exact ladder
// shape is pinned in src/core/agent.provider-failures.test.ts; the connection ladder's
// 750 ms stays on the real clock.
//
// Run: yarn vitest run src/harness.provider-codes.test.ts

import { describe, expect, it, vi } from 'vitest';
import {
    agent,
    harness,
    HarnessError,
    PROVIDER_CONNECTION_CODE,
    PROVIDER_REJECTED_CODE,
    PROVIDER_TIMEOUT_CODE
} from './index';
import type { HarnessEvent, HarnessStream, HarnessStreamEvent } from './index';

const CHAT_URL = 'http://localhost:8800/providers/private/v1/chat/completions';

// The exact frame texts the transport produces (transport/provider-timeouts.ts). They
// are pinned verbatim here because AC1 is about the CODE travelling with them, and a
// message that silently changed would otherwise hide in a code-only assertion.
const TIMEOUT_MESSAGE =
    'provider-timeout: the provider accepted the TCP connection at localhost:8800 but sent no response for 300 seconds.';

const CONNECTION_MESSAGE =
    'provider-connection: nothing answered on localhost:8800 — the request was dialled to ' +
    `${CHAT_URL}. ECONNREFUSED (connect ECONNREFUSED 127.0.0.1:8800).`;

const CODELESS_MESSAGE = 'HTTP 418: I am a teapot';

const TIMEOUT_FRAME: HarnessStreamEvent = {
    type: 'error',
    code: PROVIDER_TIMEOUT_CODE,
    message: TIMEOUT_MESSAGE,
    details: {
        errorClass: PROVIDER_TIMEOUT_CODE,
        url: CHAT_URL,
        port: 8800,
        phase: 'response-head',
        timeoutMs: 300_000
    }
};

const CONNECTION_FRAME: HarnessStreamEvent = {
    type: 'error',
    code: PROVIDER_CONNECTION_CODE,
    message: CONNECTION_MESSAGE,
    details: { errorClass: PROVIDER_CONNECTION_CODE, url: CHAT_URL, port: 8800, errno: 'ECONNREFUSED' }
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

// Sentinel: the run concluded instead of rejecting. A unique symbol so it can never collide
// with a value a run could legitimately resolve to.
const NO_REJECTION = Symbol('no-rejection');

/**
 * Settles a failing run into its rejection, so both channels can be read.
 *
 * The handler is attached FIRST, before anything is awaited. `writer('go')` is already a
 * live promise when this helper receives it, and under a faked clock its rejection lands
 * while the pump below is still running — a rejected promise with no handler attached yet is
 * what Node reports as an unhandled rejection, which vitest counts as a run-level error even
 * though the test itself asserts the failure.
 *
 * `pump` drives that FAKED clock from outside the run: the backoff timer is armed INSIDE the
 * agent's retry loop, so a test that fakes timers has to release each timer as the run arms
 * it — `vi.runAllTimersAsync()` keeps draining timers created while it unwinds, which is
 * what lets a 2 s / 4 s / 8 s ladder finish in microseconds. Without it the awaited run
 * would sleep forever, because no real clock is running to fire the wait.
 */
const rejectionOf = async (run: Promise<unknown>, pump = false): Promise<unknown> => {
    const settled: Promise<unknown> = run.then(
        () => NO_REJECTION,
        (error: unknown) => error
    );

    if (pump) await vi.runAllTimersAsync();

    const result = await settled;

    if (result === NO_REJECTION) throw new Error('Expected the run to fail, and it concluded.');

    return result;
};

describe('run-level provider failures keep their machine code (T8, AC1)', () => {
    it('keeps `provider-timeout` on the rejection and on the terminal error event, after that class\u2019s 4 attempts', async () => {
        const attempts = { value: 0 };
        const { writer, events } = failingHarness(TIMEOUT_FRAME, attempts);

        // Faked clock: the class's own 2 s / 4 s / 8 s waits (see the header). The run is
        // started INSIDE the fake-timer block, because the backoff timer is armed by the run.
        vi.useFakeTimers();

        try {
            const failure = (await rejectionOf(writer('go'), true)) as HarnessError;

            // The caller-visible error keeps the class: `code` for a program, and `name`
            // (HarnessError sets it to the code) for a log line.
            expect(failure).toBeInstanceOf(HarnessError);
            expect(failure.code).toBe(PROVIDER_TIMEOUT_CODE);
            expect(failure.name).toBe(PROVIDER_TIMEOUT_CODE);
            // The message is preserved verbatim, not reworded into prose around the class.
            expect(failure.message).toBe(TIMEOUT_MESSAGE);

            // The event channel a UI and a durable record consume: the code, and the
            // transport's diagnosis as FIELDS (`provider`), which is the whole point of the
            // 2026-11-17 change — `phase`/`timeoutMs` name the leg that stalled and the bound
            // that expired (300 s, the figure the sentence states), `url`/`port` the endpoint.
            expect(events.filter((event) => event.type === 'error')).toEqual([
                {
                    type: 'error',
                    agent: 'writer',
                    error: {
                        message: TIMEOUT_MESSAGE,
                        code: PROVIDER_TIMEOUT_CODE,
                        provider: {
                            errorClass: PROVIDER_TIMEOUT_CODE,
                            url: CHAT_URL,
                            port: 8800,
                            phase: 'response-head',
                            timeoutMs: 300_000
                        }
                    }
                }
            ]);

            // A missed bound is no longer terminal: FOUR requests (the initial one plus the
            // class's three retries — the transient ladder's count does not stretch it), each
            // failure reported as a `retry` frame with the class's own total.
            expect(attempts.value).toBe(4);
            expect(
                events
                    .filter((event) => event.type === 'retry')
                    .map((event) =>
                        event.type === 'retry'
                            ? { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs }
                            : event
                    )
            ).toEqual([
                { attempt: 1, maxAttempts: 4, delayMs: 2_000 },
                { attempt: 2, maxAttempts: 4, delayMs: 4_000 },
                { attempt: 3, maxAttempts: 4, delayMs: 8_000 }
            ]);
        } finally {
            vi.useRealTimers();
        }
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
                error: {
                    message: CONNECTION_MESSAGE,
                    code: PROVIDER_CONNECTION_CODE,
                    // The connection diagnosis, and NOTHING MORE: no `phase` and no
                    // `timeoutMs`, because nothing answered the dial and no local bound
                    // expired — inventing either would be a detail the transport never had.
                    // `errno` is the actionable fact (ECONNREFUSED = nothing is listening on
                    // that port) and `url`/`port` the endpoint that refused it.
                    provider: {
                        errorClass: PROVIDER_CONNECTION_CODE,
                        url: CHAT_URL,
                        port: 8800,
                        errno: 'ECONNREFUSED'
                    }
                }
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

        // The AC5 guard doubles as the guard on the new `provider` field: an unclassified
        // frame reported no diagnosis, so it gains neither a `code` nor a `provider` key —
        // the payload is byte-identical to what every pre-change session persisted.
        expect(errorEvent).toEqual({ type: 'error', agent: 'writer', error: { message: CODELESS_MESSAGE } });
        expect((errorEvent as { error: Record<string, unknown> }).error).not.toHaveProperty('code');
        expect((errorEvent as { error: Record<string, unknown> }).error).not.toHaveProperty('provider');
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

    it('carries the refusal\u2019s own diagnosis on the terminal record, and nothing the attempt did not report', async () => {
        // The refusal frame the built-in transport ACTUALLY writes (transport/openai.ts, via
        // providerWireFailureOf) carries `details`, so its terminal record carries the class,
        // the endpoint and the port — and no `phase`, `timeoutMs` or `errno`, none of which a
        // 401 has. Together with the codeless case above, these three pins are the per-class
        // field discipline: the payload is an echo of the attempt, never a fabrication.
        const attempts = { value: 0 };
        const { writer, events } = failingHarness(
            {
                type: 'error',
                code: PROVIDER_REJECTED_CODE,
                message:
                    'provider-rejected: the provider answered with HTTP 401 and refused the request, so ' +
                    're-sending the same bytes would be refused again.',
                details: { errorClass: PROVIDER_REJECTED_CODE, url: CHAT_URL, port: 8800 }
            },
            attempts
        );

        const failure = (await rejectionOf(writer('go'))) as HarnessError;

        expect(failure.code).toBe(PROVIDER_REJECTED_CODE);
        expect(attempts.value).toBe(1);
        expect(events.filter((event) => event.type === 'retry')).toEqual([]);
        expect(events.filter((event) => event.type === 'error')).toEqual([
            {
                type: 'error',
                agent: 'writer',
                error: {
                    message:
                        'provider-rejected: the provider answered with HTTP 401 and refused the request, so ' +
                        're-sending the same bytes would be refused again.',
                    code: PROVIDER_REJECTED_CODE,
                    provider: { errorClass: PROVIDER_REJECTED_CODE, url: CHAT_URL, port: 8800 }
                }
            }
        ]);
    });
});

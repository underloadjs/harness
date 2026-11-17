// harness.ts — the run-stop reason for a NETWORK failure, and the structured terminal
// error record (2026-11-17, the unrecoverable-timeout report).
//
// WHAT THIS PINS, in the words of the report that asked for it: "when upstream timeout at
// 120 second, the thread stopped without retry… the thread must continue and auto recover
// in all scenarios". Two of the four fixes are observable HERE, at the run boundary, and
// the session layer (a different task) builds directly on them — this is Contract D:
//
//   1. `HarnessRunStopReason` gains `'provider-network'`, emitted by
//      `classifyRunStopReason` when the failure that ended the run is a network /
//      provider-transit class. The rule, verbatim:
//        (a) the failure's machine code is `provider-timeout` or `provider-connection`,
//            whether or not a retry was spent; OR
//        (b) the failure is CODELESS and the transport diagnosed the dying bytes as
//            `provider-transit` — the retry ladder no longer has to be exhausted,
//            because the first upstream attempt of a run is itself the whole ladder
//            when `retry.maxRetries === 0` (a 0-retry transit break must be resumable
//            by the session layer, not filed under `api-error`).
//      `retries-exhausted` still covers every NON-network exhausted ladder, and
//      `api-error` still covers a first-attempt failure that is not network-classed.
//   2. the terminal `error` event carries `code` and the transport's `provider`
//      diagnostics, so a UI, a journal row and the session layer read fields instead of
//      reconstructing class, endpoint and bound from the sentence with a regex.
//
// The restart policy is NOT part of this change: such a run is still marked interrupted
// and never replayed on its own.
//
// WHY FAKE TIMERS EVERYWHERE HERE: the `provider-timeout` ladder's waits have a 2 s FLOOR
// (`PROVIDER_TIMEOUT_RETRY_BASE_DELAY_MS`) by design, so its three retries cost 14 s of
// real clock — and the harness's run loop touches no other timer once `presets: false`
// removes the shipped plugins, which is what lets `vi.runAllTimersAsync()` drive the whole
// backoff in microseconds. The millisecond-exact ladder shape is pinned in
// src/core/agent.provider-failures.test.ts; this file pins the RUN-LEVEL consequences.
//
// Run: yarn vitest run src/harness.provider-network-stop.test.ts

import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent, harness } from '@underload/harness';
import type { HarnessEvent, HarnessStream, HarnessStreamEvent } from '@underload/harness';
// T-W8: the error frame's thread identity now names the minting process (./core/agent-limits.ts
// `HARNESS_PROCESS_EPOCH`, stamped at the run-identity mints in ./harness.ts). The constant, not
// a literal — the value is random by design — and exact within one file, because vitest gives
// one module registry per test file.
import { HARNESS_PROCESS_EPOCH } from './core/agent-limits';

const CHAT_URL = 'http://localhost:6660/providers/private/v1/chat/completions';

// The reported failure, as the transport publishes it: 526 chunks arrived, then the
// gateway sat on its 120 s chunk bound. Before 2026-11-17 this frame arrived CODELESS
// (the gateway's own `code: "timeout"` was dropped by the transport) and the run died as
// `api-error` with no retry at all.
const TIMEOUT_FRAME: HarnessStreamEvent = {
    type: 'error',
    code: 'provider-timeout',
    message:
        'provider-timeout: the provider delivered 526 body chunk(s) from localhost:6660 and then went ' +
        'silent for 120 seconds. Nothing ended the wait earlier, so the turn is now failed instead of ' +
        'running forever. The stream from http://localhost:6660/providers/private/v1/chat/completions is ' +
        'unfinished, so whatever arrived is a partial answer and is discarded.',
    details: {
        errorClass: 'provider-timeout',
        url: CHAT_URL,
        port: 6660,
        phase: 'stream-chunk',
        timeoutMs: 120_000
    }
};

// The gateway's `connection` answer, as the transport publishes it.
const CONNECTION_FRAME: HarnessStreamEvent = {
    type: 'error',
    code: 'provider-connection',
    message: 'provider-connection: nothing answered on localhost:6660.',
    details: { errorClass: 'provider-connection', url: CHAT_URL, port: 6660, errno: 'ECONNREFUSED' }
};

// A gateway error frame with an unknown/absent code, and a body that closed mid-answer,
// both land here: CODELESS (the generic ladder) with the `provider-transit` diagnosis.
const TRANSIT_FRAME: HarnessStreamEvent = {
    type: 'error',
    message: 'Upstream stream terminated',
    details: { errorClass: 'provider-transit', url: CHAT_URL, port: 6660 }
};

// A provider answer that is NOT a network death: an HTTP 5xx body. Codeless AND without
// the transit diagnosis, so its exhausted ladder keeps `retries-exhausted` exactly as
// before this change.
const OVERLOADED_FRAME: HarnessStreamEvent = { type: 'error', message: 'HTTP 500: overloaded' };

// A deterministic refusal: about the request, not the wire. Terminal on one attempt.
const REJECTED_FRAME: HarnessStreamEvent = {
    type: 'error',
    code: 'provider-rejected',
    message: 'provider-rejected: the provider answered with HTTP 401 and refused the request.'
};

const alwaysFailing = (frame: HarnessStreamEvent): HarnessStream =>
    async function* stream() {
        yield frame;
    };

// Drives one failing run and reports what a caller and a UI can actually observe: the
// events the run emitted (the terminal `error` frame included) and the thread record's
// machine-readable stop reason.
const runFailing = async (
    frame: HarnessStreamEvent,
    retry?: false | { maxRetries?: number; baseDelayMs?: number }
): Promise<{ events: HarnessEvent[]; stopReason: string | undefined }> => {
    const events: HarnessEvent[] = [];

    vi.useFakeTimers();

    try {
        const writer = harness({
            agents: {
                writer: agent({
                    model: 'local/basalt',
                    stream: alwaysFailing(frame),
                    // `retry: false` is the explicit opt-out (one attempt for every class);
                    // the ladder cases pass a narrow budget so only the CLASS's own waits run.
                    ...(retry === undefined ? {} : { retry })
                })
            },
            presets: false,
            report: { progress: (event: HarnessEvent) => void events.push(event) }
        });

        const thread = writer.createThread('writer', { label: 'Network' });

        // The run is started BEFORE the clock is advanced: the backoff timer is armed
        // inside the run, so `runAllTimersAsync` is what releases each attempt.
        const settled = writer.sendThreadInput(thread.id, 'go').catch(() => undefined);

        await vi.runAllTimersAsync();
        await settled;

        return { events, stopReason: writer.thread(thread.id)?.stopReason };
    } finally {
        vi.useRealTimers();
    }
};

const retryShape = (events: HarnessEvent[]) =>
    events
        .filter((event) => event.type === 'retry')
        .map((event) =>
            event.type === 'retry'
                ? { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs }
                : null
        );

describe('run stop reason for a network failure (Contract D)', () => {
    it('stamps provider-network for a provider-timeout with no retries configured, and names the class on the error record', async () => {
        const { events, stopReason } = await runFailing(TIMEOUT_FRAME, false);

        // The reported defect persisted as `api-error`, which conflates a
        // terminal-by-design timeout with a first-attempt transient. It is now its own
        // network class — the fact the session layer counts against its threshold.
        expect(stopReason).toBe('provider-network');

        // `retry: false` is a hard opt-out: one attempt, so no retry frames at all.
        expect(retryShape(events)).toEqual([]);

        expect(events.at(-1)).toEqual({
            type: 'error',
            agent: 'writer',
            // A thread run's frames carry the thread IDENTITY only (no `agent`/`input` —
            // harness.ts `threadIdentity`), which is the shape the journal records.
            // T-W8: that identity now also names the minting PROCESS (`HarnessThread.epoch`), so
            // a journal id recycled by a restarted runtime cannot be mistaken for the run it
            // used to name (./server/turn-projector.ts `isEpochBoundary`). Exact, because the run
            // executed in this process: one module registry, hence one epoch, per test file.
            thread: { id: expect.any(String), epoch: HARNESS_PROCESS_EPOCH },
            error: {
                message: TIMEOUT_FRAME.message,
                code: 'provider-timeout',
                provider: {
                    errorClass: 'provider-timeout',
                    url: CHAT_URL,
                    port: 6660,
                    phase: 'stream-chunk',
                    timeoutMs: 120_000
                }
            }
        });
    });

    it('stamps provider-network for a provider-timeout whose bounded ladder was exhausted, after the class ladder', async () => {
        // `maxRetries: 3` with a 1 ms base is deliberately NOT the ladder's shape: the
        // class owns it (4 attempts, 2 s / 4 s / 8 s), so a host that asked for three
        // 1 ms retries gets the documented provider waits instead.
        const { events, stopReason } = await runFailing(TIMEOUT_FRAME, { maxRetries: 3, baseDelayMs: 1 });

        expect(stopReason).toBe('provider-network');

        expect(retryShape(events)).toEqual([
            { attempt: 1, maxAttempts: 4, delayMs: 2_000 },
            { attempt: 2, maxAttempts: 4, delayMs: 4_000 },
            { attempt: 3, maxAttempts: 4, delayMs: 8_000 }
        ]);

        // The terminal record still carries the class and the diagnosis, so a UI can say
        // "the provider timed out, 4 attempts" after the ladder gave up.
        expect(events.at(-1)).toMatchObject({
            type: 'error',
            error: { code: 'provider-timeout', provider: { errorClass: 'provider-timeout' } }
        });
    });

    it('stamps provider-network for a codeless provider-transit failure whose ladder was exhausted', async () => {
        const { events, stopReason } = await runFailing(TRANSIT_FRAME, { maxRetries: 1, baseDelayMs: 1 });

        expect(stopReason).toBe('provider-network');

        // The TRANSIENT ladder for this class (not a class of its own): 1 + 1 attempts,
        // the configured 1 ms base.
        expect(retryShape(events)).toEqual([{ attempt: 1, maxAttempts: 2, delayMs: 1 }]);

        expect(events.at(-1)).toMatchObject({
            type: 'error',
            // No `code`: the transit class has no retry policy of its own, so inventing
            // one here would promise something the agent does not do.
            error: { message: 'Upstream stream terminated', provider: { errorClass: 'provider-transit' } }
        });
    });

    it('stamps provider-network for a FIRST-attempt transit failure: zero retries spent, network all the same', async () => {
        const { events, stopReason } = await runFailing(TRANSIT_FRAME, false);

        // 2026-11-17 (accepted): the earlier rule demanded a spent retry frame as proof the
        // endpoint was unhealthy, so a transit frame that killed the first attempt persisted as
        // `api-error` — no streak, no auto-resume, the reported defect still unrecovered. The
        // transport's `provider-transit` diagnosis IS the evidence, so the classification does not
        // wait for a ladder.
        expect(stopReason).toBe('provider-network');

        // `retry: false` is still a hard opt-out: one attempt, no retry frames. The classification
        // changed; the retry policy did not.
        expect(retryShape(events)).toEqual([]);

        expect(events.at(-1)).toMatchObject({
            type: 'error',
            error: { message: 'Upstream stream terminated', provider: { errorClass: 'provider-transit' } }
        });
    });

    it('keeps api-error for a codeless failure the transport did NOT diagnose as dying in transit', async () => {
        // The isolation that keeps `api-error` meaningful: the failure is codeless AND carries no
        // `provider-transit` class. An HTTP 5xx body is the provider answering about a request, and
        // one attempt spent or not, it is not a network death.
        const { stopReason } = await runFailing(OVERLOADED_FRAME, false);

        expect(stopReason).toBe('api-error');
    });

    it('keeps retries-exhausted for a NON-network exhausted ladder (an HTTP 500 body)', async () => {
        const { stopReason } = await runFailing(OVERLOADED_FRAME, { maxRetries: 1, baseDelayMs: 1 });

        // The old value survives for everything that is not a named network class, so a
        // consumer that already branches on it sees exactly what it saw before.
        expect(stopReason).toBe('retries-exhausted');
    });

    it('keeps api-error for a deterministic refusal, which is about the request, not the wire', async () => {
        const { stopReason } = await runFailing(REJECTED_FRAME, false);

        expect(stopReason).toBe('api-error');
    });

    it('stamps provider-network for a provider-connection failure too', async () => {
        const { stopReason } = await runFailing(CONNECTION_FRAME, false);

        expect(stopReason).toBe('provider-network');
    });
});

// The historical shape: `harness.ts` has always emitted `{ message, code? }`, and a
// session saved before this change has neither `code` nor `provider` on a terminal
// record. The UI must still render those, which is what the fallback path in
// frontend/provider-diagnostics.ts is for.
describe('historical records still carry only prose', () => {
    it('a failure with no class yields an error record with only a message', async () => {
        const { events } = await runFailing(OVERLOADED_FRAME, false);

        expect(events.at(-1)).toMatchObject({
            type: 'error',
            error: { message: 'HTTP 500: overloaded' }
        });

        // Neither key is PRESENT — the payload is byte-identical to what a pre-change
        // session persisted.
        const error = (events.at(-1) as { error: Record<string, unknown> }).error;

        expect(Object.keys(error)).toEqual(['message']);
    });
});

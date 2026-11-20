// transport/openai.ts — the T6 provider time bounds and failure classes.
//
// Pinned contract (the pre-T6 behaviour was the DEFECT, so every expectation here is
// written from the required behaviour, not from an observed output):
//   - a provider that accepts the TCP connection and never returns a response HEAD
//     fails TERMINALLY at the head bound (AC1);
//   - an SSE body that opens and then stops delivering fails TERMINALLY, at the
//     first-token bound when nothing arrived and at the inter-chunk bound once the
//     stream was flowing (AC1);
//   - a refused connection / failed name resolution is CLASSIFIED (`provider-
//     connection`) and the frame names the dialled host:port, which is the answer to
//     "is it dialling 5500 or 8800?" (AC2);
//   - a TIME-fixable 4xx/5xx keeps the byte-for-byte historical frame: no code, no
//     details (AC3). T8 deliberately moved only the DETERMINISTIC refusals
//     (400/401/403/404) into their own class — see ./openai.provider-rejected.test.ts;
//   - a caller stop keeps the byte-for-byte historical frame too — `Request to <url>
//     failed: <reason>` — and a bound that is still armed must not claim the failure
//     (AC5);
//   - `0` on a bound disables THAT bound, restoring the pre-T6 wait (AC4);
//   - every frame carries the redacted dial target (no API key, no query string).
//
// Timers are faked with `toFake` narrowed to timers only, so `queueMicrotask` (which
// Node's ReadableStream machinery uses) stays real and the stream still pumps.
//
// Run: yarn vitest run src/transport/openai.provider-timeouts.test.ts

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    PROVIDER_CONNECTION_CODE,
    PROVIDER_REJECTED_CODE,
    PROVIDER_TIMEOUT_CODE,
    DEFAULT_PROVIDER_FIRST_TOKEN_TIMEOUT_MS,
    DEFAULT_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS,
    DEFAULT_PROVIDER_STREAM_CHUNK_TIMEOUT_MS,
    HarnessError,
    openAICompatible,
    resolveProviderTimeout
} from '@underload/harness';
import type { HarnessStream, HarnessStreamEvent } from '@underload/harness';

const BASE_URL = 'http://localhost:8800/providers/private/v1';
const CHAT_URL = 'http://localhost:8800/providers/private/v1/chat/completions';

const request = {
    model: 'local/basalt',
    messages: [{ role: 'user' as const, content: 'Write' }]
};

// Timers only: a fake `queueMicrotask` or `nextTick` would strand the stream pumps.
const fakeTimers = () =>
    vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'Date']
    });

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

// A body that enqueues `frames` and then NEVER closes: the exact shape of a provider
// that opened the stream and stopped delivering.
const hangingBody = (frames: string[]): ReadableStream<Uint8Array> => {
    const encoder = new TextEncoder();

    return new ReadableStream({
        start(controller) {
            for (const frame of frames) controller.enqueue(encoder.encode(frame));
        }
    });
};

const sse = (delta: string): string =>
    `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`;

// One attempt, driven by hand: `pending()` returns the promise for the NEXT event
// without awaiting it, so a fake-timer advance can fire the bound while the transport
// is parked on its read.
const drive = (stream: HarnessStream, signal?: AbortSignal) => {
    const iterator = stream({ ...request, ...(signal === undefined ? {} : { signal }) })[Symbol.asyncIterator]();
    const events: HarnessStreamEvent[] = [];

    let settled = false;

    const pending = (): Promise<IteratorResult<HarnessStreamEvent>> => {
        settled = false;

        const next = iterator.next().then((result) => {
            settled = true;

            return result;
        });

        // Nobody is watching if the test only advances timers; a rejection must not
        // become an unhandled one, and each test awaits the promise explicitly.
        next.catch(() => {});

        return next;
    };

    const isSettled = (): boolean => settled;
    const close = (): Promise<unknown> => iterator.return?.(undefined) ?? Promise.resolve();

    return { events, pending, isSettled, close, collect: (): Promise<HarnessStreamEvent[]> => collectAll(iterator, events) };
};

const collectAll = async (
    iterator: AsyncIterator<HarnessStreamEvent>,
    events: HarnessStreamEvent[]
): Promise<HarnessStreamEvent[]> => {
    for (;;) {
        const next = await iterator.next();
        if (next.done === true) return events;
        events.push(next.value);
    }
};

// The three documented sentences, spelled out so the operator-facing wording is a
// pinned contract (a UI renders them verbatim).
const headMessage = (seconds: number, variable: string): string =>
    `provider-timeout: the provider accepted the TCP connection at localhost:8800 but sent no response for ${seconds} seconds. ` +
    'Nothing ended the wait earlier, so the turn is now failed instead of running forever. The request was sent, ' +
    `so it may still be running on the provider. Raise \`${variable}\` (or set it to 0 to disable the bound) if ` +
    'this endpoint legitimately needs longer.';

describe('provider time bounds (T6)', () => {
    it('fails terminally when a provider accepts the connection but never returns a response head', async () => {
        fakeTimers();

        // A socket that opens and says nothing: `fetch` never resolves.
        vi.stubGlobal(
            'fetch',
            vi.fn(() => new Promise<Response>(() => {}))
        );

        const stream = openAICompatible({
            baseURL: BASE_URL,
            apiKey: 'super-secret-key',
            responseHeadTimeoutMs: 2_000
        });

        const attempt = drive(stream);
        const pending = attempt.pending();

        await vi.advanceTimersByTimeAsync(1_999);
        expect(attempt.isSettled()).toBe(false);

        await vi.advanceTimersByTimeAsync(1);

        const first = await pending;

        expect(first).toEqual({
            done: false,
            value: {
                type: 'error',
                code: PROVIDER_TIMEOUT_CODE,
                message: headMessage(2, 'HARNESS_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS'),
                details: {
                    errorClass: PROVIDER_TIMEOUT_CODE,
                    url: CHAT_URL,
                    port: 8800,
                    phase: 'response-head',
                    timeoutMs: 2_000
                }
            }
        });

        // TERMINAL: the frame is followed by the generator closing, so the turn
        // reaches an end state instead of staying `running` forever (AC1).
        expect(await attempt.pending()).toEqual({ done: true, value: undefined });
    });

    it('fails terminally when an SSE body opens and then never produces a token', async () => {
        fakeTimers();

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(hangingBody([]), { status: 200 }))
        );

        const stream = openAICompatible({ baseURL: BASE_URL, firstTokenTimeoutMs: 3_000 });
        const attempt = drive(stream);
        const pending = attempt.pending();

        await vi.advanceTimersByTimeAsync(3_000);

        const first = await pending;

        expect(first.done).toBe(false);
        expect(first.value).toMatchObject({
            type: 'error',
            code: PROVIDER_TIMEOUT_CODE,
            details: {
                errorClass: PROVIDER_TIMEOUT_CODE,
                url: CHAT_URL,
                port: 8800,
                phase: 'first-token',
                timeoutMs: 3_000
            }
        });

        expect(String((first.value as Extract<HarnessStreamEvent, { type: 'error' }>).message)).toContain(
            'provider-timeout: the provider opened the stream from localhost:8800 but sent no token for 3 seconds'
        );
        expect(await attempt.pending()).toEqual({ done: true, value: undefined });
    });

    it('fails terminally when an established stream goes silent between chunks', async () => {
        fakeTimers();

        // One delta arrives, then the body stops: pre-T6 this left `reader.read()`
        // pending forever and the UI kept its spinner.
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(hangingBody([sse('partial')]), { status: 200 }))
        );

        const stream = openAICompatible({ baseURL: BASE_URL, streamChunkTimeoutMs: 2_000 });
        const attempt = drive(stream);

        // The delta that did arrive is still surfaced, and the stall frame after it
        // says so (the partial answer is discarded by the caller, not committed).
        const text = await attempt.pending();
        expect(text).toEqual({ done: false, value: { type: 'text', delta: 'partial' } });

        const pending = attempt.pending();
        await vi.advanceTimersByTimeAsync(2_000);

        const stall = await pending;

        expect(stall.done).toBe(false);
        expect(stall.value).toMatchObject({
            type: 'error',
            code: PROVIDER_TIMEOUT_CODE,
            details: {
                errorClass: PROVIDER_TIMEOUT_CODE,
                url: CHAT_URL,
                port: 8800,
                phase: 'stream-chunk',
                timeoutMs: 2_000
            }
        });

        const message = String((stall.value as Extract<HarnessStreamEvent, { type: 'error' }>).message);
        expect(message).toContain('delivered 1 body chunk(s) from localhost:8800 and then went silent for 2 seconds');
        expect(message).toContain('whatever arrived is a partial answer and is discarded');
        expect(await attempt.pending()).toEqual({ done: true, value: undefined });
    });

    it('classifies a refused connection and names the dialled host and port', async () => {
        const refused = Object.assign(new TypeError('fetch failed'), {
            cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8800'), { code: 'ECONNREFUSED' })
        });

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw refused;
            })
        );

        const stream = openAICompatible({ baseURL: BASE_URL, apiKey: 'super-secret-key' });
        const collected: HarnessStreamEvent[] = [];

        for await (const event of stream(request)) collected.push(event);

        expect(collected).toHaveLength(1);
        expect(collected[0]).toEqual({
            type: 'error',
            code: PROVIDER_CONNECTION_CODE,
            message:
                'provider-connection: nothing answered on localhost:8800 — the request was dialled to ' +
                'http://localhost:8800/providers/private/v1/chat/completions. ECONNREFUSED (connect ECONNREFUSED ' +
                '127.0.0.1:8800). Check that the provider is running on that port and that the configured base URL ' +
                'is the one you meant. Set the per-session base URL (Endpoint & model) to the endpoint ' +
                'that is actually up; `HARNESS_BASE_URL` counts only when the session has no stored address.',
            details: {
                errorClass: PROVIDER_CONNECTION_CODE,
                url: CHAT_URL,
                port: 8800,
                errno: 'ECONNREFUSED'
            }
        });
    });

    it('classifies a name-resolution failure carried in an AggregateError', async () => {
        const dns = Object.assign(new TypeError('fetch failed'), {
            cause: Object.assign(
                new AggregateError([Object.assign(new Error('queryA EAI_AGAIN localhost'), { code: 'EAI_AGAIN' })], 'All queries failed'),
                { name: 'AggregateError [EAI_AGAIN]' }
            )
        });

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw dns;
            })
        );

        const stream = openAICompatible({ baseURL: BASE_URL });
        const collected: HarnessStreamEvent[] = [];

        for await (const event of stream(request)) collected.push(event);

        expect(collected).toHaveLength(1);
        expect(collected[0]).toMatchObject({
            type: 'error',
            code: PROVIDER_CONNECTION_CODE,
            details: { errorClass: PROVIDER_CONNECTION_CODE, url: CHAT_URL, port: 8800, errno: 'EAI_AGAIN' }
        });

        const message = String((collected[0] as Extract<HarnessStreamEvent, { type: 'error' }>).message);
        expect(message).toContain('nothing answered on localhost:8800');
        expect(message).toContain('EAI_AGAIN');
    });

    it('classes a 401 answer as a deterministic refusal (T8, AC3 moved this)', async () => {
        // This is the ONE expectation in this file that item 3 of T8 deliberately
        // changes. T6 pinned "an unclassified 4xx keeps the historical frame", and a 401
        // was the example; T8 classifies 400/401/403/404 precisely because a revoked key
        // otherwise spent the whole ladder and read like a hang. The guard T6 cared about
        // — TIME-fixable answers keep the historical frame — is now pinned by
        // ./openai.provider-rejected.test.ts (408/429/5xx/402/409) and by
        // ../core/agent.provider-rejected.test.ts (a codeless frame is still retried).
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('nope', { status: 401, statusText: 'Unauthorized' }))
        );

        const stream = openAICompatible({ baseURL: BASE_URL });
        const collected: HarnessStreamEvent[] = [];

        for await (const event of stream(request)) collected.push(event);

        expect(collected).toStrictEqual([
            {
                type: 'error',
                code: PROVIDER_REJECTED_CODE,
                message:
                    `provider-rejected: the provider answered ${CHAT_URL} with HTTP 401 and refused the request, ` +
                    'so re-sending the same bytes would be refused again — this turn failed after one attempt ' +
                    'instead of waiting out the retry ladder. The credential was refused: check the API key this ' +
                    'provider was configured with. The provider said: "nope"'
            }
        ]);
    });

    it('leaves a user stop mid-flight on the historical abort path, with a bound still armed', async () => {
        fakeTimers();

        const controller = new AbortController();

        // A body that streams one delta and then hangs, wired to the signal exactly
        // the way a real `fetch` body is: stopping ERRORS the body, so the pending
        // read rejects with the caller's reason. The transport must not relabel that
        // rejection as a timeout, and the still-armed bounds must not fire.
        vi.stubGlobal(
            'fetch',
            vi.fn((_url: string, init: RequestInit) => {
                const signal = init.signal as AbortSignal;

                const body = new ReadableStream<Uint8Array>({
                    start(streamController) {
                        streamController.enqueue(new TextEncoder().encode(sse('partial')));
                        signal.addEventListener(
                            'abort',
                            () => {
                                try {
                                    streamController.error(signal.reason ?? new Error('aborted'));
                                } catch {
                                    // Already errored or closed: the stop is in flight.
                                }
                            },
                            { once: true }
                        );
                    }
                });

                return Promise.resolve(new Response(body, { status: 200 }));
            })
        );

        const stream = openAICompatible({ baseURL: BASE_URL, streamChunkTimeoutMs: 30_000 });
        const attempt = drive(stream, controller.signal);

        const text = await attempt.pending();
        expect(text).toEqual({ done: false, value: { type: 'text', delta: 'partial' } });

        controller.abort(new Error('user stopped'));

        const pending = attempt.pending();
        await vi.advanceTimersByTimeAsync(30_000);

        // AC5: the rejection is the CALLER'S, untouched — no `provider-timeout` frame,
        // no error frame at all, so the agent's abort path still owns the outcome and
        // a cancelled run stays a control outcome rather than a retried failure.
        const reason = await pending.then(
            (result) => `resolved:${JSON.stringify(result)}`,
            (error: unknown) => (error as Error).message
        );

        expect(reason).toBe('user stopped');
    });

    it('disables a bound when it is 0, which is the escape hatch for a slower provider', async () => {
        fakeTimers();

        vi.stubGlobal(
            'fetch',
            vi.fn(() => new Promise<Response>(() => {}))
        );

        const stream = openAICompatible({
            baseURL: BASE_URL,
            responseHeadTimeoutMs: 0,
            firstTokenTimeoutMs: 0,
            streamChunkTimeoutMs: 0
        });

        const attempt = drive(stream);
        attempt.pending();

        await vi.advanceTimersByTimeAsync(DEFAULT_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS * 60);

        // Nothing fired and nothing was produced: an hour of fake clock on a request
        // still waiting for its head is the pre-T6 behaviour, on purpose.
        expect(attempt.isSettled()).toBe(false);
    });

    it('ships generous defaults and rejects a bound that is not an integer of milliseconds', () => {
        // AC4: the documented generous defaults, pinned as the declared contract.
        expect(DEFAULT_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS).toBe(300_000);
        expect(DEFAULT_PROVIDER_FIRST_TOKEN_TIMEOUT_MS).toBe(300_000);
        expect(DEFAULT_PROVIDER_STREAM_CHUNK_TIMEOUT_MS).toBe(120_000);

        // Env is the deployment knob, `0` is the opt-out, and nothing is coerced.
        expect(
            resolveProviderTimeout({
                variable: 'HARNESS_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS',
                fallback: DEFAULT_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS,
                env: { HARNESS_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS: '45000' }
            })
        ).toBe(45_000);

        expect(
            resolveProviderTimeout({
                variable: 'HARNESS_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS',
                fallback: DEFAULT_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS,
                env: { HARNESS_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS: '0' }
            })
        ).toBe(0);

        expect(() =>
            resolveProviderTimeout({
                variable: 'HARNESS_PROVIDER_STREAM_CHUNK_TIMEOUT_MS',
                fallback: DEFAULT_PROVIDER_STREAM_CHUNK_TIMEOUT_MS,
                env: { HARNESS_PROVIDER_STREAM_CHUNK_TIMEOUT_MS: '2m' }
            })
        ).toThrow(/HARNESS_PROVIDER_STREAM_CHUNK_TIMEOUT_MS must be an integer between 0 and 86400000/);

        // A provider-scoped typo names the FIELD the host wrote.
        expect(() =>
            resolveProviderTimeout({
                explicit: 1.5,
                variable: 'HARNESS_PROVIDER_FIRST_TOKEN_TIMEOUT_MS',
                fallback: DEFAULT_PROVIDER_FIRST_TOKEN_TIMEOUT_MS
            })
        ).toThrow(/`provider.firstTokenTimeoutMs`/);

        expect(() => openAICompatible({ baseURL: BASE_URL, responseHeadTimeoutMs: -1 })).toThrow(HarnessError);
    });
});

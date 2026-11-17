// transport/openai.ts + core/agent.ts — a context-length refusal that arrives on an
// SSE frame (the reported failure), classified and NOT retried.
//
// THE REPORTED DEFECT (2026-11-17). A run against the local gateway died with
//   `ERROR provider-transit: attempt 1..11 of 11 failed · retrying in Xs · Upstream stream
//    terminated · http://localhost:6660/providers/private/v1/chat/completions`
// — eleven attempts at the SAME bytes, ~3 minutes of backoff, and the compaction turn
// failed the same way. Two facts made it unfixable at the time:
//   1. the gateway commits `200 OK` + `text/event-stream` BEFORE it generates
//      (packages/underload/service/src/server/start.ts:286-288), so an upstream refusal
//      has no HTTP status left to wear — it can only be one error frame on the open
//      stream (:860-873);
//   2. the transport had ONE classifier for a refused RESPONSE (issue 0004: 413, or a
//      400 whose wording says "too long") and a DIFFERENT one for a frame
//      (`providerWireFailureOf`, wire `code`/`status` only). The same provider answer
//      therefore had two names: `context-overflow` (one attempt) and a codeless
//      `provider-transit` (all eleven).
//
// WHAT THIS FILE PINS
// -------------------
//   (i)   a 400 response whose body is a size refusal → `context-overflow` (unchanged,
//         now through the SHARED matcher `isContextOverflowSignal`);
//   (ii)  an in-stream frame carrying `upstream_status` + 400 + that wording →
//         `context-overflow` — the reported failure, classified;
//   (iii) an in-stream `unknown`/transit frame with NO overflow signal → still codeless
//         `provider-transit`, and the generic ladder is UNCHANGED (the eleven attempts
//         are still there for a failure that may heal);
//   (iv)  a classified overflow never walks the ladder: exactly ONE request at the
//         default 11-attempt policy, no `retry` event;
//   (v)   a non-overflow 400/401 refusal (bad key, bad param) is still terminal-fast.
//
// THE GATEWAY FINDING, pinned as a test rather than as prose (see the
// `Upstream stream terminated` cases below): the gateway's own message for its `unknown`
// class is the byte-frozen constant `Upstream stream terminated`
// (packages/underload/service/src/server/start.ts:341, kept deliberately for consumers
// that only ever string-matched it) and it attaches `status` ONLY to its
// `upstream_status` class (:660-668). So a frame in THAT shape carries no overflow
// signal at all, and no honest harness heuristic can name it. The wording is recoverable
// whenever the gateway DOES relay it — an upstream 400 whose body quotes the provider
// lands as `upstream_status` + `status: 400` + the provider's line, and both halves are
// matched here.
//
// The message text below is spelled out in full rather than matched loosely: a reworded
// frame is a contract change a test has to notice (the same rule
// ./openai.provider-wire-codes.test.ts follows).
//
// Run: yarn vitest run src/transport/openai.context-overflow.test.ts

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTEXT_OVERFLOW_CODE, agent, openAICompatible, providerWireFailureOf } from '@underload/harness';
import type { AgentStreamEvent, HarnessStreamEvent } from '@underload/harness';

const BASE_URL = 'http://localhost:6660/providers/private/v1';
const CHAT_URL = 'http://localhost:6660/providers/private/v1/chat/completions';

const request = {
    model: 'local/basalt',
    messages: [{ role: 'user' as const, content: 'Write' }]
};

// The provider's own line, quoted verbatim by OpenAI-compatible endpoints and relayed by
// the gateway. Its numbers are the actionable half, so they have to survive classification.
const PROVIDER_LINE =
    "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens";

// The gateway's byte-frozen sentence for the class NO rule can name. It quotes no status
// and no provider wording, and it is the sentence in the reported failure.
const GATEWAY_UNKNOWN_LINE = 'Upstream stream terminated';

// One closed body carrying a single `{"error":{…}}` frame — the whole shape under test.
const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

const streamBody = (text: string): ReadableStream<Uint8Array> => {
    const encoder = new TextEncoder();

    return new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(text));
            controller.close();
        }
    });
};

// A gateway frame on a COMMITTED 200 stream: headers flushed before generation, so this
// is the only shape the reported failure can reach us in.
const stubGatewayFrame = (error: Record<string, unknown>) => {
    const fetchMock = vi.fn(async () => new Response(streamBody(sse({ error })), { status: 200 }));

    vi.stubGlobal('fetch', fetchMock);

    return fetchMock;
};

// A plain non-2xx RESPONSE (no stream at all) — the pre-existing overflow path.
const stubResponseStatus = (status: number, body: string) => {
    const fetchMock = vi.fn(async () => new Response(streamBody(body), { status }));

    vi.stubGlobal('fetch', fetchMock);

    return fetchMock;
};

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
    const collected: T[] = [];

    for await (const event of events) collected.push(event);

    return collected;
};

const transportFrame = async (error: Record<string, unknown>): Promise<HarnessStreamEvent> => {
    stubGatewayFrame(error);

    const events = await collect(openAICompatible({ baseURL: BASE_URL })(request));

    // The error frame is TERMINAL for the attempt, so it is the only event.
    expect(events).toHaveLength(1);

    return events[0];
};

// The sentence `providerWireMessage` writes for an in-stream overflow: it LEADS with the
// code (that text is what reaches the model, an event consumer and a log line), states the
// status when the frame carried one, and names the two owners of the fix.
const overflowWireMessage = (statusPart: string, quoted: string): string =>
    'context-overflow: the provider reported a context-length refusal on the stream from ' +
    `${CHAT_URL}${statusPart}. The prompt does not fit the model's context window, so re-sending ` +
    'the same bytes would be refused again — this turn failed after one attempt instead of walking ' +
    'the retry ladder. Send less: a `turn.before` handler may replace the transcript, and the ' +
    `shipped context-compaction plugin does exactly that.${quoted}`;

const quotedProvider = (line: string): string => ` The provider said: "${line}"`;

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('in-stream context overflow (the reported failure)', () => {
    it('classifies an upstream_status 400 frame whose wording is a size refusal', async () => {
        // (ii) THE REPORTED FAILURE. `buildStreamErrorPayload` reports a definite upstream
        // status as `upstream_status` + `status` + the upstream's own line, so BOTH signal
        // halves are on the wire: the status gate and the wording. Before the shared
        // matcher this frame was `provider-rejected` (also terminal, but with no
        // actionable name and nothing for compaction to switch on).
        const event = await transportFrame({
            message: `upstream localhost:6660/v1/chat/completions returned HTTP 400 before the first chunk: ${PROVIDER_LINE}`,
            type: 'stream_error',
            code: 'upstream_status',
            status: 400,
            param: null
        });

        expect(event).toEqual({
            type: 'error',
            code: 'context-overflow',
            message: overflowWireMessage(
                ' (HTTP 400)',
                quotedProvider(`upstream localhost:6660/v1/chat/completions returned HTTP 400 before the first chunk: ${PROVIDER_LINE}`)
            ),
            details: { errorClass: 'context-overflow', url: CHAT_URL, port: 6660 }
        });
    });

    it('classifies an upstream_status 413 frame by status alone', async () => {
        // The same rule the HTTP path has always had: on a chat-completions POST the only
        // thing a 413 can be complaining about is the request body. This frame used to be
        // codeless transit — 413 is not in `isTerminalProviderStatus`, so an upstream that
        // refuses by SIZE re-sent eleven times.
        const event = await transportFrame({
            message: 'upstream /v1/chat/completions returned HTTP 413 before the first chunk',
            type: 'stream_error',
            code: 'upstream_status',
            status: 413,
            param: null
        });

        expect(event).toEqual({
            type: 'error',
            code: 'context-overflow',
            message: overflowWireMessage(
                ' (HTTP 413)',
                quotedProvider('upstream /v1/chat/completions returned HTTP 413 before the first chunk')
            ),
            details: { errorClass: 'context-overflow', url: CHAT_URL, port: 6660 }
        });
    });

    it('classifies a status-less frame whose prose is a size refusal (gateway relays prose only)', async () => {
        // Absence of a status is NOT evidence of an unrelated status — it means the
        // gateway never saw one — so the wording alone decides. This is the arm that
        // covers a `decode`/`unknown`/no-code frame quoting the provider's own line.
        const event = await transportFrame({ message: PROVIDER_LINE, type: 'stream_error', code: 'unknown', param: null });

        expect(event).toEqual({
            type: 'error',
            code: 'context-overflow',
            message: overflowWireMessage('', quotedProvider(PROVIDER_LINE)),
            details: { errorClass: 'context-overflow', url: CHAT_URL, port: 6660 }
        });
    });

    it('recognizes every documented overflow wording on a frame, matching the HTTP path', async () => {
        // ONE matcher, both paths: the same list ./openai.test.ts pins against a 400
        // response also decides a frame. A new gateway phrasing is therefore one entry in
        // `CONTEXT_OVERFLOW_PATTERNS`, never two lists that drift apart.
        const wordings = [
            "This model's maximum context length is 8192 tokens",
            'context_length_exceeded',
            'context length exceeded',
            'exceeds the model context window',
            'prompt is too long: 210000 tokens > 200000 maximum',
            'input is too long for this model',
            'Input too long',
            'too many tokens to complete chat',
            'token limit exceeded',
            'request too large',
            'payload too large'
        ];

        for (const wording of wordings) {
            const event = await transportFrame({ message: wording, type: 'stream_error', code: 'unknown', param: null });

            expect(event).toEqual({
                type: 'error',
                code: 'context-overflow',
                message: overflowWireMessage('', quotedProvider(wording)),
                details: { errorClass: 'context-overflow', url: CHAT_URL, port: 6660 }
            });
        }
    });

    it('answers the same code whether the refusal arrives as a response or as a frame', async () => {
        // (i) + (ii) together, and the reason the matcher had to move into the shared
        // leaf: a provider directly in front of us answers 400, the SAME provider behind a
        // gateway answers a frame. One question, one name.
        stubResponseStatus(400, PROVIDER_LINE);

        const [response] = await collect(openAICompatible({ baseURL: BASE_URL })(request));

        if (response?.type !== 'error') throw new Error(`expected an error frame, got ${JSON.stringify(response)}`);
        expect(response.code).toBe(CONTEXT_OVERFLOW_CODE);
        expect(response.message).toContain('context-overflow: HTTP 400');

        const frame = await transportFrame({
            message: PROVIDER_LINE,
            type: 'stream_error',
            code: 'upstream_status',
            status: 400,
            param: null
        });

        if (frame.type !== 'error') throw new Error(`expected an error frame, got ${JSON.stringify(frame)}`);
        expect(frame.code).toBe(CONTEXT_OVERFLOW_CODE);
    });
});

describe('in-stream failures that are NOT context overflows', () => {
    it('keeps the gateway `unknown` constant codeless on the transit class — no signal, no guess', async () => {
        // (iii) THE FINDING, pinned. The frame in the reported line is
        // `{ message: 'Upstream stream terminated', code: 'unknown', param: null }`: the
        // message is the gateway's byte-frozen constant (start.ts:341) and `status` is
        // emitted only for `upstream_status` (start.ts:660-668), so this frame carries NO
        // overflow signal whatsoever. Inventing one here would be guessing, so the frame
        // keeps exactly what it always had: no code, the generic transient ladder, and the
        // transit diagnosis for the session layer. What the gateway would have to emit for
        // this case to be named is EITHER `code: 'upstream_status'` + `status: 400` (it
        // already does that when the upstream error carries a status) OR the provider's own
        // line in `message` instead of the constant.
        const event = await transportFrame({
            message: GATEWAY_UNKNOWN_LINE,
            type: 'stream_error',
            code: 'unknown',
            param: null
        });

        expect(event).toEqual({
            type: 'error',
            message: GATEWAY_UNKNOWN_LINE,
            details: { errorClass: 'provider-transit', url: CHAT_URL, port: 6660 }
        });
    });

    it('keeps a 400 frame without size wording a plain refusal', async () => {
        // The near-miss that must NOT become an overflow: a complaint about the request
        // SHAPE. `max_tokens` on its own is deliberately outside the pattern list, because
        // its fix is a different request, not a smaller prompt.
        const event = await transportFrame({
            message: 'Invalid value for max_tokens: expected integer',
            type: 'stream_error',
            code: 'upstream_status',
            status: 400,
            param: 'max_tokens'
        });

        expect(event).toEqual({
            type: 'error',
            code: 'provider-rejected',
            message:
                `provider-rejected: the provider reported a failure on the stream from ${CHAT_URL} (HTTP 400). ` +
                'The upstream refused this request itself, so re-sending the same bytes would be refused ' +
                'again. The provider blamed `max_tokens`. The provider said: "Invalid value for max_tokens: ' +
                'expected integer"',
            details: { errorClass: 'provider-rejected', url: CHAT_URL, port: 6660 }
        });
    });

    it('never calls a non-400/413 upstream answer an overflow, whatever it quotes', async () => {
        // The STATUS GATE, now protecting the in-stream path too. An upstream 504/429/500
        // whose error page happens to quote the provider's context docs is fixed by TIME,
        // not by sending less, and stays the codeless transient frame it has always been.
        for (const status of [408, 429, 500, 503, 504]) {
            const event = await transportFrame({
                message: `upstream returned HTTP ${status}: ${PROVIDER_LINE}`,
                type: 'stream_error',
                code: 'upstream_status',
                status,
                param: null
            });

            expect(event).toEqual({
                type: 'error',
                message: `upstream returned HTTP ${status}: ${PROVIDER_LINE}`,
                details: { errorClass: 'provider-transit', url: CHAT_URL, port: 6660 }
            });
        }
    });

    it('never lets prose override a definite gateway verdict', async () => {
        // `timeout` / `connection` / `aborted` are verdicts the gateway PROVED, so they
        // outrank wording. Classification here is unchanged, which is what "do not weaken
        // existing classifications" means in a test.
        expect(providerWireFailureOf({ message: PROVIDER_LINE, code: 'timeout' })).toEqual({
            code: 'provider-timeout',
            errorClass: 'provider-timeout',
            phase: 'stream-chunk'
        });

        expect(
            providerWireFailureOf({ message: PROVIDER_LINE, code: 'connection', errno: 'ECONNRESET' })
        ).toEqual({ code: 'provider-connection', errorClass: 'provider-connection', errno: 'ECONNRESET' });

        expect(providerWireFailureOf({ message: PROVIDER_LINE, code: 'aborted' })).toEqual({
            code: 'provider-aborted',
            errorClass: 'provider-aborted'
        });

        // A 401 that QUOTES the context docs is still a credential problem: the gate is
        // 400/413, and the remedy is the key.
        expect(
            providerWireFailureOf({ message: `${PROVIDER_LINE}`, code: 'upstream_status', status: 401, param: 'api_key' })
        ).toEqual({ code: 'provider-rejected', errorClass: 'provider-rejected', status: 401, param: 'api_key' });
    });

    it('tolerates a hostile or prose-less frame without classifying anything', async () => {
        // TOTALITY on an error path: the recogniser reads `message` now, and a gateway
        // frame may be `null`, a string, or carry an object where a string belongs. None of
        // those may throw, and none of them may be talked into an overflow.
        expect(providerWireFailureOf(null)).toEqual({ errorClass: 'provider-transit' });
        expect(providerWireFailureOf('timeout')).toEqual({ errorClass: 'provider-transit' });
        expect(providerWireFailureOf({ message: { text: 'maximum context length' }, code: 'unknown' })).toEqual({
            errorClass: 'provider-transit'
        });
    });
});

describe('the retry ladder an overflow is kept out of (core/agent.ts)', () => {
    // The agent runs against the REAL transport with a stubbed `fetch`, so these are the
    // end of the chain: gateway frame → transport classification → retry owner. `retry`
    // is left at its default (one attempt plus ten) in the overflow case, which is the
    // configuration in the report: eleven attempts were available and none may be spent.
    const runAgainst = async (error: Record<string, unknown>, retry?: { maxRetries: number; baseDelayMs: number }) => {
        const fetchMock = stubGatewayFrame(error);

        const brain = agent({ name: 'writer', model: 'local/basalt', provider: { baseURL: BASE_URL }, retry });

        const events = await collect<AgentStreamEvent>(brain.stream('go'));

        return { fetchMock, events };
    };

    it('spends ONE attempt on a classified overflow at the default eleven-attempt policy', async () => {
        // (iv) The defect's arithmetic, in one assertion. Before: 11 fetches and ten
        // `retry` events (~3 minutes). Now: one fetch, no `retry` event, and the original
        // error — same code, same message — on the terminal `error` event, which is what
        // ../harness.ts forwards to `run.failed` as `payload.error`.
        const { fetchMock, events } = await runAgainst({
            message: PROVIDER_LINE,
            type: 'stream_error',
            code: 'upstream_status',
            status: 400,
            param: null
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(events).toStrictEqual([
            {
                type: 'error',
                error: { message: overflowWireMessage(' (HTTP 400)', quotedProvider(PROVIDER_LINE)), code: 'context-overflow' }
            }
        ]);
    });

    it('spends ONE attempt on a status-less size refusal too', async () => {
        const { fetchMock, events } = await runAgainst({ message: PROVIDER_LINE, type: 'stream_error', code: 'decode' });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(events.map((event) => event.type)).toStrictEqual(['error']);
        expect((events[0] as { error: { code?: string } }).error.code).toBe('context-overflow');
    });

    it('still walks the generic ladder for a transit frame with no overflow signal', async () => {
        // (iii), run-level half: the constant-message frame is UNCLASSIFIED, so the ladder
        // it has always had is untouched — two dials under `maxRetries: 1`, one `retry`
        // frame with the transit diagnostics, and no code on either payload. The full
        // 1 + 10 ladder and its waits are pinned in src/core/agent.retry.test.ts; what is
        // pinned HERE is that this task did not shorten it for the cases that still need it.
        const { fetchMock, events } = await runAgainst(
            { message: GATEWAY_UNKNOWN_LINE, type: 'stream_error', code: 'unknown', param: null },
            { maxRetries: 1, baseDelayMs: 1 }
        );

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(events).toStrictEqual([
            {
                type: 'retry',
                attempt: 1,
                maxAttempts: 2,
                delayMs: 1,
                error: { message: GATEWAY_UNKNOWN_LINE },
                provider: { errorClass: 'provider-transit', url: CHAT_URL, port: 6660 }
            },
            { type: 'error', error: { message: GATEWAY_UNKNOWN_LINE } }
        ]);
    });

    it('keeps a non-overflow refusal terminal on the first attempt', async () => {
        // (v) "Don't burn 17 minutes on a bad key" is intact: a 401 frame is refused,
        // classified `provider-rejected`, and never re-sent — even though its prose quotes
        // the context docs, which the status gate refuses to read as a size problem.
        const { fetchMock, events } = await runAgainst({
            message: `Invalid API key — this model's maximum context length is 8192 tokens`,
            type: 'stream_error',
            code: 'upstream_status',
            status: 401,
            param: 'api_key'
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(events).toHaveLength(1);
        expect((events[0] as { error: { code?: string } }).error.code).toBe('provider-rejected');
    });
});

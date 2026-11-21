// transport/openai.ts — the gateway's mid-stream error frame, classified.
//
// WHAT THIS PINS (2026-11-17, the unrecoverable-timeout report). A gateway that proxies
// another provider answers 200, streams, and attaches its upstream's failure to ONE SSE
// frame. The transport used to read `error.message` and drop `code`/`param`/`status`/
// `errno`, so every mid-stream failure reached `agent()` codeless. The frames below are
// the shapes the producer actually emits —
// `packages/underload/service/src/server/start.ts` `classifyStreamError` (:594-619) and
// `buildStreamErrorPayload` (:635-703), written at :860-873 — whose key set is exactly
// `{ error: { message, type, code, status?, errno?, param: null } }` with `status` and
// `errno` OMITTED (not `null`) when inapplicable.
//
// The mapping under test (src/transport/provider-timeouts.ts `providerWireFailureOf`):
//   wire `timeout`         → `provider-timeout`     (the agent's bounded 4-attempt ladder)
//   wire `connection`      → `provider-connection`  (the short 3-attempt dial ladder)
//   wire `aborted`         → `provider-aborted`     (terminal, never retried)
//   wire `upstream_status`→ `context-overflow` for an upstream 413 or a 400 whose prose is
//                            a size refusal (2026-11-17, the provider-transit
//                            context-limit report); otherwise `provider-rejected` for
//                            400/401/403/404, CODELESS otherwise
//                            — an upstream 408 / 429 / 5xx (504 included, which the
//                            producer deliberately reports HERE and not as `timeout`)
//                            keeps the generic transient ladder
//   wire `decode` /
//       `unknown` /
//       NO code at all     → `context-overflow` when the frame's PROSE is a size refusal
//                            (2026-11-17: the one case where prose is the only signal,
//                            because the gateway attaches `status` to its
//                            `upstream_status` class only); otherwise codeless transient
//                            ladder, message byte-for-byte
//
// A codeless frame keeps its historical message VERBATIM (`Upstream stream terminated`
// is the legacy constant the producer keeps for the `unknown` class, and a frame with no
// `code` at all is a defensive/legacy INPUT shape — both gateway writers emit a coded
// envelope, the copy at repository/agentic/src/server/start-server.ts:294-303 and
// :599-669 included, where `code` is a required key), and classification reads the prose
// for ONE class only — a CONTEXT-LENGTH REFUSAL (2026-11-17: a gateway that commits
// `200 OK` + SSE BEFORE it generates leaves the provider's own words as the only signal
// that a prompt is too long; the arms are pinned in ./openai.context-overflow.test.ts, and
// a definite `timeout` / `connection` / `aborted` verdict is NEVER rewritten by prose).
// What joins a prose-less frame is the `details` block with `errorClass:
// 'provider-transit'`, so the diagnosis is structured while the ladder stays generic.
//
// Run: yarn vitest run src/transport/openai.provider-wire-codes.test.ts

import { afterEach, describe, expect, it, vi } from 'vitest';
import { openAICompatible, providerWireFailureOf } from '../index';
import type { HarnessStreamEvent } from '../index';

const BASE_URL = 'http://localhost:8800/providers/private/v1';
const CHAT_URL = 'http://localhost:8800/providers/private/v1/chat/completions';

const request = {
    model: 'local/basalt',
    messages: [{ role: 'user' as const, content: 'Write' }]
};

// One closed body carrying a single `{"error":{…}}` frame — the whole shape under test.
const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

const errorBody = (error: Record<string, unknown>): ReadableStream<Uint8Array> => {
    const encoder = new TextEncoder();

    return new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(sse({ error })));
            controller.close();
        }
    });
};

const stubFetch = (error: Record<string, unknown>) => {
    vi.stubGlobal('fetch', async () => new Response(errorBody(error), { status: 200 }));
};

const collect = async (events: AsyncIterable<HarnessStreamEvent>): Promise<HarnessStreamEvent[]> => {
    const collected: HarnessStreamEvent[] = [];

    for await (const event of events) collected.push(event);

    return collected;
};

const transportFrame = async (error: Record<string, unknown>): Promise<HarnessStreamEvent> => {
    stubFetch(error);

    const events = await collect(openAICompatible({ baseURL: BASE_URL })(request));

    // The error frame is TERMINAL for the attempt, so it is the only event.
    expect(events).toHaveLength(1);

    return events[0];
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('gateway in-stream error codes (transport classification)', () => {
    it('maps wire `timeout` to provider-timeout on an open stream, with no local bound to quote', async () => {
        const event = await transportFrame({
            message: 'Upstream timed out after 900s',
            type: 'upstream_error',
            code: 'timeout',
            param: null
        });

        expect(event).toEqual({
            type: 'error',
            code: 'provider-timeout',
            message:
                'provider-timeout: the provider reported a failure on the stream from ' +
                `${CHAT_URL}. The provider (or the upstream it proxies) ran out of time while the stream ` +
                'was open, so this attempt is re-sent on a bounded retry ladder instead of ending the run. ' +
                'The provider said: "Upstream timed out after 900s"',
            details: {
                errorClass: 'provider-timeout',
                url: CHAT_URL,
                port: 8800,
                phase: 'stream-chunk'
            }
        });
    });

    it('maps wire `connection` to provider-connection and keeps the errno', async () => {
        const event = await transportFrame({
            message: 'connect ECONNREFUSED 127.0.0.1:8800',
            type: 'upstream_error',
            code: 'connection',
            status: undefined,
            errno: 'ECONNREFUSED',
            param: null
        });

        expect(event).toEqual({
            type: 'error',
            code: 'provider-connection',
            message:
                'provider-connection: the provider reported a failure on the stream from ' +
                `${CHAT_URL}. Nothing answered the dial on the provider side, so this attempt is re-sent on ` +
                'the short connection ladder. The provider said: "connect ECONNREFUSED 127.0.0.1:8800"',
            details: {
                errorClass: 'provider-connection',
                url: CHAT_URL,
                port: 8800,
                errno: 'ECONNREFUSED'
            }
        });
    });

    it('maps wire `aborted` to provider-aborted, which the agent never re-sends', async () => {
        const event = await transportFrame({
            message: 'Upstream stream aborted by client',
            type: 'upstream_error',
            code: 'aborted',
            param: null
        });

        expect(event).toEqual({
            type: 'error',
            code: 'provider-aborted',
            message:
                'provider-aborted: the provider reported a failure on the stream from ' +
                `${CHAT_URL}. The request was cancelled before it completed, so it is not re-sent. ` +
                'The provider said: "Upstream stream aborted by client"',
            details: { errorClass: 'provider-aborted', url: CHAT_URL, port: 8800 }
        });
    });

    it('maps a terminal wire `upstream_status` (401) to provider-rejected, quoting the status and the blamed param', async () => {
        const event = await transportFrame({
            message: 'Invalid API key',
            type: 'upstream_error',
            code: 'upstream_status',
            status: 401,
            param: 'api_key'
        });

        expect(event).toEqual({
            type: 'error',
            code: 'provider-rejected',
            message:
                `provider-rejected: the provider reported a failure on the stream from ${CHAT_URL} (HTTP 401). ` +
                'The upstream refused this request itself, so re-sending the same bytes would be refused again. ' +
                'The provider blamed `api_key`. The provider said: "Invalid API key"',
            details: { errorClass: 'provider-rejected', url: CHAT_URL, port: 8800 }
        });
    });

    it('keeps a time-fixable wire `upstream_status` (504) codeless on the transient ladder', async () => {
        // The producer reports an upstream 504 HERE, not as `timeout`. A refusal is
        // about OUR request; an upstream that is restarting or timing out is fixed by
        // TIME, which is exactly what the generic backoff buys — so no `code`, and the
        // message stays the provider's own sentence.
        const event = await transportFrame({
            message: 'Upstream gateway timeout',
            type: 'upstream_error',
            code: 'upstream_status',
            status: 504,
            param: null
        });

        expect(event).toEqual({
            type: 'error',
            message: 'Upstream gateway timeout',
            details: { errorClass: 'provider-transit', url: CHAT_URL, port: 8800 }
        });
    });

    it('keeps wire `decode` codeless, with the transit diagnosis and its own message', async () => {
        const event = await transportFrame({
            message: 'Upstream chunk failed to decode',
            type: 'upstream_error',
            code: 'decode',
            param: null
        });

        expect(event).toEqual({
            type: 'error',
            message: 'Upstream chunk failed to decode',
            details: { errorClass: 'provider-transit', url: CHAT_URL, port: 8800 }
        });
    });

    it('keeps the legacy `unknown` sentence byte-for-byte, with the transit diagnosis', async () => {
        // The byte-identical constant the producer keeps for `unknown`, and the exact
        // frame EITHER gateway writer emits for an `unknown` class with no status to attach.
        const event = await transportFrame({
            message: 'Upstream stream terminated',
            type: 'upstream_error',
            code: 'unknown',
            param: null
        });

        expect(event).toEqual({
            type: 'error',
            message: 'Upstream stream terminated',
            details: { errorClass: 'provider-transit', url: CHAT_URL, port: 8800 }
        });
    });

    it('keeps a frame with NO code at all on the historical codeless path', async () => {
        // Neither gateway writer emits this shape any more — both classify and always send
        // a `code` (the copy at repository/agentic/src/server/start-server.ts:599-669
        // included). Absent `code` stays a SUPPORTED input here rather than something we
        // normalize away: a provider that names nothing, or a frame an older producer
        // wrote, gets the same message, the same transient ladder, plus the diagnosis.
        const event = await transportFrame({ message: 'Upstream stream terminated' });

        expect(event).toEqual({
            type: 'error',
            message: 'Upstream stream terminated',
            details: { errorClass: 'provider-transit', url: CHAT_URL, port: 8800 }
        });
    });
});

describe('providerWireFailureOf (the one translator)', () => {
    it('classifies the whole vocabulary, exactly once each', () => {
        expect(providerWireFailureOf({ code: 'timeout' })).toEqual({
            code: 'provider-timeout',
            errorClass: 'provider-timeout',
            phase: 'stream-chunk'
        });

        expect(providerWireFailureOf({ code: 'connection', errno: 'ECONNRESET' })).toEqual({
            code: 'provider-connection',
            errorClass: 'provider-connection',
            errno: 'ECONNRESET'
        });

        expect(providerWireFailureOf({ code: 'aborted' })).toEqual({
            code: 'provider-aborted',
            errorClass: 'provider-aborted'
        });

        // Only the four statuses that are about OUR request become terminal.
        expect(providerWireFailureOf({ code: 'upstream_status', status: 400, param: 'max_tokens' })).toEqual({
            code: 'provider-rejected',
            errorClass: 'provider-rejected',
            status: 400,
            param: 'max_tokens'
        });

        expect(providerWireFailureOf({ code: 'upstream_status', status: 408 })).toEqual({
            errorClass: 'provider-transit',
            status: 408
        });

        expect(providerWireFailureOf({ code: 'upstream_status', status: 429 })).toEqual({
            errorClass: 'provider-transit',
            status: 429
        });

        expect(providerWireFailureOf({ code: 'upstream_status', status: 503 })).toEqual({
            errorClass: 'provider-transit',
            status: 503
        });

        // (2026-11-17, the provider-transit context-limit report) THE CONTEXT-LENGTH ARMS,
        // and they sit BESIDE the no-message rows above, which are their counterparts: a
        // `upstream_status` 400 with no prose stays `provider-rejected`, and a `decode` /
        // `unknown` frame with no prose stays codeless transit. A size refusal is what
        // changes: an upstream 413 needs no wording at all, a 400 earns the name only from
        // the provider's own line, and a status-less frame is decided by prose alone
        // (absence of a status is absence of evidence, not evidence of an unrelated
        // status). All three used to be `provider-rejected` or codeless transit — i.e.
        // eleven attempts at bytes that cannot change. `errorClass` is the code, like every
        // other coded class, so `harness.ts` and the UI read one answer from both fields.
        expect(providerWireFailureOf({ code: 'upstream_status', status: 413, message: 'Payload Too Large' })).toEqual({
            code: 'context-overflow',
            errorClass: 'context-overflow',
            status: 413
        });

        expect(
            providerWireFailureOf({
                code: 'upstream_status',
                status: 400,
                message: 'prompt is too long: 210000 tokens > 200000 maximum'
            })
        ).toEqual({ code: 'context-overflow', errorClass: 'context-overflow', status: 400 });

        expect(
            providerWireFailureOf({
                message: "This model's maximum context length is 8192 tokens",
                code: 'unknown'
            })
        ).toEqual({ code: 'context-overflow', errorClass: 'context-overflow' });

        expect(providerWireFailureOf({ code: 'decode' })).toEqual({ errorClass: 'provider-transit' });

        expect(providerWireFailureOf({ code: 'unknown' })).toEqual({ errorClass: 'provider-transit' });

        expect(providerWireFailureOf({})).toEqual({ errorClass: 'provider-transit' });
    });

    it('treats absent, null and unparseable secondary fields as absence, and casing as noise', () => {
        // Both producers OMIT `status`/`errno` when inapplicable and send `param: null`,
        // and a frame may still reach us with no `code` at all (a defensive/legacy input
        // shape, see the no-code test above). None of those may become a fake value.
        expect(providerWireFailureOf({ code: 'upstream_status', status: null, errno: null, param: null })).toEqual({
            errorClass: 'provider-transit'
        });

        // `ETIMEDOUT` arrives as `timeout` (the producer checks timeout first), and an
        // SDK-cancelled timeout never reaches `aborted` — the consumer just classifies
        // whatever code it is given.
        expect(providerWireFailureOf({ code: ' timeout ', errno: 'ETIMEDOUT' })).toEqual({
            code: 'provider-timeout',
            errorClass: 'provider-timeout',
            phase: 'stream-chunk',
            errno: 'ETIMEDOUT'
        });

        expect(providerWireFailureOf({ code: 'ABORTED' })).toEqual({
            code: 'provider-aborted',
            errorClass: 'provider-aborted'
        });

        // A hostile or non-object frame still answers a diagnosis, never a throw.
        expect(providerWireFailureOf(null)).toEqual({ errorClass: 'provider-transit' });
        expect(providerWireFailureOf('timeout')).toEqual({ errorClass: 'provider-transit' });
    });
});

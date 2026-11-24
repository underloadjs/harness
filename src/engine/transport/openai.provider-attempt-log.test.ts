// transport/openai.ts — the operator's per-attempt provider trace (2026-11-24).
//
// The defect this pins is the ABSENCE of a record, not a wrong value: a live session reported
// eleven `provider-transit: attempt 1..11 of 11 failed · retrying in Xs · <url>` lines and a
// `provider-rejected: … HTTP 404 … Model 'undefined' not found` on the SAME URL, and no log or
// journal anywhere carried the model id that went out — so no attempt could be attributed to a
// session, a model, or a relay. Pinned contract (every expectation is written from the required
// behaviour, and every line is asserted EXACTLY, because the greppable line IS the deliverable):
//
//   1. ONE line per outbound attempt, emitted BEFORE `fetch`, naming the model id, the redacted
//      dial target, the streaming flag, the WIRE message count and the serialized body's byte
//      count — the four facts an operator cannot recover from anywhere else;
//   2. ONE line per failed attempt naming the model, the same redacted target, and the
//      transport's classification: the frame's machine `code` (`provider-rejected`), else the
//      structured `details.errorClass` (a CODELESS `provider-transit` is still attributable),
//      else `unclassified` — including a failure that leaves as a THROW rather than a frame,
//      which is the one shape that carries no frame at all;
//   3. a request that never reached `fetch` (issue 0001's pre-flight body gates) prints NOTHING,
//      because no dial is being attributed, and a successful request prints the attempt line and
//      no failure line;
//   4. NO secret, ever: a base URL carrying a credential in userinfo AND in the path comes out as
//      `providerURLOf` + `redactProviderKey` output, and the configured key appears nowhere;
//   5. logging is behaviour-neutral: the frames are what they always were, a thrown error is
//      re-thrown with its IDENTITY intact (the retry policy switches on it), and an odd input —
//      an absent model, a Symbol, an object with no `toString` — PRINTS instead of throwing.
//
// These tests spy `console.error` (the package's only sink — see the "Operator log" section of
// ./openai.ts) and restore it in `afterEach`, so no other suite inherits the spy.
//
// Run: yarn vitest run src/engine/transport/openai.provider-attempt-log.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openAICompatible } from '../index';
import type { HarnessStream, HarnessStreamEvent } from '../index';

const BASE_URL = 'http://localhost:8800/providers/private/v1';
const CHAT_URL = `${BASE_URL}/chat/completions`;

const REQUEST = {
    model: 'local/basalt',
    messages: [{ role: 'user' as const, content: 'Write' }]
};

// One complete, terminating SSE body: a delta, a finish_reason, then `[DONE]`.
const SSE =
    'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

// The exact body `transportBody` serializes for REQUEST. The `body=85 bytes` asserted below is
// this string's real UTF-8 size, asserted from the SAME captured body the stub read back — so
// the number in the log line is pinned against the wire, not against a hand-count.
const REQUEST_BODY = '{"model":"local/basalt","stream":true,"messages":[{"role":"user","content":"Write"}]}';

const ATTEMPT_LINE =
    `[harness] provider attempt: model=local/basalt · dial=${CHAT_URL} · stream=yes · messages=1 · body=85 bytes`;

const FAILURE_LINE = (failureClass: string): string =>
    `[harness] provider attempt failed: model=local/basalt · dial=${CHAT_URL} · class=${failureClass}`;

// Everything the run wrote to stderr, IN ORDER, with a `fetch` marker interleaved by the stub.
// Order is part of the contract: an attempt line written AFTER the response arrived would not
// exist for the attempts that never got a response, which is half of the reported failure.
let lines: string[] = [];
let bodies: string[] = [];

// The credential every redaction assertion below is written against.
const KEY = 'sk-secret-value-1234567890';

const streamOnce = async (stream: HarnessStream, request = REQUEST): Promise<HarnessStreamEvent[]> => {
    const collected: HarnessStreamEvent[] = [];

    for await (const event of stream(request)) collected.push(event);

    return collected;
};

// Replaces the whole wire. The stub sees the serialized body the transport is about to send, so
// the byte count in the attempt line and the body the provider received are the SAME observed
// value.
const stubFetch = (respond: (body: string) => Response): void => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: unknown, init: { body?: unknown }) => {
            const body = String(init.body);

            bodies.push(body);
            lines.push('· fetch ·');

            return respond(body);
        })
    );
};

const answer = (status: number, statusText: string, body = ''): void =>
    stubFetch(() => new Response(body, { status, statusText }));

// Structural, not `MockInstance<…>`, so the assertion does not depend on vitest's spy generics.
let stderr: { mockRestore: () => void };

beforeEach(() => {
    lines = [];
    bodies = [];

    stderr = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        lines.push(args.map((arg) => String(arg)).join(' '));
    });
});

afterEach(() => {
    // Restored here rather than per-test so a failing assertion cannot leave a mock on `console`
    // for every later suite in the same worker.
    stderr.mockRestore();
    vi.unstubAllGlobals();
});

describe('the per-attempt provider trace (transport side)', () => {
    it('emits ONE line naming model, dial target, stream flag, message count and body size before the fetch', async () => {
        stubFetch(() => new Response(SSE, { status: 200, statusText: 'OK' }));

        const events = await streamOnce(openAICompatible({ baseURL: BASE_URL }));

        // The marker sits AFTER the line: the attempt is on the record before the request leaves.
        expect(lines).toEqual([ATTEMPT_LINE, '· fetch ·']);
        expect(bodies).toEqual([REQUEST_BODY]);
        expect(new TextEncoder().encode(REQUEST_BODY).length).toBe(85);

        // A successful attempt gets the attempt line and NO failure line, and its frames are the
        // historical ones: the trace is additive.
        expect(events).toEqual([{ type: 'text', delta: 'hi' }, { type: 'done', stopReason: 'stop', toolCalls: [] }]);
    });

    it('reports the stream flag of the body that actually went out, not the one the default writes', async () => {
        // `options.buildBody` may drop `stream`; the operator is asking what the provider
        // received, so the flag is read off the FINAL body.
        stubFetch(() => new Response(SSE, { status: 200, statusText: 'OK' }));

        await streamOnce(openAICompatible({ baseURL: BASE_URL }, { buildBody: (body) => ({ ...body, stream: false }) }));

        expect(lines).toEqual([
            `[harness] provider attempt: model=local/basalt · dial=${CHAT_URL} · stream=no · messages=1 · body=86 bytes`,
            '· fetch ·'
        ]);
        expect(bodies).toEqual([
            '{"model":"local/basalt","stream":false,"messages":[{"role":"user","content":"Write"}]}'
        ]);
    });

    it('names a refused request with the machine class the retry owner acted on', async () => {
        answer(404, 'Not Found', `{"error":"Model 'undefined' not found"}`);

        const events = await streamOnce(openAICompatible({ baseURL: BASE_URL }));

        expect(lines).toEqual([ATTEMPT_LINE, '· fetch ·', FAILURE_LINE('provider-rejected')]);

        // The frame itself is unchanged: a 404 is still the coded refusal T8 pinned.
        expect(events).toEqual([
            {
                type: 'error',
                code: 'provider-rejected',
                message:
                    `provider-rejected: the provider answered ${CHAT_URL} with HTTP 404 and refused the request, ` +
                    'so re-sending the same bytes would be refused again — this turn failed after one attempt ' +
                    'instead of waiting out the retry ladder. The model or route does not exist here: check the ' +
                    `model id and the configured base path. The provider said: "{"error":"Model 'undefined' not found"}"`
            }
        ]);
    });

    it('attributes a CODELESS failure by its diagnostics class instead of an anonymous retry', async () => {
        // A body that closed without `[DONE]` and without a finish_reason: CODELESS by contract
        // (it keeps the generic ladder), and exactly the frame that reached the live session
        // eleven times. `details.errorClass` is what makes the line nameable.
        answer(200, 'OK', 'data: {"choices":[{"delta":{"content":"half"}}]}\n\n');

        const events = await streamOnce(openAICompatible({ baseURL: BASE_URL }));

        expect(lines).toEqual([ATTEMPT_LINE, '· fetch ·', FAILURE_LINE('provider-transit')]);
        expect(events.at(-1)).toEqual({
            type: 'error',
            message: 'The model stream ended before reporting a completion.',
            details: { errorClass: 'provider-transit', url: CHAT_URL, port: 8800 }
        });
    });

    it('names an attempt the transport reports by THROWING, and re-throws the identical error', async () => {
        // `dataFrames` PARKS a body failure and ./openai.ts re-throws whatever its classifier
        // does not recognise: the one failure shape that never passes through an error frame, so
        // without the wrapper's `catch` this attempt would leave no trace at all.
        const failure = new Error('socket hung up');

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                lines.push('· fetch ·');

                return new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.enqueue(
                                new TextEncoder().encode('data: {"choices":[{"delta":{"content":"half"}}]}\n\n')
                            );
                            controller.error(failure);
                        }
                    }),
                    { status: 200, statusText: 'OK' }
                );
            })
        );

        let thrown: unknown;

        try {
            await streamOnce(openAICompatible({ baseURL: BASE_URL }));
        } catch (error) {
            thrown = error;
        }

        expect(lines).toEqual([ATTEMPT_LINE, '· fetch ·', FAILURE_LINE('unclassified')]);

        // Identity, not just message: ../core/agent.ts decides the retry policy from the thrown
        // object, so re-wrapping it here would be a behaviour change.
        expect(thrown).toBe(failure);
    });

    it('prints NOTHING for a request that never reached the wire', async () => {
        // A pre-flight refusal (issue 0001's `extraBody` gate) is a request-BUILDING mistake. A
        // "failed attempt" line would claim a dial the provider never saw, which is worse than
        // silence: it would attribute a wire failure to a local bug.
        const cyclic: Record<string, unknown> = {};

        cyclic.self = cyclic;

        stubFetch(() => new Response(SSE, { status: 200, statusText: 'OK' }));

        const events = await streamOnce(openAICompatible({ baseURL: BASE_URL, extraBody: () => cyclic }));

        expect(lines).toEqual([]);
        expect(bodies).toEqual([]);
        expect(String((events[0] as { message: string }).message)).toContain(
            '`provider.extraBody` cannot be serialized as JSON'
        );
    });

    it('carries no credential: a key in the URL userinfo and in the path is gone from both lines', async () => {
        answer(404, 'Not Found', 'no such model');

        await streamOnce(
            openAICompatible({ baseURL: `https://user:${KEY}@relay.example.dev/v1/key/${KEY}`, apiKey: KEY })
        );

        // `providerURLOf` drops the userinfo, the query and the fragment; `redactProviderKey`
        // covers the half a URL parser cannot drop — a credential that sits in the PATH — and the
        // model field, which is host-supplied.
        expect(lines).toEqual([
            '[harness] provider attempt: model=local/basalt · dial=https://relay.example.dev/v1/key/[redacted]/chat/completions · stream=yes · messages=1 · body=85 bytes',
            '· fetch ·',
            '[harness] provider attempt failed: model=local/basalt · dial=https://relay.example.dev/v1/key/[redacted]/chat/completions · class=provider-rejected'
        ]);
        expect(lines.join('\n')).not.toContain(KEY);
    });

    it('prints the incident shape — an absent model id — as `undefined` instead of failing the request', async () => {
        // The reported request reached the provider as `Model 'undefined' not found`. `undefined`
        // is dropped by `JSON.stringify`, so before this trace there was NO way to see from the
        // harness side that the model id was missing; now the line says so literally.
        stubFetch(() => new Response(SSE, { status: 200, statusText: 'OK' }));

        const events = await streamOnce(openAICompatible({ baseURL: BASE_URL }), {
            model: undefined as unknown as string,
            messages: [{ role: 'user', content: 'Write' }]
        });

        expect(lines).toEqual([
            '[harness] provider attempt: model=undefined · dial=http://localhost:8800/providers/private/v1/chat/completions · stream=yes · messages=1 · body=62 bytes',
            '· fetch ·'
        ]);
        expect(bodies).toEqual(['{"stream":true,"messages":[{"role":"user","content":"Write"}]}']);
        expect(events).toEqual([{ type: 'text', delta: 'hi' }, { type: 'done', stopReason: 'stop', toolCalls: [] }]);
    });

    it('prints a model id `String` can name, and sends the request unchanged', async () => {
        // A Symbol is the input a bare template interpolation THROWS on; the helper calls
        // `String` explicitly, so the line reads `Symbol(basalt)` and the request still runs.
        stubFetch(() => new Response(SSE, { status: 200, statusText: 'OK' }));

        const events = await streamOnce(openAICompatible({ baseURL: BASE_URL }), {
            model: Symbol('basalt') as unknown as string,
            messages: [{ role: 'user', content: 'Write' }]
        });

        expect(lines).toEqual([
            '[harness] provider attempt: model=Symbol(basalt) · dial=http://localhost:8800/providers/private/v1/chat/completions · stream=yes · messages=1 · body=62 bytes',
            '· fetch ·'
        ]);
        expect(events).toEqual([{ type: 'text', delta: 'hi' }, { type: 'done', stopReason: 'stop', toolCalls: [] }]);
    });

    it('prints a placeholder for a model id that cannot be stringified, rather than failing the request', async () => {
        // A null-prototype object has no `toString` at all, so `String` itself refuses: the one
        // input the log helper's `catch` exists for.
        stubFetch(() => new Response(SSE, { status: 200, statusText: 'OK' }));

        const events = await streamOnce(openAICompatible({ baseURL: BASE_URL }), {
            model: Object.create(null) as unknown as string,
            messages: [{ role: 'user', content: 'Write' }]
        });

        expect(lines).toEqual([
            '[harness] provider attempt: model=<unprintable> · dial=http://localhost:8800/providers/private/v1/chat/completions · stream=yes · messages=1 · body=73 bytes',
            '· fetch ·'
        ]);
        expect(events).toEqual([{ type: 'text', delta: 'hi' }, { type: 'done', stopReason: 'stop', toolCalls: [] }]);
    });
});

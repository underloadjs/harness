// transport/openai.ts — the lone-surrogate wire guarantee (T3, 2026-11-24).
//
// THE DEFECT THIS PINS, verbatim from a live stress run (295 tool calls, ~9.85M chars):
//
//   provider-transit: attempt 1 of 11 failed · … · upstream …modal.run/v1/chat/completions
//   returned HTTP 500 after 3675 chunks: 'utf-8' codec can't encode character '\ud83d' in
//   position 643: surrogates not allowed
//
// A JavaScript string may hold an UNPAIRED surrogate. `JSON.stringify` writes it as a
// `\udXXX` escape — valid JSON, so the provider parses the body — and the provider's strict
// UTF-8 encoder then refuses to ENCODE it. The transcript replays the same text on every
// later turn, so all eleven retries failed on bytes the harness had itself clipped.
//
// The fix sits between `buildBody` and `JSON.stringify` (`openai.ts:1802-1840`), i.e. at the
// one place the requirement exists, and it covers a body this package built AND a body a host
// rewrote. Pinned here, on the real serialized string the stubbed `fetch` received:
//
//   1. a body poisoned with a lone HIGH half and a lone LOW half — in message `content` and in
//      a tool call's `arguments` string — reaches the wire with ZERO lone surrogates, and every
//      other field is exactly what it was;
//   2. a CLEAN body reaches the wire BYTE-IDENTICAL, including the field order and the byte
//      count printed in the operator's attempt line: sanitizing may never re-shape a request
//      that was already valid;
//   3. the repair is behaviour-neutral — the frames a successful stream yields are unchanged;
//   4. a `buildBody` rewrite is covered too, because the sanitizer runs below that seam;
//   5. the diagnostic is ONE count-only line, and it appears ONLY on the repaired path, so the
//      per-attempt trace (`openai.provider-attempt-log.test.ts`) keeps its exact shape.
//
// Run: yarn vitest run src/engine/transport/openai.wire-surrogates.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openAICompatible } from '../index';
import type { HarnessStream, HarnessStreamEvent, HarnessStreamRequest } from '../index';
// The same counter the sanitizer's own walk uses, so "zero on the wire" is measured with the
// provider's rule (an unpaired surrogate, in either direction) rather than a regex guess.
import { countWireLoneSurrogates } from '../util';

const BASE_URL = 'http://localhost:8800/providers/private/v1';
const CHAT_URL = `${BASE_URL}/chat/completions`;

// A stray lead half, a stray trail half, one COMPLETE pair, and what a repair writes.
const HIGH = '\ud83d';
const LOW = '\udc00';
const PAIR = '\ud83c\udf89';
const REPLACEMENT = '\ufffd';

// One complete, terminating SSE body, so a request that was repaired still streams.
const SSE =
    'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

// Everything the transport wrote to stderr, IN ORDER, with a `fetch` marker interleaved, and
// every serialized body the stub `fetch` was handed. The body string is the wire: asserting on
// it is asserting on what the provider's encoder had to accept.
let lines: string[] = [];
let bodies: string[] = [];

const stubFetch = (): void => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: unknown, init: { body?: unknown }) => {
            bodies.push(String(init.body));
            lines.push('· fetch ·');

            return new Response(SSE, { status: 200, statusText: 'OK' });
        })
    );
};

const collect = async (stream: HarnessStream, request: HarnessStreamRequest) => {
    const events: HarnessStreamEvent[] = [];

    for await (const event of stream(request)) events.push(event);

    return events;
};

beforeEach(() => {
    lines = [];
    bodies = [];

    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        lines.push(args.map((arg) => String(arg)).join(' '));
    });
});

afterEach(() => {
    vi.mocked(console.error).mockRestore();
    vi.unstubAllGlobals();
});

describe('the wire surrogate guarantee (transport send path)', () => {
    it('sends a body carrying a lone high half and a lone low half with zero lone surrogates', async () => {
        stubFetch();

        // All three places the reported failure actually hid: prose `content`, an assistant
        // turn's `tool_calls[].function.arguments` (a JSON STRING, so the orphan sits inside
        // a quoted value), and a tool result. A complete pair rides along to prove the repair
        // does not touch whole characters.
        const events = await collect(openAICompatible({ baseURL: BASE_URL }), {
            model: 'local/basalt',
            messages: [
                { role: 'user', content: `party ${HIGH} time` },
                {
                    role: 'assistant',
                    content: `down ${LOW}`,
                    toolCalls: [{ id: 'c1', name: 'write', arguments: `{"text":"a${HIGH}b"}` }]
                },
                { role: 'tool', toolCallId: 'c1', name: 'write', content: `ok ${PAIR}` }
            ]
        });

        expect(bodies).toHaveLength(1);

        const wire = bodies[0];

        // 1. The raw serialized string carries no `\udXXX` escape at all — the exact shape the
        //    provider choked on.
        expect(wire).not.toMatch(/\\ud[0-9a-fA-F]{3}/);
        // 2. Re-parsed, the decoded body holds no unpaired surrogate either (an escape-free
        //    string could still carry a raw orphan, which is what `JSON.stringify` escapes).
        const sent = JSON.parse(wire) as unknown;

        expect(countWireLoneSurrogates(sent)).toBe(0);
        // 3. Every field is otherwise exactly the request: the orphan half became U+FFFD and
        //    nothing else moved.
        expect(sent).toEqual({
            model: 'local/basalt',
            stream: true,
            messages: [
                { role: 'user', content: `party ${REPLACEMENT} time` },
                {
                    role: 'assistant',
                    content: `down ${REPLACEMENT}`,
                    tool_calls: [
                        {
                            id: 'c1',
                            type: 'function',
                            function: { name: 'write', arguments: `{"text":"a${REPLACEMENT}b"}` }
                        }
                    ]
                },
                // The provider's `tool` message answers the call, so the wire spelling carries
                // `tool_call_id` and drops the local `name` (`wireMessage`, openai.ts:450-455).
                { role: 'tool', tool_call_id: 'c1', content: `ok ${PAIR}` }
            ]
        });
        // 4. Behaviour-neutral: a repaired request streams exactly what a clean one did.
        expect(events).toEqual([
            { type: 'text', delta: 'hi' },
            { type: 'done', stopReason: 'stop', toolCalls: [], usage: undefined }
        ]);
    });

    it('leaves a clean body byte-identical to the unsanitized path', async () => {
        stubFetch();

        await collect(openAICompatible({ baseURL: BASE_URL }), {
            model: 'local/basalt',
            messages: [
                { role: 'user', content: `party ${PAIR} time` },
                {
                    role: 'assistant',
                    content: '',
                    toolCalls: [{ id: 'c1', name: 'write', arguments: `{"text":"${PAIR}"}` }]
                }
            ]
        });

        // The WHOLE serialized body, spelled out — field order included. A clean request is
        // the common case, and every existing wire test in this package is written against
        // exactly this spelling, so the sanitizer must be a literal no-op on it.
        expect(bodies[0]).toBe(
            '{"model":"local/basalt","stream":true,"messages":[' +
                '{"role":"user","content":"party \ud83c\udf89 time"},' +
                '{"role":"assistant","content":"","tool_calls":[{"id":"c1","type":"function","function":{"name":"write","arguments":"{\\"text\\":\\"' +
                '\ud83c\udf89' +
                '\\"}"}}]}]}'
        );
        expect(countWireLoneSurrogates(JSON.parse(bodies[0]))).toBe(0);
    });

    it('repairs a body a host rewrote through `buildBody`', async () => {
        stubFetch();

        // The seam this sits BELOW: a host may rename fields or invent its own dialect, and a
        // lone surrogate it introduces (or inherited from a transcript it built) still cannot
        // go out.
        const stream = openAICompatible(
            { baseURL: BASE_URL },
            {
                buildBody: (base) => ({
                    ...base,
                    host_note: `note ${LOW}`,
                    nested: { parts: [`deep ${HIGH}`] }
                })
            }
        );

        await collect(stream, { model: 'local/basalt', messages: [{ role: 'user', content: 'Write' }] });

        expect(countWireLoneSurrogates(JSON.parse(bodies[0]))).toBe(0);
        expect(JSON.parse(bodies[0])).toMatchObject({
            host_note: `note ${REPLACEMENT}`,
            nested: { parts: [`deep ${REPLACEMENT}`] }
        });
    });

    it('logs ONE count-only line when it repairs, and none when it does not', async () => {
        stubFetch();

        await collect(openAICompatible({ baseURL: BASE_URL, apiKey: 'sk-secret-value-1234567890' }), {
            model: 'local/basalt',
            messages: [
                { role: 'user', content: `a${HIGH}b` },
                { role: 'assistant', content: `c${LOW}` }
            ]
        });

        // Two orphan halves, and the line says ONLY that: no message text, no key material.
        // `body=123 bytes` is the repaired body's real UTF-8 size — 119 code units, of which
        // the two U+FFFD cost 3 bytes each — of the exact string the stub read back:
        // {"model":"local/basalt","stream":true,"messages":[{"role":"user","content":"a\ufffdb"},
        //  {"role":"assistant","content":"c\ufffd"}]}
        expect(lines).toEqual([
            `[harness] provider body sanitized: model=local/basalt · dial=${CHAT_URL} · surrogates=2`,
            '[harness] provider attempt: model=local/basalt · dial=http://localhost:8800/providers/private/v1/chat/completions · stream=yes · messages=2 · body=123 bytes',
            '· fetch ·'
        ]);

        lines = [];
        bodies = [];

        await collect(openAICompatible({ baseURL: BASE_URL }), {
            model: 'local/basalt',
            messages: [{ role: 'user', content: `clean ${PAIR}` }]
        });

        // The clean path prints the attempt line and NOTHING else — the trace shape
        // `openai.provider-attempt-log.test.ts` pins is untouched by this change. The 90 bytes
        // are this exact body's UTF-8 size (88 code units, the 🎉 pair costing 4): a body with
        // a real emoji and no orphan half goes out byte for byte as it always did.
        expect(lines).toEqual([
            '[harness] provider attempt: model=local/basalt · dial=http://localhost:8800/providers/private/v1/chat/completions · stream=yes · messages=1 · body=90 bytes',
            '· fetch ·'
        ]);
        expect(bodies[0]).toBe(
            '{"model":"local/basalt","stream":true,"messages":[{"role":"user","content":"clean \ud83c\udf89"}]}'
        );
    });
});

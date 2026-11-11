// transport.ts — the OpenAI-compatible SSE transport.
//
// `fetch` is stubbed, so these tests exercise the real request shape, the real
// wire-format mapping, and the real frame parser without any network.

import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
    CONTEXT_OVERFLOW_CODE,
    MAX_EXTRA_BODY_BYTES,
    PROVIDER_REQUEST_BODY_CODE,
    HarnessError,
    openAICompatible
} from '@underload/harness';
import type { HarnessStreamEvent, HarnessStreamRequest } from '@underload/harness';

const sseBody = (frames: string[]): ReadableStream<Uint8Array> => {
    const encoder = new TextEncoder();
    return new ReadableStream({
        start(controller) {
            for (const frame of frames) {
                controller.enqueue(encoder.encode(frame));
            }
            controller.close();
        }
    });
};

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

const collect = async (events: AsyncIterable<HarnessStreamEvent>): Promise<HarnessStreamEvent[]> => {
    const collected: HarnessStreamEvent[] = [];
    for await (const event of events) {
        collected.push(event);
    }
    return collected;
};

// Narrow the terminal frame to its parsed usage. `toStrictEqual` against the
// returned value also rejects an accidental `cached: undefined` key, which a
// plain `toEqual` would treat as absent.
const usageOfDone = (event: HarnessStreamEvent | undefined) => {
    if (event?.type !== 'done') throw new Error(`expected a done event, got ${JSON.stringify(event)}`);
    return event.usage;
};

// A fresh Response per call: a Response body can only be read once.
const stubFetch = (frames: string[], init?: ResponseInit) => {
    const fetchMock = vi.fn(async () => new Response(sseBody(frames), init ?? { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
};

afterEach(() => {
    vi.unstubAllGlobals();
});

const request = {
    model: 'merge/ds4-flash',
    messages: [
        { role: 'system' as const, content: 'You are a writer.' },
        { role: 'user' as const, content: 'Write' }
    ]
};

describe('openAICompatible', () => {
    it('posts an OpenAI-compatible streaming body to /chat/completions', async () => {
        const fetchMock = stubFetch(['data: [DONE]\n\n']);

        const stream = openAICompatible({
            baseURL: 'http://localhost:5500/providers/private/v1/',
            apiKey: 'secret',
            headers: { 'x-extra': 'yes' },
            sampling: { temperature: 0.7, top_p: 0.9 }
        });

        await collect(stream(request));

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

        expect(url).toBe('http://localhost:5500/providers/private/v1/chat/completions');
        expect(init.method).toBe('POST');
        expect(init.headers).toMatchObject({
            'content-type': 'application/json',
            authorization: 'Bearer secret',
            'x-extra': 'yes'
        });
        expect(JSON.parse(String(init.body))).toEqual({
            model: 'merge/ds4-flash',
            stream: true,
            messages: request.messages,
            temperature: 0.7,
            top_p: 0.9
        });
    });

    it('declares tools in the OpenAI function format', async () => {
        const fetchMock = stubFetch(['data: [DONE]\n\n']);

        await collect(
            openAICompatible({ baseURL: 'http://x/v1' })({
                ...request,
                tools: [
                    {
                        name: 'websearch',
                        description: 'Search the web.',
                        parameters: { type: 'object', properties: { q: { type: 'string' } } }
                    }
                ]
            })
        );

        const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));

        expect(body.tools).toEqual([
            {
                type: 'function',
                function: {
                    name: 'websearch',
                    description: 'Search the web.',
                    parameters: { type: 'object', properties: { q: { type: 'string' } } }
                }
            }
        ]);
    });

    it('defaults a tool schema to an empty object schema', async () => {
        const fetchMock = stubFetch(['data: [DONE]\n\n']);

        await collect(
            openAICompatible({ baseURL: 'http://x/v1' })({
                ...request,
                tools: [{ name: 'noargs', description: 'No arguments.' }]
            })
        );

        const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
        expect(body.tools[0].function.parameters).toEqual({ type: 'object', properties: {} });
    });

    it('omits tools entirely when none are declared', async () => {
        const fetchMock = stubFetch(['data: [DONE]\n\n']);

        await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));

        const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
        expect(body).not.toHaveProperty('tools');
    });

    // T8 changed what this mapping does with thinking: an entry that still carries
    // `reasoning` after the projection ran is echoed back under the provider's
    // spelling. The withheld case (no `reasoning` key) is the next block's subject.
    it('maps assistant tool calls, tool results and the surviving thinking onto the wire format', async () => {
        const fetchMock = stubFetch(['data: [DONE]\n\n']);

        await collect(
            openAICompatible({ baseURL: 'http://x/v1' })({
                model: 'm',
                messages: [
                    { role: 'user', content: 'search' },
                    {
                        role: 'assistant',
                        content: '',
                        reasoning: 'let me look',
                        toolCalls: [{ id: 'c1', name: 'websearch', arguments: '{"q":"news"}' }]
                    },
                    { role: 'tool', content: 'results', toolCallId: 'c1', name: 'websearch' }
                ]
            })
        );

        const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));

        expect(body.messages).toEqual([
            { role: 'user', content: 'search' },
            {
                role: 'assistant',
                content: '',
                reasoning_content: 'let me look',
                tool_calls: [
                    { id: 'c1', type: 'function', function: { name: 'websearch', arguments: '{"q":"news"}' } }
                ]
            },
            { role: 'tool', tool_call_id: 'c1', content: 'results' }
        ]);

        // T8 reversed the posture for THIS one field: thinking the projection left
        // on an entry is echoed back under the provider's spelling, and NOTHING
        // else about it travels — no `reasoning` key, no internal field names.
        expect(JSON.stringify(body)).not.toContain('"reasoning"');
        expect(JSON.stringify(body)).not.toContain('reasoningIncluded');
    });

    // Stage 1a: `included` is transcript/projection state, not provider state. The
    // transport field-selects per role, so a flag that survives onto a SENT entry
    // (an explicitly-`true` one, which the projection keeps verbatim) can never
    // become a wire field — strict gateways reject unknown message fields.
    it('never puts the context-inclusion flag on the provider wire', async () => {
        const fetchMock = stubFetch(['data: [DONE]\n\n']);

        await collect(
            openAICompatible({ baseURL: 'http://x/v1' })({
                model: 'm',
                messages: [
                    { role: 'system', content: 'ctx', included: true },
                    { role: 'user', content: 'search', included: true },
                    {
                        role: 'assistant',
                        content: '',
                        included: true,
                        toolCalls: [{ id: 'c1', name: 'websearch', arguments: '{"q":"news"}' }]
                    },
                    {
                        role: 'tool',
                        content: 'results',
                        toolCallId: 'c1',
                        name: 'websearch',
                        included: true
                    }
                ]
            })
        );

        const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));

        expect(body.messages).toEqual([
            { role: 'system', content: 'ctx' },
            { role: 'user', content: 'search' },
            {
                role: 'assistant',
                content: '',
                tool_calls: [
                    { id: 'c1', type: 'function', function: { name: 'websearch', arguments: '{"q":"news"}' } }
                ]
            },
            { role: 'tool', tool_call_id: 'c1', content: 'results' }
        ]);
        expect(JSON.stringify(body)).not.toContain('included');
    });

    // Compaction T1: the persisted tool outcome is transcript state exactly like the flag
    // above — the harness keeps it so a later round, a snapshot or a fork can read WHY a
    // call ended, and the wire keeps only what a provider accepts. A strict gateway rejects
    // unknown message fields, so a tool result must serialize to the same three keys with
    // or without the key, which is also the proof that persisting an outcome cannot change
    // a replayed request or break a cache prefix.
    it('never puts the persisted tool outcome on the provider wire', async () => {
        const fetchMock = stubFetch(['data: [DONE]\n\n']);

        await collect(
            openAICompatible({ baseURL: 'http://x/v1' })({
                model: 'm',
                messages: [
                    {
                        role: 'assistant',
                        content: '',
                        toolCalls: [
                            { id: 'c1', name: 'websearch', arguments: '{"q":"news"}' },
                            { id: 'c2', name: 'websearch', arguments: '{"q":"weather"}' }
                        ]
                    },
                    {
                        role: 'tool',
                        content: 'Tool "websearch" failed: kaput',
                        toolCallId: 'c1',
                        name: 'websearch',
                        outcome: 'failed'
                    },
                    {
                        role: 'tool',
                        content: 'Tool "websearch" was cancelled before it produced a value.',
                        toolCallId: 'c2',
                        name: 'websearch',
                        outcome: 'cancelled'
                    }
                ]
            })
        );

        const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));

        expect(body.messages).toEqual([
            {
                role: 'assistant',
                content: '',
                tool_calls: [
                    { id: 'c1', type: 'function', function: { name: 'websearch', arguments: '{"q":"news"}' } },
                    { id: 'c2', type: 'function', function: { name: 'websearch', arguments: '{"q":"weather"}' } }
                ]
            },
            { role: 'tool', tool_call_id: 'c1', content: 'Tool "websearch" failed: kaput' },
            {
                role: 'tool',
                tool_call_id: 'c2',
                content: 'Tool "websearch" was cancelled before it produced a value.'
            }
        ]);
        // Nothing but the result text distinguishes a failed call on the wire today.
        expect(JSON.stringify(body)).not.toContain('outcome');
        expect(JSON.stringify(body)).not.toContain('isError');
    });

    // ---------------------------------------------------------------------------
    // Trimmer uplift T8 — the thoughts tiers made visible on the wire.
    //
    // NOT TESTED AGAINST REAL PROVIDERS (task brief Part K): no live DeepSeek, Kimi
    // or Anthropic round-trip was observed for `reasoning_content`. Every case here
    // drives the stubbed `fetch`, so what is pinned is the REQUEST SHAPE the policy
    // produces — the vendors' acceptance of that shape is vendor documentation as
    // read 2026-11-10, not a measurement.
    //
    // The tier DECISION is not the transport's: `dropOldThoughts` writes
    // `reasoningIncluded: false` on canonical state (the `context-trimmer` built-in
    // in `plugins/`) and `core/agent.ts` `withoutWithheldReasoning` resolves that
    // flag OUT of the request copy, dropping the `reasoning` key entirely
    // (`src/harness.inclusion.test.ts` §13 owns that contract). A projected entry
    // therefore reaches this transport with either a non-empty `reasoning` string or
    // no `reasoning` key at all, and each tier below is written as the projected
    // shape it produces:
    //   `turn` (default) — the open turn's entries carry `reasoning`, every closed
    //       turn's entry carries none;
    //   `all`            — no entry carries `reasoning`, which is the byte-identity
    //       case against the pre-T8 wire;
    //   `off`            — every entry carries its thinking.
    // ---------------------------------------------------------------------------

    // A first model step has no committed assistant entry in front of it, so the
    // field must not appear at all — not on the system or user entry, and not as a
    // key on any other message.
    it('sends no reasoning_content at all on a first-step request', async () => {
        const fetchMock = stubFetch(['data: [DONE]\n\n']);

        await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));

        const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));

        expect(body.messages).toEqual([
            { role: 'system', content: 'You are a writer.' },
            { role: 'user', content: 'Write' }
        ]);
        // The whole body is checked, so an accidental `reasoning_content: undefined`
        // or an empty-string echo would still fail here.
        expect(JSON.stringify(body)).not.toContain('reasoning');
    });

    // The `turn` tier's open-turn shape, mid tool loop: every assistant entry the
    // loop has committed keeps its thinking, so every one of them is echoed, in
    // place, with the text verbatim.
    it('echoes every open-turn thinking block on a tool-loop continuation', async () => {
        const fetchMock = stubFetch(['data: [DONE]\n\n']);

        await collect(
            openAICompatible({ baseURL: 'http://x/v1' })({
                model: 'm',
                messages: [
                    { role: 'user', content: 'search' },
                    {
                        role: 'assistant',
                        content: '',
                        reasoning: 'first thought: call websearch',
                        toolCalls: [{ id: 'c1', name: 'websearch', arguments: '{"q":"news"}' }]
                    },
                    { role: 'tool', content: 'results', toolCallId: 'c1', name: 'websearch' },
                    {
                        role: 'assistant',
                        content: 'the news is x',
                        reasoning: 'second thought: answer now',
                        toolCalls: [{ id: 'c2', name: 'summarise', arguments: '{}' }]
                    },
                    { role: 'tool', content: 'ok', toolCallId: 'c2', name: 'summarise' }
                ]
            })
        );

        const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));

        expect(body.messages).toEqual([
            { role: 'user', content: 'search' },
            {
                role: 'assistant',
                content: '',
                reasoning_content: 'first thought: call websearch',
                tool_calls: [
                    { id: 'c1', type: 'function', function: { name: 'websearch', arguments: '{"q":"news"}' } }
                ]
            },
            { role: 'tool', tool_call_id: 'c1', content: 'results' },
            {
                role: 'assistant',
                content: 'the news is x',
                reasoning_content: 'second thought: answer now',
                tool_calls: [{ id: 'c2', type: 'function', function: { name: 'summarise', arguments: '{}' } }]
            },
            { role: 'tool', tool_call_id: 'c2', content: 'ok' }
        ]);
    });

    // The `turn` tier's closed-turn shape: the projection EMITS the entry — same
    // slot, same `content`, same `tool_calls`, so pairing is untouched — with the
    // `reasoning` key resolved out. The field must be ABSENT, never `""`.
    it('omits reasoning_content for a closed turn whose thinking was withheld', async () => {
        const fetchMock = stubFetch(['data: [DONE]\n\n']);

        await collect(
            openAICompatible({ baseURL: 'http://x/v1' })({
                model: 'm',
                messages: [
                    // A closed turn: entry 1 is what a flagged entry's request copy
                    // looks like — no `reasoning` key.
                    { role: 'user', content: 'old question' },
                    {
                        role: 'assistant',
                        content: 'old answer',
                        toolCalls: [{ id: 'c0', name: 'alpha', arguments: '{}' }]
                    },
                    { role: 'tool', content: 'old result', toolCallId: 'c0', name: 'alpha' },
                    // The open turn: still echoed, so the omission above is proven to
                    // be a per-entry decision and not a whole-request one.
                    { role: 'user', content: 'new question' },
                    {
                        role: 'assistant',
                        content: '',
                        reasoning: 'open turn thought',
                        toolCalls: [{ id: 'c1', name: 'beta', arguments: '{}' }]
                    }
                ]
            })
        );

        const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));

        expect(body.messages).toEqual([
            { role: 'user', content: 'old question' },
            {
                role: 'assistant',
                content: 'old answer',
                tool_calls: [{ id: 'c0', type: 'function', function: { name: 'alpha', arguments: '{}' } }]
            },
            { role: 'tool', tool_call_id: 'c0', content: 'old result' },
            { role: 'user', content: 'new question' },
            {
                role: 'assistant',
                content: '',
                reasoning_content: 'open turn thought',
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'beta', arguments: '{}' } }]
            }
        ]);
        // Absent, not empty: a strict provider reads `""` as a thinking block whose
        // content is missing. The count proves the omission is per-entry — the open
        // turn's entry above still got its field.
        expect(body.messages[1]).not.toHaveProperty('reasoning_content');
        expect(JSON.stringify(body).match(/reasoning_content/g)).toHaveLength(1);
    });

    // An empty string is the one value that must never become the field, even though
    // the key is technically present on the entry. The runtime never commits one
    // (`core/agent.ts` stores `reasoning` only when non-empty), so this is the
    // hand-built/host-seeded transcript case.
    it('omits reasoning_content rather than echoing an empty string', async () => {
        const fetchMock = stubFetch(['data: [DONE]\n\n']);

        await collect(
            openAICompatible({ baseURL: 'http://x/v1' })({
                model: 'm',
                messages: [
                    { role: 'user', content: 'search' },
                    {
                        role: 'assistant',
                        content: 'an answer with no thinking',
                        reasoning: ''
                    }
                ]
            })
        );

        const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));

        expect(body.messages).toEqual([
            { role: 'user', content: 'search' },
            { role: 'assistant', content: 'an answer with no thinking' }
        ]);
        expect(body.messages[1]).not.toHaveProperty('reasoning_content');
        expect(JSON.stringify(body)).not.toContain('reasoning');
    });

    // The `dropOldThoughts: 'all'` equivalence, stated as a byte comparison: with no
    // thinking anywhere in the projected transcript the payload is exactly what this
    // transport sent before the echo existed — same keys, same KEY ORDER. The
    // expected payload is declared in wire key order, because `JSON.stringify` of
    // both sides compares bytes, not just structure.
    it('is byte-identical to the pre-echo wire when no message carries thinking', async () => {
        const fetchMock = stubFetch(['data: [DONE]\n\n']);

        await collect(
            openAICompatible({ baseURL: 'http://x/v1' })({
                model: 'm',
                messages: [
                    { role: 'system', content: 'ctx' },
                    { role: 'user', content: 'search' },
                    {
                        role: 'assistant',
                        content: '',
                        toolCalls: [{ id: 'c1', name: 'websearch', arguments: '{"q":"news"}' }]
                    },
                    { role: 'tool', content: 'results', toolCallId: 'c1', name: 'websearch' },
                    { role: 'assistant', content: 'done' }
                ]
            })
        );

        const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));

        const preEchoWire = [
            { role: 'system', content: 'ctx' },
            { role: 'user', content: 'search' },
            {
                role: 'assistant',
                content: '',
                tool_calls: [
                    { id: 'c1', type: 'function', function: { name: 'websearch', arguments: '{"q":"news"}' } }
                ]
            },
            { role: 'tool', tool_call_id: 'c1', content: 'results' },
            { role: 'assistant', content: 'done' }
        ];

        expect(JSON.stringify(body.messages)).toBe(JSON.stringify(preEchoWire));
    });

    // The transport never reads the flag and never forwards it. That is a decision,
    // not an accident: a canonical entry handed straight to a custom transport still
    // echoes its thinking (the projection, not the transport, owns the withhold), and
    // the flag key itself stays transcript state like `included` and `outcome` —
    // strict gateways reject unknown message fields.
    it('never puts the reasoningIncluded flag on the wire, and never reads it', async () => {
        const fetchMock = stubFetch(['data: [DONE]\n\n']);

        await collect(
            openAICompatible({ baseURL: 'http://x/v1' })({
                model: 'm',
                messages: [
                    { role: 'user', content: 'search' },
                    {
                        role: 'assistant',
                        content: '',
                        reasoning: 'thought a host handed over directly',
                        reasoningIncluded: false,
                        toolCalls: [{ id: 'c1', name: 'websearch', arguments: '{"q":"news"}' }]
                    }
                ]
            })
        );

        const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));

        expect(body.messages[1]).toEqual({
            role: 'assistant',
            content: '',
            reasoning_content: 'thought a host handed over directly',
            tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'websearch', arguments: '{"q":"news"}' } }
            ]
        });
        expect(JSON.stringify(body)).not.toContain('reasoningIncluded');
    });

    // The provider answers a non-object `function.arguments` with a bare
    // `500 Internal Server Error` for the WHOLE request, so a tool call that a
    // token-capped generation cut off mid-JSON would otherwise fail every later
    // request on the thread. The transcript keeps the broken text (it is what the
    // model actually sent, and the UI shows it); the wire gets a valid object.
    it('replaces non-object tool-call arguments with {} on the wire', async () => {
        const fetchMock = stubFetch(['data: [DONE]\n\n']);

        const broken = ['{"q":"once upon', '[1,2]', '42', '"a query"', 'null', 'true', ''];

        await collect(
            openAICompatible({ baseURL: 'http://x/v1' })({
                model: 'm',
                messages: broken.map((args, index) => ({
                    role: 'assistant' as const,
                    content: '',
                    toolCalls: [{ id: `c${index}`, name: 'search', arguments: args }]
                }))
            })
        );

        const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));

        expect(body.messages.map((m: { tool_calls: [{ function: { arguments: string } }] }) =>
            m.tool_calls[0].function.arguments
        )).toEqual(broken.map(() => '{}'));
    });

    it('passes object tool-call arguments through byte-for-byte', async () => {
        const fetchMock = stubFetch(['data: [DONE]\n\n']);

        const intact = ['{"q":"news"}', '{}', '{"a":{"b":[1,2]}}'];

        await collect(
            openAICompatible({ baseURL: 'http://x/v1' })({
                model: 'm',
                messages: intact.map((args, index) => ({
                    role: 'assistant' as const,
                    content: '',
                    toolCalls: [{ id: `c${index}`, name: 'search', arguments: args }]
                }))
            })
        );

        const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));

        expect(
            body.messages.map((m: { tool_calls: [{ function: { arguments: string } }] }) =>
                m.tool_calls[0].function.arguments
            )
        ).toEqual(intact);
    });

    it('resolves a getter api key per request', async () => {
        const fetchMock = stubFetch(['data: [DONE]\n\n']);

        let key = 'first';
        const stream = openAICompatible({ baseURL: 'http://x/v1', apiKey: () => key });

        await collect(stream(request));
        key = 'second';
        await collect(stream(request));

        const headers = fetchMock.mock.calls.map(
            ([, init]) => (init as RequestInit).headers as Record<string, string>
        );

        expect(headers[0].authorization).toBe('Bearer first');
        expect(headers[1].authorization).toBe('Bearer second');
    });

    it('streams text deltas and reports the stop reason', async () => {
        stubFetch([
            sse({ choices: [{ delta: { content: 'Once ' } }] }),
            sse({ choices: [{ delta: { content: 'upon' } }] }),
            sse({ choices: [{ delta: {}, finish_reason: 'length' }] }),
            'data: [DONE]\n\n'
        ]);

        const events = await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));

        expect(events).toEqual([
            { type: 'text', delta: 'Once ' },
            { type: 'text', delta: 'upon' },
            { type: 'done', stopReason: 'length', toolCalls: [], usage: undefined }
        ]);
    });

    it('reads reasoning from reasoning_content and reasoning', async () => {
        stubFetch([
            sse({ choices: [{ delta: { reasoning_content: 'think ' } }] }),
            sse({ choices: [{ delta: { reasoning: 'more' } }] }),
            sse({ choices: [{ delta: { content: 'answer' } }] }),
            'data: [DONE]\n\n'
        ]);

        const events = await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));

        expect(events).toEqual([
            { type: 'reasoning', delta: 'think ' },
            { type: 'reasoning', delta: 'more' },
            { type: 'text', delta: 'answer' },
            { type: 'done', stopReason: 'stop', toolCalls: [], usage: undefined }
        ]);
    });

    it('accumulates streamed tool-call fragments into complete calls', async () => {
        stubFetch([
            sse({
                choices: [
                    {
                        delta: {
                            tool_calls: [{ index: 0, id: 'call_1', function: { name: 'web', arguments: '' } }]
                        }
                    }
                ]
            }),
            sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] } }] }),
            sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"news"}' } }] } }] }),
            sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
            'data: [DONE]\n\n'
        ]);

        const events = await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));

        expect(events.at(-1)).toEqual({
            type: 'done',
            stopReason: 'tool_calls',
            toolCalls: [{ id: 'call_1', name: 'web', arguments: '{"q":"news"}' }],
            usage: undefined
        });
    });

    it('orders parallel tool calls by stream index', async () => {
        stubFetch([
            sse({
                choices: [
                    {
                        delta: {
                            tool_calls: [
                                { index: 0, id: 'c0', function: { name: 'first', arguments: '{}' } },
                                { index: 1, id: 'c1', function: { name: 'second', arguments: '{}' } }
                            ]
                        }
                    }
                ]
            }),
            sse({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
            'data: [DONE]\n\n'
        ]);

        const events = await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));
        const done = events.at(-1);

        expect(done?.type === 'done' && done.toolCalls.map((call) => call.name)).toEqual(['first', 'second']);
    });

    it('treats tool calls without a finish_reason as a tool turn', async () => {
        stubFetch([
            sse({
                choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 't', arguments: '{}' } }] } }]
            }),
            'data: [DONE]\n\n'
        ]);

        const events = await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));
        const done = events.at(-1);

        expect(done?.type === 'done' && done.stopReason).toBe('tool_calls');
    });

    it('captures usage from a trailing usage-only chunk', async () => {
        stubFetch([
            sse({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }),
            sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } }),
            'data: [DONE]\n\n'
        ]);

        const events = await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));

        expect(events.at(-1)).toEqual({
            type: 'done',
            stopReason: 'stop',
            toolCalls: [],
            usage: { input: 10, output: 4, total: 14 }
        });
    });

    // Cached input — the replayed prefix. Two wire keys mean the same fact:
    // OpenAI-compatible `prompt_tokens_details.cached_tokens` and
    // DeepSeek-compatible `prompt_cache_hit_tokens`. See cachedOf in openai.ts.
    it('reads cached input from prompt_tokens_details.cached_tokens', async () => {
        stubFetch([
            sse({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }),
            sse({
                choices: [],
                usage: {
                    prompt_tokens: 10,
                    completion_tokens: 4,
                    total_tokens: 14,
                    prompt_tokens_details: { cached_tokens: 8 }
                }
            }),
            'data: [DONE]\n\n'
        ]);

        const events = await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));

        expect(events.at(-1)).toEqual({
            type: 'done',
            stopReason: 'stop',
            toolCalls: [],
            usage: { input: 10, output: 4, total: 14, cached: 8 }
        });
    });

    it('reads cached input from DeepSeek-compatible prompt_cache_hit_tokens', async () => {
        stubFetch([
            sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
            sse({
                choices: [],
                usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_cache_hit_tokens: 7 }
            }),
            'data: [DONE]\n\n'
        ]);

        const events = await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));

        expect(events.at(-1)).toEqual({
            type: 'done',
            stopReason: 'stop',
            toolCalls: [],
            usage: { input: 10, output: 4, total: 14, cached: 7 }
        });
    });

    // Both keys present with different values: the OpenAI-compatible standard
    // wins, so 6 (not 99) is reported.
    it('prefers prompt_tokens_details.cached_tokens over prompt_cache_hit_tokens', async () => {
        stubFetch([
            sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
            sse({
                choices: [],
                usage: {
                    prompt_tokens: 10,
                    completion_tokens: 4,
                    total_tokens: 14,
                    prompt_tokens_details: { cached_tokens: 6 },
                    prompt_cache_hit_tokens: 99
                }
            }),
            'data: [DONE]\n\n'
        ]);

        const events = await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));

        expect(events.at(-1)).toEqual({
            type: 'done',
            stopReason: 'stop',
            toolCalls: [],
            usage: { input: 10, output: 4, total: 14, cached: 6 }
        });
    });

    // A gateway reporting more cached tokens than prompt tokens contradicts its
    // own block; the value is clamped to the input so `cached > input` can never
    // be rendered. See the clamp in usageOf (openai.ts).
    it('clamps cached tokens to the prompt tokens', async () => {
        stubFetch([
            sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
            sse({
                choices: [],
                usage: {
                    prompt_tokens: 10,
                    completion_tokens: 4,
                    total_tokens: 14,
                    prompt_tokens_details: { cached_tokens: 99 }
                }
            }),
            'data: [DONE]\n\n'
        ]);

        const events = await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));

        expect(events.at(-1)).toEqual({
            type: 'done',
            stopReason: 'stop',
            toolCalls: [],
            usage: { input: 10, output: 4, total: 14, cached: 10 }
        });
    });

    // No cache fields at all means "unknown", not "nothing cached": the usage
    // object must not carry a `cached` key at all. `toStrictEqual` is used here
    // because `toEqual` would also accept a present-but-undefined key.
    it('omits cached entirely when the provider reports no cache fields', async () => {
        stubFetch([
            sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
            sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }),
            'data: [DONE]\n\n'
        ]);

        const events = await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));

        expect(events.at(-1)).toEqual({
            type: 'done',
            stopReason: 'stop',
            toolCalls: [],
            usage: { input: 10, output: 4, total: 14 }
        });
        expect(usageOfDone(events.at(-1))).toStrictEqual({ input: 10, output: 4, total: 14 });
    });

    // `prompt_tokens_details: null` is what some gateways send when they do not
    // track a cache; the parser must not throw and must not invent a value.
    it('ignores a null prompt_tokens_details', async () => {
        stubFetch([
            sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
            sse({
                choices: [],
                usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: null }
            }),
            'data: [DONE]\n\n'
        ]);

        const events = await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));

        expect(events.at(-1)).toEqual({
            type: 'done',
            stopReason: 'stop',
            toolCalls: [],
            usage: { input: 10, output: 4, total: 14 }
        });
        expect(usageOfDone(events.at(-1))).toStrictEqual({ input: 10, output: 4, total: 14 });
    });

    // A non-object `prompt_tokens_details` (string here, number in the next
    // case) is also tolerated and yields no `cached`.
    it('ignores a non-object prompt_tokens_details', async () => {
        stubFetch([
            sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
            sse({
                choices: [],
                usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: 'cached' }
            }),
            'data: [DONE]\n\n'
        ]);

        const events = await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));

        expect(usageOfDone(events.at(-1))).toStrictEqual({ input: 10, output: 4, total: 14 });
    });

    it('ignores a numeric prompt_tokens_details', async () => {
        stubFetch([
            sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
            sse({
                choices: [],
                usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_tokens_details: 8 }
            }),
            'data: [DONE]\n\n'
        ]);

        const events = await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));

        expect(usageOfDone(events.at(-1))).toStrictEqual({ input: 10, output: 4, total: 14 });
    });

    // A negative or non-numeric cache value is not usable and is ignored rather
    // than surfaced as a negative "cached" count.
    it('ignores a negative cached token count', async () => {
        stubFetch([
            sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
            sse({
                choices: [],
                usage: {
                    prompt_tokens: 10,
                    completion_tokens: 4,
                    total_tokens: 14,
                    prompt_tokens_details: { cached_tokens: -3 }
                }
            }),
            'data: [DONE]\n\n'
        ]);

        const events = await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));

        expect(usageOfDone(events.at(-1))).toStrictEqual({ input: 10, output: 4, total: 14 });
    });

    it('ignores non-data SSE lines and stops at [DONE]', async () => {
        stubFetch([
            ': keep-alive comment\n\n',
            'event: message\n',
            sse({ choices: [{ delta: { content: 'a' } }] }),
            'data: [DONE]\n\n',
            sse({ choices: [{ delta: { content: 'never' } }] })
        ]);

        const events = await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));

        expect(events).toEqual([
            { type: 'text', delta: 'a' },
            { type: 'done', stopReason: 'stop', toolCalls: [], usage: undefined }
        ]);
    });

    it('flushes a final frame that has no trailing newline', async () => {
        stubFetch([`data: ${JSON.stringify({ choices: [{ delta: { content: 'tail' } }] })}`]);

        const events = await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));

        expect(events[0]).toEqual({ type: 'text', delta: 'tail' });
    });

    it('reports a non-2xx response as an error frame', async () => {
        stubFetch(['upstream unavailable'], { status: 503, statusText: 'Service Unavailable' });

        const events = await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));

        expect(events).toEqual([{ type: 'error', message: 'HTTP 503: upstream unavailable' }]);
    });

    it('reports a provider error attached to a 200 stream', async () => {
        stubFetch([sse({ error: { message: 'model overloaded' } })]);

        const events = await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));

        expect(events).toEqual([{ type: 'error', message: 'model overloaded' }]);
    });

    it('reports a malformed frame instead of emitting half a response', async () => {
        stubFetch(['data: {not json}\n\n']);

        const events = await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));

        expect(events).toEqual([{ type: 'error', message: 'Malformed stream frame: {not json}' }]);
    });

    it('reports a connection failure as an error frame', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new Error('ECONNREFUSED');
            })
        );

        const events = await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));

        expect(events).toEqual([
            { type: 'error', message: 'Request to http://x/v1/chat/completions failed: ECONNREFUSED' }
        ]);
    });

    // R1: a body that closes WITHOUT `[DONE]` and without a finish_reason is a
    // truncated stream, not an empty answer. Reporting it as an error frame is what
    // lets the agent retry it instead of committing half a response.
    it('reports a truncated stream that never reported a completion', async () => {
        stubFetch([sse({ choices: [{ delta: { content: 'half' } }] })]);

        const events = await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));

        expect(events).toEqual([
            { type: 'text', delta: 'half' },
            { type: 'error', message: 'The model stream ended before reporting a completion.' }
        ]);
    });

    it('accepts a stream terminated by finish_reason without [DONE]', async () => {
        stubFetch([sse({ choices: [{ delta: { content: 'complete' }, finish_reason: 'stop' }] })]);

        const events = await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));

        expect(events).toEqual([
            { type: 'text', delta: 'complete' },
            { type: 'done', stopReason: 'stop', toolCalls: [], usage: undefined }
        ]);
    });
});

// ---------------------------------------------------------------------------
// issue 0001 — request-body extension (`extraBody`, `responseFormat`,
// `options.buildBody`). Every body claim here is asserted on the fetch stub, i.e.
// on the exact bytes that would leave the process — not inferred from a helper.
// ---------------------------------------------------------------------------

// The serialized body of the single call a stubbed fetch recorded.
const sentBody = (fetchMock: ReturnType<typeof stubFetch>): string =>
    String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body);

// The parsed body, for assertions about a specific field.
const sentJson = (fetchMock: ReturnType<typeof stubFetch>): Record<string, unknown> =>
    JSON.parse(sentBody(fetchMock)) as Record<string, unknown>;

// Asserts a construction-time rejection: right error type, right machine code, and a
// message that NAMES the field the host wrote (issue 0001 AC3).
const expectRejected = (build: () => unknown, field: string): string => {
    let caught: unknown;

    try {
        build();
    } catch (error) {
        caught = error;
    }

    if (!(caught instanceof HarnessError)) throw new Error(`expected a HarnessError, got ${JSON.stringify(caught)}`);

    expect(caught.code).toBe(PROVIDER_REQUEST_BODY_CODE);
    expect(caught.message).toContain(field);

    return caught.message;
};

describe('request-body extension (issue 0001)', () => {
    // The regression the whole issue exists for: an UNSET extension must not move a
    // single byte, so a gateway that rejects unknown fields sees the body it always
    // saw. `toBe` on the serialized string is the exact form of that claim.
    it('sends the default body byte-for-byte when no extension is configured', async () => {
        const fetchMock = stubFetch(['data: [DONE]\n\n']);

        await collect(
            openAICompatible({ baseURL: 'http://x/v1', sampling: { temperature: 0.7 } })(request)
        );

        expect(sentBody(fetchMock)).toBe(
            '{"model":"merge/ds4-flash","stream":true,' +
                '"messages":[{"role":"system","content":"You are a writer."},' +
                '{"role":"user","content":"Write"}],"temperature":0.7}'
        );
    });

    // AC1, the wire half: the opt-in is a host decision, and the usage frame the
    // gateway then sends is parsed by the SAME reader (the agent/harness halves of AC1
    // are pinned in src/core/agent.test.ts and the existing harness usage tests).
    it('sends stream_options from extraBody and reports the usage frame it bought', async () => {
        const fetchMock = stubFetch([
            sse({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }),
            sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }),
            'data: [DONE]\n\n'
        ]);

        const events = await collect(
            openAICompatible({
                baseURL: 'http://x/v1',
                extraBody: { stream_options: { include_usage: true } }
            })(request)
        );

        expect(sentJson(fetchMock)).toEqual({
            model: 'merge/ds4-flash',
            stream: true,
            messages: request.messages,
            stream_options: { include_usage: true }
        });
        expect(events).toEqual([
            { type: 'text', delta: 'hi' },
            { type: 'done', stopReason: 'stop', toolCalls: [], usage: { input: 10, output: 4, total: 14 } }
        ]);
    });

    it('calls the extraBody function form once per request with the resolved request', async () => {
        const fetchMock = stubFetch([
            'data: [DONE]\n\n',
        ]);
        const controller = new AbortController();
        const withTools: HarnessStreamRequest = {
            model: 'merge/ds4-flash',
            messages: [{ role: 'user', content: 'Search' }],
            tools: [{ name: 'websearch', description: 'Search the web.' }],
            signal: controller.signal
        };

        const seen: HarnessStreamRequest[] = [];
        const stream = openAICompatible({
            baseURL: 'http://x/v1',
            extraBody: (req) => {
                seen.push(req);

                return { tool_choice: 'required', parallel_tool_calls: false };
            }
        });

        await collect(stream(withTools));
        await collect(stream(withTools));

        // Identity, not a copy: a host keys the extension off the very request object
        // the transport was handed (its `signal` and `tools` are the live ones).
        expect(seen).toEqual([withTools, withTools]);
        expect(sentJson(fetchMock)).toEqual({
            model: 'merge/ds4-flash',
            stream: true,
            messages: [{ role: 'user', content: 'Search' }],
            tools: [
                {
                    type: 'function',
                    // wireTool's default for a declaration with no `parameters` — the
                    // point of this test is the extension fields, not this shape.
                    function: {
                        name: 'websearch',
                        description: 'Search the web.',
                        parameters: { type: 'object', properties: {} }
                    }
                }
            ],
            tool_choice: 'required',
            parallel_tool_calls: false
        });
    });

    // AC3, the precedence rule: an extension ADDS fields. It cannot hijack the request
    // shape, including `stream` (which the SSE reader below depends on) and the
    // sampling numbers.
    it('never lets extraBody override model, messages, tools, stream or sampling', async () => {
        const hijack = {
            model: 'hijacked',
            messages: [{ role: 'user', content: 'injected' }],
            tools: [{ type: 'function', function: { name: 'ghost' } }],
            stream: false,
            temperature: 0.9
        };

        // Case 1: the request declares NO tools. The host's `tools` must not survive
        // either, because a tool the harness never declared has no implementation to
        // route its call to.
        const withoutTools = stubFetch(['data: [DONE]\n\n']);

        await collect(
            openAICompatible({
                baseURL: 'http://x/v1',
                sampling: { temperature: 0.2 },
                extraBody: hijack
            })(request)
        );

        expect(sentJson(withoutTools)).toEqual({
            model: 'merge/ds4-flash',
            stream: true,
            messages: request.messages,
            temperature: 0.2
        });

        // Case 2: the request DOES declare tools — the declared list wins, and every
        // other extension field still arrives.
        const withDeclared = stubFetch(['data: [DONE]\n\n']);

        await collect(
            openAICompatible({
                baseURL: 'http://x/v1',
                sampling: { temperature: 0.2 },
                extraBody: { ...hijack, seed: 11 }
            })({
                ...request,
                tools: [{ name: 'websearch', description: 'Search the web.' }]
            })
        );

        expect(sentJson(withDeclared)).toEqual({
            model: 'merge/ds4-flash',
            stream: true,
            messages: request.messages,
            tools: [
                {
                    type: 'function',
                    function: {
                        name: 'websearch',
                        description: 'Search the web.',
                        parameters: { type: 'object', properties: {} }
                    }
                }
            ],
            temperature: 0.2,
            seed: 11
        });
    });

    it('bounds the extension at MAX_EXTRA_BODY_BYTES and names the field', async () => {
        const over = { filler: 'x'.repeat(MAX_EXTRA_BODY_BYTES) };
        const message = expectRejected(
            () => openAICompatible({ baseURL: 'http://x/v1', extraBody: over }),
            'provider.extraBody'
        );

        // `{"filler":"…"}` adds 13 bytes of structure, so the reported size is exactly
        // the filler plus that.
        expect(message).toContain(`${MAX_EXTRA_BODY_BYTES + 13} bytes`);
        expect(message).toContain(`over the ${MAX_EXTRA_BODY_BYTES} byte cap`);

        // EXACTLY at the cap still sends — the cap is `>`, not `>=`, so a host that
        // measures the same way is never rejected by an off-by-one.
        const fetchMock = stubFetch(['data: [DONE]\n\n']);

        await collect(
            openAICompatible({
                baseURL: 'http://x/v1',
                extraBody: { filler: 'x'.repeat(MAX_EXTRA_BODY_BYTES - 13) }
            })(request)
        );

        expect(String(sentJson(fetchMock).filler)).toHaveLength(MAX_EXTRA_BODY_BYTES - 13);
    });

    it('rejects every extraBody shape that is not a plain JSON object at construction', () => {
        const circular: Record<string, unknown> = { name: 'loop' };
        circular.self = circular;

        const rejected: Array<[string, unknown]> = [
            ['an array', []],
            ['a string', 'stream_options'],
            ['a number', 7],
            ['a Date', new Date()],
            ['a class instance', new (class Thing { own = 1; })()],
            ['a circular object', circular]
        ];

        for (const [label, value] of rejected) {
            expectRejected(
                () => openAICompatible({ baseURL: 'http://x/v1', extraBody: value as never }),
                'provider.extraBody'
            );
        }

        // A value that is not an object AND not a function gets the shape sentence, so
        // the host learns both accepted forms.
        expect(
            expectRejected(
                () => openAICompatible({ baseURL: 'http://x/v1', extraBody: 7 as never }),
                'provider.extraBody'
            )
        ).toContain('a plain JSON object or a function returning one');
    });

    it('rejects an extraBody key that JSON would silently drop', () => {
        const cases: Array<[Record<string, unknown>, string]> = [
            [
                { stream_options: undefined },
                '`provider.extraBody.stream_options` cannot be undefined'
            ],
            [{ seed: () => 1 }, '`provider.extraBody.seed` cannot be function'],
            [{ seed: Symbol('s') }, '`provider.extraBody.seed` cannot be symbol']
        ];

        for (const [value, expected] of cases) {
            expect(
                expectRejected(
                    () => openAICompatible({ baseURL: 'http://x/v1', extraBody: value as never }),
                    'provider.extraBody'
                )
            ).toContain(expected);
        }
    });

    it('reports an extraBody function that returns a rejected value as an error frame without fetching', async () => {
        const fetchMock = stubFetch(['data: [DONE]\n\n']);

        const events = await collect(
            openAICompatible({
                baseURL: 'http://x/v1',
                extraBody: () => ({ nope: undefined }) as never
            })(request)
        );

        expect(events).toEqual([
            {
                type: 'error',
                message:
                    '`provider.extraBody.nope` cannot be undefined: it would be dropped from the request body. Omit the key instead.'
            }
        ]);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    // AC2: all three shapes, each asserted on the serialized body.
    it('maps responseFormat "text" onto response_format.type text', async () => {
        const fetchMock = stubFetch(['data: [DONE]\n\n']);

        await collect(openAICompatible({ baseURL: 'http://x/v1', responseFormat: 'text' })(request));

        expect(sentJson(fetchMock).response_format).toEqual({ type: 'text' });
    });

    it('maps responseFormat "json" onto response_format.type json_object', async () => {
        const fetchMock = stubFetch(['data: [DONE]\n\n']);

        await collect(openAICompatible({ baseURL: 'http://x/v1', responseFormat: 'json' })(request));

        expect(sentJson(fetchMock).response_format).toEqual({ type: 'json_object' });
    });

    it('maps a jsonSchema responseFormat onto response_format.type json_schema', async () => {
        const fetchMock = stubFetch(['data: [DONE]\n\n']);
        const schema = {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer']
        };

        await collect(
            openAICompatible({
                baseURL: 'http://x/v1',
                responseFormat: { jsonSchema: { name: 'answer', schema, strict: true } }
            })(request)
        );

        expect(sentJson(fetchMock).response_format).toEqual({
            type: 'json_schema',
            json_schema: { name: 'answer', schema, strict: true }
        });
    });

    it('omits strict from the json_schema body when it is not configured', async () => {
        const fetchMock = stubFetch(['data: [DONE]\n\n']);

        await collect(
            openAICompatible({
                baseURL: 'http://x/v1',
                responseFormat: { jsonSchema: { name: 'answer', schema: { type: 'object' } } }
            })(request)
        );

        // `toStrictEqual` is the point: an emitted `strict: undefined` key would still
        // satisfy `toEqual`, and a gateway may read it as an explicit false.
        expect(sentJson(fetchMock)).toStrictEqual({
            model: 'merge/ds4-flash',
            stream: true,
            messages: request.messages,
            response_format: { type: 'json_schema', json_schema: { name: 'answer', schema: { type: 'object' } } }
        });
    });

    it('lets the first-class responseFormat win over an extraBody key of the same name', async () => {
        const fetchMock = stubFetch(['data: [DONE]\n\n']);

        await collect(
            openAICompatible({
                baseURL: 'http://x/v1',
                responseFormat: 'json',
                extraBody: { response_format: { type: 'text' }, seed: 7 }
            })(request)
        );

        expect(sentJson(fetchMock)).toEqual({
            model: 'merge/ds4-flash',
            stream: true,
            messages: request.messages,
            seed: 7,
            response_format: { type: 'json_object' }
        });
    });

    it('rejects every malformed responseFormat at construction, naming the field', () => {
        const rejected: unknown[] = [
            'jsonl',
            7,
            {},
            { jsonSchema: 'answer' },
            { jsonSchema: { name: '', schema: { type: 'object' } } },
            { jsonSchema: { name: 'not a gateway name!', schema: { type: 'object' } } },
            { jsonSchema: { name: 'x'.repeat(65), schema: { type: 'object' } } },
            { jsonSchema: { name: 'answer', schema: 'object' } },
            { jsonSchema: { name: 'answer', schema: { type: 'object' }, strict: 'yes' } },
            { jsonSchema: { name: 'answer', schema: { type: 'object', fill: 'x'.repeat(MAX_EXTRA_BODY_BYTES) } } }
        ];

        for (const value of rejected) {
            expectRejected(
                () => openAICompatible({ baseURL: 'http://x/v1', responseFormat: value as never }),
                'provider.responseFormat'
            );
        }

        const circular: Record<string, unknown> = {};
        circular.self = circular;

        expectRejected(
            () =>
                openAICompatible({
                    baseURL: 'http://x/v1',
                    responseFormat: { jsonSchema: { name: 'answer', schema: circular } } as never
                }),
            'provider.responseFormat.jsonSchema.schema'
        );
    });

    // AC4: the composable seam. A host with a different dialect changes ONLY the body;
    // the URL, the bearer auth, the custom headers, the mapped transcript and the SSE
    // reader all stay the transport's.
    it('lets buildBody rewrite the body while reusing the rest of the transport', async () => {
        const fetchMock = stubFetch([
            sse({ choices: [{ delta: { content: 'rewritten' }, finish_reason: 'stop' }] }),
            'data: [DONE]\n\n'
        ]);

        const events = await collect(
            openAICompatible(
                { baseURL: 'http://x/v1/', apiKey: 'secret', headers: { 'x-dialect': 'v2' } },
                {
                    buildBody: (base) => ({
                        target_model: base.model,
                        chat: base.messages,
                        wants_stream: true
                    })
                }
            )(request)
        );

        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

        expect(url).toBe('http://x/v1/chat/completions');
        expect(init.headers).toMatchObject({
            'content-type': 'application/json',
            authorization: 'Bearer secret',
            'x-dialect': 'v2'
        });
        expect(String(init.body)).toBe(
            '{"target_model":"merge/ds4-flash","chat":[{"role":"system","content":"You are a writer."},' +
                '{"role":"user","content":"Write"}],"wants_stream":true}'
        );
        expect(events).toEqual([
            { type: 'text', delta: 'rewritten' },
            { type: 'done', stopReason: 'stop', toolCalls: [], usage: undefined }
        ]);
    });

    it('hands buildBody the assembled base body and the request', async () => {
        const fetchMock = stubFetch(['data: [DONE]\n\n']);
        const controller = new AbortController();

        let seenBase: unknown;
        let seenRequest: HarnessStreamRequest | undefined;

        await collect(
            openAICompatible(
                {
                    baseURL: 'http://x/v1',
                    sampling: { temperature: 0.5 },
                    extraBody: { seed: 3 },
                    responseFormat: 'json'
                },
                {
                    buildBody: (base, req) => {
                        seenBase = base;
                        seenRequest = req;

                        return { ...base, note: 'added' };
                    }
                }
            )({ ...request, signal: controller.signal })
        );

        // The base is the FULL default body: extension, first-class fields, mapped
        // transcript and wire tool list — so an override adjusts, it does not rebuild.
        expect(seenBase).toEqual({
            seed: 3,
            model: 'merge/ds4-flash',
            stream: true,
            messages: request.messages,
            temperature: 0.5,
            response_format: { type: 'json_object' }
        });
        expect(seenRequest).toEqual({ ...request, signal: controller.signal });
        expect(sentJson(fetchMock).note).toBe('added');
    });

    it('reports a buildBody that returns a non-object as an error frame without fetching', async () => {
        const fetchMock = stubFetch(['data: [DONE]\n\n']);

        const events = await collect(
            openAICompatible({ baseURL: 'http://x/v1' }, { buildBody: () => [] as never })(request)
        );

        expect(events).toEqual([
            {
                type: 'error',
                message: '`options.buildBody` must return a plain JSON object of request fields.'
            }
        ]);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects a non-function options.buildBody at construction', () => {
        expectRejected(
            () => openAICompatible({ baseURL: 'http://x/v1' }, { buildBody: 'nope' as never }),
            'options.buildBody'
        );
    });

    // AC4's other half: the default transport also reaches the BROWSER chunk, so this
    // file must keep importing no Node built-in. `src/structure.test.ts` pins the
    // entry split itself; this pins the module the new code lives in.
    it('keeps the transport free of any Node built-in import', () => {
        const source = fs.readFileSync(
            fileURLToPath(new URL('./openai.ts', import.meta.url)),
            'utf8'
        );

        expect(source).not.toContain("from 'node:");
        expect(source).not.toMatch(/^import .* from '[a-z]+';$/m);
    });
});

// ---------------------------------------------------------------------------
// issue 0004 — a provider "input too long" answer is its OWN failure class.
//
// Two things are pinned here and both matter to a caller:
//   - an overflow frame carries the machine `code` and a message that LEADS with it,
//     so `agent()` can refuse to retry it and a host can switch on it (the agent-side
//     half is pinned in src/core/agent.test.ts);
//   - every other non-2xx keeps the historical frame byte-for-byte, INCLUDING the
//     absence of the `code` key — hence `toStrictEqual` on those cases.
// ---------------------------------------------------------------------------

describe('provider context overflow (issue 0004)', () => {
    // The frame's message, spelled out in full rather than matched loosely: a
    // reworded message is a contract change a test has to notice.
    const quoted = (text: string): string => ` The provider said: "${text}"`;

    const overflowMessage = (status: number, quotedDetail: string): string =>
        `context-overflow: HTTP ${status} — the provider says this request is too large for the ` +
        `model's context window, so a retry would be refused again. Send less: a turn.before handler ` +
        `may replace the transcript, and the shipped context-compaction plugin does exactly that.` +
        quotedDetail;

    const overflowFrame = (status: number, providerSaid: string): HarnessStreamEvent => ({
        type: 'error',
        code: CONTEXT_OVERFLOW_CODE,
        message: overflowMessage(status, providerSaid.length > 0 ? quoted(providerSaid) : '')
    });

    it('classifies the OpenAI maximum-context-length 400 as an overflow frame', async () => {
        const providerLine =
            "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens";

        stubFetch([providerLine], { status: 400 });

        const events = await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));

        expect(events).toStrictEqual([overflowFrame(400, providerLine)]);
    });

    it('classifies an Anthropic-style prompt-is-too-long 400 as an overflow frame', async () => {
        const providerLine = 'prompt is too long: 210000 tokens > 200000 maximum';

        stubFetch([providerLine], { status: 400 });

        const events = await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));

        expect(events).toStrictEqual([overflowFrame(400, providerLine)]);
    });

    it('classifies a 413 by status alone, quoting the status line when the body is empty', async () => {
        // A proxy that caps request bodies answers 413 with no body at all. On a
        // chat-completions POST there is exactly one thing that was too large.
        stubFetch([''], { status: 413, statusText: 'Payload Too Large' });

        const events = await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));

        expect(events).toStrictEqual([overflowFrame(413, 'Payload Too Large')]);
    });

    it('recognizes every documented overflow wording and nothing else', async () => {
        // The list mirrors CONTEXT_OVERFLOW_PATTERNS in openai.ts, one live phrasing
        // per entry. A new gateway means a new entry here AND a new pattern there.
        const wordings = [
            'This model\'s maximum context length is 8192 tokens',
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
            stubFetch([wording], { status: 400 });

            const events = await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));

            expect(events).toStrictEqual([overflowFrame(400, wording)]);
        }
    });

    it('keeps an unrelated 400 with its raw detail and no code', async () => {
        // The near-miss that must NOT be called an overflow: a complaint about the
        // `max_tokens` FIELD. Nothing here may rewrite it into a size diagnosis.
        stubFetch(['Invalid value for max_tokens: expected integer'], { status: 400 });

        const events = await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));

        expect(events).toStrictEqual([{ type: 'error', message: 'HTTP 400: Invalid value for max_tokens: expected integer' }]);
    });

    it('never calls a non-400/413 answer an overflow, whatever it quotes', async () => {
        // The status gate: a broken credential or a dead gateway whose error page
        // happens to mention the context window must stay the plain frame it always
        // was, because the remedy there is not "send less".
        for (const status of [401, 429, 500, 503]) {
            stubFetch(["This model's maximum context length is 8192 tokens"], { status });

            const events = await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));

            expect(events).toStrictEqual([
                {
                    type: 'error',
                    message: `HTTP ${status}: This model's maximum context length is 8192 tokens`
                }
            ]);
        }
    });

    it('collapses a multi-line provider message into one quoted line', async () => {
        const page = '<html>\n    <body>\n\n        maximum context length\n        exceeded\n\n    </body>\n</html>';

        stubFetch([page], { status: 400 });

        const events = await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));

        expect(events).toStrictEqual([
            {
                type: 'error',
                code: CONTEXT_OVERFLOW_CODE,
                message: overflowMessage(
                    400,
                    quoted('<html> <body> maximum context length exceeded </body> </html>')
                )
            }
        ]);
    });

    it('quotes at most 300 characters of a gateway error page', async () => {
        // The pre-0004 behaviour dumped the whole body into an event stream and into
        // every event consumer. The cap keeps the provider's numbers — they are the
        // actionable half — and drops the rest of the page.
        const page = `maximum context length exceeded: 9000 tokens over 8192 ${'x'.repeat(400)} trailing`;

        stubFetch([page], { status: 400 });

        const events = await collect(openAICompatible({ baseURL: 'http://x/v1' })(request));

        const frame = events[0];
        if (frame?.type !== 'error') throw new Error(`expected an error frame, got ${JSON.stringify(frame)}`);

        expect(frame.code).toBe(CONTEXT_OVERFLOW_CODE);
        expect(frame.message).toBe(overflowMessage(400, quoted(`${page.slice(0, 300)}…`)));
    });
});

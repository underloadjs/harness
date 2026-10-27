// transport.ts — the OpenAI-compatible SSE transport.
//
// `fetch` is stubbed, so these tests exercise the real request shape, the real
// wire-format mapping, and the real frame parser without any network.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { openAICompatible } from '@underload/harness';
import type { HarnessStreamEvent } from '@underload/harness';

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

    it('maps assistant tool calls and tool results onto the wire format', async () => {
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
                tool_calls: [
                    { id: 'c1', type: 'function', function: { name: 'websearch', arguments: '{"q":"news"}' } }
                ]
            },
            { role: 'tool', tool_call_id: 'c1', content: 'results' }
        ]);

        // `reasoning` is local replay data and must never reach the provider.
        expect(JSON.stringify(body)).not.toContain('let me look');
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
});

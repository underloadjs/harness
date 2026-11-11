// agent() — the brain.
//
// These tests pin the history contract, because that is the part the harness and
// every plugin depend on:
//   - instructions are seeded as system messages, in order;
//   - turn() runs one request against the current history and commits only the
//     assistant message (no user append, no rollback);
//   - stream() commits a turn atomically (user + assistant) and rolls back on
//     failure;
//   - tool calls survive on the assistant message so a caller can loop by hand.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    CONTEXT_OVERFLOW_CODE,
    STRUCTURED_OUTPUT_INVALID_CODE,
    STRUCTURED_SCHEMA_INVALID_CODE,
    agent,
    estimateContextTokens,
    HarnessError
} from '@underload/harness';
import type {
    AgentStreamEvent,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest
} from '@underload/harness';

// Canonical transcript entries now carry a minted `messageId` (context T1,
// src/core/message-id.ts): a stable ADDRESS for a turn, i.e. an identity field like a
// timestamp rather than part of the content these assertions pin. Stripping it DEEPLY
// keeps every expected value here exactly what it was, and the id itself is pinned
// exactly where it is the subject: src/harness.inclusion.test.ts (minting, `entries`,
// addressing by id), src/harness.snapshot.test.ts (persistence and restore-without-ids)
// and src/harness.fork.test.ts (ids COPIED across a fork).
const withoutIds = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutIds);

    if (typeof value === 'object' && value !== null) {
        const entries: [string, unknown][] = [];

        for (const [key, child] of Object.entries(value)) {
            // The only key dropped is the id; `undefined`-valued keys stay, so a
            // `toStrictEqual` comparison keeps its strictness about them.
            if (key === 'messageId') continue;
            entries.push([key, withoutIds(child)]);
        }

        return Object.fromEntries(entries);
    }

    return value;
};

// A transport that replays a fixed event list. `onRequest` lets a test assert
// what the agent actually sent.
const fakeStream = (
    frames: HarnessStreamEvent[],
    onRequest?: (request: Parameters<HarnessStream>[0]) => void
): HarnessStream => {
    return async function* stream(request) {
        onRequest?.(request);
        for (const frame of frames) {
            yield frame;
        }
    };
};

// Terminal frame with no tool calls, which is the common case.
const done = (stopReason: 'stop' | 'length' | 'tool_calls' = 'stop'): HarnessStreamEvent => ({
    type: 'done',
    stopReason,
    toolCalls: []
});

const collect = async (events: AsyncIterable<AgentStreamEvent>): Promise<AgentStreamEvent[]> => {
    const collected: AgentStreamEvent[] = [];
    for await (const event of events) {
        collected.push(event);
    }
    return collected;
};

const transport = fakeStream([{ type: 'text', delta: 'hi' }, done()]);

describe('agent', () => {
    it('seeds instructions as system messages, in order', () => {
        const brain = agent({
            name: 'writer',
            model: 'merge/ds4-flash',
            instruction: ['You are a writer.', 'Answer in prose.'],
            stream: transport
        });

        expect(withoutIds(brain.messages)).toEqual([
            { role: 'system', content: 'You are a writer.' },
            { role: 'system', content: 'Answer in prose.' }
        ]);
        expect(brain.instructions).toEqual(['You are a writer.', 'Answer in prose.']);
    });

    it('places seed messages after the instructions', () => {
        const brain = agent({
            model: 'merge/ds4-flash',
            instruction: 'You are a writer.',
            messages: [{ role: 'user', content: 'Earlier question' }],
            stream: transport
        });

        expect(withoutIds(brain.messages)).toEqual([
            { role: 'system', content: 'You are a writer.' },
            { role: 'user', content: 'Earlier question' }
        ]);
    });

    it('defaults the name when none is given', () => {
        const brain = agent({ model: 'm', stream: transport });
        expect(brain.name).toBe('agent');
    });

    it('exposes a model accessor and chaining appenders', () => {
        const brain = agent({ name: 'writer', model: 'model-a', stream: transport });

        expect(brain.name).toBe('writer');
        expect(brain.model()).toBe('model-a');

        expect(brain.model('model-b')).toBe(brain);
        expect(brain.model()).toBe('model-b');

        expect(brain.system('s')).toBe(brain);
        expect(brain.user('u')).toBe(brain);
        expect(brain.assistant('a')).toBe(brain);

        expect(withoutIds(brain.messages)).toEqual([
            { role: 'system', content: 's' },
            { role: 'user', content: 'u' },
            { role: 'assistant', content: 'a' }
        ]);
    });

    // Model attribution (R2): the model is a mutable accessor, so a change may
    // arrive WHILE a request streams. The request must be attributed to the model
    // it actually started with — both in the transport payload and in the
    // committed message — and the change applies to the next request only.
    it('attributes a request to the model it started with when the model changes mid-request', async () => {
        // `brain` is assigned before any generator body runs: the transport is
        // only invoked once the turn starts.
        let brain: ReturnType<typeof agent>;
        const models: string[] = [];

        const switching = async function* (
            request: Parameters<HarnessStream>[0]
        ): AsyncGenerator<HarnessStreamEvent> {
            // What the transport was actually called with.
            models.push(request.model);
            // Retarget mid-request: must apply to the NEXT request only.
            brain.model('model-b');
            yield { type: 'text', delta: 'answer' };
            yield done();
        };

        brain = agent({ name: 'writer', model: 'model-a', stream: switching });

        const events = await collect(brain.stream('go'));

        expect(models).toEqual(['model-a']);
        // The accessor did change...
        expect(brain.model()).toBe('model-b');
        // ...but the turn it interrupted stays attributed to model-a.
        expect(events).toEqual([
            { type: 'text', delta: 'answer' },
            {
                type: 'done',
                message: {
                    role: 'assistant',
                    content: 'answer',
                    reasoning: '',
                    toolCalls: [],
                    model: 'model-a',
                    stopReason: 'stop',
                    usage: undefined
                }
            }
        ]);
        // The committed history carries the same attribution (reasoning and empty
        // tool calls are omitted, exactly as the transport produced them).
        expect(withoutIds(brain.messages)).toEqual([
            { role: 'user', content: 'go' },
            { role: 'assistant', content: 'answer' }
        ]);

        // The next request uses the new model.
        const second = await collect(brain.turn());

        expect(models).toEqual(['model-a', 'model-b']);
        expect(second).toEqual([
            { type: 'text', delta: 'answer' },
            {
                type: 'done',
                message: {
                    role: 'assistant',
                    content: 'answer',
                    reasoning: '',
                    toolCalls: [],
                    model: 'model-b',
                    stopReason: 'stop',
                    usage: undefined
                }
            }
        ]);
    });

    it('streams deltas, accumulates the turn, and appends it to history', async () => {
        const brain = agent({
            model: 'merge/ds4-flash',
            instruction: 'You are a writer.',
            stream: fakeStream([
                { type: 'reasoning', delta: 'thinking...' },
                { type: 'text', delta: 'Hello ' },
                { type: 'text', delta: 'world' },
                { type: 'done', stopReason: 'length', toolCalls: [], usage: { input: 3, output: 2, total: 5 } }
            ])
        });

        const events = await collect(brain.stream('Say hello'));

        expect(events).toEqual([
            { type: 'reasoning', delta: 'thinking...' },
            { type: 'text', delta: 'Hello ' },
            { type: 'text', delta: 'world' },
            {
                type: 'done',
                message: {
                    role: 'assistant',
                    content: 'Hello world',
                    reasoning: 'thinking...',
                    toolCalls: [],
                    model: 'merge/ds4-flash',
                    stopReason: 'length',
                    usage: { input: 3, output: 2, total: 5 }
                }
            }
        ]);

        expect(withoutIds(brain.messages)).toEqual([
            { role: 'system', content: 'You are a writer.' },
            { role: 'user', content: 'Say hello' },
            { role: 'assistant', content: 'Hello world', reasoning: 'thinking...' }
        ]);
    });

    it('sends the current history plus the new input, and forwarded tools', async () => {
        let sent: Parameters<HarnessStream>[0] | undefined;

        const brain = agent({
            model: 'model-a',
            instruction: 'You are a writer.',
            stream: fakeStream([done()], (request) => {
                sent = request;
            })
        });

        const tools = [{ name: 'websearch', description: 'search', parameters: { type: 'object' } }];
        await collect(brain.stream('Write', { tools }));

        expect(sent?.model).toBe('model-a');
        expect(sent?.tools).toEqual(tools);
        expect(withoutIds(sent?.messages)).toEqual([
            { role: 'system', content: 'You are a writer.' },
            { role: 'user', content: 'Write' }
        ]);
    });

    it('surfaces tool calls on the assistant message', async () => {
        const brain = agent({
            model: 'm',
            stream: fakeStream([
                {
                    type: 'done',
                    stopReason: 'tool_calls',
                    toolCalls: [{ id: 'call_1', name: 'websearch', arguments: '{"q":"news"}' }]
                }
            ])
        });

        const [event] = await collect(brain.stream('search'));

        expect(event.type).toBe('done');
        if (event.type === 'done') {
            expect(event.message.toolCalls).toEqual([
                { id: 'call_1', name: 'websearch', arguments: '{"q":"news"}' }
            ]);
        }

        // Committed to history so a caller can answer it.
        expect(withoutIds(brain.messages.at(-1))).toEqual({
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_1', name: 'websearch', arguments: '{"q":"news"}' }]
        });
    });

    it('turn() does not append a user message and commits only the assistant reply', async () => {
        const brain = agent({
            model: 'm',
            instruction: 'You are a writer.',
            stream: fakeStream([{ type: 'text', delta: 'ok' }, done()])
        });

        await collect(brain.turn());

        expect(withoutIds(brain.messages)).toEqual([
            { role: 'system', content: 'You are a writer.' },
            { role: 'assistant', content: 'ok' }
        ]);
    });

    // R1: retries are opt-out, and these three pin the FAILURE contract itself, so
    // they run with a single attempt (`retry: false`). The retry sequence has its
    // own suite below.
    it('turn() throws instead of yielding an error event', async () => {
        const brain = agent({
            model: 'm',
            stream: fakeStream([{ type: 'error', message: 'boom' }]),
            retry: false
        });

        await expect(collect(brain.turn())).rejects.toThrow('boom');
    });

    it('rolls back the prompt when the transport reports an error', async () => {
        const brain = agent({
            model: 'm',
            instruction: 'You are a writer.',
            stream: fakeStream([{ type: 'text', delta: 'partial' }, { type: 'error', message: 'boom' }]),
            retry: false
        });

        const events = await collect(brain.stream('Say hello'));

        expect(events).toEqual([
            { type: 'text', delta: 'partial' },
            { type: 'error', error: { message: 'boom' } }
        ]);

        // Nothing from the failed turn survives.
        expect(withoutIds(brain.messages)).toEqual([{ role: 'system', content: 'You are a writer.' }]);
    });

    it('rolls back when the transport throws', async () => {
        const throwing: HarnessStream = async function* () {
            throw new Error('socket hang up');
        };

        const brain = agent({ model: 'm', stream: throwing, retry: false });

        const events = await collect(brain.stream('Say hello'));

        expect(events).toEqual([{ type: 'error', error: { message: 'socket hang up' } }]);
        expect(brain.messages).toEqual([]);
    });

    it('reset() restores the seeded state', async () => {
        const brain = agent({
            model: 'model-a',
            instruction: 'You are a writer.',
            messages: [{ role: 'user', content: 'seed' }],
            stream: fakeStream([{ type: 'text', delta: 'ok' }, done()])
        });

        await collect(brain.stream('Say hello'));
        // system + seed user + the turn's user + the turn's assistant
        expect(brain.messages).toHaveLength(4);

        brain.reset();

        expect(withoutIds(brain.messages)).toEqual([
            { role: 'system', content: 'You are a writer.' },
            { role: 'user', content: 'seed' }
        ]);
    });

    // Harness ownership guard (T15): a turn that lost its owner while the
    // transport was in flight must not commit. This is the only synchronous
    // history mutation point, so throwing here leaves the transcript untouched.
    it('refuses to commit when precommit throws', async () => {
        const brain = agent({
            model: 'm',
            instruction: 'You are a writer.',
            stream: fakeStream([{ type: 'text', delta: 'late' }, done()])
        });

        await expect(
            collect(
                brain.turn({
                    precommit: () => {
                        throw new Error('ownership lost');
                    }
                })
            )
        ).rejects.toThrow('ownership lost');

        // No assistant message was appended by the refused turn.
        expect(withoutIds(brain.messages)).toEqual([{ role: 'system', content: 'You are a writer.' }]);

        // A later owned turn commits normally.
        const events = await collect(brain.turn());
        expect(withoutIds(events.at(-1))).toMatchObject({ type: 'done', message: { content: 'late' } });
        expect(withoutIds(brain.messages)).toEqual([
            { role: 'system', content: 'You are a writer.' },
            { role: 'assistant', content: 'late' }
        ]);
    });

    it('requires a model', () => {
        expect(() => agent({ model: '', stream: transport })).toThrow('An agent requires a model.');
    });

    it('requires a transport', () => {
        expect(() => agent({ name: 'writer', model: 'm' })).toThrow(
            'Agent "writer" has no transport: provide either `stream` or `provider.baseURL`.'
        );
    });

    it('accepts a provider block instead of an explicit stream', () => {
        expect(() =>
            agent({
                name: 'writer',
                model: 'm',
                provider: { baseURL: 'http://localhost:5500/providers/private/v1' }
            })
        ).not.toThrow();
    });
});

// Identity color (R2) — the optional display swatch configured with the agent.
//
// Pinned contract (mirrored at the server edge in
// src/server/harnesses/registry.test.ts `per-agent identity colors`, which feeds the
// SAME accepted/rejected sample set through `registry.create()` so the two hex
// spellings cannot drift):
//   - a hex color is stored TRIMMED, with the author's casing, on `Agent.color`;
//   - the accepted shape is `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`, either case, and
//     nothing else — a named color, a functional color, a 5/9-digit hex, a bare hex,
//     blank text, and a non-string are all `HarnessError`s naming the agent;
//   - an uncolored agent carries NO `color` key at all (never `color: undefined`), so a
//     host can test `agent.color !== undefined` and fall back to its own derivation;
//   - the value is display-only: it never reaches the transport request, and it
//     survives reset() and a model switch, because it belongs to the identity chosen at
//     setup rather than to the conversation.
describe('agent identity color', () => {
    // Records exactly what the transport was called with, so the test can prove the
    // color is absent from the wire payload rather than trusting the type.
    const recordingStream = (seen: HarnessStreamRequest[]): HarnessStream =>
        async function* stream(request) {
            seen.push(request);
            yield { type: 'text', delta: 'ok' };
            yield done();
        };

    // The one construction path every case below shares: padded on purpose, because
    // what is stored must be the TRIMMED author value, not a re-normalised one.
    const colorOf = (color: string): string | undefined =>
        agent({ name: 'writer', model: 'm', stream: transport, color }).color;

    const refusal = (value: unknown, name = 'writer'): string => {
        try {
            agent({ name, model: 'm', stream: transport, color: value as never });
        } catch (error) {
            expect(error).toBeInstanceOf(HarnessError);

            return (error as Error).message;
        }

        // Reaching this line is the failure: a value the contract rejects was accepted.
        throw new Error(`expected ${JSON.stringify(value)} to be rejected`);
    };

    it('stores every accepted hex shape, trimmed, with its casing intact', () => {
        expect(
            ['  #abc  ', ' #abcd ', '  #aabbcc ', '#AABBCCDD  ', ' #ABC ', '\t#4ade80\n'].map(colorOf)
        ).toEqual(['#abc', '#abcd', '#aabbcc', '#AABBCCDD', '#ABC', '#4ade80']);
    });

    it('carries no color key when none is configured', () => {
        const brain = agent({ name: 'writer', model: 'm', stream: transport });

        expect(Object.hasOwn(brain, 'color')).toBe(false);
        expect(brain.color).toBeUndefined();
    });

    it('rejects anything that is not a CSS hex color, naming the agent', () => {
        const use = (value: unknown): string =>
            `Agent "writer" has an invalid \`color\`: ${JSON.stringify(value)}. Use a CSS hex color (#rgb, #rgba, #rrggbb or #rrggbbaa).`;

        expect(refusal('red')).toBe(use('red'));
        expect(refusal('rgb(74, 222, 128)')).toBe(use('rgb(74, 222, 128)'));
        // Length is part of the shape: 5 and 9 digits are neither 3/4 nor 6/8.
        expect(refusal('#abcde')).toBe(use('#abcde'));
        expect(refusal('#aabbccdde')).toBe(use('#aabbccdde'));
        // The `#` sigil is required, and so are hex digits only.
        expect(refusal('aabbcc')).toBe(use('aabbcc'));
        expect(refusal('#gggggg')).toBe(use('#gggggg'));
        // Blank text is a visible mistake rather than "absent": clearing means omitting
        // the key, so a pasted space cannot silently drop a configured swatch.
        expect(refusal('')).toBe(use(''));
        expect(refusal('   ')).toBe(use('   '));
        // A non-string is refused with the value rendered, so the message names what the
        // caller actually sent (a number is JSON-rendered bare, not quoted).
        expect(refusal(7)).toBe('Agent "writer" has an invalid `color`: 7. Use a CSS hex color (#rgb, #rgba, #rrggbb or #rrggbbaa).');
        // A standalone agent with no configured name keeps the same default label the
        // missing-transport refusal uses.
        expect(refusal('navy', 'agent')).toBe(
            'Agent "agent" has an invalid `color`: "navy". Use a CSS hex color (#rgb, #rgba, #rrggbb or #rrggbbaa).'
        );
    });

    it('never sends the color to the transport', async () => {
        const seen: HarnessStreamRequest[] = [];
        const brain = agent({
            name: 'writer',
            model: 'm',
            instruction: 'You are a writer.',
            color: '#4ade80',
            stream: recordingStream(seen)
        });

        await collect(brain.stream('go'));

        expect(seen).toHaveLength(1);
        // The exact request the transport receives: identity metadata is not part of it.
        expect(seen[0].model).toBe('m');
        expect(withoutIds(seen[0].messages)).toEqual([
            { role: 'system', content: 'You are a writer.' },
            { role: 'user', content: 'go' }
        ]);
        expect(Object.hasOwn(seen[0], 'color')).toBe(false);
    });

    it('keeps the color through reset() and a model switch', () => {        const brain = agent({
            name: 'writer',
            model: 'm',
            instruction: 'You are a writer.',
            color: '#4ade80',
            stream: transport
        });

        brain.user('hello');
        brain.model('other-model');

        // The swatch is identity, not conversation or transport state: neither a model
        // switch nor a reset touches it. (`reset()` restores the seeded transcript; the
        // model accessor keeps whatever the caller last set, which is the pre-existing
        // contract pinned by the other tests in this file.)
        expect(brain.color).toBe('#4ade80');

        brain.reset();

        expect(brain.color).toBe('#4ade80');
        expect(withoutIds(brain.messages)).toEqual([{ role: 'system', content: 'You are a writer.' }]);
    });
});

// ---------------------------------------------------------------------------
// issue 0001 (B) — `agent({ structured })`: the schema goes out on the wire, and
// every answer has to pass the same runtime gate a created tool's arguments pass.
// ---------------------------------------------------------------------------

const ANSWER_SCHEMA = {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer']
};

// A transport that streams one answer and terminates the turn.
const answerStream = (
    content: string,
    stopReason: 'stop' | 'length' | 'tool_calls' = 'stop'
): HarnessStream => fakeStream([{ type: 'text', delta: content }, done(stopReason)]);

// SSE stub for the tests that need the REAL transport (the wire half of
// `structured`). Deliberately tiny: the body bytes are the subject.
const stubFetchFrames = (frames: string[]) => {
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async () => {
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                for (const frame of frames) controller.enqueue(encoder.encode(frame));
                controller.close();
            }
        });

        return new Response(body, { status: 200 });
    });

    vi.stubGlobal('fetch', fetchMock);

    return fetchMock;
};

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const DONE_FRAME = 'data: [DONE]\n\n';

// The serialized body of the single request a stubbed fetch recorded.
const sentBodyOf = (fetchMock: ReturnType<typeof stubFetchFrames>): string =>
    String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body);

// The one `done` message of a collected stream, or a failure.
const doneMessage = (events: AgentStreamEvent[]) => {
    for (const event of events) {
        if (event.type === 'done') return event.message;
    }

    throw new Error(`no done event in ${JSON.stringify(events)}`);
};

// Runs one construction and hands back whatever it threw (the construction-rejection
// tests assert both the code and the wording).
const caughtFrom = (build: () => unknown): unknown => {
    try {
        build();
    } catch (error) {
        return error;
    }

    throw new Error('expected a construction failure, got none');
};

// Drains a generator whose events are irrelevant — `turn()` reports the failure as a
// rejection, not as an event.
const drain = async (events: AsyncIterable<AgentStreamEvent>): Promise<void> => {
    for await (const _event of events) {
        // discarded on purpose
    }
};

// Awaits a call expected to reject and returns the rejection.
const scriptFailure = async (run: () => Promise<unknown>): Promise<unknown> => {
    try {
        await run();
    } catch (error) {
        return error;
    }

    throw new Error('expected a rejection, got none');
};

describe('agent structured output (issue 0001)', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('hands back a validated value and commits the turn', async () => {
        const brain = agent({
            name: 'writer',
            model: 'm',
            instruction: 'Answer as JSON.',
            structured: ANSWER_SCHEMA,
            stream: answerStream('{"answer":"ok"}')
        });

        const message = doneMessage(await collect(brain.stream('go')));

        // The value, not the string: the caller of a structured agent parses nothing.
        expect(message.structured).toEqual({ answer: 'ok' });
        expect(message.stopReason).toBe('stop');
        expect(withoutIds(brain.messages)).toEqual([
            { role: 'system', content: 'Answer as JSON.' },
            { role: 'user', content: 'go' },
            { role: 'assistant', content: '{"answer":"ok"}' }
        ]);
    });

    it('carries usage through to the committed message when extraBody opts into stream_options', async () => {
        // AC1, end to end: the host asks for usage with a config field (no custom
        // transport), the gateway answers with the usage frame, and the tally lands on
        // `HarnessAssistantMessage.usage` — the field the server sums into its
        // per-conversation totals.
        const fetchMock = stubFetchFrames([
            sse({ choices: [{ delta: { content: '{"answer":"ok"}' }, finish_reason: 'stop' }] }),
            sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } }),
            DONE_FRAME
        ]);

        const brain = agent({
            name: 'writer',
            model: 'm',
            provider: {
                baseURL: 'http://x/v1',
                extraBody: { stream_options: { include_usage: true } }
            }
        });

        const message = doneMessage(await collect(brain.stream('go')));

        expect(sentBodyOf(fetchMock)).toContain('"stream_options":{"include_usage":true}');
        expect(message.usage).toStrictEqual({ input: 10, output: 4, total: 14 });
        expect(withoutIds(brain.messages)).toEqual([
            { role: 'user', content: 'go' },
            { role: 'assistant', content: '{"answer":"ok"}' }
        ]);
    });

    it('sends the structured schema as response_format through the provider seam', async () => {
        const fetchMock = stubFetchFrames([
            sse({ choices: [{ delta: { content: '{"answer":"ok"}' }, finish_reason: 'stop' }] }),
            DONE_FRAME
        ]);

        const brain = agent({
            // A name carrying characters a gateway rejects in a schema name, so this
            // also pins the sanitization.
            name: 'research team.v2',
            model: 'm',
            provider: { baseURL: 'http://x/v1' },
            structured: ANSWER_SCHEMA
        });

        doneMessage(await collect(brain.stream('go')));

        const body = JSON.parse(sentBodyOf(fetchMock)) as Record<string, unknown>;

        expect(body.response_format).toEqual({
            type: 'json_schema',
            json_schema: { name: 'research_team_v2', schema: ANSWER_SCHEMA }
        });
    });

    it('keeps an explicit provider.responseFormat on the wire and still gates the answer', async () => {
        const fetchMock = stubFetchFrames([
            sse({ choices: [{ delta: { content: '{"answer":"ok"}' }, finish_reason: 'stop' }] }),
            DONE_FRAME
        ]);

        const brain = agent({
            name: 'writer',
            model: 'm',
            provider: { baseURL: 'http://x/v1', responseFormat: 'json' },
            structured: ANSWER_SCHEMA
        });

        const events = await collect(brain.stream('go'));

        // The host's explicit wire choice wins; `structured` did not overwrite it.
        expect(JSON.parse(sentBodyOf(fetchMock))).toEqual({
            model: 'm',
            stream: true,
            messages: [{ role: 'user', content: 'go' }],
            response_format: { type: 'json_object' }
        });
        expect(doneMessage(events).structured).toEqual({ answer: 'ok' });
    });

    it('fails a non-JSON answer as a typed stream error with no commit to history', async () => {
        const brain = agent({
            name: 'writer',
            model: 'm',
            instruction: 'Answer as JSON.',
            structured: ANSWER_SCHEMA,
            stream: answerStream('I would rather write prose.')
        });

        const events = await collect(brain.stream('go'));

        expect(events.map((event) => event.type)).toEqual(['text', 'error']);

        const failure = events[1];

        if (failure?.type !== 'error') throw new Error('expected an error event');

        expect(failure.error.message).toContain('is not JSON');
        expect(failure.error.message).toContain('"I would rather write prose."');
        expect(failure.error.code).toBe(STRUCTURED_OUTPUT_INVALID_CODE);

        // Rolled back exactly like any other failure: the rejected answer is nowhere.
        expect(withoutIds(brain.messages)).toEqual([{ role: 'system', content: 'Answer as JSON.' }]);
    });

    it('throws a typed failure from turn() and commits nothing when the schema does not match', async () => {
        const brain = agent({
            name: 'writer',
            model: 'm',
            instruction: 'Answer as JSON.',
            structured: ANSWER_SCHEMA,
            // Valid JSON, wrong shape: `answer` is required.
            stream: answerStream('{"nope":1}')
        });

        const caught = await scriptFailure(() => drain(brain.turn()));

        if (!(caught instanceof HarnessError)) throw new Error(`expected a HarnessError, got ${JSON.stringify(caught)}`);

        expect(caught.code).toBe(STRUCTURED_OUTPUT_INVALID_CODE);
        // The code is also the error NAME, so a host can classify either way.
        expect(caught.name).toBe(STRUCTURED_OUTPUT_INVALID_CODE);
        expect(caught.message).toContain('does not match its `structured` schema');
        // turn() appends no user message, and the rejected answer committed nothing.
        expect(withoutIds(brain.messages)).toEqual([{ role: 'system', content: 'Answer as JSON.' }]);
    });

    it('spends no transport retry on a schema failure, whatever the retry policy says', async () => {
        let calls = 0;

        const brain = agent({
            name: 'writer',
            model: 'm',
            structured: ANSWER_SCHEMA,
            // A generous budget on purpose: if a schema failure entered the R1
            // sequence, this transport would be called again and the count would show it.
            retry: { maxRetries: 3, baseDelayMs: 1 },
            stream: async function* () {
                calls += 1;
                yield { type: 'text', delta: 'prose' } as HarnessStreamEvent;
                yield { type: 'done', stopReason: 'stop', toolCalls: [] } as HarnessStreamEvent;
            }
        });

        const events = await collect(brain.stream('go'));

        expect(calls).toBe(1);
        // No `retry` event either: the host above the agent owns what happens next.
        expect(events.map((event) => event.type)).toEqual(['text', 'error']);
    });

    it('leaves a length-truncated answer distinguishable from a schema failure', async () => {
        const brain = agent({
            name: 'writer',
            model: 'm',
            structured: ANSWER_SCHEMA,
            // Cut mid-token: a truncation problem, not a format problem.
            stream: answerStream('{"answer":"trunc', 'length')
        });

        const events = await collect(brain.stream('go'));
        const message = doneMessage(events);

        expect(events.map((event) => event.type)).toEqual(['text', 'done']);
        expect(message.stopReason).toBe('length');
        // No value claimed, and the truncated answer is still committed to inspect.
        expect(Object.hasOwn(message, 'structured')).toBe(false);
        expect(withoutIds(brain.messages)).toEqual([
            { role: 'user', content: 'go' },
            { role: 'assistant', content: '{"answer":"trunc' }
        ]);
    });

    it('does not judge a tool-call round against the schema', async () => {
        const brain = agent({
            name: 'writer',
            model: 'm',
            structured: ANSWER_SCHEMA,
            stream: fakeStream([
                {
                    type: 'done',
                    stopReason: 'tool_calls',
                    toolCalls: [{ id: 'call-1', name: 'lookup', arguments: '{}' }]
                }
            ])
        });

        const message = doneMessage(await collect(brain.stream('go')));

        expect(message.toolCalls).toEqual([{ id: 'call-1', name: 'lookup', arguments: '{}' }]);
        expect(Object.hasOwn(message, 'structured')).toBe(false);
    });

    it('never grows a structured key for an agent that did not ask for one', async () => {
        const brain = agent({ name: 'writer', model: 'm', stream: answerStream('prose') });

        const message = doneMessage(await collect(brain.stream('go')));

        expect(Object.hasOwn(message, 'structured')).toBe(false);
    });

    it('rejects an unusable structured schema at construction', () => {
        // Not a schema at all.
        const flat = caughtFrom(() =>
            agent({ name: 'writer', model: 'm', structured: 'answer' as never, stream: transport })
        );

        if (!(flat instanceof HarnessError)) throw new Error(`expected a HarnessError, got ${JSON.stringify(flat)}`);
        expect(flat.code).toBe(STRUCTURED_SCHEMA_INVALID_CODE);
        expect(flat.message).toContain('invalid `structured` schema');

        // A schema over the created-tool node budget — the SAME gate a created tool
        // passes, quoted with the same wording.
        const wide = {
            type: 'object',
            properties: Object.fromEntries(
                Array.from({ length: 300 }, (_, index) => [`property_${index}`, { type: 'string' }])
            )
        };

        const big = caughtFrom(() => agent({ name: 'writer', model: 'm', structured: wide, stream: transport }));

        if (!(big instanceof HarnessError)) throw new Error(`expected a HarnessError, got ${JSON.stringify(big)}`);
        expect(big.code).toBe(STRUCTURED_SCHEMA_INVALID_CODE);
        expect(big.message).toContain('must not have more than 256 schema nodes');
    });

    it('still gates the answer when a custom stream owns the wire', async () => {
        // A custom transport cannot be told about `response_format`, so `structured`
        // is validation-only there — and that half still holds.
        const brain = agent({
            name: 'writer',
            model: 'm',
            structured: ANSWER_SCHEMA,
            stream: answerStream('{"answer":7}')
        });

        const events = await collect(brain.stream('go'));
        const failure = events[1];

        expect(events.map((event) => event.type)).toEqual(['text', 'error']);
        if (failure?.type !== 'error') throw new Error('expected an error event');

        expect(failure.error.code).toBe(STRUCTURED_OUTPUT_INVALID_CODE);
        expect(failure.error.message).toContain('$.answer must be of type string');
    });
});

// ---------------------------------------------------------------------------
// issue 0004 — the pre-request context floor.
//
// Three things are pinned, in this order, because they are the acceptance criteria:
//   - the published estimator is the number the floor measures with (AC1);
//   - a configured window refuses an oversized request BEFORE it is sent, with a
//     typed error naming the estimate and the window, and spends no retry (AC2);
//   - a provider-side overflow frame is not retried, while every other failure keeps
//     the ladder it always had (AC3).
// ---------------------------------------------------------------------------

// The refusal message, spelled out in full. The exact numbers come from the exact
// inputs below: a 100-character instruction plus a 300-character prompt is 400
// characters, and `ceil(400 / 4)` is 100 tokens, one over a 99-token window.
const OVERFLOW_MESSAGE =
    'context-overflow: agent "writer" would send an estimated 100 tokens against a 99-token ' +
    'window, so the request was not sent and is not retried. The estimate is ceil(chars / 4) ' +
    'over the transcript about to be sent (core/context-estimate.ts), the same number the UI ' +
    'context bar shows; attachment bytes and the request\'s tool schemas are not counted. Send ' +
    'less — a turn.before handler may replace the transcript, and the shipped context-compaction ' +
    'plugin owns that policy — or raise maxPromptTokens / provider.contextWindow.';

// A transport that replays one frame list PER REQUEST and records the requests it was
// actually handed. A working floor means this list is never read at all.
//
// The bookkeeping runs at the TOP of the body (the body itself only starts on the
// first `next()`), so an attempt that throws on its error frame still consumes its
// entry — otherwise every attempt would replay the failure list forever.
const scriptedStream = (perRequest: HarnessStreamEvent[][]) => {
    const calls: HarnessStreamRequest[] = [];
    let request = 0;

    const stream: HarnessStream = async function* (req) {
        const frames = perRequest[Math.min(request, perRequest.length - 1)];

        request += 1;
        calls.push(req);

        for (const frame of frames) {
            yield frame;
        }
    };

    return { stream, calls };
};

const OK_FRAMES: HarnessStreamEvent[] = [{ type: 'text', delta: 'ok' }, done()];
const OK_SSE = [sse({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }), DONE_FRAME];

describe('agent context window floor (issue 0004)', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('publishes the estimator and the overflow code on the root barrel', () => {
        // AC1. This file imports ONLY `@underload/harness`, so naming the helper here
        // is the published-surface proof (`src/structure.test.ts` pins the barrel
        // layout itself, and `scripts/check-package-types.mjs` type-checks the same
        // names for a published NodeNext and browser consumer).
        expect(CONTEXT_OVERFLOW_CODE).toBe('context-overflow');
        expect(estimateContextTokens([{ role: 'user', content: 'x'.repeat(400) }])).toBe(100);
        expect(estimateContextTokens([{ role: 'user', content: 'x'.repeat(401) }])).toBe(101);
        expect(estimateContextTokens([])).toBe(0);
    });

    it('refuses an oversized transcript before any request is made', async () => {
        const fetchMock = stubFetchFrames(OK_SSE);

        const brain = agent({
            name: 'writer',
            model: 'm',
            instruction: 'i'.repeat(100),
            provider: { baseURL: 'http://x/v1', contextWindow: 99 }
        });

        const events = await collect(brain.stream('x'.repeat(300)));

        // The whole event sequence: one `error` whose payload carries the code beside
        // the message that leads with it.
        expect(events).toStrictEqual([
            { type: 'error', error: { message: OVERFLOW_MESSAGE, code: 'context-overflow' } }
        ]);
        expect(fetchMock).not.toHaveBeenCalled();

        // And history is exactly what it was — `stream()` rolled its own prompt back,
        // so a refused request is never replayed on the next turn.
        expect(withoutIds(brain.messages)).toStrictEqual([{ role: 'system', content: 'i'.repeat(100) }]);
    });

    it('spends no transport retry on the floor, whatever the retry policy says', async () => {
        const { stream, calls } = scriptedStream([OK_FRAMES]);

        const brain = agent({
            name: 'writer',
            model: 'm',
            instruction: 'i'.repeat(100),
            maxPromptTokens: 99,
            stream,
            retry: { maxRetries: 3, baseDelayMs: 1 }
        });

        const events = await collect(brain.stream('x'.repeat(300)));

        // The floor throws OUTSIDE the retry sequence: no transport call, and no
        // `retry` event either — a consumer sees one failure, not four.
        expect(calls).toStrictEqual([]);
        expect(events.map((event) => event.type)).toStrictEqual(['error']);
    });

    it('throws the coded failure from turn() with the estimate and the window on details', async () => {
        const { stream, calls } = scriptedStream([OK_FRAMES]);

        const brain = agent({
            name: 'writer',
            model: 'm',
            instruction: 'i'.repeat(100),
            maxPromptTokens: 99,
            stream
        });

        brain.user('x'.repeat(300));

        const failure = await scriptFailure(() => drain(brain.turn()));
        if (!(failure instanceof HarnessError)) {
            throw new Error(`expected a HarnessError, got ${JSON.stringify(failure)}`);
        }

        // The machine half: `code` and `name` carry the one class a host switches on.
        expect(failure.code).toBe('context-overflow');
        expect(failure.name).toBe('context-overflow');
        // The recovery half: the pair, as data, for the caller that has to shrink the
        // transcript instead of reading a sentence.
        expect(failure.details).toStrictEqual({
            estimatedTokens: 100,
            contextWindow: 99,
            model: 'm',
            agent: 'writer'
        });
        expect(failure.message).toBe(OVERFLOW_MESSAGE);
        expect(calls).toStrictEqual([]);
    });

    it('sends a transcript that fits, on a body byte-for-byte identical to an unguarded one', async () => {
        const fetchMock = stubFetchFrames(OK_SSE);

        const brain = agent({
            name: 'writer',
            model: 'm',
            instruction: 'i'.repeat(100),
            // Exactly the estimate: the floor is `estimate > window`, so 100 tokens fit
            // a 100-token window and 99 refuses one (the test above).
            provider: { baseURL: 'http://x/v1', contextWindow: 100 }
        });

        const message = doneMessage(await collect(brain.stream('x'.repeat(300))));

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(JSON.parse(sentBodyOf(fetchMock))).toStrictEqual({
            model: 'm',
            stream: true,
            messages: [
                { role: 'system', content: 'i'.repeat(100) },
                { role: 'user', content: 'x'.repeat(300) }
            ]
        });
        expect(message.content).toBe('ok');
    });

    it('measures the projection it is handed, so a compacted transcript still fits', async () => {
        const { stream, calls } = scriptedStream([OK_FRAMES]);

        const brain = agent({
            name: 'writer',
            model: 'm',
            instruction: 'i'.repeat(100),
            maxPromptTokens: 99,
            stream
        });

        brain.user('x'.repeat(300));

        // The committed transcript is 100 tokens — one over the floor. `turn()` throws
        // its failures (the harness owns recovery there), so the refusal is a
        // rejection, not an event.
        const failure = await scriptFailure(() => drain(brain.turn()));
        if (!(failure instanceof HarnessError)) {
            throw new Error(`expected a HarnessError, got ${JSON.stringify(failure)}`);
        }
        expect(failure.code).toBe('context-overflow');
        expect(calls).toStrictEqual([]);

        // What a `turn.before` policy does is hand the request a SHORTER projection
        // (src/harness.ts passes it as `transcript`). The floor measures THAT, so the
        // guard never competes with compaction — it only refuses what survives it.
        const compacted = [{ role: 'user' as const, content: 'short' }];
        const message = doneMessage(await collect(brain.turn({ transcript: compacted })));

        expect(withoutIds(calls[0]!.messages)).toStrictEqual(compacted);
        expect(message.content).toBe('ok');
    });

    it('never retries a provider overflow frame through the backoff ladder', async () => {
        // The frame the built-in transport now emits (pinned in
        // src/transport/openai.test.ts). Here the question is only what the retry
        // owner does with it: one attempt, because the same oversized bytes would be
        // re-sent through the whole ladder to get the same answer.
        const overflowFrame: HarnessStreamEvent = {
            type: 'error',
            code: CONTEXT_OVERFLOW_CODE,
            message: 'context-overflow: HTTP 413 — the provider says this request is too large'
        };

        const { stream, calls } = scriptedStream([[overflowFrame], [overflowFrame], OK_FRAMES]);

        const brain = agent({ name: 'writer', model: 'm', stream, retry: { maxRetries: 3, baseDelayMs: 1 } });

        const events = await collect(brain.stream('go'));

        expect(calls).toHaveLength(1);
        expect(events).toStrictEqual([
            { type: 'error', error: { message: overflowFrame.message, code: 'context-overflow' } }
        ]);
    });

    it('still retries an ordinary transport failure, with no code on its payloads', async () => {
        // The other side of the rule: the classifier must not have touched the ladder
        // for anything that is not an overflow. One failed attempt, one `retry` event,
        // then success — and the retry report carries `{ message }` and NOTHING else,
        // because an unclassified failure has no code to report.
        const { stream, calls } = scriptedStream([[{ type: 'error', message: 'HTTP 503: upstream unavailable' }], OK_FRAMES]);

        const brain = agent({ name: 'writer', model: 'm', stream, retry: { maxRetries: 3, baseDelayMs: 1 } });

        const events = await collect(brain.stream('go'));

        expect(calls).toHaveLength(2);
        expect(events[0]).toStrictEqual({
            type: 'retry',
            attempt: 1,
            maxAttempts: 4,
            delayMs: 1,
            error: { message: 'HTTP 503: upstream unavailable' }
        });
        expect(events.map((event) => event.type)).toStrictEqual(['retry', 'text', 'done']);
    });

    it('lets maxPromptTokens aim lower than the endpoint window', async () => {
        const fetchMock = stubFetchFrames(OK_SSE);

        const brain = agent({
            name: 'writer',
            model: 'm',
            instruction: 'i'.repeat(100),
            provider: { baseURL: 'http://x/v1', contextWindow: 100_000 },
            maxPromptTokens: 99
        });

        const events = await collect(brain.stream('x'.repeat(300)));

        expect(fetchMock).not.toHaveBeenCalled();

        const failure = events[0];
        if (failure?.type !== 'error') throw new Error(`expected an error event, got ${JSON.stringify(events)}`);

        // The refusal quotes the AGENT's 99, not the endpoint's 100000: the narrower
        // scope is the one its author is reading.
        expect(failure.error).toStrictEqual({ message: OVERFLOW_MESSAGE, code: 'context-overflow' });
    });

    it('lets maxPromptTokens raise an endpoint window that is too low', async () => {
        const fetchMock = stubFetchFrames(OK_SSE);

        const brain = agent({
            name: 'writer',
            model: 'm',
            instruction: 'i'.repeat(100),
            provider: { baseURL: 'http://x/v1', contextWindow: 99 },
            maxPromptTokens: 100_000
        });

        doneMessage(await collect(brain.stream('x'.repeat(300))));

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rejects a window that is not a positive safe integer, naming the field', () => {
        // A bad number is a configuration mistake, so it fails on the line it was
        // written — the rule `retry.maxRetries` and `color` already follow.
        for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '4096']) {
            const failure = caughtFrom(() =>
                agent({ name: 'writer', model: 'm', maxPromptTokens: value as never, stream: transport })
            );

            if (!(failure instanceof HarnessError)) {
                throw new Error(`expected a HarnessError for ${String(value)}, got ${JSON.stringify(failure)}`);
            }

            expect(failure.code).toBeUndefined();
            expect(failure.message).toContain(
                `maxPromptTokens must be a positive safe integer of tokens; received ${String(value)}.`
            );
        }

        // The provider spelling is validated too — EVEN when `maxPromptTokens` shadows
        // it, so a typo in the losing field is not a silently dead setting.
        const providerFailure = caughtFrom(() =>
            agent({
                name: 'writer',
                model: 'm',
                maxPromptTokens: 1000,
                provider: { baseURL: 'http://x/v1', contextWindow: 0 }
            })
        );

        if (!(providerFailure instanceof HarnessError)) {
            throw new Error(`expected a HarnessError, got ${JSON.stringify(providerFailure)}`);
        }

        expect(providerFailure.message).toContain(
            'provider.contextWindow must be a positive safe integer of tokens; received 0.'
        );
    });

    it('hands the same floor to a fork', async () => {
        const { stream, calls } = scriptedStream([OK_FRAMES]);

        const source = agent({
            name: 'writer',
            model: 'm',
            instruction: 'i'.repeat(100),
            maxPromptTokens: 99,
            stream
        });

        const branch = source.fork();
        const events = await collect(branch.stream('x'.repeat(300)));

        // A branch is the same brain, so it refuses the same request: the shared
        // transport never sees it, and the message names the same agent and window.
        expect(calls).toStrictEqual([]);
        expect(events).toStrictEqual([
            { type: 'error', error: { message: OVERFLOW_MESSAGE, code: 'context-overflow' } }
        ]);
    });
});

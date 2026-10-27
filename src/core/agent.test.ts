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

import { describe, expect, it } from 'vitest';
import { agent, HarnessError } from '@underload/harness';
import type { AgentStreamEvent, HarnessStream, HarnessStreamEvent } from '@underload/harness';

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

        expect(brain.messages).toEqual([
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

        expect(brain.messages).toEqual([
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

        expect(brain.messages).toEqual([
            { role: 'system', content: 's' },
            { role: 'user', content: 'u' },
            { role: 'assistant', content: 'a' }
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

        expect(brain.messages).toEqual([
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
        expect(sent?.messages).toEqual([
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
        expect(brain.messages.at(-1)).toEqual({
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

        expect(brain.messages).toEqual([
            { role: 'system', content: 'You are a writer.' },
            { role: 'assistant', content: 'ok' }
        ]);
    });

    it('turn() throws instead of yielding an error event', async () => {
        const brain = agent({
            model: 'm',
            stream: fakeStream([{ type: 'error', message: 'boom' }])
        });

        await expect(collect(brain.turn())).rejects.toThrow('boom');
    });

    it('rolls back the prompt when the transport reports an error', async () => {
        const brain = agent({
            model: 'm',
            instruction: 'You are a writer.',
            stream: fakeStream([{ type: 'text', delta: 'partial' }, { type: 'error', message: 'boom' }])
        });

        const events = await collect(brain.stream('Say hello'));

        expect(events).toEqual([
            { type: 'text', delta: 'partial' },
            { type: 'error', error: { message: 'boom' } }
        ]);

        // Nothing from the failed turn survives.
        expect(brain.messages).toEqual([{ role: 'system', content: 'You are a writer.' }]);
    });

    it('rolls back when the transport throws', async () => {
        const throwing: HarnessStream = async function* () {
            throw new Error('socket hang up');
        };

        const brain = agent({ model: 'm', stream: throwing });

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

        expect(brain.messages).toEqual([
            { role: 'system', content: 'You are a writer.' },
            { role: 'user', content: 'seed' }
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

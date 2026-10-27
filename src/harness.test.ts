// harness() — the execution loop.
//
// These tests pin the contract the CLI relies on:
//   - the harness is callable: `await writer('...')` runs the entry agent;
//   - the first `agents` key is the entry point, and its name is the harness name;
//   - tools run, their results are fed back, and the loop repeats until the model
//     answers with text;
//   - every failure mode (unknown tool, bad JSON, throwing tool) becomes a tool
//     result the model can recover from — not a crash;
//   - report.progress is awaited for every step;
//   - transport failure or a runaway loop truncates history and throws.

import { describe, expect, it } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type { HarnessEvent, HarnessStream, HarnessStreamEvent } from '@underload/harness';

// A transport that replays a scripted list of turns, one per request. Each entry
// is the set of frames for a single turn, so a test can script
// "tool call -> tool call -> answer".
const scripted = (turns: HarnessStreamEvent[][]): HarnessStream => {
    let index = 0;
    return async function* stream() {
        const frames = turns[index] ?? turns[turns.length - 1];
        index++;
        for (const frame of frames) {
            yield frame;
        }
    };
};

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

const callTool = (id: string, name: string, args: string): HarnessStreamEvent[] => [
    { type: 'done', stopReason: 'tool_calls', toolCalls: [{ id, name, arguments: args }] }
];

// An agent with no transport config: the scripted stream is injected directly.
const brain = (stream: HarnessStream, extra: Record<string, unknown> = {}) =>
    agent({ model: 'merge/ds4-flash', stream, ...extra });

describe('harness', () => {
    it('is callable and runs the entry agent', async () => {
        const writer = harness({ agents: { writer: brain(scripted([answer('Once upon a time.')])) } });

        const message = await writer('Write an opening.');

        expect(message.content).toBe('Once upon a time.');
        expect(writer.name).toBe('writer');
        expect(writer.agent).toBe(writer.agents.writer);
        expect(writer.agent.messages).toEqual([
            { role: 'user', content: 'Write an opening.' },
            { role: 'assistant', content: 'Once upon a time.' }
        ]);
    });

    it('uses the first agents key as the entry point and names agents from the registry', async () => {
        const writer = harness({
            agents: {
                writer: brain(scripted([answer('hi')])),
                researcher: brain(scripted([answer('found')]))
            }
        });

        expect(writer.name).toBe('writer');
        expect(Object.keys(writer.agents)).toEqual(['writer', 'researcher']);
        expect(writer.agents.writer.name).toBe('writer');
        expect(writer.agents.researcher.name).toBe('researcher');
        expect(writer.agents.researcher.model()).toBe('merge/ds4-flash');
    });

    it('registers tools under their config key and declares them to the model', async () => {
        const websearch = tool({ description: 'Search the web.', execute: () => 'results' });

        const writer = harness({
            agents: { writer: brain(scripted([answer('done')])) },
            tools: { websearch }
        });

        expect(writer.tools.websearch).toBe(websearch);
        expect(websearch.name).toBe('websearch');
    });

    it('runs a tool, feeds the result back, and loops until the model answers', async () => {
        const received: unknown[] = [];
        const websearch = tool({
            description: 'Search the web.',
            parameters: { type: 'object', properties: { q: { type: 'string' } } },
            execute: ({ parameters }) => {
                received.push(parameters);
                return { hits: ['fireworks', 'countdown'] };
            }
        });

        const entry = brain(
            scripted([callTool('call_1', 'websearch', '{"q":"new year"}'), answer('New year is fireworks.')])
        );

        const writer = harness({ agents: { writer: entry }, tools: { websearch } });
        const message = await writer('tell me about new year');

        // Single-property schema: the implementation gets the value, not the
        // wrapper object. Same thing a direct `websearch('new year')` receives.
        expect(received).toEqual(['new year']);
        expect(message.content).toBe('New year is fireworks.');

        // The transcript shows the whole arc: user -> assistant(tool call) ->
        // tool result -> assistant(answer).
        expect(entry.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
        expect(entry.messages[2]).toEqual({
            role: 'tool',
            content: '{"hits":["fireworks","countdown"]}',
            toolCallId: 'call_1',
            name: 'websearch'
        });
    });

    it('reports every step through report.progress, in order', async () => {
        const events: HarnessEvent[] = [];

        const websearch = tool({ description: 'Search.', execute: () => 'found' });
        const writer = harness({
            agents: { writer: brain(scripted([callTool('c1', 'websearch', '{}'), answer('done')])) },
            tools: { websearch },
            report: {
                progress: async (event) => {
                    events.push(event);
                }
            }
        });

        await writer('go');

        expect(events.map((event) => event.type)).toEqual(['start', 'tool_call', 'tool_result', 'text', 'done']);
        expect(events[0]).toEqual({ type: 'start', agent: 'writer', model: 'merge/ds4-flash' });
        expect(events[1]).toMatchObject({ type: 'tool_call', agent: 'writer' });
        expect(events[2]).toMatchObject({ type: 'tool_result', name: 'websearch', isError: false });
        expect(events[3]).toMatchObject({ type: 'text', agent: 'writer', delta: 'done' });
        expect(events[4]).toMatchObject({ type: 'done', agent: 'writer' });
    });

    it('awaits progress so a slow reporter paces the run', async () => {
        let resolved = false;

        const writer = harness({
            agents: { writer: brain(scripted([answer('hi')])) },
            report: {
                progress: async () => {
                    await new Promise((resolve) => setTimeout(resolve, 1));
                    resolved = true;
                }
            }
        });

        await writer('go');
        expect(resolved).toBe(true);
    });

    it('turns an unknown tool into a recoverable tool result', async () => {
        const entry = brain(scripted([callTool('c1', 'nope', '{}'), answer('recovered')]));
        const writer = harness({ agents: { writer: entry } });

        const message = await writer('go');

        expect(message.content).toBe('recovered');
        expect(entry.messages[2]).toMatchObject({
            role: 'tool',
            name: 'nope',
            content: 'Tool "nope" is not registered. Available tools: none.'
        });
    });

    it('turns malformed arguments into a recoverable tool result', async () => {
        let executed = false;
        const websearch = tool({
            description: 'Search.',
            execute: () => {
                executed = true;
                return 'found';
            }
        });

        const entry = brain(scripted([callTool('c1', 'websearch', '{"q":'), answer('recovered')]));
        const writer = harness({ agents: { writer: entry }, tools: { websearch } });

        await writer('go');

        expect(executed).toBe(false);
        expect(entry.messages[2].role).toBe('tool');
        expect((entry.messages[2] as { content: string }).content).toContain('malformed JSON arguments');
    });

    it('turns a throwing tool into a recoverable tool result', async () => {
        const websearch = tool({
            description: 'Search.',
            execute: () => {
                throw new Error('rate limited');
            }
        });

        const entry = brain(scripted([callTool('c1', 'websearch', '{}'), answer('recovered')]));
        const writer = harness({ agents: { writer: entry }, tools: { websearch } });

        const message = await writer('go');

        expect(message.content).toBe('recovered');
        expect((entry.messages[2] as { content: string }).content).toBe('Tool "websearch" failed: rate limited');
    });

    it('gives a tool access to sibling agents through ctx.run', async () => {
        const researcher = brain(scripted([answer('researched facts')]));

        const research = tool({
            description: 'Ask the researcher.',
            execute: async ({ run }) => (await run('researcher', 'find facts')).content
        });

        const writerAgent = brain(scripted([callTool('c1', 'research', '{}'), answer('final')]));

        const writer = harness({
            agents: { writer: writerAgent, researcher },
            tools: { research }
        });

        await writer('go');

        expect((writerAgent.messages[2] as { content: string }).content).toBe('researched facts');
        expect(researcher.messages).toEqual([
            { role: 'user', content: 'find facts' },
            { role: 'assistant', content: 'researched facts' }
        ]);
    });

    it('runs several tool calls in one turn', async () => {
        const calls: string[] = [];

        const first = tool({
            description: 'a',
            execute: () => {
                calls.push('a');
                return 'A';
            }
        });
        const second = tool({
            description: 'b',
            execute: () => {
                calls.push('b');
                return 'B';
            }
        });

        const entry = brain(
            scripted([
                [
                    {
                        type: 'done',
                        stopReason: 'tool_calls',
                        toolCalls: [
                            { id: 'c1', name: 'first', arguments: '{}' },
                            { id: 'c2', name: 'second', arguments: '{}' }
                        ]
                    }
                ],
                answer('both done')
            ])
        );

        const writer = harness({ agents: { writer: entry }, tools: { first, second } });
        await writer('go');

        expect(calls).toEqual(['a', 'b']);
        expect(entry.messages.filter((m) => m.role === 'tool')).toHaveLength(2);
    });

    it('truncates history and throws when the transport fails', async () => {
        const events: HarnessEvent[] = [];

        const failing = scripted([[{ type: 'error', message: 'upstream exploded' }]]);
        const writer = harness({
            agents: { writer: brain(failing) },
            report: {
                progress: (event) => {
                    events.push(event);
                }
            }
        });

        await expect(writer('go')).rejects.toThrow('upstream exploded');

        expect(writer.agent.messages).toEqual([]);
        expect(events.at(-1)).toEqual({
            type: 'error',
            agent: 'writer',
            error: { message: 'upstream exploded' }
        });
    });

    it('stops a runaway tool loop instead of recursing forever', async () => {
        // Always asks for another tool, never answers.
        const loop: HarnessStream = async function* () {
            yield {
                type: 'done' as const,
                stopReason: 'tool_calls' as const,
                toolCalls: [{ id: 'c', name: 'again', arguments: '{}' }]
            };
        };

        const again = tool({ description: 'again', execute: () => 'ok' });
        const writer = harness({ agents: { writer: brain(loop) }, tools: { again } });

        await expect(writer('go')).rejects.toThrow('requested tools more than 16 times');
        // The failed run leaves no partial history behind.
        expect(writer.agent.messages).toEqual([]);
    });

    it('reset() clears the entry agent conversation and keeps the tools', async () => {
        const websearch = tool({ description: 'Search.', execute: () => 'ok' });
        const writer = harness({
            agents: { writer: brain(scripted([answer('hi')]), { instruction: 'You are a writer.' }) },
            tools: { websearch }
        });

        await writer('one');
        expect(writer.agent.messages).toHaveLength(3);

        writer.reset();

        expect(writer.agent.messages).toEqual([{ role: 'system', content: 'You are a writer.' }]);
        expect(writer.tools.websearch).toBe(websearch);
    });

    it('requires at least one agent', () => {
        expect(() => harness({ agents: {} })).toThrow('A harness requires at least one agent.');
    });

    it('rejects a value that is not an agent', () => {
        expect(() => harness({ agents: { writer: { model: 'm' } as any } })).toThrow(
            'Agent "writer" is not an agent: create it with agent({...}).'
        );
    });

    it('rejects a value that is not a tool', () => {
        expect(() =>
            harness({ agents: { writer: brain(scripted([answer('hi')])) }, tools: { bad: {} as any } })
        ).toThrow('Tool "bad" is not a tool: create it with tool({...}).');
    });

    it('applies plugins, which can add agents and tools', async () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('hi')])) },
            plugins: [
                {
                    name: 'extras',
                    setup: (api) => {
                        api.createAgent('researcher', { model: 'r', stream: scripted([answer('r')]) });
                        api.addTool('now', { description: 'Time.', execute: () => 'noon' });
                    }
                }
            ]
        });

        expect(writer.plugins).toEqual(['extras']);
        expect(writer.agents.researcher.name).toBe('researcher');
        expect(writer.tools.now.description).toBe('Time.');
    });

    it('rejects duplicate plugin names', () => {
        expect(() =>
            harness({
                agents: { writer: brain(scripted([answer('hi')])) },
                plugins: [{ name: 'x' }, { name: 'x' }]
            })
        ).toThrow('Plugin "x" is registered more than once.');
    });

    it('rejects a plugin that registers a name twice', () => {
        expect(() =>
            harness({
                agents: { writer: brain(scripted([answer('hi')])) },
                plugins: [
                    {
                        name: 'extras',
                        setup: (api) => {
                            api.addTool('now', { description: 'Time.', execute: () => 'noon' });
                            api.addTool('now', { description: 'Time.', execute: () => 'noon' });
                        }
                    }
                ]
            })
        ).toThrow('Tool "now" is already registered.');
    });

    it('exposes the harness name on the callable itself', () => {
        const writer = harness({ agents: { writer: brain(scripted([answer('hi')])) } });

        // A function's `name` is read-only, so this also proves the define
        // in harness() actually took effect.
        expect(writer.name).toBe('writer');
        expect(typeof writer).toBe('function');
    });
});

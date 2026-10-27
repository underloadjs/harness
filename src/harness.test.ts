// harness() — the execution loop.
//
// These tests pin the contract the CLI relies on:
//   - the harness is callable: `await writer('...')` runs the entry agent;
//   - the first `agents` key is the entry point (unless `primary` names another),
//     and its name is the harness name;
//   - only core tools are declared, and getTools enables the rest for the next
//     turn — a searchable tool is invisible and uncallable until then;
//   - createTool is always core, and delegate is core only when subagents exist;
//   - tools run, their results are fed back, and the loop repeats until the model
//     answers with text;
//   - every failure mode (unknown tool, undiscovered tool, bad JSON, throwing
//     tool) becomes a tool result the model can recover from — not a crash;
//   - report.progress is awaited for every step;
//   - transport failure or a runaway loop truncates history and throws.

import { describe, expect, it } from 'vitest';
import { agent, harness, javascriptSyntax, readFile, runCommand, tool } from '@underload/harness';
import type { HarnessEvent, HarnessStream, HarnessStreamEvent, HarnessStreamRequest } from '@underload/harness';

// A transport that replays a scripted list of turns, one per request. Each entry
// is the set of frames for a single turn, so a test can script
// "tool call -> tool call -> answer". Pass `seen` to record every request, which
// is how the declaration tests inspect what the model was offered.
const scripted = (turns: HarnessStreamEvent[][], seen?: HarnessStreamRequest[]): HarnessStream => {
    let index = 0;
    return async function* stream(request) {
        seen?.push(request);
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

const declaredNames = (request: HarnessStreamRequest | undefined): string[] =>
    (request?.tools ?? []).map((declaration) => declaration.name);

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

    it('registers tools under their config key and always adds getTools', async () => {
        const websearch = tool({ description: 'Search the web.', tags: ['search'], execute: () => 'results' });

        const writer = harness({
            agents: { writer: brain(scripted([answer('done')])) },
            tools: { websearch }
        });

        expect(writer.tools.websearch).toBe(websearch);
        expect(websearch.name).toBe('websearch');
        expect(writer.tools.getTools.visibility).toBe('core');
    });

    it('declares core tools only, leaving the rest to getTools', async () => {
        const seen: HarnessStreamRequest[] = [];
        const searchable = tool({ description: 'Search.', tags: ['search'], execute: () => 'found' });
        const core = tool({ description: 'Always on.', tags: ['core'], visibility: 'core', execute: () => 'ok' });

        const writer = harness({
            agents: { writer: brain(scripted([answer('hi')], seen)) },
            tools: { searchable, core }
        });

        await writer('go');

        // The searchable tool is registered but absent from the request. getTools
        // is core, so it is always there.
        expect(writer.tools.searchable).toBe(searchable);
        expect(declaredNames(seen[0])).toEqual(['core', 'getTools', 'createTool']);
    });

    it('preloads the preset catalogue into every harness, searchable', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = harness({ agents: { writer: brain(scripted([answer('hi')], seen)) } });

        await writer('go');

        // Registered, so discovery can reach them without any import ...
        expect(writer.tools.readFile).toBe(readFile);
        expect(writer.tools.runCommand).toBe(runCommand);
        expect(writer.tools.javascriptSyntax).toBe(javascriptSyntax);
        // ... and all searchable, so the first request pays only for the core
        // tools (getTools + createTool).
        expect(declaredNames(seen[0])).toEqual(['getTools', 'createTool']);
    });

    it('starts from the configured tools only when presets are disabled', () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('hi')])) },
            presets: false
        });

        expect(writer.tools.readFile).toBeUndefined();
        expect(Object.keys(writer.tools)).toEqual(['getTools', 'createTool']);
    });

    it('lets the model discover and run a preloaded preset', async () => {
        const seen: HarnessStreamRequest[] = [];
        const entry = brain(
            scripted(
                [
                    callTool('c1', 'getTools', '{"tags":["javascript"]}'),
                    callTool('c2', 'javascriptSyntax', '{"code":"const a = 1;"}'),
                    answer('valid')
                ],
                seen
            )
        );

        // No `tools` at all: the catalogue came from the preset preload.
        const writer = harness({ agents: { writer: entry } });
        const message = await writer('check this snippet');

        expect(declaredNames(seen[1])).toEqual(['getTools', 'createTool', 'javascriptSyntax']);
        expect((entry.messages[4] as { content: string }).content).toBe('true');
        expect(message.content).toBe('valid');
    });

    it('enables the closest matches through getTools for the next turn', async () => {
        const seen: HarnessStreamRequest[] = [];
        const readFile = tool({
            description: 'Read a text file.',
            tags: ['files', 'read'],
            execute: () => 'file contents'
        });
        const runCommand = tool({
            description: 'Run a shell command.',
            tags: ['shell', 'command'],
            execute: () => 'output'
        });

        const entry = brain(
            scripted(
                [
                    callTool('c1', 'getTools', '{"tags":["files"]}'),
                    callTool('c2', 'readFile', '{"path":"a.txt"}'),
                    answer('read it')
                ],
                seen
            )
        );

        const writer = harness({ agents: { writer: entry }, tools: { readFile, runCommand }, presets: false });
        const message = await writer('read a.txt');

        // Round one: core only. Round two: the discovered tool joined the
        // declarations, and the unrelated tool stayed out.
        expect(declaredNames(seen[0])).toEqual(['getTools', 'createTool']);
        expect(declaredNames(seen[1])).toEqual(['getTools', 'createTool', 'readFile']);

        // The discovery result is what the model sees: names plus metadata.
        const discovery = JSON.parse((entry.messages[2] as { content: string }).content);
        expect(discovery.enabled).toEqual(['readFile']);
        expect(discovery.tools).toEqual([
            { name: 'readFile', description: 'Read a text file.', tags: ['files', 'read'] }
        ]);

        expect(message.content).toBe('read it');
        expect((entry.messages[4] as { content: string }).content).toBe('file contents');
    });

    it('refuses a searchable tool the model has not discovered', async () => {
        let executed = false;
        const hidden = tool({
            description: 'Hidden.',
            tags: ['files', 'read'],
            execute: () => {
                executed = true;
                return 'never';
            }
        });

        const entry = brain(scripted([callTool('c1', 'hidden', '{}'), answer('recovered')]));
        const writer = harness({ agents: { writer: entry }, tools: { hidden } });

        const message = await writer('go');

        expect(executed).toBe(false);
        expect(message.content).toBe('recovered');
        expect((entry.messages[2] as { content: string }).content).toBe(
            'Tool "hidden" is registered but not enabled yet. Call getTools with tags like "files", "read" to enable it.'
        );
    });

    it('runs a tool, feeds the result back, and loops until the model answers', async () => {
        const received: unknown[] = [];
        const websearch = tool({
            description: 'Search the web.',
            tags: ['search', 'web'],
            visibility: 'core',
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

        const websearch = tool({
            description: 'Search.',
            tags: ['search'],
            visibility: 'core',
            execute: () => 'found'
        });
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
            content:
                'Tool "nope" is not registered. Available tools: getTools, createTool. Call getTools with capability tags to search the catalogue.'
        });
    });

    it('turns malformed arguments into a recoverable tool result', async () => {
        let executed = false;
        const websearch = tool({
            description: 'Search.',
            tags: ['search'],
            visibility: 'core',
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
            tags: ['search'],
            visibility: 'core',
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
            tags: ['agents'],
            visibility: 'core',
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
            tags: ['a'],
            visibility: 'core',
            execute: () => {
                calls.push('a');
                return 'A';
            }
        });
        const second = tool({
            description: 'b',
            tags: ['b'],
            visibility: 'core',
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

        const again = tool({
            description: 'again',
            tags: ['loop'],
            visibility: 'core',
            execute: () => 'ok'
        });
        const writer = harness({ agents: { writer: brain(loop) }, tools: { again } });

        await expect(writer('go')).rejects.toThrow('requested tools more than 16 times');
        // The failed run leaves no partial history behind.
        expect(writer.agent.messages).toEqual([]);
    });

    it('reset() clears the entry agent conversation and keeps the tools', async () => {
        const websearch = tool({ description: 'Search.', tags: ['search'], execute: () => 'ok' });
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

    it('reset() forgets the tools getTools enabled', async () => {
        const seen: HarnessStreamRequest[] = [];
        const hidden = tool({ description: 'Hidden.', tags: ['files'], execute: () => 'ok' });

        const entry = brain(
            scripted(
                [
                    callTool('c1', 'getTools', '{"tags":["files"]}'),
                    answer('done'),
                    answer('done again')
                ],
                seen
            )
        );

        const writer = harness({ agents: { writer: entry }, tools: { hidden }, presets: false });

        await writer('go');
        expect(declaredNames(seen[1])).toEqual(['getTools', 'createTool', 'hidden']);

        writer.reset();
        await writer('go again');

        // Back to the core set: discovery is part of "start over".
        expect(declaredNames(seen[2])).toEqual(['getTools', 'createTool']);
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

    it('reserves the getTools name', () => {
        const custom = tool({ description: 'Mine.', tags: ['discovery'], execute: () => 'ok' });

        expect(() =>
            harness({
                agents: { writer: brain(scripted([answer('hi')])) },
                tools: { getTools: custom }
            })
        ).toThrow('Tool "getTools" is reserved by the harness.');
    });

    it('applies plugins, which can add agents and tools', async () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('hi')])) },
            plugins: [
                {
                    name: 'extras',
                    setup: (api) => {
                        api.createAgent('researcher', { model: 'r', stream: scripted([answer('r')]) });
                        api.addTool('now', { description: 'Time.', tags: ['time'], execute: () => 'noon' });
                    }
                }
            ]
        });

        expect(writer.plugins).toEqual(['extras']);
        expect(writer.agents.researcher.name).toBe('researcher');
        expect(writer.tools.now.description).toBe('Time.');
        // A plugin-contributed tool is searchable too: it does not bypass discovery.
        expect(writer.tools.now.visibility).toBe('searchable');
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
                            api.addTool('now', { description: 'Time.', tags: ['time'], execute: () => 'noon' });
                            api.addTool('now', { description: 'Time.', tags: ['time'], execute: () => 'noon' });
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

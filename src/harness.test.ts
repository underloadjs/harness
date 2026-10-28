// harness() — the execution loop.
//
// These tests pin the contract the CLI relies on:
//   - the harness is callable: `await writer('...')` runs the entry agent;
//   - the first `agents` key is the entry point (unless `primary` names another),
//     and its name is the harness name;
//   - the ONLY core tools are the harness-owned toolRequest, toolCreate, and
//     todoManage (delegate only when subagents exist); the entire preset catalogue
//     — file tools included — is searchable and toolRequest enables the matches
//     for the next turn, until then they are invisible and uncallable;
//   - toolCreate and todoManage are always core, and delegate is core only when
//     subagents exist;
//   - tools run, their results are fed back, and the loop repeats until the model
//     answers with text;
//   - every failure mode (unknown tool, undiscovered tool, bad JSON, throwing
//     tool) becomes a tool result the model can recover from — not a crash;
//   - report.progress is awaited for every step;
//   - transport failure or a runaway loop truncates history and throws.

import { describe, expect, it } from 'vitest';
import { agent, harness, fileRead, commandRun, syntaxCheck, tool } from '@underload/harness';
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

    it('registers tools under their config key and always adds toolRequest', async () => {
        const webSearch = tool({ description: 'Search the web.', tags: ['search'], execute: () => 'results' });

        const writer = harness({
            agents: { writer: brain(scripted([answer('done')])) },
            tools: { webSearch }
        });

        expect(writer.tools.webSearch).toBe(webSearch);
        expect(webSearch.name).toBe('webSearch');
        expect(writer.tools.toolRequest.visibility).toBe('core');
    });

    it('declares core tools only, leaving the rest to toolRequest', async () => {
        const seen: HarnessStreamRequest[] = [];
        const searchable = tool({ description: 'Search.', tags: ['search'], execute: () => 'found' });
        const core = tool({ description: 'Always on.', tags: ['core'], visibility: 'core', execute: () => 'ok' });

        const writer = harness({
            agents: { writer: brain(scripted([answer('hi')], seen)) },
            tools: { searchable, core }
        });

        await writer('go');

        // The searchable tool is registered but absent from the request. No preset
        // tool is core either, so only the configured core tool is declared.
        expect(writer.tools.searchable).toBe(searchable);
        expect(declaredNames(seen[0])).toEqual([
            'core',
            'toolRequest',
            'toolCreate',
            'todoManage'
        ]);
    });

    it('preloads the preset catalogue with every entry searchable', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = harness({ agents: { writer: brain(scripted([answer('hi')], seen)) } });

        await writer('go');

        // Registered, so they can be discovered without any import...
        expect(writer.tools.fileRead).toBe(fileRead);
        expect(writer.tools.commandRun).toBe(commandRun);
        expect(writer.tools.syntaxCheck).toBe(syntaxCheck);
        expect(writer.tools.fileRead.visibility).toBe('searchable');
        expect(writer.tools.commandRun.visibility).toBe('searchable');
        // ...and nothing is declared but the harness-owned core set.
        expect(declaredNames(seen[0])).toEqual(['toolRequest', 'toolCreate', 'todoManage']);
    });

    it('discovers the file tools along with syntaxCheck', async () => {
        const entry = brain(
            scripted([
                callTool('c1', 'toolRequest', '{"tags":["files"]}'),
                callTool('c2', 'toolRequest', '{"tags":["javascript"]}'),
                answer('done')
            ])
        );
        const writer = harness({ agents: { writer: entry } });

        await writer('look around');

        // Every file tool is searchable now and each carries the exact tag
        // "files", so all five tie on the best single-tag score (4). A name or
        // description hit is the 1-point rung of that ladder, not a bonus on top
        // of a tag hit, so it cannot reorder them; hits and then name decide.
        // T14 folded glob+content search into one fileGlob tool, so the whole
        // family now fits inside the five-match cap.
        const fileSearch = JSON.parse((entry.messages[2] as { content: string }).content);
        expect(fileSearch.enabled).toEqual([
            'fileEdit',
            'fileGlob',
            'fileList',
            'fileRead',
            'fileWrite'
        ]);
        expect(fileSearch.tools.map((tool: { name: string }) => tool.name)).toEqual([
            'fileEdit',
            'fileGlob',
            'fileList',
            'fileRead',
            'fileWrite'
        ]);
        expect(fileSearch.remaining).toBe(0);
        expect(fileSearch.truncated).toBeUndefined();

        // ...while the searchable syntaxCheck is found and enabled. The same
        // "javascript" query also reaches fileGlob weakly (its description mentions
        // a "JavaScript regular expression"), which is the documented 1-point rung,
        // so the exact tag hit ranks first and both are declared.
        const syntaxSearch = JSON.parse((entry.messages[4] as { content: string }).content);
        expect(syntaxSearch.enabled).toEqual(['syntaxCheck', 'fileGlob']);
        expect(syntaxSearch.tools).toEqual([
            {
                name: 'syntaxCheck',
                description: expect.stringContaining('Check whether a code snippet parses'),
                tags: ['code', 'syntax', 'javascript', 'python', 'validation']
            },
            {
                name: 'fileGlob',
                description: expect.stringContaining('Find files by glob pattern'),
                tags: [
                    'files',
                    'glob',
                    'search',
                    'grep',
                    'find',
                    'content',
                    'filesystem'
                ]
            }
        ]);
        expect(syntaxSearch.remaining).toBe(0);
        expect(syntaxSearch.truncated).toBeUndefined();

        expect(writer.tools.fileRead.visibility).toBe('searchable');
        expect(writer.tools.syntaxCheck.visibility).toBe('searchable');
    });

    it('refines a broad query to reach the match the cap left out', async () => {
        const entry = brain(
            scripted([
                callTool('c1', 'toolRequest', '{"tags":["files"]}'),
                callTool('c2', 'toolRequest', '{"tags":["files","write"]}'),
                answer('done')
            ])
        );
        const writer = harness({ agents: { writer: entry } });

        await writer('change a file');

        // "files" alone already lists every file tool (the whole family fits in
        // the cap now that glob+content search is one tool). Adding the second tag
        // gives fileEdit and fileWrite a second matching query tag, which is the
        // documented tie break, so they move to the front — that is the R7
        // refinement workflow: same shortlist, better order.
        expect(JSON.parse((entry.messages[2] as { content: string }).content).enabled).toEqual([
            'fileEdit',
            'fileGlob',
            'fileList',
            'fileRead',
            'fileWrite'
        ]);
        expect(JSON.parse((entry.messages[4] as { content: string }).content).enabled).toEqual([
            'fileEdit',
            'fileWrite',
            'fileGlob',
            'fileList',
            'fileRead'
        ]);
        // Discovery order is first-enabled-first: the broad query enabled all five,
        // so the refined query adds nothing new and the order is unchanged.
        expect(writer.discoveredTools).toEqual([
            'fileEdit',
            'fileGlob',
            'fileList',
            'fileRead',
            'fileWrite'
        ]);
    });

    it('starts from the configured tools only when presets are disabled', () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('hi')])) },
            presets: false
        });

        expect(writer.tools.fileRead).toBeUndefined();
        expect(Object.keys(writer.tools)).toEqual(['toolRequest', 'toolCreate', 'todoManage']);
    });

    it('lets the model discover and run a preloaded preset', async () => {
        const seen: HarnessStreamRequest[] = [];
        const entry = brain(
            scripted(
                [
                    callTool('c1', 'toolRequest', '{"tags":["javascript"]}'),
                    callTool(
                        'c2',
                        'syntaxCheck',
                        '{"code":"const a = 1;","language":"javascript"}'
                    ),
                    answer('valid')
                ],
                seen
            )
        );

        // No `tools` at all: the catalogue came from the preset preload.
        const writer = harness({ agents: { writer: entry } });
        const message = await writer('check this snippet');

        // A "javascript" query hits syntaxCheck on its exact tag (4) and fileGlob
        // weakly through its description ("a JavaScript regular expression", 1).
        // Both are enabled; the ranking puts the exact tag hit first, so the
        // declaration order is syntaxCheck then fileGlob.
        expect(declaredNames(seen[1])).toEqual([
            'toolRequest',
            'toolCreate',
            'todoManage',
            'syntaxCheck',
            'fileGlob'
        ]);
        expect((entry.messages[4] as { content: string }).content).toBe('true');
        expect(message.content).toBe('valid');
    });

    it('enables the closest matches through toolRequest for the next turn', async () => {
        const seen: HarnessStreamRequest[] = [];
        const fileRead = tool({
            description: 'Read a text file.',
            tags: ['files', 'read'],
            execute: () => 'file contents'
        });
        const commandRun = tool({
            description: 'Run a shell command.',
            tags: ['shell', 'command'],
            execute: () => 'output'
        });

        const entry = brain(
            scripted(
                [
                    callTool('c1', 'toolRequest', '{"tags":["files"]}'),
                    callTool('c2', 'fileRead', '{"path":"a.txt"}'),
                    answer('read it')
                ],
                seen
            )
        );

        const writer = harness({ agents: { writer: entry }, tools: { fileRead, commandRun }, presets: false });
        const message = await writer('read a.txt');

        // Round one: core only. Round two: the discovered tool joined the
        // declarations, and the unrelated tool stayed out.
        expect(declaredNames(seen[0])).toEqual(['toolRequest', 'toolCreate', 'todoManage']);
        expect(declaredNames(seen[1])).toEqual(['toolRequest', 'toolCreate', 'todoManage', 'fileRead']);

        // The discovery result is what the model sees: names plus metadata.
        const discovery = JSON.parse((entry.messages[2] as { content: string }).content);
        expect(discovery.enabled).toEqual(['fileRead']);
        expect(discovery.tools).toEqual([
            { name: 'fileRead', description: 'Read a text file.', tags: ['files', 'read'] }
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
            'Tool "hidden" is registered but not enabled yet. Call toolRequest with tags like "files", "read" to enable it.'
        );
    });

    it('runs a tool, feeds the result back, and loops until the model answers', async () => {
        const received: unknown[] = [];
        const webSearch = tool({
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
            scripted([callTool('call_1', 'webSearch', '{"q":"new year"}'), answer('New year is fireworks.')])
        );

        const writer = harness({ agents: { writer: entry }, tools: { webSearch } });
        const message = await writer('tell me about new year');

        // Single-property schema: the implementation gets the value, not the
        // wrapper object. Same thing a direct `webSearch('new year')` receives.
        expect(received).toEqual(['new year']);
        expect(message.content).toBe('New year is fireworks.');

        // The transcript shows the whole arc: user -> assistant(tool call) ->
        // tool result -> assistant(answer).
        expect(entry.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
        expect(entry.messages[2]).toEqual({
            role: 'tool',
            content: '{"hits":["fireworks","countdown"]}',
            toolCallId: 'call_1',
            name: 'webSearch'
        });
    });

    it('reports every step through report.progress, in order', async () => {
        const events: HarnessEvent[] = [];

        const webSearch = tool({
            description: 'Search.',
            tags: ['search'],
            visibility: 'core',
            execute: () => 'found'
        });
        const writer = harness({
            agents: { writer: brain(scripted([callTool('c1', 'webSearch', '{}'), answer('done')])) },
            tools: { webSearch },
            report: {
                progress: async (event) => {
                    events.push(event);
                }
            }
        });

        await writer('go');

        expect(events.map((event) => event.type)).toEqual(['start', 'tool_call', 'tool_result', 'text', 'done']);
        expect(events[0]).toEqual({ type: 'start', agent: 'writer', model: 'merge/ds4-flash' });
        expect(events[1]).toEqual({
            type: 'tool_call',
            agent: 'writer',
            call: { id: 'c1', name: 'webSearch', arguments: '{}' }
        });
        // The call id lets a UI pair a result with its exact call even when two
        // calls in one turn share a name.
        expect(events[2]).toEqual({
            type: 'tool_result',
            agent: 'writer',
            name: 'webSearch',
            callId: 'c1',
            content: 'found',
            isError: false
        });
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
            // Only the harness-owned core tools are declared, so the recovery hint
            // lists exactly those and points at toolRequest for the catalogue.
            content:
                'Tool "nope" is not registered. Available tools: toolRequest, toolCreate, todoManage. Call toolRequest with capability tags to search the catalogue.'
        });
    });

    it('turns malformed arguments into a recoverable tool result', async () => {
        let executed = false;
        const webSearch = tool({
            description: 'Search.',
            tags: ['search'],
            visibility: 'core',
            execute: () => {
                executed = true;
                return 'found';
            }
        });

        const entry = brain(scripted([callTool('c1', 'webSearch', '{"q":'), answer('recovered')]));
        const writer = harness({ agents: { writer: entry }, tools: { webSearch } });

        await writer('go');

        expect(executed).toBe(false);
        expect(entry.messages[2].role).toBe('tool');
        expect((entry.messages[2] as { content: string }).content).toContain('malformed JSON arguments');
    });

    it('turns a throwing tool into a recoverable tool result', async () => {
        const webSearch = tool({
            description: 'Search.',
            tags: ['search'],
            visibility: 'core',
            execute: () => {
                throw new Error('rate limited');
            }
        });

        const entry = brain(scripted([callTool('c1', 'webSearch', '{}'), answer('recovered')]));
        const writer = harness({ agents: { writer: entry }, tools: { webSearch } });

        const message = await writer('go');

        expect(message.content).toBe('recovered');
        expect((entry.messages[2] as { content: string }).content).toBe('Tool "webSearch" failed: rate limited');
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

    it('honours a configured maxIterations above the library default', async () => {
        // 20 tool rounds would trip the default 16-round guard; a real session
        // (the workspace preset) reaches this shape routinely.
        const seen: HarnessStreamRequest[] = [];
        const turns = [
            ...Array.from({ length: 20 }, (_, index) => callTool(`c${index}`, 'again', '{}')),
            answer('finished')
        ];

        const again = tool({
            description: 'again',
            tags: ['loop'],
            visibility: 'core',
            execute: () => 'ok'
        });
        const writer = harness({
            agents: { writer: brain(scripted(turns, seen)) },
            tools: { again },
            maxIterations: 1000
        });

        const message = await writer('go');

        expect(message.content).toBe('finished');
        // 21 requests: 20 tool rounds plus the answering turn.
        expect(seen).toHaveLength(21);
        // user + (assistant tool call + tool result) * 20 + assistant answer.
        expect(writer.agent.messages).toHaveLength(42);
        expect(writer.agent.messages.at(-1)).toEqual({ role: 'assistant', content: 'finished' });
    });

    it('fails at the configured bound and names it in the error', async () => {
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
        const writer = harness({
            agents: { writer: brain(loop) },
            tools: { again },
            maxIterations: 2
        });

        await expect(writer('go')).rejects.toThrow('requested tools more than 2 times');
        expect(writer.agent.messages).toEqual([]);
    });

    it('allows one tool round at maxIterations: 2 and answers on the next turn', async () => {
        const again = tool({
            description: 'again',
            tags: ['loop'],
            visibility: 'core',
            execute: () => 'ok'
        });
        const writer = harness({
            agents: { writer: brain(scripted([callTool('c1', 'again', '{}'), answer('done')])) },
            tools: { again },
            maxIterations: 2
        });

        const message = await writer('go');

        expect(message.content).toBe('done');
        expect(writer.agent.messages).toHaveLength(4);
    });

    it('accepts maxIterations: 1 for a single answering turn', async () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('immediate')])) },
            maxIterations: 1
        });

        const message = await writer('go');

        expect(message.content).toBe('immediate');
        expect(writer.agent.messages).toEqual([
            { role: 'user', content: 'go' },
            { role: 'assistant', content: 'immediate' }
        ]);
    });

    it('rejects a maxIterations that is not a positive safe integer', () => {
        // The exact message is part of the contract: it names the field and the
        // received value so a host can fix its configuration.
        const invalid: Array<[unknown, string]> = [
            [0, 'received 0'],
            [-1, 'received -1'],
            [1.5, 'received 1.5'],
            [Number.NaN, 'received NaN'],
            [Number.POSITIVE_INFINITY, 'received Infinity'],
            [Number.NEGATIVE_INFINITY, 'received -Infinity'],
            [Number.MAX_SAFE_INTEGER + 1, 'received 9007199254740992']
        ];

        for (const [value, received] of invalid) {
            expect(() =>
                harness({
                    agents: { writer: brain(scripted([answer('hi')])) },
                    maxIterations: value as number
                })
            ).toThrow(`maxIterations must be a positive safe integer; ${received}.`);
        }
    });

    it('reset() clears the entry agent conversation and keeps the tools', async () => {
        const webSearch = tool({ description: 'Search.', tags: ['search'], execute: () => 'ok' });
        const writer = harness({
            agents: { writer: brain(scripted([answer('hi')]), { instruction: 'You are a writer.' }) },
            tools: { webSearch }
        });

        await writer('one');
        expect(writer.agent.messages).toHaveLength(3);

        writer.reset();

        expect(writer.agent.messages).toEqual([{ role: 'system', content: 'You are a writer.' }]);
        expect(writer.tools.webSearch).toBe(webSearch);
    });

    it('reset() forgets the tools toolRequest enabled', async () => {
        const seen: HarnessStreamRequest[] = [];
        const hidden = tool({ description: 'Hidden.', tags: ['files'], execute: () => 'ok' });

        const entry = brain(
            scripted(
                [
                    callTool('c1', 'toolRequest', '{"tags":["files"]}'),
                    answer('done'),
                    answer('done again')
                ],
                seen
            )
        );

        const writer = harness({ agents: { writer: entry }, tools: { hidden }, presets: false });

        await writer('go');
        expect(declaredNames(seen[1])).toEqual(['toolRequest', 'toolCreate', 'todoManage', 'hidden']);
        expect(writer.discoveredTools).toEqual(['hidden']);

        writer.reset();
        expect(writer.discoveredTools).toEqual([]);

        await writer('go again');

        // Back to the core set: discovery is part of "start over".
        expect(declaredNames(seen[2])).toEqual(['toolRequest', 'toolCreate', 'todoManage']);
    });

    it('keeps discovery across separate calls on the same harness', async () => {
        const seen: HarnessStreamRequest[] = [];
        const reader = tool({
            description: 'Read a text file.',
            tags: ['files', 'read'],
            execute: () => 'contents'
        });

        const entry = brain(
            scripted(
                [
                    callTool('c1', 'toolRequest', '{"tags":["read"]}'),
                    callTool('c2', 'reader', '{"path":"a.txt"}'),
                    answer('first done'),
                    answer('second done')
                ],
                seen
            )
        );

        const writer = harness({
            agents: { writer: entry },
            tools: { reader },
            presets: false
        });

        await writer('first');
        expect(declaredNames(seen[1])).toEqual(['toolRequest', 'toolCreate', 'todoManage', 'reader']);
        expect(writer.discoveredTools).toEqual(['reader']);

        // A second call starts a NEW turn but not a new catalogue: toolRequest
        // enabled `reader` for the harness, so the next request still declares it
        // without another discovery round.
        await writer('second');
        expect(declaredNames(seen[3])).toEqual(['toolRequest', 'toolCreate', 'todoManage', 'reader']);
        expect(writer.discoveredTools).toEqual(['reader']);
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

    it('reserves the toolRequest name', () => {
        const custom = tool({ description: 'Mine.', tags: ['discovery'], execute: () => 'ok' });

        expect(() =>
            harness({
                agents: { writer: brain(scripted([answer('hi')])) },
                tools: { toolRequest: custom }
            })
        ).toThrow('Tool "toolRequest" is reserved by the harness.');
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

// Manual execution (R8): the host/server path behind the Tools tab.
//
// The same registered implementation runs, with this harness's context. Discovery
// gates the MODEL only — an explicit operator call may run a searchable tool that
// was never enabled — while every other policy (reserved names, the toolCreate
// budget/validation, primary-only delegation) still applies.
describe('executeTool', () => {
    it('runs a registered searchable tool without enabling it for the model', async () => {
        const seen: HarnessStreamRequest[] = [];
        const hidden = tool({ description: 'Read text.', tags: ['files', 'read'], execute: () => 'contents' });
        const writer = harness({ agents: { writer: brain(scripted([answer('hi')], seen)) }, tools: { hidden } });

        expect(writer.discoveredTools).toEqual([]);
        // The parameter IS the value `execute` receives (single-property rule).
        expect(await writer.executeTool('hidden', 'a.txt')).toBe('contents');

        // Nothing was enabled and the model still sees only the core declarations.
        expect(writer.discoveredTools).toEqual([]);
        await writer('go');
        expect(declaredNames(seen[0])).toEqual(['toolRequest', 'toolCreate', 'todoManage']);
    });

    it('runs a core tool against this harness and rejects an unregistered name', async () => {
        const writer = harness({ agents: { writer: brain(scripted([answer('hi')])) } });

        // A core tool is NOT searchable, so asking for its tag matches nothing: the
        // manual path runs the real implementation, not a shortcut.
        expect(await writer.executeTool('toolRequest', { tags: ['todo'] })).toMatchObject({
            enabled: [],
            tools: [],
            remaining: 0,
            unmatchedTags: ['todo']
        });
        expect(writer.discoveredTools).toEqual([]);

        await expect(writer.executeTool('nope', {})).rejects.toThrow(
            'Tool "nope" is not registered in this harness.'
        );

        // No subagents means no agentDelegate tool at all — never a fabricated one.
        await expect(writer.executeTool('agentDelegate', { agent: 'helper', input: 'go' })).rejects.toThrow(
            'Tool "agentDelegate" is not registered in this harness.'
        );
    });

    it('registers a created tool through the same guarded policy', async () => {
        const writer = harness({ agents: { writer: brain(scripted([answer('hi')])) } });

        expect(
            await writer.executeTool('toolCreate', {
                name: 'upper',
                description: 'Uppercase text.',
                tags: ['text', 'upper'],
                source: 'return String(args).toUpperCase();'
            })
        ).toEqual({
            name: 'upper',
            description: 'Uppercase text.',
            tags: ['text', 'upper'],
            enabled: true
        });

        // Registered searchable and enabled at once, exactly like the model path,
        // and the same collision rule applies to a second manual attempt.
        expect(writer.discoveredTools).toEqual(['upper']);
        expect(writer.tools.upper.visibility).toBe('searchable');
        await expect(
            writer.executeTool('toolCreate', {
                name: 'upper',
                description: 'Again.',
                tags: ['text'],
                source: 'return 1;'
            })
        ).rejects.toThrow('Tool "upper" is already registered; choose another name.');
    });

    it('delegates manually as the primary and leaves the transcript alone', async () => {
        const writer = harness({
            agents: {
                lead: brain(scripted([answer('lead answer')])),
                helper: brain(scripted([answer('helper answer')]))
            },
            primary: 'lead',
            subagents: ['helper'],
            presets: false
        });

        // A manual delegate call runs a REAL turn on the subagent, so its answer is
        // the same one the model would receive. No user message is appended to the
        // primary's conversation: this was not a turn.
        expect(await writer.executeTool('agentDelegate', { agent: 'helper', input: 'find it' })).toEqual({
            agent: 'helper',
            content: 'helper answer'
        });
        expect(writer.agent.messages).toEqual([]);
        expect(writer.agents.helper.messages.map((message) => message.role)).toEqual(['user', 'assistant']);

        // The allowlist is still enforced on the manual path.
        await expect(writer.executeTool('agentDelegate', { agent: 'lead', input: 'go' })).rejects.toThrow(
            'Agent "lead" is not a configured subagent. Allowed: helper.'
        );
    });
});

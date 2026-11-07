// harness() — the execution loop.
//
// These tests pin the contract the CLI relies on:
//   - the harness is callable: `await writer('...')` runs the entry agent;
//   - the first `agents` key is the entry point (unless `primary` names another),
//     and its name is the harness name;
//   - the harness-owned core tools are toolRequest, toolCreate, task,
//     profileManage, chapterManage, and locationManage (delegate only when
//     subagents exist); the rest of the preset catalogue — files and beyond —
//     is searchable and toolRequest enables the matches for the next turn, until
//     then it is invisible and uncallable;
//   - toolCreate, task, and the record tools are always core, and delegate
//     is core only when subagents exist;
//   - tools run, their results are fed back, and the loop repeats until the model
//     answers with text;
//   - every failure mode (unknown tool, undiscovered tool, bad JSON, throwing
//     tool) becomes a tool result the model can recover from — not a crash;
//   - report.progress is awaited for every step;
//   - transport failure or a runaway loop truncates history and throws.

import { describe, expect, it } from 'vitest';
import { agent, harness, read, shell, syntax, tool, toolUi } from '@underload/harness';
import type {
    HarnessEvent,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest,
    HarnessUsage
} from '@underload/harness';

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

// The optional `usage` makes the scripted transport report token accounting for
// THAT request, which is how the per-request `usage` progress events are pinned.
// Omitting it scripts a provider that sent no usage block (never zero-filled).
const answer = (text: string, usage?: HarnessUsage): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [], ...(usage === undefined ? {} : { usage }) }
];

const callTool = (id: string, name: string, args: string, usage?: HarnessUsage): HarnessStreamEvent[] => [
    {
        type: 'done',
        stopReason: 'tool_calls',
        toolCalls: [{ id, name, arguments: args }],
        ...(usage === undefined ? {} : { usage })
    }
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
        const search = tool({ description: 'Search the web.', tags: ['search'], execute: () => 'results' });

        const writer = harness({
            agents: { writer: brain(scripted([answer('done')])) },
            tools: { search }
        });

        expect(writer.tools.search.name).toBe('search');
        // The caller's shared Tool is not mutated; only the registered wrapper is
        // named by the configuration key.
        expect(search.name).toBe('tool');
        expect(writer.tools.toolRequest.visibility).toBe('core');
    });

    it('declares core tools only, leaving the rest to toolRequest', async () => {
        const seen: HarnessStreamRequest[] = [];
        const searchable = tool({ description: 'Search.', tags: ['search'], execute: () => 'found' });
        const core = tool({ description: 'Always on.', tags: ['core'], visibility: 'core', execute: () => 'ok' });

        const writer = harness({
            agents: { writer: brain(scripted([answer('hi')], seen)) },
            tools: { searchable, core },
            // Isolate the configured set: with the default preload the four core
            // file tools are declared too.
            presets: false
        });

        await writer('go');

        // The searchable tool is registered but absent from the request; only the
        // configured core tool (plus the harness-owned set) is declared.
        expect(writer.tools.searchable.name).toBe('searchable');
        expect(declaredNames(seen[0])).toEqual([
            'toolRequest',
            'task',
            // A configured core tool is a LATER registration, so it follows the
            // baseline in declaration order (later registration wins).
            'core'
        ]);
    });

    it('preloads the catalogue: four core file tools declared, the rest searchable', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = harness({ agents: { writer: brain(scripted([answer('hi')], seen)) } });

        await writer('go');

        // Registered from their editable source entries, so they can be used
        // without any import. Each harness gets a FRESH compiled definition rather
        // than the module-level lazy proxy identity.
        expect(writer.tools.read).not.toBe(read);
        expect(writer.tools.read.name).toBe('read');
        expect(typeof writer.tools.read.execute).toBe('function');
        expect(writer.tools.shell.name).toBe('shell');
        expect(writer.tools.syntax.name).toBe('syntax');
        // R18: everyday file access is core; the rest still waits for discovery.
        expect(writer.tools.read.visibility).toBe('core');
        expect(writer.tools.write.visibility).toBe('core');
        expect(writer.tools.edit.visibility).toBe('core');
        // Both halves of the split search are core: `glob` names files, `grep` reads them.
        expect(writer.tools.glob.visibility).toBe('core');
        expect(writer.tools.grep.visibility).toBe('core');
        expect(writer.tools.files.visibility).toBe('searchable');
        expect(writer.tools.shell.visibility).toBe('searchable');
        // ...so the first request declares exactly the core file tools plus the
        // harness-owned set.
        expect(declaredNames(seen[0])).toEqual([
            'toolRequest',
            'task',
            'read',
            'write',
            'edit',
            'glob',
            'grep',
            // R9-R11: `download` registers with the package presets but stays
            // searchable, so it is absent here and shows up in toolRequest below.
        ]);

        expect(writer.tools.download.visibility).toBe('searchable');
        expect(writer.tools.agentManage.visibility).toBe('searchable');
        expect(writer.tools.task.visibility).toBe('core');
    });

    it('never returns the core file tools from toolRequest', async () => {
        const entry = brain(
            scripted([
                callTool('c1', 'toolRequest', '{"tags":["files"]}'),
                callTool('c2', 'toolRequest', '{"tags":["javascript"]}'),
                answer('done')
            ])
        );
        const writer = harness({ agents: { writer: entry } });

        await writer('look around');

        // read/write/edit/glob/grep are core, so a "files" query only
        // finds the searchable remainder. There is no fileSearch: glob and grep are
        // the two search surfaces and both are already declared. `files` is the
        // searchable manager (list/move/copy/delete/mkdir), and `download` is
        // searchable under R9-R11, so the 'file' tag offers it here.
        const fileSearch = JSON.parse((entry.messages[2] as { content: string }).content);
        expect(fileSearch.enabled).toEqual(['files', 'download', 'profileManage']);
        expect(fileSearch.tools).toEqual([
            {
                name: 'files',
                description: expect.stringContaining('Manage files and folders'),
                tags: [
                    'files',
                    'list',
                    'filesystem',
                    'folder',
                    'directory',
                    'move',
                    'rename',
                    'copy',
                    'delete',
                    'remove',
                    'mkdir'
                ]
            },
            {
                name: 'download',
                description: expect.stringContaining('Download one file over http(s)'),
                tags: ['download', 'file', 'image', 'pdf', 'media', 'binary', 'web', 'url']
            },
            {
                name: 'profileManage',
                description: expect.stringContaining('Manage character and people profiles'),
                tags: ['profile', 'profiles', 'character', 'characters', 'person', 'people']
            }
        ]);
        expect(fileSearch.matched).toBe(3);
        expect(fileSearch.omitted).toBe(0);

        // "javascript" finds the searchable syntax AND the runtime rows that now
        // advertise the same capability tags (toolCreate/toolRegistry are searchable
        // after R9-R11). The core file tools are still never returned.
        const syntaxSearch = JSON.parse((entry.messages[4] as { content: string }).content);
        expect(syntaxSearch.enabled).toEqual(['syntax', 'toolCreate', 'toolRegistry']);
        expect(syntaxSearch.tools).toEqual([
            {
                name: 'syntax',
                description: expect.stringContaining('Check whether a code snippet PARSES'),
                tags: ['code', 'syntax', 'javascript', 'typescript', 'json', 'python', 'validation']
            },
            {
                name: 'toolCreate',
                description: expect.stringContaining('Create a tool for yourself from JavaScript source'),
                tags: ['tools', 'create', 'extension', 'dynamic']
            },
            {
                name: 'toolRegistry',
                description: expect.stringContaining('Compile and register a tool from editable source'),
                tags: ['tools', 'registry', 'source', 'self-modifying', 'compile']
            }
        ]);
        expect(syntaxSearch.matched).toBe(3);
        expect(syntaxSearch.omitted).toBe(0);

        expect(writer.tools.read.visibility).toBe('core');
        expect(writer.tools.syntax.visibility).toBe('searchable');
    });

    it('returns the whole tag union and ranks a second-tag hit first', async () => {
        // Selection must not depend on the preset catalogue: R18 made its file
        // family core, so these fixtures are plain searchable tools. Every one has
        // the exact tag "files"; only file-f carries "write" too.
        const fixtures = ['file-a', 'file-b', 'file-c', 'file-d', 'file-e', 'file-f'].map((name) =>
            tool({
                // The harness renames on registration; a unique name here keeps the
                // object keys distinct before that happens.
                name,
                description: `${name} fixture.`,
                tags: name === 'file-f' ? ['files', 'write'] : ['files'],
                execute: () => name
            })
        );

        const entry = brain(
            scripted([
                callTool('c1', 'toolRequest', '{"tags":["files"]}'),
                callTool('c2', 'toolRequest', '{"tags":["files","write"]}'),
                answer('done')
            ])
        );
        const writer = harness({
            agents: { writer: entry },
            tools: Object.fromEntries(fixtures.map((definition) => [definition.name, definition])),
            presets: false
        });

        await writer('change a file');

        // No five-result cap: one query enables all six (the default enabled bound
        // is 32), in name order because every fixture is an exact tag hit.
        const broad = JSON.parse((entry.messages[2] as { content: string }).content);
        expect(broad.enabled).toEqual([
            'file-a',
            'file-b',
            'file-c',
            'file-d',
            'file-e',
            'file-f',
            'profileManage'
        ]);
        expect(broad.matched).toBe(7);
        expect(broad.omitted).toBe(0);

        // Tag breadth remains a tiebreak: file-f has two matching query tags, so
        // it ranks first while the full union is still returned.
        const refined = JSON.parse((entry.messages[4] as { content: string }).content);
        expect(refined.enabled).toEqual([
            'file-f',
            'file-a',
            'file-b',
            'file-c',
            'file-d',
            'file-e',
            'profileManage',
            'toolManage'
        ]);
        expect(refined.matched).toBe(8);
        expect(refined.omitted).toBe(0);

        // The newest selection leads the current order; all eight still fit.
        expect(writer.discoveredTools).toEqual([
            'file-f',
            'file-a',
            'file-b',
            'file-c',
            'file-d',
            'file-e',
            'profileManage',
            'toolManage'
        ]);
    });

    it('starts from the configured tools only when presets are disabled', () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('hi')])) },
            presets: false
        });

        expect(writer.tools.read).toBeUndefined();
        expect(Object.keys(writer.tools)).toEqual([
            'toolRegistry',
            'toolRequest',
            'toolList',
            'toolManage',
            'toolCreate',
            'task',
            'profileManage',
            'chapterManage',
            'locationManage',
            'agentManage',
            'agentResult',
            'threadFork',
            'toolCancel'
        ]);
    });

    it('lets the model discover and run a preloaded preset', async () => {
        const seen: HarnessStreamRequest[] = [];
        const entry = brain(
            scripted(
                [
                    callTool('c1', 'toolRequest', '{"tags":["javascript"]}'),
                    callTool('c2', 'syntax', '{"code":"const a = 1;","language":"javascript"}'),
                    answer('valid')
                ],
                seen
            )
        );

        // No `tools` at all: the catalogue came from the preset preload.
        const writer = harness({ agents: { writer: entry } });
        const message = await writer('check this snippet');

        // "javascript" enables syntax plus the searchable runtime rows that
        // share its tags. The declared core set is unchanged ahead of them, and
        // `download` is searchable (R9-R11), so it does not ride on the request.
        expect(declaredNames(seen[1])).toEqual([
            'toolRequest',
            'task',
            'read',
            'write',
            'edit',
            'glob',
            'grep',
            'syntax',
            'toolCreate',
            'toolRegistry'
        ]);
        expect((entry.messages[4] as { content: string }).content).toBe('true');
        expect(message.content).toBe('valid');
    });

    it('enables the closest matches through toolRequest for the next turn', async () => {
        const seen: HarnessStreamRequest[] = [];
        const read = tool({
            description: 'Read a text file.',
            tags: ['files', 'read'],
            execute: () => 'file contents'
        });
        const shell = tool({
            description: 'Run a shell command.',
            tags: ['shell', 'command'],
            execute: () => 'output'
        });

        const entry = brain(
            scripted(
                [
                    callTool('c1', 'toolRequest', '{"tags":["files"]}'),
                    callTool('c2', 'read', '{"path":"a.txt"}'),
                    answer('read it')
                ],
                seen
            )
        );

        const writer = harness({ agents: { writer: entry }, tools: { read, shell }, presets: false });
        const message = await writer('read a.txt');

        // Round one: core only. Round two: the discovered tool joined the
        // declarations, and the unrelated tool stayed out.
        expect(declaredNames(seen[0])).toEqual([
            'toolRequest',
            'task',
        ]);
        expect(declaredNames(seen[1])).toEqual([
            'toolRequest',
            'task',
            'read',
            'profileManage'
        ]);

        // The discovery result is what the model sees: names plus metadata.
        // R9-R11 moved profileManage into the candidate set, so a "files" query
        // answers with the fixture and the demoted row in rank order.
        const discovery = JSON.parse((entry.messages[2] as { content: string }).content);
        expect(discovery.enabled).toEqual(['read', 'profileManage']);
        expect(discovery.tools).toEqual([
            { name: 'read', description: 'Read a text file.', tags: ['files', 'read'] },
            {
                name: 'profileManage',
                description: expect.stringContaining('Manage character and people profiles'),
                tags: ['profile', 'profiles', 'character', 'characters', 'person', 'people']
            }
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
        const search = tool({
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
            scripted([callTool('call_1', 'search', '{"q":"new year"}'), answer('New year is fireworks.')])
        );

        const writer = harness({ agents: { writer: entry }, tools: { search } });
        const message = await writer('tell me about new year');

        // Single-property schema: the implementation gets the value, not the
        // wrapper object. Same thing a direct `search('new year')` receives.
        expect(received).toEqual(['new year']);
        expect(message.content).toBe('New year is fireworks.');

        // The transcript shows the whole arc: user -> assistant(tool call) ->
        // tool result -> assistant(answer).
        expect(entry.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
        expect(entry.messages[2]).toEqual({
            role: 'tool',
            content: '{"hits":["fireworks","countdown"]}',
            toolCallId: 'call_1',
            name: 'search'
        });
    });

    it('reports every step through report.progress, in order', async () => {
        const events: HarnessEvent[] = [];

        const search = tool({
            description: 'Search.',
            tags: ['search'],
            visibility: 'core',
            execute: () => 'found'
        });
        const writer = harness({
            agents: { writer: brain(scripted([callTool('c1', 'search', '{}'), answer('done')])) },
            tools: { search },
            report: {
                progress: async (event) => {
                    events.push(event);
                }
            }
        });

        await writer('go');

        expect(events.map((event) => event.type)).toEqual([
            'start',
            'tool_call',
            // R3/F1: the tool-calling request's SUCCESS boundary. A tool round gets
            // no `done`, so this is the only frame that says its output is committed.
            'attempt_commit',
            'tool_result',
            'text',
            'done'
        ]);
        expect(events[0]).toEqual({ type: 'start', agent: 'writer', model: 'merge/ds4-flash' });
        expect(events[1]).toEqual({
            type: 'tool_call',
            agent: 'writer',
            call: { id: 'c1', name: 'search', arguments: '{}' }
        });
        expect(events[2]).toEqual({ type: 'attempt_commit', agent: 'writer', attempt: 1, maxAttempts: 11 });
        // The call id lets a UI pair a result with its exact call even when two
        // calls in one turn share a name. `durationMs` is now measured for every
        // executed call; it is wall clock, so assert its shape and pin the rest
        // exactly.
        expect(events[3]).toMatchObject({
            type: 'tool_result',
            agent: 'writer',
            name: 'search',
            callId: 'c1',
            content: 'found',
            isError: false
        });
        expect((events[3] as { durationMs?: unknown }).durationMs).toEqual(expect.any(Number));
        expect((events[3] as { durationMs?: number }).durationMs).toBeGreaterThanOrEqual(0);
        expect(events[4]).toMatchObject({ type: 'text', agent: 'writer', delta: 'done' });
        expect(events[5]).toMatchObject({ type: 'done', agent: 'writer' });
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

    // R20.2: a tool may return `toolUi(content, panels)`. The model must see the
    // plain content (never the envelope or panels), while the recorded event
    // carries the normalized panels on its optional `ui` field.
    it('unwraps toolUi panels into the event and feeds the model content only', async () => {
        const panels = [
            {
                id: 'answer',
                slot: 'right',
                title: 'Answer details',
                blocks: [
                    { type: 'keyValue' as const, items: [{ label: 'Value', value: '42' }] },
                    { type: 'text' as const, text: 'Generated by the UI tool.' }
                ]
            }
        ];

        const uiTool = tool({
            description: 'Returns a declarative panel.',
            tags: ['ui'],
            visibility: 'core',
            execute: () => toolUi({ answer: 42 }, panels)
        });
        const plainTool = tool({
            description: 'Returns a plain value.',
            tags: ['plain'],
            visibility: 'core',
            execute: () => ({ answer: 7 })
        });

        const events: HarnessEvent[] = [];
        const seen: HarnessStreamRequest[] = [];

        const writer = harness({
            agents: {
                writer: brain(
                    scripted(
                        [callTool('c1', 'uiTool', '{}'), callTool('c2', 'plainTool', '{}'), answer('done')],
                        seen
                    )
                )
            },
            tools: { uiTool, plainTool },
            report: { progress: async (event) => { events.push(event); } }
        });

        await writer('go');

        const results = events.filter((event) => event.type === 'tool_result');
        // `durationMs` is the authoritative span of each executed call; strip it
        // before the exact comparison and assert it separately as wall clock.
        expect(
            results.map((event) => {
                const { durationMs, ...rest } = event as { durationMs?: number };
                expect(durationMs).toEqual(expect.any(Number));
                expect(durationMs).toBeGreaterThanOrEqual(0);
                return rest;
            })
        ).toEqual([
            {
                type: 'tool_result',
                agent: 'writer',
                name: 'uiTool',
                callId: 'c1',
                content: '{"answer":42}',
                isError: false,
                outcome: 'completed',
                ui: panels
            },
            {
                type: 'tool_result',
                agent: 'writer',
                name: 'plainTool',
                callId: 'c2',
                content: '{"answer":7}',
                isError: false,
                outcome: 'completed'
            }
        ]);

        // The model's transcript holds the underlying content only.
        expect(writer.agent.messages.filter((message) => message.role === 'tool')).toEqual([
            { role: 'tool', content: '{"answer":42}', toolCallId: 'c1', name: 'uiTool' },
            { role: 'tool', content: '{"answer":7}', toolCallId: 'c2', name: 'plainTool' }
        ]);

        // Nothing about the envelope leaves the process: every request the model
        // transport saw is plain content.
        expect(JSON.stringify(seen)).not.toContain('__toolUi');
        expect(JSON.stringify(seen)).not.toContain('Answer details');
    });

    it('turns an unknown tool into a recoverable tool result', async () => {
        const entry = brain(scripted([callTool('c1', 'nope', '{}'), answer('recovered')]));
        const writer = harness({ agents: { writer: entry } });

        const message = await writer('go');

        expect(message.content).toBe('recovered');
        expect(entry.messages[2]).toMatchObject({
            role: 'tool',
            name: 'nope',
            // The preloaded core file tools and the harness-owned set are declared,
            // so the recovery hint lists exactly those and points at toolRequest
            // for the searchable remainder.
            content:
                'Tool "nope" is not registered. Available tools: toolRequest, task, read, write, edit, glob, grep. Call toolRequest with capability tags to search the catalogue.'
        });
    });

    it('turns malformed arguments into a recoverable tool result', async () => {
        let executed = false;
        const search = tool({
            description: 'Search.',
            tags: ['search'],
            visibility: 'core',
            execute: () => {
                executed = true;
                return 'found';
            }
        });

        const entry = brain(scripted([callTool('c1', 'search', '{"q":'), answer('recovered')]));
        const writer = harness({ agents: { writer: entry }, tools: { search } });

        await writer('go');

        expect(executed).toBe(false);
        expect(entry.messages[2].role).toBe('tool');
        expect((entry.messages[2] as { content: string }).content).toContain('malformed JSON arguments');
    });

    // A generation cut at its output-token ceiling stops in the middle of a tool
    // call's arguments, so the harness receives a truncated string. Executing it
    // is impossible, and replaying it is what used to poison the whole thread.
    const callToolStopped = (
        id: string,
        name: string,
        args: string,
        stopReason: 'length' | 'tool_calls'
    ): HarnessStreamEvent[] => [
        { type: 'done', stopReason, toolCalls: [{ id, name, arguments: args }] }
    ];

    it('names the output-token limit when a length-stopped call is truncated', async () => {
        let executed = false;
        const search = tool({
            description: 'Search.',
            tags: ['search'],
            visibility: 'core',
            execute: () => {
                executed = true;
                return 'found';
            }
        });

        const entry = brain(
            scripted([
                callToolStopped('c1', 'search', '{"q":"once upon', 'length'),
                answer('recovered')
            ])
        );
        const writer = harness({ agents: { writer: entry }, tools: { search } });

        const message = await writer('go');

        expect(message.content).toBe('recovered');
        expect(executed).toBe(false);

        const content = (entry.messages[2] as { content: string }).content;
        expect(content).toContain('malformed JSON arguments');
        // The actionable half: the model cannot fix what it does not know was cut.
        expect(content).toContain('output-token limit');
    });

    it('does not blame the token limit when the model simply wrote bad JSON', async () => {
        const search = tool({
            description: 'Search.',
            tags: ['search'],
            visibility: 'core',
            execute: () => 'found'
        });

        const entry = brain(scripted([callTool('c1', 'search', '{"q":', 'length'), answer('ok')]));
        const writer = harness({ agents: { writer: entry }, tools: { search } });

        await writer('go');

        const content = (entry.messages[2] as { content: string }).content;
        expect(content).toContain('malformed JSON arguments');
        expect(content).not.toContain('output-token limit');
    });

    it('rejects a well-formed call whose arguments are not an object', async () => {
        let executed = false;
        const search = tool({
            description: 'Search.',
            tags: ['search'],
            visibility: 'core',
            execute: () => {
                executed = true;
                return 'found';
            }
        });

        // Valid JSON every one of these, and none of them a parameter object.
        for (const args of ['[1,2]', '42', '"a query"', 'null', 'true']) {
            executed = false;
            const entry = brain(scripted([callTool('c1', 'search', args), answer('ok')]));
            const writer = harness({ agents: { writer: entry }, tools: { search } });

            await writer('go');

            expect(executed).toBe(false);
            expect((entry.messages[2] as { content: string }).content).toContain(
                'must be a JSON object'
            );
        }
    });

    it('still runs a call whose arguments are an empty object or blank', async () => {
        const search = tool({
            description: 'Search.',
            tags: ['search'],
            visibility: 'core',
            execute: () => 'found'
        });

        for (const args of ['{}', '']) {
            const entry = brain(scripted([callTool('c1', 'search', args), answer('ok')]));
            const writer = harness({ agents: { writer: entry }, tools: { search } });

            await writer('go');

            expect((entry.messages[2] as { content: string }).content).toBe('found');
        }
    });

    it('turns a throwing tool into a recoverable tool result', async () => {
        const search = tool({
            description: 'Search.',
            tags: ['search'],
            visibility: 'core',
            execute: () => {
                throw new Error('rate limited');
            }
        });

        const entry = brain(scripted([callTool('c1', 'search', '{}'), answer('recovered')]));
        const writer = harness({ agents: { writer: entry }, tools: { search } });

        const message = await writer('go');

        expect(message.content).toBe('recovered');
        expect((entry.messages[2] as { content: string }).content).toBe('Tool "search" failed: rate limited');
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

        // R1: this pins the terminal FAILURE path, so it runs one attempt only; the
        // retry sequence is covered by the dedicated retry suite.
        const failing = scripted([[{ type: 'error', message: 'upstream exploded' }]]);
        const writer = harness({
            agents: { writer: brain(failing, { retry: false }) },
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
        // Always asks for another tool, never answers. Ids are unique per turn:
        // reusing a committed call id is rejected as aliasing (P2-B).
        let sequence = 0;
        const loop: HarnessStream = async function* () {
            yield {
                type: 'done' as const,
                stopReason: 'tool_calls' as const,
                toolCalls: [{ id: `c${sequence++}`, name: 'again', arguments: '{}' }]
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
        // Always asks for another tool, never answers; unique ids per turn.
        let sequence = 0;
        const loop: HarnessStream = async function* () {
            yield {
                type: 'done' as const,
                stopReason: 'tool_calls' as const,
                toolCalls: [{ id: `c${sequence++}`, name: 'again', arguments: '{}' }]
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
        const search = tool({ description: 'Search.', tags: ['search'], execute: () => 'ok' });
        const writer = harness({
            agents: { writer: brain(scripted([answer('hi')]), { instruction: 'You are a writer.' }) },
            tools: { search }
        });

        await writer('one');
        expect(writer.agent.messages).toHaveLength(3);

        writer.reset();

        expect(writer.agent.messages).toEqual([{ role: 'system', content: 'You are a writer.' }]);
        expect(writer.tools.search.name).toBe('search');
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
        expect(declaredNames(seen[1])).toEqual([
            'toolRequest',
            'task',
            'hidden',
            'profileManage'
        ]);
        expect(writer.discoveredTools).toEqual(['hidden', 'profileManage']);

        writer.reset();
        expect(writer.discoveredTools).toEqual([]);

        await writer('go again');

        // Back to the core set: discovery is part of "start over".
        expect(declaredNames(seen[2])).toEqual([
            'toolRequest',
            'task',
        ]);
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
        expect(declaredNames(seen[1])).toEqual([
            'toolRequest',
            'task',
            'reader',
            'threadFork',
            'agentManage',
            'agentResult'
        ]);
        expect(writer.discoveredTools).toEqual([
            'reader',
            'threadFork',
            'agentManage',
            'agentResult'
        ]);

        // A second call starts a NEW turn but not a new catalogue: toolRequest
        // enabled the matches (the fixture plus the demoted runtime rows that
        // carry the tag), so the next request still declares them without
        // another discovery round.
        await writer('second');
        expect(declaredNames(seen[3])).toEqual([
            'toolRequest',
            'task',
            'reader',
            'threadFork',
            'agentManage',
            'agentResult'
        ]);
        expect(writer.discoveredTools).toEqual([
            'reader',
            'threadFork',
            'agentManage',
            'agentResult'
        ]);
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

    it('lets a configured tool replace the toolRequest name (no reserved names)', async () => {
        const custom = tool({ description: 'Mine.', tags: ['discovery'], execute: () => 'ok' });

        const writer = harness({
            agents: { writer: brain(scripted([answer('hi')])) },
            tools: { toolRequest: custom }
        });

        // Later registration wins; the replacement is a real registry entry, not a
        // shadowed name the runtime still dispatches around.
        expect(writer.tools.toolRequest).not.toBe(custom);
        expect(writer.tools.toolRequest.description).toBe('Mine.');
        await expect(writer.executeTool('toolRequest', { tags: [] })).resolves.toBe('ok');
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

        // R2/R3/R4: the auto-discovered built-ins are applied FIRST, so `plugins`
        // reports them as well — a host plugin list is additive, never the whole set.
        expect(writer.plugins).toEqual(['async-ping', 'context-compaction', 'extras']);
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

    it('lets a plugin replace an earlier registration instead of rejecting it', async () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('hi')])) },
            plugins: [
                {
                    name: 'extras',
                    setup: (api) => {
                        api.addTool('now', { description: 'First.', tags: ['time'], execute: () => 'first' });
                        api.addTool('now', { description: 'Second.', tags: ['time'], execute: () => 'second' });
                    }
                }
            ]
        });

        expect(writer.tools.now.description).toBe('Second.');
        await expect(writer.executeTool('now', {})).resolves.toBe('second');
    });

    it('exposes the harness name on the callable itself', () => {
        const writer = harness({ agents: { writer: brain(scripted([answer('hi')])) } });

        // A function's `name` is read-only, so this also proves the define
        // in harness() actually took effect.
        expect(writer.name).toBe('writer');
        expect(typeof writer).toBe('function');
    });
});

// Per-request token accounting (`usage` events).
//
// `done` only ever reports the FINAL request of a run, so a client that wants the
// whole cost reads the `usage` events: exactly one per model request whose
// message carries usage — including the intermediate tool-call rounds — emitted
// after that request's text and before its tool_calls/done. A request whose
// transport reported no usage emits nothing at all: "not reported" must never be
// turned into a zero-filled event. The source of truth is the `usage` block on
// the `done` stream frame (see core/agent.ts, `request()`), fanned out by
// harness.ts inside runAgentCore.
describe('usage reporting', () => {
    it('reports one usage event for a single answered request, before done', async () => {
        const events: HarnessEvent[] = [];
        const usage = { input: 3, output: 2, total: 5 };

        const writer = harness({
            agents: { writer: brain(scripted([answer('done', usage)])) },
            report: { progress: (event) => { events.push(event); } }
        });

        await writer('go');

        // Exactly one usage event, positioned after the answer text and before done.
        expect(events.map((event) => event.type)).toEqual(['start', 'text', 'usage', 'done']);
        expect(events[2]).toEqual({ type: 'usage', agent: 'writer', usage });

        // The final `done` still carries the same usage on its message, so the
        // last request appears on BOTH events; a tallying consumer counts only
        // the usage events.
        const done = events.at(-1) as Extract<HarnessEvent, { type: 'done' }>;
        expect(done.message.usage).toEqual({ input: 3, output: 2, total: 5 });
        expect(events.filter((event) => event.type === 'usage')).toEqual([
            { type: 'usage', agent: 'writer', usage }
        ]);
    });

    it('reports usage for every tool-call round as well as the final answer', async () => {
        const events: HarnessEvent[] = [];
        const first = { input: 11, output: 6, total: 17 };
        const second = { input: 21, output: 4, total: 25 };

        const probe = tool({
            description: 'Probe.',
            tags: ['probe'],
            visibility: 'core',
            execute: () => 'pong'
        });
        const writer = harness({
            agents: {
                writer: brain(
                    scripted([callTool('c1', 'probe', '{}', first), answer('finished', second)])
                )
            },
            tools: { probe },
            presets: false,
            report: { progress: (event) => { events.push(event); } }
        });

        await writer('go');

        // Round 1: usage BEFORE that round's tool_call/tool_result, then the round's
        // success boundary (R3/F1: a tool round has no `done`). Round 2: usage after
        // the text, before done. No usage is reported twice.
        expect(events.map((event) => event.type)).toEqual([
            'start',
            'usage',
            'tool_call',
            'attempt_commit',
            'tool_result',
            'text',
            'usage',
            'done'
        ]);
        expect(events.filter((event) => event.type === 'usage')).toEqual([
            { type: 'usage', agent: 'writer', usage: first },
            { type: 'usage', agent: 'writer', usage: second }
        ]);

        // `done` describes only the FINAL request, with that request's usage.
        const done = events.at(-1) as Extract<HarnessEvent, { type: 'done' }>;
        expect(done.message.usage).toEqual({ input: 21, output: 4, total: 25 });
    });

    it('emits no usage event when a request reports none', async () => {
        const events: HarnessEvent[] = [];
        const writer = harness({
            agents: { writer: brain(scripted([answer('done')])) },
            report: { progress: (event) => { events.push(event); } }
        });

        await writer('go');

        expect(events.map((event) => event.type)).toEqual(['start', 'text', 'done']);
        expect(events.filter((event) => event.type === 'usage')).toEqual([]);

        // The message also stays honest: an unreported request is not zero-filled.
        const done = events.at(-1) as Extract<HarnessEvent, { type: 'done' }>;
        expect(done.message.usage).toBeUndefined();
    });

    it('reports only the requests that carry usage, leaving the rest absent', async () => {
        const events: HarnessEvent[] = [];
        const first = { input: 7, output: 1, total: 8 };

        const probe = tool({
            description: 'Probe.',
            tags: ['probe'],
            visibility: 'core',
            execute: () => 'pong'
        });
        const writer = harness({
            agents: { writer: brain(scripted([callTool('c1', 'probe', '{}', first), answer('finished')])) },
            tools: { probe },
            presets: false,
            report: { progress: (event) => { events.push(event); } }
        });

        await writer('go');

        // The tool round reported usage; the final answer did not. No zero-filled
        // event is invented for the silent request. The round's success boundary
        // (R3/F1) still appears: a tool round has no `done`.
        expect(events.map((event) => event.type)).toEqual([
            'start',
            'usage',
            'tool_call',
            'attempt_commit',
            'tool_result',
            'text',
            'done'
        ]);
        expect(events.filter((event) => event.type === 'usage')).toEqual([
            { type: 'usage', agent: 'writer', usage: first }
        ]);

        const done = events.at(-1) as Extract<HarnessEvent, { type: 'done' }>;
        expect(done.message.usage).toBeUndefined();
    });

    it('passes the cached figure through untouched', async () => {
        const events: HarnessEvent[] = [];
        const usage = { input: 10, output: 4, total: 14, cached: 8 };

        const writer = harness({
            agents: { writer: brain(scripted([answer('done', usage)])) },
            report: { progress: (event) => { events.push(event); } }
        });

        await writer('go');

        // Exact object: the optional `cached` figure is neither stripped nor
        // supplemented, and no keys are added.
        expect(events.map((event) => event.type)).toEqual(['start', 'text', 'usage', 'done']);
        expect(events[2]).toEqual({
            type: 'usage',
            agent: 'writer',
            usage: { input: 10, output: 4, total: 14, cached: 8 }
        });
        expect(Object.keys((events[2] as Extract<HarnessEvent, { type: 'usage' }>).usage)).toEqual([
            'input',
            'output',
            'total',
            'cached'
        ]);
    });

    it('reports a delegated subagent usage with its own agent name, interleaved', async () => {
        const events: HarnessEvent[] = [];
        const leadFirst = { input: 5, output: 2, total: 7 };
        const helperUsage = { input: 9, output: 3, total: 12 };
        const leadAnswer = { input: 13, output: 5, total: 18 };

        const writer = harness({
            agents: {
                // The primary delegates, then answers; each of its requests carries usage.
                lead: brain(
                    scripted([
                        callTool('c1', 'delegate', '{"agent":"helper","input":"find it"}', leadFirst),
                        answer('lead done', leadAnswer)
                    ])
                ),
                // The subagent's single request carries its own usage.
                helper: brain(scripted([answer('helper answer', helperUsage)]))
            },
            primary: 'lead',
            subagents: ['helper'],
            presets: false,
            report: { progress: (event) => { events.push(event); } }
        });

        await writer('go');

        // The subagent's whole run (start/text/usage/done) happens INSIDE the
        // primary's tool_call, so its usage lands in the same stream, tagged
        // with the subagent name, before the primary's tool_result. The primary's
        // own tool-calling request closes with `attempt_commit` (R3/F1: it gets no
        // `done`), which lands right after the request's own frames — i.e. once the
        // call is launched, before the delegated child's remaining output.
        expect(events.map((event) => `${event.agent}:${event.type}`)).toEqual([
            'lead:start',
            'lead:usage',
            'lead:tool_call',
            'helper:start',
            'lead:attempt_commit',
            'helper:text',
            'helper:usage',
            'helper:done',
            'lead:tool_result',
            'lead:text',
            'lead:usage',
            'lead:done'
        ]);
        expect(events.filter((event) => event.type === 'usage')).toEqual([
            { type: 'usage', agent: 'lead', usage: leadFirst },
            {
                type: 'usage',
                agent: 'helper',
                usage: helperUsage,
                // T3 thread identity: the helper is a direct child of the root run,
                // so it carries its invocation id and the spawning call, but no
                // parentId and no `input` (that travels on `start` only).
                thread: { id: '2', callId: 'c1' }
            },
            { type: 'usage', agent: 'lead', usage: leadAnswer }
        ]);

        // The child's start frame is the one event that also carries the prompt, so
        // a UI can title the row; every later frame keeps just the identity.
        expect(events.find((event) => event.type === 'start' && event.agent === 'helper')).toEqual({
            type: 'start',
            agent: 'helper',
            model: 'merge/ds4-flash',
            thread: { id: '2', callId: 'c1', input: 'find it' }
        });
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
        const writer = harness({
            agents: { writer: brain(scripted([answer('hi')], seen)) },
            tools: { hidden },
            // Keep this test about the searchable-tool bypass: the preload's core
            // file declarations are asserted separately above.
            presets: false
        });

        expect(writer.discoveredTools).toEqual([]);
        // The parameter IS the value `execute` receives (single-property rule).
        expect(await writer.executeTool('hidden', 'a.txt')).toBe('contents');

        // Nothing was enabled and the model still sees only the core declarations.
        expect(writer.discoveredTools).toEqual([]);
        await writer('go');
        expect(declaredNames(seen[0])).toEqual([
            'toolRequest',
            'task',
        ]);
    });

    it('runs a core tool against this harness and rejects an unregistered name', async () => {
        const writer = harness({ agents: { writer: brain(scripted([answer('hi')])) } });

        // A core tool is NOT searchable, so it is never enabled by discovery. It IS
        // reported in `alreadyAvailable` (tag "todo" is an exact tag on task),
        // and that report means the tag must not also appear in `unmatchedTags`.
        const result = await writer.executeTool('toolRequest', { tags: ['todo'] });

        expect(result).toMatchObject({
            enabled: [],
            tools: [],
            matched: 0,
            omitted: 0,
            alreadyAvailable: [
                {
                    name: 'task',
                    tags: ['task', 'tasks', 'todo', 'todos', 'checklist', 'plan']
                }
            ]
        });
        expect((result as { unmatchedTags?: string[] }).unmatchedTags).toBeUndefined();
        expect(writer.discoveredTools).toEqual([]);

        await expect(writer.executeTool('nope', {})).rejects.toThrow(
            'Tool "nope" is not registered in this harness.'
        );

        // No subagents means no delegate tool at all — never a fabricated one.
        await expect(writer.executeTool('delegate', { agent: 'helper', input: 'go' })).rejects.toThrow(
            'Tool "delegate" is not registered in this harness.'
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

        // Registered searchable and enabled at once, exactly like the model path.
        expect(writer.discoveredTools).toEqual(['upper']);
        expect(writer.tools.upper.visibility).toBe('searchable');

        // An intentional second manual attempt REPLACES the definition: the same
        // kernel publishes the new metadata/source atomically.
        await expect(
            writer.executeTool('toolCreate', {
                name: 'upper',
                description: 'Again.',
                tags: ['text'],
                source: 'return 1;'
            })
        ).resolves.toEqual({
            name: 'upper',
            description: 'Again.',
            tags: ['text'],
            enabled: true
        });
        expect(writer.tools.upper.description).toBe('Again.');
        await expect(writer.executeTool('upper', {})).resolves.toBe(1);
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
        expect(await writer.executeTool('delegate', { agent: 'helper', input: 'find it' })).toEqual({
            agent: 'helper',
            content: 'helper answer'
        });
        expect(writer.agent.messages).toEqual([]);
        expect(writer.agents.helper.messages.map((message) => message.role)).toEqual(['user', 'assistant']);

        // The allowlist is still enforced on the manual path (R11: the schema enum
        // is checked before the implementation's own guard, so the message names
        // the allowed value).
        await expect(writer.executeTool('delegate', { agent: 'lead', input: 'go' })).rejects.toThrow(
            '$.agent must be one of: "helper".'
        );
    });
});

// Identity color (R2) through the harness registry.
//
// `harness.addAgent(name, configuration)` builds the brain from a FULL
// `AgentConfiguration` (src/harness.ts:8315 spreads it), which is exactly how the
// server binds an agent into an already-running session
// (./server/sessions.ts `addSessionAgent` -> `agentConfigurationFromProfile`). So a
// color configured for a member must arrive on that member's Agent by the same path
// the construction loop uses, and a malformed color must fail BEFORE the roster moves.
describe('harness agent identity colors', () => {
    it('carries the configured color through the construction loop and through addAgent', () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('first')]), { color: '#4ade80' }) },
            presets: false
        });

        expect(writer.agents.writer.color).toBe('#4ade80');

        // Registered after construction: the registry key names the agent, and the
        // configuration's color still travels with it.
        const late = writer.addAgent('late', {
            model: 'merge/ds4-flash',
            stream: scripted([answer('late answer')]),
            color: ' #F97316 '
        });

        expect(late.name).toBe('late');
        expect(late.color).toBe('#F97316');
        expect(writer.agents.late.color).toBe('#F97316');
        // The member that was configured without a color still carries no key, so a host
        // can tell "uncolored" from "colored" for every roster entry.
        expect(Object.hasOwn(writer.agents.writer, 'color')).toBe(true);

        const uncolored = harness({
            agents: { plain: brain(scripted([answer('plain')])) },
            presets: false
        });
        expect(Object.hasOwn(uncolored.agents.plain, 'color')).toBe(false);
    });

    it('refuses an invalid color and leaves the roster untouched', () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('first')])) },
            presets: false
        });

        // The construction-time validation runs inside `addAgent`, so a bad swatch is a
        // hard failure rather than an agent a later run would have to tolerate...
        expect(() =>
            writer.addAgent('late', {
                model: 'merge/ds4-flash',
                stream: scripted([answer('late answer')]),
                color: 'tomato'
            })
        ).toThrow('Agent "late" has an invalid `color`: "tomato".');

        // ...and it happens before the roster is written, so the harness keeps exactly the
        // agents it had (`assertRosterIdle` + construction-first ordering).
        expect(Object.keys(writer.agents)).toEqual(['writer']);
    });
});

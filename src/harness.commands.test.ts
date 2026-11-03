// The harness command registry — registration order, collisions, and the built-ins.
//
// What this file pins (all of it harness-level; the grammar itself is unit-tested
// in src/core/command.test.ts):
//   - a harness starts with the five built-ins (/help, /tools, /task, /websearch,
//     /webfetch) even when `plugins` is absent;
//   - `/task` mutates THIS harness's task store (the model path and snapshot()
//     both see it), and add/complete/reopen/remove map onto the tool's real
//     parameter schema;
//   - `/websearch` and `/webfetch` are pass-throughs to `search`/`fetch`, and when
//     the tool is absent they answer a helpful error result instead of throwing;
//   - `commands` entries register after the built-ins and a collision (with a
//     built-in or inside the list) fails CONSTRUCTION;
//   - a plugin's `addCommand` runs last and REPLACES by name;
//   - `registerCommand` replaces at runtime, `commands` is a frozen copy, and
//     `executeCommand` never calls the model and never emits a progress event
//     (the underlying tool call still fires stateChange('tool_execute')).
//
// Expectations come from the documented contract, not from whatever the
// implementation printed: a usage mistake is `{ content, isError: true }`, a host
// bug (not a command / unknown name) is a HarnessError.
//
// Cross-references:
//   - ./core/command.ts             — parseCommandLine/formatCommandHelp (unit)
//   - ./core/command-builtins.ts    — the built-in implementations
//   - ./harness.task.test.ts        — the same scripted-agent conventions

import { describe, expect, it } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type {
    Agent,
    HarnessCommand,
    HarnessCommandConfiguration,
    HarnessEvent,
    HarnessStateChangeEvent,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest,
    HarnessSnapshot,
    Tool
} from '@underload/harness';

// A stream that answers immediately and RECORDS every model request, so the
// "a command never spends a model turn" assertions have something to count.
const scripted = (seen: HarnessStreamRequest[]): HarnessStream => {
    let index = 0;

    return async function* stream(
        request: HarnessStreamRequest
    ): AsyncIterable<HarnessStreamEvent> {
        seen.push(request);
        index++;
        yield { type: 'text', delta: `answer ${index}` };
        yield { type: 'done', stopReason: 'stop', toolCalls: [] };
    };
};

const brain = (seen: HarnessStreamRequest[]): Agent =>
    agent({ model: 'merge/ds4-flash', stream: scripted(seen) });

// Presets OFF: the registry is exactly the core set plus whatever a test adds, so
// `/tools` and the web pass-throughs are predictable.
const quiet = (
    entry: Agent,
    tools: Record<string, Tool> = {},
    commands?: readonly HarnessCommandConfiguration[]
) =>
    harness({
        agents: { writer: entry },
        tools,
        presets: false,
        ...(commands === undefined ? {} : { commands })
    });

// The five built-ins, in the order the registry sorts them for an assertion.
const BUILT_INS = ['help', 'task', 'tools', 'webfetch', 'websearch'];

// The task page the `task` tool always returns (src/core/task.ts): one shape for
// a read, an add, a patch and a removal alike.
const taskPage = (tasks: unknown[], total: number, completed: number, pending: number) => ({
    tasks,
    counts: { total, completed, pending },
    page: { offset: 0, limit: 20, hasMore: false }
});

const taskUsage =
    'usage: /task [list | add <text> | complete <id> | reopen <id> | remove <id>...]';

describe('command registry', () => {
    it('registers the five built-ins on a harness with no commands and no plugins', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = quiet(brain(seen));

        expect(Object.keys(writer.commands).sort()).toEqual(BUILT_INS);
        expect(writer.commands.task).toMatchObject({
            name: 'task',
            usage: '/task [list | add <text> | complete <id> | reopen <id> | remove <id>...]'
        });
        // Every built-in carries the description /help renders.
        for (const name of BUILT_INS) {
            expect((writer.commands[name] as HarnessCommand).description.length).toBeGreaterThan(0);
        }
        expect(seen).toHaveLength(0);
    });

    it('exposes commands as a frozen copy that cannot mutate the registry', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = quiet(brain(seen));
        const before = writer.commands;

        expect(Object.isFrozen(before)).toBe(true);
        expect(() => {
            (before as Record<string, unknown>).injected = 1;
        }).toThrow(TypeError);
        expect(Object.keys(writer.commands).sort()).toEqual(BUILT_INS);

        // A replacement at runtime is visible in the NEXT read, and the read taken
        // before it stays untouched (it is a copy, not a live view).
        writer.registerCommand({ name: 'later', description: 'L.', execute: () => ({ content: 'l' }) });
        expect(Object.keys(writer.commands).sort()).toEqual([...BUILT_INS, 'later'].sort());
        expect('later' in before).toBe(false);
    });

    it('throws for a line that is not a command and for an unknown name', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = quiet(brain(seen));

        await expect(writer.executeCommand('hello')).rejects.toThrow('a command must start with "/"');
        await expect(writer.executeCommand('/nope')).rejects.toThrow('unknown command: /nope');
        // A bare "/" is command-shaped, so the honest answer names the empty name.
        await expect(writer.executeCommand('/')).rejects.toThrow('unknown command: /');
        expect(seen).toHaveLength(0);
    });

    it('registers configuration commands, and fails construction on any collision', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = harness({
            agents: { writer: brain(seen) },
            presets: false,
            commands: [
                {
                    // A name with a leading slash and upper case is canonicalized,
                    // exactly like the parser canonicalizes a typed line.
                    name: '/Echo',
                    description: ' Echo the arguments back. ',
                    usage: ' /echo <text> ',
                    execute: (context) => ({
                        content: JSON.stringify({
                            name: context.name,
                            args: context.args,
                            rest: context.rest,
                            input: context.input,
                            harnessName: context.harness.name,
                            commandCount: Object.keys(context.harness.commands).length
                        })
                    })
                }
            ]
        });

        expect(writer.commands.echo.description).toBe('Echo the arguments back.');
        expect(writer.commands.echo.usage).toBe('/echo <text>');

        // The context is what the shared parser produced: lowercased name, quoted
        // argument unquoted, raw tail, and the ORIGINAL line for echoing.
        expect((await writer.executeCommand('/ECHO say "hi there"  ')).content).toBe(
            JSON.stringify({
                name: 'echo',
                args: ['say', 'hi there'],
                rest: 'say "hi there"',
                input: '/ECHO say "hi there"  ',
                harnessName: 'writer',
                commandCount: 6
            })
        );

        // Colliding with a built-in, and repeating a name inside the list, are both
        // construction errors (fail fast, before any command runs).
        expect(() =>
            quiet(brain([]), {}, [
                { name: 'task', description: 'Mine.', execute: () => ({ content: 'x' }) }
            ])
        ).toThrow(
            'Command "/task" is already registered. Built-in commands and "commands" entries share one namespace and must be unique; use a plugin or harness.registerCommand() to override "/task".'
        );
        expect(() =>
            quiet(brain([]), {}, [
                { name: 'alpha', description: 'A.', execute: () => ({ content: 'a' }) },
                { name: 'ALPHA', description: 'B.', execute: () => ({ content: 'b' }) }
            ])
        ).toThrow('Command "/alpha" is already registered.');
        expect(seen).toHaveLength(0);
    });

    it('rejects an invalid name or a malformed definition at construction', () => {
        const attempt = (commands: unknown[], message: string) =>
            expect(() =>
                harness({
                    agents: { writer: brain([]) },
                    presets: false,
                    commands: commands as never
                })
            ).toThrow(message);

        attempt(
            [{ name: 'Bad Name!', description: 'A.', execute: () => ({ content: 'a' }) }],
            'Command name "Bad Name!" is not valid: use 1-32 characters starting with a lowercase letter, and only lowercase letters, digits, or "-".'
        );
        attempt(
            [{ description: 'Nameless.', execute: () => ({ content: 'a' }) }],
            'A command registered by the "commands" configuration requires a name'
        );
        attempt(
            [{ name: 'alpha', description: 'A.' }],
            'Command "/alpha" requires an execute function.'
        );
        attempt(
            [{ name: 'alpha', execute: () => ({ content: 'a' }) }],
            'Command "/alpha" requires a description.'
        );
        attempt(
            [
                {
                    name: 'alpha',
                    description: 'A.',
                    usage: 7,
                    execute: () => ({ content: 'a' })
                }
            ],
            'Command "/alpha" usage must be a string.'
        );
    });

    it('lets a plugin add a command and OVERRIDE a built-in by name', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = harness({
            agents: { writer: brain(seen) },
            presets: false,
            plugins: [
                {
                    name: 'extra',
                    setup: (api) => {
                        api.addCommand('/plugin', {
                            description: 'From a plugin.',
                            execute: () => ({ content: 'plugin', data: { ok: true } })
                        });
                        // Plugins apply after the built-ins, so this is the
                        // supported way to replace one.
                        api.addCommand('help', {
                            description: 'Replaced help.',
                            execute: () => ({ content: 'replaced help' })
                        });
                    }
                }
            ]
        });

        expect(writer.commands.plugin.description).toBe('From a plugin.');
        expect(writer.commands.help.description).toBe('Replaced help.');
        expect(await writer.executeCommand('/plugin')).toEqual({
            content: 'plugin',
            data: { ok: true }
        });
        expect(await writer.executeCommand('/help')).toEqual({ content: 'replaced help' });
        expect(seen).toHaveLength(0);
    });

    it('replaces a command at runtime through registerCommand', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = quiet(brain(seen));

        const first = writer.registerCommand({
            name: 'Greet',
            description: 'First.',
            execute: () => ({ content: 'first' })
        });

        expect(first.name).toBe('greet');
        expect(writer.commands.greet.description).toBe('First.');
        expect((await writer.executeCommand('/greet')).content).toBe('first');

        // Replace-by-name (mirrors registerTool): no error, one entry.
        writer.registerCommand({ name: '/GREET', description: 'Second.', execute: () => ({ content: 'second' }) });

        expect(Object.keys(writer.commands).filter((name) => name === 'greet')).toEqual(['greet']);
        expect(writer.commands.greet.description).toBe('Second.');
        expect((await writer.executeCommand('/greet')).content).toBe('second');

        // Validation still applies at runtime, and a rejected candidate leaves the
        // registry untouched.
        expect(() => writer.registerCommand({ name: '9bad', description: 'X', execute: () => ({ content: 'x' }) })).toThrow(
            'Command name "9bad" is not valid'
        );
        expect((await writer.executeCommand('/greet')).content).toBe('second');
        expect(seen).toHaveLength(0);
    });

    it('normalizes a command result and lets a thrown error propagate', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = quiet(brain(seen));

        writer.registerCommand({ name: 'void', description: 'Nothing.', execute: () => undefined as never });
        writer.registerCommand({
            name: 'weird',
            description: 'Non-string content.',
            execute: () => ({ content: 42 as never, isError: false })
        });
        writer.registerCommand({
            name: 'boom',
            description: 'Throws.',
            execute: () => {
                throw new Error('command boom');
            }
        });

        // `content` is always a string for the host; the optional keys ride along
        // only when the command set them.
        expect(await writer.executeCommand('/void')).toEqual({ content: '' });
        expect(await writer.executeCommand('/weird')).toEqual({ content: '', isError: false });
        await expect(writer.executeCommand('/boom')).rejects.toThrow('command boom');
        expect(seen).toHaveLength(0);
    });

    it('spends no model request and no progress event, but still notifies persistence', async () => {
        const seen: HarnessStreamRequest[] = [];
        const progress: HarnessEvent[] = [];
        const changes: HarnessStateChangeEvent[] = [];

        const writer = harness({
            agents: { writer: brain(seen) },
            presets: false,
            report: {
                progress: (event) => {
                    progress.push(event);
                },
                stateChange: (event) => {
                    changes.push(event);
                }
            }
        });

        await writer.executeCommand('/help');
        await writer.executeCommand('/tools task');
        await writer.executeCommand('/task add "testing"');
        await writer.executeCommand('/task complete 1');

        // No model turn, and no conversation progress events.
        expect(seen).toHaveLength(0);
        expect(progress).toEqual([]);
        // The two calls that ran the `task` tool DID fire the ordinary tool
        // state-change, which is what a server uses to schedule a save.
        expect(changes).toEqual([
            { type: 'state_change', reason: 'tool_execute', tool: 'task' },
            { type: 'state_change', reason: 'tool_execute', tool: 'task' }
        ]);

        // Proof the counter above is meaningful: a real run does hit the stream.
        await writer('now talk to the model');
        expect(seen).toHaveLength(1);
    });
});

describe('/task', () => {
    it('adds, lists, completes, reopens, and removes through the live task store', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = quiet(brain(seen));

        expect(await writer.executeCommand('/task')).toEqual({
            content: 'No tasks.\n0 total, 0 completed, 0 pending\npage: offset 0, limit 20, showing 0',
            data: taskPage([], 0, 0, 0)
        });

        // `/task add "testing"` — the quoted phrase is ONE task text.
        expect(await writer.executeCommand('/task add "testing"')).toEqual({
            content: '#1 [ ] testing\n1 total, 0 completed, 1 pending\npage: offset 0, limit 20, showing 1',
            data: taskPage([{ id: '1', text: 'testing', completed: false }], 1, 0, 1)
        });

        // A later add joins the remaining tokens, and `/task` re-reads the list.
        expect((await writer.executeCommand('/task add fix  the build')).content).toBe(
            '#1 [ ] testing\n#2 [ ] fix the build\n2 total, 0 completed, 2 pending\npage: offset 0, limit 20, showing 2'
        );
        expect((await writer.executeCommand('/task list')).content).toBe(
            '#1 [ ] testing\n#2 [ ] fix the build\n2 total, 0 completed, 2 pending\npage: offset 0, limit 20, showing 2'
        );
        expect((await writer.executeCommand('/task complete 1')).content).toBe(
            '#1 [x] testing\n#2 [ ] fix the build\n2 total, 1 completed, 1 pending\npage: offset 0, limit 20, showing 2'
        );
        expect((await writer.executeCommand('/task reopen 1')).content).toBe(
            '#1 [ ] testing\n#2 [ ] fix the build\n2 total, 0 completed, 2 pending\npage: offset 0, limit 20, showing 2'
        );
        expect((await writer.executeCommand('/task remove 2')).content).toBe(
            '#1 [ ] testing\n1 total, 0 completed, 1 pending\npage: offset 0, limit 20, showing 1'
        );

        // The store is THIS harness's: the host tool path and a snapshot both see
        // exactly what the command wrote.
        expect(await writer.executeTool('task', {})).toEqual(taskPage([{ id: '1', text: 'testing', completed: false }], 1, 0, 1));
        expect(writer.snapshot().records.todos.items).toEqual([
            { id: '1', text: 'testing', completed: false }
        ]);
        expect(seen).toHaveLength(0);
    });

    it('answers a usage mistake as an error result instead of throwing', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = quiet(brain(seen));

        await writer.executeCommand('/task add "testing"');

        const cases: [string, string][] = [
            ['/task bogus', `/task: unknown action "bogus".\n${taskUsage}`],
            ['/task add', `/task: "add" needs the task text.\n${taskUsage}`],
            ['/task complete', `/task: "complete" needs a task id.\n${taskUsage}`],
            ['/task reopen', `/task: "reopen" needs a task id.\n${taskUsage}`],
            ['/task remove', `/task: "remove" needs at least one task id.\n${taskUsage}`],
            ['/task list 1', `/task: "list" takes no arguments (got 1).\n${taskUsage}`],
            ['/task complete 1 2', `/task: "complete" takes one id (got 2).\n${taskUsage}`]
        ];

        for (const [line, content] of cases) {
            expect(await writer.executeCommand(line)).toEqual({ content, isError: true });
        }

        // An unknown id is a TOOL rejection; a command still reports it as text.
        expect(await writer.executeCommand('/task complete 99')).toEqual({
            content: '/task complete: task has no task with id "99".',
            isError: true
        });
        // None of the rejected calls changed the list.
        expect((await writer.executeCommand('/task')).content).toBe(
            '#1 [ ] testing\n1 total, 0 completed, 1 pending\npage: offset 0, limit 20, showing 1'
        );
        expect(seen).toHaveLength(0);
    });
});

describe('/tools and /help', () => {
    it('lists registered tools sorted, and filters by a substring', async () => {
        const seen: HarnessStreamRequest[] = [];
        const zeta = tool({
            name: 'zeta',
            description: 'Zeta tool.',
            tags: ['zeta'],
            execute: () => 'zeta'
        });
        const writer = quiet(brain(seen), { zeta });

        const all = await writer.executeCommand('/tools');
        const names = Object.keys(writer.tools).sort();

        expect(all.data).toEqual(names);
        expect(all.content).toContain('zeta — Zeta tool.');
        // Long core descriptions are flattened to one preview line so the
        // inventory stays scannable (core/command-builtins.ts).
        expect(all.content.split('\n')).toHaveLength(names.length);
        expect(all.content.split('\n')[names.indexOf('task')]).toMatch(
            /^task — Maintain the task list for this harness session\./
        );

        // A filter matches the name or the description; `zeta` is unique here.
        expect(await writer.executeCommand('/tools zeta')).toEqual({
            content: 'zeta — Zeta tool.',
            data: ['zeta']
        });
        expect(await writer.executeCommand('/tools ZETA')).toEqual({
            content: 'zeta — Zeta tool.',
            data: ['zeta']
        });
        expect(await writer.executeCommand('/tools nothing-matches')).toEqual({
            content: '/tools: no registered tool matches "nothing-matches".\nusage: /tools [filter]',
            isError: true
        });
        expect(seen).toHaveLength(0);
    });

    it('lists every command, shows one, and reports an unknown one', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = quiet(brain(seen));

        expect((await writer.executeCommand('/help')).content).toBe(
            [
                '/help  List the commands in this harness, or show one command.',
                '  usage: /help [command]',
                "/task  Read and change this session's task list.",
                '  usage: /task [list | add <text> | complete <id> | reopen <id> | remove <id>...]',
                '/tools  List the tools registered in this harness.',
                '  usage: /tools [filter]',
                "/webfetch  Fetch one http(s) page through this session's fetch tool.",
                '  usage: /webfetch <url>',
                "/websearch  Search the web with this session's configured search tool.",
                '  usage: /websearch <query>'
            ].join('\n')
        );

        // `/help <name>` — the same renderer over one entry, and the name lookup
        // is as forgiving as the parser.
        expect((await writer.executeCommand('/help task')).content).toBe(
            "/task  Read and change this session's task list.\n  usage: /task [list | add <text> | complete <id> | reopen <id> | remove <id>...]"
        );
        expect((await writer.executeCommand('/help /TASK')).content).toBe(
            "/task  Read and change this session's task list.\n  usage: /task [list | add <text> | complete <id> | reopen <id> | remove <id>...]"
        );
        expect(await writer.executeCommand('/help zzz')).toEqual({
            content: '/help: unknown command "/zzz".\nusage: /help [command]',
            isError: true
        });
        expect(await writer.executeCommand('/help task extra')).toEqual({
            content: '/help: "help" takes at most one command name.\nusage: /help [command]',
            isError: true
        });
        expect(seen).toHaveLength(0);
    });

    it('renders the live registry, so /help follows a replacement', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = quiet(brain(seen));

        writer.registerCommand({
            name: 'zulu',
            description: 'Zulu command.',
            usage: '/zulu',
            execute: () => ({ content: 'z' })
        });

        expect((await writer.executeCommand('/help')).content).toContain(
            '/zulu  Zulu command.\n  usage: /zulu'
        );
        expect((await writer.executeCommand('/help zulu')).content).toBe(
            '/zulu  Zulu command.\n  usage: /zulu'
        );
        expect(seen).toHaveLength(0);
    });
});

describe('/websearch and /webfetch', () => {
    // A `search` tool with the REAL parameter schema (tools/websearch/index.ts):
    // `query` is required and additional properties are rejected, so a command
    // that sent the wrong key would fail validation instead of passing.
    const fakeSearch = (): Tool =>
        tool({
            name: 'search',
            description: 'Fake search.',
            tags: ['web'],
            visibility: 'core',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string' },
                    maxResults: { type: 'integer' },
                    provider: { type: 'string' }
                },
                required: ['query'],
                additionalProperties: false
            },
            execute: ({ parameters }) => ({
                provider: 'exa',
                query: (parameters as { query: string }).query,
                maxResults: 5,
                results: [
                    {
                        title: 'Harness docs',
                        url: 'https://example.com/docs',
                        snippet: 'line one\nline  two',
                        published: '2026-01-01'
                    },
                    { title: '', url: 'https://example.com/two', snippet: '' }
                ]
            })
        });

    // Same for `fetch` (tools/webfetch/index.ts): `url` is required.
    const fakeFetch = (): Tool =>
        tool({
            name: 'fetch',
            description: 'Fake fetch.',
            tags: ['web'],
            visibility: 'core',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string' },
                    format: { type: 'string' },
                    provider: { type: 'string' }
                },
                required: ['url'],
                additionalProperties: false
            },
            execute: ({ parameters }) => ({
                provider: 'native',
                url: (parameters as { url: string }).url,
                contentType: 'text/html',
                format: 'markdown',
                characters: 12,
                truncated: false,
                title: 'Example   Docs',
                content: '# Hello\nworld'
            })
        });

    it('calls the search tool with the query and formats the results', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = quiet(brain(seen), { search: fakeSearch() });

        const result = await writer.executeCommand('/websearch harness  docs');

        expect(result.content).toBe(
            '2 result(s) via exa:\n1. Harness docs\n   https://example.com/docs\n   line one line two\n   published: 2026-01-01\n2. (untitled)\n   https://example.com/two'
        );
        // `data` is the tool's own result, and the RAW tail was the query (its
        // spacing intact), not a re-joined token list.
        expect((result.data as { query: string }).query).toBe('harness  docs');

        // Quotes/escapes are NOT applied to a query: the operator's phrase is data.
        expect(((await writer.executeCommand('/websearch "exact phrase"')).data as { query: string }).query).toBe(
            '"exact phrase"'
        );

        expect(await writer.executeCommand('/websearch')).toEqual({
            content: '/websearch: a query is required.\nusage: /websearch <query>',
            isError: true
        });
        expect(seen).toHaveLength(0);
    });

    it('reports a failed search call as an error result, never a throw', async () => {
        const seen: HarnessStreamRequest[] = [];
        const broken = tool({
            name: 'search',
            description: 'Broken search.',
            tags: ['web'],
            visibility: 'core',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string' } },
                required: ['query'],
                additionalProperties: false
            },
            execute: () => {
                throw new Error('provider exploded');
            }
        });
        const writer = quiet(brain(seen), { search: broken });

        expect(await writer.executeCommand('/websearch anything')).toEqual({
            content: '/websearch: provider exploded',
            isError: true
        });
        expect(seen).toHaveLength(0);
    });

    it('calls the fetch tool with the first argument and formats the page', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = quiet(brain(seen), { fetch: fakeFetch() });

        const result = await writer.executeCommand('/webfetch https://example.com/docs');

        expect(result.content).toBe(
            'title: Example Docs\nurl: https://example.com/docs\ncontent type: text/html\ncharacters: 12\n\n# Hello\nworld'
        );
        expect((result.data as { url: string }).url).toBe('https://example.com/docs');

        expect(await writer.executeCommand('/webfetch')).toEqual({
            content: '/webfetch: a URL is required.\nusage: /webfetch <url>',
            isError: true
        });
        expect(seen).toHaveLength(0);
    });

    it('explains the configuration when the web tools are absent', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = quiet(brain(seen));

        // No `search` tool exists without a provider key, and no `fetch` tool
        // without `webfetch`. Both answers are results, not exceptions.
        expect(await writer.executeCommand('/websearch anything')).toEqual({
            content:
                '/websearch needs the "search" tool, which this harness does not register. Set websearch: true (or a websearch configuration object) and provide a provider key: EXA_API_KEY, TAVILY_API_KEY, or LINKUP_API_KEY.',
            isError: true
        });
        expect(await writer.executeCommand('/webfetch https://x.test')).toEqual({
            content:
                '/webfetch needs the "fetch" tool, which this harness does not register. Set webfetch: true (or a webfetch configuration object) to enable it; its native provider needs no key, and exa/linkup read EXA_API_KEY / LINKUP_API_KEY.',
            isError: true
        });
        expect(seen).toHaveLength(0);
    });
});

describe('snapshot isolation', () => {
    it('keeps command state per harness, like every other session store', async () => {
        const seen: HarnessStreamRequest[] = [];
        const first = quiet(brain(seen));
        const second = quiet(brain(seen));

        await first.executeCommand('/task add "only here"');

        expect((await second.executeCommand('/task')).content).toBe(
            'No tasks.\n0 total, 0 completed, 0 pending\npage: offset 0, limit 20, showing 0'
        );
        expect((await first.executeCommand('/task')).content).toBe(
            '#1 [ ] only here\n1 total, 0 completed, 1 pending\npage: offset 0, limit 20, showing 1'
        );

        // A registered command is per-harness too: replacing one name in the first
        // session leaves the second one on the built-in.
        first.registerCommand({ name: 'help', description: 'Mine.', execute: () => ({ content: 'mine' }) });
        expect((await first.executeCommand('/help')).content).toBe('mine');
        expect(((await second.executeCommand('/help')).content as string).startsWith('/help  ')).toBe(true);

        const snapshot: HarnessSnapshot = first.snapshot();
        expect(snapshot.records.todos.items).toEqual([
            { id: '1', text: 'only here', completed: false }
        ]);
        expect(seen).toHaveLength(0);
    });
});

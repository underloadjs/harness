// todoManage in the harness — declaration, turns, sharing, isolation, and names.
//
// These tests sit next to harness() because they pin harness integration, while
// src/core/todo.test.ts covers the tool implementation itself:
//   - todoManage is core and available on the very first request (no discovery);
//   - the list persists across harness calls and across agents in one harness;
//   - a second harness (a second server session) starts empty;
//   - reset() clears the list with the conversation;
//   - configured tools, plugins, and toolCreate cannot claim the name;
//   - invalid input becomes a readable, recoverable tool result.

import { describe, expect, it } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type {
    Agent,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest
} from '@underload/harness';

// Replay a scripted list of turns, one per request. `seen` records what the
// model was offered so the declaration tests can inspect it.
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

const brain = (stream: HarnessStream, extra: Record<string, unknown> = {}): Agent =>
    agent({ model: 'merge/ds4-flash', stream, ...extra });

// A harness with no presets, so the registry is exactly the core tools plus
// whatever a test adds.
const quiet = (entry: Agent, tools: Record<string, any> = {}) =>
    harness({ agents: { writer: entry }, tools, presets: false });

// R9 bounded shapes (src/core/todo.ts):
//   list  -> { todos, counts, page }        (one page, default 20, max 100)
//   write -> { todo|removed, counts }       (no list: a model calls `list`)
// `nextOffset` is omitted when `hasMore` is false, hence the explicit shape here.
const page = (offset = 0, limit = 20, hasMore = false) => ({ offset, limit, hasMore });

const empty = {
    todos: [],
    counts: { total: 0, completed: 0, remaining: 0 },
    page: page()
};

describe('todoManage', () => {
    it('is core and available on the first request without discovery', async () => {
        const seen: HarnessStreamRequest[] = [];
        const entry = brain(
            scripted([callTool('c1', 'todoManage', '{"action":"add","text":"Draft plan"}'), answer('added')], seen)
        );
        const writer = quiet(entry);

        expect(writer.tools.todoManage.visibility).toBe('core');

        await writer('start a plan');

        // toolRequest is never called, yet todoManage was declared and executed.
        expect(declaredNames(seen[0])).toEqual([
            'toolRegistry',
            'toolRequest',
            'toolList',
            'toolManage',
            'toolCreate',
            'todoManage',
            'profileManage',
            'chapterManage',
            'locationManage',
            'agentManage',
            'agentResult',
            'threadFork'
        ]);
        expect((entry.messages[2] as { content: string }).content).toBe(
            '{"todo":{"id":"1","text":"Draft plan","completed":false},"counts":{"total":1,"completed":0,"remaining":1}}'
        );
    });

    it('keeps the list across harness calls', async () => {
        const entry = brain(
            scripted([
                callTool('c1', 'todoManage', '{"action":"add","text":"Draft plan"}'),
                answer('added'),
                callTool('c2', 'todoManage', '{"action":"list"}'),
                answer('listed')
            ])
        );
        const writer = quiet(entry);

        await writer('plan');
        await writer('status');

        const toolMessages = entry.messages.filter((message) => message.role === 'tool');

        expect(JSON.parse((toolMessages[0] as { content: string }).content)).toEqual({
            todo: { id: '1', text: 'Draft plan', completed: false },
            counts: { total: 1, completed: 0, remaining: 1 }
        });

        // Second call: the todo is still there, with no surrounding context.
        expect(JSON.parse((toolMessages[1] as { content: string }).content)).toEqual({
            todos: [{ id: '1', text: 'Draft plan', completed: false }],
            counts: { total: 1, completed: 0, remaining: 1 },
            page: page()
        });
    });

    it('shares one list with every agent in the same harness', async () => {
        const writerSeen: HarnessStreamRequest[] = [];
        const researcherSeen: HarnessStreamRequest[] = [];

        const researcher = brain(
            scripted(
                [
                    callTool('r1', 'todoManage', '{"action":"list"}'),
                    answer('saw the shared list')
                ],
                researcherSeen
            )
        );

        // A core sibling tool is enough to enter the researcher's run and prove
        // the same todoManage instance serves both brains.
        const peek = tool({
            description: 'Ask the researcher what is planned.',
            tags: ['agents', 'inspect'],
            visibility: 'core',
            execute: async ({ run }) => (await run!('researcher', 'list the plan')).content
        });

        const entry = brain(
            scripted(
                [
                    callTool('c1', 'todoManage', '{"action":"add","text":"Shared item"}'),
                    callTool('c2', 'peek', '{}'),
                    answer('done')
                ],
                writerSeen
            )
        );

        const writer = harness({ agents: { writer: entry, researcher }, tools: { peek }, presets: false });
        await writer('plan and inspect');

        // The researcher's tool result is the primary's todo, not an empty list.
        expect(JSON.parse((researcher.messages[2] as { content: string }).content)).toEqual({
            todos: [{ id: '1', text: 'Shared item', completed: false }],
            counts: { total: 1, completed: 0, remaining: 1 },
            page: page()
        });

        // Both agents see todoManage as core; the primary additionally sees delegate.
        // `peek` was configured later than the baseline, so it follows them.
        expect(declaredNames(writerSeen[0])).toEqual([
            'toolRegistry',
            'toolRequest',
            'toolList',
            'toolManage',
            'toolCreate',
            'todoManage',
            'profileManage',
            'chapterManage',
            'locationManage',
            'agentManage',
            'agentResult',
            'agentDelegate',
            'threadFork',
            'peek'
        ]);
        expect(declaredNames(researcherSeen[0])).toEqual([
            'toolRegistry',
            'toolRequest',
            'toolList',
            'toolManage',
            'toolCreate',
            'todoManage',
            'profileManage',
            'chapterManage',
            'locationManage',
            'agentManage',
            'agentResult',
            'threadFork',
            'peek'
        ]);
    });

    it('isolates harnesses and clears on reset', async () => {
        const writerA = quiet(brain(scripted([answer('hi')])));
        const writerB = quiet(brain(scripted([answer('hi')])));

        // Separate factory instances per harness: not the same tool object.
        expect(writerA.tools.todoManage).not.toBe(writerB.tools.todoManage);

        // Session-bound core tools execute through the harness so they receive the
        // live reference and that harness's record store.
        await writerA.executeTool('todoManage', { action: 'add', text: 'Only A' });

        expect(await writerB.executeTool('todoManage', { action: 'list' })).toEqual(empty);

        // A reset is a clean start, including the id sequence.
        writerA.reset();

        expect(await writerA.executeTool('todoManage', { action: 'list' })).toEqual(empty);
        expect(await writerA.executeTool('todoManage', { action: 'add', text: 'After reset' })).toEqual({
            todo: { id: '1', text: 'After reset', completed: false },
            counts: { total: 1, completed: 0, remaining: 1 }
        });
    });

    it('lets configured tools, plugins, and dynamic creation replace todoManage', async () => {
        const custom = tool({ description: 'Mine.', tags: ['todo'], execute: () => 'ok' });

        const configured = harness({
            agents: { writer: brain(scripted([answer('hi')])) },
            tools: { todoManage: custom },
            presets: false
        });
        expect(configured.tools.todoManage).not.toBe(custom);
        expect(configured.tools.todoManage.description).toBe('Mine.');
        await expect(configured.executeTool('todoManage', {})).resolves.toBe('ok');

        const plugin = harness({
            agents: { writer: brain(scripted([answer('hi')])) },
            presets: false,
            plugins: [
                {
                    name: 'claim',
                    setup: (api) => {
                        api.addTool('todoManage', {
                            description: 'Mine.',
                            tags: ['todo'],
                            execute: () => 'plugin'
                        });
                    }
                }
            ]
        });
        await expect(plugin.executeTool('todoManage', {})).resolves.toBe('plugin');

        const writer = quiet(brain(scripted([answer('hi')])));
        const creation = {
            description: 'Mine.',
            tags: ['todo'],
            source: 'return 1;'
        };

        const created = writer.createTool({ ...creation, name: 'todoManage' });
        expect(created.description).toBe('Mine.');
        await expect(writer.executeTool('todoManage', {})).resolves.toBe(1);

        expect(Object.keys(writer.tools)).toEqual([
            'toolRegistry',
            'toolRequest',
            'toolList',
            'toolManage',
            'toolCreate',
            'todoManage',
            'profileManage',
            'chapterManage',
            'locationManage',
            'agentManage',
            'agentResult',
            'threadFork',
            'toolCancel'
        ]);
    });

    it('turns invalid todo input into a recoverable tool result', async () => {
        const entry = brain(
            scripted([callTool('c1', 'todoManage', '{"action":"add","text":"   "}'), answer('recovered')])
        );
        const writer = quiet(entry);

        const message = await writer('try');

        expect(message.content).toBe('recovered');
        expect((entry.messages[2] as { content: string }).content).toBe(
            'Tool "todoManage" failed: todoManage "add" requires a non-empty "text" string.'
        );
        expect(await writer.executeTool('todoManage', { action: 'list' })).toEqual(empty);
    });
});

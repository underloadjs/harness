// task in the harness — declaration, turns, sharing, isolation, and names.
//
// These tests sit next to harness() because they pin harness integration, while
// src/core/task.test.ts covers the tool implementation itself:
//   - task is core and available on the very first request (no discovery);
//   - the list persists across harness calls and across agents in one harness;
//   - a mutation returns the CURRENT bounded list in the same round trip;
//   - a second harness (a second server session) starts empty;
//   - reset() clears the list with the conversation;
//   - configured tools, plugins, and toolCreate can still replace the name;
//   - invalid input becomes a readable, recoverable tool result;
//   - R9-R11: the demoted runtime rows (the record tools, the tool* inventory set,
//     threadFork) stay REGISTERED but are no longer DECLARED, so only
//     toolRequest + task are advertised up front.
//
// Expectations come from the approved wire design (one patch call, one bounded
// result `{ tasks, counts { total, completed, pending }, page }`), not from the
// implementation's output.

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

// The ONE result shape (src/core/task.ts): every success — read, add, patch or
// remove — is the same bounded page. `nextOffset` is omitted when `hasMore` is
// false, hence the explicit shape here.
const page = (offset = 0, limit = 20, hasMore = false) => ({ offset, limit, hasMore });

const empty = {
    tasks: [],
    counts: { total: 0, completed: 0, pending: 0 },
    page: page()
};

// The runtime rows R9-R11 demoted to demand discovery. They stay registered (so
// toolRequest can enable them) but must never appear in a declaration.
const DEMOTED_RUNTIME_TOOLS = [
    'toolRegistry',
    'toolCreate',
    'toolManage',
    'toolList',
    'profileManage',
    'chapterManage',
    'locationManage',
    'agentManage',
    'agentResult',
    'threadFork'
] as const;

describe('task', () => {
    it('is core and available on the first request without discovery', async () => {
        const seen: HarnessStreamRequest[] = [];
        const entry = brain(
            scripted([callTool('c1', 'task', '{"tasks":[{"text":"Draft plan"}]}'), answer('added')], seen)
        );
        const writer = quiet(entry);

        expect(writer.tools.task.visibility).toBe('core');

        await writer('start a plan');

        // toolRequest is never called, yet task was declared and executed. R9-R11
        // leaves exactly the discovery bootstrap plus the session plan declared.
        expect(declaredNames(seen[0])).toEqual(['toolRequest', 'task']);

        // The mutation answer IS the current list: no `{ todo, counts }` wrapper.
        expect((entry.messages[2] as { content: string }).content).toBe(
            '{"tasks":[{"id":"1","text":"Draft plan","completed":false}],"counts":{"total":1,"completed":0,"pending":1},"page":{"offset":0,"limit":20,"hasMore":false}}'
        );
    });

    it('keeps the list across harness calls and re-reads with no arguments', async () => {
        const entry = brain(
            scripted([
                callTool('c1', 'task', '{"tasks":[{"text":"Draft plan"}]}'),
                answer('added'),
                callTool('c2', 'task', '{}'),
                answer('listed')
            ])
        );
        const writer = quiet(entry);

        await writer('plan');
        await writer('status');

        const toolMessages = entry.messages.filter((message) => message.role === 'tool');

        // First call: the add already returned the list.
        expect(JSON.parse((toolMessages[0] as { content: string }).content)).toEqual({
            tasks: [{ id: '1', text: 'Draft plan', completed: false }],
            counts: { total: 1, completed: 0, pending: 1 },
            page: page()
        });

        // Second call: an argument-less read of the same store, byte-identical.
        expect(JSON.parse((toolMessages[1] as { content: string }).content)).toEqual({
            tasks: [{ id: '1', text: 'Draft plan', completed: false }],
            counts: { total: 1, completed: 0, pending: 1 },
            page: page()
        });
    });

    it('patches one field and removes by id, each time returning the list', async () => {
        const writer = quiet(brain(scripted([answer('hi')])));

        await writer.executeTool('task', { tasks: [{ text: 'One' }, { text: 'Two' }] });

        // A partial patch leaves the untouched text in place.
        expect(await writer.executeTool('task', { tasks: [{ id: '1', completed: true }] })).toEqual({
            tasks: [
                { id: '1', text: 'One', completed: true },
                { id: '2', text: 'Two', completed: false }
            ],
            counts: { total: 2, completed: 1, pending: 1 },
            page: page()
        });

        // Removals answer the same way, with the survivor list.
        expect(await writer.executeTool('task', { remove: ['1'] })).toEqual({
            tasks: [{ id: '2', text: 'Two', completed: false }],
            counts: { total: 1, completed: 0, pending: 1 },
            page: page()
        });

        // A rejected patch does not move the store.
        await expect(writer.executeTool('task', { tasks: [{ id: '9', completed: true }] })).rejects.toThrow(
            'task has no task with id "9".'
        );
        expect(await writer.executeTool('task', {})).toEqual({
            tasks: [{ id: '2', text: 'Two', completed: false }],
            counts: { total: 1, completed: 0, pending: 1 },
            page: page()
        });
    });

    it('shares one list with every agent in the same harness', async () => {
        const writerSeen: HarnessStreamRequest[] = [];
        const researcherSeen: HarnessStreamRequest[] = [];

        const researcher = brain(
            scripted(
                [callTool('r1', 'task', '{}'), answer('saw the shared list')],
                researcherSeen
            )
        );

        // A core sibling tool is enough to enter the researcher's run and prove
        // the same task instance serves both brains.
        const peek = tool({
            description: 'Ask the researcher what is planned.',
            tags: ['agents', 'inspect'],
            visibility: 'core',
            execute: async ({ run }) => (await run!('researcher', 'list the plan')).content
        });

        const entry = brain(
            scripted(
                [
                    callTool('c1', 'task', '{"tasks":[{"text":"Shared item"}]}'),
                    callTool('c2', 'peek', '{}'),
                    answer('done')
                ],
                writerSeen
            )
        );

        const writer = harness({ agents: { writer: entry, researcher }, tools: { peek }, presets: false });
        await writer('plan and inspect');

        // The researcher's tool result is the primary's list, not an empty one.
        expect(JSON.parse((researcher.messages[2] as { content: string }).content)).toEqual({
            tasks: [{ id: '1', text: 'Shared item', completed: false }],
            counts: { total: 1, completed: 0, pending: 1 },
            page: page()
        });

        // Both brains see task (and the bootstrap) as core; the primary additionally
        // sees delegate. `peek` was configured later than the baseline, so it follows.
        expect(declaredNames(writerSeen[0])).toEqual(['toolRequest', 'task', 'delegate', 'peek']);
        expect(declaredNames(researcherSeen[0])).toEqual(['toolRequest', 'task', 'peek']);
    });

    it('declares only toolRequest and task, and keeps the demoted rows discoverable', () => {
        const writer = quiet(brain(scripted([answer('hi')])));

        // Registered (the harness can still run them, and toolRequest can surface
        // them) but searchable, which is exactly why they are not declared.
        for (const name of DEMOTED_RUNTIME_TOOLS) {
            expect(writer.tools[name], name).toBeDefined();
            expect(writer.tools[name].visibility, name).toBe('searchable');
        }

        // actionRequest is demoted too, but it only registers with an owner
        // answerer, so this harness has no row for it at all.
        expect(writer.tools.actionRequest).toBeUndefined();

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

    it('isolates harnesses and clears on reset', async () => {
        const writerA = quiet(brain(scripted([answer('hi')])));
        const writerB = quiet(brain(scripted([answer('hi')])));

        // Separate factory instances per harness: not the same tool object.
        expect(writerA.tools.task).not.toBe(writerB.tools.task);

        // Session-bound core tools execute through the harness so they receive the
        // live reference and that harness's record store.
        await writerA.executeTool('task', { tasks: [{ text: 'Only A' }] });

        expect(await writerB.executeTool('task', {})).toEqual(empty);

        // A reset is a clean start, including the id sequence.
        writerA.reset();

        expect(await writerA.executeTool('task', {})).toEqual(empty);
        expect(await writerA.executeTool('task', { tasks: [{ text: 'After reset' }] })).toEqual({
            tasks: [{ id: '1', text: 'After reset', completed: false }],
            counts: { total: 1, completed: 0, pending: 1 },
            page: page()
        });
    });

    it('lets configured tools, plugins, and dynamic creation replace task', async () => {
        const custom = tool({ description: 'Mine.', tags: ['task'], execute: () => 'ok' });

        const configured = harness({
            agents: { writer: brain(scripted([answer('hi')])) },
            tools: { task: custom },
            presets: false
        });
        expect(configured.tools.task).not.toBe(custom);
        expect(configured.tools.task.description).toBe('Mine.');
        await expect(configured.executeTool('task', {})).resolves.toBe('ok');

        const plugin = harness({
            agents: { writer: brain(scripted([answer('hi')])) },
            presets: false,
            plugins: [
                {
                    name: 'claim',
                    setup: (api) => {
                        api.addTool('task', {
                            description: 'Mine.',
                            tags: ['task'],
                            execute: () => 'plugin'
                        });
                    }
                }
            ]
        });
        await expect(plugin.executeTool('task', {})).resolves.toBe('plugin');

        const writer = quiet(brain(scripted([answer('hi')])));
        const creation = {
            description: 'Mine.',
            tags: ['task'],
            source: 'return 1;'
        };

        const created = writer.createTool({ ...creation, name: 'task' });
        expect(created.description).toBe('Mine.');
        await expect(writer.executeTool('task', {})).resolves.toBe(1);

        // The replaced row is still the same slot in the same registration order.
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

    it('turns invalid task input into a recoverable tool result', async () => {
        const entry = brain(
            scripted([callTool('c1', 'task', '{"tasks":[{"text":"   "}]}'), answer('recovered')])
        );
        const writer = quiet(entry);

        const message = await writer('try');

        expect(message.content).toBe('recovered');
        expect((entry.messages[2] as { content: string }).content).toBe(
            'Tool "task" failed: task "tasks[0]" requires a non-empty "text" string.'
        );
        expect(await writer.executeTool('task', {})).toEqual(empty);
    });
});

// Tool creation policy, budget, and run-depth authority (R12).
//
// Contract pinned here:
//   - `toolCreation` defaults to 'all' (every agent sees toolCreate);
//   - 'primary' declares the tool only to the primary and rejects a guessed call
//     from a subagent;
//   - `false` registers no model-facing tool at all, while the HOST path
//     `harness.createTool()` keeps working;
//   - the creation budget is a LIFETIME budget: reset() does not restore it;
//   - `maxCreatedTools` is validated at construction;
//   - runs nest at most one level deep, enforced centrally, so a tool holding the
//     whole `context` (including a model-CREATED tool) cannot widen the
//     hierarchy — while the primary's own ctx.run still works.

import { describe, expect, it } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type { Agent, HarnessStream, HarnessStreamEvent, HarnessStreamRequest } from '@underload/harness';

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

const content = (message: unknown): string => (message as { content: string }).content;

const creation = {
    name: 'repeat',
    description: 'Repeat text.',
    tags: ['text', 'repeat'],
    source: 'return args;'
};

describe('toolCreation policy', () => {
    it('defaults to all: a subagent sees toolCreate too', async () => {
        const seenResearcher: HarnessStreamRequest[] = [];
        const researcher = brain(scripted([answer('facts')], seenResearcher));
        const writerAgent = brain(
            scripted([callTool('c1', 'agentDelegate', '{"agent":"researcher","input":"go"}'), answer('final')])
        );
        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });

        await writer('go');

        expect(writer.tools.toolCreate).toBeDefined();
        expect(declaredNames(seenResearcher[0])).toContain('toolCreate');
    });

    it('primary: hides the tool from subagents and rejects a guessed call', async () => {
        const seenResearcher: HarnessStreamRequest[] = [];
        const researcher = brain(
            scripted([callTool('r1', 'toolCreate', JSON.stringify(creation)), answer('blocked')], seenResearcher)
        );
        const writerAgent = brain(
            scripted([callTool('c1', 'agentDelegate', '{"agent":"researcher","input":"go"}'), answer('final')])
        );
        const writer = harness({
            agents: { writer: writerAgent, researcher },
            presets: false,
            toolCreation: 'primary'
        });

        await writer('go');

        // Not declared to the subagent ...
        expect(declaredNames(seenResearcher[0])).toEqual([
            'toolRegistry',
            'toolRequest',
            'toolList',
            'toolManage',
            'todoManage',
            'profileManage',
            'chapterManage',
            'locationManage',
            'agentManage',
            'agentResult',
            'threadFork'
        ]);

        // ... and a guessed call is answered, not executed.
        expect(content(researcher.messages[2])).toBe(
            'Tool "toolCreate" is only available to the primary agent "writer".'
        );
        expect(writer.tools.repeat).toBeUndefined();

        // The primary still sees it.
        const seenWriter = brain(scripted([answer('x')]));
        expect(harness({ agents: { writer: seenWriter }, presets: false, toolCreation: 'primary' }).tools.toolCreate)
            .toBeDefined();
    });

    it('false: registers no model-facing tool, but the host path still creates', () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('hi')])) },
            presets: false,
            toolCreation: false
        });

        expect(writer.tools.toolCreate).toBeUndefined();

        // An operator action is not a model privilege.
        const created = writer.createTool(creation);
        expect(created.name).toBe('repeat');
        expect(writer.tools.repeat).toBe(created);
    });

    it('rejects an unknown policy at construction', () => {
        expect(() =>
            harness({
                agents: { writer: brain(scripted([answer('hi')])) },
                toolCreation: 'sometimes' as never
            })
        ).toThrow('toolCreation must be one of: "all", "primary", false. Received sometimes.');
    });
});

describe('creation budget', () => {
    it('is a lifetime budget that reset() does not restore', () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('hi')])) },
            presets: false,
            maxCreatedTools: 2
        });

        writer.createTool({ ...creation, name: 'one' });
        writer.createTool({ ...creation, name: 'two' });

        // reset() clears conversation and discovery, NOT the registry or the budget.
        writer.reset();
        expect(writer.tools.one).toBeDefined();
        expect(writer.tools.two).toBeDefined();

        expect(() => writer.createTool({ ...creation, name: 'three' })).toThrow(
            'This harness already created 2 tools; reuse an existing tool instead of creating more.'
        );
    });

    it('validates maxCreatedTools at construction', () => {
        expect(() =>
            harness({ agents: { writer: brain(scripted([answer('hi')])) }, maxCreatedTools: 0 })
        ).toThrow('maxCreatedTools must be a positive safe integer; received 0.');
        expect(() =>
            harness({ agents: { writer: brain(scripted([answer('hi')])) }, maxCreatedTools: 1.5 })
        ).toThrow('maxCreatedTools must be a positive safe integer; received 1.5.');
    });
});

describe('run depth authority', () => {
    it('lets the primary run a tool that starts one agent through ctx.run', async () => {
        const summarizer = brain(scripted([answer('summary')]));
        const delegate = tool({
            description: 'Summarise through a sibling agent.',
            tags: ['agents'],
            visibility: 'core',
            execute: async ({ run }) => (await run!('summarizer', 'text')).content
        });
        const entry = brain(scripted([callTool('c1', 'delegate', '{}'), answer('done')]));
        const writer = harness({
            agents: { writer: entry, summarizer },
            tools: { delegate },
            presets: false
        });

        await writer('go');

        // The trusted primary ctx.run still works (depth 2).
        expect(content(entry.messages[2])).toBe('summary');
        expect(summarizer.messages).toEqual([
            { role: 'user', content: 'text' },
            { role: 'assistant', content: 'summary' }
        ]);
    });

    it('refuses a third level from inside a delegated subagent, even from a created tool', async () => {
        const editor = brain(scripted([answer('edited')]));
        const seenResearcher: HarnessStreamRequest[] = [];
        const researcher = brain(
            scripted([callTool('r1', 'nest', '{}'), answer('blocked')], seenResearcher)
        );

        // A model-CREATED tool gets the whole context, so it can call run(). It must
        // not be able to widen "one level of delegation".
        const writerAgent = brain(
            scripted([
                callTool(
                    'c1',
                    'agentDelegate',
                    '{"agent":"researcher","input":"go"}'
                ),
                answer('final')
            ])
        );

        const writer = harness({
            agents: { writer: writerAgent, researcher, editor },
            presets: false
        });

        // Register the nesting tool through the SAME host path toolCreate uses, as
        // a created (searchable, immediately enabled) tool.
        writer.createTool({
            name: 'nest',
            description: 'Start another agent.',
            tags: ['agents'],
            source: "return context.run('editor', 'edit');"
        });
        // The subagent never discovered it: make it callable for this fixture by
        // running discovery through the same harness (its result enables it).
        await writer.executeTool('toolRequest', { tags: ['agents'] });

        await writer('go');

        expect(content(researcher.messages[2])).toBe(
            'Tool "nest" failed: Agent "editor" cannot run: runs nest at most 2 deep, and "researcher" is already running.'
        );
        // The editor never ran, so it has no transcript.
        expect(editor.messages).toEqual([]);
    });
});

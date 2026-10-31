// toolCreate — the runtime tool-creation capability (R2b).
//
// Contract pinned here:
//   - toolCreate is a core tool, so every agent sees it without discovery;
//   - a model-created tool is registered searchable, enabled at once, and appears
//     in the very next request's declarations and in later toolRequest results;
//   - registering compiles the body but NEVER executes it;
//   - the body receives `args` after the single-property rule and the harness
//     `context` (agent/agents/run);
//   - invalid name, reserved name, registry collision, budget exhaustion, and a
//     source that does not parse are recoverable tool results for the model and
//     HarnessError exceptions for the host;
//   - creation is session-local: nothing touches the filesystem.

import { describe, expect, it } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type {
    Agent,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest,
    ToolCreation
} from '@underload/harness';

// Replay a scripted list of turns, one per request. `seen` records what the
// model was offered, so declaration changes are observable.
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

// A harness that never reaches the network and starts without the preset
// catalogue, so the registry is exactly what a test puts in it.
const quiet = (entry: Agent, tools: Record<string, any> = {}) =>
    harness({ agents: { writer: entry }, tools, presets: false });

const creation: ToolCreation = {
    name: 'repeat',
    description: 'Repeat text.',
    tags: ['text', 'repeat'],
    parameters: {
        type: 'object',
        properties: {
            text: { type: 'string' },
            times: { type: 'number' }
        },
        required: ['text']
    },
    source: 'return args.text.repeat(args.times ?? 1);'
};

describe('toolCreate', () => {
    it('is core, so the model can reach it without discovery', async () => {
        const seen: HarnessStreamRequest[] = [];
        const writer = quiet(brain(scripted([answer('hi')], seen)));

        await writer('go');

        expect(writer.tools.toolCreate.visibility).toBe('core');
        expect(writer.tools.toolCreate.description).toContain('Create a tool for yourself from JavaScript source.');
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
    });

    it('registers a tool from a model call and declares it on the next turn', async () => {
        const seen: HarnessStreamRequest[] = [];
        const entry = brain(
            scripted(
                [
                    callTool('c1', 'toolCreate', JSON.stringify(creation)),
                    callTool('c2', 'repeat', '{"text":"ab","times":2}'),
                    answer('done')
                ],
                seen
            )
        );

        const writer = quiet(entry);
        const message = await writer('go');

        // Round 1: core only. Round 2: the created tool is already enabled.
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
        expect(declaredNames(seen[1])).toEqual([
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
            'repeat'
        ]);

        // The tool is a real registry entry, searchable like any other.
        expect(writer.tools.repeat.name).toBe('repeat');
        expect(writer.tools.repeat.visibility).toBe('searchable');
        expect(writer.tools.repeat.tags).toEqual(['text', 'repeat']);

        // The toolCreate result is metadata only — never the source.
        expect(JSON.parse((entry.messages[2] as { content: string }).content)).toEqual({
            name: 'repeat',
            description: 'Repeat text.',
            tags: ['text', 'repeat'],
            enabled: true,
            parameters: creation.parameters
        });

        // The created tool ran on the next turn with its arguments object.
        expect((entry.messages[4] as { content: string }).content).toBe('abab');
        expect(message.content).toBe('done');
    });

    it('never executes the source at registration', async () => {
        const writer = quiet(brain(scripted([answer('hi')])));

        // A body that throws on execution registers without complaint ...
        const bomb = writer.createTool({
            name: 'bomb',
            description: 'Explode on call.',
            tags: ['probe'],
            source: "throw new Error('boom');"
        });

        expect(bomb.name).toBe('bomb');
        expect(writer.tools.bomb).toBe(bomb);
        expect(writer.tools.bomb.visibility).toBe('searchable');

        // ... and only blows up when it is actually called.
        await expect(bomb(undefined)).rejects.toThrow('boom');
    });

    it('applies the single-property rule to the body arguments', async () => {
        const entry = brain(
            scripted([
                callTool(
                    'c1',
                    'toolCreate',
                    JSON.stringify({
                        name: 'shout',
                        description: 'Uppercase text.',
                        tags: ['text'],
                        parameters: { type: 'object', properties: { text: { type: 'string' } } },
                        source: 'return args.toUpperCase();'
                    })
                ),
                callTool('c2', 'shout', '{"text":"hello"}'),
                answer('done')
            ])
        );

        const writer = quiet(entry);
        await writer('go');

        // One-property schema: the model's `{ text: "hello" }` reaches the body as
        // the value itself, exactly like `execute({ parameters })`.
        expect((entry.messages[4] as { content: string }).content).toBe('HELLO');
    });

    it('stays discoverable through toolRequest after registration', async () => {
        const writer = quiet(brain(scripted([answer('hi')])));

        writer.createTool({
            name: 'digest',
            description: 'Summarise text.',
            tags: ['text', 'summary'],
            source: 'return args;'
        });

        expect(await writer.executeTool('toolRequest', { tags: ['summary'] })).toEqual({
            enabled: ['digest'],
            tools: [{ name: 'digest', description: 'Summarise text.', tags: ['text', 'summary'] }],
            matched: 1,
            omitted: 0
        });
    });

    it('replaces reserved and existing names intentionally through the same kernel', async () => {
        const existing = tool({ description: 'Existing.', tags: ['x'], execute: () => 'ok' });
        const writer = quiet(brain(scripted([answer('hi')])), { existing });

        // No reserved names: toolCreate can intentionally replace a harness-owned
        // control and a previously registered name.
        writer.createTool({ name: 'toolRequest', description: 'Mine.', tags: ['x'], source: 'return 1;' });
        await expect(writer.executeTool('toolRequest', { tags: [] })).resolves.toBe(1);

        writer.createTool({
            name: 'agentDelegate',
            description: 'Mine.',
            tags: ['x'],
            source: 'return 2;'
        });
        await expect(writer.executeTool('agentDelegate', {})).resolves.toBe(2);

        writer.createTool({
            name: 'existing',
            description: 'Replacement.',
            tags: ['x'],
            source: 'return "replaced";'
        });
        await expect(writer.executeTool('existing', {})).resolves.toBe('replaced');

        // A case-different name is a distinct registry key (no collision ban).
        writer.createTool({
            name: 'Existing',
            description: 'Case variant.',
            tags: ['x'],
            source: 'return "replaced";'
        });
        await expect(writer.executeTool('Existing', {})).resolves.toBe('replaced');

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
            'toolCancel',
            'existing',
            'agentDelegate',
            'Existing'
        ]);
    });

    it('validates the creation shape', () => {
        const writer = quiet(brain(scripted([answer('hi')])));

        expect(() => writer.createTool({ ...creation, name: 'bad name' })).toThrow(
            'Tool name "bad name" is not valid: use one letter followed by letters, digits, "_" or "-", at most 64 characters.'
        );

        expect(() => writer.createTool({ ...creation, description: '   ' })).toThrow(
            'Tool "repeat" requires a description.'
        );

        expect(() => writer.createTool({ ...creation, tags: [] })).toThrow(
            'Tool "repeat" requires at least one tag, so toolRequest can find it.'
        );

        expect(() => writer.createTool({ ...creation, source: '   ' })).toThrow(
            'Tool "repeat" requires a source body.'
        );
    });

    it('reports a source that does not parse as a HarnessError', () => {
        const writer = quiet(brain(scripted([answer('hi')])));

        expect(() => writer.createTool({ ...creation, source: 'return (' })).toThrow(
            /^Tool source could not be compiled: /
        );

        // A failed compile registers nothing.
        expect(writer.tools.repeat).toBeUndefined();
    });

    it('turns a failed creation into a recoverable tool result for the model', async () => {
        const entry = brain(
            scripted([
                callTool('c1', 'toolCreate', JSON.stringify({ ...creation, source: 'return (' })),
                answer('recovered')
            ])
        );

        const writer = quiet(entry);
        const message = await writer('go');

        expect(message.content).toBe('recovered');
        expect(writer.tools.repeat).toBeUndefined();
        expect((entry.messages[2] as { content: string }).content).toMatch(
            /^Tool "toolCreate" failed: Tool source could not be compiled: /
        );
    });

    it('bounds how many tools one harness may create', () => {
        const writer = quiet(brain(scripted([answer('hi')])));

        for (let index = 0; index < 32; index++) {
            writer.createTool({
                name: `generated${index}`,
                description: 'Generated.',
                tags: ['generated'],
                source: 'return args;'
            });
        }

        // Thirteen harness-owned baseline entries (toolRegistry, toolRequest,
        // toolList, toolManage, toolCreate, the four record tools,
        // agentManage/agentResult, threadFork, and the pending-only toolCancel)
        // plus the 32 creations.
        expect(Object.keys(writer.tools)).toHaveLength(45);
        expect(() =>
            writer.createTool({
                name: 'generated32',
                description: 'Generated.',
                tags: ['generated'],
                source: 'return args;'
            })
        ).toThrow('This harness already created 32 tools; reuse an existing tool instead of creating more.');
    });
});

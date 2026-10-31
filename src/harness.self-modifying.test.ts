// Self-modifying tool kernel — focused regression tests.
//
// These pin the production loop required by task-harness-self-modifying-tools:
// source -> compile/load/validate -> atomic publish -> invocation, on the SAME
// live harness object. Manual `executeTool` is used where the assertion is about
// the kernel/implementation; scripted model turns cover schema capture and
// scheduled-call semantics.
import { describe, expect, it } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type {
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest
} from '@underload/harness';

// Scripted provider: one array of frames per model request.
const scripted = (turns: HarnessStreamEvent[][], seen?: HarnessStreamRequest[]): HarnessStream => {
    let index = 0;
    return async function* stream(request) {
        seen?.push(request);
        const frames = turns[Math.min(index, turns.length - 1)];
        index++;
        for (const frame of frames) yield frame;
    };
};

const answer = (text: string): HarnessStreamEvent[] => [
    { type: 'text', delta: text },
    { type: 'done', stopReason: 'stop', toolCalls: [] }
];

const callTool = (id: string, name: string, args: string): HarnessStreamEvent[] => [
    {
        type: 'done',
        stopReason: 'tool_calls',
        toolCalls: [{ id, name, arguments: args }]
    }
];

const brain = (stream: HarnessStream) => agent({ model: 'test/model', stream });

// A module entry in the runtime-tools shape: metadata + execute.
const moduleFor = (options: {
    name: string;
    description?: string;
    tags?: string[];
    parameters?: Record<string, unknown>;
    body: string;
}): string => `
export const metadata = {
    name: ${JSON.stringify(options.name)},
    description: ${JSON.stringify(options.description ?? `${options.name} tool`)},
    tags: ${JSON.stringify(options.tags ?? ['test', 'dynamic'])},
    ...${
        options.parameters === undefined
            ? '{}'
            : `{ parameters: ${JSON.stringify(options.parameters)} }`
    }
};

export const execute = async (context) => {
    ${options.body}
};
`;

const makeHarness = (stream: HarnessStream = scripted([answer('ok')])) =>
    harness({ agents: { writer: brain(stream) }, presets: false });

describe('self-modifying tool kernel', () => {
    it('registers source, publishes metadata/schema/implementation together, and exposes a revision', async () => {
        const writer = makeHarness();

        const result = await writer.registerTool({
            name: 'selfEcho',
            moduleText: moduleFor({
                name: 'selfEcho',
                description: 'Echo the input.',
                parameters: {
                    type: 'object',
                    properties: { value: { type: 'string' } },
                    required: ['value'],
                    additionalProperties: false
                },
                body: 'return context.parameters;'
            })
        });

        expect(result.name).toBe('selfEcho');
        expect(result.created).toBe(true);
        expect(result.replaced).toBe(false);
        expect(result.revision).toMatch(/^[0-9a-f]{16}$/);
        expect(result.checks).toEqual([
            'transpile:syntax',
            'load:module',
            'contract:tool',
            'schema:json'
        ]);

        expect(writer.tools.selfEcho.description).toBe('Echo the input.');
        expect(writer.tools.selfEcho.parameters).toEqual({
            type: 'object',
            properties: { value: { type: 'string' } },
            required: ['value'],
            additionalProperties: false
        });
        expect(writer.toolSource('selfEcho')?.revision).toBe(result.revision);
        await expect(writer.executeTool('selfEcho', 'hello')).resolves.toBe('hello');
    });

    it('passes the exact same live harness reference to original and replacement implementations', async () => {
        const writer = makeHarness();

        const v1 = await writer.registerTool({
            name: 'harnessIdentity',
            moduleText: moduleFor({
                name: 'harnessIdentity',
                body: "return { version: 1, harness: context.harness, isLive: typeof context.harness.tools.harnessIdentity.execute === 'function' };"
            })
        });

        const first = (await writer.executeTool('harnessIdentity', {})) as {
            harness: unknown;
            isLive: boolean;
        };

        expect(first.harness).toBe(writer);
        expect(first.isLive).toBe(true);

        // Replace while the first definition still exists and then execute again.
        const v2 = await writer.registerTool({
            name: 'harnessIdentity',
            moduleText: moduleFor({
                name: 'harnessIdentity',
                body: 'return { version: 2, harness: context.harness };'
            })
        });

        const second = (await writer.executeTool('harnessIdentity', {})) as {
            harness: unknown;
            version: number;
        };

        expect(second.harness).toBe(writer);
        expect(second.version).toBe(2);
        expect(v2.replaced).toBe(true);
        expect(v2.previousRevision).toBe(v1.revision);
        expect(v2.revision).not.toBe(v1.revision);
    });

    it('keeps harness memory and agents across replacement', async () => {
        const writer = makeHarness();
        writer.memory.set('durable', { count: 1 });
        const originalAgent = writer.agent;

        await writer.registerTool({
            name: 'memoryTool',
            moduleText: moduleFor({
                name: 'memoryTool',
                body: "const value = context.harness.memory.get('durable'); context.harness.memory.set('durable', { count: value.count + 1 }); return { value, agent: context.harness.agent.name };"
            })
        });

        await expect(writer.executeTool('memoryTool', {})).resolves.toEqual({
            value: { count: 1 },
            agent: 'writer'
        });

        await writer.registerTool({
            name: 'memoryTool',
            moduleText: moduleFor({
                name: 'memoryTool',
                body: "const value = context.harness.memory.get('durable'); context.harness.memory.set('durable', { count: value.count + 1 }); return { value, sameAgent: context.harness.agent === context.agent };"
            })
        });

        await expect(writer.executeTool('memoryTool', {})).resolves.toEqual({
            value: { count: 2 },
            sameAgent: true
        });
        expect(writer.memory.get('durable')).toEqual({ count: 3 });
        expect(writer.agent).toBe(originalAgent);
    });

    it('leaves implementation, metadata, and schema unchanged when compilation fails', async () => {
        const writer = makeHarness();

        await writer.registerTool({
            name: 'guarded',
            moduleText: moduleFor({
                name: 'guarded',
                description: 'old description',
                parameters: { type: 'object', properties: { a: { type: 'string' } } },
                body: "return 'old';"
            })
        });

        const before = writer.tools.guarded;
        const beforeSource = writer.toolSource('guarded');

        await expect(
            writer.registerTool({
                name: 'guarded',
                description: 'new description',
                parameters: { type: 'object', properties: { b: { type: 'number' } } },
                moduleText: 'export const execute = (;'
            })
        ).rejects.toThrow(/could not be transpiled/);

        expect(writer.tools.guarded).toBe(before);
        expect(writer.tools.guarded.description).toBe('old description');
        expect(writer.tools.guarded.parameters).toEqual({
            type: 'object',
            properties: { a: { type: 'string' } }
        });
        expect(writer.toolSource('guarded')).toEqual(beforeSource);
        await expect(writer.executeTool('guarded', {})).resolves.toBe('old');
    });

    it('creates no registry entry when a new name fails compilation', async () => {
        const writer = makeHarness();

        await expect(
            writer.registerTool({
                name: 'neverInstalled',
                moduleText: 'export const metadata = { name: "neverInstalled", description: "x", tags: ["x"] }; export const execute = ;'
            })
        ).rejects.toThrow(/could not be transpiled/);

        expect(writer.tools.neverInstalled).toBeUndefined();
        expect(writer.toolSource('neverInstalled')).toBeUndefined();
    });

    it('does not publish a replacement when loading or the tool contract fails', async () => {
        const writer = makeHarness();

        await writer.registerTool({
            name: 'loadGuarded',
            moduleText: moduleFor({ name: 'loadGuarded', body: "return 'old';" })
        });
        const before = writer.tools.loadGuarded;

        await expect(
            writer.registerTool({
                name: 'loadGuarded',
                moduleText: 'throw new Error("top-level load failure");'
            })
        ).rejects.toThrow(/could not be loaded: top-level load failure/);
        expect(writer.tools.loadGuarded).toBe(before);

        const beforeRevision = writer.toolSource('loadGuarded')?.revision;

        await expect(
            writer.registerTool({
                name: 'loadGuarded',
                moduleText: 'export const metadata = { name: "loadGuarded", description: "x", tags: ["x"] }; export const execute = 42;'
            })
        ).rejects.toThrow(/did not export a tool/);
        expect(writer.tools.loadGuarded).toBe(before);
        expect(writer.toolSource('loadGuarded')?.revision).toBe(beforeRevision);
    });

    it('publishes overlapping registrations in submission order with the last completed call winning', async () => {
        const writer = makeHarness();

        const first = writer.registerTool({
            name: 'ordered',
            moduleText: moduleFor({ name: 'ordered', body: "return 'first';" })
        });
        const second = writer.registerTool({
            name: 'ordered',
            moduleText: moduleFor({ name: 'ordered', body: "return 'second';" })
        });

        const [firstResult, secondResult] = await Promise.all([first, second]);

        expect(firstResult.created).toBe(true);
        expect(secondResult.replaced).toBe(true);
        expect(secondResult.previousRevision).toBe(firstResult.revision);
        await expect(writer.executeTool('ordered', {})).resolves.toBe('second');
    });

    it('lets toolRegistry replace itself twice and continue registering tools afterwards', async () => {
        const writer = makeHarness();

        const v2 = await writer.executeTool('toolRegistry', {
            name: 'toolRegistry',
            description: 'registry v2',
            tags: ['tools'],
            moduleText: moduleFor({
                name: 'toolRegistry',
                body: 'return context.harness.registerTool(context.parameters);'
            })
        });

        expect(v2).toMatchObject({ name: 'toolRegistry', replaced: true });

        // V2 registers another tool through the same live harness.
        const created = await writer.executeTool('toolRegistry', {
            name: 'fromV2',
            moduleText: moduleFor({ name: 'fromV2', body: "return 'from-v2';" })
        });
        expect(created).toMatchObject({ name: 'fromV2', created: true });
        await expect(writer.executeTool('fromV2', {})).resolves.toBe('from-v2');

        // V2 replaces itself with V3; V3 keeps working.
        const v3 = await writer.executeTool('toolRegistry', {
            name: 'toolRegistry',
            description: 'registry v3',
            tags: ['tools'],
            moduleText: moduleFor({
                name: 'toolRegistry',
                body: "return { version: 3 };"
            })
        });
        expect(v3).toMatchObject({ name: 'toolRegistry', replaced: true });
        await expect(writer.executeTool('toolRegistry', {})).resolves.toEqual({ version: 3 });
    });

    it('keeps two harnesses bound to their own memory and registry destinations', async () => {
        const one = makeHarness();
        const two = makeHarness();

        await one.registerTool({
            name: 'isolated',
            moduleText: moduleFor({
                name: 'isolated',
                body: "context.harness.memory.set('where', 'one'); return context.harness.memory.get('where');"
            })
        });
        await two.registerTool({
            name: 'isolated',
            moduleText: moduleFor({
                name: 'isolated',
                body: "context.harness.memory.set('where', 'two'); return context.harness.memory.get('where');"
            })
        });

        await expect(one.executeTool('isolated', {})).resolves.toBe('one');
        await expect(two.executeTool('isolated', {})).resolves.toBe('two');
        expect(one.memory.get('where')).toBe('one');
        expect(two.memory.get('where')).toBe('two');
        expect(one.tools.isolated).not.toBe(two.tools.isolated);
    });

    it('resolves nested calls through the live registry and observes later replacements', async () => {
        const writer = makeHarness();

        await writer.registerTool({
            name: 'echoValue',
            moduleText: moduleFor({ name: 'echoValue', body: "return 'v1:' + context.parameters; " })
        });
        await writer.registerTool({
            name: 'relayValue',
            moduleText: moduleFor({
                name: 'relayValue',
                body: 'return context.callTool("echoValue", context.parameters);'
            })
        });

        await expect(writer.executeTool('relayValue', 'x')).resolves.toBe('v1:x');

        await writer.registerTool({
            name: 'echoValue',
            moduleText: moduleFor({ name: 'echoValue', body: "return 'v2:' + context.parameters; " })
        });

        await expect(writer.executeTool('relayValue', 'x')).resolves.toBe('v2:x');
    });

    it('compiles shipped preset and core entries through the same operation and exposes their source revisions', () => {
        const writer = harness({ agents: { writer: brain(scripted([answer('ok')])) } });

        const preset = writer.toolSource('fileRead');
        expect(preset?.sourcePath).toBe('tools/files/fileRead.tool.ts');
        expect(preset?.checks).toEqual([
            'transpile:syntax',
            'load:module',
            'contract:tool',
            'schema:json'
        ]);
        // Harness framework imports resolve to live package modules; this entry
        // has no local helper dependency.
        expect(preset?.dependencies).toEqual([]);

        const registry = writer.toolSource('toolRegistry');
        expect(registry?.sourcePath).toBe('tools/runtime/toolRegistry.tool.ts');
        expect(registry?.revision).toMatch(/^[0-9a-f]{16}$/);
        // Harness-owned controls are source entries too.
        expect(writer.toolSource('todoManage')?.sourcePath).toBe('tools/runtime/todoManage.tool.ts');
        expect(writer.toolSource('toolCancel')?.sourcePath).toBe('tools/runtime/toolCancel.tool.ts');
    });

    it('captures and compiles local virtual dependencies for moduleText revisions', async () => {
        const writer = makeHarness();

        await writer.registerTool({
            name: 'withHelper',
            moduleText:
                "import { join } from './helper'; export const metadata = { name: 'withHelper', description: 'uses helper', tags: ['test'] }; export const execute = () => join('a', 'b');",
            dependencies: [
                {
                    path: 'helper.ts',
                    text: "export const join = (left: string, right: string): string => `${left}/${right}`;"
                }
            ]
        });

        const source = writer.toolSource('withHelper');
        expect(source?.dependencies).toEqual([
            {
                path: 'helper.ts',
                text: "export const join = (left: string, right: string): string => `${left}/${right}`;"
            }
        ]);
        await expect(writer.executeTool('withHelper', {})).resolves.toBe('a/b');
    });

    it('executes the schema/implementation offered to a request even when it is replaced in flight', async () => {
        let writer: ReturnType<typeof harness>;
        const requests: HarnessStreamRequest[] = [];

        const targetV1 = tool({
            name: 'captured',
            description: 'v1',
            tags: ['capture'],
            visibility: 'core',
            parameters: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
                additionalProperties: false
            },
            execute: ({ parameters }) => `v1:${parameters}`
        });

        const stream: HarnessStream = async function* (request) {
            requests.push(request);

            if (requests.length === 1) {
                // Replace BEFORE the provider returns the tool call. The request
                // already captured V1, so the returned call must execute V1.
                await writer.registerTool({
                    name: 'captured',
                    description: 'v2',
                    tags: ['capture'],
                    visibility: 'core',
                    parameters: {
                        type: 'object',
                        properties: { value: { type: 'number' } },
                        required: ['value'],
                        additionalProperties: false
                    },
                    moduleText: moduleFor({
                        name: 'captured',
                        description: 'v2',
                        parameters: {
                            type: 'object',
                            properties: { value: { type: 'number' } },
                            required: ['value'],
                            additionalProperties: false
                        },
                        body: "return 'v2:' + context.parameters;"
                    })
                });
                yield callTool('c1', 'captured', '{"value":"old"}')[0];
                return;
            }

            if (requests.length === 2) {
                yield callTool('c2', 'captured', '{"value":7}')[0];
                return;
            }

            yield answer('done')[0];
            yield answer('done')[1];
        };

        writer = harness({
            agents: { writer: agent({ model: 'test/model', stream }) },
            tools: { captured: targetV1 },
            presets: false
        });

        const message = await writer('go');

        expect(message.content).toBe('done');
        expect(writer.tools.captured.description).toBe('v2');
        // First call retained V1; the later request captured V2.
        const toolContents = writer.agent.messages
            .filter((entry) => entry.role === 'tool')
            .map((entry) => (entry as { content: string }).content);
        expect(toolContents).toEqual(['v1:old', 'v2:7']);
    });

    it('keeps an already-scheduled call on its captured implementation while later calls use the replacement', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let started!: () => void;
        const startedGate = new Promise<void>((resolve) => {
            started = resolve;
        });
        let calls = 0;

        const slow = tool({
            name: 'slow',
            description: 'slow v1',
            tags: ['slow'],
            visibility: 'core',
            execute: async () => {
                calls++;
                started();
                await gate;
                return 'slow-v1';
            }
        });

        const stream = scripted([
            callTool('c1', 'slow', '{}'),
            callTool('c2', 'slow', '{}'),
            answer('finished')
        ]);

        const writer = harness({
            agents: { writer: brain(stream) },
            tools: { slow },
            presets: false
        });

        const run = writer('go');
        await startedGate;

        // Replace while V1 is still in flight. The scheduled call keeps V1; the
        // next request declares/executes V2.
        await writer.registerTool({
            name: 'slow',
            description: 'slow v2',
            tags: ['slow'],
            visibility: 'core',
            moduleText: moduleFor({
                name: 'slow',
                description: 'slow v2',
                tags: ['slow'],
                body: "return 'slow-v2';"
            })
        });
        release();

        const message = await run;

        expect(message.content).toBe('finished');
        expect(calls).toBe(1);
        expect(writer.tools.slow.description).toBe('slow v2');
        const toolContents = writer.agent.messages
            .filter((entry) => entry.role === 'tool')
            .map((entry) => (entry as { content: string }).content);
        expect(toolContents).toEqual(['slow-v1', 'slow-v2']);
    });

    it('restores captured source revisions and validates every restore candidate before mutation', async () => {
        const writer = makeHarness();

        await writer.registerTool({
            name: 'survivor',
            moduleText: moduleFor({
                name: 'survivor',
                body: "return context.harness.memory.get('kept') ?? 'restored';"
            })
        });
        writer.memory.set('kept', 'memory-stays');

        const snapshot = writer.snapshot();
        expect(snapshot.createdTools.map((entry) => entry.name)).toEqual(['survivor']);
        expect(snapshot.createdTools[0].moduleText).toContain("metadata =");
        expect(snapshot.createdToolCount).toBe(1);

        const restored = makeHarness();
        restored.restore(snapshot);
        await expect(restored.executeTool('survivor', {})).resolves.toBe('restored');

        // A bad later snapshot must not replace a working one.
        const broken = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
        broken.createdTools[0].moduleText = 'export const execute = (;';
        const before = restored.tools.survivor;
        const beforeSource = restored.toolSource('survivor');

        expect(() => restored.restore(broken)).toThrow(/could not be transpiled/);
        expect(restored.tools.survivor).toBe(before);
        expect(restored.toolSource('survivor')).toEqual(beforeSource);
    });

    it('leaves a working toolRegistry installed when its replacement fails to compile', async () => {
        const writer = makeHarness();
        const before = writer.tools.toolRegistry;

        await expect(
            writer.registerTool({
                name: 'toolRegistry',
                moduleText: 'export const execute = ;'
            })
        ).rejects.toThrow(/could not be transpiled/);

        expect(writer.tools.toolRegistry).toBe(before);
        const registered = await writer.executeTool('toolRegistry', {
            name: 'stillWorks',
            moduleText: moduleFor({ name: 'stillWorks', body: "return 'ok';" })
        });
        expect(registered).toMatchObject({ name: 'stillWorks', created: true });
    });

    it('allows replacing built-in and previously reserved names without a special prohibition', async () => {
        const writer = harness({ agents: { writer: brain(scripted([answer('ok')])) } });

        // The configured model-facing built-ins are ordinary source/definition
        // registrations now. Replacing toolRequest and fileRead must publish.
        const replacedRequest = await writer.registerTool({
            name: 'toolRequest',
            moduleText: moduleFor({ name: 'toolRequest', body: "return { brand: 'replacement' };" })
        });
        expect(replacedRequest.replaced).toBe(true);
        await expect(writer.executeTool('toolRequest', { tags: ['x'] })).resolves.toEqual({
            brand: 'replacement'
        });

        const replacedFileRead = await writer.registerTool({
            name: 'fileRead',
            description: 'replacement reader',
            tags: ['files'],
            moduleText: moduleFor({ name: 'fileRead', body: "return 'replacement-reader';" })
        });
        expect(replacedFileRead.replaced).toBe(true);
        expect(writer.tools.fileRead.description).toBe('replacement reader');
        await expect(writer.executeTool('fileRead', [])).resolves.toBe('replacement-reader');
    });

    it('registers configuration.toolSources after the baseline and before configured tool overrides', async () => {
        const sourced = harness({
            agents: { writer: brain(scripted([answer('ok')])) },
            toolSources: { customList: 'tools/files/fileList.tool.ts' }
        });

        expect(sourced.toolSource('customList')?.sourcePath).toBe('tools/files/fileList.tool.ts');
        expect(sourced.tools.customList.name).toBe('customList');
        await expect(
            sourced.executeTool('customList', ['not-a-real-directory'])
        ).rejects.toThrow();

        // A configured Tool of the same name is a LATER registration and wins.
        const override = tool({
            description: 'Configured override.',
            tags: ['files'],
            execute: () => 'override'
        });
        const overridden = harness({
            agents: { writer: brain(scripted([answer('ok')])) },
            toolSources: { customList: 'tools/files/fileList.tool.ts' },
            tools: { customList: override }
        });

        expect(overridden.tools.customList.description).toBe('Configured override.');
        expect(overridden.toolSource('customList')).toBeUndefined();
        await expect(overridden.executeTool('customList', {})).resolves.toBe('override');
    });

    it('compiles webSearch/webFetch as source entries while credentials stay harness-owned', async () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('ok')])) },
            websearch: {
                env: { EXA_API_KEY: 'test-exa-key', TAVILY_API_KEY: 'test-tavily-key' }
            },
            webfetch: { env: {} }
        });

        expect(writer.toolSource('webSearch')?.sourcePath).toBe('tools/runtime/webSearch.tool.ts');
        expect(writer.toolSource('webFetch')?.sourcePath).toBe('tools/runtime/webFetch.tool.ts');

        // Dynamic per-harness provider surface is supplied as registration
        // metadata; no key appears in the captured source.
        const searchProperties = (
            writer.tools.webSearch.parameters as { properties: Record<string, unknown> }
        ).properties;
        expect(Object.keys(searchProperties)).toContain('provider');
        const fetchProperties = (
            writer.tools.webFetch.parameters as { properties: Record<string, unknown> }
        ).properties;
        expect(Object.keys(fetchProperties)).toEqual(['url', 'format']);

        for (const record of [writer.toolSource('webSearch'), writer.toolSource('webFetch')]) {
            expect(record?.moduleText).not.toContain('test-exa-key');
            expect(record?.moduleText).not.toContain('EXA_API_KEY');
            expect(record?.moduleText).not.toContain('TAVILY_API_KEY');
        }
    });

    it('does not mutate a configured shared Tool name and validates definition contracts', async () => {
        const shared = tool({
            description: 'Shared.',
            tags: ['test'],
            execute: () => 'shared'
        });
        const originalName = shared.name;

        const writer = harness({
            agents: { writer: brain(scripted([answer('ok')])) },
            tools: { renamed: shared }
        });

        expect(shared.name).toBe(originalName);
        expect(writer.tools.renamed).not.toBe(shared);
        expect(writer.tools.renamed.name).toBe('renamed');
        await expect(writer.executeTool('renamed', {})).resolves.toBe('shared');

        expect(() =>
            harness({
                agents: { writer: brain(scripted([answer('ok')])) },
                tools: {
                    'not a wire name': {
                        description: 'Broken.',
                        tags: ['test'],
                        visibility: 'searchable',
                        execute: () => 'broken'
                    } as never
                }
            })
        ).toThrow(/is not valid/);

        expect(() =>
            harness({
                agents: { writer: brain(scripted([answer('ok')])) },
                tools: {
                    brokenSchema: {
                        name: 'brokenSchema',
                        description: 'Broken.',
                        tags: ['test'],
                        visibility: 'searchable',
                        parameters: [] as never,
                        execute: () => 'broken'
                    } as never
                }
            })
        ).toThrow(/parameters must be a JSON Schema object/);
    });

    it('keeps baseline replacements runtime-only while restoring enabled names and discards stale source records', async () => {
        const writer = harness({ agents: { writer: brain(scripted([answer('ok')])) } });

        await writer.registerTool({
            name: 'fileList',
            description: 'runtime replacement',
            tags: ['files', 'list'],
            moduleText: moduleFor({ name: 'fileList', body: "return 'runtime-only';" })
        });
        await writer.executeTool('toolRequest', { tags: ['files', 'list'] });
        expect(writer.discoveredTools).toContain('fileList');
        expect(writer.toolSource('fileList')?.moduleText).toContain('runtime-only');

        const snapshot = writer.snapshot();
        expect(snapshot.createdTools).toEqual([]);

        const restored = harness({ agents: { writer: brain(scripted([answer('ok')])) } });
        restored.restore(snapshot);

        // The name stays enabled/restorable; the replacement itself is
        // runtime-only, so the fresh baseline implementation is loaded.
        expect(restored.discoveredTools).toContain('fileList');
        expect(restored.toolSource('fileList')?.sourcePath).toBe('tools/files/fileList.tool.ts');
        expect(restored.tools.fileList.description).not.toBe('runtime replacement');

        // Restoring a snapshot that does not contain a created tool removes both
        // the registry entry and its captured source record.
        const clean = restored.snapshot();
        await restored.registerTool({
            name: 'ephemeral',
            moduleText: moduleFor({ name: 'ephemeral', body: "return 'gone';" })
        });
        expect(restored.toolSource('ephemeral')).toBeDefined();
        restored.restore(clean);
        expect(restored.tools.ephemeral).toBeUndefined();
        expect(restored.toolSource('ephemeral')).toBeUndefined();
    });

    it('prepares conditional thread tools before restore mutates state', () => {
        const writer = harness({ agents: { writer: brain(scripted([answer('ok')])) } });
        writer.createThread('writer');
        const snapshot = writer.snapshot();

        const restored = harness({ agents: { writer: brain(scripted([answer('ok')])) } });
        expect(restored.tools.threadSend).toBeUndefined();
        restored.restore(snapshot);

        expect(restored.tools.threadSend).toBeDefined();
        expect(restored.tools.threadList).toBeDefined();
        expect(restored.toolSource('threadSend')?.sourcePath).toBe('tools/runtime/threadSend.tool.ts');
        expect(restored.toolSource('threadList')?.sourcePath).toBe('tools/runtime/threadList.tool.ts');
    });

    it('prepares baseline thread tools when a target-created control is absent from the snapshot', async () => {
        const source = harness({ agents: { writer: brain(scripted([answer('ok')])) } });
        source.createThread('writer');
        const snapshot = source.snapshot();

        const target = harness({ agents: { writer: brain(scripted([answer('ok')])) } });
        await target.registerTool({
            name: 'threadList',
            description: 'target-created control',
            tags: ['threads'],
            moduleText: moduleFor({
                name: 'threadList',
                description: 'target-created control',
                body: "return { replaced: true };"
            })
        });
        expect(target.toolSource('threadList')?.moduleText).toContain('replaced');

        target.restore(snapshot);

        // Phase 4 deleted the target-created entry; the pre-prepared baseline
        // source must have been published, with no stale target record.
        expect(target.tools.threadList.description).not.toBe('target-created control');
        expect(target.toolSource('threadList')?.sourcePath).toBe('tools/runtime/threadList.tool.ts');
        expect(target.toolSource('threadSend')?.sourcePath).toBe('tools/runtime/threadSend.tool.ts');

        const roster = (await target.executeTool('threadList', {})) as {
            threads: Array<{ id: string }>;
        };
        expect(roster.threads.map((thread) => thread.id)).toEqual([
            'agent:writer',
            snapshot.threads?.[0].id
        ]);
    });
});

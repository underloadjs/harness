// agentManage / agentResult (R3) — session-wide agent result inspection.
//
// Contract pinned here:
//   - both are ALWAYS-registered core tools, declared to the primary AND to
//     subagents, and their wire names are reserved;
//   - agentManage lists EVERY configured agent (even one that never ran) with
//     only truncated previews of recent invocations;
//   - agentResult reads one completed answer by agent (latest finished when no
//     invocationId is given) and pages long text explicitly, so the harness's
//     64 KiB result cap never silently truncates a full result;
//   - subagent and fork results are available without reading the owner's
//     transcript;
//   - no system prompt, transcript message, tool argument, or tool body is ever
//     exposed: only the completed assistant answer value is recorded.

import { describe, expect, it, vi } from 'vitest';
import { agent, harness, tool } from '@underload/harness';
import type {
    Agent,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest
} from '@underload/harness';

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

// Route a stream by the REQUEST content instead of a global call counter: a
// fork consumes the same transport as its source, so transcript-based routing is
// the only deterministic way to tell "this is the branch's own user task" from
// "this is the root's next turn".
const routed = (route: (request: HarnessStreamRequest) => HarnessStreamEvent[]): HarnessStream =>
    async function* stream(request) {
        for (const frame of route(request)) {
            yield frame;
        }
    };

const latestUser = (request: HarnessStreamRequest): string => {
    for (let index = request.messages.length - 1; index >= 0; index--) {
        const message = request.messages[index];
        if (message.role === 'user') return message.content;
    }
    return '';
};

const hasForkResult = (request: HarnessStreamRequest): boolean =>
    request.messages.some(
        (message) =>
            message.role === 'tool' &&
            message.name === 'threadFork' &&
            message.content.includes('fork result')
    );

const CORE_DECLARATIONS = [
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
    'agentResult'
];

describe('agentManage / agentResult registration', () => {
    it('declares both core tools to the primary and to subagents', async () => {
        const seenLead: HarnessStreamRequest[] = [];
        const seenHelper: HarnessStreamRequest[] = [];

        const helper = brain(scripted([answer('helper result')], seenHelper));
        const lead = brain(
            scripted(
                [
                    callTool('c1', 'agentDelegate', '{"agent":"helper","input":"help"}'),
                    answer('lead result')
                ],
                seenLead
            )
        );

        const writer = harness({ agents: { lead, helper }, presets: false });
        await writer('go');

        expect(writer.tools.agentManage.visibility).toBe('core');
        expect(writer.tools.agentResult.visibility).toBe('core');
        expect(writer.tools.agentManage.tags).toEqual([
            'agents',
            'results',
            'preview',
            'subagent',
            'team',
            'inspect'
        ]);
        expect(writer.tools.agentResult.tags).toEqual([
            'agents',
            'result',
            'answer',
            'output',
            'subagent',
            'inspect'
        ]);

        expect(declaredNames(seenLead[0])).toEqual([
            ...CORE_DECLARATIONS,
            'agentDelegate',
            'threadFork'
        ]);
        expect(declaredNames(seenHelper[0])).toEqual([...CORE_DECLARATIONS, 'threadFork']);
    });

    it('lets other tool sources replace agentManage and agentResult (no reserved names)', async () => {
        for (const name of ['agentManage', 'agentResult']) {
            const clash = tool({ description: 'Mine.', tags: ['mine'], execute: () => 'ok' });

            const writer = harness({
                agents: { writer: brain(scripted([answer('hi')])) },
                tools: { [name]: clash },
                presets: false
            });

            expect(writer.tools[name]).not.toBe(clash);
            expect(writer.tools[name].description).toBe('Mine.');
            await expect(writer.executeTool(name, {})).resolves.toBe('ok');
        }
    });

    it('publishes the exact empty-argument listing schema and the paged result schema', () => {
        const writer = harness({ agents: { writer: brain(scripted([answer('hi')])) }, presets: false });

        expect(writer.tools.agentManage.parameters).toEqual({
            type: 'object',
            properties: {},
            additionalProperties: false
        });

        expect(writer.tools.agentResult.parameters).toEqual({
            type: 'object',
            properties: {
                agent: {
                    type: 'string',
                    minLength: 1,
                    description: 'Configured agent name whose result to read.'
                },
                invocationId: {
                    type: 'string',
                    minLength: 1,
                    description:
                        "Invocation id from agentManage. Omit to read that agent's latest completed result."
                },
                offset: {
                    type: 'integer',
                    minimum: 0,
                    description:
                        '0-based character offset into the result. Defaults to 0; use nextOffset from the previous page.'
                },
                limit: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 8000,
                    description: 'Page size in characters, 1-8000. Defaults to 4000.'
                }
            },
            required: ['agent'],
            additionalProperties: false
        });
    });
});

describe('agentManage', () => {
    it('lists every configured agent with previews and no private transcript data', async () => {
        const helper = brain(scripted([answer('helper result')]), {
            instruction: 'HELPER-SYSTEM-SECRET'
        });
        const lead = brain(
            scripted([
                callTool('c1', 'agentDelegate', '{"agent":"helper","input":"help"}'),
                answer('lead result')
            ]),
            { instruction: 'LEAD-SYSTEM-SECRET' }
        );

        const writer = harness({ agents: { lead, helper }, presets: false });
        await writer('go');

        const listed = await writer.executeTool('agentManage', {});

        expect(listed).toEqual({
            agents: [
                {
                    name: 'lead',
                    role: 'primary',
                    model: 'merge/ds4-flash',
                    invocationCount: 1,
                    results: [
                        {
                            invocationId: '1',
                            kind: 'root',
                            status: 'completed',
                            contentLength: 11,
                            preview: 'lead result',
                            truncated: false
                        }
                    ]
                },
                {
                    name: 'helper',
                    role: 'subagent',
                    model: 'merge/ds4-flash',
                    invocationCount: 1,
                    results: [
                        {
                            invocationId: '2',
                            kind: 'delegation',
                            status: 'completed',
                            contentLength: 13,
                            preview: 'helper result',
                            truncated: false
                        }
                    ]
                }
            ],
            totalResults: 2,
            activeResults: 0,
            truncated: false
        });

        const serialized = JSON.stringify(listed);
        expect(serialized).not.toContain('LEAD-SYSTEM-SECRET');
        expect(serialized).not.toContain('HELPER-SYSTEM-SECRET');
        expect(serialized).not.toContain('{"agent":"helper"');
    });

    it('truncates a long preview while agentResult still returns the exact full answer', async () => {
        const long = 'A'.repeat(250);

        const writer = harness({
            agents: { writer: brain(scripted([answer(long)]), { instruction: 'PROMPT-SECRET' }) },
            presets: false
        });
        await writer('go');

        const listed = await writer.executeTool('agentManage', {});

        expect(listed).toEqual({
            agents: [
                {
                    name: 'writer',
                    role: 'primary',
                    model: 'merge/ds4-flash',
                    invocationCount: 1,
                    results: [
                        {
                            invocationId: '1',
                            kind: 'root',
                            status: 'completed',
                            contentLength: 250,
                            preview: `${'A'.repeat(200)}…`,
                            truncated: true
                        }
                    ]
                }
            ],
            totalResults: 1,
            activeResults: 0,
            truncated: false
        });

        expect(JSON.stringify(listed)).not.toContain(long);
        expect(JSON.stringify(listed)).not.toContain('PROMPT-SECRET');

        expect(await writer.executeTool('agentResult', { agent: 'writer' })).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: long,
            contentLength: 250,
            offset: 0,
            limit: 4000,
            hasMore: false
        });
    });

    it('only exposes the completed answer, never a tool body', async () => {
        const secretTool = tool({
            description: 'Return a secret.',
            tags: ['test'],
            visibility: 'core',
            execute: () => 'TOOL-BODY-SECRET'
        });

        const writer = harness({
            agents: {
                writer: brain(
                    scripted([callTool('c1', 'secretTool', '{}'), answer('safe answer')]),
                    { instruction: 'PROMPT-SECRET' }
                )
            },
            tools: { secretTool },
            presets: false
        });
        await writer('go');

        const listed = JSON.stringify(await writer.executeTool('agentManage', {}));
        const result = JSON.stringify(await writer.executeTool('agentResult', { agent: 'writer' }));

        expect(listed).not.toContain('TOOL-BODY-SECRET');
        expect(result).not.toContain('TOOL-BODY-SECRET');
        expect(listed).not.toContain('PROMPT-SECRET');
        expect(result).not.toContain('PROMPT-SECRET');
        expect(result).toContain('safe answer');
    });
});

describe('agentResult', () => {
    it('pages a long result explicitly instead of letting the 64 KiB cap truncate it', async () => {
        const long = 'A'.repeat(9000);

        const writer = harness({
            agents: { writer: brain(scripted([answer(long)])) },
            presets: false
        });
        await writer('go');

        const first = await writer.executeTool('agentResult', { agent: 'writer' });

        expect(first).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: 'A'.repeat(4000),
            contentLength: 9000,
            offset: 0,
            limit: 4000,
            hasMore: true,
            nextOffset: 4000
        });

        const second = await writer.executeTool('agentResult', {
            agent: 'writer',
            offset: 4000
        });

        expect(second).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: 'A'.repeat(4000),
            contentLength: 9000,
            offset: 4000,
            limit: 4000,
            hasMore: true,
            nextOffset: 8000
        });

        const third = await writer.executeTool('agentResult', {
            agent: 'writer',
            offset: 8000
        });

        expect(third).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: 'A'.repeat(1000),
            contentLength: 9000,
            offset: 8000,
            limit: 4000,
            hasMore: false
        });

        expect(
            [first, second, third]
                .map((page) => (page as { content: string }).content)
                .join('')
        ).toBe(long);

        // A caller may narrow the page; nextOffset remains exact.
        expect(
            await writer.executeTool('agentResult', {
                agent: 'writer',
                offset: 7,
                limit: 3
            })
        ).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: 'AAA',
            contentLength: 9000,
            offset: 7,
            limit: 3,
            hasMore: true,
            nextOffset: 10
        });

        // The advertised maximum is enforced by the shared argument gate.
        await expect(
            writer.executeTool('agentResult', { agent: 'writer', limit: 8001 })
        ).rejects.toThrow('$.limit must be <= 8000.');
    });

    it('reads a submitted invocation by id and reports an unknown id as an error', async () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('one')])) },
            presets: false
        });
        await writer('go');

        expect(
            await writer.executeTool('agentResult', {
                agent: 'writer',
                invocationId: '1'
            })
        ).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: 'one',
            contentLength: 3,
            offset: 0,
            limit: 4000,
            hasMore: false
        });

        await expect(
            writer.executeTool('agentResult', { agent: 'writer', invocationId: 'missing' })
        ).rejects.toThrow('No result "missing" is available for agent "writer".');

        await expect(writer.executeTool('agentResult', { agent: 'ghost' })).rejects.toThrow(
            'Agent "ghost" is not registered. Configured agents: writer.'
        );
    });

    it('returns an empty state before any run and an empty completed answer exactly', async () => {
        const fresh = harness({
            agents: { writer: brain(scripted([answer('unused')])) },
            presets: false
        });

        expect(await fresh.executeTool('agentResult', { agent: 'writer' })).toEqual({
            agent: 'writer',
            status: 'empty',
            content: '',
            contentLength: 0,
            offset: 0,
            limit: 4000,
            hasMore: false
        });

        const blank = harness({
            agents: { writer: brain(scripted([answer('')])) },
            presets: false
        });
        await blank('go');

        expect(await blank.executeTool('agentResult', { agent: 'writer' })).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: '',
            contentLength: 0,
            offset: 0,
            limit: 4000,
            hasMore: false
        });
    });

    it('reports a failed invocation without inventing content', async () => {
        const writer = harness({
            agents: {
                writer: brain(
                    scripted([[{ type: 'error', message: 'transport exploded' }]])
                )
            },
            presets: false
        });

        await expect(writer('go')).rejects.toThrow('transport exploded');

        expect(await writer.executeTool('agentResult', { agent: 'writer' })).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'failed',
            content: '',
            contentLength: 0,
            offset: 0,
            limit: 4000,
            hasMore: false,
            error: 'transport exploded'
        });
    });

    it('retains results when only an agent transcript is reset (server new-turn path)', async () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('one')])) },
            presets: false
        });
        await writer('go');

        // sessions.ts starts a new block with Agent.reset(), NOT harness.reset();
        // the result archive is session state and must survive that.
        writer.agent.reset();

        expect(await writer.executeTool('agentResult', { agent: 'writer' })).toMatchObject({
            status: 'completed',
            content: 'one'
        });
    });

    it('clears every result on reset()', async () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('one')])) },
            presets: false
        });
        await writer('go');
        expect(await writer.executeTool('agentResult', { agent: 'writer' })).toMatchObject({
            status: 'completed',
            content: 'one'
        });

        writer.reset();

        expect(await writer.executeTool('agentManage', {})).toEqual({
            agents: [
                {
                    name: 'writer',
                    role: 'primary',
                    model: 'merge/ds4-flash',
                    invocationCount: 0,
                    results: []
                }
            ],
            totalResults: 0,
            activeResults: 0,
            truncated: false
        });
        expect(await writer.executeTool('agentResult', { agent: 'writer' })).toEqual({
            agent: 'writer',
            status: 'empty',
            content: '',
            contentLength: 0,
            offset: 0,
            limit: 4000,
            hasMore: false
        });
    });
});

describe('subagent and fork results', () => {
    it('makes a delegated subagent result readable by agent and invocation id', async () => {
        const helper = brain(scripted([answer('helper result')]));
        const lead = brain(
            scripted([
                callTool('c1', 'agentDelegate', '{"agent":"helper","input":"help"}'),
                answer('lead final')
            ])
        );

        const writer = harness({ agents: { lead, helper }, presets: false });
        await writer('go');

        expect(await writer.executeTool('agentResult', { agent: 'helper' })).toEqual({
            agent: 'helper',
            invocationId: '2',
            kind: 'delegation',
            status: 'completed',
            content: 'helper result',
            contentLength: 13,
            offset: 0,
            limit: 4000,
            hasMore: false
        });
    });

    it('makes a threadFork branch result readable while the root answer stays latest', async () => {
        const lead = brain(
            routed((request) => {
                // The fork reads the parent snapshot plus its own task; the root
                // never sees that user message.
                if (latestUser(request) === 'investigate') return answer('fork result');

                // Root's turn after the branch result has been delivered.
                if (hasForkResult(request)) return answer('lead final');

                // Root's first turn: ask for one fork.
                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return callTool('f1', 'threadFork', '{"input":"investigate"}');
                }

                // A tool-free pause while the branch is still running; the
                // completion drives the next root turn.
                return answer('waiting');
            })
        );

        const writer = harness({ agents: { lead }, presets: false });
        await writer('go');

        // The branch id is runtime-generated (module sequence), so read it from
        // the audit record instead of hardcoding it.
        const branchId = writer.branches()[0].branchId;

        expect(
            await writer.executeTool('agentResult', { agent: 'lead', invocationId: branchId })
        ).toEqual({
            agent: 'lead',
            invocationId: branchId,
            kind: 'fork',
            status: 'completed',
            content: 'fork result',
            contentLength: 11,
            offset: 0,
            limit: 4000,
            hasMore: false
        });

        // Without an id, the agent's latest FINISHED answer is the root's final
        // turn, not the fork that finished earlier.
        expect(await writer.executeTool('agentResult', { agent: 'lead' })).toEqual({
            agent: 'lead',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: 'lead final',
            contentLength: 10,
            offset: 0,
            limit: 4000,
            hasMore: false
        });

        const listed = await writer.executeTool('agentManage', {});
        const leadResults = (listed as { agents: Array<{ name: string; results: unknown[] }> }).agents.find(
            (entry) => entry.name === 'lead'
        )!.results;

        expect(leadResults).toEqual([
            {
                invocationId: branchId,
                kind: 'fork',
                status: 'completed',
                contentLength: 11,
                preview: 'fork result',
                truncated: false
            },
            {
                invocationId: '1',
                kind: 'root',
                status: 'completed',
                contentLength: 10,
                preview: 'lead final',
                truncated: false
            }
        ]);
    });
});

describe('result pagination and Unicode boundaries', () => {
    it('never splits a surrogate pair at either page edge', async () => {
        // Length 8 UTF-16 units: A A A [high low] B B B.
        const content = 'AAA😀BBB';

        const writer = harness({
            agents: { writer: brain(scripted([answer(content)])) },
            presets: false
        });
        await writer('go');

        const first = await writer.executeTool('agentResult', {
            agent: 'writer',
            limit: 4
        });

        // The limit would cut the emoji: return only the three A's and advance to
        // the pair boundary instead of emitting half a glyph.
        expect(first).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: 'AAA',
            contentLength: 8,
            offset: 0,
            limit: 4,
            hasMore: true,
            nextOffset: 3
        });

        const second = await writer.executeTool('agentResult', {
            agent: 'writer',
            offset: 3,
            limit: 4
        });

        expect(second).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: '😀BB',
            contentLength: 8,
            offset: 3,
            limit: 4,
            hasMore: true,
            nextOffset: 7
        });

        const third = await writer.executeTool('agentResult', {
            agent: 'writer',
            offset: 7,
            limit: 4
        });

        expect(third).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: 'B',
            contentLength: 8,
            offset: 7,
            limit: 4,
            hasMore: false
        });

        expect(
            [first, second, third].map((page) => (page as { content: string }).content).join('')
        ).toBe(content);

        // An offset INSIDE the pair is moved back to include the whole glyph; the
        // returned offset is the actual one used.
        expect(
            await writer.executeTool('agentResult', {
                agent: 'writer',
                offset: 4,
                limit: 3
            })
        ).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: '😀B',
            contentLength: 8,
            offset: 3,
            limit: 3,
            hasMore: true,
            nextOffset: 6
        });
    });
});

describe('snapshot durability (R3)', () => {
    it('round-trips root, subagent and fork results, and advances ids', async () => {
        const helper = brain(scripted([answer('helper answer')]));

        const lead = brain(
            routed((request) => {
                if (latestUser(request) === 'investigate') return answer('fork answer');

                const delegateResult = request.messages.some(
                    (message) =>
                        message.role === 'tool' &&
                        message.name === 'agentDelegate' &&
                        message.content.includes('helper answer')
                );
                const forkResult = request.messages.some(
                    (message) =>
                        message.role === 'tool' &&
                        message.name === 'threadFork' &&
                        message.content.includes('fork answer')
                );

                if (delegateResult && forkResult) return answer('root final');

                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return [
                        {
                            type: 'done',
                            stopReason: 'tool_calls',
                            toolCalls: [
                                {
                                    id: 'c1',
                                    name: 'agentDelegate',
                                    arguments: '{"agent":"helper","input":"help"}'
                                },
                                {
                                    id: 'f1',
                                    name: 'threadFork',
                                    arguments: '{"input":"investigate"}'
                                }
                            ]
                        }
                    ];
                }

                return answer('waiting');
            })
        );

        const source = harness({ agents: { lead, helper }, presets: false });
        await source('go');

        const branchId = source.branches()[0].branchId;
        const snapshot = source.snapshot();

        // Only terminal records, ordered by run sequence (root, helper, fork).
        expect(snapshot.agentResults).toEqual([
            {
                invocationId: '1',
                sequence: 1,
                completedOrder: 3,
                agent: 'lead',
                role: 'primary',
                kind: 'root',
                status: 'completed',
                content: 'root final'
            },
            {
                invocationId: '2',
                sequence: 2,
                completedOrder: 1,
                agent: 'helper',
                role: 'subagent',
                kind: 'delegation',
                status: 'completed',
                content: 'helper answer'
            },
            {
                invocationId: branchId,
                sequence: 3,
                completedOrder: 2,
                agent: 'lead',
                role: 'primary',
                kind: 'fork',
                status: 'completed',
                content: 'fork answer'
            }
        ]);

        // A fresh harness with the same agent identities restores the archive.
        const target = harness({
            agents: {
                lead: brain(scripted([answer('after')])),
                helper: brain(scripted([answer('unused')]))
            },
            presets: false
        });
        // JSON round-trip mirrors the server's on-disk persistence path.
        target.restore(JSON.parse(JSON.stringify(snapshot)) as never);

        expect(await target.executeTool('agentResult', { agent: 'lead' })).toEqual({
            agent: 'lead',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: 'root final',
            contentLength: 10,
            offset: 0,
            limit: 4000,
            hasMore: false
        });
        expect(await target.executeTool('agentResult', { agent: 'helper' })).toEqual({
            agent: 'helper',
            invocationId: '2',
            kind: 'delegation',
            status: 'completed',
            content: 'helper answer',
            contentLength: 13,
            offset: 0,
            limit: 4000,
            hasMore: false
        });
        expect(
            await target.executeTool('agentResult', { agent: 'lead', invocationId: branchId })
        ).toEqual({
            agent: 'lead',
            invocationId: branchId,
            kind: 'fork',
            status: 'completed',
            content: 'fork answer',
            contentLength: 11,
            offset: 0,
            limit: 4000,
            hasMore: false
        });

        // Round-trip is exact.
        expect(target.snapshot().agentResults).toEqual(snapshot.agentResults);

        // A new run takes sequence 4, so it cannot reuse/overwrite invocation '1'.
        await target('after');
        expect(await target.executeTool('agentResult', { agent: 'lead' })).toEqual({
            agent: 'lead',
            invocationId: '4',
            kind: 'root',
            status: 'completed',
            content: 'after',
            contentLength: 5,
            offset: 0,
            limit: 4000,
            hasMore: false
        });
        expect(
            await target.executeTool('agentResult', { agent: 'lead', invocationId: '1' })
        ).toMatchObject({ content: 'root final' });
    });

    it('persists failed results and restores their error', async () => {
        const source = harness({
            agents: {
                writer: brain(scripted([[{ type: 'error', message: 'transport exploded' }]]))
            },
            presets: false
        });

        await expect(source('go')).rejects.toThrow('transport exploded');

        const snapshot = source.snapshot();
        expect(snapshot.agentResults).toEqual([
            {
                invocationId: '1',
                sequence: 1,
                completedOrder: 1,
                agent: 'writer',
                role: 'primary',
                kind: 'root',
                status: 'failed',
                content: '',
                error: 'transport exploded'
            }
        ]);

        const target = harness({
            agents: { writer: brain(scripted([answer('unused')])) },
            presets: false
        });
        target.restore(snapshot);

        expect(await target.executeTool('agentResult', { agent: 'writer' })).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'failed',
            content: '',
            contentLength: 0,
            offset: 0,
            limit: 4000,
            hasMore: false,
            error: 'transport exploded'
        });
    });

    it('omits a running invocation from a snapshot and persists it once terminal', async () => {
        let release: (() => void) | undefined;

        const hold = tool({
            description: 'Hold until released.',
            tags: ['test'],
            visibility: 'core',
            execute: () =>
                new Promise<string>((resolve) => {
                    release = () => resolve('held');
                })
        });

        const writer = harness({
            agents: {
                writer: brain(scripted([callTool('h1', 'hold', '{}'), answer('late answer')]))
            },
            tools: { hold },
            presets: false
        });

        const pending = writer('go');
        await vi.waitFor(() => expect(release).toBeDefined());

        // A running invocation has no answer; it is omitted rather than fabricated.
        expect(writer.snapshot().agentResults).toBeUndefined();

        release!();
        await pending;

        expect(writer.snapshot().agentResults).toEqual([
            {
                invocationId: '1',
                sequence: 1,
                completedOrder: 1,
                agent: 'writer',
                role: 'primary',
                kind: 'root',
                status: 'completed',
                content: 'late answer'
            }
        ]);
    });

    it('restores an old snapshot without the field and mutates nothing on invalid results', async () => {
        const source = harness({
            agents: { writer: brain(scripted([answer('archived')])) },
            presets: false
        });
        await source('go');
        const snapshot = source.snapshot();

        const legacy = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
        delete legacy.agentResults;

        const fresh = harness({
            agents: { writer: brain(scripted([answer('unused')])) },
            presets: false
        });
        fresh.restore(legacy as never);
        expect(await fresh.executeTool('agentResult', { agent: 'writer' })).toEqual({
            agent: 'writer',
            status: 'empty',
            content: '',
            contentLength: 0,
            offset: 0,
            limit: 4000,
            hasMore: false
        });

        // The target already has a different result. A rejected snapshot must not
        // clear or partially overwrite it.
        const target = harness({
            agents: { writer: brain(scripted([answer('keep')])) },
            presets: false
        });
        await target('go');

        const invalid = JSON.parse(JSON.stringify(snapshot)) as {
            agentResults: Array<Record<string, unknown>>;
        };
        invalid.agentResults[0].status = 'running';

        expect(() => target.restore(invalid as never)).toThrow(
            'snapshot.agentResults[0].status must be one of: completed, failed, cancelled (running is not persisted).'
        );
        expect(await target.executeTool('agentResult', { agent: 'writer' })).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'completed',
            content: 'keep',
            contentLength: 4,
            offset: 0,
            limit: 4000,
            hasMore: false
        });
    });

    it('rejects duplicate ids and over-bound result arrays before mutating', async () => {
        const source = harness({
            agents: { writer: brain(scripted([answer('one')])) },
            presets: false
        });
        await source('go');
        const snapshot = source.snapshot() as Record<string, unknown>;

        const duplicate = JSON.parse(JSON.stringify(snapshot)) as {
            agentResults: Array<Record<string, unknown>>;
        };
        duplicate.agentResults.push({ ...duplicate.agentResults[0] });

        const target = harness({
            agents: { writer: brain(scripted([answer('unused')])) },
            presets: false
        });

        expect(() => target.restore(duplicate as never)).toThrow(
            'snapshot.agentResults contains the duplicate invocationId "1".'
        );

        const overBound = JSON.parse(JSON.stringify(snapshot)) as {
            agentResults: Array<Record<string, unknown>>;
        };
        overBound.agentResults = Array.from({ length: 65 }, (_, index) => ({
            invocationId: `r${index + 1}`,
            sequence: index + 1,
            completedOrder: index + 1,
            agent: 'writer',
            role: 'primary',
            kind: 'root',
            status: 'completed',
            content: 'x'
        }));

        expect(() => target.restore(overBound as never)).toThrow(
            'snapshot.agentResults contains 65 records; at most 64 are retained.'
        );
    });

    it('retains at most 64 results and snapshot restores that bound', async () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('x')])) },
            presets: false
        });

        for (let index = 0; index < 70; index++) await writer(`prompt ${index}`);

        const retained = writer.snapshot().agentResults!;

        expect(retained).toHaveLength(64);
        expect(retained[0]).toMatchObject({ invocationId: '7', sequence: 7 });
        expect(retained.at(-1)).toMatchObject({ invocationId: '70', sequence: 70 });

        await expect(
            writer.executeTool('agentResult', { agent: 'writer', invocationId: '6' })
        ).rejects.toThrow('No result "6" is available for agent "writer".');

        const target = harness({
            agents: { writer: brain(scripted([answer('unused')])) },
            presets: false
        });
        target.restore(writer.snapshot());
        expect(target.snapshot().agentResults).toHaveLength(64);
    });

    it('reserves restored branch ids so a new fork cannot overwrite an archived result', async () => {
        const source = brain(
            routed((request) => {
                if (latestUser(request) === 'archived task') return answer('archived fork');

                if (hasForkResult(request)) return answer('archived root');

                if (!request.messages.some((message) => message.role === 'assistant')) {
                    return callTool('f1', 'threadFork', '{"input":"archived task"}');
                }

                return answer('waiting');
            })
        );

        const first = harness({ agents: { lead: source }, presets: false });
        await first('go');

        const snapshot = first.snapshot();
        const archivedBranch = snapshot.agentResults!.find((result) => result.kind === 'fork')!;
        archivedBranch.invocationId = 'branch-99999';

        const targetStream = routed((request) => {
            if (latestUser(request) === 'new task') return answer('new fork answer');

            const newFork = request.messages.some(
                (message) =>
                    message.role === 'tool' &&
                    message.name === 'threadFork' &&
                    message.content.includes('new fork answer')
            );

            if (newFork) return answer('new root answer');

            const requestedNewFork = request.messages.some(
                (message) =>
                    message.role === 'assistant' &&
                    message.toolCalls?.some((call) => call.id === 'f2')
            );

            // First target turn: ask for exactly one NEW fork (the restored
            // transcript's old fork is already paired and must not suppress this).
            if (!requestedNewFork) return callTool('f2', 'threadFork', '{"input":"new task"}');

            // Tool-free pause until the new branch delivers its result.
            return answer('waiting');
        });

        const target = harness({ agents: { lead: brain(targetStream) }, presets: false });
        target.restore(snapshot);

        expect(
            await target.executeTool('agentResult', {
                agent: 'lead',
                invocationId: 'branch-99999'
            })
        ).toMatchObject({ content: 'archived fork', kind: 'fork' });

        await target('again');

        const newBranchId = target.branches()[0].branchId;
        expect(newBranchId).not.toBe('branch-99999');
        expect(Number(newBranchId.slice('branch-'.length))).toBeGreaterThan(99999);

        // The archived record is still addressable after the new fork.
        expect(
            await target.executeTool('agentResult', {
                agent: 'lead',
                invocationId: 'branch-99999'
            })
        ).toMatchObject({ content: 'archived fork' });
    });
});


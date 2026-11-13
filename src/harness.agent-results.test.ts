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
//   - `archiveInvocation` — the door a LANE result comes through — carries the forensic
//     pair of a stopped run (`partialContent` / `cancelledAtMessage`), refuses a malformed
//     value before it mints an order or writes a row, drops the pair on a completed
//     status, and returns what it stored, which is the record the lane seam digests
//     (review finding #5, issues 0020 + 0033);
//   - no system prompt, transcript message, tool argument, or tool body is ever
//     exposed: only the completed assistant answer value is recorded.

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

// R9-R11: only the discovery bootstrap and the session plan are declared. The
// inspection pair (agentManage/agentResult) is registered and searchable, which
// is why it still reaches both agents — through toolRequest, not a declaration.
const CORE_DECLARATIONS = [
    'toolRequest',
    'tasks'
];

describe('agentManage / agentResult registration', () => {
    it('declares both core tools to the primary and to subagents', async () => {
        const seenLead: HarnessStreamRequest[] = [];
        const seenHelper: HarnessStreamRequest[] = [];

        const helper = brain(scripted([answer('helper result')], seenHelper));
        const lead = brain(
            scripted(
                [
                    callTool('c1', 'delegate', '{"agent":"helper","input":"help"}'),
                    answer('lead result')
                ],
                seenLead
            )
        );

        const writer = harness({ agents: { lead, helper }, presets: false });
        await writer('go');

        expect(writer.tools.agentManage.visibility).toBe('searchable');
        expect(writer.tools.agentResult.visibility).toBe('searchable');
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
            'delegate',
        ]);
        expect(declaredNames(seenHelper[0])).toEqual(CORE_DECLARATIONS);
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
                callTool('c1', 'delegate', '{"agent":"helper","input":"help"}'),
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
                // R1: one attempt (`retry: false`) — this pins the terminal failure
                // path, not the retry sequence.
                writer: brain(
                    scripted([[{ type: 'error', message: 'transport exploded' }]]),
                    { retry: false }
                )
            },
            presets: false
        });

        await expect(writer('go')).rejects.toThrow('transport exploded');

        // T28: a failed run reports its forensic state too. `cancelledAtMessage` is how
        // many messages the run had appended before the rollback removed them, and
        // `durationMs` is the measured span. Both are present only when the run actually
        // got that far, so this pins the shape of a run that failed on its first request.
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
            error: 'transport exploded',
            cancelledAtMessage: 1,
            durationMs: expect.any(Number)
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
                callTool('c1', 'delegate', '{"agent":"helper","input":"help"}'),
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
                        message.name === 'delegate' &&
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
                                    name: 'delegate',
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
        //
        // Every row names its OWNER (`threadId`) — the persistent conversation `purgeThread`'s
        // delete cascade matches on. A default-thread run is owned by `agent:<name>`, and a
        // branch by the conversation that spawned it (0033/0024: the owner is state, so it has to
        // survive the round trip or a conversation deleted after a reload keeps its results).
        expect(snapshot.agentResults).toEqual([
            {
                invocationId: '1',
                sequence: 1,
                completedOrder: 3,
                agent: 'lead',
                role: 'primary',
                kind: 'root',
                status: 'completed',
                content: 'root final',
                threadId: 'agent:lead'
            },
            {
                invocationId: '2',
                sequence: 2,
                completedOrder: 1,
                agent: 'helper',
                role: 'subagent',
                kind: 'delegation',
                status: 'completed',
                content: 'helper answer',
                threadId: 'agent:helper'
            },
            {
                invocationId: branchId,
                sequence: 3,
                completedOrder: 2,
                agent: 'lead',
                role: 'primary',
                kind: 'fork',
                status: 'completed',
                content: 'fork answer',
                threadId: 'agent:lead'
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
                // R1: one attempt — the terminal failure shape is what is pinned here.
                writer: brain(scripted([[{ type: 'error', message: 'transport exploded' }]]), {
                    retry: false
                })
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
                error: 'transport exploded',
                // Issue 0033: the position the run reached is stored with the row, and it
                // travels on its own — this run failed on its first request, so it has a
                // message count and NO `partialContent` key. That asymmetry is the runtime's
                // own (0020's open case), and the reader keeps it rather than pairing the two.
                cancelledAtMessage: 1,
                // The callable root belongs to the agent's DEFAULT conversation, so the row names
                // that owner (`agent:writer`) rather than leaving it out (0033/0024).
                threadId: 'agent:writer'
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
            error: 'transport exploded',
            cancelledAtMessage: 1
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
                content: 'late answer',
                // A completed row may name its owner too — unlike the forensic pair, a finished
                // turn still belongs to the conversation that ran it (0033/0024).
                threadId: 'agent:writer'
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

// ---------------------------------------------------------------------------
// B2 (2026-11-13) — ONE synchronous terminal commit for a finished run
// ---------------------------------------------------------------------------
//
// A run's terminal state is TWO facts: the agent-result ledger entry (`finishInvocation`)
// and the conversation's release back to `idle`. They used to happen in two places with an
// `await` between them, so anything a `run.finished`/`run.failed` handler did in that
// window saw a conversation that had already ANSWERED but was still `running` and still
// held its run slot. Two consequences, both pinned here:
//   - a handler that reaps a finished conversation (`deleteThread`, the way a session
//     frees a thread slot) drew `Thread "…" is running; stop it before deleting it.` even
//     though the run was over;
//   - the read side handed back the NEWEST STARTED record when no finished one was newer,
//     i.e. a `status: 'running'` next to `content: ''` — indistinguishable from "this
//     agent has never said anything", which is why a caller stopped polling a child that
//     had already answered on an earlier turn.
//
// The host thread is the fixture throughout: `deleteThread` refuses an agent's default
// `agent:<name>` conversation by design, so `origin: 'host'` is the only conversation a
// reaper can actually close, and it is also the only one whose removal is observable here.
describe('terminal commit is atomic for a finished run (B2)', () => {
    // A gate the test opens by hand: the run that calls `hold` stays in flight until the
    // assertions below have been made, which is the only way to observe a STARTED record.
    const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void } => {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((accept) => {
            resolve = accept;
        });
        return { promise, resolve };
    };

    // Real timers and an explicit pump: this block is about STATE, not time, so the runs
    // are driven by draining the queue until the roster says what the test needs, and the
    // pump itself asserts the condition so a stuck run fails here rather than later.
    const pump = async (predicate: () => boolean, passes = 60): Promise<void> => {
        for (let index = 0; index < passes && !predicate(); index++) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        expect(predicate()).toBe(true);
    };

    it('a run.finished handler finds the thread idle, and its delete removes the whole conversation', async () => {
        const reaped: { threadId: string; status: string | undefined }[] = [];
        let refusal: string | undefined;
        let reapedId: string | undefined;

        const reaper = {
            name: 'reaper',
            setup: (api) => {
                api.on('run.finished', ({ threadId }) => {
                    if (threadId === undefined || threadId !== reapedId) return;

                    // Observed from INSIDE the hook, which is the window the finding is
                    // about: the record's status at the moment `run.finished` fires.
                    reaped.push({
                        threadId,
                        status: api.threads.list().find((record) => record.id === threadId)?.status
                    });

                    try {
                        api.threads.delete(threadId);
                    } catch (error) {
                        refusal = (error as Error).message;
                    }
                });
            }
        };

        const writer = harness({
            agents: { writer: brain(scripted([answer('done here')])) },
            plugins: [reaper],
            presets: false
        });

        const thread = writer.createThread('writer');
        reapedId = thread.id;

        expect((await writer.sendThreadInput(thread.id, 'go')).content).toBe('done here');

        // THE FIX: at `run.finished` the ledger entry is terminal AND the conversation is
        // released, with no await in between, so the record reads `idle` and the delete is
        // accepted. Before this, `status` was 'running' and `refusal` was the sentence the
        // handler had no way to satisfy — the run it was told about was already over.
        expect(reaped).toEqual([{ threadId: thread.id, status: 'idle' }]);
        expect(refusal).toBeUndefined();

        // And the removal is WHOLE. Record, roster, transcript and the invocation lookup
        // all go together (purgeThread matches `record.threadId` and the roster's own
        // `invocationId`), so "the conversation is gone but its result survives" is now
        // unrepresentable — which is the state a reaping caller could previously be left
        // polling.
        expect(writer.thread(thread.id)).toBeUndefined();
        expect(writer.threads().map((record) => record.id)).toEqual(['agent:writer']);

        expect(await writer.executeTool('agentResult', { agent: 'writer' })).toEqual({
            agent: 'writer',
            status: 'empty',
            content: '',
            contentLength: 0,
            offset: 0,
            limit: 4000,
            hasMore: false
        });

        // The other half of the atomic claim: the harness is still usable afterwards, so a
        // reaped conversation cannot strand the session.
        expect(writer.agent.messages).toEqual([]);
    });

    it('a delete that arrives while the run still holds the conversation refuses on the live run', async () => {
        let refusal: string | undefined;
        let reapedId: string | undefined;

        // `run.started` is the genuinely-live case: the run owns the slot, the record says
        // `running`, and deleting then must still refuse. B2 moved state earlier; it did
        // NOT loosen the live-run guard, and this is the half that proves that.
        const eager = {
            name: 'eager',
            setup: (api) => {
                api.on('run.started', ({ threadId }) => {
                    if (threadId === undefined || threadId !== reapedId) return;

                    try {
                        api.threads.delete(threadId);
                    } catch (error) {
                        refusal = (error as Error).message;
                    }
                });
            }
        };

        const writer = harness({
            agents: { writer: brain(scripted([answer('still here')])) },
            plugins: [eager],
            presets: false
        });

        const thread = writer.createThread('writer');
        reapedId = thread.id;

        expect((await writer.sendThreadInput(thread.id, 'go')).content).toBe('still here');

        expect(refusal).toBe(`Thread "${thread.id}" is running; stop it before deleting it.`);
        expect(writer.thread(thread.id)).toMatchObject({ id: thread.id, status: 'idle' });

        // The refusal left nothing half-removed, so the conversation is still repleasable
        // by the same op once its run is genuinely over.
        expect(writer.deleteThread(thread.id)).toEqual({
            deleted: thread.id,
            removedThreadIds: [thread.id],
            // The turn that had just finished is the lookup the release takes with it — named
            // on the receipt, since `agentResult` for it starts throwing on the next call.
            removedInvocationIds: ['1'],
            removedBranchIds: []
        });
    });

    it('the default result is the newest FINISHED answer, never a run that is still in flight', async () => {
        const gate = deferred<string>();

        // One agent, two conversations: `first` finishes (record 1), `second` is parked
        // inside a tool (record 2). Before B2 the DEFAULT lookup sorted by START order, so
        // `agentResult` with no invocationId returned record 2 with an empty body and a
        // `running` status — the caller read that as "no answer yet" and stopped polling,
        // even though record 1 held the real answer.
        const writerAgent = brain(
            routed((request) => {
                const brief = latestUser(request);

                if (brief.includes('second')) {
                    return request.messages.some((message) => message.name === 'hold')
                        ? answer('second answer')
                        : callTool('h1', 'hold', '{}');
                }

                return answer('first answer');
            })
        );

        // A second agent whose ONLY invocation is in flight: it has no result at all, and
        // the honest answer is the empty state, not a `running` record with an empty body.
        const quietAgent = brain(
            routed((request) =>
                request.messages.some((message) => message.name === 'hold')
                    ? answer('quiet answer')
                    : callTool('h2', 'hold', '{}')
            )
        );

        const hold = tool({
            description: 'Hold until the test releases it.',
            tags: ['test'],
            visibility: 'core',
            execute: () => gate.promise
        });

        const writer = harness({
            agents: { writer: writerAgent, quiet: quietAgent },
            tools: { hold },
            presets: false
        });

        const first = writer.createThread('writer');
        await writer.sendThreadInput(first.id, 'first');
        expect(await writer.executeTool('agentResult', { agent: 'writer' })).toMatchObject({
            invocationId: '1',
            status: 'completed',
            content: 'first answer'
        });

        const second = writer.createThread('writer');
        const quiet = writer.createThread('quiet');

        const secondRun = writer.sendThreadInput(second.id, 'second');
        const quietRun = writer.sendThreadInput(quiet.id, 'hush');

        await pump(() => {
            return (
                writer.thread(second.id)?.status === 'running' &&
                writer.thread(quiet.id)?.status === 'running'
            );
        });

        // The finished answer still wins the default, with the parked run in flight.
        expect(await writer.executeTool('agentResult', { agent: 'writer' })).toMatchObject({
            invocationId: '1',
            status: 'completed',
            content: 'first answer'
        });

        // An agent with only an in-flight run reports the EMPTY state — `status: 'running'`
        // next to `content: ''` was the lie this replaces.
        expect(await writer.executeTool('agentResult', { agent: 'quiet' })).toEqual({
            agent: 'quiet',
            status: 'empty',
            content: '',
            contentLength: 0,
            offset: 0,
            limit: 4000,
            hasMore: false
        });

        // The live invocations are still reported where they belong, and an explicit id
        // still reaches the running record: `agentManage` is the liveness surface, and
        // `agentResult` by id is the address.
        expect(await writer.executeTool('agentManage', {})).toMatchObject({
            totalResults: 3,
            activeResults: 2
        });

        expect(await writer.executeTool('agentResult', { agent: 'quiet', invocationId: '3' })).toMatchObject({
            invocationId: '3',
            kind: 'root',
            status: 'running',
            content: ''
        });

        gate.resolve('released');
        const secondAnswer = await secondRun;
        const quietAnswer = await quietRun;

        expect([secondAnswer.content, quietAnswer.content]).toEqual(['second answer', 'quiet answer']);

        // Completion order decides the default, and every record is terminal again.
        expect(await writer.executeTool('agentResult', { agent: 'writer' })).toMatchObject({
            invocationId: '2',
            status: 'completed',
            content: 'second answer'
        });

        expect(await writer.executeTool('agentResult', { agent: 'quiet' })).toMatchObject({
            invocationId: '3',
            status: 'completed',
            content: 'quiet answer'
        });

        expect(await writer.executeTool('agentManage', {})).toMatchObject({
            totalResults: 3,
            activeResults: 0
        });
    });

    // THE UNTESTED HALF OF THE B2 SELECTOR (`src/harness.ts:3935-3939`):
    // `record = completed[0] ?? recent.find((entry) => entry.status !== 'running')`.
    // The completed branch and the nothing-finished-at-all branch were both pinned; the
    // `??` fallback — an agent whose only FINISHED runs failed or were cancelled — was
    // not, and that is exactly the case the entry's prose used to get wrong (it promised
    // `status: 'empty'` "when that agent has no completed result", which contradicts a
    // fallback that returns that failed record). Pinned here as an exact answer: the
    // NEWEST terminal record, with its own error and forensic fields, never `empty`.
    it('the default selector returns the newest terminal record when nothing completed (B2 fallback)', async () => {
        const gate = deferred<string>();

        // Turn 1 is a transport error (record 1 -> `failed`). Turn 2 parks inside a tool
        // so the host can stop it (record 2 -> `cancelled`). `retry: false` keeps the
        // first run ONE record rather than a retry sequence with several.
        const writerAgent = brain(
            routed((request) => {
                const brief = latestUser(request);

                if (brief.includes('stop')) {
                    return request.messages.some((message) => message.name === 'hold')
                        ? answer('never answered')
                        : callTool('h1', 'hold', '{}');
                }

                return [{ type: 'error', message: 'first transport exploded' }];
            }),
            { retry: false }
        );

        const hold = tool({
            description: 'Hold until the test releases it.',
            tags: ['test'],
            visibility: 'core',
            execute: () => gate.promise
        });

        const writer = harness({ agents: { writer: writerAgent }, tools: { hold }, presets: false });

        const broken = writer.createThread('writer');

        await expect(writer.sendThreadInput(broken.id, 'boom')).rejects.toThrow('first transport exploded');

        // Nothing has COMPLETED, so a caller of the pre-B2-fallback build read `empty`
        // here and gave up. The terminal fallback answers the failed run instead.
        expect(await writer.executeTool('agentResult', { agent: 'writer' })).toMatchObject({
            invocationId: '1',
            status: 'failed',
            error: 'first transport exploded'
        });

        const stopped = writer.createThread('writer');
        const stoppedRun = writer.sendThreadInput(stopped.id, 'stop me');

        await pump(() => writer.thread(stopped.id)?.status === 'running');
        expect(writer.stopThread(stopped.id, 'the host stopped it')).toBe(true);
        await expect(stoppedRun).rejects.toThrow();

        // The NEWEST terminal record wins the default — the cancelled run, not the older
        // failure — because "the last thing that actually finished" is what a caller
        // polling without an id is asking for.
        expect(await writer.executeTool('agentResult', { agent: 'writer' })).toEqual({
            agent: 'writer',
            invocationId: '2',
            kind: 'root',
            status: 'cancelled',
            content: '',
            contentLength: 0,
            offset: 0,
            limit: 4000,
            hasMore: false,
            error: 'the host stopped it',
            cancelledAtMessage: 1,
            durationMs: expect.any(Number)
        });

        // And `empty` keeps its exact, narrow meaning: no finished run at all. The same
        // agent answers `empty` before its first run, which is the only place that status
        // appears for an agent that HAS run.
        const untouched = harness({
            agents: { writer: brain(scripted([answer('unused')])), fresh: brain(scripted([answer('unused')])) },
            presets: false
        });

        expect(await untouched.executeTool('agentResult', { agent: 'fresh' })).toEqual({
            agent: 'fresh',
            status: 'empty',
            content: '',
            contentLength: 0,
            offset: 0,
            limit: 4000,
            hasMore: false
        });

        gate.resolve('released');
    });

    it('invents no invocation identity when the delegate result has no ledger record to point at', () => {
        // This one is pinned against the SOURCE, and the reason is honest: the omitted
        // identity has no reachable trigger inside one process today. A delegated child
        // runs in the child agent's DEFAULT conversation (`agent:<name>`), which
        // `deleteThread` refuses outright, and the requesting run holds its own thread
        // until its pending async work settles — so neither the child's conversation nor
        // an ancestor can be reaped while the delegation is open, and the only other way
        // to lose the record is the 64-record ledger bound. The branch is therefore
        // guarded at the read, and this test is what makes removing the guard a decision
        // rather than an accident.
        const source = readFileSync(fileURLToPath(new URL('./harness.ts', import.meta.url)), 'utf8');

        // Every identity field is a CONDITIONAL spread: an absent record means an absent
        // field, never a placeholder that reads like an address or a status.
        expect(source).toContain('...(record === undefined ? {} : { invocationId: record.invocationId }),');
        expect(source).toContain('...(record?.threadId === undefined ? {} : { threadId: record.threadId }),');
        expect(source).toContain('...(record === undefined ? {} : { status: record.status }),');

        // The fabrication the finding replaced is gone from the CODE: an empty string that
        // READS like an address, so a caller pages `agentResult` with `''` and gets an
        // unrelated result instead of noticing that there is none. Comment lines are
        // excluded because the comment at the commit site QUOTES the old code.
        const codeLines = source
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => !line.startsWith('//') && !line.startsWith('*'));

        expect(codeLines.filter((line) => line.includes("invocationId: ''"))).toEqual([]);

        // `durationMs` keeps its honest fallback: the child's own measurement when the
        // record exists, otherwise the span this call actually spent.
        expect(source).toContain('durationMs: record?.durationMs ?? Math.max(0, Date.now() - startedAt)');
    });
});


// ---------------------------------------------------------------------------
// ISSUE 0033 (2026-11-14) — the forensic partial of an UNFINISHED run survives
// persistence
// ---------------------------------------------------------------------------
//
// `partialContent` and `cancelledAtMessage` are the ONLY surviving account of a
// cancelled or failed run: the transcript rollback in `runAgentCore`'s catch
// (`src/harness.ts:11486`) splices the run's own messages out, so a post-mortem has
// exactly these two fields plus `error`. They were also RUNTIME-ONLY. The snapshot
// projection wrote `content` alone — empty for a non-completed run — and `restore()`
// rebuilt the record without the pair, so the restart took back an answer the caller
// had already been shown. `Temp/t12-verify/probes/t12-snapshot-partial.test.ts`
// measured it on the pre-fix tree (invocationId `2`, the abort door):
//
//   live      content:"half an answer", contentLength:14, partialContent present, cancelledAtMessage:2
//   snapshot  content:"" and NO `partialContent` key
//   restored  content:"", contentLength:0, and NO `partialContent` key
//
// That is the stress report's #5 harm class — "the answer I already relied on is
// gone" — one door further down. The fixtures below reproduce the same two shapes the
// probe used (a committed text turn, then a parked tool for the cancel; a committed
// text turn, then a transport error for the failure) and pin the whole chain with
// exact values: live door, snapshot row, restored door, and re-projection.
//
// The pair also bounds itself, which is why persisting it costs nothing: a terminal
// record holds its answer in exactly ONE of `content` (completed) or `partialContent`
// (unfinished) — `finishInvocation` (`src/harness.ts:3866-3890`) never writes both and
// `archiveInvocation` (`:7194-7196`) keeps the same rule — so the archive's answer-text
// footprint is unchanged and the row count is still capped by AGENT_RESULT_RETENTION
// (64, `src/core/agent-limits.ts:25`). No new size cap was introduced; `content` was
// already stored in full and paged on READ, and this field follows that precedent.
//
// What still does NOT survive, and deliberately: the run's transcript (rolled back),
// its tool calls and tool bodies (0020's leak boundary, 0032), and `durationMs` — a
// wall-clock measurement of the run this process made, not part of 0033's gap, so the
// restored envelopes below assert its ABSENCE rather than inventing a value.
describe('the forensic partial survives persistence (issue 0033)', () => {
    const deferred = <T,>(): { promise: Promise<T>; resolve: (value: T) => void } => {
        let resolve!: (value: T) => void;
        const promise = new Promise<T>((accept) => {
            resolve = accept;
        });
        return { promise, resolve };
    };

    // Real timers, state-driven pump — same convention as the B2 block above.
    const pump = async (predicate: () => boolean, passes = 120): Promise<void> => {
        for (let index = 0; index < passes && !predicate(); index++) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
        expect(predicate()).toBe(true);
    };

    const settle = async (passes = 20): Promise<void> => {
        for (let index = 0; index < passes; index++) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    };

    const rowOf = (snapshot: unknown, invocationId: string) =>
        ((snapshot as { agentResults?: Record<string, unknown>[] }).agentResults ?? []).find(
            (record) => record.invocationId === invocationId
        ) ?? null;

    // The cancelled fixture: ONE committed assistant text turn, then a park inside a
    // hanging sync tool. The abort door is the run's OWN signal — a host `stopThread`
    // reaches the same catch but leaves nothing committed (see the pin at :1571, where a
    // stopped run reports `cancelledAtMessage: 1` with NO partial), so only the signal
    // exercises the pair.
    const cancelledRun = async (): Promise<{
        source: ReturnType<typeof harness>;
        invocationId: string;
        // The host thread this run belongs to — the owner the persisted row has to name, so the
        // assertions below can address it without hardcoding the minted id.
        threadId: string;
        release: () => void;
    }> => {
        const gate = deferred<string>();

        const source = harness({
            agents: {
                writer: brain(
                    routed((request) =>
                        request.messages.some((message) => message.role === 'tool')
                            ? answer('never reached')
                            : [
                                  { type: 'text', delta: 'half an answer' },
                                  ...callTool('h1', 'hold', '{}')
                              ]
                    )
                )
            },
            tools: {
                hold: tool({
                    description: 'Hold until the test releases it.',
                    tags: ['test'],
                    visibility: 'core',
                    execute: () => gate.promise
                })
            },
            presets: false
        });

        const thread = source.createThread('writer');
        const controller = new AbortController();
        const run = source
            .sendThreadInput(thread.id, 'go', { signal: controller.signal })
            .catch((error: Error) => error);

        await pump(() =>
            source.threadMessages(thread.id).some((message) => message.role === 'assistant')
        );

        controller.abort(new Error('operator stop'));
        await run;

        gate.resolve('released');
        await settle();

        return {
            source,
            threadId: thread.id,
            invocationId: String(source.thread(thread.id)?.invocationId ?? ''),
            release: () => undefined
        };
    };

    it('carries a cancelled run partial and its message position through snapshot -> restore', async () => {
        const { source, threadId, invocationId } = await cancelledRun();

        // SURFACE 1 — the live door, the shape the caller was promised.
        expect(await source.executeTool('agentResult', { agent: 'writer', invocationId })).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'cancelled',
            content: 'half an answer',
            contentLength: 14,
            offset: 0,
            limit: 4000,
            hasMore: false,
            error: 'operator stop',
            partialContent: 'half an answer',
            cancelledAtMessage: 2,
            durationMs: expect.any(Number)
        });

        // SURFACE 2 — the persisted row. `content` stays EMPTY (it is the completed
        // answer, and this run never gave one); the partial and its position travel
        // beside the error instead. `threadId` names the conversation that ran it — the
        // same fact `purgeThread`'s cascade matches on, and the one a restart used to
        // lose (0033/0024).
        const snapshot = source.snapshot();

        expect(rowOf(snapshot, invocationId)).toEqual({
            invocationId: '1',
            sequence: 1,
            completedOrder: 1,
            agent: 'writer',
            role: 'primary',
            kind: 'root',
            status: 'cancelled',
            content: '',
            error: 'operator stop',
            partialContent: 'half an answer',
            cancelledAtMessage: 2,
            threadId
        });

        // SURFACE 3 — the restart. JSON on purpose: this is the bytes a server writes
        // under DATABASE_ROOT, so the round trip is proven through the serialiser and the
        // reader, not only through two in-process objects.
        const target = harness({ agents: { writer: brain(scripted([answer('unused')])) }, presets: false });
        target.restore(JSON.parse(JSON.stringify(snapshot)) as never);

        expect(await target.executeTool('agentResult', { agent: 'writer', invocationId })).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'cancelled',
            content: 'half an answer',
            contentLength: 14,
            offset: 0,
            limit: 4000,
            hasMore: false,
            error: 'operator stop',
            partialContent: 'half an answer',
            cancelledAtMessage: 2
        });

        // The restored record re-projects byte-for-byte, so a restart cannot start
        // drifting the archive a second time.
        expect(rowOf(target.snapshot(), invocationId)).toEqual(rowOf(snapshot, invocationId));

        // SURFACE 4 — the owner is the point of persisting it: deleting the conversation AFTER
        // the reload has to take the archived result with it, exactly as the same delete does
        // BEFORE the reload. Before 0033/0024 the restored record had no `threadId`, so
        // `purgeThread`'s predicate (`record.threadId === threadId`) missed it and the row
        // outlived its conversation. Both doors are asserted, in the same run, so the parity is
        // the finding rather than an assumption.
        expect(source.deleteThread(threadId)).toEqual({
            deleted: threadId,
            removedThreadIds: [threadId],
            removedInvocationIds: [invocationId],
            removedBranchIds: []
        });
        expect(target.deleteThread(threadId)).toEqual({
            deleted: threadId,
            removedThreadIds: [threadId],
            removedInvocationIds: [invocationId],
            removedBranchIds: []
        });

        // Neither side keeps a row whose owner is gone, and the reloaded harness reads the id
        // as archived-and-deleted, not as still addressable.
        expect(rowOf(source.snapshot(), invocationId)).toBeNull();
        expect(rowOf(target.snapshot(), invocationId)).toBeNull();
        expect(target.thread(threadId)).toBeUndefined();
    });

    it('carries a failed run partial through snapshot -> restore', async () => {
        // A FAILED terminal state with something committed: the assistant text turn
        // lands, the tool it called throws, and the NEXT request dies on the transport
        // with `retry: false` so the failure is one record, not a retry sequence.
        const source = harness({
            agents: {
                writer: brain(
                    routed((request) =>
                        request.messages.some((message) => message.role === 'tool')
                            ? [{ type: 'error', message: 'transport died mid-run' }]
                            : [
                                  { type: 'text', delta: 'a partial before the crash' },
                                  ...callTool('b1', 'boom', '{}')
                              ]
                    ),
                    { retry: false }
                )
            },
            tools: {
                boom: tool({
                    description: 'Fail loudly.',
                    tags: ['test'],
                    visibility: 'core',
                    execute: () => {
                        throw new Error('tool exploded');
                    }
                })
            },
            presets: false
        });

        const thread = source.createThread('writer');

        await expect(source.sendThreadInput(thread.id, 'go')).rejects.toThrow('transport died mid-run');

        const invocationId = String(source.thread(thread.id)?.invocationId ?? '');

        expect(await source.executeTool('agentResult', { agent: 'writer', invocationId })).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'failed',
            content: 'a partial before the crash',
            contentLength: 26,
            offset: 0,
            limit: 4000,
            hasMore: false,
            error: 'transport died mid-run',
            partialContent: 'a partial before the crash',
            cancelledAtMessage: 3,
            durationMs: expect.any(Number)
        });

        const snapshot = source.snapshot();

        expect(rowOf(snapshot, invocationId)).toEqual({
            invocationId: '1',
            sequence: 1,
            completedOrder: 1,
            agent: 'writer',
            role: 'primary',
            kind: 'root',
            status: 'failed',
            content: '',
            error: 'transport died mid-run',
            partialContent: 'a partial before the crash',
            cancelledAtMessage: 3,
            // The owner travels on a failed row exactly as it does on a cancelled one.
            threadId: thread.id
        });

        const target = harness({ agents: { writer: brain(scripted([answer('unused')])) }, presets: false });
        target.restore(JSON.parse(JSON.stringify(snapshot)) as never);

        expect(await target.executeTool('agentResult', { agent: 'writer', invocationId })).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'failed',
            content: 'a partial before the crash',
            contentLength: 26,
            offset: 0,
            limit: 4000,
            hasMore: false,
            error: 'transport died mid-run',
            partialContent: 'a partial before the crash',
            cancelledAtMessage: 3
        });
    });

    it('restores an OLD-GENERATION agent-result row that never carried the forensic keys', async () => {
        // Compatibility is asserted against DATA, not against this build's own writer:
        // the array below is a literal, typed only as JSON, exactly the row shape every
        // file written before 0033 holds (`error` present, no forensic keys). Both
        // halves of the rule matter: the old row must still VALIDATE, and the reader must
        // not INVENT the keys on the way back out.
        const base = harness({ agents: { writer: brain(scripted([answer('unused')])) }, presets: false });
        const document = base.snapshot() as Record<string, unknown>;

        document.agentResults = [
            {
                invocationId: '1',
                sequence: 1,
                completedOrder: 1,
                agent: 'writer',
                role: 'primary',
                kind: 'root',
                status: 'cancelled',
                content: '',
                error: 'operator stop'
            },
            {
                invocationId: '2',
                sequence: 2,
                completedOrder: 2,
                agent: 'writer',
                role: 'primary',
                kind: 'root',
                status: 'completed',
                content: 'a finished answer'
            }
        ];

        const target = harness({ agents: { writer: brain(scripted([answer('unused')])) }, presets: false });
        target.restore(JSON.parse(JSON.stringify(document)) as never);

        // The old file answers exactly what it always did: the cancelled run reports its
        // error and an empty page, with NO forensic key rather than an empty-string one.
        expect(await target.executeTool('agentResult', { agent: 'writer', invocationId: '1' })).toEqual({
            agent: 'writer',
            invocationId: '1',
            kind: 'root',
            status: 'cancelled',
            content: '',
            contentLength: 0,
            offset: 0,
            limit: 4000,
            hasMore: false,
            error: 'operator stop'
        });
        expect(await target.executeTool('agentResult', { agent: 'writer', invocationId: '2' })).toEqual({
            agent: 'writer',
            invocationId: '2',
            kind: 'root',
            status: 'completed',
            content: 'a finished answer',
            contentLength: 17,
            offset: 0,
            limit: 4000,
            hasMore: false
        });

        // Round-tripping old data does not quietly upgrade it: the keys stay absent, so a
        // file this build reads is also a file the previous build could read back.
        expect(target.snapshot().agentResults).toEqual(document.agentResults);

        // A MIXED-generation array — one row with the pair, one without — validates and
        // restores per row, which is what a store with files from both eras needs.
        const mixed = JSON.parse(JSON.stringify(document)) as {
            agentResults: Array<Record<string, unknown>>;
        };
        mixed.agentResults[0].partialContent = 'half an answer';
        mixed.agentResults[0].cancelledAtMessage = 2;

        const both = harness({ agents: { writer: brain(scripted([answer('unused')])) }, presets: false });
        both.restore(mixed as never);

        expect(await both.executeTool('agentResult', { agent: 'writer', invocationId: '1' })).toMatchObject({
            status: 'cancelled',
            content: 'half an answer',
            contentLength: 14,
            partialContent: 'half an answer',
            cancelledAtMessage: 2
        });
        expect(await both.executeTool('agentResult', { agent: 'writer', invocationId: '2' })).toMatchObject({
            status: 'completed',
            content: 'a finished answer'
        });
        expect(rowOf(both.snapshot(), '2')).not.toHaveProperty('partialContent');
    });

    it('refuses a forensic value the runtime can never write, without touching live state', async () => {
        const base = harness({ agents: { writer: brain(scripted([answer('unused')])) }, presets: false });
        const rowOfStatus = (status: string): Record<string, unknown> => ({
            invocationId: '1',
            sequence: 1,
            completedOrder: 1,
            agent: 'writer',
            role: 'primary',
            kind: 'root',
            status,
            content: '',
            ...(status === 'completed' ? {} : { error: 'operator stop' })
        });

        const restoreWith = (patch: Record<string, unknown>): (() => void) => () => {
            const document = JSON.parse(JSON.stringify(base.snapshot())) as {
                agentResults: Record<string, unknown>[];
            };
            document.agentResults = [patch];

            harness({ agents: { writer: brain(scripted([answer('unused')])) }, presets: false }).restore(
                document as never
            );
        };

        // A writer that stored a blank partial is hand-edited data, not a fact this build
        // produces (`finishInvocation` guards on a non-blank trim, src/harness.ts:3887-3889),
        // and restoring it would answer `partialContent: ""` where the runtime says ABSENT.
        expect(restoreWith({ ...rowOfStatus('cancelled'), partialContent: '' })).toThrow(
            'snapshot.agentResults[0].partialContent must be at least 1 character.'
        );

        expect(restoreWith({ ...rowOfStatus('cancelled'), partialContent: 7 })).toThrow(
            'snapshot.agentResults[0].partialContent must be a string.'
        );

        // `cancelledAtMessage` may be 0 — a run stopped before it appended anything
        // reports zero — but not negative and not fractional.
        expect(restoreWith({ ...rowOfStatus('cancelled'), cancelledAtMessage: 0 })).not.toThrow();
        expect(restoreWith({ ...rowOfStatus('cancelled'), cancelledAtMessage: -1 })).toThrow(
            'snapshot.agentResults[0].cancelledAtMessage must be between 0 and Infinity.'
        );
        expect(restoreWith({ ...rowOfStatus('cancelled'), cancelledAtMessage: 1.5 })).toThrow(
            'snapshot.agentResults[0].cancelledAtMessage must be a safe integer.'
        );

        // The same completed-row rule `error` already enforces: a completed answer has no
        // partial, and a row claiming one is a contradiction, not a redundant field.
        expect(restoreWith({ ...rowOfStatus('completed'), content: 'done', partialContent: 'draft' })).toThrow(
            'snapshot.agentResults[0].partialContent and .cancelledAtMessage must be absent on a completed result.'
        );
        expect(restoreWith({ ...rowOfStatus('completed'), content: 'done', cancelledAtMessage: 4 })).toThrow(
            'snapshot.agentResults[0].partialContent and .cancelledAtMessage must be absent on a completed result.'
        );

        // Nothing above is a PARTIAL accept either: a refused row leaves the harness's own
        // registry exactly as it was (the reader runs before any live state is touched).
        const target = harness({ agents: { writer: brain(scripted([answer('keep')])) }, presets: false });
        await target('go');

        const refused = JSON.parse(JSON.stringify(target.snapshot())) as {
            agentResults: Record<string, unknown>[];
        };
        refused.agentResults[0].partialContent = 'a draft that never was';

        expect(() => target.restore(refused as never)).toThrow(
            'snapshot.agentResults[0].partialContent and .cancelledAtMessage must be absent on a completed result.'
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

        // THE OWNER KEY (0033/0024) is read under the same rules: optional on the row, NEVER
        // blank on a row that carries one — both writers (the snapshot projection and
        // `archiveInvocation`) spread it only when the invocation has a conversation, so a
        // `threadId: ""` on disk is a hand edit, and restoring one would hand `purgeThread`'s
        // cascade predicate an owner that matches no conversation.
        expect(restoreWith({ ...rowOfStatus('cancelled'), threadId: '' })).toThrow(
            'snapshot.agentResults[0].threadId must be at least 1 character.'
        );
        expect(restoreWith({ ...rowOfStatus('cancelled'), threadId: 7 })).toThrow(
            'snapshot.agentResults[0].threadId must be a string.'
        );

        // And, unlike the forensic pair, it is LEGAL on a completed row — a finished turn of a
        // host thread still belongs to that thread — and it survives the restore intact, which is
        // the whole point: the cascade still matches after the reload.
        const ownerKept = harness({
            agents: { writer: brain(scripted([answer('unused')])) },
            presets: false
        });

        ownerKept.restore({
            ...(JSON.parse(JSON.stringify(base.snapshot())) as Record<string, unknown>),
            agentResults: [{ ...rowOfStatus('completed'), content: 'done', threadId: 'thread-9' }]
        } as never);

        expect(rowOf(ownerKept.snapshot(), '1')).toEqual({
            ...rowOfStatus('completed'),
            content: 'done',
            threadId: 'thread-9'
        });
    });
});

// ---------------------------------------------------------------------------
// REVIEW FINDING #5 / issues 0020 + 0033 (2026-11-14) — THE ARCHIVE SEAM ITSELF.
//
// Everything above this block establishes that a STOPPED RUN holds the pair (live reader, persisted
// row, restored row). What it could not say is that an ARCHIVE — the door a lane result comes
// through, and the door `restore()`-then-re-archive pushes through — carries it. Until this change
// `HarnessInvocationArchiveInput` named neither field, so `archiveInvocation` stored `content: ''`
// and nothing else: issue 0020's "significant cancelled child reports no partial content" with NO
// restart involved, because the loss was in this payload.
//
// The rules pinned here are the snapshot reader's own (../core/snapshot.ts:242-298), reused through
// `core/snapshot-validation.ts` rather than re-derived, so an archive can never mint a live record
// the next snapshot cannot reload:
//   * PRESENT means it said something — a value must be a non-blank string, and an integer >= 0;
//   * a malformed value is REFUSED, not coerced, and refused BEFORE anything moves: no record
//     written, no completion order burned (the lane seam turns this throw into a permanent
//     `invalid-mutation`, so a canonical state corrupted on the way would never be repaired);
//   * a `completed` status carries NEITHER field, exactly like `error` — and on a REPLACE it drops
//     the pair the earlier cancellation left behind, because the reader refuses a completed row
//     that holds one;
//   * the RETURNED record carries what was stored, because the lane digests the return value
//     (`lane-authority.ts` → `archiveDigestOf(archived.record)`) and a field the digest covers that
//     the return omits is a lane that re-archives the same row forever.
// ---------------------------------------------------------------------------
describe('the archive seam carries the forensic pair of a stopped run (review #5, 0020 + 0033)', () => {
    // An archive never runs a model, so one scripted turn is the whole fixture.
    const coreOf = () => harness({ agents: { writer: brain(scripted([answer('unused')])) }, presets: false });

    const rowOf = (snapshot: unknown, invocationId: string) =>
        ((snapshot as { agentResults?: Record<string, unknown>[] }).agentResults ?? []).find(
            (record) => record.invocationId === invocationId
        ) ?? null;

    const cancelledArchive = {
        invocationId: '513',
        sequence: 3,
        agent: 'writer',
        role: 'subagent',
        kind: 'delegation',
        status: 'cancelled',
        content: '',
        error: 'The run was cancelled.',
        partialContent: 'half an answer',
        cancelledAtMessage: 2,
        threadId: 'thread-9'
    } as const;

    it('stores the pair on the canonical row AND returns it, which is the record the lane digests', () => {
        const source = coreOf();
        const archived = source.archiveInvocation(cancelledArchive);

        expect(archived.replaced).toBe(false);
        // The whole returned record, key for key. `lane-authority.ts` digests THIS object as the
        // receipt the lane compares against its own derivation, so the pair has to be on it.
        expect(archived.record).toEqual({
            invocationId: '513',
            sequence: 3,
            completedOrder: 1,
            agent: 'writer',
            role: 'subagent',
            kind: 'delegation',
            status: 'cancelled',
            content: '',
            error: 'The run was cancelled.',
            partialContent: 'half an answer',
            cancelledAtMessage: 2
        });

        // And the row the session reads, `/results` serves, and the next snapshot writes.
        expect(rowOf(source.snapshot(), '513')).toEqual({
            invocationId: '513',
            sequence: 3,
            completedOrder: 1,
            agent: 'writer',
            role: 'subagent',
            kind: 'delegation',
            status: 'cancelled',
            content: '',
            error: 'The run was cancelled.',
            partialContent: 'half an answer',
            cancelledAtMessage: 2,
            threadId: 'thread-9'
        });

        // Reloadable in the strictest sense: the persisted form parses and restores unchanged, which
        // is the guarantee the pair has to keep (the reader's `min: 1` / `>= 0` bounds are why the
        // writer refuses anything else rather than tidying it up).
        const reloaded = coreOf();

        reloaded.restore(JSON.parse(JSON.stringify(source.snapshot())) as never);
        expect(rowOf(reloaded.snapshot(), '513')).toEqual(rowOf(source.snapshot(), '513'));
    });

    it('drops the pair on a completed archive, and off the row a completed archive replaces', () => {
        const source = coreOf();

        // A caller that sends `completed` WITH a partial is not refused — the pair simply has no
        // meaning there, exactly as `error` is ignored on a completed status. Storing it would write
        // a row ../core/snapshot.ts refuses to read back, so the whole snapshot would stop loading.
        const completed = source.archiveInvocation({
            ...cancelledArchive,
            status: 'completed',
            content: 'the finished answer',
            error: undefined
        });

        expect(completed.record).toEqual({
            invocationId: '513',
            sequence: 3,
            completedOrder: 1,
            agent: 'writer',
            role: 'subagent',
            kind: 'delegation',
            status: 'completed',
            content: 'the finished answer'
        });
        expect(rowOf(source.snapshot(), '513')).toEqual({
            invocationId: '513',
            sequence: 3,
            completedOrder: 1,
            agent: 'writer',
            role: 'subagent',
            kind: 'delegation',
            status: 'completed',
            content: 'the finished answer',
            threadId: 'thread-9'
        });

        // THE CASE THAT MATTERS: a lane child that is cancelled and then finishes. The first archive
        // stores the pair; the completed one replaces the row, and a spread merge would quietly
        // resurrect the stale partial beside a completed status.
        const staged = coreOf();

        staged.archiveInvocation(cancelledArchive);
        expect(rowOf(staged.snapshot(), '513')?.partialContent).toBe('half an answer');

        staged.archiveInvocation({ ...cancelledArchive, status: 'completed', content: 'the finished answer', error: undefined });

        expect(rowOf(staged.snapshot(), '513')).toEqual({
            invocationId: '513',
            sequence: 3,
            completedOrder: 2,
            agent: 'writer',
            role: 'subagent',
            kind: 'delegation',
            status: 'completed',
            content: 'the finished answer',
            threadId: 'thread-9'
        });
        // Still one row, and the persisted form is one the reader accepts.
        expect((staged.snapshot() as { agentResults?: unknown[] }).agentResults).toHaveLength(1);

        const restored = coreOf();

        restored.restore(JSON.parse(JSON.stringify(staged.snapshot())) as never);
        expect(rowOf(restored.snapshot(), '513')).toEqual(rowOf(staged.snapshot(), '513'));
    });

    it('refuses a malformed pair before anything moves — no row, no burned completion order', () => {
        const source = coreOf();

        // The four malformed shapes, each refused with the snapshot reader's own sentence (so a
        // value that is legal to archive is never illegal to reload).
        expect(() => source.archiveInvocation({ ...cancelledArchive, partialContent: '' })).toThrow(
            'Invocation "513".partialContent must be at least 1 character.'
        );
        expect(() => source.archiveInvocation({ ...cancelledArchive, partialContent: '   ' })).toThrow(
            'Invocation "513".partialContent cannot be blank; a run that said nothing archives no partial at all.'
        );
        expect(() => source.archiveInvocation({ ...cancelledArchive, partialContent: 7 as unknown as string })).toThrow(
            'Invocation "513".partialContent must be a string.'
        );
        expect(() => source.archiveInvocation({ ...cancelledArchive, cancelledAtMessage: -1 })).toThrow(
            'Invocation "513".cancelledAtMessage must be between 0 and Infinity.'
        );
        // A count is a count, not a string.
        expect(() => source.archiveInvocation({ ...cancelledArchive, cancelledAtMessage: '2' as unknown as number })).toThrow(
            'Invocation "513".cancelledAtMessage must be a safe integer.'
        );

        // NONE of the five touched live canonical state: not a record, not a slot, not the ordering
        // counter. `completedOrder` is minted by incrementing harness-owned state, which is why the
        // validation runs above it — a refusal that burned an order would leave `/results` with a
        // gap nobody can explain, and the lane seam retries the same op against the same payload.
        expect(rowOf(source.snapshot(), '513')).toBeNull();
        expect((source.snapshot() as { agentResults?: unknown[] }).agentResults ?? []).toEqual([]);

        const landed = source.archiveInvocation({ ...cancelledArchive, invocationId: '514', sequence: 4 });

        expect(landed.record.completedOrder).toBe(1);
        expect(rowOf(source.snapshot(), '514')).toEqual({
            invocationId: '514',
            sequence: 4,
            completedOrder: 1,
            agent: 'writer',
            role: 'subagent',
            kind: 'delegation',
            status: 'cancelled',
            content: '',
            error: 'The run was cancelled.',
            partialContent: 'half an answer',
            cancelledAtMessage: 2,
            threadId: 'thread-9'
        });

        // An absent pair stays absent — the pre-change payload is still a legal archive, and `''` is
        // a DIFFERENT claim that the reader would refuse. This is what lets an older lane keep
        // archiving while the field crosses the seam.
        const bare = source.archiveInvocation({
            invocationId: '515',
            sequence: 5,
            agent: 'writer',
            role: 'subagent',
            kind: 'delegation',
            status: 'cancelled',
            content: '',
            error: 'The run was cancelled.',
            threadId: 'thread-9'
        });

        expect(bare.record.completedOrder).toBe(2);
        expect(rowOf(source.snapshot(), '515')).toEqual({
            invocationId: '515',
            sequence: 5,
            completedOrder: 2,
            agent: 'writer',
            role: 'subagent',
            kind: 'delegation',
            status: 'cancelled',
            content: '',
            error: 'The run was cancelled.',
            threadId: 'thread-9'
        });
    });
});

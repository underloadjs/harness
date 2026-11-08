// Explicit primary/subagent configuration and bounded delegation (R4).
//
// Contract pinned here:
//   - `primary` selects the entry agent; without it the first `agents` key wins;
//   - `subagents` is an allowlist, defaulting to every agent except the primary;
//   - the `delegate` tool is core but declared ONLY to the primary, so a subagent
//     never sees it (and a guessed call is rejected);
//   - delegation is one level deep: only a top-level primary run may delegate, and
//     re-entering a running agent is refused (ctx.run cycles included);
//   - each agent keeps its own seeded instructions and transcript; only the answer
//     crosses back;
//   - a delegated child's result is the last substantive tool-free answer of THAT
//     run when its final normal turn is whitespace-only (the literal transcript
//     and `done` stay unchanged); a truly blank child stays blank;
//   - primary/subagent names are validated at construction, so a typo fails fast.

import { describe, expect, it } from 'vitest';
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

const content = (message: unknown): string => (message as { content: string }).content;

// T28: the delegate result is no longer `{ agent, content }`. It carries the same
// identity agentManage/agentResult report plus a paged answer, so a test that pins the
// exact JSON string would pin the whole envelope. These helpers assert the two fields
// the contract is ABOUT (which agent answered, and what it said) and leave the identity
// fields to the dedicated envelope test below.
const delegationOf = (message: unknown): Record<string, any> =>
    JSON.parse(content(message)) as Record<string, any>;

const answerOf = (message: unknown): { agent: string; content: string } => {
    const parsed = delegationOf(message);
    return { agent: parsed.agent, content: parsed.content };
};

describe('primary and subagents', () => {
    it('selects the primary explicitly and defaults the allowlist to the rest', () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('w')])), researcher: brain(scripted([answer('r')])) },
            primary: 'researcher',
            presets: false
        });

        expect(writer.name).toBe('researcher');
        expect(writer.agent).toBe(writer.agents.researcher);
        expect(Object.keys(writer.subagents)).toEqual(['writer']);
        expect(writer.tools.delegate).toBeDefined();
    });

    it('keeps the first agents key as primary when none is named', () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('w')])), researcher: brain(scripted([answer('r')])) },
            presets: false
        });

        expect(writer.name).toBe('writer');
        expect(Object.keys(writer.subagents)).toEqual(['researcher']);
    });

    it('creates no delegation surface when the allowlist is empty', () => {
        const writer = harness({
            agents: { writer: brain(scripted([answer('w')])), researcher: brain(scripted([answer('r')])) },
            subagents: [],
            presets: false
        });

        expect(writer.subagents).toEqual({});
        expect(writer.tools.delegate).toBeUndefined();
    });

    it('uses an explicit allowlist and exposes it on the tool schema', () => {
        const writer = harness({
            agents: {
                writer: brain(scripted([answer('w')])),
                researcher: brain(scripted([answer('r')])),
                editor: brain(scripted([answer('e')]))
            },
            subagents: ['researcher'],
            presets: false
        });

        expect(Object.keys(writer.subagents)).toEqual(['researcher']);
        expect(
            (writer.tools.delegate.parameters as Record<string, any>).properties.agent.enum
        ).toEqual(['researcher']);
    });

    it('validates the primary and subagent names at construction', () => {
        const agents = { writer: brain(scripted([answer('w')])), researcher: brain(scripted([answer('r')])) };

        expect(() => harness({ agents, primary: 'ghost' })).toThrow(
            'Primary agent "ghost" is not registered. Configured agents: writer, researcher.'
        );

        expect(() => harness({ agents, subagents: ['ghost'] })).toThrow(
            'Subagent "ghost" is not registered. Configured agents: writer, researcher.'
        );

        expect(() => harness({ agents, subagents: ['writer'] })).toThrow(
            'Subagent "writer" is the primary agent "writer"; the primary cannot delegate to itself.'
        );
    });
});

describe('delegate', () => {
    it('declares delegate to the primary only', async () => {
        const seenWriter: HarnessStreamRequest[] = [];
        const seenResearcher: HarnessStreamRequest[] = [];

        const researcher = brain(scripted([answer('facts')], seenResearcher));
        const writerAgent = brain(
            scripted(
                [
                    callTool('c1', 'delegate', '{"agent":"researcher","input":"find facts"}'),
                    answer('final')
                ],
                seenWriter
            )
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        await writer('go');

        // The primary sees the bootstrap pair plus delegate. The subagent never sees
        // the delegation control, so its declarations are exactly the pair.
        expect(declaredNames(seenWriter[0])).toEqual([
            'toolRequest',
            'task',
            'delegate',
        ]);
        expect(declaredNames(seenResearcher[0])).toEqual([
            'toolRequest',
            'task'
        ]);
    });

    it('runs the subagent under its own instructions and returns only its answer', async () => {
        const researcher = brain(scripted([answer('the facts')]), {
            instruction: 'You are a researcher. Answer briefly.'
        });

        const writerAgent = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"researcher","input":"find facts"}'),
                answer('final')
            ])
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        const message = await writer('go');

        expect(message.content).toBe('final');

        // Only the answer crosses back, as data.
        expect(answerOf(writerAgent.messages[2])).toEqual({
            agent: 'researcher',
            content: 'the facts'
        });

        // The subagent kept its own instruction and transcript.
        expect(researcher.instructions).toEqual(['You are a researcher. Answer briefly.']);
        expect(researcher.messages).toEqual([
            { role: 'system', content: 'You are a researcher. Answer briefly.' },
            { role: 'user', content: 'find facts' },
            { role: 'assistant', content: 'the facts' }
        ]);
    });

    it('refuses an agent outside the allowlist', async () => {
        const researcher = brain(scripted([answer('r')]));
        const editor = brain(scripted([answer('e')]));
        const writerAgent = brain(
            scripted([callTool('c1', 'delegate', '{"agent":"editor","input":"edit"}'), answer('recovered')])
        );

        const writer = harness({
            agents: { writer: writerAgent, researcher, editor },
            subagents: ['researcher'],
            presets: false
        });

        await writer('go');

        expect(content(writerAgent.messages[2])).toBe(
            'Tool "delegate" received arguments that do not match its schema: $.agent must be one of: "researcher".'
        );
    });

    it('rejects a subagent that tries to delegate (guessed name)', async () => {
        const researcher = brain(
            scripted([
                callTool('r1', 'delegate', '{"agent":"researcher","input":"again"}'),
                answer('blocked')
            ])
        );

        const writerAgent = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"researcher","input":"go"}'),
                answer('final')
            ])
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        await writer('go');

        // The subagent's call is answered with a tool result it can read; the run
        // does not crash and delegation stays one level deep.
        expect(content(researcher.messages[2])).toBe(
            'Tool "delegate" is only available to the primary agent "writer".'
        );
        expect(answerOf(writerAgent.messages[2])).toEqual({
            agent: 'researcher',
            content: 'blocked'
        });
    });
    it('refuses to re-enter a running agent through ctx.run', async () => {
        const recurse = tool({
            description: 'Re-enter the writer.',
            tags: ['agents'],
            visibility: 'core',
            execute: ({ run }) => run!('writer', 'again')
        });

        const entry = brain(scripted([callTool('c1', 'recurse', '{}'), answer('recovered')]));
        const writer = harness({ agents: { writer: entry }, tools: { recurse }, presets: false });
        const message = await writer('go');

        expect(message.content).toBe('recovered');
        expect(content(entry.messages[2])).toBe(
            'Tool "recurse" failed: Agent "writer" is already running; it cannot be re-entered (delegation cycle).'
        );
    });

    // T2/R1: a tool-call turn's visible text is a PREAMBLE, not an answer. A blank
    // final turn must never be "repaired" with it.
    it('does not rescue text from a tool-call preamble', async () => {
        const probe = tool({
            description: 'Probe the catalogue.',
            tags: ['test'],
            visibility: 'core',
            execute: () => 'probed'
        });

        const researcher = brain(
            scripted([
                [
                    { type: 'text', delta: 'checking the catalogue' },
                    {
                        type: 'done',
                        stopReason: 'tool_calls',
                        toolCalls: [{ id: 'r1', name: 'probe', arguments: '{}' }]
                    }
                ],
                answer('\n')
            ])
        );

        const writerAgent = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"researcher","input":"find facts"}'),
                answer('final')
            ])
        );

        const writer = harness({
            agents: { writer: writerAgent, researcher },
            tools: { probe },
            presets: false
        });

        await writer('go');

        // The literal blank terminal turn crosses back: the preamble is not an
        // answer, so there is nothing substantive to fall back to.
        expect(answerOf(writerAgent.messages[2])).toEqual({
            agent: 'researcher',
            content: '\n'
        });
    });

    // T2/R1: no substantive text anywhere in the run => keep the exact blank result
    // rather than inventing an answer.
    it('keeps a genuinely blank answer when nothing substantive was said', async () => {
        const researcher = brain(scripted([answer('\n')]));

        const writerAgent = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"researcher","input":"find facts"}'),
                answer('final')
            ])
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        await writer('go');

        // The child's own transcript keeps the blank turn...
        expect(content(researcher.messages.at(-1))).toBe('\n');
        // ...and the delegate returns it verbatim.
        expect(answerOf(writerAgent.messages[2])).toEqual({
            agent: 'researcher',
            content: '\n'
        });
    });

    // R12: reset() is a session restart, so it must clear EVERY agent's
    // transcript — a subagent used to keep its conversation across a reset, which
    // leaked one session into the next. Seeded instructions stay.
    it('reset() clears every agent transcript, not just the entry agent', async () => {
        const researcher = brain(scripted([answer('facts')]), {
            instruction: 'You are a researcher.'
        });
        const writerAgent = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"researcher","input":"find facts"}'),
                answer('final')
            ]),
            { instruction: 'You are a writer.' }
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        await writer('go');

        // Both agents really have a conversation before the reset.
        expect(writerAgent.messages.map((message) => message.role)).toEqual([
            'system',
            'user',
            'assistant',
            'tool',
            'assistant'
        ]);
        expect(researcher.messages.map((message) => message.role)).toEqual([
            'system',
            'user',
            'assistant'
        ]);

        writer.reset();

        expect(writerAgent.messages).toEqual([{ role: 'system', content: 'You are a writer.' }]);
        expect(researcher.messages).toEqual([{ role: 'system', content: 'You are a researcher.' }]);
    });
});

// ---------------------------------------------------------------------------
// T28 — the delegation result contract
// ---------------------------------------------------------------------------
//
// The result used to be `{ agent, content }`: no identity, no bound, and no account
// of a child that did not finish. Each test below pins one of the three fixes.
describe('delegation result contract (T28)', () => {
    it('returns the invocation identity agentManage/agentResult report', async () => {
        const researcher = brain(scripted([answer('the facts')]));
        const writerAgent = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"researcher","input":"find facts"}'),
                answer('final')
            ])
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        await writer('go');

        const result = delegationOf(writerAgent.messages[2]);

        // The SAME id agentResult takes, the conversation threadSend/threadRead
        // address, the terminal status, and the measured span. Before this, a caller
        // had to call threadList and match by agent name plus sequence order, which is
        // ambiguous with two concurrent runs of one agent.
        expect(result).toMatchObject({
            agent: 'researcher',
            content: 'the facts',
            contentLength: 9,
            offset: 0,
            limit: 8000,
            truncated: false,
            status: 'completed',
            threadId: 'agent:researcher',
            invocationId: expect.any(String),
            durationMs: expect.any(Number)
        });

        // The reported id really addresses the same answer through agentResult.
        const stored = (await writer.executeTool('agentResult', {
            agent: 'researcher',
            invocationId: result.invocationId
        })) as { content: string; status: string };

        expect(stored).toMatchObject({ content: 'the facts', status: 'completed' });
    });

    it('pages a long answer instead of returning it whole', async () => {
        const long = 'x'.repeat(20_000);
        const researcher = brain(scripted([answer(long)]));
        const writerAgent = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"researcher","input":"write it all"}'),
                answer('final')
            ])
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        await writer('go');

        const result = delegationOf(writerAgent.messages[2]);

        // One page, an explicit continuation, and the FULL length — the 58 KB inline
        // payload is what this replaces.
        expect(result.content).toHaveLength(8000);
        expect(result.contentLength).toBe(20_000);
        expect(result.truncated).toBe(true);
        expect(result.nextOffset).toBe(8000);

        // The rest is reachable through the SAME pager agentResult uses.
        const rest = (await writer.executeTool('agentResult', {
            agent: 'researcher',
            invocationId: result.invocationId,
            offset: result.nextOffset,
            limit: 8000
        })) as { content: string; hasMore: boolean; nextOffset?: number };

        expect(rest.content).toHaveLength(8000);
        expect(rest.hasMore).toBe(true);
        expect(rest.nextOffset).toBe(16_000);
    });

    it('honours an explicit maxChars page bound', async () => {
        const researcher = brain(scripted([answer('abcdefghij')]));
        const writerAgent = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"researcher","input":"go","maxChars":4}'),
                answer('final')
            ])
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        await writer('go');

        expect(delegationOf(writerAgent.messages[2])).toMatchObject({
            content: 'abcd',
            contentLength: 10,
            limit: 4,
            truncated: true,
            nextOffset: 4
        });
    });

    it('gates an under-specified brief at dispatch when asked to', async () => {
        const seen: HarnessStreamRequest[] = [];
        const researcher = brain(scripted([answer('should not run')], seen));
        const writerAgent = brain(
            scripted([
                callTool(
                    'c1',
                    'delegate',
                    '{"agent":"researcher","input":"Fix the bug.","requireClarification":true}'
                ),
                answer('recovered')
            ])
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        await writer('go');

        // The refusal is a tool result the model can act on, and the child never ran:
        // no request reached it, so nothing was mutated and no recon was spent.
        expect(content(writerAgent.messages[2])).toContain('is under-specified');
        expect(content(writerAgent.messages[2])).toContain('concrete target');
        expect(seen).toHaveLength(0);
        expect(researcher.messages).toEqual([]);
    });

    it('accepts a brief that names a target and an acceptance criterion', async () => {
        const seen: HarnessStreamRequest[] = [];
        const researcher = brain(scripted([answer('done')], seen));
        const writerAgent = brain(
            scripted([
                callTool(
                    'c1',
                    'delegate',
                    '{"agent":"researcher","input":"Fix the null check in src/parse.ts so the test passes.","requireClarification":true}'
                ),
                answer('final')
            ])
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        await writer('go');

        expect(seen).toHaveLength(1);
        expect(answerOf(writerAgent.messages[2])).toEqual({ agent: 'researcher', content: 'done' });
    });

    it('reports a cancelled child as a structured result instead of an empty record', async () => {
        // A child that commits a substantive turn and then hangs inside a tool: the run
        // is cancelled mid-flight, which is exactly the case the transcript rollback
        // used to erase. (A cancel DURING a stream commits nothing — the assistant
        // message only lands at `done` — so the hang has to be in a tool call for there
        // to be committed text to preserve.)
        let release!: () => void;
        const hang = new Promise<void>((resolve) => {
            release = resolve;
        });

        const researcher = brain(
            scripted([
                [
                    { type: 'text', delta: 'half an answer' },
                    {
                        type: 'done',
                        stopReason: 'tool_calls',
                        toolCalls: [{ id: 'r1', name: 'hang', arguments: '{}' }]
                    }
                ],
                answer('never reached')
            ])
        );

        const writerAgent = brain(
            scripted([
                callTool('c1', 'delegate', '{"agent":"researcher","input":"find facts"}'),
                answer('final')
            ])
        );

        const writer = harness({
            agents: { writer: writerAgent, researcher },
            tools: {
                hang: tool({
                    description: 'Hang until the run is cancelled.',
                    tags: ['test'],
                    visibility: 'core',
                    execute: () => hang.then(() => 'released')
                })
            },
            presets: false
        });

        const controller = new AbortController();
        const running = writer('go', { signal: controller.signal });

        // Let the child commit its turn and reach the hanging tool, then stop the run.
        await new Promise((resolve) => setTimeout(resolve, 20));
        controller.abort(new Error('operator stop'));
        release();

        await expect(running).rejects.toThrow('operator stop');

        // The child's own record survives the rollback: how far it got, and what it had
        // already said. This is the forensic half of the fix — the transcript is gone,
        // but the account of the run is not.
        const stored = (await writer.executeTool('agentResult', { agent: 'researcher' })) as {
            status: string;
            content: string;
            cancelledAtMessage?: number;
            error?: string;
        };

        expect(stored.status).toBe('cancelled');
        expect(stored.content).toBe('half an answer');
        expect(stored.cancelledAtMessage).toBeGreaterThan(0);
        expect(stored.error).toContain('operator stop');
    });
});

// ---------------------------------------------------------------------------
// T28 — a delegation is bounded in wall-clock time
// ---------------------------------------------------------------------------
//
// Before this, a child that ran `sleep 600` sat `running` indefinitely: nothing in
// the schema capped wall-clock, and the only recovery was `toolCancel` — which then
// destroyed the transcript. `timeoutMs` bounds the CHILD only, so the parent turn
// still receives a structured result instead of rolling back.
describe('delegation timeout (T28)', () => {
    it('stops a frozen child and reports its partial work', async () => {
        let release!: () => void;
        const hang = new Promise<void>((resolve) => {
            release = resolve;
        });

        const researcher = brain(
            scripted([
                [
                    { type: 'text', delta: 'started the work' },
                    {
                        type: 'done',
                        stopReason: 'tool_calls',
                        toolCalls: [{ id: 'r1', name: 'hang', arguments: '{}' }]
                    }
                ],
                answer('never reached')
            ])
        );

        const writerAgent = brain(
            scripted([
                callTool(
                    'c1',
                    'delegate',
                    '{"agent":"researcher","input":"find facts","timeoutMs":30}'
                ),
                answer('recovered')
            ])
        );

        const writer = harness({
            agents: { writer: writerAgent, researcher },
            tools: {
                hang: tool({
                    description: 'Hang until released.',
                    tags: ['test'],
                    visibility: 'core',
                    execute: () => hang.then(() => 'released')
                })
            },
            presets: false
        });

        const message = await writer('go');
        release();

        // The parent recovered with an answer, and the delegation is a readable result
        // rather than a hang or a thrown error.
        expect(message.content).toBe('recovered');

        const result = delegationOf(writerAgent.messages[2]);

        expect(result).toMatchObject({
            agent: 'researcher',
            status: 'cancelled',
            content: 'started the work',
            partialContent: 'started the work'
        });
        expect(result.error).toContain('exceeded its 30ms timeout');
        expect(result.cancelledAtMessage).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// T28 — a delegation can scope what the child may do
// ---------------------------------------------------------------------------
//
// `delegate` had no scope declaration, so a "planning" agent could write a 58 KB
// artifact into the user's checkout. `scope.tools` is an allowlist enforced on the
// child: it neither SEES nor can CALL anything outside it.
describe('delegation scope (T28)', () => {
    it('hides and refuses every tool outside the child allowlist', async () => {
        const seen: HarnessStreamRequest[] = [];
        const researcher = brain(
            scripted(
                [
                    // The child tries a tool it was not granted.
                    callTool('r1', 'write', '{"path":"leak.txt","content":"x"}'),
                    answer('scoped answer')
                ],
                seen
            )
        );

        const writerAgent = brain(
            scripted([
                callTool(
                    'c1',
                    'delegate',
                    '{"agent":"researcher","input":"review src/a.ts","scope":{"tools":["read"]}}'
                ),
                answer('final')
            ])
        );

        const writer = harness({
            agents: { writer: writerAgent, researcher },
            tools: {
                read: tool({
                    description: 'Read.',
                    tags: ['files'],
                    visibility: 'core',
                    execute: () => 'contents'
                }),
                write: tool({
                    description: 'Write.',
                    tags: ['files'],
                    visibility: 'core',
                    execute: () => 'written'
                })
            },
            presets: false
        });

        await writer('go');

        // The child SAW only its allowlist (plus the bootstrap pair, which the scope
        // filter also applies to — so exactly `read`).
        expect(declaredNames(seen[0])).toEqual(['read']);

        // The guessed call was refused with a readable result, and the run continued.
        const refusal = researcher.messages.find(
            (message) => message.role === 'tool' && message.toolCallId === 'r1'
        ) as { content: string };

        expect(refusal.content).toContain('is outside this run\'s scope');
        expect(refusal.content).toContain('Allowed: read');
        expect(answerOf(writerAgent.messages[2])).toEqual({
            agent: 'researcher',
            content: 'scoped answer'
        });
    });

    it('declares no tools at all for an empty allowlist', async () => {
        const seen: HarnessStreamRequest[] = [];
        const researcher = brain(scripted([answer('reasoned')], seen));
        const writerAgent = brain(
            scripted([
                callTool(
                    'c1',
                    'delegate',
                    '{"agent":"researcher","input":"think about src/a.ts","scope":{"tools":[]}}'
                ),
                answer('final')
            ])
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        await writer('go');

        // A pure-reasoning child: no declarations, so it cannot touch the workspace.
        expect(declaredNames(seen[0])).toEqual([]);
        expect(answerOf(writerAgent.messages[2])).toEqual({ agent: 'researcher', content: 'reasoned' });
    });
});

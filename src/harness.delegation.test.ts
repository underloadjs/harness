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
//
// Policy change 2026-11-09 (docs/tasks/2026-11-09-thread-timeout-policy.md): the
// wall-clock DEFAULT on a delegated child is gone — an omitted `timeoutMs` arms no
// timer at all, `timeoutMs` is an optional caller-set bound, and the model schema's
// 1..3600000 range bounds a model argument only (the unvalidated host path is not
// clamped). See `delegation time limits (policy 2026-11-09)`,
// `delegate timeoutMs bounds (policy 2026-11-09)`,
// `pending delegation placeholder (delegate-stress T1.3/T1.4)`,
// `liveness wake covers a delegated child (policy 2026-11-09 T8)` and
// `harness source shape (policy 2026-11-09 T5.5)` at the end of this file.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { agent, harness, tool } from '@underload/harness';
import type {
    Agent,
    HarnessEvent,
    HarnessMessage,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest
} from '@underload/harness';

// Canonical transcript entries now carry a minted `messageId` (context T1,
// src/core/message-id.ts): a stable ADDRESS for a turn, i.e. an identity field like a
// timestamp rather than part of the content these assertions pin. Stripping it DEEPLY
// keeps every expected value here exactly what it was, and the id itself is pinned
// exactly where it is the subject: src/harness.inclusion.test.ts (minting, `entries`,
// addressing by id), src/harness.snapshot.test.ts (persistence and restore-without-ids)
// and src/harness.fork.test.ts (ids COPIED across a fork).
const withoutIds = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutIds);

    if (typeof value === 'object' && value !== null) {
        const entries: [string, unknown][] = [];

        for (const [key, child] of Object.entries(value)) {
            // The only key dropped is the id; `undefined`-valued keys stay, so a
            // `toStrictEqual` comparison keeps its strictness about them.
            if (key === 'messageId') continue;
            entries.push([key, withoutIds(child)]);
        }

        return Object.fromEntries(entries);
    }

    return value;
};

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

// ---------------------------------------------------------------------------
// Fake-clock helpers (the 2026-11-09 time-policy tests)
// ---------------------------------------------------------------------------
//
// Every assertion about wall-clock time in this file moves the clock on purpose.
// `harness.background.test.ts` / `harness.sync-async.test.ts` established the
// pattern (and `src/harness.ts`'s only turn-bounding timer is asserted against it),
// so a test that needs "five minutes later" never sleeps for it.
//
// `flush` drains the harness's promise chain WITHOUT moving the clock — several
// zero-advance passes are needed because a launch → re-request → pause chain spans
// more microtasks than one `await` can settle.
const flush = async (): Promise<void> => {
    for (let pass = 0; pass < 32; pass += 1) {
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
    }
};

// Move the clock by an exact amount, then let the resulting work settle.
const advance = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
    await flush();
};

const deferred = <T>() => {
    let settle!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
        settle = resolve;
    });
    return { promise, resolve: settle };
};

// Attach handlers immediately so a rejection never becomes unhandled, and expose
// the settled state so a test can prove a child is STILL RUNNING at an instant.
const probe = <T>(promise: Promise<T>): { status: 'pending' | 'resolved' | 'rejected'; value?: T; error?: unknown } => {
    const state: { status: 'pending' | 'resolved' | 'rejected'; value?: T; error?: unknown } = {
        status: 'pending'
    };
    promise.then(
        (value) => {
            state.status = 'resolved';
            state.value = value;
        },
        (error) => {
            state.status = 'rejected';
            state.error = error;
        }
    );
    return state;
};

// The liveness wakes the runtime emitted, for a given agent.
const wakeupsFor = (events: readonly HarnessEvent[], agentName: string) =>
    events
        .filter((event): event is Extract<HarnessEvent, { type: 'wakeup' }> => event.type === 'wakeup')
        .filter((event) => event.agent === agentName);

// A tool whose execution parks until the test releases it. `mode: 'async'` is
// deliberate where a test needs the CALLING run to keep taking turns while it is
// parked (a sync call holds that message's batch gate).
const parkedTool = (name: string, gate: Promise<string>, mode?: 'async') =>
    tool({
        description: `Park ${name} until released.`,
        tags: ['test'],
        visibility: 'core',
        ...(mode === undefined ? {} : { mode }),
        execute: () => gate
    });

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
            'tasks',
            'delegate',
        ]);
        expect(declaredNames(seenResearcher[0])).toEqual([
            'toolRequest',
            'tasks'
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
        expect(withoutIds(researcher.messages)).toEqual([
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

        expect(withoutIds(writerAgent.messages)).toEqual([{ role: 'system', content: 'You are a writer.' }]);
        expect(withoutIds(researcher.messages)).toEqual([{ role: 'system', content: 'You are a researcher.' }]);
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
// T28 — a delegation CAN be bounded in wall-clock time
// ---------------------------------------------------------------------------
//
// ORIGINAL HEADING: "a delegation is bounded in wall-clock time". That is now the
// OPTIONAL behaviour, not the default: as of 2026-11-09 an omitted `timeoutMs` arms
// no clock at all (see `delegation time limits (policy 2026-11-09)` below). This
// block stays exactly as written because it is the R5 proof — the mechanism survives,
// its default changed — and policy doc T5.2 asks for it to be EXTENDED, not replaced.
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
    it('hides and refuses every capability outside the allowlist except the discovery door', async () => {
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

        // The child SAW only its allowlist plus the one tool the scope can never
        // block: `toolRequest` is the escape hatch (delegate-stress finding 2), so a
        // restricted child can always name the capability it is missing instead of
        // looping. `task` is filtered out — the allowlist still bounds every capability.
        expect(declaredNames(seen[0])).toEqual(['toolRequest', 'read']);

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

    it('declares only the discovery door for an empty allowlist', async () => {
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

        // A pure-reasoning child: no capability declarations, so it cannot touch the
        // workspace. The ONE entry is `toolRequest` — the escape hatch the scope can
        // never remove (delegate-stress finding 2), so even a zero-tool child has a
        // way to report what it needs instead of producing nothing at all.
        expect(declaredNames(seen[0])).toEqual(['toolRequest']);
        expect(answerOf(writerAgent.messages[2])).toEqual({ agent: 'researcher', content: 'reasoned' });
    });

    // -------------------------------------------------------------------------
    // delegate-stress finding 2 (docs/tasks/2026-11-08-delegate-stress-test.md) —
    // `scope` gated `toolRequest` itself, which livelocked a restricted child. A
    // child scoped to `["read","glob"]` and briefed to write "ran 45 messages over
    // 132 s" looping on glob, because the one instruction its prompt gives for a
    // missing capability ("call toolRequest before concluding it cannot be done")
    // could not be honoured. The fix is the escape hatch: `toolRequest` is declared
    // and callable no matter what the allowlist names, while every capability the
    // scope omits stays hidden AND stays refused at launch.
    // -------------------------------------------------------------------------
    it('lets a scoped child call toolRequest, the one tool the allowlist cannot block', async () => {
        const seen: HarnessStreamRequest[] = [];

        // The child does exactly what the finding says a scoped child could not: ask
        // discovery for the capability it is missing, then answer about it.
        const researcher = brain(
            scripted(
                [
                    callTool('r1', 'toolRequest', '{"names":["write"]}'),
                    answer('write is not available to me')
                ],
                seen
            )
        );

        const writerAgent = brain(
            scripted([
                callTool(
                    'c1',
                    'delegate',
                    '{"agent":"researcher","input":"write one file","scope":{"tools":["read","glob"]}}'
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
                glob: tool({
                    description: 'Glob.',
                    tags: ['files'],
                    visibility: 'core',
                    execute: () => 'a.ts'
                }),
                write: tool({
                    description: 'Write.',
                    tags: ['files'],
                    visibility: 'searchable',
                    execute: () => 'written'
                })
            },
            presets: false
        });

        await writer('go');

        // 1. Declared: the allowlist is `read`/`glob`, and `toolRequest` is there
        //    anyway (in registry order, ahead of the scoped capability).
        expect(declaredNames(seen[0])).toEqual(['toolRequest', 'read', 'glob']);

        // 2. Callable: the discovery call ANSWERED (no scope refusal), so the child got
        //    a real result to reason about rather than a dead end.
        const discovery = researcher.messages.find(
            (message) => message.role === 'tool' && message.toolCallId === 'r1'
        ) as { content: string };

        // 2. Callable: the discovery call ANSWERED (no scope REFUSAL — the tool call
        //    itself ran), so the child got a real result to reason about rather than a
        //    dead end. T11: the answer is now an explicit DENIAL, not an `enabled`
        //    promise. `write` is searchable and matched, but the run's scope excludes
        //    it, so it is reported under `forbidden` with the launch gate's own
        //    sentence and the allowed list — and it was never added to the enabled set
        //    (the session-wide pollution the old shape caused is gone). The exact JSON
        //    below is also the proof the call was not refused: a launch-gate refusal is
        //    plain text and would not parse to this discovery envelope at all.
        expect(JSON.parse(discovery.content)).toEqual({
            enabled: [],
            tools: [],
            matched: 1,
            omitted: 0,
            forbidden: [
                {
                    name: 'write',
                    reason:
                        "Tool \"write\" is outside this run's scope. Allowed: read, glob. Requesting it again will not change this answer — adapt to the allowed tools or report the limitation.",
                    allowed: ['read', 'glob']
                }
            ]
        });

        // 3. Still scoped: the escape hatch opens the discovery door only. A tool the
        //    allowlist omits stays uncalled — the finding's "no clean denial to fail
        //    on" is answered by the sibling test above, which asserts the readable
        //    `is outside this run's scope` refusal for a guessed capability call.
        const childAnswer = delegationOf(writerAgent.messages[2]);
        expect(childAnswer).toMatchObject({
            agent: 'researcher',
            content: 'write is not available to me',
            status: 'completed'
        });
    });

    // -------------------------------------------------------------------------
    // T11 (RR4 loop) — toolRequest must answer a SCOPED run honestly.
    //
    // The escape hatch kept `toolRequest` callable from a scoped child, but the answer
    // itself was scope-BLIND: an out-of-scope match came back under `enabled`, the very
    // next declaration list hid the tool again (the scope filter is correct), and a
    // guessed call hit the launch-gate refusal. RR4 answered that contradiction by
    // re-requesting — 135 round-trips, 5.6k→152k tokens — and every such enable also
    // landed in the SESSION-wide enabled set, leaking the child's discovery into every
    // sibling thread. The tests below pin the three contract halves: the denial shape
    // and its determinism, the untouched enabled set, and the unchanged in-scope path.
    // -------------------------------------------------------------------------

    // One builder for the two denial tests: the same scoped writer/researcher pair as
    // the escape-hatch test; only the allowlist and the child's script vary. `scope`
    // is passed as the delegate arguments so a test can name a scope that hides even a
    // core tool (the `alreadyAvailable` half of the T11 fix).
    const scopedDiscoveryPair = (
        childScript: HarnessStreamEvent[][],
        scope: string,
        seenChild: HarnessStreamRequest[]
    ) => {
        const researcher = brain(scripted(childScript, seenChild));
        const writerAgent = brain(
            scripted([
                callTool(
                    'c1',
                    'delegate',
                    `{"agent":"researcher","input":"need write","scope":{"tools":${scope}}}`
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
                glob: tool({
                    description: 'Glob.',
                    tags: ['files'],
                    visibility: 'core',
                    execute: () => 'a.ts'
                }),
                write: tool({
                    description: 'Write.',
                    tags: ['files'],
                    visibility: 'searchable',
                    execute: () => 'written'
                })
            },
            presets: false
        });

        return { writer, writerAgent, researcher };
    };

    it('denies an out-of-scope request with the allowed list, twice identically, and never touches the enabled set (T11)', async () => {
        // The loop-prevention regression: TWO consecutive rounds asking for the same
        // out-of-scope tool. Both answers are byte-identical (the denial is a pure
        // function of request + scope, no state can flip it), the tool never reaches
        // the next turn's declarations, and `discoveredTools` — the session-wide
        // enabled set that used to gain `write` from the child's doomed enable — stays
        // empty.
        const seenChild: HarnessStreamRequest[] = [];
        const { writer, researcher } = scopedDiscoveryPair(
            [
                callTool('w1', 'toolRequest', '{"names":["write"]}'),
                callTool('w2', 'toolRequest', '{"names":["write"]}'),
                answer('write is forbidden here')
            ],
            '["read","glob"]',
            seenChild
        );

        await writer('go');

        const expected = {
            enabled: [],
            tools: [],
            matched: 1,
            omitted: 0,
            forbidden: [
                {
                    name: 'write',
                    reason:
                        "Tool \"write\" is outside this run's scope. Allowed: read, glob. Requesting it again will not change this answer — adapt to the allowed tools or report the limitation.",
                    allowed: ['read', 'glob']
                }
            ]
        };

        const toolResults = researcher.messages.filter((message) => message.role === 'tool');
        const first = JSON.parse((toolResults[0] as { content: string }).content);
        const second = JSON.parse((toolResults[1] as { content: string }).content);

        // Round 1 and round 2: the SAME honest denial — deterministic, no flip.
        expect(first).toEqual(expected);
        expect(second).toEqual(expected);
        expect(second).toEqual(first);

        // The escape hatch is untouched: the child was never blocked from asking (no
        // launch-gate refusal on either round — the denial lives INSIDE the discovery
        // envelope, which only an executed toolCall produces).
        expect(toolResults).toHaveLength(2);

        // The very next model request still declares only the allowlist plus the
        // discovery door: the denial did not declare `write`, and the enabled set did
        // not grow behind the scope filter (both would have put `write` in this list in
        // an unscoped run).
        expect(declaredNames(seenChild[1])).toEqual(['toolRequest', 'read', 'glob']);

        // R1, no-pollution half: the session-wide enabled set is exactly what it was —
        // empty. Before T11 this read ['write'] even though the child could never call
        // it, and every sibling thread inherited the leak.
        expect(writer.discoveredTools).toEqual([]);
    });

    it('moves an out-of-scope CORE tool from alreadyAvailable to forbidden (T11)', async () => {
        // The lie was not only in `enabled`. A core tool the agent can SEE but the run
        // scope HIDES used to be reported under `alreadyAvailable` — "you can call this
        // right now" — while the launch gate refused it. Same predicate, same honest
        // answer: it moves to `forbidden` and `alreadyAvailable` drops.
        const { writer, researcher } = scopedDiscoveryPair(
            [callTool('w1', 'toolRequest', '{"names":["read","write"]}'), answer('done')],
            '["glob"]',
            []
        );

        await writer('go');

        const toolResults = researcher.messages.filter((message) => message.role === 'tool');
        const answer1 = JSON.parse((toolResults[0] as { content: string }).content);

        // One query, both halves of the denial: the searchable `write` (an enable
        // candidate the scope hides) and the CORE `read` (an `alreadyAvailable` hit the
        // scope hides). Capability denials lead, core denials follow, both in selection
        // order; neither is enabled, and `alreadyAvailable` is absent because its only
        // match was the denied core tool.
        expect(answer1).toEqual({
            enabled: [],
            tools: [],
            matched: 1,
            omitted: 0,
            forbidden: [
                {
                    name: 'write',
                    reason:
                        "Tool \"write\" is outside this run's scope. Allowed: glob. Requesting it again will not change this answer — adapt to the allowed tools or report the limitation.",
                    allowed: ['glob']
                },
                {
                    name: 'read',
                    reason:
                        "Tool \"read\" is outside this run's scope. Allowed: glob. Requesting it again will not change this answer — adapt to the allowed tools or report the limitation.",
                    allowed: ['glob']
                }
            ]
        });

        // The denial promised nothing anywhere: the session-wide enabled set is empty.
        expect(writer.discoveredTools).toEqual([]);
    });

    it('keeps the in-scope toolRequest answer byte-for-byte historical in a scoped run (T11 R2)', async () => {
        // R2's scoped half: an allowlisted SEARCHABLE tool still enables exactly like an
        // unscoped request would — same fields, same values, NO `forbidden` key (the
        // `toEqual` below is exact; a stray field would fail it). The session-wide
        // enabled set gains it, because an in-scope grant is still a real grant.
        const seenChild: HarnessStreamRequest[] = [];
        const { writer, researcher } = scopedDiscoveryPair(
            [callTool('w1', 'toolRequest', '{"names":["write"]}'), answer('writing now')],
            '["read","glob","write"]',
            seenChild
        );

        await writer('go');

        const toolResults = researcher.messages.filter((message) => message.role === 'tool');

        expect(JSON.parse((toolResults[0] as { content: string }).content)).toEqual({
            enabled: ['write'],
            tools: [{ name: 'write', description: 'Write.', tags: ['files'] }],
            matched: 1,
            omitted: 0
        });

        // The grant is live for this run: `write` joins the next turn's declarations
        // (scope-allowed AND enabled — the old test's "enabling is still not the same
        // as being allowed" case, now with both halves true).
        expect(declaredNames(seenChild[1])).toEqual(['toolRequest', 'read', 'glob', 'write']);
        expect(writer.discoveredTools).toEqual(['write']);
    });
});

// ---------------------------------------------------------------------------
// 2026-11-09 thread time policy — an omitted `timeoutMs` means NO time limit
// ---------------------------------------------------------------------------
//
// docs/tasks/2026-11-09-thread-timeout-policy.md, R1/R2/R5. The mechanism `delegate`
// gained in T28 survives untouched (the `delegation timeout (T28)` block above is the
// proof, and it passes unmodified); what changed is the DEFAULT:
//
//   - omitted               -> no wall-clock timer is armed at all, and the child
//                              ends on its own answer, however long that takes;
//   - explicit finite value -> armed exactly as before (an opt-in bound);
//   - explicit non-finite   -> the default again, i.e. unbounded, never 0 ms;
//   - the model schema keeps 1..3600000 (it bounds what a MODEL may ask for), while
//                              the unvalidated host path may pass any finite bound
//                              and is NOT clamped.
//
// ---------------------------------------------------------------------------
// The shared "child that hangs on its own tool" scenario
// ---------------------------------------------------------------------------
//
// One builder for the five policy tests below, because every one of them needs the
// SAME shape — a primary that delegates to a researcher whose own tool call parks
// until the test releases it — and they differ only in what the caller passes and
// which observation surface they need:
//
//   - `arguments`      the model-path delegate arguments (the bound under test);
//   - `hostTimeoutMs`  routes the call through a HOST tool body instead, because the
//                      host path (`runtime.delegate`) is the only way to reach a value
//                      JSON cannot carry — an explicit `Infinity`, or a bound above the
//                      schema ceiling — and it bypasses schema validation, which is the
//                      point of T2.3;
//   - `ping: false`    replaces the shipped `async-ping` plugin (the documented
//                      override path), so the ONLY timer that could end the child is
//                      the delegate one and `vi.getTimerCount()` is meaningful;
//   - `wakeIntervalMs` shortens the liveness cadence for the T8 wake tests;
//   - `childMode`      'async' lets the CHILD keep taking turns while its call is
//                      parked (a sync call holds that message's batch gate), which the
//                      wake test needs;
//   - `events`/`seenChild`/`seenParent` the request/event logs a test asserts on.
const hangingChild = (options: {
    arguments: string;
    hostTimeoutMs?: number;
    ping?: false;
    wakeIntervalMs?: number;
    childMode?: 'async';
    events?: HarnessEvent[];
    seenChild?: HarnessStreamRequest[];
    seenParent?: HarnessStreamRequest[];
}) => {
    const gate = deferred<string>();

    const researcher = brain(
        scripted(
            [
                [
                    { type: 'text', delta: 'started the work' },
                    {
                        type: 'done',
                        stopReason: 'tool_calls',
                        toolCalls: [{ id: 'r1', name: 'hang', arguments: '{}' }]
                    }
                ],
                answer('child finished')
            ],
            options.seenChild
        )
    );

    const writerAgent = brain(
        scripted(
            [
                callTool(
                    'c1',
                    options.hostTimeoutMs === undefined ? 'delegate' : 'hostDelegate',
                    options.arguments
                ),
                answer('waiting'),
                answer('final')
            ],
            options.seenParent
        )
    );

    const hostDelegate = tool({
        description: 'Delegate through the unvalidated host path.',
        tags: ['test'],
        visibility: 'core',
        execute: (context) =>
            context.harness!.runtime.delegate(
                context.agent,
                {
                    agent: 'researcher',
                    input: 'find facts',
                    ...(options.hostTimeoutMs === undefined
                        ? {}
                        : { timeoutMs: options.hostTimeoutMs })
                },
                context.run!,
                context.runDepth,
                context.signal,
                context.callId,
                context.runScope
            )
    });

    const writer = harness({
        agents: { writer: writerAgent, researcher },
        tools: {
            hang: parkedTool('hang', gate.promise, options.childMode),
            ...(options.hostTimeoutMs === undefined ? {} : { hostDelegate })
        },
        presets: false,
        ...(options.wakeIntervalMs === undefined
            ? {}
            : { wakeIntervalMs: options.wakeIntervalMs }),
        ...(options.ping === false
            ? { plugins: [{ name: 'async-ping', setup: () => undefined }] }
            : {}),
        ...(options.events === undefined
            ? {}
            : {
                    report: {
                        progress: (event: HarnessEvent) => {
                            options.events!.push(event);
                        }
                    }
                })
    });

    return { writer, writerAgent, researcher, gate };
};

// Every test here replaces the shipped `async-ping` plugin (the documented override
// path) so the ONLY timer that could end a child is the delegate one, and asserts
// `vi.getTimerCount()` to prove that.
describe('delegation time limits (policy 2026-11-09)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('runs a delegated child with no clock at all when timeoutMs is omitted', async () => {
        const { writer, writerAgent, gate } = hangingChild({
            arguments: '{"agent":"researcher","input":"find facts"}',
            ping: false
        });

        const state = probe(writer('go'));
        await flush();

        // THE CORE ASSERTION: an omitted bound arms no wall-clock timer. Before the
        // policy change this was a 300000 ms timer, so the count was 1 here.
        expect(vi.getTimerCount()).toBe(0);
        expect(writer.thread('agent:researcher')?.status).toBe('running');

        // The OLD default, exactly, and then well past it. Nothing kills the child.
        await advance(300_000);
        expect(state.status).toBe('pending');
        expect(writer.thread('agent:researcher')?.status).toBe('running');
        expect(vi.getTimerCount()).toBe(0);

        await advance(1_500_000);
        expect(state.status).toBe('pending');
        expect(writer.thread('agent:researcher')?.status).toBe('running');

        // It ends because its OWN tool released and it answered — not because a clock
        // fired. The envelope carries no `error`, and the status is the child's own.
        gate.resolve('released');
        await flush();

        expect(state.status).toBe('resolved');
        expect(state.value?.content).toBe('final');

        const result = delegationOf(writerAgent.messages[2]);
        expect(result).toMatchObject({
            agent: 'researcher',
            content: 'child finished',
            status: 'completed'
        });
        expect(result.error).toBeUndefined();
        expect(result.partialContent).toBeUndefined();
        expect(result.cancelledAtMessage).toBeUndefined();
        expect(writer.thread('agent:researcher')?.status).toBe('idle');
    });

    it('treats an explicit non-finite bound as unbounded, never as 0 ms', async () => {
        // `Number.isFinite` rejects Infinity, so an explicit `Infinity` falls through
        // to the default. The default is infinity too now, but this test is the guard
        // against a refactor that turns it into `setTimeout(fn, Infinity)` — which
        // fires immediately and would cancel the child at once.
        const { writer, writerAgent, gate } = hangingChild({
            arguments: '{"agent":"researcher","input":"find facts"}',
            hostTimeoutMs: Number.POSITIVE_INFINITY,
            ping: false
        });

        const state = probe(writer('go'));
        await flush();
        expect(vi.getTimerCount()).toBe(0);

        await advance(3_600_001);
        expect(state.status).toBe('pending');
        expect(writer.thread('agent:researcher')?.status).toBe('running');

        gate.resolve('released');
        await flush();

        expect(state.status).toBe('resolved');
        expect(delegationOf(writerAgent.messages[2])).toMatchObject({
            agent: 'researcher',
            content: 'child finished',
            status: 'completed'
        });
    });

    it('honours a host bound above the model ceiling instead of clamping it', async () => {
        // T2.3: the schema's 3600000 maximum bounds a MODEL argument. A host calling
        // `runtime.delegate` is not schema-validated, and the runtime applies no upper
        // clamp, so a 90-minute bound must still be pending at 3600001 ms. Clamping it
        // silently would cancel the child here — the half-implemented behaviour the
        // policy doc refuses to leave in place.
        const { writer, writerAgent, gate } = hangingChild({
            arguments: '{"agent":"researcher","input":"find facts"}',
            hostTimeoutMs: 5_400_000,
            ping: false
        });

        const state = probe(writer('go'));
        await flush();

        // This path DOES arm exactly one timer: the caller asked for a bound.
        expect(vi.getTimerCount()).toBe(1);

        await advance(3_600_001);
        expect(state.status).toBe('pending');
        expect(writer.thread('agent:researcher')?.status).toBe('running');

        // Past the bound the caller asked for, the T28 mechanism still works: a
        // structured `cancelled` result naming the 5400000 ms bound.
        await advance(1_800_000);
        expect(state.status).toBe('resolved');

        const result = delegationOf(writerAgent.messages[2]);
        expect(result).toMatchObject({
            agent: 'researcher',
            status: 'cancelled',
            content: 'started the work',
            partialContent: 'started the work'
        });
        expect(result.error).toBe(
            'Delegation to "researcher" exceeded its 5400000ms timeout and was stopped.'
        );

        gate.resolve('released');
        await flush();
    });
});

// ---------------------------------------------------------------------------
// The model-facing ceiling: `minimum: 1`, `maximum: 3600000` (T2.2)
// ---------------------------------------------------------------------------
//
// Both bounds are enforced on a MODEL call by the runtime schema gate
// (src/core/schema-validation.ts reads `minimum`/`maximum`), and the refusal happens
// BEFORE the child runs, so the measurement is "the child was never asked". A "0
// means infinity" spelling is rejected on purpose: `minimum: 1` already forbids 0,
// and overloading it would make an explicit value mean "no value".
describe('delegate timeoutMs bounds (policy 2026-11-09)', () => {
    const boundsHarness = (timeoutArgument: string) => {
        const seenChild: HarnessStreamRequest[] = [];
        const researcher = brain(scripted([answer('never started')], seenChild));
        const writerAgent = brain(
            scripted([
                callTool('c1', 'delegate', `{"agent":"researcher","input":"find facts","timeoutMs":${timeoutArgument}}`),
                answer('final')
            ])
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });

        return { writer, writerAgent, researcher, seenChild };
    };

    it('refuses a model bound above the ceiling before the child runs', async () => {
        const { writer, writerAgent, seenChild } = boundsHarness('4000000');
        const message = await writer('go');

        expect(message.content).toBe('final');
        expect(seenChild).toHaveLength(0);
        expect(content(writerAgent.messages[2])).toBe(
            'Tool "delegate" received arguments that do not match its schema: $.timeoutMs must be <= 3600000.'
        );
    });

    it('refuses a zero bound: the floor is real and 0 does not mean infinity', async () => {
        const { writer, writerAgent, seenChild } = boundsHarness('0');
        const message = await writer('go');

        expect(message.content).toBe('final');
        expect(seenChild).toHaveLength(0);
        expect(content(writerAgent.messages[2])).toBe(
            'Tool "delegate" received arguments that do not match its schema: $.timeoutMs must be >= 1.'
        );
    });
});

// ---------------------------------------------------------------------------
// delegate-stress T1.3/T1.4 — the pending envelope names its own control
// ---------------------------------------------------------------------------
//
// `delegate` tells the model to "use toolCancel with that callId", and the stress run
// found discovery reporting `toolCancel` as absent in exactly that window. The fix
// that removes the discovery dependency entirely: the placeholder the model receives
// while the child runs states the cancellation tool BY NAME, next to the `callId` it
// belongs to. (The sibling half — `toolRequest` reporting `toolCancel` under
// `alreadyAvailable` while a call is in flight — is pinned in
// src/harness.already-available.test.ts.)
describe('pending delegation placeholder (delegate-stress T1.3/T1.4)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('advertises toolCancel beside the callId while the child is still running', async () => {
        const seenParent: HarnessStreamRequest[] = [];
        const { writer, gate } = hangingChild({
            arguments: '{"agent":"researcher","input":"find facts"}',
            ping: false,
            seenParent
        });

        const state = probe(writer('go'));
        await flush();

        // The parent kept working: an async delegation means the NEXT request carries
        // a projection-only placeholder instead of an answer.
        expect(state.status).toBe('pending');
        expect(seenParent).toHaveLength(2);

        const placeholder = (seenParent[1].messages ?? []).find(
            (message) => message.role === 'tool' && message.toolCallId === 'c1'
        ) as Extract<HarnessMessage, { role: 'tool' }>;

        expect({
            role: placeholder.role,
            toolCallId: placeholder.toolCallId,
            name: placeholder.name
        }).toEqual({ role: 'tool', toolCallId: 'c1', name: 'delegate' });

        // Every CONTRACT field, exactly. The free-text `note` is asserted separately
        // because its wording is not the published shape (see the alignment note in
        // src/harness.inclusion.test.ts) — what this finding pins is that the text
        // NAMES the control and the id it belongs to.
        const { note, ...payload } = JSON.parse(placeholder.content) as {
            status: string;
            callId: string;
            name: string;
            elapsedMs: number;
            note: string;
        };
        expect(payload).toEqual({ status: 'pending', callId: 'c1', name: 'delegate', elapsedMs: 0 });
        // The finding is about the NAME: the text the model reads in exactly this
        // moment must point at the control, and the field beside it carries the id.
        expect(note).toContain('toolCancel');

        gate.resolve('released');
        await flush();
        expect(state.status).toBe('resolved');
    });
});

// ---------------------------------------------------------------------------
// Policy doc T8 — does the liveness wake actually cover a DELEGATED CHILD?
// ---------------------------------------------------------------------------
//
// With no default clock, the stated recovery for a stuck child is a wake plus an
// explicit `toolCancel`. `async-ping` keys its per-agent timer on scheduler identity
// (src/plugins/async-ping.plugin.ts `arm()`), so whether the CHILD gets its own
// heartbeat — rather than only the parent — was the open question. Both
// configurations are pinned here: plugin on (the shipped default) and plugin replaced
// (a deployment that disables it).
describe('liveness wake covers a delegated child (policy 2026-11-09 T8)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('wakes the CHILD agent while its own tool is parked and offers it toolCancel', async () => {
        const events: HarnessEvent[] = [];
        const seenChild: HarnessStreamRequest[] = [];

        // `childMode: 'async'` is required, not decorative: a SYNC parked call holds
        // that message's batch gate, so the woken run could not take the inspecting
        // turn this test is about.
        const { writer, gate } = hangingChild({
            arguments: '{"agent":"researcher","input":"find facts"}',
            wakeIntervalMs: 250,
            childMode: 'async',
            events,
            seenChild
        });

        const state = probe(writer('go'));
        await flush();

        await advance(249);
        expect(wakeupsFor(events, 'researcher')).toEqual([]);

        await advance(1);
        expect(wakeupsFor(events, 'researcher')).toEqual([
            {
                type: 'wakeup',
                agent: 'researcher',
                reason: 'pending-tools',
                pending: [{ callId: 'r1', name: 'hang', elapsedMs: 250 }],
                // Attributed to the CHILD's run, not the parent's: thread '2' is the
                // researcher's conversation and `callId: 'c1'` records that the
                // delegation call is what started it.
                thread: { id: '2', callId: 'c1' }
            }
        ]);

        // The wake is actionable, not cosmetic: the child's own inspecting request
        // declares the control that releases it.
        const childRequest = seenChild[seenChild.length - 1];
        expect((childRequest.tools ?? []).map((declaration) => declaration.name)).toContain(
            'toolCancel'
        );

        gate.resolve('released');
        await flush();
        expect(state.status).toBe('resolved');
    });

    it('leaves an unbounded child running with no wake when the ping plugin is replaced', async () => {
        const events: HarnessEvent[] = [];
        const { writer, gate } = hangingChild({
            arguments: '{"agent":"researcher","input":"find facts"}',
            childMode: 'async',
            ping: false,
            events
        });

        const state = probe(writer('go'));
        await flush();

        // Three historical intervals with no heartbeat: nothing fires, nothing is
        // armed, and the child is still `running` — which is exactly why the schema
        // text names `toolCancel` as the recovery and keeps `timeoutMs` available.
        await advance(600_000 * 3);
        expect(wakeupsFor(events, 'researcher')).toEqual([]);
        expect(wakeupsFor(events, 'writer')).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
        expect(state.status).toBe('pending');
        expect(writer.thread('agent:researcher')?.status).toBe('running');

        gate.resolve('released');
        await flush();
        expect(state.status).toBe('resolved');
    });
});

// ---------------------------------------------------------------------------
// Policy doc T5.5 — the guard that keeps the policy from rotting
// ---------------------------------------------------------------------------
//
// A source-shape assertion, deliberately: the requirement ("no thread has a
// wall-clock limit") is about what the runtime DOES NOT arm, and the easiest way to
// regress it is a future "safety timeout" bolted onto an unrelated path. Pinning the
// shape means that change has to edit this test on purpose.
describe('harness source shape (policy 2026-11-09 T5.5)', () => {
    const harnessSource = () =>
        readFileSync(fileURLToPath(new URL('./harness.ts', import.meta.url)), 'utf8').split('\n');

    // A line that ARMS something is code; `src/harness.ts` also mentions these names
    // in prose ("Microtasks rather than setTimeout"), so comment lines never count.
    const codeLines = (lines: string[], needle: string) =>
        lines
            .map((line, index) => ({ line, index }))
            .filter(({ line }) => line.includes(needle) && !line.trim().startsWith('//'));

    it('arms exactly one turn-bounding timer, and only behind a finiteness check', () => {
        const lines = harnessSource();

        const armed = codeLines(lines, 'setTimeout(');
        expect(armed).toHaveLength(1);

        // The single arm site is the delegation's, and it is the FIRST statement
        // inside the `Number.isFinite(timeoutMs)` guard — an omitted or non-finite
        // bound therefore arms nothing rather than arming a 0 ms timer.
        expect(armed[0].line).toContain('timeoutTimer = setTimeout(');
        expect(lines[armed[0].index - 1]).toContain('if (Number.isFinite(timeoutMs)) {');

        // And it is cleared behind an existence check, so the unbounded path (no
        // handle) cannot clear a handle that was never created.
        const cleared = codeLines(lines, 'clearTimeout(');
        expect(cleared).toHaveLength(1);
        expect(cleared[0].line).toContain('if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);');

        // The fallback is the exported constant — the single readable place the
        // "no limit by default" fact lives (core/agent-limits.ts, value infinity).
        const fallback = codeLines(lines, ': DELEGATE_TIMEOUT_MS');
        expect(fallback).toHaveLength(1);
    });
});

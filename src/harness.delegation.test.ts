// Explicit primary/subagent configuration and bounded delegation (R4).
//
// Contract pinned here:
//   - `primary` selects the entry agent; without it the first `agents` key wins;
//   - `subagents` is an allowlist, defaulting to every agent except the primary;
//   - the `agentDelegate` tool is core but declared ONLY to the primary, so a subagent
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
        expect(writer.tools.agentDelegate).toBeDefined();
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
        expect(writer.tools.agentDelegate).toBeUndefined();
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
            (writer.tools.agentDelegate.parameters as Record<string, any>).properties.agent.enum
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

describe('agentDelegate', () => {
    it('declares delegate to the primary only', async () => {
        const seenWriter: HarnessStreamRequest[] = [];
        const seenResearcher: HarnessStreamRequest[] = [];

        const researcher = brain(scripted([answer('facts')], seenResearcher));
        const writerAgent = brain(
            scripted(
                [
                    callTool('c1', 'agentDelegate', '{"agent":"researcher","input":"find facts"}'),
                    answer('final')
                ],
                seenWriter
            )
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        await writer('go');

        // The primary sees toolRequest, toolCreate, delegate. The subagent never sees
        // the delegation control.
        expect(declaredNames(seenWriter[0])).toEqual([
            'toolRequest',
            'toolCreate',
            'todoManage',
            'profileManage',
            'chapterManage',
            'locationManage',
            'agentDelegate',
            'threadFork',
        ]);
        expect(declaredNames(seenResearcher[0])).toEqual([
            'toolRequest',
            'toolCreate',
            'todoManage',
            'profileManage',
            'chapterManage',
            'locationManage',
            'threadFork'
        ]);
    });

    it('runs the subagent under its own instructions and returns only its answer', async () => {
        const researcher = brain(scripted([answer('the facts')]), {
            instruction: 'You are a researcher. Answer briefly.'
        });

        const writerAgent = brain(
            scripted([
                callTool('c1', 'agentDelegate', '{"agent":"researcher","input":"find facts"}'),
                answer('final')
            ])
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        const message = await writer('go');

        expect(message.content).toBe('final');

        // Only the answer crosses back, as data.
        expect(content(writerAgent.messages[2])).toBe('{"agent":"researcher","content":"the facts"}');

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
            scripted([callTool('c1', 'agentDelegate', '{"agent":"editor","input":"edit"}'), answer('recovered')])
        );

        const writer = harness({
            agents: { writer: writerAgent, researcher, editor },
            subagents: ['researcher'],
            presets: false
        });

        await writer('go');

        expect(content(writerAgent.messages[2])).toBe(
            'Tool "agentDelegate" received arguments that do not match its schema: $.agent must be one of: "researcher".'
        );
    });

    it('rejects a subagent that tries to delegate (guessed name)', async () => {
        const researcher = brain(
            scripted([
                callTool('r1', 'agentDelegate', '{"agent":"researcher","input":"again"}'),
                answer('blocked')
            ])
        );

        const writerAgent = brain(
            scripted([
                callTool('c1', 'agentDelegate', '{"agent":"researcher","input":"go"}'),
                answer('final')
            ])
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        await writer('go');

        // The subagent's call is answered with a tool result it can read; the run
        // does not crash and delegation stays one level deep.
        expect(content(researcher.messages[2])).toBe(
            'Tool "agentDelegate" is only available to the primary agent "writer".'
        );
        expect(content(writerAgent.messages[2])).toBe('{"agent":"researcher","content":"blocked"}');
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
                callTool('c1', 'agentDelegate', '{"agent":"researcher","input":"find facts"}'),
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
        expect(content(writerAgent.messages[2])).toBe('{"agent":"researcher","content":"\\n"}');
    });

    // T2/R1: no substantive text anywhere in the run => keep the exact blank result
    // rather than inventing an answer.
    it('keeps a genuinely blank answer when nothing substantive was said', async () => {
        const researcher = brain(scripted([answer('\n')]));

        const writerAgent = brain(
            scripted([
                callTool('c1', 'agentDelegate', '{"agent":"researcher","input":"find facts"}'),
                answer('final')
            ])
        );

        const writer = harness({ agents: { writer: writerAgent, researcher }, presets: false });
        await writer('go');

        // The child's own transcript keeps the blank turn...
        expect(content(researcher.messages.at(-1))).toBe('\n');
        // ...and the delegate returns it verbatim.
        expect(content(writerAgent.messages[2])).toBe('{"agent":"researcher","content":"\\n"}');
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
                callTool('c1', 'agentDelegate', '{"agent":"researcher","input":"find facts"}'),
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

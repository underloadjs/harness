// R10 at the harness boundary: the model-facing result/error cap, and
// cancellation propagation.
//
// Contract pinned here:
//   - every serialized tool result the model sees goes through the 64 KiB cap;
//   - every tool ERROR goes through the same cap;
//   - a small result is still fed back byte-exact;
//   - `signal` reaches the transport, a tool's `ToolContext.signal`, a delegated
//     subagent's request, and a ctx.run agent's tools;
//   - an aborted run starts no new tool call, rejects, and rolls its history
//     back;
//   - a tool that observes the signal is a cancellation, NOT a "failed" tool
//     result the model could retry.

import { describe, expect, it } from 'vitest';
import { agent, harness, tool, utf8ByteLength } from '@underload/harness';
import type {
    HarnessEvent,
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

const brain = (stream: HarnessStream, extra: Record<string, unknown> = {}) =>
    agent({ model: 'merge/ds4-flash', stream, ...extra });

describe('model-facing result budget', () => {
    it('leaves a small result byte-exact', async () => {
        const echo = tool({
            description: 'Echo.',
            tags: ['echo'],
            visibility: 'core',
            execute: () => ({ ok: true })
        });
        const entry = brain(scripted([callTool('c1', 'echo', '{}'), answer('done')]));
        const writer = harness({ agents: { writer: entry }, tools: { echo }, presets: false });

        await writer('go');

        expect((entry.messages[2] as { content: string }).content).toBe('{"ok":true}');
    });

    it('caps a huge tool result in a valid truncation envelope, in the transcript and the event', async () => {
        // Must exceed the 256 KiB cap, so the fixture scales with it.
        const huge = 'z'.repeat(300_000);
        const dump = tool({
            description: 'Dump.',
            tags: ['dump'],
            visibility: 'core',
            execute: () => huge
        });
        const events: HarnessEvent[] = [];
        const entry = brain(scripted([callTool('c1', 'dump', '{}'), answer('done')]));
        const writer = harness({
            agents: { writer: entry },
            tools: { dump },
            presets: false,
            report: { progress: (event) => void events.push(event) }
        });

        await writer('go');

        const fed = (entry.messages[2] as { content: string }).content;

        // Truncation is applied once, before BOTH the transcript and the event, so
        // a client and a reload agree byte for byte. Exact envelope: the middle is
        // cut and named, and the model is told which call to re-run (T5.1).
        expect(JSON.parse(fed)).toEqual({
            truncated: true,
            originalBytes: 300_000,
            budgetBytes: 262_144,
            note: "Cut 64071 of 300000 bytes from the middle by a 262144-byte cap; kept a 176946-byte head and a 58983-byte tail. The full text is not in this transcript: re-run tool 'dump' (call c1) with narrower arguments to fetch it.",
            content: 'z'.repeat(176_946),
            tail: 'z'.repeat(58_983)
        });

        const result = events.find((event) => event.type === 'tool_result');
        expect(result).toMatchObject({ type: 'tool_result', name: 'dump', isError: false, content: fed });
    });

    it('caps a huge error message too', async () => {
        const boom = tool({
            description: 'Boom.',
            tags: ['boom'],
            visibility: 'core',
            execute: () => {
                throw new Error('e'.repeat(300_000));
            }
        });
        const entry = brain(scripted([callTool('c1', 'boom', '{}'), answer('recovered')]));
        const writer = harness({ agents: { writer: entry }, tools: { boom }, presets: false });

        await writer('go');

        const message = `Tool "boom" failed: ${'e'.repeat(300_000)}`;

        expect(JSON.parse((entry.messages[2] as { content: string }).content)).toEqual({
            truncated: true,
            originalBytes: message.length,
            budgetBytes: 262_144,
            note: "Cut 64091 of 300020 bytes from the middle by a 262144-byte cap; kept a 176946-byte head and a 58983-byte tail. The full text is not in this transcript: re-run tool 'boom' (call c1) with narrower arguments to fetch it.",
            content: message.slice(0, 176_946),
            tail: message.slice(message.length - 58_983)
        });
    });
});

describe('cancellation', () => {
    it('does not start a run when the signal is already aborted', async () => {
        const entry = brain(scripted([answer('never')]));
        const writer = harness({ agents: { writer: entry }, presets: false });
        const controller = new AbortController();
        controller.abort();

        await expect(writer('go', { signal: controller.signal })).rejects.toThrow(
            'This operation was aborted'
        );
        // Nothing was appended, so the cancelled call cannot be replayed later.
        expect(entry.messages).toEqual([]);
    });

    it('stops before the next tool call when cancelled mid-run', async () => {
        const controller = new AbortController();
        const executed: string[] = [];

        const first = tool({
            description: 'First.',
            tags: ['first'],
            visibility: 'core',
            execute: () => {
                executed.push('first');
                // The operator cancels WHILE this tool runs; the harness must not
                // start the second call of the same round.
                controller.abort();
                return 'first done';
            }
        });
        const second = tool({
            description: 'Second.',
            tags: ['second'],
            visibility: 'core',
            execute: () => {
                executed.push('second');
                return 'second done';
            }
        });

        const entry = brain(
            scripted([
                [
                    {
                        type: 'done',
                        stopReason: 'tool_calls',
                        toolCalls: [
                            { id: 'c1', name: 'first', arguments: '{}' },
                            { id: 'c2', name: 'second', arguments: '{}' }
                        ]
                    }
                ],
                answer('never')
            ])
        );
        const writer = harness({ agents: { writer: entry }, tools: { first, second }, presets: false });

        await expect(writer('go', { signal: controller.signal })).rejects.toThrow(
            'This operation was aborted'
        );

        // Only the call that was already running executed; the run rolled back, so
        // the first tool's message is gone with the rest of the turn.
        expect(executed).toEqual(['first']);
        expect(entry.messages).toEqual([]);
    });

    it('forwards the signal into ToolContext and treats an observing tool as a cancellation', async () => {
        const controller = new AbortController();
        let seen: AbortSignal | undefined;

        const stop = tool({
            description: 'Stop.',
            tags: ['stop'],
            visibility: 'core',
            execute: ({ signal }) => {
                seen = signal;
                controller.abort();
                throw new Error('stopped by the caller');
            }
        });

        const entry = brain(scripted([callTool('c1', 'stop', '{}'), answer('never')]));
        const writer = harness({ agents: { writer: entry }, tools: { stop }, presets: false });

        await expect(writer('go', { signal: controller.signal })).rejects.toThrow(
            'stopped by the caller'
        );

        // The SAME cancellation reached the tool: each call gets its own
        // controller linked to the run signal, so the per-call signal is aborted
        // (and is not the root object itself). The failure is not reported as a
        // recoverable tool result: a cancelled run must not invite a retry.
        expect(seen).toBeInstanceOf(AbortSignal);
        expect(seen?.aborted).toBe(true);
        expect(entry.messages).toEqual([]);
    });

    it('reaches a delegated subagent and its tools', async () => {
        const controller = new AbortController();
        const seenTools: (AbortSignal | undefined)[] = [];

        const probe = tool({
            description: 'Probe.',
            tags: ['probe'],
            visibility: 'core',
            execute: ({ signal }) => {
                seenTools.push(signal);
                // Cancel WHILE the subagent's tool is running: the derived
                // per-call controllers must already be linked at this point.
                controller.abort();
                return 'ok';
            }
        });

        const seenResearcher: HarnessStreamRequest[] = [];
        const researcher = brain(scripted([callTool('r1', 'probe', '{}'), answer('facts')], seenResearcher));
        const writerAgent = brain(
            scripted([callTool('c1', 'delegate', '{"agent":"researcher","input":"find"}'), answer('final')])
        );

        const writer = harness({
            agents: { writer: writerAgent, researcher },
            tools: { probe },
            presets: false
        });

        await expect(writer('go', { signal: controller.signal })).rejects.toThrow(
            'This operation was aborted'
        );

        // The subagent's request carries a cancellation signal derived from the
        // run's (not the run object itself, because the delegation call owns its
        // own controller) ...
        expect(seenResearcher[0].signal).toBeInstanceOf(AbortSignal);
        expect(seenResearcher[0].signal?.aborted).toBe(true);
        // ... and so does the tool the subagent then calls.
        expect(seenTools).toHaveLength(1);
        expect(seenTools[0]).toBeInstanceOf(AbortSignal);
        expect(seenTools[0]?.aborted).toBe(true);
    });

    it('reaches the tools of an agent started through ctx.run', async () => {
        const controller = new AbortController();
        const seenTools: (AbortSignal | undefined)[] = [];

        const probe = tool({
            description: 'Probe.',
            tags: ['probe'],
            visibility: 'core',
            execute: ({ signal }) => {
                seenTools.push(signal);
                controller.abort();
                return 'ok';
            }
        });
        const summarizer = brain(scripted([callTool('s1', 'probe', '{}'), answer('summary')]));
        const delegate = tool({
            description: 'Delegate.',
            tags: ['agents'],
            visibility: 'core',
            execute: ({ run }) => run!('summarizer', 'text')
        });

        const entry = brain(scripted([callTool('c1', 'delegate', '{}'), answer('done')]));
        const writer = harness({
            agents: { writer: entry, summarizer },
            tools: { probe, delegate },
            presets: false
        });

        await expect(writer('go', { signal: controller.signal })).rejects.toThrow(
            'This operation was aborted'
        );

        expect(seenTools).toHaveLength(1);
        expect(seenTools[0]).toBeInstanceOf(AbortSignal);
        expect(seenTools[0]?.aborted).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// T5.1/T5.2/T5.4 — the budget and the estimate AT THE HARNESS BOUNDARY. The pure
// rules live in src/core/result-budget.test.ts and src/core/context-estimate.test.ts;
// this is the proof the run actually applies them: which delivery of one turn gets
// spilled, that the envelope names the call the model must re-run, and that a
// reported `usage` frame re-anchors the next `turn.before` estimate.
// ---------------------------------------------------------------------------

const calls = (turn: string, ...requested: Array<[string, string, string]>): HarnessStreamEvent[] => [
    {
        type: 'done',
        stopReason: 'tool_calls',
        toolCalls: requested.map(([id, name, args]) => ({ id, name, arguments: args })),
        // The per-turn tally counts a turn's results, so this scripted turn is the
        // window the aggregate guard bounds.
        ...(turn === 'usage'
            ? { usage: { input: 900, output: 12, total: 912 } }
            : {})
    }
];

describe('per-turn tool-result budget at the harness boundary', () => {
    it('bounds the SUM of one turn: the first two results keep the cap, the third is spilled', async () => {
        // 3 x 300 000 bytes through a 256 KiB per-result cap and a 512 KiB per-turn
        // cap. Deliveries of one assistant message are synchronous and in the order
        // the model listed them, so WHICH result spills is deterministic: c1 and c2
        // take the per-result envelope (236 241 bytes each, pinned above), the
        // window has 524 288 - 472 482 = 51 806 bytes left, and c3 is cut to that.
        const echo = tool({
            description: 'Echo.',
            tags: ['echo'],
            visibility: 'core',
            execute: () => 'z'.repeat(300_000)
        });
        const entry = brain(scripted([calls('plain', ['c1', 'echo', '{}'], ['c2', 'echo', '{}'], ['c3', 'echo', '{}']), answer('done')]));
        const writer = harness({ agents: { writer: entry }, tools: { echo }, presets: false });

        await writer('go');

        const envelopes = [2, 3, 4].map((index) =>
            JSON.parse((entry.messages[index] as { content: string }).content) as {
                truncated: boolean;
                originalBytes: number;
                budgetBytes: number;
                note: string;
                content: string;
                tail: string;
            }
        );

        // The first two: the ordinary per-result cap, each naming its own call.
        expect(envelopes[0]).toEqual({
            truncated: true,
            originalBytes: 300_000,
            budgetBytes: 262_144,
            note: "Cut 64071 of 300000 bytes from the middle by a 262144-byte cap; kept a 176946-byte head and a 58983-byte tail. The full text is not in this transcript: re-run tool 'echo' (call c1) with narrower arguments to fetch it.",
            content: 'z'.repeat(176_946),
            tail: 'z'.repeat(58_983)
        });
        expect(envelopes[1].note).toContain("re-run tool 'echo' (call c2)");

        // The third: spilled by the AGGREGATE, and the note says so — a model that
        // reads only this envelope can tell "my result was huge" from "this turn was".
        expect(envelopes[2].originalBytes).toBe(300_000);
        expect(envelopes[2].budgetBytes).toBe(51_806);
        expect(envelopes[2].note).toContain("51806-byte budget set by this turn's 524288-byte per-turn cap");
        expect(envelopes[2].note).toContain("re-run tool 'echo' (call c3)");
        expect(utf8ByteLength(envelopes[2].content) + utf8ByteLength(envelopes[2].tail)).toBe(46_625);
        expect(envelopes[2].content.startsWith('zzzz')).toBe(true);
        expect(envelopes[2].tail.endsWith('zzzz')).toBe(true);

        // The turn's committed total is over the cap by less than one envelope, and
        // NOTHING was dropped: three calls, three results, pairing intact.
        expect(entry.messages.filter((message) => message.role === 'tool')).toHaveLength(3);
    });

    it('leaves a turn under the aggregate exactly as the per-result cap alone would', async () => {
        // The no-cost property at the boundary: one big result is byte-identical to
        // what this file pins for a single delivery.
        const echo = tool({
            description: 'Echo.',
            tags: ['echo'],
            visibility: 'core',
            execute: () => 'z'.repeat(300_000)
        });
        const single = brain(scripted([calls('plain', ['c1', 'echo', '{}']), answer('done')]));
        const writer = harness({ agents: { writer: single }, tools: { echo }, presets: false });

        await writer('go');

        expect((single.messages[2] as { content: string }).content).toBe(
            JSON.stringify({
                truncated: true,
                originalBytes: 300_000,
                budgetBytes: 262_144,
                note: "Cut 64071 of 300000 bytes from the middle by a 262144-byte cap; kept a 176946-byte head and a 58983-byte tail. The full text is not in this transcript: re-run tool 'echo' (call c1) with narrower arguments to fetch it.",
                content: 'z'.repeat(176_946),
                tail: 'z'.repeat(58_983)
            })
        );
    });
});

describe('provider-anchored context estimate (T5.4)', () => {
    // Runs the scripted conversation and records the number the shipped compactor
    // compares against its limit, turn by turn. `seed` is long text already in the
    // transcript, so the sanity band has something to bite on.
    const estimatesWith = async (turns: HarnessStreamEvent[][], seed = ''): Promise<number[]> => {
        const estimates: number[] = [];
        const echo = tool({
            description: 'Echo.',
            tags: ['echo'],
            visibility: 'core',
            execute: () => 'ok'
        });
        const entry = brain(
            scripted(turns),
            seed.length > 0 ? { messages: [{ role: 'user', content: seed }] } : {}
        );
        const writer = harness({
            agents: { writer: entry },
            tools: { echo },
            presets: false,
            plugins: [
                {
                    name: 'estimate-watcher',
                    setup: (api) => {
                        api.on('turn.before', (payload) => {
                            estimates.push(payload.estimatedTokens);
                            // Nothing has been written in this round, so the entry-time
                            // and live views of the SAME number must agree — the property
                            // the `minTokens` floor depends on.
                            expect(payload.currentEstimatedTokens()).toBe(payload.estimatedTokens);
                        });
                    }
                }
            ]
        });

        await writer('go');

        return estimates;
    };

    const answerTurn: HarnessStreamEvent[] = [
        { type: 'text', delta: 'done' },
        { type: 'done', stopReason: 'stop', toolCalls: [] }
    ];

    it('extrapolates the next turn from the reported prompt size', async () => {
        // Hand-derived, not read off the implementation.
        //   turn 1 sends one 2-character user message and this agent has no
        //   instructions, so the anchored prefix is 2 characters: the plain
        //   ceil(2/4) = 1, because nothing has been reported yet.
        //   The provider reports 900 prompt tokens for THAT request.
        //   turn 2 sends 'go' (2) + the assistant turn's call name 'echo' (4) and its
        //   raw arguments '{}' (2) + the tool result 'ok' (2) and its pairing name
        //   'echo' (4) = 14 characters, i.e. 12 more than the anchored prefix.
        //   So the estimate is 900 + ceil(12 / 4) = 903, and the ~890 tokens of tool
        //   schema and message framing the heuristic cannot see are inside the number
        //   the compaction limit is compared against.
        expect(await estimatesWith([calls('usage', ['c1', 'echo', '{}']), answerTurn])).toEqual([1, 903]);
    });

    it('keeps the plain heuristic when the provider reports no usage', async () => {
        // The identical conversation with the `usage` field absent: byte-for-byte the
        // pre-T5.4 behaviour — 14 characters -> ceil(14/4) = 4.
        expect(await estimatesWith([calls('plain', ['c1', 'echo', '{}']), answerTurn])).toEqual([1, 4]);
    });

    it('adopts an anchor BELOW the heuristic when the text can support it', async () => {
        // 4002 characters of prefix -> a heuristic of ceil(4002/4) = 1001. The
        // provider reports 900, which is inside the sanity band (900*4 >= 1001), so it
        // is a real measurement of a denser tokenizer and the number steps DOWN.
        // This is the stated correction rule, not drift: it happens once per request,
        // and only against this file's own extrapolation. Turn 2 then measures 4014
        // characters, 12 more than the anchored prefix -> 900 + 3 = 903.
        expect(await estimatesWith([calls('usage', ['c1', 'echo', '{}']), answerTurn], 'p'.repeat(4000))).toEqual([
            1001, 903
        ]);
    });

    it('refuses a count the transcript cannot support and stays on the heuristic', async () => {
        // Same 4002-character prefix (heuristic 1001), reported `input` 100: four
        // hundred tokens of text cannot fit in a hundred tokens, so this is not this
        // request's prompt size (a provider counting only the uncached delta, say).
        // The estimate keeps the heuristic it has always used: 1001, then
        // ceil(4014/4) = 1004.
        const refused: HarnessStreamEvent[] = [
            {
                type: 'done',
                stopReason: 'tool_calls',
                toolCalls: [{ id: 'c1', name: 'echo', arguments: '{}' }],
                usage: { input: 100, output: 1, total: 101 }
            }
        ];

        expect(await estimatesWith([refused, answerTurn], 'p'.repeat(4000))).toEqual([1001, 1004]);
    });
});

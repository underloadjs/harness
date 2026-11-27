// R10 at the harness boundary: the model-facing result/error cap, and
// cancellation propagation.
//
// Contract pinned here:
//   - every serialized tool result the model sees goes through the per-result
//     envelope, which is sized in tokens from the model's context window (8192 tokens
//     x 4 bytes = 32 768 bytes for the built-in 200 000-token default), and one turn's
//     results together through the per-turn envelope (24 576 tokens = 98 304 bytes);
//   - every tool ERROR goes through the same cap;
//   - an over-budget result that is a JSON DOCUMENT is REFUSED rather than cut
//     (F-CUTTER): the delivery is the budget's refusal sentence, the outcome is
//     `failed`, and the same bytes reach the transcript, the `tool_result` event and
//     `tool.after`. Only text that does not parse keeps the head/tail envelope;
//   - a small result is still fed back byte-exact;
//   - `signal` reaches the transport, a tool's `ToolContext.signal`, a delegated
//     child's request, and a ctx.run agent's tools;
//   - an aborted run starts no new tool call and rejects; a thread-bound run
//     RETAINS the turns it committed (issue 0036 R1) and repairs each call left
//     without an answer by one synthesized interrupted result;
//   - a tool that observes the signal is a cancellation, NOT a "failed" tool
//     result the model could retry.

import { describe, expect, it } from 'vitest';
import { agent, harness, tool, utf8ByteLength } from './index';
import type {
    HarnessEvent,
    HarnessStream,
    HarnessStreamEvent,
    HarnessStreamRequest
} from './index';
// The measure the harness hands to the estimator as `toolSchemaChars` (src/harness.ts
// `toolSchemaBytes`). Imported from the module, not the barrel: this file re-derives the
// token figures below from the SAME serialized-payload byte count the shipped request
// path charges, so a pin is arithmetic rather than a captured implementation output.
import { toolSchemaPayloadBytes } from './core/context-estimate';

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
        // Must exceed the per-result envelope, so the fixture scales with it: the
        // built-in default window sizes the envelope at 8192 tokens x 4 bytes =
        // 32 768 bytes, and 300 000 bytes is comfortably over it. It is also NOT JSON —
        // a run of `z`s parses as nothing — which is why THIS delivery keeps the head/tail
        // envelope while the test below, on a document of the same size, is refused.
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
            budgetBytes: 32_768,
            note: "Cut 270509 of 300000 bytes from the middle by a 32768-byte cap; kept a 22118-byte head and a 7373-byte tail. The full text is not in this transcript: re-run tool 'dump' (call c1) with narrower arguments to fetch it.",
            content: 'z'.repeat(22_118),
            tail: 'z'.repeat(7_373)
        });

        const result = events.find((event) => event.type === 'tool_result');
        expect(result).toMatchObject({ type: 'tool_result', name: 'dump', isError: false, content: fed });
    });

    it('refuses an oversized JSON result as a failed call, in the transcript, the event and tool.after', async () => {
        // F-CUTTER at the delivery seam — the case the finding is actually about. The
        // fixture is a record PAGE (the shape a store/knowledge read answers with), not
        // the `z`-page the test above cuts. Over the 32 768-byte payload budget the
        // cutter used to deliver `content` (a head that ends "Unterminated string in
        // JSON") plus `tail` (a run of bytes that starts mid-value) with `isError:
        // false`, so the model was told it had received a document, could not parse
        // either half, and could not tell which records the 44 601-byte hole had taken.
        // A document that does not fit is now a FAILED call carrying one sentence.
        const page = JSON.stringify({
            ok: true,
            records: Array.from({ length: 400 }, (_, index) => ({
                id: `rec-${String(index).padStart(4, '0')}`,
                body: 'k'.repeat(120)
            })),
            nextOffset: 400
        });

        // The premise, asserted: this really is an over-budget JSON document.
        expect(utf8ByteLength(page)).toBeGreaterThan(32_768);
        expect(() => JSON.parse(page)).not.toThrow();

        const store = tool({
            description: 'Read a page of records.',
            tags: ['store'],
            visibility: 'core',
            execute: () => page
        });
        const events: HarnessEvent[] = [];
        const after: string[] = [];
        const entry = brain(scripted([callTool('c1', 'store', '{}'), answer('done')]));
        const writer = harness({
            agents: { writer: entry },
            tools: { store },
            presets: false,
            report: { progress: (event) => void events.push(event) },
            plugins: [
                {
                    name: 'after-capture',
                    setup: (api: { on: (event: string, handler: (payload: { content: string }) => void) => void }) => {
                        api.on('tool.after', (payload) => void after.push(payload.content));
                    }
                } as never
            ]
        });

        await writer('go');

        // One sentence, byte-identical in all three places a consumer reads it from.
        const refusal =
            `Tool result too large to deliver: ${utf8ByteLength(page)} bytes against a 32768-byte budget. ` +
            "The result was discarded, not truncated: no part of it reached this transcript. " +
            "Re-run tool 'store' (call c1) with narrower arguments (smaller limit, fewer ids, narrower fields) " +
            'to fetch it. If this call could have written anything, that write may already be applied — re-read before retrying.';

        expect((entry.messages[2] as { content: string }).content).toBe(refusal);
        expect(after).toEqual([refusal]);

        // The classification is what makes the sentence actionable: `failed` is derived
        // into `isError` (core/tool-outcome.ts), so the model, the UI and a retry policy
        // all see a call that did not answer rather than an answer with bytes missing.
        expect((entry.messages[2] as { outcome?: string }).outcome).toBe('failed');

        const result = events.find((event) => event.type === 'tool_result');

        expect(result).toMatchObject({
            type: 'tool_result',
            name: 'store',
            callId: 'c1',
            isError: true,
            outcome: 'failed',
            content: refusal
        });

        // Nothing was silently dropped: the message states both sizes and the door back.
        expect(refusal).toContain(`${utf8ByteLength(page)} bytes`);
        expect(refusal).toContain('32768-byte budget');
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
            budgetBytes: 32_768,
            note: "Cut 270529 of 300020 bytes from the middle by a 32768-byte cap; kept a 22118-byte head and a 7373-byte tail. The full text is not in this transcript: re-run tool 'boom' (call c1) with narrower arguments to fetch it.",
            content: message.slice(0, 22_118),
            tail: message.slice(message.length - 7_373)
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

        // Only the call that was already running executed; the run refused to start
        // the second one. Issue 0036 R1: the run is RETAINED rather than spliced back,
        // so the transcript is what the model was shown, plus one synthesized answer per
        // unanswered call. BOTH calls are unanswered: the abort landed before the first
        // tool's 'first done' result could be committed, so that real result is absent —
        // the `stringContaining` match below is what proves it was not written. Pinned
        // structurally (role/toolCallId/name) with the interrupted marker matched by
        // substring, never by the exact sentence, so the wording can be rephrased.
        expect(executed).toEqual(['first']);
        expect(entry.messages).toMatchObject([
            { role: 'user', content: 'go' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [
                    { id: 'c1', name: 'first', arguments: '{}' },
                    { id: 'c2', name: 'second', arguments: '{}' }
                ]
            },
            {
                role: 'tool',
                toolCallId: 'c1',
                name: 'first',
                content: expect.stringContaining('cancelled or interrupted')
            },
            {
                role: 'tool',
                toolCallId: 'c2',
                name: 'second',
                content: expect.stringContaining('cancelled or interrupted')
            }
        ]);
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
        // Issue 0036 R1: the cancelled run keeps its committed turns. The throwing
        // tool produced no result, so the call it belongs to is answered by ONE
        // synthesized interrupted marker — the transcript is well-formed for a replay
        // instead of ending in an unanswered assistant turn.
        expect(entry.messages).toMatchObject([
            { role: 'user', content: 'go' },
            {
                role: 'assistant',
                content: '',
                toolCalls: [{ id: 'c1', name: 'stop', arguments: '{}' }]
            },
            {
                role: 'tool',
                toolCallId: 'c1',
                name: 'stop',
                content: expect.stringContaining('cancelled or interrupted')
            }
        ]);
    });

    it('reaches a delegated child and its tools', async () => {
        const controller = new AbortController();
        const seenTools: (AbortSignal | undefined)[] = [];

        const probe = tool({
            description: 'Probe.',
            tags: ['probe'],
            visibility: 'core',
            execute: ({ signal }) => {
                seenTools.push(signal);
                // Cancel WHILE the child's tool is running: the derived
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

        // The child's request carries a cancellation signal derived from the
        // run's (not the run object itself, because the delegation call owns its
        // own controller) ...
        expect(seenResearcher[0].signal).toBeInstanceOf(AbortSignal);
        expect(seenResearcher[0].signal?.aborted).toBe(true);
        // ... and so does the tool the child then calls.
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
    it('bounds the SUM of one turn: the first three results keep the cap, the fourth is spilled', async () => {
        // 4 x 300 000 bytes through a 32 768-byte per-result envelope and a
        // 98 304-byte per-turn envelope (both sized in tokens from the built-in
        // 200 000-token default window: 8192 and 24576 tokens x 4 bytes). Deliveries of
        // one assistant message are synchronous and in the order the model listed them,
        // so WHICH result spills is deterministic: c1-c3 take the per-result envelope —
        // each one serializes to 29 800 bytes and commits 29 818 once the request body
        // escapes its quotes — the turn has 98 304 - 89 454 = 8 850 bytes left, and c4 is
        // cut to that. A fourth call is needed because a truncated result costs ~91% of
        // the envelope, so three of them still fit under a turn cap that is exactly three
        // envelopes wide.
        const echo = tool({
            description: 'Echo.',
            tags: ['echo'],
            visibility: 'core',
            execute: () => 'z'.repeat(300_000)
        });
        const entry = brain(
            scripted([
                calls('plain', ['c1', 'echo', '{}'], ['c2', 'echo', '{}'], ['c3', 'echo', '{}'], ['c4', 'echo', '{}']),
                answer('done')
            ])
        );
        const writer = harness({ agents: { writer: entry }, tools: { echo }, presets: false });

        await writer('go');

        const envelopes = [2, 3, 4, 5].map((index) =>
            JSON.parse((entry.messages[index] as { content: string }).content) as {
                truncated: boolean;
                originalBytes: number;
                budgetBytes: number;
                note: string;
                content: string;
                tail: string;
            }
        );

        // The first three: the ordinary per-result cap, each naming its own call.
        expect(envelopes[0]).toEqual({
            truncated: true,
            originalBytes: 300_000,
            budgetBytes: 32_768,
            note: "Cut 270509 of 300000 bytes from the middle by a 32768-byte cap; kept a 22118-byte head and a 7373-byte tail. The full text is not in this transcript: re-run tool 'echo' (call c1) with narrower arguments to fetch it.",
            content: 'z'.repeat(22_118),
            tail: 'z'.repeat(7_373)
        });
        expect(envelopes[1].note).toContain("re-run tool 'echo' (call c2)");
        expect(envelopes[2].note).toContain("re-run tool 'echo' (call c3)");

        // The fourth: spilled by the AGGREGATE, and the note says so — a model that
        // reads only this envelope can tell "my result was huge" from "this turn was".
        // D-F (independent review): pinned BYTE-FOR-BYTE like the three sibling envelopes
        // above, instead of "the previews together are at or under the 8,850-byte headroom".
        // The figures are the cutter's own arithmetic and therefore derivable: the byte loop
        // grows one preview `keep` at a time until the serialized envelope fits the 8,850
        // bytes this turn had left of its 98,304-byte per-turn cap (result-budget.ts
        // `envelope()`), and splits that keep 3:1 by `HEAD_PREVIEW_RATIO`/`TAIL_PREVIEW_RATIO`
        // — 7,965 text bytes to floor(7,965 x 3/4) = 5,973 of head and 1,992 of tail, all
        // ASCII `z` so text bytes and payload bytes are the same number. The loose form proved
        // too little: any smaller preview that happened to fit passed, a head/tail split that
        // ignored the 3:1 rule passed, and a note that misnamed the head or tail size passed.
        expect(envelopes[3]).toEqual({
            truncated: true,
            originalBytes: 300_000,
            budgetBytes: 8_850,
            note: "Cut 292035 of 300000 bytes from the middle by a 8850-byte budget set by this turn's 98304-byte per-turn cap; kept a 5973-byte head and a 1992-byte tail. The full text is not in this transcript: re-run tool 'echo' (call c4) with narrower arguments to fetch it.",
            content: 'z'.repeat(5_973),
            tail: 'z'.repeat(1_992)
        });

        // The turn's committed total is over the cap by less than one envelope, and
        // NOTHING was dropped: four calls, four results, pairing intact.
        expect(entry.messages.filter((message) => message.role === 'tool')).toHaveLength(4);
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
                budgetBytes: 32_768,
                note: "Cut 270509 of 300000 bytes from the middle by a 32768-byte cap; kept a 22118-byte head and a 7373-byte tail. The full text is not in this transcript: re-run tool 'echo' (call c1) with narrower arguments to fetch it.",
                content: 'z'.repeat(22_118),
                tail: 'z'.repeat(7_373)
            })
        );
    });
});

describe('provider-anchored context estimate (T5.4)', () => {
    // Runs the scripted conversation and records the number the shipped compactor
    // compares against its limit, turn by turn. `seed` is long text already in the
    // transcript, so the sanity band has something to bite on.
    //
    // `seen` optionally collects the REQUESTS the transport was handed. It exists for the
    // catalogue-floor case below: the tool declarations are the one term of the estimate
    // that is not in the transcript, and the honest expected value for a blind round is
    // `ceil((transcript + serialized catalogue) / 4)` — which this file can only compute
    // from the catalogue the request actually carried.
    const estimatesWith = async (
        turns: HarnessStreamEvent[][],
        seed = '',
        seen?: HarnessStreamRequest[]
    ): Promise<number[]> => {
        const estimates: number[] = [];
        const echo = tool({
            description: 'Echo.',
            tags: ['echo'],
            visibility: 'core',
            execute: () => 'ok'
        });
        const entry = brain(
            scripted(turns, seen),
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
        // Hand-derived, not read off the implementation. ONE constant first: the catalogue
        // this harness declares (the `echo` definition plus the runtime controls a session
        // always offers) serializes to 15,426 payload bytes — `toolSchemaPayloadBytes` of
        // the request's own `tools`, asserted exactly by the case below — so its floor is
        // ceil(15,426 / 4) = 3,857 tokens.
        //   THE MOVE, derived rather than read back: this catalogue sat at 14,377 bytes through
        //   2026-11-25, and the record/task disclosure wave put +562 bytes on `tasks` ALONE (the
        //   `ids` paging rule, the two-fact `expects` split and the single-id ceiling sentence in
        //   ../tools/runtime/tasks.tool.ts). Nothing else this roster declares changed text — the
        //   other tools the wave touched are searchable, so they are not in it — which is why the
        //   figure was 14,377 + 562 = 14,939, measured per entry on a live request in both
        //   trees by probe Temp/fix-f5/probe-floors.ts. The estimator itself moved not one line.
        //   THE 2026-11-27 MOVE (+487 B, 14,939 -> 15,426), same method, one new term: every
        //   OFFERED declaration now advertises one extra OPTIONAL property, the reserved per-call
        //   `async` switch (../core/tool.ts `withToolAsyncSwitch` injects it into the model-facing
        //   copy in ../harness.ts `offerDeclarations`), and `toolSchemaPayloadBytes` prices THAT
        //   copy. All 3 rows of this roster carry the injected key, so the estimate every case in
        //   this describe block reads now rides the new constant; the figure is MEASURED, not
        //   derived — probe Temp/coding/probe-catalogue-ab.ts shape E, both trees, whose pristine-
        //   HEAD leg reproduces 14,939 bytes exactly (which is what makes +487 a measurement). It
        //   is not 3 x a fixed per-row figure: the first `async` key into a declaration with an
        //   EMPTY `properties` object is dearer than appending beside existing keys, so the sum is
        //   read off the live request. The estimator moved no line, so each figure below is the
        //   same arithmetic on the new constant: 3,736 -> 3,857, 3,739 -> 3,860, 4,736 -> 4,857,
        //   4,739 -> 4,860 (the floor itself is ceil(15,426/4) = 3,857, was ceil(14,939/4) =
        //   3,735; neither catalogue is a multiple of 4, so the transcript keeps its own rounding).
        //   turn 1 sends one 2-byte user message and this agent has no instructions, so the
        //   anchored prefix is 2 bytes. Nothing has been reported yet, so turn 1 is the
        //   BLIND round, and the blind round now prices the catalogue that rides with it:
        //   ceil((2 + 15,426) / 4) = 3,857. (It was 1 before the catalogue floor, which is
        //   the number the measured provider refusal proved wrong: a first request the
        //   harness believed was 464 tokens was billed 31,693.)
        //   The provider reports 900 prompt tokens for THAT request.
        //   turn 2 sends 'go' (2) + the assistant turn's call name 'echo' (4) and its
        //   raw arguments '{}' (2) + the tool result 'ok' (2) and its pairing name
        //   'echo' (4) = 14 bytes, i.e. 12 more than the anchored prefix. The anchor
        //   absorbs the catalogue, so the estimate is 900 + ceil(12 x 1.166 / 4) = 904:
        //   the 1.166 is `ANCHOR_GROWTH_MARGIN` (../core/context-estimate.ts), the measured
        //   density residual on anchored growth, and it is what makes the anchored leg
        //   ceil(13.992 / 4) = 4 rather than 3.
        const seen: HarnessStreamRequest[] = [];

        expect(await estimatesWith([calls('usage', ['c1', 'echo', '{}']), answerTurn], '', seen)).toEqual([
            // Re-baselined 2026-11-27: the blind round's floor is the catalogue, which grew by the
            // advertised `async` switch (see the block above), so 3,736 -> 3,857. The ANCHORED leg
            // is untouched at 904 — the anchor absorbs the catalogue, which is the whole point.
            3857, 904
        ]);
    });

    it('prices the first request at its tool catalogue, not at its transcript', async () => {
        // THE ROUND-1 FLOOR (context T5, 2026-11-17 — the provider size refusal). The
        // catalogue is not in `messages`, so the estimator cannot see it, yet it is the
        // largest single term of a first request: 31,693 billed tokens against a 464-token
        // transcript on the session that was refused (`Temp/d1/report.md`). The harness
        // therefore hands `turn.before` the serialized weight of exactly the `tools` this
        // round declares (`toolSchemaChars`, src/harness.ts `toolSchemaBytes`), and the
        // hybrid applies that allowance ONLY on the unanchored leg.
        //
        // Derived from the request the transport was actually handed, so this is a
        // measurement of the fix rather than of a guess: the blind estimate is the
        // transcript figure PLUS this catalogue, and would be `ceil(2 / 4) = 1` without it.
        const seen: HarnessStreamRequest[] = [];
        const [firstTurn] = await estimatesWith(
            [calls('plain', ['c1', 'echo', '{}']), answerTurn],
            '',
            seen
        );

        // The catalogue the shipped request carries, asserted exactly: 3 declarations —
        // `echo` plus the runtime controls — and 15,426 serialized payload bytes (was
        // 14,939 until 2026-11-27, when every offered declaration started advertising the
        // reserved optional `async` property; +487 B measured live, block above).
        expect(seen[0].tools).toHaveLength(3);
        expect(toolSchemaPayloadBytes(seen[0].tools)).toBe(15_426);
        // The transcript alone would say 1 token; the round the provider receives is
        // ceil((2 + 15,426) / 4), and that is the number the compaction limit is compared
        // against on the round that has no anchor to hide behind.
        expect(firstTurn).toBe(Math.ceil((2 + 15_426) / 4));
        expect(firstTurn).toBeGreaterThan(1);
    });

    it('keeps the plain heuristic when the provider reports no usage', async () => {
        // The identical conversation with the `usage` field absent: still the plain
        // heuristic, but the heuristic now counts what the body carries — the transcript
        // AND the catalogue, since no anchor exists to absorb either.
        //   turn 1: ceil((2 + 15,426) / 4) = 3,857;
        //   turn 2: ceil((14 + 15,426) / 4) = ceil(15,440 / 4) = 3,860.
        // The transcript-only half is the old 1 and 4; the delta is the same 15,426 bytes
        // of declaration both rounds really send.
        expect(await estimatesWith([calls('plain', ['c1', 'echo', '{}']), answerTurn])).toEqual([
            3857, 3860
        ]);
    });

    it('adopts an anchor BELOW the heuristic when the text can support it', async () => {
        // 4,002 bytes of prefix -> a transcript-only heuristic of ceil(4,002/4) = 1001. The
        // provider reports 900, which is inside the sanity band (900*4 >= 1001), so it
        // is a real measurement of a denser tokenizer and the number steps DOWN.
        // Turn 1 is still blind, so it reports the catalogue floor:
        // ceil((4,002 + 15,426) / 4) = 4,857. Turn 2 then measures 4,014 bytes, 12 more
        // than the anchored prefix -> 900 + ceil(12 x 1.166 / 4) = 904, and the low-side
        // clamp (ceil(ceil(4,014/4) / 4) = 251) is far below it.
        expect(
            await estimatesWith([calls('usage', ['c1', 'echo', '{}']), answerTurn], 'p'.repeat(4000))
        ).toEqual([4857, 904]);
    });

    it('refuses a count the transcript cannot support and stays on the heuristic', async () => {
        // Same 4,002-byte prefix (transcript heuristic 1001), reported `input` 100: four
        // hundred tokens of text cannot fit in a hundred tokens, so this is not this
        // request's prompt size (a provider counting only the uncached delta, say). The
        // estimate keeps the heuristic it has always used — the heuristic that counts the
        // catalogue, because on this leg nothing else can: turn 1
        // ceil((4,002 + 15,426) / 4) = 4,857, then turn 2
        // ceil((4,014 + 15,426) / 4) = 4,860.
        const refused: HarnessStreamEvent[] = [
            {
                type: 'done',
                stopReason: 'tool_calls',
                toolCalls: [{ id: 'c1', name: 'echo', arguments: '{}' }],
                usage: { input: 100, output: 1, total: 101 }
            }
        ];

        expect(await estimatesWith([refused, answerTurn], 'p'.repeat(4000))).toEqual([4857, 4860]);
    });
});

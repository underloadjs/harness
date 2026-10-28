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
import { agent, harness, tool } from '@underload/harness';
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
        const huge = 'z'.repeat(70_000);
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
        // a client and a reload agree byte for byte.
        expect(JSON.parse(fed)).toEqual({
            truncated: true,
            originalBytes: 70_000,
            budgetBytes: 65_536,
            content: 'z'.repeat(58_982)
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
                throw new Error('e'.repeat(70_000));
            }
        });
        const entry = brain(scripted([callTool('c1', 'boom', '{}'), answer('recovered')]));
        const writer = harness({ agents: { writer: entry }, tools: { boom }, presets: false });

        await writer('go');

        const message = `Tool "boom" failed: ${'e'.repeat(70_000)}`;

        expect(JSON.parse((entry.messages[2] as { content: string }).content)).toEqual({
            truncated: true,
            originalBytes: message.length,
            budgetBytes: 65_536,
            content: message.slice(0, 58_982)
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

        // The SAME signal reached the tool, and the failure is not reported as a
        // recoverable tool result: a cancelled run must not invite a retry.
        expect(seen).toBe(controller.signal);
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
                return 'ok';
            }
        });

        const seenResearcher: HarnessStreamRequest[] = [];
        const researcher = brain(scripted([callTool('r1', 'probe', '{}'), answer('facts')], seenResearcher));
        const writerAgent = brain(
            scripted([callTool('c1', 'agentDelegate', '{"agent":"researcher","input":"find"}'), answer('final')])
        );

        const writer = harness({
            agents: { writer: writerAgent, researcher },
            tools: { probe },
            presets: false
        });

        await writer('go', { signal: controller.signal });

        // The subagent's request carries the run's signal ...
        expect(seenResearcher[0].signal).toBe(controller.signal);
        // ... and so does the tool the subagent then calls.
        expect(seenTools).toEqual([controller.signal]);
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

        await writer('go', { signal: controller.signal });

        expect(seenTools).toEqual([controller.signal]);
    });
});

// harness() — the `progress` event: a run's quiet tool block, made visible (task T2).
//
// Pinned contract (all of it about the ONE new kind in the closed `HarnessEvent` list,
// ../shared/harness-stream.ts `HarnessEventType`):
//   - a transport `progress` frame becomes a `progress` HARNESS event, verbatim apart
//     from `agent` (the display name, like every other frame) and `thread` (added by the
//     one `emit` gate, ../harness.ts:9604);
//   - it rides in stream order — after the text deltas of its attempt, before the
//     `tool_call`/`attempt_commit`/`done` frames the terminal round produces;
//   - IT CHANGES NOTHING ELSE: strip the `progress` events from a run and the remaining
//     event stream is byte-identical to the same run without them, and the committed
//     answer is the same. That is the "must be ignored by a reader that does not
//     understand it, never reordering or altering the other events" clause of T2 AC4;
//   - it never becomes a message and never moves a commit boundary (AC3): the frames are
//     dropped by the post-completion guard in ../core/agent.ts, and nothing downstream
//     can execute a partial call (knowledge.md:5864-5865 "partial arguments are never
//     executed");
//   - the frames of a FAILED attempt precede its `retry` frame, and the next attempt
//     reports its OWN counters: attempt scoping is a consequence of the transport
//     accumulator being re-created per request (../core/agent.ts retry loop), not of a
//     reset anyone has to remember.
//
// Run: yarn vitest run src/harness.progress.test.ts

import { describe, expect, it } from 'vitest';
import { agent, harness } from '@underload/harness';
import type { HarnessEvent, HarnessStream, HarnessStreamEvent, HarnessStreamRequest } from '@underload/harness';

const done = (): HarnessStreamEvent => ({ type: 'done', stopReason: 'stop', toolCalls: [] });

const progress = (toolCallSlots: number, argumentChars: number): HarnessStreamEvent => ({
    type: 'progress',
    phase: 'tool-composition',
    toolCallSlots,
    argumentChars
});

// Route every request through a callback so a test scripts by TRANSCRIPT, not by a
// global counter (the retry pin below needs both a failing and a succeeding request).
const routed = (route: (request: HarnessStreamRequest) => HarnessStreamEvent[]): HarnessStream =>
    async function* stream(request) {
        for (const frame of route(request)) yield frame;
    };

const run = async (stream: HarnessStream): Promise<{ events: HarnessEvent[]; content: string }> => {
    const events: HarnessEvent[] = [];

    const writer = harness({
        agents: { writer: agent({ model: 'm', stream }) },
        presets: false,
        report: { progress: (event) => void events.push(event) }
    });

    const message = await writer('go');

    return { events, content: message.content };
};

describe('harness `progress` event', () => {
    it('publishes one `progress` event per transport frame, in stream order', async () => {
        const stream = routed(() => [
            { type: 'text', delta: 'launching' },
            progress(1, 11),
            progress(2, 24),
            progress(4, 6050),
            done()
        ]);

        const { events, content } = await run(stream);

        // EXACT event stream. `agent` is stamped by the single `emit` gate; a root run
        // carries no `thread` (../types/index.ts:3989 — root events keep their recorded
        // shape), so this pin also proves the frame does not smuggle identity in. There is
        // no boundary frame between the last heartbeat and `done` for a plain
        // (non-session) run of this shape — which is exactly the blindness T2 fixes: the
        // ONLY frames a composing tool round used to produce were these two ends.
        expect(events).toEqual([
            { type: 'start', agent: 'writer', model: 'm' },
            { type: 'text', agent: 'writer', delta: 'launching' },
            { type: 'progress', agent: 'writer', phase: 'tool-composition', toolCallSlots: 1, argumentChars: 11 },
            { type: 'progress', agent: 'writer', phase: 'tool-composition', toolCallSlots: 2, argumentChars: 24 },
            { type: 'progress', agent: 'writer', phase: 'tool-composition', toolCallSlots: 4, argumentChars: 6050 },
            {
                type: 'done',
                agent: 'writer',
                message: {
                    content: 'launching',
                    model: 'm',
                    reasoning: '',
                    role: 'assistant',
                    stopReason: 'stop',
                    toolCalls: [],
                    usage: undefined
                }
            }
        ]);

        // Nothing about the ANSWER moved: the heartbeat is projection-only and can neither
        // execute a partial call nor change what the turn returns.
        expect(content).toBe('launching');
    });

    it('leaves the rest of the event stream byte-identical when a reader ignores it', async () => {
        // THE unknown-reader pin (T2 AC4). Two runs of the SAME scripted round, one with
        // the heartbeat and one without: drop the `progress` events from the first and it
        // must be indistinguishable from the second, key for key. A single stray field, a
        // reordered frame, or a duplicated boundary fails this.
        const plain = await run(routed(() => [{ type: 'text', delta: 'launching' }, done()]));

        const beating = await run(
            routed(() => [{ type: 'text', delta: 'launching' }, progress(1, 11), progress(4, 6050), done()])
        );

        const withoutProgress = beating.events.filter(
            (event): event is Exclude<HarnessEvent, { type: 'progress' }> => event.type !== 'progress'
        );

        expect(withoutProgress).toEqual(plain.events);
        expect(beating.content).toBe(plain.content);

        // And the heartbeat really was there — otherwise the filter above would be
        // comparing two identical runs and proving nothing.
        expect(beating.events.filter((event) => event.type === 'progress')).toHaveLength(2);
    });

    it('frames of the FAILED attempt precede `retry`, and the next attempt starts its own counters', async () => {
        // Attempt scoping by construction (../core/agent.ts re-creates the transport per
        // attempt): the failed attempt's frames are the only ones before the `retry`, and
        // the successful attempt reports slot 1 / 3 characters — its own accumulation —
        // rather than continuing the dead attempt's 4 / 6050.
        let attempts = 0;

        const stream = routed(() => {
            attempts += 1;

            if (attempts === 1) return [progress(4, 6050), { type: 'error', message: 'HTTP 500: overloaded' }];

            return [progress(1, 3), { type: 'text', delta: 'recovered' }, done()];
        });

        const { events, content } = await run(stream);

        const kinds = events.map((event) => event.type);

        // The failed attempt's heartbeat, then the retry, then the fresh attempt's own
        // heartbeat, then the answer's frames.
        expect(kinds).toEqual(['start', 'progress', 'retry', 'progress', 'text', 'done']);

        expect(events.filter((event) => event.type === 'progress')).toEqual([
            { type: 'progress', agent: 'writer', phase: 'tool-composition', toolCallSlots: 4, argumentChars: 6050 },
            { type: 'progress', agent: 'writer', phase: 'tool-composition', toolCallSlots: 1, argumentChars: 3 }
        ]);

        expect(content).toBe('recovered');
        expect(attempts).toBe(2);
    });

    it('drops a frame that arrives after the response completed', async () => {
        // A provider that keeps streaming past its own `finish_reason` cannot publish
        // progress for a request that is already answered: `done` sets `completed` in
        // ../core/agent.ts:1151 and everything after it is dropped for every kind,
        // `progress` included. Without this, a late frame would paint a "composing" line
        // under an already-committed answer.
        const stream = routed(() => [done(), progress(3, 40)]);

        const { events } = await run(stream);

        expect(events.filter((event) => event.type === 'progress')).toEqual([]);
        expect(events.map((event) => event.type)).toEqual(['start', 'done']);
    });
});

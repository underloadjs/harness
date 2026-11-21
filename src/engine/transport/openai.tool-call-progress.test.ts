// transport/openai.ts — the `progress` frame: WHAT it says, and HOW OFTEN it says it.
//
// WHY THIS FILE EXISTS (task T2, 2026-11-19). The journal of the live session
// (session beed8a0c…, turn ff4cc458…) recorded the last `text` delta, then 62.232 s with
// ZERO frames, then the user's abort — and zero `delegate` frames ever, because a tool
// block is invisible while it is being composed (./openai.tool-call-liveness.test.ts
// documents the blindness this replaces). The fix is a projection-only `progress` frame
// emitted from the tool-call merge site (./openai.ts, the `delta.tool_calls[]` branch).
//
// The pins below are DETERMINISTIC because the throttle is driven by a STUBBED monotonic
// clock (`performance.now`, stubbed with `vi.spyOn`, never faked via timers — the transport
// owns no timer and T2 forbids adding one). `clock.step()` is the only way time moves, so
// every frame count below is exact, not a range.
//
// The contract these pins hold, plane by plane:
//   - transport  → this file;
//   - agent      → ../core/agent.ts forwards it as an event, attempt-scoped;
//   - harness    → ../harness.ts publishes the `progress` HarnessEvent
//                  (../harness.progress.test.ts);
//   - projection → ../server/turn-projector.ts paints one attempt-scoped field and mints
//                  no node and no context block
//                  (../server/turn-projector-progress.test.ts).
//
// Run: yarn vitest run src/transport/openai.tool-call-progress.test.ts

import { afterEach, describe, expect, it, vi } from 'vitest';
import { openAICompatible } from '../index';
import type { HarnessStream, HarnessStreamEvent } from '../index';

const BASE_URL = 'http://localhost:8800/providers/private/v1';

const request = {
    model: 'local/basalt',
    messages: [{ role: 'user' as const, content: 'launch the batteries' }]
};

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

const encoder = new TextEncoder();

const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const textFrame = (delta: string): string => frame({ choices: [{ delta: { content: delta } }] });
const toolFrame = (fragment: unknown): string => frame({ choices: [{ delta: { tool_calls: [fragment] } }] });
const finishFrame = (reason: string): string => frame({ choices: [{ delta: {}, finish_reason: reason }] });
const doneFrame = 'data: [DONE]\n\n';

// A body that enqueues everything and CLOSES, so the request ends without any timer.
const closedBody = (frames: string[]): ReadableStream<Uint8Array> =>
    new ReadableStream({
        start(controller) {
            for (const item of frames) controller.enqueue(encoder.encode(item));
            controller.close();
        }
    });

const stubFetch = (body: ReadableStream<Uint8Array>) =>
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(body, { status: 200 }))
    );

// The monotonic clock the throttle reads, replaced with a counter the TEST moves.
// `vi.spyOn(performance, 'now')` is the whole trick: ./openai.ts calls `performance.now()`
// INLINE (never through a captured const), which is what makes a spy observable at all.
const fakeClock = () => {
    let now = 10_000;

    vi.spyOn(performance, 'now').mockImplementation(() => now);

    return {
        at: (ms: number) => {
            now = ms;
        },
        step: (ms: number) => {
            now += ms;
        }
    };
};

const collect = async (stream: HarnessStream): Promise<HarnessStreamEvent[]> => {
    const events: HarnessStreamEvent[] = [];

    for await (const event of stream({ ...request })) events.push(event);

    return events;
};

// Narrows to the progress frames. A helper that returned `[]` on a malformed frame would
// turn "no progress at all" into a passing pin, so the shape test below runs on the RAW
// event list instead.
const progressOf = (events: HarnessStreamEvent[]) =>
    events.filter((event): event is Extract<HarnessStreamEvent, { type: 'progress' }> => event.type === 'progress');

describe('transport `progress` frame: phase entry, throttle, and payload discipline', () => {
    it('emits a progress frame the MOMENT the first tool-call fragment is seen', async () => {
        fakeClock();

        stubFetch(
            closedBody([
                textFrame('launching'),
                toolFrame({ index: 0, id: 'call_1', function: { name: 'delegate', arguments: '{"agents":[' } }),
                finishFrame('tool_calls'),
                doneFrame
            ])
        );

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));

        // Exact ORDER and exact payload: the text delta, then the heartbeat BEFORE any
        // terminal frame, then `done`. The counters describe this fragment — one slot,
        // the 11 characters it carried.
        expect(events).toEqual([
            { type: 'text', delta: 'launching' },
            { type: 'progress', phase: 'tool-composition', toolCallSlots: 1, argumentChars: 11 },
            {
                type: 'done',
                stopReason: 'tool_calls',
                toolCalls: [{ id: 'call_1', name: 'delegate', arguments: '{"agents":[' }],
                usage: undefined
            }
        ]);
    });

    it('throttles: 20 fragments inside one 500 ms window still emit exactly ONE frame', async () => {
        fakeClock();

        // The chatty half of the outage: a relay that dribbles a big argument block. Every
        // fragment is real traffic; journaling all 20 would be 20 lines of noise per
        // half-second of generation (every harness event is journalled verbatim,
        // ../server/sessions.ts `copyEvent`).
        const fragments = Array.from({ length: 20 }, (_, index) =>
            toolFrame({ index: 0, function: { arguments: index % 2 === 0 ? '{"a":' : '"b"}' } })
        );

        stubFetch(closedBody([...fragments, finishFrame('tool_calls'), doneFrame]));

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));

        // One, not twenty — and the clock NEVER moved, so every later fragment fell inside
        // the window the phase-entry frame opened.
        expect(progressOf(events)).toEqual([
            { type: 'progress', phase: 'tool-composition', toolCallSlots: 1, argumentChars: 5 }
        ]);
    });

    it('emits again once 500 ms has passed, with counters that moved forward', async () => {
        // The 62 s shape: fragments keep arriving and the CLOCK is what decides. The
        // throttle reads `performance.now()` exactly once per tool chunk (the transport
        // touches no other clock), so a clock that advances 500 ms per read admits every
        // fragment — four frames, one per chunk, each one the accumulator's state at that
        // moment: slot 1 throughout, argument characters 7 → 8 → 15 → 22. The other
        // direction (a clock that never moves) is the pin above, which holds the SAME
        // fragments to one frame; together they pin the boundary from both sides.
        let now = 10_000;

        vi.spyOn(performance, 'now').mockImplementation(() => {
            now += 500;

            return now;
        });

        const fragments = [
            toolFrame({ index: 0, id: 'call_1', function: { name: 'delegate', arguments: '{"a":1}' } }),
            toolFrame({ index: 0, function: { arguments: '}' } }),
            toolFrame({ index: 0, function: { arguments: '{"b":2}' } }),
            toolFrame({ index: 0, function: { arguments: '{"c":3}' } })
        ];

        stubFetch(closedBody([...fragments, finishFrame('tool_calls'), doneFrame]));

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));

        expect(progressOf(events)).toEqual([
            { type: 'progress', phase: 'tool-composition', toolCallSlots: 1, argumentChars: 7 },
            { type: 'progress', phase: 'tool-composition', toolCallSlots: 1, argumentChars: 8 },
            { type: 'progress', phase: 'tool-composition', toolCallSlots: 1, argumentChars: 15 },
            { type: 'progress', phase: 'tool-composition', toolCallSlots: 1, argumentChars: 22 }
        ]);
    });

    it('counts SLOTS across parallel calls, and never emits after the terminal frame', async () => {
        // The delegation shape: four parallel calls interleaved. The counter that matters
        // for "is it alive and how far along" is the number of calls OPENING, which is why
        // `toolCallSlots` is the accumulator's slot count rather than a per-call tally.
        stubFetch(
            closedBody([
                toolFrame({ index: 0, id: 'c0', function: { name: 'delegate', arguments: '{"q":"a"}' } }),
                toolFrame({ index: 1, id: 'c1', function: { name: 'delegate', arguments: '{"q":"b"}' } }),
                toolFrame({ index: 2, id: 'c2', function: { name: 'delegate', arguments: '{"q":"c"}' } }),
                toolFrame({ index: 3, id: 'c3', function: { name: 'delegate', arguments: '{"q":"d"}' } }),
                finishFrame('tool_calls'),
                doneFrame
            ])
        );

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));

        // One frame (the phase-entry one) at 4 slots / 9 characters — and it is the
        // SECOND-TO-LAST event: the terminal `done` is the last, so nothing about the
        // request can arrive behind it.
        expect(progressOf(events)).toEqual([
            { type: 'progress', phase: 'tool-composition', toolCallSlots: 1, argumentChars: 9 }
        ]);
        expect(events.map((event) => event.type)).toEqual(['progress', 'done']);
        expect(events.at(-1)?.type).toBe('done');
    });

    it('carries NO argument text — the payload is four keys and nothing else', async () => {
        stubFetch(
            closedBody([
                toolFrame({ index: 0, id: 'call_1', function: { name: 'delegate', arguments: '{"secret":"hunter2"}' } }),
                finishFrame('tool_calls'),
                doneFrame
            ])
        );

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));
        const [progress] = progressOf(events);

        // Exact key set. The volume reason (a 6.5k-token block re-sent per frame) and the
        // privacy reason (the journal is readable by everything that reads a turn) are both
        // answered by this one assertion: the payload is counters.
        expect(Object.keys(progress ?? {}).sort()).toEqual(['argumentChars', 'phase', 'toolCallSlots', 'type']);
        expect(progress).toEqual({ type: 'progress', phase: 'tool-composition', toolCallSlots: 1, argumentChars: 20 });

        // And the sensitive value itself appears NOWHERE in the frame, while the frame that
        // legitimately carries it (`done`) does — which is what proves the test could have
        // caught text if the payload had carried it.
        const wire = JSON.stringify(progress ?? {});

        expect(wire).not.toContain('hunter2');
        expect(wire).not.toContain('secret');
        expect(JSON.stringify(events.at(-1))).toContain('hunter2');
    });

    it('a text-only turn emits NO progress frame at all', async () => {
        // Honest absence, in the direction that protects every existing consumer: a turn
        // that never opens a tool call produces a byte-identical event stream, so no reader
        // has to tolerate a frame it does not understand in the common case.
        stubFetch(closedBody([textFrame('nothing to run'), finishFrame('stop'), doneFrame]));

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));

        expect(progressOf(events)).toEqual([]);
        expect(events).toEqual([
            { type: 'text', delta: 'nothing to run' },
            { type: 'done', stopReason: 'stop', toolCalls: [], usage: undefined }
        ]);
    });

    it('a relay that flushes the whole tool region in ONE frame still reports it once', async () => {
        // The relay leg in front of this deployment withholds the ENTIRE tool region and
        // flushes one final SSE frame
        // (services/modal/deploy/qwen3.8-27b/modal_qwen3_8_rtx6000_ninfer.py:97-100,
        // 993-1003), and SSE `: ping` comments are dropped by the OpenAI SDK decoder inside
        // that hop, so the harness can receive NOTHING until the end. The heartbeat
        // degrades to exactly one frame naming all four calls — an honest single update,
        // which is what the design requires when there is nothing else to report.
        stubFetch(
            closedBody([
                textFrame('OK, launching'),
                frame({
                    choices: [
                        {
                            delta: {
                                tool_calls: [
                                    { index: 0, id: 'c0', function: { name: 'delegate', arguments: '{"q":"a"}' } },
                                    { index: 1, id: 'c1', function: { name: 'delegate', arguments: '{"q":"b"}' } },
                                    { index: 2, id: 'c2', function: { name: 'delegate', arguments: '{"q":"c"}' } },
                                    { index: 3, id: 'c3', function: { name: 'delegate', arguments: '{"q":"d"}' } }
                                ]
                            },
                            finish_reason: 'tool_calls'
                        }
                    ]
                }),
                doneFrame
            ])
        );

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));

        expect(progressOf(events)).toEqual([
            { type: 'progress', phase: 'tool-composition', toolCallSlots: 4, argumentChars: 36 }
        ]);
        expect(events.map((event) => event.type)).toEqual(['text', 'progress', 'done']);
    });

    it('a failed request emits at most its phase-entry frame, then only the terminal frame', async () => {
        // Nothing may make a failure LOOK like progress: the heartbeat stops with the data
        // frames, and the error frame stays the last word (../harness.ts and
        // ../core/agent.ts both key their retry decisions off that frame).
        stubFetch(closedBody([toolFrame({ index: 0, id: 'call_1', function: { name: 'delegate', arguments: '{"a":' } })]));

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));

        expect(events.map((event) => event.type)).toEqual(['progress', 'error']);
        expect(progressOf(events)).toEqual([
            { type: 'progress', phase: 'tool-composition', toolCallSlots: 1, argumentChars: 5 }
        ]);
    });

    it('a zero-slot delta is not composition: no frame, and it does not spend the phase-entry frame', async () => {
        // F3 (review, 2026-11-19). A `tool_calls: []` delta is an array-shaped delta that
        // opened NOTHING, and the sample it aggregates is `{ slots: 0, chars: 0 }` — which the
        // tile prints as the self-contradictory `composing 0 tool calls · 0 chars`
        // (../ui/turns.ts:891-893). So the transport keeps the frame, and the journal line,
        // that says something.
        //
        // THE HALF THAT MATTERS: skipping it must not consume the attempt's ONE guaranteed
        // phase-entry emission. If it did, a relay that buffers the whole tool region and
        // flushes a single frame would land behind a 500 ms throttle opened by an EMPTY delta,
        // and the attempt would report nothing at all — the exact blind spot T2 removed. Both
        // directions are pinned here: the empty delta emits nothing, and the first real
        // fragment after it still emits immediately.
        fakeClock();

        stubFetch(
            closedBody([
                frame({ choices: [{ delta: { tool_calls: [] } }] }),
                toolFrame({ index: 0, id: 'call_1', function: { name: 'delegate', arguments: '{"a":1}' } }),
                finishFrame('tool_calls'),
                doneFrame
            ])
        );

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));

        expect(progressOf(events)).toEqual([
            { type: 'progress', phase: 'tool-composition', toolCallSlots: 1, argumentChars: 7 }
        ]);

        // And a turn whose ONLY tool-call delta is empty produces a byte-identical event
        // stream to a text-only turn: no frame, no `idle` invented, nothing for a reader to
        // tolerate.
        stubFetch(closedBody([frame({ choices: [{ delta: { tool_calls: [] } }] }), finishFrame('stop'), doneFrame]));

        const empty = await collect(openAICompatible({ baseURL: BASE_URL }));

        expect(empty).toEqual([{ type: 'done', stopReason: 'stop', toolCalls: [], usage: undefined }]);
    });
});

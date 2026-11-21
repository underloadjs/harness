// INDEPENDENT REVIEW PROBE (task V3) — behaviour of the FINAL tree for R3 (tool-call
// transport hardening) and R4 (tool-composition visibility), derived from the REVIEW
// BRIEF'S OWN WORDING, not from what the shipped tests assert.
//
// Every expectation below is written from the requirement text:
//   R3a  the tool-call `name` survives BOTH a name streamed in pieces AND a relay that
//        echoes the whole name per fragment (no `delegatedelegate`);
//   R3b  anonymous tool calls get a UNIQUE SYNTHETIC ID, paired BYTE-EXACTLY on both
//        sides of the transcript;
//   R3c  index-less fragments must not corrupt a DIFFERENT slot;
//   R3d  a body that closes without `[DONE]`/`finish_reason` keeps a COMPLETE tool block
//        (emit `done` + `stopReason: 'tool_calls'`) but still FAILS on PARTIAL args;
//   R4   a throttled `progress` frame (<=1 per 500 ms, none after the terminal frame,
//        NEVER any argument text), and the projector painting it without minting a
//        transcript node or context block, clearing it on retry/attempt_commit/done/error,
//        and projecting a progress-free journal to the identical display ("zero ops").
//
// Everything is stubbed: a `fetch` stub hands the transport an SSE body I wrote, and
// `performance.now` is stubbed so the throttle is exact rather than a range. No timers,
// no network, no provider.
//
// REVISED 2026-11-19 AFTER THE REVIEW THIS PROBE PRODUCED (task T8). Four expectations that
// pinned SHIPPED DEFECTS as facts were re-pinned to the fixed behaviour, each marked
// "RE-PINNED AFTER THE REVIEW" where it sits: the late name piece now concatenates instead of
// being dropped (F2), an empty `tool_calls: []` delta emits no frame instead of a zero-counter
// one (F3), and both terminal edges that end a section without a frame of its own — `settle()`
// and the parent's `tool_result` for a spawn call — now clear `toolProgress` (F1). TWO pins were
// added rather than one: the residual risk F2 leaves open (a relay that re-sends a NAME PREFIX)
// and the F3 companion that proves a zero-slot delta does not spend the attempt's phase-entry
// frame. A SECOND pass then corrected one expected VALUE (marked "RE-PINNED AGAIN"): the review
// write-up named the F2 result `delegated`, while the fragments it pinned are `deleg` + `ate`,
// whose byte-exact concatenation is `delegate` — the same slip sat in
// ./openai.tool-call-liveness.test.ts, and both pins failed against a transport that was already
// behaving correctly. The rest of this file is unchanged, and every other pin still describes the
// shipped tree.
//
// EXTENDED 2026-11-19 by the FINAL VERIFICATION WAVE (task V5): two new describes at the end of
// this file (8 more cases, 30 -> 38) probe the CORRECTION PASS itself rather than the original
// fixes — that the new `settle()` clear (`server/turn-projector.ts:3899`) adds no spurious op to a
// journal that never painted the field and no SECOND op where a frame already cleared it, that live
// fold + settle and a cold `projectTurn` still agree, that the zero-slot rule now binds EVERY
// surface (RE-PINNED the same day by task T9, which CLOSED the asymmetry that case had recorded as a
// cosmetic finding — the projector painting `{0,0}` while the CLI refused it — so it now pins the two
// surfaces ANSWERING THE SAME FRAME THE SAME WAY: `toolProgress === undefined` on the projector and
// exactly one terminal line), and that the new CLI arm (`server/cli/render.ts`) prints only validated
// frames, dedupes a repeat, and cannot be crashed by a malformed one.
//
// Run: yarn vitest run src/harness.tool-composition-review.test.ts   (cwd packages/underload/harness)

import { afterEach, describe, expect, it, vi } from 'vitest';
import { openAICompatible } from '../engine/index';
import type { HarnessStream, HarnessStreamEvent, HarnessStreamRequest, HarnessToolCall } from '../engine/types';
import type { HarnessEvent } from '../engine/harness';
import type { DisplayProjectContext, TurnDisplay, TurnDisplayOp, TurnSection } from '../engine/shared/turn-display';
import type { SessionTurn } from './protocol';
import { createTurnProjector, projectTurn } from './turn-projector';
import { createRenderer } from './cli/render';

// ---------------------------------------------------------------------------
// Transport fixtures
// ---------------------------------------------------------------------------

const BASE_URL = 'http://review.local/providers/review/v1';

const PROMPT = 'launch the batteries';

const encoder = new TextEncoder();

const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const textFrame = (delta: string): string => frame({ choices: [{ delta: { content: delta } }] });
const toolFrame = (fragment: unknown): string => frame({ choices: [{ delta: { tool_calls: [fragment] } }] });
const finishFrame = (reason: string): string => frame({ choices: [{ delta: {}, finish_reason: reason }] });
const doneFrame = 'data: [DONE]\n\n';

// A body that enqueues everything and CLOSES. Closing (rather than `[DONE]`) is what
// makes the R3d probes meaningful: the transport must decide from the bytes alone.
const closedBody = (frames: string[]): ReadableStream<Uint8Array> =>
    new ReadableStream({
        start(controller) {
            for (const item of frames) controller.enqueue(encoder.encode(item));
            controller.close();
        }
    });

const stubFetch = (body: ReadableStream<Uint8Array>) => {
    const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));

    vi.stubGlobal('fetch', fetchMock);

    return fetchMock as unknown as { mock: { calls: [string, RequestInit][] } };
};

// One stub answering a SEQUENCE of requests, so a generate turn and its replay live in
// a single test and "which request produced this body" is unambiguous.
const stubFetchSequence = (bodies: ReadableStream<Uint8Array>[]) => {
    let call = 0;

    const fetchMock = vi.fn(async () => {
        const body = bodies[Math.min(call, bodies.length - 1)];

        call += 1;

        return new Response(body, { status: 200 });
    });

    vi.stubGlobal('fetch', fetchMock);

    return fetchMock as unknown as { mock: { calls: [string, RequestInit][] } };
};

// The monotonic clock the throttle reads, moved only by the test. A frozen clock is a
// single instant: any two fragments in one run are then 0 ms apart, so the throttle
// answer is a fact, not a race.
const frozenClock = (startAt = 10_000) => {
    let now = startAt;

    vi.spyOn(performance, 'now').mockImplementation(() => now);

    return { step: (ms: number) => (now += ms) };
};

const requestOf = (messages: HarnessStreamRequest['messages']): HarnessStreamRequest => ({
    model: 'review/basalt',
    messages
});

const BASE_REQUEST = requestOf([{ role: 'user', content: PROMPT }]);

const collect = async (stream: HarnessStream, withRequest?: HarnessStreamRequest): Promise<HarnessStreamEvent[]> => {
    const events: HarnessStreamEvent[] = [];

    for await (const event of stream(withRequest ?? BASE_REQUEST)) events.push(event);

    return events;
};

const progressFrames = (events: HarnessStreamEvent[]) =>
    events.filter((event) => event.type === 'progress') as Extract<HarnessStreamEvent, { type: 'progress' }>[];

const doneFrames = (events: HarnessStreamEvent[]) =>
    events.filter((event) => event.type === 'done') as Extract<HarnessStreamEvent, { type: 'done' }>[];

const errorFrames = (events: HarnessStreamEvent[]) =>
    events.filter((event) => event.type === 'error') as Extract<HarnessStreamEvent, { type: 'error' }>[];

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('R3 review: tool-call name survival (brief clause a)', () => {
    it('concatenates a name streamed in PIECES (OpenAI shape) into the whole name', async () => {
        frozenClock();

        stubFetch(
            closedBody([
                toolFrame({ index: 0, id: 'call_pieces', function: { name: 'deleg' } }),
                toolFrame({ index: 0, function: { name: 'ate' } }),
                toolFrame({ index: 0, function: { arguments: '{"agent":"rank-a"}' } }),
                finishFrame('tool_calls'),
                doneFrame
            ])
        );

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));

        expect(doneFrames(events)).toHaveLength(1);
        expect(doneFrames(events)[0].toolCalls).toEqual([
            { id: 'call_pieces', name: 'delegate', arguments: '{"agent":"rank-a"}' }
        ]);
    });

    it('ignores a relay that ECHOES the whole name on every fragment (three echoes, one name)', async () => {
        frozenClock();

        stubFetch(
            closedBody([
                toolFrame({ index: 0, id: 'call_echo', function: { name: 'delegate', arguments: '' } }),
                toolFrame({ index: 0, function: { name: 'delegate', arguments: '{"agent"' } }),
                toolFrame({ index: 0, function: { name: 'delegate', arguments: ':"rank-a"}' } }),
                finishFrame('tool_calls'),
                doneFrame
            ])
        );

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));

        // The exact failure the brief names: the old unconditional append produced
        // `delegatedelegate` (and, with three echoes, `delegatedelegategate`).
        expect(doneFrames(events)[0].toolCalls).toEqual([
            { id: 'call_echo', name: 'delegate', arguments: '{"agent":"rank-a"}' }
        ]);
        expect(doneFrames(events)[0].toolCalls[0].name).not.toBe('delegatedelegate');
    });

    it('a name piece that arrives AFTER the first argument byte CONCATENATES (review F2)', async () => {
        frozenClock();

        // RE-PINNED AFTER THE REVIEW (2026-11-19). This probe pinned the SHIPPED rule at the
        // time it was written: the rule also dropped any name once the slot had taken an
        // argument byte, so `deleg` + (args) + `ate` flushed `deleg` — an unresolvable tool
        // that fails the WHOLE block, i.e. a regression against HEAD's unconditional append.
        // That clause is gone; the only drop left is a fragment equal to the whole name the
        // slot already holds, so the interleaved piece concatenates and the call resolves.
        stubFetch(
            closedBody([
                toolFrame({ index: 0, id: 'call_split', function: { name: 'deleg' } }),
                toolFrame({ index: 0, function: { arguments: '{"a":1}' } }),
                toolFrame({ index: 0, function: { name: 'ate' } }),
                finishFrame('tool_calls'),
                doneFrame
            ])
        );

        const calls = doneFrames(await collect(openAICompatible({ baseURL: BASE_URL })))[0].toolCalls;

        // RE-PINNED AGAIN (2026-11-19, verification): the review's write-up named the fixed
        // value `delegated`, and this pin and its sibling in ./openai.tool-call-liveness.test.ts
        // copied it. The fragments above are `deleg` and `ate`, so the byte-exact concatenation
        // is `delegate` — the tool that actually exists in this harness. The claim the pin makes
        // (a late piece CONCATENATES) is unchanged; only the spelling follows the fixtures.
        expect(calls).toEqual([{ id: 'call_split', name: 'delegate', arguments: '{"a":1}' }]);
    });

    it('RESIDUAL RISK: a relay that re-sends a PREFIX of the name is not an echo (documented, accepted)', async () => {
        frozenClock();

        // The one shape the relaxed rule still cannot resolve, pinned so the trade-off is a
        // FACT ON DISK rather than a hope: `delegate` then `deleg` is not byte-identical to
        // what the slot holds, so it concatenates and the name becomes `delegatedeleg`.
        // Acceptable because HEAD (unconditional append) produced the SAME value from the
        // SAME stream — nothing that worked before breaks — and any rule strong enough to
        // catch it has to guess whether a repeated prefix is a prefix or the first piece of a
        // longer legitimate name, which is exactly the guess that broke `delegate`.
        stubFetch(
            closedBody([
                toolFrame({ index: 0, id: 'call_prefix', function: { name: 'delegate' } }),
                toolFrame({ index: 0, function: { name: 'deleg', arguments: '{"a":1}' } }),
                finishFrame('tool_calls'),
                doneFrame
            ])
        );

        const calls = doneFrames(await collect(openAICompatible({ baseURL: BASE_URL })))[0].toolCalls;

        expect(calls).toEqual([{ id: 'call_prefix', name: 'delegatedeleg', arguments: '{"a":1}' }]);
    });

    it('still takes a name on the delta that OPENS the arguments (echo guard cannot swallow the first piece)', async () => {
        frozenClock();

        // A relay that repeats the name on the delta that also carries the first
        // argument byte has not delivered an argument byte YET, so the name must come
        // through exactly once even though no earlier fragment carried it.
        stubFetch(
            closedBody([
                toolFrame({ index: 0, id: 'call_open', function: { name: 'delegate', arguments: '{' } }),
                toolFrame({ index: 0, function: { name: 'delegate', arguments: '"a":1}' } }),
                finishFrame('tool_calls'),
                doneFrame
            ])
        );

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));

        expect(doneFrames(events)[0].toolCalls).toEqual([
            { id: 'call_open', name: 'delegate', arguments: '{"a":1}' }
        ]);
    });
});

describe('R3 review: anonymous tool calls (brief clause b)', () => {
    it('mints a UNIQUE non-empty id per anonymous call, and replays them paired on the wire', async () => {
        frozenClock();

        const generate = closedBody([
            toolFrame({ index: 0, function: { name: 'stats', arguments: '{}' } }),
            toolFrame({ index: 1, function: { name: 'logs', arguments: '{"limit":2}' } }),
            finishFrame('tool_calls'),
            doneFrame
        ]);

        // The replay body: a plain stop, so the only thing under test is the SECOND
        // request's bytes (the transcript the harness would send back).
        const replay = closedBody([textFrame('done'), finishFrame('stop'), doneFrame]);
        const fetchMock = stubFetchSequence([generate, replay]);

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));
        const calls = doneFrames(events)[0].toolCalls;

        // Two calls, names and arguments intact, ids present and DIFFERENT.
        expect(calls.map((call) => call.name)).toEqual(['stats', 'logs']);
        expect(calls.map((call) => call.arguments)).toEqual(['{}', '{"limit":2}']);
        expect(calls.every((call) => typeof call.id === 'string' && call.id.length > 0)).toBe(true);
        expect(new Set(calls.map((call) => call.id)).size).toBe(2);

        // --- the pairing half: the same ids must ride BOTH sides of the wire -------
        const replayed = await collect(
            openAICompatible({ baseURL: BASE_URL }),
            requestOf([
                { role: 'user', content: PROMPT },
                { role: 'assistant', content: '', toolCalls: calls },
                { role: 'tool', toolCallId: calls[0].id, content: 'stats ok' },
                { role: 'tool', toolCallId: calls[1].id, content: 'logs ok' }
            ])
        );

        expect(doneFrames(replayed)).toHaveLength(1);

        const wire = JSON.parse(String(fetchMock.mock.calls[1][1].body)) as {
            messages: { role: string; tool_calls?: { id: string }[]; tool_call_id?: string }[];
        };

        const assistantBlock = wire.messages.filter((message) => message.role === 'assistant').at(-1);
        const resultIds = wire.messages
            .filter((message) => message.role === 'tool')
            .map((message) => message.tool_call_id);

        // Byte-exact: the call ids on the assistant block are the SAME strings, in the
        // same order, as the `tool_call_id`s that answer them — and none is `''`.
        expect(assistantBlock?.tool_calls?.map((call) => call.id)).toEqual([...calls.map((call) => call.id)]);
        expect(resultIds).toEqual([calls[0].id, calls[1].id]);
        expect(resultIds).not.toContain('');
    });

    it('a synthetic id never collides with a provider id present in the same block', async () => {
        frozenClock();

        // Slot 1 is anonymous while slot 0 carries the id the mint would otherwise be
        // free to reuse (whatever its spelling, it must not duplicate an id in play).
        stubFetch(
            closedBody([
                toolFrame({ index: 0, id: 'call_0', function: { name: 'stats', arguments: '{}' } }),
                toolFrame({ index: 1, function: { name: 'logs', arguments: '{}' } }),
                finishFrame('tool_calls'),
                doneFrame
            ])
        );

        const calls = doneFrames(await collect(openAICompatible({ baseURL: BASE_URL })))[0].toolCalls;

        expect(calls[0].id).toBe('call_0');
        expect(calls[1].id.length > 0).toBe(true);
        expect(calls[1].id).not.toBe(calls[0].id);
    });
});

describe('R3 review: index-less fragments (brief clause c)', () => {
    it('does NOT append an index-less continuation of slot 1 onto slot 0', async () => {
        frozenClock();

        stubFetch(
            closedBody([
                toolFrame({ index: 0, id: 'call_a', function: { name: 'one', arguments: '{"x"' } }),
                toolFrame({ index: 1, id: 'call_b', function: { name: 'two', arguments: '{"y"' } }),
                // No index, no id: the provider is still streaming the slot it last named
                // (1). Attributing this to 0 is the corruption the brief names.
                toolFrame({ function: { arguments: ':1}' } }),
                toolFrame({ index: 0, function: { arguments: ':2}' } }),
                finishFrame('tool_calls'),
                doneFrame
            ])
        );

        const calls = doneFrames(await collect(openAICompatible({ baseURL: BASE_URL })))[0].toolCalls;

        // Slot 0 holds EXACTLY its own bytes plus its own explicitly-indexed
        // continuation; slot 1 owns the index-less continuation. Neither is corrupted.
        expect(calls).toEqual([
            { id: 'call_a', name: 'one', arguments: '{"x":2}' },
            { id: 'call_b', name: 'two', arguments: '{"y":1}' }
        ]);
    });

    it('gives an unknown id its own slot instead of merging it into slot 0', async () => {
        frozenClock();

        // A gateway that sends ids but never indexes: two ids, therefore two calls.
        stubFetch(
            closedBody([
                toolFrame({ id: 'call_x', function: { name: 'one', arguments: '{"a":1}' } }),
                toolFrame({ id: 'call_y', function: { name: 'two', arguments: '{"b":2}' } }),
                finishFrame('tool_calls'),
                doneFrame
            ])
        );

        const calls = doneFrames(await collect(openAICompatible({ baseURL: BASE_URL })))[0].toolCalls;

        expect(calls).toEqual([
            { id: 'call_x', name: 'one', arguments: '{"a":1}' },
            { id: 'call_y', name: 'two', arguments: '{"b":2}' }
        ]);
    });

    it('four parallel calls where ONE slot is anonymous and ANOTHER echoes its name', async () => {
        frozenClock();

        stubFetch(
            closedBody([
                toolFrame({ index: 0, id: 'call_0', function: { name: 'alpha', arguments: '{"i":0}' } }),
                toolFrame({ index: 1, id: 'call_1', function: { name: 'beta', arguments: '' } }),
                toolFrame({ index: 1, function: { name: 'beta', arguments: '{"i":1}' } }),
                toolFrame({ index: 2, function: { name: 'gamma', arguments: '{"i":2}' } }),
                toolFrame({ index: 3, id: 'call_3', function: { name: 'delta', arguments: '{"i":3}' } }),
                finishFrame('tool_calls'),
                doneFrame
            ])
        );

        const calls = doneFrames(await collect(openAICompatible({ baseURL: BASE_URL })))[0].toolCalls;

        expect(calls.map((call) => call.name)).toEqual(['alpha', 'beta', 'gamma', 'delta']);
        expect(calls.map((call) => call.arguments)).toEqual(['{"i":0}', '{"i":1}', '{"i":2}', '{"i":3}']);

        const ids = calls.map((call) => call.id);

        expect(ids[0]).toBe('call_0');
        expect(ids[1]).toBe('call_1');
        expect(ids[3]).toBe('call_3');
        // Slot 2 is the anonymous one: an id of its own, distinct from the other three.
        expect(ids[2].length > 0).toBe(true);
        expect(new Set(ids).size).toBe(4);
    });
});

describe('R3 review: an early-closed body (brief clause d)', () => {
    it('keeps a COMPLETE tool block: emits `done` with stopReason `tool_calls`', async () => {
        frozenClock();

        stubFetch(
            closedBody([
                textFrame('OK. '),
                toolFrame({ index: 0, id: 'call_0', function: { name: 'stats', arguments: '{"a"' } }),
                toolFrame({ index: 0, function: { arguments: ':1}' } }),
                toolFrame({ index: 1, id: 'call_1', function: { name: 'logs', arguments: '{"b":2}' } })
                // ... and the body simply closes: no `finish_reason`, no `[DONE]`.
            ])
        );

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));

        expect(errorFrames(events)).toHaveLength(0);
        expect(doneFrames(events)).toHaveLength(1);

        const done = doneFrames(events)[0];

        expect(done.stopReason).toBe('tool_calls');
        expect(done.toolCalls).toEqual([
            { id: 'call_0', name: 'stats', arguments: '{"a":1}' },
            { id: 'call_1', name: 'logs', arguments: '{"b":2}' }
        ]);
    });

    it('still FAILS on PARTIAL arguments: an error frame, and no `done` at all', async () => {
        frozenClock();

        stubFetch(
            closedBody([
                textFrame('OK. '),
                toolFrame({ index: 0, id: 'call_0', function: { name: 'stats', arguments: '{"a":' } })
            ])
        );

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));

        // A half-written `arguments` string is exactly what the truncation guard exists
        // for: the request is a FAILURE, so the agent retries it and no call launches.
        expect(doneFrames(events)).toHaveLength(0);
        expect(errorFrames(events)).toHaveLength(1);
        expect(errorFrames(events)[0].message.length > 0).toBe(true);
        expect(events.map((event) => event.type)).toEqual(['text', 'progress', 'error']);
    });

    it('DISCLOSED TRADE-OFF (T1): a complete no-argument call streamed as `arguments: ""` still retries', async () => {
        frozenClock();

        stubFetch(
            closedBody([toolFrame({ index: 0, id: 'call_0', function: { name: 'ping', arguments: '' } })])
        );

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));

        // Pinning the disclosed behaviour, not endorsing it: `''` is not a JSON object,
        // so this shape keeps the retry ladder instead of launching the call.
        expect(doneFrames(events)).toHaveLength(0);
        expect(errorFrames(events)).toHaveLength(1);
    });
});

describe('R4 review: the transport progress frame', () => {
    it('20 fragments inside ONE 500 ms window emit EXACTLY ONE progress frame', async () => {
        // A frozen clock: every fragment is at the same instant, so "one per 500 ms"
        // means one frame, full stop.
        frozenClock();

        const fragments = Array.from({ length: 20 }, () => toolFrame({ index: 0, function: { arguments: '0123456789' } }));

        stubFetch(closedBody([...fragments, finishFrame('tool_calls'), doneFrame]));

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));
        const progress = progressFrames(events);

        expect(progress).toHaveLength(1);
        // The one frame describes the fragment it followed, not the whole accumulation.
        expect(progress[0]).toEqual({
            type: 'progress',
            phase: 'tool-composition',
            toolCallSlots: 1,
            argumentChars: 10
        });
    });

    it('paces at exactly one frame per 500 ms over 1.6 s, with the counters of that instant', async () => {
        // A clock that moves 100 ms on EVERY read. `openAI.ts:1983` is the only
        // `performance.now()` call site in this request path (verified by grep across
        // src/transport), so one read == one tool fragment and the schedule below is
        // arithmetic, not a race.
        let now = 0;

        vi.spyOn(performance, 'now').mockImplementation(() => {
            const observed = now;

            now += 100;

            return observed;
        });

        const fragments = Array.from({ length: 16 }, () =>
            toolFrame({ index: 0, function: { arguments: '0123456789' } })
        );

        stubFetch(closedBody([...fragments, finishFrame('tool_calls'), doneFrame]));

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));
        const progress = progressFrames(events);

        // Fragments are read at t=0,100,…,1500. Emission at t=0 (the window opens), then
        // t=500, t=1000, t=1500 — the maximum the spec allows, never more, and the
        // counters are the accumulation of THAT instant (10 chars per fragment).
        expect(progress.map((frame) => frame.argumentChars)).toEqual([10, 60, 110, 160]);
        expect(progress.every((frame) => frame.phase === 'tool-composition' && frame.toolCallSlots === 1)).toBe(true);
    });

    it('carries COUNTERS ONLY — the payload key set has no room for argument text', async () => {
        // A clock that moves 600 ms per read: both fragments clear the throttle, so the
        // SECOND sample describes the whole two-slot block (the `<=1 per 500 ms` rule
        // allows exactly this spacing).
        let now = 0;

        vi.spyOn(performance, 'now').mockImplementation(() => {
            const observed = now;

            now += 600;

            return observed;
        });

        stubFetch(
            closedBody([
                toolFrame({ index: 0, id: 'call_0', function: { name: 'delegate', arguments: '{"agent":"SENTINEL_TEXT_A"' } }),
                toolFrame({ index: 1, id: 'call_1', function: { name: 'stats', arguments: '{"q":"SENTINEL_TEXT_B"}' } }),
                finishFrame('tool_calls'),
                doneFrame
            ])
        );

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));
        const progress = progressFrames(events);

        // The frames exist, so the key-set assertion below proves something.
        expect(progress.length).toBeGreaterThan(0);

        for (const frameEvent of progress) {
            expect(Object.keys(frameEvent).sort()).toEqual(['argumentChars', 'phase', 'toolCallSlots', 'type']);
        }

        // No frame carries ANY argument text (nor the tool names, which are argument
        // content the operator does not need in a heartbeat): every string value on
        // every frame is one of the two vocabulary words, and every other value is a
        // number.
        const wire = JSON.stringify(progress);

        expect(wire.includes('SENTINEL_TEXT_A')).toBe(false);
        expect(wire.includes('SENTINEL_TEXT_B')).toBe(false);
        expect(wire.includes('delegate')).toBe(false);

        for (const frameEvent of progress) {
            for (const [key, value] of Object.entries(frameEvent)) {
                if (typeof value === 'string') expect(['progress', 'tool-composition'], key).toContain(value);
                else expect(typeof value, key).toBe('number');
            }
        }

        // The LAST sample of the attempt counts both slots and every argument byte.
        expect(progress.at(-1)).toEqual({
            type: 'progress',
            phase: 'tool-composition',
            toolCallSlots: 2,
            argumentChars: '{"agent":"SENTINEL_TEXT_A"'.length + '{"q":"SENTINEL_TEXT_B"}'.length
        });
    });

    it('emits NOTHING after the terminal frame — `done` is the last event of the stream', async () => {
        frozenClock();

        // Includes a chatty provider that keeps dribbling tool fragments AFTER its own
        // `finish_reason`, which is the only way a late frame could sneak past `done`.
        stubFetch(
            closedBody([
                toolFrame({ index: 0, id: 'call_0', function: { name: 'stats', arguments: '{"a":1}' } }),
                finishFrame('tool_calls'),
                toolFrame({ index: 0, function: { arguments: '{"b":2}' } }),
                doneFrame
            ])
        );

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));

        expect(events.at(-1)?.type).toBe('done');

        const doneIndex = events.findIndex((event) => event.type === 'done');
        const lastProgress = events.map((event) => event.type).lastIndexOf('progress');

        expect(lastProgress).toBeGreaterThanOrEqual(0);
        expect(lastProgress).toBeLessThan(doneIndex);

        // The late fragments did not corrupt the flushed block either: the flush happens
        // once, at the terminal frame.
        expect(doneFrames(events)).toHaveLength(1);
    });

    it('an empty `tool_calls: []` delta emits NO progress frame (review F3)', async () => {
        frozenClock();

        stubFetch(closedBody([frame({ choices: [{ delta: { tool_calls: [] } }] }), finishFrame('stop'), doneFrame]));

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));

        // RE-PINNED AFTER THE REVIEW (2026-11-19, F3). The probe recorded the shipped rule
        // ("this branch runs for any array-shaped `tool_calls` delta"): an empty array is an
        // array, so the phase-entry frame fired with nothing composed and the tile could be
        // handed the self-contradictory line `composing 0 tool calls · 0 chars`. The transport
        // now refuses a zero-slot sample, and it does NOT spend the attempt's phase-entry
        // emission doing so — the next real fragment still reports immediately.
        expect(progressFrames(events)).toEqual([]);
        expect(events.map((event) => event.type)).toEqual(['done']);
    });

    it('an empty delta does not eat the attempt’s phase-entry frame', async () => {
        frozenClock();

        // The half that keeps F3 from becoming a new blind spot: if the zero-slot sample
        // consumed the throttle slot, the first REAL fragment of the attempt — the one frame
        // that always fires, and the only one a relaying buffer may ever produce — would be
        // silenced for the whole 500 ms window.
        stubFetch(
            closedBody([
                frame({ choices: [{ delta: { tool_calls: [] } }] }),
                toolFrame({ index: 0, id: 'call_1', function: { name: 'delegate', arguments: '{"a":1}' } }),
                finishFrame('tool_calls'),
                doneFrame
            ])
        );

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));

        expect(progressFrames(events)).toEqual([
            { type: 'progress', phase: 'tool-composition', toolCallSlots: 1, argumentChars: 7 }
        ]);
    });
});

// ---------------------------------------------------------------------------
// Projector probes (R4, compiled plane) — my own fold, my own frames.
// ---------------------------------------------------------------------------

const CONTEXT: DisplayProjectContext = { entry: 'review' };

const turnOf = (): SessionTurn => ({
    id: 'turn-review',
    index: 0,
    prompt: PROMPT,
    status: 'running',
    startedAt: 1_000,
    updatedAt: 1_000,
    events: [],
    eventTimes: []
});

const timeOf = (index: number): number => 1_000 + index * 10;

type Folded = {
    ops: TurnDisplayOp[];
    display: () => TurnDisplay;
    section: (agent: string) => TurnSection | undefined;
    settle: (status: 'done' | 'error' | 'cancelled', at: number) => void;
};

const fold = (events: HarnessEvent[]): Folded => {
    const turn = turnOf();
    const projector = createTurnProjector(turn, CONTEXT);
    const ops: TurnDisplayOp[] = [];

    events.forEach((event, index) => {
        turn.events.push(event);
        turn.eventTimes?.push(timeOf(index));

        ops.push(...(projector.apply(event, timeOf(index), index) as TurnDisplayOp[]));
    });

    return {
        ops,
        display: () => projector.display(),
        section: (agent) => projector.display().sections.find((candidate) => candidate.agent === agent),
        settle: (status, at) => projector.settle(status, at)
    };
};

const rootStart = (): HarnessEvent => ({
    type: 'start',
    agent: 'lead',
    model: 'review/test',
    thread: { id: '1', input: PROMPT }
});

const rootThread = (): HarnessEvent['thread'] => ({ id: '1' });

const childStart = (): HarnessEvent => ({
    type: 'start',
    agent: 'worker',
    model: 'review/test',
    thread: { id: '2', parentId: '1', callId: 'call-delegate', input: 'subtask' }
});

const childThread = (): HarnessEvent['thread'] => ({ id: '2', parentId: '1', callId: 'call-delegate' });

const text = (delta: string): HarnessEvent => ({ type: 'text', agent: 'lead', delta, thread: rootThread() });

const progress = (toolCallSlots: number, argumentChars: number, agent = 'lead'): HarnessEvent =>
    ({
        type: 'progress',
        agent,
        phase: 'tool-composition',
        toolCallSlots,
        argumentChars,
        ...(agent === 'lead' ? { thread: rootThread() } : { thread: childThread() })
    }) as unknown as HarnessEvent;

const commit = (): HarnessEvent => ({ type: 'attempt_commit', agent: 'lead', attempt: 1, maxAttempts: 11, thread: rootThread() });

const retry = (): HarnessEvent => ({
    type: 'retry',
    agent: 'lead',
    attempt: 1,
    maxAttempts: 11,
    delayMs: 1_000,
    error: { message: 'HTTP 500: overloaded' },
    thread: rootThread()
});

const failure = (): HarnessEvent => ({ type: 'error', agent: 'lead', error: { message: 'provider died' }, thread: rootThread() });

const answer = (): HarnessEvent =>
    ({
        type: 'done',
        agent: 'lead',
        message: { role: 'assistant', content: 'launched', reasoning: '', toolCalls: [] },
        thread: rootThread()
    }) as unknown as HarnessEvent;

// Ops that name the ONE field this feature owns.
const progressOps = (ops: TurnDisplayOp[]) =>
    ops.filter(
        (op) => (op as { patch?: { toolProgress?: unknown } }).patch?.toolProgress !== undefined
    ) as { op: string; sectionId: string; patch: { toolProgress: { phase: string; toolCallSlots: number; argumentChars: number } } }[];

// The display with ONLY that field removed; everything else must be byte-identical.
const withoutProgressField = (display: TurnDisplay): TurnDisplay =>
    JSON.parse(JSON.stringify(display, (key, value) => (key === 'toolProgress' ? undefined : value))) as TurnDisplay;

describe('R4 review: the projector paints a field, never a transcript entry', () => {
    it('a fold WITH progress frames and a fold WITHOUT it produce the same tree', () => {
        const quiet = fold([rootStart(), text('OK. '), answer()]);
        const noisy = fold([rootStart(), text('OK. '), progress(1, 40), progress(4, 6_512), answer()]);

        // The live value really is on the section on a fold that stops mid-composition.
        expect(fold([rootStart(), text('OK. '), progress(4, 6_512)]).section('lead')?.toolProgress).toEqual({
            phase: 'tool-composition',
            toolCallSlots: 4,
            argumentChars: 6_512
        });

        // Strip the one field: nodes, steps, context bar, tail, summary, order — all equal.
        expect(withoutProgressField(noisy.display())).toEqual(withoutProgressField(quiet.display()));

        // The extra ops are ONLY `section:set` patches naming that field: no
        // `node:*`, `step:*`, `context:*` or `tail:*` op appears in the noisy fold that
        // the quiet fold lacks.
        const kinds = (ops: TurnDisplayOp[]) => ops.map((op) => op.op).sort();
        const extra = [...noisy.ops].filter(
            (op) =>
                !(
                    op.op === 'section:set' &&
                    Object.keys((op as { patch: object }).patch).every((key) => key === 'toolProgress')
                )
        );

        expect(kinds(extra)).toEqual(kinds(quiet.ops));
    });

    it('clears on `retry`, on `attempt_commit`, on `done` and on `error`', () => {
        const IDLE = { phase: 'idle', toolCallSlots: 0, argumentChars: 0 };

        // The line is up first, THEN the boundary lands — the order a reader sees.
        const after = (boundary?: HarnessEvent) =>
            fold(
                boundary === undefined
                    ? [rootStart(), text('OK. '), progress(3, 900)]
                    : [rootStart(), text('OK. '), progress(3, 900), boundary]
            ).section('lead')?.toolProgress;

        expect(after()).toEqual({ phase: 'tool-composition', toolCallSlots: 3, argumentChars: 900 });
        expect(after(retry())).toEqual(IDLE);
        expect(after(commit())).toEqual(IDLE);
        expect(after(answer())).toEqual(IDLE);
        expect(after(failure())).toEqual(IDLE);
    });

    it('a progress-free journal costs ZERO progress ops and never gains the field (the zero-ops clear path)', () => {
        const quiet = fold([rootStart(), text('OK. '), commit(), retry(), text('again'), answer()]);

        expect(progressOps(quiet.ops)).toEqual([]);
        expect(Object.keys(quiet.section('lead') ?? {}).includes('toolProgress')).toBe(false);
        expect(quiet.section('lead')?.toolProgress).toBeUndefined();
    });

    it('a progress frame mints no node and cannot reorder: same nodes, same order, same content', () => {
        const base = fold([rootStart(), text('first '), answer()]);
        const noisy = fold([rootStart(), progress(1, 5), text('first '), progress(2, 12), answer()]);

        // Same node COUNT, same ORDER, and identical content on every node — the one
        // thing a progress frame may not do is add, move or rewrite a transcript entry.
        const nodesOf = (display: TurnDisplay) =>
            display.sections.map((section) =>
                section.nodes.map((node) => ({ ...node, id: 'ORDINAL' }))
            );

        expect(nodesOf(noisy.display())).toEqual(nodesOf(base.display()));
        expect(noisy.display().sections.map((section) => section.id)).toEqual(
            base.display().sections.map((section) => section.id)
        );

        // EVIDENCE FOR THE DISCLOSED ORDINAL SHIFT: node ids are minted from the journal
        // LINE INDEX, so inserting a progress line renumbers every node minted after it
        // (`n1` -> `n2` for the same text delta). Consistent within one journal, so live
        // and replay agree; it only means two DIFFERENT journals of "the same" turn are
        // not id-identical.
        expect(base.display().sections[0]?.nodes[0]?.id).toBe('n1');
        expect(noisy.display().sections[0]?.nodes[0]?.id).toBe('n2');
    });

    it('tolerates a malformed frame without touching the last snapshot', () => {
        const bogus = { ...progress(2, 500), phase: 'sideways' } as unknown as HarnessEvent;
        const negative = { ...progress(-1, 500) } as unknown as HarnessEvent;

        const events = [rootStart(), progress(2, 500), bogus, negative, progress(2, 0)];
        const section = fold(events).section('lead');

        // The unknown phase and the negative counter paint nothing; the good frames stand.
        expect(section?.toolProgress).toEqual({ phase: 'tool-composition', toolCallSlots: 2, argumentChars: 0 });
    });
});

describe('R4 review: break-it scenarios', () => {
    it('a `toolProgress` patch on a DELEGATED CHILD section lands on the child, not the root', () => {
        const delegateCall = {
            type: 'tool_call',
            agent: 'lead',
            call: { id: 'call-delegate', name: 'delegate', arguments: '{"agent":"worker"}' },
            thread: rootThread()
        } as unknown as HarnessEvent;

        const folded = fold([rootStart(), text('OK. '), delegateCall, childStart(), progress(2, 4_096, 'worker')]);

        expect(folded.section('worker')?.toolProgress).toEqual({
            phase: 'tool-composition',
            toolCallSlots: 2,
            argumentChars: 4_096
        });
        // The parent waiting on the child must not inherit the child's line.
        expect(folded.section('lead')?.toolProgress).toBeUndefined();
    });

    it('a `progress` frame AFTER `attempt_commit` on the wire re-paints the line after the boundary', () => {
        const folded = fold([rootStart(), text('OK. '), commit(), progress(3, 1_024)]);

        // Derived from the projector rule as shipped: the clear happens ON the commit
        // frame, and a later frame simply paints again. The value stays live until the
        // next boundary, which is a real (if unreachable-from-this-transport) ordering
        // hole — recorded here as evidence, not as a required behaviour.
        expect(folded.section('lead')?.toolProgress).toEqual({
            phase: 'tool-composition',
            toolCallSlots: 3,
            argumentChars: 1_024
        });
    });

    it('settle() CLEARS a line that was live when the turn was cut short (abort case)', () => {
        const folded = fold([rootStart(), text('OK. '), progress(4, 6_512)]);

        folded.settle('cancelled', 9_000);

        // RE-PINNED AFTER THE REVIEW (2026-11-19, F1). This probe pinned the shipped defect:
        // `settle` swept the state and the pending list but never the composition field, so the
        // exact incident shape — the user aborts mid-composition and the journal ends ON a
        // progress frame — stored `phase: 'tool-composition'` in a terminal section forever and
        // replayed it on every reload, against the field contract (../shared/turn-display.ts
        // "can never outlive the attempt that produced it").
        expect(folded.section('lead')?.state).toBe('cancelled');
        expect(folded.section('lead')?.toolProgress).toEqual({
            phase: 'idle',
            toolCallSlots: 0,
            argumentChars: 0
        });
    });

    it("FIXED DEFECT: a child settled by the PARENT's `tool_result` no longer keeps a LIVE composition line", () => {
        const delegateCall = {
            type: 'tool_call',
            agent: 'lead',
            call: { id: 'call-delegate', name: 'delegate', arguments: '{"agent":"worker"}' },
            thread: rootThread()
        } as unknown as HarnessEvent;

        // The child composes, then is CANCELLED: a child cancelled by its tree emits no
        // `error` frame of its own (harness.ts:9618 `if (run.aborted && run.parent)`), and
        // the parent's result for the spawn call settles the child's ROW (the `byCall`
        // settle branch of `case 'tool_result'` in turn-projector.ts) — and since F1 that
        // same branch clears the row's `toolProgress` (turn-projector.ts:3187).
        const folded = fold([
            rootStart(),
            text('OK. '),
            delegateCall,
            childStart(),
            progress(2, 4_096, 'worker'),
            {
                type: 'tool_result',
                agent: 'lead',
                name: 'delegate',
                callId: 'call-delegate',
                content: 'cancelled',
                isError: true,
                outcome: 'cancelled',
                thread: rootThread()
            } as unknown as HarnessEvent
        ]);

        const child = folded.section('worker');

        // RE-PINNED AFTER THE REVIEW (2026-11-19, F1). This probe FOUND the defect: the child
        // was settled here — by the `byCall` branch of `case 'tool_result'`, the only frame that
        // ever ends a child cancelled by its tree (harness.ts:9618 `if (run.aborted &&
        // run.parent)` means it emits no `error` frame of its own) — while its
        // `toolProgress` stayed live, which is exactly what ../shared/turn-display.ts:1145
        // ("can never outlive the attempt that produced it") and ../frontend/ui/turns.ts:4800
        // ("a journal never carries a live value on a finished turn") promise cannot happen.
        // It was user-visible because `composingProgressOf()` scans the nested sections
        // (ui/turns.ts:4758-4770), so the still-streaming parent printed
        // `composing 2 tool calls · 4,096 chars` for a child that had finished.
        expect(child?.state).toBe('cancelled');
        expect(child?.toolProgress).toEqual({ phase: 'idle', toolCallSlots: 0, argumentChars: 0 });

        // The parent still waiting on nothing keeps its own field ABSENT — the child's line is
        // cleared on the CHILD, never inherited.
        expect(folded.section('lead')?.toolProgress).toBeUndefined();
    });

    it('a transport that emits its OWN `phase: "idle"` frame paints NOTHING (idle is a display-plane spelling)', () => {
        const idle = { ...progress(4, 6_512), phase: 'idle' } as unknown as HarnessEvent;

        const folded = fold([rootStart(), progress(4, 6_512), idle]);

        // The live line survives an `idle` frame: only the projector's own boundary
        // clears are honoured, so a custom transport cannot fake a clear.
        expect(folded.section('lead')?.toolProgress).toEqual({ phase: 'tool-composition', toolCallSlots: 4, argumentChars: 6_512 });
    });
});

// Sanity: the type the transport flushes is the one the harness commits verbatim.
describe('R3 review: terminal-frame-only invariant', () => {
    it('no `tool_call`-shaped event is yielded before the terminal frame (partial args are never executable)', async () => {
        frozenClock();

        stubFetch(
            closedBody([
                textFrame('thinking'),
                toolFrame({ index: 0, id: 'call_0', function: { name: 'stats', arguments: '{"a"' } }),
                toolFrame({ index: 0, function: { arguments: ':1}' } }),
                finishFrame('tool_calls'),
                doneFrame
            ])
        );

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));

        const types = events.map((event) => event.type);

        expect(types).toEqual(['text', 'progress', 'done']);

        const calls: HarnessToolCall[] = doneFrames(events)[0].toolCalls;

        expect(calls).toEqual([{ id: 'call_0', name: 'stats', arguments: '{"a":1}' }]);
    });
});

// ---------------------------------------------------------------------------
// V5 (final verification wave, 2026-11-19) — probes of the CORRECTION PASS.
// These are written by the reviewer, not the correction worker: they hunt the
// regressions the F1/F3 fixes could plausibly introduce, none of which the
// worker's own pins cover.
// ---------------------------------------------------------------------------

// A fold that keeps EVERYTHING: the record, both op streams (per-frame and `settle`) and
// the live display, so a settle-time op can be told apart from a frame-time op.
const replay = (events: HarnessEvent[], status: 'done' | 'cancelled' | 'error' = 'cancelled') => {
    const turn = turnOf();

    turn.updatedAt = 5_000;
    turn.events.push(...events);
    turn.eventTimes?.push(...events.map((_, index) => timeOf(index)));

    const projector = createTurnProjector(turn, CONTEXT);
    const applyOps: TurnDisplayOp[] = [];

    events.forEach((event, index) => {
        applyOps.push(...(projector.apply(event, timeOf(index), index) as TurnDisplayOp[]));
    });

    const settleOps = projector.settle(status, turn.updatedAt) as TurnDisplayOp[];

    return {
        turn,
        applyOps,
        settleOps,
        allOps: [...applyOps, ...settleOps],
        live: (): TurnDisplay => projector.display()
    };
};

// A cold reload of the SAME record — the path `projectTurn`/`refoldTurn` take for every
// view read, and the only honest way to test live↔reload parity once `settle` writes an
// extra `idle` patch. `status` is part of the record, and `refoldTurn` re-settles ONLY a
// record whose status is already terminal (`server/turn-projector.ts:4138-4140`), so a
// reload of a RUNNING record must keep the live line and a reload of a CANCELLED one must
// not — both halves are pinned below.
const reload = (turn: SessionTurn, status: SessionTurn['status'] = turn.status): TurnDisplay =>
    projectTurn({ ...turn, status, events: [...turn.events] }, CONTEXT).display;

describe('V5: the F1 settle clear adds no spurious op and keeps reload parity', () => {
    it('a journal that never painted the field gains ZERO toolProgress ops, even through settle', () => {
        // The AC5-d "pre-T2 journal stays byte-identical" claim, re-tested against the NEW
        // settle sweep (`turn-projector.ts:3899`), which touches EVERY section — root
        // included — on every turn, composed or not.
        const folded = replay([rootStart(), text('OK. '), commit(), retry(), text('again'), answer()]);

        expect(progressOps(folded.applyOps)).toEqual([]);
        expect(progressOps(folded.settleOps)).toEqual([]);
        expect(folded.allOps.some((op) => (op as { patch?: unknown }).patch !== undefined)).toBe(true);

        for (const section of folded.live().sections) {
            expect(Object.keys(section).includes('toolProgress')).toBe(false);
        }
    });

    it('the frame-driven clear stays exactly ONE op, and settle adds none', () => {
        const folded = replay([rootStart(), text('OK. '), progress(3, 900), answer()]);
        const named = progressOps(folded.applyOps);

        // Two ops name the field across the frames — the PAINT and the CLEAR — and the clear
        // is the `done` frame's own. (An earlier draft of this probe expected ONE op total and
        // was counting clears only; the paint op is the second one.)
        expect(named).toHaveLength(2);
        expect(named.map((op) => op.patch.toolProgress)).toEqual([
            { phase: 'tool-composition', toolCallSlots: 3, argumentChars: 900 },
            { phase: 'idle', toolCallSlots: 0, argumentChars: 0 }
        ]);

        // The dedupe inside `paintToolProgress` (:1926-1945) holds across the NEW settle call
        // site: the field is already `idle`, so `settle` emits nothing that names it. Without
        // it, every settled turn would pay a second identical patch.
        expect(progressOps(folded.settleOps)).toEqual([]);
        expect(folded.live().sections[0]?.toolProgress).toEqual({
            phase: 'idle',
            toolCallSlots: 0,
            argumentChars: 0
        });
    });

    it('a line still live at settle produces EXACTLY one clear, on the section that held it', () => {
        const folded = replay([rootStart(), text('OK. '), progress(4, 6_512)]);
        const clears = progressOps(folded.settleOps);

        expect(clears).toHaveLength(1);
        expect(clears[0].patch.toolProgress).toEqual({ phase: 'idle', toolCallSlots: 0, argumentChars: 0 });
        expect(clears[0].sectionId).toBe(folded.live().sections[0]?.id);

        // The DATA the frontend reads after a reload: `phase !== 'tool-composition'`, so
        // `isComposing` (ui/turns.ts:873-875) is false and `compositionClauseOf` returns
        // undefined — the settled turn can print neither `composing …` nor the self-
        // contradictory `composing 0 tool calls · 0 chars`.
        expect(folded.live().sections[0]?.toolProgress?.phase).not.toBe('tool-composition');
    });

    it('live fold + settle and a cold `projectTurn` of the same record give the SAME display', () => {
        // Parity, stated the only way it can be stated: the OP STREAMS differ (live sees the
        // settle clear as an op, a cold fold never does), so the display VALUES must agree.
        const live = replay([rootStart(), text('OK. '), progress(4, 6_512)], 'cancelled');

        expect(reload(live.turn, 'cancelled')).toEqual(live.live());

        // The half that must NOT regress: a reload that lands DURING composition (the record
        // is still `running`, so nothing has settled it) keeps the live counters, which is the
        // only reason the tile can still print `composing 4 tool calls · 6,512 chars` after a
        // refresh. F1's settle clear must never fire on a running record.
        const midFlight = reload(live.turn, 'running');

        expect(midFlight.sections[0]?.toolProgress).toEqual({
            phase: 'tool-composition',
            toolCallSlots: 4,
            argumentChars: 6_512
        });
        expect(midFlight.sections[0]?.state).toBe('streaming');

        const answered = replay([rootStart(), text('OK. '), progress(2, 40), answer()], 'done');

        expect(reload(answered.turn, 'done')).toEqual(answered.live());

        // And a progress-free record still projects with no field anywhere.
        const quiet = replay([rootStart(), text('OK. '), answer()], 'done');

        expect(reload(quiet.turn, 'done')).toEqual(quiet.live());
        expect(reload(quiet.turn, 'done').sections.every((section) => section.toolProgress === undefined)).toBe(true);
    });

    it('a zero-slot frame now answers IDENTICALLY on both surfaces — the F3 projector/CLI asymmetry is CLOSED', () => {
        // RE-PINNED 2026-11-19 (task T9 CLOSED the asymmetry this case had recorded as a
        // finding). It used to pin the OPPOSITE on purpose: `toolProgressOf` accepted
        // `{ slots: 0, chars: 0 }`, so a custom transport or a journal written before F3 could
        // make the live tile print the self-contradictory `composing 0 tool calls · 0 chars`
        // (../frontend/ui/turns.ts:891-893) while the CLI validator refused the identical frame
        // (./server/cli/render.ts:103). The bound is now `toolCallSlots >= 1` in the projector
        // too (./server/turn-projector.ts:390), so the same frame paints nothing everywhere.
        //
        // WHY THIS FILE KEEPS A CASE AT ALL: only this probe imports BOTH consumers (the
        // projector at :56 and `createRenderer` at :57), so only here can the AGREEMENT be
        // pinned — ./server/turn-projector-progress.test.ts proves the projector's own halves
        // (op counts, cold reload, the real `{ 1, 0 }` frame) and the idle clear's exemption
        // (./server/turn-projector.ts:404, which never passes through `toolProgressOf`), and the
        // CLI cases below prove its validator's bounds. Neither half proves they agree.
        //
        // Not a tautology: the empty field is asserted together with the FULL op list naming
        // that field, so "refused" cannot be satisfied by a vacuous section, and the real value
        // that arrived BEFORE the refused frame must survive with exactly ONE op.
        const real = progress(2, 900);
        const vacuous = progress(0, 0);

        // The exact byte sequence both surfaces are fed: a real frame, then the vacuous one.
        const pair = (): HarnessEvent[] => [rootStart(), text('OK. '), real, vacuous];

        // (1) Projector, arriving AFTER a real sample: the snapshot is left ALONE and the
        // refused frame mints no op at all — hence the complete op list, not a "still there".
        const after = fold(pair());

        expect(after.section('lead')?.toolProgress).toEqual({
            phase: 'tool-composition',
            toolCallSlots: 2,
            argumentChars: 900
        });
        expect(progressOps(after.ops).map((op) => op.patch.toolProgress)).toEqual([
            { phase: 'tool-composition', toolCallSlots: 2, argumentChars: 900 }
        ]);

        // (2) Projector, arriving FIRST: the field stays ABSENT, i.e. the shape of a turn that
        // never composed anything — replaying a pre-F3 journal cannot invent a line.
        const first = fold([rootStart(), text('OK. '), vacuous]);

        expect(first.section('lead')?.toolProgress).toBeUndefined();
        expect(progressOps(first.ops)).toEqual([]);

        // (3) The CLI on the SAME frames: one line, for the real frame only. Read (1) and (3)
        // together and the asymmetry is gone — the projector keeps `2 · 900` exactly where the
        // terminal prints it, and the vacuous frame is silent on both.
        const lines: string[] = [];
        const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
            lines.push(String(chunk));

            return true;
        }) as unknown as typeof process.stdout.write);

        let thrown: unknown;

        try {
            const render = createRenderer({ json: false, color: false });

            for (const event of pair()) render(event);
        } catch (error) {
            thrown = error;
        } finally {
            spy.mockRestore();
        }

        expect(thrown).toBeUndefined();
        expect(lines.filter((chunk) => chunk.includes('composing'))).toEqual([
            '~ lead composing 2 tool calls · 900 chars\n'
        ]);
    });
});

describe('V5: the CLI progress arm (F4) prints only validated frames and cannot crash', () => {
    const capture = () => {
        const out: string[] = [];

        const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
            out.push(String(chunk));

            return true;
        }) as unknown as typeof process.stdout.write);

        return { out, restore: () => spy.mockRestore() };
    };

    const renderAll = (events: HarnessEvent[]) => {
        const streams = capture();
        const render = createRenderer({ json: false, color: false });
        let thrown: unknown;

        for (const event of events) {
            try {
                render(event);
            } catch (error) {
                thrown = error;
                break;
            }
        }

        streams.restore();

        return { out: streams.out, thrown };
    };

    it('prints the moving counters exactly once per distinct sample', () => {
        const rendered = renderAll([
            rootStart(),
            progress(2, 4_096),
            progress(2, 4_096),
            progress(4, 6_512),
            progress(1, 5),
            answer()
        ]);

        expect(rendered.thrown).toBeUndefined();

        // FINDING (cosmetic): the terminal prints the RAW integer (`4096`) while the tile
        // prints the grouped figure (`4,096`, `formatContextCharCount` via
        // `Intl.NumberFormat('en-US')`, ../frontend/view-context.ts:539-543). The CLI file's
        // own header promises "the terminal and the UI agree" about DURATIONS
        // (`formatDuration` is mirrored exactly); for character counts the two surfaces print
        // the same number with different digits. Same wording, different grouping — cosmetic,
        // and the counters themselves are identical.
        expect(rendered.out.filter((chunk) => chunk.includes('composing'))).toEqual([
            '~ lead composing 2 tool calls · 4096 chars\n',
            '~ lead composing 4 tool calls · 6512 chars\n',
            '~ lead composing 1 tool call · 5 chars\n'
        ]);
    });

    it('a re-sent attempt may print the same figures again', () => {
        const rendered = renderAll([rootStart(), progress(2, 64), retry(), progress(2, 64)]);

        expect(rendered.out.filter((chunk) => chunk.includes('composing'))).toHaveLength(2);
    });

    it('every malformed or vacuous progress frame prints NOTHING and throws nothing', () => {
        const bad: HarnessEvent[] = [
            { ...progress(2, 10), phase: 'sideways' } as unknown as HarnessEvent,
            { ...progress(2, 10), phase: 'idle' } as unknown as HarnessEvent,
            progress(0, 0),
            { ...progress(-1, 10) } as unknown as HarnessEvent,
            { ...progress(1.5, 10) } as unknown as HarnessEvent,
            { ...progress(2, -1) } as unknown as HarnessEvent,
            { ...progress(2, 1.5) } as unknown as HarnessEvent,
            { ...progress(2, 'ten') } as unknown as HarnessEvent,
            { type: 'progress', agent: 'lead' } as unknown as HarnessEvent,
            { type: 'progress', phase: 'tool-composition', toolCallSlots: 2, argumentChars: 4 } as unknown as HarnessEvent,
            { type: 'progress', agent: '', phase: 'tool-composition', toolCallSlots: 2, argumentChars: 4 } as unknown as HarnessEvent,
            { type: 'progress', agent: null, phase: 'tool-composition', toolCallSlots: 2, argumentChars: 4 } as unknown as HarnessEvent
        ];

        const rendered = renderAll([rootStart(), ...bad, answer()]);

        expect(rendered.thrown).toBeUndefined();
        expect(rendered.out.filter((chunk) => chunk.includes('composing'))).toEqual([]);
    });
});

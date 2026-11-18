// transport/openai.ts — PROBE: what the harness does during a long tool-call ARGUMENT
// generation, and which bound (if any) can ever see it.
//
// WHY THIS FILE EXISTS (probe P2, 2026-11-18). The Instruct app said it was "launching
// four parallel delegate batteries" and then hung until the user aborted. Journal
// forensics (session beed8a0c…, turn ff4cc458…): last frame `text "."`, then 62.232 s of
// NOTHING, then `error "This operation was aborted"` — zero `delegate` frames ever. The
// suspect is therefore the transport's handling of a tool-call generation whose TEXT has
// already ended, not the delegation logic. This probe pins, by execution:
//
//   1. VISIBILITY (Q2): `HarnessStreamEvent` has exactly four kinds — text, reasoning,
//      done, error (../types/index.ts:450-476) — and `delta.tool_calls[]` chunks are
//      folded into a private Map (./openai.ts:1769-1773 -> `mergeToolCallDelta` :937-958)
//      with NO yield. So a 60 s argument block emits zero frames at every layer: the
//      agent yields nothing (../core/agent.ts:1163-1196 has no tool-call arm), the
//      harness emits nothing (`tool_call` rides on the LAUNCH, ../harness.ts:10887, and
//      `attempt_commit` on the COMMIT, ../harness.ts:14099 — both AFTER `done`).
//   2. THE CHUNK BOUND RESETS PER CHUNK (Q3): `guardedRead` (./openai.ts:732-763) arms a
//      fresh timer on EVERY read, and `msFor` (./openai.ts:1656-1657) switches to the
//      inter-chunk bound after the first byte. A provider that keeps emitting argument
//      chunks therefore NEVER trips the 120 s bound, however long the block runs; only a
//      SILENCE of 120 s does. The probes below use the DEFAULT configuration (no
//      `*TimeoutMs` field is passed) to prove the bounds are armed out of the box:
//      provider-timeouts.ts:150-152 + server/harnesses/toolbox.ts:332-343 (`providerOf`
//      forwards the fields only when a session set one) + server/config.ts:662-673
//      (`mergeSettings` keeps an unset pair absent).
//   3. NO TOTAL BOUND (Q5): nothing measures the WHOLE request. `MODEL_TIMEOUT_MAX_MS`
//      (../core/agent-limits.ts:81) is the ceiling on a MODEL-SETTABLE `delegate`/
//      `threadFork` `timeoutMs`, not a request clock, and `armWallClock`
//      (../harness.ts:911-941) arms nothing for a non-finite value. The trickling-stream
//      probe runs past 3 600 000 simulated ms and is still open.
//   4. THE COST OF A TIMEOUT (Q4): the frame is `provider-timeout`, which ../core/agent.ts
//      :1359-1397 puts on a 4-attempt ladder (pinned by
//      ../core/agent.provider-failures.test.ts:264) — every already-generated tool
//      argument is thrown away and the request is re-sent from token one.
//   5. NO OUTPUT CEILING (Q6): the stack never SENDS `max_tokens` (toolbox.ts:338 sets
//      only `temperature`), so `finish_reason: "length"` only appears when the provider's
//      own cap bites; the probe pins that `length` is mapped and the half-built call still
//      surfaces (./openai.ts:869-873, :1835-1841).
//
// Timers are faked with `toFake` narrowed to timers only, exactly like
// ./openai.provider-timeouts.test.ts:48-53: `queueMicrotask` must stay REAL or the
// ReadableStream pumps never advance.
//
// PROBE P3 — HARDENING (issue T1, 2026-11-19). The probes below were written against the
// BROKEN behaviour and several of them pinned it as a fact. The transport now fixes the
// four defects they exposed, and the pins were moved to the fixed value (each one named
// in the `tool-call hardening (T1)` block): (1) a name the relay repeats per delta is no
// longer concatenated (`delegatedelegate` → `delegate`); (2) an anonymous call gets a
// minted `harness-call-<index>` id instead of `''`, so parallel id-less calls stay
// pairable on replay; (3) a tool block whose every `arguments` parses to a JSON object
// SURVIVES a body that closed without `[DONE]`/`finish_reason` — it becomes
// `done`/`stopReason: 'tool_calls'` instead of the codeless error that spent the 11-attempt
// ladder re-generating the same block; (4) an index-less fragment follows the slot the
// provider was streaming instead of always landing on slot 0. What did NOT change: partial
// arguments are still never executed, and a half-written block still fails the truncation
// guard.
//
// Run: yarn vitest run src/transport/openai.tool-call-liveness.test.ts
//
// PROBE P4 — VISIBILITY (task T2, 2026-11-19). Probe 1 above ("VISIBILITY (Q2)") pinned
// the blindness as a fact: `HarnessStreamEvent` had four kinds and a tool-argument block
// emitted NOTHING at any layer. That is now FIXED, so the pins that asserted "exactly two
// events" assert "exactly three, one of them a `progress` frame", and the trickling-stream
// probe drains the heartbeat instead of assuming silence. What did NOT change: the
// heartbeat carries COUNTERS ONLY (slots + argument characters, never argument text), it
// never executes or commits anything, it cannot end a run, and the terminal frame is still
// the only place a complete tool call appears. The deterministic throttle (phase-entry
// emission, the 500 ms window, nothing after `done`) is pinned by
// ./openai.tool-call-progress.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    DEFAULT_PROVIDER_STREAM_CHUNK_TIMEOUT_MS,
    PROVIDER_TIMEOUT_CODE,
    PROVIDER_TRANSIT_CLASS,
    openAICompatible
} from '@underload/harness';
import type { HarnessMessage, HarnessStream, HarnessStreamEvent, HarnessStreamRequest } from '@underload/harness';

const BASE_URL = 'http://localhost:6660/providers/private/v1';
const CHAT_URL = 'http://localhost:6660/providers/private/v1/chat/completions';

const request = {
    model: 'local/basalt',
    messages: [{ role: 'user' as const, content: 'launch the batteries' }]
};

const fakeTimers = () =>
    vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'Date']
    });

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

const encoder = new TextEncoder();

// One SSE frame, in the shape a provider writes it.
const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const textFrame = (delta: string): string => frame({ choices: [{ delta: { content: delta } }] });
const toolFrame = (fragment: unknown): string => frame({ choices: [{ delta: { tool_calls: [fragment] } }] });
const finishFrame = (reason: string): string => frame({ choices: [{ delta: {}, finish_reason: reason }] });
const doneFrame = 'data: [DONE]\n\n';

// A body that enqueues everything and CLOSES: the transport loop ends deterministically
// with real timers, so the parsing probes do not depend on a fake clock at all.
const closedBody = (frames: string[]): ReadableStream<Uint8Array> =>
    new ReadableStream({
        start(controller) {
            for (const item of frames) controller.enqueue(encoder.encode(item));
            controller.close();
        }
    });

// A body the TEST drives: `push` delivers one TCP chunk, and the body never closes, so a
// read is parked between pushes — the exact shape of a provider that is still generating.
const pushedBody = (): { stream: ReadableStream<Uint8Array>; push: (chunk: string) => void } => {
    let held: ReadableStreamDefaultController<Uint8Array> | undefined;

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            held = controller;
        }
    });

    return {
        stream,
        push: (chunk: string) => held?.enqueue(encoder.encode(chunk))
    };
};

const stubFetch = (body: ReadableStream<Uint8Array>) =>
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(body, { status: 200 }))
    );

// Collects the whole event sequence of one request. `withRequest` defaults to the
// shared one-request-per-test prompt; the id-pairing pin below replays a whole
// transcript through the transport and needs its own.
const collect = async (stream: HarnessStream, withRequest?: HarnessStreamRequest): Promise<HarnessStreamEvent[]> => {
    const events: HarnessStreamEvent[] = [];

    for await (const event of stream({ ...(withRequest ?? request) })) events.push(event);

    return events;
};

// The serialized body of one recorded fetch call — the exact bytes that would leave
// the process, which is the only honest place to read a wire id.
type WireBody = { messages: Record<string, unknown>[] };

type RecordedFetch = { mock: { calls: unknown[][] } };

const sentBody = (fetchMock: RecordedFetch, index = 0): WireBody => {
    const call = fetchMock.mock.calls[index];

    if (call === undefined) throw new Error(`the fetch stub recorded no call #${index}`);

    return JSON.parse(String((call as [string, RequestInit])[1].body)) as WireBody;
};

// One fetch stub for a SEQUENCE of requests: every call answers with the next body
// (the last one repeats). The id-pairing pin needs a generate turn AND a replay turn
// inside one test, and a second `vi.stubGlobal('fetch', …)` in the SAME test does not
// take over the key (observed: the second mock records zero calls, because the first
// stub stays installed), so ONE stub serving both requests is what keeps "which
// request produced this body" unambiguous.
const stubFetchSequence = (bodies: ReadableStream<Uint8Array>[]): RecordedFetch => {
    let call = 0;

    const fetchMock = vi.fn(async () => {
        const body = bodies[Math.min(call, bodies.length - 1)];

        call += 1;

        return new Response(body, { status: 200 });
    });

    vi.stubGlobal('fetch', fetchMock);

    return fetchMock as unknown as RecordedFetch;
};

// Narrows the terminal frame so a pin can read `toolCalls` without a cast. A miss is
// an assertion failure by construction, never a skip.
const doneOf = (events: HarnessStreamEvent[]): Extract<HarnessStreamEvent, { type: 'done' }> => {
    const done = events.at(-1);

    if (done?.type !== 'done') throw new Error(`expected a terminal \`done\` frame, got ${JSON.stringify(done)}`);

    return done;
};

// Drives one request BY HAND so a fake-timer advance can fire a bound while the transport
// is parked in `reader.read()` (same shape as ./openai.provider-timeouts.test.ts:76-101).
const drive = (stream: HarnessStream) => {
    const iterator = stream({ ...request })[Symbol.asyncIterator]();
    let settled = false;

    const pending = (): Promise<IteratorResult<HarnessStreamEvent>> => {
        settled = false;

        const next = iterator.next().then((result) => {
            settled = true;

            return result;
        });

        next.catch(() => {});

        return next;
    };

    return { pending, isSettled: (): boolean => settled };
};

describe('tool-call argument generation: visibility and liveness (probe P2)', () => {
    // -------------------------------------------------------------------------
    // Q1 + Q2 — the accumulation itself, and the silence around it.
    // -------------------------------------------------------------------------

    it('emits a throttled `progress` frame — and only one — between the last text delta and `done`', async () => {
        // The reported shape: text ends ("."), then an argument block arrives in pieces.
        // Every one of those chunks is real traffic; not one of them is reportable.
        stubFetch(
            closedBody([
                textFrame('.'),
                toolFrame({ index: 0, id: 'call_1', function: { name: 'delegate', arguments: '' } }),
                toolFrame({ index: 0, function: { arguments: '{"agents":[' } }),
                toolFrame({ index: 0, function: { arguments: '{"task":"a"},{"task":"b"}' } }),
                toolFrame({ index: 0, function: { arguments: ']}' } }),
                finishFrame('tool_calls'),
                doneFrame
            ])
        );

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));

        // EXACTLY three events for six body chunks: the text delta, ONE `progress` frame,
        // and the terminal `done`. Before T2 this was two events, and that WAS the bug —
        // there was no frame kind that could carry an argument delta (../types/index.ts:450
        // has one now), which is why the journal showed 62 s of nothing.
        //
        // ONE progress frame for FIVE tool chunks is the throttle (./openai.ts
        // `TOOL_CALL_PROGRESS_INTERVAL_MS`): the phase-entry frame fires on the first
        // fragment, and the four that follow arrive inside the same 500 ms window. The
        // counters are the state at that first fragment — one slot opened, no argument
        // bytes yet, because this provider sends `arguments: ''` alongside the name.
        expect(events).toEqual([
            { type: 'text', delta: '.' },
            { type: 'progress', phase: 'tool-composition', toolCallSlots: 1, argumentChars: 0 },
            {
                type: 'done',
                stopReason: 'tool_calls',
                toolCalls: [{ id: 'call_1', name: 'delegate', arguments: '{"agents":[{"task":"a"},{"task":"b"}]}' }],
                usage: undefined
            }
        ]);
    });

    it('de-multiplexes parallel calls by `index`, and a name on a NEW index opens that slot', async () => {
        // Four batteries: index 0 and 1 interleave their argument deltas; index 2 is
        // introduced mid-stream by a chunk that carries ONLY a name (no id).
        stubFetch(
            closedBody([
                toolFrame({ index: 0, id: 'call_a', function: { name: 'delegate', arguments: '{"t":"1"}' } }),
                toolFrame({ index: 1, id: 'call_b', function: { name: 'delegate', arguments: '{"t":' } }),
                toolFrame({ index: 1, function: { arguments: '"2"}' } }),
                toolFrame({ index: 0, function: { arguments: '' } }),
                toolFrame({ index: 2, function: { name: 'threadFork', arguments: '{}' } }),
                finishFrame('tool_calls'),
                doneFrame
            ])
        );

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));
        const done = events.at(-1);

        // Flushed in stream-index order (./openai.ts `finishToolCalls`). Index 2 has NO id:
        // the provider left that call anonymous, and an anonymous call is UNPAIRABLE on
        // replay (every `tool` result would answer `''`), so the transport MINTS
        // `harness-call-<index>` — the same string the assistant message carries and the
        // matching `tool` result answers, pinned end-to-end below.
        expect(done).toEqual({
            type: 'done',
            stopReason: 'tool_calls',
            toolCalls: [
                { id: 'call_a', name: 'delegate', arguments: '{"t":"1"}' },
                { id: 'call_b', name: 'delegate', arguments: '{"t":"2"}' },
                { id: 'harness-call-2', name: 'threadFork', arguments: '{}' }
            ],
            usage: undefined
        });
    });

    // -------------------------------------------------------------------------
    // Defect 1 — the NAME rule: pieces concatenate, echoes do not.
    // -------------------------------------------------------------------------

    it('concatenates a name the provider streams in PIECES before any argument', async () => {
        // OpenAI's shape: `function.name` arrives split across deltas, all of them BEFORE
        // the first argument byte. Those pieces MUST concatenate, so the fix cannot simply
        // take the first fragment and ignore the rest.
        stubFetch(
            closedBody([
                toolFrame({ index: 0, id: 'call_1', function: { name: 'deleg' } }),
                toolFrame({ index: 0, function: { name: 'ate', arguments: '{"t":' } }),
                toolFrame({ index: 0, function: { arguments: '"a"}' } }),
                finishFrame('tool_calls'),
                doneFrame
            ])
        );

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));

        expect(events).toEqual([
            // (T2) The phase-entry frame of this attempt: emitted on the FIRST tool-call
            // fragment, counters at that fragment, where only the name piece has arrived.
            { type: 'progress', phase: 'tool-composition', toolCallSlots: 1, argumentChars: 0 },
            {
                type: 'done',
                stopReason: 'tool_calls',
                toolCalls: [{ id: 'call_1', name: 'delegate', arguments: '{"t":"a"}' }],
                usage: undefined
            }
        ]);
    });

    it('ignores the full name a relay ECHOES on every delta instead of concatenating it', async () => {
        // The shape this guard exists for: a relay that repeats `id` + `function.name` on
        // EVERY delta of the block. `entry.name += name` (./openai.ts before the fix) would
        // turn it into `delegatedelegate`, which resolves to no tool (../harness.ts:11115-
        // 11128) and fails the WHOLE multi-call block — one unresolvable call for the whole
        // parallel round. DEFENSIVE, NOT OBSERVED: no capture in this workspace shows a
        // name-echoing relay (../docs/tasks/2026-11-19-tool-call-composition-visibility.md,
        // Finding 1 + "Not tested / not confirmed"), so this pin holds a rule the contract
        // permits rather than a failure that was witnessed.
        stubFetch(
            closedBody([
                toolFrame({ index: 0, id: 'call_1', function: { name: 'delegate', arguments: '' } }),
                toolFrame({ index: 0, id: 'call_1', function: { name: 'delegate', arguments: '{"agents":[' } }),
                toolFrame({ index: 0, id: 'call_1', function: { name: 'delegate', arguments: ']}' } }),
                finishFrame('tool_calls'),
                doneFrame
            ])
        );

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));

        expect(events).toEqual([
            // (T2) The phase-entry frame of this attempt: emitted on the FIRST tool-call
            // fragment, and the four relay echoes inside the same window cost nothing.
            { type: 'progress', phase: 'tool-composition', toolCallSlots: 1, argumentChars: 0 },
            {
                type: 'done',
                stopReason: 'tool_calls',
                // One `delegate`, and the arguments intact: each echo is dropped because the
                // slot already holds EXACTLY that name (the only drop the rule makes — F2
                // removed the broader "arguments have begun" clause, which used to also discard
                // a legitimate late name piece).
                toolCalls: [{ id: 'call_1', name: 'delegate', arguments: '{"agents":[]}' }],
                usage: undefined
            }
        ]);
    });

    it('takes a late name while the slot is still unnamed, then ignores every later echo', async () => {
        // The exception, in both directions: arguments arrived first with NO name at all,
        // so the FIRST late name is taken (an unresolvable `''` is worse than a late name)
        // and the second one is an echo.
        stubFetch(
            closedBody([
                toolFrame({ index: 1, function: { arguments: '{"a":1}' } }),
                toolFrame({ index: 1, function: { name: 'delegate' } }),
                toolFrame({ index: 1, function: { name: 'delegate' } }),
                finishFrame('tool_calls'),
                doneFrame
            ])
        );

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));

        expect(events).toEqual([
            // (T2) The phase-entry frame of this attempt: emitted on the FIRST tool-call
            // fragment, which already carries the 7 argument characters.
            { type: 'progress', phase: 'tool-composition', toolCallSlots: 1, argumentChars: 7 },
            {
                type: 'done',
                stopReason: 'tool_calls',
                toolCalls: [{ id: 'harness-call-1', name: 'delegate', arguments: '{"a":1}' }],
                usage: undefined
            }
        ]);
    });

    it('concatenates a name piece that arrives AFTER the first argument byte (review F2)', async () => {
        // ADDED 2026-11-19 with fix F2, in the direction the first version of the echo guard
        // got wrong. The guard used to drop EVERY name once the slot had taken an argument
        // byte, which is a strictly broader rule than "this fragment repeats the whole name":
        // it also dropped a legitimate piece from a relay that interleaves — `deleg`, one
        // argument byte, `ate` — and flushed `deleg`, an unresolvable tool that fails the
        // WHOLE multi-call block. HEAD's unconditional append answered `delegate` for the same
        // bytes — `deleg` + `ate` is `delegate`, the real tool name, which is also why the
        // expected value below is spelled that way and not `delegated` (the review write-up
        // carried that off-by-one into both pins; re-derived from the fragments 2026-11-19) —
        // so the shipped guard had REGRESSED a shape the OpenAI schema permits
        // (`function.name` is a free-running string field on every delta; nothing in the
        // contract says the name is finished before the arguments start).
        //
        // The pin in the other direction — an echo really is dropped — is the test above; the
        // residual risk this relaxation accepts (a relay that re-sends a name PREFIX) is
        // pinned in ./harness.tool-composition-review.test.ts and documented at
        // ./openai.ts, the `mergeToolCallDelta` name-fragment note.
        stubFetch(
            closedBody([
                toolFrame({ index: 0, id: 'call_split', function: { name: 'deleg' } }),
                toolFrame({ index: 0, function: { arguments: '{"a":1}' } }),
                toolFrame({ index: 0, function: { name: 'ate' } }),
                finishFrame('tool_calls'),
                doneFrame
            ])
        );

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));

        expect(events).toEqual([
            // The phase-entry frame, counters at the first fragment: one slot, no argument
            // bytes yet. The two later fragments fall inside the same 500 ms window.
            { type: 'progress', phase: 'tool-composition', toolCallSlots: 1, argumentChars: 0 },
            {
                type: 'done',
                stopReason: 'tool_calls',
                toolCalls: [{ id: 'call_split', name: 'delegate', arguments: '{"a":1}' }],
                usage: undefined
            }
        ]);
    });

    // -------------------------------------------------------------------------
    // Defect 3 — a body that closes early WITHOUT saying how.
    // -------------------------------------------------------------------------

    it('keeps a COMPLETE tool block when the body closes without `[DONE]` or a finish_reason', async () => {
        // THE fix for the reported stall. The relay leg in front of this deployment
        // withholds the whole tool region and closes with one final frame
        // (services/modal/deploy/qwen3.8-27b/modal_qwen3_8_rtx6000_ninfer.py:97-100,
        // 993-1003), so a body ending with no sentinel and no finish_reason can still hold
        // a FULLY generated block. It used to be dropped as the codeless
        // `provider-transit` error, which walks the generic 11-attempt ladder
        // (../core/agent.ts:1375-1397, ../core/agent-limits.ts:134-139, :169): up to 10
        // re-generations of the same ~60 s block, i.e. the loop the user watched.
        stubFetch(
            closedBody([
                textFrame('.'),
                toolFrame({ index: 0, id: 'call_1', function: { name: 'delegate', arguments: '{"t":"x"}' } })
            ])
        );

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));

        expect(events).toEqual([
            { type: 'text', delta: '.' },
            // (T2) The phase-entry frame of this attempt: emitted on the FIRST tool-call
            // fragment, which carries the whole (complete) argument string.
            { type: 'progress', phase: 'tool-composition', toolCallSlots: 1, argumentChars: 9 },
            // The same answer the code gives when `[DONE]` DOES arrive (./openai.ts
            // `stopReasonOf`): a complete tool round is a tool round, sentinel or not.
            {
                type: 'done',
                stopReason: 'tool_calls',
                toolCalls: [{ id: 'call_1', name: 'delegate', arguments: '{"t":"x"}' }],
                usage: undefined
            }
        ]);
    });

    it('still fails a HALF-WRITTEN tool block that closes without `[DONE]` or a finish_reason', async () => {
        // The truncation guard survives for the case it exists for: `arguments` stopped
        // mid-JSON, so the call is NOT executable and the request stays retryable.
        stubFetch(
            closedBody([
                textFrame('.'),
                toolFrame({ index: 0, id: 'call_1', function: { name: 'delegate', arguments: '{"agents":[{"task"' } })
            ])
        );

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));

        expect(events).toEqual([
            { type: 'text', delta: '.' },
            // (T2) The phase-entry frame of this attempt: emitted on the FIRST tool-call
            // fragment, and the request still fails the truncation guard it always failed.
            { type: 'progress', phase: 'tool-composition', toolCallSlots: 1, argumentChars: 18 },
            {
                type: 'error',
                message: 'The model stream ended before reporting a completion.',
                details: { errorClass: PROVIDER_TRANSIT_CLASS, url: CHAT_URL, port: 6660 }
            }
        ]);
    });

    it('does not treat arguments that parse to a NON-OBJECT as a completed tool round', async () => {
        // The completeness test is "parses to a JSON OBJECT" — the same rule the outbound
        // wire applies (`isPlainJsonObject`, ./openai.ts, which repairs a non-object to
        // `'{}'` because the gateway 500s on the whole request otherwise). A block the
        // transport would have to repair on the way out is never declared finished.
        stubFetch(closedBody([toolFrame({ index: 0, id: 'call_1', function: { name: 'stats', arguments: '[]' } })]));

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));

        expect(events).toEqual([
            // (T2) The phase-entry frame of this attempt: emitted on the FIRST tool-call
            // fragment, so even a rejected round reports that it WAS composed.
            { type: 'progress', phase: 'tool-composition', toolCallSlots: 1, argumentChars: 2 },
            {
                type: 'error',
                message: 'The model stream ended before reporting a completion.',
                details: { errorClass: PROVIDER_TRANSIT_CLASS, url: CHAT_URL, port: 6660 }
            }
        ]);
    });

    // -------------------------------------------------------------------------
    // Defect 4 — index-less fragments must not corrupt a slot the provider left.
    // -------------------------------------------------------------------------

    it('sends an index-less continuation to the slot the provider is streaming, never to slot 0', async () => {
        // `?? 0` (./openai.ts:940 before the fix) merged EVERY index-less fragment into
        // slot 0. Here the provider drops `index` on the continuation of call #1, and the
        // old rule appended it to call #0 — `alpha` would have run with
        // `{"q":""news"}"x"}`, a tool the model never asked for.
        stubFetch(
            closedBody([
                toolFrame({ index: 0, id: 'c0', function: { name: 'alpha', arguments: '{"q":' } }),
                toolFrame({ index: 0, function: { arguments: '"news"}' } }),
                toolFrame({ index: 1, id: 'c1', function: { name: 'beta', arguments: '{"q":' } }),
                toolFrame({ function: { arguments: '"x"}' } }),
                // A late index-less NAME too: it follows slot 1, and slot 1 already has a
                // name and arguments, so it is an echo and changes nothing.
                toolFrame({ function: { name: 'beta' } }),
                finishFrame('tool_calls'),
                doneFrame
            ])
        );

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));
        const done = events.at(-1);

        expect(done).toEqual({
            type: 'done',
            stopReason: 'tool_calls',
            toolCalls: [
                { id: 'c0', name: 'alpha', arguments: '{"q":"news"}' },
                { id: 'c1', name: 'beta', arguments: '{"q":"x"}' }
            ],
            usage: undefined
        });
    });

    it('keeps a provider that never sends an index on slot 0 (the shape `?? 0` was written for)', async () => {
        // No `index`, no `id` anywhere: the single-call shape. `openIndex` was never set,
        // so the accumulator's only slot is 0 and the fragments still concatenate.
        stubFetch(
            closedBody([
                toolFrame({ function: { name: 'alpha', arguments: '{"q":' } }),
                toolFrame({ function: { arguments: '"news"}' } }),
                finishFrame('tool_calls'),
                doneFrame
            ])
        );

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));

        expect(events).toEqual([
            // (T2) The phase-entry frame of this attempt: emitted on the FIRST tool-call
            // fragment, the single-call shape needs the signal as much as a parallel one.
            { type: 'progress', phase: 'tool-composition', toolCallSlots: 1, argumentChars: 5 },
            {
                type: 'done',
                stopReason: 'tool_calls',
                toolCalls: [{ id: 'harness-call-0', name: 'alpha', arguments: '{"q":"news"}' }],
                usage: undefined
            }
        ]);
    });

    it('opens its own slot for an id-less-index provider reporting a SECOND id, and returns to a known id', async () => {
        // A gateway that sends ids but NO indexes is still describing parallel calls:
        // merging them into slot 0 would have produced `name: 'alphabeta'` over `'{}{}'`,
        // i.e. two unresolvable calls instead of two calls. The third fragment re-uses
        // `c0`, and an id names exactly one call, so it goes back to slot 0.
        stubFetch(
            closedBody([
                toolFrame({ id: 'c0', function: { name: 'alpha', arguments: '{}' } }),
                toolFrame({ id: 'c1', function: { name: 'beta', arguments: '{}' } }),
                toolFrame({ id: 'c0', function: { arguments: '' } }),
                finishFrame('tool_calls'),
                doneFrame
            ])
        );

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));
        const done = events.at(-1);

        expect(done).toEqual({
            type: 'done',
            stopReason: 'tool_calls',
            toolCalls: [
                { id: 'c0', name: 'alpha', arguments: '{}' },
                { id: 'c1', name: 'beta', arguments: '{}' }
            ],
            usage: undefined
        });
    });


    it('reports `finish_reason: "length"` as a `length` stop with the half-built call still attached', async () => {
        // Q6: nothing in this stack sends `max_tokens` (toolbox.ts:338 sends only
        // `temperature`), so `length` can only come from the PROVIDER's own ceiling. When
        // it does, the truncated call is still handed over (./openai.ts:1835-1841) and the
        // harness turns the malformed JSON into the "output-token limit" message
        // (../harness.ts:11130-11141).
        stubFetch(
            closedBody([
                toolFrame({ index: 0, id: 'call_1', function: { name: 'delegate', arguments: '{"agents":[{"task"' } }),
                finishFrame('length'),
                doneFrame
            ])
        );

        const events = await collect(openAICompatible({ baseURL: BASE_URL }));

        expect(events).toEqual([
            // (T2) The phase-entry frame of this attempt: emitted on the FIRST tool-call
            // fragment, so a truncated round is visible while it is still streaming.
            { type: 'progress', phase: 'tool-composition', toolCallSlots: 1, argumentChars: 18 },
            {
                type: 'done',
                stopReason: 'length',
                // Truncated mid-JSON, and still launched: `stopReason` is the only signal
                // that distinguishes this from a model that wrote bad JSON.
                toolCalls: [{ id: 'call_1', name: 'delegate', arguments: '{"agents":[{"task"' }],
                usage: undefined
            }
        ]);
    });

    // -------------------------------------------------------------------------
    // Q3 + Q5 — the bounds that are armed by default, and what they cannot see.
    // -------------------------------------------------------------------------

    it('lets a default-configured stream TRICKLE past 3 600 000 ms without any bound firing', async () => {
        fakeTimers();

        const body = pushedBody();

        stubFetch(body.stream);

        // No `*TimeoutMs` field: this is the DEFAULT Instruct server configuration
        // (toolbox.ts `providerOf` omits all three, so the transport resolves
        // env -> shipped default at construction, ./openai.ts:1436-1452).
        const transport = openAICompatible({ baseURL: BASE_URL });
        const attempt = drive(transport);

        const startedAt = Date.now();

        const first = attempt.pending();

        body.push(textFrame('.'));
        await vi.advanceTimersByTimeAsync(0);
        expect(await first).toEqual({ done: false, value: { type: 'text', delta: '.' } });

        // Re-arm the drive. (T2) The FIRST argument chunk now yields a `progress` frame,
        // so the drive drains whatever the transport releases and re-parks. The probe's
        // claim is unchanged and is still about BOUNDS: nothing released here is an
        // `error`, and only a real silence ends the request. The exact number of
        // progress frames is NOT pinned below because the throttle runs on the REAL
        // monotonic clock while these timers are faked (fakeTimers() toFake list excludes
        // `performance`), so how many 500 ms windows 70 awaited pushes span depends on
        // host speed. The deterministic throttle pins live in
        // ./openai.tool-call-progress.test.ts, which stubs `performance.now`.
        let parked = attempt.pending();
        let progressFrames = 0;

        // 70 argument chunks, 61 s apart — every gap BELOW the 120 s inter-chunk bound, so
        // each completed read re-arms a fresh timer (`guardedRead` ./openai.ts:738-769,
        // `msFor` ./openai.ts:1847) and NO bound can expire while tokens keep coming.
        for (let index = 0; index < 70; index += 1) {
            await vi.advanceTimersByTimeAsync(61_000);
            expect(attempt.isSettled()).toBe(false);

            body.push(toolFrame({ index: 0, function: { arguments: '{"a":' } }));
            await vi.advanceTimersByTimeAsync(0);

            if (!attempt.isSettled()) continue;

            const yielded = await parked;

            // This drive only ever releases the composition heartbeat. An `error` here
            // would be exactly the failure this probe is about: a bound ending a request
            // that was still receiving tokens.
            expect(yielded.done).toBe(false);
            expect(yielded.value).toMatchObject({ type: 'progress', phase: 'tool-composition', toolCallSlots: 1 });

            progressFrames += 1;
            parked = attempt.pending();
        }

        // The heartbeat was flowing the whole time: the blind 62 s is what this file
        // originally pinned, and it can no longer happen on a stream this chatty.
        expect(progressFrames).toBeGreaterThanOrEqual(1);

        // 70 × 61 s = 4 270 000 ms of one request — MORE than `MODEL_TIMEOUT_MAX_MS`
        // (../core/agent-limits.ts:81), which is NOT a request clock in the first place.
        expect(Date.now() - startedAt).toBeGreaterThan(3_600_000);
        expect(attempt.isSettled()).toBe(false);

        // The ONLY thing that ends it is a real silence of 120 s.
        await vi.advanceTimersByTimeAsync(DEFAULT_PROVIDER_STREAM_CHUNK_TIMEOUT_MS);

        const stall = await parked;

        expect(stall.done).toBe(false);
        // `timeoutMs: 120000` is the proof the inter-chunk bound is ARMED by default, at
        // its shipped value, without any operator configuration.
        expect(stall.value).toMatchObject({
            type: 'error',
            code: PROVIDER_TIMEOUT_CODE,
            details: { errorClass: PROVIDER_TIMEOUT_CODE, url: CHAT_URL, port: 6660, phase: 'stream-chunk', timeoutMs: 120_000 }
        });
    });

    it('fires NOTHING at 62 s of silence and fires `stream-chunk` at exactly 120 s (the reported turn)', async () => {
        fakeTimers();

        const body = pushedBody();

        stubFetch(body.stream);

        const attempt = drive(openAICompatible({ baseURL: BASE_URL }));

        body.push(textFrame('.'));
        await vi.advanceTimersByTimeAsync(0);
        expect(await attempt.pending()).toEqual({ done: false, value: { type: 'text', delta: '.' } });

        // The journal's gap: 62.232 s between `text "."` and the user's abort. The bound
        // is 120 s, so NOTHING could have ended the turn at that point — which is exactly
        // why the run looked dead and was not.
        const pending = attempt.pending();

        await vi.advanceTimersByTimeAsync(62_232);
        expect(attempt.isSettled()).toBe(false);

        // 120 000 ms after the last delivered chunk the inter-chunk bound fires, and it
        // quotes how much had arrived.
        await vi.advanceTimersByTimeAsync(120_000 - 62_232);

        const stall = await pending;

        expect(stall.done).toBe(false);
        expect(stall.value).toMatchObject({
            type: 'error',
            code: PROVIDER_TIMEOUT_CODE,
            details: { phase: 'stream-chunk', timeoutMs: 120_000, errorClass: PROVIDER_TIMEOUT_CODE }
        });
        expect((stall.value as Extract<HarnessStreamEvent, { type: 'error' }>).message).toContain(
            'delivered 1 body chunk(s) from localhost:6660 and then went silent for 120 seconds'
        );

        // And the frame is the START of a retry sequence, not the end of the run:
        // `provider-timeout` is re-sent 3 more times (../core/agent.ts:1359-1397, pinned by
        // ../core/agent.provider-failures.test.ts:264) — losing every token of the tool
        // block the provider had already generated.
        expect(await attempt.pending()).toEqual({ done: true, value: undefined });
    });
});

// ---------------------------------------------------------------------------
// Defect 2 — the minted id, and the pairing it protects.
//
// `finishToolCalls` used to flush `id: ''`. A block of parallel anonymous calls then
// produced SEVERAL calls sharing that empty key, and replay pairs a result with its
// call BY ID (`tool_calls[].id` vs `tool_call_id`), so the transcript could no longer
// say which result answered which call. These pins prove the minted id is unique per
// call AND identical on both sides of the pair, by reading the serialized request the
// transport would actually send.
// ---------------------------------------------------------------------------

describe('anonymous tool calls get a minted id that pairs them with their result (T1 defect 2)', () => {
    it('mints a distinct id per anonymous call, in slot order', async () => {
        // Two parallel `delegate` calls with no id anywhere — the case that made the
        // transcript unpairable.
        stubFetch(
            closedBody([
                toolFrame({ index: 0, function: { name: 'delegate', arguments: '{"t":"1"}' } }),
                toolFrame({ index: 1, function: { name: 'delegate', arguments: '{"t":"2"}' } }),
                finishFrame('tool_calls'),
                doneFrame
            ])
        );

        const emitted = doneOf(await collect(openAICompatible({ baseURL: BASE_URL })));

        expect(emitted.toolCalls.map((call) => call.id)).toEqual(['harness-call-0', 'harness-call-1']);
        // The pairing property, stated directly: no two calls in one block share a key.
        expect(new Set(emitted.toolCalls.map((call) => call.id)).size).toBe(2);
    });

    it('replays the SAME minted id on both sides of the pair — assistant `tool_calls[].id` and `tool_call_id`', async () => {
        const transport = openAICompatible({ baseURL: BASE_URL });

        // Request 1 generates the calls; request 2 is the replay whose OUTGOING body we
        // read. One stub, two bodies, so `sentBody(fetch, 1)` is provably the replay.
        const fetchMock = stubFetchSequence([
            closedBody([
                toolFrame({ index: 0, function: { name: 'delegate', arguments: '{"t":"1"}' } }),
                toolFrame({ index: 1, function: { name: 'delegate', arguments: '{"t":"2"}' } }),
                finishFrame('tool_calls'),
                doneFrame
            ]),
            closedBody([textFrame('four batteries launched'), finishFrame('stop'), doneFrame])
        ]);

        const toolCalls = doneOf(await collect(transport)).toolCalls;

        // The transcript the runtime holds after THIS turn: `core/agent.ts:1503` commits
        // the emitted `toolCalls` array VERBATIM onto the assistant entry, and
        // `harness.ts:9798` stamps every result with `toolCallId: call.id`. Both sides of
        // the pair come from these same objects, so the minted string cannot drift.
        const messages: HarnessMessage[] = [
            { role: 'user', content: 'launch the batteries' },
            { role: 'assistant', content: '', toolCalls },
            ...toolCalls.map((call) => ({
                role: 'tool' as const,
                content: `ok ${call.id}`,
                toolCallId: call.id,
                name: call.name
            }))
        ];

        await collect(transport, { model: 'local/basalt', messages });

        // The exact bytes of the replay request. This is the whole point of the mint:
        // `tool_calls[].id` (./openai.ts:428-434) and `tool_call_id` (./openai.ts:443-448)
        // carry the SAME synthetic ids, so the provider — and every later replay — can
        // pair them.
        const body = sentBody(fetchMock, 1);

        expect(body.messages).toEqual([
            { role: 'user', content: 'launch the batteries' },
            {
                role: 'assistant',
                content: '',
                tool_calls: [
                    { id: 'harness-call-0', type: 'function', function: { name: 'delegate', arguments: '{"t":"1"}' } },
                    { id: 'harness-call-1', type: 'function', function: { name: 'delegate', arguments: '{"t":"2"}' } }
                ]
            },
            { role: 'tool', tool_call_id: 'harness-call-0', content: 'ok harness-call-0' },
            { role: 'tool', tool_call_id: 'harness-call-1', content: 'ok harness-call-1' }
        ]);

        // And the pairing is COMPLETE both ways: every issued id is answered, and every
        // answer names an issued id. With the old `id: ''` both calls shared one key, so
        // this is exactly the assertion that used to be unsatisfiable.
        const issued = (body.messages[1].tool_calls as { id: string }[]).map((call) => call.id);
        const answered = body.messages.slice(2).map((message) => String(message.tool_call_id));

        expect(answered).toEqual(issued);
    });

    it('never mints an id that duplicates one the provider really sent', async () => {
        // A provider that uses the transport's own prefix on slot 0 must not receive a
        // second `harness-call-1` on the anonymous slot 1 — a duplicate key would put the
        // transcript back in the unpairable state the mint exists to prevent. The mint
        // bumps with a counter instead.
        stubFetch(
            closedBody([
                toolFrame({ index: 0, id: 'harness-call-1', function: { name: 'alpha', arguments: '{}' } }),
                toolFrame({ index: 1, function: { name: 'beta', arguments: '{}' } }),
                finishFrame('tool_calls'),
                doneFrame
            ])
        );

        const emitted = doneOf(await collect(openAICompatible({ baseURL: BASE_URL })));

        expect(emitted.toolCalls).toEqual([
            { id: 'harness-call-1', name: 'alpha', arguments: '{}' },
            { id: 'harness-call-1-1', name: 'beta', arguments: '{}' }
        ]);
    });
});

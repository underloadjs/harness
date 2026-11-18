// turn-projector.ts — the `progress` frame on the COMPILED plane (task T2).
//
// WHY THESE TESTS EXIST. A `progress` harness event is journalled like any other
// (../server/sessions.ts `copyEvent` is a verbatim clone), so the projector must fold it
// WITHOUT touching anything a reader acts on. The design decision is explicit
// (../shared/turn-display.ts `TurnSection.toolProgress`): ONE attempt-scoped FIELD, not a
// notice per frame. Consequences pinned here:
//
//   AC5-a  MINTS NOTHING. A fold with progress frames and a fold without it produce the
//          SAME node list, the SAME step/context bar, the SAME tail and the SAME ops apart
//          from the `section:set` that names `toolProgress` — asserted by stripping that one
//          field and comparing whole displays with `toEqual`.
//   AC5-b  ONE CHEAP OP. 20 throttled frames that carry the same counters cost ZERO ops;
//          frames that move produce exactly one `section:set` each, never a `node:insert`.
//   AC5-c  ATTEMPT SCOPING. `retry`, `attempt_commit`, `done` and `error` each clear the
//          field to `phase: 'idle'`, so a "composing 4 calls" line can never outlive the
//          attempt that produced it (knowledge.md:6178-6180 — a retry discards everything
//          streamed since the last boundary).
//   AC5-d  ABSENT ≠ IDLE. A turn that never composes a tool call emits NO clear op at its
//          boundaries, so its display keeps the byte-identical shape it had before T2 —
//          which is also what makes AC5-a true for every historical journal.
//   AC5-e  RELOAD PARITY. A cold `projectTurn` of the journal answers the same display the
//          live fold painted, so a browser that reconnects mid-composition sees the line the
//          live board saw (../frontend/view-state-live-parity.test.ts covers the reducer).
//   AC5-f  TOLERANCE. A malformed frame (unknown phase, missing or negative counter) paints
//          nothing and leaves the last snapshot alone — an unknown reader must be able to
//          ignore this kind without corrupting the tree.
//   AC5-g  THE LINE ENDS WITH THE SECTION (review F1, 2026-11-19). The frame-driven clears
//          above do not cover the three edges that end a SECTION without a frame of ITS OWN:
//          the parent's `tool_result` for the spawn call, `settle()` (the abort case: a journal
//          that ends on a progress frame) and a `branch_end`. All three clear it too, and a
//          section that never painted still costs ZERO ops at any of them. See the
//          `the composition line ends with the section` block at the foot of this file.
//   P2     A FRAME MUST SAY SOMETHING, HERE TOO (review F3 + P2, 2026-11-19). A
//          `tool-composition` frame with `toolCallSlots < 1` paints NOTHING — the projector,
//          the CLI (./cli/render.ts) and the transport (../transport/openai.ts:2015) now
//          accept the same frames — while `IDLE_TOOL_PROGRESS`, whose counters are also zero,
//          keeps clearing through both the frame-driven and the settle paths. Pinned in the
//          two `refuses a zero-slot …` / `still paints the zero-slot IDLE clear` cases.
//
// Run: yarn vitest run src/server/turn-projector-progress.test.ts   (cwd packages/underload/harness)

import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '../harness';
import type { DisplayProjectContext, TurnDisplay, TurnSection } from '../shared/turn-display';
// The generated wire spelling of the field (./harness.swagger.yaml `TurnToolProgress`,
// emitted into ../shared/harness-api.ts). Asserting against IT, not against a local copy,
// is what keeps a contract edit from passing a test that the browser can no longer read.
import type { TurnToolProgress } from '../shared/harness-api';
import type { SessionTurn } from './protocol';
import { createTurnProjector, projectTurn } from './turn-projector';

const turnOf = (overrides: Partial<SessionTurn> = {}): SessionTurn => ({
    id: 'turn-1',
    index: 0,
    prompt: 'launch the batteries',
    status: 'running',
    startedAt: 1_000,
    updatedAt: 1_000,
    events: [],
    eventTimes: [],
    ...overrides
});

const CONTEXT: DisplayProjectContext = { entry: 'one' };

// One recorded event per 10 ms (same rule as ./turn-projector-provider-retry.test.ts:56,
// so a timestamp in either file means the same thing).
const timeOf = (index: number): number => 1_000 + index * 10;

type Folded = {
    ops: Record<string, unknown>[][];
    display: () => TurnDisplay;
    sections: () => TurnSection[];
    summary: () => ReturnType<ReturnType<typeof createTurnProjector>['summary']>;
    // `settle` returns ITS ops (F1 pins below read them), and accepts `cancelled` because
    // the incident that produced the defect ended on a `cancelled` settle.
    settle: (status: 'done' | 'error' | 'cancelled') => Record<string, unknown>[];
};

// The live path: append to the record, then fold — the store recorder's own order
// (./sessions.ts), which is why a passing fold here is already a parity result.
const fold = (events: HarnessEvent[], turn: SessionTurn = turnOf()): Folded => {
    const projector = createTurnProjector(turn, CONTEXT);
    const ops: Folded['ops'] = [];

    events.forEach((event, index) => {
        turn.events.push(event);
        turn.eventTimes?.push(timeOf(index));

        ops.push(projector.apply(event, timeOf(index), index) as unknown as Record<string, unknown>[]);
    });

    return {
        ops,
        display: () => projector.display(),
        sections: () => projector.display().sections,
        summary: () => projector.summary(),
        settle: (status) => projector.settle(status, 5_000) as unknown as Record<string, unknown>[]
    };
};

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

const start = (): HarnessEvent => ({ type: 'start', agent: 'one', model: 'm' });
const text = (delta: string): HarnessEvent => ({ type: 'text', agent: 'one', delta });

const progress = (toolCallSlots: number, argumentChars: number): HarnessEvent => ({
    type: 'progress',
    agent: 'one',
    phase: 'tool-composition',
    toolCallSlots,
    argumentChars
});

const answer = (): HarnessEvent =>
    ({
        type: 'done',
        agent: 'one',
        message: { role: 'assistant', content: 'launched', model: 'm', reasoning: '', toolCalls: [] }
    }) as unknown as HarnessEvent;

const commit = (): HarnessEvent => ({ type: 'attempt_commit', agent: 'one', attempt: 1, maxAttempts: 11 });

const retry = (): HarnessEvent => ({
    type: 'retry',
    agent: 'one',
    attempt: 1,
    maxAttempts: 11,
    delayMs: 1_000,
    error: { message: 'HTTP 500: overloaded' }
});

const failure = (): HarnessEvent => ({ type: 'error', agent: 'one', error: { message: 'provider died' } });

// The composition burst the outage produced: four parallel calls, ~6.5k argument
// characters, arriving as throttled samples.
const COMPOSITION: HarnessEvent[] = [
    progress(1, 11),
    progress(2, 1_400),
    progress(3, 3_200),
    progress(4, 6_050),
    progress(4, 6_512)
];

// Ops that name `toolProgress`, whatever their op kind.
const progressOps = (ops: Folded['ops']): { patch: { toolProgress: TurnToolProgress } }[] =>
    ops
        .flat()
        .filter((op) => (op.patch as { toolProgress?: unknown } | undefined)?.toolProgress !== undefined) as {
        patch: { toolProgress: TurnToolProgress };
    }[];

// The display with the ONE field this feature owns removed from every section. Whatever
// remains must be byte-identical to the same journal without progress frames — the only
// honest form of "mints no node and no context block".
const withoutProgressField = (display: TurnDisplay): TurnDisplay =>
    JSON.parse(
        JSON.stringify(display, (key, value) => (key === 'toolProgress' ? undefined : value))
    ) as TurnDisplay;

describe('turn projector: the tool-composition field', () => {
    it('mints NO node, NO step and NO context block — the rest of the tree is byte-identical', () => {
        // Two folds of the SAME turn, differing only in the progress frames. Everything
        // except the one field must agree exactly: nodes (ids, kinds, text), the context
        // bar, the tail designation, and the turn summary.
        const quiet = fold([start(), text('OK. '), answer()]);
        const noisy = fold([start(), text('OK. '), ...COMPOSITION, answer()]);

        const quietDisplay = quiet.display();
        const noisyDisplay = noisy.display();

        // The field IS present, or the comparison below would prove nothing. It is
        // `idle` at the END because the sequence closes with `done`, which is the clear
        // itself (pinned below); the LIVE value is pinned on a fold that stops inside the
        // composition, where a reader would actually be looking at it.
        expect(noisyDisplay.sections[0]?.toolProgress).toEqual({
            phase: 'idle',
            toolCallSlots: 0,
            argumentChars: 0
        });
        expect(
            fold([start(), text('OK. '), ...COMPOSITION]).sections()[0]?.toolProgress
        ).toEqual({ phase: 'tool-composition', toolCallSlots: 4, argumentChars: 6_512 });
        expect(quietDisplay.sections[0]?.toolProgress).toBeUndefined();

        // And with it stripped, the two displays are the SAME BYTES — including `nodes`,
        // `context`, `tail` and every counter.
        expect(withoutProgressField(noisyDisplay)).toEqual(quietDisplay);

        // Node counts stated directly, so a regression cannot hide behind a rename: five
        // heartbeats add zero nodes.
        expect(noisyDisplay.sections[0]?.nodes.map((node) => node.kind)).toEqual(
            quietDisplay.sections[0]?.nodes.map((node) => node.kind)
        );
        expect(noisyDisplay.sections[0]?.context).toEqual(quietDisplay.sections[0]?.context);
    });

    it('coalesces: a sample that did not move costs ZERO ops, one that moved costs one', () => {
        // The composition burst, with every sample ALSO delivered a second time — the
        // shape a dribbling relay produces, and the case the design names: "one cheap op
        // per CHANGED value, not per frame". Alternating moved/still frames pins the dedupe
        // in BOTH directions at once: an op, nothing, an op, nothing.
        const moved = [
            progress(1, 11),
            progress(2, 1_400),
            progress(3, 3_200),
            progress(4, 6_050),
            progress(4, 6_512)
        ];

        const live = fold([start(), ...moved.flatMap((event) => [event, event])]);

        // ops[0] is the `start` frame. Every progress op that exists at all is ONE
        // `section:set` naming `toolProgress` — never a `node:insert`, never a new op kind.
        const perFrame = live.ops.slice(1);

        expect(perFrame.map((eventOps) => eventOps.length)).toEqual([1, 0, 1, 0, 1, 0, 1, 0, 1, 0]);
        expect(
            perFrame.filter((eventOps) => eventOps.length > 0).every((eventOps) => eventOps[0]?.op === 'section:set')
        ).toBe(true);
        expect(progressOps(perFrame).map((op) => op.patch.toolProgress)).toEqual([
            { phase: 'tool-composition', toolCallSlots: 1, argumentChars: 11 },
            { phase: 'tool-composition', toolCallSlots: 2, argumentChars: 1_400 },
            { phase: 'tool-composition', toolCallSlots: 3, argumentChars: 3_200 },
            { phase: 'tool-composition', toolCallSlots: 4, argumentChars: 6_050 },
            { phase: 'tool-composition', toolCallSlots: 4, argumentChars: 6_512 }
        ]);

        // A patch is THREE numbers under a `toolProgress` key: its size is fixed, so 60 s of
        // composition at the throttle rate is a bounded stream of them and never the block
        // itself. Pinned against the exact bytes of one patch.
        expect(JSON.stringify(perFrame[8][0]?.patch)).toBe(
            JSON.stringify({ toolProgress: { phase: 'tool-composition', toolCallSlots: 4, argumentChars: 6_512 } })
        );

        // And the whole burst added NO nodes, in either direction.
        expect(live.sections()[0]?.nodes).toEqual([]);
    });

    it('clears on retry, attempt_commit, done and error — and only when a line was up', () => {
        // Each boundary settles the field to `idle` with zero counters, so a stale
        // "composing 4 calls" can never sit above a committed answer or under an error.
        const cases: { name: string; tail: HarnessEvent[]; settle?: 'done' | 'error' }[] = [
            { name: 'retry', tail: [retry()] },
            { name: 'attempt_commit', tail: [commit()] },
            { name: 'done', tail: [answer()] },
            { name: 'error', tail: [failure()] }
        ];

        for (const scenario of cases) {
            const live = fold([start(), ...COMPOSITION, ...scenario.tail]);
            const boundaryOps = live.ops[1 + COMPOSITION.length] ?? [];
            const cleared = progressOps([boundaryOps]);

            // Exactly ONE clear, and it is a `section:set`, not a new op kind.
            expect(cleared.map((op) => op.patch.toolProgress)).toEqual([
                { phase: 'idle', toolCallSlots: 0, argumentChars: 0 }
            ]);

            // And the compiled section agrees, so a reload shows the cleared state too.
            expect(live.sections()[0]?.toolProgress).toEqual({ phase: 'idle', toolCallSlots: 0, argumentChars: 0 });
        }

        // The other half: a turn that NEVER composed anything emits no clear at any
        // boundary — `toolProgress` stays ABSENT, which is what keeps every pre-T2 journal
        // byte-identical (AC5-d) instead of rewriting it with a value it never reported.
        for (const scenario of cases) {
            const quiet = fold([start(), text('no tools'), ...scenario.tail]);
            const boundaryOps = quiet.ops[2] ?? [];

            expect(progressOps([boundaryOps])).toEqual([]);
            expect(quiet.sections()[0]?.toolProgress).toBeUndefined();
        }
    });

    it('a cold reload of the journal shows exactly what the live fold painted', () => {
        // AC5-e: `projectTurn` is what a reload and a resync serve (./sessions.ts). The
        // journal containing progress lines must therefore yield the SAME display the live
        // board produced — and the same display a journal WITHOUT those lines yields, apart
        // from the field itself.
        const events: HarnessEvent[] = [start(), text('OK. '), ...COMPOSITION, commit()];

        const turn = turnOf();
        const live = fold(events, turn);
        const cold = projectTurn(turn, CONTEXT);

        expect(cold.display).toEqual(live.display());
        expect(cold.summary).toEqual(live.summary());

        // T2 AC3b: replaying a journal that CONTAINS progress lines yields the same
        // transcript-bearing surface as one that does not — strip the field and the two
        // cold folds agree byte for byte, so an unknown reader and a T2 reader cannot
        // diverge about anything but this line.
        const withoutLines = turnOf({ events: [start(), text('OK. '), commit()] });

        withoutLines.eventTimes = withoutLines.events.map((_event, index) => timeOf(index));

        expect(withoutProgressField(projectTurn(withoutLines, CONTEXT).display)).toEqual(
            withoutProgressField(cold.display)
        );
    });

    it('ignores a malformed frame without disturbing the last snapshot', () => {
        // A projector replays journal data it did not write. An unknown phase, a missing
        // counter or a negative one is data to tolerate, NOT an instruction to paint or to
        // clear (../shared/harness-stream.ts: "treat an unrecognised `type` as data").
        const malformed = (overrides: Record<string, unknown>): HarnessEvent =>
            ({ type: 'progress', agent: 'one', ...overrides }) as unknown as HarnessEvent;

        const live = fold([
            start(),
            progress(2, 900),
            // Legal, and moves the counters: the tolerant parse accepts it.
            malformed({ phase: 'tool-composition', toolCallSlots: 9, argumentChars: 1 }),
            malformed({ phase: 'composing', toolCallSlots: 9, argumentChars: 1 }),
            malformed({ phase: 'tool-composition', toolCallSlots: -1, argumentChars: 1 }),
            malformed({ phase: 'tool-composition', toolCallSlots: 1.5, argumentChars: 1 }),
            progress(3, 1_200)
        ]);

        // The three VALID frames paint (the third one is `malformed` only in NAME: its
        // phase and counters are legal); the three genuinely malformed ones produce zero
        // ops each and leave the previous sample on screen.
        expect(live.ops.slice(1, 3).map((eventOps) => eventOps.length)).toEqual([1, 1]);
        expect(live.ops.slice(3, 6)).toEqual([[], [], []]);
        expect(live.sections()[0]?.toolProgress).toEqual({
            phase: 'tool-composition',
            toolCallSlots: 3,
            argumentChars: 1_200
        });

        // `phase: 'idle'` on the EVENT plane is not a transport frame at all (only the
        // projector writes it), so a journaled frame claiming it paints nothing either.
        const idle = fold([start(), progress(2, 900), malformed({ phase: 'idle', toolCallSlots: 0, argumentChars: 0 })]);

        expect(idle.ops[2]).toEqual([]);
        expect(idle.sections()[0]?.toolProgress).toEqual({
            phase: 'tool-composition',
            toolCallSlots: 2,
            argumentChars: 900
        });
    });

    // ------------------------------------------------------------------
    // P2 (review, 2026-11-19) — the F3 rule "a frame must say something" is no longer
    // transport-side only. `toolProgressOf` (./turn-projector.ts:381-391) now refuses
    // `toolCallSlots < 1`, so the PROJECTOR, the CLI (./cli/render.ts:103) and the
    // transport (../transport/openai.ts:2015) accept exactly the same frames: before this,
    // a custom transport, or a journal written before F3, could make a live tile print the
    // self-contradictory `composing 0 tool calls · 0 chars`
    // (../frontend/ui/turns.ts:891-893) while the CLI rejected the identical frame.
    //
    // THE HALF THAT COULD HAVE BROKEN, PROVEN SECOND: the rule is "reject a zero-slot
    // TOOL-COMPOSITION frame", NEVER "reject zero slots". `IDLE_TOOL_PROGRESS`
    // (./turn-projector.ts:404) also carries `toolCallSlots: 0`, reaches `paintToolProgress`
    // as a constant through no validator, and IS the clear.
    // ------------------------------------------------------------------

    it('refuses a zero-slot tool-composition frame — it paints nothing and disturbs nothing', () => {
        // Arriving FIRST it leaves the field ABSENT — the same shape as a turn that never
        // composed anything (AC5-d), so replaying a pre-F3 journal cannot invent a line.
        const first = fold([start(), progress(0, 0)]);

        expect(first.ops[1]).toEqual([]);
        expect(first.sections()[0]?.toolProgress).toBeUndefined();

        // And because nothing was painted, the terminal edge still costs ZERO progress ops:
        // refusing the frame did not create a field that then needs a clear.
        expect(progressOps([first.settle('cancelled')])).toEqual([]);
        expect(first.sections()[0]?.toolProgress).toBeUndefined();

        // A cold reload of the same journal agrees (AC5-e on the refused frame): `projectTurn`
        // runs the same validator, so the line never appears on a reconnect either.
        const journaled = turnOf({ events: [start(), progress(0, 0)] });

        journaled.eventTimes = journaled.events.map((_event, index) => timeOf(index));

        expect(projectTurn(journaled, CONTEXT).display.sections[0]?.toolProgress).toBeUndefined();

        // Arriving BETWEEN real frames it leaves the last snapshot alone — including the
        // slot-less-but-not-characterless shape, which names no open call either and so says
        // nothing (`0 tool calls · 12 chars` is the same contradiction).
        const middle = fold([start(), progress(2, 900), progress(0, 0), progress(0, 12)]);

        expect(middle.ops.slice(1).map((eventOps) => eventOps.length)).toEqual([1, 0, 0]);
        expect(middle.sections()[0]?.toolProgress).toEqual({
            phase: 'tool-composition',
            toolCallSlots: 2,
            argumentChars: 900
        });

        // `chars` keeps its own bound: a slot that has just opened legitimately carries zero
        // characters so far (a fragment with only an `id`), so `{ 1, 0 }` is a real frame.
        const openSlot = fold([start(), progress(1, 0)]);

        expect(openSlot.ops[1].length).toBe(1);
        expect(openSlot.sections()[0]?.toolProgress).toEqual({
            phase: 'tool-composition',
            toolCallSlots: 1,
            argumentChars: 0
        });
    });

    it('still paints the zero-slot IDLE clear — the P2 bound is on frames, never on the clear', () => {
        // The frame-driven clear (F1/AC5-c) and the settle clear (AC5-g) both write
        // `IDLE_TOOL_PROGRESS`, whose counters are exactly the pair a FRAME may no longer
        // carry. If the bound had been written against the VALUE instead of the frame, the
        // op below would be the first thing to disappear.
        const cleared = fold([start(), progress(2, 900), commit()]);

        expect(progressOps([cleared.ops[2]]).map((op) => op.patch.toolProgress)).toEqual([
            { phase: 'idle', toolCallSlots: 0, argumentChars: 0 }
        ]);
        expect(cleared.sections()[0]?.toolProgress).toEqual({
            phase: 'idle',
            toolCallSlots: 0,
            argumentChars: 0
        });

        // F1's settle clear relies on the SAME constant, and the incident shape is a journal
        // that ENDS on a progress frame — here one more, refused, zero-slot frame after the
        // live one. The line still ends, and the reload agrees.
        const aborted = fold([start(), progress(4, 6_512), progress(0, 0)]);

        expect(aborted.sections()[0]?.toolProgress).toEqual({
            phase: 'tool-composition',
            toolCallSlots: 4,
            argumentChars: 6_512
        });

        expect(progressOps([aborted.settle('cancelled')]).map((op) => op.patch.toolProgress)).toEqual([
            { phase: 'idle', toolCallSlots: 0, argumentChars: 0 }
        ]);
        expect(aborted.sections()[0]?.toolProgress).toEqual({
            phase: 'idle',
            toolCallSlots: 0,
            argumentChars: 0
        });

        const turn = turnOf({ events: [start(), progress(4, 6_512), progress(0, 0)] });

        turn.eventTimes = turn.events.map((_event, index) => timeOf(index));
        turn.status = 'cancelled';
        turn.updatedAt = 5_000;

        const cold = projectTurn(turn, CONTEXT);

        expect(cold.display.sections[0]?.toolProgress).toEqual({ phase: 'idle', toolCallSlots: 0, argumentChars: 0 });
        expect(cold.display).toEqual(aborted.display());
    });
});

// ---------------------------------------------------------------------------
// AC5-g — the line can never outlive the ATTEMPT, not even when nothing "ends" it
// ---------------------------------------------------------------------------
//
// The four frame-driven clears (`retry` / `attempt_commit` / `done` / `error`) all assume a
// frame arrives. Three real terminal edges do not send one for the SECTION that is ending:
//
//   1. the parent's `tool_result` for the SPAWNING call, which is the authoritative end of a
//      delegated child (../harness.ts:9618 — a child cancelled by its tree emits no `error`
//      frame of its own, so nothing else ever closes that row);
//   2. `settle()` itself, i.e. the turn reaching a terminal status. THE INCIDENT SHAPE: the
//      user aborts mid-composition, so the journal simply ENDS on a progress frame and the
//      stored section would otherwise carry `phase: 'tool-composition'` forever — visible on
//      every reload, and printed by the parent's tile while the parent is still streaming
//      (../frontend/ui/turns.ts:4758-4770 scans the nested sections);
//   3. a `branch_end`.
//
// All three now clear the field through the same deduped writer, so a settled section answers
// `{ phase: 'idle', toolCallSlots: 0, argumentChars: 0 }` — and a section that NEVER painted
// still costs ZERO ops at any of these edges (AC5-d stays true: a pre-T2 journal replays
// byte-identically).

const ROOT_THREAD = { id: '1', input: 'launch the batteries' };
const CHILD_THREAD = { id: '2', parentId: '1', callId: 'call-delegate', input: 'subtask' };

const rootStart = (): HarnessEvent => ({ type: 'start', agent: 'lead', model: 'm', thread: { ...ROOT_THREAD } });
const childStart = (): HarnessEvent => ({ type: 'start', agent: 'worker', model: 'm', thread: { ...CHILD_THREAD } });

// The child's own composition: two parallel calls, 4,096 argument characters, framed on the
// CHILD thread (the harness stamps `thread` on every event, src/harness.ts:13452-13478).
const childComposing = (): HarnessEvent =>
    ({
        type: 'progress',
        agent: 'worker',
        phase: 'tool-composition',
        toolCallSlots: 2,
        argumentChars: 4_096,
        thread: { id: '2', parentId: '1', callId: 'call-delegate' }
    }) as unknown as HarnessEvent;

const delegateCall = (): HarnessEvent =>
    ({
        type: 'tool_call',
        agent: 'lead',
        call: { id: 'call-delegate', name: 'delegate', arguments: '{"agent":"worker"}' },
        thread: { id: '1' }
    }) as unknown as HarnessEvent;

// The parent's result for the spawn call, CANCELLED — the exact frame that ends a child the
// tree aborted.
const parentResult = (): HarnessEvent =>
    ({
        type: 'tool_result',
        agent: 'lead',
        name: 'delegate',
        callId: 'call-delegate',
        content: 'cancelled',
        isError: true,
        outcome: 'cancelled',
        thread: { id: '1' }
    }) as unknown as HarnessEvent;

const IDLE = { phase: 'idle', toolCallSlots: 0, argumentChars: 0 };

// The same filter as `progressOps`, WITHOUT the narrowing: the pins below assert the WHOLE
// op object, because WHICH SECTION a clear lands on is part of the claim (a child's line
// must not become the parent's).
const progressPatches = (ops: Record<string, unknown>[]): Record<string, unknown>[] =>
    ops.filter((op) => (op.patch as { toolProgress?: unknown } | undefined)?.toolProgress !== undefined);

describe('turn projector: the composition line ends with the section', () => {
    it('clears on a child settled by the PARENT’s `tool_result` — the frame that ends a cancelled child', () => {
        const live = fold([rootStart(), delegateCall(), childStart(), childComposing(), parentResult()]);

        const child = live.sections().find((section) => section.agent === 'worker');

        // The row IS settled (the review probe pinned the old, wrong half at
        // src/harness.tool-composition-review.test.ts:844), and the live line is gone.
        expect(child?.state).toBe('cancelled');
        expect(child?.toolProgress).toEqual(IDLE);

        // The clear is ONE `section:set`, emitted on the parent's frame, and it names the
        // CHILD's section — the parent waiting on the child never inherits its line.
        expect(progressPatches(live.ops[4])).toEqual([
            { op: 'section:set', turnId: 'turn-1', sectionId: child?.id, patch: { toolProgress: IDLE } }
        ]);
        expect(live.sections().find((section) => section.agent === 'lead')?.toolProgress).toBeUndefined();
    });

    it('clears on a turn-level `cancelled` settle — a journal that ends on a progress frame', () => {
        // The incident: composition, then the abort, with no terminal frame in between.
        const live = fold([start(), text('OK. '), progress(4, 6_512)]);

        expect(live.sections()[0]?.toolProgress).toEqual({
            phase: 'tool-composition',
            toolCallSlots: 4,
            argumentChars: 6_512
        });

        const settleOps = live.settle('cancelled');

        // (src/harness.tool-composition-review.test.ts:829 pinned the OLD value — the live
        // counters on a settled turn — and was re-pinned after the review.) Whatever a reload
        // of that record shows is exactly this.
        expect(live.sections()[0]?.toolProgress).toEqual(IDLE);
        expect(progressPatches(settleOps)).toEqual([
            { op: 'section:set', turnId: 'turn-1', sectionId: live.sections()[0]?.id, patch: { toolProgress: IDLE } }
        ]);
    });

    it('clears a row the turn force-closed, and a row that was already terminal', () => {
        // A child that streamed and never answered is force-closed by `settle`; and a row some
        // frame already settled is still swept, so the ordering hole the review probe records at
        // src/harness.tool-composition-review.test.ts:815 (a `progress` frame AFTER
        // `attempt_commit` re-paints the line) cannot survive into the stored record either.
        const live = fold([rootStart(), delegateCall(), childStart(), childComposing()]);

        live.settle('error');

        const child = live.sections().find((section) => section.agent === 'worker');

        expect(child?.state).toBe('error');
        expect(child?.toolProgress).toEqual(IDLE);

        // Already-terminal half: the child was ended by its own `error` frame (which clears),
        // then re-painted, then settled — one more clear, never a live value.
        const repainted = fold([
            rootStart(),
            delegateCall(),
            childStart(),
            childComposing(),
            ({ type: 'error', agent: 'worker', error: { message: 'lane died' }, thread: { id: '2', parentId: '1', callId: 'call-delegate' } }) as unknown as HarnessEvent,
            childComposing()
        ]);

        expect(repainted.sections().find((section) => section.agent === 'worker')?.toolProgress).toEqual({
            phase: 'tool-composition',
            toolCallSlots: 2,
            argumentChars: 4_096
        });

        repainted.settle('cancelled');

        expect(repainted.sections().find((section) => section.agent === 'worker')?.toolProgress).toEqual(IDLE);
    });

    it('a `done` answer still clears EXACTLY ONCE, and settle adds no second op', () => {
        const live = fold([start(), ...COMPOSITION, answer()]);

        // One clear, on the `done` frame itself (the pre-existing AC5-c pin).
        expect(progressOps([live.ops[1 + COMPOSITION.length]]).map((op) => op.patch.toolProgress)).toEqual([IDLE]);

        // Then the terminal edge: the field is already idle, so `settle` emits NOTHING that
        // names it. "Cleared" stays one op per attempt, never one per boundary.
        const settleOps = live.settle('done');

        expect(progressPatches(settleOps)).toEqual([]);
        expect(live.sections()[0]?.toolProgress).toEqual(IDLE);
    });

    it('costs ZERO ops where the field was never painted — a pre-T2 journal replays byte-identical', () => {
        // AC5-d, now enforced at the terminal edges too: `paintToolProgress` refuses a clear of
        // an ABSENT field, so `settle` cannot invent an `idle` value the producer never reported.
        const quiet = fold([start(), text('no tools')]);

        expect(quiet.sections()[0]?.toolProgress).toBeUndefined();

        expect(progressPatches(quiet.settle('cancelled'))).toEqual([]);
        expect(quiet.sections()[0]?.toolProgress).toBeUndefined();

        // And the same for a child the parent settled with no composition frames at all.
        const quietChild = fold([rootStart(), delegateCall(), childStart(), parentResult()]);

        expect(progressPatches(quietChild.ops.flat())).toEqual([]);
        expect(quietChild.sections().find((section) => section.agent === 'worker')?.toolProgress).toBeUndefined();
    });

    it('a cold reload of an aborted journal answers the cleared line, not the live one', () => {
        // Parity (AC5-e) on the incident shape. The store settles the turn on the terminal
        // lifecycle edge and then serves `projectTurn`, and `refoldTurn` re-settles a turn whose
        // STATUS is terminal (turn-projector.ts:4138-4140), so the reload must agree with what
        // the live board painted — including the line being GONE.
        const events: HarnessEvent[] = [rootStart(), delegateCall(), childStart(), childComposing(), parentResult()];

        const turn = turnOf();
        const live = fold(events, turn);

        live.settle('cancelled');

        // Same terminal status, same settle stamp (5 000, the fold helper's own value).
        turn.status = 'cancelled';
        turn.updatedAt = 5_000;

        const cold = projectTurn(turn, CONTEXT);
        const coldChild = cold.display.sections.find((section) => section.agent === 'worker');

        expect(coldChild?.state).toBe('cancelled');
        expect(coldChild?.toolProgress).toEqual(IDLE);
        expect(cold.display).toEqual(live.display());
    });
});

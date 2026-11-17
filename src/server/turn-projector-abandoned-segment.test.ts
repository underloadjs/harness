// T-W25 — the CONTEXT-BAR SEGMENT an abandoned call leaves behind ends at the SAME figure the
// accepted card rule uses: the call's OWN last recorded activity stamp, not the turn's end stamp.
//
// THE DEFECT, and the last plane of it (measured on the user's own recorded run, see
// Temp/orch-plan/w25/{before,after}.txt — Temp/orch-plan/w25/fold.ts is the fold that produced
// them): T-W23 gave every force-closed SECTION ROW its own last activity (rows `:1/:2/:3` ->
// `185,9xx ms / cancelled`) and T-W24 gave every force-closed CARD its own last activity (the 5
// abandoned cards -> `0 ms`), but `settle` still stamped the context-bar SEGMENT of those same
// calls with `endedAt = settledAt` (./turn-projector.ts, the `settle` step pass). So for ONE call
// the reader was shown three different spans at once: the row's `3m05s`, the card's `0ms`, and a
// context-bar segment of `3,844,657 ms / 64m04s` — the bar being the widget the complaint named,
// because `contextBlockDurationOf` (../frontend/view-context.ts:339-346) prefers the record's
// measured `durationMs` and falls back to `endedAt - at`, and `settle` invents no `durationMs` for
// a call that never reported one.
//
// THE RULE under test (./turn-projector.ts `abandonedEndedAtOf`, now feeding BOTH the card patch and
// the segment patch of the same call — ONE computation, so the two planes cannot drift):
//   - a segment whose call received its OWN terminal event is never reached: the `tool_result`
//     writer (:2961) already stamped the real `endedAt` and the measured `durationMs`, and the settle
//     loop skips every step that is not `state: 'running'`. Pinned byte-identically below (the whole
//     `context` array is compared, not a field).
//   - every segment `settle` DOES reach ends at the last frame that ever wrote to that call. That is
//     `step.startedAt`, and for these segments `segment.at` is the SAME number: both fields are
//     written from the same `stamp` argument in the same `tool_call` frame (:2831 and :2857) and
//     nothing between there and `settle` touches either one. So the truthful segment end is its own
//     `at`, the span is 0 ms, and it equals the card's span.
//   - NO stamp anywhere (a record with no `eventTimes`, i.e. `DISPLAY_NO_TIMESTAMP`) keeps the
//     previous value — the settle stamp — so an un-timed record folds byte-identically. Pinned below.
//   - the segment never ends before its OWN start: the clamp is the recorded start, which for these
//     segments IS `segment.at`. It matters because `elapsedBetween` returns `undefined` for a negative
//     span, and `contextBlockDurationOf` returns `undefined` with it, i.e. the segment would LOSE its
//     duration label rather than print a wrong one.
//
// WHAT IS DELIBERATELY UNTOUCHED — the segment's CONTENT and redaction semantics: `chars`,
// `argsChars`, `resultChars`, `inPrompt`, `included`, and `eventTo` (which is a real event index, not
// a time, and is load-bearing for the detail reads and for the row's own last-activity witness). The
// settle patch below is asserted to carry EXACTLY `state` + `endedAt`, so a content field that moved
// shows up as a failing assertion. Also untouched: the row rule from T-W23
// (./turn-projector-settle-interrupted.test.ts), the root row (still the turn's own end), the card
// rule from T-W24 (./turn-projector-abandoned-card.test.ts), and every other plane of the bar
// (lanes, widths of segments that have their own `durationMs`, the aggregate character totals).
//
// LIVE ≡ REPLAY: every journal below folds through the LIVE path (`createTurnProjector` + one
// `apply()` per event + `settle()`, the store's own order in ./sessions.ts `projectorFor`) and is
// asserted a second time through the COLD path (`projectTurn`, what a reload and every view read
// serve). The rule reads only recorded stamps — no `Date.now()`, no live-only state — so a reload
// shows the same bar (the invariant at the top of ./turn-projector.ts).
//
// THE WIDGET FIGURES are asserted too, because the defect was a rendered duration: `contextBlockDurationOf`
// and the tooltip `contextSegmentTitleOf` are the exact reads ../frontend/ui/context-bar.ts and
// ../frontend/ui/context-detail.ts use, and `contextBarOf` is the strip model whose `totalDurationMs`
// was inflated by the same stamps.
//
// THE REAL ARTIFACT this is modelled on: Temp/orch-plan/events.jsonl, turn
// 319cfc1c-6ab5-4d2e-aed3-383806fe4d36 — a 1,141,922 ms process death at frame index 17,476; three
// never-returned `delegate` calls in the root row and two never-returned `shell`/`glob` calls in the
// row that died. Their before/after context-block durations are Temp/orch-plan/w25/{before,after}.txt.
//
// Run: yarn vitest run src/server/turn-projector-abandoned-segment.test.ts   (cwd packages/underload/harness)

import { describe, expect, it } from 'vitest';
import { elapsedBetween, formatDuration } from '../frontend/ui/time';
import { contextBarOf, contextBlockDurationOf, contextSegmentTitleOf } from '../frontend/view-context';
import type { HarnessEvent } from '../harness';
import type {
    ContextBlock,
    DisplayProjectContext,
    TurnDisplay,
    TurnDisplayOp,
    TurnRecordStatus,
    TurnSection
} from '../shared/turn-display';
import type { SessionTurn } from './protocol';
import { createTurnProjector, DISPLAY_NO_TIMESTAMP, projectTurn } from './turn-projector';

const turnOf = (overrides: Partial<SessionTurn> = {}): SessionTurn => ({
    id: 'turn-1',
    index: 0,
    prompt: 'do the thing',
    status: 'running',
    startedAt: 1_000,
    updatedAt: 1_000,
    events: [],
    eventTimes: [],
    ...overrides
});

const CONTEXT: DisplayProjectContext = { primary: 'one' };

// One recorded event per 10 ms, exactly as ./turn-projector-abandoned-card.test.ts does it, so every
// span below is an event index the reader can count.
const timeOf = (index: number): number => 1_000 + index * 10;

// The turn's end stamp — 3.9 seconds after the last recorded frame of either flow. Pre-fix, EVERY
// abandoned SEGMENT printed a span to this figure; that is the value the assertions below refuse.
const SETTLE_AT = 5_000;

type Folded = {
    turn: SessionTurn;
    ops: TurnDisplayOp[][];
    display: () => TurnDisplay;
    summary: () => ReturnType<ReturnType<typeof createTurnProjector>['summary']>;
    settle: (status: TurnRecordStatus) => TurnDisplayOp[];
};

// The LIVE path: push the record, then fold it — the store recorder's own order (./sessions.ts).
const foldWith = (events: HarnessEvent[], stamps: number[], turn: SessionTurn = turnOf()): Folded => {
    const projector = createTurnProjector(turn, CONTEXT);
    const ops: TurnDisplayOp[][] = [];

    events.forEach((event, index) => {
        turn.events.push(event);
        if (turn.eventTimes !== undefined) turn.eventTimes.push(stamps[index]);
        ops.push(projector.apply(event, stamps[index], index));
    });

    return {
        turn,
        ops,
        display: () => projector.display(),
        summary: () => projector.summary(),
        settle: (status) => {
            turn.status = status;
            turn.updatedAt = SETTLE_AT;

            return projector.settle(status, SETTLE_AT);
        }
    };
};

const fold = (events: HarnessEvent[], turn: SessionTurn = turnOf()): Folded =>
    foldWith(
        events,
        events.map((_event, index) => timeOf(index)),
        turn
    );

const sectionOf = (result: Folded | TurnDisplay, id: string): TurnSection | undefined => {
    const sections =
        (result as Folded).display !== undefined
            ? (result as Folded).display().sections
            : (result as TurnDisplay).sections;

    return sections.find((section) => section.id === id);
};

const segmentsOf = (result: Folded | TurnDisplay, id: string): ContextBlock[] => sectionOf(result, id)?.context ?? [];

// The whole segment, asserted as ONE object: a segment that moved any field other than `endedAt`
// shows up as an object diff, not as a count that happens to match.
const segmentOf = (result: Folded | TurnDisplay, id: string, blockId: string): unknown =>
    segmentsOf(result, id).find((block) => block.id === blockId);

// The segments `settle` put on the wire, WHOLE: the op is what a live watcher applies, so the patch
// key set is also the proof that no CONTENT field moved.
const settledSegmentPatches = (ops: TurnDisplayOp[]): unknown[] =>
    ops
        .filter((op): op is Extract<TurnDisplayOp, { op: 'context:set' }> => op.op === 'context:set')
        .map((op) => ({ sectionId: op.sectionId, blockId: op.blockId, patch: op.patch }));

// The PRE-FIX face of a segment list: `settle` stamped `endedAt = settledAt` and nothing else moved,
// so the pre-fix board is this board with those stamps swapped. Used to state the discrimination as
// figures the reader saw, never as a hand-waved "was wrong".
const preFixSegments = (blocks: ContextBlock[]): ContextBlock[] =>
    blocks.map((block) =>
        block.kind === 'tool' && block.state !== 'running' && block.durationMs === undefined
            ? { ...block, endedAt: SETTLE_AT }
            : block
    );

const preFixBar = (display: TurnDisplay): TurnDisplay => ({
    ...display,
    sections: display.sections.map((section) => ({ ...section, context: preFixSegments(section.context ?? []) }))
});

// ---------------------------------------------------------------------------
// Frame builders (same shapes as ./turn-projector-abandoned-card.test.ts)
// ---------------------------------------------------------------------------

const ROOT = { id: 'inv-root' };

const childOf = (id: string, callId: string) => ({
    id,
    parentId: 'inv-root',
    callId,
    kind: 'delegation' as const,
    input: 'sub task'
});

const start = (agent: string, model: string, thread: HarnessEvent['thread']): HarnessEvent => ({
    type: 'start',
    agent,
    model,
    ...(thread === undefined ? {} : { thread })
});

const reasoning = (agent: string, text: string, thread?: HarnessEvent['thread']): HarnessEvent => ({
    type: 'reasoning',
    agent,
    delta: text,
    ...(thread === undefined ? {} : { thread })
});

const text = (agent: string, content: string, thread?: HarnessEvent['thread']): HarnessEvent => ({
    type: 'text',
    agent,
    delta: content,
    ...(thread === undefined ? {} : { thread })
});

// The parent's delegation call: it mints BOTH the root row's card and the root row's bar segment
// (recorded run: the root row's three never-returned `delegate` calls).
const delegateCall = (callId: string): HarnessEvent => ({
    type: 'tool_call',
    agent: 'one',
    call: { id: callId, name: 'delegate', arguments: JSON.stringify({ agent: 'two', input: 'sub task' }) }
});

// A call made BY a delegated run — the segment that lives inside the child's own row (recorded run:
// row `:3`'s never-returned `shell`/`glob` calls).
const childCall = (callId: string, name: string, args: string, thread: HarnessEvent['thread']): HarnessEvent => ({
    type: 'tool_call',
    agent: 'two',
    call: { id: callId, name, arguments: args },
    thread
});

const toolResult = (
    name: string,
    content: string,
    callId: string,
    extra: Partial<Extract<HarnessEvent, { type: 'tool_result' }>> = {}
): HarnessEvent => ({
    type: 'tool_result',
    agent: 'one',
    name,
    content,
    callId,
    isError: extra.isError ?? false,
    ...extra
});

const commit = (): HarnessEvent =>
    ({ type: 'attempt_commit', agent: 'one', attempt: 1, maxAttempts: 3 }) as HarnessEvent;

const done = (agent: string, model: string, content: string, thread?: HarnessEvent['thread']): HarnessEvent => ({
    type: 'done',
    agent,
    message: { role: 'assistant', content, reasoning: '', toolCalls: [], model, stopReason: 'stop' },
    ...(thread === undefined ? {} : { thread })
});

// The un-timed LIVE fold: `apply` receives `DISPLAY_NO_TIMESTAMP` for every frame, the store's reading
// of a record with no `eventTimes` (./sessions.ts `projectorFor` passes 0). The fold is settled once,
// because both legacy tests read the settled board.
const legacyRecord = (turn: SessionTurn, events: HarnessEvent[]): Folded => {
    const projector = createTurnProjector(turn, CONTEXT);

    events.forEach((event, index) => projector.apply(event, DISPLAY_NO_TIMESTAMP, index));
    projector.settle('done', SETTLE_AT);

    return {
        turn,
        ops: [],
        display: () => projector.display(),
        summary: () => projector.summary(),
        settle: (status) => projector.settle(status, SETTLE_AT)
    };
};

// ---------------------------------------------------------------------------
// The journal: a delegation whose CHILD died mid-run, mid-tool-call (the same journal T-W24 pins).
// ---------------------------------------------------------------------------

const DEATH: HarnessEvent[] = [
    start('one', 'gpt-x', ROOT), // 0 -> 1_000  the conversation's own flow
    delegateCall('call-1'), // 1 -> 1_010  mints the parent's card AND its bar segment
    start('two', 'gpt-y', childOf('inv-15', 'call-1')), // 2 -> 1_020  adopts the placeholder -> row :1
    reasoning('two', 'planning the build', childOf('inv-15', 'call-1')), // 3 -> 1_030
    childCall('call-9', 'shell', '{"command":"make"}', childOf('inv-15', 'call-1')), // 4 -> 1_040  the child's OWN call, never answered
    reasoning('two', 'still waiting on make', childOf('inv-15', 'call-1')), // 5 -> 1_050  the ROW's last frame; the call saw nothing after 1_040
    // ---- the process dies; the restarted runtime restarts its invocation counter ----
    start('one', 'gpt-x', { id: 'inv-15' }), // 6 -> 1_060  root-shaped, wearing the dead child's id
    text('one', 'the complete answer', { id: 'inv-15' }), // 7 -> 1_070
    commit(), // 8 -> 1_080
    done('one', 'gpt-x', 'the complete answer', { id: 'inv-15' }) // 9 -> 1_090
];

describe('T-W25 — an abandoned call’s bar segment ends at its own stamp', () => {
    it('ends the root row’s abandoned segment at the segment/card figure, not at the settle stamp', () => {
        const result = fold(DEATH);

        // `settle` is idempotent (pinned in ./turn-projector.test.ts), so this batch is captured ONCE:
        // it is what a live watcher actually applied.
        const settleOps = result.settle('done');

        // THE ROOT ROW'S SEGMENT: opened by event 1, and event 1 is the last frame that ever wrote to
        // that call, so the segment ends at its own `at` — a 0 ms span — while the turn went on for
        // another 3,900 ms and the root ROW still ends at the settle stamp.
        expect(segmentOf(result, 'turn-1:0', '0-tool-1')).toEqual({
            kind: 'tool',
            id: '0-tool-1',
            turnId: 'turn-1',
            sectionId: 'turn-1:0',
            name: 'delegate',
            at: 1_010,
            endedAt: 1_010,
            chars: 34,
            argsChars: 34,
            inPrompt: true,
            state: 'error',
            eventFrom: 1,
            eventTo: 1
        });

        // THE CHILD ROW'S OWN SEGMENT (the recorded run's row `:3`). Three figures are in play and
        // only the middle one is the segment's: the settle stamp 5_000 (pre-fix), the ROW's last frame
        // 1_050 (the T-W23 rule, one plane up), and the CALL's last frame 1_040.
        expect(segmentOf(result, 'turn-1:1', '1-tool-4')).toEqual({
            kind: 'tool',
            id: '1-tool-4',
            turnId: 'turn-1',
            sectionId: 'turn-1:1',
            name: 'shell',
            at: 1_040,
            endedAt: 1_040,
            chars: 18,
            argsChars: 18,
            inPrompt: true,
            state: 'error',
            eventFrom: 4,
            eventTo: 4
        });

        // ONE wire patch per abandoned segment, WHOLE. The key set is the content proof: `state` +
        // `endedAt` and NOTHING else, so `chars`/`argsChars`/`inPrompt`/`eventTo` — the bar's content
        // and redaction semantics — did not move.
        expect(settledSegmentPatches(settleOps)).toEqual([
            { sectionId: 'turn-1:0', blockId: '0-tool-1', patch: { state: 'error', endedAt: 1_010 } },
            { sectionId: 'turn-1:1', blockId: '1-tool-4', patch: { state: 'error', endedAt: 1_040 } }
        ]);

        // THE SEGMENT AND THE CARD AGREE, which is the whole point: the same call, two planes, one end.
        const card = (sectionOf(result, 'turn-1:0')?.nodes ?? []).find((node) => node.id === '1') as Record<
            string,
            unknown
        >;
        const segment = segmentOf(result, 'turn-1:0', '0-tool-1') as Record<string, unknown>;

        expect([segment.at, segment.endedAt]).toEqual([card.startedAt, card.endedAt]);

        // ...and the child's segment ends BEFORE its own row, which is the ordering the reader should
        // see (the call stopped; the row kept reasoning for one more frame).
        expect(segmentOf(result, 'turn-1:1', '1-tool-4')).toHaveProperty('endedAt', 1_040);
        expect(sectionOf(result, 'turn-1:1')).toMatchObject({ endedAt: 1_050, state: 'cancelled' });
        expect(sectionOf(result, 'turn-1:0')).toMatchObject({ endedAt: SETTLE_AT, state: 'done' });
    });

    it('renders 0ms in the bar for an abandoned call where the pre-fix stamp rendered 4.0s', () => {
        const result = fold(DEATH);

        const patches = settledSegmentPatches(result.settle('done'));

        expect(patches).toHaveLength(2);

        const tree = result.display();
        const segment = segmentOf(tree, 'turn-1:1', '1-tool-4') as ContextBlock;

        // THE FIGURE THE WIDGET PRINTS (../frontend/ui/context-bar.ts:1201 and
        // ../frontend/ui/context-detail.ts:421 both read this function).
        expect(contextBlockDurationOf(segment)).toBe(0);
        expect(contextSegmentTitleOf(segment)).toBe(
            'shell · tool · error · 18 characters · args 18, no result recorded · 0ms'
        );

        // DISCRIMINATION, stated as the figure the pre-fix stamp produced for the SAME segment: the
        // whole rest of the turn, 3,960 ms -> `4.0s`, i.e. the restart-sized `64m04s` shape of the
        // recorded run. Reverting the fix makes these two assertions fail with the pre-fix number.
        const before = preFixSegments(segmentsOf(tree, 'turn-1:1')).find(
            (block) => block.id === '1-tool-4'
        ) as ContextBlock;

        expect(contextBlockDurationOf(before)).toBe(3_960);
        expect(elapsedBetween(1_040, SETTLE_AT)).toBe(3_960);
        expect(formatDuration(3_960)).toBe('4.0s');
        expect(formatDuration(0)).toBe('0ms');

        // THE STRIP AGGREGATE, the same inflation one level up: the pre-fix stamps added 7,950 ms of
        // span no call ever lived (3,990 + 3,960), and the strip's horizontal axis is scaled off this.
        expect(contextBarOf(tree).totalDurationMs).toBe(0);
        expect(contextBarOf(preFixBar(tree)).totalDurationMs).toBe(7_950);
        // 5 of the 7 segments are still unbracketed prose/prompt blocks, and that count is NOT this
        // fix's business: an un-timed segment keeps saying "time not recorded".
        expect(contextBarOf(tree).durationsUnknown).toBe(5);
        expect(contextBarOf(tree).blocks).toHaveLength(7);
    });

    it('ends the segment of a CANCELLED turn at its own stamp too (state vocabulary unchanged)', () => {
        const result = fold(DEATH);

        result.settle('cancelled');

        // `cancelled` for the state (a control outcome, exactly as before) and the call's own stamp for
        // the end — the same pair the card two lines above it carries.
        expect(segmentOf(result, 'turn-1:0', '0-tool-1')).toMatchObject({
            state: 'cancelled',
            at: 1_010,
            endedAt: 1_010
        });
        expect(segmentOf(result, 'turn-1:1', '1-tool-4')).toMatchObject({
            state: 'cancelled',
            at: 1_040,
            endedAt: 1_040
        });
    });
});

describe('T-W25 — a segment that got its own terminal event is byte-identical', () => {
    // A journal whose calls BOTH kinds exist: one result-only legacy frame (already terminal at mint),
    // and one call that received its `tool_result` (with the tool's own measured `durationMs`).
    const SETTLED: HarnessEvent[] = [
        start('one', 'gpt-x', ROOT), // 0 -> 1_000
        toolResult('read', 'body of the result', 'call-1', { durationMs: 41, outcome: 'completed' }), // 1 -> 1_010  result-only mint
        delegateCall('call-2'), // 2 -> 1_020
        toolResult('delegate', 'sub result', 'call-2', { isError: true, outcome: 'failed' }) // 3 -> 1_030  its own terminal frame
    ];

    it('moves nothing at all on the settle pass when every call already settled', () => {
        const result = fold(SETTLED);
        const before = JSON.stringify(segmentsOf(result, 'turn-1:0'));

        const settleOps = result.settle('error');

        // The whole `context` array, byte for byte — not one field of it.
        expect(JSON.stringify(segmentsOf(result, 'turn-1:0'))).toBe(before);
        // And no segment patch travelled on the wire at all, which is the same proof from the op side.
        expect(settledSegmentPatches(settleOps)).toEqual([]);

        // THE FACES, pinned exactly: a measured call keeps the tool's own `durationMs` (the bar reads
        // THAT and never touches `endedAt`), and a call with a result but no measurement keeps the
        // result frame's recorded settle time.
        expect(segmentOf(result, 'turn-1:0', '0-tool-1')).toEqual({
            kind: 'tool',
            id: '0-tool-1',
            turnId: 'turn-1',
            sectionId: 'turn-1:0',
            name: 'read',
            at: 1_010,
            endedAt: 1_010,
            chars: 18,
            resultChars: 18,
            inPrompt: true,
            state: 'ok',
            durationMs: 41,
            eventFrom: 1,
            eventTo: 1
        });
        expect(segmentOf(result, 'turn-1:0', '0-tool-2')).toEqual({
            kind: 'tool',
            id: '0-tool-2',
            turnId: 'turn-1',
            sectionId: 'turn-1:0',
            name: 'delegate',
            at: 1_020,
            endedAt: 1_030,
            chars: 44,
            argsChars: 34,
            resultChars: 10,
            inPrompt: true,
            state: 'error',
            eventFrom: 2,
            eventTo: 3
        });

        expect(contextBlockDurationOf(segmentOf(result, 'turn-1:0', '0-tool-1') as ContextBlock)).toBe(41);
        expect(contextBlockDurationOf(segmentOf(result, 'turn-1:0', '0-tool-2') as ContextBlock)).toBe(10);
        expect(contextBarOf(result.display()).totalDurationMs).toBe(51);
    });

    it('leaves a settled segment alone even when the same turn ALSO abandoned one', () => {
        // The mixed board, which is the shape the recorded run has: row `:0` holds 3 abandoned calls
        // beside settled ones. The settled one must keep its own numbers next to a moved one.
        const result = fold([
            start('one', 'gpt-x', ROOT), // 0 -> 1_000
            toolResult('read', 'body of the result', 'call-1', { durationMs: 41, outcome: 'completed' }), // 1 -> 1_010  settled
            delegateCall('call-2') // 2 -> 1_020  abandoned
        ]);

        const settled = JSON.stringify(segmentOf(result, 'turn-1:0', '0-tool-1'));
        const settleOps = result.settle('error');

        expect(JSON.stringify(segmentOf(result, 'turn-1:0', '0-tool-1'))).toBe(settled);
        expect(settledSegmentPatches(settleOps)).toEqual([
            { sectionId: 'turn-1:0', blockId: '0-tool-2', patch: { state: 'error', endedAt: 1_020 } }
        ]);
        expect(contextBlockDurationOf(segmentOf(result, 'turn-1:0', '0-tool-1') as ContextBlock)).toBe(41);
        expect(contextBlockDurationOf(segmentOf(result, 'turn-1:0', '0-tool-2') as ContextBlock)).toBe(0);
    });
});

describe('T-W25 — a record with no stamps keeps the previous value byte-identically', () => {
    const LEGACY = [
        start('one', 'gpt-x', ROOT),
        text('one', 'partial', ROOT),
        { type: 'tool_call', agent: 'one', call: { id: 'call-1', name: 'shell', arguments: '{"command":"sleep 99"}' } }
    ] as HarnessEvent[];

    // THE PRE-FIX FACE, and therefore the post-fix face too: with no `eventTimes` there is no stamp
    // anywhere, so the rule falls back to the settle stamp and this object is reproduced exactly —
    // `endedAt: 5_000`, and `at` still ABSENT (the R9 rule: an un-timed record gains no boundary it
    // did not have, and a fabricated stamp would paint a fake time).
    const PRE_FIX_SEGMENT = {
        kind: 'tool',
        id: '0-tool-2',
        turnId: 'turn-1',
        sectionId: 'turn-1:0',
        name: 'shell',
        endedAt: SETTLE_AT,
        chars: 22,
        argsChars: 22,
        inPrompt: true,
        state: 'error',
        eventFrom: 2,
        eventTo: 2
    };

    const legacyFold = (): Folded =>
        foldWith(
            [...LEGACY],
            LEGACY.map(() => DISPLAY_NO_TIMESTAMP),
            turnOf({ eventTimes: undefined })
        );

    it('keeps the settle stamp as the segment end when the record holds no stamps', () => {
        const result = legacyFold();

        result.settle('done');

        expect(segmentOf(result, 'turn-1:0', '0-tool-2')).toEqual(PRE_FIX_SEGMENT);
        // Absent, not zero.
        expect('at' in (segmentOf(result, 'turn-1:0', '0-tool-2') as Record<string, unknown>)).toBe(false);
        // No span is invented either: the bar says "time not recorded", exactly as before the fix.
        expect(contextBlockDurationOf(segmentOf(result, 'turn-1:0', '0-tool-2') as ContextBlock)).toBeUndefined();
        expect(contextSegmentTitleOf(segmentOf(result, 'turn-1:0', '0-tool-2') as ContextBlock)).toContain(
            'time not recorded'
        );
        expect(contextBarOf(result.display()).totalDurationMs).toBeUndefined();
    });

    it('still sends the settle stamp for an un-timed abandoned segment', () => {
        const result = legacyFold();

        const settleOps = result.settle('done');

        expect(settledSegmentPatches(settleOps)).toEqual([
            { sectionId: 'turn-1:0', blockId: '0-tool-2', patch: { state: 'error', endedAt: SETTLE_AT } }
        ]);
    });
});

describe('T-W25 — live ≡ replay for the segment rule', () => {
    it('a reload of the settled run serves the same segments the live fold painted', () => {
        const live = fold(DEATH);

        live.settle('done');

        const liveTree = live.display();
        const liveSummary = live.summary();

        // The COLD fold is what a reload and every view read serve (./turn-projector.ts `projectTurn`).
        // If the segment end came from `Date.now()` or from live-only state, these two boards would
        // disagree the moment the page refreshed.
        const cold = projectTurn(live.turn, CONTEXT);
        const coldAgain = projectTurn(live.turn, CONTEXT);

        expect(cold.display).toEqual(liveTree);
        expect(cold.summary).toEqual(liveSummary);
        expect(coldAgain.display).toEqual(cold.display);

        // Stated once more as the exact segment, read off the COLD board: 1_040, not the settle stamp
        // and not the row end — and the bar figure it renders, 0 ms.
        expect(segmentOf(cold.display, 'turn-1:1', '1-tool-4')).toMatchObject({
            at: 1_040,
            endedAt: 1_040,
            state: 'error'
        });
        expect(contextBlockDurationOf(segmentOf(cold.display, 'turn-1:1', '1-tool-4') as ContextBlock)).toBe(0);
        expect(contextBlockDurationOf(segmentOf(cold.display, 'turn-1:0', '0-tool-1') as ContextBlock)).toBe(0);
    });

    it('folds the un-timed record the same live and cold', () => {
        const events = [
            start('one', 'gpt-x', ROOT),
            text('one', 'partial', ROOT),
            {
                type: 'tool_call',
                agent: 'one',
                call: { id: 'call-1', name: 'shell', arguments: '{"command":"sleep 99"}' }
            }
        ] as HarnessEvent[];

        const record = turnOf({ eventTimes: undefined, status: 'done', updatedAt: SETTLE_AT, events: [...events] });
        const live = legacyRecord(record, events);

        const cold = projectTurn(
            turnOf({ eventTimes: undefined, status: 'done', updatedAt: SETTLE_AT, events: [...events] }),
            CONTEXT
        );

        expect(cold.display).toEqual(live.display());
        expect(cold.display.sections[0].context?.[2]).toEqual({
            kind: 'tool',
            id: '0-tool-2',
            turnId: 'turn-1',
            sectionId: 'turn-1:0',
            name: 'shell',
            endedAt: SETTLE_AT,
            chars: 22,
            argsChars: 22,
            inPrompt: true,
            state: 'error',
            eventFrom: 2,
            eventTo: 2
        });
    });

    it('a still-running turn that never settles keeps its running segments with no end at all', () => {
        // `settle` is the ONLY place this rule lives, so a running fold must not move a segment's clock:
        // a running call has no `endedAt` (the bar keeps "time not recorded" and the live tick stays
        // local, ../frontend/ui/context-bar.ts).
        const running = fold(DEATH.slice(0, 6));

        expect(segmentOf(running, 'turn-1:0', '0-tool-1')).toMatchObject({ state: 'running' });
        expect('endedAt' in (segmentOf(running, 'turn-1:0', '0-tool-1') as Record<string, unknown>)).toBe(false);
        expect('endedAt' in (segmentOf(running, 'turn-1:1', '1-tool-4') as Record<string, unknown>)).toBe(false);
        expect(contextBlockDurationOf(segmentOf(running, 'turn-1:0', '0-tool-1') as ContextBlock)).toBeUndefined();
        expect(contextBarOf(running.display()).totalDurationMs).toBeUndefined();
    });
});

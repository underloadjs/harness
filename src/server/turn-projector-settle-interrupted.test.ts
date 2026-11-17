// T-W23 — a section the turn CLOSED without its own terminal frame reports its OWN last recorded
// activity as the end of its span, and says it was cut off instead of claiming success.
//
// THE DEFECT (measured end-to-end on the user's own recorded run — Temp/orch-plan/session.json +
// events.jsonl, and the replay probe Temp/orch-plan/w23/fold.ts with its pre-fix log
// Temp/orch-plan/w23/before.txt): a ~19-minute process death sits mid-turn (a 1,141,922 ms hole at
// frame index 17,476). Three PRE-restart delegated children were killed by that death and never
// received a terminal frame of their own, so `settle()` force-closed them with the TURN's end stamp
// and the TURN's state:
//
//   before:  :1 3,844,654 ms (64m04s) state=done   :2 3,844,647 ms (64m04s) state=done
//            :3 3,844,642 ms (64m04s) state=done
//   after :   :1   185,918 ms ( 3m05s) state=cancelled :2 185,915 ms (3m05s) state=cancelled
//            :3   185,930 ms ( 3m05s) state=cancelled
//
// `settle` was stamping every row it reached with `endedAt = turn.updatedAt` and
// `state = sectionStateOf(turn.status)`, so a row killed 19 minutes before the turn closed printed
// a 64-minute span and claimed it had FINISHED. The rule now, in ./turn-projector.ts
// `interruptedStateOf` / `interruptedEndedAtOf` and `settle`:
//
//   1. a row that answered with its OWN terminal frame (the `done`/`error`/`branch_end`/
//      `tool_result` sites at ./turn-projector.ts:3092, :3235, :3403, :2979) is UNTOUCHED — it
//      already stamped its real end and its real outcome;
//   2. a row the turn closed ends at `record.lastStamp`, the stamp of the last frame ROUTED TO THAT
//      ROW (written by `apply` at ./turn-projector.ts:3436 from frame stamps only — never
//      `Date.now()`, never live state, so live ≡ replay holds by construction), and reports
//      `'cancelled'`, the EXISTING `SectionDisplayState` value this codebase already uses for "ended
//      before completing, by a control event, not by its own failure" (`branch_end`
//      `status: 'cancelled'` :3403; a spawning `tool_result` with `outcome: 'cancelled'`, "A
//      CANCELLED call is a control outcome, never an error", :2974);
//   3. the turn's OWN card (`ROOT_KEY`) is exempt: `settle` IS its terminal frame by design (a
//      `done` closes one AGENT turn — "the root keeps streaming until the turn settles",
//      ./turn-projector.ts:3086, :686), its span is the pair the turn tile prints from
//      `TurnSummary.startedAt`/`updatedAt` (../frontend/ui/turns.ts:9347-9354), and on the recorded
//      run that wall span is honest: the root conversation ran pre-restart, resumed on THIS row
//      post-restart, answered at 1794867200207 and then waited on its own recorded pending
//      delegation until the last lane's `error` frame closed the turn at 1794867558009.
//
// WHY `'cancelled'` AND NOT ANOTHER VALUE (the vocabulary is fixed at
// ../shared/turn-display.ts:195, so this introduces NOTHING new — no wire change, no REST-model
// change (../shared/harness-api.ts:3275 is a verbatim alias), no restore/round-trip migration):
// `'done'` is the lie; `'error'` claims a failure the record does not hold (a section's `'error'`
// is stamped only next to a recorded `error` frame and its notice, :3235); `'open'`/`'streaming'`
// claim the row is still running and would keep its agent in the live active set
// (../frontend/view-state.ts:963,976).
//
// THE STATE MAP FOR A TURN THAT DID NOT SETTLE `done` is deliberately unchanged
// (`sectionStateOf`: error → 'error', cancelled → 'cancelled'): those rows were never claiming
// success, and the complaint was only about that claim. Their SPAN is still truncated — an
// interrupted row's end is its own last frame whichever way the turn ended.
//
// Every value below is measured: the fold is the store's own order (`createTurnProjector` + one
// `apply()` per recorded event + `settle()`), and each expectation is an event index the reader can
// count (`timeOf(index) = 1_000 + index * 10`, `settle` at 5_000).
//
// Run: yarn vitest run src/server/turn-projector-settle-interrupted.test.ts  (cwd packages/underload/harness)

import { describe, expect, it } from 'vitest';
import { formatDuration, elapsedBetween } from '../frontend/ui/time';
import type { HarnessEvent } from '../harness';
import type { DisplayProjectContext, TurnDisplayOp, TurnRecordStatus, TurnSection } from '../shared/turn-display';
import { createTurnProjector, projectTurn } from './turn-projector';
import type { SessionTurn } from './protocol';

const CONTEXT: DisplayProjectContext = { primary: 'one' };

// One recorded event per 10 ms, exactly as ./turn-projector-restart.test.ts does it, so every
// span below is an event count.
const timeOf = (index: number): number => 1_000 + index * 10;

// The turn closes at 5_000 — 3,900 ms after the killed child's last frame. That gap IS the defect:
// the pre-fix span of that row was exactly this gap plus its own run.
const SETTLE_AT = 5_000;

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

type Folded = {
    turn: SessionTurn;
    ops: TurnDisplayOp[][];
    display: () => ReturnType<typeof createTurnProjector>['display'];
    summary: () => ReturnType<typeof createTurnProjector>['summary'];
    settle: (status: TurnRecordStatus) => TurnDisplayOp[];
};

// The LIVE path: push the record, then fold it — the store recorder's order (./sessions.ts), so
// every assertion here is also a parity assertion once re-read through `projectTurn`.
const foldWith = (events: HarnessEvent[], stamps: number[]): Folded => {
    const turn = turnOf();
    const projector = createTurnProjector(turn, CONTEXT);
    const ops: TurnDisplayOp[][] = [];

    events.forEach((event, index) => {
        turn.events.push(event);
        turn.eventTimes?.push(stamps[index]);
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

const fold = (events: HarnessEvent[], stamps: number[] = events.map((_event, index) => timeOf(index))): Folded =>
    foldWith(events, stamps);

const sectionOf = (sections: TurnSection[], id: string): TurnSection => {
    const found = sections.find((section) => section.id === id);

    if (found === undefined) throw new Error(`no section ${id} in ${sections.map((section) => section.id).join(', ')}`);

    return found;
};

// The section WITHOUT its node list / context bar / tail: those are asserted whole separately.
// Asserting the face whole is what proves the fix touched no other field (no new key, no removed
// key, no moved label, no moved token figure).
const faceOf = (section: TurnSection): Record<string, unknown> => {
    const copy = { ...(section as unknown as Record<string, unknown>) };

    delete copy.nodes;
    delete copy.context;
    delete copy.tail;

    return copy;
};

const nodesOf = (sections: TurnSection[], id: string): unknown[] => sectionOf(sections, id).nodes;

// The turn's own conversation flow: one id, no parent, no spawn call, no kind, no branch.
const ROOT = { id: 'inv-root' };

// A delegated flow: it names its parent invocation AND the spawning call, which is how `route`
// finds the row the parent's `tool_call` opened. NO `epoch` anywhere: these are the legacy,
// pre-2026-11-17 bytes.
const childOf = (id: string, callId: string) => ({
    id,
    parentId: 'inv-root',
    callId,
    kind: 'delegation' as const,
    input: 'sub task'
});

const CHILD_KILLED = childOf('inv-15', 'call-1');
const CHILD_ANSWERED = childOf('inv-16', 'call-2');

const start = (agent: string, model: string, thread?: HarnessEvent['thread']): HarnessEvent => ({
    type: 'start',
    agent,
    model,
    ...(thread === undefined ? {} : { thread })
});

const reasoning = (agent: string, delta: string, thread?: HarnessEvent['thread']): HarnessEvent => ({
    type: 'reasoning',
    agent,
    delta,
    ...(thread === undefined ? {} : { thread })
});

const text = (agent: string, delta: string, thread?: HarnessEvent['thread']): HarnessEvent => ({
    type: 'text',
    agent,
    delta,
    ...(thread === undefined ? {} : { thread })
});

const done = (agent: string, model: string, content: string, thread?: HarnessEvent['thread']): HarnessEvent => ({
    type: 'done',
    agent,
    message: { role: 'assistant', content, reasoning: '', toolCalls: [], model, stopReason: 'stop' },
    ...(thread === undefined ? {} : { thread })
});

const failure = (agent: string, message: string, thread?: HarnessEvent['thread']): HarnessEvent => ({
    type: 'error',
    agent,
    error: { message },
    ...(thread === undefined ? {} : { thread })
});

const toolCall = (id: string): HarnessEvent => ({
    type: 'tool_call',
    agent: 'one',
    call: { id, name: 'delegate', arguments: JSON.stringify({ agent: 'two', input: 'sub task' }) }
});

const commit = (agent = 'one'): HarnessEvent =>
    ({ type: 'attempt_commit', agent, attempt: 1, maxAttempts: 3 }) as HarnessEvent;

// THE JOURNAL: two delegated children, one of them killed mid-run by the process death (it never
// emits another frame), the other one ANSWERING with its own `done`; then the resumed
// conversation answers and the turn settles 3,900 ms later. Event indices are the timestamps.
const DEATH: HarnessEvent[] = [
    start('one', 'gpt-x', ROOT), // 0  -> 1_000  the conversation's own flow
    toolCall('call-1'), // 1  -> 1_010  mints the killed child's row
    start('two', 'gpt-y', CHILD_KILLED), // 2  -> 1_020  adopts it as 'turn-1:1' (= its `startedAt`)
    reasoning('two', 'reading the source', CHILD_KILLED), // 3  -> 1_030
    text('two', 'half an answer', CHILD_KILLED), // 4  -> 1_040  ...and THIS is its last frame
    toolCall('call-2'), // 5  -> 1_050  mints the answered child's row
    start('three', 'gpt-z', CHILD_ANSWERED), // 6  -> 1_060  adopts it as 'turn-1:2'
    text('three', 'a finished answer', CHILD_ANSWERED), // 7  -> 1_070
    done('three', 'gpt-z', 'a finished answer', CHILD_ANSWERED), // 8  -> 1_080  its OWN terminal frame
    text('one', 'the complete answer', ROOT), // 9  -> 1_090  the resumed conversation
    done('one', 'gpt-x', 'the complete answer', ROOT), // 10 -> 1_100
    commit() // 11 -> 1_110
];

// THE PRE-FIX BOARD for this exact journal, captured by folding it with the pre-fix `settle`
// (Temp/orch-plan/w23/face-before.txt; the same shape ./turn-projector.test.ts and
// ./turn-projector-threads.test.ts pinned before this change: `endedAt = SETTLE_AT` for every row
// `settle` reached, and `state: 'done'` for a `done` turn). Pinned here so the test below proves
// the diff is EXACTLY the two fields the fix is about, on EXACTLY the killed row.
const FACE_BEFORE: Record<string, Record<string, unknown>> = {
    'turn-1:0': {
        id: 'turn-1:0',
        role: 'primary',
        agent: 'one',
        agentLabel: '',
        state: 'done',
        invocationId: 'inv-root',
        startedAt: 1_000,
        model: 'gpt-x',
        answerNodeId: 'n9',
        endedAt: SETTLE_AT
    },
    'turn-1:1': {
        id: 'turn-1:1',
        parentSectionId: 'turn-1:0',
        role: 'subagent',
        agent: 'two',
        agentLabel: '',
        state: 'done', // the lie: this run never reached a terminal frame
        invocationId: 'inv-15',
        startedAt: 1_020,
        model: 'gpt-y',
        endedAt: SETTLE_AT // 3,980 ms of span the run never lived
    },
    'turn-1:2': {
        id: 'turn-1:2',
        parentSectionId: 'turn-1:0',
        role: 'subagent',
        agent: 'two',
        agentLabel: '',
        state: 'done',
        invocationId: 'inv-16',
        startedAt: 1_060,
        model: 'gpt-z',
        answerNodeId: 'n7',
        endedAt: 1_080
    }
};

describe('T-W23 — a force-closed section reports its own last activity, and that it was cut off', () => {
    it('ends a run killed without a terminal frame at its OWN last frame and calls it cancelled', () => {
        const result = fold(DEATH);

        result.settle('done');

        const sections = result.display().sections;
        const killed = sectionOf(sections, 'turn-1:1');

        // SPAN END = the last frame routed to THIS row (event 4), not the turn's end: the row was
        // killed at 1_040 and the turn only closed 3,900 ms later.
        expect(killed.startedAt).toBe(1_020);
        expect(killed.endedAt).toBe(1_040);
        // The exact figure the row prints through ../frontend/ui/time.ts, and the figure it printed
        // before (a 3,980 ms span the run never lived).
        expect(formatDuration(elapsedBetween(killed.startedAt, killed.endedAt) ?? -1)).toBe('20ms');
        expect(formatDuration(SETTLE_AT - (killed.startedAt ?? 0))).toBe('4.0s');
        // STATE = cut off, not success.
        expect(killed.state).toBe('cancelled');

        // The face, WHOLE: nothing else on the row moved.
        expect(faceOf(killed)).toEqual({
            id: 'turn-1:1',
            parentSectionId: 'turn-1:0',
            role: 'subagent',
            agent: 'two',
            agentLabel: '',
            state: 'cancelled',
            invocationId: 'inv-15',
            startedAt: 1_020,
            model: 'gpt-y',
            endedAt: 1_040
        });

        // The row still holds ONLY its own two frames — the fix is about the clock and the state,
        // not about what was recorded.
        expect(nodesOf(sections, 'turn-1:1')).toEqual([
            { kind: 'reasoning', id: 'n3', text: 'reading the source', chars: 18 },
            { kind: 'text', id: 'n4', text: 'half an answer', committed: false, chars: 14 }
        ]);

        // The turn-level verdict is UNTOUCHED: the turn genuinely completed, with the model that
        // answered. The complaint was about the section rows.
        expect(result.summary()).toMatchObject({ status: 'done', state: 'done', detail: 'gpt-x' });
    });

    it('leaves a section that answered with its OWN terminal frame byte-for-byte as it was', () => {
        const result = fold(DEATH);

        result.settle('done');

        const sections = result.display().sections;
        const answered = sectionOf(sections, 'turn-1:2');

        // Its `done` (event 8) stamped both the end and the outcome; `settle` must not move either,
        // so this row is identical before and after the fix.
        expect(answered.state).toBe('done');
        expect(answered.startedAt).toBe(1_060);
        expect(answered.endedAt).toBe(1_080);
        expect(formatDuration(elapsedBetween(answered.startedAt, answered.endedAt) ?? -1)).toBe('20ms');
        expect(faceOf(answered)).toEqual(FACE_BEFORE['turn-1:2']);

        // A row that FAILED with its own `error` frame is equally untouched: the failure stamped
        // both the state and the end at ITS stamp (1_050), and `settle` never revisits a terminal
        // row. This is the recorded run's rows :4/:7/:8 — 21m58s / 19m23s / 17m56s spans that stay.
        const failed = fold([
            ...DEATH.slice(0, 5),
            failure('two', 'upstream stream terminated', CHILD_KILLED), // 5 -> 1_050 its OWN error frame
            ...DEATH.slice(5)
        ]);

        failed.settle('done');

        const failedSections = failed.display().sections;

        expect(faceOf(sectionOf(failedSections, 'turn-1:1'))).toEqual({
            id: 'turn-1:1',
            parentSectionId: 'turn-1:0',
            role: 'subagent',
            agent: 'two',
            agentLabel: '',
            state: 'error',
            invocationId: 'inv-15',
            startedAt: 1_020,
            model: 'gpt-y',
            endedAt: 1_050
        });
        expect(nodesOf(failedSections, 'turn-1:1')).toEqual([
            { kind: 'reasoning', id: 'n3', text: 'reading the source', chars: 18 },
            { kind: 'text', id: 'n4', text: 'half an answer', committed: false, chars: 14 },
            { kind: 'notice', id: 'n5', tone: 'error', text: 'upstream stream terminated', at: 1_050 }
        ]);
    });

    it("keeps the turn's own card on the turn's span and the turn's state", () => {
        const result = fold(DEATH);

        result.settle('done');

        const root = sectionOf(result.display().sections, 'turn-1:0');

        // `settle` IS the root row's terminal frame (./turn-projector.ts:3086, :686), so its end is
        // the turn's end and its state is the turn's state — the same pair the turn tile prints from
        // `TurnSummary.startedAt`/`updatedAt` (../frontend/ui/turns.ts:9347-9354). Truncating THIS
        // row would make the section disagree with the tile about a span the reader watched live.
        expect(root.state).toBe('done');
        expect([root.startedAt, root.endedAt]).toEqual([1_000, SETTLE_AT]);
        expect(faceOf(root)).toEqual(FACE_BEFORE['turn-1:0']);
    });

    it('changes ONLY the state and the end of the killed row on an epoch-less (legacy) record', () => {
        // The journal above carries no `thread.epoch` at all — it is the legacy shape every store
        // wrote before 2026-11-17 — so this is the backward-compatibility proof: fold it and diff
        // every face against the pinned pre-fix board.
        const result = fold(DEATH);

        result.settle('done');

        // The ONE intended diff: the killed row's `state` and `endedAt`. Everything else, on every
        // row, is byte-identical — including key SETS, so nothing was added to the wire and nothing
        // was dropped (the epoch stays row state, never a section field).
        const intended: Record<string, Record<string, unknown>> = {
            'turn-1:1': { state: 'cancelled', endedAt: 1_040 }
        };

        for (const [id, before] of Object.entries(FACE_BEFORE)) {
            const after = faceOf(sectionOf(result.display().sections, id));

            expect(after).toEqual({ ...before, ...(intended[id] ?? {}) });
            expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
        }

        // And the two fields that DID move are the only ones that differ, on exactly one row.
        const moved = result
            .display()
            .sections.filter((section) => JSON.stringify(faceOf(section)) !== JSON.stringify(FACE_BEFORE[section.id]));

        expect(moved.map((section) => section.id)).toEqual(['turn-1:1']);
    });

    it('writes no timing for a record with no event times, and still stops claiming success', () => {
        // `at` is `DISPLAY_NO_TIMESTAMP` (0) for every frame, so `record.lastStamp` stays undefined:
        // the span keeps its documented ABSENCE (the client hides the label rather than printing the
        // record's wall-clock age, ../frontend/ui/time.ts) — exactly as before the fix.
        const turn = turnOf({ eventTimes: undefined });
        const projector = createTurnProjector(turn, CONTEXT);

        DEATH.forEach((event, index) => projector.apply(event, 0, index));
        projector.settle('done', 0);

        const sections = projector.display().sections;

        for (const section of sections) {
            expect('startedAt' in section).toBe(false);
            expect('endedAt' in section).toBe(false);
        }

        // The STATE is not a clock, so the truth applies to un-timed records too: the killed row no
        // longer claims it finished.
        expect(sectionOf(sections, 'turn-1:1').state).toBe('cancelled');
        expect(sectionOf(sections, 'turn-1:2').state).toBe('done');
        expect(sectionOf(sections, 'turn-1:0').state).toBe('done');
    });

    it("clamps an out-of-order journal to the row's own start instead of hiding the label", () => {
        // A journal can hand frames out of order (./turn-projector-restart.test.ts pins the same
        // tolerance for `isRunBoundary`). The start is FIRST-WRITE-WINS (event 2, 1_040) and the
        // row's last routed frame is stamped EARLIER (event 3, 1_030), so a naive "last frame" end
        // would run backwards and ../frontend/ui/time.ts `elapsedBetween` would return undefined —
        // the label would vanish. The recorded start is the honest floor.
        const stamps = [1_000, 1_010, 1_040, 1_030, 1_050, 1_060];
        const result = fold(
            [
                start('one', 'gpt-x', ROOT), // 0
                toolCall('call-1'), // 1
                start('two', 'gpt-y', CHILD_KILLED), // 2  stamped 1_040 (out of order)
                reasoning('two', 'reading the source', CHILD_KILLED), // 3  stamped 1_030 (its last frame)
                text('one', 'the complete answer', ROOT), // 4
                done('one', 'gpt-x', 'the complete answer', ROOT) // 5
            ],
            stamps
        );

        result.settle('done');

        const killed = sectionOf(result.display().sections, 'turn-1:1');

        expect(killed.startedAt).toBe(1_040);
        expect(killed.endedAt).toBe(1_040);
        expect(formatDuration(elapsedBetween(killed.startedAt, killed.endedAt) ?? -1)).toBe('0ms');
        expect(killed.state).toBe('cancelled');
    });

    it('keeps the old state mapping for a turn that settled error or cancelled', () => {
        // The complaint was a row CLAIMING SUCCESS, so only that mapping changed. A turn that
        // settled `error`/`cancelled` explains its unfinished rows the way it always did
        // (`sectionStateOf`), while the SPAN is still truncated — an interrupted row's end is its
        // own last frame whichever way the turn ended.
        const errored = fold(DEATH);

        errored.settle('error');

        const erroredSections = errored.display().sections;

        expect(sectionOf(erroredSections, 'turn-1:1').state).toBe('error');
        expect([
            sectionOf(erroredSections, 'turn-1:1').startedAt,
            sectionOf(erroredSections, 'turn-1:1').endedAt
        ]).toEqual([1_020, 1_040]);
        expect(sectionOf(erroredSections, 'turn-1:0').state).toBe('error');
        expect(sectionOf(erroredSections, 'turn-1:0').endedAt).toBe(SETTLE_AT);

        const cancelled = fold(DEATH);

        cancelled.settle('cancelled');

        const cancelledSections = cancelled.display().sections;

        expect(sectionOf(cancelledSections, 'turn-1:1').state).toBe('cancelled');
        expect([
            sectionOf(cancelledSections, 'turn-1:1').startedAt,
            sectionOf(cancelledSections, 'turn-1:1').endedAt
        ]).toEqual([1_020, 1_040]);
        expect(sectionOf(cancelledSections, 'turn-1:0').state).toBe('cancelled');

        // A row that answered itself keeps `done` in BOTH cases: the turn's outcome never overwrites
        // a section's own recorded terminal frame.
        expect(sectionOf(erroredSections, 'turn-1:2').state).toBe('done');
        expect(sectionOf(cancelledSections, 'turn-1:2').state).toBe('done');
    });

    it('settles the same board live and cold, killed row and answered row alike', () => {
        // live ≡ replay, the invariant at the top of ./turn-projector.ts: the fix is a pure function
        // of the recorded event sequence (`record.lastStamp` is written from frame stamps only), so
        // the COLD fold a reload and every view read serve — `projectTurn` — must produce the byte
        // same board the live run streamed.
        const live = fold(DEATH);

        // The ops the terminal `settle` emits are a separate batch (the store appends them to the
        // stream the same way), so keep that batch to assert what the wire ACTUALLY carried.
        const settleOps = live.settle('done');

        const liveTree = live.display();
        const liveSummary = live.summary();
        const cold = projectTurn(live.turn, CONTEXT);
        const coldAgain = projectTurn(live.turn, CONTEXT);

        expect(cold.display).toEqual(liveTree);
        expect(cold.summary).toEqual(liveSummary);
        expect(coldAgain.display).toEqual(cold.display);
        expect(coldAgain.summary).toEqual(cold.summary);

        // And the parity is asserted on the VALUES that changed, not just structurally: both paths
        // end the killed row at 1_040 with `cancelled`, and keep the answered row at 1_080 with
        // `done` and the root row at the turn's end with `done`.
        expect(
            cold.display.sections.map((section) => [section.id, section.state, section.startedAt, section.endedAt])
        ).toEqual([
            ['turn-1:0', 'done', 1_000, SETTLE_AT],
            ['turn-1:1', 'cancelled', 1_020, 1_040],
            ['turn-1:2', 'done', 1_060, 1_080]
        ]);
        expect(cold.summary).toMatchObject({ status: 'done', state: 'done', detail: 'gpt-x', sectionCount: 3 });

        // The terminal ops a live watcher received carry the SAME pair, so the two planes cannot
        // paint different rows: exactly one `section:set` on the killed row holds its end, and no
        // op anywhere — stream or terminal batch — stamps it with the settle time.
        const isKilledRowPatch = (op: TurnDisplayOp): op is Extract<TurnDisplayOp, { op: 'section:set' }> =>
            op.op === 'section:set' && op.sectionId === 'turn-1:1';

        expect(settleOps.filter(isKilledRowPatch).map((op) => op.patch)).toEqual([
            { state: 'cancelled', endedAt: 1_040 }
        ]);
        // The killed row's whole `endedAt` lifecycle on the wire: minted with no end, streamed with
        // no end, closed ONCE with its own last frame. The pre-fix stream ended with a fourth value,
        // 5_000, which is the turn's end — not the row's.
        expect([...live.ops.flat(), ...settleOps].filter(isKilledRowPatch).map((op) => op.patch.endedAt)).toEqual([
            undefined,
            undefined,
            1_040
        ]);
    });
});

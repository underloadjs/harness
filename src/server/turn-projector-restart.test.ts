// T-W3 — F5 (a journal-id restart must not merge two runs into one section) and
// F6 (a completed turn must not be summarised by an older failure notice).
//
// WHY THIS FILE IS SEPARATE. ./turn-projector.test.ts and
// ./turn-projector-provider-retry.test.ts are being edited right now by T-W2 (retry
// classification), and ./turn-projector.ts is being edited by T-W3 for F5/F6. New,
// focused assertions live here so no two writers touch the same file; the two existing
// files stay as the regression gate for everything that predates these fixes (they are
// the pinned contract for routing, attempt discard, retry notices and the interrupted-
// resume `detail` strings, and F6 must not move any of them).
//
// THE LIVE ARTIFACT these scenarios are modelled on (dump of session
// a4a6f913-d8b4-436d-98c4-b9b0059b30cb, analyzed in Temp/orch-plan/report.md):
//   * the turn's journal carries 160 081 events across a 1 141 922 ms process death
//     (last frame before it @1794863899277, first frame after it @1794865041220);
//   * three delegated children ran under journal ids 15/16/17 before the death, and
//     after the restart the turn's OWN conversation and two fresh conversations were
//     recorded under those SAME ids — `thread.id` is an invocation id from a counter the
//     restarted process begins again (../harness.ts, the counter is per-process);
//   * the main conversation failed once with a provider-timeout (`agentResults[13]`,
//     stopReason `api-error`) and completed later (`agentResults[14]`, and a second
//     `done` for the main flow @1794867200227);
//   * the LAST frame in the whole journal is an `error` on a delegated lane @1794867558009
//     — after the main flow's completed answer, which is exactly the frame that must not
//     become the board's header text for a turn that completed.
//
// What each group is accountable for:
//   F5  one row per RUN: a root-shaped frame wearing a dead child's invocation id answers
//       on the conversation's own card; a shape-agreeing `start` recorded after a row's run
//       closed begins a new row; a shape-agreeing frame that is not stamped after that
//       close, or that does not open a run, still merges.
//   F6  the settled `detail`, in the precedence order documented at
//       ./turn-projector.ts `summaryOf`: done → the model that answered; error → the ROOT
//       flow's own recorded failure, a delegated flow's only as the fallback; anything else
//       → only the root flow's failure, so a lane failure never titles the turn.
//   PARITY  live ≡ replay: every fold below is asserted a second time through the COLD path
//       (`projectTurn`, what a reload and every view read serve), because F5/F6 must stay
//       pure functions of the recorded sequence — a fix keyed on wall-clock `Date.now()` or
//       on live-only state would pass the live assertion and show a different board after a
//       reload (the invariant at the top of ./turn-projector.ts).
//   T-W8  the residual F5 REPORTED but could not close: a restarted runtime re-mints CALL ids
//       too, so a post-restart child wearing a dead child's `thread.id` AND its `callId` merged
//       into the dead row, and no recorded field could separate them. Runs now carry a
//       per-process epoch (`HarnessThread.epoch`) and a KNOWN epoch that differs is a run
//       boundary ahead of every other rule; a record that names no epoch folds byte-identically
//       to how it folded before (groups B, C, D and E below are that pin, scenario by scenario
//       against scenario A).
//
// Run: yarn vitest run src/server/turn-projector-restart.test.ts   (cwd packages/underload/harness)

import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '../harness';
import type { DisplayProjectContext, TurnDisplayOp, TurnRecordStatus, TurnSection } from '../shared/turn-display';
import type { SessionTurn } from './protocol';
import { createTurnProjector, projectTurn } from './turn-projector';

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

const CONTEXT: DisplayProjectContext = { entry: 'one' };

// One recorded event per 10 ms, exactly as ./turn-projector.test.ts does it, so every
// duration and every boundary stamp in these assertions is an event index the reader can
// count. `isRunBoundary` compares the record's OWN stamps, so this spacing is the input.
const timeOf = (index: number): number => 1_000 + index * 10;

const SETTLE_AT = 5_000;

type Folded = {
    turn: SessionTurn;
    ops: TurnDisplayOp[][];
    display: () => ReturnType<ReturnType<typeof createTurnProjector>['display']>;
    summary: () => ReturnType<ReturnType<typeof createTurnProjector>['summary']>;
    settle: (status: TurnRecordStatus) => TurnDisplayOp[];
};

// The LIVE path: push the record, then fold it — the store recorder's own order
// (./sessions.ts), which is what makes every assertion below a parity test as well.
// Stamps default to `timeOf`; `foldAt` is the variant for an out-of-order journal.
const foldWith = (events: HarnessEvent[], stamps: number[], turn: SessionTurn = turnOf()): Folded => {
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

const fold = (events: HarnessEvent[], turn: SessionTurn = turnOf()): Folded =>
    foldWith(
        events,
        events.map((_event, index) => timeOf(index)),
        turn
    );

const sectionOf = (result: Folded, id: string): TurnSection | undefined =>
    result.display().sections.find((section) => section.id === id);

// A node list asserted WHOLE: kind, id and text, so a frame routed to the wrong row shows
// up as a diff instead of a count that happens to match.
const nodesOf = (result: Folded, id: string): unknown[] => sectionOf(result, id)?.nodes ?? [];

// The turn's own conversation flow, as the runtime records it: one id, no parent, no
// spawn call, no kind, no branch (the discriminator ./turn-projector.ts
// `isConversationRoot` shares with ../shared/agent-results.ts).
const ROOT = { id: 'inv-root' };

// A delegated flow: it names its parent invocation AND the spawning call, which is how
// `route` finds the row the parent's `tool_call` already opened (./turn-projector.ts
// `byCall`, `adoptPlaceholder`).
const childOf = (id: string, callId: string) => ({
    id,
    parentId: 'inv-root',
    callId,
    kind: 'delegation' as const,
    input: 'sub task'
});

// A delegated flow whose frames carry NO `callId`: the only way a frame can be
// child-SHAPED without a live call join, which is what rule (2)/(3) of `isRunBoundary`
// (a CLOSED row superseded by a later `start`) is about.
const detachedChild = (id: string) => ({ id, kind: 'delegation' as const });

const toolCall = (id: string, name = 'delegate'): HarnessEvent => ({
    type: 'tool_call',
    agent: 'one',
    call: { id, name, arguments: JSON.stringify({ agent: 'two', input: 'sub task' }) }
});

const reasoning = (agent: string, text: string, thread: HarnessEvent['thread']): HarnessEvent => ({
    type: 'reasoning',
    agent,
    delta: text,
    ...(thread === undefined ? {} : { thread })
});

const text = (agent: string, content: string, thread: HarnessEvent['thread']): HarnessEvent => ({
    type: 'text',
    agent,
    delta: content,
    ...(thread === undefined ? {} : { thread })
});

const start = (agent: string, model: string, thread: HarnessEvent['thread']): HarnessEvent => ({
    type: 'start',
    agent,
    model,
    ...(thread === undefined ? {} : { thread })
});

// The recorded commit: `answerNodeId` moves here (./turn-projector.ts `commitAttempt`),
// never at `done`, so an answer is pinned to the request that produced it.
const commit = (agent = 'one'): HarnessEvent =>
    ({ type: 'attempt_commit', agent, attempt: 1, maxAttempts: 3 }) as HarnessEvent;

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

describe('F5 — a recycled journal id starts a new section', () => {
    // The live artifact, reduced to its frame skeleton: three children ran under ids
    // 15/16/17, the process died, and the resumed process recorded its OWN conversation
    // under the id of a child that was cut off mid-run.
    const RESUMED_TURN: HarnessEvent[] = [
        start('one', 'gpt-x', ROOT), // 0  -> 1_000  the conversation's own flow
        reasoning('one', 'planning the run', ROOT), // 1  -> 1_010
        toolCall('call-1'), // 2  -> 1_020  mints the child row + its `tool` node
        start('two', 'gpt-y', childOf('inv-15', 'call-1')), // 3  -> 1_030  adopts the placeholder
        reasoning('two', 'reading the tool source', childOf('inv-15', 'call-1')), // 4  -> 1_040  cut off here
        // ---- the process dies; the restarted runtime begins its invocation counter again ----
        start('one', 'gpt-x', { id: 'inv-15' }), // 5  -> 1_050  root-shaped, wearing the dead child's id
        reasoning('one', 'the review is in', { id: 'inv-15' }), // 6  -> 1_060
        text('one', 'the complete answer', { id: 'inv-15' }), // 7  -> 1_070
        commit(), // 8  -> 1_080  the resumed request commits on the conversation's own row
        done('one', 'gpt-x', 'the complete answer', { id: 'inv-15' }) // 9  -> 1_090
    ];

    it('keeps the resumed conversation run out of the dead child row', () => {
        const result = fold(RESUMED_TURN);

        result.settle('done');

        // One row per RUN: the conversation's own card plus the one child that actually
        // ran. The recycled id did not mint a third row, and the child's row did not
        // become the conversation's card.
        expect(result.display().sections.map((section) => section.id)).toEqual(['turn-1:0', 'turn-1:1']);

        // Every post-restart frame landed on the conversation's own card, in order, and
        // the pre-restart child's row still holds ONLY its own two frames. Prose carries
        // `chars` (the recorded byte count, pinned in ./turn-projector.test.ts); the
        // `tool` node is the parent's step, and at settle a call that never returned is
        // abandoned with the fixed preview text (./turn-projector.ts `settle`).
        expect(nodesOf(result, 'turn-1:0')).toEqual([
            { kind: 'reasoning', id: 'n1', text: 'planning the run', chars: 16 },
            {
                kind: 'tool',
                id: '2',
                turnId: 'turn-1',
                sectionId: 'turn-1:0',
                name: 'delegate',
                callId: 'call-1',
                argsPreview: '{"agent":"two","input":"sub task"}',
                startedAt: 1_020,
                // T-W24 — THIS PIN MOVED, deliberately (it was `endedAt: SETTLE_AT`, 5_000). The
                // pre-fix value encoded the defect: the card was force-closed with the TURN's end
                // stamp, so this delegate printed a 3,980 ms span on a journal where the call's own
                // recorded activity stopped at 1_020 (event 2, `timeOf`). The card's span now ends at
                // the card's OWN last stamp — the same rule `interruptedEndedAtOf` applies one plane
                // up — while the abandoned `state`/`preview` below are untouched. Measured on the
                // user's run: 3,844,657 ms (64m04s) -> 0 ms (Temp/orch-plan/w24/before.txt vs
                // after.txt). See ./turn-projector.ts `abandonedEndedAtOf`.
                endedAt: 1_020,
                state: 'error',
                preview: 'the turn ended before this call returned',
                detail: { stepId: '2', hasResult: false, truncated: false }
            },
            { kind: 'reasoning', id: 'n6', text: 'the review is in', chars: 16 },
            { kind: 'text', id: 'n7', text: 'the complete answer', committed: true, chars: 19 }
        ]);
        expect(nodesOf(result, 'turn-1:1')).toEqual([
            { kind: 'reasoning', id: 'n4', text: 'reading the tool source', chars: 23 }
        ]);

        // The answer pointer is the copy target for the card and the summary line: it
        // moved with the RESUMED commit, on the conversation's own row.
        expect(sectionOf(result, 'turn-1:0')?.answerNodeId).toBe('n7');
        expect(sectionOf(result, 'turn-1:1')?.answerNodeId).toBeUndefined();

        // The span the user read as an impossible duration: the child's clock stops at
        // its own last frame (event 4), the conversation's own card spans the whole turn.
        expect(sectionOf(result, 'turn-1:1')?.startedAt).toBe(1_030);
        expect(sectionOf(result, 'turn-1:0')?.startedAt).toBe(1_000);

        expect(result.summary()).toMatchObject({ status: 'done', state: 'done', detail: 'gpt-x' });
    });

    it('replays the same journal to the same rows after a reload', () => {
        // The fix must be a pure function of the recorded sequence: a reload (and every
        // view read) goes through the COLD fold, and if F5 keyed on anything live the
        // board would change when the page refreshed.
        const live = fold(RESUMED_TURN);

        live.settle('done');

        const liveTree = live.display();
        const liveSummary = live.summary();
        const cold = projectTurn(live.turn, CONTEXT);
        const coldAgain = projectTurn(live.turn, CONTEXT);

        expect(cold.display).toEqual(liveTree);
        expect(cold.summary).toEqual(liveSummary);
        // Two independent cold folds of the same record are byte-identical, so a resync or
        // a second reader cannot show a different board.
        expect(coldAgain.display).toEqual(cold.display);
        expect(coldAgain.summary).toEqual(cold.summary);
    });

    it('keeps merging frames of a run whose row is still open', () => {
        // NOT a boundary: the row it matches never closed, so a second `start` wearing the
        // same id is a replay/continuation of the SAME run (the retry ladder re-sends
        // frames). `bindSectionStart` is first-write-wins, so the row keeps its span.
        const result = fold([
            start('one', 'gpt-x', ROOT), // 0
            reasoning('one', 'before', ROOT), // 1
            start('one', 'gpt-x', ROOT), // 2  same id, root-shaped, row still open
            reasoning('one', 'after', ROOT) // 3
        ]);

        result.settle('done');

        expect(result.display().sections.map((section) => section.id)).toEqual(['turn-1:0']);
        // One node, not two: consecutive prose deltas of the same flow extend the node the
        // request opened, which is another way of saying "the same run".
        expect(nodesOf(result, 'turn-1:0')).toEqual([{ kind: 'reasoning', id: 'n1', text: 'beforeafter', chars: 11 }]);
    });

    it('starts a new section when a like-shaped run opens after the row that closed', () => {
        // Rule (2)+(3): the shape alone cannot separate two runs of the SAME kind, so a
        // closed row is superseded only by a frame that OPENS a run (`start`) and is
        // stamped after the frame that closed it. A child-shaped frame with no `callId`
        // is the minimal way to ask that question.
        const result = fold([
            start('one', 'gpt-x', ROOT), // 0
            start('two', 'gpt-y', detachedChild('inv-9')), // 1  -> 1_010 first run
            text('two', 'first answer', detachedChild('inv-9')), // 2  -> 1_020
            done('two', 'gpt-y', 'first answer', detachedChild('inv-9')), // 3  -> 1_030 closes it
            start('two', 'gpt-y', detachedChild('inv-9')), // 4  -> 1_040 AFTER the close: a new run
            text('two', 'second answer', detachedChild('inv-9')) // 5  -> 1_050
        ]);

        result.settle('done');

        expect(result.display().sections.map((section) => section.id)).toEqual(['turn-1:0', 'turn-1:1', 'turn-1:2']);
        expect(nodesOf(result, 'turn-1:1')).toEqual([
            { kind: 'text', id: 'n2', text: 'first answer', committed: true, chars: 12 }
        ]);
        // The second row's run never reached a commit frame, so its prose is NOT marked
        // committed: the new run is exactly as unfinished as the journal says it is.
        expect(nodesOf(result, 'turn-1:2')).toEqual([
            { kind: 'text', id: 'n5', text: 'second answer', committed: false, chars: 13 }
        ]);

        // The first row keeps the span of the run that ran, and the second row's clock
        // starts at ITS OWN `start` — this is what stops the impossible durations.
        expect(sectionOf(result, 'turn-1:1')).toMatchObject({ startedAt: 1_010, endedAt: 1_030 });
        expect(sectionOf(result, 'turn-1:2')?.startedAt).toBe(1_040);
    });

    it('merges a start that is not stamped after the frame that closed the row', () => {
        // A journal can hand the fold frames out of order. The boundary reads recorded
        // stamps, never arrival order, so this out-of-order `start` (1_025, i.e. before
        // the `done` that closed the row at 1_030) is the same run and stays on its row.
        const events = [
            start('one', 'gpt-x', ROOT), //                    -> 1_000
            start('two', 'gpt-y', detachedChild('inv-9')), //  -> 1_010
            text('two', 'first answer', detachedChild('inv-9')), // -> 1_020
            done('two', 'gpt-y', 'first answer', detachedChild('inv-9')), // -> 1_030
            start('two', 'gpt-y', detachedChild('inv-9')), //  -> 1_025  out of order
            text('two', 'late frame', detachedChild('inv-9')) // -> 1_035
        ];
        const result = foldWith(events, [1_000, 1_010, 1_020, 1_030, 1_025, 1_035]);

        result.settle('done');

        expect(result.display().sections.map((section) => section.id)).toEqual(['turn-1:0', 'turn-1:1']);
        // The late prose is NOT part of the committed window: the out-of-order `start`
        // opened a fresh request window (./turn-projector.ts `beginAttempt`) and nothing
        // committed it, so the recorded flag stays false.
        expect(nodesOf(result, 'turn-1:1')).toEqual([
            { kind: 'text', id: 'n2', text: 'first answer', committed: true, chars: 12 },
            { kind: 'text', id: 'n5', text: 'late frame', committed: false, chars: 10 }
        ]);
    });

    it('gives a post-restart child the row of its own call, not the dead child row', () => {
        // The other half of the artifact: after the restart a FRESH delegated run is
        // recorded under the invocation id of a child that ran before it died. The dead
        // child's row must not absorb it, and the new row is the one the parent's NEW
        // `tool_call` already opened.
        const result = fold([
            start('one', 'gpt-x', ROOT), // 0
            toolCall('call-1'), // 1  parent's call, pre-restart
            start('two', 'gpt-y', childOf('inv-16', 'call-1')), // 2  -> 1_020 adopts 'turn-1:1'
            reasoning('two', 'pre-restart lane', childOf('inv-16', 'call-1')), // 3  -> 1_030  cut off
            // ---- restart: the conversation resumes under the recycled id, then spawns again
            start('one', 'gpt-x', { id: 'inv-16' }), // 4  -> 1_040 root-shaped, recycled id
            toolCall('call-2'), // 5  -> 1_050 mints 'turn-1:2'
            start('two', 'gpt-y', childOf('inv-16', 'call-2')), // 6  -> 1_060 same id, NEW call
            reasoning('two', 'post-restart lane', childOf('inv-16', 'call-2')) // 7  -> 1_070
        ]);

        result.settle('done');

        expect(result.display().sections.map((section) => section.id)).toEqual(['turn-1:0', 'turn-1:1', 'turn-1:2']);
        expect(nodesOf(result, 'turn-1:1')).toEqual([
            { kind: 'reasoning', id: 'n3', text: 'pre-restart lane', chars: 16 }
        ]);
        expect(nodesOf(result, 'turn-1:2')).toEqual([
            { kind: 'reasoning', id: 'n7', text: 'post-restart lane', chars: 17 }
        ]);

        // Both children still nest under the conversation's card (the parent lookup goes by
        // the parent INVOCATION id, which the boundary re-pointed at the live row), and the
        // resumed run's own frames are on that card, not on either child row.
        expect(sectionOf(result, 'turn-1:1')?.parentSectionId).toBe('turn-1:0');
        expect(sectionOf(result, 'turn-1:2')?.parentSectionId).toBe('turn-1:0');
        expect(nodesOf(result, 'turn-1:0').map((node) => (node as { kind: string }).kind)).toEqual(['tool', 'tool']);

        expect(result.summary()).toMatchObject({ status: 'done', state: 'done' });
    });
});

describe('F6 — the settled status line', () => {
    const RESUME_AFTER_FAILURE: HarnessEvent[] = [
        start('one', 'gpt-x', ROOT), // 0
        failure('one', 'Request failed: HTTP 503'), // 1  the conversation's OWN recorded failure
        start('one', 'gpt-x', ROOT), // 2  the resume
        text('one', 'the complete answer', ROOT), // 3
        commit(), // 4
        done('one', 'gpt-x', 'the complete answer', ROOT) // 5
    ];

    it('names the model that answered once the turn completed', () => {
        const result = fold(RESUME_AFTER_FAILURE);

        result.settle('done');

        const summary = result.summary() as Record<string, unknown>;

        // The user-reported artifact: a provider failure recorded first, then a resume,
        // then the completed answer, printed as a failed turn forever. `done` wins.
        expect(summary.status).toBe('done');
        expect(summary.detail).toBe('gpt-x');

        // The failure is not erased: it stays as the notice on the row it happened on,
        // where the reader can still act on it.
        expect(nodesOf(result, 'turn-1:0')).toEqual([
            { kind: 'notice', id: 'n1', tone: 'error', text: 'Request failed: HTTP 503', at: 1_010 },
            { kind: 'text', id: 'n3', text: 'the complete answer', committed: true, chars: 19 }
        ]);
        expect(sectionOf(result, 'turn-1:0')?.answerNodeId).toBe('n3');
    });

    it('names the conversation own failure when the turn really failed', () => {
        // Rule (2): the ROOT flow's own text outranks a delegated flow's. Both frames
        // exist; the turn ended failed, so the header names the conversation's failure
        // while the child's row keeps its own notice.
        const result = fold([
            start('one', 'gpt-x', ROOT), // 0
            toolCall('call-1'), // 1
            start('two', 'gpt-y', childOf('inv-3', 'call-1')), // 2
            failure('two', 'Upstream stream terminated', childOf('inv-3', 'call-1')), // 3  a lane failure
            failure('one', 'Request failed: HTTP 503') // 4  the conversation's own failure
        ]);

        result.settle('error');

        expect(result.summary()).toMatchObject({ status: 'error', state: 'error', detail: 'Request failed: HTTP 503' });
    });

    it('does not let a lane failure title a turn that completed', () => {
        // The last frame of the live journal was a lane `error` recorded AFTER the main
        // flow's completed answer. A completed turn gets NO error text at all — and no
        // stand-in, because `undefined` means no detail rather than a invented one.
        const result = fold([
            start('one', 'gpt-x', ROOT), // 0
            toolCall('call-1'), // 1
            start('two', 'gpt-y', childOf('inv-3', 'call-1')), // 2
            text('one', 'the complete answer', ROOT), // 3
            commit(), // 4
            done('one', 'gpt-x', 'the complete answer', ROOT), // 5
            failure('two', 'Upstream stream terminated', childOf('inv-3', 'call-1')) // 6  late lane failure
        ]);

        result.settle('done');

        const summary = result.summary() as Record<string, unknown>;

        expect(summary.status).toBe('done');
        expect(summary.detail).toBe('gpt-x');
        // The lane keeps its own row and its own notice.
        expect(nodesOf(result, 'turn-1:1')).toEqual([
            { kind: 'notice', id: 'n6', tone: 'error', text: 'Upstream stream terminated', at: 1_060 }
        ]);
    });

    it('falls back to the only recorded failure when the turn failed and the conversation recorded none', () => {
        const result = fold([
            start('one', 'gpt-x', ROOT), // 0
            toolCall('call-1'), // 1
            start('two', 'gpt-y', childOf('inv-3', 'call-1')), // 2
            failure('two', 'Upstream stream terminated', childOf('inv-3', 'call-1')) // 3
        ]);

        result.settle('error');

        expect(result.summary()).toMatchObject({
            status: 'error',
            state: 'error',
            detail: 'Upstream stream terminated'
        });
    });

    it('shows a lane failure in the body only while the turn is still running', () => {
        const result = fold([
            start('one', 'gpt-x', ROOT), // 0
            toolCall('call-1'), // 1
            start('two', 'gpt-y', childOf('inv-3', 'call-1')), // 2
            failure('two', 'Upstream stream terminated', childOf('inv-3', 'call-1')) // 3
        ]);

        // Still running: the header carries NO text, because the only recorded failure is
        // one lane's business. (No `settle` — the summary is read mid-run.)
        expect('detail' in (result.summary() as Record<string, unknown>)).toBe(false);
    });

    it('keeps the stop text of an interrupted-resume turn', () => {
        // The pin ./turn-projector.test.ts and ./threads.test.ts already hold: a cancelled
        // turn still answers with its own recorded failure text.
        const result = fold([
            start('one', 'gpt-x', ROOT), // 0
            text('one', 'partial answer', ROOT), // 1
            failure('one', 'Request failed: HTTP 503') // 2
        ]);

        result.settle('cancelled');

        expect(result.summary()).toMatchObject({
            status: 'cancelled',
            state: 'cancelled',
            detail: 'Request failed: HTTP 503'
        });
    });

    it('replays the settled status line identically from the record', () => {
        const live = fold(RESUME_AFTER_FAILURE);

        live.settle('done');

        const cold = projectTurn(live.turn, CONTEXT);

        expect(cold.summary).toEqual(live.summary());
        expect(cold.display).toEqual(live.display());
    });
});

// ---------------------------------------------------------------------------
// T-W8 (2026-11-17) — THE RESIDUAL F5 COULD NOT REPORT, AND THE EPOCH CLOSES IT.
//
// F5's own note (./turn-projector.ts, the call-id join in `route`) said the limit out loud:
// a restarted runtime re-mints CALL ids as well as invocation ids, so a post-restart child
// merges into the dead child's row, and the persisted lines settle nothing either way — all
// 160 081 lines of the live store's `events.jsonl` carry only the journal's `thread.id`
// (ids 14..20, reused across the restart) and no `callId` at all.
//
// The runtime now stamps a per-process epoch on every run identity (`HarnessThread.epoch`,
// minted in ../core/agent-limits.ts, stamped at ../harness.ts `run.thread` /
// `threadIdentity` / `branchThreadOf`), and the fold treats a KNOWN epoch that differs as a
// run boundary ahead of every other rule (`isRunBoundary` rule (0)).
//
// The group below is therefore two things at once: the proof the discriminator works, and
// the proof it is INERT for every record written before it — scenarios B, C, E1 and E2 are
// the same frame skeletons as A, and the only thing that moves between them is whether the
// frames name a process.
// ---------------------------------------------------------------------------

// The child of the SAME recorded `delegate` call, from the process named by `epoch`: one id
// (`inv-16`), one spawn call (`call-1`), one shape — the F5 residual, frame for frame.
const childFrom = (epoch?: string) => ({
    ...childOf('inv-16', 'call-1'),
    ...(epoch === undefined ? {} : { epoch })
});

// The turn's own flow from the process named by `epoch`: a HOST-thread conversation records
// its own run ROOT-SHAPED (`{id, input}`, ../harness.ts), so the shape test cannot tell the
// run a turn began with from the run that continues it under a recycled id.
const rootFrom = (epoch?: string) => ({
    id: 'inv-15',
    ...(epoch === undefined ? {} : { epoch })
});

describe('T-W8 — the process epoch separates what the shape and call-id rules cannot', () => {
    // A. THE ACCEPTANCE CASE. Same `thread.id`, same `callId`, different epoch, and the dead
    // row was never even terminal (the pre-restart child was cut off mid-run), so neither F5
    // rule can fire: the shapes agree, and rule (2) refuses to supersede an OPEN row. The
    // epoch is the only fact on the frames that separates them.
    it('gives a post-restart child its own row when it recycles the call id too', () => {
        const result = fold([
            start('one', 'gpt-x', ROOT), // 0  -> 1_000
            toolCall('call-1'), // 1  -> 1_010  mints the placeholder
            start('two', 'gpt-y', childFrom('e1')), // 2  -> 1_020  adopts it as 'turn-1:1'
            reasoning('two', 'pre-restart lane', childFrom('e1')), // 3  -> 1_030  cut off, row OPEN
            // ---- the process dies; the restarted runtime re-mints BOTH counters ----
            start('two', 'gpt-y', childFrom('e2')), // 4  -> 1_040  same id AND same call, new epoch
            reasoning('two', 'post-restart lane', childFrom('e2')) // 5  -> 1_050
        ]);

        result.settle('done');

        // One row per RUN — and per PROCESS, which is the granularity `thread.id` alone could
        // never reach. Without the epoch this fold is scenario B below: TWO rows, the second
        // one holding both runs' prose.
        expect(result.display().sections.map((section) => section.id)).toEqual(['turn-1:0', 'turn-1:1', 'turn-1:2']);

        // Each row holds ONLY its own run's frames: the dead child's thinking block stops at
        // the frame the process death cut off, and the new run opens its own block instead of
        // extending a stranger's (which is what produced the impossible durations and the
        // answer that never reached a card).
        expect(nodesOf(result, 'turn-1:1')).toEqual([
            { kind: 'reasoning', id: 'n3', text: 'pre-restart lane', chars: 16 }
        ]);
        expect(nodesOf(result, 'turn-1:2')).toEqual([
            { kind: 'reasoning', id: 'n5', text: 'post-restart lane', chars: 17 }
        ]);

        // Both children still hang off the SAME recorded `delegate` call on the parent's card
        // (the row identity is the call; the run identity is the epoch), and the split row
        // names the invocation id the runtime actually recorded — recycled, and no longer
        // unique on its own, which is exactly why the epoch is not on the wire with it.
        expect(sectionOf(result, 'turn-1:1')).toMatchObject({ parentSectionId: 'turn-1:0', invocationId: 'inv-16' });
        expect(sectionOf(result, 'turn-1:2')).toMatchObject({ parentSectionId: 'turn-1:0', invocationId: 'inv-16' });

        // T-W23: the spans stay honest, and they stay honest ABOUT THEMSELVES. Each row's clock
        // starts at its OWN `start`; neither run reached a terminal frame, so each ends at ITS OWN
        // last frame (index 3 -> 1_030, index 5 -> 1_050) and reports `cancelled`. The pre-fix fold
        // closed both at the TURN's end stamp (5_000) with `state: 'done'`, which printed a span
        // each killed run never lived and claimed both had finished. The node TEXT is still the
        // byte-for-byte pre-change fold — only the two fields the reader sees as duration/state move.
        expect(sectionOf(result, 'turn-1:1')).toMatchObject({ startedAt: 1_020, endedAt: 1_030, state: 'cancelled' });
        expect(sectionOf(result, 'turn-1:2')).toMatchObject({ startedAt: 1_040, endedAt: 1_050, state: 'cancelled' });

        // The epoch is ROW state. `TurnSection` gained no field, the `section:open` payload
        // gained no key, and the REST display contract is byte-for-byte what it was.
        for (const section of result.display().sections) {
            expect('epoch' in section).toBe(false);
        }

        // live ≡ replay: the cold fold a reload and every view read serve mints the same rows.
        const cold = projectTurn(result.turn, CONTEXT);

        expect(cold.display).toEqual(result.display());
        expect(cold.summary).toEqual(result.summary());
        expect(cold.summary).toMatchObject({ status: 'done', state: 'done', sectionCount: 3 });
    });

    // B. THE SAME JOURNAL WITHOUT EPOCHS — what every store written before 2026-11-17 holds.
    // These are the EXACT rows this file pinned before the epoch existed (the merged prose
    // block, `chars: 33`, the second row's span starting at the first run's `start`), so this
    // is the backward-compatibility pin, not a restatement of scenario A.
    it('folds a record with no epoch exactly as it did before the epoch existed', () => {
        const result = fold([
            start('one', 'gpt-x', ROOT), // 0
            toolCall('call-1'), // 1
            start('two', 'gpt-y', childFrom()), // 2  -> 1_020
            reasoning('two', 'pre-restart lane', childFrom()), // 3  -> 1_030
            start('two', 'gpt-y', childFrom()), // 4  -> 1_040  same id, same call, no epoch
            reasoning('two', 'post-restart lane', childFrom()) // 5  -> 1_050
        ]);

        result.settle('done');

        expect(result.display().sections.map((section) => section.id)).toEqual(['turn-1:0', 'turn-1:1']);
        // ONE block, both runs' text inside it: the pre-change fold, character for character.
        expect(nodesOf(result, 'turn-1:1')).toEqual([
            { kind: 'reasoning', id: 'n3', text: 'pre-restart lanepost-restart lane', chars: 33 }
        ]);
        // The epoch rule keeps ONE block with both runs' text — that is the byte-for-byte legacy
        // fold. T-W23 changes only how the row reports itself once the turn closes without a
        // terminal frame: its own last frame (index 5 -> 1_050) as the end, `cancelled` as the
        // state. Epoch-less records therefore stay epoch-less: no key added, no wire shape change.
        expect(sectionOf(result, 'turn-1:1')).toMatchObject({ startedAt: 1_020, endedAt: 1_050, state: 'cancelled' });
        expect(result.summary()).toMatchObject({ status: 'done', state: 'done', sectionCount: 2 });

        const cold = projectTurn(result.turn, CONTEXT);

        expect(cold.display).toEqual(result.display());
        expect(cold.summary).toEqual(result.summary());
    });

    // C. AN EPOCH THAT AGREES IS INERT. Two runs of one process keep merging exactly as F5
    // decided (the retry ladder re-sends frames, a re-`start` of an open row is a
    // continuation); the discriminator never splits what one process minted.
    it('leaves the rows of one process untouched when both runs name the same epoch', () => {
        const result = fold([
            start('one', 'gpt-x', ROOT), // 0
            toolCall('call-1'), // 1
            start('two', 'gpt-y', childFrom('e1')), // 2
            reasoning('two', 'pre-restart lane', childFrom('e1')), // 3
            start('two', 'gpt-y', childFrom('e1')), // 4  same id, same call, SAME epoch
            reasoning('two', 'post-restart lane', childFrom('e1')) // 5
        ]);

        result.settle('done');

        expect(result.display().sections.map((section) => section.id)).toEqual(['turn-1:0', 'turn-1:1']);
        expect(nodesOf(result, 'turn-1:1')).toEqual([
            { kind: 'reasoning', id: 'n3', text: 'pre-restart lanepost-restart lane', chars: 33 }
        ]);
    });

    // D. THE F5 ARTIFACT ITSELF, EPOCH-STAMPED. The resumed conversation is ROOT-SHAPED and
    // comes from a different process than the child it follows, and rule (0) fires on its very
    // first frame — yet the fold still lands on the conversation's OWN card, because a
    // root-shaped frame is routed to the root row whichever way the boundary answers. The rows
    // are byte-identical to the epoch-less record above: an epoch may split runs, it may never
    // move the turn's own answer off its card.
    it('keeps the resumed conversation on its own card when its frames name a new epoch', () => {
        const result = fold([
            start('one', 'gpt-x', ROOT), // 0  -> 1_000
            reasoning('one', 'planning the run', ROOT), // 1  -> 1_010
            toolCall('call-1'), // 2  -> 1_020
            start('two', 'gpt-y', { ...childOf('inv-15', 'call-1'), epoch: 'e1' }), // 3  -> 1_030
            reasoning('two', 'reading the tool source', {
                id: 'inv-15',
                parentId: 'inv-root',
                callId: 'call-1',
                epoch: 'e1'
            }), // 4 -> 1_040
            // ---- restart: the conversation resumes under the dead child's id, new epoch ----
            start('one', 'gpt-x', rootFrom('e2')), // 5  -> 1_050
            reasoning('one', 'the review is in', rootFrom('e2')), // 6  -> 1_060
            text('one', 'the complete answer', rootFrom('e2')), // 7  -> 1_070
            commit(), // 8  -> 1_080
            done('one', 'gpt-x', 'the complete answer', rootFrom('e2')) // 9  -> 1_090
        ]);

        result.settle('done');

        expect(result.display().sections.map((section) => section.id)).toEqual(['turn-1:0', 'turn-1:1']);
        expect(nodesOf(result, 'turn-1:0')).toEqual([
            { kind: 'reasoning', id: 'n1', text: 'planning the run', chars: 16 },
            expect.objectContaining({ kind: 'tool', id: '2', callId: 'call-1', state: 'error' }),
            { kind: 'reasoning', id: 'n6', text: 'the review is in', chars: 16 },
            { kind: 'text', id: 'n7', text: 'the complete answer', committed: true, chars: 19 }
        ]);
        expect(nodesOf(result, 'turn-1:1')).toEqual([
            { kind: 'reasoning', id: 'n4', text: 'reading the tool source', chars: 23 }
        ]);
        expect(sectionOf(result, 'turn-1:0')?.answerNodeId).toBe('n7');
        expect(result.summary()).toMatchObject({ status: 'done', state: 'done', detail: 'gpt-x' });

        // The same journal with NO epochs (the record this file pinned at the top, and the
        // only shape a pre-change store holds) mints the identical tree and the identical
        // summary: the epoch changed nothing for a record that does not carry one.
        const legacy = fold([
            start('one', 'gpt-x', ROOT),
            reasoning('one', 'planning the run', ROOT),
            toolCall('call-1'),
            start('two', 'gpt-y', childOf('inv-15', 'call-1')),
            reasoning('two', 'reading the tool source', { id: 'inv-15', parentId: 'inv-root', callId: 'call-1' }),
            start('one', 'gpt-x', rootFrom()),
            reasoning('one', 'the review is in', rootFrom()),
            text('one', 'the complete answer', rootFrom()),
            commit(),
            done('one', 'gpt-x', 'the complete answer', rootFrom())
        ]);

        legacy.settle('done');

        expect(legacy.display()).toEqual(result.display());
        expect(legacy.summary()).toEqual(result.summary());
    });

    // E. AN ABSENT EPOCH DECIDES NOTHING, in either direction. A row minted by an
    // epoch-bearing frame followed by epoch-less ones, and the mirror image, both keep the
    // pre-change merge — a hand-written or partially-upgraded reporter must never be split
    // into rows it cannot justify (../types/index.ts: an absent field means "the producer said
    // nothing", never "a different run").
    it('never splits a row on an epoch one side does not carry', () => {
        const knownRowThenLegacyFrames = fold([
            start('one', 'gpt-x', ROOT),
            toolCall('call-1'),
            start('two', 'gpt-y', childFrom('e1')), //    the row names a process…
            reasoning('two', 'pre-restart lane', childFrom('e1')),
            start('two', 'gpt-y', childFrom()), //        …this frame names none
            reasoning('two', 'post-restart lane', childFrom())
        ]);

        knownRowThenLegacyFrames.settle('done');

        expect(knownRowThenLegacyFrames.display().sections.map((section) => section.id)).toEqual([
            'turn-1:0',
            'turn-1:1'
        ]);
        expect(nodesOf(knownRowThenLegacyFrames, 'turn-1:1')).toEqual([
            { kind: 'reasoning', id: 'n3', text: 'pre-restart lanepost-restart lane', chars: 33 }
        ]);

        const legacyRowThenEpochFrames = fold([
            start('one', 'gpt-x', ROOT),
            toolCall('call-1'),
            start('two', 'gpt-y', childFrom()), //        the row names no process…
            reasoning('two', 'pre-restart lane', childFrom()),
            start('two', 'gpt-y', childFrom('e2')), //    …this frame names one
            reasoning('two', 'post-restart lane', childFrom('e2'))
        ]);

        legacyRowThenEpochFrames.settle('done');

        expect(legacyRowThenEpochFrames.display().sections.map((section) => section.id)).toEqual([
            'turn-1:0',
            'turn-1:1'
        ]);
        expect(nodesOf(legacyRowThenEpochFrames, 'turn-1:1')).toEqual([
            { kind: 'reasoning', id: 'n3', text: 'pre-restart lanepost-restart lane', chars: 33 }
        ]);
    });
});

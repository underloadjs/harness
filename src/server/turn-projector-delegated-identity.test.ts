// F3/S1 (2026-11-25) — A DELEGATION LEAVES EXACTLY ONE ROW, AND THAT ROW ANSWERS TO A RUN.
//
// THE DEFECT THE OPERATOR SCREENSHOTS. A `delegate` CALL mints a placeholder row the moment the
// parent's `tool_call` is recorded, and the child's own frames are supposed to ADOPT it. When they
// do not, the row survives as a card with `agentLabel: ''`, no `invocationId`, no `threadId`, no
// `startedAt`, no nodes and no context blocks — the "delegated task" line with no id chip and no
// metrics. Measured on the user's own recorded session (read-only dump at
// …/temporary/dump/harness/sessions/e513eed7-7c44-487f-a60c-18f69d9fca68/): 5 of the 32 rows of
// turn `caaa372e-c489-4be0-947d-defebb1c9441` are exactly that shape (`:1 :4 :16 :26 :28` of
// Temp/fix-f3/replay.out, re-measured green in Temp/fix-f3/replay-after.out).
//
// THE THREE SERVER RULES UNDER TEST (./turn-projector.ts):
//   1. `queuedPlaceholder(agent, callId?)` keys the lookup on the spawn CALL FIRST. A delegated
//      frame carries `thread.callId` (../engine/harness.ts stamps it with the id of the `delegate`
//      call that requested the run), so two same-agent delegations in flight at once adopt the row
//      each call opened, instead of both piling onto the oldest queued row (cases A/B).
//   2. `route` adopts for a CHILD-SHAPED frame that names a parent but no call id (`else if
//      (!isConversationRoot(meta))`). Without that door the frame minted a SECOND row beside the
//      placeholder, which is the pair this defect is (case B, and the guard case in E).
//   3. `isUnrunPlaceholder(record)` is the store's exactness test for "this row is a `delegate`
//      call, it was never adopted by one frame of the run it requested, and it holds nothing of its
//      own". The spawning call's `tool_result` is the LAST evidence that could arrive for such a
//      row, so a clean return (`completed`, or a legacy result with no `outcome` and no error)
//      REMOVES it (case C) and the end-of-turn sweep still removes one the turn closed without any
//      result at all (case E). A CONTROL outcome (`cancelled`/`failed`/`rejected`) is not a clean
//      return: it is a state the parent's card does not repeat on the child, so the row stays and
//      answers for it (case D; the cancelled case is pinned in ./turn-projector.test.ts:634-643).
//
// WHAT IS DELIBERATELY NOT DONE, and why the assertions below refuse it:
//   - NO FABRICATED CLOCK. A row that never ran keeps `startedAt` absent (case D asserts
//     `startedAt: undefined`); the row's clock starts at the frame that adopts or starts it
//     (`adoptPlaceholder` / the FIFO `start` door), never at the parent's call stamp.
//   - NO REMOVAL OF A ROW THAT RAN AND SAID LITTLE. A child whose whole life is one reasoning delta
//     (case F) and one that emitted only its `start` frame (case G — invocation 83 of the recorded
//     run) keep their rows, nodes and context blocks byte-for-byte. Emptiness in those rows is a
//     fact about the run, not a broken render, and `settle` must not eat it (the no-frame-loss rule
//     at the top of ./turn-projector.ts).
//   - NOTHING IS MOVED OFF THE PARENT ROW. Every case asserts the parent's own `delegate` card
//     whole — its args, its result, its state and its span — because that step is the copy the
//     reader acts on once the child's anonymous row is gone.
//
// LIVE ≡ REPLAY: every journal folds through the LIVE path (`createTurnProjector` + one `apply()`
// per event + `settle()`, the store recorder's own order in ./sessions.ts) and the COLD path
// (`projectTurn`, what a reload and every view read serve) is asserted to answer identically. The
// rules read only recorded frames and stamps — no `Date.now()`, no live-only state.
//
// Run: yarn vitest run src/server/turn-projector-delegated-identity.test.ts   (cwd packages/underload/harness)

import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '../engine/harness';
import type { DisplayProjectContext, TurnDisplayOp, TurnRecordStatus, TurnSection } from '../engine/shared/turn-display';
import type { SessionTurn } from './protocol';
import { createTurnProjector, projectTurn } from './turn-projector';

const turnOf = (): SessionTurn => ({
    id: 'turn-1',
    index: 0,
    prompt: 'do the thing',
    status: 'running',
    startedAt: 1_000,
    updatedAt: 1_000,
    events: [],
    eventTimes: []
});

const CONTEXT: DisplayProjectContext = { entry: 'one', ranks: { one: 'A', two: 'B' } };

// One recorded event per 10 ms, exactly as ./turn-projector-abandoned-card.test.ts does it, so
// every stamp asserted below is an event index the reader can count.
const timeOf = (index: number): number => 1_000 + index * 10;

// The turn's end stamp, well past the last frame of any journal below.
const SETTLE_AT = 5_000;

type Folded = {
    turn: SessionTurn;
    ops: TurnDisplayOp[][];
    display: () => ReturnType<ReturnType<typeof createTurnProjector>['display']>;
    summary: () => ReturnType<ReturnType<typeof createTurnProjector>['summary']>;
    settle: (status: TurnRecordStatus) => TurnDisplayOp[];
};

// The LIVE path: push the record, then fold it — the store recorder's own order (./sessions.ts).
const fold = (events: HarnessEvent[]): Folded => {
    const turn = turnOf();
    const projector = createTurnProjector(turn, CONTEXT);
    const ops: TurnDisplayOp[][] = [];

    events.forEach((event, index) => {
        turn.events.push(event);
        turn.eventTimes?.push(timeOf(index));
        ops.push(projector.apply(event, timeOf(index), index));
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

// The identity half of a row, asserted as ONE object: a row that gained or lost any of these
// fields shows up as a diff, not as a count that happens to match.
const identityOf = (section: TurnSection): unknown => ({
    id: section.id,
    parentSectionId: section.parentSectionId,
    rank: section.rank,
    agent: section.agent,
    agentLabel: section.agentLabel,
    invocationId: section.invocationId,
    threadId: section.threadId,
    state: section.state,
    startedAt: section.startedAt,
    endedAt: section.endedAt,
    nodeCount: section.nodes.length,
    contextCount: section.context?.length ?? 0
});

const rowsOf = (result: Folded): TurnSection[] => result.display().sections;

const rowById = (result: Folded, id: string): TurnSection => {
    const section = result.display().sections.find((entry) => entry.id === id);

    if (section === undefined) throw new Error(`no section ${id} in ${result.display().sections.map((entry) => entry.id).join(', ')}`);

    return section;
};

// Every op that names a section, in the order the wire carried them. `section:open` carries the
// whole section (no `sectionId`), so both shapes are matched.
const opsFor = (result: Folded, sectionId: string): TurnDisplayOp[] =>
    result.ops.flat().filter((op) => {
        const carried = op as { sectionId?: string; section?: { id?: string } };

        return (carried.sectionId ?? carried.section?.id) === sectionId;
    });

const removedIds = (ops: TurnDisplayOp[]): string[] =>
    ops.filter((op): op is Extract<TurnDisplayOp, { op: 'section:remove' }> => op.op === 'section:remove').map((op) => op.sectionId);

const allOps = (result: Folded, settleOps: TurnDisplayOp[] = []): TurnDisplayOp[] => [...result.ops.flat(), ...settleOps];

// The parent's `delegate` CARD — the step that survives every case below. Narrowed to the fields a
// reader reads off the card, asserted whole.
const delegateCardOf = (result: Folded, cardId: string): unknown => {
    const node = (rowById(result, 'turn-1:0').nodes as unknown as Record<string, unknown>[]).find((entry) => entry.id === cardId);

    if (node === undefined) throw new Error(`no card ${cardId} on the root row`);

    return {
        id: node.id,
        name: node.name,
        state: node.state,
        outcome: node.outcome,
        startedAt: node.startedAt,
        endedAt: node.endedAt,
        durationMs: node.durationMs,
        preview: node.preview,
        argsPreview: node.argsPreview,
        detail: node.detail
    };
};

// ---------------------------------------------------------------------------
// Frame builders (the shapes ./turn-projector-abandoned-card.test.ts records)
// ---------------------------------------------------------------------------

// The turn's own conversation flow: one id, no parent, no spawn call.
const ROOT = { id: 'inv-root' } as const;

// A delegated flow: it names its parent invocation and (optionally) the spawning call, which is
// how `route` finds the row the parent's `tool_call` already opened.
const childOf = (id: string, callId?: string): HarnessEvent['thread'] => ({
    id,
    parentId: 'inv-root',
    ...(callId === undefined ? {} : { callId }),
    kind: 'delegation',
    input: 'sub task'
});

const start = (agent: string, thread?: HarnessEvent['thread']): HarnessEvent => ({
    type: 'start',
    agent,
    model: 'gpt-x',
    ...(thread === undefined ? {} : { thread })
});

const text = (agent: string, delta: string, thread?: HarnessEvent['thread']): HarnessEvent => ({
    type: 'text',
    agent,
    delta,
    ...(thread === undefined ? {} : { thread })
});

const reasoning = (agent: string, delta: string, thread?: HarnessEvent['thread']): HarnessEvent => ({
    type: 'reasoning',
    agent,
    delta,
    ...(thread === undefined ? {} : { thread })
});

const done = (agent: string, content: string, thread?: HarnessEvent['thread']): HarnessEvent => ({
    type: 'done',
    agent,
    message: { role: 'assistant', content, reasoning: '', toolCalls: [], model: 'gpt-x', stopReason: 'stop' },
    ...(thread === undefined ? {} : { thread })
});

// The spawning call: its arguments mint the child PLACEHOLDER row.
const delegateCall = (callId: string): HarnessEvent => ({
    type: 'tool_call',
    agent: 'one',
    call: { id: callId, name: 'delegate', arguments: JSON.stringify({ agent: 'two', input: 'sub task' }) }
});

// The call returning. `outcome` is what decides an un-run placeholder's fate (rule 3).
const toolResult = (
    callId: string,
    outcome: 'completed' | 'failed' | 'cancelled',
    extra: Partial<Extract<HarnessEvent, { type: 'tool_result' }>> = {}
): HarnessEvent => ({
    type: 'tool_result',
    agent: 'one',
    name: 'delegate',
    content: 'the child answered',
    callId,
    isError: outcome === 'failed',
    outcome,
    durationMs: 12,
    ...extra
});

// The two same-agent children of one root, each naming the call that spawned it.
const TWO_CALL_CHILDREN: HarnessEvent[] = [
    start('one', ROOT),
    delegateCall('call-a'),
    delegateCall('call-b'),
    start('two', childOf('inv-a', 'call-a')),
    text('two', 'alpha', childOf('inv-a', 'call-a')),
    done('two', 'answer a', childOf('inv-a', 'call-a')),
    start('two', childOf('inv-b', 'call-b')),
    text('two', 'beta', childOf('inv-b', 'call-b')),
    done('two', 'answer b', childOf('inv-b', 'call-b')),
    toolResult('call-a', 'completed', { durationMs: 40 }),
    toolResult('call-b', 'completed', { durationMs: 50 })
];

describe('one delegated run claims the row its spawning call opened', () => {
    it('gives two simultaneous same-agent delegations two distinct rows, each with its own run id and clock', () => {
        const result = fold(TWO_CALL_CHILDREN);
        const settleOps = result.settle('done');

        // Exactly three rows: the root, and one per delegation. The pre-fix fold left the
        // SECOND child on the oldest queued row and orphaned a contentless placeholder beside it.
        expect(rowsOf(result).map((section) => section.id)).toEqual(['turn-1:0', 'turn-1:1', 'turn-1:2']);

        expect(identityOf(rowById(result, 'turn-1:1'))).toEqual({
            id: 'turn-1:1',
            parentSectionId: 'turn-1:0',
            rank: 'B',
            agent: 'two',
            agentLabel: '',
            invocationId: 'inv-a',
            threadId: undefined,
            state: 'done',
            startedAt: 1_030,
            endedAt: 1_050,
            nodeCount: 1,
            contextCount: 1
        });

        expect(identityOf(rowById(result, 'turn-1:2'))).toEqual({
            id: 'turn-1:2',
            parentSectionId: 'turn-1:0',
            rank: 'B',
            agent: 'two',
            agentLabel: '',
            invocationId: 'inv-b',
            threadId: undefined,
            state: 'done',
            startedAt: 1_060,
            endedAt: 1_080,
            nodeCount: 1,
            contextCount: 1
        });

        // No row of this turn is retired: both placeholders became real rows.
        expect(removedIds(allOps(result, settleOps))).toEqual([]);
        expect(result.summary().sectionCount).toBe(3);

        // LIVE ≡ REPLAY, asserted on the whole compiled tree.
        expect(projectTurn(result.turn, CONTEXT).display.sections).toEqual(result.display().sections);
    });

    it('adopts the same two children by spawning order when their frames name no call id at all', () => {
        // The legacy/thin-producer plane: `thread.parentId` is set, `thread.callId` is not, so the
        // call-first lookup has nothing to match and `route` falls to the order scan. Children
        // start after the calls that spawned them and in call order, which makes the scan exact.
        const result = fold([
            start('one', ROOT),
            delegateCall('call-a'),
            delegateCall('call-b'),
            start('two', childOf('inv-a')),
            text('two', 'alpha', childOf('inv-a')),
            done('two', 'answer a', childOf('inv-a')),
            start('two', childOf('inv-b')),
            text('two', 'beta', childOf('inv-b')),
            done('two', 'answer b', childOf('inv-b')),
            toolResult('call-a', 'completed', { durationMs: 40 }),
            toolResult('call-b', 'completed', { durationMs: 50 })
        ]);
        const settleOps = result.settle('done');

        expect(rowsOf(result).map((section) => section.id)).toEqual(['turn-1:0', 'turn-1:1', 'turn-1:2']);
        expect(identityOf(rowById(result, 'turn-1:1'))).toEqual({
            id: 'turn-1:1',
            parentSectionId: 'turn-1:0',
            rank: 'B',
            agent: 'two',
            agentLabel: '',
            invocationId: 'inv-a',
            threadId: undefined,
            state: 'done',
            startedAt: 1_030,
            endedAt: 1_050,
            nodeCount: 1,
            contextCount: 1
        });
        expect(identityOf(rowById(result, 'turn-1:2'))).toEqual({
            id: 'turn-1:2',
            parentSectionId: 'turn-1:0',
            rank: 'B',
            agent: 'two',
            agentLabel: '',
            invocationId: 'inv-b',
            threadId: undefined,
            state: 'done',
            startedAt: 1_060,
            endedAt: 1_080,
            nodeCount: 1,
            contextCount: 1
        });
        expect(removedIds(allOps(result, settleOps))).toEqual([]);
        expect(result.summary().sectionCount).toBe(3);
    });
});

describe('a delegation that never ran is retired by the frame that proves it', () => {
    it('removes the placeholder the moment the spawning call returns clean, and loses nothing', () => {
        const result = fold([start('one', ROOT), delegateCall('call-1'), toolResult('call-1', 'completed', { durationMs: 7 })]);

        // The wire for that row is EXACTLY an open and a remove: the row was opened by the call,
        // and the call's result is the frame that proves no run ever answered it.
        expect(opsFor(result, 'turn-1:1')).toEqual([
            {
                op: 'section:open',
                turnId: 'turn-1',
                section: {
                    id: 'turn-1:1',
                    parentSectionId: 'turn-1:0',
                    rank: 'B',
                    agent: 'two',
                    agentLabel: '',
                    nodes: [],
                    context: [],
                    state: 'open'
                }
            },
            { op: 'section:remove', turnId: 'turn-1', sectionId: 'turn-1:1' }
        ]);

        // The tree the operator reads is the root row alone.
        expect(rowsOf(result).map((section) => section.id)).toEqual(['turn-1:0']);
        expect(result.summary().sectionCount).toBe(1);

        // The parent's card carries the whole event: args, result, state and span, byte-exact.
        expect(delegateCardOf(result, '1')).toEqual({
            id: '1',
            name: 'delegate',
            state: 'ok',
            outcome: 'completed',
            startedAt: 1_010,
            endedAt: 1_020,
            durationMs: 7,
            preview: 'the child answered',
            argsPreview: '{"agent":"two","input":"sub task"}',
            detail: { stepId: '1', hasResult: true, truncated: false, resultStepId: '2' }
        });

        // `settle` has nothing left to say about a row that is already gone.
        const settleOps = result.settle('done');

        expect(removedIds(settleOps)).toEqual([]);
        expect(projectTurn(result.turn, CONTEXT).display.sections).toEqual(result.display().sections);
    });

    it('keeps the row when the spawning call came back a control outcome, and never invents a start stamp', () => {
        const result = fold([start('one', ROOT), delegateCall('call-1'), toolResult('call-1', 'failed', { durationMs: 7 })]);

        expect(rowsOf(result).map((section) => section.id)).toEqual(['turn-1:0', 'turn-1:1']);

        const row = rowById(result, 'turn-1:1');

        expect(identityOf(row)).toEqual({
            id: 'turn-1:1',
            parentSectionId: 'turn-1:0',
            rank: 'B',
            agent: 'two',
            agentLabel: '',
            invocationId: undefined,
            threadId: undefined,
            state: 'error',
            startedAt: undefined,
            endedAt: 1_020,
            nodeCount: 0,
            contextCount: 0
        });

        // The honest-empty row is NOT given a fabricated clock: it never started.
        expect(row.startedAt).toBeUndefined();

        expect(delegateCardOf(result, '1')).toEqual({
            id: '1',
            name: 'delegate',
            state: 'error',
            outcome: 'failed',
            startedAt: 1_010,
            endedAt: 1_020,
            durationMs: 7,
            preview: 'the child answered',
            argsPreview: '{"agent":"two","input":"sub task"}',
            detail: { stepId: '1', hasResult: true, truncated: false, resultStepId: '2' }
        });
    });

    it('retires a placeholder the turn closed without any result at all, keeping the abandoned card', () => {
        const result = fold([start('one', ROOT), delegateCall('call-1'), text('one', 'the answer')]);
        const settleOps = result.settle('done');

        expect(removedIds(settleOps)).toEqual(['turn-1:1']);
        expect(rowsOf(result).map((section) => section.id)).toEqual(['turn-1:0']);
        expect(result.summary().sectionCount).toBe(1);

        // The abandoned CALL stays visible on the parent row with the server's own caption.
        expect(delegateCardOf(result, '1')).toEqual({
            id: '1',
            name: 'delegate',
            state: 'error',
            outcome: undefined,
            startedAt: 1_010,
            endedAt: 1_010,
            durationMs: undefined,
            preview: 'the turn ended before this call returned',
            argsPreview: '{"agent":"two","input":"sub task"}',
            detail: { stepId: '1', hasResult: false, truncated: false }
        });

        expect(projectTurn(result.turn, CONTEXT).display.sections).toEqual(result.display().sections);
    });
});

describe('a child that ran stays on the tree however little it recorded', () => {
    it('keeps a reasoning-only child with its node, its context block and its span', () => {
        const result = fold([
            start('one', ROOT),
            delegateCall('call-1'),
            start('two', childOf('inv-a', 'call-1')),
            reasoning('two', 'thinking only', childOf('inv-a', 'call-1')),
            done('two', '', childOf('inv-a', 'call-1')),
            toolResult('call-1', 'completed', { durationMs: 12 })
        ]);
        const settleOps = result.settle('done');

        expect(removedIds(allOps(result, settleOps))).toEqual([]);
        expect(rowById(result, 'turn-1:1')).toEqual({
            id: 'turn-1:1',
            parentSectionId: 'turn-1:0',
            rank: 'B',
            agent: 'two',
            agentLabel: '',
            nodes: [{ kind: 'reasoning', id: 'n3', text: 'thinking only', chars: 13 }],
            context: [
                {
                    kind: 'reasoning',
                    id: '1-reasoning-3',
                    turnId: 'turn-1',
                    sectionId: 'turn-1:1',
                    name: 'reasoning',
                    at: 1_030,
                    chars: 13,
                    inPrompt: false,
                    eventFrom: 3,
                    eventTo: 3
                }
            ],
            state: 'done',
            invocationId: 'inv-a',
            startedAt: 1_020,
            model: 'gpt-x',
            tail: { kind: 'reasoning', nodeId: 'n3', blockId: '1-reasoning-3', chars: 13, truncated: false },
            endedAt: 1_040
        });
    });

    it('keeps a child whose whole journal is its start frame, at exactly the frames it recorded', () => {
        // The shape of invocation 83 of the recorded run: one `start`, then the parent's result.
        const result = fold([
            start('one', ROOT),
            delegateCall('call-1'),
            start('two', childOf('inv-a', 'call-1')),
            toolResult('call-1', 'completed', { durationMs: 2 })
        ]);
        const settleOps = result.settle('done');

        expect(removedIds(allOps(result, settleOps))).toEqual([]);
        expect(rowById(result, 'turn-1:1')).toEqual({
            id: 'turn-1:1',
            parentSectionId: 'turn-1:0',
            rank: 'B',
            agent: 'two',
            agentLabel: '',
            nodes: [],
            context: [],
            state: 'done',
            invocationId: 'inv-a',
            startedAt: 1_020,
            model: 'gpt-x',
            endedAt: 1_030
        });

        expect(result.summary().sectionCount).toBe(2);
        expect(projectTurn(result.turn, CONTEXT).display.sections).toEqual(result.display().sections);
    });
});

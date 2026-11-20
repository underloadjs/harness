// T-W24 — a CALL CARD the turn closed without its own terminal event ends at the CARD's OWN last
// recorded activity stamp, not at the turn's end stamp.
//
// THE DEFECT, and the half of T-W23 this closes (measured on the user's own recorded run,
// Temp/orch-plan/w23/before.txt + Temp/orch-plan/w24/before.txt): T-W23 gave every force-closed
// SECTION ROW its own last activity (rows `:1/:2/:3` went from `3,844,6xx ms / done` to
// `185,9xx ms / cancelled`), but the CARDS inside those rows were still force-closed with the
// TURN's end stamp — root row `:0` printed 3 abandoned call cards (widest 3,844,657 ms / 64m04s) and
// row `:3` printed 2 more (widest 3,658,721 ms / 60m58s). So the row said `3m05s` while a card inside
// it said `64m04s`. The figure the card prints IS this field: the compiled card resolves with
// `step.durationMs ?? elapsedBetween(step.startedAt, step.endedAt)` (../frontend/ui/turns.ts:8246,
// mirrored at ../frontend/view-context.ts:1114), and an abandoned call has no `durationMs` because
// `settle` refuses to invent one — so `endedAt` alone is the span the reader sees.
//
// THE RULE under test (./turn-projector.ts `abandonedEndedAtOf`, applied in the `settle` step pass):
// a card that received its OWN terminal event is never reached (both settle-exempt writers,
// `tool_result` :2863 and `action_answer` :3302, are pinned unchanged below); every card `settle`
// does reach ends at the last frame that ever wrote to it — the stamp of the frame that MINTED it,
// which is provably the only frame a still-`running` card was ever written by, and is the card-plane
// figure of the same per-frame `stamp` `record.lastStamp` is built from (:3436). No stamp at all (a
// record with no `eventTimes`, `DISPLAY_NO_TIMESTAMP`) keeps the settle stamp, so a legacy record
// folds byte-identically. The span can never go negative: the recorded start is the floor, exactly
// as in the row rule `interruptedEndedAtOf`.
//
// WHAT IS DELIBERATELY UNTOUCHED:
//   - the card's STATE and PREVIEW. `abandonedStateOf` calls this a call that failed to return, and
//     the record agrees (it holds no result frame for it at all). The complaint is the duration, so
//     the duration is the only field moved — every face below pins state/preview/detail whole.
//   - the SECTION row rule from T-W23 (./turn-projector-settle-interrupted.test.ts owns that), the
//     root row (still the turn's own end), and the turn-level summary.
//   - the CONTEXT-BAR segment of the same call (`ContextBlock.endedAt`), which THIS change (T-W24)
//     left alone as a different plane with its own pin (./turn-projector.test.ts "settles a segment
//     an abandoned call leaves behind"). T-W25 has since CLOSED that plane, so the sentence this
//     note used to carry ("it still reports the turn's close") is no longer true: the segment now
//     ends at the SAME one computation the card above it uses — `abandonedEndedAtOf` is reused, not
//     duplicated, at ./turn-projector.ts:3686-3694 — so the card and its segment can no longer print
//     two different spans. That plane is owned by ./turn-projector-abandoned-segment.test.ts, and
//     the shared pin ./turn-projector.test.ts:1706 was moved deliberately (its `endedAt` went from
//     the settle stamp `5_000` to the call's own `1_010`) with its own note explaining the move.
//     Nothing below changes because of it: every card face asserted here is byte-exact either way.
//
// LIVE ≡ REPLAY: every journal below folds through the LIVE path (`createTurnProjector` + one
// `apply()` per event + `settle()`, the store's order in ./sessions.ts `projectorFor`) and is asserted
// a second time through the COLD path (`projectTurn`, what a reload and every view read serve). The
// rule reads only recorded stamps — no `Date.now()`, no live-only state — so a reload shows the same
// board (the invariant at the top of ./turn-projector.ts).
//
// THE REAL ARTIFACT this is modelled on: Temp/orch-plan/events.jsonl, turn
// 319cfc1c-6ab5-4d2e-aed3-383806fe4d36 — a 1,141,922 ms process death at frame index 17,476; three
// never-returned `delegate` calls in the root row (cards 2262/2264/2266) and two never-returned
// `shell`/`glob` calls in the row that died (cards 17473/17474). Their before/after spans are in
// Temp/orch-plan/w24/{before,after}.txt, produced by Temp/orch-plan/w24/fold.ts.
//
// Run: yarn vitest run src/server/turn-projector-abandoned-card.test.ts   (cwd packages/underload/harness)

import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '../harness';
import type { DisplayProjectContext, TurnDisplayOp, TurnRecordStatus, TurnSection } from '../shared/turn-display';
import type { SessionTurn } from './protocol';
import { createTurnProjector, DISPLAY_NO_TIMESTAMP, formatDuration, projectTurn } from './turn-projector';

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

// One recorded event per 10 ms, exactly as ./turn-projector-restart.test.ts does it, so every span
// and every boundary stamp below is an event index the reader can count.
const timeOf = (index: number): number => 1_000 + index * 10;

// The turn's end stamp — 4 seconds after the last recorded frame of either flow. Pre-fix, EVERY
// abandoned card printed a span to this figure; that is the value the assertions below refuse.
const SETTLE_AT = 5_000;

type Folded = {
    turn: SessionTurn;
    ops: TurnDisplayOp[][];
    display: () => ReturnType<ReturnType<typeof createTurnProjector>['display']>;
    summary: () => ReturnType<ReturnType<typeof createTurnProjector>['summary']>;
    settle: (status: TurnRecordStatus) => TurnDisplayOp[];
};

// The LIVE path: push the record, then fold it — the store recorder's own order (./sessions.ts).
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

const nodesOf = (result: Folded, id: string): unknown[] => sectionOf(result, id)?.nodes ?? [];

// The whole card, asserted as ONE object: a card that moved any field other than `endedAt` shows up
// as a diff instead of a count that happens to match.
const cardOf = (result: Folded, id: string, cardId: string): unknown =>
    (nodesOf(result, id) as Record<string, unknown>[]).find((node) => node.id === cardId);

// The card patches `settle` put on the wire, narrowed to the three fields this change owns.
const settledCardPatches = (ops: TurnDisplayOp[]): unknown[] =>
    ops
        .filter((op): op is Extract<TurnDisplayOp, { op: 'step:set' }> => op.op === 'step:set')
        .map((op) => ({ sectionId: op.sectionId, id: op.step.id, state: op.step.state, endedAt: op.step.endedAt }));

// ---------------------------------------------------------------------------
// Frame builders (same shapes as ./turn-projector-restart.test.ts)
// ---------------------------------------------------------------------------

// The turn's own conversation flow: one id, no parent, no spawn call, no kind, no branch.
const ROOT = { id: 'inv-root' };

// A delegated flow: it names its parent invocation AND the spawning call, which is how `route` finds
// the row the parent's `tool_call` already opened.
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

// A delegation call: its arguments mint the child PLACEHOLDER row, and the card under test is the
// parent's own node (recorded run: cards 2262/2264/2266).
const delegateCall = (callId: string): HarnessEvent => ({
    type: 'tool_call',
    agent: 'one',
    call: { id: callId, name: 'delegate', arguments: JSON.stringify({ agent: 'two', input: 'sub task' }) }
});

// A call made BY a delegated run — the card that lives inside the child's own row (recorded run:
// row `:3`'s never-returned `shell` card 17473).
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

// The recorded commit: an answer is pinned here, so the root row keeps a committed answer node.
const commit = (): HarnessEvent =>
    ({ type: 'attempt_commit', agent: 'one', attempt: 1, maxAttempts: 3 }) as HarnessEvent;

const done = (agent: string, model: string, content: string, thread?: HarnessEvent['thread']): HarnessEvent => ({
    type: 'done',
    agent,
    message: { role: 'assistant', content, reasoning: '', toolCalls: [], model, stopReason: 'stop' },
    ...(thread === undefined ? {} : { thread })
});

const actionRequest = (requestId: string): HarnessEvent =>
    ({
        type: 'action_request',
        agent: 'one',
        callId: 'call-1',
        request: {
            requestId,
            question: 'Which target?',
            recommended: 'b',
            options: [
                { id: 'a', label: 'Alpha' },
                { id: 'b', label: 'Beta', description: 'preferred' }
            ],
            allowCustom: true
        }
    }) as HarnessEvent;

const actionAnswer = (requestId: string): HarnessEvent =>
    ({
        type: 'action_answer',
        agent: 'one',
        requestId,
        answer: { requestId, choice: { kind: 'option', optionId: 'b' }, source: 'owner' }
    }) as HarnessEvent;

// ---------------------------------------------------------------------------
// The journal: a delegation whose CHILD died mid-run, mid-tool-call.
// ---------------------------------------------------------------------------

const DEATH: HarnessEvent[] = [
    start('one', 'gpt-x', ROOT), // 0 -> 1_000  the conversation's own flow
    delegateCall('call-1'), // 1 -> 1_010  mints the parent's `delegate` CARD + child placeholder
    start('two', 'gpt-y', childOf('inv-15', 'call-1')), // 2 -> 1_020  adopts the placeholder -> row :1
    reasoning('two', 'planning the build', childOf('inv-15', 'call-1')), // 3 -> 1_030
    childCall('call-9', 'shell', '{"command":"make"}', childOf('inv-15', 'call-1')), // 4 -> 1_040  the child's OWN card, never answered
    reasoning('two', 'still waiting on make', childOf('inv-15', 'call-1')), // 5 -> 1_050  the ROW's last frame; the card saw nothing after 1_040
    // ---- the process dies; the restarted runtime restarts its invocation counter ----
    start('one', 'gpt-x', { id: 'inv-15' }), // 6 -> 1_060  root-shaped, wearing the dead child's id
    text('one', 'the complete answer', { id: 'inv-15' }), // 7 -> 1_070
    commit(), // 8 -> 1_080
    done('one', 'gpt-x', 'the complete answer', { id: 'inv-15' }) // 9 -> 1_090
];

describe('T-W24 — an abandoned call card ends at its own last stamp', () => {
    it('ends both abandoned cards at the CARD figure, which is neither the row end nor the settle stamp', () => {
        const result = fold(DEATH);

        // `settle` is idempotent (pinned in ./turn-projector.test.ts, "settles a cancelled turn"), so
        // this batch is captured ONCE: it is what a live watcher actually applied.
        const settleOps = result.settle('done');

        // THE PARENT'S CARD (the recorded run's row `:0` cards): minted at event 1, and event 1 is
        // also the last frame that ever wrote to it, so the card ends at 1_010 — a 0 ms span — while
        // the turn went on for another 3,900 ms and the ROOT row still ends at the settle stamp.
        expect(cardOf(result, 'turn-1:0', '1')).toEqual({
            kind: 'tool',
            id: '1',
            turnId: 'turn-1',
            sectionId: 'turn-1:0',
            callId: 'call-1',
            name: 'delegate',
            argsPreview: '{"agent":"two","input":"sub task"}',
            state: 'error',
            preview: 'the turn ended before this call returned',
            startedAt: 1_010,
            endedAt: 1_010,
            detail: { stepId: '1', hasResult: false, truncated: false }
        });

        // THE CHILD'S OWN CARD, inside the row the death cut off (the recorded run's row `:3`
        // `shell`/`glob` cards). Three different figures are in play, and only the middle one is the
        // card's: settle stamp 5_000 (the pre-fix value), the ROW's last frame 1_050 (the T-W23 rule,
        // one plane up), and the CARD's last frame 1_040 — which is what the card must report.
        expect(cardOf(result, 'turn-1:1', '4')).toEqual({
            kind: 'tool',
            id: '4',
            turnId: 'turn-1',
            sectionId: 'turn-1:1',
            callId: 'call-9',
            name: 'shell',
            argsPreview: '{"command":"make"}',
            state: 'error',
            preview: 'the turn ended before this call returned',
            startedAt: 1_040,
            endedAt: 1_040,
            detail: { stepId: '4', hasResult: false, truncated: false }
        });

        // DISCRIMINATION, stated as figures: the span the reader gets is 0 ms, and the span the
        // pre-fix stamp produced was the whole rest of the turn (3,990 ms from 1_010 / 3,960 ms from
        // 1_040, i.e. `4.0s` on this clock — the 64m04s the recorded run printed).
        const abandonedCard = cardOf(result, 'turn-1:0', '1') as { startedAt: number; endedAt: number };
        expect(abandonedCard.endedAt - abandonedCard.startedAt).toBe(0);
        expect(formatDuration(0)).toBe('0ms');
        expect(formatDuration(SETTLE_AT - 1_010)).toBe('4.0s');
        expect((cardOf(result, 'turn-1:1', '4') as { endedAt: number }).endedAt).not.toBe(SETTLE_AT);
        // The card never runs backwards and never loses its label: `elapsedBetween` returns a number
        // (0), never `undefined`, so the compiled card paints instead of ticking to NOW.
        expect((cardOf(result, 'turn-1:1', '4') as { endedAt: number }).endedAt - 1_040).toBe(0);

        // ONE wire patch per abandoned card, carrying that card's own end — the settle ops are what a
        // live watcher applies, so the live board and the reload board are decided here. The order is
        // the mint order (`steps` insertion order: the parent's card first, then the child's).
        expect(settledCardPatches(settleOps)).toEqual([
            { sectionId: 'turn-1:0', id: '1', state: 'error', endedAt: 1_010 },
            { sectionId: 'turn-1:1', id: '4', state: 'error', endedAt: 1_040 }
        ]);

        // The T-W23 row rule, unchanged by this change and still visible next to the cards: the child
        // row ends at ITS last frame (event 5) as `cancelled`, and the root row still ends at the
        // turn's end as `done`.
        const child = sectionOf(result, 'turn-1:1');
        const root = sectionOf(result, 'turn-1:0');

        expect([child?.startedAt, child?.endedAt, child?.state]).toEqual([1_020, 1_050, 'cancelled']);
        expect([root?.startedAt, root?.endedAt, root?.state]).toEqual([1_000, SETTLE_AT, 'done']);
        expect(result.summary()).toMatchObject({ status: 'done', state: 'done', detail: 'gpt-x' });
    });

    it('leaves a card that received its OWN terminal event byte-identical, and touches it again at settle', () => {
        const answered = fold([
            start('one', 'gpt-x', ROOT), // 0 -> 1_000
            toolResult('read', 'file body', 'call-0', { outcome: 'completed', durationMs: 12 }), // 1 -> result-only legacy card (its own terminal frame)
            { type: 'tool_call', agent: 'one', call: { id: 'call-1', name: 'read', arguments: '{"path":"a.ts"}' } }, // 2 -> 1_020
            toolResult('read', 'file body', 'call-1', { outcome: 'completed', durationMs: 12 }), // 3 -> 1_030  the card's OWN result frame
            {
                type: 'tool_call',
                agent: 'one',
                call: { id: 'call-2', name: 'shell', arguments: '{"command":"sleep 99"}' }
            }, // 4 -> 1_040  abandoned
            text('one', 'the complete answer', ROOT), // 5 -> 1_050
            commit(), // 6 -> 1_060
            done('one', 'gpt-x', 'the complete answer', ROOT) // 7 -> 1_070
        ] as HarnessEvent[]);

        const settleOps = answered.settle('done');

        // The paired card, WHOLE: the `tool_result` stamped `endedAt` 1_030 and the measured
        // `durationMs`, and `settle` may not move either (the loop skips anything not `running`).
        expect(cardOf(answered, 'turn-1:0', '2')).toEqual({
            kind: 'tool',
            id: '2',
            turnId: 'turn-1',
            sectionId: 'turn-1:0',
            callId: 'call-1',
            name: 'read',
            argsPreview: '{"path":"a.ts"}',
            state: 'ok',
            outcome: 'completed',
            preview: 'file body',
            durationMs: 12,
            startedAt: 1_020,
            endedAt: 1_030,
            detail: { stepId: '2', resultStepId: '3', hasResult: true, truncated: false }
        });

        // The result-only legacy card is equally its own terminal event: minted AND ended at 1_001...
        // event 1, i.e. 1_010, with the measured span.
        expect(cardOf(answered, 'turn-1:0', '1')).toMatchObject({
            state: 'ok',
            startedAt: 1_010,
            endedAt: 1_010,
            durationMs: 12
        });

        // BYTE-IDENTITY ON THE WIRE: `settle` emits a patch for the abandoned card ONLY — a card with
        // its own terminal event receives no second patch, before or after this change.
        expect(settledCardPatches(settleOps)).toEqual([
            { sectionId: 'turn-1:0', id: '4', state: 'error', endedAt: 1_040 }
        ]);
    });

    it('applies the same rule to an unanswered owner question, and leaves an answered one alone', () => {
        const abandoned = fold([
            start('one', 'gpt-x', ROOT), // 0 -> 1_000
            actionRequest('req-1'), // 1 -> 1_010  the card's only frame
            text('one', 'proceeding without an answer', ROOT), // 2 -> 1_020
            commit(), // 3 -> 1_030
            done('one', 'gpt-x', 'proceeding without an answer', ROOT) // 4 -> 1_040
        ]);

        abandoned.settle('done');

        expect(cardOf(abandoned, 'turn-1:0', '1')).toEqual({
            kind: 'action',
            id: '1',
            turnId: 'turn-1',
            sectionId: 'turn-1:0',
            callId: 'call-1',
            name: 'Which target?',
            state: 'error',
            preview: 'the turn ended before this call returned',
            startedAt: 1_010,
            endedAt: 1_010,
            action: {
                requestId: 'req-1',
                question: 'Which target?',
                options: [
                    { id: 'a', label: 'Alpha' },
                    { id: 'b', label: 'Beta', description: 'preferred' }
                ],
                recommended: 'b',
                allowCustom: true,
                expired: true
            },
            detail: { stepId: '1', hasResult: false, truncated: false }
        });

        const answered = fold([
            start('one', 'gpt-x', ROOT), // 0 -> 1_000
            actionRequest('req-1'), // 1 -> 1_010
            actionAnswer('req-1'), // 2 -> 1_020  its OWN terminal event
            text('one', 'the complete answer', ROOT), // 3 -> 1_030
            commit(), // 4 -> 1_040
            done('one', 'gpt-x', 'the complete answer', ROOT) // 5 -> 1_050
        ]);

        const settleOps = answered.settle('done');

        expect(cardOf(answered, 'turn-1:0', '1')).toMatchObject({ state: 'ok', startedAt: 1_010, endedAt: 1_020 });
        // Nothing running, so no card patch at all — this card is byte-identical pre- and post-fix.
        expect(settledCardPatches(settleOps)).toEqual([]);
    });

    it('ends an abandoned card of a CANCELLED turn at its own stamp too (state vocabulary unchanged)', () => {
        const result = fold([
            start('one', 'gpt-x', ROOT), // 0 -> 1_000
            text('one', 'partial', ROOT), // 1 -> 1_010
            {
                type: 'tool_call',
                agent: 'one',
                call: { id: 'call-1', name: 'shell', arguments: '{"command":"sleep 99"}' }
            } // 2 -> 1_020
        ] as HarnessEvent[]);

        result.settle('cancelled');

        // `cancelled` for the state (a control outcome, exactly as before) and the card's own stamp
        // for the end. The updated pin in ./turn-projector.test.ts:1165-1176 is the same figure.
        expect(cardOf(result, 'turn-1:0', '2')).toEqual({
            kind: 'tool',
            id: '2',
            turnId: 'turn-1',
            sectionId: 'turn-1:0',
            callId: 'call-1',
            name: 'shell',
            argsPreview: '{"command":"sleep 99"}',
            state: 'cancelled',
            preview: 'the turn was cancelled before this call returned',
            startedAt: 1_020,
            endedAt: 1_020,
            detail: { stepId: '2', hasResult: false, truncated: false }
        });
    });
});

describe('T-W24 — a record with no per-card stamps folds byte-identically', () => {
    const legacyEvents = [
        start('one', 'gpt-x', ROOT),
        text('one', 'partial', ROOT),
        { type: 'tool_call', agent: 'one', call: { id: 'call-1', name: 'shell', arguments: '{"command":"sleep 99"}' } }
    ] as HarnessEvent[];

    // THE PRE-FIX FACE for this journal: `settle` stamped `endedAt = settledAt` and nothing else moved.
    // A record with no `eventTimes` still has no stamp anywhere after the fix, so the fallback branch
    // has to reproduce this object EXACTLY — absent `startedAt` included.
    const PRE_FIX_CARD = {
        kind: 'tool',
        id: '2',
        turnId: 'turn-1',
        sectionId: 'turn-1:0',
        callId: 'call-1',
        name: 'shell',
        argsPreview: '{"command":"sleep 99"}',
        state: 'error',
        preview: 'the turn ended before this call returned',
        endedAt: SETTLE_AT,
        detail: { stepId: '2', hasResult: false, truncated: false }
    };

    it('keeps the settle stamp as the card end when the record holds no stamps', () => {
        const liveTurn = turnOf({ eventTimes: undefined, status: 'done', updatedAt: SETTLE_AT });
        const projector = createTurnProjector(liveTurn, CONTEXT);

        legacyEvents.forEach((event, index) => projector.apply(event, DISPLAY_NO_TIMESTAMP, index));

        projector.settle('done', SETTLE_AT);

        const card = projector.display().sections[0].nodes.find((node) => node.id === '2') as Record<string, unknown>;

        expect(card).toEqual(PRE_FIX_CARD);
        // Absent, not zero: a fabricated stamp would paint a fake duration (the R9 rule in
        // ./turn-projector.test.ts "writes no timing at all for a record with no event times").
        expect('startedAt' in card).toBe(false);
    });

    it('folds that legacy record the same live and cold', () => {
        const liveTurn = turnOf({
            eventTimes: undefined,
            status: 'done',
            updatedAt: SETTLE_AT,
            events: [...legacyEvents]
        });
        const projector = createTurnProjector(liveTurn, CONTEXT);

        legacyEvents.forEach((event, index) => projector.apply(event, DISPLAY_NO_TIMESTAMP, index));

        projector.settle('done', SETTLE_AT);

        const cold = projectTurn(
            turnOf({ eventTimes: undefined, status: 'done', updatedAt: SETTLE_AT, events: [...legacyEvents] }),
            CONTEXT
        );

        expect(cold.display).toEqual(projector.display());
        expect(cold.summary).toEqual(projector.summary());
        expect(cold.display.sections[0].nodes.find((node) => node.id === '2') as Record<string, unknown>).toEqual(
            PRE_FIX_CARD
        );
    });
});

describe('T-W24 — live ≡ replay for the card rule', () => {
    it('a reload of the settled run serves the same cards the live fold painted', () => {
        const live = fold(DEATH);

        live.settle('done');

        const liveTree = live.display();
        const liveSummary = live.summary();

        // The COLD fold is what a reload and every view read serve (./turn-projector.ts
        // `projectTurn`). If the card end came from `Date.now()` or from live-only state, these two
        // boards would disagree the moment the page refreshed.
        const cold = projectTurn(live.turn, CONTEXT);
        const coldAgain = projectTurn(live.turn, CONTEXT);

        expect(cold.display).toEqual(liveTree);
        expect(cold.summary).toEqual(liveSummary);
        expect(coldAgain.display).toEqual(cold.display);

        // Stated once more as the exact card, read off the COLD board: 1_040, not the settle stamp and
        // not the row end.
        expect(cold.display.sections[1].nodes.find((node) => node.id === '4') as Record<string, unknown>).toMatchObject(
            {
                startedAt: 1_040,
                endedAt: 1_040
            }
        );
    });

    it('a still-running turn that never settles keeps its running cards exactly as they were', () => {
        // `settle` is the ONLY place this rule lives, so a running fold must not move a card's clock:
        // a running card has no `endedAt` at all (its label keeps ticking locally, ../frontend/ui/
        // turns.ts:8226-8230).
        const running = fold(DEATH.slice(0, 6));

        expect(cardOf(running, 'turn-1:1', '4')).toMatchObject({ state: 'running' });
        expect('endedAt' in (cardOf(running, 'turn-1:1', '4') as Record<string, unknown>)).toBe(false);
        expect(cardOf(running, 'turn-1:0', '1')).toMatchObject({ state: 'running' });
        expect('endedAt' in (cardOf(running, 'turn-1:0', '1') as Record<string, unknown>)).toBe(false);
    });
});

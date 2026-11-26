// F11 (2026-11-26) — EVERY ROW IS NAMED, EVEN WHEN THE ROSTER JOINS LATE.
//
// THE MANDATE, verbatim (what this file pins):
//   "All labels must be valid. Cannot have T? or T- etc... all labels must be unique, as no
//    thread share same labeling. This is because user using these label to reference as needed,
//    and having a bunch of "T?" means they cannot reference specific one. All thread that
//    started, regardless of failure etc... must be assigned a proper label."
//
// WHY THIS FILE EXISTS. `syncThreadIds` (./turn-projector.ts) already back-fills a delegated
// row's CONVERSATION ID when the store learns the join after the row was folded, and
// ./turn-projector-run-join.test.ts T4 pins that. Nothing did the same for the row's NAME: a
// section folded while `DisplayProjectContext.threadLabels` had no entry for its run kept an
// EMPTY `agentLabel` for the rest of its life, and a live watcher (the only consumer of the
// patch stream) showed an unnamed row until the next reload — the exact defect F11 forbids,
// one level below the label the client mints. `syncSectionLabels` is the label twin of
// `syncThreadIds`, on the same three call sites (every event, `settle`, `syncSteers`), with the
// same epoch-scoped lookup, and this file is the round-trip proof:
//
//   1. a label-join landing AFTER the fold back-fills the section label (as its own patch, on
//      the SAME frame — the R18d discipline, so a live watcher and a cold replay agree);
//   2. no section keeps an empty label once its roster entry exists;
//   3. the pass cannot rename anything it does not own: the root row (whose label is the
//      RECORD's `turn.threadLabel`), a row that already has a label, a threadFork BRANCH (no
//      conversation of its own — the block projection names it, `labelSource: 'shared'`), an
//      un-adopted placeholder (no invocation id), and a row of ANOTHER process epoch (R19).
//
// The behavioral reference for the round trip is
// ../../../loadscript/harness/src/frontend/ui/turns-label-round-trip.test.ts (live rows ≡ live
// descriptors ≡ replayed blocks). This is its SERVER half: the projection's own labels, because
// the wire projection is what a reload paints and what the composer's `#` popup reads.
//
// Event shapes are copied from what the runtime ACTUALLY records (../engine/harness.ts
// `withThread`/`threadIdentity`), as in ./turn-projector-run-join.test.ts: a delegated child
// carries `{ id, parentId, callId, input }` and later frames carry the identity fields alone.
//
// Clock policy: one recorded event per 10 ms, so every timestamp below is an exact number.
//
// Run: yarn vitest run src/server/turn-projector-label-join.test.ts

import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '../engine/harness';
import type { DisplayProjectContext, TurnDisplay, TurnDisplayOp } from '../engine/shared/turn-display';
import type { SessionTurn } from './protocol';
import { invocationRunKeyOf } from './protocol';
import { createTurnProjector, projectTurn } from './turn-projector';

const EPOCH_PRE = 'epoch-pre-restart';
const EPOCH_POST = 'epoch-post-restart';

const turnOf = (overrides: Partial<SessionTurn> = {}): SessionTurn => ({
    id: 'turn-1',
    index: 0,
    prompt: 'label the rows',
    status: 'running',
    startedAt: 1_000,
    updatedAt: 1_000,
    events: [],
    eventTimes: [],
    // The turn's OWN conversation: what the ROOT row's label must stay, whatever the join says.
    threadId: 'thread-13',
    threadLabel: 'IT4',
    ...overrides
});

// `threadIds`/`labels` are optional on purpose: their ABSENCE is the case under test — a roster
// that does not yet name the run. Both maps are keyed by INVOCATION RUN (`invocationRunKeyOf`),
// the store's own rule (../sessions.ts `noteInvocationThread` / `invocationThreadLabels`).
const contextOf = (
    options: { threadIds?: ReadonlyMap<string, string>; labels?: ReadonlyMap<string, string> } = {}
): DisplayProjectContext => ({
    entry: 'instruct',
    ranks: { instruct: 'A', workspace: 'B' },
    ...(options.labels === undefined ? {} : { threadLabels: options.labels }),
    ...(options.threadIds === undefined ? {} : { invocationThreadIds: options.threadIds })
});

// --- recorded frame shapes, verbatim from the runtime ------------------------

/** A host-thread root `start`: `{ id, input }` plus the minting process's epoch. */
const rootStart = (invocationId: string, epoch: string, agent = 'instruct'): HarnessEvent => ({
    type: 'start',
    agent,
    model: 'local/basalt',
    thread: { id: invocationId, input: 'label the rows', epoch }
});

/** A delegated child's `start`: id + lineage + prompt + epoch, no `kind` (only branches set one). */
const childStart = (
    invocationId: string,
    parentId: string,
    callId: string,
    agent: string,
    epoch: string
): HarnessEvent => ({
    type: 'start',
    agent,
    model: 'local/basalt',
    thread: { id: invocationId, parentId, callId, input: 'keep going', epoch }
});

/** The run's identity fields on every LATER frame (../engine/harness.ts `threadIdentity`). */
const runThread = (
    invocationId: string,
    parentId: string | undefined,
    callId: string | undefined,
    epoch: string
): HarnessEvent['thread'] => ({
    id: invocationId,
    ...(parentId === undefined ? {} : { parentId }),
    ...(callId === undefined ? {} : { callId }),
    epoch
});

const text = (agent: string, delta: string, thread: HarnessEvent['thread']): HarnessEvent => ({
    type: 'text',
    agent,
    delta,
    thread
});

const done = (agent: string, thread: HarnessEvent['thread']): HarnessEvent => ({
    type: 'done',
    agent,
    message: {
        role: 'assistant',
        content: '',
        reasoning: '',
        toolCalls: [],
        model: 'local/basalt',
        stopReason: 'stop'
    },
    thread
});

const delegateCall = (callId: string, agent: string, thread: HarnessEvent['thread']): HarnessEvent => ({
    type: 'tool_call',
    agent: 'instruct',
    call: { id: callId, name: 'delegate', arguments: JSON.stringify({ agent, input: 'keep going' }) },
    thread
});

/** A `threadFork` BRANCH run: it owns no conversation, so it must never take one's name. */
const branchStart = (epoch: string): HarnessEvent => ({
    type: 'branch_start',
    agent: 'instruct',
    branch: {
        branchId: 'branch-1',
        agent: 'instruct',
        kind: 'fork',
        rank: 'B',
        forkDepth: 1,
        model: 'local/basalt',
        tools: [],
        label: 'audit'
    },
    thread: { id: 'branch-1', kind: 'fork', branchId: 'branch-1', parentId: '14', epoch }
});

// One row as a client sees it. Absent fields stay ABSENT, so `toEqual` is exact.
const rowsOf = (display: TurnDisplay) =>
    display.sections.map((section) => ({
        id: section.id,
        agent: section.agent,
        agentLabel: section.agentLabel,
        ...(section.invocationId === undefined ? {} : { invocationId: section.invocationId }),
        ...(section.threadId === undefined ? {} : { threadId: section.threadId }),
        ...(section.branchId === undefined ? {} : { branchId: section.branchId }),
        state: section.state
    }));

// Exactly what the late-label pass emits: a `section:set` naming `agentLabel` and NOTHING ELSE.
// Anything else that legitimately names the field must not be counted — a root `start` (that
// label is in the RECORD), a child adoption patch (whole identity + state in one op), and the
// `start` handler's own join read (same frame the row was created on).
const lateLabelPatches = (ops: TurnDisplayOp[][]) =>
    ops
        .flat()
        .filter(
            (op): op is Extract<TurnDisplayOp, { op: 'section:set' }> =>
                op.op === 'section:set' &&
                Object.keys(op.patch).length === 1 &&
                Object.prototype.hasOwnProperty.call(op.patch, 'agentLabel')
        )
        .map((op) => ({ op: op.op, turnId: op.turnId, sectionId: op.sectionId, patch: op.patch }));

// A LIVE fold driven frame by frame, with the maps mutable between frames — exactly how the
// recorder grows the join while the run goes (../sessions.ts).
const live = (
    turn: SessionTurn,
    context: DisplayProjectContext
): { projector: ReturnType<typeof createTurnProjector>; frame: (event: HarnessEvent, index: number) => TurnDisplayOp[] } => {
    const projector = createTurnProjector(turn, context);

    return {
        projector,
        frame: (event: HarnessEvent, index: number) => {
            const stamp = 1_000 + index * 10;
            turn.events.push(event);
            turn.eventTimes?.push(stamp);

            return projector.apply(event, stamp, index);
        }
    };
};

describe('F11: a label the store learns late still lands on the row that owns the run', () => {
    it('back-fills the row name when the label join lands after the row was folded', () => {
        // The child row is created by the parent's `delegate` call and takes its invocation id
        // from the run's first frame, while the store's `threadLabels` view has NO entry for
        // that run yet — so `createChild`/`adoptPlaceholder` resolved the label to undefined and
        // the row is folded with an EMPTY name. The entry appears between frames.
        const labels = new Map<string, string>();
        const { projector, frame } = live(turnOf(), contextOf({ labels }));

        frame(rootStart('14', EPOCH_PRE), 0);
        frame(delegateCall('call-a', 'workspace', runThread('14', undefined, undefined, EPOCH_PRE)), 1);
        frame(
            text('workspace', 'probing read', runThread('17', '14', 'call-a', EPOCH_PRE)),
            2
        );

        // Folded, addressable, and UNNAMED — the defect, stated before it is fixed.
        expect(rowsOf(projector.display())[1]).toEqual({
            id: 'turn-1:1',
            agent: 'workspace',
            agentLabel: '',
            invocationId: '17',
            state: 'streaming'
        });

        // The roster names the run only now. There is no `threadIds` map at all here, so the
        // label pass cannot be riding on the id pass: it stands on its own.
        labels.set(invocationRunKeyOf('17', EPOCH_PRE), 'WE9');

        const ops = frame(text('workspace', 'still probing', runThread('17', '14', 'call-a', EPOCH_PRE)), 3);

        // The name lands on the SAME frame the join became known, as its own patch (the R18d
        // discipline) — a live watcher is never left with an unnamed row until a reload.
        expect(lateLabelPatches([ops])).toEqual([
            { op: 'section:set', turnId: 'turn-1', sectionId: 'turn-1:1', patch: { agentLabel: 'WE9' } }
        ]);
        expect(rowsOf(projector.display())[1]).toEqual({
            id: 'turn-1:1',
            agent: 'workspace',
            agentLabel: 'WE9',
            invocationId: '17',
            state: 'streaming'
        });
    });

    it('leaves the row unnamed while no roster entry names its run (no invented numbers)', () => {
        // The projection NEVER mints an ordinal: that is the display plane's job
        // (../frontend/ui/turns.ts). So the honest answer with no join is the empty string, and
        // this pins that the pass does not manufacture a label out of the agent name.
        const { projector } = live(turnOf(), contextOf({}));

        projector.apply(rootStart('14', EPOCH_PRE), 1_000, 0);
        projector.apply(delegateCall('call-a', 'workspace', runThread('14', undefined, undefined, EPOCH_PRE)), 1_010, 1);
        projector.apply(text('workspace', 'probing', runThread('17', '14', 'call-a', EPOCH_PRE)), 1_020, 2);
        projector.settle('done', 9_000);

        expect(rowsOf(projector.display())).toEqual([
            {
                id: 'turn-1:0',
                agent: 'instruct',
                agentLabel: 'IT4',
                invocationId: '14',
                threadId: 'thread-13',
                state: 'done'
            },
            {
                // `cancelled`: the row streamed but never reported a terminal frame, and the
                // settle policy closes an unfinished child as cancelled (the same rule
                // ./turn-projector-settle-interrupted.test.ts pins) — unrelated to labels.
                id: 'turn-1:1',
                agent: 'workspace',
                agentLabel: '',
                invocationId: '17',
                state: 'cancelled'
            }
        ]);
    });

    it('names every row of a mixed fleet once the roster names every run — no empty label survives', () => {
        // The mandate's second half, asserted as a property of a whole fold: two delegations, a
        // never-started attempt, and a fork, replayed COLD with the complete map. `projectTurn`
        // is the reload path, so this is also the live ≡ replay parity proof for labels.
        const labels = new Map<string, string>([
            [invocationRunKeyOf('15', EPOCH_PRE), 'WE6'],
            [invocationRunKeyOf('16', EPOCH_PRE), 'WE7']
        ]);
        const threadIds = new Map<string, string>([
            [invocationRunKeyOf('15', EPOCH_PRE), 'thread-14'],
            [invocationRunKeyOf('16', EPOCH_PRE), 'thread-15']
        ]);

        const turn = turnOf({
            status: 'done',
            events: [
                rootStart('14', EPOCH_PRE),
                delegateCall('call-a', 'workspace', runThread('14', undefined, undefined, EPOCH_PRE)),
                childStart('15', '14', 'call-a', 'workspace', EPOCH_PRE),
                text('workspace', 'probing', runThread('15', '14', 'call-a', EPOCH_PRE)),
                done('workspace', runThread('15', '14', 'call-a', EPOCH_PRE)),
                delegateCall('call-b', 'workspace', runThread('14', undefined, undefined, EPOCH_PRE)),
                childStart('16', '14', 'call-b', 'workspace', EPOCH_PRE),
                done('workspace', runThread('16', '14', 'call-b', EPOCH_PRE)),
                // A third spawning call whose child NEVER starts: the projection still gives the
                // row its own identity, and the display plane is what numbers it.
                delegateCall('call-c', 'workspace', runThread('14', undefined, undefined, EPOCH_PRE)),
                done('instruct', runThread('14', undefined, undefined, EPOCH_PRE))
            ],
            eventTimes: [1_000, 1_010, 1_020, 1_030, 1_040, 1_050, 1_060, 1_070, 1_080, 1_090]
        });

        // `projectTurn` is the COLD replay entry point the store uses on restore: it folds the
        // whole record with the loaded maps and answers `{ summary, display }`.
        const display = projectTurn(turn, contextOf({ labels, threadIds })).display;

        expect(rowsOf(display)).toEqual([
            {
                id: 'turn-1:0',
                agent: 'instruct',
                agentLabel: 'IT4',
                invocationId: '14',
                threadId: 'thread-13',
                state: 'done'
            },
            {
                id: 'turn-1:1',
                agent: 'workspace',
                agentLabel: 'WE6',
                invocationId: '15',
                threadId: 'thread-14',
                state: 'done'
            },
            {
                id: 'turn-1:2',
                agent: 'workspace',
                agentLabel: 'WE7',
                invocationId: '16',
                threadId: 'thread-15',
                state: 'done'
            }
            // The third spawning call's child NEVER started, and a `delegate` placeholder that
            // never became a run is dropped from the DISPLAY at settle
            // (./turn-projector-abandoned-card.test.ts) — which is precisely why the label pass
            // must not be judged by this fold. The row the operator can still reference is the
            // BLOCK projection's (`call:<callId>`, its own ordinal), and ./references.test.ts
            // 'binds a never-started delegation attempt' pins that end to end.
        ]);

        // The property itself, not a snapshot: no row that OWNS a run is blank.
        for (const row of rowsOf(display)) {
            if (row.branchId !== undefined || row.invocationId === undefined) continue;
            if (labels.get(invocationRunKeyOf(row.invocationId, EPOCH_PRE)) === undefined) continue;
            expect(row.agentLabel).toBe(labels.get(invocationRunKeyOf(row.invocationId, EPOCH_PRE)));
        }
    });

    it('keeps a label the row already had — a late join never rewrites a name', () => {
        // First evidence wins, exactly as in `syncThreadIds`: the wire label a row was folded
        // with is its identity, and a join that arrives afterwards must not rename a live row
        // (a rename would move the address the user may already be typing).
        const labels = new Map<string, string>([[invocationRunKeyOf('17', EPOCH_PRE), 'WE6']]);
        const { projector, frame } = live(turnOf(), contextOf({ labels }));

        frame(rootStart('14', EPOCH_PRE), 0);
        frame(delegateCall('call-a', 'workspace', runThread('14', undefined, undefined, EPOCH_PRE)), 1);
        frame(childStart('17', '14', 'call-a', 'workspace', EPOCH_PRE), 2);

        expect(rowsOf(projector.display())[1].agentLabel).toBe('WE6');

        // The store changes its mind about the run afterwards — the row does not move.
        labels.set(invocationRunKeyOf('17', EPOCH_PRE), 'WE9');
        const ops = frame(text('workspace', 'later', runThread('17', '14', 'call-a', EPOCH_PRE)), 3);

        expect(lateLabelPatches([ops])).toEqual([]);
        expect(rowsOf(projector.display())[1].agentLabel).toBe('WE6');
    });

    it('skips the root row, the branch row, and an un-adopted placeholder', () => {
        const labels = new Map<string, string>([
            // A join that WOULD name the root differently than the record does.
            [invocationRunKeyOf('14', EPOCH_PRE), 'ZZ9'],
            // And one for a branch id: a branch owns no conversation, so its name comes from the
            // block projection (`labelSource: 'shared'`), never from this pass.
            ['branch-1', 'ZZ8']
        ]);

        const turn = turnOf();
        const projector = createTurnProjector(turn, contextOf({ labels }));
        const ops: TurnDisplayOp[][] = [];
        const frame = (event: HarnessEvent, index: number) => {
            ops.push(projector.apply(event, 1_000 + index * 10, index));
            turn.events.push(event);
            turn.eventTimes?.push(1_000 + index * 10);
        };

        frame(rootStart('14', EPOCH_PRE), 0);
        // A placeholder NOTHING ever adopts: it has no invocation id, so there is no run key to
        // look up and the pass must not touch it (its name is the client's provisional ordinal).
        frame(delegateCall('call-x', 'workspace', runThread('14', undefined, undefined, EPOCH_PRE)), 1);
        frame(branchStart(EPOCH_PRE), 2);
        frame(text('workspace', 'probing', runThread('14', undefined, undefined, EPOCH_PRE)), 3);
        projector.settle('done', 9_000);

        // ROOT keeps the record's `IT4` and the branch keeps its own empty projection label —
        // no single-field `agentLabel` patch anywhere, for any row.
        expect(lateLabelPatches(ops)).toEqual([]);
        expect(rowsOf(projector.display())).toEqual([
            {
                id: 'turn-1:0',
                agent: 'instruct',
                agentLabel: 'IT4',
                invocationId: '14',
                threadId: 'thread-13',
                state: 'done'
            },
            {
                // The branch row: `invocationId` is its own branch id, and the pass skipped it
                // (`branchId` is set) — a branch runs INSIDE the conversation that forked it, so
                // the block projection gives it that conversation's address with
                // `labelSource: 'shared'`, which this pass must not pre-empt. `cancelled` is the
                // settle policy for a fork that never reported `branch_end`.
                // The un-adopted placeholder row is GONE: a `delegate` placeholder that never
                // became a run is dropped at settle (./turn-projector-abandoned-card.test.ts),
                // which is also why the pass skipping it is not observable as a blank name.
                id: 'turn-1:2',
                agent: 'instruct',
                agentLabel: '',
                invocationId: 'branch-1',
                branchId: 'branch-1',
                state: 'cancelled'
            }
        ]);
    });

    it('carries a label learned after the LAST frame on the settle ops (the settle call site)', () => {
        // Settle is the last frame a projector ever emits: without the pass there, a live watcher
        // keeps an unnamed row until the next reload while the cold replay had the name from the
        // first fold — the same asymmetry `syncThreadIds` exists to close.
        const labels = new Map<string, string>();
        const { projector, frame } = live(turnOf(), contextOf({ labels }));

        frame(rootStart('14', EPOCH_PRE), 0);
        frame(delegateCall('call-a', 'workspace', runThread('14', undefined, undefined, EPOCH_PRE)), 1);
        frame(text('workspace', 'probing', runThread('17', '14', 'call-a', EPOCH_PRE)), 2);

        labels.set(invocationRunKeyOf('17', EPOCH_PRE), 'WE9');

        expect(lateLabelPatches([projector.settle('done', 9_000)])).toEqual([
            { op: 'section:set', turnId: 'turn-1', sectionId: 'turn-1:1', patch: { agentLabel: 'WE9' } }
        ]);
        expect(rowsOf(projector.display())[1].agentLabel).toBe('WE9');
    });

    it('carries it on the steer ops too (the syncSteers call site)', () => {
        // `syncSteers` is the only fold step that runs WITHOUT a stored event, and a steer's
        // bar segment is resolved by `section.threadId` — so the identity passes run there for
        // the same reason, and the row the guidance lands on must be named on that frame.
        const labels = new Map<string, string>();
        const threadIds = new Map<string, string>();
        const turn = turnOf();
        const { projector, frame } = live(turn, contextOf({ labels, threadIds }));

        frame(rootStart('14', EPOCH_PRE), 0);
        frame(delegateCall('call-a', 'workspace', runThread('14', undefined, undefined, EPOCH_PRE)), 1);
        frame(text('workspace', 'probing', runThread('17', '14', 'call-a', EPOCH_PRE)), 2);

        // Both joins land together, after the row exists, and NOTHING else is folded before the
        // steer is adopted.
        labels.set(invocationRunKeyOf('17', EPOCH_PRE), 'WE9');
        threadIds.set(invocationRunKeyOf('17', EPOCH_PRE), 'thread-30');
        turn.steers = [{ id: 'steer-1', at: 5_000, prompt: 'focus the probe', threadId: 'thread-30' }];

        const ops = projector.syncSteers(5_000);

        expect(lateLabelPatches([ops])).toEqual([
            { op: 'section:set', turnId: 'turn-1', sectionId: 'turn-1:1', patch: { agentLabel: 'WE9' } }
        ]);

        const rows = rowsOf(projector.display());
        expect(rows[1].agentLabel).toBe('WE9');
        expect(rows[1].threadId).toBe('thread-30');

        // The steer segment itself is drawn on THAT row (`kind: 'user'`, the steer's own
        // segment) — the name and the destination of the guidance come from the same frame.
        const bar = projector.display().sections[1].context ?? [];
        expect(bar.map((block) => [block.kind, block.name])).toEqual([
            ['assistant', 'answer'],
            ['user', 'steer']
        ]);
    });

    it('never hands a recycled invocation id another process\'s name (R19, still enforced)', () => {
        // The pass looks the run key up with the ROW's own epoch (`record.epoch`), exactly like
        // `syncThreadIds`. A join for a post-restart run of id `15` must not rename the
        // pre-restart row that also carried `15`.
        const labels = new Map<string, string>([[invocationRunKeyOf('17', EPOCH_POST), 'WE9']]);
        const { projector, frame } = live(turnOf(), contextOf({ labels }));

        frame(rootStart('14', EPOCH_PRE), 0);
        frame(delegateCall('call-a', 'workspace', runThread('14', undefined, undefined, EPOCH_PRE)), 1);
        const ops = frame(text('workspace', 'probing', runThread('17', '14', 'call-a', EPOCH_PRE)), 2);
        projector.settle('done', 9_000);

        expect(lateLabelPatches([ops])).toEqual([]);
        expect(rowsOf(projector.display())[1]).toEqual({
            id: 'turn-1:1',
            agent: 'workspace',
            agentLabel: '',
            invocationId: '17',
            state: 'cancelled'
        });
    });
});

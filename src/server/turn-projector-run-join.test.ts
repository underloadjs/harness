// R19 (2026-11-17): the invocation→conversation join is scoped to the invocation RUN.
//
// WHY THIS FILE EXISTS. An invocation id is `String(++runSequence)` from a PER-PROCESS counter
// (../harness.ts `runSequence`:8268; restore only RAISES it — :8153, `reserveIdentity`:8235), so
// a restarted harness mints `15` again for a DIFFERENT conversation. Before this change the store's
// join was keyed by that bare id with first-write-wins, so the post-restart run inherited the dead
// pre-restart conversation's entry — and, in the label pass, the two joins OVERWROTE each other.
// The operator's own board showed the result: one conversation's name printed on another
// conversation's row (`IT4` on a pre-restart `workspace` child whose conversation was `WE6`).
//
// WHAT IS PINNED (each item is the REQUIREMENT, not an observation):
//   T1  a frame carries the epoch of the process that minted its id (`HarnessThread.epoch`,
//       ../types/index.ts:3042), and the fold resolves BOTH joins — conversation id and
//       conversation label — under that run key (`invocationRunKeyOf`, ./protocol.ts), so two runs
//       wearing one recycled id get their OWN conversations.
//   T2  the ROOT row's conversation is the record's own statement (`turn.threadId` /
//       `turn.threadLabel`); an ambiguous recycled id can never rename the turn's conversation.
//   T3  a record with NO epoch anywhere — every turn recorded before the field existed — folds
//       exactly as it did before the join was scoped (the bare-id key is the only key, and the
//       same value wins).
//   T4  a join learned AFTER the row was folded still lands on the row that owns that RUN
//       (`syncThreadIds`), and a row of a different process is not handed the entry by accident.
//   T5  the fallback the store's live view implements (exact run key → BARE id) is what a
//       mid-upgrade record needs: a document whose join is bare-id keyed still names every
//       conversation it ever named, including for a row that carries an epoch.
//
// Event shapes are copied from what the runtime ACTUALLY records (../harness.ts
// `withThread`/`threadIdentity`): a delegated child carries `{ id, parentId, callId, input }` and
// every later frame of that run carries the identity fields alone; a host-thread root carries
// `{ id, input }` on `start`. The ids ('14'/'15', 'thread-13'/'thread-14') and labels
// ('IT4'/'WE6') are the values measured in the operator's recorded run
// (Temp/orch-plan/session.json, turn 319cfc1c), reduced to the smallest shape that shows the defect.
//
// Clock policy: one recorded event per 10 ms, so every timestamp below is an exact number.
//
// Run: yarn vitest run src/server/turn-projector-run-join.test.ts

import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '../harness';
import type { DisplayProjectContext, TurnDisplay } from '../shared/turn-display';
import type { SessionTurn } from './protocol';
import { invocationRunKeyOf } from './protocol';
import { createTurnProjector } from './turn-projector';

const EPOCH_PRE = 'epoch-pre-restart';
const EPOCH_POST = 'epoch-post-restart';

const turnOf = (overrides: Partial<SessionTurn> = {}): SessionTurn => ({
    id: 'turn-1',
    index: 0,
    prompt: 'stress test the tools',
    status: 'running',
    startedAt: 1_000,
    updatedAt: 1_000,
    events: [],
    eventTimes: [],
    // The turn's OWN conversation: the host thread that received the submit (the operator's
    // `thread-13` / `IT4`).
    threadId: 'thread-13',
    threadLabel: 'IT4',
    ...overrides
});

// The join exactly as the store now hands it: keyed by invocation RUN (../sessions.ts
// `Session.invocationThreads`, written by `noteInvocationThread` from the `start` frame's epoch).
const RUN_JOIN = (): Map<string, string> =>
    new Map([
        [invocationRunKeyOf('15', EPOCH_PRE), 'thread-14'],
        [invocationRunKeyOf('15', EPOCH_POST), 'thread-20']
    ]);

const RUN_LABELS = (): Map<string, string> =>
    new Map([
        [invocationRunKeyOf('15', EPOCH_PRE), 'WE6'],
        [invocationRunKeyOf('15', EPOCH_POST), 'WE9']
    ]);

// A PRE-CHANGE document: bare ids only, because no frame carried an epoch.
const LEGACY_JOIN = (): Map<string, string> => new Map([['15', 'thread-14']]);
const LEGACY_LABELS = (): Map<string, string> => new Map([['15', 'WE6']]);

const contextOf = (
    options: { threadIds?: ReadonlyMap<string, string>; labels?: ReadonlyMap<string, string> } = {}
): DisplayProjectContext => ({
    primary: 'instruct',
    ...(options.labels === undefined ? {} : { threadLabels: options.labels }),
    ...(options.threadIds === undefined ? {} : { invocationThreadIds: options.threadIds })
});

// --- recorded frame shapes, verbatim from the runtime ------------------------

/** A host-thread root `start`: `{ id, input }` plus the minting process's epoch. */
const rootStart = (invocationId: string, epoch: string | undefined, agent = 'instruct'): HarnessEvent => ({
    type: 'start',
    agent,
    model: 'local/basalt',
    thread: { id: invocationId, input: 'stress test the tools', ...(epoch === undefined ? {} : { epoch }) }
});

/** A delegated child's `start`: id + lineage + prompt + epoch, no `kind` (only branches set one). */
const childStart = (
    invocationId: string,
    parentId: string,
    callId: string,
    agent: string,
    epoch: string | undefined
): HarnessEvent => ({
    type: 'start',
    agent,
    model: 'local/basalt',
    thread: {
        id: invocationId,
        parentId,
        callId,
        input: 'keep going',
        ...(epoch === undefined ? {} : { epoch })
    }
});

/** The run's identity fields on every LATER frame (../harness.ts `threadIdentity`). */
const runThread = (
    invocationId: string,
    parentId: string | undefined,
    callId: string | undefined,
    epoch: string | undefined
): HarnessEvent['thread'] => ({
    id: invocationId,
    ...(parentId === undefined ? {} : { parentId }),
    ...(callId === undefined ? {} : { callId }),
    ...(epoch === undefined ? {} : { epoch })
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

// The fold, in the store's exact order (./sessions.ts records, then folds).
const fold = (events: HarnessEvent[], context: DisplayProjectContext, turn = turnOf()) => {
    const projector = createTurnProjector(turn, context);

    events.forEach((event, index) => {
        const stamp = 1_000 + index * 10;
        turn.events.push(event);
        turn.eventTimes?.push(stamp);
        projector.apply(event, stamp, index);
    });

    projector.settle('done', 9_000);

    return { projector, turn };
};

// One row's identity as a client sees it. Absent fields stay ABSENT, so `toEqual` is exact.
const rowsOf = (display: TurnDisplay) =>
    display.sections.map((section) => ({
        id: section.id,
        agent: section.agent,
        agentLabel: section.agentLabel,
        ...(section.invocationId === undefined ? {} : { invocationId: section.invocationId }),
        ...(section.threadId === undefined ? {} : { threadId: section.threadId }),
        state: section.state
    }));

describe('R19: a recycled invocation id binds to the conversation of its own process', () => {
    it('folds the pre-restart and post-restart runs of one id onto their own conversations', () => {
        const { projector } = fold(
            [
                // The main conversation's first run, in the FIRST process.
                rootStart('14', EPOCH_PRE),
                text('instruct', 'planning', runThread('14', undefined, undefined, EPOCH_PRE)),
                // The parent's `delegate` call opens a queued row for the child.
                delegateCall('call-pre', 'workspace', runThread('14', undefined, undefined, EPOCH_PRE)),
                // The child RUNS under invocation id 15, minted by the first process.
                childStart('15', '14', 'call-pre', 'workspace', EPOCH_PRE),
                text('workspace', 'probing read', runThread('15', '14', 'call-pre', EPOCH_PRE)),
                done('workspace', runThread('15', '14', 'call-pre', EPOCH_PRE)),
                // ---- the process dies here; a new one restarts the invocation counter ----
                // The main conversation's RESUMED run re-mints id 15 (root-shaped).
                rootStart('15', EPOCH_POST),
                // A different spawn in the new process re-mints the CALL id too, and its child
                // run lands on invocation id 15 of THIS process — a different conversation.
                delegateCall('call-post', 'workspace', runThread('15', undefined, undefined, EPOCH_POST)),
                childStart('15', '15', 'call-post', 'workspace', EPOCH_POST),
                text('workspace', 'probing write', runThread('15', '15', 'call-post', EPOCH_POST)),
                done('workspace', runThread('15', '15', 'call-post', EPOCH_POST))
            ],
            contextOf({ threadIds: RUN_JOIN(), labels: RUN_LABELS() })
        );

        // The exact answer the operator's board needed: the pre-restart child row wears `WE6`
        // (its own conversation), the post-restart child row wears `WE9`, and neither borrows the
        // other's name. Before the run-keyed join both rows resolved the single bare `15` entry.
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
                agentLabel: 'WE9',
                invocationId: '15',
                threadId: 'thread-20',
                state: 'done'
            }
        ]);
    });

    it('never lets an ambiguous recycled id rename the turn itself (T2)', () => {
        // The join names the DEAD conversation for a bare `15`, and the post-restart root-shaped
        // run carries an epoch the join has no entry for. The root row's identity is the RECORD's
        // own `threadId`/`threadLabel`, so the fold keeps `IT4`/`thread-13` regardless.
        const join = new Map<string, string>([['15', 'thread-14']]);
        const labels = new Map<string, string>([['15', 'WE6']]);

        const { projector } = fold(
            [
                rootStart('15', EPOCH_PRE),
                text('instruct', 'before', runThread('15', undefined, undefined, EPOCH_PRE)),
                done('instruct', runThread('15', undefined, undefined, EPOCH_PRE)),
                rootStart('15', EPOCH_POST),
                text('instruct', 'after', runThread('15', undefined, undefined, EPOCH_POST))
            ],
            contextOf({ threadIds: join, labels })
        );

        expect(rowsOf(projector.display())).toEqual([
            {
                id: 'turn-1:0',
                agent: 'instruct',
                agentLabel: 'IT4',
                invocationId: '15',
                threadId: 'thread-13',
                state: 'done'
            }
        ]);
        expect(projector.summary().threadLabel).toBe('IT4');
    });

    it('folds a record that names no epoch exactly as the pre-change fold did (T3)', () => {
        // Every recorded turn written before `HarnessThread.epoch` has this shape. The run key IS
        // the bare id, so the join resolves the entry the document holds — same conversation, same
        // label, same rows as before this change.
        const { projector } = fold(
            [
                rootStart('14', undefined),
                delegateCall('call-pre', 'workspace', runThread('14', undefined, undefined, undefined)),
                childStart('15', '14', 'call-pre', 'workspace', undefined),
                text('workspace', 'probing', runThread('15', '14', 'call-pre', undefined)),
                done('workspace', runThread('15', '14', 'call-pre', undefined))
            ],
            contextOf({ threadIds: LEGACY_JOIN(), labels: LEGACY_LABELS() })
        );

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
                id: 'turn-1:1',
                agent: 'workspace',
                agentLabel: 'WE6',
                invocationId: '15',
                threadId: 'thread-14',
                state: 'done'
            }
        ]);
    });

    it('patches a late join entry onto the row of its OWN run, not onto a row that merely shares the id (T4)', () => {
        // A live fold: the projector is built at the turn's first event and the join grows while
        // the run goes (../sessions.ts records the entry at the child's own `start`). The map is
        // LIVE, so this fixture mutates it between frames exactly as the recorder does.
        const join = new Map<string, string>([
            // The dead pre-restart binding, still in the restored document under its run key.
            [invocationRunKeyOf('15', EPOCH_PRE), 'thread-14']
        ]);
        const labels = new Map<string, string>([[invocationRunKeyOf('15', EPOCH_PRE), 'WE6']]);

        const turn = turnOf();
        const projector = createTurnProjector(turn, contextOf({ threadIds: join, labels }));
        const opsOf = (event: HarnessEvent, index: number) => {
            const stamp = 1_000 + index * 10;
            turn.events.push(event);
            turn.eventTimes?.push(stamp);

            return projector.apply(event, stamp, index);
        };

        // The pre-restart child row, folded with its own (correct) binding.
        opsOf(rootStart('14', EPOCH_PRE), 0);
        opsOf(delegateCall('call-pre', 'workspace', runThread('14', undefined, undefined, EPOCH_PRE)), 1);
        opsOf(childStart('15', '14', 'call-pre', 'workspace', EPOCH_PRE), 2);

        expect(rowsOf(projector.display())[1]).toEqual({
            id: 'turn-1:1',
            agent: 'workspace',
            agentLabel: 'WE6',
            invocationId: '15',
            threadId: 'thread-14',
            state: 'streaming'
        });

        // The new process re-mints id 15 for ANOTHER conversation, and its join entry arrives only
        // after the row exists — the late-join pass must attach `thread-20`, and must NOT let the
        // pre-restart entry answer for it.
        join.set(invocationRunKeyOf('16', EPOCH_POST), 'thread-20');
        labels.set(invocationRunKeyOf('16', EPOCH_POST), 'WE9');

        opsOf(delegateCall('call-post', 'workspace', runThread('14', undefined, undefined, EPOCH_POST)), 3);
        opsOf(childStart('16', '14', 'call-post', 'workspace', EPOCH_POST), 4);

        expect(rowsOf(projector.display())[2]).toEqual({
            id: 'turn-1:2',
            agent: 'workspace',
            agentLabel: 'WE9',
            invocationId: '16',
            threadId: 'thread-20',
            state: 'streaming'
        });

        // The pre-restart row is untouched by the new entry: same conversation, same name.
        expect(rowsOf(projector.display())[1]).toEqual({
            id: 'turn-1:1',
            agent: 'workspace',
            agentLabel: 'WE6',
            invocationId: '15',
            threadId: 'thread-14',
            state: 'streaming'
        });
    });
});

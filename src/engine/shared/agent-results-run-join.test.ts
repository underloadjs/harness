// W19 (2026-11-17) — A RESULT BLOCK IS ONE RUN, NOT ONE RECYCLABLE INVOCATION ID
//
// THE DEFECT, ON THE MODEL-FACING PLANE. `listAgentResultBlocks` folds a turn's recorded events into the
// blocks a client renders and `composeAgentResultPrompt` feeds back to the model. Blocks were keyed by
// `thread.id` — the BARE invocation id — and ./agent-results.ts:479 keys them by the RUN
// (`invocationRunKeyOf(thread.id, thread.epoch)`, `../shared/run-identity.ts`) for exactly one reason: the
// id is a per-process counter (`../harness.ts:8462`), so one recorded turn can hold two runs wearing it.
// Measured on the operator's own document BEFORE this change (`Temp/orch-plan/w19/fold-blocks-before.txt`,
// folds B and C): the block for invocation `15` carried the label `WE6` — the conversation of a child that
// died before the restart — while the run that re-minted `15` belongs to `IT4`, and fold (A) labelled the
// same number `IT4`. One number, two conversations, whichever key the store's join reached first.
//
// WHAT IS PINNED HERE — each item is the REQUIREMENT, not an observation:
//   1. two KNOWN epochs on one id are TWO blocks, each with its own conversation label and its own
//      answer — and both report the BARE id on the wire (`block.threadId`), because a composite key must
//      never reach a client or a model-facing tool result;
//   2. ONE-SIDED cases MERGE, never split, in the direction the data supports: a run whose EARLY frames
//      predate the field continues in the block those frames opened, so the run is never cut in two;
//   3. a record whose frames carry NO epoch is its own run — it is NOT merged into a block that a KNOWN
//      epoch already opened, which is what keeps a pre-restart record from being swallowed by the run that
//      re-minted its id;
//   4. a LEGACY join map (bare-id keys, the only keys a pre-change document holds) still resolves — the
//      bare fallback is the door those entries are reached through, and it is honest about what a bare
//      entry can say: it cannot pick between two runs, so both runs of the id read the same name;
//   5. a pre-change turn (no epoch anywhere, bare join) projects EXACTLY the blocks it projects today.
//
// Pure functions, literal events, exact values — the same style as `./agent-results.test.ts`. The expected
// boards were read off the projection itself (`Temp/orch-plan/w19/probe-blocks.ts`) and then checked
// against the requirements above: the labels are the point, and every one of them is a conversation name
// the FRAME's own run can justify.
//
// Cross-references:
//   - ./agent-results.ts:462-510 `blockForThread` (the run key + the label resolution)
//   - ../server/sessions.ts `invocationThreadLabels` / `labelJoinsOf` (the producer of the run-keyed map)
//   - ./run-identity.ts (the key rule), ../server/turn-projector.ts `isEpochBoundary`,
//     ../frontend/ui/turns.ts `runKeyOf` (the same one-sided rule on the other two planes)

import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '../harness';
import { listAgentResultBlocks } from './agent-results';
import type { AgentResultTurn } from './agent-results';
import { invocationRunKeyOf } from './run-identity';
// The current ledger generation, so the fixture states its run keys with the same constant the runtime
// stamps (the value is random per process, never a literal).
import { HARNESS_PROCESS_EPOCH } from '../core/agent-limits';

const assistant = (content: string): Extract<HarnessEvent, { type: 'done' }>['message'] => ({
    role: 'assistant',
    content,
    reasoning: '',
    toolCalls: [],
    model: 'scripted/test',
    stopReason: 'stop'
});

// The generation of a process that has already ended, and the join map a current store writes for the two
// runs of one id: the dead child's conversation `WE6`, the live one `IT9`.
const DEAD = 'epoch-pre-restart';

const JOIN_OF_BOTH_RUNS: Record<string, string> = {
    [invocationRunKeyOf('15', DEAD)]: 'WE6',
    [invocationRunKeyOf('15', HARNESS_PROCESS_EPOCH)]: 'IT9'
};

// One root run (`inv-root`, this process) that delegates TWICE, and both children wear invocation `15`:
// the first child ran in the dead generation, the second is the run that re-minted the id. `omitSecondEpoch`
// drops the epoch from the SECOND child's frames, which is the one-sided case.
const recycledTurn = (threadLabels: Record<string, string> | undefined, omitSecondEpoch = false): AgentResultTurn => {
    // The second child's frame metadata: with the epoch, or entirely without it.
    const second = (extra: Record<string, unknown>): Record<string, unknown> => ({
        id: '15',
        ...extra,
        ...(omitSecondEpoch ? {} : { epoch: HARNESS_PROCESS_EPOCH })
    });

    return {
        id: 'turn-run-join',
        status: 'done',
        threadLabel: 'IT4',
        ...(threadLabels === undefined ? {} : { threadLabels }),
        events: [
            {
                type: 'start',
                agent: 'Researcher',
                model: 'scripted/test',
                thread: { id: 'inv-root', input: 'go', epoch: HARNESS_PROCESS_EPOCH }
            },
            {
                type: 'tool_call',
                agent: 'Researcher',
                thread: { id: 'inv-root', epoch: HARNESS_PROCESS_EPOCH },
                call: { id: 'call_1', name: 'delegate', arguments: '{"agent":"Helper","input":"first"}' }
            },
            // --- the child of the DEAD generation ---
            {
                type: 'start',
                agent: 'Helper',
                model: 'scripted/test',
                thread: { id: '15', parentId: 'inv-root', callId: 'call_1', input: 'first', epoch: DEAD }
            },
            {
                type: 'text',
                agent: 'Helper',
                delta: 'dead child answer',
                thread: { id: '15', parentId: 'inv-root', callId: 'call_1', epoch: DEAD }
            },
            {
                type: 'done',
                agent: 'Helper',
                thread: { id: '15', parentId: 'inv-root', callId: 'call_1', epoch: DEAD },
                message: assistant('dead child answer')
            },
            {
                type: 'tool_result',
                agent: 'Researcher',
                name: 'delegate',
                callId: 'call_1',
                content: 'ok',
                isError: false
            },
            {
                type: 'tool_call',
                agent: 'Researcher',
                thread: { id: 'inv-root', epoch: HARNESS_PROCESS_EPOCH },
                call: { id: 'call_2', name: 'delegate', arguments: '{"agent":"Helper","input":"second"}' }
            },
            // --- the child that re-minted `15` (or names no epoch at all) ---
            {
                type: 'start',
                agent: 'Helper',
                model: 'scripted/test',
                thread: second({ parentId: 'inv-root', callId: 'call_2', input: 'second' })
            },
            {
                type: 'text',
                agent: 'Helper',
                delta: 'live child answer',
                thread: second({ parentId: 'inv-root', callId: 'call_2' })
            },
            {
                type: 'done',
                agent: 'Helper',
                thread: second({ parentId: 'inv-root', callId: 'call_2' }),
                message: assistant('live child answer')
            },
            {
                type: 'tool_result',
                agent: 'Researcher',
                name: 'delegate',
                callId: 'call_2',
                content: 'ok',
                isError: false
            },
            {
                type: 'done',
                agent: 'Researcher',
                thread: { id: 'inv-root', epoch: HARNESS_PROCESS_EPOCH },
                message: assistant('root answer')
            }
        ] as AgentResultTurn['events']
    };
};

// The projection the way a client and the model see it: label, the BARE invocation id, and the answer.
const board = (turn: AgentResultTurn): string[] =>
    listAgentResultBlocks([turn]).map((block) => `${block.label}:${block.threadId ?? 'root'}:${block.content}`);

describe('a result block is one invocation run', () => {
    it('gives the two runs of one recycled id their own block and their own label', () => {
        const turn = recycledTurn(JOIN_OF_BOTH_RUNS);

        // The headline: the post-restart run no longer wears the dead child's conversation name, and the
        // dead child keeps its own. Before the run key these two folds collapsed into ONE block.
        expect(board(turn)).toEqual(['IT4:root:root answer', 'WE6:15:dead child answer', 'IT9:15:live child answer']);

        // The wire stays BARE: a composite `id\0epoch` must never reach a client or a model-facing
        // result, so both blocks report the invocation id exactly as the runtime minted it.
        const childBlocks = listAgentResultBlocks([turn]).filter((block) => block.threadId === '15');

        expect(childBlocks.map((block) => block.threadId)).toEqual(['15', '15']);
        expect(childBlocks.map((block) => block.agent)).toEqual(['Helper', 'Helper']);
        expect(childBlocks.map((block) => block.status)).toEqual(['done', 'done']);
    });

    it('keeps one run in one block when its early frames predate the epoch field', () => {
        // One delegated child: `start`/first `text` carry no epoch (the record was written before the
        // field existed), the later frames carry this process's epoch. A run is ONE block, so the answer
        // stays together — this is the same continuity rule `../server/turn-projector.ts`
        // `isEpochBoundary` states, in the direction the data supports.
        const continuity: AgentResultTurn = {
            id: 'turn-continuity',
            status: 'done',
            threadLabel: 'IT4',
            threadLabels: JOIN_OF_BOTH_RUNS,
            events: [
                {
                    type: 'start',
                    agent: 'Researcher',
                    model: 'scripted/test',
                    thread: { id: 'inv-root', input: 'go', epoch: HARNESS_PROCESS_EPOCH }
                },
                {
                    type: 'tool_call',
                    agent: 'Researcher',
                    thread: { id: 'inv-root', epoch: HARNESS_PROCESS_EPOCH },
                    call: { id: 'call_1', name: 'delegate', arguments: '{"agent":"Helper","input":"first"}' }
                },
                {
                    type: 'start',
                    agent: 'Helper',
                    model: 'scripted/test',
                    thread: { id: '15', parentId: 'inv-root', callId: 'call_1', input: 'first' }
                },
                {
                    type: 'text',
                    agent: 'Helper',
                    delta: 'early words',
                    thread: { id: '15', parentId: 'inv-root', callId: 'call_1' }
                },
                {
                    type: 'text',
                    agent: 'Helper',
                    delta: ' late words',
                    thread: { id: '15', parentId: 'inv-root', callId: 'call_1', epoch: HARNESS_PROCESS_EPOCH }
                },
                {
                    type: 'done',
                    agent: 'Helper',
                    thread: { id: '15', parentId: 'inv-root', callId: 'call_1', epoch: HARNESS_PROCESS_EPOCH },
                    message: assistant('early words late words')
                },
                {
                    type: 'tool_result',
                    agent: 'Researcher',
                    name: 'delegate',
                    callId: 'call_1',
                    content: 'ok',
                    isError: false
                },
                {
                    type: 'done',
                    agent: 'Researcher',
                    thread: { id: 'inv-root', epoch: HARNESS_PROCESS_EPOCH },
                    message: assistant('root answer')
                }
            ]
        };

        // ONE block, ONE merged answer. Its label is the provisional per-invocation number the spawning
        // call minted (`HR1`), because the label is resolved when the block OPENS — from the epoch-less
        // `start` frame, which can only ask for the bare key, and this join map names runs. A live store
        // never produces this shape: its `start` frame carries the epoch, so the block opens named.
        expect(board(continuity)).toEqual(['IT4:root:root answer', 'HR1:15:early words late words']);
    });

    it('does not merge an epoch-less record into the block of a known run', () => {
        // The other one-sided case, and the one the defect needed: a record that names NO epoch is a run
        // of its own. Folding it into the block a KNOWN epoch opened would put the pre-change answer
        // inside the post-restart run's block — the misattribution the run key exists to stop.
        expect(board(recycledTurn(JOIN_OF_BOTH_RUNS, true))).toEqual([
            'IT4:root:root answer',
            'WE6:15:dead child answer',
            // `HR2`, not `HR1`: the per-invocation mint is sequential over the turn's delegations, and
            // `HR1` was the first child's provisional number before the join renamed it `WE6`. The point
            // of the pin is that the epoch-less record gets its OWN block and NO conversation name it
            // cannot justify.
            'HR2:15:live child answer'
        ]);
    });

    it('resolves a pre-change (bare-id) join map for frames that DO carry epochs', () => {
        // A document whose JOIN predates the scoping while its frames do not. Both runs fall back to the
        // one bare entry, because a bare entry cannot say which of two runs it names — the blocks still
        // split (the frames carry the discrimination), and no conversation name is invented.
        expect(board(recycledTurn({ '15': 'WE6' }))).toEqual([
            'IT4:root:root answer',
            'WE6:15:dead child answer',
            'WE6:15:live child answer'
        ]);
    });

    it('resolves a partially migrated join map: a run-keyed entry for one run, a bare entry for the other', () => {
        // What a store mid-migration actually holds: the pre-change bare entry plus the run-keyed entry
        // the current process wrote. Each side is reached through its own door, and neither overwrites
        // the other — the same first-write-wins authority order `../server/sessions.ts` `labelJoinsOf`
        // documents.
        expect(board(recycledTurn({ '15': 'WE6', ...JOIN_OF_BOTH_RUNS }, true))).toEqual([
            'IT4:root:root answer',
            'WE6:15:dead child answer',
            'WE6:15:live child answer'
        ]);
    });

    it('projects a pre-change turn exactly as it does today', () => {
        // No epoch on any frame and a bare-id join: one block for the id, labelled from the bare entry —
        // the shape `./agent-results.test.ts:506` pins for this fixture family, unchanged by the run key.
        const legacy: AgentResultTurn = {
            id: 'turn-legacy',
            status: 'done',
            threadLabel: 'RR4',
            threadLabels: { 'inv-child': 'RR5' },
            events: [
                {
                    type: 'start',
                    agent: 'Researcher',
                    model: 'scripted/test',
                    thread: { id: 'inv-root', input: 'go' }
                },
                {
                    type: 'tool_call',
                    agent: 'Researcher',
                    thread: { id: 'inv-root' },
                    call: { id: 'call_1', name: 'delegate', arguments: '{"agent":"Helper","input":"child"}' }
                },
                {
                    type: 'start',
                    agent: 'Helper',
                    model: 'scripted/test',
                    thread: { id: 'inv-child', parentId: 'inv-root', callId: 'call_1', input: 'child' }
                },
                {
                    type: 'done',
                    agent: 'Helper',
                    thread: { id: 'inv-child', parentId: 'inv-root', callId: 'call_1' },
                    message: assistant('child answer')
                },
                {
                    type: 'tool_result',
                    agent: 'Researcher',
                    name: 'delegate',
                    callId: 'call_1',
                    content: 'ok',
                    isError: false
                },
                { type: 'done', agent: 'Researcher', thread: { id: 'inv-root' }, message: assistant('root answer') }
            ]
        };

        expect(board(legacy)).toEqual(['RR4:root:root answer', 'RR5:inv-child:child answer']);
    });
});

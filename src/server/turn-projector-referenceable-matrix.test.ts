// T-C4 (2026-11-26) — THE NO-BROKEN-CHIPS MATRIX, SERVER PROJECTION HALF.
//
// The twin of two other proofs, all three reading the SAME rule:
//   - the picker's gate          — ../../../loadscript/harness/src/frontend/ui/references.ts
//                                  `isReferenceableBlock` (accepted by
//                                  ../../../loadscript/harness/src/frontend/ui/references.test.ts);
//   - the client projector       — ../../../loadscript/harness/src/server/turn-projector.ts, pinned by
//                                  ../../../loadscript/harness/src/frontend/ui/turn-projector-referenceable-matrix.test.ts;
//   - THIS FILE                  — the server projector's own `TurnSummary.blocks[].referenceable`,
//                                  the boolean the wire ships in `DisplayBlockSummary`
//                                  (../harness-server.swagger.yaml) so a reader applies one flag
//                                  instead of restating a status rule.
//
// WHY IT MATTERS THAT ALL THREE READ ONE RULE. The wire flag is what a board filters its `#`
// popup on; the gate is what mints the chip; `bindReference` (./sessions.ts) is what accepts it.
// Before this fold the projector still asserted the PRE-relaxation rule
// (`done || running || queued`) while the gate and the doors accepted every status, so the board
// hid exactly the rows the operator was told to name — a failed child, a stopped run, an attempt
// that never started. The rule is now the ONE label parser (`agentLabelParts` →
// `AGENT_REFERENCE_LABEL_PATTERN`), so the two twins differ nowhere in this behavior, and the
// table below is the proof: the same five rows and the same drop shapes as the client twin.
//
// Run: yarn vitest run src/server/turn-projector-referenceable-matrix.test.ts

import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '../engine/harness';
import type { AgentResultBlock } from '../engine/shared/agent-results';
import type { DisplayProjectContext } from '../engine/shared/turn-display';
import type { SessionTurn } from './protocol';
import { createTurnProjector } from './turn-projector';

// Every status the block projection can put on a row, in the order the wire enum lists them.
const STATUSES: readonly AgentResultBlock['status'][] = ['done', 'running', 'queued', 'error', 'cancelled'];

const CONTEXT: DisplayProjectContext = { entry: 'one' };

const turnOf = (status: SessionTurn['status']): SessionTurn => ({
    id: 'turn-1',
    index: 0,
    prompt: 'do the thing',
    status,
    startedAt: 1_000,
    updatedAt: 1_000,
    events: [],
    eventTimes: []
});

// The store's own seam: block rows arrive through `blocksOf` (./sessions.ts `blocksFor`), so what
// is asserted below is the summary the route ships, not a restatement of the input.
const summaryBlocksOf = (block: AgentResultBlock, status: SessionTurn['status']) => {
    const turn = turnOf(status);
    const projector = createTurnProjector(turn, {
        ...CONTEXT,
        blocksOf: () => [block]
    });
    const event = { type: 'start', agent: 'one', model: 'gpt-x' } as HarnessEvent;

    turn.events.push(event);
    turn.eventTimes?.push(1_010);
    projector.apply(event, 1_010, 0);

    return projector.summary().blocks;
};

describe('the referenceable summary flag is the picker rule, not a status list', () => {
    it('marks every status the server binds as referenceable — the terminal relaxation, row by row', () => {
        // One row per matrix row, each asserted with the EXACT summary object the route ships.
        // `done` was already true; the four others are what this fold changed.
        expect(
            summaryBlocksOf({ turnId: 'turn-1', label: 'RR1', agent: 'one', status: 'done', content: 'the answer' }, 'done')
        ).toEqual([
            { turnId: 'turn-1', label: 'RR1', agent: 'one', status: 'done', preview: 'the answer', referenceable: true }
        ]);

        expect(
            summaryBlocksOf(
                { turnId: 'turn-1', label: 'RR1', agent: 'one', status: 'running', content: 'the answer' },
                'running'
            )
        ).toEqual([
            { turnId: 'turn-1', label: 'RR1', agent: 'one', status: 'running', preview: 'the answer', referenceable: true }
        ]);

        expect(
            summaryBlocksOf({ turnId: 'turn-1', label: 'RR1', agent: 'one', status: 'queued', content: 'the answer' }, 'queued')
        ).toEqual([
            { turnId: 'turn-1', label: 'RR1', agent: 'one', status: 'queued', preview: 'the answer', referenceable: true }
        ]);

        expect(
            summaryBlocksOf(
                { turnId: 'turn-1', label: 'RR1', agent: 'one', status: 'error', content: 'the answer' },
                'error'
            )
        ).toEqual([
            { turnId: 'turn-1', label: 'RR1', agent: 'one', status: 'error', preview: 'the answer', referenceable: true }
        ]);

        expect(
            summaryBlocksOf(
                { turnId: 'turn-1', label: 'RR1', agent: 'one', status: 'cancelled', content: 'the answer' },
                'cancelled'
            )
        ).toEqual([
            {
                turnId: 'turn-1',
                label: 'RR1',
                agent: 'one',
                status: 'cancelled',
                preview: 'the answer',
                referenceable: true
            }
        ]);
    });

    it('marks a terminal row that recorded NO result as referenceable, with no preview key', () => {
        // THE NEVER-STARTED-ATTEMPT SHAPE, on the wire: the row the block projection keeps with its
        // minted ordinal (F11) and no content. It binds (./sessions.ts `bindReference`) and
        // composes `referencedResultUnavailableNote`, so hiding it here would strand the very
        // address the user is told to type. Exact equality also pins the ABSENT `preview` key.
        expect(
            summaryBlocksOf(
                { turnId: 'turn-1', threadId: 'call:call_1', label: 'HR2', agent: 'two', status: 'error' },
                'error'
            )
        ).toEqual([
            { turnId: 'turn-1', threadId: 'call:call_1', label: 'HR2', agent: 'two', status: 'error', referenceable: true }
        ]);
    });

    it('refuses a row whose label is not an address, in every status', () => {
        // The label clause is the WHOLE filter, and it is the shared parser rather than a
        // special case: `T?` is the pre-F11 placeholder an older record still carries, `RR0` an
        // ordinal the grammar rejects, and `branch-3` a branch identity that was never an address.
        // Dropping them here is the projector half of "no chip is minted that 400s at submit" —
        // the server's list reader rejects the ENTIRE reference array when one label is malformed.
        const unaddressable = ['T?', 'RR0', 'branch-3', ''];

        for (const status of STATUSES) {
            expect(
                unaddressable.map((label) =>
                    summaryBlocksOf({ turnId: 'turn-1', label, agent: 'one', status, content: 'the answer' }, status)[0]
                        .referenceable
                ),
                `status ${status}`
            ).toEqual([false, false, false, false]);

            // …while a real ordinal is referenceable in the SAME status, which is what makes the
            // four `false` above a verdict about the label rather than about the status.
            expect(
                summaryBlocksOf({ turnId: 'turn-1', label: 'RR12', agent: 'one', status, content: 'the answer' }, status)[0]
                    .referenceable
            ).toBe(true);
        }
    });

    it('keeps every row referenceable across the settle pass of a cancelled turn', () => {
        // THE SETTLE HALF OF THE SERVER INVARIANT, stated on the projector: once the turn is
        // terminal, EVERY row it renders — including one the run left unfinished (the second row
        // below, no content) — keeps its addressable flag, so no row the flag offers can trip the
        // `still queued/running` door in ./sessions.ts `bindReference`. WHICH terminal status a row
        // wears is the block fold's business (../engine/shared/agent-results.ts, pinned row by row in
        // ./references.test.ts); what this pins is that the wire summary never withholds the flag
        // from a settled row, and that `settle` does not recompute it away.
        const turn = turnOf('cancelled');
        const rows: AgentResultBlock[] = [
            { turnId: 'turn-1', label: 'RR1', agent: 'one', status: 'cancelled', content: 'partial' },
            { turnId: 'turn-1', threadId: 'call:call_1', label: 'RR2', agent: 'one', status: 'cancelled' }
        ];
        const projector = createTurnProjector(turn, { ...CONTEXT, blocksOf: () => rows });
        const events = [
            { type: 'start', agent: 'one', model: 'gpt-x' },
            { type: 'text', agent: 'one', delta: 'partial' }
        ] as HarnessEvent[];

        events.forEach((event, index) => {
            turn.events.push(event);
            turn.eventTimes?.push(1_010 + index * 10);
            projector.apply(event, 1_010 + index * 10, index);
        });
        projector.settle('cancelled', 5_000);

        expect(projector.summary().blocks).toEqual([
            {
                turnId: 'turn-1',
                label: 'RR1',
                agent: 'one',
                status: 'cancelled',
                preview: 'partial',
                referenceable: true
            },
            {
                turnId: 'turn-1',
                threadId: 'call:call_1',
                label: 'RR2',
                agent: 'one',
                status: 'cancelled',
                referenceable: true
            }
        ]);
    });
});

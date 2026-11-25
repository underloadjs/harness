// F6 (2026-11-25) — A BLOCK LABEL IS AN ADDRESS, SO ONLY ITS OWNER MINTS ONE.
//
// THE DEFECT, ON THE PROJECTION PLANE. `blocksOfTurn` minted a per-agent ordinal for EVERY
// block it opened, including runs that can never own a durable conversation. Measured on the
// operator's own session (`Temp/fix-f3/replay-after.out`, session `e513eed7`, turn
// `caaa372e…` = index 8): the block projection printed
// `IT13 IT14 IT15 IT16 IT17 IT18 IT19 WE12` for `branch-3`/`branch-4`/`branch-5` runs and for
// `delegate` placeholders whose child never started (every one of them ZERO characters), plus a
// SECOND `RR9` — a threadless `inline:reviewer` block minting the number `thread-57` owns — and
// `collectAgentLabelCounters` fed all of it back into `labelHighWater`
// (../server/sessions.ts `mergeLabelHighWater`/`labelSeedOf`), so the durable `IT` high-water
// reached 20 with only IT1-IT8, IT12 and IT20 owned. That is the user's "some threads have no
// label, like IT13, IT15 etc… some are empty in total".
//
// WHAT IS PINNED HERE — each item is the requirement, not an observation:
//   G1. a branch run, a never-started placeholder, and any other block that owns no
//       conversation consumes NO ordinal, and the number it tentatively took is NOT
//       re-hydrated into the counters a restored session starts from;
//   G2. such a block still carries an honest, STABLE identity — `UNADDRESSABLE_BLOCK_LABEL`
//       (`T?`, the same unknown token the client already uses, ../
//       ../../../../../loadscript/harness/src/frontend/ui/threads.ts `UNKNOWN_THREAD_LABEL`) —
//       which every address-resolving helper rejects, so it can never be referenced BY;
//   G3. no duplicate addressable label may be minted for a conversation that does not own it:
//       a minted number already shown by THIS record for a conversation is skipped;
//   G4. blocks that DO own a label keep the exact numbers they keep today (conversation
//       adoption, continuations, legacy inline blocks, and a live pending delegation).
//   G5. (F10 / R10.3) a number this projection MINTED for a run the join never names may not
//       raise the durable per-code counters at all — only an owned conversation label and a
//       turn's own recorded seed may, and a record with NO join view keeps the legacy rule.
//
// Pure functions, literal events, exact values — the same style as ./agent-results.test.ts and
// ./agent-results-run-join.test.ts. The fixtures are the shapes the live session produced, not
// the 300 MB dump itself.
//
// Cross-references:
//   - ./agent-results.ts `UNADDRESSABLE_BLOCK_LABEL`, `blocksOfTurn` (the claimed set, the
//     branch test, the never-started-placeholder pass) and `collectAgentLabelCounters`
//   - ../core/branch.ts:142 `createBranchId` (the `branch-N` id), ../core/thread.ts
//     `resolveThreadAddressOf` (a label matched exactly, ambiguity refused)
//   - ../server/sessions.ts `labelJoinsOf`/`liveThreadLabel` (the join that never names a
//     branch), `mergeLabelHighWater`/`labelSeedOf` (the hydration this closes)
//   - ../../../../../loadscript/harness/src/shared/agent-results.ts (the client copy, kept in
//     step; pinned by ../../../../loadscript/harness/src/frontend/agent-results-block-identity.test.ts)

import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '../harness';
import {
    UNADDRESSABLE_BLOCK_LABEL,
    agentLabelParts,
    collectAgentLabelCounters,
    findAgentResultBlock,
    findLatestAgentResultBlock,
    listAgentResultBlocks,
    normalizeAgentLabel,
    readAgentResultReferenceList
} from './agent-results';
import type { AgentResultTurn } from './agent-results';

const assistant = (content: string): Extract<HarnessEvent, { type: 'done' }>['message'] => ({
    role: 'assistant',
    content,
    reasoning: '',
    toolCalls: [],
    model: 'scripted/test',
    stopReason: 'stop'
});

// The label board, in projection order: what a client renders and what a chip binds.
const board = (turns: readonly AgentResultTurn[]): string[] =>
    listAgentResultBlocks(turns).map((block) => `${block.label}:${block.threadId ?? 'root'}:${block.status}`);

// The durable water, read as a value rather than an entry list so the assertion never depends
// on the order the codes happened to be first seen in.
const water = (turns: readonly AgentResultTurn[]): Record<string, number> =>
    Object.fromEntries(collectAgentLabelCounters(turns));

// ---------------------------------------------------------------------------
// G1 + G2 — the two run kinds that own no conversation, in one settled turn.
// ---------------------------------------------------------------------------

// The measured shape: a host conversation `IT1`, ONE delegation whose child never started, and
// ONE threadFork branch. In the live session the placeholder and the branch both printed an
// ordinal (`IT13`, `IT14`) and both had nothing in them.
const stressTurn = (overrides: Partial<AgentResultTurn> = {}): AgentResultTurn => ({
    id: 'turn-stress',
    status: 'done',
    threadLabel: 'IT1',
    events: [
        { type: 'start', agent: 'instruct', model: 'scripted/test', thread: { id: '67', input: 'go' } },
        {
            type: 'tool_call',
            agent: 'instruct',
            thread: { id: '67' },
            call: { id: 'call_1', name: 'delegate', arguments: '{"agent":"ghost","input":"never ran"}' }
        },
        // The parent's result for the spawning call is what settles the child: the record holds
        // NO frame of the child itself, so there is no run to name.
        {
            type: 'tool_result',
            agent: 'instruct',
            name: 'delegate',
            callId: 'call_1',
            content: 'child never started',
            isError: true
        },
        // A threadFork branch: live-only identity (`kind`/`branchId`, and the generated
        // `branch-N` invocation id), never in the store's run→conversation join.
        {
            type: 'start',
            agent: 'instruct',
            model: 'scripted/test',
            thread: { id: 'branch-3', parentId: '67', kind: 'fork', branchId: 'branch-3', input: 'fork task' }
        },
        {
            type: 'branch_end',
            agent: 'instruct',
            status: 'completed',
            thread: { id: 'branch-3', parentId: '67', kind: 'fork', branchId: 'branch-3' }
        },
        {
            type: 'done',
            agent: 'instruct',
            thread: { id: '67' },
            message: assistant('root answer')
        }
    ],
    ...overrides
});

describe('a block that owns no conversation consumes no ordinal (G1)', () => {
    it('shows the unknown identity for a never-started delegation and a branch run', () => {
        // Exact descriptors: the real ids survive (`call:<callId>`, `branch-N`) so the row is
        // still identifiable and readable; only the fabricated address is gone.
        expect(listAgentResultBlocks([stressTurn()])).toEqual([
            {
                turnId: 'turn-stress',
                label: 'IT1',
                agent: 'instruct',
                status: 'done',
                content: 'root answer'
            },
            {
                turnId: 'turn-stress',
                threadId: 'call:call_1',
                label: 'T?',
                agent: 'ghost',
                status: 'error'
            },
            {
                turnId: 'turn-stress',
                threadId: 'branch-3',
                label: 'T?',
                agent: 'instruct',
                status: 'done'
            }
        ]);
    });

    it('advances NO per-agent counter for them — the IT and HR water stays where its owners put it', () => {
        // Before the fix this map was `{ IT: 2, HR: 1 }`: `IT2` was the branch's number and
        // `HR1` the placeholder's, and neither label was ever shown. `IT1` is here because the
        // conversation OWNS it.
        expect(water([stressTurn()])).toEqual({ IT: 1 });
    });

    it('keeps that state through a snapshot-restore cycle — the leak is never re-hydrated', () => {
        // The restore path is the server's: `labelSeedOf` records the collected counters as the
        // NEXT turn's `labels` seed (../server/sessions.ts), and `blocksOfTurn` re-seeds from it.
        const first = collectAgentLabelCounters([stressTurn()]);
        const restored = stressTurn({ labels: Object.fromEntries(first) });

        // Identical board (no renumbering, no new number per render) and identical water (the
        // tentative `HR1` did not come back as a durable tombstone).
        expect(board([restored])).toEqual(board([stressTurn()]));
        expect(water([restored])).toEqual({ IT: 1 });
        expect(water([stressTurn(), restored])).toEqual({ IT: 1 });
    });

    it('does not mint for a branch even when the branch produced content and a whole turn of it', () => {
        // `IT17` in the measured session was a COMPLETED branch with an answer. A result is still
        // not a conversation: `agentResult`/`threadRead` address it by the `branch-N` ID, which
        // the descriptor carries, while `#LABEL` addresses conversations only.
        const branchOnly: AgentResultTurn = {
            id: 'turn-branch-only',
            status: 'done',
            threadLabel: 'IT5',
            events: [
                { type: 'start', agent: 'instruct', model: 'scripted/test', thread: { id: '70', input: 'go' } },
                {
                    type: 'start',
                    agent: 'instruct',
                    model: 'scripted/test',
                    thread: { id: 'branch-9', parentId: '70', kind: 'fork', branchId: 'branch-9', input: 'fork' }
                },
                {
                    type: 'done',
                    agent: 'instruct',
                    thread: { id: 'branch-9', parentId: '70', kind: 'fork', branchId: 'branch-9' },
                    message: assistant('branch answer')
                },
                {
                    type: 'done',
                    agent: 'instruct',
                    thread: { id: '70' },
                    message: assistant('root answer')
                }
            ]
        };

        expect(
            listAgentResultBlocks([branchOnly]).map((block) => `${block.label}:${block.threadId ?? 'root'}`)
        ).toEqual(['IT5:root', 'T?:branch-9']);
        expect(water([branchOnly])).toEqual({ IT: 5 });
    });

    it('recognises a branch by the fields the record actually carries, in every spelling', () => {
        // The three ways a branch frame says what it is (../types/index.ts `HarnessThread`):
        // `branchId`, `kind: 'fork' | 'autoanswer'`, and — for every record predating those
        // fields — the generated `branch-N` invocation id itself.
        const shapes: Array<Record<string, unknown>> = [
            { id: 'branch-1', parentId: '70', branchId: 'branch-1' },
            { id: 'branch-2', parentId: '70', kind: 'fork' },
            { id: 'branch-3', parentId: '70', kind: 'autoanswer' },
            // A pre-`kind` record: id only.
            { id: 'branch-4', parentId: '70' }
        ];

        for (const thread of shapes) {
            const turn: AgentResultTurn = {
                id: 'turn-shape',
                status: 'done',
                threadLabel: 'IT5',
                events: [
                    { type: 'start', agent: 'instruct', model: 'scripted/test', thread: { id: '70' } },
                    {
                        type: 'done',
                        agent: 'instruct',
                        thread: thread as HarnessEvent['thread'],
                        message: assistant('branch answer')
                    },
                    { type: 'done', agent: 'instruct', thread: { id: '70' }, message: assistant('root answer') }
                ]
            };

            const blocks = listAgentResultBlocks([turn]);

            expect(blocks.map((block) => block.label)).toEqual(['IT5', UNADDRESSABLE_BLOCK_LABEL]);
            expect(water([turn])).toEqual({ IT: 5 });
        }
    });
});

describe('the fallback identity is honest and stable (G2)', () => {
    const turns = [stressTurn()];
    const blocks = listAgentResultBlocks(turns);

    it('is the token the codebase already declares for an unknown identity', () => {
        // The client renders the SAME token for a thread row whose identity is not knowable
        // (loadscript ui/threads.ts `UNKNOWN_THREAD_LABEL`), so there is one unknown shape.
        expect(UNADDRESSABLE_BLOCK_LABEL).toBe('T?');
    });

    it('parses as nothing, so no address door accepts it', () => {
        expect(normalizeAgentLabel('T?')).toBeUndefined();
        expect(agentLabelParts('T?')).toBeUndefined();
        // …and the exact-lookup helpers reject a reference that carries it.
        expect(findAgentResultBlock(turns, { turnId: 'turn-stress', threadId: 'branch-3', label: 'T?' }))
            .toBeUndefined();
        expect(findLatestAgentResultBlock(turns, 'T?')).toBeUndefined();
        // A submitted/persisted reference list carrying it is a malformed payload, not a miss.
        expect(() =>
            readAgentResultReferenceList([{ turnId: 'turn-stress', threadId: 'branch-3', label: 'T?' }])
        ).toThrow(new TypeError('references[0].label must be a block label such as "IT1".'));
    });

    it('is stable across re-projections of the same run — no new number per render', () => {
        const first = board(turns);

        expect(board(turns)).toEqual(first);
        expect(board(turns)).toEqual(first);
        // Restoring the collected counters and re-projecting is the cold-read case, and it lands
        // on the SAME board (a per-render mint would move these labels).
        const seed = Object.fromEntries(collectAgentLabelCounters(turns));

        expect(board([stressTurn({ labels: seed })])).toEqual(first);
    });

    it('is the SAME token for both unknown kinds, and each block still names its real id', () => {
        const unknown = blocks.filter((block) => block.label === UNADDRESSABLE_BLOCK_LABEL);

        expect(unknown.map((block) => `${block.agent}:${block.threadId}:${block.status}`)).toEqual([
            'ghost:call:call_1:error',
            'instruct:branch-3:done'
        ]);
    });
});

// ---------------------------------------------------------------------------
// G3 — the second `RR9`: one turn may never print one address twice.
// ---------------------------------------------------------------------------

describe('a minted number never collides with a conversation this record shows (G3)', () => {
    // The measured collision: turn 8 ran in conversation `IT12`; a `reviewer` run in another
    // agent's DEFAULT conversation carries no thread metadata at all, so it projects as the
    // threadless `inline:` block, and the per-run mint landed on `RR9` — the name `thread-57`
    // owns through the join (run `76`). `RR` was already at 8 when it minted (the recorded seed).
    const collisionTurn: AgentResultTurn = {
        id: 'turn-8',
        status: 'done',
        threadLabel: 'IT12',
        labels: { RR: 8 },
        threadLabels: { '76': 'RR9' },
        events: [
            { type: 'start', agent: 'instruct', model: 'scripted/test', thread: { id: '67', input: 'go' } },
            { type: 'start', agent: 'reviewer', model: 'scripted/test' },
            { type: 'text', agent: 'reviewer', delta: 'side answer' },
            { type: 'done', agent: 'reviewer', message: assistant('side answer') },
            {
                type: 'start',
                agent: 'reviewer',
                model: 'scripted/test',
                thread: { id: '76', parentId: '67', input: 'delegated' }
            },
            {
                type: 'done',
                agent: 'reviewer',
                thread: { id: '76', parentId: '67' },
                message: assistant('thread answer')
            },
            { type: 'done', agent: 'instruct', thread: { id: '67' }, message: assistant('root answer') }
        ]
    };

    it('skips the conversation name and gives the threadless block the next free ordinal', () => {
        expect(listAgentResultBlocks([collisionTurn])).toEqual([
            {
                turnId: 'turn-8',
                label: 'IT12',
                agent: 'instruct',
                status: 'done',
                content: 'root answer'
            },
            {
                turnId: 'turn-8',
                threadId: 'inline:reviewer',
                label: 'RR10',
                agent: 'reviewer',
                status: 'done',
                content: 'side answer'
            },
            {
                turnId: 'turn-8',
                threadId: '76',
                label: 'RR9',
                agent: 'reviewer',
                status: 'done',
                content: 'thread answer'
            }
        ]);

        // One label, one block — the property ../core/thread.ts `resolveThreadAddressOf` needs to
        // refuse ambiguity rather than guess.
        const labels = listAgentResultBlocks([collisionTurn]).map((block) => block.label);

        expect(new Set(labels).size).toBe(labels.length);
    });

    it('reserves every number it displayed that a conversation owns, and nothing above that', () => {
        // F10 (R10.3): "above both" is now "above both OWNED names". `RR9` is `thread-57`'s
        // conversation, so it stays in the water; the threadless block's `RR10` is an ordinal NO
        // conversation owns (the join names nothing above RR9), and the operator's session showed
        // exactly such numbers becoming permanent (`WE:12` durable while the join stops at WE11).
        // The number is still DISPLAYED, still resolvable by `findAgentResultBlock`, and still
        // skipped inside this turn — it just cannot inflate the durable counter.
        expect(water([collisionTurn])).toEqual({ IT: 12, RR: 9 });
    });

    it('still resolves the conversation by its own name, and the threadless block by its new one', () => {
        expect(findLatestAgentResultBlock([collisionTurn], '#RR9')).toEqual({
            turnId: 'turn-8',
            threadId: '76',
            label: 'RR9',
            agent: 'reviewer',
            status: 'done',
            content: 'thread answer'
        });
        expect(
            findAgentResultBlock([collisionTurn], {
                turnId: 'turn-8',
                threadId: 'inline:reviewer',
                label: 'RR10'
            })
        ).toEqual({
            turnId: 'turn-8',
            threadId: 'inline:reviewer',
            label: 'RR10',
            agent: 'reviewer',
            status: 'done',
            content: 'side answer'
        });
        // The old ambiguous binding resolves NOTHING rather than silently picking one of two.
        expect(
            findAgentResultBlock([collisionTurn], { turnId: 'turn-8', threadId: 'inline:reviewer', label: 'RR9' })
        ).toBeUndefined();
    });

    it('does not claim a session-wide name this turn cannot resolve', () => {
        // `turn.threadLabels` is a SESSION-wide join. Claiming every name in it would renumber a
        // legacy block whose number was legitimate when it was recorded, so a claim is only made
        // for an entry THIS turn's frames can actually resolve.
        const legacy: AgentResultTurn = {
            id: 'turn-legacy',
            status: 'done',
            labels: { RR: 8 },
            // A conversation created in a LATER turn, whose run this turn never mentions.
            threadLabels: { '99': 'RR9' },
            events: [
                { type: 'start', agent: 'reviewer', model: 'scripted/test' },
                { type: 'done', agent: 'reviewer', message: assistant('legacy answer') }
            ]
        };

        // Nothing here identifies run `99`, so `RR9` stays a LIVE name and the legacy rule hands it
        // to the root agent that matches the child (`agent: 'reviewer'`). Claiming it as a
        // completed conversation would renumber a block whose number was legitimate when recorded.
        expect(
            listAgentResultBlocks([legacy]).map((block) => `${block.label}:${block.threadId ?? 'root'}`)
        ).toEqual(['RR9:root']);
        expect(water([legacy])).toEqual({ RR: 9 });
    });
});

// ---------------------------------------------------------------------------
// G4 — every block that OWNS a label keeps the number it has today.
// ---------------------------------------------------------------------------

describe('owned labels keep their exact numbering (G4)', () => {
    it('adopts the recorded conversation labels for a root and a nested child, and burns nothing else', () => {
        // The ./agent-results-run-join.test.ts:294 fixture, unchanged in shape. The `Helper`
        // placeholder's tentative `HR1` is handed back to the join, so no `HR` tombstone is left
        // behind — the number was never on screen.
        const turn: AgentResultTurn = {
            id: 'turn-r8',
            status: 'done',
            threadLabel: 'RR4',
            threadLabels: { 'inv-child': 'RR5' },
            events: [
                { type: 'start', agent: 'Researcher', model: 'scripted/test', thread: { id: 'inv-root', input: 'go' } },
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
                {
                    type: 'done',
                    agent: 'Researcher',
                    thread: { id: 'inv-root' },
                    message: assistant('root answer')
                }
            ]
        };

        expect(board([turn])).toEqual(['RR4:root:done', 'RR5:inv-child:done']);
        expect(water([turn])).toEqual({ RR: 5 });
    });

    it('reserves the ordinal an ADOPTED conversation label takes over, so a later block cannot reuse it', () => {
        // Without the reservation on the adoption path a same-code block opened after the child
        // would be minted the number the child's conversation already shows.
        const turn: AgentResultTurn = {
            id: 'turn-adopt-order',
            status: 'done',
            threadLabel: 'RR4',
            threadLabels: { 'inv-child': 'RR7' },
            events: [
                { type: 'start', agent: 'Researcher', model: 'scripted/test', thread: { id: 'inv-root', input: 'go' } },
                {
                    type: 'tool_call',
                    agent: 'Researcher',
                    thread: { id: 'inv-root' },
                    call: { id: 'call_1', name: 'delegate', arguments: '{"agent":"Researcher","input":"child"}' }
                },
                {
                    type: 'start',
                    agent: 'Researcher',
                    model: 'scripted/test',
                    thread: { id: 'inv-child', parentId: 'inv-root', callId: 'call_1', input: 'child' }
                },
                {
                    type: 'done',
                    agent: 'Researcher',
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
                {
                    type: 'start',
                    agent: 'Researcher',
                    model: 'scripted/test',
                    thread: { id: 'inv-later', parentId: 'inv-root', input: 'no join entry' }
                },
                {
                    type: 'done',
                    agent: 'Researcher',
                    thread: { id: 'inv-later', parentId: 'inv-root' },
                    message: assistant('later answer')
                },
                {
                    type: 'done',
                    agent: 'Researcher',
                    thread: { id: 'inv-root' },
                    message: assistant('root answer')
                }
            ]
        };

        // `RR7` is the child's conversation; the later same-code run continues at RR8, and the
        // tentative RR5 the spawning call took is not skipped ahead of it.
        expect(board([turn])).toEqual(['RR4:root:done', 'RR7:inv-child:done', 'RR8:inv-later:done']);
        // F10 (R10.3): the WATER holds the numbers a conversation owns — `RR4` (the turn's own
        // conversation) and `RR7` (the child's, taken over by the join on adoption). `inv-later`
        // has no join entry, so its `RR8` is a display ordinal for a run that owns no
        // conversation and it cannot become durable; that is the difference between the join's
        // water and the operator's `WE:12`/`RR:11`/`DR:8` tombstones, each one above the last
        // name a conversation actually holds.
        expect(water([turn])).toEqual({ RR: 7 });
    });

    it('repeats one conversation label across continuations without consuming another ordinal', () => {
        const hostTurn = (id: string, content: string): AgentResultTurn => ({
            id,
            status: 'done',
            threadLabel: 'RR2',
            events: [
                { type: 'start', agent: 'Researcher', model: 'scripted/test', thread: { id: `inv-${id}` } },
                { type: 'done', agent: 'Researcher', thread: { id: `inv-${id}` }, message: assistant(content) }
            ]
        });

        const turns = [hostTurn('turn-a', 'one'), hostTurn('turn-b', 'two')];

        expect(board(turns)).toEqual(['RR2:root:done', 'RR2:root:done']);
        expect(water(turns)).toEqual({ RR: 2 });
    });

    it('keeps a LIVE pending delegation on its tentative number, which is what a chip binds', () => {
        // The child has not started yet and MAY still adopt a conversation, so the number stays
        // (./agent-results.test.ts:310 and the client's blocks.test.ts pin exactly this state).
        const pending: AgentResultTurn = {
            id: 'turn-pending',
            status: 'running',
            threadLabel: 'IT1',
            events: [
                { type: 'start', agent: 'instruct', model: 'scripted/test', thread: { id: '67' } },
                {
                    type: 'tool_call',
                    agent: 'instruct',
                    thread: { id: '67' },
                    call: { id: 'call_9', name: 'delegate', arguments: '{"agent":"helper","input":"later"}' }
                }
            ]
        };

        expect(listAgentResultBlocks([pending])[1]).toEqual({
            turnId: 'turn-pending',
            threadId: 'call:call_9',
            label: 'HR1',
            agent: 'helper',
            status: 'running'
        });
        // A displayed number IS a claim: while it is on screen the water holds it.
        expect(water([pending])).toEqual({ IT: 1, HR: 1 });
    });

    it('hands the tentative number back when the same delegation later dies', () => {
        // The two turns above differ ONLY in the turn status: the pending one shows `HR1`, the
        // settled one shows `T?` and reserves nothing.
        const failed: AgentResultTurn = {
            id: 'turn-pending',
            status: 'done',
            threadLabel: 'IT1',
            events: [
                { type: 'start', agent: 'instruct', model: 'scripted/test', thread: { id: '67' } },
                {
                    type: 'tool_call',
                    agent: 'instruct',
                    thread: { id: '67' },
                    call: { id: 'call_9', name: 'delegate', arguments: '{"agent":"helper","input":"later"}' }
                },
                {
                    type: 'done',
                    agent: 'instruct',
                    thread: { id: '67' },
                    message: assistant('root answer')
                }
            ]
        };

        expect(
            listAgentResultBlocks([failed]).map((block) => `${block.label}:${block.threadId ?? 'root'}`)
        ).toEqual(['IT1:root', 'T?:call:call_9']);
        expect(water([failed])).toEqual({ IT: 1 });
    });

    it('keeps a legacy threadless child addressable — it is a run, with an answer', () => {
        // `blockForLegacy` adopts a placeholder for a threadless child start: the block has
        // STARTED, so the never-started pass must not retire its label.
        const legacy: AgentResultTurn = {
            id: 'turn-legacy',
            status: 'done',
            events: [
                { type: 'start', agent: 'lead', model: 'scripted/test' },
                {
                    type: 'tool_call',
                    agent: 'lead',
                    call: { id: 'call_1', name: 'delegate', arguments: '{"agent":"helper","input":"go"}' }
                },
                { type: 'start', agent: 'helper', model: 'scripted/test' },
                { type: 'done', agent: 'helper', message: assistant('helper answer') },
                { type: 'done', agent: 'lead', message: assistant('lead answer') }
            ]
        };

        expect(
            listAgentResultBlocks([legacy]).map((block) => `${block.label}:${block.threadId ?? 'root'}`)
        ).toEqual(['LD1:root', 'HR1:call:call_1']);
        expect(water([legacy])).toEqual({ LD: 1, HR: 1 });
    });
});

// ---------------------------------------------------------------------------
// F10 / R10.3 — a mint that owns no conversation may never raise the DURABLE water.
//
// G3/G4 pinned the two directions that already mattered (a mint must not collide with a
// conversation in the SAME record, and an owner keeps its number). This group pins the third
// direction, the one the operator's session got wrong: a run the join never names still gets a
// display number, and that number was being fed into `labelHighWater` — which
// ../server/sessions.ts `mergeLabelHighWater` only ever RAISES, so `WE` stopped at 12 owned
// while the map read 12 and a later turn displayed WE16 (WE13-WE16 answer to nothing).
// ---------------------------------------------------------------------------

describe('a minted ordinal outside the join never reaches the durable counters (F10)', () => {
    // The measured shape: the turn's own conversation `IT3`, ONE delegated child whose
    // conversation the join names (`inv-child` → `RR2`), and ONE threadless `reviewer` run that
    // carries no thread metadata at all. The recorded seed (`RR: 3`) puts that last run's mint at
    // `RR4` — ABOVE every ordinal the join owns, which is the `WE13`-`WE16` case.
    const unjoinedTurn = (join: Record<string, string> | undefined): AgentResultTurn => ({
        id: 'turn-f10-unjoined',
        status: 'done',
        threadLabel: 'IT3',
        labels: { RR: 3 },
        ...(join === undefined ? {} : { threadLabels: join }),
        events: [
            { type: 'start', agent: 'instruct', model: 'scripted/test', thread: { id: 'inv-root', input: 'go' } },
            { type: 'start', agent: 'reviewer', model: 'scripted/test' },
            { type: 'done', agent: 'reviewer', message: assistant('side answer') },
            {
                type: 'start',
                agent: 'reviewer',
                model: 'scripted/test',
                thread: { id: 'inv-child', parentId: 'inv-root', input: 'delegated' }
            },
            {
                type: 'done',
                agent: 'reviewer',
                thread: { id: 'inv-child', parentId: 'inv-root' },
                message: assistant('child answer')
            },
            { type: 'done', agent: 'instruct', thread: { id: 'inv-root' }, message: assistant('root answer') }
        ]
    });

    it('still DISPLAYS the number, and holds the durable water at what a conversation owns', () => {
        const turn = unjoinedTurn({ 'inv-child': 'RR2' });

        // The display rule is untouched: a run needs a local identity, and the join's own name
        // (`RR2`) is what the nested block shows.
        expect(board([turn])).toEqual([
            'IT3:root:done',
            'RR4:inline:reviewer:done',
            'RR2:inv-child:done'
        ]);

        // `RR: 3` is the RECORDED seed (durable state, never dropped — a deleted
        // conversation's ordinal must not come back), `IT: 3` is the turn's own conversation.
        // `RR4` belongs to no conversation, so it is the one number missing from the map.
        expect(water([turn])).toEqual({ IT: 3, RR: 3 });
    });

    it('counts every mint once the record carries NO join view — the legacy namespace is unchanged', () => {
        // The same events with no roster join at all (a `/messages` record): here the minted
        // occurrence IS the whole reference namespace, so it keeps raising the counters exactly
        // as it did before F10. This is the clause that keeps a legacy session's numbering from
        // restarting at 1 on every turn.
        const turn = unjoinedTurn(undefined);

        // No join, so BOTH runs draw from the sequence: the threadless block at `RR4`, the
        // unlabelled child at `RR5`, and the counters continue after the LAST one — which is the
        // pre-F10 behaviour these records must keep.
        expect(board([turn])).toEqual(['IT3:root:done', 'RR4:inline:reviewer:done', 'RR5:inv-child:done']);
        expect(water([turn])).toEqual({ IT: 3, RR: 5 });
    });

    it('counts a conversation label the join handed over, however high it is', () => {
        // Ownership, not height, is the test: a join name far above the seed raises the water
        // (that reservation is what stops a later nested block being minted the same name),
        // while a MINT may not.
        const turn: AgentResultTurn = {
            id: 'turn-f10-owned-high',
            status: 'done',
            threadLabel: 'IT3',
            labels: { RR: 1 },
            threadLabels: { 'inv-child': 'RR12' },
            events: [
                { type: 'start', agent: 'instruct', model: 'scripted/test', thread: { id: 'inv-root', input: 'go' } },
                {
                    type: 'start',
                    agent: 'reviewer',
                    model: 'scripted/test',
                    thread: { id: 'inv-child', parentId: 'inv-root', input: 'delegated' }
                },
                {
                    type: 'done',
                    agent: 'reviewer',
                    thread: { id: 'inv-child', parentId: 'inv-root' },
                    message: assistant('child answer')
                },
                { type: 'done', agent: 'instruct', thread: { id: 'inv-root' }, message: assistant('root answer') }
            ]
        };

        expect(board([turn])).toEqual(['IT3:root:done', 'RR12:inv-child:done']);
        expect(water([turn])).toEqual({ IT: 3, RR: 12 });
    });

    it('leaves the persisted high-water untouched when it is merged back (the census case)', () => {
        // The operator's `WE` numbers in miniature: the recorded seed sits at the join's water
        // (WE11), a threadless `workspace` run mints WE12 for a run no conversation owns, and the
        // persisted tombstone map already reads WE:12. `../server/sessions.ts`
        // `mergeLabelHighWater` merges RAISE-ONLY, so what this function returns IS the future
        // water — before F10 it returned WE:16 on the full session, and 13-16 belong to nothing.
        const turn: AgentResultTurn = {
            id: 'turn-f10-census',
            status: 'done',
            threadLabel: 'IT12',
            labels: { WE: 11 },
            threadLabels: { 'inv-ws': 'WE11' },
            events: [
                { type: 'start', agent: 'instruct', model: 'scripted/test', thread: { id: 'inv-root', input: 'go' } },
                { type: 'start', agent: 'workspace', model: 'scripted/test' },
                { type: 'done', agent: 'workspace', message: assistant('threadless answer') },
                {
                    type: 'start',
                    agent: 'workspace',
                    model: 'scripted/test',
                    thread: { id: 'inv-ws', parentId: 'inv-root', input: 'delegated' }
                },
                {
                    type: 'done',
                    agent: 'workspace',
                    thread: { id: 'inv-ws', parentId: 'inv-root' },
                    message: assistant('child answer')
                },
                { type: 'done', agent: 'instruct', thread: { id: 'inv-root' }, message: assistant('root answer') }
            ]
        };

        // WE12 is on screen; WE11 is the conversation; nothing above the join is collected.
        expect(board([turn])).toEqual(['IT12:root:done', 'WE12:inline:workspace:done', 'WE11:inv-ws:done']);
        expect(water([turn])).toEqual({ IT: 12, WE: 11 });

        const durable = { IT: 20, WE: 12, RR: 11 };
        const collected = water([turn]);
        const merged: Record<string, number> = { ...durable };

        for (const [code, used] of Object.entries(collected)) merged[code] = Math.max(merged[code] ?? 0, used);

        // The persisted water survives byte-identical: the new code cannot raise it, and the
        // raise-only merge cannot lower it either.
        expect(merged).toEqual({ IT: 20, WE: 12, RR: 11 });
    });
});

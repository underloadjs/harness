// F11 (2026-11-26) — EVERY RENDERED ROW OWNS ONE VALID, UNIQUE LABEL. NO PLACEHOLDER TOKEN.
//
// THE MANDATE, verbatim (it is the requirement these tests pin, not an observation):
//   "All labels must be valid. Cannot have T? or T- etc... all labels must be unique, as no
//    thread share same labeling. This is because user using these label to reference as needed,
//    and having a bunch of T? means they cannot reference specific one. All thread that started,
//    regardless of failure etc... must be assigned a proper label."
//
// THE CONTRACT, as implemented in ./agent-results.ts:
//   V1. every projected `label` matches `AGENT_REFERENCE_LABEL_PATTERN` — there is no other
//       shape, and `T?` (`UNADDRESSABLE_BLOCK_LABEL`, F6/F10) no longer exists;
//   V2. a `delegate` placeholder whose child NEVER STARTED keeps the ordinal the spawning call
//       minted (refused before start, cancelled before start, settled by the parent's
//       `tool_result` — the outcome does not take the label away), and the number is permanently
//       owned by that row: `collectAgentLabelCounters` reserves it, so a LATER turn cannot mint
//       it as a conversation name;
//   V3. a threadFork BRANCH run displays the address of the conversation it forked FROM
//       (`labelSource: 'shared'`) — it is part of that conversation, so it burns nothing from
//       the sequence, and a bare `#LABEL` still resolves to the conversation that owns the
//       address while the branch stays bindable by its own `branch-N` id;
//   V4. no two rows of one record wear the same address unless one of them is that branch copy
//       (`reserveDisplayedLabels` walks any clashing MINT forward, in transcript order);
//   V5. blocks that DO own a label keep the exact numbers they always had (conversation
//       adoption, continuations, legacy inline runs, a live pending delegation);
//   V6. the durable per-code water is every label the projection ENDS UP SHOWING, except a
//       branch's `shared` copy. F10's cap ("a mint the join never names may not raise the
//       water") is lifted ON PURPOSE: under F11 such a number is the address of the row on
//       screen, and reserving what the user sees is what keeps labels unique.
//
// Pure functions, literal events, exact values — the same style as ./agent-results.test.ts and
// ./agent-results-run-join.test.ts. The fixtures are the shapes the live session produced, not
// the 300 MB dump itself.
//
// Cross-references:
//   - ./agent-results.ts `blocksOfTurn` (the claim set, `branchSharedLabelOf`, the branch test),
//     `reserveDisplayedLabels` (the settle pass that replaced F6's blanking sweep) and
//     `collectAgentLabelCounters`
//   - ../core/branch.ts:142 `createBranchId` (the `branch-N` id), ../core/thread.ts
//     `resolveThreadAddressOf` (a label matched exactly, ambiguity refused)
//   - ../../server/sessions.ts `labelJoinsOf`/`liveThreadLabel` (the join that never names a
//     branch), `mergeLabelHighWater`/`labelSeedOf` (the raise-only hydration V6 drives)
//   - ../../../../loadscript/harness/src/shared/agent-results.ts (the client copy, kept in step;
//     pinned by ../../../../loadscript/harness/src/frontend/agent-results-block-identity.test.ts)

import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '../harness';
import {
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

// Labels only, in projection order, for the uniqueness assertions.
const labelsOf = (turns: readonly AgentResultTurn[]): string[] =>
    listAgentResultBlocks(turns).map((block) => block.label);

// ---------------------------------------------------------------------------
// V1 + V2 + V3 — the two run kinds F6/F10 used to blank, in one settled turn.
// ---------------------------------------------------------------------------

// The measured shape: a host conversation `IT1`, ONE delegation whose child never started, and
// ONE threadFork branch. In the live session the placeholder and the branch both printed an
// ordinal (`IT13`, `IT14`) that answered to nothing, F6/F10 then printed `T?` for both, and the
// user could not name either row.
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
        // NO frame of the child itself, so the row has an outcome but no run.
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

describe('every rendered row wears a valid label (V1-V3)', () => {
    it('gives a never-started delegation its own ordinal and a branch its conversation label', () => {
        // Exact descriptors. The attempt owns `GT1` (ghost → GT, its first occurrence) forever;
        // the branch wears `IT1`, the conversation it forked from, because it IS part of it. The
        // real ids still ride the descriptor (`call:<callId>`, `branch-N`) for the id-addressed
        // doors and for the row's identity badge.
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
                label: 'GT1',
                agent: 'ghost',
                status: 'error'
            },
            {
                turnId: 'turn-stress',
                threadId: 'branch-3',
                label: 'IT1',
                agent: 'instruct',
                status: 'done'
            }
        ]);
    });

    it('reserves the attempt ordinal, so the NEXT turn cannot mint it as a name (V2)', () => {
        // This is the half the user pays for: the row is citable, and the number it owns can never
        // come back as a later conversation's label. `labelSeedOf`
        // (@underload/harness ../../server/sessions.ts) records `collectAgentLabelCounters` as the
        // next turn's `labels` seed, so a second turn continues AFTER `GT1`.
        const first = collectAgentLabelCounters([stressTurn()]);
        const next: AgentResultTurn = {
            id: 'turn-next',
            status: 'done',
            threadLabel: 'IT1',
            labels: Object.fromEntries(first),
            events: [
                { type: 'start', agent: 'instruct', model: 'scripted/test', thread: { id: '72', input: 'again' } },
                {
                    type: 'tool_call',
                    agent: 'instruct',
                    thread: { id: '72' },
                    call: { id: 'call_2', name: 'delegate', arguments: '{"agent":"ghost","input":"also refused"}' }
                },
                {
                    type: 'tool_result',
                    agent: 'instruct',
                    name: 'delegate',
                    callId: 'call_2',
                    content: 'rank refused',
                    isError: true
                },
                { type: 'done', agent: 'instruct', thread: { id: '72' }, message: assistant('answer two') }
            ]
        };

        // Two refused attempts, two different labels — the reason `T?` could not stay.
        expect(board([stressTurn(), next])).toEqual([
            'IT1:root:done',
            'GT1:call:call_1:error',
            'IT1:branch-3:done',
            'IT1:root:done',
            'GT2:call:call_2:error'
        ]);
        expect(water([stressTurn(), next])).toEqual({ IT: 1, GT: 2 });
    });

    it('labels a branch by its conversation even when the branch produced content', () => {
        // `IT17` in the measured session was a COMPLETED branch with an answer. A result is still
        // not a conversation: `agentResult`/`threadRead` address it by the `branch-N` ID, which the
        // descriptor carries, while `#LABEL` addresses conversations only.
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
        ).toEqual(['IT5:root', 'IT5:branch-9']);
        // The branch copy consumes NOTHING: the sequence stays where its owner put it.
        expect(water([branchOnly])).toEqual({ IT: 5 });
    });

    it('displays the turn\'s own conversation for a branch whose parent run was never folded', () => {
        // THE DEGRADATION F11 ACTUALLY TAKES: the branch's `parentId` names a run this record
        // never folded, so there is no parent entry to read — but the turn DOES have a root block
        // (thread `70`, `IT1`), and a branch of the turn's own flow is part of THAT conversation.
        // `branchSharedLabelOf` falls to the turn's root block and the row displays its address;
        // `T?` was never an answer, and neither is a second number that implies a second
        // conversation. The water stays at IT1: a `shared` copy burns nothing from the sequence.
        const orphan: AgentResultTurn = {
            id: 'turn-orphan-branch',
            status: 'done',
            events: [
                { type: 'start', agent: 'instruct', model: 'scripted/test', thread: { id: '70', input: 'go' } },
                {
                    type: 'start',
                    agent: 'instruct',
                    model: 'scripted/test',
                    thread: { id: 'branch-9', parentId: 'unknown-run', kind: 'fork', branchId: 'branch-9' }
                },
                {
                    type: 'done',
                    agent: 'instruct',
                    thread: { id: 'branch-9', parentId: 'unknown-run', kind: 'fork', branchId: 'branch-9' },
                    message: assistant('branch answer')
                },
                { type: 'done', agent: 'instruct', thread: { id: '70' }, message: assistant('root answer') }
            ]
        };

        expect(board([orphan])).toEqual(['IT1:root:done', 'IT1:branch-9:done']);
        expect(water([orphan])).toEqual({ IT: 1 });
    });

    it('recognises a branch by the fields the record actually carries, in every spelling', () => {
        // The three ways a branch frame says what it is (../harness.ts `HarnessThread`):
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

            // Every spelling lands on the conversation's own name, and none of them burns a
            // number: the shape test is what the F11 branch rule must agree on.
            expect(labelsOf([turn])).toEqual(['IT5', 'IT5']);
            expect(water([turn])).toEqual({ IT: 5 });
        }
    });
});

// ---------------------------------------------------------------------------
// V1/V3/V4 — the address doors, with no placeholder left to reject.
// ---------------------------------------------------------------------------

describe('no placeholder label token survives on any projected row (V1)', () => {
    const turns = [stressTurn()];
    const blocks = listAgentResultBlocks(turns);

    it('parses every projected label as an address', () => {
        // One fleet, every kind of row: root, never-started attempt, branch, and (below) a legacy
        // threadless run. `agentLabelParts` is the SAME parser every address door uses, so a
        // projected row cannot be un-bindable.
        for (const block of blocks) {
            expect(agentLabelParts(block.label)?.label).toBe(block.label);
        }

        expect(labelsOf(turns)).toEqual(['IT1', 'GT1', 'IT1']);
    });

    it('is stable across re-projections of the same run — no new number per render', () => {
        const first = board(turns);

        expect(board(turns)).toEqual(first);
        expect(board(turns)).toEqual(first);
    });

    it('binds the never-started attempt by label AND id, and names its real ids', () => {
        // The referenceability the mandate is about: a chip built from this row resolves to THIS
        // block. Its status is `error` (the refusal is the outcome) and it carries no content, so
        // the composer contributes the "no result" NOTE rather than failing the submit — and the
        // block itself is found, so nothing 404s inside the projection.
        expect(
            findAgentResultBlock(turns, { turnId: 'turn-stress', threadId: 'call:call_1', label: 'GT1' })
        ).toEqual({
            turnId: 'turn-stress',
            threadId: 'call:call_1',
            label: 'GT1',
            agent: 'ghost',
            status: 'error'
        });
        expect(findLatestAgentResultBlock(turns, '#GT1')).toEqual({
            turnId: 'turn-stress',
            threadId: 'call:call_1',
            label: 'GT1',
            agent: 'ghost',
            status: 'error'
        });

        // Each row still carries the id its own door addresses.
        expect(
            blocks
                .filter((block) => block.threadId !== undefined)
                .map((block) => `${block.agent}:${block.threadId}:${block.status}`)
        ).toEqual(['ghost:call:call_1:error', 'instruct:branch-3:done']);
    });

    it('resolves a bare #LABEL to the conversation that owns it, never to the branch inside it', () => {
        // `IT1` is worn twice on this board (the conversation and its fork). The OWNER answers a
        // typed `#IT1`; the branch answers the id-addressed door. That is what keeps one address
        // resolving to one result — the property ../core/thread.ts `resolveThreadAddressOf` needs.
        expect(findLatestAgentResultBlock(turns, '#IT1')).toEqual({
            turnId: 'turn-stress',
            label: 'IT1',
            agent: 'instruct',
            status: 'done',
            content: 'root answer'
        });

        // A chip that came from the BRANCH row binds the branch id, and resolves to the branch.
        expect(
            findAgentResultBlock(turns, { turnId: 'turn-stress', threadId: 'branch-3', label: 'IT1' })
        ).toEqual({
            turnId: 'turn-stress',
            threadId: 'branch-3',
            label: 'IT1',
            agent: 'instruct',
            status: 'done'
        });
    });

    it('still rejects a payload that carries the retired token', () => {
        // F11 removed the PRODUCERS of `T?`; the parser is unchanged, so a persisted/typed `T?`
        // (an old document, or a hand-built reference) is a malformed payload rather than a
        // silently accepted label.
        expect(normalizeAgentLabel('T?')).toBeUndefined();
        expect(agentLabelParts('T?')).toBeUndefined();
        expect(findLatestAgentResultBlock(turns, 'T?')).toBeUndefined();
        expect(() =>
            readAgentResultReferenceList([{ turnId: 'turn-stress', threadId: 'branch-3', label: 'T?' }])
        ).toThrow(new TypeError('references[0].label must be a block label such as "IT1".'));
    });
});

// ---------------------------------------------------------------------------
// V4 — the second `RR9`: one turn may never print one address twice.
// ---------------------------------------------------------------------------

describe('a minted number never collides with a label this record already shows (V4)', () => {
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
        const labels = labelsOf([collisionTurn]);

        expect(new Set(labels).size).toBe(labels.length);
    });

    it('reserves every label it displayed, the threadless row included (V6)', () => {
        // F10 capped this at the join's water (RR9); F11 has no cap, because `RR10` is the address
        // the row on screen owns. `mergeLabelHighWater` is raise-only, so the number is now
        // permanently out of circulation — which is the uniqueness guarantee, stated as a counter.
        expect(water([collisionTurn])).toEqual({ IT: 12, RR: 10 });
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

    it('walks a never-started attempt forward when a conversation takes its number', () => {
        // The provisional mint at the CALL frame is exempt from the collision skip (a chip must bind
        // the pending block by that number while the child may still start). F11 resolves the
        // clash at the settle pass instead: the attempt — not the conversation — moves, because the
        // conversation's name is authored by the store.
        const clash: AgentResultTurn = {
            id: 'turn-attempt-clash',
            status: 'done',
            threadLabel: 'IT2',
            threadLabels: { 'inv-late': 'HR1' },
            events: [
                { type: 'start', agent: 'instruct', model: 'scripted/test', thread: { id: 'inv-root', input: 'go' } },
                {
                    type: 'tool_call',
                    agent: 'instruct',
                    thread: { id: 'inv-root' },
                    call: { id: 'call_1', name: 'delegate', arguments: '{"agent":"helper","input":"refused"}' }
                },
                {
                    type: 'tool_result',
                    agent: 'instruct',
                    name: 'delegate',
                    callId: 'call_1',
                    content: 'rank refused',
                    isError: true
                },
                // A SECOND delegation of the same agent, this one a real conversation whose join
                // entry the store authored — and it names the number the attempt tentatively took.
                {
                    type: 'tool_call',
                    agent: 'instruct',
                    thread: { id: 'inv-root' },
                    call: { id: 'call_2', name: 'delegate', arguments: '{"agent":"helper","input":"ran"}' }
                },
                {
                    type: 'start',
                    agent: 'helper',
                    model: 'scripted/test',
                    thread: { id: 'inv-late', parentId: 'inv-root', callId: 'call_2', input: 'ran' }
                },
                {
                    type: 'done',
                    agent: 'helper',
                    thread: { id: 'inv-late', parentId: 'inv-root', callId: 'call_2' },
                    message: assistant('child answer')
                },
                { type: 'done', agent: 'instruct', thread: { id: 'inv-root' }, message: assistant('root answer') }
            ]
        };

        // `HR1` was minted by the first call; the join gave it to the late child. The settled
        // attempt would take `HR2`, but the root conversation is `IT2` — the walk is cross-kind so
        // a bare `#2` lookup stays unambiguous — so it lands on `HR3`. Every row keeps a unique,
        // valid address, and the walk raises the durable water to what is actually displayed.
        expect(board([clash])).toEqual([
            'IT2:root:done',
            'HR3:call:call_1:error',
            'HR1:inv-late:done'
        ]);
        expect(water([clash])).toEqual({ IT: 2, HR: 3 });
    });
});

// ---------------------------------------------------------------------------
// V5 — every block that OWNS a label keeps the number it has today.
// ---------------------------------------------------------------------------

describe('owned labels keep their exact numbering (V5)', () => {
    it('adopts the recorded conversation labels for a root and a nested child, and burns nothing else', () => {
        // The ./agent-results-run-join.test.ts:294 fixture, unchanged in shape. The `Helper`
        // placeholder's tentative `HR1` is handed to the join, so nothing is left behind — the
        // number was never on screen.
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
        // F11 (V6): `inv-later` has no join entry, but a ROW displays `RR8`, so the number is
        // reserved. F10 held the water at RR7; the difference is exactly the collision F11 closes —
        // a later conversation minted RR8 while this row was wearing it.
        expect(water([turn])).toEqual({ RR: 8 });
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

    it('keeps the number when the same delegation later dies — the label survives the failure', () => {
        // The two turns differ ONLY in the turn status. F6/F10 blanked the settled one to `T?`;
        // F11 keeps `HR1`, because the user references THIS attempt by that name ("All thread
        // that started, regardless of failure etc... must be assigned a proper label" — and a
        // refused attempt is the row they most need to point at).
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
        ).toEqual(['IT1:root', 'HR1:call:call_9']);
        expect(water([failed])).toEqual({ IT: 1, HR: 1 });
    });

    it('keeps a legacy threadless child addressable — it is a run, with an answer', () => {
        // `blockForLegacy` adopts a placeholder for a threadless child start: the block has
        // STARTED, so the settle pass must not move its label.
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
// V6 — the durable water is exactly what the rows display (F10's cap lifted).
//
// G3/V5 pinned the two directions that already mattered (a mint must not collide with a label in
// the SAME record, and an owner keeps its number). This group pins the third direction, the one
// the operator's session got wrong in the other direction: a run the join never names gets a
// display number, and F10 refused to let that number reach `labelHighWater`
// (@underload/harness ../../server/sessions.ts `mergeLabelHighWater`, RAISE-only) — so the next
// conversation was minted the very number the row on screen was already wearing.
// ---------------------------------------------------------------------------

describe('every displayed label reserves its ordinal in the durable counters (V6)', () => {
    // The measured shape: the turn's own conversation `IT3`, ONE delegated child whose
    // conversation the join names (`inv-child` → `RR2`), and ONE threadless `reviewer` run that
    // carries no thread metadata at all. The recorded seed (`RR: 3`) puts that last run's mint at
    // `RR4` — ABOVE every ordinal the join owns, which is the `WE13`-`WE16` case.
    const unjoinedTurn = (join: Record<string, string> | undefined): AgentResultTurn => ({
        id: 'turn-f11-unjoined',
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

    it('displays the number AND reserves it, so no later row can take it', () => {
        const turn = unjoinedTurn({ 'inv-child': 'RR2' });

        // The display rule is untouched: a run needs an identity, and the join's own name (`RR2`)
        // is what the nested block shows.
        expect(board([turn])).toEqual([
            'IT3:root:done',
            'RR4:inline:reviewer:done',
            'RR2:inv-child:done'
        ]);

        // `RR: 3` is the RECORDED seed (durable state, never dropped — a deleted conversation's
        // ordinal must not come back), `IT: 3` is the turn's own conversation, and `RR4` is now in
        // the map because a row is showing it.
        expect(water([turn])).toEqual({ IT: 3, RR: 4 });
    });

    it('counts every mint once the record carries NO join view — the legacy namespace is unchanged', () => {
        // The same events with no roster join at all (a `/messages` record): here the minted
        // occurrence IS the whole reference namespace, exactly as it always was.
        const turn = unjoinedTurn(undefined);

        expect(board([turn])).toEqual(['IT3:root:done', 'RR4:inline:reviewer:done', 'RR5:inv-child:done']);
        expect(water([turn])).toEqual({ IT: 3, RR: 5 });
    });

    it('counts a conversation label the join handed over, however high it is', () => {
        // A join name far above the seed raises the water (that reservation is what stops a later
        // nested block being minted the same name).
        const turn: AgentResultTurn = {
            id: 'turn-f11-owned-high',
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

    it('never lets a branch copy raise the water past the conversation it copies', () => {
        // The one exclusion V6 keeps, in the shape where it matters: the join owns `RR9`, the fork
        // inside it wears `RR9` too, and the copy must not push the sequence to RR10 (which would
        // renumber the conversation's own next thread).
        const turn: AgentResultTurn = {
            id: 'turn-f11-branch-copy',
            status: 'done',
            threadLabel: 'IT3',
            labels: { RR: 8 },
            threadLabels: { 'inv-child': 'RR9' },
            events: [
                { type: 'start', agent: 'instruct', model: 'scripted/test', thread: { id: 'inv-root', input: 'go' } },
                {
                    type: 'start',
                    agent: 'reviewer',
                    model: 'scripted/test',
                    thread: { id: 'inv-child', parentId: 'inv-root', input: 'delegated' }
                },
                {
                    type: 'start',
                    agent: 'reviewer',
                    model: 'scripted/test',
                    thread: {
                        id: 'branch-2',
                        parentId: 'inv-child',
                        kind: 'fork',
                        branchId: 'branch-2',
                        input: 'fork of the child'
                    }
                },
                {
                    type: 'done',
                    agent: 'reviewer',
                    thread: { id: 'branch-2', parentId: 'inv-child', kind: 'fork', branchId: 'branch-2' },
                    message: assistant('branch answer')
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

        // The fork wears the CHILD conversation's address (`RR9`), not a number of its own.
        expect(board([turn])).toEqual([
            'IT3:root:done',
            'RR9:inv-child:done',
            'RR9:branch-2:done'
        ]);
        expect(water([turn])).toEqual({ IT: 3, RR: 9 });
    });

    it('leaves the persisted high-water monotonic when it is merged back (the census case)', () => {
        // The operator's `WE` numbers in miniature: the recorded seed sits at the join's water
        // (WE11), a threadless `workspace` run displays WE12, and the persisted tombstone map
        // already reads WE:12. `mergeLabelHighWater` merges RAISE-ONLY, so what this function
        // returns IS the future water.
        const turn: AgentResultTurn = {
            id: 'turn-f11-census',
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

        // WE12 is on screen and WE12 is the water: F11 keeps F6's anti-leak INVARIANT (no number is
        // ever re-minted while a row owns it) by reserving what it shows, which is the number the
        // F10 map used to leave out — and then hand back to a later conversation.
        expect(board([turn])).toEqual(['IT12:root:done', 'WE12:inline:workspace:done', 'WE11:inv-ws:done']);
        expect(water([turn])).toEqual({ IT: 12, WE: 12 });

        const durable = { IT: 20, WE: 12, RR: 11 };
        const collected = water([turn]);
        const merged: Record<string, number> = { ...durable };

        for (const [code, used] of Object.entries(collected)) merged[code] = Math.max(merged[code] ?? 0, used);

        // The persisted water survives byte-identical: the merge can raise nothing here, and a
        // raise-only merge can never lower it.
        expect(merged).toEqual({ IT: 20, WE: 12, RR: 11 });
    });
});

// R18/T18: the PERSISTENT conversation identity of a delegated section.
//
// What is pinned here (the server half of "every delegated thread gets its own bar and
// its own place in the hierarchy"):
//   R18a  a delegated child row carries `threadId` = the persistent conversation its
//         invocation ran in, taken from the store's own join
//         (`DisplayProjectContext.invocationThreadIds`, ./sessions.ts
//         `Session.invocationThreads`). The fold never mints or guesses an id.
//   R18b  nesting (`parentSectionId`) survives BOTH spawn paths: a recorded `delegate`
//         call (the placeholder) AND a stream that only names the spawner by INVOCATION id
//         (T20: `newSection` resolves through `byKey` and `byInvocation`), and a deeper
//         delegation nests under its parent row with its OWN conversation id, so
//         [Main] → [RR1] → [RR2] is addressable per conversation, not per invocation.
//   R18c  one conversation reused by several invocations keeps ONE stable `threadId`
//         (a resumed child), while each row stays separately addressable by
//         `invocationId`, and a sibling delegation stays separate.
//   R18d  a join learned AFTER the row was folded arrives as its own `section:set`
//         patch, exactly once, on the next fold step — and a live fold and a cold
//         replay end at the same tree.
//   R18e  a record with no join (a pre-T18 document, or a branch, which owns no
//         conversation) omits `threadId` on the delegated row — never a fabricated one.
//   R19   a retry inside a DELEGATED conversation mints no notice node and leaves that
//         row `streaming` until the real terminal frame.
//
// Event shapes are copied from what the runtime ACTUALLY records (../harness.ts
// `withThread`/`threadIdentity` at 4094-4117 and 6560-6579): a delegated child carries
// `{ id, parentId?, callId?, input? }` with NO `kind` (only branch runs set one), and a
// host-thread root carries `{ id, input }` on `start` and `{ id }` afterwards. The
// invocation/conversation ids ('1'/'2' and 'thread-1'/'thread-2') are the exact values a
// real store run produces (./threads.test.ts:1401-1445).
//
// Clock policy: one recorded event per 10 ms, so every timestamp below is an exact
// number, never a range.

import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '../harness';
import type { DisplayProjectContext, TurnDisplay, TurnDisplayOp, TurnSummary } from '../shared/turn-display';
import type { SessionTurn } from './protocol';
import { createTurnProjector, projectTurn } from './turn-projector';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const turnOf = (overrides: Partial<SessionTurn> = {}): SessionTurn => ({
    id: 'turn-1',
    index: 0,
    prompt: 'delegate please',
    status: 'running',
    startedAt: 1_000,
    updatedAt: 1_000,
    events: [],
    eventTimes: [],
    // The turn's OWN conversation: the host thread that received the submit.
    threadId: 'thread-1',
    threadLabel: 'IT1',
    ...overrides
});

// The join under test: invocation id → persistent conversation id.
const JOIN = (): Map<string, string> =>
    new Map([
        ['1', 'thread-1'],
        ['2', 'thread-2'],
        ['3', 'thread-3']
    ]);

const LABELS = (): Map<string, string> =>
    new Map([
        ['1', 'IT1'],
        ['2', 'RR1'],
        ['3', 'RR2']
    ]);

// `threadIds`/`labels` are optional on purpose: their ABSENCE is a tested case (R18e).
const contextOf = (
    options: { threadIds?: ReadonlyMap<string, string>; labels?: ReadonlyMap<string, string> } = {}
): DisplayProjectContext => ({
    primary: 'lead',
    ...(options.labels === undefined ? {} : { threadLabels: options.labels }),
    ...(options.threadIds === undefined ? {} : { invocationThreadIds: options.threadIds })
});

// What a cold replay (restore) sees: the persisted map is loaded before `foldProjections`.
const REPLAY = (): DisplayProjectContext => contextOf({ threadIds: JOIN(), labels: LABELS() });

const timeOf = (index: number): number => 1_000 + index * 10;

// --- recorded frame shapes, verbatim from the runtime ----------------------

/** A host-thread root run: `{ id, input }` on `start` (../harness.ts:6579). */
const rootStart = (invocationId: string, input = 'delegate please'): HarnessEvent => ({
    type: 'start',
    agent: 'lead',
    model: 'scripted/test',
    thread: { id: invocationId, input }
});

/** A delegated child's `start` (../harness.ts:6570): id + lineage + prompt, no `kind`. */
const childStart = (
    invocationId: string,
    parentId: string,
    callId: string,
    agent: string,
    input: string
): HarnessEvent => ({
    type: 'start',
    agent,
    model: 'scripted/test',
    thread: { id: invocationId, parentId, callId, input }
});

/** That run's identity fields on every LATER frame (../harness.ts:4094). */
const childThread = (invocationId: string, parentId: string, callId: string): HarnessEvent['thread'] => ({
    id: invocationId,
    parentId,
    callId
});

const delegateCall = (callId: string, agent: string, input: string): HarnessEvent => ({
    type: 'tool_call',
    agent: 'lead',
    call: { id: callId, name: 'delegate', arguments: JSON.stringify({ agent, input }) },
    thread: { id: '1' }
});

const text = (agent: string, delta: string, thread?: HarnessEvent['thread']): HarnessEvent => ({
    type: 'text',
    agent,
    delta,
    ...(thread === undefined ? {} : { thread })
});

const done = (agent: string, thread?: HarnessEvent['thread']): HarnessEvent => ({
    type: 'done',
    agent,
    message: { role: 'assistant', content: '', reasoning: '', toolCalls: [], model: 'scripted/test', stopReason: 'stop' },
    ...(thread === undefined ? {} : { thread })
});

const retry = (agent: string, thread?: HarnessEvent['thread']): HarnessEvent => ({
    type: 'retry',
    agent,
    attempt: 2,
    maxAttempts: 6,
    delayMs: 500,
    error: { message: 'upstream timed out' },
    ...(thread === undefined ? {} : { thread })
});

const usage = (agent: string, thread?: HarnessEvent['thread']): HarnessEvent => ({
    type: 'usage',
    agent,
    usage: { input: 3, output: 4, total: 7 },
    ...(thread === undefined ? {} : { thread })
});

const branchStart = (threadId: string | undefined): HarnessEvent => ({
    type: 'branch_start',
    agent: 'lead',
    branch: {
        branchId: 'branch-1',
        kind: 'fork',
        agent: 'lead',
        role: 'subagent',
        sourceThreadId: '1',
        forkDepth: 1,
        model: 'scripted/test',
        tools: [],
        ...(threadId === undefined ? {} : { threadId })
    }
});

// ---------------------------------------------------------------------------
// The live fold, in the store's exact order: record, then fold (./sessions.ts:5456-5504)
// ---------------------------------------------------------------------------

type Folded = {
    ops: TurnDisplayOp[][];
    push: (event: HarnessEvent, at?: number) => TurnDisplayOp[];
    display: () => TurnDisplay;
    summary: () => TurnSummary;
    settle: (status: 'done' | 'error' | 'cancelled', at?: number) => TurnDisplayOp[];
};

const fold = (events: HarnessEvent[], options: { turn?: SessionTurn; context?: DisplayProjectContext } = {}): Folded => {
    const turn = options.turn ?? turnOf();
    const projector = createTurnProjector(turn, options.context ?? contextOf({ threadIds: JOIN(), labels: LABELS() }));
    const ops: TurnDisplayOp[][] = [];

    const push = (event: HarnessEvent, at?: number): TurnDisplayOp[] => {
        const index = turn.events.length;
        const stamp = at ?? timeOf(index);

        turn.events.push(event);
        turn.eventTimes?.push(stamp);

        const applied = projector.apply(event, stamp, index);
        ops.push(applied);

        return applied;
    };

    events.forEach((event) => push(event));

    return {
        ops,
        push,
        display: () => projector.display(),
        summary: () => projector.summary(),
        settle: (status, at) => projector.settle(status, at ?? 5_000)
    };
};

// One row's whole server-side identity: what a client needs to draw it, indent it, and
// give it its own bar. Absent fields stay absent, so `toEqual` is exact.
type RowIdentity = {
    id: string;
    parentSectionId?: string;
    role: string;
    agent: string;
    agentLabel: string;
    threadLabel?: string;
    invocationId?: string;
    threadId?: string;
    state: string;
};

const identityOf = (display: TurnDisplay): RowIdentity[] =>
    display.sections.map((section) => ({
        id: section.id,
        ...(section.parentSectionId === undefined ? {} : { parentSectionId: section.parentSectionId }),
        role: section.role,
        agent: section.agent,
        agentLabel: section.agentLabel,
        ...(section.threadLabel === undefined ? {} : { threadLabel: section.threadLabel }),
        ...(section.invocationId === undefined ? {} : { invocationId: section.invocationId }),
        ...(section.threadId === undefined ? {} : { threadId: section.threadId }),
        state: section.state
    }));

// The tree a fold ENDS at: `[section id, conversation, invocation, parent, state]`.
const treeOf = (display: TurnDisplay) =>
    identityOf(display).map((row) => [row.id, row.threadId, row.invocationId, row.parentSectionId, row.state]);

const openedSections = (ops: TurnDisplayOp[][]) =>
    ops.flat().filter((op): op is Extract<TurnDisplayOp, { op: 'section:open' }> => op.op === 'section:open');

const patchesFor = (ops: TurnDisplayOp[][], sectionId: string) =>
    ops
        .flat()
        .filter((op): op is Extract<TurnDisplayOp, { op: 'section:set' }> => op.op === 'section:set' && op.sectionId === sectionId)
        .map((op) => op.patch);

// Every `section:set` that names `threadId`, in op order, as the whole op.
const threadIdPatches = (ops: TurnDisplayOp[][], sectionId?: string) =>
    ops
        .flat()
        .filter(
            (op): op is Extract<TurnDisplayOp, { op: 'section:set' }> =>
                op.op === 'section:set' &&
                Object.prototype.hasOwnProperty.call(op.patch, 'threadId') &&
                (sectionId === undefined || op.sectionId === sectionId)
        )
        .map((op) => ({ op: op.op, turnId: op.turnId, sectionId: op.sectionId, patch: op.patch }));

// Narrower still: the patches that name `threadId` and NOTHING ELSE, i.e. exactly what
// the late-join scan emits. Two other ops legitimately name the field and must never be
// counted here: a root `start` patch (that conversation is in the RECORD) and a child
// adoption patch (whole identity + state in one op).
const lateJoinPatches = (ops: TurnDisplayOp[][]) =>
    threadIdPatches(ops).filter((patch) => Object.keys(patch.patch).length === 1);

// Which section each bar segment belongs to, per row: the per-conversation bar test.
const barsOf = (display: TurnDisplay) =>
    display.sections.map((section) => (section.context ?? []).map((block) => [block.kind, block.name, block.sectionId]));

// The lead→helper sequence the recorder really produces: the root's `delegate` call
// mints a placeholder row, and the child's own `start` frame adopts it.
const DELEGATION: HarnessEvent[] = [
    rootStart('1'),
    delegateCall('delegate-1', 'helper', 'child work'),
    childStart('2', '1', 'delegate-1', 'helper', 'child work'),
    text('helper', 'helper answer', childThread('2', '1', 'delegate-1')),
    done('helper', childThread('2', '1', 'delegate-1'))
];

const clone = (events: HarnessEvent[]): HarnessEvent[] => events.map((event) => JSON.parse(JSON.stringify(event)) as HarnessEvent);

// ---------------------------------------------------------------------------

describe('delegated conversation identity (R18)', () => {
    it('mints the conversation id on the adopted child row, in the same patch as its invocation id', () => {
        const result = fold(clone(DELEGATION));

        // Root = the turn's own conversation; child = the delegated conversation,
        // indented under the row that spawned it.
        expect(identityOf(result.display())).toEqual([
            {
                id: 'turn-1:0',
                role: 'primary',
                agent: 'lead',
                agentLabel: 'IT1',
                threadLabel: 'IT1',
                invocationId: '1',
                threadId: 'thread-1',
                state: 'streaming'
            },
            {
                id: 'turn-1:1',
                parentSectionId: 'turn-1:0',
                role: 'subagent',
                agent: 'helper',
                agentLabel: 'RR1',
                threadLabel: 'RR1',
                invocationId: '2',
                threadId: 'thread-2',
                state: 'done'
            }
        ]);

        // Adoption is ONE patch carrying identity and state together, so a watcher never
        // sees a row addressable by invocation but not by conversation.
        expect(patchesFor(result.ops, 'turn-1:1')[0]).toEqual({
            invocationId: '2',
            state: 'streaming',
            threadId: 'thread-2',
            agentLabel: 'RR1',
            threadLabel: 'RR1'
        });

        // The placeholder row opened BEFORE an invocation existed honestly carries no
        // conversation id: the key is absent, not `undefined` (R18e).
        const placeholder = openedSections(result.ops)[1].section;

        expect(placeholder).toMatchObject({ id: 'turn-1:1', agent: 'helper' });
        expect(Object.prototype.hasOwnProperty.call(placeholder, 'threadId')).toBe(false);

        // One bar per conversation: every segment names the row that owns it, and the
        // delegated answer is its OWN segment, not the parent's.
        expect(barsOf(result.display())).toEqual([
            [
                ['user', 'prompt', 'turn-1:0'],
                ['tool', 'delegate', 'turn-1:0']
            ],
            [['assistant', 'answer', 'turn-1:1']]
        ]);
    });

    it('gives a child row its conversation id when no placeholder was minted', () => {
        // A recorded stream that names a child invocation the parent never announced (a
        // hand-written reporter, or a run whose spawn call was dropped): `createChild`
        // still resolves the conversation.
        const result = fold([
            rootStart('1'),
            childStart('2', '1', 'delegate-9', 'helper', 'child work'),
            done('helper', childThread('2', '1', 'delegate-9'))
        ]);

        // T20: this row ALSO carries `parentSectionId`. Its `thread.parentId` names the
        // turn's own run by INVOCATION id ('1'), and `newSection` resolves a parent through
        // `byKey` (section keys) AND `byInvocation` (runtime invocation ids), because the
        // root flow is registered under `ROOT_KEY` while its frames name its invocation
        // (./turn-projector.ts `newSection`). Before that second lookup only the
        // placeholder path — a recorded `delegate` call — produced a hierarchy link, so a
        // stream like this one lost the parent on the wire while still knowing it.
        expect(identityOf(result.display())[1]).toEqual({
            id: 'turn-1:1',
            parentSectionId: 'turn-1:0',
            role: 'subagent',
            agent: 'helper',
            agentLabel: 'RR1',
            threadLabel: 'RR1',
            invocationId: '2',
            threadId: 'thread-2',
            state: 'done'
        });

        // This path opens the WHOLE row, so the conversation id is on the first frame a
        // watcher ever sees for it — no patch round trip.
        expect(openedSections(result.ops)[1].section).toMatchObject({
            id: 'turn-1:1',
            invocationId: '2',
            threadId: 'thread-2'
        });
    });

    it('keeps a child whose parent section does not exist yet flat, and renumbers nothing when the parent lands', () => {
        // LATE PARENT: a record that starts INSIDE the delegated run — the child's frames
        // arrive before the turn's own flow is ever seen (a reporter that opens on the
        // child, or a document truncated at the delegation). The child cannot be nested
        // under a section that does not exist yet, so it honestly reports no
        // `parentSectionId`, and the parent's arrival later does NOT renumber or re-parent
        // it: section ordinals are allocation order (../shared/turn-display.ts `TurnSection`)
        // and a client that already drew row 0 must not be told it is now row 1.
        const result = fold([
            childStart('2', '1', 'delegate-9', 'helper', 'child work'),
            text('helper', 'helper answer', childThread('2', '1', 'delegate-9')),
            rootStart('1'),
            done('helper', childThread('2', '1', 'delegate-9'))
        ]);

        expect(treeOf(result.display())).toEqual([
            // The child keeps ordinal 0 (it was allocated first) with no parent link, and
            // still names its own conversation: separable by `threadId` regardless. Its own
            // terminal frame closes it, exactly as it would in the normal order.
            ['turn-1:0', 'thread-2', '2', undefined, 'done'],
            // The turn's own flow is still recognised as the primary root by ROLE, which is
            // the figure `compiledEntryOf`/`rootSectionOf` check first (../frontend/ui/
            // turns.ts), so the tile body keeps the main conversation's prose. It stays
            // open: only the turn's own terminal frame settles it.
            ['turn-1:1', 'thread-1', '1', undefined, 'streaming']
        ]);

        // The child row keeps the conversation label of ITS conversation (`RR1`), not the
        // turn root's (`IT1`), even when it is the first row the fold ever opened.
        expect(identityOf(result.display())[0]).toMatchObject({
            agentLabel: 'RR1',
            threadLabel: 'RR1',
            role: 'subagent'
        });
        expect(identityOf(result.display())[1]).toMatchObject({
            agentLabel: 'IT1',
            threadLabel: 'IT1',
            role: 'primary'
        });
    });

    it('nests a second-level delegation with its own conversation id and keeps the parent link', () => {
        // [Main] → [RR1] → [RR2]. The live runtime caps a tree at two runs deep, so a
        // deeper row arrives from recorded state — the shape supports it
        // (../harness.threads.test.ts:11), and the fold must render it indented.
        const result = fold([
            rootStart('1'),
            delegateCall('delegate-1', 'helper', 'child work'),
            childStart('2', '1', 'delegate-1', 'helper', 'child work'),
            {
                type: 'tool_call',
                agent: 'helper',
                call: { id: 'run-1', name: 'ctx.run', arguments: JSON.stringify({ agent: 'deep', input: 'deeper' }) },
                thread: childThread('2', '1', 'delegate-1')
            },
            childStart('3', '2', 'run-1', 'deep', 'deeper'),
            text('deep', 'deep answer', childThread('3', '2', 'run-1')),
            done('deep', childThread('3', '2', 'run-1')),
            done('helper', childThread('2', '1', 'delegate-1'))
        ]);

        expect(identityOf(result.display())).toEqual([
            {
                id: 'turn-1:0',
                role: 'primary',
                agent: 'lead',
                agentLabel: 'IT1',
                threadLabel: 'IT1',
                invocationId: '1',
                threadId: 'thread-1',
                state: 'streaming'
            },
            {
                id: 'turn-1:1',
                parentSectionId: 'turn-1:0',
                role: 'subagent',
                agent: 'helper',
                agentLabel: 'RR1',
                threadLabel: 'RR1',
                invocationId: '2',
                threadId: 'thread-2',
                state: 'done'
            },
            {
                id: 'turn-1:2',
                parentSectionId: 'turn-1:1',
                role: 'subagent',
                agent: 'deep',
                agentLabel: 'RR2',
                threadLabel: 'RR2',
                invocationId: '3',
                threadId: 'thread-3',
                state: 'done'
            }
        ]);

        // Three conversations, three bars, and no segment crosses a row boundary: that is
        // what lets the client draw one bar per conversation instead of one per turn.
        expect(barsOf(result.display())).toEqual([
            [
                ['user', 'prompt', 'turn-1:0'],
                ['tool', 'delegate', 'turn-1:0']
            ],
            [['tool', 'ctx.run', 'turn-1:1']],
            [['assistant', 'answer', 'turn-1:2']]
        ]);
    });

    it('keeps one stable conversation id across a reused conversation and separates it from a sibling', () => {
        // Thread reuse: the SAME conversation runs twice (the store records both of its
        // invocations), and a third delegation to the same agent opens ANOTHER
        // conversation that must never collapse into it.
        const join = new Map([
            ['1', 'thread-1'],
            ['2', 'thread-2'],
            ['7', 'thread-2'],
            ['4', 'thread-4']
        ]);
        const labels = new Map([
            ['1', 'IT1'],
            ['2', 'RR1'],
            ['7', 'RR1'],
            ['4', 'RR2']
        ]);

        const result = fold(
            [
                rootStart('1'),
                delegateCall('delegate-1', 'helper', 'first'),
                childStart('2', '1', 'delegate-1', 'helper', 'first'),
                done('helper', childThread('2', '1', 'delegate-1')),
                delegateCall('delegate-2', 'helper', 'again'),
                childStart('7', '1', 'delegate-2', 'helper', 'again'),
                done('helper', childThread('7', '1', 'delegate-2')),
                delegateCall('delegate-3', 'helper', 'other'),
                childStart('4', '1', 'delegate-3', 'helper', 'other'),
                done('helper', childThread('4', '1', 'delegate-3'))
            ],
            { context: contextOf({ threadIds: join, labels }) }
        );

        expect(
            identityOf(result.display())
                .slice(1)
                .map((row) => ({ threadId: row.threadId, invocationId: row.invocationId, agentLabel: row.agentLabel }))
        ).toEqual([
            { threadId: 'thread-2', invocationId: '2', agentLabel: 'RR1' },
            // Reused conversation ⇒ the SAME id and the same label: one bar, one focus
            // target, even though this is a different run of it.
            { threadId: 'thread-2', invocationId: '7', agentLabel: 'RR1' },
            { threadId: 'thread-4', invocationId: '4', agentLabel: 'RR2' }
        ]);

        // Rows stay individually addressable: a distinct section id per run, and every one
        // of them names a conversation.
        expect(result.display().sections.map((section) => [section.id, section.threadId])).toEqual([
            ['turn-1:0', 'thread-1'],
            ['turn-1:1', 'thread-2'],
            ['turn-1:2', 'thread-2'],
            ['turn-1:3', 'thread-4']
        ]);
    });

    it('patches the conversation id once, on the first frame folded after a late join', () => {
        // Late join: the projector exists while the map is still empty (a roster slot the
        // runtime had not bound at the child's start). A COPIED context map could never
        // see the later write, because the store mutates this map in place.
        const join = new Map<string, string>();
        const result = fold(clone(DELEGATION.slice(0, 4)), {
            context: contextOf({ threadIds: join, labels: LABELS() })
        });

        // While the join is missing, the delegated row honestly reports no conversation
        // and receives no identity patch of any kind.
        expect(result.display().sections[1].threadId).toBeUndefined();
        expect(threadIdPatches(result.ops, 'turn-1:1')).toEqual([]);

        // The store records the mapping, and the next frame is folded.
        join.set('2', 'thread-2');

        const ops = result.push(usage('helper', childThread('2', '1', 'delegate-1')));

        // Exactly one patch, naming ONLY the field that moved, in THIS frame.
        expect(lateJoinPatches([ops])).toEqual([
            { op: 'section:set', turnId: 'turn-1', sectionId: 'turn-1:1', patch: { threadId: 'thread-2' } }
        ]);
        expect(result.display().sections[1].threadId).toBe('thread-2');

        // And it is never repeated: the terminal frame and every later read cost nothing.
        const settled = result.settle('done');

        expect(threadIdPatches([[...ops, ...settled]], 'turn-1:1')).toHaveLength(1);
        expect(result.display().sections[1]).toMatchObject({ threadId: 'thread-2', state: 'done' });
    });

    it('carries a join learned after the last event on the terminal settle ops', () => {
        // The quiet-turn case: nothing more is ever recorded, so `settle` is the only
        // frame left that can publish an id a live watcher would otherwise lose.
        const join = new Map<string, string>();
        const result = fold(clone(DELEGATION), { context: contextOf({ threadIds: join, labels: LABELS() }) });

        expect(result.display().sections[1].threadId).toBeUndefined();

        join.set('2', 'thread-2');

        const ops = result.settle('done');

        expect(lateJoinPatches([ops])).toEqual([
            { op: 'section:set', turnId: 'turn-1', sectionId: 'turn-1:1', patch: { threadId: 'thread-2' } }
        ]);
        expect(result.display().sections[1]).toMatchObject({ threadId: 'thread-2', state: 'done' });
    });

    it('omits threadId entirely when no join is recorded, so a legacy document is unchanged', () => {
        const result = fold(clone(DELEGATION), { context: { primary: 'lead' } });

        // The root still reports the conversation the RECORD names; the delegated row
        // reports none, and the key is ABSENT rather than `undefined`, so an old frame
        // stays byte-identical (R18e).
        expect(
            result.display().sections.map((section) => [
                section.id,
                Object.prototype.hasOwnProperty.call(section, 'threadId'),
                section.threadId
            ])
        ).toEqual([
            ['turn-1:0', true, 'thread-1'],
            ['turn-1:1', false, undefined]
        ]);

        expect(threadIdPatches(result.ops, 'turn-1:1')).toEqual([]);
        expect(openedSections(result.ops).map((op) => Object.prototype.hasOwnProperty.call(op.section, 'threadId'))).toEqual([
            true,
            false
        ]);
    });

    it('keeps a branch row on the conversation its own frame names, and never invents one', () => {
        // A fork branch owns no persistent conversation, so the store records no join for
        // it; its `branch_start` frame may still name the conversation it reads from
        // (`HarnessBranchSummary.threadId`).
        const branchEnd: HarnessEvent = { type: 'branch_end', agent: 'lead', branchId: 'branch-1', status: 'completed' };

        const withOwner = fold([rootStart('1'), branchStart('thread-1'), branchEnd]);

        expect(withOwner.display().sections[1]).toMatchObject({
            id: 'turn-1:1',
            role: 'subagent',
            agent: 'lead',
            branchId: 'branch-1',
            threadId: 'thread-1',
            state: 'done'
        });

        // A branch with no owner thread stays without one: the fold must not read the
        // branch id ('branch-1', never an invocation id) as a conversation, and the
        // late-join scan must never revisit a branch row.
        const bare = fold([rootStart('1'), branchStart(undefined), branchEnd]);

        expect(Object.prototype.hasOwnProperty.call(bare.display().sections[1], 'threadId')).toBe(false);
        expect(threadIdPatches(bare.ops, 'turn-1:1')).toEqual([]);
        expect(JOIN().has('branch-1')).toBe(false);
    });

    it('resolves a steer addressed at a delegated conversation onto that conversation’s own bar', () => {
        // A steer is a RECORD mutation adopted on the next frame whose stamp has reached
        // it, and its destination is resolved by `section.threadId` — which is exactly
        // why the id has to reach the row (R18). Without it, the segment is painted on
        // the parent's bar.
        const turn = turnOf({ steers: [{ at: 1_020, prompt: 'deeper please', threadId: 'thread-2' }] });

        const result = fold(clone(DELEGATION.slice(0, 3)), { turn });
        const child = result.display().sections[1];

        expect(child.threadId).toBe('thread-2');
        expect((child.context ?? []).map((block) => [block.kind, block.name, block.chars, block.sectionId])).toEqual([
            ['user', 'steer', 13, 'turn-1:1']
        ]);

        // The parent's bar keeps only its own segments.
        expect(barsOf(result.display())[0]).toEqual([
            ['user', 'prompt', 'turn-1:0'],
            ['tool', 'delegate', 'turn-1:0']
        ]);

        // The row's destination field agrees with the bar, so a client needs no rule of
        // its own about which conversation the guidance reached.
        expect(result.summary().steers).toEqual([
            { at: 1_020, prompt: 'deeper please', sectionId: 'turn-1:1', threadId: 'thread-2' }
        ]);
    });

    it('folds live and cold to the same identity tree', () => {
        // The one rule the projector rests on: the op SEQUENCE may differ, the resulting
        // TREE may not.
        const live = fold(clone(DELEGATION));

        live.settle('done');

        const cold = projectTurn(
            turnOf({
                status: 'done',
                updatedAt: 5_000,
                events: clone(DELEGATION),
                eventTimes: DELEGATION.map((_, index) => timeOf(index))
            }),
            REPLAY()
        );

        expect(treeOf(cold.display)).toEqual([
            ['turn-1:0', 'thread-1', '1', undefined, 'done'],
            ['turn-1:1', 'thread-2', '2', 'turn-1:0', 'done']
        ]);
        expect(treeOf(live.display())).toEqual(treeOf(cold.display));
        expect(identityOf(live.display())).toEqual(identityOf(cold.display));
    });
});

describe('a retry inside a delegated conversation (R19)', () => {
    it('mints no notice, keeps the row streaming, and keeps its conversation id', () => {
        const result = fold([
            rootStart('1'),
            delegateCall('delegate-1', 'helper', 'child work'),
            childStart('2', '1', 'delegate-1', 'helper', 'child work'),
            text('helper', 'half an answer', childThread('2', '1', 'delegate-1')),
            retry('helper', childThread('2', '1', 'delegate-1')),
            text('helper', 'helper answer', childThread('2', '1', 'delegate-1')),
            done('helper', childThread('2', '1', 'delegate-1'))
        ]);

        const retryOps = result.ops[4];

        // A retry is the server still working: no row, no notice chip, no identity churn.
        // It owes only the ops that drop the FAILED attempt's own prose and its bar
        // segment (the child row's own ordinal is 1, its prose opened at event 3) — plus the
        // R23 statement that this row now has no block to display, since the only one it
        // had went with the attempt.
        expect(retryOps).toEqual([
            { op: 'context:remove', turnId: 'turn-1', sectionId: 'turn-1:1', blockId: '1-assistant-3' },
            { op: 'attempt:discard', turnId: 'turn-1', sectionId: 'turn-1:1', nodeIds: ['n3'] },
            { op: 'tail:clear', turnId: 'turn-1', sectionId: 'turn-1:1' }
        ]);
        expect(retryOps.filter((op) => op.op === 'node:insert')).toEqual([]);
        expect(retryOps.filter((op) => op.op === 'section:set')).toEqual([]);

        const child = result.display().sections[1];

        // The retried attempt is gone; the row is still its own conversation, still
        // nested, and its retried prose never stayed in the bar.
        expect(child.nodes.filter((node) => node.kind === 'notice')).toEqual([]);
        expect(child.nodes.map((node) => node.kind)).toEqual(['text']);
        expect(child).toMatchObject({ threadId: 'thread-2', invocationId: '2', parentSectionId: 'turn-1:0' });

        // Streaming until a REAL terminal frame: the delegated agent is still live work
        // during the backoff ('lead' is listed too, because the parent's delegate call has
        // not returned yet in this fixture).
        const retrying = fold([
            rootStart('1'),
            delegateCall('delegate-1', 'helper', 'child work'),
            childStart('2', '1', 'delegate-1', 'helper', 'child work'),
            text('helper', 'half an answer', childThread('2', '1', 'delegate-1')),
            retry('helper', childThread('2', '1', 'delegate-1'))
        ]);

        expect(retrying.display().sections[1]).toMatchObject({ state: 'streaming', threadId: 'thread-2' });
        expect(retrying.summary().activeAgents).toEqual(['lead', 'helper']);
        expect(retrying.summary().state).toBe('streaming');

        // The exhausted case stays terminal and stays visible: the run's own `error`
        // frame mints exactly one notice, on THAT conversation's row.
        const failed = fold([
            rootStart('1'),
            delegateCall('delegate-1', 'helper', 'child work'),
            childStart('2', '1', 'delegate-1', 'helper', 'child work'),
            {
                type: 'error',
                agent: 'helper',
                error: { message: 'upstream timed out' },
                thread: childThread('2', '1', 'delegate-1')
            }
        ]);

        expect(failed.display().sections[1].nodes.filter((node) => node.kind === 'notice')).toEqual([
            { kind: 'notice', id: 'n3', tone: 'error', text: 'upstream timed out', at: 1_030 }
        ]);
        expect(failed.display().sections[1]).toMatchObject({ state: 'error', threadId: 'thread-2' });
    });

    it('drops a retried attempt’s placeholder without ever giving it a conversation id', () => {
        // F2: a failed root attempt removes the child row it minted. That row must go
        // WITHOUT ever claiming a conversation, so a retried request that re-issues the
        // same call id cannot inherit a stale one.
        const result = fold([
            rootStart('1'),
            delegateCall('delegate-1', 'helper', 'child work'),
            retry('lead'),
            delegateCall('delegate-1', 'helper', 'child work'),
            childStart('2', '1', 'delegate-1', 'helper', 'child work'),
            done('helper', childThread('2', '1', 'delegate-1'))
        ]);

        // The discarded row never received an identity patch of any kind.
        expect(result.ops.flat().filter((op) => op.op === 'section:remove')).toEqual([
            { op: 'section:remove', turnId: 'turn-1', sectionId: 'turn-1:1' }
        ]);
        expect(threadIdPatches(result.ops, 'turn-1:1')).toEqual([]);

        // The row that takes its place is born with the conversation id, and only one row
        // per invocation ever claims it.
        expect(threadIdPatches(result.ops).map((patch) => [patch.sectionId, patch.patch.threadId])).toEqual([
            // The root's own `start` patch: that id comes from the record, as always.
            ['turn-1:0', 'thread-1'],
            ['turn-1:2', 'thread-2']
        ]);
        expect(identityOf(result.display())[1]).toMatchObject({
            id: 'turn-1:2',
            invocationId: '2',
            threadId: 'thread-2',
            parentSectionId: 'turn-1:0'
        });
    });
});

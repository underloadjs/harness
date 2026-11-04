// Direct tests for the browser's DISPLAY STATE (R1 compact view, R3 no client-side
// compilation): the compiled document, the `TurnDisplayOp` stream that mutates it, and
// the questions the shell asks the result.
//
// WHY THESE FIXTURES ARE HAND-WRITTEN
// ----------------------------------
// `view-test-support.ts` turns a RAW `SessionSnapshot` into the display wire using the
// SERVER'S OWN projector. That is the right double for an end-to-end shell test, but it
// cannot prove THIS module: if the projector and the reducer agreed on a wrong shape, the
// shell test would still be green. Every fixture here is written straight from
// `src/shared/turn-display.ts` (the frozen contract), so each rule below is pinned by the
// contract's own words: id-addressing (turn-display.ts:36), `section:remove`
// (turn-display.ts:530), the `node:set {text}` server-stated replacement of ONE node's
// text (turn-display.ts `DisplayNodePatch`: a notice line, a bounded think window, a
// superseded answer),
// `step:set` replacing whole (turn-display.ts:513) and the terminal `view` frame being the
// reconciliation point (turn-display.ts:521).
//
// Run: npx vitest run --config src/frontend/vitest.config.ts view-state.test.ts

import type { HarnessPendingTool } from '../types';
import type {
    DisplayBlockSummary,
    DisplayNode,
    DisplayPanelSummary,
    DisplayStep,
    TurnDisplay,
    TurnDisplayOp,
    TurnSection,
    TurnSummary
} from '../shared/turn-display';
import type { SessionView, SubmitTaskViewResult } from '../server/protocol';
import { describe, expect, it } from 'vitest';
import {
    activeAgentsOf,
    applyOpToDisplay,
    applyOpsToActivity,
    applyOpsToDisplay,
    applySubmitViewResult,
    blocksOf,
    createViewStateStore,
    displayOf,
    findNode,
    isNewerSummary,
    isPendingView,
    nodesOf,
    panelEntriesOf,
    pendingKeyOf,
    sectionsOf,
    stepIndex,
    stepsOf,
    summariesOf,
    transcriptTurnIdsOf,
    turnIdsOf,
    upsertSummary
} from './view-state';

const T = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Fixtures — the wire shapes spelled out (no server, no fold, no shim)
// ---------------------------------------------------------------------------

const summary = (overrides: Partial<TurnSummary> = {}): TurnSummary => ({
    id: 't1',
    index: 0,
    prompt: 'go',
    status: 'running',
    state: 'streaming',
    updatedAt: T,
    sectionCount: 1,
    stepCount: 0,
    activeAgents: [],
    blocks: [],
    ...overrides
});

const section = (id: string, overrides: Partial<TurnSection> = {}): TurnSection => ({
    id,
    role: 'primary',
    agent: 'instruct',
    agentLabel: 'RR1',
    state: 'streaming',
    nodes: [],
    ...overrides
});

const display = (turnId: string, sections: TurnSection[] = []): TurnDisplay => ({ turnId, sections });

const view = (turns: TurnSummary[], displays: Record<string, TurnDisplay> = {}): SessionView =>
    ({
        id: 's1',
        harness: 'instruct',
        // An IDLE session by default: the pending questions below are about ROWS, and a
        // running session flag would answer them before the row was even consulted.
        status: 'idle',
        model: 'm1',
        createdAt: T,
        updatedAt: T,
        turns,
        displays
    }) as SessionView;

const panel = (id: string, overrides: Partial<DisplayPanelSummary> = {}): DisplayPanelSummary => ({
    id,
    slot: 'scratch',
    title: `Panel ${id}`,
    blocks: [{ type: 'keyValue', items: 2 }],
    preview: 'open 2',
    truncated: true,
    totalPanels: 1,
    ...overrides
});

const step = (overrides: Partial<DisplayStep> = {}): DisplayStep => ({
    kind: 'tool',
    id: '7',
    turnId: 't1',
    sectionId: 't1:0',
    name: 'read',
    argsPreview: '{"path":"a"}',
    state: 'running',
    detail: { stepId: '7', hasResult: false, truncated: true },
    ...overrides
});

const prose = (id: string, value: string, committed = false): DisplayNode => ({
    kind: 'text',
    id,
    text: value,
    committed
});

const notice = (
    id: string,
    value: string,
    tone: 'info' | 'error' | 'retry' | 'wake' | 'steer' | 'answer' = 'info'
): DisplayNode => ({ kind: 'notice', id, tone, text: value });

const tool = (callId: string, name: string): HarnessPendingTool => ({ callId, name, elapsedMs: 1_200 });

// A fresh tree for one op assertion: a root section holding prose, the per-section status
// notice and a tool step, so every addressing rule has something to address.
const sampleDisplay = (): TurnDisplay =>
    display('t1', [section('t1:0', { nodes: [prose('n0', 'half'), notice('pending', 'pending · read 1.2s'), step()] })]);

// A fresh pending map per test: the reducer takes it as a parameter, and a shared map
// would let one test's snapshot answer another test's question.
const freshPending = (): Map<string, HarnessPendingTool[]> => new Map();

// ---------------------------------------------------------------------------
// Read helpers — every access is a lookup, and a malformed document never throws
// ---------------------------------------------------------------------------

describe('read helpers', () => {
    it('reads rows, trees, ids and nodes out of a compiled document', () => {
        const document = view(
            [summary({ id: 't1' }), summary({ id: 't2', index: 1 })],
            { t1: display('t1', [section('t1:0', { nodes: [step({ id: '3' })] })]) }
        );

        expect(summariesOf(document).map((row) => row.id)).toEqual(['t1', 't2']);
        expect(turnIdsOf(document)).toEqual(['t1', 't2']);
        expect(displayOf(document, 't1')?.turnId).toBe('t1');
        expect(displayOf(document, 't2')).toBeUndefined();
        expect(sectionsOf(displayOf(document, 't1') as TurnDisplay).map((entry) => entry.id)).toEqual(['t1:0']);
        expect(nodesOf(sectionsOf(displayOf(document, 't1') as TurnDisplay)[0]).map((node) => node.id)).toEqual(['3']);
    });

    it('treats a null tree map and an absent section as nothing, never a guess', () => {
        const bare = { ...view([]), displays: null } as unknown as SessionView;

        expect(displayOf(bare, 't1')).toBeUndefined();
        expect(summariesOf(undefined)).toEqual([]);
        expect(sectionsOf(undefined)).toEqual([]);
        expect(nodesOf(undefined)).toEqual([]);
        expect(stepsOf(undefined)).toEqual([]);
    });

    it('collects only the addressable steps, in section order then node order', () => {
        const tree = display('t1', [
            section('t1:1', { role: 'subagent', agent: 'helper', nodes: [step({ id: '2' }), prose('n0', 'prose')] }),
            section('t1:0', { nodes: [step({ id: '0', name: 'delegate' })] })
        ]);

        expect(stepsOf(tree).map((entry) => entry.id)).toEqual(['2', '0']);
    });
});

// ---------------------------------------------------------------------------
// Derived state — the questions the rail, the rings and the composer ask
// ---------------------------------------------------------------------------

describe('derived state', () => {
    it('calls a view pending on a running row, a queued row, a queue depth or a running session', () => {
        expect(isPendingView(view([summary({ status: 'running' })]))).toBe(true);
        expect(isPendingView(view([summary({ status: 'queued', state: 'queued' })]))).toBe(true);
        expect(isPendingView(view([summary({ status: 'done', state: 'done' })]))).toBe(false);
        expect(isPendingView({ ...view([summary({ status: 'done', state: 'done' })]), queueDepth: 2 } as SessionView)).toBe(true);
        expect(isPendingView({ ...view([summary({ status: 'done', state: 'done' })]), queueDepth: 0 } as SessionView)).toBe(false);
        expect(isPendingView({ ...view([summary({ status: 'done', state: 'done' })]), status: 'running' } as SessionView)).toBe(true);
        expect(isPendingView(undefined)).toBe(false);
    });

    it('lights only a running turn: its own active agents plus any section still working', () => {
        const document = view(
            [
                summary({ id: 't1', status: 'running', activeAgents: ['instruct'] }),
                summary({ id: 't9', status: 'done', state: 'done', activeAgents: ['ghost'] })
            ],
            {
                t1: display('t1', [
                    section('t1:0', { agent: 'instruct', state: 'streaming' }),
                    section('t1:1', { agent: 'helper', role: 'subagent', state: 'open' }),
                    section('t1:2', { agent: 'closed', role: 'subagent', state: 'done' })
                ]),
                t9: display('t9', [section('t9:0', { agent: 'late', state: 'streaming' })])
            }
        );

        // `closed` is excluded by its section state and `late` because a settled row may
        // never animate old work — the rule ui/activity.ts pins for the raw path too.
        expect([...activeAgentsOf(document)].sort()).toEqual(['helper', 'instruct']);
        expect([...activeAgentsOf(undefined)]).toEqual([]);
    });

    it('flattens the referenceable blocks of every row, oldest turn first', () => {
        const block = (turnId: string, label: string): DisplayBlockSummary => ({
            turnId,
            label,
            agent: 'instruct',
            status: 'done',
            preview: 'a line',
            referenceable: true
        });

        const document = view([
            summary({ id: 't1', blocks: [block('t1', 'RR1')] }),
            summary({ id: 't2', index: 1, blocks: [block('t2', 'RR2'), block('t2', 'RH1')] })
        ]);

        expect(blocksOf(document).map((entry) => entry.label)).toEqual(['RR1', 'RR2', 'RH1']);
        expect(blocksOf(view([]))).toEqual([]);
    });

    it('collects panel summaries under one tool+panel key, first position, newest value', () => {
        const panelStep = (overrides: Partial<DisplayStep> = {}): DisplayStep => step({ name: 'statusTool', ...overrides });

        const first = display('t1', [
            section('t1:0', {
                nodes: [
                    panelStep({ id: '1', panels: [panel('status'), panel('extra')] }),
                    // An owner question has no panels of its own.
                    panelStep({ id: '2', kind: 'action', name: 'ask', action: { requestId: 'r1', question: 'Which?', options: [], allowCustom: true, expired: false } })
                ]
            })
        ]);
        // A LATER turn publishing the same `${tool}${panel.id}` key replaces the entry but
        // keeps its position — the documented aggregation rule (view-state.ts:168-203).
        const second = display('t2', [
            section('t2:0', { nodes: [panelStep({ id: '5', turnId: 't2', sectionId: 't2:0', panels: [panel('status', { preview: 'open 9' })] })] })
        ]);

        const document = view([summary({ id: 't1' }), summary({ id: 't2', index: 1 })], { t1: first, t2: second });

        expect(panelEntriesOf(document).map((entry) => [entry.turnId, entry.turnIndex, entry.sectionId, entry.stepId, entry.tool, entry.panel.id, entry.panel.preview])).toEqual([
            ['t2', 1, 't2:0', '5', 'statusTool', 'status', 'open 9'],
            ['t1', 0, 't1:0', '1', 'statusTool', 'extra', 'open 2']
        ]);
        // A document whose rows carry no trees yields nothing (a `GET /views` summary row).
        expect(panelEntriesOf(view([summary({ id: 't9', status: 'done' })]))).toEqual([]);
    });

    it('indexes every step by `turn:node` id', () => {
        const document = view([summary({ id: 't1' })], {
            t1: display('t1', [section('t1:0', { nodes: [step({ id: '4' }), prose('n0', 'prose')] })])
        });

        const index = stepIndex(document);

        expect([...index.keys()]).toEqual(['t1:4']);
        expect(index.get('t1:4')).toEqual({ turnId: 't1', sectionId: 't1:0', step: step({ id: '4' }) });
    });

    it('selects the recorded turns a thread transcript needs from compiled state only', () => {
        const roster = [
            { id: 'th-a', invocationId: 'inv-a' },
            { id: 'th-b', ownerThreadId: 'th-a', invocationId: 'inv-b', invocationIds: ['inv-b'] }
        ];

        const document = view(
            [summary({ id: 't1', threadId: 'th-a' }), summary({ id: 't2' }), summary({ id: 't3', threadId: 'th-z' })],
            {
                // A foreign turn whose tree RAN a thread of this subtree contributes
                // events to the document, so its record has to be readable.
                t2: display('t2', [section('t2:0', { agent: 'helper', role: 'subagent', invocationId: 'inv-b' })]),
                t3: display('t3', [section('t3:0', { invocationId: 'inv-z' })])
            }
        );

        expect(transcriptTurnIdsOf(document, 'th-a', roster)).toEqual(['t1', 't2']);
        // With no roster the join collapses to the thread's OWN turns.
        expect(transcriptTurnIdsOf(document, 'th-a')).toEqual(['t1']);
        expect(transcriptTurnIdsOf(undefined, 'th-a', roster)).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// The op reducer — one addressed mutation at a time
// ---------------------------------------------------------------------------

describe('applyOpToDisplay', () => {
    it('opens a section once and keeps the ordinal counter the client needs', () => {
        const pending = freshPending();
        const tree = display('t1');
        const open = (sectionValue: TurnSection, turnId = 't1'): boolean =>
            applyOpToDisplay(tree, turnId, { op: 'section:open', turnId, section: sectionValue }, pending);

        expect(open(section('t1:0'))).toBe(true);
        // A re-delivered open (a reconnect replaying a frame) never duplicates the flow,
        // and never patches fields it did not send.
        expect(open(section('t1:0', { agentLabel: 'RR9' }))).toBe(true);
        expect(sectionsOf(tree).map((entry) => [entry.id, entry.agentLabel])).toEqual([['t1:0', 'RR1']]);
        expect(tree.lastSectionOrdinal).toBe(0);

        expect(open(section('t1:3', { role: 'subagent', agent: 'helper' }))).toBe(true);
        expect(sectionsOf(tree).map((entry) => entry.id)).toEqual(['t1:0', 't1:3']);
        expect(tree.lastSectionOrdinal).toBe(3);

        // A frame addressed to another turn's tree is dropped, not guessed at.
        expect(open(section('t9:0'), 't9')).toBe(false);
    });

    it('patches only the fields a section:set names', () => {
        const pending = freshPending();
        const tree = display('t1', [section('t1:0', { model: 'm1', latestInput: 10 })]);

        expect(
            applyOpToDisplay(tree, 't1', { op: 'section:set', turnId: 't1', sectionId: 't1:0', patch: { state: 'done', endedAt: T + 50 } }, pending)
        ).toBe(true);

        expect(sectionsOf(tree)[0]).toEqual({
            id: 't1:0',
            role: 'primary',
            agent: 'instruct',
            agentLabel: 'RR1',
            state: 'done',
            nodes: [],
            model: 'm1',
            latestInput: 10,
            endedAt: T + 50
        });
        expect(applyOpToDisplay(tree, 't1', { op: 'section:set', turnId: 't1', sectionId: 't1:9', patch: { state: 'done' } }, pending)).toBe(false);
    });

    it('removes a discarded section and the pending snapshot parked beside it', () => {
        const pending = freshPending();
        const tree = display('t1', [section('t1:0'), section('t1:1', { agent: 'helper', role: 'subagent', invocationId: 'inv-x' })]);

        expect(applyOpToDisplay(tree, 't1', { op: 'pending:set', turnId: 't1', sectionId: 't1:1', pending: [tool('c1', 'read')] }, pending)).toBe(true);
        expect(pending.get(pendingKeyOf('t1', 't1:1'))).toEqual([tool('c1', 'read')]);

        expect(applyOpToDisplay(tree, 't1', { op: 'section:remove', turnId: 't1', sectionId: 't1:1' }, pending)).toBe(true);
        expect(sectionsOf(tree).map((entry) => entry.id)).toEqual(['t1:0']);
        // The snapshot is addressed by turn+section: leaving it behind is a leak the next
        // `pending:set` for a re-used id could not see through.
        expect(pending.has(pendingKeyOf('t1', 't1:1'))).toBe(false);

        // Removing a section this client never adopted is a MISS, which tells the caller a
        // whole-document frame has to reconcile it.
        expect(applyOpToDisplay(tree, 't1', { op: 'section:remove', turnId: 't1', sectionId: 't1:7' }, pending)).toBe(false);
    });

    it('inserts by id, honours an explicit index, and never mints a duplicate', () => {
        const pending = freshPending();
        const tree = display('t1', [section('t1:0', { nodes: [prose('n0', 'first')] })]);
        const apply = (op: TurnDisplayOp): boolean => applyOpToDisplay(tree, 't1', op, pending);

        expect(apply({ op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: prose('n1', 'last') })).toBe(true);
        expect(apply({ op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: prose('n2', 'middle'), index: 1 })).toBe(true);
        expect(nodesOf(sectionsOf(tree)[0]).map((node) => node.id)).toEqual(['n0', 'n2', 'n1']);

        // Out-of-range and absent indexes append at the end (the server's order).
        expect(apply({ op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: prose('n3', 'tail'), index: 99 })).toBe(true);
        expect(nodesOf(sectionsOf(tree)[0]).map((node) => node.id)).toEqual(['n0', 'n2', 'n1', 'n3']);

        // A re-delivered insert keeps the ORIGINAL node (the id is the identity).
        expect(apply({ op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: prose('n0', 'again') })).toBe(true);
        expect((findNode(tree, 't1:0', 'n0') as DisplayNode & { text: string }).text).toBe('first');

        expect(apply({ op: 'node:insert', turnId: 't1', sectionId: 't1:9', node: prose('n5', 'x') })).toBe(false);
    });

    it('moves prose through node:append and treats a node:set text patch as server truth', () => {
        const pending = freshPending();
        const tree = sampleDisplay();
        const apply = (op: TurnDisplayOp): boolean => applyOpToDisplay(tree, 't1', op, pending);
        const textOf = (id: string): string => (findNode(tree, 't1:0', id) as DisplayNode & { text: string }).text;
        const metaOf = (id: string): { chars?: number; redacted?: true } => {
            const node = findNode(tree, 't1:0', id) as DisplayNode & { chars?: number; redacted?: true };

            // Only the metadata: `toEqual` ignores an absent `redacted`, so each assertion
            // states exactly what the tree must (and must not) carry.
            return { chars: node.chars, redacted: node.redacted };
        };

        expect(apply({ op: 'node:append', turnId: 't1', sectionId: 't1:0', nodeId: 'n0', delta: ' · more' })).toBe(true);
        expect(textOf('n0')).toBe('half · more');
        // T13: an UNREDACTED prose node's `chars` is the exact length of the bytes the
        // server sent — while a node is un-redacted its wire text IS its whole recorded
        // text (turn-display.ts:659), so the delta stream is the authoritative source for
        // the figure. Without this the live tree holds `chars: 0` where the reload holds
        // the real count, and the two trees are not the same document.
        expect(metaOf('n0')).toEqual({ chars: 11 });

        // A step's content never moves through `node:append` (it resends whole), and a
        // node the tree does not name is a miss.
        expect(apply({ op: 'node:append', turnId: 't1', sectionId: 't1:0', nodeId: '7', delta: 'x' })).toBe(false);
        expect(apply({ op: 'node:append', turnId: 't1', sectionId: 't1:9', nodeId: 'n0', delta: 'x' })).toBe(false);
        expect(apply({ op: 'node:append', turnId: 't1', sectionId: 't1:0', nodeId: 'n0', delta: '' })).toBe(true);
        expect(textOf('n0')).toBe('half · more');

        // T4's addition, honored: the per-section status line is rewritten IN PLACE, so a
        // row that moves many times per turn never flickers.
        expect(apply({ op: 'node:set', turnId: 't1', sectionId: 't1:0', nodeId: 'pending', patch: { text: 'pending · read 2.4s' } })).toBe(true);
        expect(textOf('pending')).toBe('pending · read 2.4s');
        expect(nodesOf(sectionsOf(tree)[0]).map((node) => node.id)).toEqual(['n0', 'pending', '7']);

        // T13 (contract decision): the SAME patch kind is authoritative for PROSE too. The
        // projector replaces a think window's text when the wire hits its cap, and a
        // superseded answer's text at redaction (../server/turn-projector.ts
        // `redactSuperseded`), and the cold `display()` carries the identical string — so
        // applying it is what makes the live tree the reloaded tree. Only the fields the
        // patch NAMES move: a `text`-only patch does not restate the length.
        expect(apply({ op: 'node:set', turnId: 't1', sectionId: 't1:0', nodeId: 'n0', patch: { text: 'rewritten' } })).toBe(true);
        expect(textOf('n0')).toBe('rewritten');
        expect(metaOf('n0')).toEqual({ chars: 11 });

        // The full redaction patch: preview bytes + the EXACT recorded count + the marker,
        // in one op, exactly as `redactSuperseded` sends it.
        expect(
            apply({
                op: 'node:set',
                turnId: 't1',
                sectionId: 't1:0',
                nodeId: 'n0',
                patch: { text: 'half · m\u2026', chars: 4_010, redacted: true }
            })
        ).toBe(true);
        expect(textOf('n0')).toBe('half · m\u2026');
        expect(metaOf('n0')).toEqual({ chars: 4_010, redacted: true });

        // Once the node is marked redacted the preview is NOT a measurement source: a late
        // delta moves the text, and only the server's next `chars` patch moves the figure.
        expect(apply({ op: 'node:append', turnId: 't1', sectionId: 't1:0', nodeId: 'n0', delta: 'x' })).toBe(true);
        expect(textOf('n0')).toBe('half · m\u2026x');
        expect(metaOf('n0')).toEqual({ chars: 4_010, redacted: true });

        // `committed` belongs to prose, `share` to a think chip, and a step ignores both.
        expect(apply({ op: 'node:set', turnId: 't1', sectionId: 't1:0', nodeId: 'n0', patch: { committed: true } })).toBe(true);
        expect((findNode(tree, 't1:0', 'n0') as DisplayNode & { committed: boolean }).committed).toBe(true);
        expect(apply({ op: 'node:set', turnId: 't1', sectionId: 't1:0', nodeId: '7', patch: { share: 12 } })).toBe(true);
        expect(findNode(tree, 't1:0', '7')).toEqual(step());
        expect(apply({ op: 'node:set', turnId: 't1', sectionId: 't1:0', nodeId: 'nope', patch: { committed: true } })).toBe(false);
    });

    it('replaces a step object whole and recovers a step whose insert was missed', () => {
        const pending = freshPending();
        const tree = sampleDisplay();
        const settled = step({
            preview: 'ok',
            state: 'ok',
            outcome: 'completed',
            detail: { stepId: '7', resultStepId: '9', hasResult: true, truncated: false }
        });

        expect(applyOpToDisplay(tree, 't1', { op: 'step:set', turnId: 't1', sectionId: 't1:0', step: settled }, pending)).toBe(true);
        // REPLACED, not merged: no leftover field of the running row survives.
        expect(findNode(tree, 't1:0', '7')).toEqual({
            kind: 'tool',
            id: '7',
            turnId: 't1',
            sectionId: 't1:0',
            name: 'read',
            argsPreview: '{"path":"a"}',
            preview: 'ok',
            state: 'ok',
            outcome: 'completed',
            detail: { stepId: '7', resultStepId: '9', hasResult: true, truncated: false }
        });

        // A `step:set` for a step the client never inserted appends it (the ordering
        // contract says the insert came first; recovery keeps the tree equal to the
        // server's instead of losing a settled call forever).
        const empty = display('t1', [section('t1:0')]);
        expect(applyOpToDisplay(empty, 't1', { op: 'step:set', turnId: 't1', sectionId: 't1:0', step: step({ id: '8' }) }, pending)).toBe(true);
        expect(nodesOf(sectionsOf(empty)[0]).map((node) => node.id)).toEqual(['8']);
        expect(applyOpToDisplay(empty, 't1', { op: 'step:set', turnId: 't1', sectionId: 't1:9', step: step({ id: '9' }) }, pending)).toBe(false);
    });

    it('removes one node, drops exactly the nodes a discarded attempt names, and commits the rest', () => {
        const pending = freshPending();
        const tree = display('t1', [section('t1:0', { nodes: [prose('n0', 'kept', true), prose('n1', 'dropped'), prose('n2', 'uncommitted')] })]);
        const apply = (op: TurnDisplayOp): boolean => applyOpToDisplay(tree, 't1', op, pending);

        expect(apply({ op: 'node:remove', turnId: 't1', sectionId: 't1:0', nodeId: 'n0' })).toBe(true);
        expect(nodesOf(sectionsOf(tree)[0]).map((node) => node.id)).toEqual(['n1', 'n2']);
        expect(apply({ op: 'node:remove', turnId: 't1', sectionId: 't1:0', nodeId: 'ghost' })).toBe(false);

        // `attempt:discard` names the exact nodes: the retry never depends on the client
        // tracking an attempt window.
        expect(apply({ op: 'attempt:discard', turnId: 't1', sectionId: 't1:0', nodeIds: ['n1'] })).toBe(true);
        expect(nodesOf(sectionsOf(tree)[0]).map((node) => node.id)).toEqual(['n2']);

        expect(apply({ op: 'attempt:commit', turnId: 't1', sectionId: 't1:0' })).toBe(true);
        expect((findNode(tree, 't1:0', 'n2') as DisplayNode & { committed: boolean }).committed).toBe(true);

        expect(apply({ op: 'attempt:commit', turnId: 't1', sectionId: 't1:9' })).toBe(false);
        expect(apply({ op: 'attempt:discard', turnId: 't1', sectionId: 't1:9', nodeIds: ['n1'] })).toBe(false);
    });

    it('treats a present pending array as the snapshot and an absent one as its removal', () => {
        const pending = freshPending();
        const tree = display('t1', [section('t1:0')]);
        const snapshot = [tool('c1', 'read')];
        const apply = (op: TurnDisplayOp): boolean => applyOpToDisplay(tree, 't1', op, pending);

        expect(apply({ op: 'pending:set', turnId: 't1', sectionId: 't1:0', pending: snapshot })).toBe(true);
        expect(pending.get(pendingKeyOf('t1', 't1:0'))).toEqual(snapshot);

        expect(apply({ op: 'pending:set', turnId: 't1', sectionId: 't1:0' })).toBe(true);
        expect(pending.has(pendingKeyOf('t1', 't1:0'))).toBe(false);

        // A snapshot for a section this client does not hold still replaces the entry
        // (it is data, not a claim about the tree), but the frame is reported as a MISS so
        // the caller knows the terminal `view` has to reconcile the tree.
        expect(apply({ op: 'pending:set', turnId: 't1', sectionId: 't1:8', pending: snapshot })).toBe(false);
        expect(pending.get(pendingKeyOf('t1', 't1:8'))).toEqual(snapshot);
    });

    it('separates the turn-wide usage line from one invocation\u2019s own figures', () => {
        const pending = freshPending();
        const tree = display('t1', [section('t1:0')]);
        const apply = (op: TurnDisplayOp): boolean => applyOpToDisplay(tree, 't1', op, pending);

        expect(apply({ op: 'usage', turnId: 't1', sectionId: 'turn', latestInput: 900, usage: { input: 900, cached: 10, output: 5 } })).toBe(true);
        expect(sectionsOf(tree)[0].latestInput).toBeUndefined();

        expect(apply({ op: 'usage', turnId: 't1', sectionId: 't1:0', latestInput: 120, cachedInput: 40 })).toBe(true);
        expect([sectionsOf(tree)[0].latestInput, sectionsOf(tree)[0].cachedInput]).toEqual([120, 40]);
        expect(apply({ op: 'usage', turnId: 't1', sectionId: 't1:6', latestInput: 1 })).toBe(false);
    });

    it('claims nothing for an op kind this client does not know', () => {
        const pending = freshPending();
        const tree = sampleDisplay();
        const future = { op: 'node:hologram', turnId: 't1', sectionId: 't1:0', nodeId: 'n0' } as unknown as TurnDisplayOp;

        expect(applyOpToDisplay(tree, 't1', future, pending)).toBe(false);
        // The row upsert lives on the VIEW, not on one tree, so it changes nothing here.
        expect(applyOpToDisplay(tree, 't1', { op: 'turn', turnId: 't1', summary: summary() }, pending)).toBe(true);
        expect(nodesOf(sectionsOf(tree)[0]).map((node) => node.id)).toEqual(['n0', 'pending', '7']);
    });
});

// ---------------------------------------------------------------------------
// Frames, rows and the document they mutate
// ---------------------------------------------------------------------------

describe('applyOpsToDisplay and upsertSummary', () => {
    it('applies a whole frame to one turn and ignores a tree it does not hold', () => {
        const pending = freshPending();
        const document = view([summary()], { t1: sampleDisplay() });

        applyOpsToDisplay(
            document,
            't1',
            [
                { op: 'node:append', turnId: 't1', sectionId: 't1:0', nodeId: 'n0', delta: '!' },
                { op: 'node:remove', turnId: 't1', sectionId: 't1:0', nodeId: 'pending' }
            ],
            pending
        );

        const tree = displayOf(document, 't1') as TurnDisplay;
        expect((findNode(tree, 't1:0', 'n0') as DisplayNode & { text: string }).text).toBe('half!');
        expect(nodesOf(sectionsOf(tree)[0]).map((node) => node.id)).toEqual(['n0', '7']);

        // A frame for a turn this document does not hold is a no-op, not an error.
        applyOpsToDisplay(document, 'tX', [{ op: 'node:remove', turnId: 'tX', sectionId: 'tX:0', nodeId: 'n0' }], pending);
        expect(nodesOf(sectionsOf(tree)[0]).map((node) => node.id)).toEqual(['n0', '7']);
    });

    it('upserts a row in place and never lets an older revision regress it', () => {
        const document = view([], {});

        upsertSummary(document, summary({ status: 'queued', state: 'queued', updatedAt: T + 10 }));
        upsertSummary(document, summary({ id: 't2', index: 1, updatedAt: T + 20 }));
        expect(document.turns.map((row) => row.id)).toEqual(['t1', 't2']);

        // The newest revision of t1 replaces it IN PLACE: the server's recorded order is
        // never re-sorted by the client.
        upsertSummary(document, summary({ updatedAt: T + 30 }));
        expect(document.turns.map((row) => row.id)).toEqual(['t1', 't2']);
        expect(document.turns[0].status).toBe('running');

        // A late 202 body (queued at T+20) is authoritative for nothing.
        upsertSummary(document, summary({ status: 'queued', state: 'queued', updatedAt: T + 20 }));
        expect(document.turns[0].status).toBe('running');

        // An equal stamp is the SAME moment, so it still applies (the N2 tie policy: a
        // drain frame may share its millisecond with the last event).
        upsertSummary(document, summary({ status: 'done', state: 'done', detail: 'm1', updatedAt: T + 30 }));
        expect([document.turns[0].status, document.turns[0].detail]).toEqual(['done', 'm1']);

        // The comparison itself: no known row, a newer incoming row and an unstamped row
        // are all "apply it".
        expect(isNewerSummary(undefined, summary())).toBe(false);
        expect(isNewerSummary(summary({ updatedAt: T + 5 }), summary({ updatedAt: T + 9 }))).toBe(false);
        expect(isNewerSummary(summary({ updatedAt: T + 9 }), summary({ updatedAt: undefined as unknown as number }))).toBe(false);
    });

    it('prunes a display tree whose row the document no longer names', () => {
        const document = view([summary({ id: 't1' })], { t1: sampleDisplay(), t9: display('t9') });

        upsertSummary(document, summary({ id: 't1' }));

        expect(Object.keys(document.displays)).toEqual(['t1']);
    });
});

// ---------------------------------------------------------------------------
// The store the shell holds, including the reconnect contract
// ---------------------------------------------------------------------------

describe('createViewStateStore', () => {
    it('applies view, ops and failed frames and reports what each one touched', () => {
        const store = createViewStateStore();

        expect(store.view()).toBeUndefined();
        expect(store.applyItem({ type: 'nonsense' } as never)).toEqual({ kind: 'ignored', turnIds: [] });

        const document = view([summary({ id: 't1' })], { t1: display('t1', [section('t1:0')]) });
        const opened = store.applyItem({ type: 'view', view: document });
        expect(opened.kind).toBe('view');
        expect(opened.turnIds).toEqual(['t1']);
        expect(opened.view).toBe(document);

        const frame = store.applyItem({
            type: 'ops',
            turnId: 't1',
            at: T + 1,
            ops: [
                { op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: prose('n0', 'hel') },
                { op: 'node:append', turnId: 't1', sectionId: 't1:0', nodeId: 'n0', delta: 'lo' }
            ]
        });
        expect(frame).toEqual({ kind: 'ops', turnIds: ['t1'], ops: frame.ops });
        const live = displayOf(store.view() as SessionView, 't1') as TurnDisplay;
        expect((findNode(live, 't1:0', 'n0') as DisplayNode & { text: string }).text).toBe('hello');

        const failed = store.applyItem({
            type: 'failed',
            error: { message: 'boom' } as never,
            view: view([summary({ id: 't1', status: 'error', state: 'error' })])
        });
        expect(failed.kind).toBe('failed');
        expect(failed.turnIds).toEqual(['t1']);
        // The error terminal is self-sufficient: the tree map it carries replaces the live
        // one, so a half-painted flow cannot survive a failure.
        expect(displayOf(store.view() as SessionView, 't1')).toBeUndefined();

        store.reset();
        expect(store.view()).toBeUndefined();
        store.applyItem({ type: 'ops', turnId: 't1', at: T, ops: [] });
        expect(store.view()).toBeUndefined();
    });

    it('reconciles the ops a connection missed with the closing view frame', () => {
        const store = createViewStateStore();
        store.setView(view([summary({ id: 't1' })], { t1: display('t1', [section('t1:0')]) }));

        // One frame lands, the next is lost (a dropped connection), and the drain frame
        // carries the whole truth: text must appear ONCE, never twice.
        store.applyItem({
            type: 'ops',
            turnId: 't1',
            at: T,
            ops: [{ op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: prose('n0', 'one') }]
        });

        const drained = view([summary({ id: 't1', status: 'done', state: 'done' })], {
            t1: display('t1', [section('t1:0', { state: 'done', nodes: [prose('n0', 'one', true), step({ id: '3', state: 'ok', outcome: 'completed' })] })])
        });
        store.applyItem({ type: 'view', view: drained });

        const tree = displayOf(store.view() as SessionView, 't1') as TurnDisplay;
        expect(nodesOf(sectionsOf(tree)[0]).map((node) => node.id)).toEqual(['n0', '3']);
        expect((findNode(tree, 't1:0', 'n0') as DisplayNode & { text: string }).text).toBe('one');
    });

    it('owns the per-section pending snapshots, and a whole document clears them', () => {
        const store = createViewStateStore();
        store.setView(view([summary()], { t1: display('t1', [section('t1:0')]) }));

        store.applyItem({ type: 'ops', turnId: 't1', at: T, ops: [{ op: 'pending:set', turnId: 't1', sectionId: 't1:0', pending: [tool('c', 'read')] }] });
        expect(store.pendingOf('t1', 't1:0')).toEqual([tool('c', 'read')]);
        expect(store.pendingOf('t1', 't1:9')).toBeUndefined();

        // A fresh document says nothing about pending work: the snapshots arrive only
        // through ops, so a partial connection's leftovers must not survive it.
        store.setView(view([summary()], { t1: display('t1', [section('t1:0')]) }));
        expect(store.pendingOf('t1', 't1:0')).toBeUndefined();
    });

    it('installs the view a submit answer carries and ignores an answer without one', () => {
        const store = createViewStateStore();
        const answer = { view: view([summary({ id: 't1' })]), turn: summary({ id: 't1' }) } as SubmitTaskViewResult;

        expect(applySubmitViewResult(store, answer)?.turns.map((row) => row.id)).toEqual(['t1']);
        expect(store.view()?.turns[0].id).toBe('t1');
        expect(applySubmitViewResult(store, { turn: summary() } as never)).toBeUndefined();
        expect(applySubmitViewResult(store, null as never)).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Live activity from an ops frame — the display-wire replacement for the event reducer
// ---------------------------------------------------------------------------

describe('applyOpsToActivity', () => {
    const running = view([summary({ id: 't1', status: 'running' })], {
        t1: display('t1', [
            section('t1:0', { agent: 'instruct', state: 'streaming' }),
            section('t1:1', { agent: 'helper', role: 'subagent', state: 'streaming' })
        ])
    });

    const frame = (active: Set<string>, ops: TurnDisplayOp[], document: SessionView | undefined = running): Set<string> => {
        applyOpsToActivity(active, document, 't1', ops);
        return active;
    };

    it('lights an agent for the work its own invocation produced', () => {
        const active = new Set<string>();

        frame(active, [{ op: 'node:append', turnId: 't1', sectionId: 't1:0', nodeId: 'n0', delta: 'hi' }]);
        expect([...active]).toEqual(['instruct']);

        frame(active, [{ op: 'step:set', turnId: 't1', sectionId: 't1:1', step: step({ sectionId: 't1:1' }) }]);
        expect([...active].sort()).toEqual(['helper', 'instruct']);

        frame(active, [{ op: 'pending:set', turnId: 't1', sectionId: 't1:1', pending: [tool('c1', 'read')] }]);
        expect([...active].sort()).toEqual(['helper', 'instruct']);

        // The TURN-wide usage line names no invocation, so it lights nobody new.
        frame(active, [{ op: 'usage', turnId: 't1', sectionId: 'turn', latestInput: 1 }]);
        expect([...active].sort()).toEqual(['helper', 'instruct']);

        // An agent this tree never names (another tab's section) cannot be resolved, so
        // the frame is a no-op rather than a guess.
        frame(active, [{ op: 'node:append', turnId: 't1', sectionId: 't1:7', nodeId: 'n0', delta: 'x' }]);
        expect([...active].sort()).toEqual(['helper', 'instruct']);
    });

    it('closes one agent when its section settles and keeps a delegated sibling lit', () => {
        const active = new Set(['instruct', 'helper']);

        frame(active, [{ op: 'section:set', turnId: 't1', sectionId: 't1:1', patch: { state: 'done' } }]);
        expect([...active]).toEqual(['instruct']);

        frame(active, [{ op: 'section:set', turnId: 't1', sectionId: 't1:0', patch: { state: 'error' } }]);
        expect([...active]).toEqual([]);

        // A patch that only moves a model or a label changes nobody's ring.
        const kept = new Set(['instruct']);
        frame(kept, [{ op: 'section:set', turnId: 't1', sectionId: 't1:0', patch: { model: 'm2' } }]);
        expect([...kept]).toEqual(['instruct']);
    });

    it('treats an error notice as that agent going idle and a retry or wake as it working again', () => {
        const active = new Set(['instruct']);

        // The root's section state belongs to the TURN (turn-projector.ts:1330), so an
        // `error`-tone notice is the only compiled signal that THIS agent stopped; the raw
        // reducer formed the same figure from an `error` event.
        frame(active, [{ op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: notice('n9', 'boom', 'error') }]);
        expect([...active]).toEqual([]);

        frame(active, [{ op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: notice('n10', 'attempt 2 of 3 · retrying', 'retry') }]);
        expect([...active]).toEqual(['instruct']);

        frame(active, [{ op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: notice('n11', 'pending tools finished · continuing', 'wake') }]);
        expect([...active]).toEqual(['instruct']);

        // A brand new flow that opens already-settled never lights a ring.
        const only = new Set<string>();
        frame(only, [{ op: 'section:open', turnId: 't1', section: section('t1:5', { agent: 'late', role: 'subagent', state: 'done' }) }]);
        expect([...only]).toEqual([]);
    });

    it('never lights a turn that is not running, and clears the rings when its row settles', () => {
        const settled = view([summary({ id: 't1', status: 'done', state: 'done', activeAgents: ['ghost'] })], {
            t1: display('t1', [section('t1:0', { agent: 'instruct', state: 'done' })])
        });

        // Replaying a settled transcript must never animate old work.
        const quiet = frame(new Set<string>(), [{ op: 'node:insert', turnId: 't1', sectionId: 't1:0', node: prose('n0', 'late prose') }], settled);
        expect([...quiet]).toEqual([]);

        // A frame that ENDS the turn removes every agent it was holding — including one
        // the tree still paints as streaming, because the settled row's own
        // `activeAgents: []` is the figure (turn-projector.ts:1717).
        const live = new Set(['instruct', 'helper']);
        frame(live, [{ op: 'turn', turnId: 't1', summary: summary({ status: 'done', state: 'done', activeAgents: [] }) }]);
        expect([...live]).toEqual([]);

        // A running row upsert contributes the SERVER's figure verbatim.
        const up = new Set<string>();
        frame(up, [{ op: 'turn', turnId: 't1', summary: summary({ status: 'running', activeAgents: ['instruct'] }) }]);
        expect([...up]).toEqual(['instruct']);
    });

    it('unlights a discarded placeholder and stays neutral on content patches', () => {
        const active = new Set(['helper']);

        frame(active, [{ op: 'section:remove', turnId: 't1', sectionId: 't1:1' }]);
        expect([...active]).toEqual([]);

        const kept = new Set(['instruct']);
        frame(kept, [
            { op: 'node:set', turnId: 't1', sectionId: 't1:0', nodeId: 'n0', patch: { committed: true } },
            { op: 'node:remove', turnId: 't1', sectionId: 't1:0', nodeId: 'n0' },
            // T16 (R16a): this is the ENTIRE op set one transient retry now sends (the
            // server dropped the `retry`-tone notice with it). Nothing here may take the
            // ring off — a retried request is the same agent still working, which is what
            // the removed notice line used to re-assert.
            { op: 'context:remove', turnId: 't1', sectionId: 't1:0', blockId: '0-assistant-1' },
            { op: 'attempt:discard', turnId: 't1', sectionId: 't1:0', nodeIds: ['n0'] },
            { op: 'attempt:commit', turnId: 't1', sectionId: 't1:0' }
        ]);
        // `attempt:commit` is a mid-run signal (a committed request, more work may follow),
        // so it keeps the agent lit rather than clearing it.
        expect([...kept]).toEqual(['instruct']);
    });

    it('does nothing without a document', () => {
        const active = new Set(['instruct']);

        frame(active, [{ op: 'node:append', turnId: 't1', sectionId: 't1:0', nodeId: 'n0', delta: 'x' }], undefined);
        expect([...active]).toEqual(['instruct']);
    });
});

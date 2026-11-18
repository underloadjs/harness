// T-W10 — PARITY ACROSS THE TWO CLIENT FOLDS.
//
// The requirement's acceptance bar is "a live streamed fold and a reloaded/replayed fold must
// produce the same set of rows", and the browser has TWO folds:
//   RAW       the tile folds `HarnessEvent`s itself, one row per RUN (./turns.ts `entryFor` /
//             `entryForMeta`, now keyed by `runKeyOf` = `id\0epoch`) — the live SSE path and the
//             raw-snapshot replay. This is the fold that had no epoch rule; ./turns-run-epoch.test.ts
//             pins its split and its keys.
//   COMPILED  the tile renders server-addressed `TurnSection`s, one row per SECTION, keyed by
//             `section.id` (`compiledEntryOf`) — what a `/views` read and every reload of the
//             compiled plane serve. The server's projector already mints ONE section per run
//             (../../server/turn-projector.ts `isEpochBoundary`), so this plane legitimately hands
//             the client TWO sections that share ONE `invocationId`.
//
// This file is the seam between them: for one recycled-id turn, the compiled plane's rows and
// the raw fold's rows must be the SAME ROWS — same count, same order, same prose per row — and
// each plane must be stable between its own live door and its own reload door. A client that
// keyed or de-duplicated rows by `invocationId` (the defect T-W8 named) fails the cross-plane
// comparison even if each plane looked self-consistent, which is how the live board and the
// refresh used to disagree.
//
// The compiled fixture is HAND-WRITTEN: `turn-1:1` and `turn-1:2` both carry
// `invocationId: 'inv-16'`, the pair the accepted server fold produces for exactly this artifact
// (../server/turn-projector.test.ts asserts `turn-1:1`/`turn-1:2` → `inv-16`), and it is advanced
// through the REAL reducer (`applyOpsToDisplay`, the first step of `main.ts onViewItem`) so the
// DOM cannot drift from the addressed state.
//
// Run: yarn vitest run --config src/frontend/vitest.config.ts ui/turns-compiled-run-epoch.test.ts

import type { HarnessAssistantMessage, HarnessEvent, SessionTurn, SessionView } from '../../server/protocol';
import type { DisplayNode, TurnDisplayOp, TurnSection, TurnSummary } from '../../shared/turn-display';
import { applyOpsToDisplay } from '../view-state';
import { createTurnBoard, type TurnBoard } from './turns';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const T = 1_700_000_000_000;
const E1 = 'proc-4a13';
const E2 = 'proc-9f20';

// ---------------------------------------------------------------------------
// ONE turn, described twice: as the events the runtime emitted, and as the sections the
// server's projector folds out of exactly those events.
// ---------------------------------------------------------------------------

const doneMessage = (agent: string): HarnessAssistantMessage => ({
    role: 'assistant',
    content: 'answer',
    reasoning: '',
    toolCalls: [],
    model: `${agent}-model`,
    stopReason: 'stop'
});

const withThread = (event: Record<string, unknown>, thread: Record<string, unknown>): HarnessEvent =>
    ({ ...event, thread }) as unknown as HarnessEvent;

const hostThread = (epoch: string | undefined): Record<string, unknown> => ({
    id: 'inv-13',
    input: 'stress test the tools',
    ...(epoch === undefined ? {} : { epoch })
});

const childThread = (epoch: string | undefined): Record<string, unknown> => ({
    id: 'inv-16',
    parentId: 'inv-13',
    callId: 'call-1',
    kind: 'delegation',
    input: 'review the read tool',
    ...(epoch === undefined ? {} : { epoch })
});

// One delegated run: the parent's `delegate` call, the child's `start`, one prose figure that
// identifies THIS run, and its `done`.
const delegatedRun = (epoch: string | undefined, prose: string): HarnessEvent[] => {
    const meta = childThread(epoch);

    return [
        {
            type: 'tool_call',
            agent: 'one',
            call: {
                id: 'call-1',
                name: 'delegate',
                arguments: JSON.stringify({ agent: 'Workspace', input: 'review the read tool' })
            }
        } as HarnessEvent,
        withThread({ type: 'start', agent: 'Workspace', model: 'w1' }, meta),
        withThread({ type: 'text', agent: 'Workspace', delta: prose }, meta),
        withThread({ type: 'done', agent: 'Workspace', message: doneMessage('Workspace') }, meta)
    ];
};

const turnEvents = (epochs: [string | undefined, string | undefined]): HarnessEvent[] => [
    withThread({ type: 'start', agent: 'one', model: 'm1' }, hostThread(epochs[0])),
    withThread({ type: 'text', agent: 'one', delta: 'planning the run' }, hostThread(epochs[0])),
    ...delegatedRun(epochs[0], 'pre-restart lane'),
    ...delegatedRun(epochs[1], 'post-restart lane'),
    withThread({ type: 'text', agent: 'one', delta: 'the report' }, hostThread(epochs[1])),
    withThread({ type: 'done', agent: 'one', message: doneMessage('one') }, hostThread(epochs[1]))
];

const timesOf = (events: HarnessEvent[]): number[] => events.map((_event, index) => 1_000 + index * 10);

const recordOf = (events: HarnessEvent[]): SessionTurn => ({
    id: 'turn-1',
    index: 0,
    prompt: 'stress test the tools',
    status: 'done',
    startedAt: T,
    updatedAt: (timesOf(events).at(-1) ?? T) + T,
    threadId: 'thread-13',
    threadLabel: 'IT4',
    events,
    eventTimes: timesOf(events)
});

// ---------------------------------------------------------------------------
// The COMPILED mirror. `invocationId` is what makes the fixture the interesting one: two
// sections, one per RUN, both naming `inv-16`, so any client that keys rows by invocation id
// collapses them into one.
// ---------------------------------------------------------------------------

const summary = (): TurnSummary => ({
    id: 'turn-1',
    index: 0,
    prompt: 'stress test the tools',
    status: 'done',
    state: 'done',
    updatedAt: T + 400,
    sectionCount: 3,
    stepCount: 0,
    activeAgents: ['one'],
    blocks: []
});

const text = (id: string, value: string): DisplayNode => ({ kind: 'text', id, text: value, committed: true });

const rootSection = (figures: string[] = []): TurnSection => ({
    id: 'turn-1:0',
    rank: 'A',
    agent: 'one',
    agentLabel: 'RR1',
    state: 'done',
    invocationId: 'inv-13',
    // Empty for the LIVE door (the figures arrive as `node:insert` ops); filled for the RELOAD
    // door, where the terminal document already carries every tree.
    nodes: figures.map((value, index) => text(`n-root-${index}`, value))
});

const childSection = (id: string, figures: string[]): TurnSection => ({
    id,
    parentSectionId: 'turn-1:0',
    rank: 'B',
    agent: 'Workspace',
    agentLabel: 'RH1',
    state: 'done',
    invocationId: 'inv-16',
    // One TEXT NODE per attempt window, which is what the projector emits: two runs merged into
    // ONE legacy section therefore arrive as two figures inside one section, exactly as the raw
    // fold renders them inside one row.
    nodes: figures.map((value, index) => text(`n-${id}-${index}`, value))
});

const documentOf = (sections: TurnSection[]): SessionView =>
    ({
        id: 's1',
        harness: 'one',
        status: 'done',
        model: 'm1',
        createdAt: T,
        updatedAt: T + 400,
        turns: [summary()],
        displays: { 'turn-1': { turnId: 'turn-1', sections } }
    }) as unknown as SessionView;

const pending = new Map<string, unknown[]>();

// ---------------------------------------------------------------------------
// The four doors, all for the same turn
// ---------------------------------------------------------------------------

const mount = (): TurnBoard => {
    const board = createTurnBoard({});
    board.bindSession('s1');
    document.body.replaceChildren(board.element);

    return board;
};

// COMPILED · live `{ type: 'ops' }` frames — state advanced by the real reducer FIRST, exactly
// as `main.ts onViewItem` does, then routed to the tile.
const frame = (board: TurnBoard, view: SessionView, ops: TurnDisplayOp[]): void => {
    applyOpsToDisplay(view, 'turn-1', ops, pending as never);
    board.applyViewOps('turn-1', ops, view);
};

const openSection = (section: TurnSection): TurnDisplayOp => ({
    op: 'section:open',
    turnId: 'turn-1',
    section: { ...section, nodes: [] }
});
const insertText = (sectionId: string, id: string, value: string): TurnDisplayOp => ({
    op: 'node:insert',
    turnId: 'turn-1',
    sectionId,
    node: { kind: 'text', id, text: value, committed: false } as DisplayNode
});

const compiledLiveFold = (childSections: Array<[string, string[]]>): TurnBoard => {
    const board = mount();
    const view = documentOf([]);
    const tile = board.upsertView(summary(), view);

    frame(board, view, [openSection(rootSection())]);
    frame(board, view, [insertText('turn-1:0', 'n0', 'planning the run')]);

    for (const [id, figures] of childSections) {
        frame(board, view, [openSection(childSection(id, []))]);
        frame(
            board,
            view,
            figures.map((value, index) => insertText(id, `n-${id}-${index}`, value))
        );
    }

    frame(board, view, [insertText('turn-1:0', 'n1', 'the report')]);
    tile.flush();

    return board;
};

// COMPILED · reload: the terminal document already carries every tree (`hydrateView`).
const compiledReloadFold = (
    childSections: Array<[string, string[]]>,
    rootFigures: string[] = ['planning the run', 'the report']
): TurnBoard => {
    const board = mount();
    const [tile] = board.hydrateView(
        documentOf([rootSection(rootFigures), ...childSections.map(([id, figures]) => childSection(id, figures))])
    );
    tile?.flush();

    return board;
};

// RAW · live SSE.
const rawLiveFold = (events: HarnessEvent[]): TurnBoard => {
    const board = mount();
    const handle = board.begin('stress test the tools', [], 'thread-13');
    const stamps = timesOf(events);

    events.forEach((event, index) => handle.apply(event, stamps[index], 'live'));
    handle.flush();

    return board;
};

// RAW · reload from the record.
const rawReloadFold = (events: HarnessEvent[]): TurnBoard => {
    const board = mount();
    board.hydrate([recordOf(events)]);

    return board;
};

// ---------------------------------------------------------------------------
// One comparable projection for BOTH planes: the DELEGATED rows that hold content, in DOM
// order, each as its prose with ALL whitespace removed.
//
// Two normalization decisions, both honest:
//   - The row KEY differs by contract (a compiled row answers to the server's `section.id`, a raw
//     row to `id\0epoch`), so the cross-plane comparison is made on the ROW SET — count, order
//     and content — which is what "the same set of rows" means.
//   - Whitespace is dropped because the two planes JOIN consecutive figures differently: the raw
//     fold mints one prose block per attempt window (a new `start` opens one), while
//     `paintCompiledText` reuses the fold's `appendText`, which accumulates every text node of
//     one section into ONE block (turns.ts:8213-8218). That is a rendering detail of one row, not
//     a row difference; for the EPOCH case each row holds exactly one figure, so the
//     normalization is a no-op there. What the claim is about — WHICH run's prose lands in WHICH
//     row — survives it exactly.
// Rows with no prose are skipped: the raw fold alone mints a QUEUED placeholder row for a
// `delegate` call whose child merged into an existing invocation (pre-existing behavior, and a
// row the compiled plane never had), and counting it would compare a legacy artifact of one fold
// against the other instead of comparing runs.
// ---------------------------------------------------------------------------

const normalize = (value: string): string => value.replace(/\s+/g, '');

// Every prose block a surface owns, concatenated and whitespace-free. `paintCompiledText` and
// the streamed fold both mint the SAME `.agent-text` element (turns.ts:6492), so this selector
// sees both planes' prose and nothing else (no status line, no label).
const proseOf = (host: Element | null | undefined): string =>
    normalize(
        [...(host?.querySelectorAll<HTMLElement>('.agent-text') ?? [])].map((node) => node.textContent ?? '').join('')
    );

const contentRowsOf = (board: TurnBoard): string[] =>
    [...board.element.querySelectorAll<HTMLElement>('.thread-row')]
        .map((row) => proseOf(row.querySelector('.thread-flow')))
        .filter((prose) => prose !== '');

const rootFlowOf = (board: TurnBoard): string => proseOf(board.element.querySelector('.tile-flow'));

beforeEach(() => {
    pending.clear();
    document.body.innerHTML = '';
});

afterEach(() => {
    document.body.innerHTML = '';
});

describe('T-W10 — the two client folds agree on the rows of a recycled-id turn', () => {
    it('the compiled plane holds two rows for one invocation id, live and reloaded', () => {
        const twoRuns: Array<[string, string[]]> = [
            ['turn-1:1', ['pre-restart lane']],
            ['turn-1:2', ['post-restart lane']]
        ];
        const live = compiledLiveFold(twoRuns);

        // Two delegated rows, addressed by the two SECTION ids (each already unique per run): the
        // shared `invocationId` cannot collapse them, because this plane never keys by it.
        expect(
            [...live.element.querySelectorAll<HTMLElement>('.thread-row')].map((row) => row.dataset.threadId)
        ).toEqual(['turn-1:1', 'turn-1:2']);
        expect(contentRowsOf(live)).toEqual(['pre-restartlane', 'post-restartlane']);
        expect(rootFlowOf(live)).toEqual('planningtherunthereport');

        // The reload door of the SAME plane reads the same rows out of the terminal document.
        const reload = compiledReloadFold(twoRuns);

        expect(
            [...reload.element.querySelectorAll<HTMLElement>('.thread-row')].map((row) => row.dataset.threadId)
        ).toEqual(['turn-1:1', 'turn-1:2']);
        expect(contentRowsOf(reload)).toEqual(['pre-restartlane', 'post-restartlane']);
        expect(rootFlowOf(reload)).toEqual('planningtherunthereport');
    });

    it('the raw fold produces the same rows as the compiled plane, live and reloaded', () => {
        const events = turnEvents([E1, E2]);
        const twoRuns: Array<[string, string[]]> = [
            ['turn-1:1', ['pre-restart lane']],
            ['turn-1:2', ['post-restart lane']]
        ];

        const rawLive = contentRowsOf(rawLiveFold(events));
        const rawReload = contentRowsOf(rawReloadFold(events));
        const compiledLive = contentRowsOf(compiledLiveFold(twoRuns));
        const compiledReload = contentRowsOf(compiledReloadFold(twoRuns));

        // FOUR ways: the live raw board, the raw reload, the live compiled board and the compiled
        // reload all show the same two runs, in the same order, with the same prose per row.
        // Before the epoch rule the raw plane showed ONE merged row, so both raw↔compiled
        // comparisons failed while each plane still looked self-consistent.
        expect(rawLive).toEqual(['pre-restartlane', 'post-restartlane']);
        expect(rawReload).toEqual(rawLive);
        expect(compiledLive).toEqual(rawLive);
        expect(compiledReload).toEqual(rawLive);

        // The turn's own conversation is not a child row in EITHER plane, in either door: both
        // hold its two figures on the card, and neither child absorbed them.
        expect(rootFlowOf(rawLiveFold(events))).toEqual('planningtherunthereport');
        expect(rootFlowOf(rawReloadFold(events))).toEqual('planningtherunthereport');
        expect(rootFlowOf(compiledLiveFold(twoRuns))).toEqual('planningtherunthereport');
        expect(rootFlowOf(compiledReloadFold(twoRuns))).toEqual('planningtherunthereport');
    });

    it('an epoch-less turn still shows ONE run row in both planes', () => {
        // The legacy mirror of the same artifact: the server folds ONE child section carrying BOTH
        // figures, and the raw fold merges BOTH runs into ONE row. A rule that split epoch-less
        // frames would show TWO raw run rows against ONE compiled row — this comparison catches
        // it, and it is the same statement in both directions (the pre-change board, unchanged).
        const events = turnEvents([undefined, undefined]);
        const legacy: Array<[string, string[]]> = [['turn-1:1', ['pre-restart lane', 'post-restart lane']]];
        const merged = ['pre-restartlanepost-restartlane'];

        expect(contentRowsOf(rawLiveFold(events))).toEqual(merged);
        expect(contentRowsOf(rawReloadFold(events))).toEqual(merged);
        expect(contentRowsOf(compiledLiveFold(legacy))).toEqual(merged);
        expect(contentRowsOf(compiledReloadFold(legacy))).toEqual(merged);
    });
});

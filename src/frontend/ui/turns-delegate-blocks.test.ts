// A delegated conversation is its OWN referenceable block (T19: R17 + R18 + R20 guard).
//
// What this file exists to prove, driven the way the shell drives a board — hand-written
// `TurnSummary` rows and `TurnDisplay` trees, no `HarnessEvent`, no projector, no raw
// snapshot:
//
//   R17  EVERY section carries its own context bar. The tile's strip describes the turn's
//        ROOT section; a delegated card shows ITS distribution (all kinds, all details),
//        never its caller's and never an aggregate of the two.
//   R18  A delegated card is an independent block OUTSIDE its parent's content: a sibling
//        row in the conversation's flow, not another element inside `.tile` / `.thread-tile`.
//        The recorded hierarchy survives as ORDER (depth-first: IT1, RR1, RR2, RR3, IT2) and
//        as IDENTITY (`data-depth`, `data-parent-thread`), not as DOM nesting.
//   R20  Nothing about grouping, labels, focus or the persistent-thread join regressed while
//        the rows moved: one conversation card per persistent thread, the server's labels,
//        and a `threadId` that arrives LATE (the T18 server fills `TurnSection.threadId` from
//        the session's own map) must neither duplicate a row nor renumber one on a replay.
//
// Lazy detail is pinned here too, because per-section bars multiply the click targets: a
// render costs ZERO requests, a click costs exactly one, and that one names the clicked
// block of the section whose strip was clicked.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/turns-delegate-blocks.test.ts

import type { SessionView } from '../../server/protocol';
import type { HarnessPendingTool } from '../../types';
import type {
    ContextBlock,
    DisplayNode,
    TurnBlockDetail,
    TurnDisplay,
    TurnDisplayOp,
    TurnSection,
    TurnSummary
} from '../../shared/turn-display';
import { applyOpsToDisplay } from '../view-state';
import { clearBlockDetailCache } from './context-detail';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTurnBoard } from './turns';
import type { TurnBoard } from './turns';
import type { SessionThreadEntry } from './threads';

const T = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// The fixture: one main conversation with two delegations and a grandchild, then
// a second main conversation. Labels are the SERVER's (`IT1`/`RR1`…), so the test
// asserts the board's structure without re-deriving any of its naming.
// ---------------------------------------------------------------------------

const block = (sectionId: string, id: string, overrides: Partial<ContextBlock> = {}): ContextBlock =>
    ({
        kind: 'tool',
        id,
        turnId: id.startsWith('0-') || id.startsWith('1-') || id.startsWith('2-') || id.startsWith('3-') ? (sectionId.split(':')[0] as string) : 't1',
        sectionId,
        name: `call-${id}`,
        chars: 100,
        argsChars: 40,
        resultChars: 60,
        inPrompt: true,
        state: 'ok',
        eventFrom: 7,
        eventTo: 9,
        at: T,
        endedAt: T + 500,
        ...overrides
    }) as ContextBlock;

const prose = (sectionId: string, id: string, chars: number): ContextBlock =>
    block(sectionId, id, {
        kind: 'user',
        name: 'prompt',
        chars,
        argsChars: undefined,
        resultChars: undefined,
        state: undefined,
        eventFrom: undefined,
        eventTo: undefined,
        endedAt: undefined
    });

const answer = (id: string, text: string): DisplayNode =>
    ({ kind: 'text', id, text, committed: true }) as unknown as DisplayNode;

const section = (overrides: Partial<TurnSection> & { id: string }): TurnSection =>
    ({
        role: 'subagent',
        agent: 'helper',
        agentLabel: 'RH1',
        state: 'done',
        nodes: [],
        startedAt: T,
        endedAt: T + 900,
        ...overrides
    }) as TurnSection;

const ROOT = section({
    id: 't1:0',
    role: 'primary',
    agent: 'instruct',
    agentLabel: 'IT1',
    threadId: 'th-it1',
    invocationId: 'inv-it1',
    threadLabel: 'IT1',
    context: [prose('t1:0', '0-user-prompt', 120), block('t1:0', '0-tool-7'), block('t1:0', '0-tool-9')],
    nodes: [answer('0', 'the main answer')]
});

const RR1 = section({
    id: 't1:1',
    agent: 'research',
    agentLabel: 'RR1',
    invocationId: 'inv-rr1',
    parentSectionId: 't1:0',
    context: [prose('t1:1', '1-user-prompt', 60), block('t1:1', '1-tool-4')],
    nodes: [answer('1', 'first delegate answer')]
});

const RR2 = section({
    id: 't1:2',
    agent: 'research',
    agentLabel: 'RR2',
    invocationId: 'inv-rr2',
    parentSectionId: 't1:0',
    context: [block('t1:2', '2-tool-4')],
    nodes: [answer('2', 'second delegate answer')]
});

const RR3 = section({
    id: 't1:3',
    agent: 'deeper',
    agentLabel: 'RR3',
    invocationId: 'inv-rr3',
    // A child of the SECOND delegation: the recorded order is IT1, RR1, RR2, RR3, and the
    // grandchild sits deeper between RR2 and the next main conversation — the exact hierarchy
    // the request describes.
    parentSectionId: 't1:2',
    context: [block('t1:3', '3-tool-5', { state: 'error', chars: 30, argsChars: 10, resultChars: 20 })],
    nodes: [answer('3', 'nested delegate answer')]
});

const summary = (id: string, overrides: Partial<TurnSummary> = {}): TurnSummary =>
    ({
        id,
        index: id === 't1' ? 0 : 1,
        prompt: `${id} task`,
        status: 'done',
        state: 'done',
        threadId: id === 't1' ? 'th-it1' : 'th-it2',
        threadLabel: id === 't1' ? 'IT1' : 'IT2',
        updatedAt: T + 1_000,
        sectionCount: 1,
        stepCount: 0,
        activeAgents: ['instruct'],
        blocks: [],
        ...overrides
    }) as TurnSummary;

const IT2 = section({
    id: 't2:0',
    role: 'primary',
    agent: 'instruct',
    agentLabel: 'IT2',
    threadId: 'th-it2',
    invocationId: 'inv-it2',
    context: [prose('t2:0', '0-user-prompt', 33)],
    nodes: [answer('0', 'the second main answer')]
});

const viewOf = (turns: TurnSummary[], displays: Record<string, TurnSection[]>): SessionView =>
    ({
        id: 's1',
        harness: 'instruct',
        status: 'idle',
        model: 'm1',
        createdAt: 1,
        updatedAt: T + 2_000,
        turns,
        displays: Object.fromEntries(
            Object.entries(displays).map(([turnId, sections]) => [turnId, { turnId, sections }])
        )
    }) as unknown as SessionView;

const FULL = viewOf(
    [summary('t1'), summary('t2')],
    { t1: [ROOT, RR1, RR2, RR3], t2: [IT2] }
);

const pending = new Map<string, HarnessPendingTool[]>();

const mount = (options: Parameters<typeof createTurnBoard>[0] = {}): { board: TurnBoard } => {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const board = createTurnBoard({ ...options, empty });
    board.bindSession('s1');
    document.body.replaceChildren(board.element);

    return { board };
};

/** One frame the way `main.ts onViewItem` does it: advance the document, then route it. */
const frame = (board: TurnBoard, view: SessionView, turnId: string, ops: TurnDisplayOp[]): boolean => {
    applyOpsToDisplay(view, turnId, ops, pending);

    return board.applyViewOps(turnId, ops, view);
};

// ---------------------------------------------------------------------------
// Readers for the two things R18 is about: the ORDER blocks appear in, and which
// card a card is (not) inside.
// ---------------------------------------------------------------------------

/** The board's reading order, as the visible block identities the user sees. */
const readingOrder = (): string[] => [
    ...[...document.querySelectorAll<HTMLElement>('.turn-row > .tile, .thread-row')].map((node) =>
        node.classList.contains('thread-row')
            ? (node.querySelector('.thread-name')?.textContent ?? '')
            : (node.querySelector('.tile-agent')?.textContent ?? '')
    )
];

/** Every delegated card, in DOM order. */
const threadRows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.thread-row')];

/** The strip inside one surface, with the segment ids it carries. */
const segmentsOf = (surface: Element): string[] =>
    [...surface.querySelectorAll<HTMLElement>('.context-bar-segment')].map((node) => node.dataset.blockId ?? '');

// The strip a block OWNS, addressed through the surface that paints it: the tile's own
// `.tile-body` host for a root section, the card's `.thread-body` host for a delegate.
const hostOf = (surface: Element): HTMLElement | null =>
    surface.matches('.thread-row')
        ? surface.querySelector<HTMLElement>(':scope > .thread-tile > .thread-body > .context-bar-host')
        : surface.querySelector<HTMLElement>(':scope > .tile-body > .context-bar-host');

const rowOf = (label: string): HTMLElement =>
    threadRows().find((row) => row.querySelector('.thread-name')?.textContent === label) as HTMLElement;

// The roster half of the identity: the same four conversations the board joins a card to.
const rosterEntry = (overrides: Partial<SessionThreadEntry> & { id: string }): SessionThreadEntry =>
    ({
        agent: 'instruct',
        origin: 'host',
        status: 'idle',
        sequence: 1,
        ...overrides
    }) as SessionThreadEntry;

const ROSTER: SessionThreadEntry[] = [
    rosterEntry({ id: 'th-it1', sequence: 1, label: 'IT1', agent: 'instruct', invocationId: 'inv-it1', invocationIds: ['inv-it1'] }),
    rosterEntry({
        id: 'th-rr1',
        sequence: 2,
        label: 'RR1',
        agent: 'research',
        ownerThreadId: 'th-it1',
        invocationId: 'inv-rr1',
        invocationIds: ['inv-rr1']
    }),
    rosterEntry({
        id: 'th-rr2',
        sequence: 3,
        label: 'RR2',
        agent: 'research',
        ownerThreadId: 'th-it1',
        invocationId: 'inv-rr2',
        invocationIds: ['inv-rr2']
    }),
    rosterEntry({
        id: 'th-rr3',
        sequence: 4,
        label: 'RR3',
        agent: 'deeper',
        ownerThreadId: 'th-rr2',
        invocationId: 'inv-rr3',
        invocationIds: ['inv-rr3']
    })
];

// The block route's answer: the segment's own metadata, so the dialog is identified by the
// block it is showing rather than by which strip happened to be clicked. The fixture numbers
// its blocks `<sectionOrdinal>-…`, so the section id is that prefix — which is also what lets
// a test assert the answer came from the section whose strip was clicked.
const detailFor = (input: { turnId: string; blockId: string }): TurnBlockDetail => {
    const isTool = input.blockId.includes('tool');

    return {
        kind: isTool ? 'tool' : 'user',
        id: input.blockId,
        turnId: input.turnId,
        sectionId: `${input.turnId}:${input.blockId.slice(0, 1)}`,
        name: `call-${input.blockId}`,
        chars: 100,
        inPrompt: true,
        state: isTool ? 'ok' : undefined,
        at: T,
        sessionId: 's1',
        ...(isTool
            ? { args: `{"q":"${input.blockId}"}`, result: `the recorded result of ${input.blockId}` }
            : { text: `the recorded prompt of ${input.blockId}` })
    } as TurnBlockDetail;
};

beforeEach(() => {
    pending.clear();
    clearBlockDetailCache();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('.dialog-close')) button.click();
    vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// R18 — independent cards, in the recorded hierarchy, without the nesting
// ---------------------------------------------------------------------------

describe('a delegated conversation is an independent card (R18)', () => {
    it('orders the blocks IT1, RR1, RR2, RR3, IT2 with the recorded depths', () => {
        const { board } = mount();
        for (const handle of board.reconcileView(FULL)) handle.flush();

        // The reading order the request asked for, exactly.
        expect(readingOrder()).toEqual(['IT1', 'RR1', 'RR2', 'RR3', 'IT2']);

        // ... and it is carried by ids, since the DOM no longer nests anything.
        expect(threadRows().map((row) => row.dataset.threadId)).toEqual(['t1:1', 't1:2', 't1:3']);
        expect(threadRows().map((row) => row.dataset.depth)).toEqual(['1', '1', '2']);
        expect(threadRows().map((row) => row.dataset.parentThread)).toEqual(['t1:0', 't1:0', 't1:2']);

        // Indentation is the row's own depth figure (the stylesheet multiplies it by the
        // single indent step), so a deeper card reads deeper without being nested.
        expect(threadRows().map((row) => row.style.getPropertyValue('--thread-depth'))).toEqual(['0', '0', '1']);

        // The persistent-thread identity the join resolves to is unchanged by the flattening.
        board.setThreads(ROSTER);
        expect(threadRows().map((row) => row.dataset.persistentThread)).toEqual(['th-rr1', 'th-rr2', 'th-rr3']);
    });

    it('places every delegated card OUTSIDE its parent block content', () => {
        const { board } = mount();
        for (const handle of board.reconcileView(FULL)) handle.flush();

        const mainTile = document.querySelector<HTMLElement>('.turn-row > .tile') as HTMLElement;
        const rr1 = rowOf('RR1');
        const rr2 = rowOf('RR2');
        const rr3 = rowOf('RR3');

        // No delegate row is inside the main tile at all — not its body, not its flow.
        expect(mainTile.contains(rr1)).toBe(false);
        expect(mainTile.contains(rr2)).toBe(false);
        expect(mainTile.contains(rr3)).toBe(false);
        expect(mainTile.querySelector('.tile-body')?.contains(rr3)).toBe(false);
        expect(mainTile.querySelector('.tile-flow')?.contains(rr3)).toBe(false);

        // The grandchild is not inside its own parent's card either: it is a sibling beside it.
        expect(rr1.querySelector('.thread-tile')?.contains(rr3)).toBe(false);
        expect(rr1.querySelector('.thread-body')?.contains(rr3)).toBe(false);
        expect(rr3.closest('.thread-row:not([data-thread-id="t1:3"])')).toBeNull();

        // Each row's own structure is exactly one card (the per-entry children host is gone).
        for (const row of threadRows())
            expect([...row.children].map((child) => (child as HTMLElement).className)).toEqual(['thread-tile']);

        // The rows are siblings of the main tile in one host, so the parent's row wraps the
        // hierarchy without containing it: `.turn-row > .tile` and `.turn-row > .thread-children`.
        const turnRow = mainTile.parentElement as HTMLElement;
        expect(turnRow.className).toBe('turn-row');

        const host = turnRow.querySelector<HTMLElement>(':scope > .thread-children') as HTMLElement;
        expect(host.className).toBe('thread-children');
        expect([...host.children].map((child) => (child as HTMLElement).dataset.threadId)).toEqual([
            't1:1',
            't1:2',
            't1:3'
        ]);
        expect(host.parentElement?.className).toBe('turn-row');
    });

    it('keeps one conversation card per persistent thread, with the server labels (R20)', () => {
        const { board } = mount();
        for (const handle of board.reconcileView(FULL)) handle.flush();

        // Two persistent threads, two conversation containers: the flattened rows did not
        // merge or split either conversation.
        const cards = [...document.querySelectorAll<HTMLElement>('.conversation')];
        expect(cards.map((card) => card.dataset.threadId)).toEqual(['th-it1', 'th-it2']);
        expect(cards[0].querySelectorAll('.turn-row')).toHaveLength(1);
        expect(cards[1].querySelectorAll('.turn-row')).toHaveLength(1);

        // The badges and the nested headers are the SERVER's labels, unmodified.
        expect([...document.querySelectorAll('.tile-thread')].map((node) => node.textContent)).toEqual(['IT1', 'IT2']);
        expect(threadRows().map((row) => row.querySelector('.thread-name')?.textContent)).toEqual([
            'RR1',
            'RR2',
            'RR3'
        ]);
    });
});

// ---------------------------------------------------------------------------
// R17 — one context bar per section, and each one only its own segments
// ---------------------------------------------------------------------------

describe('each delegated conversation owns a context bar (R17)', () => {
    it('paints one bar per section, root included, with no shared segment', () => {
        const loadBlockDetail = vi.fn(async (input: { turnId: string; blockId: string }) => detailFor(input));
        const { board } = mount({ loadBlockDetail });
        for (const handle of board.reconcileView(FULL)) handle.flush();

        // Five sections across the two turns (IT1 + RR1 + RR2 + RR3, then IT2), five strips —
        // and NOT one aggregate per turn.
        expect(document.querySelectorAll('.context-bar')).toHaveLength(5);

        const mainTile = document.querySelector<HTMLElement>('.turn-row > .tile') as HTMLElement;

        expect(segmentsOf(hostOf(mainTile) as Element)).toEqual(['0-user-prompt', '0-tool-7', '0-tool-9']);
        expect(segmentsOf(hostOf(rowOf('RR1')) as Element)).toEqual(['1-user-prompt', '1-tool-4']);
        expect(segmentsOf(hostOf(rowOf('RR2')) as Element)).toEqual(['2-tool-4']);
        expect(segmentsOf(hostOf(rowOf('RR3')) as Element)).toEqual(['3-tool-5']);

        // Each strip names the section it belongs to, so a reader (and a test) can tell whose
        // distribution it is looking at.
        expect(hostOf(mainTile)?.dataset.sectionId).toBe('t1:0');
        expect(hostOf(rowOf('RR1'))?.dataset.sectionId).toBe('t1:1');
        expect(hostOf(rowOf('RR2'))?.dataset.sectionId).toBe('t1:2');
        expect(hostOf(rowOf('RR3'))?.dataset.sectionId).toBe('t1:3');
        expect(hostOf(rowOf('RR3'))?.dataset.turnId).toBe('t1');

        // The caller's strip never swallowed a delegation's calls, and a delegation's strip
        // never shows its caller's.
        expect(mainTile.querySelectorAll('.context-bar-segment[data-block-id^="1-"]')).toHaveLength(0);
        expect(mainTile.querySelectorAll('.context-bar-segment[data-block-id^="3-"]')).toHaveLength(0);
        expect(rowOf('RR1').querySelectorAll('.context-bar-segment[data-block-id^="0-"]')).toHaveLength(0);

        // The second conversation carries its own single-segment strip, not the first turn's.
        const it2 = [...document.querySelectorAll<HTMLElement>('.conversation')][1].querySelector<HTMLElement>(
            '.turn-row > .tile'
        ) as HTMLElement;
        expect(segmentsOf(hostOf(it2) as Element)).toEqual(['0-user-prompt']);
        expect(hostOf(it2)?.dataset.sectionId).toBe('t2:0');

        // A bar replaces the chip wall FOR ITS OWN SECTION: none of the four sections renders
        // a tool card, and nothing was fetched to draw any of the strips.
        expect(document.querySelectorAll('details.tool')).toHaveLength(0);
        expect(loadBlockDetail).not.toHaveBeenCalled();
    });

    it('keeps a section it cannot describe rendering its own cards', () => {
        // RR2 carries NO `context` field (the server said nothing about it), RR1 does. A
        // sibling's metadata must not silence RR2's cards, and RR1's own strip must still win
        // for RR1's calls: suppression is per section, never per tile.
        const partial = viewOf(
            [summary('t1')],
            { t1: [ROOT, RR1, { ...RR2, context: undefined }, RR3] }
        );
        const { board } = mount();
        for (const handle of board.reconcileView(partial)) handle.flush();

        expect(document.querySelectorAll('.context-bar')).toHaveLength(3);

        const rr2 = rowOf('RR2');
        expect(hostOf(rr2)?.hidden).toBe(true);
        expect(rr2.querySelectorAll('.context-bar')).toHaveLength(0);
    });

    it('re-derives only the section a late context frame touched', () => {
        // RR1 is part of the turn from the start; only its `context` metadata arrives later (a
        // live run mints a call, and the `context:add` frame that follows it is the only bar
        // frame the shell sends).
        const live = viewOf(
            [summary('t1')],
            { t1: [{ ...ROOT, context: [] }, { ...RR1, context: undefined }] }
        );
        const { board } = mount();
        for (const handle of board.reconcileView(live)) handle.flush();

        // An authoritative empty bar for the root: the host is up, it says so, and the root's
        // calls stay cards because an empty strip may not hide real information. RR1 has no
        // strip at all yet.
        const mainTile = document.querySelector<HTMLElement>('.turn-row > .tile') as HTMLElement;
        expect(hostOf(mainTile)?.hidden).toBe(false);
        expect(hostOf(mainTile)?.dataset.segments).toBe('0');
        expect(hostOf(mainTile)?.querySelector('.context-bar')?.getAttribute('data-empty')).toBe('true');
        expect(mainTile.querySelectorAll('.tile-flow details.tool')).toHaveLength(0);
        expect(hostOf(rowOf('RR1'))?.hidden).toBe(true);

        frame(board, live, 't1', [
            { op: 'context:add', turnId: 't1', sectionId: 't1:1', block: block('t1:1', '1-tool-4') }
        ]);

        // RR1's strip appeared, on RR1's card; the root's strip is still the empty one it was,
        // and still holds none of RR1's segment.
        expect(hostOf(rowOf('RR1'))?.dataset.sectionId).toBe('t1:1');
        expect(segmentsOf(hostOf(rowOf('RR1')) as Element)).toEqual(['1-tool-4']);
        expect(segmentsOf(hostOf(mainTile) as Element)).toEqual([]);
        expect(hostOf(mainTile)?.dataset.segments).toBe('0');
        expect(document.querySelectorAll('.context-bar')).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// The click, and only the click — provenance per section
// ---------------------------------------------------------------------------

describe('a segment click resolves to its own section (R17/R20)', () => {
    it('asks for nothing while rendering and exactly one block route per click', async () => {
        const calls: { turnId: string; blockId: string; sessionId?: string }[] = [];
        const loadBlockDetail = vi.fn(async (input: { turnId: string; blockId: string; sessionId?: string }) => {
            calls.push(input);

            return detailFor(input);
        });
        const loadStepDetail = vi.fn();

        const { board } = mount({ loadBlockDetail, loadStepDetail });
        for (const handle of board.reconcileView(FULL)) handle.flush();

        // Zero eager requests for four strips.
        expect(loadBlockDetail).not.toHaveBeenCalled();
        expect(loadStepDetail).not.toHaveBeenCalled();
        expect(document.querySelectorAll('.dialog')).toHaveLength(0);

        // The DEEPEST strip: the request names that section's block, and nothing else.
        const rr3Segment = rowOf('RR3').querySelector<HTMLElement>('.context-bar-segment') as HTMLElement;
        rr3Segment.click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(calls).toEqual([{ sessionId: 's1', turnId: 't1', blockId: '3-tool-5' }]);
        expect(document.querySelectorAll('.dialog')).toHaveLength(1);
        expect(document.querySelector<HTMLElement>('.block-detail')?.getAttribute('data-block-id')).toBe('3-tool-5');
        expect(document.querySelector<HTMLElement>('[data-pane="result"]')?.textContent).toContain(
            'the recorded result of 3-tool-5'
        );

        // A click in ANOTHER section's strip replaces the open dialog instead of stacking a
        // second one, and costs exactly its own request.
        const rr1Segments = rowOf('RR1').querySelectorAll<HTMLElement>('.context-bar-segment');
        rr1Segments[1].click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(calls).toHaveLength(2);
        expect(calls[1]).toEqual({ sessionId: 's1', turnId: 't1', blockId: '1-tool-4' });
        expect(document.querySelectorAll('.dialog')).toHaveLength(1);
        expect(document.querySelector<HTMLElement>('.block-detail')?.getAttribute('data-block-id')).toBe('1-tool-4');

        // The caller's own strip is still there and still answers for its own blocks.
        const rootSegment = document.querySelector<HTMLElement>(
            '.tile-body > .context-bar-host .context-bar-segment[data-block-id="0-tool-7"]'
        ) as HTMLElement;
        rootSegment.click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(calls).toHaveLength(3);
        expect(calls[2].blockId).toBe('0-tool-7');

        // The strip that was NOT clicked never cost a request, and no dialog was ever opened
        // for it.
        expect(calls.map((call) => call.blockId)).toEqual(['3-tool-5', '1-tool-4', '0-tool-7']);
        expect(rowOf('RR2').querySelectorAll('.context-bar-segment')).toHaveLength(1);
    });

    it('closes a delegated strip dialog with its section and leaves the rest alone', async () => {
        const { board } = mount({ loadBlockDetail: async (input) => detailFor(input) });
        for (const handle of board.reconcileView(FULL)) handle.flush();

        rowOf('RR3').querySelector<HTMLElement>('.context-bar-segment')?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(document.querySelector('.dialog')).not.toBeNull();

        // The server drops the whole section (a deleted invocation): its strip and its open
        // dialog go, while the other three strips survive.
        frame(board, FULL, 't1', [{ op: 'section:remove', turnId: 't1', sectionId: 't1:3' }]);

        expect(document.querySelectorAll('.dialog')).toHaveLength(0);
        expect(threadRows().map((row) => row.dataset.threadId)).toEqual(['t1:1', 't1:2']);
        // The other four strips survive: the root's, RR1's, RR2's and IT2's.
        expect(document.querySelectorAll('.context-bar')).toHaveLength(4);
        expect(document.body.textContent ?? '').not.toContain('call-3-tool-5');
    });
});

// ---------------------------------------------------------------------------
// R20 — identity that arrives late, and a document that arrives twice
// ---------------------------------------------------------------------------

describe('a late persistent-thread id does not duplicate a card (R20)', () => {
    it('re-keys the same rows when threadId lands, then replays without a second copy', () => {
        // The tree BEFORE the T18 server fills `TurnSection.threadId`: identity is only the
        // invocation id, and the roster has not landed either.
        const bare = viewOf(
            [summary('t1')],
            {
                t1: [
                    { ...ROOT, threadId: undefined },
                    { ...RR1, threadId: undefined },
                    { ...RR2, threadId: undefined },
                    { ...RR3, threadId: undefined }
                ]
            }
        );
        const { board } = mount();
        for (const handle of board.reconcileView(bare)) handle.flush();

        expect(threadRows().map((row) => row.dataset.threadId)).toEqual(['t1:1', 't1:2', 't1:3']);
        expect(threadRows().map((row) => row.dataset.persistentThread)).toEqual([
            undefined,
            undefined,
            undefined
        ]);

        // T18 patch: `threadId` arrives on the section, in a `section:set` frame.
        frame(board, bare, 't1', [
            { op: 'section:set', turnId: 't1', sectionId: 't1:1', patch: { threadId: 'th-rr1' } },
            { op: 'section:set', turnId: 't1', sectionId: 't1:2', patch: { threadId: 'th-rr2' } },
            { op: 'section:set', turnId: 't1', sectionId: 't1:3', patch: { threadId: 'th-rr3' } }
        ]);

        // Same three cards, same order, same strips — only the join appeared.
        expect(threadRows().map((row) => row.dataset.threadId)).toEqual(['t1:1', 't1:2', 't1:3']);
        expect(threadRows().map((row) => row.dataset.depth)).toEqual(['1', '1', '2']);
        expect(threadRows().map((row) => row.dataset.parentThread)).toEqual(['t1:0', 't1:0', 't1:2']);
        expect(threadRows().map((row) => row.dataset.persistentThread)).toEqual(['th-rr1', 'th-rr2', 'th-rr3']);
        expect(readingOrder()).toEqual(['IT1', 'RR1', 'RR2', 'RR3']);
        expect(document.querySelectorAll('.context-bar')).toHaveLength(4);
        expect(segmentsOf(hostOf(rowOf('RR3')) as Element)).toEqual(['3-tool-5']);

        // The roster lands afterwards (a live session's ordering): the join is the SAME, so no
        // second card and no renumbered label.
        board.setThreads(ROSTER);
        expect(threadRows()).toHaveLength(3);
        expect(threadRows().map((row) => row.dataset.persistentThread)).toEqual(['th-rr1', 'th-rr2', 'th-rr3']);
        expect(threadRows().map((row) => row.querySelector('.thread-name')?.textContent)).toEqual([
            'RR1',
            'RR2',
            'RR3'
        ]);

        // A full replay of the same document (a reconnect drain) rebuilds the identical board:
        // the late id is honoured, and nothing is added twice.
        const drained = viewOf([summary('t1')], { t1: [ROOT, RR1, RR2, RR3] });
        for (const handle of board.reconcileView(drained)) handle.flush();

        expect(threadRows().map((row) => row.dataset.threadId)).toEqual(['t1:1', 't1:2', 't1:3']);
        expect(threadRows().map((row) => row.dataset.persistentThread)).toEqual(['th-rr1', 'th-rr2', 'th-rr3']);
        expect(document.querySelectorAll('.context-bar')).toHaveLength(4);
        expect(readingOrder()).toEqual(['IT1', 'RR1', 'RR2', 'RR3']);
        expect(hostOf(rowOf('RR1'))?.dataset.segments).toBe('2');
        expect(hostOf(rowOf('RR2'))?.dataset.segments).toBe('1');
        expect(hostOf(rowOf('RR3'))?.dataset.segments).toBe('1');
    });
});

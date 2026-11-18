// ONE CARD PER PERSISTENT CONVERSATION ON THE COMPILED PLANE (R1).
//
// The reported defect: an Instruct session listed the SAME thread code twice under one parent
// (`IT1` -> `WE1…WE11, RR1`, then `WE7, WE8, WE9, WE10, WE11` again). Nothing was mislabelled:
// that session holds 13 conversations with 13 unique labels, and 19 RUNS. A `threadSend`
// reply-run lands in its CALLER's turn as a second, root-shaped section that names the EXISTING
// conversation (`TurnSection.threadId`, ../server/turn-projector.ts:1402) and repeats its label
// (the label join binds one entry per run key, ../server/sessions.ts `labelJoinsOf`). The
// compiled card builder keyed one card per SECTION, so one conversation read as two cards.
//
// What this file pins. The server's ONE SECTION PER RUN fold, the label allocator, the roster
// and `kind` are deliberately unchanged: this is the display-side rule.
//
//   R1  one card per persistent conversation: a code appears at most once per session, and a
//       later run of a conversation renders as an ordered exchange under the card it belongs to.
//   R2  it rebuilds from a fresh hydration out of per-run records alone (`section.threadId`, or
//       a UNIQUE roster claim) — never from live-only state.
//   R3  no loss of per-run detail: every run keeps its own row, its own context strip, its own
//       prose and its own lazy block route.
//   R4  a `threadId` that lands LATE re-keys the row already on screen (no second copy, no
//       re-created row), and a card that is removed promotes the next run in its place.
//   R5  no over-merge: runs whose conversation is not provable (no `threadId`, an ambiguous
//       roster claim) keep their own cards, and two runs of DIFFERENT threads that share one
//       bare invocation id (./turns-compiled-run-epoch.test.ts:314) stay two conversations.
//
// Run: yarn vitest run --config src/frontend/vitest.config.ts ui/turns-compiled-conversation-cards.test.ts

import type { SessionView } from '../../server/protocol';
import type { HarnessPendingTool } from '../../types';
import type {
    ContextBlock,
    DisplayNode,
    TurnBlockDetail,
    TurnDisplayOp,
    TurnSection,
    TurnSummary
} from '../../shared/turn-display';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyOpsToDisplay } from '../view-state';
import { clearBlockDetailCache } from './context-detail';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTurnBoard, type TurnBoard } from './turns';
import type { SessionThreadEntry } from './threads';

const T = 1_700_000_000_000;

// The five conversations that received a `threadSend` reply-run, exactly as in the dump where
// `thread-8…thread-12` (= `WE7…WE11`) each hold a first `delegate` run and a second reply run.
const REPLIED = [7, 8, 9, 10, 11];

const LABELS = ['IT1', ...[...Array(11).keys()].map((index) => `WE${index + 1}`), 'RR1'];

// ---------------------------------------------------------------------------
// The fixture: one Instruct turn that delegated eleven WORKSPACE children and one REVIEWER
// child, then sent a reply to five of those SAME conversations. Labels are the SERVER's, so
// the board is asserted on structure, never on naming it re-derived.
// ---------------------------------------------------------------------------

const block = (sectionId: string, id: string, overrides: Partial<ContextBlock> = {}): ContextBlock =>
    ({
        kind: 'tool',
        id,
        turnId: sectionId.split(':')[0] as string,
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
        rank: 'B',
        agent: 'workspace',
        agentLabel: 'RH1',
        state: 'done',
        nodes: [],
        startedAt: T,
        endedAt: T + 900,
        ...overrides
    }) as TurnSection;

const ROOT = section({
    id: 't1:0',
    rank: 'A',
    agent: 'instruct',
    agentLabel: 'IT1',
    threadId: 'th-instruct',
    invocationId: 'inv-it1',
    threadLabel: 'IT1',
    context: [prose('t1:0', '0-user-prompt', 120), block('t1:0', '0-tool-7')],
    nodes: [answer('0', 'the audit report')]
});

// A first `delegate` run: WE1…WE11, one persistent conversation each.
const firstRun = (index: number): TurnSection =>
    section({
        id: `t1:${index}`,
        agent: 'workspace',
        agentLabel: `WE${index}`,
        threadId: `th-we${index}`,
        invocationId: `inv-we${index}-1`,
        parentSectionId: 't1:0',
        context: [prose(`t1:${index}`, `${index}-task-prompt`, 60), block(`t1:${index}`, `${index}-tool-4`)],
        nodes: [answer(`${index}`, `WE${index} first run`)],
        startedAt: T + index * 1_000,
        endedAt: T + index * 1_000 + 60_000
    });

// A `threadSend` REPLY-RUN on one of those conversations: the SAME `threadId`, the SAME label,
// a different invocation, and NO `parentSectionId`. The reply-run is deliberately spawned
// without a parent (../harness.ts:6794-6798) and recorded into the caller's turn, which is
// exactly how one turn ends up holding two root-shaped sections for one conversation.
const replyRun = (index: number, ordinal: number): TurnSection =>
    section({
        id: `t1:${ordinal}`,
        agent: 'workspace',
        agentLabel: `WE${index}`,
        threadId: `th-we${index}`,
        invocationId: `inv-we${index}-2`,
        state: 'cancelled',
        context: [prose(`t1:${ordinal}`, `${ordinal}-reply-prompt`, 40), block(`t1:${ordinal}`, `${ordinal}-tool-2`)],
        nodes: [answer(`${ordinal}`, `WE${index} reply run`)],
        startedAt: T + 200_000,
        endedAt: T + 316_000
    });

const RR1 = section({
    id: 't1:12',
    agent: 'reviewer',
    agentLabel: 'RR1',
    threadId: 'th-rr1',
    invocationId: 'inv-rr1',
    parentSectionId: 't1:0',
    context: [block('t1:12', '12-tool-4')],
    nodes: [answer('12', 'the review')]
});

// 18 sections = 19 runs less the turn's own root run… and they are what the server's per-run
// fold hands the tile for the reported session: one ROOT, twelve first runs, five reply runs.
const SECTIONS: TurnSection[] = [
    ROOT,
    ...[...Array(11).keys()].map((index) => firstRun(index + 1)),
    RR1,
    ...REPLIED.map((index, position) => replyRun(index, 13 + position))
];

// The section id of the reply run that continues `WE${index}`.
const replyOf = (index: number): number => 13 + REPLIED.indexOf(index);

const summary = (id: string, overrides: Partial<TurnSummary> = {}): TurnSummary =>
    ({
        id,
        index: 0,
        prompt: 'run the audit',
        status: 'done',
        state: 'done',
        threadId: 'th-instruct',
        threadLabel: 'IT1',
        updatedAt: T + 400_000,
        sectionCount: 1,
        stepCount: 0,
        activeAgents: ['instruct'],
        blocks: [],
        ...overrides
    }) as TurnSummary;

const viewOf = (sections: TurnSection[], turnId = 't1'): SessionView =>
    ({
        id: 's1',
        harness: 'instruct',
        status: 'idle',
        model: 'm1',
        createdAt: 1,
        updatedAt: T + 400_000,
        turns: [summary(turnId)],
        displays: { [turnId]: { turnId, sections } }
    }) as unknown as SessionView;

const FULL = viewOf(SECTIONS);

const pending = new Map<string, HarnessPendingTool[]>();

// The roster the server reports once a conversation has been resumed: `invocationId` names the
// NEWEST run and the historical `invocationIds` still names the original delegated one, so a
// conversation is joinable from EITHER of its runs (R2's second source of proof).
const rosterEntry = (overrides: Partial<SessionThreadEntry> & { id: string }): SessionThreadEntry =>
    ({
        agent: 'workspace',
        origin: 'host',
        status: 'idle',
        sequence: 1,
        ...overrides
    }) as SessionThreadEntry;

const ROSTER: SessionThreadEntry[] = [
    rosterEntry({
        id: 'th-instruct',
        agent: 'instruct',
        sequence: 1,
        label: 'IT1',
        invocationId: 'inv-it1',
        invocationIds: ['inv-it1']
    }),
    ...[...Array(11).keys()].map((index) => {
        const replied = REPLIED.includes(index + 1);

        return rosterEntry({
            id: `th-we${index + 1}`,
            sequence: index + 2,
            label: `WE${index + 1}`,
            ownerThreadId: 'th-instruct',
            invocationId: replied ? `inv-we${index + 1}-2` : `inv-we${index + 1}-1`,
            invocationIds: replied
                ? [`inv-we${index + 1}-1`, `inv-we${index + 1}-2`]
                : [`inv-we${index + 1}-1`],
            preview: replied ? 'STOP TESTING AND REPORT NOW' : `audit task ${index + 1}`
        });
    }),
    rosterEntry({
        id: 'th-rr1',
        agent: 'reviewer',
        sequence: 13,
        label: 'RR1',
        ownerThreadId: 'th-instruct',
        invocationId: 'inv-rr1',
        invocationIds: ['inv-rr1']
    })
];

const mount = (options: Parameters<typeof createTurnBoard>[0] = {}): TurnBoard => {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const board = createTurnBoard({ ...options, empty });
    board.bindSession('s1');
    document.body.replaceChildren(board.element);

    return board;
};

// One authoritative document the way `main.ts` routes it: `reconcileView`, then flush the tiles.
const render = (view: SessionView, board: TurnBoard = mount()): TurnBoard => {
    for (const handle of board.reconcileView(view)) handle.flush();

    return board;
};

/** One ops frame the way `main.ts onViewItem` does it: advance the document, then route it. */
const frame = (board: TurnBoard, view: SessionView, ops: TurnDisplayOp[], turnId = 't1'): void => {
    applyOpsToDisplay(view, turnId, ops, pending);
    board.applyViewOps(turnId, ops, view);
};

// ---------------------------------------------------------------------------
// Readers. Every one of them takes the board element, because a test that mounts a second
// board leaves the first one detached and `document` would then answer for the wrong board.
//
// `visibleNames` is the question the defect is about: which conversation codes a reader can
// actually READ, in reading order. A repeated code is WITHDRAWN, and this board has two
// devices for withdrawing it, both of which a reader experiences identically:
//
//   * the `hidden` attribute (`[hidden] { display: none !important }`, styles.css:124) — the
//     device the raw plane's grouped-continuation label uses, pinned for the root twin at
//     ./thread-conversation.test.ts:347;
//   * `visibility: hidden`, which the SHIPPED stylesheet applies from the row's own role
//     marker: `styles.css:3469-3472` withdraws `.thread-row[data-thread-exchange] .thread-name`
//     (a run merged into its own tile's card) and `.thread-row[data-thread-repeat]
//     .thread-name` (a card after the first for that conversation in the BOARD). The device
//     is deliberate — it keeps the code's flex slot, so `.thread-preview` stays in column
//     with the rows around it, for the reason recorded at styles.css:3422-3433.
//
// A withdrawn code contributes nothing here, whichever device withdrew it. The `.agent-name`
// head every nested section owns is deliberately not counted either: styles.css hides it
// (`.thread-flow .agent-head`), so it is not read either.
// ---------------------------------------------------------------------------

/** The ONE question every reader below asks: can a reader read this code node? */
const codeReadable = (name: HTMLElement | undefined): boolean => {
    if (name === undefined || name === null) return false;
    if (name.hidden) return false;

    // Defensive: nothing in `turns.ts` writes an inline `style.visibility` (measured — the file has
    // none). The raw plane withdraws a repeated root label with `styles.css:3434-3436`/`:3442-3444`.
    if (name.style.display === 'none' || name.style.visibility === 'hidden') return false;

    // Stylesheet withdrawal, by the row's role marker. The check is scoped to the node's OWN
    // row's header, exactly like the stylesheet's child chain
    // (`.thread-row[…] > .thread-tile > .thread-select > .thread-name`), so a card nested
    // inside a marked row keeps its own readable code. ./turns-thread-repeat-labels.test.ts
    // pins the stylesheet itself, so this mirror cannot drift silently.
    const row = name.closest<HTMLElement>('.thread-row');
    if (row === null) return true;
    if (row.querySelector(':scope > .thread-tile > .thread-select > .thread-name') !== name) return true;

    return !row.matches('[data-thread-exchange], [data-thread-repeat]');
};

const threadRows = (root: ParentNode): HTMLElement[] => [
    ...root.querySelectorAll<HTMLElement>('.thread-row')
];

const exchangeRows = (root: ParentNode): HTMLElement[] =>
    threadRows(root).filter((row) => row.classList.contains('is-exchange'));

const nameNodeOf = (row: HTMLElement): HTMLElement | undefined =>
    row.querySelector<HTMLElement>(':scope > .thread-tile > .thread-select > .thread-name') ?? undefined;

// The ONE identity a tile shows. A persistent thread carries it in the `.tile-thread` badge, and
// `syncRootAgentVisibility` then HIDES `.tile-agent` so the code is not printed twice (turns.ts:4298
// — the badge wins, the root code node stays in the DOM for legacy/unthreaded turns). A reader that
// only looked at `.tile-agent` would therefore report a session with NO root name at all; the badge
// is what `./turns-delegate-blocks.test.ts:394` reads for the same reason.
const tileIdentityOf = (tile: Element): string => {
    const badge = tile.querySelector<HTMLElement>(':scope > .tile-select > .tile-identity > .tile-thread');
    if (badge !== null && !badge.hidden && (badge.textContent ?? '').length > 0) return badge.textContent ?? '';

    const agent = tile.querySelector<HTMLElement>(':scope > .tile-select > .tile-agent');

    return agent === null || agent.hidden ? '' : agent.textContent ?? '';
};

const visibleNames = (root: ParentNode): string[] => [
    ...[...root.querySelectorAll<HTMLElement>('.turn-row > .tile')]
        .map(tileIdentityOf)
        .filter((label) => label.length > 0),
    ...threadRows(root)
        .filter((row) => !row.hidden)
        .flatMap((row) => {
            // `codeReadable`, not `name.hidden`: the compiled plane withdraws a repeated code
            // through the SHIPPED stylesheet (`visibility: hidden` from the row's role marker),
            // which the `hidden` attribute cannot see, and the same reader has to answer for
            // both devices so a reader never reads a code twice (header comment, :280).
            const name = nameNodeOf(row);
            if (!codeReadable(name)) return [];

            const label = name.textContent ?? '';

            return label.length === 0 ? [] : [label];
        })
];

const rowOfSection = (root: ParentNode, sectionId: string): HTMLElement =>
    threadRows(root).find((row) => row.dataset.threadId === sectionId) as HTMLElement;

// The strip one surface OWNS, addressed through that surface: the tile's `.tile-body` host for
// the root section, the row's own `.thread-body` host for a delegated run.
const hostOf = (surface: Element): HTMLElement | null =>
    surface.matches('.thread-row')
        ? surface.querySelector<HTMLElement>(':scope > .thread-tile > .thread-body > .context-bar-host')
        : surface.querySelector<HTMLElement>(':scope > .tile-body > .context-bar-host');

const segmentsOf = (surface: Element): string[] =>
    [...surface.querySelectorAll<HTMLElement>('.context-bar-segment')].map((node) => node.dataset.blockId ?? '');

const proseOf = (host: Element | null | undefined): string =>
    [...(host?.querySelectorAll<HTMLElement>('.agent-text') ?? [])]
        .map((node) => node.textContent ?? '')
        .join('')
        .replace(/\s+/g, '');

// The block route's answer, identified by the block it shows rather than by which strip was
// clicked: the fixture numbers blocks `<sectionOrdinal>-…`, so the section id is that prefix.
const detailFor = (input: { turnId: string; blockId: string }): TurnBlockDetail =>
    ({
        kind: 'tool',
        id: input.blockId,
        turnId: input.turnId,
        sectionId: `${input.turnId}:${input.blockId.split('-')[0]}`,
        name: `call-${input.blockId}`,
        chars: 100,
        inPrompt: true,
        state: 'ok',
        at: T,
        sessionId: 's1',
        args: `{"q":"${input.blockId}"}`,
        result: `the recorded result of ${input.blockId}`
    }) as TurnBlockDetail;

const nextTick = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    pending.clear();
    clearBlockDetailCache();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('.dialog-close')) button.click();
    vi.unstubAllGlobals();
});

describe('one card per persistent conversation (R1)', () => {
    it('shows thirteen conversations and thirteen names for a session of nineteen runs', () => {
        // 18 sections in one turn: the tile is what the caller's turn holds, and the dump's five
        // reply-runs are inside it.
        expect(SECTIONS).toHaveLength(18);

        const board = render(FULL);

        // The reported shape, fixed: 13 conversations, and the five reply-runs do NOT add a
        // second `WE7…WE11` beside the parent.
        expect(visibleNames(board.element)).toEqual(LABELS);
        expect(new Set(visibleNames(board.element)).size).toBe(13);

        // Every RUN still owns a row (twelve cards + five exchanges, plus the turn's own root
        // flow), keyed by its section id, so a merge cost no addressable run (R3).
        expect(threadRows(board.element).map((row) => row.dataset.threadId)).toEqual([
            't1:1',
            't1:2',
            't1:3',
            't1:4',
            't1:5',
            't1:6',
            't1:7',
            't1:13',
            't1:8',
            't1:14',
            't1:9',
            't1:15',
            't1:10',
            't1:16',
            't1:11',
            't1:17',
            't1:12'
        ]);
    });

    it('keeps the join and the labels stable when the roster lands after the rows', () => {
        // A live session delivers the rows first and the roster afterwards, which is also the
        // moment `data-persistent-thread` appears. Neither pass may split or renumber anything.
        const board = render(FULL);
        expect(visibleNames(board.element)).toEqual(LABELS);

        board.setThreads(ROSTER);

        expect(threadRows(board.element).map((row) => row.dataset.persistentThread)).toEqual([
            'th-we1',
            'th-we2',
            'th-we3',
            'th-we4',
            'th-we5',
            'th-we6',
            'th-we7',
            'th-we7',
            'th-we8',
            'th-we8',
            'th-we9',
            'th-we9',
            'th-we10',
            'th-we10',
            'th-we11',
            'th-we11',
            'th-rr1'
        ]);
        expect(visibleNames(board.element)).toEqual(LABELS);
        // A row's preview is bound at CREATION from the roster claim of its own run
        // (`turns.ts:8347`), so a roster that lands AFTER the rows leaves the neutral figure
        // rather than inventing a prompt — and the join changed nothing else on the row.
        expect(rowOfSection(board.element, 't1:13').querySelector('.thread-preview')?.textContent).toBe(
            'delegated task'
        );
        expect(rowOfSection(board.element, 't1:7').querySelector('.thread-preview')?.textContent).toBe(
            'delegated task'
        );
        // What the late roster DOES own: the conversation each row belongs to, the reply row
        // included — one conversation, two rows, one persistent id.
        expect(rowOfSection(board.element, 't1:13').dataset.persistentThread).toBe('th-we7');
        expect(rowOfSection(board.element, 't1:7').dataset.persistentThread).toBe('th-we7');
    });

    it('places each reply-run as the ordered exchange of the card it belongs to', () => {
        const board = render(FULL);

        // The five later runs say they are exchanges, and name the conversation they belong to —
        // the same figure a continuation turn row carries on the raw path (:3058).
        expect(exchangeRows(board.element).map((row) => row.dataset.threadId)).toEqual([
            't1:13',
            't1:14',
            't1:15',
            't1:16',
            't1:17'
        ]);
        expect(exchangeRows(board.element).map((row) => row.dataset.threadExchange)).toEqual([
            'th-we7',
            'th-we8',
            'th-we9',
            'th-we10',
            'th-we11'
        ]);

        for (const index of REPLIED) {
            const card = rowOfSection(board.element, `t1:${index}`);
            const exchange = rowOfSection(board.element, `t1:${replyOf(index)}`);

            // Chronological: the exchange is the row directly after the card it continues, one
            // level deeper, and `data-parent-thread` names that card — the recorded hierarchy as
            // ORDER and IDENTITY rather than DOM nesting (R18).
            const rows = threadRows(board.element);
            expect(rows.indexOf(exchange)).toBe(rows.indexOf(card) + 1);
            expect(exchange.dataset.parentThread).toBe(`t1:${index}`);
            expect(exchange.dataset.depth).toBe('2');
            expect(card.dataset.depth).toBe('1');

            // The repeated NAME is the only figure that duplicated: the card keeps it, the
            // exchange hides it, and both rows still carry their own run's state.
            expect(nameNodeOf(card)?.textContent).toBe(`WE${index}`);
            expect(codeReadable(nameNodeOf(card))).toBe(true);
            expect(codeReadable(nameNodeOf(exchange))).toBe(false);
            expect(card.dataset.state).toBe('done');
            expect(exchange.dataset.state).toBe('cancelled');
        }
    });

    it('keeps every run inspectable: one strip and one body per run (R3)', () => {
        const board = render(FULL);

        // Eighteen sections, eighteen strips: one per RUN, the five reply-runs included. The
        // merge is a placement decision, never a fold of two runs into one surface — which is why
        // no strip ever had to "follow" the wrong section.
        expect(board.element.querySelectorAll('.context-bar')).toHaveLength(18);

        const hosts = [...board.element.querySelectorAll<HTMLElement>('.context-bar-host')];
        expect(hosts.map((host) => host.dataset.sectionId).sort()).toEqual(
            SECTIONS.map((entry) => entry.id).sort()
        );

        for (const index of REPLIED) {
            const cardHost = hostOf(rowOfSection(board.element, `t1:${index}`)) as HTMLElement;
            const exchangeHost = hostOf(rowOfSection(board.element, `t1:${replyOf(index)}`)) as HTMLElement;

            // Each strip follows ITS OWN section: the card's strip still carries the FIRST run's
            // segments (a later run never took the card's bar over), and the exchange's strip
            // carries the reply run's.
            expect(cardHost.dataset.sectionId).toBe(`t1:${index}`);
            expect(exchangeHost.dataset.sectionId).toBe(`t1:${replyOf(index)}`);
            expect(segmentsOf(cardHost)).toEqual([`${index}-task-prompt`, `${index}-tool-4`]);
            expect(segmentsOf(exchangeHost)).toEqual([
                `${replyOf(index)}-reply-prompt`,
                `${replyOf(index)}-tool-2`
            ]);

            // And each row prints ITS OWN run: no run's prose was swallowed by the card.
            expect(proseOf(rowOfSection(board.element, `t1:${index}`))).toBe(`WE${index}firstrun`);
            expect(proseOf(rowOfSection(board.element, `t1:${replyOf(index)}`))).toBe(`WE${index}replyrun`);
        }

        // The tile's own strip is untouched by all of it.
        expect(
            segmentsOf(hostOf(board.element.querySelector('.turn-row > .tile') as Element) as Element)
        ).toEqual(['0-user-prompt', '0-tool-7']);
    });

    it('routes a click in a reply-run strip to that run, one request per click (R3)', async () => {
        const calls: { turnId: string; blockId: string; sessionId?: string }[] = [];
        const loadBlockDetail = vi.fn(async (input: { turnId: string; blockId: string; sessionId?: string }) => {
            calls.push(input);

            return detailFor(input);
        });

        const board = render(FULL, mount({ loadBlockDetail }));

        // Rendering cost nothing: eighteen strips, zero requests.
        expect(loadBlockDetail).not.toHaveBeenCalled();

        // The reply run's own segment: the request names the REPLY section's block, so the exact
        // recorded bytes of a merged-in run stay reachable through the merge.
        rowOfSection(board.element, 't1:15')
            .querySelector<HTMLElement>('.context-bar-segment[data-block-id="15-tool-2"]')
            ?.click();
        await nextTick();

        expect(calls).toEqual([{ sessionId: 's1', turnId: 't1', blockId: '15-tool-2' }]);
        expect(document.querySelector<HTMLElement>('.block-detail')?.getAttribute('data-block-id')).toBe('15-tool-2');
        expect(document.querySelector<HTMLElement>('[data-pane="result"]')?.textContent).toContain(
            'the recorded result of 15-tool-2'
        );

        // The CARD of that same conversation answers for its own run: one conversation, two runs,
        // two different blocks, one dialog.
        rowOfSection(board.element, 't1:9')
            .querySelector<HTMLElement>('.context-bar-segment[data-block-id="9-tool-4"]')
            ?.click();
        await nextTick();

        expect(calls).toHaveLength(2);
        expect(calls[1]).toEqual({ sessionId: 's1', turnId: 't1', blockId: '9-tool-4' });
        expect(document.querySelectorAll('.dialog')).toHaveLength(1);
    });

    it('rebuilds the same thirteen cards from a fresh hydration (R2)', () => {
        // Live door.
        const live = render(FULL);

        // Reload door: a brand-new board reading the terminal document — no live state, and no
        // roster at all, so the merge is derived only from what the records carry.
        const cold = mount();
        for (const handle of cold.hydrateView(viewOf(SECTIONS))) handle.flush();

        // Drain door: the same document routed a second time through the same board.
        for (const handle of live.reconcileView(viewOf(SECTIONS))) handle.flush();

        for (const board of [live, cold]) {
            expect(
                [...board.element.querySelectorAll<HTMLElement>('.turn-row > .tile .tile-agent')].map(
                    (node) => node.textContent ?? ''
                )
            ).toEqual(['IT1']);
            expect(visibleNames(board.element)).toEqual(LABELS);
            expect(exchangeRows(board.element).map((row) => row.dataset.threadId)).toEqual([
                't1:13',
                't1:14',
                't1:15',
                't1:16',
                't1:17'
            ]);
            expect(board.element.querySelectorAll('.context-bar')).toHaveLength(18);
        }
    });
});

describe('a thread id that lands late re-keys the row in place (R4)', () => {
    it('merges the reply-runs when their threadId arrives, without a second copy', () => {
        // The tree BEFORE the server fills `TurnSection.threadId`: identity is only the
        // invocation id and the roster has not landed, so nothing PROVES the second run is the
        // same conversation. It keeps its own card: the merge never guesses (R5).
        const bare = viewOf(
            SECTIONS.map((entry) => (entry.invocationId?.endsWith('-2') ? { ...entry, threadId: undefined } : entry))
        );
        const board = render(bare);

        // A duplicated name is the honest transient state of an unprovable payload.
        expect(visibleNames(board.element).filter((label) => label === 'WE7')).toHaveLength(2);
        expect(exchangeRows(board.element)).toHaveLength(0);

        // The rows that exist NOW are the rows that must still exist after the join: the join
        // re-KEYS a row, it never mints a second copy of one.
        const before = threadRows(board.element);
        expect(before).toHaveLength(17);

        frame(
            board,
            bare,
            REPLIED.map((index, position) => ({
                op: 'section:set',
                turnId: 't1',
                sectionId: `t1:${13 + position}`,
                patch: { threadId: `th-we${index}` }
            })) as TurnDisplayOp[]
        );

        const after = threadRows(board.element);
        expect(after).toHaveLength(17);
        // The SAME seventeen row elements, no second copy and none dropped. Order is expected to
        // change — the merged runs move to sit right after their card — so identity is what is
        // pinned here, by element, not by position.
        expect(after.map((row) => row.dataset.threadId).sort()).toEqual(
            before.map((row) => row.dataset.threadId).sort()
        );
        const kept = new Set(before);
        expect(after.filter((row) => kept.has(row))).toHaveLength(17);
        expect(new Set(after).size).toBe(17);
        // And the order it settled into is the reading order of thirteen cards — the same figure
        // the fully-labelled payload renders (test R1), reached without re-creating a row.
        expect(after.map((row) => row.dataset.threadId)).toEqual([
            't1:1',
            't1:2',
            't1:3',
            't1:4',
            't1:5',
            't1:6',
            't1:7',
            't1:13',
            't1:8',
            't1:14',
            't1:9',
            't1:15',
            't1:10',
            't1:16',
            't1:11',
            't1:17',
            't1:12'
        ]);

        expect(exchangeRows(board.element).map((row) => row.dataset.threadExchange)).toEqual([
            'th-we7',
            'th-we8',
            'th-we9',
            'th-we10',
            'th-we11'
        ]);
        expect(visibleNames(board.element).filter((label) => label === 'WE7')).toHaveLength(1);
        expect(new Set(visibleNames(board.element)).size).toBe(13);
        // Nothing was lost by the re-key: still one strip per run.
        expect(board.element.querySelectorAll('.context-bar')).toHaveLength(18);
    });

    it('promotes the next run to the card when the card is removed', () => {
        const board = render(FULL);

        // A deleted conversation takes its card with it. The exchange that survives becomes that
        // conversation's card, rather than an orphan with a hidden name.
        frame(board, FULL, [{ op: 'section:remove', turnId: 't1', sectionId: 't1:7' }]);

        expect(threadRows(board.element)).toHaveLength(16);
        expect(exchangeRows(board.element).map((row) => row.dataset.threadId)).toEqual([
            't1:14',
            't1:15',
            't1:16',
            't1:17'
        ]);

        const promoted = rowOfSection(board.element, 't1:13');
        expect(promoted.classList.contains('is-exchange')).toBe(false);
        expect(codeReadable(nameNodeOf(promoted))).toBe(true);
        expect(nameNodeOf(promoted)?.textContent).toBe('WE7');
        expect(promoted.dataset.parentThread).toBeUndefined();
        expect(promoted.dataset.depth).toBe('1');
        expect(visibleNames(board.element).filter((label) => label === 'WE7')).toHaveLength(1);
        expect(board.element.querySelectorAll('.context-bar')).toHaveLength(17);
    });
});

describe('merging never guesses (R5)', () => {
    it('keeps two runs of different conversations apart when they share one invocation id', () => {
        // The recycled-id shape of ./turns-compiled-run-epoch.test.ts:314, made interesting by
        // giving each run its OWN `threadId`: one bare invocation id names two conversations, so
        // the merge keys on the conversation and never on the run id.
        const shared = section({
            id: 't1:20',
            agentLabel: 'WE12',
            threadId: 'th-we12',
            invocationId: 'inv-16',
            parentSectionId: 't1:0',
            context: [block('t1:20', '20-tool-4')],
            nodes: [answer('20', 'lane one')]
        });
        const recycled = section({
            id: 't1:21',
            agentLabel: 'WE13',
            threadId: 'th-we13',
            invocationId: 'inv-16',
            parentSectionId: 't1:0',
            context: [block('t1:21', '21-tool-4')],
            nodes: [answer('21', 'lane two')]
        });

        const board = render(viewOf([ROOT, shared, recycled]));

        expect(threadRows(board.element).map((row) => row.dataset.threadId)).toEqual(['t1:20', 't1:21']);
        expect(exchangeRows(board.element)).toHaveLength(0);
        expect(visibleNames(board.element)).toEqual(['IT1', 'WE12', 'WE13']);
    });

    it('never merges siblings whose roster claim is ambiguous', () => {
        // Two delegated runs, no `threadId` on the wire, and two conversations that BOTH name
        // the same run id: nothing distinguishes the pairs, so no conversation may claim either
        // card — the rule ./thread-conversation.test.ts:1302 pins on the raw path.
        const board = mount();
        board.setThreads([
            rosterEntry({ id: 'th-a', label: 'WE14', invocationId: 'inv-x', invocationIds: ['inv-x'] }),
            rosterEntry({ id: 'th-b', label: 'WE15', invocationId: 'inv-x', invocationIds: ['inv-x'] })
        ]);

        const first = section({
            id: 't1:30',
            agentLabel: 'WE14',
            invocationId: 'inv-x',
            parentSectionId: 't1:0',
            context: [block('t1:30', '30-tool-4')],
            nodes: [answer('30', 'sibling one')]
        });
        const second = section({
            id: 't1:31',
            agentLabel: 'WE15',
            invocationId: 'inv-x',
            parentSectionId: 't1:0',
            context: [block('t1:31', '31-tool-4')],
            nodes: [answer('31', 'sibling two')]
        });

        render(viewOf([ROOT, first, second]), board);

        expect(exchangeRows(board.element)).toHaveLength(0);
        expect(threadRows(board.element).map((row) => row.dataset.threadId)).toEqual(['t1:30', 't1:31']);
        expect(visibleNames(board.element)).toEqual(['IT1', 'WE14', 'WE15']);
    });

    it('joins a run that carries no threadId through a unique roster claim (R2)', () => {
        const board = mount();
        // The authoritative anchor for a RESUMED conversation: `invocationId` moved to the second
        // run, and only `invocationIds` still names the original delegated one.
        board.setThreads([
            rosterEntry({
                id: 'th-we16',
                label: 'WE16',
                invocationId: 'inv-we16-2',
                invocationIds: ['inv-we16-1', 'inv-we16-2'],
                preview: 'STOP TESTING AND REPORT NOW'
            })
        ]);

        const first = section({
            id: 't1:40',
            agentLabel: 'WE16',
            invocationId: 'inv-we16-1',
            parentSectionId: 't1:0',
            context: [block('t1:40', '40-tool-4')],
            nodes: [answer('40', 'first run')]
        });
        const second = section({
            id: 't1:41',
            agentLabel: 'WE16',
            invocationId: 'inv-we16-2',
            context: [block('t1:41', '41-tool-4')],
            nodes: [answer('41', 'second run')]
        });

        render(viewOf([ROOT, first, second]), board);

        // ONE card, named once; the resumed run is the exchange inside it, and its own strip,
        // prose and persistent join survived the join.
        expect(threadRows(board.element).map((row) => row.dataset.threadId)).toEqual(['t1:40', 't1:41']);
        expect(exchangeRows(board.element).map((row) => row.dataset.threadId)).toEqual(['t1:41']);
        expect(visibleNames(board.element)).toEqual(['IT1', 'WE16']);
        expect(segmentsOf(hostOf(rowOfSection(board.element, 't1:41')) as Element)).toEqual(['41-tool-4']);
        expect(proseOf(rowOfSection(board.element, 't1:41'))).toBe('secondrun');
        expect(rowOfSection(board.element, 't1:41').dataset.persistentThread).toBe('th-we16');
        // The roster preview is bound per ROW from that row's own run (turns.ts:8347), so the
        // merge kept the join on both: one conversation, one transcript preview, two rows.
        expect(rowOfSection(board.element, 't1:40').querySelector('.thread-preview')?.textContent).toContain(
            'STOP TESTING'
        );
        expect(rowOfSection(board.element, 't1:41').querySelector('.thread-preview')?.textContent).toContain(
            'STOP TESTING'
        );
    });
});

// ---------------------------------------------------------------------------
// The boundary of the rule, pinned rather than assumed (R1's scope is ONE parent).
//
// The card is the conversation INSIDE a tile: each turn tile lists the runs that landed in that
// turn, and a run of a conversation that tile has not shown yet is that tile's card. A later
// turn therefore legitimately repeats the code, in a different place, with its own run detail -
// which is what a reader of a transcript expects from a turn boundary, and what keeps every
// run's prose and strip inside the turn that produced it (R3).
// ---------------------------------------------------------------------------

describe('the card is scoped to one tile (R1 boundary)', () => {
    it('merges a later run recorded under a different parent of the same tile', () => {
        // The conversation's two runs are recorded under DIFFERENT parents (`t1:51` and the
        // turn's own root), with an unrelated conversation nested in between: the join keys on
        // the CONVERSATION, not on the recorded parent, so the second run still belongs to the
        // first card rather than becoming a third name in the list.
        const weFirst = section({
            id: 't1:51',
            agentLabel: 'WE7',
            threadId: 'th-we7',
            invocationId: 'inv-we7-1',
            parentSectionId: 't1:0',
            context: [block('t1:51', '51-tool-4')],
            nodes: [answer('51', 'first run')]
        });
        const nested = section({
            id: 't1:52',
            agentLabel: 'WE8',
            threadId: 'th-we8',
            invocationId: 'inv-we8-1',
            parentSectionId: 't1:51',
            context: [block('t1:52', '52-tool-4')],
            nodes: [answer('52', 'nested run')]
        });
        const weReply = section({
            id: 't1:53',
            agentLabel: 'WE7',
            threadId: 'th-we7',
            invocationId: 'inv-we7-2',
            parentSectionId: 't1:0',
            context: [block('t1:53', '53-tool-4')],
            nodes: [answer('53', 'reply run')]
        });

        const board = render(viewOf([ROOT, weFirst, nested, weReply]));

        expect(threadRows(board.element).map((row) => row.dataset.threadId)).toEqual([
            't1:51',
            't1:52',
            't1:53'
        ]);
        // The reply run is the exchange, hung off the CARD rather than off the parent the
        // record names, and `WE7` is printed once.
        const exchange = rowOfSection(board.element, 't1:53');
        expect(exchange.classList.contains('is-exchange')).toBe(true);
        expect(exchange.dataset.threadExchange).toBe('th-we7');
        expect(exchange.dataset.parentThread).toBe('t1:51');
        expect(exchange.dataset.depth).toBe('2');
        expect(nameNodeOf(exchange)?.hidden).toBe(false);
        expect(codeReadable(nameNodeOf(exchange))).toBe(false);
        expect(visibleNames(board.element)).toEqual(['IT1', 'WE7', 'WE8']);
        expect(proseOf(exchange)).toBe('replyrun');
        expect(segmentsOf(hostOf(exchange) as Element)).toEqual(['53-tool-4']);
    });

    it('keeps ONE readable code across two turns that both ran the conversation', () => {
        // One conversation, two turns: `threadSend` records a reply run into its CALLER's turn,
        // so a conversation that ran in an earlier turn and runs again in a later one is listed
        // by BOTH tiles. Each tile still owns its own run — the code, however, is one figure per
        // SESSION, so the LATER tile's card is the repeat (the rule and the reason are in
        // `syncCompiledThreadRepeats`, turns.ts:3307; the tile-scoped rule alone could not see
        // this, and this assertion is the one C1's tile-scoped version had to supersede).
        const weFirst = section({
            id: 't1:1',
            agentLabel: 'WE7',
            threadId: 'th-we7',
            invocationId: 'inv-we7-1',
            parentSectionId: 't1:0',
            context: [block('t1:1', '1-tool-4')],
            nodes: [answer('1', 'first run')]
        });
        const rootSecond = section({
            id: 't2:0',
            rank: 'A',
            agent: 'instruct',
            agentLabel: 'IT1',
            threadId: 'th-instruct',
            invocationId: 'inv-it1-2',
            threadLabel: 'IT1',
            context: [block('t2:0', '20-tool-4')],
            nodes: [answer('20', 'second turn')]
        });
        const weReply = section({
            id: 't2:1',
            agentLabel: 'WE7',
            threadId: 'th-we7',
            invocationId: 'inv-we7-2',
            context: [block('t2:1', '21-tool-4')],
            nodes: [answer('21', 'reply run')]
        });

        const board = render(
            ({
                id: 's1',
                harness: 'instruct',
                status: 'idle',
                model: 'm1',
                createdAt: 1,
                updatedAt: T + 400_000,
                turns: [summary('t1'), summary('t2')],
                displays: {
                    t1: { turnId: 't1', sections: [ROOT, weFirst] },
                    t2: { turnId: 't2', sections: [rootSecond, weReply] }
                }
            }) as unknown as SessionView
        );

        // Each tile owns its own run, and the code is never repeated UNDER one parent — and now
        // never repeated ACROSS tiles either: the second tile's card is marked, and a reader sees
        // `WE7` once for the session.
        expect(threadRows(board.element).map((row) => row.dataset.threadId)).toEqual(['t1:1', 't2:1']);
        expect(exchangeRows(board.element)).toHaveLength(0);
        expect(rowOfSection(board.element, 't1:1').dataset.threadCard).toBe('th-we7');
        expect(rowOfSection(board.element, 't1:1').dataset.threadRepeat).toBeUndefined();
        expect(rowOfSection(board.element, 't2:1').dataset.threadCard).toBe('th-we7');
        expect(rowOfSection(board.element, 't2:1').dataset.threadRepeat).toBe('');
        expect(codeReadable(nameNodeOf(rowOfSection(board.element, 't1:1')))).toBe(true);
        expect(codeReadable(nameNodeOf(rowOfSection(board.element, 't2:1')))).toBe(false);
        expect(visibleNames(board.element)).toEqual(['IT1', 'IT1', 'WE7']);

        // R3 held: the second run's detail stayed in the second tile.
        expect(
            rowOfSection(board.element, 't2:1')
                .closest('.turn-row')
                ?.querySelector<HTMLElement>(':scope > .tile > .tile-select > .tile-identity > .tile-thread')
                ?.textContent
        ).toBe('IT1');
        expect(
            rowOfSection(board.element, 't1:1').closest('.turn-row') !==
                rowOfSection(board.element, 't2:1').closest('.turn-row')
        ).toBe(true);
        expect(proseOf(rowOfSection(board.element, 't2:1'))).toBe('replyrun');
        expect(segmentsOf(hostOf(rowOfSection(board.element, 't2:1')) as Element)).toEqual(['21-tool-4']);
    });
});

/**
 * R14 / review F2 — the mirrored readers above (`codeReadable`, `visibleNames`,
 * `tileIdentityOf`) are the only JS copy of the shipped stylesheet's withdrawal rules, so
 * they are pinned against the engine itself: `styles.css` is injected as a real <style> and
 * every verdict is re-derived through `getComputedStyle`. Three boards are probed:
 *
 *   1. `FULL` — the 19-run board, one card per conversation, nothing withdrawn;
 *   2. a cross-turn repeat — the conversation ran in an earlier turn, so the later tile's
 *      card is the board-level repeat (`syncCompiledThreadRepeats`, turns.ts:3307);
 *   3. the F1 shape — that repeat card is ITSELF the parent of a live child row, so a
 *      readable row sits inside the subtree of a withdrawn card. A board-level pass that
 *      ranked by DOM nesting used to mark the outer card and leave the conversation with no
 *      readable code at all; the R6 rule that withdraws it (styles.css:3469-3472) must not
 *      reach into that subtree either.
 *
 * Pinning the mirror to the engine is what stops it drifting silently: any rule that hides a
 * code through inheritance — styles.css:3469-3472, or the tile-badge rule at
 * styles.css:3442-3444 — shows up here as a disagreement instead of as a reader that reports
 * a conversation code zero times.
 */
describe('the mirrored readers vs the shipped stylesheet (R14)', () => {
    // The real stylesheet, with the same two-candidate resolution the stylesheet-driven suite
    // uses (./turns-thread-repeat-labels.test.ts:83-86) — vitest's root is `src/frontend`, so
    // the package-relative candidate is the one that resolves.
    const stylesheet = ['src/frontend/styles.css', 'src/styles.css']
        .map((candidate) => resolve(process.cwd(), candidate))
        .find((candidate) => existsSync(candidate));
    if (stylesheet === undefined) throw new Error('styles.css not found');

    const shippedCss = readFileSync(stylesheet, 'utf8');

    /** Two turns of one session, the way the cross-turn test above records them. */
    const twoTurns = (first: TurnSection[], second: TurnSection[]): SessionView =>
        ({
            id: 's1',
            harness: 'instruct',
            status: 'idle',
            model: 'm1',
            createdAt: 1,
            updatedAt: T + 400_000,
            turns: [summary('t1'), summary('t2')],
            displays: { t1: { turnId: 't1', sections: first }, t2: { turnId: 't2', sections: second } }
        }) as unknown as SessionView;

    /** What a browser actually renders for one code node: attribute plus inherited CSS. */
    const engineReadable = (name: HTMLElement | undefined | null): boolean => {
        if (name === undefined || name === null) return false;

        const computed = getComputedStyle(name);

        return !name.hidden && computed.visibility !== 'hidden' && computed.display !== 'none';
    };

    /** `tileIdentityOf` re-derived through the engine instead of through the `hidden` flag. */
    const engineTileIdentity = (tile: Element): string => {
        const badge = tile.querySelector<HTMLElement>(':scope > .tile-select > .tile-identity > .tile-thread');

        if (engineReadable(badge)) return badge?.textContent ?? '';

        const agent = tile.querySelector<HTMLElement>(':scope > .tile-select > .tile-agent');

        return engineReadable(agent) ? agent?.textContent ?? '' : '';
    };

    /** `visibleNames` re-derived through the engine, for the same board. */
    const engineVisibleNames = (root: ParentNode): string[] => [
        ...[...root.querySelectorAll<HTMLElement>('.turn-row > .tile')]
            .map(engineTileIdentity)
            .filter((label) => label.length > 0),
        ...threadRows(root)
            .filter((row) => !row.hidden)
            .flatMap((row) => {
                const name = nameNodeOf(row);

                if (!engineReadable(name)) return [];

                const label = name?.textContent ?? '';

                return label.length === 0 ? [] : [label];
            })
    ];

    /**
     * Both readers over one board, plus every `.thread-name` where the mirror and the engine
     * disagree. Measured while the board is still attached: `mount()` replaces the previous
     * board, and neither a browser nor jsdom resolves inheritance on a detached tree.
     */
    const compare = (board: TurnBoard) => ({
        mirror: visibleNames(board.element),
        engine: engineVisibleNames(board.element),
        disagreements: [...board.element.querySelectorAll<HTMLElement>('.thread-name')]
            .filter((name) => codeReadable(name) !== engineReadable(name))
            .map((name) => `${name.textContent ?? ''}:${name.hidden ? 'hidden' : 'shown'}`)
    });

    it('answers identically for a flat board, a cross-turn repeat, and a nested repeat', () => {
        // Injected for this test only — every other test in this file reads unstyled DOM, so
        // an attached <style> would silently change what they observe.
        const style = document.createElement('style');
        style.id = 'shipped-stylesheet';
        style.textContent = shippedCss;

        const results: Record<string, ReturnType<typeof compare>> = {};
        try {
            document.head.appendChild(style);

            // 1. Nothing withdrawn.
            const flat = render(FULL);
            flat.setThreads(ROSTER);
            results.flat = compare(flat);

            // 2 + 3. The same cross-turn repeat, with and without a live child row nested
            // inside the repeat card.
            const weFirst = section({
                id: 't1:1',
                agentLabel: 'WE7',
                threadId: 'th-we7',
                invocationId: 'inv-we7-1',
                parentSectionId: 't1:0',
                context: [block('t1:1', '1-tool-4')],
                nodes: [answer('1', 'first run')]
            });
            const rootSecond = section({
                id: 't2:0',
                rank: 'A',
                agent: 'instruct',
                agentLabel: 'IT1',
                threadId: 'th-instruct',
                invocationId: 'inv-it1-2',
                threadLabel: 'IT1',
                context: [block('t2:0', '20-tool-4')],
                nodes: [answer('20', 'second turn')]
            });
            const weReply = section({
                id: 't2:1',
                agentLabel: 'WE7',
                threadId: 'th-we7',
                invocationId: 'inv-we7-2',
                context: [block('t2:1', '21-tool-4')],
                nodes: [answer('21', 'reply run')]
            });
            const nestedChild = section({
                id: 't2:2',
                agentLabel: 'WE8',
                threadId: 'th-we8',
                invocationId: 'inv-we8-1',
                parentSectionId: 't2:1',
                context: [block('t2:2', '22-tool-4')],
                nodes: [answer('22', 'nested run')]
            });

            const cross = render(twoTurns([ROOT, weFirst], [rootSecond, weReply]));
            results.cross = compare(cross);

            const nested = render(twoTurns([ROOT, weFirst], [rootSecond, weReply, nestedChild]));
            results.nested = compare(nested);
        } finally {
            style.remove();
        }

        // The shared predicate — the `hidden` attribute, inherited `visibility`, `display` —
        // resolves identically under the mirror and under the injected stylesheet, for every
        // `.thread-name` node of every board. A rule that withdrew a row code in a way the
        // mirror does not model would name the node here.
        expect(Object.values(results).flatMap((entry) => entry.disagreements)).toEqual([]);

        // Both readers, pinned. The one place they differ is the TILE badge, and the reason is
        // honest and known: `tileIdentityOf` reads only the `hidden` attribute, while the
        // stylesheet also withdraws a continuation tile's badge through inherited
        // `visibility` — styles.css:3434-3436 for a continuation turn (`IT1` again in the
        // second tile) and styles.css:3442-3444 for a turn row nested inside a child card. The
        // mirror therefore reports a tile's OWN identity per tile, and the engine reports what
        // a reader actually sees once per session; the row codes — the figure R6 is about — are
        // identical, which is what the assertion above pins.
        expect(results).toEqual({
            // One card per conversation: nothing withdrawn, both readers agree completely.
            flat: {
                mirror: ['IT1', 'WE1', 'WE2', 'WE3', 'WE4', 'WE5', 'WE6', 'WE8', 'WE9', 'WE10', 'WE11', 'RR1', 'WE7'],
                engine: ['IT1', 'WE1', 'WE2', 'WE3', 'WE4', 'WE5', 'WE6', 'WE8', 'WE9', 'WE10', 'WE11', 'RR1', 'WE7'],
                disagreements: []
            },
            // The cross-turn repeat: the second card's `WE7` is withdrawn by styles.css:3469-3472
            // (both readers agree on that), and the second tile's `IT1` badge is withdrawn by
            // styles.css:3434-3436 (only the engine sees that).
            cross: {
                mirror: ['IT1', 'IT1', 'WE7'],
                engine: ['IT1', 'WE7'],
                disagreements: []
            },
            // F1's shape: the repeat card also owns a live child row, so `WE8` stays readable
            // inside the subtree of a withdrawn card — the code that regressed to ZERO reads it
            // once under both readers.
            nested: {
                mirror: ['IT1', 'IT1', 'WE7', 'WE8'],
                engine: ['IT1', 'WE7', 'WE8'],
                disagreements: []
            }
        });
    });
});

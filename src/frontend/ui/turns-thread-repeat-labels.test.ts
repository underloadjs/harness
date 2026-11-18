// ONE CONVERSATION CODE PER SESSION — ACROSS CARDS (R6), THE CODE KEEPS ITS COLUMN (D2/R7),
// AND A CARD THE SERVER DELETED NEVER SPENDS THE CODE (R17).
//
// The defect the user reported: an Instruct session printed the SAME conversation code twice,
// in two places, and the second copy knocked the row's columns out of alignment. The tile-scoped
// fix (./turns-compiled-conversation-cards.test.ts, ./turns-delegate-blocks.test.ts) closed the
// in-tile door — a later run of a conversation the SAME tile already shows becomes that card's
// ordered exchange. Three things were left:
//
//   D1  the CROSS-TILE door. A `threadSend` reply-run is recorded into its CALLER's turn
//       (../harness.ts records it into the current turn), so a conversation that ran in an
//       EARLIER turn and runs again in a LATER one is listed by BOTH tiles, and each tile
//       printed its own `WE7`. A tile has no idea what another tile painted, so no tile-scoped
//       rule can close this; the board has to re-derive the answer for the whole session.
//   D2  the DEVICE. The repeated code was withdrawn with the `hidden` attribute, and
//       `[hidden] { display: none !important }` (styles.css:124) collapses the row's identity
//       half — `.thread-preview`, the only flexible item of `.thread-select` (styles.css:4110),
//       then starts ~one badge width left of its neighbours. The shipped stylesheet already had
//       the right answer for the SAME figure elsewhere (`visibility: hidden`, styles.css:3434-3436
//       and :3442-3444): the slot stays reserved, so the columns line up, because every copy of an
//       identity prints the SAME text and therefore the SAME width.
//   D3  the DELETED card. A roster entry the server deletes HIDES its row (turns.ts:5016) but keeps
//       its card election, so the hidden row still reaches the session-wide pass. A row that paints
//       nothing must not spend a code or hold a rank: on a frame where the hide has not landed on
//       every row of the conversation, the card the reader CAN see would be the one left at zero.
//
// What this file pins, against the SHIPPED stylesheet so the answer is measured and not mirrored:
//
//   R6  one code per session across cards: the board ranks every compiled card by its owning
//       turn's index in the board's turn ARRAY — the recorded order on a snapshot frame, or the
//       order an ops `{op:'turn'}` upsert appends until the next snapshot heals it — and then by
//       its place inside that turn, marking every card whose code an EARLIER card already shows.
//       The invariant is ONE readable copy per conversation: never twice, never zero. The mark
//       survives every way this board gets rebuilt — tiles arriving out of order, a fresh
//       hydration, a card removed, a session switched. A rows-only (optimistic) tile has no
//       compiled tree, so it never owns a code and never loses one. The marked row keeps its
//       join, its own strip, its prose and its routes.
//   R6b a card NESTED inside another conversation's card keeps its OWN readable code. A resumed
//       child conversation is a turn of its own thread, and `placeTurn` routes that turn inside
//       the child's card, so its rows are DESCENDANTS of an earlier tile: a pass that queried one
//       subtree per tile visited such a card twice and marked it, leaving ZERO readable copies,
//       and a pass that ranked by DOM order let the nested copy outrank the turn-array-earliest
//       card. The board now reads every card once and ranks by turn-array order (the fixture and
//       the measurements are in the R6b block below).
//   R7  the withdrawal reserves the slot: the code is unreadable (`visibility: hidden`) while
//       `display` stays `inline`, so `.thread-preview` keeps the exact column the rows around it
//       use — for an in-tile exchange AND for a cross-tile repeat.
//   R8  pressing an exchange row's header opens THAT run's body inline and moves no focus and no
//       route (turns.ts:5701-5710), which is what keeps it from reading as a dead control; the card
//       above is that conversation's steerable surface, so a repeat row's press does steer it.
//   R17 a `hidden` row never takes part in the election — the pass skips it before `shown` is
//       written (turns.ts:3372), so a card the server deleted neither spends a code nor carries a
//       rank mark, and the pair re-derives the moment the roster revives the conversation. The hide
//       is `paintPersistentMarkers` reacting to `isConversationDeleted` (turns.ts:2868, turns.ts:5016).
//
// Run: yarn vitest run --config src/frontend/vitest.config.ts ui/turns-thread-repeat-labels.test.ts

import type {
    ContextBlock,
    DisplayNode,
    TurnDisplayOp,
    TurnSection,
    TurnSummary
} from '../../shared/turn-display';
import type { HarnessEvent, SessionTurn, SessionView } from '../../server/protocol';
import { existsSync, readFileSync } from 'node:fs';
import { applyOpsToDisplay } from '../view-state';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTurnBoard, type TurnBoard } from './turns';
import type { SessionThreadEntry } from './threads';
import { resolve } from 'node:path';

const T = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// The stylesheet, injected for the whole file. jsdom parses and applies it, so
// `getComputedStyle` answers the question a browser would answer — which code can a reader
// actually READ — rather than this file restating the rules. Same resolution trick as
// ./activity-style.test.ts:14 (root is src/frontend, and `import.meta.url` is not a file URL
// under this config).
// ---------------------------------------------------------------------------

const stylesheet = ['src/frontend/styles.css', 'src/styles.css']
    .map((candidate) => resolve(process.cwd(), candidate))
    .find((candidate) => existsSync(candidate));
if (stylesheet === undefined) throw new Error('styles.css not found');

const css = readFileSync(stylesheet, 'utf8');

beforeAll(() => {
    const style = document.createElement('style');
    style.id = 'shipped-stylesheet';
    style.textContent = css;
    document.head.append(style);
});

// ---------------------------------------------------------------------------
// Fixture: the reported shape, kept to the two turns that show the defect. ONE persistent
// conversation `th-we7` / `WE7`, a first `delegate` run in turn `t1` and a `threadSend`
// reply-run recorded into the LATER turn `t2`. Every section carries a non-empty `context`
// array, which is what the compiled plane reads for its strip — a section without one leaves
// the tile in rows-only mode and the test would be measuring the wrong plane.
// ---------------------------------------------------------------------------

const block = (sectionId: string, id: string): ContextBlock =>
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
        endedAt: T + 500
    }) as ContextBlock;

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

// The turn's own flow, so both tiles belong to the same ROOT conversation (`th-instruct`).
const root = (turnId: string): TurnSection =>
    section({
        id: `${turnId}:0`,
        rank: 'A',
        agent: 'instruct',
        agentLabel: 'IT1',
        threadId: 'th-instruct',
        invocationId: `inv-it1-${turnId}`,
        threadLabel: 'IT1',
        context: [block(`${turnId}:0`, `${turnId}0-tool-7`)],
        nodes: [answer(`${turnId}0`, `${turnId} prose`)]
    });

// One RUN of conversation `th-we7`, labelled with the server's code `WE7`.
const weRun = (turnId: string, invocation: string, text: string): TurnSection =>
    section({
        id: `${turnId}:1`,
        agent: 'workspace',
        agentLabel: 'WE7',
        threadId: 'th-we7',
        invocationId: invocation,
        parentSectionId: `${turnId}:0`,
        context: [block(`${turnId}:1`, `${turnId}1-tool-4`)],
        nodes: [answer(`${turnId}1`, text)]
    });

const summary = (id: string, index: number): TurnSummary =>
    ({
        id,
        index,
        prompt: 'run the audit',
        status: 'done',
        state: 'done',
        threadId: 'th-instruct',
        threadLabel: 'IT1',
        updatedAt: T + 400_000,
        sectionCount: 2,
        stepCount: 0,
        activeAgents: ['instruct'],
        blocks: []
    }) as TurnSummary;

const viewOf = (documents: Record<string, TurnSection[]>, sessionId = 's1'): SessionView =>
    ({
        id: sessionId,
        harness: 'instruct',
        status: 'idle',
        model: 'm1',
        createdAt: 1,
        updatedAt: T + 400_000,
        turns: Object.keys(documents).map((id, index) => summary(id, index)),
        displays: Object.fromEntries(
            Object.entries(documents).map(([id, sections]) => [id, { turnId: id, sections }])
        )
    }) as unknown as SessionView;

// The two turns of the reported session, in recorded order.
const TWO_TURNS = (): Record<string, TurnSection[]> => ({
    t1: [root('t1'), weRun('t1', 'inv-we7-1', 'first run')],
    t2: [root('t2'), weRun('t2', 'inv-we7-2', 'reply run')]
});

// One turn holding BOTH runs of `th-rr1`: the first `delegate` run, and the `threadSend`
// reply-run with NO `parentSectionId` (../harness.ts spawns it without a parent). This is the
// in-tile exchange the tile itself builds (R7) and the row R8 presses.
const ONE_TURN_EXCHANGE = (): Record<string, TurnSection[]> => ({
    t1: [
        root('t1'),
        section({
            id: 't1:1',
            agent: 'research',
            agentLabel: 'RR1',
            threadId: 'th-rr1',
            invocationId: 'inv-rr1',
            parentSectionId: 't1:0',
            context: [block('t1:1', '1-tool-4')],
            nodes: [answer('1', 'first run')]
        }),
        section({
            id: 't1:2',
            agent: 'research',
            agentLabel: 'RR1',
            threadId: 'th-rr1',
            invocationId: 'inv-rr1-b',
            context: [block('t1:2', '2-tool-4')],
            nodes: [answer('2', 'reply run')]
        })
    ]
});

// The roster for the two-turn shape. `th-we7` claims BOTH runs — a resumed conversation publishes its
// earlier run in the historical `invocationIds` (`turns.ts:4893`, the uniqueness rule `rosterClaimOf`
// requires), so each tile elects a card for the SAME conversation exactly as the fixture above does.
// The second frame carries the server's soft-delete marker (`SessionThreadEntry.deleted`,
// ./threads.ts:131), the state `DELETE /sessions/:id/threads/:threadId` leaves, and the only writer of
// a card row's `hidden` (`turns.ts:5016`, consumed by `isConversationDeleted` at :2868).
const ROSTER_WE7 = (retired: boolean): SessionThreadEntry[] =>
    [
        {
            id: 'th-instruct',
            agent: 'instruct',
            origin: 'host',
            status: 'idle',
            sequence: 0,
            label: 'IT1',
            invocationId: 'inv-it1-t1'
        },
        {
            id: 'th-we7',
            agent: 'workspace',
            origin: 'host',
            status: 'idle',
            sequence: 7,
            label: 'WE7',
            invocationId: 'inv-we7-1',
            invocationIds: ['inv-we7-1', 'inv-we7-2'],
            ownerThreadId: 'th-instruct',
            ...(retired ? { deleted: true } : {})
        }
    ] as SessionThreadEntry[];

const mount = (sessionId = 's1'): TurnBoard => {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const board = createTurnBoard({ empty });
    board.bindSession(sessionId);
    document.body.replaceChildren(board.element);

    return board;
};

/** One authoritative document the way `main.ts` routes it: `reconcileView`, then flush. */
const render = (board: TurnBoard, view: SessionView): void => {
    for (const handle of board.reconcileView(view)) handle.flush();
};

const pending = new Map<string, unknown[]>();

// ---------------------------------------------------------------------------
// Readers.
//
// `readableCode` is the ONLY readability question in this file, and it is answered by the
// browser's own engine: `getComputedStyle(...).visibility`, which the injected shipped
// stylesheet drives. That is deliberate — a mirror of the selectors could keep passing after
// the rule stopped matching anything, which is how D2 reached a shipped build.
// ---------------------------------------------------------------------------

const readableCode = (node: HTMLElement | null | undefined): boolean => {
    if (node === null || node === undefined) return false;
    if (node.hidden) return false;

    // Inherited or inline withdrawal: an ancestor that hides its subtree hides this code too,
    // which is exactly what the reader experiences.
    return getComputedStyle(node).visibility !== 'hidden';
};

// Every conversation code a reader can read, in document order: the tile badge (`.tile-thread`,
// the turn's own conversation) and each row's header code (`.thread-name`). `.tile-agent` is
// deliberately absent — it carries the `hidden` attribute whenever a badge repeats it
// (turns.ts `syncRootAgentVisibility`), and ./turns-delegate-blocks.test.ts:394 reads the badge
// for the same reason.
const readableCodes = (board: TurnBoard): string[] =>
    [...board.element.querySelectorAll<HTMLElement>('.tile-thread, .thread-name')]
        .filter(readableCode)
        .map((node) => node.textContent ?? '')
        .filter((code) => code.length > 0);

// The row's own header code node, addressed through the row the way the stylesheet does it.
const nameOf = (row: Element): HTMLElement | null =>
    row.querySelector<HTMLElement>(':scope > .thread-tile > .thread-select > .thread-name');

const rowOf = (board: TurnBoard, sectionId: string): HTMLElement =>
    [...board.element.querySelectorAll<HTMLElement>('.thread-row')].find(
        (row) => row.dataset.threadId === sectionId
    ) as HTMLElement;

const rows = (board: TurnBoard): HTMLElement[] => [
    ...board.element.querySelectorAll<HTMLElement>('.thread-row')
];

// `readablePerConversation` (further down) asks the question through `getComputedStyle`, and that is
// right for every row on screen. It cannot see the OTHER way a row stops painting: the `hidden`
// attribute the server's delete verdict leaves (`turns.ts:5016` → `[hidden] { display: none }`,
// styles.css:124). A hidden row's code node still computes `visibility: visible`, so an element-level
// read reports a copy nobody can actually read. This reader is row-aware — rows that paint nothing are
// skipped, exactly as `./turns-compiled-conversation-cards.test.ts:351` filters `!row.hidden` for its
// `visibleNames` — and it is the reader the hidden-owner regression below needs.
const readableCardsOnScreen = (board: TurnBoard): Record<string, number> => {
    const counts: Record<string, number> = {};

    for (const row of rows(board)) {
        const conversation = row.dataset.threadCard;
        if (conversation === undefined || row.hidden) continue;

        counts[conversation] = (counts[conversation] ?? 0) + (readableCode(nameOf(row)) ? 1 : 0);
    }

    return counts;
};

// The projection of the rows this board shows: identity, markers, and the per-run detail R3
// says a merge may never cost.
const rowShape = (board: TurnBoard) =>
    rows(board).map((row) => ({
        section: row.dataset.threadId,
        card: row.dataset.threadCard,
        repeat: row.dataset.threadRepeat,
        exchange: row.dataset.threadExchange,
        persistent: row.dataset.persistentThread,
        code: nameOf(row)?.textContent,
        readable: readableCode(nameOf(row)),
        segments: [...row.querySelectorAll<HTMLElement>('.context-bar-segment')].map((n) => n.dataset.blockId),
        prose: [...(row.querySelectorAll<HTMLElement>('.agent-text') ?? [])]
            .map((node) => node.textContent?.trim())
            .join('|')
    }));

const press = (row: HTMLElement): void => {
    row.querySelector<HTMLElement>(':scope > .thread-tile > .thread-select')?.click();
};

const bodyDisplay = (row: HTMLElement): string => {
    const body = row.querySelector<HTMLElement>(':scope > .thread-tile > .thread-body');

    return body === null ? 'missing' : getComputedStyle(body).display;
};

// The stylesheet block for one selector, comments stripped so the rationale text beside a rule
// cannot satisfy a "this property is absent" assertion.
const rulesOf = (selector: string): string => {
    const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const found = [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter((match) => match[1].includes(selector))
        .map((match) => match[2]);

    expect(found.length, `no rule for ${selector}`).toBeGreaterThan(0);

    return found.join('\n');
};

beforeEach(() => {
    pending.clear();
    document.body.innerHTML = '';
});

afterEach(() => {
    document.body.innerHTML = '';
});

describe('R6 — one conversation code per session, across cards', () => {
    it('a conversation that ran in two turns prints its code once, board-wide', () => {
        const board = mount();
        render(board, viewOf(TWO_TURNS()));

        // The reported figure, measured: the session's reader sees the turn code `IT1` and the
        // conversation code `WE7`, each ONCE — even though two tiles list `IT1` and two cards
        // list `WE7`. The second tile's badge is already hidden by the conversation-grouping
        // rule (styles.css:3442, it is a continuation of the card above), and its CARD is now
        // hidden by the new session-wide rule.
        expect(readableCodes(board)).toEqual(['IT1', 'WE7']);

        // The projection that produces it: both tiles elected a card for `th-we7` (each owns one
        // RUN of it), and only the LATER one is the repeat — turn-array order decides, and
        // the marker is written on the row, not remembered in the board.
        expect(rowShape(board)).toEqual([
            {
                section: 't1:1',
                card: 'th-we7',
                repeat: undefined,
                exchange: undefined,
                persistent: 'th-we7',
                code: 'WE7',
                readable: true,
                segments: ['t11-tool-4'],
                prose: 'first run'
            },
            {
                section: 't2:1',
                card: 'th-we7',
                repeat: '',
                exchange: undefined,
                persistent: 'th-we7',
                code: 'WE7',
                readable: false,
                segments: ['t21-tool-4'],
                prose: 'reply run'
            }
        ]);

        // R3 held across the new rule: the marked row lost NOTHING but its visible code. It is
        // still the join for `th-we7`, it still owns its OWN run's strip and prose, and it is
        // still an ordinary row of its own tile — not an exchange of the other tile.
        const repeat = rowOf(board, 't2:1');
        expect(repeat.classList.contains('is-exchange')).toBe(false);
        expect(repeat.dataset.persistentThread).toBe('th-we7');
        expect(repeat.querySelector(':scope > .thread-tile > .thread-body > .context-bar-host')).not.toBeNull();
        // It is still a row of its OWN tile, not folded into the other tile: the merge was a
        // label decision, never a move of the run.
        expect(repeat.closest('.turn-row') !== rowOf(board, 't1:1').closest('.turn-row')).toBe(true);
    });

    it('gives the readable copy to the earliest turn, whichever door the tiles came in by', () => {
        // Tiles arrive in whatever order the stream delivers them, and the window may hold only
        // the later one first. Arrival order may never decide who owns the code: the LATER tile
        // alone is the only copy, so it reads its own code; when the EARLIER tile lands, the
        // readable copy moves to it: a snapshot frame rebuilds the board's turn ARRAY in the
        // document's recorded order, and THAT array — not arrival — defines "first".
        const board = mount();
        render(board, viewOf({ t2: TWO_TURNS().t2 }));

        expect(rowShape(board)).toEqual([
            {
                section: 't2:1',
                card: 'th-we7',
                repeat: undefined,
                exchange: undefined,
                persistent: 'th-we7',
                code: 'WE7',
                readable: true,
                segments: ['t21-tool-4'],
                prose: 'reply run'
            }
        ]);

        render(board, viewOf(TWO_TURNS()));

        expect(rows(board).map((row) => row.dataset.threadId)).toEqual(['t1:1', 't2:1']);
        expect(rowOf(board, 't1:1').dataset.threadRepeat).toBeUndefined();
        expect(rowOf(board, 't2:1').dataset.threadRepeat).toBe('');
        expect(readableCodes(board)).toEqual(['IT1', 'WE7']);
    });

    it('rebuilds the same figure from a fresh hydration', () => {
        // The reload door: every compiled tile is torn down (`resetCompiled`) and the board
        // re-derives from the document alone. A remembered owner would either hide BOTH copies
        // (the remembered tile was destroyed) or none, and either way the figure would drift
        // from the live path the reader already saw.
        const board = mount();
        board.clear();

        for (const handle of board.hydrateView(viewOf(TWO_TURNS()))) handle.flush();

        const rebuilt = rowShape(board);

        expect(rebuilt.map((row) => ({ code: row.code, readable: row.readable, repeat: row.repeat }))).toEqual([
            { code: 'WE7', readable: true, repeat: undefined },
            { code: 'WE7', readable: false, repeat: '' }
        ]);
        expect(rebuilt.map((row) => row.segments)).toEqual([['t11-tool-4'], ['t21-tool-4']]);
        expect(readableCodes(board)).toEqual(['IT1', 'WE7']);
    });

    it('gives the code back when the card that owned it is removed', () => {
        // The promotion door. The owner's row is deleted by a `section:remove` frame
        // (turns.ts:9484), and the pass runs again for the ops frame — if the mark were
        // remembered or only recomputed on a full projection, the surviving card would stay
        // silently nameless with nothing above it.
        const board = mount();
        const view = viewOf(TWO_TURNS());
        render(board, view);

        expect(rowOf(board, 't2:1').dataset.threadRepeat).toBe('');

        const ops = [{ op: 'section:remove', turnId: 't1', sectionId: 't1:1' }] as unknown as TurnDisplayOp[];
        applyOpsToDisplay(view, 't1', ops, pending as never);

        expect(board.applyViewOps('t1', ops, view)).toBe(true);

        // One row left in the session, and it reads its own code again: no stale marker.
        expect(rows(board).map((row) => row.dataset.threadId)).toEqual(['t2:1']);
        expect(rowOf(board, 't2:1').dataset.threadCard).toBe('th-we7');
        expect(rowOf(board, 't2:1').hasAttribute('data-thread-repeat')).toBe(false);
        expect(readableCode(nameOf(rowOf(board, 't2:1')))).toBe(true);
        expect(rowShape(board)).toEqual([
            {
                section: 't2:1',
                card: 'th-we7',
                repeat: undefined,
                exchange: undefined,
                persistent: 'th-we7',
                code: 'WE7',
                readable: true,
                segments: ['t21-tool-4'],
                prose: 'reply run'
            }
        ]);
    });

    it('a card the server deleted never spends the code, so a visible card is never left at zero', () => {
        // THE ONLY LINE BETWEEN "READABLE" AND "NOTHING AT ALL". The pass tests `row.hidden` at
        // turns.ts:3372, BEFORE both `shown.has(conversation)` and `shown.add(conversation)`, because a
        // row the delete verdict hid (:5016) still wears its `data-thread-card` stamp and paints
        // nothing. Move that guard below the `shown` bookkeeping and the hidden earliest card still
        // SPENDS the conversation's code, the visible later card is then marked as its own repeat, and
        // the conversation reads ZERO codes on screen — the half of the figure no other test here can
        // see. Confirmed by mutation on a scratch copy of the pass (Temp/coding/mut), not by reading:
        // the assertions below fail there and pass against the shipped order.
        const board = mount();

        render(board, viewOf(TWO_TURNS()));

        // The figure the rest of this file pins, before anything is retired.
        expect(readableCodes(board)).toEqual(['IT1', 'WE7']);
        expect(rowOf(board, 't2:1').dataset.threadRepeat).toBe('');

        // The roster lands, then the server's soft-delete verdict lands with it. ONE frame draws the
        // verdict for EVERY row of `th-we7`, so both cards hide together (`hidden` + `data-deleted`) —
        // and a hidden row may not WEAR the mark either. That is the first half of the guard a moved
        // `if` breaks: the mutated pass stamps the hidden later card as the repeat.
        board.setThreads(ROSTER_WE7(false));
        expect(readableCardsOnScreen(board)).toEqual({ 'th-we7': 1 });

        board.setThreads(ROSTER_WE7(true));

        const owner = rowOf(board, 't1:1');
        const later = rowOf(board, 't2:1');

        expect(owner.dataset.deleted).toBe('true');
        expect(owner.hidden).toBe(true);
        expect(later.hidden).toBe(true);
        expect(board.element.querySelectorAll('.thread-row[data-thread-repeat]')).toHaveLength(0);

        // THE PAIR THE GUARD EXISTS FOR. The verdict is enforced tile by tile, by each tile's own
        // `paintPersistentMarkers` (:4972), and the compiled ops plane can address the reply run's
        // section while the verdict still stands — the verdict's own comment (:5002) names that door,
        // a re-minted row is created visible. So the board does hold a hidden earliest card beside a
        // visible later card of the same conversation. Re-deriving the rule through an ops frame
        // ADDRESSED TO THE OTHER TILE re-runs the pass for the whole board (`applyViewOps` :11234 →
        // :11257) while only the addressed tile repaints its markers — which is what lets this state
        // stand long enough to be measured.
        later.hidden = false;

        expect(board.applyViewOps('t1', [], undefined)).toBe(true);

        // THE FIGURE: exactly ONE readable copy of `WE7`, and it is the row the reader can see. The
        // answer is the shipped stylesheet's (`getComputedStyle(...).visibility`), not this file's.
        expect(readableCardsOnScreen(board)).toEqual({ 'th-we7': 1 });
        expect(getComputedStyle(nameOf(later) as HTMLElement).visibility).toBe('visible');
        expect(later.hasAttribute('data-thread-repeat')).toBe(false);
        // The hidden card keeps its election, so it owns the code again the moment it is painted, and
        // it wears no mark while it is not painted at all.
        expect(owner.dataset.threadCard).toBe('th-we7');
        expect(owner.hasAttribute('data-thread-repeat')).toBe(false);
        // Nothing else was traded for the figure (R3): every row still owns its own run's strip, prose,
        // persistent join and card election — the delete only ever withdraws a rendering.
        expect(
            rowShape(board).map((row) => ({
                section: row.section,
                card: row.card,
                repeat: row.repeat,
                persistent: row.persistent,
                segments: row.segments,
                prose: row.prose
            }))
        ).toEqual([
            {
                section: 't1:1',
                card: 'th-we7',
                repeat: undefined,
                persistent: 'th-we7',
                segments: ['t11-tool-4'],
                prose: 'first run'
            },
            {
                section: 't2:1',
                card: 'th-we7',
                repeat: undefined,
                persistent: 'th-we7',
                segments: ['t21-tool-4'],
                prose: 'reply run'
            }
        ]);

        // And the pair is transient BY CONSTRUCTION: deriving through a frame addressed to `t2` repaints
        // THAT tile's markers, so the verdict lands on its row again — the conversation is then entirely
        // off screen (zero readable copies of a conversation with no card on screen, which is what a
        // delete asks for) and still carries no mark, so nothing is stranded when it comes back.
        expect(board.applyViewOps('t2', [], undefined)).toBe(true);
        expect(later.hidden).toBe(true);
        expect(readableCardsOnScreen(board)).toEqual({});
        expect(board.element.querySelectorAll('.thread-row[data-thread-repeat]')).toHaveLength(0);
    });

    it('carries no owner across a session switch', () => {
        // A remembered owner would be keyed by the conversation, and a different session may
        // legitimately run the SAME conversation ids — the first card of the new session would
        // come up nameless. Re-binding and re-rendering from the document reproduces the same
        // figures as the live path.
        const board = mount();
        render(board, viewOf(TWO_TURNS(), 's1'));
        board.bindSession('s2');
        board.clear();
        render(board, viewOf(TWO_TURNS(), 's2'));

        expect(rowOf(board, 't1:1').dataset.threadRepeat).toBeUndefined();
        expect(readableCode(nameOf(rowOf(board, 't1:1')))).toBe(true);
        expect(rowOf(board, 't2:1').dataset.threadRepeat).toBe('');
        expect(readableCodes(board)).toEqual(['IT1', 'WE7']);
    });

    it('leaves a rows-only tile out of the rule entirely', () => {
        // An optimistic / rows-only tile has no compiled tree, so `syncCompiledConversationCards`
        // never runs for it and it publishes no `data-thread-card`. The board pass reads markers
        // only, so such a tile can neither claim a code (hiding the compiled card that owns it)
        // nor be hidden itself (losing the only copy on screen).
        //
        // The raw fold's own door: a record of events, no view at all (the shape
        // ./turns-compiled-run-epoch.test.ts:259 hydrates, and `rowsOnlyRecord()` above). The
        // delegated run becomes a nested row exactly as on the compiled plane — and stays outside
        // this rule.
        const board = mount();
        board.hydrate([rowsOnlyRecord()]);

        // The raw fold's own row, on a tile that is NOT compiled: no card election, no mark, and
        // its code stays readable.
        expect(board.turns().map((turn) => turn.compiled())).toEqual([false]);
        expect(board.element.querySelectorAll('.thread-row[data-thread-card]')).toHaveLength(0);
        expect(board.element.querySelectorAll('.thread-row[data-thread-repeat]')).toHaveLength(0);
        expect(rows(board).map((row) => row.dataset.threadId)).toEqual(['inv-16']);
        expect(readableCode(nameOf(rowOf(board, 'inv-16')))).toBe(true);
    });

    it('takes no part for a tile the document gives no tree', () => {
        // The optimistic shape on the COMPILED plane: the view names a second turn whose
        // `displays` entry is an empty tree, so it publishes no card. Nothing may be hidden for
        // a card that does not exist, so the first tile keeps its code and nothing is marked.
        const board = mount();
        render(board, viewOf({ t1: TWO_TURNS().t1, t2: [] }));

        expect(board.turns()).toHaveLength(2);
        expect(rows(board).map((row) => row.dataset.threadId)).toEqual(['t1:1']);
        expect([...board.element.querySelectorAll('.thread-row[data-thread-card]')].map(
            (row) => row.dataset.threadId
        )).toEqual(['t1:1']);
        expect(board.element.querySelectorAll('.thread-row[data-thread-repeat]')).toHaveLength(0);
        expect(readableCode(nameOf(rowOf(board, 't1:1')))).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// R6b — a card NESTED inside another conversation's card keeps its own code.
//
// A resumed or continued CHILD conversation is a turn of its OWN thread, and `placeTurn` routes
// that turn's row INSIDE the child's own card (`childExchangeHost`), so every row of the nested
// turn is a DESCENDANT of an EARLIER tile. That placement broke the session-wide rule in two
// ways at once, both measured through the shipped stylesheet below:
//
//   * the pass asked each compiled turn for the cards in its own subtree, so a nested card was
//     VISITED TWICE in one invocation — once through the host tile's subtree, once through its
//     own turn — and the second visit marked it: the conversation ended with ZERO readable codes;
//   * the ranking was subtree/DOM order, so a nested row could claim the code ahead of the
//     recorded-earlier card, and could even be its own earlier copy.
//
// `syncCompiledThreadRepeats` (turns.ts:3307) now reads the board ONCE, attributes every card to
// its nearest `.turn-row` ancestor, and ranks by the owning turn's index in the board's turn
// ARRAY (recorded order on a snapshot frame), then by in-tile order. The earliest rank is the one
// row that can never carry the mark.
// ---------------------------------------------------------------------------

// A `user` context block — the prompt half of a resumed turn's own flow.
const prose = (sectionId: string, id: string, chars: number): ContextBlock =>
    ({
        ...block(sectionId, id),
        kind: 'user',
        name: 'prompt',
        chars,
        argsChars: undefined,
        resultChars: undefined,
        state: undefined,
        eventFrom: undefined,
        eventTo: undefined,
        endedAt: undefined
    }) as ContextBlock;

// The turn's OWN flow when the turn belongs to the CHILD conversation `th-we7` (the server
// records a resumed child as a turn of that child's thread, labelled `WE7`).
const weRoot = (turnId: string): TurnSection =>
    section({
        id: `${turnId}:0`,
        rank: 'A',
        agent: 'workspace',
        agentLabel: 'WE7',
        threadId: 'th-we7',
        invocationId: 'inv-we7-2',
        threadLabel: 'WE7',
        context: [prose(`${turnId}:0`, `${turnId}0-user-prompt`, 30), block(`${turnId}:0`, `${turnId}0-tool-7`)],
        nodes: [answer(`${turnId}0`, 'we7 continuation turn prose')]
    });

// A run of `th-rr1` delegated by the flow `parentSectionId` names.
const rrRun = (sectionId: string, invocation: string, parentSectionId: string, text: string): TurnSection =>
    section({
        id: sectionId,
        agent: 'research',
        agentLabel: 'RR1',
        threadId: 'th-rr1',
        invocationId: invocation,
        parentSectionId,
        context: [block(sectionId, `${sectionId.replace(':', '')}-tool-4`)],
        nodes: [answer(sectionId.replace(':', ''), text)]
    });

// A turn summary that names the conversation the TURN belongs to — the figure that makes
// `placeTurn` route it into that conversation's card instead of beside the owner's tile.
const turnSummary = (id: string, index: number, threadId?: string, threadLabel?: string): TurnSummary =>
    ({
        ...summary(id, index),
        ...(threadId === undefined ? {} : { threadId, threadLabel })
    }) as TurnSummary;

const viewOfTurns = (turns: TurnSummary[], documents: Record<string, TurnSection[]>, sessionId = 's1'): SessionView =>
    ({
        id: sessionId,
        harness: 'instruct',
        status: 'idle',
        model: 'm1',
        createdAt: 1,
        updatedAt: T + 400_000,
        turns,
        displays: Object.fromEntries(
            Object.entries(documents).map(([id, sections]) => [id, { turnId: id, sections }])
        )
    }) as unknown as SessionView;

// The nested turn, in recorded order: `t1` (the root conversation's audit turn) then `t2`
// (a continuation of the CHILD `th-we7`, delegated from `t1` as `inv-we7-1`).
const NESTED_TURNS: TurnSummary[] = [turnSummary('t1', 0), turnSummary('t2', 1, 'th-we7', 'WE7')];

const nestedDocuments = (withOuterCard: boolean): Record<string, TurnSection[]> => ({
    t1: [
        root('t1'),
        weRun('t1', 'inv-we7-1', 'we7 first run'),
        // The SAME conversation `th-rr1` also ran directly under the root turn. Recorded order
        // puts it BEFORE the nested tile's copy; document order puts it AFTER (the nested rows
        // live inside `t1:1`, which precedes `t1:2`).
        ...(withOuterCard ? [rrRun('t1:2', 'inv-rr1-0', 't1:0', 'rr1 delegated by the root turn')] : [])
    ],
    t2: [weRoot('t2'), rrRun('t2:1', 'inv-rr1-1', 't2:0', 'rr1 delegated from the continuation turn')]
});

// The roster that joins both conversations to their persistent ids: `inv-we7-2` is the resumed
// run, and `th-rr1` belongs to `th-we7`.
const NESTED_ROSTER: SessionThreadEntry[] = [
    {
        id: 'th-instruct',
        agent: 'instruct',
        origin: 'host',
        status: 'idle',
        sequence: 0,
        label: 'IT1',
        invocationId: 'inv-it1-t1'
    },
    {
        id: 'th-we7',
        agent: 'workspace',
        origin: 'host',
        status: 'idle',
        sequence: 7,
        label: 'WE7',
        invocationId: 'inv-we7-2',
        ownerThreadId: 'th-instruct'
    },
    {
        id: 'th-rr1',
        agent: 'research',
        origin: 'host',
        status: 'idle',
        sequence: 8,
        label: 'RR1',
        invocationId: 'inv-rr1-1',
        ownerThreadId: 'th-we7'
    }
] as SessionThreadEntry[];

/** The nested session, rendered the way `main.ts` routes it, roster last (as the stream brings it). */
const renderNested = (withOuterCard: boolean, board: TurnBoard = mount()): TurnBoard => {
    render(board, viewOfTurns(NESTED_TURNS, nestedDocuments(withOuterCard)));
    board.setThreads(NESTED_ROSTER);

    return board;
};

/**
 * The rule the user stated, as a measurement: EVERY conversation that owns a card on screen has
 * exactly ONE readable copy of its code. Two is the reported defect; ZERO is the other failure,
 * and it is the one a subtree-scoped pass produces for a nested card.
 */
const readablePerConversation = (board: TurnBoard): Record<string, number> => {
    const counts: Record<string, number> = {};

    for (const row of rows(board)) {
        const conversation = row.dataset.threadCard;
        if (conversation === undefined) continue;

        counts[conversation] = (counts[conversation] ?? 0) + (readableCode(nameOf(row)) ? 1 : 0);
    }

    return counts;
};

const turnRowOf = (row: Element): HTMLElement => row.closest('.turn-row') as HTMLElement;

// The strip and the prose a row owns BY ITSELF. `rowShape` reads whole subtrees, which is right
// for the flat shapes and wrong for a nested card — the nested turn's run lives INSIDE the card,
// so a subtree read would report the card as owning the nested run's blocks.
const ownStrip = (row: HTMLElement): (string | undefined)[] =>
    [...row.querySelectorAll<HTMLElement>(':scope > .thread-tile > .thread-body > .context-bar-host .context-bar-segment')].map(
        (node) => node.dataset.blockId
    );

const ownProse = (row: HTMLElement): string =>
    [...row.querySelectorAll<HTMLElement>(':scope > .thread-tile > .thread-body > .thread-flow > .agent .agent-text')]
        .map((node) => node.textContent?.trim())
        .join('|');

// A tile the COMPILED plane never paints: events, no display tree (the shape
// ./turns-compiled-run-epoch.test.ts:259 hydrates). The raw fold still mints one `.thread-row`
// per delegated invocation, but no tile pass runs, so NO row publishes `data-thread-card` — the
// only board state in which `syncCompiledThreadRepeats` takes its early return.
//
// The value is a TURN row (`SessionTurn`, src/server/protocol.ts:135) — `id`/`index`/`prompt`/
// `status`/`events` — not a `SessionRecord` (which is `Session`, the session envelope;
// src/server/sessions.ts:958). `TurnBoard.hydrate` takes `readonly SessionTurn[]`
// (./turns.ts:758), so the turn type is the one this fixture has to satisfy.
const rowsOnlyRecord = (): SessionTurn => {
    const host = { id: 'inv-13', input: 'p' };
    const child = { id: 'inv-16', parentId: 'inv-13', callId: 'call-1', kind: 'delegation', input: 'task' };
    const withThread = (event: Record<string, unknown>, thread: Record<string, unknown>): HarnessEvent =>
        ({ ...event, thread }) as unknown as HarnessEvent;
    const doneOf = (agent: string, model: string, thread: Record<string, unknown>): HarnessEvent =>
        withThread(
            {
                type: 'done',
                agent,
                message: {
                    role: 'assistant',
                    content: 'answer',
                    reasoning: '',
                    toolCalls: [],
                    model,
                    stopReason: 'stop'
                }
            },
            thread
        );
    const events: HarnessEvent[] = [
        withThread({ type: 'start', agent: 'one', model: 'm' }, host),
        withThread({ type: 'text', agent: 'one', delta: 'planning' }, host),
        withThread({ type: 'start', agent: 'Workspace', model: 'w' }, child),
        withThread({ type: 'text', agent: 'Workspace', delta: 'lane' }, child),
        doneOf('Workspace', 'w', child),
        doneOf('one', 'm', host)
    ];

    return {
        id: 'r1',
        index: 0,
        prompt: 'p',
        status: 'done',
        startedAt: T,
        updatedAt: T + 100,
        threadId: 'th-we7',
        threadLabel: 'WE7',
        events,
        eventTimes: events.map((_event, index) => T + index * 10)
    } as unknown as SessionTurn;
};

describe('R6b — a card nested inside another conversation\u2019s card', () => {
    it('keeps the nested card\u2019s own readable code', () => {
        const board = renderNested(false);

        // PRECONDITION, asserted first: this really is the nested shape, not two sibling tiles.
        // `t2` has its own `.turn-row` (it is a turn of `th-we7`), and that row sits inside the
        // `th-we7` CARD that `t1` painted — so the card `t2` delegates is a descendant of `t1`.
        const card = rowOf(board, 't1:1');
        const nested = rowOf(board, 't2:1');
        expect(turnRowOf(card)).not.toBe(turnRowOf(nested));
        expect(card.contains(turnRowOf(nested))).toBe(true);
        expect(turnRowOf(nested).dataset.threadExchange).toBe('th-we7');
        // Both conversations elected a card (each owns a run of its own).
        expect([card.dataset.threadCard, nested.dataset.threadCard]).toEqual(['th-we7', 'th-rr1']);

        // THE FIGURE: three conversations on screen, three codes, each readable EXACTLY ONCE.
        // Before the fix `RR1` was readable ZERO times — the nested card was marked by its own
        // second visit, and nothing else on the board showed `th-rr1`.
        expect(readableCodes(board)).toEqual(['IT1', 'WE7', 'RR1']);
        expect(readablePerConversation(board)).toEqual({ 'th-we7': 1, 'th-rr1': 1 });
        expect(nested.hasAttribute('data-thread-repeat')).toBe(false);
        expect(card.hasAttribute('data-thread-repeat')).toBe(false);
        expect(readableCode(nameOf(nested))).toBe(true);

        // The nested placement cost nothing else (R3): each row still owns ITS OWN strip and
        // prose. The scoping matters here — a subtree query would fold the nested turn's run into
        // the card that contains it, which is exactly the containment this shape relies on.
        expect([ownStrip(card), ownStrip(nested)]).toEqual([['t11-tool-4'], ['t21-tool-4']]);
        expect([ownProse(card), ownProse(nested)]).toEqual(['we7 first run', 'rr1 delegated from the continuation turn']);
        // The nested run is still addressable by its own section id, inside the card.
        expect(rows(board).map((row) => row.dataset.threadId)).toEqual(['t1:1', 't2:1']);
    });

    it('gives the code to the RECORDED-earliest card when the outer tile also owns one', () => {
        const board = renderNested(true);

        // The trap, pinned: DOCUMENT order puts the nested copy first (`t2:1` lives inside
        // `t1:1`), while RECORDED order puts `t1:2` first. Ranking by the subtree picked the
        // nested row, marked `t1:2` as "the repeat", and then marked `t2:1` on its second visit —
        // so `th-rr1` printed nothing at all.
        expect(rows(board).map((row) => row.dataset.threadId)).toEqual(['t1:1', 't2:1', 't1:2']);

        const outer = rowOf(board, 't1:2');
        const nested = rowOf(board, 't2:1');

        // The recorded-earliest card is the readable one, and it is never the marked one.
        expect(outer.dataset.threadCard).toBe('th-rr1');
        expect(outer.hasAttribute('data-thread-repeat')).toBe(false);
        expect(readableCode(nameOf(outer))).toBe(true);
        // The nested copy is an ordinary marked repeat: hidden code, everything else kept.
        expect(nested.dataset.threadCard).toBe('th-rr1');
        expect(nested.dataset.threadRepeat).toBe('');
        expect(readableCode(nameOf(nested))).toBe(false);
        expect(getComputedStyle(nameOf(nested) as HTMLElement).visibility).toBe('hidden');
        expect(nested.dataset.persistentThread).toBe('th-rr1');
        expect(nested.classList.contains('is-exchange')).toBe(false);

        expect(readableCodes(board)).toEqual(['IT1', 'WE7', 'RR1']);
        expect(readablePerConversation(board)).toEqual({ 'th-we7': 1, 'th-rr1': 1 });
    });

    it('moves the readable copy to the earlier tile when the nested one arrives first', () => {
        // The arrival door, combined with the nesting: the window can hold only the later
        // (nested) tile at first, and it is then the ONLY copy of `th-rr1` on screen — so it has
        // to read its own code. When the earlier tile lands, the readable copy moves to `t1:2`,
        // and the nested row becomes the marked repeat. Neither moment may show `RR1` twice or
        // not at all.
        const board = mount();
        render(board, viewOfTurns([turnSummary('t2', 1, 'th-we7', 'WE7')], { t2: nestedDocuments(true).t2 }));
        board.setThreads(NESTED_ROSTER);

        expect(rows(board).map((row) => row.dataset.threadId)).toEqual(['t2:1']);
        expect(readablePerConversation(board)).toEqual({ 'th-rr1': 1 });

        render(board, viewOfTurns(NESTED_TURNS, nestedDocuments(true)));
        board.setThreads(NESTED_ROSTER);

        expect(rows(board).map((row) => row.dataset.threadId)).toEqual(['t1:1', 't2:1', 't1:2']);
        expect(rowOf(board, 't1:2').hasAttribute('data-thread-repeat')).toBe(false);
        expect(rowOf(board, 't2:1').dataset.threadRepeat).toBe('');
        expect(readableCodes(board)).toEqual(['IT1', 'WE7', 'RR1']);
        expect(readablePerConversation(board)).toEqual({ 'th-we7': 1, 'th-rr1': 1 });
    });

    it('takes one board-level card query per invocation, and none per tile', () => {
        // The cost half of the contract (the pass used to pay one scoped query per compiled
        // tile, which is also what visited a nested card twice). Counted, not asserted by
        // reading the source: `Element.prototype.querySelectorAll` is wrapped for the duration
        // of one ops frame — the only public entry that re-derives the rule on a warm board.
        const board = renderNested(true);
        const boardElement = board.element;

        const seen: string[] = [];
        const proto = Element.prototype as unknown as {
            querySelectorAll: (this: Element, selectors: string) => NodeListOf<Element>;
        };
        const native = proto.querySelectorAll;
        proto.querySelectorAll = function counted(selectors: string): NodeListOf<Element> {
            if (this === boardElement) seen.push(selectors);

            return native.call(this, selectors);
        };

        try {
            expect(board.applyViewOps('t1', [], viewOfTurns(NESTED_TURNS, nestedDocuments(true)))).toBe(true);
        } finally {
            proto.querySelectorAll = native;
        }

        // ONE full-board query for the whole pass, with the per-tile subtree query gone.
        expect(seen.filter((selector) => selector === '.thread-row[data-thread-card], .thread-row[data-thread-repeat]')).toHaveLength(1);
        expect(seen.filter((selector) => selector === '.thread-row[data-thread-card]')).toHaveLength(0);
        // The frame still derived the same figure, so the count is not from a pass that bailed.
        expect(readablePerConversation(board)).toEqual({ 'th-we7': 1, 'th-rr1': 1 });
    });

    it('clears every mark and stops when the board owns no card at all', () => {
        // The early return, and the ORDER inside it. A rows-only tile has no compiled tree, so it
        // publishes no card — but a mark a previous paint left behind still has to go, or a card
        // that fell back to rows would stay nameless forever. The stale mark is therefore stamped
        // by hand and the pass is run through an ops frame, the only entry that re-derives the
        // rule on a warm board.
        const board = mount();
        board.hydrate([rowsOnlyRecord()]);

        const cardless = rows(board);
        expect(board.turns().map((turn) => turn.compiled())).toEqual([false]);
        expect(board.element.querySelectorAll('.thread-row[data-thread-card]')).toHaveLength(0);
        expect(cardless.map((row) => row.dataset.threadId)).toEqual(['inv-16']);

        // A mark a paint that has since fallen back to rows-only left behind, and the row the
        // stylesheet is hiding because of it.
        cardless[0].dataset.threadRepeat = '';
        expect(readableCode(nameOf(cardless[0]))).toBe(false);

        expect(board.applyViewOps('r1', [], undefined)).toBe(true);

        // Cleared, even though the pass bailed out before ranking anything: no card on the board
        // means nothing to rank, and no row may keep a mark it does not earn.
        expect(board.element.querySelectorAll('.thread-row[data-thread-repeat]')).toHaveLength(0);
        expect(readableCode(nameOf(cardless[0]))).toBe(true);
    });
});

describe('R7 / D2 — the withdrawal reserves the code\u2019s slot', () => {
    it('hides a repeated code without moving the preview out of column', () => {
        // TWO TURNS: the cross-tile repeat.
        const board = mount();
        render(board, viewOf(TWO_TURNS()));

        const owner = rowOf(board, 't1:1');
        const repeat = rowOf(board, 't2:1');

        // The unreadable/readable pair, measured through the shipped stylesheet.
        expect(readableCode(nameOf(owner))).toBe(true);
        expect(readableCode(nameOf(repeat))).toBe(false);

        // D2 exactly: the device is `visibility`, never `display`. `display` stays `inline`, so
        // the identity half of `.thread-select` keeps the width its text would occupy, and
        // `.thread-preview` — the flexible item — starts at the SAME x as its neighbour's.
        expect(nameOf(repeat) === null ? 'missing' : getComputedStyle(nameOf(repeat) as HTMLElement).display).toBe(
            'inline'
        );
        expect(getComputedStyle(nameOf(repeat) as HTMLElement).visibility).toBe('hidden');
        expect(nameOf(repeat)?.hidden).toBe(false);
        // The column itself: identical computed display on both rows' preview, and it is NOT
        // `none` (that is the collapse that shifted the text left).
        expect(getComputedStyle(repeat.querySelector('.thread-preview') as Element).display).toBe(
            getComputedStyle(owner.querySelector('.thread-preview') as Element).display
        );
        expect(getComputedStyle(repeat.querySelector('.thread-preview') as Element).display).toBe('block');
        // Nothing else about the header changed: same children, same order.
        const selectChildren = (row: Element): string[] => [
            ...row.querySelectorAll<HTMLElement>(':scope > .thread-tile > .thread-select > *')
        ].map((node) => node.className);

        expect(selectChildren(repeat)).toEqual(selectChildren(owner));
        expect(selectChildren(repeat)).toEqual(['thread-name', 'thread-preview', 'thread-top']);

        // ONE TURN, in-tile exchange: the same treatment for the figure that used to use the
        // `hidden` attribute (the defect D2 reported).
        const inTile = mount();
        render(inTile, viewOf(ONE_TURN_EXCHANGE()));

        const card = rowOf(inTile, 't1:1');
        const exchange = rowOf(inTile, 't1:2');

        expect(exchange.classList.contains('is-exchange')).toBe(true);
        expect(exchange.dataset.threadExchange).toBe('th-rr1');
        expect(readableCodes(inTile)).toEqual(['IT1', 'RR1']);
        expect(nameOf(exchange)?.hidden).toBe(false);
        expect(getComputedStyle(nameOf(exchange) as HTMLElement).visibility).toBe('hidden');
        expect(getComputedStyle(nameOf(exchange) as HTMLElement).display).toBe('inline');
        expect(getComputedStyle(exchange.querySelector('.thread-preview') as Element).display).toBe(
            getComputedStyle(card.querySelector('.thread-preview') as Element).display
        );
    });

    it('withdraws both figures by visibility, and never by display', () => {
        // The source-level half of the same contract, so a future edit cannot swap the device
        // back to `display: none` (which is what `[hidden]` did, styles.css:124) while the
        // computed-style assertions above still read `visibility: hidden` from a copy.
        for (const marker of ['[data-thread-repeat]', '[data-thread-exchange]']) {
            const rule = rulesOf(`.thread-row${marker} > .thread-tile > .thread-select > .thread-name`);

            expect(rule).toContain('visibility: hidden');
            expect(rule).not.toContain('display');
        }
    });
});

describe('R8 — an exchange header steers its own run', () => {
    it('opens the pressed exchange body inline, and moves neither focus nor route', () => {
        const board = mount();
        render(board, viewOf(ONE_TURN_EXCHANGE()));

        const card = rowOf(board, 't1:1');
        const exchange = rowOf(board, 't1:2');

        // The state a reader starts in: both collapsed, the board focused on the session's root
        // conversation (the newest surface), and the exchange's body hidden by
        // `.thread-row:not(.is-expanded) .thread-body` (styles.css:4133).
        const focusBefore = board.focusedThread();
        expect(focusBefore).toBe('th-instruct');
        expect(exchange.classList.contains('is-expanded')).toBe(false);
        expect(bodyDisplay(exchange)).toBe('none');

        press(exchange);

        // The press opened THIS run and nothing else: the row is expanded, its body is laid out,
        // the card above is untouched, and no focus moved — an exchange is a run of the
        // conversation the card above already represents, so `focusThread` would open the CARD
        // and leave the pressed row closed, which reads as a dead control (turns.ts:5701-5710).
        expect(exchange.classList.contains('is-expanded')).toBe(true);
        expect(bodyDisplay(exchange)).toBe('flex');
        expect(card.classList.contains('is-expanded')).toBe(false);
        expect(bodyDisplay(card)).toBe('none');
        expect(board.focusedThread()).toBe(focusBefore);
        expect(document.querySelector('.dialog')).toBeNull();
        // The repeated code stays withdrawn while the body is open: expanding a run does not
        // re-print an identity the card above already prints, and the slot stays reserved.
        expect(readableCode(nameOf(exchange))).toBe(false);
        expect(exchange.dataset.threadExchange).toBe('th-rr1');
        expect(exchange.hasAttribute('data-thread-card')).toBe(false);

        // The second press is the way back (T7's two-way control), still without moving focus.
        press(exchange);

        expect(exchange.classList.contains('is-expanded')).toBe(false);
        expect(bodyDisplay(exchange)).toBe('none');
        expect(board.focusedThread()).toBe(focusBefore);
    });

    it('still lets the cross-tile repeat steer its conversation', () => {
        // The other kind of repeated code: a card in its OWN tile. R6 took its visible label,
        // not its steering — the row is still the join for `th-we7`, so pressing it routes
        // through `focusThread` (turns.ts:5721) and opens that conversation's card, which is the
        // surface the reader asked for. A suppressed label must not cost the reader the route.
        const board = mount();
        render(board, viewOf(TWO_TURNS()));

        const owner = rowOf(board, 't1:1');
        const repeat = rowOf(board, 't2:1');

        expect(board.focusedThread()).toBe('th-instruct');
        expect(bodyDisplay(repeat)).toBe('none');

        press(repeat);

        // Focus moved to the conversation, and the card that answers it is the one now open.
        expect(board.focusedThread()).toBe('th-we7');
        expect(bodyDisplay(owner)).toBe('flex');
        expect(bodyDisplay(repeat)).toBe('none');
        // The marks did not move: steering never re-elects the card, and the repeat keeps its
        // own join, strip and prose either way.
        expect(repeat.dataset.threadRepeat).toBe('');
        expect(repeat.dataset.persistentThread).toBe('th-we7');

        // Pressing the open card again unfocuses it, the same deliberate unfocus the tile header
        // performs, so the composer never keeps targeting a conversation the reader just closed.
        press(owner);

        expect(board.focusedThread()).toBeUndefined();
        expect(bodyDisplay(owner)).toBe('none');
    });
});

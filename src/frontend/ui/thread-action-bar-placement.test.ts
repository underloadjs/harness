// R2 — ONE action bar per conversation, anchored at the TOP of that conversation.
//
// The user report this pins: "[Stop] and [Transcript] button are floating all over place
// depending on which entry I click on the IT15 and any of the user prompts. The [Stop] and
// [Transcript] here is for the entire IT15, so it shouldn't matter which part I click, it
// should be at the top."
//
// The bar belongs to the conversation, so it hangs off the header of the conversation
// SURFACE's first exchange (the head prompt that carries the thread badge) and stays there
// while any other entry of the same conversation is pressed — see ui/turns.ts
// `showsThreadActionBar` / `coveredByExpandedSurface`. What this file proves:
//
//   (a) an expanded conversation shows EXACTLY one visible bar, in the head exchange,
//       after its header and before every entry body, and pressing the head, a steering
//       prompt or the footer of another exchange never moves or re-targets it;
//   (b) the bar acts on the CONVERSATION's thread id, not on the pressed entry's;
//   (c) a collapsed conversation shows none;
//   (d) a delegated card adds no second bar, and a continuation routed inside that card
//       adds none either — the card's own bar is the one for that conversation;
//   (e) when the CHILD conversation is the focused surface, the child card's bar is the
//       only visible one and it targets the child.
//
//   (f) a PLACEMENT change carries the open conversation with the row: when a snapshot gives
//       the expanded turn a different conversation (or none), the card the row left loses its
//       open look and the bars repaint even though no card changed its head — see the last
//       block, and ui/turns.ts `placeTurn` (F4/F5).
//
// Run: yarn vitest run --config src/frontend/vitest.config.ts ui/thread-action-bar-placement.test.ts

import type { HarnessEvent, SessionTurn } from '../../server/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTurnBoard } from './turns';
import type { SessionThreadEntry } from './threads';

const threadEntry = (overrides: Partial<SessionThreadEntry> & { id: string }): SessionThreadEntry => ({
    agent: 'writer',
    origin: 'host',
    status: 'running',
    sequence: 1,
    ...overrides
});

const turnRecord = (options: {
    id: string;
    index: number;
    prompt?: string;
    status?: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
    threadId?: string;
    events?: unknown[];
}): SessionTurn =>
    ({
        id: options.id,
        index: options.index,
        prompt: options.prompt ?? 'tasks',
        status: options.status ?? 'running',
        startedAt: 5,
        updatedAt: 10,
        events: options.events ?? [],
        ...(options.threadId === undefined ? {} : { threadId: options.threadId })
    }) as unknown as SessionTurn;

// Writer delegates to helper: the child run is the nested invocation `inv-9`, which the
// roster joins to the persistent conversation `thread-child`. One delegate call is enough
// to put a delegated card inside the conversation card, exactly like the IT15 report.
const delegationEvents = (): HarnessEvent[] =>
    [
        { type: 'start', agent: 'writer', model: 'm1' } as HarnessEvent,
        {
            type: 'tool_call',
            agent: 'writer',
            call: { id: 'd1', name: 'delegate', arguments: '{}' }
        } as HarnessEvent,
        { type: 'start', agent: 'helper', model: 'h1', thread: { id: 'inv-9' } } as unknown as HarnessEvent
    ];

// The IT15 shape: ONE conversation holding a head prompt and TWO steering prompts, with a
// delegated child conversation card inside the head exchange. `thread-root` is `running`,
// so the bar's destructive control is Stop (the state in the user's screenshot).
const roster = (): SessionThreadEntry[] => [
    threadEntry({ id: 'thread-root', sequence: 1, label: 'Writer', agent: 'writer' }),
    threadEntry({
        id: 'thread-child',
        sequence: 2,
        label: 'Helper child',
        agent: 'helper',
        ownerThreadId: 'thread-root',
        invocationId: 'inv-9',
        messages: [{ role: 'assistant', content: 'child answer' }]
    })
];

const conversationTurns = (): SessionTurn[] => [
    turnRecord({ id: 'turn-1', index: 0, threadId: 'thread-root', prompt: 'Review IT14 thread', events: delegationEvents() }),
    turnRecord({ id: 'turn-2', index: 1, threadId: 'thread-root', prompt: 'I note that the plan is wrong' }),
    turnRecord({ id: 'turn-3', index: 2, threadId: 'thread-root', prompt: 'Looks like you didn’t finish the task?' })
];

const mount = (stopThread?: (sessionId: string, threadId: string) => Promise<unknown>) => {
    const board = createTurnBoard({
        ...(stopThread === undefined ? {} : { stopThread })
    });

    document.body.replaceChildren(board.element);
    board.bindSession('s1');
    board.setThreads(roster());

    return board;
};

afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

// --- DOM helpers ------------------------------------------------------------

// Every bar the board currently SHOWS. `hidden` is the only suppression path (styles.css
// `[hidden] { display: none !important }`), so an un-hidden bar is a bar on screen.
const visibleBars = (board: { element: HTMLElement }): HTMLElement[] =>
    [...board.element.querySelectorAll<HTMLElement>(
        '.tile-transcript-action, .thread-transcript-action, .thread-focus-actions'
    )].filter((bar) => !bar.hidden);

// The conversation CARD, and the exchange rows directly inside it (recorded order, so
// `rows[0]` is the card header).
const cardOf = (board: { element: HTMLElement }, threadId: string): HTMLElement => {
    const card = board.element.querySelector<HTMLElement>(`.conversation[data-thread-id="${threadId}"]`);
    if (card === null) throw new Error(`missing conversation card ${threadId}`);
    return card;
};

const exchangeRows = (card: HTMLElement): HTMLElement[] => [
    ...card.querySelectorAll<HTMLElement>(':scope > .turn-row')
];

const tileOf = (row: HTMLElement): HTMLElement => {
    const tile = row.querySelector<HTMLElement>(':scope > .tile');
    if (tile === null) throw new Error('missing tile');
    return tile;
};

const selectOf = (tile: HTMLElement): HTMLButtonElement => {
    const select = tile.querySelector<HTMLButtonElement>(':scope > .tile-select');
    if (select === null) throw new Error('missing .tile-select');
    return select;
};

const barOf = (tile: HTMLElement): HTMLElement => {
    const bar = tile.querySelector<HTMLElement>(':scope > .tile-transcript-action');
    if (bar === null) throw new Error('missing tile action bar');
    return bar;
};

// A delegated card's bar lives inside its `.thread-tile` (the card's anatomy is
// `.thread-row > .thread-tile > [.thread-select, .thread-transcript-action, .thread-body]`,
// exactly one bar deep below the header).
const cardBarOf = (row: HTMLElement): HTMLElement => {
    const bar = row.querySelector<HTMLElement>(':scope > .thread-tile > .thread-transcript-action');
    if (bar === null) throw new Error('missing card action bar');
    return bar;
};

describe('one action bar at the top of an expanded conversation (R2)', () => {
    it('keeps a single bar in the head exchange while every entry of the conversation is pressed', () => {
        const board = mount();
        board.hydrate(conversationTurns());

        const card = cardOf(board, 'thread-root');
        const rows = exchangeRows(card);
        // The projection groups all three runs of `thread-root` into ONE card.
        expect(rows).toHaveLength(3);
        expect([...rows].map((row) => row.classList.contains('is-continuation'))).toEqual([
            false,
            true,
            true
        ]);

        const head = tileOf(rows[0]);
        const headBar = barOf(head);

        // The entry-time default opens the newest exchange (pinned elsewhere); the bar is
        // still the HEAD's, because the bar belongs to the conversation.
        expect(board.expanded()?.id()).toBe('turn-3');
        expect(visibleBars(board)).toEqual([headBar]);
        // Anatomy: header → bar → body, so the bar is the first thing under the thread
        // header and ABOVE every entry body of the card (the user's "it should be at the
        // top"). The node is a direct child of the head exchange's tile, i.e. it scrolls
        // with the conversation instead of sticking to the viewport.
        expect([...head.children].map((node) => node.className)).toEqual([
            'tile-select',
            'tile-transcript-action',
            'tile-body'
        ]);
        for (const body of card.querySelectorAll<HTMLElement>('.tile-body')) {
            expect(headBar.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        }

        // The bar's accessible identity is the CONVERSATION.
        const transcriptLabel = () =>
            headBar.querySelector<HTMLElement>('.transcript-open')?.getAttribute('aria-label');
        const stopLabel = () => headBar.querySelector<HTMLElement>('.thread-delete')?.getAttribute('aria-label');
        expect(transcriptLabel()).toBe('Open the JSON transcript of Writer');
        expect(stopLabel()).toBe('Stop thread Writer');

        // Press the FIRST steering prompt, then the SECOND, then the head: the visible bar
        // stays byte-for-byte the head's bar, and the single-expansion invariant still
        // follows the pressed tile.
        for (const [row, turnId] of [
            [rows[1], 'turn-2'],
            [rows[2], 'turn-3'],
            [rows[0], 'turn-1']
        ] as const) {
            selectOf(tileOf(row)).click();

            expect(board.expanded()?.id()).toBe(turnId);
            expect(board.focusedThread()).toBe('thread-root');
            expect(visibleBars(board)).toEqual([headBar]);
            expect(transcriptLabel()).toBe('Open the JSON transcript of Writer');
            expect(stopLabel()).toBe('Stop thread Writer');
            // The pressed entry gained its own expansion, and its own (hidden) bar.
            expect(tileOf(row).classList.contains('is-expanded')).toBe(true);
        }
    });

    it('removes the bar with the conversation, and hides the delegated card’s own bar', () => {
        const board = mount();
        board.hydrate(conversationTurns());

        const card = cardOf(board, 'thread-root');
        const childRow = card.querySelector<HTMLElement>('.thread-row[data-persistent-thread="thread-child"]');
        expect(childRow?.dataset.parentThread).toBeUndefined();
        // The delegated card is collapsed until something needs it: no bar of its own.
        expect(childRow?.classList.contains('is-expanded')).toBe(false);

        // Collapse the conversation (the board's own unfocus) — no surface, no bar.
        board.collapse();

        expect(card.classList.contains('is-expanded')).toBe(false);
        expect(visibleBars(board)).toEqual([]);

        // Re-opening through `focusThread` (a programmatic focus) shows the SAME single bar.
        expect(board.focusThread('thread-root')).toBe(true);
        expect(visibleBars(board)).toEqual([barOf(tileOf(exchangeRows(card)[0]))]);
    });

    it('stops the CONVERSATION from the bar whoever was pressed last', async () => {
        const stopped: Array<[string, string]> = [];
        const board = mount(async (sessionId, threadId) => {
            stopped.push([sessionId, threadId]);
        });

        board.hydrate(conversationTurns());

        const card = cardOf(board, 'thread-root');
        // Press a steering entry (a separate run of the same conversation), then the bar.
        selectOf(tileOf(exchangeRows(card)[1])).click();

        const deleteButton = barOf(tileOf(exchangeRows(card)[0])).querySelector<HTMLButtonElement>(
            '.thread-delete'
        );
        expect(deleteButton?.classList.contains('thread-stop')).toBe(true);
        deleteButton?.click();

        // One cancel, for the conversation the card shows — not for the pressed entry's own
        // id, and not one request per entry.
        expect(stopped).toEqual([['s1', 'thread-root']]);
    });
});

describe('a delegated card adds no second bar (R2)', () => {
    // Continuing a CHILD conversation is a turn of its own routed INSIDE the child's card
    // (ui/turns.ts `placeTurn` -> `childExchangeHost`). Expanding it opens the enclosing
    // card, so this is the state where the board used to paint a bar for the CARD and a
    // second one for the exchange inside it — two bars, one conversation.
    const withChildContinuation = (): ReturnType<typeof createTurnBoard> => {
        const board = mount();

        board.hydrate([turnRecord({ id: 'turn-1', index: 0, threadId: 'thread-root', events: delegationEvents() })]);
        board.reconcile([
            turnRecord({ id: 'turn-1', index: 0, threadId: 'thread-root', events: delegationEvents() }),
            turnRecord({ id: 'turn-2', index: 1, threadId: 'thread-child', prompt: 'child follow-up' })
        ]);

        return board;
    };

    it('routes the continuation inside the child card and shows that card’s bar only', () => {
        const board = withChildContinuation();

        const childCard = board.element.querySelector<HTMLElement>(
            '.thread-row[data-persistent-thread="thread-child"]'
        );
        const exchange = childCard?.querySelector<HTMLElement>(':scope > .thread-tile > .thread-body > .thread-flow > .turn-row');
        expect(exchange?.dataset.threadExchange).toBe('thread-child');

        // Focusing the child opens the card that holds the focused exchange (ui/turns.ts
        // `openEnclosingCards`) — an "expanded" turn hidden inside a collapsed ancestor
        // body would be an invisible focus.
        expect(board.focusThread('thread-child')).toBe(true);
        expect(board.expanded()?.id()).toBe('turn-2');
        expect(childCard?.classList.contains('is-expanded')).toBe(true);

        // ONE bar for the child conversation, and it is the card's — the exchange inside
        // the card contributes none, because the card's bar already sits above its bodies.
        expect(visibleBars(board)).toEqual([cardBarOf(childCard as HTMLElement)]);

        // Pressing the exchange INSIDE the card is a collapse press (it is the expanded
        // turn): everything closes, and with it the conversation's only bar.
        selectOf(tileOf(exchange as HTMLElement)).click();
        expect(board.expanded()).toBeUndefined();
        expect(visibleBars(board)).toEqual([]);

        // Pressing it again re-opens the same surface — and the bar is still the CARD's,
        // never a second one on the exchange inside the card.
        selectOf(tileOf(exchange as HTMLElement)).click();
        expect(board.expanded()?.id()).toBe('turn-2');
        expect(childCard?.classList.contains('is-expanded')).toBe(true);
        expect(visibleBars(board)).toEqual([cardBarOf(childCard as HTMLElement)]);
    });

    it('moves the single bar onto the child card when the child is the focused surface', () => {
        const board = mount();
        board.hydrate([
            turnRecord({ id: 'turn-1', index: 0, threadId: 'thread-root', events: delegationEvents() })
        ]);

        const card = cardOf(board, 'thread-root');
        const headBar = barOf(tileOf(exchangeRows(card)[0]));
        expect(visibleBars(board)).toEqual([headBar]);

        const childRow = card.querySelector<HTMLElement>('.thread-row[data-persistent-thread="thread-child"]');
        // Pressing the child's header focuses the CHILD conversation, which closes the
        // parent surface: the child-specific Stop/Transcript/Delete is therefore still
        // reachable, on the child's own bar.
        childRow
            ?.querySelector<HTMLButtonElement>(':scope > .thread-tile > .thread-select')
            ?.click();

        expect(board.focusedThread()).toBe('thread-child');
        expect(card.classList.contains('is-expanded')).toBe(false);
        expect(visibleBars(board)).toEqual([cardBarOf(childRow as HTMLElement)]);
        expect(
            cardBarOf(childRow as HTMLElement)
                .querySelector<HTMLElement>('.transcript-open')
                ?.getAttribute('aria-label')
        ).toBe('Open the JSON transcript of Helper child');
    });
});

describe('a placement change carries the open conversation WITH the row (F4/F5)', () => {
    // The bar belongs to the conversation that is OPEN, and an open conversation is the card
    // the expanded row sits in. `placeTurn` is record-authoritative, so a snapshot that names
    // a different conversation for the SAME turn — or no conversation at all (the C8-M1 command
    // turn) — MOVES the expanded row. Two things must follow, and neither one was guaranteed
    // before: the card the row left stops looking open (F5, else its head keeps a SECOND bar
    // beside the new card's), and the bars repaint even though no card changed its head (F4,
    // because `reorderBoard`'s repaint is head-keyed).
    const twoConversationRoster = (): SessionThreadEntry[] => [
        threadEntry({ id: 'thread-a', sequence: 1, label: 'Alpha', agent: 'writer' }),
        threadEntry({ id: 'thread-b', sequence: 2, label: 'Beta', agent: 'worker' })
    ];

    const mountRoster = (entries: readonly SessionThreadEntry[]): ReturnType<typeof createTurnBoard> => {
        const board = createTurnBoard({});

        document.body.replaceChildren(board.element);
        board.bindSession('s1');
        board.setThreads(entries);

        return board;
    };

    it('moves the single bar to the new conversation when the expanded row changes conversation', () => {
        const board = mountRoster(twoConversationRoster());

        // `turn-b1` heads `thread-b` and is created BEFORE the row that is about to move, so
        // moving that row into the card cannot change the card's head: the steady-state case
        // `reorderBoard` cannot see, and the reason the bars need their own repaint.
        board.hydrate([
            turnRecord({ id: 'turn-b1', index: 0, threadId: 'thread-b', prompt: 'beta prompt' }),
            turnRecord({ id: 'turn-a1', index: 1, threadId: 'thread-a', prompt: 'alpha owner' }),
            turnRecord({ id: 'turn-a2', index: 2, threadId: 'thread-a', prompt: 'alpha steering' })
        ]);

        const cardA = cardOf(board, 'thread-a');
        const cardB = cardOf(board, 'thread-b');
        const headBarA = barOf(tileOf(exchangeRows(cardA)[0]));

        // Start: the entry-time default opens the newest surface, which is the CONTINUATION
        // `turn-a2` of `thread-a`; the conversation's one bar is `thread-a`'s head.
        expect(board.expanded()?.id()).toBe('turn-a2');
        expect(cardA.classList.contains('is-expanded')).toBe(true);
        expect(cardB.classList.contains('is-expanded')).toBe(false);
        expect(visibleBars(board)).toEqual([headBarA]);

        // The placement change: the same turn, now a record of `thread-b`.
        board.reconcile([
            turnRecord({ id: 'turn-b1', index: 0, threadId: 'thread-b', prompt: 'beta prompt' }),
            turnRecord({ id: 'turn-a1', index: 1, threadId: 'thread-a', prompt: 'alpha owner' }),
            turnRecord({ id: 'turn-a2', index: 2, threadId: 'thread-b', prompt: 'alpha steering' })
        ]);

        // The reader's surface survived as the same tile, and it now lives in the OTHER card.
        expect(board.expanded()?.id()).toBe('turn-a2');
        expect(board.focusedThread()).toBe('thread-b');
        expect(exchangeRows(cardB)).toHaveLength(2);

        // F5: the abandoned card is closed again — the row that made it an open conversation
        // left it, and nothing else ever clears that marker on a placement change.
        expect(cardA.classList.contains('is-expanded')).toBe(false);
        // F4: the card the row landed in carries the open look, and the moved row is a
        // continuation of it (it did not become that card's head).
        expect(cardB.classList.contains('is-expanded')).toBe(true);
        expect(exchangeRows(cardB).map((row) => row.classList.contains('is-continuation'))).toEqual([
            false,
            true
        ]);

        // The result is exactly ONE visible bar, on the head of the conversation the expanded
        // row now belongs to, and it acts on THAT conversation. Pre-fix this was either two
        // bars (the stale card kept its head bar) or the wrong one bar (the new card's bar was
        // never painted, because no card head changed).
        const headBarB = barOf(tileOf(exchangeRows(cardB)[0]));

        expect(visibleBars(board)).toEqual([headBarB]);
        expect(headBarA.hidden).toBe(true);
        expect(
            headBarB
                .querySelector<HTMLElement>('.transcript-open')
                ?.getAttribute('aria-label')
        ).toBe('Open the JSON transcript of Beta');
        // The thread is `running` in this roster, so the bar's destructive control is Stop —
        // and it names the conversation the bar moved to, which is the target fact here.
        expect(
            headBarB.querySelector<HTMLElement>('.thread-delete')?.getAttribute('aria-label')
        ).toBe('Stop thread Beta');
    });

    it('leaves one bar when the expanded row leaves its conversation for a thread-less record', () => {
        const board = mountRoster([threadEntry({ id: 'thread-a', sequence: 1, label: 'Alpha', agent: 'writer' })]);

        board.hydrate([
            turnRecord({ id: 'turn-a1', index: 0, threadId: 'thread-a', prompt: 'alpha owner' }),
            turnRecord({ id: 'turn-a2', index: 1, threadId: 'thread-a', prompt: 'alpha steering' })
        ]);

        const cardA = cardOf(board, 'thread-a');
        const headBarA = barOf(tileOf(exchangeRows(cardA)[0]));

        expect(board.expanded()?.id()).toBe('turn-a2');
        expect(visibleBars(board)).toEqual([headBarA]);

        // The expanded turn's record names NO conversation (a server command turn, C8-M1): the
        // row is placed board-direct and becomes a card of its own, and the card it came from
        // is no longer the open conversation.
        board.reconcile([
            turnRecord({ id: 'turn-a1', index: 0, threadId: 'thread-a', prompt: 'alpha owner' }),
            turnRecord({ id: 'turn-a2', index: 1, prompt: 'alpha steering' })
        ]);

        expect(board.expanded()?.id()).toBe('turn-a2');
        expect(cardA.classList.contains('is-expanded')).toBe(false);

        const standalone = board.element.querySelector<HTMLElement>('.turns > .turn-row > .tile[data-turn-id="turn-a2"]');

        expect(standalone).not.toBeNull();
        // A board-direct row IS its whole card, so its header owns the bar — and it is the
        // ONLY bar: the abandoned conversation lost the open look with the row.
        expect(visibleBars(board)).toEqual([barOf(standalone as HTMLElement)]);
        expect(headBarA.hidden).toBe(true);
    });
});

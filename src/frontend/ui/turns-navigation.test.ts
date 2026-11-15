// R3 — the reader navigates freely; the board does not force the latest item.
//
// Two rules the display-flood fix pins down, both at the board level:
//
//   (a) `hydrate`/`hydrateView` used to end with `kept ?? handles[handles.length - 1]`, so a
//       rebuild whose window no longer held the tile the reader was looking at silently
//       selected the NEWEST turn (and the viewport followed). The selection is now left alone;
//       the ENTRY-TIME default — a rebuild that starts with nothing expanded — still opens the
//       newest surface, which is the conversation the reader just entered (the deliberate
//       keep-list exception, pinned here too so the two cannot be confused later).
//
//   (b) re-asserting a focus from a background document apply (`reconcile`'s focus
//       preservation → `focusThread` → `focusChildThread`) used to call `scrollIntoView`, so a
//       poll could move the viewport under the reader. Scrolling is now the caller's explicit
//       statement (`scroll: true`, only from a gesture); every programmatic path is silent.
//
//   (c) R1: the SAME flag was silently dropped on the ordinary path — a turn of the focused
//       conversation — so clicking an entry of a MULTI-EXCHANGE conversation opened the whole
//       conversation (every exchange's body becomes visible, ui/turns.ts) above the pressed
//       row and left the viewport on the head entry: "clicking on them does not navigate to
//       the correct position". `expand(turn, scroll)` now reveals the PRESSED entry, and the
//       last block here pins that the flag is honoured on both focus paths and still ignored
//       by every background one. The reveal is deliberately NOT restored to a background
//       auto-scroll: (b) stays pinned.
//
//   (d) F2: WHICH node was revealed cannot prove WHEN it was revealed. The spy therefore
//       captures the DOM state at call time (the pressed card's open look, the conversation
//       card's open look, and the conversation bar's painted state), so a reveal moved back in
//       front of the class toggles and the bar repaint — the original bug — fails the test
//       instead of passing on the element identity alone.
//
//   (e) F6: the two kinds of delegated row press behave differently ON PURPOSE — a persistent
//       child's press focuses that conversation and reveals its surface, a non-persistent
//       invocation card only opens detail and scrolls nothing. The last block pins both, so the
//       silence of the second branch is a recorded decision rather than an assumption.
//
// Run: yarn vitest run --config src/frontend/vitest.config.ts ui/turns-navigation.test.ts

import type { HarnessEvent, SessionTurn } from '../../server/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTurnBoard } from './turns';
import type { SessionThreadEntry } from './threads';

const threadEntry = (overrides: Partial<SessionThreadEntry> & { id: string }): SessionThreadEntry => ({
    agent: 'writer',
    origin: 'host',
    status: 'idle',
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
        status: options.status ?? 'done',
        startedAt: 5,
        updatedAt: 10,
        events: options.events ?? [],
        ...(options.threadId === undefined ? {} : { threadId: options.threadId })
    }) as unknown as SessionTurn;

const mount = () => {
    const board = createTurnBoard({});

    document.body.replaceChildren(board.element);

    return board;
};

// jsdom ships no `scrollIntoView` at all (which is why the production call is optional), so a
// prototype spy is the only way to observe the rule. Captured as `unknown` and restored after
// every test: this file used to leave its spy on the prototype for everything that followed,
// and a leak would silently decide which element a later test saw revealed.
const nativeScrollIntoView: unknown = (
    HTMLElement.prototype as unknown as { scrollIntoView?: unknown }
).scrollIntoView;

// F2: one recorded reveal — the node, the exact request, and the DOM state AS THE CALL SAW IT.
// `expand` has to run the reveal LAST: the pressed card's class, the conversation card's class
// and the board-wide bar repaint each grow the content ABOVE the pressed row (ui/turns.ts
// `expand`), and the transcript keeps its numeric scroll offset, so a `scrollIntoView` that ran
// earlier in that sequence would land on the conversation head — the original bug. Asserting
// only WHICH node was revealed cannot see that (the same node is passed either way); asserting
// the state captured at call time can, which is what this recorder exists for.
type RevealCall = {
    element: HTMLElement;
    // The request, serialized (`{"block":"nearest"}`).
    request: string;
    // `[pressed card open, conversation card open, conversation bar hidden]`.
    state: [boolean, boolean, boolean];
};

// The conversation anatomy around a revealed node: the CARD the node belongs to (a `.tile` for
// an exchange, a `.thread-tile` for a delegated card) and the `.conversation` card holding it
// (undefined for a board-direct row — a legacy/unthreaded row is its own whole card).
// `querySelector` returns `null`; every probe here wants "absent" as `undefined` so the
// assertions below read as facts about the DOM rather than as null-handling.
const elementOf = (scope: HTMLElement | undefined, selector: string): HTMLElement | undefined =>
    scope?.querySelector<HTMLElement>(selector) ?? undefined;

const cardAround = (node: HTMLElement): { card?: HTMLElement; host?: HTMLElement } => {
    const card =
        node.classList.contains('tile') || node.classList.contains('thread-tile')
            ? node
            : (elementOf(node, ':scope > .tile') ?? elementOf(node, ':scope > .thread-tile'));
    const parent = card === undefined ? undefined : (card.parentElement ?? undefined);
    const host = parent === undefined ? undefined : (parent.parentElement ?? undefined);

    return {
        card,
        host: host !== undefined && host.classList.contains('conversation') ? host : undefined
    };
};

const revealState = (node: HTMLElement): [boolean, boolean, boolean] => {
    const { card, host } = cardAround(node);

    // THE bar of this conversation: when the row sits in a conversation card the bar belongs
    // to that card's HEAD exchange (ui/turns.ts `showsThreadActionBar`), and `refreshActionBars`
    // is the last thing before the reveal — so this node going visible is the repaint the
    // reveal is required to wait for. A board-direct row owns its own bar.
    const bar =
        host === undefined
            ? (elementOf(card, ':scope > .tile-transcript-action') ??
                elementOf(card, ':scope > .thread-transcript-action'))
            : elementOf(host, ':scope > .turn-row > .tile > .tile-transcript-action');

    return [
        card?.classList.contains('is-expanded') ?? false,
        host?.classList.contains('is-expanded') ?? false,
        // A missing bar counts as hidden: "visible" is the fact being pinned. The DOM types
        // spell `hidden` as `boolean | 'until-found'`, so "on screen" is exactly `false`.
        bar?.hidden !== false
    ];
};

// Installs the recorder and returns every reveal, in the order they were asked for.
const revealSpy = (): RevealCall[] => {
    const calls: RevealCall[] = [];

    (HTMLElement.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView =
        function (this: HTMLElement, request?: unknown) {
            calls.push({ element: this, request: JSON.stringify(request ?? null), state: revealState(this) });
        };

    return calls;
};

afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';

    if (nativeScrollIntoView === undefined) {
        delete (HTMLElement.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
    } else {
        (HTMLElement.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView =
            nativeScrollIntoView;
    }
});

describe('selection survives a rebuild that dropped the tile (R3a)', () => {
    it('leaves the selection alone when the kept tile is not in the fresh document', () => {
        const board = mount();

        board.hydrate([
            turnRecord({ id: 'turn-1', index: 0, threadId: 'thread-1' }),
            turnRecord({ id: 'turn-2', index: 1, threadId: 'thread-2' })
        ]);

        // The entry-time default: the reader entered this conversation, so its newest surface
        // is open (the KEEP-list exception, not the bug).
        expect(board.expanded()?.id()).toBe('turn-2');

        // A re-read whose window no longer holds the tile the reader was looking at: the old
        // newest-fallback would have opened `turn-1` (the only row left, and the newest of the
        // fresh document). Nothing is expanded instead, and nothing is focused.
        board.hydrate([turnRecord({ id: 'turn-1', index: 0, threadId: 'thread-1' })], { keep: 'turn-2' });

        expect(board.expanded()).toBeUndefined();
        expect(board.focusedThread()).toBeUndefined();
        expect(board.turns()).toHaveLength(1);
    });

    it('keeps the entry-time default of opening the newest surface of a board with no selection', () => {
        const board = mount();

        board.hydrate([
            turnRecord({ id: 'turn-1', index: 0, threadId: 'thread-1' }),
            turnRecord({ id: 'turn-2', index: 1, threadId: 'thread-2' })
        ]);

        expect(board.expanded()?.id()).toBe('turn-2');
        expect(board.focusedThread()).toBe('thread-2');
    });

    it('re-expands the kept tile when it survives the rebuild', () => {
        const board = mount();

        board.hydrate([turnRecord({ id: 'turn-1', index: 0, threadId: 'thread-1' })]);
        board.hydrate([
            turnRecord({ id: 'turn-1', index: 0, threadId: 'thread-1' }),
            turnRecord({ id: 'turn-2', index: 1, threadId: 'thread-2' })
        ]);

        // Carried across by id: the newer document does not steal the selection.
        expect(board.expanded()?.id()).toBe('turn-1');
    });
});

describe('a background focus never scrolls (R3c)', () => {
    // Writer delegates to helper: the child run is a nested invocation (`inv-9`) the roster
    // joins to the persistent conversation `thread-child`, which is the only surface whose
    // focus path calls `scrollIntoView` (./ui/turns.ts `focusChildThread`).
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

    const roster = (): SessionThreadEntry[] => [
        threadEntry({ id: 'thread-root', sequence: 1, label: 'Writer', agent: 'writer' }),
        threadEntry({
            id: 'thread-child',
            sequence: 2,
            label: 'Helper child',
            agent: 'helper',
            ownerThreadId: 'thread-root',
            invocationId: 'inv-9',
            messages: [
                { role: 'user', content: 'child prompt' },
                { role: 'assistant', content: 'child answer' }
            ]
        })
    ];

    const childTurn = (): SessionTurn =>
        turnRecord({ id: 'turn-1', index: 0, threadId: 'thread-root', events: delegationEvents() as unknown[] });

    it('scrolls only for a caller that says the reader asked for it', () => {
        // jsdom ships no `scrollIntoView` at all (which is why the production call is optional),
        // so the spy is the only way to observe the rule in this environment.
        const scrolled = vi.fn();

        (HTMLElement.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrolled;

        const board = mount();

        board.setThreads(roster());
        board.hydrate([childTurn()]);

        // Programmatic focus (the default every background path uses): the conversation opens,
        // the reader's viewport does not move.
        expect(board.focusThread('thread-child')).toBe(true);
        expect(board.focusedThread()).toBe('thread-child');
        expect(scrolled).toHaveBeenCalledTimes(0);

        // The same focus asked for by a gesture (a header press) does move the row into view.
        expect(board.focusThread('thread-child', true)).toBe(true);
        expect(scrolled).toHaveBeenCalledTimes(1);

        // And a document reconcile that only RE-ASSERTS the focus the reader already had is
        // silent again — the per-poll path that used to drag the viewport.
        board.reconcile([childTurn()]);
        expect(board.focusedThread()).toBe('thread-child');
        expect(scrolled).toHaveBeenCalledTimes(1);
    });
});

describe('a pressed entry of a multi-entry conversation reveals ITSELF (R1)', () => {
    // The R3c flag only ever reached `focusThread`; the ordinary click path had no scroll at
    // all, so pressing the SECOND exchange of an RR2 conversation revealed the FIRST entry
    // (and the action bar anchored there). These tests pin the gesture reveal on the entry
    // that was pressed, and pin the opt-out everywhere else: hydrate, reconcile, collapse and
    // any programmatic focus that does not ask for a scroll.
    const conversationEvents = (): HarnessEvent[] =>
        [{ type: 'start', agent: 'researcher', model: 'm1' } as HarnessEvent];

    // ONE persistent conversation with two recorded entries — the shape of the user report
    // ("I can't navigate to a specific entry if it is a multi entry thread").
    const conversationTurns = (): SessionTurn[] => [
        turnRecord({
            id: 'turn-1',
            index: 0,
            prompt: 'owner prompt',
            status: 'running',
            threadId: 'thread-1',
            events: conversationEvents()
        }),
        turnRecord({
            id: 'turn-2',
            index: 1,
            prompt: 'steered prompt',
            status: 'running',
            threadId: 'thread-1',
            events: conversationEvents()
        })
    ];

    const mountConversation = (): ReturnType<typeof createTurnBoard> => {
        const board = mount();

        board.setThreads([threadEntry({ id: 'thread-1', agent: 'researcher', label: 'RR2' })]);
        board.hydrate(conversationTurns());

        return board;
    };

    // The exchange rows of the conversation card, in RECORDED order: `rows[0]` is the head
    // prompt, `rows[1]` the steered prompt. `placeTurn` keeps that order and marks every
    // later row `is-continuation`, so the rows are stable however the projection re-renders.
    const exchangeRows = (board: ReturnType<typeof createTurnBoard>): HTMLElement[] => [
        ...board.element.querySelectorAll<HTMLElement>('.conversation > .turn-row')
    ];

    const pressRow = (row: HTMLElement): void => {
        const select = row.querySelector('.tile-select') as HTMLButtonElement | null;

        expect(select).not.toBeNull();
        select?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    };

    // Which entry a revealed node stands for: the conversation anatomy carries the id on the
    // TILE, a legacy standalone row carries it on the ROW, so both spellings resolve here.
    const entryIdOf = (node: HTMLElement): string | null =>
        node.closest('[data-turn-id]')?.getAttribute('data-turn-id') ??
        node.querySelector('[data-turn-id]')?.getAttribute('data-turn-id') ??
        null;

    const revealedEntries = (revealed: RevealCall[]): (string | null)[] =>
        revealed.map((call) => entryIdOf(call.element));

    // F2: the whole ordering fact of one reveal — `[entry, card open at call time, conversation
    // card open at call time, conversation bar hidden at call time, request]`. Every boolean is
    // read INSIDE the `scrollIntoView` call, so the tuple proves the reveal ran at the END of
    // the expansion sequence; a reveal moved earlier in that sequence reads different booleans.
    const revealedStates = (
        revealed: RevealCall[]
    ): Array<[string | null, boolean, boolean, boolean, string]> =>
        revealed.map(
            (call) =>
                [entryIdOf(call.element), call.state[0], call.state[1], call.state[2], call.request] as [
                    string | null,
                    boolean,
                    boolean,
                    boolean,
                    string
                ]
        );

    // The conversation's ONE bar: the HEAD exchange's (styles.css's `[hidden] { display: none
    // !important }` is the only suppression path, so an un-hidden bar is a bar on screen).
    const headBar = (board: ReturnType<typeof createTurnBoard>): HTMLElement => {
        const bar = board.element.querySelector<HTMLElement>(
            '.conversation > .turn-row > .tile > .tile-transcript-action'
        );

        if (bar === null) throw new Error('missing the conversation action bar');

        return bar;
    };

    it('reveals only AFTER the grown conversation and its bar are painted (F2)', () => {
        const revealed = revealSpy();
        const board = mountConversation();
        const [head, steering] = exchangeRows(board) as [HTMLElement, HTMLElement];

        // The collapsed board is the state where the reveal's position actually matters: the
        // press that opens this conversation makes every EARLIER exchange's body visible above
        // the pressed row, marks the conversation card open, and paints the in-flow action bar
        // (the bar belongs to the conversation's head exchange, ui/turns.ts
        // `showsThreadActionBar`), and the transcript keeps its numeric scroll offset. Every one
        // of those changes the distance the reveal has to travel, so it must run last.
        board.collapse();

        expect(revealed).toEqual([]);
        expect((head.querySelector(':scope > .tile') as HTMLElement).classList.contains('is-expanded')).toBe(
            false
        );
        expect(headBar(board).hidden).toBe(true);

        // Press the SECOND exchange of the collapsed conversation: the reveal is for the entry
        // pressed, and at the moment it is asked for the pressed card is open, the conversation
        // card is open and that conversation's bar is on screen.
        pressRow(steering);

        expect(revealedStates(revealed)).toEqual([['turn-2', true, true, false, '{"block":"nearest"}']]);

        // A press of the HEAD exchange of the same (now open) conversation reveals the head, and
        // the call-time state is the same final surface — the reveal never runs before the
        // toggles, whichever entry was pressed.
        pressRow(head);

        expect(revealedStates(revealed)).toEqual([
            ['turn-2', true, true, false, '{"block":"nearest"}'],
            ['turn-1', true, true, false, '{"block":"nearest"}']
        ]);
        // The state the reveal saw is the state the board ends in: same node, same facts.
        expect(headBar(board).hidden).toBe(false);
    });

    it('reveals the entry that was pressed, in press order, and nothing else', () => {
        const revealed = revealSpy();
        const board = mountConversation();

        // Hydration auto-opens the newest surface (the entry-time default) and that expansion
        // alone must not move the viewport: the reader was already looking at it.
        expect(exchangeRows(board)).toHaveLength(2);
        expect(revealed).toEqual([]);

        const [head, steering] = exchangeRows(board);

        expect(entryIdOf(head as HTMLElement)).toBe('turn-1');
        expect(entryIdOf(steering as HTMLElement)).toBe('turn-2');

        // First press: the entry pressed IS the entry revealed.
        pressRow(head as HTMLElement);

        expect((head.querySelector(':scope > .tile') as HTMLElement).classList.contains('is-expanded')).toBe(true);
        expect(revealedEntries(revealed)).toEqual(['turn-1']);

        // The R1 case: pressing the SECOND entry of the open conversation reveals THAT entry.
        // It never follows the conversation head, which is what the bar anchors to instead.
        pressRow(steering as HTMLElement);

        expect(
            (steering.querySelector(':scope > .tile') as HTMLElement).classList.contains('is-expanded')
        ).toBe(true);
        expect(revealedEntries(revealed)).toEqual(['turn-1', 'turn-2']);
    });

    it('reveals nothing when the same press collapses the entry', () => {
        const revealed = revealSpy();
        const board = mountConversation();
        const [head, steering] = exchangeRows(board);

        pressRow(head as HTMLElement);
        pressRow(steering as HTMLElement);
        expect(revealedEntries(revealed)).toEqual(['turn-1', 'turn-2']);

        // A collapse is not a gesture that needs revealing: the reader stays put.
        pressRow(steering as HTMLElement);

        expect(
            (steering.querySelector(':scope > .tile') as HTMLElement).classList.contains('is-expanded')
        ).toBe(false);
        expect(revealedEntries(revealed)).toEqual(['turn-1', 'turn-2']);
    });

    it('never reveals on a hydrate, a reconcile, or a focus that did not ask for a scroll', () => {
        const revealed = revealSpy();
        const board = mountConversation();

        // A document poll that only re-asserts the open conversation must not move the reader
        // (the per-poll path that used to drag the viewport).
        board.reconcile(conversationTurns());
        board.focusThread('thread-1');

        expect(revealed).toEqual([]);
    });

    it('still reveals when a programmatic focus explicitly opts in (the R3c flag survives)', () => {
        const revealed = revealSpy();
        const board = mountConversation();

        // The focus path opens the conversation's NEWEST entry (the entry-time default), and
        // the reveal follows the entry that actually opened — the same rule the press path
        // uses. What this pins is that the opt-in flag still travels: an explicit `true`
        // moves the viewport, while every silent path (the tests above) keeps it still.
        board.focusThread('thread-1', true);

        expect(revealedEntries(revealed)).toEqual(['turn-2']);
    });

    it('asks scrollIntoView on the pressed entry alone, with the nearest-block request', () => {
        const board = mountConversation();
        const [head, steering] = exchangeRows(board);

        pressRow(head as HTMLElement);

        // jsdom implements no scrollIntoView (the production call is optional for that
        // reason), so the exchange subtrees record their own calls: the second entry scrolls
        // ITSELF into view, the head entry is never scrolled, and the request stays
        // `{ block: 'nearest' }` — the least jumpy reveal available.
        const seen: string[] = [];

        const record = (node: Element | null): void => {
            if (node === null) return;
            (node as HTMLElement).scrollIntoView = (arg?: unknown) =>
                void seen.push(`${entryIdOf(node as HTMLElement)}:${JSON.stringify(arg ?? null)}`);
        };

        for (const row of [head, steering] as HTMLElement[]) {
            record(row);
            record(row.querySelector(':scope > .tile'));
        }

        pressRow(steering as HTMLElement);

        expect(seen).toEqual(['turn-2:{"block":"nearest"}']);
    });
});

describe('the two delegated row presses: child surface revealed, invocation detail silent (F6)', () => {
    // Writer delegates twice. The roster joins `inv-9` to the persistent child conversation
    // `thread-child`; `inv-8` has NO roster entry, so its card is pure invocation detail and
    // carries no `data-persistent-thread`. Those two rows take different branches of the
    // delegated header handler (ui/turns.ts, the `.thread-select` listener), and the viewport
    // follows only one of them. This block pins which, so the silence of the other branch
    // reads as the decision it is rather than as an oversight.
    const delegationEvents = (): HarnessEvent[] =>
        [
            { type: 'start', agent: 'writer', model: 'm1' } as HarnessEvent,
            {
                type: 'tool_call',
                agent: 'writer',
                call: { id: 'd1', name: 'delegate', arguments: '{}' }
            } as HarnessEvent,
            { type: 'start', agent: 'helper', model: 'h1', thread: { id: 'inv-9' } } as unknown as HarnessEvent,
            {
                type: 'tool_call',
                agent: 'writer',
                call: { id: 'd2', name: 'delegate', arguments: '{}' }
            } as HarnessEvent,
            { type: 'start', agent: 'logger', model: 'l1', thread: { id: 'inv-8' } } as unknown as HarnessEvent
        ];

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

    // The child conversation WITH a continuation turn of its own (the shape `focusThread`
    // path 1 answers), plus the head turn that carries both delegated cards.
    const withChildContinuation = (): ReturnType<typeof createTurnBoard> => {
        const board = mount();

        board.setThreads(roster());
        board.hydrate([
            turnRecord({ id: 'turn-1', index: 0, threadId: 'thread-root', events: delegationEvents() }),
            turnRecord({ id: 'turn-2', index: 1, prompt: 'child follow-up', threadId: 'thread-child' })
        ]);

        // Hydration auto-opens the newest surface; closing it first makes the press below the
        // thing that opens the conversation, which is the gesture being pinned.
        board.collapse();

        return board;
    };

    const cardHeaderOf = (row: HTMLElement): HTMLButtonElement => {
        const select = row.querySelector<HTMLButtonElement>(':scope > .thread-tile > .thread-select');

        if (select === null) throw new Error('missing the delegated card header');

        return select;
    };

    // Which entry a revealed node stands for: the id is carried on the TILE (ui/turns.ts
    // `update`/`bind`), so a reveal of an exchange resolves to that exchange's record.
    const entryIdOf = (node: HTMLElement): string | null =>
        node.closest('[data-turn-id]')?.getAttribute('data-turn-id') ??
        node.querySelector('[data-turn-id]')?.getAttribute('data-turn-id') ??
        null;

    it('reveals the conversation the persistent child press focused, not the card clicked', () => {
        const revealed = revealSpy();
        const board = withChildContinuation();

        const childRow = board.element.querySelector<HTMLElement>(
            '.thread-row[data-persistent-thread="thread-child"]'
        );

        expect(childRow).not.toBeNull();
        // The continuation lives INSIDE the child's card (ui/turns.ts `placeTurn` ->
        // `childExchangeHost`), so the conversation's surface and the card are different nodes.
        expect(
            childRow?.querySelector<HTMLElement>(
                ':scope > .thread-tile > .thread-body > .thread-flow > .turn-row'
            )?.dataset.threadExchange
        ).toBe('thread-child');

        cardHeaderOf(childRow as HTMLElement).click();

        expect(board.focusedThread()).toBe('thread-child');
        // Path 1 of `focusThread` finds the conversation's newest turn and forwards the gesture
        // flag, so the reveal is for THAT exchange — a press on the card whose conversation has
        // a recorded turn reveals the turn, which is the reading position the press asked for.
        expect(revealed.map((call) => entryIdOf(call.element))).toEqual(['turn-2']);
        expect(revealed.map((call) => call.request)).toEqual(['{"block":"nearest"}']);
    });

    it('scrolls nothing for a non-persistent invocation row — expansion only, BY DESIGN', () => {
        const revealed = revealSpy();
        const board = withChildContinuation();

        // The one card the roster never joined: no persistent conversation to focus.
        const detailRows = [...board.element.querySelectorAll<HTMLElement>('.thread-row:not([data-persistent-thread])')];

        expect(detailRows).toHaveLength(1);

        cardHeaderOf(detailRows[0]).click();

        // The detail card opened (the branch is `setThreadExpanded`, a local toggle) and nothing
        // moved: no focus change to follow and no position in the transcript to land on, so the
        // reader keeps their place exactly where they were.
        expect(detailRows[0].classList.contains('is-expanded')).toBe(true);
        expect(board.focusedThread()).toBeUndefined();
        expect(revealed).toEqual([]);
    });
});

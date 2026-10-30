// Thread focus in the turn board (R5/R6/R7 + T5b corrections).
//
// Focus is EXPLICIT board state, not "whichever tile is expanded":
//   - S1: a background adoption (snapshot turn, other tab, late upsert) never moves
//     it, and an explicit unfocus suppresses auto-selection;
//   - S2: a persistent CHILD conversation can be focused from the roster or by
//     clicking its nested invocation, even though it owns no SessionTurn;
//   - S6: the tile badge uses the SAME canonical label/sequence as the strip.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/thread-focus.test.ts

import type { HarnessEvent, SessionTurn } from '../../server/protocol';
import { composerStopOf } from './composer';
import { createTurnBoard } from './turns';
import type { TurnHandle } from './turns';
import type { SessionThreadEntry } from './threads';

const threadEntry = (overrides: Partial<SessionThreadEntry> & { id: string }): SessionThreadEntry => ({
    agent: 'writer',
    origin: 'host',
    status: 'idle',
    sequence: 1,
    ...overrides
});

// `SessionTurn.threadId` is additive in the protocol, so fixtures build the wire
// shape structurally where needed.
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
        prompt: options.prompt ?? 'task',
        status: options.status ?? 'done',
        startedAt: 5,
        updatedAt: 10,
        events: options.events ?? [],
        ...(options.threadId === undefined ? {} : { threadId: options.threadId })
    }) as unknown as SessionTurn;

const mount = () => {
    const focus: (string | undefined)[] = [];
    const board = createTurnBoard({
        onFocusChange: (threadId) => focus.push(threadId)
    });
    document.body.replaceChildren(board.element);
    return { board, focus };
};

const badgeOf = (element: HTMLElement): HTMLElement | null => element.querySelector<HTMLElement>('.tile-thread');

const nestedRow = (turn: TurnHandle): HTMLElement | null =>
    (turn.element.parentElement as HTMLElement | null)?.querySelector<HTMLElement>('.thread-row') ?? null;

describe('persistent thread identity on tiles (S6)', () => {
    it('paints the optimistic target thread from the roster label', () => {
        const { board } = mount();
        board.setThreads([threadEntry({ id: 'thread-7', sequence: 7, label: 'Writing', agent: 'writer' })]);

        const turn = board.begin('continue this one', [], 'thread-7');

        expect(turn.threadId()).toBe('thread-7');
        expect(turn.element.dataset.threadId).toBe('thread-7');
        const badge = badgeOf(turn.element);
        expect(badge?.hidden).toBe(false);
        // ONE canonical identity: the roster's label — never a digit from the id.
        expect(badge?.textContent).toBe('Writing');
        expect(badge?.title).toBe('Thread Writing · writer · idle');
    });

    it('uses the roster SEQUENCE (not the id digits) and marks unknown ids explicitly', () => {
        const { board } = mount();
        board.setThreads([
            threadEntry({ id: 'conv/3', sequence: 7 }),
            threadEntry({ id: 'thread-2', sequence: 2, label: 'Research' })
        ]);

        const sequenced = board.begin('a', [], 'conv/3');
        const labelled = board.begin('b', [], 'thread-2');
        const unknown = board.begin('c', [], 'thread-999');

        // R8: an unlabeled roster row shows its agent-prefixed fallback, never `T7`.
        expect(badgeOf(sequenced.element)?.textContent).toBe('WR7');
        expect(badgeOf(labelled.element)?.textContent).toBe('Research');
        expect(badgeOf(unknown.element)?.textContent).toBe('T?');
        expect(badgeOf(unknown.element)?.title).toBe('Thread thread-999');
    });

    it('repaints the badge when the roster arrives after adoption', () => {
        const { board } = mount();
        const turn = board.adopt(turnRecord({ id: 'turn-1', index: 0, threadId: 'thread-4' }));
        expect(badgeOf(turn.element)?.textContent).toBe('T?');

        board.setThreads([threadEntry({ id: 'thread-4', sequence: 4, label: 'Planner', agent: 'research' })]);

        expect(badgeOf(turn.element)?.textContent).toBe('Planner');
        expect(badgeOf(turn.element)?.title).toBe('Thread Planner · research · idle');
    });

    it('hides the badge for a legacy turn with no runtime thread', () => {
        const { board } = mount();

        const turn = board.begin('legacy');

        expect(turn.threadId()).toBeUndefined();
        expect(turn.element.dataset.threadId).toBeUndefined();
        expect(badgeOf(turn.element)?.hidden).toBe(true);
    });

    it('adopts the record thread, and keeps the optimistic one when the record omits it', () => {
        const { board } = mount();

        const optimistic = board.begin('steer', [], 'thread-2');
        optimistic.merge(turnRecord({ id: 'turn-1', index: 0, status: 'running' }));
        expect(optimistic.threadId()).toBe('thread-2');

        const fresh = board.begin('new');
        fresh.merge(turnRecord({ id: 'turn-2', index: 1, status: 'running', threadId: 'thread-9' }));
        expect(fresh.threadId()).toBe('thread-9');
        expect(fresh.element.dataset.threadId).toBe('thread-9');
    });

    it('groups repeated turns of one thread under the same badge', () => {
        const { board } = mount();

        board.hydrate([
            turnRecord({ id: 'turn-1', index: 0, threadId: 'thread-1' }),
            turnRecord({ id: 'turn-2', index: 1, threadId: 'thread-1' }),
            turnRecord({ id: 'turn-3', index: 2, threadId: 'thread-2' }),
            turnRecord({ id: 'turn-4', index: 3 })
        ]);

        const badges = board.turns().map((turn) => ({
            threadId: turn.threadId(),
            text: badgeOf(turn.element)?.textContent,
            hidden: badgeOf(turn.element)?.hidden
        }));

        expect(badges).toEqual([
            { threadId: 'thread-1', text: 'T?', hidden: false },
            { threadId: 'thread-1', text: 'T?', hidden: false },
            { threadId: 'thread-2', text: 'T?', hidden: false },
            // Legacy turn: no identity, so no badge (never an invented thread).
            { threadId: undefined, text: '', hidden: true }
        ]);
    });
});

describe('focus routing (S1)', () => {
    it('keeps an optimistic follow-up focused while a snapshot adopts another thread', () => {
        const { board, focus } = mount();
        board.hydrate([turnRecord({ id: 'turn-1', index: 0, threadId: 'thread-1' })]);

        const optimistic = board.begin('follow up in T1', [], 'thread-1');
        expect(board.expanded()).toBe(optimistic);
        expect(board.focusedThread()).toBe('thread-1');

        // A snapshot lands before the ack: T1's existing turn plus an UNRELATED
        // thread-2 turn the board has not seen yet.
        board.reconcile([
            turnRecord({ id: 'turn-1', index: 0, threadId: 'thread-1' }),
            turnRecord({ id: 'turn-2', index: 1, threadId: 'thread-2' })
        ]);

        // Focus never moves: the optimistic tile stays open and keeps its target.
        expect(board.focusedThread()).toBe('thread-1');
        expect(board.expanded()).toBe(optimistic);
        // The unrelated turn is rendered compact, NOT expanded.
        expect(board.turns().find((turn) => turn.id() === 'turn-2')?.element.classList.contains('is-expanded')).toBe(
            false
        );
        expect(focus.at(-1)).toBe('thread-1');
    });

    it('does not let a late upsert/adoption steal focus', () => {
        const { board } = mount();
        board.hydrate([turnRecord({ id: 'turn-1', index: 0, threadId: 'thread-1' })]);

        board.adopt(turnRecord({ id: 'turn-2', index: 1, threadId: 'thread-2' }));

        expect(board.focusedThread()).toBe('thread-1');
        expect(board.expanded()?.id()).toBe('turn-1');
    });

    it('respects a deliberate unfocus when new turns arrive', () => {
        const { board } = mount();
        board.hydrate([turnRecord({ id: 'turn-1', index: 0, threadId: 'thread-1' })]);
        board.collapse();
        expect(board.focusedThread()).toBeUndefined();

        board.reconcile([turnRecord({ id: 'turn-2', index: 1, threadId: 'thread-2' })]);

        expect(board.focusedThread()).toBeUndefined();
        expect(board.expanded()).toBeUndefined();
        expect(board.turns()[0].element.classList.contains('is-expanded')).toBe(false);
    });

    it('leaves an empty board unfocused after a failed submit is retired', () => {
        const { board } = mount();
        const failed = board.begin('fails', [], 'thread-1');
        failed.setState('error');
        expect(board.focusedThread()).toBe('thread-1');

        // A later snapshot describes another thread only: the terminal unbound tile
        // is retired and focus becomes empty — it is NOT transferred to thread-2.
        board.reconcile([turnRecord({ id: 'turn-2', index: 0, threadId: 'thread-2' })]);

        expect(board.focusedThread()).toBeUndefined();
        expect(board.expanded()).toBeUndefined();
    });

    it('opens the newest conversation of the session it switches TO', () => {
        const { board } = mount();
        board.bindSession('s1');
        board.hydrate([turnRecord({ id: 'turn-1', index: 0, threadId: 'thread-1' })]);

        // Switching sessions rebinds; the incoming snapshot replaces the transcript.
        board.bindSession('s2');
        board.reconcile([turnRecord({ id: 'turn-9', index: 0, threadId: 'thread-9' })]);

        expect(board.expanded()?.id()).toBe('turn-9');
        expect(board.focusedThread()).toBe('thread-9');
    });

    it('focuses the newest turn of the chosen thread', () => {
        const { board } = mount();
        board.hydrate([
            turnRecord({ id: 'turn-1', index: 0, threadId: 'thread-1' }),
            turnRecord({ id: 'turn-2', index: 1, threadId: 'thread-1' }),
            turnRecord({ id: 'turn-3', index: 2, threadId: 'thread-2' })
        ]);
        expect(board.focusedThread()).toBe('thread-2');

        expect(board.focusThread('thread-1')).toBe(true);
        expect(board.focusedThread()).toBe('thread-1');
        expect(board.expanded()?.id()).toBe('turn-2');
    });

    it('reports no focus for a legacy conversation and refuses an unknown thread', () => {
        const { board } = mount();
        board.hydrate([turnRecord({ id: 'turn-1', index: 0 })]);

        expect(board.expanded()?.id()).toBe('turn-1');
        expect(board.focusedThread()).toBeUndefined();

        expect(board.focusThread('thread-missing')).toBe(false);
        expect(board.expanded()?.id()).toBe('turn-1');
    });

    it('clears focus when the expanded conversation is collapsed', () => {
        const { board } = mount();
        board.hydrate([turnRecord({ id: 'turn-1', index: 0, threadId: 'thread-1' })]);

        expect(board.focusedThread()).toBe('thread-1');
        board.collapse();

        expect(board.focusedThread()).toBeUndefined();
        expect(board.expanded()).toBeUndefined();
    });

    it('discards an optimistic steering row and clears its focus', () => {
        const { board } = mount();
        board.hydrate([turnRecord({ id: 'turn-1', index: 0, threadId: 'thread-1' })]);
        const steering = board.begin('steer the running one', [], 'thread-1');
        expect(board.turns()).toHaveLength(2);

        board.discard(steering);

        expect(board.turns()).toHaveLength(1);
        expect(board.turns()[0].id()).toBe('turn-1');
        expect(steering.element.isConnected).toBe(false);
        expect(board.focusedThread()).toBeUndefined();
        expect(board.expanded()).toBeUndefined();
    });
});

describe('persistent child conversations (S2)', () => {
    // Writer delegates to helper: the child run is a nested invocation (`inv-9`)
    // that the roster joins to the persistent conversation `thread-child`.
    const delegationEvents = (extra: HarnessEvent[] = []): HarnessEvent[] => [
        { type: 'start', agent: 'writer', model: 'm1' } as HarnessEvent,
        {
            type: 'tool_call',
            agent: 'writer',
            call: { id: 'd1', name: 'agentDelegate', arguments: '{}' }
        } as HarnessEvent,
        { type: 'start', agent: 'helper', model: 'h1', thread: { id: 'inv-9' } } as unknown as HarnessEvent,
        ...extra
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

    it('focuses a roster-only child conversation and renders its transcript', () => {
        const { board } = mount();
        board.setThreads([
            threadEntry({ id: 'thread-root', sequence: 1 }),
            threadEntry({
                id: 'thread-child',
                sequence: 2,
                agent: 'helper',
                ownerThreadId: 'thread-root',
                messages: [{ role: 'assistant', content: 'child answer' }]
            })
        ]);
        board.hydrate([turnRecord({ id: 'turn-1', index: 0, threadId: 'thread-root' })]);

        expect(board.focusThread('thread-child')).toBe(true);

        expect(board.focusedThread()).toBe('thread-child');
        // Only ONE persistent conversation is open: the parent tile is collapsed.
        expect(board.expanded()).toBeUndefined();
        const panel = board.element.querySelector<HTMLElement>('.thread-focus-panel');
        expect(panel?.dataset.threadId).toBe('thread-child');
        expect(panel?.querySelector('.thread-focus-owner')?.textContent).toBe('owned by WR1');
        // Markdown rendering ends a paragraph with a newline; the text is exact.
        expect(panel?.querySelector('.thread-focus-text')?.textContent?.trim()).toBe('child answer');
    });

    it('targets the true persistent id when a nested child is clicked', () => {
        const { board } = mount();
        board.setThreads(roster());
        board.hydrate([
            turnRecord({
                id: 'turn-1',
                index: 0,
                threadId: 'thread-root',
                status: 'running',
                events: delegationEvents()
            })
        ]);

        const row = nestedRow(board.turns()[0]);
        expect(row?.dataset.persistentThread).toBe('thread-child');

        row?.querySelector<HTMLButtonElement>('.thread-select')?.click();

        expect(board.focusedThread()).toBe('thread-child');
        // The child conversation is the ONE expanded surface; the tile body is shut.
        expect(row?.classList.contains('is-expanded')).toBe(true);
        expect(row?.classList.contains('is-persistent-focused')).toBe(true);
        expect(board.expanded()).toBeUndefined();
        expect(board.turns()[0].element.classList.contains('is-expanded')).toBe(false);
    });

    it('keeps a focused child across snapshots that stream or add other threads', () => {
        const { board } = mount();
        board.setThreads(roster());
        board.hydrate([
            turnRecord({
                id: 'turn-1',
                index: 0,
                threadId: 'thread-root',
                status: 'running',
                events: delegationEvents()
            })
        ]);
        expect(board.focusThread('thread-child')).toBe(true);

        board.reconcile([
            turnRecord({
                id: 'turn-1',
                index: 0,
                threadId: 'thread-root',
                status: 'running',
                events: delegationEvents([{ type: 'text', agent: 'helper', delta: 'more' } as HarnessEvent])
            }),
            turnRecord({ id: 'turn-2', index: 1, threadId: 'thread-other' })
        ]);

        expect(board.focusedThread()).toBe('thread-child');
        expect(nestedRow(board.turns()[0])?.classList.contains('is-expanded')).toBe(true);
        expect(board.turns().find((turn) => turn.id() === 'turn-2')?.element.classList.contains('is-expanded')).toBe(
            false
        );
    });

    it('keeps exactly ONE persistent child conversation expanded', () => {
        const { board } = mount();
        const twoChildren = [
            threadEntry({ id: 'thread-root', sequence: 1 }),
            threadEntry({ id: 'thread-a', sequence: 2, agent: 'helper', invocationId: 'inv-a' }),
            threadEntry({ id: 'thread-b', sequence: 3, agent: 'helper', invocationId: 'inv-b' })
        ];
        board.setThreads(twoChildren);
        board.hydrate([
            turnRecord({
                id: 'turn-1',
                index: 0,
                threadId: 'thread-root',
                status: 'running',
                events: [
                    { type: 'start', agent: 'writer', model: 'm1' } as HarnessEvent,
                    {
                        type: 'tool_call',
                        agent: 'writer',
                        call: { id: 'a', name: 'agentDelegate', arguments: '{}' }
                    } as HarnessEvent,
                    { type: 'start', agent: 'helper', model: 'h1', thread: { id: 'inv-a' } } as unknown as HarnessEvent,
                    {
                        type: 'tool_call',
                        agent: 'writer',
                        call: { id: 'b', name: 'agentDelegate', arguments: '{}' }
                    } as HarnessEvent,
                    { type: 'start', agent: 'helper', model: 'h1', thread: { id: 'inv-b' } } as unknown as HarnessEvent
                ]
            })
        ]);

        const host = board.turns()[0].element.parentElement as HTMLElement | null;
        const rows = Array.from(host?.querySelectorAll<HTMLElement>('.thread-row') ?? []);
        expect(rows.map((row) => row.dataset.persistentThread)).toEqual(['thread-a', 'thread-b']);

        expect(board.focusThread('thread-a')).toBe(true);
        expect(rows[0].classList.contains('is-expanded')).toBe(true);

        expect(board.focusThread('thread-b')).toBe(true);
        expect(board.focusedThread()).toBe('thread-b');
        expect(rows[0].classList.contains('is-expanded')).toBe(false);
        expect(rows[1].classList.contains('is-expanded')).toBe(true);
    });

    it('focuses a continuation host turn created with the child id', () => {
        const { board } = mount();
        board.setThreads(roster());
        board.hydrate([turnRecord({ id: 'turn-1', index: 0, threadId: 'thread-root', events: delegationEvents() })]);

        board.reconcile([
            turnRecord({ id: 'turn-1', index: 0, threadId: 'thread-root', events: delegationEvents() }),
            // Continuing the child starts a real turn IN that conversation.
            turnRecord({ id: 'turn-2', index: 1, threadId: 'thread-child', status: 'running' })
        ]);

        expect(board.focusThread('thread-child')).toBe(true);

        expect(board.focusedThread()).toBe('thread-child');
        expect(board.expanded()?.id()).toBe('turn-2');
        expect(board.element.querySelector('.thread-focus-panel')).toBeNull();
    });

    it('opens the child card so the focused exchange is actually visible', () => {
        const { board } = mount();
        board.setThreads(roster());
        board.hydrate([turnRecord({ id: 'turn-1', index: 0, threadId: 'thread-root', events: delegationEvents() })]);

        board.reconcile([
            turnRecord({ id: 'turn-1', index: 0, threadId: 'thread-root', events: delegationEvents() }),
            turnRecord({ id: 'turn-2', index: 1, threadId: 'thread-child', status: 'running' })
        ]);

        // The continuation lives INSIDE the child's own card (ui/turns.ts placeTurn).
        const card = board.element.querySelector<HTMLElement>('.thread-row[data-persistent-thread="thread-child"]');
        const exchange = card?.querySelector<HTMLElement>('.thread-flow > .turn-row');
        expect(exchange?.dataset.threadExchange).toBe('thread-child');
        expect(card?.classList.contains('is-expanded')).toBe(false);

        expect(board.focusThread('thread-child')).toBe(true);
        // The card and the exchange are opened together: an "expanded" turn hidden by
        // a collapsed ancestor body would be an invisible focus.
        expect(card?.classList.contains('is-expanded')).toBe(true);
        expect(card?.querySelector<HTMLButtonElement>('.thread-select')?.getAttribute('aria-expanded')).toBe('true');
        expect(exchange?.querySelector('.tile')?.classList.contains('is-expanded')).toBe(true);

        // Moving the focus closes the card THIS focus opened (one surface at a time).
        board.expand(board.turns()[0]);
        expect(card?.classList.contains('is-expanded')).toBe(false);
        expect(board.focusedThread()).toBe('thread-root');
    });

    it('drops focus-owned expansion when the board is cleared (F2)', () => {
        const { board } = mount();
        board.setThreads(roster());
        board.hydrate([turnRecord({ id: 'turn-1', index: 0, threadId: 'thread-root', events: delegationEvents() })]);
        board.reconcile([
            turnRecord({ id: 'turn-1', index: 0, threadId: 'thread-root', events: delegationEvents() }),
            turnRecord({ id: 'turn-2', index: 1, threadId: 'thread-child', status: 'running' })
        ]);

        board.focusThread('thread-child');
        const card = board.element.querySelector<HTMLElement>('.thread-row[data-persistent-thread="thread-child"]');
        expect(card?.classList.contains('is-expanded')).toBe(true);

        // `clear` is the one teardown that does not run `detachTileExpansion`, so it has
        // to drop the focus-owned expansion itself instead of keeping the opened rows.
        board.clear();
        expect(board.expanded()).toBeUndefined();
        expect(board.element.querySelectorAll('.conversation')).toHaveLength(0);

        // The NEXT board starts closed: no expansion leaks across the teardown, and the
        // same child can be focused again from scratch.
        board.setThreads(roster());
        board.hydrate([turnRecord({ id: 'turn-1', index: 0, threadId: 'thread-root', events: delegationEvents() })]);
        const fresh = board.element.querySelector<HTMLElement>('.thread-row[data-persistent-thread="thread-child"]');
        expect(fresh?.classList.contains('is-expanded')).toBe(false);

        expect(board.focusThread('thread-child')).toBe(true);
        expect(fresh?.classList.contains('is-expanded')).toBe(true);
    });

    it('drops the focus when the roster no longer describes the child', () => {
        const { board } = mount();
        board.setThreads(roster());
        board.hydrate([
            turnRecord({
                id: 'turn-1',
                index: 0,
                threadId: 'thread-root',
                status: 'running',
                events: delegationEvents()
            })
        ]);
        board.focusThread('thread-child');

        board.setThreads([threadEntry({ id: 'thread-root', sequence: 1 })]);

        expect(board.focusedThread()).toBeUndefined();
        expect(nestedRow(board.turns()[0])?.classList.contains('is-expanded')).toBe(false);
    });
});

describe('label seeds (deletion must not renumber blocks)', () => {
    const started = (): SessionTurn =>
        turnRecord({
            id: 'turn-2',
            index: 1,
            threadId: 'thread-2',
            events: [{ type: 'start', agent: 'writer', model: 'm1' }]
        });

    it('replays a turn from its recorded seed when an earlier turn is gone', () => {
        const board = createTurnBoard();
        document.body.replaceChildren(board.element);

        board.hydrate([started()], { labelSeeds: { 'turn-2': { WR: 2 } } });

        expect(board.turns()[0].element.querySelector('.tile-agent')?.textContent).toBe('WR3');
    });

    it('falls back to conversation counters when the server sends no seed', () => {
        const board = createTurnBoard();
        document.body.replaceChildren(board.element);

        board.hydrate([started()]);

        expect(board.turns()[0].element.querySelector('.tile-agent')?.textContent).toBe('WR1');
    });
});

describe('composerStopOf', () => {
    it('shows the separate stop-all only while work is pending and the action is not stop', () => {
        expect(composerStopOf('submit', true)).toBe(true);
        expect(composerStopOf('submit', false)).toBe(false);
        expect(composerStopOf('stop', true)).toBe(false);
        expect(composerStopOf('none', true)).toBe(true);
        expect(composerStopOf('none', false)).toBe(false);
    });
});

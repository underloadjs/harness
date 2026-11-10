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
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/turns-navigation.test.ts

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

afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
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

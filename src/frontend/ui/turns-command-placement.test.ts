// C8-M1 — WHERE a command card is placed, live and after a reload.
//
// A server command turn is THREAD-LESS: `executeCommandTurn`
// (src/server/sessions.ts) records no `threadId`, because a command acts on the
// SESSION (its task list, its tool registry) and never joins a conversation. The
// composer still submits the line through the ordinary `/tasks` path
// (src/frontend/main.ts line ~7087 `instance.view.begin(prompt, validated,
// target.threadId)`), so the optimistic tile is created WITH the focused
// conversation's id.
//
// `setThreadId` is deliberately additive — a record that omits `threadId` keeps the
// draft binding, because the composer must keep steering the conversation the reader
// focused (that is the contract pinned in ui/thread-focus.test.ts line 116) — so the
// tile kept naming the focused thread, and `placeTurn` routed the ROW by it. The
// command card therefore appeared INSIDE the focused conversation while it was live,
// moved to board level on the next reload, and after the conversation was deleted the
// orphaned card was the only thing keeping that conversation's container on the board.
//
// The fix is placement authority: `placeTurn` reads the thread from the bound source
// record (`turn.source()`), falling back to the runtime/draft thread only for an
// UNBOUND optimistic tile (ui/turns.ts `placementThreadIdOf`).
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/turns-command-placement.test.ts

import { describe, expect, it } from 'vitest';
import type { SessionTurn } from '../../server/protocol';
import { createTurnBoard } from './turns';
import type { TurnHandle } from './turns';
import type { SessionThreadEntry } from './threads';

const T = 1_700_000_000_000;
const INPUT = '/task add ship the release';
const ANSWER = '1. ship the release (pending)';

const threadEntry = (overrides: Partial<SessionThreadEntry> & { id: string }): SessionThreadEntry => ({
    agent: 'writer',
    origin: 'host',
    status: 'idle',
    sequence: 1,
    ...overrides
});

// A normal (model) turn of the focused conversation: it owns `threadId`, so it is the
// card the command must NOT end up inside.
const modelTurn = (overrides: Partial<SessionTurn> = {}): SessionTurn => ({
    id: 'turn-model',
    index: 0,
    prompt: 'write the release notes',
    status: 'done',
    threadId: 'thread-1',
    startedAt: T,
    updatedAt: T + 20,
    events: [{ type: 'start', agent: 'writer', model: 'm1' }],
    eventTimes: [T],
    ...overrides
});

// Byte-for-byte the record a command produces (sessions.ts `executeCommandTurn`):
// terminal, and NO `threadId`.
const commandTurn = (overrides: Partial<SessionTurn> = {}): SessionTurn => ({
    id: 'turn-command',
    index: 1,
    prompt: INPUT,
    status: 'done',
    startedAt: T + 30,
    updatedAt: T + 42,
    events: [
        { type: 'start', agent: 'writer', model: 'm1' },
        {
            type: 'tool_call',
            agent: 'writer',
            call: { id: 'call-1', name: 'command', arguments: JSON.stringify({ input: INPUT }) }
        },
        {
            type: 'tool_result',
            agent: 'writer',
            name: 'command',
            callId: 'call-1',
            content: ANSWER,
            isError: false,
            outcome: 'completed'
        }
    ],
    eventTimes: [T + 30, T + 34, T + 42],
    ...overrides
});

const mount = () => {
    const board = createTurnBoard({});
    document.body.replaceChildren(board.element);

    return board;
};

// The one assertion this file is about: WHICH surface holds a tile's row. 'board' is
// the top-level flow (a thread-less turn's own row), otherwise the id of the
// `.conversation` container that holds it.
const placementOf = (board: ReturnType<typeof createTurnBoard>, tile: HTMLElement): string => {
    const row = tile.parentElement as HTMLElement;

    if (row.parentElement === board.element) return 'board';

    const host = row.closest<HTMLElement>('.conversation');

    return host === null ? 'detached' : (host.dataset.threadId ?? 'unnamed-host');
};

// The rows one conversation container holds, in DOM order (by turn id).
const rowsOf = (threadId: string): string[] =>
    [...document.querySelectorAll<HTMLElement>(`.conversation[data-thread-id="${threadId}"] .turn-row .tile`)].map(
        (tile) => tile.dataset.turnId ?? 'unbound'
    );

// A board with ONE conversation card holding one recorded model turn.
const focusedConversation = () => {
    const board = mount();
    board.setThreads([threadEntry({ id: 'thread-1', label: 'Release notes' })]);
    const [conversation] = board.hydrate([modelTurn()]);

    return { board, conversation: conversation as TurnHandle };
};

describe('command tile placement (C8-M1)', () => {
    it('keeps the optimistic tile in its draft thread until a record binds it', () => {
        const { board } = focusedConversation();

        // Unbound optimistic submit addressed to the focused conversation: the draft
        // thread IS the placement, so a follow-up joins the same card immediately.
        const optimistic = board.begin('a follow-up', [], 'thread-1');
        expect(placementOf(board, optimistic.element)).toBe('thread-1');
        expect(optimistic.threadId()).toBe('thread-1');

        // Its own record confirms the same thread, so nothing moves.
        optimistic.merge(modelTurn({ id: 'turn-2', index: 1, prompt: 'a follow-up' }), 'm1');
        expect(placementOf(board, optimistic.element)).toBe('thread-1');
        expect(rowsOf('thread-1')).toEqual(['turn-model', 'turn-2']);
    });

    it('moves a live command card to board level when its thread-less record is merged (ack)', () => {
        const { board, conversation } = focusedConversation();
        expect(placementOf(board, conversation.element)).toBe('thread-1');

        // `main.ts run()`: the tile begins in the focused conversation, then the 202
        // record (already terminal for a command) is merged into it.
        const command = board.begin(INPUT, [], 'thread-1');
        expect(placementOf(board, command.element)).toBe('thread-1');

        command.merge(commandTurn(), 'm1');

        // The record says "no conversation", so the card belongs to the board — the
        // exact placement the same record produces on a reload.
        expect(placementOf(board, command.element)).toBe('board');
        expect(command.element.parentElement?.parentElement).toBe(board.element);

        // The conversation card keeps only its own exchange.
        expect(rowsOf('thread-1')).toEqual(['turn-model']);
        expect(command.state()).toBe('done');
    });

    it('keeps a command card at board level through the observer snapshot (frames)', () => {
        const { board, conversation } = focusedConversation();

        const command = board.begin(INPUT, [], 'thread-1');
        command.merge(commandTurn(), 'm1');
        expect(placementOf(board, command.element)).toBe('board');

        // Every later reconcile re-places from the SAME authority, so the card cannot
        // drift back into the conversation.
        const settled = board.reconcile([modelTurn(), commandTurn()], { model: 'm1' });

        expect(settled).toHaveLength(2);
        expect(placementOf(board, conversation.element)).toBe('thread-1');
        expect(placementOf(board, command.element)).toBe('board');
        expect(rowsOf('thread-1')).toEqual(['turn-model']);
    });

    it('places the same command at board level on reload (hydrate) as live', () => {
        const { board, conversation } = focusedConversation();
        const command = board.begin(INPUT, [], 'thread-1');
        command.merge(commandTurn(), 'm1');

        const live = placementOf(board, command.element);

        // A reload rebuilds both tiles from records; the placement must not change.
        const [reloadedConversation, reloadedCommand] = board.hydrate([modelTurn(), commandTurn()], {
            model: 'm1'
        });

        expect(live).toBe('board');
        expect(placementOf(board, reloadedConversation.element)).toBe('thread-1');
        expect(placementOf(board, reloadedCommand.element)).toBe(live);
    });

    it('does not leave a command card holding a deleted conversation open', () => {
        const { board, conversation } = focusedConversation();

        const command = board.begin(INPUT, [], 'thread-1');
        command.merge(commandTurn(), 'm1');

        // The conversation is deleted: its roster entry and its turn are both gone, so
        // the snapshot now lists ONLY the command record.
        board.setThreads([]);
        board.reconcile([commandTurn()], { model: 'm1' });

        // The conversation's tile is gone with its thread (the row is detached too).
        expect(document.contains(conversation.element)).toBe(false);

        // The deleted conversation's card is off the board — the surviving command card
        // must not be the thing keeping it alive.
        expect(document.querySelector('.conversation[data-thread-id="thread-1"]')).toBeNull();
        expect(document.querySelectorAll('.conversation')).toHaveLength(0);
        expect(placementOf(board, command.element)).toBe('board');
        expect(board.turns().map((turn) => turn.id())).toEqual(['turn-command']);
    });
});

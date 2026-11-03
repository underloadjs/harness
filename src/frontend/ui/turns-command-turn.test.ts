// C6 — a SERVER COMMAND turn renders as a tool card, on every path.
//
// `SessionStore.dispatch()` (src/server/sessions.ts `executeCommandTurn`) turns one
// slash line into a normal `SessionTurn` whose events are SYNTHESIZED, not streamed:
//
//   start(agent, model)
//   tool_call(agent, call: { id, name: 'command', arguments: JSON.stringify({ input }) })
//   tool_result(agent, name: 'command', callId, content, isError, outcome)
//
// with `status: 'done'` (or `'error'` when the command refused), NO `text`, NO `done`
// event, NO `usage` and NO `threadId`. Nothing in the frontend was written for that
// combination, so this file pins the two render paths a command actually arrives on:
//
//   1. `hydrate` — the reload/poll path (`applySnapshot` → `board.reconcile`), where the
//      record is already terminal and every event is replayed from `events`;
//   2. `merge` — the live submit path (`main.ts run()` binds the optimistic tile to the
//      POST /tasks answer, which for a command is ALREADY settled).
//
// Both must produce ONE settled tool card named `command` carrying the command's answer,
// with the tile reading `done`. The failure modes this rules out: a command drawn as an
// error (because no `done`/assistant text landed), and a command drawn as a blank tile
// (because an empty `arguments`/`content` collapsed the card away).
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/turns-command-turn.test.ts

import { describe, expect, it } from 'vitest';
import type { SessionTurn } from '../../server/protocol';
import { createTurnBoard } from './turns';

const T = 1_700_000_000_000;
const INPUT = '/task add ship the release';
const ANSWER = '1. ship the release (pending)';

// Byte-for-byte the record the store publishes (sessions.ts lines 3364-3477): the
// command line rides INSIDE the tool-call arguments JSON, because
// `HarnessToolCall.arguments` is a raw JSON string on the wire.
const commandTurn = (overrides: Partial<SessionTurn> = {}): SessionTurn => ({
    id: 'turn-command',
    index: 0,
    prompt: INPUT,
    status: 'done',
    startedAt: T,
    updatedAt: T + 12,
    events: [
        { type: 'start', agent: 'instruct', model: 'm1' },
        {
            type: 'tool_call',
            agent: 'instruct',
            call: { id: 'call-1', name: 'command', arguments: JSON.stringify({ input: INPUT }) }
        },
        {
            type: 'tool_result',
            agent: 'instruct',
            name: 'command',
            callId: 'call-1',
            content: ANSWER,
            isError: false,
            outcome: 'completed'
        }
    ],
    eventTimes: [T, T + 4, T + 12],
    ...overrides
});

const mount = () => {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const board = createTurnBoard({ empty });
    document.body.replaceChildren(board.element);
    return { board, empty };
};

// The one card a command must produce: `details.tool` (the same surface a real tool
// call uses, ui/tools.ts), settled, named `command`.
const cardOf = (element: HTMLElement): Element | null =>
    element.querySelector('details.tool:not(.think)');

describe('server command turn', () => {
    it('replays a recorded command turn as a settled tool card, not an error or a blank tile', () => {
        const { board } = mount();
        const [turn] = board.hydrate([commandTurn()]);

        // The tile exists and reads its recorded terminal state — the record IS `done`,
        // and the absence of a `done` EVENT must not downgrade it to `error`.
        expect(turn).toBeDefined();
        expect(turn.element.dataset.state).toBe('done');
        expect(turn.element.querySelector('.tile-status-text')?.textContent).toBe('done');
        expect(turn.element.querySelector('.tile-prompt')?.textContent).toBe(INPUT);

        // One card, settled, named after the synthesized tool.
        const card = cardOf(turn.element);
        expect(card).not.toBeNull();
        expect(turn.element.querySelectorAll('details.tool:not(.think)')).toHaveLength(1);
        expect(card?.getAttribute('data-state')).toBe('ok');
        expect(card?.querySelector('.tool-name')?.textContent).toBe('command');
        expect(card?.querySelector('.tool-state')?.textContent).toBe('ok');

        // The command's ANSWER is the card body, and its arguments still carry the line
        // that produced it — neither is blank. The two panes are the tool card's own
        // code views, in card order: `arguments` then `result` (ui/tools.ts).
        const panes = [...(card?.querySelectorAll<HTMLElement>('.tool-body .tool-code code') ?? [])];
        expect(panes.map((pane) => pane.textContent)).toEqual([
            JSON.stringify({ input: INPUT }, null, 2),
            ANSWER
        ]);

        // The board's own tally agrees: one tool, one agent, nothing failed.
        expect(turn.summary()).toEqual({ agents: 1, tools: 1, primary: 'instruct' });
    });

    it('binds the optimistic submit tile to the settled command record (POST /tasks answer)', () => {
        const { board } = mount();

        // `main.ts run()`: the composer begins a tile, then `merge`s the POST answer.
        // For a command that answer is already terminal, so the queued tile must become
        // the settled card in place — not a second row, and not an error state.
        const turn = board.begin(INPUT);
        expect(turn.element.dataset.state).toBe('queued');

        turn.merge(commandTurn(), 'm1');

        expect(turn.element.dataset.state).toBe('done');
        expect(turn.element.querySelector('.tile-status-text')?.textContent).toBe('done');
        expect(cardOf(turn.element)?.getAttribute('data-state')).toBe('ok');
        expect(cardOf(turn.element)?.querySelector('.tool-name')?.textContent).toBe('command');
        expect(cardOf(turn.element)?.querySelector('.tool-result code')?.textContent).toBe(ANSWER);
        // No assistant answer was generated, so no answer block is invented.
        expect(turn.element.querySelector('.agent-text')).toBeNull();
        expect(board.turns()).toEqual([turn]);
    });

    it('draws a refused command as a failed card with the error status the store recorded', () => {
        // `/task bogus` answers `{ content, isError: true }`, and the store then records
        // the TURN as `error` too. The card must show the refusal, and the tile must not
        // claim success — this is the state a user typo lands in.
        const { board } = mount();
        const refused = commandTurn({
            id: 'turn-command-refused',
            prompt: '/task bogus',
            status: 'error',
            events: [
                { type: 'start', agent: 'instruct', model: 'm1' },
                {
                    type: 'tool_call',
                    agent: 'instruct',
                    call: { id: 'call-2', name: 'command', arguments: JSON.stringify({ input: '/task bogus' }) }
                },
                {
                    type: 'tool_result',
                    agent: 'instruct',
                    name: 'command',
                    callId: 'call-2',
                    content: 'unknown action "bogus"',
                    isError: true,
                    outcome: 'failed'
                }
            ]
        });

        const [turn] = board.hydrate([refused]);

        expect(turn.element.dataset.state).toBe('error');
        expect(turn.element.querySelector('.tile-status-text')?.textContent).toBe('error');
        expect(cardOf(turn.element)?.getAttribute('data-state')).toBe('error');
        expect(cardOf(turn.element)?.querySelector('.tool-result code')?.textContent).toBe(
            'unknown action "bogus"'
        );
    });
});

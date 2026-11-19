// C2 (R4/AC1/AC2): a settled or reloaded ROOT card whose answer was recorded is
// rendered ANSWERED — never "expired", and never "Auto-answered by the owner fork".
//
// The screenshot symptom lives on the COMPILED plane: the tile was settled, the step
// carried `action.answered` (the "answered · <option>" notice below the card proves the
// fold applied it), yet the card above it read
//   "This question expired when the turn ended."  +  "Auto-answered by the owner fork."
// Two independent mistakes in `mountActionCard` / `createActionRequestCard`:
//   - `expired` was passed from the TURN's state, ignoring the step's own answer (Bug 2);
//   - the owner-fork note was derived from `!interactive`, which is true for a settled
//     root card as well — provenance is which FLOW asked, not whether the turn ended (Bug 1).
//
// Every value asserted here is the exact text/state a reader sees. The display tree is
// the SERVER's own fold (`../../server/turn-projector`), so the card is driven by the
// same compiled bytes a reload receives.

import { agent, harness } from '../../harness';
import { projectTurn } from '../../server/turn-projector';
import type { SessionTurn } from '../../server/protocol';
import type { DisplayProjectContext } from '../../shared/turn-display';
import type { HarnessActionAnswer, HarnessActionRequest } from '../../types';
import { createActionRequestCard } from './action-request';
import { createTurnBoard } from './turns';

const CONTEXT: DisplayProjectContext = { entry: 'worker' };

const REQUEST: HarnessActionRequest = {
    requestId: 'req-1',
    question: 'Which path should I take?',
    recommended: 'a',
    options: [
        { id: 'a', label: 'Path A', description: 'The recommended path' },
        { id: 'b', label: 'Path B' }
    ],
    allowCustom: true
};

const requestEvent = (requestId = 'req-1') => ({
    type: 'action_request',
    agent: 'worker',
    callId: 'call-1',
    request: { ...REQUEST, requestId }
});

const answerEvent = (requestId: string, optionId: string, source: 'owner' | 'auto' = 'owner') => ({
    type: 'action_answer',
    agent: 'worker',
    requestId,
    answer: { requestId, choice: { kind: 'option', optionId }, source }
});

// A RECORDED turn: exactly what a reload/re-fold hands the board and the fold.
const recordOf = (events: unknown[], status: SessionTurn['status'] = 'done'): SessionTurn =>
    ({
        id: 'turn-1',
        index: 0,
        prompt: 'ask the owner',
        status,
        startedAt: 1,
        updatedAt: 2,
        events,
        eventTimes: events.map((_event, index) => index + 1)
    }) as SessionTurn;

// A board tile standing in for a settled, reloaded conversation.
const settledTile = () => {
    const board = createTurnBoard({});
    document.body.replaceChildren(board.element);
    board.bindSession('s1');

    const turn = board.adopt(recordOf([], 'done'));
    board.expand(turn);

    return { board, turn };
};

const cardOf = (turn: ReturnType<typeof settledTile>['turn']): HTMLElement => {
    const card = turn.element.querySelector<HTMLElement>('.action-request');

    if (card === null) throw new Error('no action card was painted');

    return card;
};

describe('a settled/reloaded root card with a recorded answer (R4)', () => {
    it('renders the human answer instead of the turn-end expiry or the owner-fork note', () => {
        const { turn } = settledTile();

        // The server fold for a request the human answered. The id is NOT in the
        // expiry set — that exclusion is pinned in
        // ../server/actions-answer-expiry.test.ts (C2/R5).
        turn.renderDisplay(projectTurn(recordOf([requestEvent(), answerEvent('req-1', 'a')]), CONTEXT).display);

        const card = cardOf(turn);

        expect(card.dataset.state).toBe('answered');
        expect(card.querySelector('.action-status')?.textContent).toBe('Answered: Path A');
        // R4: neither mislabel survives.
        expect(card.querySelector('.action-status')?.textContent).not.toContain('expired');
        expect(card.querySelector('.action-note')).toBeNull();
        // A settled root question keeps its read-only anatomy: no live controls.
        expect(card.querySelector('.action-submit')).toBeNull();
    });

    it('stays answered across a re-fold of the same settled turn', () => {
        const { turn } = settledTile();
        const record = recordOf([requestEvent(), answerEvent('req-1', 'b')]);

        turn.renderDisplay(projectTurn(record, CONTEXT).display);
        expect(cardOf(turn).dataset.state).toBe('answered');

        // The re-paint re-reads the same tree (a poll/reconcile after the reload).
        turn.renderDisplay(projectTurn(record, CONTEXT).display);

        const card = cardOf(turn);
        expect(card.dataset.state).toBe('answered');
        expect(card.querySelector('.action-status')?.textContent).toBe('Answered: Path B');
        expect(card.querySelector('.action-note')).toBeNull();
    });

    it('still marks a settled root question with NO answer expired (R6)', () => {
        const { turn } = settledTile();

        turn.renderDisplay(
            projectTurn(recordOf([requestEvent()]), CONTEXT).display
        );

        const card = cardOf(turn);
        expect(card.dataset.state).toBe('expired');
        // The card opens with the turn-end reason (mount, settled + no answer) and the
        // SERVER-flag branch then restates it (`paintCompiledAction`: the fold settles an
        // unanswered running step, so `action.expired` is true for a `done` record). The
        // server's reason wins because it is the authority on answerability.
        expect(card.querySelector('.action-status')?.textContent).toBe(
            'This question can no longer be answered.'
        );
        // R4: a root question is never credited to a fork, expired or not.
        expect(card.querySelector('.action-note')).toBeNull();
    });

    it('renders a custom (free-text) answer verbatim, never as expired (R6)', () => {
        const { turn } = settledTile();
        const custom = {
            type: 'action_answer',
            agent: 'worker',
            requestId: 'req-1',
            answer: { requestId: 'req-1', choice: { kind: 'custom', text: 'Take path C' }, source: 'owner' }
        };

        turn.renderDisplay(projectTurn(recordOf([requestEvent(), custom]), CONTEXT).display);

        const card = cardOf(turn);
        expect(card.dataset.state).toBe('answered');
        expect(card.querySelector('.action-status')?.textContent).toBe('Answered: Take path C');
        expect(card.querySelector('.action-note')).toBeNull();
    });

    it('expires an answered card honestly on the raw event plane too', () => {
        // A reload that replays the EVENTS (the raw path) must land on the same answer,
        // and the fork note must not appear for a root question.
        const board = createTurnBoard({});
        document.body.replaceChildren(board.element);
        board.bindSession('s1');

        const turn = board.adopt(recordOf([requestEvent(), answerEvent('req-1', 'a')]));
        const card = cardOf(turn);

        expect(card.dataset.state).toBe('answered');
        expect(card.querySelector('.action-status')?.textContent).toBe('Answered: Path A');
        expect(card.querySelector('.action-note')).toBeNull();
    });
});

describe('the owner-fork note is provenance, never turn state (AC2)', () => {
    const answer: HarnessActionAnswer = {
        requestId: 'req-1',
        choice: { kind: 'option', optionId: 'b' },
        source: 'auto'
    };

    // A card is a handle, not an element: every DOM read below goes through `card.element`.
    it('states the owner fork only for a child (non-root) request', () => {
        const card = createActionRequestCard({ request: REQUEST, interactive: false, forkAnswered: true });
        document.body.replaceChildren(card.element);

        expect(card.element.querySelector('.action-note')?.textContent).toBe(
            'Auto-answered by the owner fork.'
        );
        expect(card.state()).toBe('pending');
    });

    it('keeps the fork note for a genuinely fork-answered child request', () => {
        const card = createActionRequestCard({
            request: REQUEST,
            interactive: false,
            forkAnswered: true,
            answer
        });
        document.body.replaceChildren(card.element);

        expect(card.element.dataset.state).toBe('answered');
        expect(card.element.querySelector('.action-status')?.textContent).toBe('Auto-answered: Path B');
        expect(card.element.querySelector('.action-note')?.textContent).toBe(
            'Auto-answered by the owner fork.'
        );
    });

    it('never notes the owner fork for a root request, settled or answered', () => {
        // THE screenshot case: a settled ROOT card (`interactive:false` because the turn
        // ended) whose recorded answer came from the human.
        const card = createActionRequestCard({
            request: REQUEST,
            interactive: false,
            answer: { ...answer, source: 'owner' }
        });
        document.body.replaceChildren(card.element);

        expect(card.element.dataset.state).toBe('answered');
        expect(card.element.querySelector('.action-status')?.textContent).toBe('Answered: Path B');
        expect(card.element.querySelector('.action-note')).toBeNull();
        // The read-only marker still follows interactivity, not provenance.
        expect(card.element.dataset.readonly).toBe('true');
    });

    it('retires the fork note when a later answer names the owner', () => {
        const card = createActionRequestCard({ request: REQUEST, interactive: false, forkAnswered: true });
        document.body.replaceChildren(card.element);
        expect(card.element.querySelector('.action-note')).not.toBeNull();

        card.setAnswer({ ...answer, source: 'owner' });

        expect(card.element.querySelector('.action-note')).toBeNull();
        expect(card.element.querySelector('.action-status')?.textContent).toBe('Answered: Path B');
    });

    it('never notes the owner fork on a live interactive root card', () => {
        const card = createActionRequestCard({ request: REQUEST, interactive: true });
        document.body.replaceChildren(card.element);

        expect(card.element.querySelector('.action-note')).toBeNull();
        expect(card.element.querySelector('.action-submit')).not.toBeNull();
        expect(card.element.dataset.state).toBe('pending');
    });

    it('an expired card never regresses once the answer arrives (R4)', () => {
        const card = createActionRequestCard({
            request: REQUEST,
            interactive: false,
            expired: 'This question expired when the turn ended.'
        });
        document.body.replaceChildren(card.element);
        expect(card.element.dataset.state).toBe('expired');

        card.setAnswer({ ...answer, source: 'owner' });

        expect(card.element.dataset.state).toBe('answered');
        expect(card.element.querySelector('.action-status')?.textContent).toBe('Answered: Path B');
    });
});

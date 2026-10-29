// Turn-board interaction/branch wiring (N3 / A1/A3/A4).
//
// The board is the only place the event stream becomes an answerable card or a
// branch row:
//   - a ROOT action_request is interactive; a NON-ROOT one (any thread) is
//     read-only because its immediate owner answers automatically;
//   - action_answer is authoritative and resolves the card (owner or auto);
//   - a settled turn / session switch expires an unresolved question, while a
//     done-with-pending scheduler pause keeps it answerable;
//   - fork/autoanswer branch events reuse the existing nested block anatomy and
//     add only a tiny kind tag;
//   - the answer callback carries the captured requestId/choice/sessionId.

import type { HarnessAssistantMessage, HarnessEvent, SessionTurn } from '../../server/protocol';
import type { HarnessActionAnswer, HarnessActionChoice, HarnessActionRequest } from '../../types';
import { createTurnBoard } from './turns';
import type { AnswerActionInput, TurnHandle } from './turns';

const actionRequest = (overrides: Partial<HarnessActionRequest> = {}): HarnessActionRequest => ({
    requestId: 'req-1',
    question: 'Which file should I read?',
    recommended: 'b',
    options: [
        { id: 'a', label: 'Alpha' },
        { id: 'b', label: 'Beta' }
    ],
    allowCustom: true,
    ...overrides
});

const requestEvent = (
    overrides: Partial<Extract<HarnessEvent, { type: 'action_request' }>> = {}
): HarnessEvent => ({
    type: 'action_request',
    agent: 'writer',
    callId: 'call-1',
    request: actionRequest(),
    ...overrides
});

const answerEvent = (answer: HarnessActionAnswer, agent = 'writer'): HarnessEvent => ({
    type: 'action_answer',
    agent,
    requestId: answer.requestId,
    answer
});

const doneMessage = (): HarnessAssistantMessage => ({
    role: 'assistant',
    content: '',
    reasoning: '',
    toolCalls: [],
    model: 'm1',
    stopReason: 'stop'
});

const serverTurn = (
    options: {
        status?: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
        events?: HarnessEvent[];
    } = {}
): SessionTurn => ({
    id: 'turn-1',
    index: 0,
    prompt: 'task',
    status: options.status ?? 'running',
    startedAt: 5,
    updatedAt: 10,
    events: options.events ?? []
});

const mount = () => {
    const board = createTurnBoard({});
    document.body.replaceChildren(board.element);
    return board;
};

const cardOf = (turn: TurnHandle): HTMLElement =>
    turn.element.querySelector<HTMLElement>('.action-request') as HTMLElement;

const startRoot = (turn: TurnHandle): void => {
    turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
};

describe('action cards in the turn board', () => {
    it('mounts an interactive root question and resolves it from action_answer', () => {
        const board = mount();
        board.bindSession('s1');
        const turn = board.begin('task');
        startRoot(turn);
        turn.apply(requestEvent());

        const card = cardOf(turn);
        expect(card.dataset.state).toBe('pending');
        expect(card.dataset.readonly).toBeUndefined();
        expect(card.querySelector('.action-submit')).not.toBeNull();
        expect(card.querySelector('.action-option-label')?.textContent).toBe('Beta');

        turn.apply(
            answerEvent({
                requestId: 'req-1',
                choice: { kind: 'option', optionId: 'a' },
                source: 'owner'
            })
        );

        expect(card.dataset.state).toBe('answered');
        expect(card.querySelector('.action-status')?.textContent).toBe('Answered: Alpha');
    });

    it('routes a human choice with the request id, choice and bound session', async () => {
        const sent: AnswerActionInput[] = [];
        const board = createTurnBoard({
            answerAction: async (input) => {
                sent.push(input);
            }
        });
        document.body.replaceChildren(board.element);
        board.bindSession('session-1');

        const turn = board.begin('task');
        startRoot(turn);
        turn.apply(requestEvent());

        const card = cardOf(turn);
        card.querySelector<HTMLInputElement>('input[value="b"]')?.click();
        card.querySelector<HTMLButtonElement>('.action-submit')?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(sent).toEqual([
            {
                requestId: 'req-1',
                choice: { kind: 'option', optionId: 'b' },
                sessionId: 'session-1'
            } satisfies AnswerActionInput
        ]);
        expect(card.dataset.state).toBe('answered');
    });

    it('makes a non-root request read-only regardless of thread kind', () => {
        const board = mount();
        const turn = board.begin('task');
        startRoot(turn);
        turn.apply(
            requestEvent({
                agent: 'helper',
                callId: 'call-2',
                thread: { id: 'child-1', kind: 'autoanswer', branchId: 'branch-1' }
            })
        );

        const card = turn.element.parentElement?.querySelector<HTMLElement>(
            '.thread-row .action-request'
        ) as HTMLElement;
        expect(card).not.toBeNull();
        expect(card.dataset.readonly).toBe('true');
        expect(card.querySelector('.action-submit')).toBeNull();
        expect(card.querySelector('.action-radio')).toBeNull();
        expect(card.querySelector('.action-status')?.textContent).toBe(
            'Waiting for the automatic owner answer…'
        );

        turn.apply(
            answerEvent(
                {
                    requestId: 'req-1',
                    choice: { kind: 'option', optionId: 'b' },
                    source: 'auto',
                    branchId: 'branch-1'
                },
                'helper'
            )
        );
        expect(card.dataset.state).toBe('answered');
        expect(card.querySelector('.action-status')?.textContent).toBe('Auto-answered: Beta');
    });

    it('keeps a done-with-pending pause answerable but expires a settled turn', () => {
        const live = mount();
        const turn = live.begin('task');
        startRoot(turn);
        turn.apply(requestEvent());
        turn.apply({
            type: 'done',
            agent: 'writer',
            message: doneMessage(),
            pending: [{ callId: 'call-9', name: 'fileRead', elapsedMs: 25 }]
        });
        expect(cardOf(turn).dataset.state).toBe('pending');

        // A recorded terminal turn replays the same request but has no live turn to
        // answer: the card is rendered expired (A4).
        const historical = mount();
        historical.bindSession('s1');
        const adopted = historical.adopt(
            serverTurn({
                status: 'done',
                events: [requestEvent()]
            })
        );
        expect(cardOf(adopted).dataset.state).toBe('expired');
        expect(cardOf(adopted).querySelector('.action-status')?.textContent).toBe(
            'This question expired when the turn ended.'
        );

        // A RUNNING recorded turn is the one replay where the pending card is real.
        const running = mount();
        running.bindSession('s1');
        const liveRecord = running.adopt(
            serverTurn({
                status: 'running',
                events: [requestEvent()]
            })
        );
        expect(cardOf(liveRecord).dataset.state).toBe('pending');
    });

    it('expires an unresolved question when the session changes', () => {
        const board = mount();
        board.bindSession('s1');
        const turn = board.begin('task');
        startRoot(turn);
        turn.apply(requestEvent());

        board.bindSession('s2');

        const card = cardOf(turn);
        expect(card.dataset.state).toBe('expired');
        expect(card.querySelector('.action-status')?.textContent).toBe(
            'This question belongs to another session.'
        );
        expect(card.querySelector<HTMLButtonElement>('.action-submit')?.hidden).toBe(true);
    });

    it('does not downgrade an answered card on a later terminal transition', () => {
        const board = mount();
        const turn = board.begin('task');
        startRoot(turn);
        turn.apply(requestEvent());
        turn.apply(
            answerEvent({
                requestId: 'req-1',
                choice: { kind: 'custom', text: 'read the docs' },
                source: 'auto'
            })
        );
        turn.apply({ type: 'error', agent: 'writer', error: { message: 'boom' } });
        turn.setState('error', 'boom');

        expect(cardOf(turn).dataset.state).toBe('answered');
        expect(cardOf(turn).querySelector('.action-status')?.textContent).toBe(
            'Auto-answered: read the docs'
        );
    });

    it('applies an answer that precedes its request and adopts the first session bind', () => {
        const board = mount();
        const turn = board.begin('task');
        startRoot(turn);

        // Legacy/reordered replay: the answer record may be encountered first. The
        // later request must render resolved, never as a live question.
        turn.apply(
            answerEvent({
                requestId: 'req-1',
                choice: { kind: 'option', optionId: 'b' },
                source: 'owner'
            })
        );
        turn.apply(requestEvent());

        const card = cardOf(turn);
        expect(card.dataset.state).toBe('answered');
        expect(card.querySelector('.action-status')?.textContent).toBe('Answered: Beta');
        expect(card.querySelector<HTMLButtonElement>('.action-submit')?.hidden).toBe(true);

        // A card rendered before the first bind is adopted by that conversation,
        // not expired as if it belonged somewhere else.
        const early = mount();
        const earlyTurn = early.begin('task');
        startRoot(earlyTurn);
        earlyTurn.apply(requestEvent());
        early.bindSession('s-late');
        expect(cardOf(earlyTurn).dataset.state).toBe('pending');
    });
});

describe('fork / autoanswer branch rows', () => {
    it('renders a fork as a nested block with a short kind tag and settles on branch_end', () => {
        const board = mount();
        const turn = board.begin('task');
        startRoot(turn);
        turn.apply({
            type: 'branch_start',
            agent: 'writer',
            branch: {
                branchId: 'branch-1',
                kind: 'fork',
                agent: 'writer',
                role: 'primary',
                forkDepth: 1,
                model: 'fork-model',
                tools: ['fileRead']
            }
        });

        const row = turn.element.parentElement?.querySelector<HTMLElement>('.thread-row') as HTMLElement;
        // The branch row is keyed by its branchId (the runtime's branch thread id),
        // NOT by the requester's thread carried on the event.
        expect(row.dataset.threadId).toBe('branch-1');
        expect(row.dataset.depth).toBe('1');
        expect(row.dataset.kind).toBe('fork');
        expect(row.dataset.branchId).toBe('branch-1');
        expect(row.dataset.state).toBe('streaming');
        expect(row.querySelector('.thread-kind')?.textContent).toBe('fork');
        expect(row.querySelector('.thread-preview')?.textContent).toBe('fork of this thread');
        // The block uses the existing agent label allocator, never a raw agent id.
        expect(row.querySelector('.thread-name')?.textContent).toBe('WR2');
        expect(row.textContent).not.toContain('writer');

        // The branch's own first event carries thread.id = branchId and must reuse
        // the same row rather than adding a duplicate.
        turn.apply({
            type: 'start',
            agent: 'writer',
            model: 'fork-model',
            thread: { id: 'branch-1', kind: 'fork', branchId: 'branch-1' }
        });
        expect(turn.element.parentElement?.querySelectorAll('.thread-row')).toHaveLength(1);

        turn.apply({
            type: 'branch_end',
            agent: 'writer',
            branchId: 'branch-1',
            status: 'completed'
        });

        expect(row.dataset.state).toBe('done');
        expect(row.querySelector('.thread-outcome')?.textContent).toBe('outcome · branch completed.');
    });

    it('labels an autoanswer branch and reports a failed branch without raw ids', () => {
        const board = mount();
        const turn = board.begin('task');
        startRoot(turn);
        turn.apply({
            type: 'branch_start',
            agent: 'helper',
            branch: {
                branchId: 'branch-2',
                kind: 'autoanswer',
                agent: 'writer',
                role: 'primary',
                requestId: 'req-1',
                forkDepth: 0,
                model: 'm1',
                tools: []
            },
            thread: { id: 'child-thread' }
        });

        const row = turn.element.parentElement?.querySelector<HTMLElement>('.thread-row') as HTMLElement;
        expect(row.dataset.threadId).toBe('branch-2');
        expect(row.querySelector('.thread-kind')?.textContent).toBe('auto');
        expect(row.querySelector<HTMLElement>('.thread-kind')?.dataset.kind).toBe('autoanswer');
        expect(row.querySelector('.thread-preview')?.textContent).toBe('automatic owner answer');
        // The owner fork runs as the owner agent (writer), not the requester (helper).
        expect(row.querySelector('.thread-name')?.textContent).toBe('WR2');

        turn.apply({
            type: 'branch_end',
            agent: 'helper',
            branchId: 'branch-2',
            status: 'failed',
            error: { message: 'fork failed' },
            thread: { id: 'child-thread' }
        });

        expect(row.dataset.state).toBe('error');
        expect(row.querySelector('.thread-outcome')?.textContent).toBe('error · fork failed');
        expect(row.textContent).not.toContain('branch-2');
    });

    it('nests a branch under its source thread without a second block shape', () => {
        const board = mount();
        const turn = board.begin('task');
        startRoot(turn);
        turn.apply({
            type: 'start',
            agent: 'helper',
            model: 'm1',
            thread: { id: 'child-thread', input: 'look this up' }
        });

        turn.apply({
            type: 'branch_start',
            agent: 'helper',
            branch: {
                branchId: 'branch-3',
                kind: 'fork',
                agent: 'helper',
                role: 'subagent',
                sourceThreadId: 'child-thread',
                forkDepth: 2,
                model: 'm1',
                tools: []
            }
        });

        const branchRow = turn.element.parentElement?.querySelector<HTMLElement>(
            '.thread-row[data-thread-id="branch-3"]'
        ) as HTMLElement;
        expect(branchRow.dataset.depth).toBe('2');
        expect(branchRow.parentElement?.className).toBe('thread-children');
        expect(branchRow.closest('.thread-row[data-thread-id="child-thread"]')).not.toBeNull();
    });
});

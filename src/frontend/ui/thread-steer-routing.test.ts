// T12d F1 — a steer belongs to its TARGET conversation across turns.
//
// A running delegated child runs inside its parent's turn. The parent may later
// get a continuation turn; steering the child audits the guidance on that ACTIVE
// parent turn with `threadId` = the child. The child invocation itself lives in an
// EARLIER turn (or only in the roster). The board must route the guidance there:
//   - visible in the earlier child invocation's flow;
//   - visible in a focused roster-only child panel;
//   - never rendered as the parent user's prompt;
//   - idempotent across snapshots/roster refreshes (no duplicate), timestamp-ordered.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/thread-steer-routing.test.ts

import type { HarnessAssistantMessage, HarnessEvent, SessionTurn } from '../../server/protocol';
import type { SessionThreadEntry } from './threads';
import { createTurnBoard } from './turns';

const message = (agent: string): HarnessAssistantMessage => ({
    role: 'assistant',
    content: 'answer',
    reasoning: '',
    toolCalls: [],
    model: `${agent}-model`,
    stopReason: 'stop'
});

const withThread = (event: Record<string, unknown>, thread: Record<string, unknown>): HarnessEvent =>
    ({ ...event, thread } as unknown as HarnessEvent);

const threadEntry = (overrides: Partial<SessionThreadEntry> & { id: string }): SessionThreadEntry => ({
    agent: 'Researcher',
    origin: 'host',
    status: 'idle',
    sequence: 1,
    ...overrides
});

const mount = (roster: SessionThreadEntry[]): ReturnType<typeof createTurnBoard> => {
    const board = createTurnBoard({});
    board.setThreads(roster);
    document.body.replaceChildren(board.element);
    return board;
};

const turn = (
    overrides: Partial<SessionTurn> & { id: string; index: number; threadId: string; threadLabel: string }
): SessionTurn =>
    ({
        prompt: 'task',
        status: 'running',
        startedAt: 1,
        updatedAt: 2,
        events: [],
        ...overrides
    }) as unknown as SessionTurn;

const childRow = (board: ReturnType<typeof createTurnBoard>, invocationId: string): HTMLElement | null =>
    board.element.querySelector<HTMLElement>(`.thread-row[data-thread-id="${invocationId}"]`);

const steerTexts = (root: ParentNode): (string | undefined)[] =>
    [...root.querySelectorAll<HTMLElement>('.turn-steer-text')].map((node) => node.textContent ?? undefined);

const ROOT_EVENTS: HarnessEvent[] = [
    withThread({ type: 'start', agent: 'Researcher', model: 'r1' }, { id: 'inv-root', input: 'parent task' })
];

const CHILD_START: HarnessEvent = withThread(
    { type: 'start', agent: 'Helper', model: 'h1' },
    { id: 'inv-child', parentId: 'inv-root', callId: 'call-1', input: 'child task' }
);

const roster = (): SessionThreadEntry[] => [
    threadEntry({ id: 'thread-root', sequence: 1, label: 'RR1', invocationId: 'inv-root' }),
    threadEntry({
        id: 'thread-child',
        sequence: 2,
        label: 'HH1',
        agent: 'Helper',
        ownerThreadId: 'thread-root',
        invocationId: 'inv-child'
    })
];

describe('steer routing across turns (F1)', () => {
    it('renders earlier-run child guidance in the child invocation, never the parent', () => {
        const board = mount(roster());
        const first = turn({
            id: 'turn-1',
            index: 0,
            threadId: 'thread-root',
            threadLabel: 'RR1',
            status: 'done',
            events: [
                ...ROOT_EVENTS,
                {
                    type: 'tool_call',
                    agent: 'Researcher',
                    call: {
                        id: 'call-1',
                        name: 'agentDelegate',
                        arguments: JSON.stringify({ agent: 'Helper', input: 'child task' })
                    }
                },
                CHILD_START,
                withThread(
                    { type: 'done', agent: 'Helper', message: message('Helper') },
                    { id: 'inv-child', parentId: 'inv-root', callId: 'call-1' }
                )
            ]
        });
        const continuation = turn({
            id: 'turn-2',
            index: 1,
            threadId: 'thread-root',
            threadLabel: 'RR1',
            events: [withThread({ type: 'start', agent: 'Researcher', model: 'r1' }, { id: 'inv-2', input: 'more' })],
            steers: [
                { at: 20, prompt: 'second steer', threadId: 'thread-child' },
                { at: 10, prompt: 'first steer', threadId: 'thread-child' }
            ]
        });

        const handles = board.hydrate([first, continuation]);
        const row = childRow(board, 'inv-child');

        expect(row).not.toBeNull();
        // Timestamp order, even when the audit array is not sorted.
        expect(steerTexts(row as HTMLElement)).toEqual(['first steer\n', 'second steer\n']);
        // The active parent tile does not claim the child's guidance.
        expect(steerTexts(handles[1].element)).toEqual([]);
        expect(steerTexts(handles[0].element)).toEqual([]);

        // Focusing the child reaches the same guidance; roster/reconcile refreshes
        // neither duplicate nor lose it.
        expect(board.focusThread('thread-child')).toBe(true);
        expect(row?.classList.contains('is-expanded')).toBe(true);
        expect(steerTexts(row as HTMLElement)).toEqual(['first steer\n', 'second steer\n']);

        board.setThreads(roster());
        board.reconcile([first, continuation]);
        expect(steerTexts(childRow(board, 'inv-child') as HTMLElement)).toEqual([
            'first steer\n',
            'second steer\n'
        ]);

        // A full rebuild (target invocation re-adopted) must re-project the audit,
        // not lose it and not leave a stale duplicate.
        board.hydrate([first, continuation]);
        expect(steerTexts(childRow(board, 'inv-child') as HTMLElement)).toEqual([
            'first steer\n',
            'second steer\n'
        ]);
    });

    it('shows roster-only child guidance in the focused panel, deduped against its transcript', () => {
        const board = mount([
            threadEntry({ id: 'thread-root', sequence: 1, label: 'RR1', invocationId: 'inv-root' }),
            threadEntry({
                id: 'thread-child',
                sequence: 2,
                label: 'HH1',
                agent: 'Helper',
                ownerThreadId: 'thread-root',
                messages: [{ role: 'user', content: 'already committed guidance' }]
            })
        ]);
        board.hydrate([
            turn({
                id: 'turn-1',
                index: 0,
                threadId: 'thread-root',
                threadLabel: 'RR1',
                events: ROOT_EVENTS,
                steers: [
                    { at: 5, prompt: 'already committed guidance', threadId: 'thread-child' },
                    { at: 10, prompt: 'new child guidance', threadId: 'thread-child' }
                ]
            })
        ]);

        // Nothing is visible before the child conversation is opened …
        expect(board.element.querySelectorAll('.turn-steer')).toHaveLength(0);

        expect(board.focusThread('thread-child')).toBe(true);
        const panel = board.element.querySelector<HTMLElement>('.thread-focus-panel');
        expect(panel).not.toBeNull();

        const userMessages = [...(panel?.querySelectorAll<HTMLElement>('.thread-focus-message') ?? [])]
            .filter((row) => row.dataset.role === 'user')
            .map((row) => row.querySelector('.thread-focus-text')?.textContent?.trim());
        // The committed transcript message is not duplicated; only the new guidance
        // is appended as a visible steer.
        expect(userMessages).toEqual(['already committed guidance']);
        expect(steerTexts(panel as HTMLElement)).toEqual(['new child guidance\n']);

        // Re-focusing/roster refresh does not duplicate the panel steer.
        board.setThreads([
            threadEntry({ id: 'thread-root', sequence: 1, label: 'RR1', invocationId: 'inv-root' }),
            threadEntry({
                id: 'thread-child',
                sequence: 2,
                label: 'HH1',
                agent: 'Helper',
                ownerThreadId: 'thread-root',
                messages: [{ role: 'user', content: 'already committed guidance' }]
            })
        ]);
        expect(steerTexts(board.element.querySelector('.thread-focus-panel') as HTMLElement)).toEqual([
            'new child guidance\n'
        ]);
    });
});

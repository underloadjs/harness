// R8/R9/R10 — conversation labels and the visible steer, at the turn-board layer.
//
// The screenshots this pins down:
//   - a user-opened conversation is a TOP-LEVEL block named `<AGENT CODE><N>`
//     (`RR1`, `RR2`, `RR3`, then a new one is `RR4`; `IT1` for Instruct);
//   - a host-thread ROOT run carries a metadata-only `thread` frame (no parent,
//     callId, kind or branch marker). That frame is the SAME conversation, not an
//     agent-spawned child: it must NOT create an indented `T<n>` wrapper row;
//   - only a genuine delegation/fork child (callId/parentId/kind) is indented and
//     named with its own child-conversation label;
//   - a focused steer is a visible user message inside the SAME tile, not a second
//     top-level row and not a hidden audit-only record.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/thread-conversation.test.ts

import type { HarnessAssistantMessage, HarnessEvent, SessionTurn } from '../../server/protocol';
import type { SessionThreadEntry } from './threads';
import { createTurnBoard } from './turns';

const doneMessage = (agent: string): HarnessAssistantMessage => ({
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

const mount = () => {
    const board = createTurnBoard({});
    document.body.replaceChildren(board.element);
    return board;
};

const hostRootEvents = (input: string): HarnessEvent[] => [
    withThread({ type: 'start', agent: 'Researcher', model: 'r1' }, { id: 'inv-4', input }),
    withThread({ type: 'text', agent: 'Researcher', delta: 'hello there' }, { id: 'inv-4' }),
    withThread({ type: 'done', agent: 'Researcher', message: doneMessage('Researcher') }, { id: 'inv-4' })
];

const hostTurn = (overrides: Partial<SessionTurn> & { id: string; index: number }): SessionTurn => ({
    prompt: 'go',
    status: 'done',
    startedAt: 1,
    updatedAt: 2,
    events: [],
    ...overrides
});

const rows = (board: ReturnType<typeof mount>): HTMLElement[] => [
    ...board.element.querySelectorAll<HTMLElement>('.thread-row')
];

// Top-level conversation roots: one per persistent thread (a legacy turn has no
// wrapper and stays its own `.turn-row`).
const conversations = (board: ReturnType<typeof mount>): HTMLElement[] => [
    ...board.element.querySelectorAll<HTMLElement>(':scope > .conversation')
];

const turnRowsIn = (host: HTMLElement): HTMLElement[] => [
    ...host.querySelectorAll<HTMLElement>(':scope > .turn-row')
];

describe('persistent conversation labels (R8/R10)', () => {
    it('renders a host-thread root run flat, named by its conversation label', () => {
        const board = mount();
        board.setThreads([
            threadEntry({ id: 'thread-1', sequence: 1, label: 'RR4', invocationId: 'inv-4' })
        ]);

        const turn = board.begin('fourth conversation', [], 'thread-1');
        turn.merge(
            hostTurn({
                id: 'turn-1',
                index: 0,
                prompt: 'fourth conversation',
                threadId: 'thread-1',
                threadLabel: 'RR4',
                events: hostRootEvents('fourth conversation')
            })
        );

        // The metadata-only thread frame is the ROOT, never a T-wrapper child.
        expect(rows(board)).toHaveLength(0);
        expect(turn.element.querySelector('.tile-agent')?.textContent).toBe('RR4');
        expect(turn.element.querySelector('.tile-thread')?.textContent).toBe('RR4');
        expect(turn.element.querySelector('.tile-flow .agent-text')?.textContent).toBe('hello there\n');
    });

    it('reuses one label across repeated runs and starts the next conversation after it', () => {
        const board = mount();
        const roster: SessionThreadEntry[] = [
            threadEntry({ id: 'thread-1', sequence: 1, label: 'RR1', invocationId: 'inv-1' }),
            threadEntry({ id: 'thread-2', sequence: 2, label: 'RR2', invocationId: 'inv-2' }),
            threadEntry({ id: 'thread-3', sequence: 3, label: 'RR3', invocationId: 'inv-3' }),
            threadEntry({ id: 'thread-4', sequence: 4, label: 'RR4', invocationId: 'inv-4' })
        ];
        board.setThreads(roster);

        const handles = board.hydrate([
            hostTurn({
                id: 'turn-1',
                index: 0,
                prompt: 'first',
                threadId: 'thread-4',
                threadLabel: 'RR4',
                events: hostRootEvents('first')
            }),
            hostTurn({
                id: 'turn-2',
                index: 1,
                prompt: 'continue',
                threadId: 'thread-4',
                threadLabel: 'RR4',
                events: hostRootEvents('continue')
            })
        ]);

        // Two RUNS of one conversation share ONE label; neither consumes RR5.
        expect(handles.map((handle) => handle.element.querySelector('.tile-agent')?.textContent)).toEqual([
            'RR4',
            'RR4'
        ]);
        expect(handles.map((handle) => handle.element.querySelector('.tile-thread')?.textContent)).toEqual([
            'RR4',
            'RR4'
        ]);
        expect(rows(board)).toHaveLength(0);
    });

    it('keeps the first Instruct conversation independent as IT1', () => {
        const board = mount();
        board.setThreads([threadEntry({ id: 'thread-i', sequence: 1, label: 'IT1', agent: 'Instruct' })]);

        const handle = board.adopt(
            hostTurn({
                id: 'turn-1',
                index: 0,
                threadId: 'thread-i',
                threadLabel: 'IT1',
                events: [withThread({ type: 'start', agent: 'Instruct', model: 'i1' }, { id: 'inv-i', input: 'x' })]
            })
        );

        expect(handle.element.querySelector('.tile-agent')?.textContent).toBe('IT1');
        expect(handle.element.querySelector('.tile-thread')?.textContent).toBe('IT1');
    });

    it('indents only a real agent-spawned child and names it with its child label', () => {
        const board = mount();
        board.setThreads([
            threadEntry({ id: 'thread-1', sequence: 1, label: 'RR4', invocationId: 'inv-4' }),
            threadEntry({
                id: 'thread-child',
                sequence: 2,
                label: 'RR5',
                agent: 'Helper',
                ownerThreadId: 'thread-1',
                invocationId: 'inv-5'
            })
        ]);

        const turn = board.begin('host turn', [], 'thread-1');
        turn.apply(withThread({ type: 'start', agent: 'Researcher', model: 'r1' }, { id: 'inv-4', input: 'host turn' }));
        turn.merge(
            hostTurn({
                id: 'turn-1',
                index: 0,
                threadId: 'thread-1',
                threadLabel: 'RR4',
                events: [withThread({ type: 'start', agent: 'Researcher', model: 'r1' }, { id: 'inv-4', input: 'host turn' })]
            })
        );
        turn.apply({
            type: 'tool_call',
            agent: 'Researcher',
            call: {
                id: 'call-1',
                name: 'agentDelegate',
                arguments: JSON.stringify({ agent: 'Helper', input: 'child task' })
            }
        });
        turn.apply(
            withThread(
                { type: 'start', agent: 'Helper', model: 'h1' },
                { id: 'inv-5', parentId: 'inv-4', callId: 'call-1', input: 'child task' }
            )
        );

        const childRows = rows(board);
        expect(childRows).toHaveLength(1);
        expect(childRows[0].dataset.threadId).toBe('inv-5');
        expect(childRows[0].dataset.depth).toBe('1');
        expect(childRows[0].querySelector('.thread-name')?.textContent).toBe('RR5');
    });

    it('groups every run of one thread into ONE top-level conversation, in order', () => {
        const board = mount();
        board.setThreads([threadEntry({ id: 'thread-2', sequence: 2, label: 'RR2', invocationId: 'inv-2' })]);

        board.hydrate([
            hostTurn({
                id: 'turn-1',
                index: 0,
                prompt: 'first prompt',
                threadId: 'thread-2',
                threadLabel: 'RR2',
                events: hostRootEvents('first prompt')
            }),
            hostTurn({
                id: 'turn-2',
                index: 1,
                prompt: 'second prompt',
                threadId: 'thread-2',
                threadLabel: 'RR2',
                events: hostRootEvents('second prompt')
            })
        ]);

        const roots = conversations(board);
        expect(roots).toHaveLength(1);
        expect(roots[0].dataset.threadId).toBe('thread-2');
        expect(turnRowsIn(roots[0])).toHaveLength(2);
        expect(
            [...roots[0].querySelectorAll<HTMLElement>('.turn-prompt')].map((node) => node.textContent?.trim())
        ).toEqual(['first prompt', 'second prompt']);
        // # reference descriptors stay per TURN (unique turnId/thread binding) even
        // though both roots render inside one conversation DOM.
        expect(board.blocks().map((block) => `${block.turnId}:${block.label}:${block.threadId ?? 'root'}`)).toEqual([
            'turn-1:RR2:root',
            'turn-2:RR2:root'
        ]);
        // The first exchange is the conversation header; the second is an ordered
        // continuation whose repeated label is hidden by CSS.
        expect(turnRowsIn(roots[0]).map((row) => row.classList.contains('is-continuation'))).toEqual([
            false,
            true
        ]);
        expect(roots[0].querySelector('.tile-thread')?.textContent).toBe('RR2');
    });

    it('keeps exactly ONE conversation expanded (all its exchanges) at a time', () => {
        const board = mount();
        board.setThreads([
            threadEntry({ id: 'thread-1', sequence: 1, label: 'RR1', invocationId: 'inv-1' }),
            threadEntry({ id: 'thread-2', sequence: 2, label: 'RR2', invocationId: 'inv-3' })
        ]);

        const handles = board.hydrate([
            hostTurn({ id: 'turn-1', index: 0, threadId: 'thread-1', threadLabel: 'RR1', events: hostRootEvents('one') }),
            hostTurn({ id: 'turn-2', index: 1, threadId: 'thread-1', threadLabel: 'RR1', events: hostRootEvents('two') }),
            hostTurn({ id: 'turn-3', index: 2, threadId: 'thread-2', threadLabel: 'RR2', events: hostRootEvents('three') })
        ]);

        board.expand(handles[1]);
        expect(
            [...board.element.querySelectorAll<HTMLElement>('.conversation')].map((host) => [
                host.dataset.threadId,
                host.classList.contains('is-expanded')
            ])
        ).toEqual([
            ['thread-1', true],
            ['thread-2', false]
        ]);
        expect(board.expanded()?.id()).toBe('turn-2');

        board.expand(handles[2]);
        expect(
            [...board.element.querySelectorAll<HTMLElement>('.conversation')].map((host) => [
                host.dataset.threadId,
                host.classList.contains('is-expanded')
            ])
        ).toEqual([
            ['thread-1', false],
            ['thread-2', true]
        ]);
    });

    it('nests a child conversation continuation inside its owner and still focuses it', () => {
        const board = mount();
        board.setThreads([
            threadEntry({ id: 'thread-1', sequence: 1, label: 'RR4', invocationId: 'inv-4' }),
            threadEntry({
                id: 'thread-child',
                sequence: 2,
                label: 'RR5',
                agent: 'Helper',
                ownerThreadId: 'thread-1',
                invocationId: 'inv-5'
            })
        ]);

        const handles = board.hydrate([
            hostTurn({ id: 'turn-1', index: 0, threadId: 'thread-1', threadLabel: 'RR4', events: hostRootEvents('owner') }),
            hostTurn({
                id: 'turn-2',
                index: 1,
                threadId: 'thread-child',
                threadLabel: 'RR5',
                events: hostRootEvents('child continuation')
            })
        ]);

        // ONE top-level conversation (the owner); the child continuation is nested.
        const roots = conversations(board);
        expect(roots).toHaveLength(1);
        expect(roots[0].dataset.threadId).toBe('thread-1');
        const childRow = roots[0].querySelector<HTMLElement>('.turn-row[data-child-thread="thread-child"]');
        expect(childRow).not.toBeNull();
        expect(childRow?.querySelector('.tile-thread')?.textContent).toBe('RR5');

        expect(board.focusThread('thread-child')).toBe(true);
        expect(board.focusedThread()).toBe('thread-child');
        expect(board.expanded()?.id()).toBe('turn-2');
        expect(roots[0].classList.contains('is-expanded')).toBe(true);
        expect(handles).toHaveLength(2);
    });

    it('shows ONE canonical root label: the badge, not a duplicate agent code', () => {
        const board = mount();
        board.setThreads([threadEntry({ id: 'thread-4', sequence: 4, label: 'RR4', invocationId: 'inv-4' })]);

        const threaded = board.adopt(
            hostTurn({
                id: 'turn-4',
                index: 3,
                threadId: 'thread-4',
                threadLabel: 'RR4',
                events: hostRootEvents('four')
            })
        );

        const agentCode = threaded.element.querySelector<HTMLElement>('.tile-agent');
        const badge = threaded.element.querySelector<HTMLElement>('.tile-thread');
        expect(agentCode?.textContent).toBe('RR4');
        expect(agentCode?.hidden).toBe(true);
        expect(badge?.textContent).toBe('RR4');
        expect(badge?.hidden).toBe(false);
        expect(badge?.title).toContain('RR4');

        // A legacy threadless turn has no badge, so its agent code remains visible.
        const legacy = board.adopt(
            hostTurn({
                id: 'turn-5',
                index: 4,
                events: [{ type: 'start', agent: 'Researcher', model: 'r1' }]
            })
        );
        expect(legacy.element.querySelector<HTMLElement>('.tile-agent')?.hidden).toBe(false);
        expect(legacy.element.querySelector<HTMLElement>('.tile-thread')?.hidden).toBe(true);

        // A nested child has exactly one label node.
        const child = board.adopt(
            hostTurn({
                id: 'turn-6',
                index: 5,
                threadId: 'thread-4',
                threadLabel: 'RR4',
                events: [
                    withThread({ type: 'start', agent: 'Researcher', model: 'r1' }, { id: 'inv-4', input: 'host' }),
                    {
                        type: 'tool_call',
                        agent: 'Researcher',
                        call: {
                            id: 'call-1',
                            name: 'agentDelegate',
                            arguments: JSON.stringify({ agent: 'Helper', input: 'child' })
                        }
                    },
                    withThread(
                        { type: 'start', agent: 'Helper', model: 'h1' },
                        { id: 'inv-child', parentId: 'inv-4', callId: 'call-1', input: 'child' }
                    )
                ]
            })
        );
        const childRow = child.element.parentElement?.querySelector<HTMLElement>('.thread-row');
        expect(childRow?.querySelectorAll('.thread-name')).toHaveLength(1);
    });

    it('keeps a new unfocused conversation as its own row beside the existing ones', () => {
        const board = mount();
        board.setThreads([
            threadEntry({ id: 'thread-1', sequence: 1, label: 'RR1', invocationId: 'inv-1' }),
            threadEntry({ id: 'thread-2', sequence: 2, label: 'RR2', invocationId: 'inv-2' }),
            threadEntry({ id: 'thread-3', sequence: 3, label: 'RR3', invocationId: 'inv-3' }),
            threadEntry({ id: 'thread-4', sequence: 4, label: 'RR4', invocationId: 'inv-4' })
        ]);

        board.hydrate([
            hostTurn({ id: 't1', index: 0, threadId: 'thread-1', threadLabel: 'RR1', events: hostRootEvents('one') }),
            hostTurn({ id: 't2', index: 1, threadId: 'thread-2', threadLabel: 'RR2', events: hostRootEvents('two') }),
            hostTurn({ id: 't3', index: 2, threadId: 'thread-3', threadLabel: 'RR3', events: hostRootEvents('three') }),
            hostTurn({ id: 't4', index: 3, threadId: 'thread-4', threadLabel: 'RR4', events: hostRootEvents('four') })
        ]);

        expect(conversations(board).map((host) => host.dataset.threadId)).toEqual([
            'thread-1',
            'thread-2',
            'thread-3',
            'thread-4'
        ]);
        expect(conversations(board).map((host) => host.querySelector('.tile-thread')?.textContent)).toEqual([
            'RR1',
            'RR2',
            'RR3',
            'RR4'
        ]);
    });

    it('renders a steered CHILD message in that child conversation, never as the parent prompt', () => {
        const board = mount();
        board.setThreads([
            threadEntry({ id: 'thread-1', sequence: 1, label: 'RR4', invocationId: 'inv-4' }),
            threadEntry({
                id: 'thread-child',
                sequence: 2,
                label: 'RR5',
                agent: 'Helper',
                ownerThreadId: 'thread-1',
                invocationId: 'inv-5'
            })
        ]);

        const events: HarnessEvent[] = [
            withThread({ type: 'start', agent: 'Researcher', model: 'r1' }, { id: 'inv-4', input: 'host' }),
            {
                type: 'tool_call',
                agent: 'Researcher',
                call: {
                    id: 'call-1',
                    name: 'agentDelegate',
                    arguments: JSON.stringify({ agent: 'Helper', input: 'child' })
                }
            },
            withThread(
                { type: 'start', agent: 'Helper', model: 'h1' },
                { id: 'inv-5', parentId: 'inv-4', callId: 'call-1', input: 'child' }
            )
        ];

        const turn = board.adopt(
            hostTurn({
                id: 'turn-4',
                index: 3,
                threadId: 'thread-1',
                threadLabel: 'RR4',
                status: 'running',
                events,
                steers: [{ at: 15, prompt: 'child steer', threadId: 'thread-child' }]
            })
        );

        const childRow = rows(board)[0];
        expect(childRow.dataset.threadId).toBe('inv-5');
        expect(childRow.querySelector('.turn-steer-text')?.textContent).toBe('child steer\n');
        // The parent root flow does NOT claim the child's user message.
        expect(turn.element.querySelectorAll('.turn-steer')).toHaveLength(0);
    });

    it('keeps a top-level referenced conversation flat (a reference is a link, not nesting)', () => {
        const board = mount();
        board.setThreads([
            threadEntry({ id: 'thread-1', sequence: 1, label: 'RR1', invocationId: 'inv-1' }),
            threadEntry({ id: 'thread-4', sequence: 4, label: 'RR4', invocationId: 'inv-4' })
        ]);

        const handle = board.adopt(
            hostTurn({
                id: 'turn-4',
                index: 3,
                threadId: 'thread-4',
                threadLabel: 'RR4',
                references: [{ turnId: 'turn-1', label: 'RR1' }],
                events: hostRootEvents('reference RR1')
            })
        );

        expect(rows(board)).toHaveLength(0);
        expect(handle.element.querySelector('.tile-agent')?.textContent).toBe('RR4');
    });
});

describe('visible steering inside the same conversation (R9)', () => {
    it('renders the steered user text as a message in the owning tile', () => {
        const board = mount();
        board.setThreads([threadEntry({ id: 'thread-1', sequence: 1, label: 'RR2', invocationId: 'inv-2' })]);

        const turn = board.begin('start the run', [], 'thread-1');
        const events: HarnessEvent[] = [
            withThread({ type: 'start', agent: 'Researcher', model: 'r1' }, { id: 'inv-2', input: 'start the run' }),
            withThread({ type: 'text', agent: 'Researcher', delta: 'working' }, { id: 'inv-2' })
        ];
        for (const event of events) turn.apply(event, 10);

        // Steering answers with the OWNING turn (same id) plus the audit record.
        turn.merge(
            hostTurn({
                id: 'turn-2',
                index: 1,
                prompt: 'start the run',
                status: 'running',
                threadId: 'thread-1',
                threadLabel: 'RR2',
                updatedAt: 20,
                events,
                steers: [{ at: 15, prompt: 'test' }]
            })
        );

        expect(board.turns()).toHaveLength(1);
        expect(conversations(board)).toHaveLength(1);
        expect(turn.element.querySelectorAll('.turn-steer')).toHaveLength(1);
        expect(turn.element.querySelector('.turn-steer-role')?.textContent).toBe('you · steering');
        expect(turn.element.querySelector('.turn-steer-text')?.textContent).toBe('test\n');
        // The same conversation badge; no second conversation/tile was created.
        expect(turn.element.querySelector('.tile-thread')?.textContent).toBe('RR2');
        expect(rows(board)).toHaveLength(0);
    });
});

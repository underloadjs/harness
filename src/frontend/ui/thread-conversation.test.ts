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

// ONE THREAD-OWNED CARD (R2/R3). A persistent thread is ONE block in the
// transcript, whatever number of RUNS the server recorded for it: a follow-up
// submitted to a focused thread appends prompt + answer inside that block (the
// `.conversation` container carries the frame, styles.css removes the inner tile
// frames), and a resumed CHILD conversation appends inside its own nested card.
// Distinct agent threads stay distinct cards.
describe('one thread-owned card (R2/R3)', () => {
    // One host-thread RUN: metadata-only thread frames, exactly the wire shape the
    // runtime emits (no parent/callId/kind/branch), joined to `threadId`.
    const rootRun = (invocation: string, input: string, answer: string): HarnessEvent[] => [
        withThread({ type: 'start', agent: 'Researcher', model: 'r1' }, { id: invocation, input }),
        withThread({ type: 'text', agent: 'Researcher', delta: answer }, { id: invocation }),
        withThread({ type: 'done', agent: 'Researcher', message: doneMessage('Researcher') }, { id: invocation })
    ];

    const delegated = (callId: string, agent: string, input: string, invocation: string): HarnessEvent[] => [
        {
            type: 'tool_call',
            agent: 'Researcher',
            call: { id: callId, name: 'agentDelegate', arguments: JSON.stringify({ agent, input }) }
        } as HarnessEvent,
        withThread({ type: 'start', agent, model: 'h1' }, { id: invocation, parentId: 'inv-4', callId, input })
    ];

    const rootTurn = (id: string, index: number, prompt: string, invocation: string): SessionTurn =>
        hostTurn({
            id,
            index,
            prompt,
            threadId: 'thread-1',
            threadLabel: 'RR1',
            events: rootRun(invocation, prompt, `${prompt} answer`)
        });

    // The DOM projection of a board, in the terms the requirement is written in:
    // one entry per card, with its ordered exchanges, the answers inside it and the
    // nested child cards (whose own exchanges belong to that child, not the owner).
    const projectionOf = (board: ReturnType<typeof mount>) => [
        ...board.element.querySelectorAll<HTMLElement>(':scope > .conversation')
    ].map((host) => ({
        thread: host.dataset.threadId,
        exchanges: [...host.querySelectorAll<HTMLElement>(':scope > .turn-row')].map((row) => [
            row.classList.contains('is-continuation') ? 'next' : 'head',
            row.querySelector('.tile-prompt')?.textContent,
            row.querySelector('.tile-thread')?.textContent,
            row.querySelector('.tile-status-text')?.textContent
        ]),
        answers: [...host.querySelectorAll<HTMLElement>('.agent-text')].map((node) => node.textContent),
        children: [...host.querySelectorAll<HTMLElement>('.thread-row')].map((row) => [
            row.dataset.persistentThread,
            [...row.querySelectorAll<HTMLElement>('.thread-flow > .turn-row')].map((exchange) => [
                exchange.dataset.threadExchange,
                exchange.querySelector('.tile-prompt')?.textContent
            ])
        ])
    }));

    it('appends a focused root follow-up inside the SAME card, in order', () => {
        const board = mount();
        board.setThreads([threadEntry({ id: 'thread-1', sequence: 1, label: 'RR1', invocationId: 'inv-4' })]);

        board.hydrate([
            rootTurn('turn-1', 0, 'first prompt', 'inv-4'),
            rootTurn('turn-2', 1, 'follow-up', 'inv-5')
        ]);

        // ONE visible card for the thread; both runs are exchanges of it.
        const cards = conversations(board);
        expect(cards).toHaveLength(1);
        expect(cards[0].dataset.threadId).toBe('thread-1');
        expect(turnRowsIn(cards[0]).map((row) => row.classList.contains('is-continuation'))).toEqual([false, true]);
        expect(
            [...cards[0].querySelectorAll<HTMLElement>(':scope > .turn-row .turn-prompt')].map((node) =>
                node.textContent?.trim()
            )
        ).toEqual(['first prompt', 'follow-up']);
        expect([...cards[0].querySelectorAll<HTMLElement>('.agent-text')].map((node) => node.textContent)).toEqual([
            'first prompt answer\n',
            'follow-up answer\n'
        ]);
        // The exchanges keep their own tile DOM (events/timing/# blocks), but the card
        // is the block the reader sees — the inner tiles sit inside the one container.
        expect(cards[0].querySelectorAll(':scope > .turn-row > .tile')).toHaveLength(2);

        // R1: identity once per card, leading the header — never beside the clock.
        expect(
            [...cards[0].querySelectorAll<HTMLElement>(':scope > .turn-row .tile-select')].map(
                (select) => select.firstElementChild?.className
            )
        ).toEqual(['tile-thread', 'tile-thread']);
        expect(
            [...cards[0].querySelectorAll<HTMLElement>(':scope > .turn-row .tile-thread')].map(
                (node) => node.textContent
            )
        ).toEqual(['RR1', 'RR1']);

        // Stream/status survive on every exchange (nothing is flattened away).
        expect(
            turnRowsIn(cards[0]).map(
                (row) => `${row.dataset.state}:${row.querySelector('.tile-status-text')?.textContent}`
            )
        ).toEqual(['done:done', 'done:done']);
        // The newest exchange is the open/focused surface (hydrate opens the newest).
        expect(board.expanded()?.id()).toBe('turn-2');
        expect(board.focusedThread()).toBe('thread-1');
    });

    it('projects hydrated, live and out-of-order follow-ups identically', () => {
        const roster = [threadEntry({ id: 'thread-1', sequence: 1, label: 'RR1', invocationId: 'inv-4' })];
        const first = rootTurn('turn-1', 0, 'first prompt', 'inv-4');
        const second = rootTurn('turn-2', 1, 'follow-up', 'inv-5');

        // Recorded/hydrated: both runs arrive together.
        const hydrated = mount();
        hydrated.setThreads(roster);
        hydrated.hydrate([first, second]);

        // Live: the follow-up arrives after the first run is already on screen.
        const live = mount();
        live.setThreads(roster);
        live.reconcile([first]);
        live.reconcile([first, second]);

        // Live, out of order: the snapshot lists the follow-up before its owner.
        const reordered = mount();
        reordered.setThreads(roster);
        reordered.reconcile([second]);
        reordered.reconcile([first, second]);

        const expected = [
            {
                thread: 'thread-1',
                exchanges: [
                    ['head', 'first prompt', 'RR1', 'done'],
                    ['next', 'follow-up', 'RR1', 'done']
                ],
                answers: ['first prompt answer\n', 'follow-up answer\n'],
                children: []
            }
        ];
        expect(projectionOf(hydrated)).toEqual(expected);
        expect(projectionOf(live)).toEqual(expected);
        expect(projectionOf(reordered)).toEqual(expected);
        // Both runs are rows of the SAME card element, in every arrival path
        // (`turn.element` is the tile; its parent is the row inside the card).
        const rows = hydrated.turns().map((turn) => turn.element.parentElement);
        const card = conversations(hydrated)[0];
        expect(rows[0]?.parentElement).toBe(card);
        expect(rows[1]?.parentElement).toBe(card);
        expect(rows[0]?.classList.contains('is-continuation')).toBe(false);
        expect(rows[1]?.classList.contains('is-continuation')).toBe(true);
    });

    it('appends a resumed CHILD exchange inside its own nested card, not beside it', () => {
        const board = mount();
        // The roster the server reports AFTER the child resumed: its `invocationId` and
        // `originInvocationId` name the CONTINUATION run (`inv-6`), never the original
        // delegated `inv-5` (src/harness.ts:4536). The AUTHORITATIVE anchor is
        // `invocationIds` — the server's persisted invocation→thread roster, which still
        // names the original delegated run (src/server/sessions.ts `invocationIdsOf`).
        board.setThreads([
            threadEntry({ id: 'thread-1', sequence: 1, label: 'RR1', invocationId: 'inv-4' }),
            threadEntry({
                id: 'thread-child',
                sequence: 2,
                label: 'RR5',
                agent: 'Helper',
                ownerThreadId: 'thread-1',
                invocationId: 'inv-6',
                originInvocationId: 'inv-6',
                invocationIds: ['inv-5', 'inv-6'],
                messages: [
                    { role: 'user', content: 'child task' },
                    { role: 'assistant', content: 'child answer' }
                ]
            })
        ]);

        board.hydrate([
            hostTurn({
                id: 'turn-1',
                index: 0,
                prompt: 'owner',
                threadId: 'thread-1',
                threadLabel: 'RR1',
                events: [
                    ...rootRun('inv-4', 'owner', 'owner answer'),
                    ...delegated('call-1', 'Helper', 'child task', 'inv-5')
                ]
            }),
            hostTurn({
                id: 'turn-2',
                index: 1,
                prompt: 'child follow-up',
                threadId: 'thread-child',
                threadLabel: 'RR5',
                events: rootRun('inv-6', 'child follow-up', 'child answer')
            })
        ]);

        // ONE top-level card (the owner) and ONE child card inside it.
        const cards = conversations(board);
        expect(cards).toHaveLength(1);
        expect(cards[0].dataset.threadId).toBe('thread-1');
        expect(turnRowsIn(cards[0]).map((row) => row.querySelector('.tile-prompt')?.textContent)).toEqual(['owner']);

        const childCard = cards[0].querySelector<HTMLElement>('.thread-row[data-persistent-thread="thread-child"]');
        expect(childCard).not.toBeNull();
        // The child card is the block: its own invocation content AND the continuation.
        expect(
            [...(childCard?.querySelectorAll<HTMLElement>('.thread-flow > .turn-row') ?? [])].map((row) => [
                row.dataset.threadExchange,
                row.querySelector('.tile-prompt')?.textContent,
                row.querySelector('.tile-status-text')?.textContent
            ])
        ).toEqual([['thread-child', 'child follow-up', 'done']]);
        // It is NOT a second `.turn-row` under the owner conversation.
        expect(cards[0].querySelector('.turn-row[data-child-thread]')).toBeNull();
        expect(turnRowsIn(cards[0])).toHaveLength(1);
        expect(rows(board)).toHaveLength(1);
    });

    it('keeps two sibling child threads as two separate cards', () => {
        const board = mount();
        board.setThreads([
            threadEntry({ id: 'thread-1', sequence: 1, label: 'RR1', invocationId: 'inv-4' }),
            // Both siblings have ALREADY resumed: each roster row names its own
            // continuation run in `invocationId`, and the ORIGINAL delegated run
            // (`inv-a` / `inv-b`) is named only by the historical `invocationIds` list.
            threadEntry({
                id: 'thread-child-a',
                sequence: 2,
                label: 'RR5',
                agent: 'Helper',
                ownerThreadId: 'thread-1',
                invocationId: 'inv-a2',
                invocationIds: ['inv-a', 'inv-a2'],
                messages: [
                    { role: 'user', content: 'task a' },
                    { role: 'assistant', content: 'answer a' }
                ]
            }),
            threadEntry({
                id: 'thread-child-b',
                sequence: 3,
                label: 'RR6',
                agent: 'Helper',
                ownerThreadId: 'thread-1',
                invocationId: 'inv-b2',
                invocationIds: ['inv-b', 'inv-b2'],
                messages: [
                    { role: 'user', content: 'task b' },
                    { role: 'assistant', content: 'answer b' }
                ]
            })
        ]);

        board.hydrate([
            hostTurn({
                id: 'turn-1',
                index: 0,
                prompt: 'owner',
                threadId: 'thread-1',
                threadLabel: 'RR1',
                events: [
                    ...rootRun('inv-4', 'owner', 'owner answer'),
                    ...delegated('call-a', 'Helper', 'task a', 'inv-a'),
                    ...delegated('call-b', 'Helper', 'task b', 'inv-b')
                ]
            }),
            hostTurn({
                id: 'turn-2',
                index: 1,
                prompt: 'follow a',
                threadId: 'thread-child-a',
                threadLabel: 'RR5',
                events: rootRun('inv-a2', 'follow a', 'answer a')
            }),
            hostTurn({
                id: 'turn-3',
                index: 2,
                prompt: 'follow b',
                threadId: 'thread-child-b',
                threadLabel: 'RR6',
                events: rootRun('inv-b2', 'follow b', 'answer b')
            })
        ]);

        const cards = conversations(board);
        expect(cards).toHaveLength(1);
        // Two SIBLING threads: two cards, each with ONLY its own exchange.
        const childCards = [
            ...cards[0].querySelectorAll<HTMLElement>(':scope > .turn-row > .thread-children > .thread-row')
        ];
        expect(childCards.map((card) => card.dataset.persistentThread)).toEqual([
            'thread-child-a',
            'thread-child-b'
        ]);
        expect(
            childCards.map((card) => [
                card.querySelector('.thread-name')?.textContent,
                [...card.querySelectorAll<HTMLElement>('.thread-flow > .turn-row')].map((row) => [
                    row.dataset.threadExchange,
                    row.querySelector('.tile-prompt')?.textContent
                ])
            ])
        ).toEqual([
            ['RR5', [['thread-child-a', 'follow a']]],
            ['RR6', [['thread-child-b', 'follow b']]]
        ]);
        // The owner card still holds exactly its own exchange.
        expect(turnRowsIn(cards[0])).toHaveLength(1);
    });

    it('keeps a child conversation that has no card as its own distinct nested card', () => {
        const board = mount();
        board.setThreads([
            threadEntry({ id: 'thread-1', sequence: 1, label: 'RR1' }),
            threadEntry({ id: 'thread-child', sequence: 2, label: 'RR5', agent: 'Helper', ownerThreadId: 'thread-1' })
        ]);

        board.hydrate([
            hostTurn({
                id: 'turn-1',
                index: 0,
                prompt: 'owner',
                threadId: 'thread-1',
                threadLabel: 'RR1',
                events: rootRun('inv-4', 'owner', 'a')
            }),
            hostTurn({
                id: 'turn-2',
                index: 1,
                prompt: 'child only',
                threadId: 'thread-child',
                threadLabel: 'RR5',
                events: rootRun('inv-5', 'child only', 'b')
            })
        ]);

        // Nothing claims the child, so the continuation itself is the card — a
        // DISTINCT nested block with its own identity, never merged into the owner.
        const cards = conversations(board);
        expect(cards).toHaveLength(1);
        const childRow = cards[0].querySelector<HTMLElement>('.turn-row[data-child-thread="thread-child"]');
        expect(childRow?.querySelector('.tile-prompt')?.textContent).toBe('child only');
        expect(childRow?.querySelector('.tile-thread')?.textContent).toBe('RR5');
        expect(turnRowsIn(cards[0]).map((row) => row.querySelector('.tile-prompt')?.textContent)).toEqual([
            'owner',
            'child only'
        ]);
    });

    // The DEFECT this suite pins (T4/F1): the roster only names the LATEST run of a
    // conversation, so a live refresh that reports the resumed invocation (`inv-6`)
    // used to erase the card's join (`inv-5`), ejecting the follow-up into a duplicate
    // indented card and losing click-to-focus. The association must survive the
    // advancement because it was established while the roster still named it.
    it('keeps the child card when a roster refresh advances the invocation id', () => {
        const board = mount();
        const before = threadEntry({
            id: 'thread-child',
            sequence: 2,
            label: 'RR5',
            agent: 'Helper',
            ownerThreadId: 'thread-1',
            invocationId: 'inv-5'
        });

        board.setThreads([
            threadEntry({ id: 'thread-1', sequence: 1, label: 'RR1', invocationId: 'inv-4' }),
            before
        ]);
        board.hydrate([
            hostTurn({
                id: 'turn-1',
                index: 0,
                prompt: 'owner',
                threadId: 'thread-1',
                threadLabel: 'RR1',
                events: [
                    ...rootRun('inv-4', 'owner', 'owner answer'),
                    ...delegated('call-1', 'Helper', 'child task', 'inv-5')
                ]
            })
        ]);

        const card = board.element.querySelector<HTMLElement>('.thread-row[data-persistent-thread="thread-child"]');
        expect(card?.dataset.threadId).toBe('inv-5');

        // The follow-up lands in the card while the roster still names `inv-5`.
        board.reconcile([
            hostTurn({
                id: 'turn-1',
                index: 0,
                prompt: 'owner',
                threadId: 'thread-1',
                threadLabel: 'RR1',
                events: [
                    ...rootRun('inv-4', 'owner', 'owner answer'),
                    ...delegated('call-1', 'Helper', 'child task', 'inv-5')
                ]
            }),
            hostTurn({
                id: 'turn-2',
                index: 1,
                prompt: 'child follow-up',
                threadId: 'thread-child',
                threadLabel: 'RR5',
                events: rootRun('inv-6', 'child follow-up', 'child answer')
            })
        ]);
        expect(board.element.querySelectorAll('.thread-flow > .turn-row')).toHaveLength(1);
        expect(board.focusThread('thread-child')).toBe(true);

        // The runtime reports the resumed run: `invocationId`/`originInvocationId`
        // move to `inv-6`. This is the frame that used to break the projection.
        board.setThreads([
            threadEntry({ id: 'thread-1', sequence: 1, label: 'RR1', invocationId: 'inv-4' }),
            threadEntry({
                id: 'thread-child',
                sequence: 2,
                label: 'RR5',
                agent: 'Helper',
                ownerThreadId: 'thread-1',
                invocationId: 'inv-6',
                originInvocationId: 'inv-6',
                messages: [{ role: 'user', content: 'child task' }]
            })
        ]);

        const cards = conversations(board);
        expect(cards).toHaveLength(1);
        expect(cards[0].querySelector('.turn-row[data-child-thread]')).toBeNull();
        expect(
            [...board.element.querySelectorAll<HTMLElement>('.thread-row')].map((row) => row.dataset.persistentThread)
        ).toEqual(['thread-child']);
        expect(
            [...board.element.querySelectorAll<HTMLElement>('.thread-flow > .turn-row')].map((row) => [
                row.dataset.threadExchange,
                row.querySelector('.tile-prompt')?.textContent
            ])
        ).toEqual([['thread-child', 'child follow-up']]);
        // Click/focus still resolves the SAME child conversation after the advance.
        expect(board.focusThread('thread-child')).toBe(true);
        expect(board.focusedThread()).toBe('thread-child');
        expect(board.expanded()?.id()).toBe('turn-2');
        expect(card?.classList.contains('is-expanded')).toBe(true);
    });

    // R3 (LIVE roster advancement, authoritative): the same scenario as above but
    // with the server's historical `invocationIds` present. The card must keep its
    // conversation because the roster still NAMES the original run — not merely
    // because the board remembered it while the slot was current.
    it('keeps the child card across a live roster advance that carries the historical list', () => {
        const board = mount();
        const ownerTurn = hostTurn({
            id: 'turn-1',
            index: 0,
            prompt: 'owner',
            threadId: 'thread-1',
            threadLabel: 'RR1',
            events: [
                ...rootRun('inv-4', 'owner', 'owner answer'),
                ...delegated('call-1', 'Helper', 'child task', 'inv-5')
            ]
        });
        const followTurn = hostTurn({
            id: 'turn-2',
            index: 1,
            prompt: 'child follow-up',
            threadId: 'thread-child',
            threadLabel: 'RR5',
            events: rootRun('inv-6', 'child follow-up', 'child answer')
        });

        board.setThreads([
            threadEntry({ id: 'thread-1', sequence: 1, label: 'RR1', invocationId: 'inv-4' }),
            threadEntry({
                id: 'thread-child',
                sequence: 2,
                label: 'RR5',
                agent: 'Helper',
                ownerThreadId: 'thread-1',
                invocationId: 'inv-5',
                invocationIds: ['inv-5']
            })
        ]);
        board.hydrate([ownerTurn]);

        board.reconcile([ownerTurn, followTurn]);
        expect(board.focusThread('thread-child')).toBe(true);

        // The roster refresh advances the live slot to the continuation run. The
        // historical list now names both, so the ORIGINAL card is still provable.
        board.setThreads([
            threadEntry({ id: 'thread-1', sequence: 1, label: 'RR1', invocationId: 'inv-4' }),
            threadEntry({
                id: 'thread-child',
                sequence: 2,
                label: 'RR5',
                agent: 'Helper',
                ownerThreadId: 'thread-1',
                invocationId: 'inv-6',
                originInvocationId: 'inv-6',
                invocationIds: ['inv-5', 'inv-6'],
                messages: [{ role: 'user', content: 'child task' }]
            })
        ]);

        const cards = conversations(board);
        expect(cards).toHaveLength(1);
        expect(
            [...board.element.querySelectorAll<HTMLElement>('.thread-row')].map((row) => row.dataset.persistentThread)
        ).toEqual(['thread-child']);
        expect(
            [...board.element.querySelectorAll<HTMLElement>('.thread-flow > .turn-row')].map((row) => [
                row.dataset.threadExchange,
                row.querySelector('.tile-prompt')?.textContent
            ])
        ).toEqual([['thread-child', 'child follow-up']]);
        expect(board.focusedThread()).toBe('thread-child');
        expect(board.expanded()?.id()).toBe('turn-2');
    });

    // R3 (session scope): invocation ids are unique per SESSION only. A remembered
    // join from the conversation being left must never resolve an invocation of the
    // next session to a thread that session does not have.
    it('drops remembered invocation joins on a session switch', () => {
        const board = mount();
        board.bindSession('session-1');
        board.setThreads([
            threadEntry({ id: 'thread-1', sequence: 1, label: 'RR1', invocationId: 'inv-4' }),
            threadEntry({
                id: 'thread-child',
                sequence: 2,
                label: 'RR5',
                agent: 'Helper',
                ownerThreadId: 'thread-1',
                invocationId: 'inv-5'
            })
        ]);
        board.hydrate([
            hostTurn({
                id: 'turn-1',
                index: 0,
                prompt: 'owner',
                threadId: 'thread-1',
                threadLabel: 'RR1',
                events: [
                    ...rootRun('inv-4', 'owner', 'owner answer'),
                    ...delegated('call-1', 'Helper', 'child task', 'inv-5')
                ]
            })
        ]);
        expect(
            [...board.element.querySelectorAll<HTMLElement>('.thread-row')].map((row) => row.dataset.persistentThread)
        ).toEqual(['thread-child']);

        // A DIFFERENT session reuses the invocation id `inv-5` for an unrelated
        // conversation, and its roster does not list `thread-child` at all.
        board.bindSession('session-2');
        board.setThreads([threadEntry({ id: 'thread-9', sequence: 1, label: 'WR1', agent: 'writer' })]);
        board.hydrate([
            hostTurn({
                id: 'turn-1',
                index: 0,
                prompt: 'other owner',
                threadId: 'thread-9',
                threadLabel: 'WR1',
                events: [
                    ...rootRun('inv-4', 'other owner', 'other answer'),
                    ...delegated('call-1', 'Helper', 'child task', 'inv-5')
                ]
            })
        ]);

        // No join: the old session's remembered association is gone and the new
        // roster never named this invocation.
        expect(
            [...board.element.querySelectorAll<HTMLElement>('.thread-row')].map((row) => row.dataset.persistentThread)
        ).toEqual([undefined]);
        expect(board.element.querySelectorAll('.thread-flow > .turn-row')).toHaveLength(0);
    });

    it('keeps ONE child card and ordered exchanges across repeated resumptions', () => {
        const board = mount();
        const owner = hostTurn({
            id: 'turn-1',
            index: 0,
            prompt: 'owner',
            threadId: 'thread-1',
            threadLabel: 'RR1',
            events: [
                ...rootRun('inv-4', 'owner', 'owner answer'),
                ...delegated('call-1', 'Helper', 'child task', 'inv-5')
            ]
        });
        const followUp = (id: string, index: number, invocation: string, prompt: string): SessionTurn =>
            hostTurn({
                id,
                index,
                prompt,
                threadId: 'thread-child',
                threadLabel: 'RR5',
                events: rootRun(invocation, prompt, `${prompt} answer`)
            });

        // First resumption: the roster names `inv-6` and its historical list still
        // names the original delegated `inv-5`.
        board.setThreads([
            threadEntry({ id: 'thread-1', sequence: 1, label: 'RR1', invocationId: 'inv-4' }),
            threadEntry({
                id: 'thread-child',
                sequence: 2,
                label: 'RR5',
                agent: 'Helper',
                ownerThreadId: 'thread-1',
                invocationId: 'inv-6',
                originInvocationId: 'inv-6',
                invocationIds: ['inv-5', 'inv-6'],
                messages: [{ role: 'user', content: 'child task' }]
            })
        ]);
        board.hydrate([owner, followUp('turn-2', 1, 'inv-6', 'follow one')]);

        // Second resumption: the roster now names `inv-7`; a second exchange arrives.
        // The historical list grew by exactly the resume, so BOTH earlier runs stay
        // joinable and neither card/exchange is duplicated.
        board.setThreads([
            threadEntry({ id: 'thread-1', sequence: 1, label: 'RR1', invocationId: 'inv-4' }),
            threadEntry({
                id: 'thread-child',
                sequence: 2,
                label: 'RR5',
                agent: 'Helper',
                ownerThreadId: 'thread-1',
                invocationId: 'inv-7',
                originInvocationId: 'inv-7',
                invocationIds: ['inv-5', 'inv-6', 'inv-7'],
                messages: [{ role: 'user', content: 'child task' }]
            })
        ]);
        board.reconcile([
            owner,
            followUp('turn-2', 1, 'inv-6', 'follow one'),
            followUp('turn-3', 2, 'inv-7', 'follow two')
        ]);

        const cards = conversations(board);
        expect(cards).toHaveLength(1);
        expect(
            [...board.element.querySelectorAll<HTMLElement>('.thread-row')].map((row) => row.dataset.persistentThread)
        ).toEqual(['thread-child']);
        expect(
            [...board.element.querySelectorAll<HTMLElement>('.thread-flow > .turn-row')].map((row) => [
                row.dataset.threadExchange,
                row.querySelector('.tile-prompt')?.textContent
            ])
        ).toEqual([
            ['thread-child', 'follow one'],
            ['thread-child', 'follow two']
        ]);
        // The owner card still holds only its own exchange.
        expect(turnRowsIn(cards[0]).map((row) => row.querySelector('.tile-prompt')?.textContent)).toEqual(['owner']);
    });

    // R3 (authoritative, fresh hydration): two delegated HELPERS with the SAME task
    // text, both ALREADY resumed. Content alone cannot separate them, so the join is
    // taken from `invocationIds` — the server's persisted invocation→thread roster —
    // and each invocation card binds to ITS OWN conversation, in the recorded order.
    it('assigns identical sibling delegations to their own conversations on fresh hydration', () => {
        const board = mount();
        board.setThreads([
            threadEntry({ id: 'thread-1', sequence: 1, label: 'RR1', invocationId: 'inv-4' }),
            threadEntry({
                id: 'thread-child-a',
                sequence: 2,
                label: 'RR5',
                agent: 'Helper',
                ownerThreadId: 'thread-1',
                invocationId: 'inv-a2',
                invocationIds: ['inv-a', 'inv-a2'],
                messages: [{ role: 'user', content: 'same task' }]
            }),
            threadEntry({
                id: 'thread-child-b',
                sequence: 3,
                label: 'RR6',
                agent: 'Helper',
                ownerThreadId: 'thread-1',
                invocationId: 'inv-b2',
                invocationIds: ['inv-b', 'inv-b2'],
                messages: [{ role: 'user', content: 'same task' }]
            })
        ]);

        board.hydrate([
            hostTurn({
                id: 'turn-1',
                index: 0,
                prompt: 'owner',
                threadId: 'thread-1',
                threadLabel: 'RR1',
                events: [
                    ...rootRun('inv-4', 'owner', 'owner answer'),
                    ...delegated('call-a', 'Helper', 'same task', 'inv-a'),
                    ...delegated('call-b', 'Helper', 'same task', 'inv-b')
                ]
            }),
            hostTurn({
                id: 'turn-2',
                index: 1,
                prompt: 'follow a',
                threadId: 'thread-child-a',
                threadLabel: 'RR5',
                events: rootRun('inv-a2', 'follow a', 'answer a')
            }),
            hostTurn({
                id: 'turn-3',
                index: 2,
                prompt: 'follow b',
                threadId: 'thread-child-b',
                threadLabel: 'RR6',
                events: rootRun('inv-b2', 'follow b', 'answer b')
            })
        ]);

        // Each invocation card carries ITS conversation, in spawn order, and each
        // resumed exchange landed inside the matching card (never swapped).
        const cards = conversations(board);
        expect(cards).toHaveLength(1);
        const childCards = [
            ...cards[0].querySelectorAll<HTMLElement>(':scope > .turn-row > .thread-children > .thread-row')
        ];
        expect(
            childCards.map((card) => [
                card.dataset.threadId,
                card.dataset.persistentThread,
                card.querySelector('.thread-name')?.textContent,
                [...card.querySelectorAll<HTMLElement>('.thread-flow > .turn-row')].map((row) => [
                    row.dataset.threadExchange,
                    row.querySelector('.tile-prompt')?.textContent,
                    row.querySelector('.agent-text')?.textContent
                ])
            ])
        ).toEqual([
            ['inv-a', 'thread-child-a', 'RR5', [['thread-child-a', 'follow a', 'answer a\n']]],
            ['inv-b', 'thread-child-b', 'RR6', [['thread-child-b', 'follow b', 'answer b\n']]]
        ]);
        // The owner card still holds exactly its own exchange; nothing was folded in.
        expect(turnRowsIn(cards[0])).toHaveLength(1);
        expect(cards[0].querySelector('.turn-row[data-child-thread]')).toBeNull();
        // Focus still resolves each child conversation to its own card.
        expect(board.focusThread('thread-child-a')).toBe(true);
        expect(board.focusedThread()).toBe('thread-child-a');
        expect(childCards[0].classList.contains('is-expanded')).toBe(true);
        expect(board.focusThread('thread-child-b')).toBe(true);
        expect(board.focusedThread()).toBe('thread-child-b');
        expect(childCards[1].classList.contains('is-expanded')).toBe(true);
        expect(childCards[0].classList.contains('is-expanded')).toBe(false);
    });

    // R3 (conservative degradation): the SAME ambiguous pair WITHOUT the historical
    // list. Nothing on the wire distinguishes the cards from the conversations, so the
    // board must NOT guess from task text/agent: no join, no merged thread, and each
    // continuation stays its own distinct card.
    it('never merges ambiguous sibling threads when the historical roster is absent', () => {
        const board = mount();
        // Two delegated HELPERS with the SAME task text and two matching child
        // conversations. Nothing distinguishes the pairs, so neither card may claim
        // either conversation: a wrong merge would mix two agent threads.
        board.setThreads([
            threadEntry({ id: 'thread-1', sequence: 1, label: 'RR1', invocationId: 'inv-4' }),
            threadEntry({
                id: 'thread-child-a',
                sequence: 2,
                label: 'RR5',
                agent: 'Helper',
                ownerThreadId: 'thread-1',
                invocationId: 'inv-a2',
                messages: [{ role: 'user', content: 'same task' }]
            }),
            threadEntry({
                id: 'thread-child-b',
                sequence: 3,
                label: 'RR6',
                agent: 'Helper',
                ownerThreadId: 'thread-1',
                invocationId: 'inv-b2',
                messages: [{ role: 'user', content: 'same task' }]
            })
        ]);

        board.hydrate([
            hostTurn({
                id: 'turn-1',
                index: 0,
                prompt: 'owner',
                threadId: 'thread-1',
                threadLabel: 'RR1',
                events: [
                    ...rootRun('inv-4', 'owner', 'owner answer'),
                    ...delegated('call-a', 'Helper', 'same task', 'inv-a'),
                    ...delegated('call-b', 'Helper', 'same task', 'inv-b')
                ]
            }),
            hostTurn({
                id: 'turn-2',
                index: 1,
                prompt: 'follow a',
                threadId: 'thread-child-a',
                threadLabel: 'RR5',
                events: rootRun('inv-a2', 'follow a', 'answer a')
            }),
            hostTurn({
                id: 'turn-3',
                index: 2,
                prompt: 'follow b',
                threadId: 'thread-child-b',
                threadLabel: 'RR6',
                events: rootRun('inv-b2', 'follow b', 'answer b')
            })
        ]);

        // No join was made: no card was marked, and no invocation has an exchange inside.
        expect(
            [...board.element.querySelectorAll<HTMLElement>('.thread-row')].map((row) => row.dataset.persistentThread)
        ).toEqual([undefined, undefined]);
        expect(board.element.querySelectorAll('.thread-flow > .turn-row')).toHaveLength(0);
        // Each continuation stays its OWN distinct nested card (never merged).
        const childRows = [
            ...board.element.querySelectorAll<HTMLElement>('.conversation > .turn-row[data-child-thread]')
        ];
        expect(
            childRows.map((row) => [row.dataset.childThread, row.querySelector('.tile-prompt')?.textContent])
        ).toEqual([
            ['thread-child-a', 'follow a'],
            ['thread-child-b', 'follow b']
        ]);
    });

    // OWNERSHIP IS REQUIRED EVIDENCE. Without `ownerThreadId` the task text alone
    // cannot separate "a resumed runtime child" from "a user-created conversation whose
    // first prompt happens to be the same string", so the board does NOT guess: the
    // continuation stays its own distinct card (honest, if redundant). The
    // authoritative fix is the server's `invocationIds` roster, which is exercised by
    // the tests above; this case pins that a payload without it degrades conservatively.
    it('does not guess a join when the roster omits ownership', () => {
        const board = mount();
        board.setThreads([
            threadEntry({ id: 'thread-1', sequence: 1, label: 'RR1', invocationId: 'inv-4' }),
            threadEntry({
                id: 'thread-child',
                sequence: 2,
                label: 'RR5',
                agent: 'Helper',
                invocationId: 'inv-6',
                messages: [{ role: 'user', content: 'child task' }]
            })
        ]);

        board.hydrate([
            hostTurn({
                id: 'turn-1',
                index: 0,
                prompt: 'owner',
                threadId: 'thread-1',
                threadLabel: 'RR1',
                events: [
                    ...rootRun('inv-4', 'owner', 'owner answer'),
                    ...delegated('call-1', 'Helper', 'child task', 'inv-5')
                ]
            }),
            hostTurn({
                id: 'turn-2',
                index: 1,
                prompt: 'child follow-up',
                threadId: 'thread-child',
                threadLabel: 'RR5',
                events: rootRun('inv-6', 'child follow-up', 'child answer')
            })
        ]);

        // No join was invented: the invocation card stays unmarked and the follow-up is
        // the child's OWN distinct card (never folded into an unrelated conversation).
        expect(board.element.querySelectorAll('.thread-flow > .turn-row')).toHaveLength(0);
        expect(
            [...board.element.querySelectorAll<HTMLElement>('.thread-row')].map((row) => row.dataset.persistentThread)
        ).toEqual([undefined]);
        // Without an owner the continuation is its own top-level card, still separate
        // from the owner — nothing was folded into another conversation.
        expect(conversations(board).map((host) => host.dataset.threadId)).toEqual(['thread-1', 'thread-child']);
        expect(conversations(board)[1].querySelector('.tile-prompt')?.textContent).toBe('child follow-up');
    });
});

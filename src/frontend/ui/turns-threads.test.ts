// Invocation thread entries (R1–R5).
//
// A delegated agent is its own entry, not another flat section inside the turn:
//   - the row lives in the spawning invocation's children host, INSIDE the turn
//     row but OUTSIDE every `.tile-body`/`.thread-body`, so collapsing either
//     parent never hides its descendants;
//   - entries are per INVOCATION (two same-agent delegates are two rows) and are
//     nested by `thread.parentId`, giving depth-first sibling order for free;
//   - status/outcome come from the child's own events and from the parent's
//     `tool_result` for the spawning `callId` (the authoritative completion);
//   - saved sessions predating the metadata still render rows inferred from
//     `agentDelegate` calls, while genuinely unattributable legacy streams keep
//     the old flat agent sections.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/turns-threads.test.ts

import type { HarnessAssistantMessage, HarnessEvent, SessionTurn } from '../../server/protocol';
import { findLatestAgentResultBlock, listAgentResultBlocks } from '../../shared/agent-results';
import { createTurnBoard } from './turns';
import type { TurnHandle } from './turns';

const doneMessage = (agent: string): HarnessAssistantMessage => ({
    role: 'assistant',
    content: 'answer',
    reasoning: '',
    toolCalls: [],
    model: `${agent}-model`,
    stopReason: 'stop'
});

// Attach frozen `thread` metadata to an otherwise ordinary event. Cast because the
// running server types gain the optional field from the runtime worker; the UI
// treats it structurally (contract.ts `threadOf`).
const withThread = (
    event: Record<string, unknown>,
    thread: Record<string, unknown>
): HarnessEvent => ({ ...event, thread } as unknown as HarnessEvent);

const delegateCall = (agent: string, input: string, id: string, from?: string): HarnessEvent => {
    const event = {
        type: 'tool_call',
        agent: from ?? 'writer',
        call: { id, name: 'agentDelegate', arguments: JSON.stringify({ agent, input }) }
    };
    return from === undefined ? (event as unknown as HarnessEvent) : withThread(event, { id: from });
};

const serverTurn = (
    options: {
        id?: string;
        index?: number;
        prompt?: string;
        status?: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
        events?: HarnessEvent[];
    } = {}
): SessionTurn => ({
    id: options.id ?? 'turn-1',
    index: options.index ?? 0,
    prompt: options.prompt ?? 'task',
    status: options.status ?? 'done',
    startedAt: 5,
    updatedAt: 10,
    events: options.events ?? []
});

type ThreadProjection = {
    id: string | undefined;
    depth: string | undefined;
    agent: string | undefined;
    state: string | undefined;
    name: string;
    status: string;
    preview: string;
    text: string | undefined;
    outcome: string | undefined;
};

const threadRows = (turn: TurnHandle): HTMLElement[] => [
    ...((turn.element.parentElement as HTMLElement).querySelectorAll<HTMLElement>('.thread-row') ?? [])
];

const project = (row: HTMLElement): ThreadProjection => {
    const outcome = row.querySelector<HTMLElement>('.thread-outcome');
    const text = row.querySelector('.agent-text');
    return {
        id: row.dataset.threadId,
        depth: row.dataset.depth,
        agent: row.dataset.agent,
        state: row.dataset.state,
        name: row.querySelector('.thread-name')?.textContent ?? '',
        status: row.querySelector('.thread-status')?.textContent ?? '',
        preview: row.querySelector('.thread-preview')?.textContent ?? '',
        text: text === null ? undefined : (text.textContent ?? ''),
        outcome:
            outcome === null || outcome.hidden ? undefined : (outcome.textContent ?? '')
    };
};

const mount = () => {
    const board = createTurnBoard({});
    document.body.replaceChildren(board.element);
    return board;
};

describe('invocation thread entries', () => {
    it('shows a queued delegate entry outside the parent body and expands it independently', () => {
        const board = mount();
        const turn = board.begin('root task');
        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply(delegateCall('helper', 'look up the docs', 'd1'));

        // The placeholder exists as soon as the call is made: the user sees WHO was
        // called before the child ever starts.
        const host = turn.element.nextElementSibling as HTMLElement;
        expect(host.className).toBe('thread-children');

        const row = host.firstElementChild as HTMLElement;
        expect(row.className).toBe('thread-row');
        expect(row.dataset.threadId).toBe('call:d1');
        expect(row.dataset.depth).toBe('1');
        expect(row.dataset.agent).toBe('helper');
        expect(row.dataset.state).toBe('queued');
        expect(project(row)).toEqual({
            id: 'call:d1',
            depth: '1',
            agent: 'helper',
            state: 'queued',
            name: 'HR1',
            status: 'queued',
            preview: 'look up the docs',
            text: undefined,
            outcome: undefined
        });

        // R1: the row is NOT inside the tile (whose body is hidden when collapsed).
        expect(turn.element.querySelectorAll('.thread-row')).toHaveLength(0);
        expect(turn.element.querySelector('.tile-body')?.contains(row)).toBe(false);
        expect(row.closest('.tile-body')).toBeNull();

        // R1: collapsing the parent tile hides only the tile body; the entry stays.
        board.collapse();
        expect(turn.element.classList.contains('is-expanded')).toBe(false);
        expect(row.isConnected).toBe(true);

        // Independent expansion: the child opens while the parent stays collapsed.
        const select = row.querySelector<HTMLButtonElement>('.thread-select');
        expect(select).not.toBeNull();
        expect(select?.tagName).toBe('BUTTON');
        expect(select?.type).toBe('button');
        // A real button is the whole keyboard contract: Enter/Space activate it
        // natively, and it is a natural tab stop (no artificial tabindex).
        expect(select?.hasAttribute('tabindex')).toBe(false);
        expect(select?.disabled).toBe(false);
        expect(select?.getAttribute('aria-expanded')).toBe('false');
        const bodyId = select?.getAttribute('aria-controls');
        expect(bodyId).toBe(row.querySelector<HTMLElement>('.thread-body')?.id);

        select?.click();
        expect(row.classList.contains('is-expanded')).toBe(true);
        expect(select?.getAttribute('aria-expanded')).toBe('true');
        expect(turn.element.classList.contains('is-expanded')).toBe(false);

        select?.focus();
        expect(document.activeElement).toBe(select);

        select?.click();
        expect(row.classList.contains('is-expanded')).toBe(false);
        expect(select?.getAttribute('aria-expanded')).toBe('false');
    });

    it('keeps two same-agent invocations separate and settles each by its own callId', () => {
        const board = mount();
        const turn = board.begin('delegate twice');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply(delegateCall('helper', 'first task', 'd1'));
        turn.apply(
            withThread({ type: 'start', agent: 'helper', model: 'h1' }, { id: 't1', callId: 'd1', input: 'first task' })
        );
        turn.apply(withThread({ type: 'text', agent: 'helper', delta: 'first answer' }, { id: 't1' }));
        turn.apply(withThread({ type: 'done', agent: 'helper', message: doneMessage('helper') }, { id: 't1' }));
        turn.apply({
            type: 'tool_result',
            agent: 'writer',
            name: 'agentDelegate',
            callId: 'd1',
            content: 'first outcome',
            isError: false
        });

        const host = turn.element.nextElementSibling as HTMLElement;
        // The placeholder was ADOPTED, not duplicated.
        expect(host.querySelectorAll('.thread-row')).toHaveLength(1);
        expect(threadRows(turn).map(project)).toEqual([
            {
                id: 't1',
                depth: '1',
                agent: 'helper',
                state: 'done',
                name: 'HR1',
                status: 'done',
                preview: 'first task',
                text: 'first answer\n',
                outcome: 'outcome · first outcome'
            }
        ]);

        turn.apply(delegateCall('helper', 'second task', 'd2'));
        turn.apply(
            withThread({ type: 'start', agent: 'helper', model: 'h1' }, { id: 't2', callId: 'd2', input: 'second task' })
        );
        turn.flush();

        // Two invocations of the SAME agent: separate rows, separate ids, sibling order.
        expect([...host.children].map((child) => (child as HTMLElement).dataset.threadId)).toEqual(['t1', 't2']);
        expect(threadRows(turn).map((row) => row.dataset.state)).toEqual(['done', 'streaming']);

        turn.apply({
            type: 'tool_result',
            agent: 'writer',
            name: 'agentDelegate',
            callId: 'd2',
            content: 'second outcome',
            isError: false
        });

        expect(threadRows(turn).map(project)).toEqual([
            {
                id: 't1',
                depth: '1',
                agent: 'helper',
                state: 'done',
                name: 'HR1',
                status: 'done',
                preview: 'first task',
                text: 'first answer\n',
                outcome: 'outcome · first outcome'
            },
            {
                id: 't2',
                depth: '1',
                agent: 'helper',
                state: 'done',
                name: 'HR2',
                status: 'done',
                preview: 'second task',
                text: undefined,
                outcome: 'outcome · second outcome'
            }
        ]);

        // Counting is per invocation: root + two helper entries, two delegate calls.
        expect(turn.element.querySelector('.tile-meta')?.textContent).toBe('3 agents · 2 tool calls');
    });

    it('nests grandchildren depth-first with depth 2 indentation', () => {
        const board = mount();
        const turn = board.begin('nested');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply(delegateCall('helper', 'child task', 'd1'));
        turn.apply(
            withThread({ type: 'start', agent: 'helper', model: 'h1' }, { id: 't1', callId: 'd1', input: 'child task' })
        );
        // The helper delegates further. Execution permissions are unchanged; the UI
        // simply renders the nested metadata it is given.
        turn.apply(delegateCall('deeper', 'grand task', 'd2', 't1'));
        turn.apply(
            withThread(
                { type: 'start', agent: 'deeper', model: 'g1' },
                { id: 't3', parentId: 't1', callId: 'd2', input: 'grand task' }
            )
        );
        turn.apply(
            withThread({ type: 'text', agent: 'deeper', delta: 'grand answer' }, { id: 't3' })
        );
        // Sibling of the first child, spawned later: it must come AFTER the whole
        // first subtree, not between t1 and its grandchild.
        turn.apply(delegateCall('helper', 'second child', 'd5'));
        turn.apply(
            withThread({ type: 'start', agent: 'helper', model: 'h1' }, { id: 't5', callId: 'd5', input: 'second child' })
        );
        turn.flush();

        const host = turn.element.nextElementSibling as HTMLElement;
        // Root host: only direct children (t1, t5). The grandchild lives inside t1.
        expect([...host.children].map((child) => (child as HTMLElement).dataset.threadId)).toEqual(['t1', 't5']);
        expect(threadRows(turn).map((row) => row.dataset.threadId)).toEqual(['t1', 't3', 't5']);
        expect(threadRows(turn).map((row) => row.dataset.depth)).toEqual(['1', '2', '1']);
        // R2: the code is per INVOCATION and ordered by spawn, at any depth:
        // helper → HR1, deeper → DR1, the second helper → HR2.
        expect(threadRows(turn).map((row) => row.querySelector('.thread-name')?.textContent)).toEqual([
            'HR1',
            'DR1',
            'HR2'
        ]);

        const t1 = host.children[0] as HTMLElement;
        const nestedHost = t1.lastElementChild as HTMLElement;
        expect(nestedHost.className).toBe('thread-children');
        const t3 = nestedHost.firstElementChild as HTMLElement;
        expect(t3.dataset.threadId).toBe('t3');
        // Descendants are outside t1's body, so collapsing t1 keeps them visible.
        expect(t1.querySelector('.thread-body')?.contains(t3)).toBe(false);
        expect(t1.querySelector('.thread-flow')?.contains(t3)).toBe(false);

        // Per-invocation content and tools: t1 owns its own delegate card, the root
        // tile owns the two root-level calls.
        expect(t1.querySelectorAll('details.tool')).toHaveLength(1);
        expect(turn.element.querySelectorAll('details.tool')).toHaveLength(2);
        expect(t3.querySelector('.agent-text')?.textContent).toBe('grand answer\n');
    });

    it('treats an interim done with pending work as still active', () => {
        const board = mount();
        const turn = board.begin('paused');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply(delegateCall('helper', 'long task', 'd1'));
        turn.apply(
            withThread({ type: 'start', agent: 'helper', model: 'h1' }, { id: 't1', callId: 'd1', input: 'long task' })
        );
        turn.apply(
            withThread(
                {
                    type: 'done',
                    agent: 'helper',
                    message: doneMessage('helper'),
                    pending: [{ callId: 'p1', name: 'fileRead', elapsedMs: 1200 }]
                },
                { id: 't1' }
            )
        );

        const row = threadRows(turn)[0];
        // R6 + R3: the response is not the finish; the invocation is still running.
        expect(row.dataset.state).toBe('streaming');
        expect(row.querySelector('.thread-status')?.textContent).toBe('streaming');
        expect(row.querySelector('.agent-pending')?.textContent).toBe('pending · fileRead 1.2s');
        expect(row.querySelector('.agent-meta')?.textContent).toBe('helper-model · stop · 1 tool still running');

        turn.apply({
            type: 'tool_result',
            agent: 'writer',
            name: 'agentDelegate',
            callId: 'd1',
            content: 'final answer',
            isError: false
        });

        expect(row.dataset.state).toBe('done');
        expect(row.querySelector('.thread-outcome')?.textContent).toBe('outcome · final answer');
        expect(row.querySelector<HTMLElement>('.thread-outcome')?.hidden).toBe(false);
    });

    it('terminalizes the matching sibling only when the parent result is an error', () => {
        const board = mount();
        const turn = board.begin('mixed');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply(delegateCall('helper', 'first', 'd1'));
        turn.apply(withThread({ type: 'start', agent: 'helper', model: 'h1' }, { id: 't1', callId: 'd1', input: 'first' }));
        turn.apply(delegateCall('helper', 'second', 'd2'));
        turn.apply(withThread({ type: 'start', agent: 'helper', model: 'h1' }, { id: 't2', callId: 'd2', input: 'second' }));

        turn.apply({
            type: 'tool_result',
            agent: 'writer',
            name: 'agentDelegate',
            callId: 'd1',
            content: 'delegate exploded',
            isError: true
        });

        expect(threadRows(turn).map((row) => row.dataset.state)).toEqual(['error', 'streaming']);
        expect(threadRows(turn).map((row) => project(row).outcome)).toEqual([
            'error · delegate exploded',
            undefined
        ]);

        turn.apply({
            type: 'tool_result',
            agent: 'writer',
            name: 'agentDelegate',
            callId: 'd2',
            content: 'second outcome',
            isError: false
        });
        expect(threadRows(turn).map((row) => row.dataset.state)).toEqual(['error', 'done']);

        // A delegation cancelled BEFORE its child ever started is resolved by the
        // parent's result for its callId: the queued placeholder must not linger.
        turn.apply(delegateCall('helper', 'cancelled before start', 'd3'));
        expect(threadRows(turn)[2].dataset.state).toBe('queued');

        turn.apply({
            type: 'tool_result',
            agent: 'writer',
            name: 'agentDelegate',
            callId: 'd3',
            content: 'delegation cancelled',
            isError: true
        });
        expect(threadRows(turn)[2].dataset.state).toBe('error');
        expect(project(threadRows(turn)[2]).outcome).toBe('error · delegation cancelled');
    });

    it('terminalizes a cancelled delegation as cancelled, never as an error', () => {
        // R1: the runtime marks a toolCancel release with outcome 'cancelled'; the
        // child row must show that control outcome in its own state (info tone)
        // instead of turning red like a provider failure.
        const board = mount();
        const turn = board.begin('cancel');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply(delegateCall('helper', 'slow', 'd1'));
        turn.apply(withThread({ type: 'start', agent: 'helper', model: 'h1' }, { id: 't1', callId: 'd1', input: 'slow' }));

        turn.apply({
            type: 'tool_result',
            agent: 'writer',
            name: 'agentDelegate',
            callId: 'd1',
            content: 'Tool call "agentDelegate" (d1) was cancelled before it completed; no result is available.',
            isError: true,
            outcome: 'cancelled'
        });

        const [row] = threadRows(turn);
        expect(row.dataset.state).toBe('cancelled');
        expect(row.querySelector('.thread-status')?.textContent).toBe('cancelled');
        expect(project(row).outcome).toBe(
            'cancelled · Tool call "agentDelegate" (d1) was cancelled before it completed; no result is available.'
        );
        expect(row.querySelector<HTMLElement>('.thread-outcome')?.dataset.tone).toBe('info');
    });

    it('infers repeated same-agent legacy delegations from their spawning calls', () => {
        const board = mount();

        const [turn] = board.hydrate(
            [
                serverTurn({
                    events: [
                        { type: 'start', agent: 'writer', model: 'm1' },
                        delegateCall('helper', 'first task', 'd1'),
                        { type: 'start', agent: 'helper', model: 'h1' },
                        { type: 'text', agent: 'helper', delta: 'one' },
                        { type: 'done', agent: 'helper', message: doneMessage('helper') },
                        {
                            type: 'tool_result',
                            agent: 'writer',
                            name: 'agentDelegate',
                            callId: 'd1',
                            content: 'first answer',
                            isError: false
                        },
                        delegateCall('helper', 'second task', 'd2'),
                        { type: 'start', agent: 'helper', model: 'h1' },
                        { type: 'text', agent: 'helper', delta: 'two' },
                        { type: 'done', agent: 'helper', message: doneMessage('helper') },
                        {
                            type: 'tool_result',
                            agent: 'writer',
                            name: 'agentDelegate',
                            callId: 'd2',
                            content: 'second answer',
                            isError: false
                        }
                    ]
                })
            ],
            { model: 'm1' }
        );

        // Synthetic ids are stable and derived from the spawning call, so replaying
        // the same record twice cannot produce different ancestry.
        expect(threadRows(turn).map(project)).toEqual([
            {
                id: 'call:d1',
                depth: '1',
                agent: 'helper',
                state: 'done',
                name: 'HR1',
                status: 'done',
                preview: 'first task',
                text: 'one\n',
                outcome: 'outcome · first answer'
            },
            {
                id: 'call:d2',
                depth: '1',
                agent: 'helper',
                state: 'done',
                name: 'HR2',
                status: 'done',
                preview: 'second task',
                text: 'two\n',
                outcome: 'outcome · second answer'
            }
        ]);
        // Each invocation owns its own prose: the second did not merge into the first.
        expect(threadRows(turn)[0].querySelector('.agent-text')?.textContent).toBe('one\n');
        expect(threadRows(turn)[1].querySelector('.agent-text')?.textContent).toBe('two\n');
        expect(turn.element.querySelectorAll('.thread-row')).toHaveLength(0);
        expect(turn.element.querySelector('.tile-meta')?.textContent).toBe('3 agents · 2 tool calls · m1');
    });

    it('renders the same explicit identity from live frames and from a saved record', () => {
        const events: HarnessEvent[] = [
            { type: 'start', agent: 'writer', model: 'm1' },
            delegateCall('helper', 'same task', 'd1'),
            withThread(
                { type: 'start', agent: 'helper', model: 'h1' },
                { id: 't1', callId: 'd1', input: 'same task' }
            ),
            withThread({ type: 'text', agent: 'helper', delta: 'same answer' }, { id: 't1' }),
            withThread({ type: 'done', agent: 'helper', message: doneMessage('helper') }, { id: 't1' }),
            {
                type: 'tool_result',
                agent: 'writer',
                name: 'agentDelegate',
                callId: 'd1',
                content: 'same outcome',
                isError: false
            }
        ];

        const liveBoard = mount();
        const live = liveBoard.begin('same task');
        for (const event of events) live.apply(event);
        live.flush();

        const replayBoard = mount();
        const [replay] = replayBoard.hydrate([serverTurn({ events })], { model: 'm1' });

        expect(threadRows(live).map(project)).toEqual(threadRows(replay).map(project));
        expect(threadRows(live).map(project)).toEqual([
            {
                id: 't1',
                depth: '1',
                agent: 'helper',
                state: 'done',
                name: 'HR1',
                status: 'done',
                preview: 'same task',
                text: 'same answer\n',
                outcome: 'outcome · same outcome'
            }
        ]);
        expect(live.summary()).toEqual({ agents: 2, tools: 1, primary: 'writer' });
        expect(replay.summary()).toEqual({ agents: 2, tools: 1, primary: 'writer' });
    });

    it('merges an authoritative record without duplicating or orphaning entries', () => {
        const board = mount();
        const turn = board.begin('merge');

        const events: HarnessEvent[] = [
            { type: 'start', agent: 'writer', model: 'm1' },
            delegateCall('helper', 'task', 'd1'),
            withThread({ type: 'start', agent: 'helper', model: 'h1' }, { id: 't1', callId: 'd1', input: 'task' }),
            withThread({ type: 'text', agent: 'helper', delta: 'hello' }, { id: 't1' })
        ];
        for (const event of events) turn.apply(event);
        turn.flush();

        const host = turn.element.nextElementSibling as HTMLElement;
        turn.merge(serverTurn({ status: 'running', events }));

        expect(turn.applied()).toBe(4);
        expect(host.querySelectorAll('.thread-row')).toHaveLength(1);
        expect(host.querySelectorAll('.thread-body')).toHaveLength(1);
        expect(threadRows(turn)[0].querySelector('.agent-text')?.textContent).toBe('hello\n');

        // A record whose prefix DISAGREES supersedes the projection: rebuild it from
        // the record and drop every row the discarded projection created.
        const superseding: HarnessEvent[] = [
            events[0],
            events[1],
            events[2],
            withThread({ type: 'text', agent: 'helper', delta: 'replayed' }, { id: 't1' })
        ];
        turn.merge({ ...serverTurn({ status: 'running', events: superseding }), updatedAt: 11 });

        expect(turn.applied()).toBe(4);
        expect(host.querySelectorAll('.thread-row')).toHaveLength(1);
        expect(host.querySelectorAll('.thread-body')).toHaveLength(1);
        expect(turn.element.querySelectorAll('details.tool')).toHaveLength(1);
        expect(host.querySelectorAll('.agent-text')).toHaveLength(1);
        expect(threadRows(turn)[0].querySelector('.agent-text')?.textContent).toBe('replayed\n');

        // Clearing the board removes the whole turn row, entries and descendants
        // included (no orphan rows survive).
        board.clear();
        expect(document.querySelectorAll('.thread-row')).toHaveLength(0);
    });

    it('closes unfinished descendants when the root turn goes terminal', () => {
        const board = mount();

        const cancelled = board.begin('cancel');
        cancelled.apply({ type: 'start', agent: 'writer', model: 'm1' });
        cancelled.apply(delegateCall('helper', 'child task', 'd1'));
        cancelled.apply(
            withThread({ type: 'start', agent: 'helper', model: 'h1' }, { id: 't1', callId: 'd1', input: 'child task' })
        );
        cancelled.setState('cancelled', 'stopped');

        expect(threadRows(cancelled).map(project)).toEqual([
            {
                id: 't1',
                depth: '1',
                agent: 'helper',
                state: 'cancelled',
                name: 'HR1',
                status: 'cancelled',
                preview: 'child task',
                text: undefined,
                outcome: 'outcome · cancelled before the child returned.'
            }
        ]);
        expect(cancelled.element.dataset.state).toBe('cancelled');
        expect(cancelled.element.querySelector('.tile-meta')?.textContent).toBe('2 agents · 1 tool call · stopped');
        expect(cancelled.element.querySelector<HTMLElement>('details.tool')?.dataset.state).toBe('cancelled');

        const failed = board.begin('fail');
        failed.apply({ type: 'start', agent: 'writer', model: 'm1' });
        failed.apply(delegateCall('helper', 'queued task', 'd2'));
        failed.setState('error', 'boom');

        // A delegation cancelled before its child ever started is resolved by the
        // root's terminal status, not left as a forever-queued row. Labels are
        // conversation-scoped, so this second helper thread is HR2 — the first tile's
        // helper keeps HR1 (no duplicate thread labels, R5/R6).
        expect(threadRows(failed).map(project)).toEqual([
            {
                id: 'call:d2',
                depth: '1',
                agent: 'helper',
                state: 'error',
                name: 'HR2',
                status: 'error',
                preview: 'queued task',
                text: undefined,
                outcome: 'outcome · interrupted when the turn failed.'
            }
        ]);
    });

    it('continues one agent code across turns so threads are RR1 then RR2 (R5/R6)', () => {
        const board = mount();

        const firstRecord = serverTurn({
            id: 'turn-a',
            index: 0,
            prompt: 'first',
            status: 'running',
            events: [
                { type: 'start', agent: 'writer', model: 'm1' },
                delegateCall('researcher', 'first question', 'd1'),
                withThread(
                    { type: 'start', agent: 'researcher', model: 'r1' },
                    { id: 't1', callId: 'd1', input: 'first question' }
                )
            ]
        });
        const secondRecord = serverTurn({
            id: 'turn-b',
            index: 1,
            prompt: 'second',
            status: 'running',
            events: [
                { type: 'start', agent: 'writer', model: 'm1' },
                delegateCall('researcher', 'second question', 'd2'),
                withThread(
                    { type: 'start', agent: 'researcher', model: 'r1' },
                    { id: 't2', callId: 'd2', input: 'second question' }
                )
            ]
        });

        const first = board.adopt(firstRecord);
        const second = board.adopt(secondRecord);

        // The defect: two Researcher threads both reading RR1. Numbering continues
        // across turns, so the second thread is RR2 and the prompts stay distinct.
        expect(threadRows(first).map((row) => row.querySelector('.thread-name')?.textContent)).toEqual([
            'RR1'
        ]);
        expect(threadRows(second).map((row) => row.querySelector('.thread-name')?.textContent)).toEqual([
            'RR2'
        ]);
        expect(threadRows(second)[0].querySelector('.thread-preview')?.textContent).toBe('second question');

        // The # descriptors agree with the displayed labels (R6).
        expect(board.blocks().map((block) => `${block.label}:${block.threadId ?? 'root'}`)).toEqual([
            'WR1:root',
            'RR1:t1',
            'WR2:root',
            'RR2:t2'
        ]);

        // A reload re-derives the SAME numbering from the recorded turn order (R5).
        const reloaded = mount();
        const handles = reloaded.hydrate([firstRecord, secondRecord]);
        expect(threadRows(handles[1]).map((row) => row.querySelector('.thread-name')?.textContent)).toEqual([
            'RR2'
        ]);
        expect(reloaded.blocks().map((block) => block.label)).toEqual(['WR1', 'RR1', 'WR2', 'RR2']);
    });

    it('seeds a queued tile on its first allocation, not at creation (R5/R6)', () => {
        // The interleaving T4 found: turn 1 is still running when turn 2 is
        // created optimistically, and turn 1 allocates a LATER label afterwards. A
        // seed frozen at turn-2 creation would miss it and mint a duplicate.
        const board = mount();

        const firstEvents: HarnessEvent[] = [
            { type: 'start', agent: 'writer', model: 'm1' },
            delegateCall('researcher', 'first question', 'd1'),
            withThread(
                { type: 'start', agent: 'researcher', model: 'r1' },
                { id: 't1', callId: 'd1', input: 'first question' }
            )
        ];
        const first = board.begin('first');
        for (const event of firstEvents) first.apply(event);

        // Turn 2 exists (queued, nothing allocated) while turn 1 is still running.
        const second = board.begin('second');

        // Turn 1 continues and allocates RR2 AFTER turn 2 was created.
        const lateEvents: HarnessEvent[] = [
            delegateCall('researcher', 'second question', 'd2'),
            withThread(
                { type: 'start', agent: 'researcher', model: 'r1' },
                { id: 't2', callId: 'd2', input: 'second question' }
            )
        ];
        for (const event of lateEvents) first.apply(event);

        // Turn 2's FIRST allocation must continue after RR2 (WR2, then RR3).
        const secondEvents: HarnessEvent[] = [
            { type: 'start', agent: 'writer', model: 'm1' },
            delegateCall('researcher', 'third question', 'd3'),
            withThread(
                { type: 'start', agent: 'researcher', model: 'r1' },
                { id: 't3', callId: 'd3', input: 'third question' }
            )
        ];
        for (const event of secondEvents) second.apply(event);

        // Bind both tiles to their server records so `blocks()` can describe them.
        const records = [
            serverTurn({
                id: 'turn-a',
                index: 0,
                prompt: 'first',
                status: 'running',
                events: [...firstEvents, ...lateEvents]
            }),
            serverTurn({ id: 'turn-b', index: 1, prompt: 'second', status: 'running', events: secondEvents })
        ];
        first.merge(records[0]);
        second.merge(records[1]);

        // Displayed labels: RR1/RR2 in turn 1, and RR3 (never a duplicate RR2) in 2.
        expect(threadRows(first).map((row) => row.querySelector('.thread-name')?.textContent)).toEqual([
            'RR1',
            'RR2'
        ]);
        expect(threadRows(second).map((row) => row.querySelector('.thread-name')?.textContent)).toEqual([
            'RR3'
        ]);

        // Exact parity with the shared/server projection, and the typed # law
        // resolves the same block the transcript shows.
        const shared = listAgentResultBlocks(records);
        expect(board.blocks()).toEqual(shared);
        expect(findLatestAgentResultBlock(records, '#RR3')).toEqual(
            expect.objectContaining({
                turnId: 'turn-b',
                threadId: 't3',
                label: 'RR3',
                agent: 'researcher'
            })
        );
    });

    it('numbers a fork branch row exactly like the shared projection', () => {
        const board = mount();
        // The runtime forks the REQUESTING agent (`threadFork`), so the frame's agent
        // and the branch summary's agent are the same id. The branch row must still
        // agree with the shared projection on label, thread id, and order.
        const record = serverTurn({
            id: 'turn-branch',
            index: 0,
            status: 'running',
            events: [
                { type: 'start', agent: 'writer', model: 'm1' },
                // A branch frame carries the BRANCH's own thread id, so UI and the
                // shared projection both allocate one block for it.
                {
                    type: 'branch_start',
                    agent: 'writer',
                    branch: {
                        branchId: 'b1',
                        agent: 'writer',
                        kind: 'fork',
                        role: 'subagent',
                        forkDepth: 1,
                        model: 'm1',
                        tools: [],
                        label: 'audit'
                    },
                    thread: { id: 'b1', kind: 'fork', branchId: 'b1', parentId: 'root' }
                }
            ] as unknown as HarnessEvent[]
        });

        board.adopt(record);

        expect(board.blocks()).toEqual(listAgentResultBlocks([record]));
        expect(board.blocks().map((block) => block.label)).toEqual(['WR1', 'WR2']);
    });

    it('attaches an unknown or self parent at depth 1 instead of throwing', () => {
        const board = mount();
        const turn = board.begin('corrupt metadata');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply(
            withThread(
                { type: 'start', agent: 'helper', model: 'h1' },
                { id: 't9', parentId: 'ghost', callId: 'd9', input: 'orphan' }
            )
        );
        turn.apply(withThread({ type: 'text', agent: 'helper', delta: 'still rendered' }, { id: 't9' }));
        // A self parent is dropped by contract.threadOf; the entry still renders.
        turn.apply(
            withThread(
                { type: 'start', agent: 'helper', model: 'h1' },
                { id: 't8', parentId: 't8', input: 'self parent' }
            )
        );
        turn.flush();

        expect(threadRows(turn).map((row) => [row.dataset.threadId, row.dataset.depth])).toEqual([
            ['t9', '1'],
            ['t8', '1']
        ]);
        expect(threadRows(turn)[0].querySelector('.agent-text')?.textContent).toBe('still rendered\n');
    });

    it('keeps the flat legacy section for a stream it cannot attribute', () => {
        const board = mount();
        const turn = board.begin('legacy ctx.run');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        // No agentDelegate call and no thread metadata: inventing a child entry
        // would be a lie, so the old flat subagent section stays.
        turn.apply({ type: 'start', agent: 'helper', model: 'h2' });
        turn.apply({ type: 'text', agent: 'helper', delta: 'legacy answer' });
        turn.flush();

        expect(threadRows(turn)).toHaveLength(0);
        const agents = [...turn.element.querySelectorAll<HTMLElement>('.agent')];
        expect(agents.map((agent) => agent.dataset.agent)).toEqual(['writer', 'helper']);
        expect(agents.map((agent) => agent.dataset.role)).toEqual(['primary', 'subagent']);
        // R3: no visible role badge on a flat section either.
        expect(turn.element.querySelectorAll('.agent-role, .thread-role')).toHaveLength(0);
        expect(agents[1].querySelector('.agent-text')?.textContent).toBe('legacy answer\n');
    });

    // R3: identity is colour, and the colour is the SAME on the main block and on
    // every nested block of that agent — including two invocations of one agent,
    // and the neutral fallback for an agent the stream cannot name. The name/section
    // spells out WHO, the nesting WHERE, and nothing is labelled "subagent".
    it('paints one stable agent colour on main and nested blocks, with an unknown fallback', () => {
        const board = mount();
        const turn = board.begin('colour identity');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply(delegateCall('helper', 'first task', 'd1'));
        turn.apply(
            withThread({ type: 'start', agent: 'helper', model: 'h1' }, { id: 't1', callId: 'd1', input: 'first task' })
        );
        turn.apply(delegateCall('helper', 'second task', 'd2'));
        turn.apply(
            withThread({ type: 'start', agent: 'helper', model: 'h1' }, { id: 't2', callId: 'd2', input: 'second task' })
        );
        // An empty agent id: the server never named this invocation.
        turn.apply(withThread({ type: 'start', agent: '', model: 'u1' }, { id: 't3', input: 'anon' }));
        turn.flush();

        // Main block: the primary agent's tone (`writer` is a hashed, non-profile id
        // → violet, slot 2).
        expect(turn.element.dataset.agent).toBe('writer');
        expect(turn.element.style.getPropertyValue('--agent-color')).toBe('#a78bfa');
        expect(turn.element.style.getPropertyValue('--agent-line')).toBe('rgba(167, 139, 250, 0.6)');

        // Nested blocks: each tile is painted; the same agent is the same tone, twice.
        // `helper` hashes to teal (slot 5).
        const tiles = [...turn.element.nextElementSibling!.querySelectorAll<HTMLElement>('.thread-tile')];
        expect(tiles.map((tile) => tile.dataset.agent)).toEqual(['helper', 'helper', undefined]);
        expect(tiles.map((tile) => tile.style.getPropertyValue('--agent-line'))).toEqual([
            'rgba(45, 212, 191, 0.6)',
            'rgba(45, 212, 191, 0.6)',
            // Unknown/unnamed agent keeps the neutral fallback, and `data-agent` is
            // absent (cleared) rather than an empty identity.
            'rgba(139, 148, 167, 0.55)'
        ]);
        expect(tiles.map((tile) => tile.style.getPropertyValue('--agent-color'))).toEqual([
            '#2dd4bf',
            '#2dd4bf',
            '#8b94a7'
        ]);
        expect(tiles[2].hasAttribute('data-agent')).toBe(false);
        // The ROW uses the same neutral semantics (no `data-agent=""` raw value).
        expect(tiles[2].parentElement?.hasAttribute('data-agent')).toBe(false);

        // No role label anywhere in the transcript, and hierarchy is only indentation
        // (the host nests, nothing else changes the block).
        expect(turn.element.querySelectorAll('.thread-role, .agent-role')).toHaveLength(0);
        expect(turn.element.nextElementSibling!.querySelectorAll('.thread-role')).toHaveLength(0);
    });

    // R3 parity: the nested tile MIRRORS its row's state and expansion, which is what
    // lets styles.css style main and nested blocks with one grouped selector
    // (`:is(.tile, .thread-tile)`). The CSS itself is pinned in thread-style.test.ts;
    // this pins the DOM half so a mirrored property cannot silently stop updating.
    it('mirrors the nested row state and expansion onto the block surface', () => {
        const board = mount();
        const turn = board.begin('mirror');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply(delegateCall('helper', 'task', 'd1'));
        turn.apply(
            withThread({ type: 'start', agent: 'helper', model: 'h1' }, { id: 't1', callId: 'd1', input: 'task' })
        );

        const row = threadRows(turn)[0];
        const tile = row.querySelector<HTMLElement>('.thread-tile');
        expect(row.dataset.state).toBe('streaming');
        expect(tile?.dataset.state).toBe('streaming');
        expect(tile?.classList.contains('is-expanded')).toBe(false);

        const button = row.querySelector<HTMLButtonElement>('.thread-select');
        button?.click();
        expect(row.classList.contains('is-expanded')).toBe(true);
        // The tile carries the same marker, so `:is(.tile, .thread-tile).is-expanded`
        // paints the nested entry's expanded frame exactly like the main tile's.
        expect(tile?.classList.contains('is-expanded')).toBe(true);

        turn.apply(withThread({ type: 'done', agent: 'helper', message: doneMessage('helper') }, { id: 't1' }));
        expect(row.dataset.state).toBe('done');
        expect(tile?.dataset.state).toBe('done');
    });

    // R3: a FLAT legacy section (a second agent the stream cannot attribute to an
    // invocation) is still an agent-owned block: it must be a direct child of
    // `.tile-flow` with `data-role="subagent"`, the only shape styles.css outlines.
    // The primary section is the tile's own content and is deliberately excluded.
    it('marks a flat legacy subagent section so it can carry its own outline', () => {
        const board = mount();
        const turn = board.begin('legacy ctx.run');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply({ type: 'start', agent: 'helper', model: 'h2' });

        const flow = turn.element.querySelector('.tile-flow');
        const flat = [...(flow?.children ?? [])].filter((child) => child.classList.contains('agent'));

        expect(flat.map((node) => node.getAttribute('data-role'))).toEqual(['primary', 'subagent']);
        expect(flat[0].matches(".tile-flow > .agent[data-role='subagent']")).toBe(false);
        expect(flat[1].matches(".tile-flow > .agent[data-role='subagent']")).toBe(true);
        // It keeps the agent's own colour, which the outline reads.
        expect((flat[1] as HTMLElement).style.getPropertyValue('--agent-line')).toBe(
            'rgba(45, 212, 191, 0.6)'
        );
    });

    // R4/R1: a collapsed entry is ONE row with the same anatomy as a compact turn
    // tile — `code · preview · [elapsed | tokens] status`. The old layout put the
    // preview on a second line and had no header metadata.
    it('renders a collapsed entry as a single header row with the tile metadata cluster', () => {
        const board = mount();
        const turn = board.begin('one line');
        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply(delegateCall('helper', 'a very long delegated task description', 'd1'));

        const row = threadRows(turn)[0];
        const select = row.querySelector<HTMLElement>('.thread-select');
        const top = select?.querySelector<HTMLElement>('.thread-top');

        // The button holds the code, the flexible preview and the metadata cluster —
        // the same three-part row the compact tile uses (prompt + `.tile-top`).
        expect([...(select?.children ?? [])].map((child) => child.className)).toEqual([
            'thread-name',
            'thread-preview',
            'thread-top'
        ]);
        expect([...(top?.children ?? [])].map((child) => child.className)).toEqual([
            'thread-elapsed',
            'thread-tokens',
            'thread-status'
        ]);
        expect(top?.querySelector('.thread-preview')).toBeNull();
        expect(select?.querySelector('.thread-preview')?.textContent).toBe(
            'a very long delegated task description'
        );
        expect(top?.querySelector('.thread-status')?.textContent).toBe('queued');
        // R3/R2: the visible agent identity is the compact code, never the raw id.
        expect(select?.querySelector('.thread-name')?.textContent).toBe('HR1');
        expect(row.textContent).not.toContain('helper');

        // Expansion is unchanged: the body opens and the header row stays a row
        // (the preview is replaced by the full Markdown task in the body).
        const button = select as HTMLButtonElement;
        button.click();
        expect(row.classList.contains('is-expanded')).toBe(true);
        expect(button.getAttribute('aria-expanded')).toBe('true');
        expect(row.querySelector('.thread-body')?.contains(row.querySelector('.thread-prompt'))).toBe(true);
    });

    // R1: a nested block carries the SAME metadata as a main block — its own elapsed
    // span and its own token tally, both derived from ITS events. Nothing here is
    // inherited from the parent tile, and nothing is fabricated when the record has
    // no stamps.
    it('shows a nested block its own elapsed span and usage from its events', () => {
        const T = 1_700_000_000_000;
        const board = mount();

        const [turn] = board.hydrate([
            {
                ...serverTurn({
                    events: [
                        { type: 'start', agent: 'writer', model: 'm1' },
                        delegateCall('helper', 'child task', 'd1'),
                        withThread(
                            { type: 'start', agent: 'helper', model: 'h1' },
                            { id: 't1', callId: 'd1', input: 'child task' }
                        ),
                        withThread(
                            {
                                type: 'usage',
                                agent: 'helper',
                                usage: { input: 120, output: 5, total: 125, cached: 40 }
                            },
                            { id: 't1' }
                        ),
                        withThread({ type: 'text', agent: 'helper', delta: 'answer' }, { id: 't1' }),
                        withThread({ type: 'done', agent: 'helper', message: doneMessage('helper') }, { id: 't1' }),
                        {
                            type: 'tool_result',
                            agent: 'writer',
                            name: 'agentDelegate',
                            callId: 'd1',
                            content: 'ok',
                            isError: false
                        }
                    ]
                }),
                startedAt: T,
                updatedAt: T + 9000,
                // Child start T+200, child done T+7000 → exactly 6.8s.
                eventTimes: [T, T + 100, T + 200, T + 300, T + 400, T + 7000, T + 7000]
            }
        ]);

        // Main block: the server span (T → T+9000).
        expect(turn.elapsed()).toBe('9.0s');

        const row = threadRows(turn)[0];
        const elapsed = row.querySelector<HTMLElement>('.thread-elapsed');
        const tokens = row.querySelector<HTMLElement>('.thread-tokens');

        expect(elapsed?.textContent).toBe('6.8s');
        expect(elapsed?.hidden).toBe(false);
        expect(tokens?.textContent).toBe('120 (40)');
        expect(tokens?.hidden).toBe(false);
        // The tally names both scopes exactly like the main block's.
        expect(tokens?.title).toBe(
            'Latest request context: 120 input tokens · Total cached input sent: 40 tokens'
        );
    });

    // R1: the nested clock is honest about unknown data — a record with no event
    // stamps shows no duration rather than 0ms.
    it('leaves a nested duration hidden when its events carry no stamps', () => {
        const board = mount();
        const [turn] = board.hydrate([
            serverTurn({
                events: [
                    { type: 'start', agent: 'writer', model: 'm1' },
                    delegateCall('helper', 'child task', 'd1'),
                    withThread(
                        { type: 'start', agent: 'helper', model: 'h1' },
                        { id: 't1', callId: 'd1', input: 'child task' }
                    ),
                    withThread({ type: 'done', agent: 'helper', message: doneMessage('helper') }, { id: 't1' })
                ]
            })
        ]);

        const row = threadRows(turn)[0];
        const elapsed = row.querySelector<HTMLElement>('.thread-elapsed');
        expect(elapsed?.textContent).toBe('');
        expect(elapsed?.hidden).toBe(true);
        // No usage event either: the tally claims nothing.
        expect(row.querySelector<HTMLElement>('.thread-tokens')?.hidden).toBe(true);
    });

    // F1: a REPLAYED child with no recorded end must never derive a span from the
    // current wall clock. Two runs at very different "now"s must both hide it.
    it('never derives a replayed child duration from the wall clock', () => {
        const T = 1_700_000_000_000;
        const source = (): SessionTurn => ({
            ...serverTurn({
                status: 'cancelled',
                events: [
                    { type: 'start', agent: 'writer', model: 'm1' },
                    delegateCall('helper', 'never finished', 'd1'),
                    withThread(
                        { type: 'start', agent: 'helper', model: 'h1' },
                        { id: 't1', callId: 'd1', input: 'never finished' }
                    )
                ]
            }),
            startedAt: T,
            updatedAt: T + 20_000,
            eventTimes: [T, T + 100, T + 1_000]
        });

        const read = (now: number): [string, boolean] => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date(now));
            try {
                const board = mount();
                const [turn] = board.hydrate([source()]);

                // Sanity: the root keeps the record's own span (T → T+20s).
                expect(turn.elapsed()).toBe('20.0s');

                const elapsed = threadRows(turn)[0].querySelector<HTMLElement>('.thread-elapsed');
                return [elapsed?.textContent ?? '', elapsed?.hidden ?? false];
            } finally {
                vi.useRealTimers();
            }
        };

        // One day later and two years later: the replayed child has NO end stamp, so
        // the answer is "unavailable" in both — never the replay's age.
        expect(read(T + 86_400_000)).toEqual(['', true]);
        expect(read(T + 2 * 365 * 86_400_000)).toEqual(['', true]);
    });

    // F2 (live): the child's OWN `done` fixes its end; a later parent `tool_result`
    // may not stretch it.
    it('keeps a live child end when the parent result lands later', () => {
        const T = 1_700_000_000_000;
        vi.useFakeTimers();
        vi.setSystemTime(new Date(T + 2_000));

        try {
            const board = mount();
            const turn = board.begin('live endpoints');
            turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
            turn.apply(delegateCall('helper', 'child task', 'd1'));
            turn.apply(
                withThread(
                    { type: 'start', agent: 'helper', model: 'h1' },
                    { id: 't1', callId: 'd1', input: 'child task' }
                )
            );

            // The child answers at +4s (2s after its start).
            vi.setSystemTime(new Date(T + 4_000));
            turn.apply(withThread({ type: 'done', agent: 'helper', message: doneMessage('helper') }, { id: 't1' }));

            const elapsed = threadRows(turn)[0].querySelector<HTMLElement>('.thread-elapsed');
            expect(elapsed?.textContent).toBe('2.0s');

            // The parent observes the result at +9s: the span must NOT become 7s.
            vi.setSystemTime(new Date(T + 9_000));
            turn.apply({
                type: 'tool_result',
                agent: 'writer',
                name: 'agentDelegate',
                callId: 'd1',
                content: 'ok',
                isError: false,
                durationMs: 2_000
            });
            expect(elapsed?.textContent).toBe('2.0s');
        } finally {
            vi.useRealTimers();
        }
    });

    // F2 (replay): identical rule with recorded stamps — the child's `done` at +4s
    // wins over the parent's result at +19s.
    it('keeps a recorded child end when the parent result is stamped later', () => {
        const T = 1_700_000_000_000;
        const board = mount();

        const [turn] = board.hydrate([
            {
                ...serverTurn({
                    status: 'done',
                    events: [
                        { type: 'start', agent: 'writer', model: 'm1' },
                        delegateCall('helper', 'child task', 'd1'),
                        withThread(
                            { type: 'start', agent: 'helper', model: 'h1' },
                            { id: 't1', callId: 'd1', input: 'child task' }
                        ),
                        withThread(
                            { type: 'done', agent: 'helper', message: doneMessage('helper') },
                            { id: 't1' }
                        ),
                        {
                            type: 'tool_result',
                            agent: 'writer',
                            name: 'agentDelegate',
                            callId: 'd1',
                            content: 'ok',
                            isError: false,
                            durationMs: 3_000
                        }
                    ]
                }),
                startedAt: T,
                updatedAt: T + 20_000,
                // child start +1s, child done +4s (3s), parent result +19s
                eventTimes: [T, T + 100, T + 1_000, T + 4_000, T + 19_000]
            }
        ]);

        const elapsed = threadRows(turn)[0].querySelector<HTMLElement>('.thread-elapsed');
        expect(elapsed?.textContent).toBe('3.0s');
    });

    // F2: the parent result is still allowed to supply an endpoint the child never
    // reported — that is a KNOWN recorded time, not a wall-clock guess.
    it('lets a recorded parent result supply the missing child endpoint', () => {
        const T = 1_700_000_000_000;
        const board = mount();

        const [turn] = board.hydrate([
            {
                ...serverTurn({
                    status: 'done',
                    events: [
                        { type: 'start', agent: 'writer', model: 'm1' },
                        delegateCall('helper', 'child task', 'd1'),
                        withThread(
                            { type: 'start', agent: 'helper', model: 'h1' },
                            { id: 't1', callId: 'd1', input: 'child task' }
                        ),
                        {
                            type: 'tool_result',
                            agent: 'writer',
                            name: 'agentDelegate',
                            callId: 'd1',
                            content: 'ok',
                            isError: false,
                            durationMs: 8_000
                        }
                    ]
                }),
                startedAt: T,
                updatedAt: T + 20_000,
                // child start +1s, no child `done`, parent result +9s → 8s span.
                eventTimes: [T, T + 100, T + 1_000, T + 9_000]
            }
        ]);

        const elapsed = threadRows(turn)[0].querySelector<HTMLElement>('.thread-elapsed');
        expect(elapsed?.textContent).toBe('8.0s');
    });

    // F3/R1: the collapsed ROOT block is the same anatomy as a collapsed CHILD —
    // agent code first, then the flexible preview, then the metadata cluster.
    it('gives the collapsed root the same code-preview-metadata anatomy as a child', () => {
        const board = mount();
        const turn = board.begin('shapes');
        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply(delegateCall('helper', 'child task', 'd1'));

        const rootSelect = turn.element.querySelector<HTMLElement>('.tile-select');
        expect([...(rootSelect?.children ?? [])].map((child) => child.className)).toEqual([
            'tile-agent',
            'tile-top',
            'tile-prompt',
            'tile-meta'
        ]);
        expect(rootSelect?.querySelector('.tile-agent')?.textContent).toBe('WR1');
        expect([...(rootSelect?.querySelector('.tile-top')?.children ?? [])].map((child) => child.className)).toEqual(
            // R5/R6: the persistent-thread badge leads the cluster. This turn is
            // built without a runtime thread, so the badge is present but hidden.
            ['tile-thread', 'tile-elapsed', 'tile-tokens', 'tile-status']
        );

        const childSelect = threadRows(turn)[0].querySelector<HTMLElement>('.thread-select');
        expect([...(childSelect?.children ?? [])].map((child) => child.className)).toEqual([
            'thread-name',
            'thread-preview',
            'thread-top'
        ]);
        expect(childSelect?.querySelector('.thread-name')?.textContent).toBe('HR1');
        expect([...(childSelect?.querySelector('.thread-top')?.children ?? [])].map((child) => child.className)).toEqual(
            ['thread-elapsed', 'thread-tokens', 'thread-status']
        );

        // F3: the code stays first and correct after the projection is rebuilt.
        turn.merge({
            ...serverTurn({
                status: 'running',
                events: [
                    // A different model forces a rebuild (prefix disagreement).
                    { type: 'start', agent: 'writer', model: 'm2' },
                    delegateCall('helper', 'child task', 'd1')
                ]
            }),
            updatedAt: 11
        });

        expect(turn.element.querySelector('.tile-select')?.firstElementChild?.className).toBe('tile-agent');
        expect(turn.element.querySelector('.tile-agent')?.textContent).toBe('WR1');
    });

    // R1: a nested block ticks like the main block while it runs, and the tick stops
    // when the board is destroyed (a detached interval would keep painting).
    it('ticks a nested block clock while it streams and stops it with the board', () => {
        const T = 1_700_000_000_000;
        vi.useFakeTimers();
        vi.setSystemTime(new Date(T));

        try {
            const board = mount();
            const turn = board.begin('live child');
            turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
            turn.apply(delegateCall('helper', 'child task', 'd1'));
            turn.apply(
                withThread(
                    { type: 'start', agent: 'helper', model: 'h1' },
                    { id: 't1', callId: 'd1', input: 'child task' }
                )
            );

            const elapsed = threadRows(turn)[0].querySelector<HTMLElement>('.thread-elapsed');
            expect(elapsed?.textContent).toBe('0ms');
            expect(elapsed?.hidden).toBe(false);

            vi.advanceTimersByTime(2500);
            expect(elapsed?.textContent).toBe('2.5s');

            const settled = elapsed?.textContent;

            board.clear();
            vi.advanceTimersByTime(10_000);
            expect(elapsed?.textContent).toBe(settled);
        } finally {
            vi.useRealTimers();
        }
    });

    // R2/R5: the code is first+last letter + occurrence, ordered by invocation,
    // root included — and a repeated event does not bump the number. Numbering is
    // conversation-scoped (one tile is the first turn here, so it starts at 1).
    it('labels invocations RH1/RH2 with the root counted, and never per event', () => {
        const board = mount();
        const turn = board.begin('research twice');

        // The root invocation is itself an invocation of `research`.
        turn.apply({ type: 'start', agent: 'research', model: 'r1' });
        expect(turn.element.querySelector('.agent-name')?.textContent).toBe('RH1');

        const spawn = (input: string, id: string): HarnessEvent => ({
            type: 'tool_call',
            agent: 'research',
            call: { id, name: 'agentDelegate', arguments: JSON.stringify({ agent: 'research', input }) }
        });

        turn.apply(spawn('first child', 'd1'));
        turn.apply(spawn('second child', 'd2'));
        turn.apply(
            withThread(
                { type: 'start', agent: 'research', model: 'r1' },
                { id: 't1', callId: 'd1', input: 'first child' }
            )
        );
        turn.apply(
            withThread(
                { type: 'start', agent: 'research', model: 'r1' },
                { id: 't2', callId: 'd2', input: 'second child' }
            )
        );
        // Several more events for the SAME invocations: no new occurrence is taken.
        turn.apply(withThread({ type: 'text', agent: 'research', delta: 'a' }, { id: 't1' }));
        turn.apply(withThread({ type: 'text', agent: 'research', delta: 'b' }, { id: 't1' }));
        turn.apply(withThread({ type: 'text', agent: 'research', delta: 'c' }, { id: 't2' }));

        expect(threadRows(turn).map((row) => row.querySelector('.thread-name')?.textContent)).toEqual([
            'RH2',
            'RH3'
        ]);
        // R3: every VISIBLE agent identity is a code — the root header and both
        // invocation headers. (Tool-card arguments are model data, not labels.)
        expect(turn.element.querySelector('.agent-name')?.textContent).toBe('RH1');
        // The ids remain available internally (colour, routing, tests).
        expect(threadRows(turn).map((row) => row.dataset.agent)).toEqual(['research', 'research']);
    });

    // R2: replay determinism — the same recorded turn yields the same labels on a
    // fresh board, including after a superseding record rebuilds the projection.
    it('replays the same invocation codes after a projection rebuild', () => {
        const events: HarnessEvent[] = [
            { type: 'start', agent: 'research', model: 'r1' },
            delegateCall('research', 'first child', 'd1'),
            delegateCall('workspace', 'second child', 'd2'),
            withThread(
                { type: 'start', agent: 'research', model: 'r1' },
                { id: 't1', callId: 'd1', input: 'first child' }
            ),
            withThread(
                { type: 'start', agent: 'workspace', model: 'w1' },
                { id: 't2', callId: 'd2', input: 'second child' }
            )
        ];

        const board = mount();
        const turn = board.begin('replay');
        for (const event of events) turn.apply(event);
        expect(threadRows(turn).map((row) => row.querySelector('.thread-name')?.textContent)).toEqual([
            'RH2',
            'WE1'
        ]);

        // A record whose prefix DISAGREES forces `resetProjection`, then replays in
        // full: the labels must restart from the record's order, not keep counting.
        const superseding: HarnessEvent[] = [
            events[0],
            events[1],
            events[3],
            withThread({ type: 'text', agent: 'research', delta: 'again' }, { id: 't1' })
        ];
        turn.merge({ ...serverTurn({ status: 'running', events: superseding }), updatedAt: 11 });

        expect(threadRows(turn).map((row) => row.querySelector('.thread-name')?.textContent)).toEqual([
            'RH2'
        ]);
        expect(turn.element.querySelector('.agent-name')?.textContent).toBe('RH1');
    });

    // R1: expanding a child is independent of the parent AND survives a projection
    // rebuild (a superseding record replays the entries; the reader's choice is
    // restored by canonical key).
    it('keeps an expanded child open when a superseding record rebuilds', () => {
        const board = mount();
        const turn = board.begin('rebuild');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply(delegateCall('helper', 'child task', 'd1'));
        turn.apply(
            withThread(
                { type: 'start', agent: 'helper', model: 'h1' },
                { id: 't1', callId: 'd1', input: 'child task' }
            )
        );

        const before = threadRows(turn)[0];
        before.querySelector<HTMLButtonElement>('.thread-select')?.click();
        expect(before.classList.contains('is-expanded')).toBe(true);
        expect(turn.element.classList.contains('is-expanded')).toBe(true);

        // A DISAGREEING prefix forces `resetProjection`, so the row below is a NEW
        // element created by the replay.
        turn.merge({
            ...serverTurn({
                status: 'running',
                events: [
                    { type: 'start', agent: 'writer', model: 'm1' },
                    delegateCall('helper', 'child task', 'd1'),
                    withThread(
                        { type: 'start', agent: 'helper', model: 'h1' },
                        { id: 't1', callId: 'd1', input: 'changed by the record' }
                    )
                ]
            }),
            updatedAt: 11
        });

        const after = threadRows(turn)[0];
        expect(after).not.toBe(before);
        expect(after.dataset.threadId).toBe('t1');
        expect(after.classList.contains('is-expanded')).toBe(true);
        expect(after.querySelector('.thread-select')?.getAttribute('aria-expanded')).toBe('true');
        expect(after.querySelector('.thread-prompt')?.textContent).toBe('changed by the record\n');
        // The rebuilt header still shows the SAME code for that invocation.
        expect(after.querySelector('.thread-name')?.textContent).toBe('HR1');
    });
});

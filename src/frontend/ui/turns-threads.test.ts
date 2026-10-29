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
            name: 'helper',
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
                name: 'helper',
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
                name: 'helper',
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
                name: 'helper',
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
                name: 'helper',
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
                name: 'helper',
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
                name: 'helper',
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
                name: 'helper',
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
        // root's terminal status, not left as a forever-queued row.
        expect(threadRows(failed).map(project)).toEqual([
            {
                id: 'call:d2',
                depth: '1',
                agent: 'helper',
                state: 'error',
                name: 'helper',
                status: 'error',
                preview: 'queued task',
                text: undefined,
                outcome: 'outcome · interrupted when the turn failed.'
            }
        ]);
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
        expect(agents[1].querySelector('.agent-text')?.textContent).toBe('legacy answer\n');
    });
});

// T14 parity — explicit conversation labels RESERVE their ordinal in the UI.
//
// `shared/agent-results.ts` `createBlock` seeds the shared allocator whenever a
// block uses an explicit label (a root `turn.threadLabel` or a child
// `turn.threadLabels[id]`). The turn board must do the same, or a same-code child
// fallback mints the number the root already shows (`RR1` root + `RR1` child)
// while the server projection says `RR2`. These pin exact board labels against
// `listAgentResultBlocks` on the SAME fixture.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/thread-label-reservation.test.ts

import type { HarnessAssistantMessage, HarnessEvent, SessionTurn } from '../../server/protocol';
import { findAgentResultBlock, listAgentResultBlocks } from '../../shared/agent-results';
import type { AgentResultTurn } from '../../shared/agent-results';
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

const delegateCall = (agent: string, id: string): HarnessEvent => ({
    type: 'tool_call',
    agent: 'Researcher',
    call: { id, name: 'agentDelegate', arguments: JSON.stringify({ agent, input: 'child task' }) }
});

const record = (
    options: {
        id: string;
        index: number;
        threadId: string;
        threadLabel: string;
        events: HarnessEvent[];
        status?: 'running' | 'done';
    }
): SessionTurn =>
    ({
        id: options.id,
        index: options.index,
        prompt: 'task',
        status: options.status ?? 'done',
        startedAt: 1,
        updatedAt: 2,
        threadId: options.threadId,
        threadLabel: options.threadLabel,
        events: options.events
    }) as unknown as SessionTurn;

// The shared projection consumes the same recorded fields (including the child
// conversation map, which the browser gets from the roster instead).
const sharedTurn = (turn: SessionTurn, threadLabels?: Record<string, string>): AgentResultTurn => ({
    id: turn.id,
    status: turn.status,
    events: turn.events,
    threadLabel: turn.threadLabel,
    ...(threadLabels === undefined ? {} : { threadLabels })
});

const mount = (roster: SessionThreadEntry[] = []) => {
    const board = createTurnBoard({});
    board.setThreads(roster);
    document.body.replaceChildren(board.element);
    return board;
};

const threadEntry = (overrides: Partial<SessionThreadEntry> & { id: string }): SessionThreadEntry => ({
    agent: 'Researcher',
    origin: 'host',
    status: 'idle',
    sequence: 1,
    ...overrides
});

describe('explicit conversation label reservation (T14 parity)', () => {
    it('reserves root RR1, so a same-code nested fallback is RR2', () => {
        const board = mount();
        const turn = record({
            id: 'turn-1',
            index: 0,
            threadId: 'thread-root',
            threadLabel: 'RR1',
            events: [
                withThread({ type: 'start', agent: 'Researcher', model: 'r1' }, { id: 'inv-root', input: 'task' }),
                delegateCall('Researcher', 'call-1'),
                withThread(
                    { type: 'start', agent: 'Researcher', model: 'r1' },
                    { id: 'inv-child', parentId: 'inv-root', callId: 'call-1', input: 'child task' }
                )
            ]
        });

        const handle = board.adopt(turn);
        const ui = handle.blocks().map((block) => `${block.label}:${block.threadId ?? 'root'}`);
        const shared = listAgentResultBlocks([sharedTurn(turn)]).map(
            (block) => `${block.label}:${block.threadId ?? 'root'}`
        );

        expect(ui).toEqual(['RR1:root', 'RR2:inv-child']);
        expect(ui).toEqual(shared);
        // A chip bound to the UI label resolves the SAME server block.
        expect(
            findAgentResultBlock([sharedTurn(turn)], {
                turnId: 'turn-1',
                threadId: 'inv-child',
                label: 'RR2'
            })?.label
        ).toBe('RR2');
    });

    it('reserves root RR4, so a same-code nested fallback is RR5', () => {
        const board = mount();
        const turn = record({
            id: 'turn-1',
            index: 0,
            threadId: 'thread-root',
            threadLabel: 'RR4',
            events: [
                withThread({ type: 'start', agent: 'Researcher', model: 'r1' }, { id: 'inv-root', input: 'task' }),
                delegateCall('Researcher', 'call-1'),
                withThread(
                    { type: 'start', agent: 'Researcher', model: 'r1' },
                    { id: 'inv-child', parentId: 'inv-root', callId: 'call-1', input: 'child task' }
                )
            ]
        });

        const handle = board.adopt(turn);
        expect(handle.blocks().map((block) => block.label)).toEqual(['RR4', 'RR5']);
        expect(handle.blocks().map((block) => block.label)).toEqual(
            listAgentResultBlocks([sharedTurn(turn)]).map((block) => block.label)
        );
    });

    it('reserves a persisted CHILD label, so a later same-code fallback is not reminted', () => {
        const board = mount([
            threadEntry({ id: 'thread-root', sequence: 1, label: 'RR1', invocationId: 'inv-root' }),
            threadEntry({
                id: 'thread-child',
                sequence: 2,
                label: 'RR2',
                ownerThreadId: 'thread-root',
                invocationId: 'inv-child'
            })
        ]);
        const turn = record({
            id: 'turn-1',
            index: 0,
            threadId: 'thread-root',
            threadLabel: 'RR1',
            events: [
                withThread({ type: 'start', agent: 'Researcher', model: 'r1' }, { id: 'inv-root', input: 'task' }),
                delegateCall('Researcher', 'call-1'),
                withThread(
                    { type: 'start', agent: 'Researcher', model: 'r1' },
                    { id: 'inv-child', parentId: 'inv-root', callId: 'call-1', input: 'child task' }
                ),
                delegateCall('Researcher', 'call-2'),
                withThread(
                    { type: 'start', agent: 'Researcher', model: 'r1' },
                    { id: 'inv-grand', parentId: 'inv-child', callId: 'call-2', input: 'grand task' }
                )
            ]
        });

        const handle = board.adopt(turn);
        const ui = handle.blocks().map((block) => `${block.label}:${block.threadId ?? 'root'}`);
        const shared = listAgentResultBlocks([sharedTurn(turn, { 'inv-child': 'RR2' })]).map(
            (block) => `${block.label}:${block.threadId ?? 'root'}`
        );

        expect(ui).toEqual(['RR1:root', 'RR2:inv-child', 'RR3:inv-grand']);
        expect(ui).toEqual(shared);
    });

    it('reserves an explicit label on top of a restored label seed', () => {
        const board = mount();
        const turn = record({
            id: 'turn-1',
            index: 0,
            threadId: 'thread-root',
            threadLabel: 'RR1',
            events: [
                withThread({ type: 'start', agent: 'Researcher', model: 'r1' }, { id: 'inv-root', input: 'task' }),
                delegateCall('Researcher', 'call-1'),
                withThread(
                    { type: 'start', agent: 'Researcher', model: 'r1' },
                    { id: 'inv-child', parentId: 'inv-root', callId: 'call-1', input: 'child task' }
                )
            ]
        });

        const handles = board.hydrate([turn], { labelSeeds: { 'turn-1': { RR: 3 } } });
        const ui = handles[0].blocks().map((block) => block.label);
        const shared = listAgentResultBlocks([{ ...sharedTurn(turn), labels: { RR: 3 } }]).map(
            (block) => block.label
        );

        // Seed RR3 is the floor; the explicit RR1 raises nothing and the nested
        // same-code fallback continues at RR4 in BOTH projections.
        expect(ui).toEqual(['RR1', 'RR4']);
        expect(ui).toEqual(shared);
    });

    it('does not burn an ordinal when the same conversation continues as RR1', () => {
        const board = mount();
        const first = record({
            id: 'turn-1',
            index: 0,
            threadId: 'thread-root',
            threadLabel: 'RR1',
            events: [
                withThread({ type: 'start', agent: 'Researcher', model: 'r1' }, { id: 'inv-1', input: 'one' }),
                delegateCall('Researcher', 'call-1'),
                withThread(
                    { type: 'start', agent: 'Researcher', model: 'r1' },
                    { id: 'inv-1-child', parentId: 'inv-1', callId: 'call-1', input: 'child one' }
                )
            ]
        });
        const second = record({
            id: 'turn-2',
            index: 1,
            threadId: 'thread-root',
            threadLabel: 'RR1',
            events: [
                withThread({ type: 'start', agent: 'Researcher', model: 'r1' }, { id: 'inv-2', input: 'two' }),
                delegateCall('Researcher', 'call-2'),
                withThread(
                    { type: 'start', agent: 'Researcher', model: 'r1' },
                    { id: 'inv-2-child', parentId: 'inv-2', callId: 'call-2', input: 'child two' }
                )
            ]
        });

        const handles = board.hydrate([first, second]);
        const ui = handles.flatMap((handle) =>
            handle.blocks().map((block) => `${block.turnId}:${block.label}:${block.threadId ?? 'root'}`)
        );
        const shared = listAgentResultBlocks([sharedTurn(first), sharedTurn(second)]).map(
            (block) => `${block.turnId}:${block.label}:${block.threadId ?? 'root'}`
        );

        // The root stays RR1 in BOTH runs. Only the separate nested invocation in the
        // second run continues the same-code sequence (RR3), exactly like the server.
        expect(ui).toEqual([
            'turn-1:RR1:root',
            'turn-1:RR2:inv-1-child',
            'turn-2:RR1:root',
            'turn-2:RR3:inv-2-child'
        ]);
        expect(ui).toEqual(shared);
        expect(handles.map((handle) => handle.element.querySelector('.tile-agent')?.textContent)).toEqual([
            'RR1',
            'RR1'
        ]);
    });
});

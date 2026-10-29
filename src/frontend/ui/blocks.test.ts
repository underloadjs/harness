// Block descriptors shared by the composer # popup and the server (T8).
//
// The UI's `blocks()` output must be byte-compatible with shared/projected blocks,
// including stable synthetic identities before a delegation adopts its runtime
// thread id. These tests use the REAL shared helpers over one event fixture, so a
// drift between ui/turns.ts and shared/agent-results.ts fails here.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/blocks.test.ts

import type { HarnessAssistantMessage, HarnessEvent } from '../../server/protocol';
import { findAgentResultBlock, listAgentResultBlocks } from '../../shared/agent-results';
import { createTurnBoard } from './turns';

const doneMessage = (content: string): HarnessAssistantMessage => ({
    role: 'assistant',
    content,
    reasoning: '',
    toolCalls: [],
    model: 'm1',
    stopReason: 'stop'
});

const identityOf = (block: {
    turnId: string;
    threadId?: string;
    label: string;
    agent: string;
}): { turnId: string; threadId?: string; label: string; agent: string } => ({
    turnId: block.turnId,
    ...(block.threadId === undefined ? {} : { threadId: block.threadId }),
    label: block.label,
    agent: block.agent
});

const mount = (id = 't1') => {
    const board = createTurnBoard();
    const turn = board.begin('task');
    turn.bind({ id, index: 0 });
    return { board, turn, id };
};

it('keeps the call alias before adoption and the runtime id after adoption', () => {
    const { turn, id } = mount();
    const delegate = {
        type: 'tool_call' as const,
        agent: 'instruct',
        call: {
            id: 'd1',
            name: 'agentDelegate',
            arguments: '{"agent":"research","input":"go"}'
        }
    };

    turn.apply({ type: 'start', agent: 'instruct', model: 'm1' });
    turn.apply(delegate);

    const before = turn.blocks();
    expect(before.map((block) => identityOf(block))).toEqual([
        { turnId: id, label: 'IT1', agent: 'instruct' },
        { turnId: id, threadId: 'call:d1', label: 'RH1', agent: 'research' }
    ]);

    // The shared projection of the SAME prefix uses the same synthetic alias.
    const sharedTurns = [
        {
            id,
            status: 'running' as const,
            events: [
                { type: 'start' as const, agent: 'instruct', model: 'm1' },
                delegate
            ]
        }
    ];
    const sharedBefore = listAgentResultBlocks(sharedTurns);
    expect(sharedBefore.map((block) => identityOf(block))).toEqual(before.map((block) => identityOf(block)));

    // The runtime start adopts the placeholder and rekeys the UI entry.
    const started: HarnessEvent = {
        type: 'start',
        agent: 'research',
        model: 'm1',
        thread: { id: '2', callId: 'd1', input: 'go' }
    };
    turn.apply(started);

    const after = turn.blocks();
    expect(after.map((block) => identityOf(block))).toEqual([
        { turnId: id, label: 'IT1', agent: 'instruct' },
        { turnId: id, threadId: '2', label: 'RH1', agent: 'research' }
    ]);

    const sharedAfterTurns = [
        {
            id,
            status: 'running' as const,
            events: [
                { type: 'start' as const, agent: 'instruct', model: 'm1' },
                delegate,
                started
            ]
        }
    ];
    const sharedAfter = listAgentResultBlocks(sharedAfterTurns);
    expect(sharedAfter.map((block) => identityOf(block))).toEqual(after.map((block) => identityOf(block)));

    // A reference bound BEFORE adoption still resolves after adoption, so a queued
    // submit keeps working while the child starts.
    expect(
        identityOf(
            findAgentResultBlock(sharedAfterTurns, {
                turnId: id,
                threadId: 'call:d1',
                label: 'RH1'
            })!
        )
    ).toEqual({ turnId: id, threadId: '2', label: 'RH1', agent: 'research' });

    expect(
        identityOf(findAgentResultBlock(sharedAfterTurns, { turnId: id, label: 'IT1' })!)
    ).toEqual({ turnId: id, label: 'IT1', agent: 'instruct' });
});

it('keeps the inline alias for a threadless legacy child', () => {
    const { turn, id } = mount();

    turn.apply({ type: 'start', agent: 'instruct', model: 'm1' });
    turn.apply({ type: 'start', agent: 'research', model: 'm1' });
    turn.apply({ type: 'text', agent: 'research', delta: 'legacy child' });

    const blocks = turn.blocks();
    expect(blocks.map((block) => identityOf(block))).toEqual([
        { turnId: id, label: 'IT1', agent: 'instruct' },
        { turnId: id, threadId: 'inline:research', label: 'RH1', agent: 'research' }
    ]);

    const sharedTurns = [
        {
            id,
            status: 'running' as const,
            events: [
                { type: 'start' as const, agent: 'instruct', model: 'm1' },
                { type: 'start' as const, agent: 'research', model: 'm1' },
                { type: 'text' as const, agent: 'research', delta: 'legacy child' }
            ]
        }
    ];

    expect(
        identityOf(
            findAgentResultBlock(sharedTurns, {
                turnId: id,
                threadId: 'inline:research',
                label: 'RH1'
            })!
        )
    ).toEqual({ turnId: id, threadId: 'inline:research', label: 'RH1', agent: 'research' });
});

it('settles row-less legacy entries and keeps their completed content and alias', () => {
    const { turn, id } = mount();

    turn.apply({ type: 'start', agent: 'instruct', model: 'm1' });
    turn.apply({ type: 'start', agent: 'research', model: 'm1' });
    turn.apply({ type: 'text', agent: 'research', delta: 'legacy answer' });
    turn.apply({ type: 'done', agent: 'research', message: doneMessage('legacy answer') });

    expect(turn.blocks().map((block) => identityOf(block))).toEqual([
        { turnId: id, label: 'IT1', agent: 'instruct' },
        { turnId: id, threadId: 'inline:research', label: 'RH1', agent: 'research' }
    ]);
    const legacy = turn.blocks()[1];
    expect(legacy?.status).toBe('done');
    expect(legacy?.content).toBe('legacy answer');
});

it('settles row-less legacy entries on root error/cancelled transitions', () => {
    const errored = mount();
    errored.turn.apply({ type: 'start', agent: 'instruct', model: 'm1' });
    errored.turn.apply({ type: 'start', agent: 'research', model: 'm1' });
    errored.turn.setState('error');
    expect(errored.turn.blocks()[1]).toMatchObject({
        threadId: 'inline:research',
        label: 'RH1',
        status: 'error'
    });

    const cancelled = mount();
    cancelled.turn.apply({ type: 'start', agent: 'instruct', model: 'm1' });
    cancelled.turn.apply({ type: 'start', agent: 'research', model: 'm1' });
    cancelled.turn.setState('cancelled');
    expect(cancelled.turn.blocks()[1]).toMatchObject({
        threadId: 'inline:research',
        label: 'RH1',
        status: 'cancelled'
    });
});

it('retains the final answer after done closes the streaming text block', () => {
    const { turn } = mount();

    turn.apply({ type: 'start', agent: 'instruct', model: 'm1' });
    turn.apply({ type: 'text', agent: 'instruct', delta: 'final ' });
    turn.apply({ type: 'text', agent: 'instruct', delta: 'answer' });
    turn.apply({ type: 'done', agent: 'instruct', message: doneMessage('final answer') });

    // `done` clears section.text (the incremental writer); the descriptor must still
    // carry the completed answer from `lastText`.
    expect(turn.blocks()[0]?.content).toBe('final answer');

    turn.flush();
    expect(turn.blocks()[0]?.content).toBe('final answer');
});

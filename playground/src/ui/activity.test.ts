// Per-agent activity reduction for the tile ring.
//
// The ring must mean "this agent is working in the turn on screen". These tests
// pin the accept/reject rules as exact sets:
//   - start activates; text/reasoning/tool events reactivate;
//   - done/error remove ONLY that agent (delegated siblings keep spinning);
//   - only a RUNNING recorded turn contributes activity, so replaying history can
//     never light an old tile;
//   - renderAgents rebuilds read the live set, and painting sets/removes both
//     data-activity and aria-busy.

import type { HarnessEvent, SessionTurn } from '../../../server/protocol';
import { applyActivity, activityOfTurn, activityOfTurns, paintActivity } from './activity';
import { createAgentRow } from './agents';

const start = (agent: string): HarnessEvent => ({ type: 'start', agent, model: 'm1' });
const text = (agent: string): HarnessEvent => ({ type: 'text', agent, delta: 'x' });
const reasoning = (agent: string): HarnessEvent => ({ type: 'reasoning', agent, delta: 'think' });
const toolCall = (agent: string): HarnessEvent => ({
    type: 'tool_call',
    agent,
    call: { id: 'c1', name: 'fileRead', arguments: '{}' }
});
const toolResult = (agent: string): HarnessEvent => ({
    type: 'tool_result',
    agent,
    name: 'fileRead',
    content: 'ok',
    isError: false
});
const done = (agent: string): HarnessEvent => ({
    type: 'done',
    agent,
    message: {
        role: 'assistant',
        content: '',
        reasoning: '',
        toolCalls: [],
        model: 'm1',
        stopReason: 'stop'
    }
});
const failed = (agent: string): HarnessEvent => ({ type: 'error', agent, error: { message: 'boom' } });

const turn = (overrides: Partial<SessionTurn> = {}): SessionTurn => ({
    id: 't1',
    index: 0,
    prompt: 'go',
    status: 'running',
    startedAt: 1000,
    updatedAt: 2000,
    events: [],
    ...overrides
});

const reduce = (events: readonly HarnessEvent[]): string[] => {
    const active = new Set<string>();
    for (const event of events) applyActivity(active, event);
    return [...active];
};

describe('applyActivity', () => {
    it('activates on start and every content event', () => {
        expect(reduce([start('instruct')])).toEqual(['instruct']);
        expect(reduce([start('instruct'), text('instruct')])).toEqual(['instruct']);
        expect(reduce([text('instruct')])).toEqual(['instruct']);
        expect(reduce([reasoning('instruct')])).toEqual(['instruct']);
        expect(reduce([toolCall('instruct')])).toEqual(['instruct']);
        expect(reduce([toolResult('instruct')])).toEqual(['instruct']);
    });

    it('removes only the agent that finished, not a delegated sibling', () => {
        expect(reduce([start('instruct'), toolCall('instruct'), start('helper'), text('helper')])).toEqual([
            'instruct',
            'helper'
        ]);
        expect(reduce([start('instruct'), start('helper'), done('helper')])).toEqual(['instruct']);
        expect(reduce([start('instruct'), start('helper'), failed('instruct')])).toEqual(['helper']);
    });

    it('reactivates an agent after an intermediate done (a second agent run)', () => {
        expect(reduce([start('instruct'), done('instruct'), text('instruct')])).toEqual(['instruct']);
    });
});

describe('activityOfTurn / activityOfTurns', () => {
    it('derives activity from a still-running turn only', () => {
        const running = turn({ events: [start('instruct'), text('instruct')] });
        expect([...activityOfTurn(running)]).toEqual(['instruct']);
    });

    it('never lights a settled turn when replaying history', () => {
        for (const status of ['done', 'error', 'cancelled'] as const) {
            expect([...activityOfTurn(turn({ status, events: [start('instruct'), text('instruct')] }))]).toEqual(
                []
            );
        }

        // A finished turn with an active-looking final event is still history:
        // only the status decides.
        const finished = turn({ status: 'done', events: [start('instruct')] });
        expect([...activityOfTurn(finished)]).toEqual([]);
    });

    it('unions only the running turns of a snapshot', () => {
        const older = turn({ id: 't1', status: 'done', events: [start('instruct'), text('instruct')] });
        const current = turn({ id: 't2', index: 1, events: [start('helper')] });

        expect([...activityOfTurns([older, current])]).toEqual(['helper']);
        expect([...activityOfTurns([older])]).toEqual([]);
    });

    it('leaves an empty set for a finished turn whose last event is a done', () => {
        const running = turn({ events: [start('instruct'), done('instruct')] });
        expect([...activityOfTurn(running)]).toEqual([]);
    });
});

describe('paintActivity', () => {
    const row = (activity: readonly string[]): HTMLElement =>
        createAgentRow({
            members: ['instruct', 'helper'],
            primary: 'instruct',
            agents: [],
            editable: true,
            activity,
            onSelectPrimary: () => undefined,
            onAdd: () => undefined,
            onRemove: () => undefined
        });

    it('marks only the active tiles and clears the rest on a repaint', () => {
        const element = row(['instruct']);
        document.body.replaceChildren(element);

        const tiles = [...element.querySelectorAll<HTMLElement>('.agent-tile')];
        expect(tiles.map((tile) => tile.dataset.activity)).toEqual(['active', undefined]);
        expect(tiles.map((tile) => tile.getAttribute('aria-busy'))).toEqual(['true', null]);

        // A `done` for instruct removes exactly its ring.
        paintActivity(element, new Set(['helper']));
        expect(tiles.map((tile) => tile.dataset.activity)).toEqual([undefined, 'active']);
        expect(tiles.map((tile) => tile.getAttribute('aria-busy'))).toEqual([null, 'true']);

        paintActivity(element, new Set<string>());
        expect(tiles.map((tile) => tile.dataset.activity)).toEqual([undefined, undefined]);
        expect(tiles.map((tile) => tile.getAttribute('aria-busy'))).toEqual([null, null]);
    });

    it('preserves a live set across a row rebuild', () => {
        // What renderAgents does: the set lives on the instance, the rebuilt row
        // reads it, so a PATCH/snapshot repaint never drops a working agent.
        const active = new Set(['helper']);
        document.body.replaceChildren(row([...active]));

        expect(
            document.querySelector<HTMLElement>('.agent-tile[data-agent="helper"]')?.dataset.activity
        ).toBe('active');
        expect(
            document.querySelector<HTMLElement>('.agent-tile[data-agent="instruct"]')?.dataset.activity
        ).toBeUndefined();
    });
});

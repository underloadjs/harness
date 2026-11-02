// Turn-tile retry rendering (R1/R3/R4).
//
// The agent retries ONE model request after a failed attempt. Its streamed output
// from that attempt was already forwarded, so the tile must DISCARD it when the
// `retry` frame arrives and show a concise retry notice instead; the successful
// attempt's output must then render normally.
//
// Pinned contract:
//   - the failed attempt's prose, reasoning and tool chips are removed;
//   - the notice names the attempt, the budget, the backoff and the failed error;
//   - output from an EARLIER successful turn of the same run is never discarded;
//   - a malformed retry frame renders nothing (no fabricated "retry 0 in 0ms").
//
// Run: npx vitest run --config src/frontend/vitest.config.ts

import type { HarnessEvent } from '../../server/protocol';
import { createTurnBoard } from './turns';

const mount = () => {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const board = createTurnBoard({ empty });
    document.body.replaceChildren(board.element);
    return board;
};

const start = (agent = 'writer'): HarnessEvent => ({ type: 'start', agent, model: 'm1' });

const text = (delta: string, agent = 'writer'): HarnessEvent => ({ type: 'text', agent, delta });

const retry = (fields: Record<string, unknown> = {}): HarnessEvent =>
    ({
        type: 'retry',
        agent: 'writer',
        attempt: 1,
        maxAttempts: 11,
        delayMs: 1_000,
        error: { message: 'HTTP 500: overloaded' },
        ...fields
    }) as unknown as HarnessEvent;

describe('model-request retries (R1)', () => {
    it('discards the failed attempt output and shows a concise retry notice', () => {
        const board = mount();
        const turn = board.begin('ask');

        turn.apply(start());
        turn.apply({ type: 'reasoning', agent: 'writer', delta: 'thinking' });
        turn.apply(text('partial draft'));
        turn.apply({
            type: 'tool_call',
            agent: 'writer',
            call: { id: 'bad', name: 'dangerous', arguments: '{}' }
        });
        turn.flush();

        // The failed attempt is visible until the retry frame arrives.
        expect(turn.element.querySelectorAll('details.tool')).toHaveLength(1);

        turn.apply(retry());
        turn.flush();

        // Everything the abandoned attempt produced is gone.
        expect(turn.element.querySelectorAll('details.tool')).toHaveLength(0);
        expect(turn.element.querySelector('.thinking')).toBeNull();
        expect(turn.element.textContent).not.toContain('partial draft');
        expect(turn.element.textContent).not.toContain('thinking');

        // One concise notice, with the attempt, the budget, the wait and the error.
        const notices = turn.element.querySelectorAll('.agent-retry');
        expect(notices).toHaveLength(1);
        expect(notices[0].querySelector('.agent-retry-label')?.textContent).toBe('retry');
        expect(notices[0].querySelector('.agent-retry-text')?.textContent).toBe(
            'attempt 1 of 11 failed · retrying in 1.0s · HTTP 500: overloaded'
        );
    });

    it('renders the successful attempt normally after a discarded one', () => {
        const board = mount();
        const turn = board.begin('ask');

        turn.apply(start());
        turn.apply(text('failed draft'));
        turn.apply(retry());
        turn.apply(text('clean answer'));
        turn.flush();

        expect(turn.element.textContent).not.toContain('failed draft');
        expect(turn.element.querySelector('.agent-text')?.innerHTML).toBe('<p>clean answer</p>\n');
        expect(turn.element.querySelectorAll('.agent-retry')).toHaveLength(1);
        expect(turn.state()).toBe('streaming');
    });

    it('keeps output from an earlier successful turn of the same run', () => {
        const board = mount();
        const turn = board.begin('ask');

        // Turn 1 (a completed tool round) wrote prose and a tool chip.
        turn.apply(start());
        turn.apply(text('working on it'));
        turn.apply({
            type: 'tool_call',
            agent: 'writer',
            call: { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }
        });
        turn.apply({
            type: 'tool_result',
            agent: 'writer',
            name: 'read',
            callId: 'c1',
            content: 'ok',
            isError: false,
            outcome: 'completed'
        });
        turn.apply({
            type: 'done',
            agent: 'writer',
            message: {
                role: 'assistant',
                content: 'working on it',
                reasoning: '',
                toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }],
                model: 'm1',
                stopReason: 'tool_calls'
            }
        });
        turn.flush();

        // Turn 2 fails its first attempt: only ITS output is discarded.
        turn.apply(text('second draft'));
        turn.apply(retry({ attempt: 1 }));
        turn.apply(text('second answer'));
        turn.flush();

        expect(turn.element.textContent).toContain('working on it');
        expect(turn.element.textContent).not.toContain('second draft');
        expect(turn.element.textContent).toContain('second answer');
        expect(turn.element.querySelectorAll('details.tool')).toHaveLength(1);
    });

    it('ignores a malformed retry frame instead of inventing a notice', () => {
        const board = mount();
        const turn = board.begin('ask');

        turn.apply(start());
        turn.apply(text('kept'));
        // No attempt number: the frame says nothing usable about the sequence.
        turn.apply(retry({ attempt: undefined }));
        turn.flush();

        expect(turn.element.querySelectorAll('.agent-retry')).toHaveLength(0);
        expect(turn.element.textContent).toContain('kept');
    });

    it('removes a delegation placeholder minted by a failed attempt', () => {
        const board = mount();
        const turn = board.begin('ask');

        turn.apply(start());
        turn.apply({
            type: 'tool_call',
            agent: 'writer',
            call: { id: 'd1', name: 'delegate', arguments: '{"agent":"helper","input":"look it up"}' }
        });
        turn.flush();

        // The spawning call queues a child placeholder (thread rows live in the
        // tile ROW, outside the tile body, so the board is the query root).
        expect(board.element.querySelectorAll('.thread-row')).toHaveLength(1);

        turn.apply(retry());
        turn.flush();

        // The failed attempt's placeholder is gone with the rest of its output.
        expect(board.element.querySelectorAll('.thread-row')).toHaveLength(0);
        expect(turn.element.querySelectorAll('details.tool')).toHaveLength(0);
        expect(board.element.textContent).not.toContain('look it up');
    });
});

// ---------------------------------------------------------------------------
// F1/F2/F4/F5 — the attempt window discards by OWNERSHIP, not by position.
//
// The real harness sequence for a completed tool round has NO `done` (the harness
// emits `done` only for a tool-free response), so the UI cannot use `done` as the
// attempt boundary. `attempt_commit` is that boundary; without it the next
// request's `retry` deleted an already committed round.
// ---------------------------------------------------------------------------

const commit = (fields: Record<string, unknown> = {}): HarnessEvent =>
    ({
        type: 'attempt_commit',
        agent: 'writer',
        attempt: 1,
        maxAttempts: 11,
        ...fields
    }) as unknown as HarnessEvent;

const withThread = (event: HarnessEvent, thread: Record<string, unknown>): HarnessEvent =>
    ({ ...event, thread }) as unknown as HarnessEvent;

const call = (id: string, name: string, agent = 'writer'): HarnessEvent =>
    ({ type: 'tool_call', agent, call: { id, name, arguments: '{}' } }) as unknown as HarnessEvent;

const result = (id: string, name: string, agent = 'writer'): HarnessEvent =>
    ({
        type: 'tool_result',
        agent,
        name,
        callId: id,
        content: 'ok',
        isError: false,
        outcome: 'completed'
    }) as unknown as HarnessEvent;

describe('attempt ownership (F1/F2/F4/F5)', () => {
    // F1, LIVE path: the exact done-less tool round followed by a retried request.
    it('keeps a committed tool round that the harness never closed with done', () => {
        const board = mount();
        const turn = board.begin('ask');

        turn.apply(start());
        turn.apply(text('working'));
        turn.apply(call('c1', 'read'));
        turn.apply(result('c1', 'read'));
        // The tool-calling request's success boundary: its only closing frame.
        turn.apply(commit());
        // The NEXT request fails its first attempt.
        turn.apply(text('partial'));
        turn.apply(retry());
        turn.apply(text('final'));
        turn.flush();

        // The committed round survives: prose, card and result.
        expect(turn.element.textContent).toContain('working');
        expect(turn.element.querySelectorAll('details.tool')).toHaveLength(1);
        // Only the failed attempt's own prose is gone.
        expect(turn.element.textContent).not.toContain('partial');
        expect(turn.element.textContent).toContain('final');
        expect(turn.element.querySelectorAll('.agent-retry')).toHaveLength(1);
    });

    // R1: `attempt_commit` no longer closes the chip ROW, so one row can hold calls
    // from several attempts. Ownership is therefore tracked per CHIP: discarding the
    // later attempt removes its calls and keeps the committed ones in the same row.
    it('removes only the discarded attempt chips from a shared tool row', () => {
        const board = mount();
        const turn = board.begin('ask');

        turn.apply(start());
        turn.apply(call('c1', 'first'));
        turn.apply(call('c2', 'second'));
        turn.apply(commit());
        // The next batch joins the SAME row (nothing readable came between them)…
        turn.apply(call('c3', 'third'));
        turn.apply(call('c4', 'fourth'));
        // …and that request then fails.
        turn.apply(retry());
        turn.flush();

        const rows = [...turn.element.querySelectorAll('.agent-flow > .tool-group')];
        expect(rows).toHaveLength(1);
        expect([...rows[0].querySelectorAll('.tool-name')].map((node) => node.textContent)).toEqual([
            'first',
            'second'
        ]);
        expect(turn.element.querySelectorAll('details.tool')).toHaveLength(2);
        // F5: only the discarded calls leave the tally.
        expect(turn.element.querySelector('.tile-meta')?.textContent).toBe('1 agent · 2 tool calls');
    });

    // R1: because the row is no longer itself attempt output, an emptied row has to
    // be pruned explicitly — a failed first attempt must not leave a blank strip.
    it('drops the tool row an emptied discard leaves behind', () => {
        const board = mount();
        const turn = board.begin('ask');

        turn.apply(start());
        turn.apply(call('c1', 'first'));
        turn.apply(call('c2', 'second'));
        turn.flush();

        turn.apply(retry());
        turn.flush();

        expect(turn.element.querySelectorAll('.agent-flow > .tool-group')).toHaveLength(0);
        expect(turn.element.querySelectorAll('details.tool')).toHaveLength(0);
        // Only the retry notice is left in the block.
        expect([...(turn.element.querySelector('.agent-flow')?.children ?? [])].map((child) => child.className)).toEqual(
            ['agent-retry']
        );
    });

    // F1, HYDRATE/REPLAY path: a recorded turn applies with the `replay` origin and
    // must behave identically (the record is the same event list).
    it('keeps the committed round when the same sequence is replayed', () => {
        const board = mount();
        const turn = board.begin('ask');
        let at = 1_000;

        const replay = (event: HarnessEvent): void => {
            turn.apply(event, at, 'replay');
            at += 10;
        };

        replay(start());
        replay(text('working'));
        replay(call('c1', 'read'));
        replay(result('c1', 'read'));
        replay(commit());
        replay(text('partial'));
        replay(retry());
        replay(text('final'));
        turn.flush();

        expect(turn.element.textContent).toContain('working');
        expect(turn.element.querySelectorAll('details.tool')).toHaveLength(1);
        expect(turn.element.textContent).not.toContain('partial');
        expect(turn.element.textContent).toContain('final');
        expect(turn.element.querySelectorAll('.agent-retry')).toHaveLength(1);
    });

    // F2: the tile-wide pending list is shared by every invocation. Discarding one
    // agent's attempt must prune ONLY its own entries, or a concurrently streaming
    // sibling's pending call (and its later result) is corrupted.
    it('leaves a sibling invocation pending call and its result intact', () => {
        const board = mount();
        const turn = board.begin('ask');

        // Two invocations of the same turn, each with its own running call.
        turn.apply(withThread(start('writer'), { id: 't1' }));
        turn.apply(withThread(call('a1', 'slow', 'writer'), { id: 't1' }));
        turn.apply(withThread(start('helper'), { id: 't2' }));
        turn.apply(withThread(call('b1', 'other', 'helper'), { id: 't2' }));
        turn.flush();

        expect(board.element.querySelectorAll('details.tool')).toHaveLength(2);

        // The writer's attempt is abandoned: only ITS card goes.
        turn.apply(withThread(retry(), { id: 't1' }));
        turn.flush();

        // The helper's card is still there and still running. Nested invocation cards
        // live in their `.thread-row` (outside the tile body), so query the board.
        const cards = [...board.element.querySelectorAll<HTMLDetailsElement>('details.tool')];
        expect(cards).toHaveLength(1);
        expect(cards[0].dataset.callId).toBe('b1');
        expect(cards[0].dataset.state).toBe('running');
        // The tile counts one surviving call, not the discarded one (F5).
        expect(turn.element.querySelector('.tile-meta')?.textContent).toContain('1 tool call');

        // The helper's own result still settles that single card, exactly once.
        turn.apply(withThread(result('b1', 'other', 'helper'), { id: 't2' }));
        turn.flush();

        const settled = [...board.element.querySelectorAll<HTMLDetailsElement>('details.tool')];
        expect(settled).toHaveLength(1);
        expect(settled[0].dataset.callId).toBe('b1');
        expect(settled[0].dataset.state).toBe('ok');
    });

    // F4: a flow child that ANOTHER source owns (a wakeup marker) is not attempt
    // output and must survive the discard.
    it('preserves a wakeup marker that landed while the attempt was streaming', () => {
        const board = mount();
        const turn = board.begin('ask');

        turn.apply(start());
        turn.apply(text('draft'));
        turn.apply({ type: 'wakeup', agent: 'writer', reason: 'pending-tools', pending: [] });
        turn.flush();

        expect(turn.element.querySelectorAll('.agent-wakeup')).toHaveLength(1);

        turn.apply(retry());
        turn.flush();

        // The attempt prose is gone; the wakeup marker stays.
        expect(turn.element.textContent).not.toContain('draft');
        expect(turn.element.querySelectorAll('.agent-wakeup')).toHaveLength(1);
    });

    // F5: the meta line counts calls, so a discarded card must not keep inflating it.
    it('decrements the tool count for every discarded card', () => {
        const board = mount();
        const turn = board.begin('ask');

        turn.apply(start());
        turn.apply(call('c1', 'first'));
        turn.apply(call('c2', 'second'));
        turn.flush();

        expect(turn.element.querySelector('.tile-meta')?.textContent).toBe('1 agent · 2 tool calls');

        turn.apply(retry());
        turn.flush();

        // Both cards belonged to the abandoned attempt, so neither is counted; the
        // agent itself stays counted (one invocation still exists).
        expect(turn.element.querySelectorAll('details.tool')).toHaveLength(0);
        expect(turn.element.querySelector('.tile-meta')?.textContent).toBe('1 agent');
    });

    // R3/F1: `attempt_commit` closes the window, so a LATER retry cannot reach the
    // committed output even without a `done`.
    it('closes the attempt window on attempt_commit', () => {
        const board = mount();
        const turn = board.begin('ask');

        turn.apply(start());
        turn.apply(text('committed'));
        turn.apply(call('c1', 'read'));
        turn.apply(commit());
        turn.apply(text('second'));
        turn.apply(retry());
        turn.apply(text('third'));
        turn.flush();

        expect(turn.element.textContent).toContain('committed');
        expect(turn.element.querySelectorAll('details.tool')).toHaveLength(1);
        expect(turn.element.textContent).not.toContain('second');
        expect(turn.element.textContent).toContain('third');
    });

    // A malformed boundary says nothing about a committed request, so it must NOT
    // close the window: the retry then discards normally.
    it('ignores a malformed attempt_commit and keeps the window open', () => {
        const board = mount();
        const turn = board.begin('ask');

        turn.apply(start());
        turn.apply(text('kept'));
        // `attempt` below 1 is not a usable attempt index.
        turn.apply(commit({ attempt: 0 }));
        turn.apply(retry());
        turn.flush();

        // The window stayed open, so the retry discarded the prose as usual.
        expect(turn.element.textContent).not.toContain('kept');
        expect(turn.element.querySelectorAll('.agent-retry')).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// T8 defect 1 — per-request REASONING ownership.
//
// The real sequence for a reasoning round that then fails its first attempt is
// `start, reasoning, tool_call, attempt_commit, tool_result, reasoning, retry,
// text, done`. Committing a request must DETACH the incremental reasoning writer,
// otherwise the failed attempt's deltas are appended into the committed block:
// the two requests fuse into one node, and the discard (which only removes owned
// nodes) cannot separate them, so the failed reasoning survives.
// ---------------------------------------------------------------------------

describe('per-request reasoning ownership (T8)', () => {
    const reasoning = (delta: string): HarnessEvent => ({ type: 'reasoning', agent: 'writer', delta });

    const reasoningText = (turn: { element: HTMLElement }): string[] =>
        [...turn.element.querySelectorAll('.reasoning')].map((node) => node.textContent ?? '');

    it('keeps committed reasoning and drops the failed attempt reasoning', () => {
        const board = mount();
        const turn = board.begin('ask');

        turn.apply(start());
        turn.apply(reasoning('committed plan'));
        turn.apply(call('c1', 'read'));
        turn.apply(commit());
        turn.apply(result('c1', 'read'));
        // The NEXT request reasons, then fails its first attempt.
        turn.apply(reasoning('failed musing'));
        turn.apply(retry());
        turn.apply(text('final'));
        turn.flush();

        // Two SEPARATE reasoning blocks are never fused: the committed one survives
        // verbatim and the failed one is gone entirely.
        expect(reasoningText(turn)).toEqual(['committed plan']);
        expect(turn.element.textContent).not.toContain('failed musing');
        expect(turn.element.textContent).toContain('final');
        expect(turn.element.querySelectorAll('details.tool')).toHaveLength(1);
        expect(turn.element.querySelectorAll('.agent-retry')).toHaveLength(1);
    });

    it('keeps committed reasoning when the same sequence is replayed', () => {
        const board = mount();
        const turn = board.begin('ask');
        let at = 1_000;

        const replay = (event: HarnessEvent): void => {
            turn.apply(event, at, 'replay');
            at += 10;
        };

        replay(start());
        replay(reasoning('committed plan'));
        replay(call('c1', 'read'));
        replay(commit());
        replay(result('c1', 'read'));
        replay(reasoning('failed musing'));
        replay(retry());
        replay(text('final'));
        turn.flush();

        expect(reasoningText(turn)).toEqual(['committed plan']);
        expect(turn.element.textContent).not.toContain('failed musing');
        expect(turn.element.textContent).toContain('final');
    });

    // The same ownership rule for PROSE: a superseded text response is committed
    // (its `attempt_commit` arrives before the next request), so the following
    // request's deltas must land in a block of their own.
    it('does not fuse committed prose with the next request prose', () => {
        const board = mount();
        const turn = board.begin('ask');

        turn.apply(start());
        turn.apply(text('superseded prose'));
        turn.apply(commit());
        turn.apply(text('failed draft'));
        turn.apply(retry());
        turn.apply(text('final answer'));
        turn.flush();

        // The committed prose is one block, the failed draft is gone, and the retry
        // answer is its own block: nothing was appended into the committed node.
        // (Each block renders as a markdown paragraph, hence the trailing newline.)
        expect(
            [...turn.element.querySelectorAll('.agent-text')].map((node) => node.textContent)
        ).toEqual(['superseded prose\n', 'final answer\n']);
        expect(turn.element.textContent).not.toContain('failed draft');
    });
});

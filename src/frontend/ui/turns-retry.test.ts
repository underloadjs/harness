// Turn-tile retry handling (R1/R3/R4, and R19/T19: the notice is GONE).
//
// The agent retries ONE model request after a failed attempt. Its streamed output from
// that attempt was already forwarded, so the tile must DISCARD it when the `retry` frame
// arrives. What it must NOT do is print a line about it: a transient retry is internal
// machinery the reader never acts on, so every browser render path — the raw event fold
// here, and a compiled document that still carries a `retry`-tone notice node from an
// OLDER recording — stays silent about it. Everything below therefore asserts the
// DISCARD (the part with real state behind it) and the SILENCE (the part R19 removed).
//
// Pinned contract:
//   - the failed attempt's prose, its think chip and its tool chips are removed;
//   - a discarded think chip's DIALOG is closed with it (`card.destroy()`), and the
//     committed chip's text is never touched by the discard;
//   - NO retry line appears anywhere (`.agent-retry`, `.agent-notice`, or the words
//     "retry"/"attempt N of M" in the tile's text) — while a terminal `error` still
//     prints, because that one is the outcome the reader acts on;
//   - output from an EARLIER successful turn of the same run is never discarded;
//   - a malformed retry frame discards NOTHING (it is not evidence of a failed attempt).
//
// REASONING is an inline CHIP, not a block: one `details.tool.think` per model request,
// appended INTO the agent's `.tool-group` row (ui/turns.ts `appendReasoning` +
// ui/tools.ts `createReasoningCard`). Because the chip IS a `details.tool`, every
// TOOL-CALL count in this file selects `details.tool:not(.think)` and every REASONING
// assertion selects `.tool.think` (its full text is `.tool.think .reasoning`). The old
// `<details class="thinking">` block and its `.thinking-summary` no longer exist.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts

import type { HarnessEvent, SessionView } from '../../server/protocol';
import type { HarnessPendingTool } from '../../types';
import type { TurnDisplay, TurnDisplayOp, TurnSummary } from '../../shared/turn-display';
import { applyOpsToDisplay } from '../view-state';
import { createTurnBoard } from './turns';

const mount = () => {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const board = createTurnBoard({ empty });
    document.body.replaceChildren(board.element);
    return board;
};

// The full text of every reasoning round still on screen, in DOM order. A think chip's
// `.reasoning` block is the ONLY place that text lives now (it moves into the chip's
// dialog while one is open, which no test here does), so this is the discard probe.
const reasoningTexts = (turn: { element: HTMLElement }): string[] =>
    [...turn.element.querySelectorAll('.tool.think .reasoning')].map((node) => node.textContent ?? '');

// The tool CALLS still on screen: `details.tool` alone would also count think chips.
const callChips = (turn: { element: HTMLElement }): number =>
    turn.element.querySelectorAll('details.tool:not(.think)').length;

// The think chips still on screen, one per model request.
const thinkChips = (turn: { element: HTMLElement }): number =>
    turn.element.querySelectorAll('details.tool.think').length;

// Every wrapping chip row in the block, as the chip names it holds in DOM order. A
// reasoning round now appears in here as `think` rather than as a flow-level block.
const rowsOf = (turn: { element: HTMLElement }): string[][] =>
    [...turn.element.querySelectorAll('.agent-flow > .tool-group')].map((row) =>
        [...row.querySelectorAll('.tool-name')].map((node) => node.textContent ?? '')
    );

const start = (agent = 'writer'): HarnessEvent => ({ type: 'start', agent, model: 'm1' });

// R19 (T19): the ONE assertion every retry case makes. A discarded attempt leaves no
// surface behind at all — no dedicated `.agent-retry` line, no `.agent-notice` line, and
// not one word of the old wording anywhere in the tile's text (a screen reader hears this
// element too, so "the line is gone" has to be true of its text, not only of its class).
const expectNoRetryChatter = (turn: { element: HTMLElement }): void => {
    expect(turn.element.querySelectorAll('.agent-retry')).toHaveLength(0);
    expect(turn.element.querySelectorAll('.agent-notice')).toHaveLength(0);
    expect(turn.element.textContent ?? '').not.toMatch(/retry/i);
    expect(turn.element.textContent ?? '').not.toMatch(/attempt \d+ of \d+/);
};

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

describe('model-request retries (R1 + R19)', () => {
    it('discards the failed attempt output and prints no retry line', () => {
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

        // The failed attempt is visible until the retry frame arrives: its one tool
        // call AND the think chip its reasoning deltas minted (both live in the SAME
        // `.tool-group` row, which is why the call count excludes the chip).
        expect(callChips(turn)).toBe(1);
        expect(thinkChips(turn)).toBe(1);
        expect(reasoningTexts(turn)).toEqual(['thinking']);
        // The chip is the row's only child, and the prose that followed it opened a
        // second row for the call — reasoning itself never splits the row.
        expect(rowsOf(turn)).toEqual([['think'], ['dangerous']]);

        turn.apply(retry());
        turn.flush();

        // Everything the abandoned attempt produced is gone: the call chip, the think
        // chip (no `.thinking` block survives either, because there is no longer one)
        // and the prose.
        expect(turn.element.querySelectorAll('details.tool')).toHaveLength(0);
        expect(callChips(turn)).toBe(0);
        expect(thinkChips(turn)).toBe(0);
        expect(reasoningTexts(turn)).toEqual([]);
        expect(turn.element.textContent).not.toContain('partial draft');
        expect(turn.element.textContent).not.toContain('thinking');

        // R19: the discard happened, and NOTHING replaced it — no line, no words. The
        // attempt, the budget, the backoff and the error are still on the wire (the raw
        // journal and the CLI watcher read them); they are simply not transcript content.
        expectNoRetryChatter(turn);
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
        // R19: the surviving answer is the only thing the block shows.
        expectNoRetryChatter(turn);
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
        expectNoRetryChatter(turn);
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
        // R19: and the block is EMPTY, not "empty except for a retry line". A failed first
        // attempt leaves no blank strip and no notice behind.
        expect([...(turn.element.querySelector('.agent-flow')?.children ?? [])].map((child) => child.className)).toEqual(
            []
        );
        expectNoRetryChatter(turn);
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
        expectNoRetryChatter(turn);
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
        expectNoRetryChatter(turn);
    });
});

// ---------------------------------------------------------------------------
// T8 defect 1 — per-request REASONING ownership.
//
// The real sequence for a reasoning round that then fails its first attempt is
// `start, reasoning, tool_call, attempt_commit, tool_result, reasoning, retry,
// text, done`. Each round renders as ONE inline think chip in the agent's
// `.tool-group` row, and committing a request must DETACH the incremental reasoning
// WRITER pointer (the chip itself stays in the DOM with its text), otherwise the
// failed attempt's deltas are appended into the committed chip: the two requests
// fuse into one chip, and the discard (which only removes owned chips) cannot
// separate them, so the failed reasoning survives.
// ---------------------------------------------------------------------------

describe('per-request reasoning ownership (T8)', () => {
    const reasoning = (delta: string): HarnessEvent => ({ type: 'reasoning', agent: 'writer', delta });

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

        // Two SEPARATE think chips are never fused: the committed one survives verbatim
        // and the failed one is gone entirely — including its chip, its text and the
        // `.reasoning` block inside it.
        expect(reasoningTexts(turn)).toEqual(['committed plan']);
        expect(thinkChips(turn)).toBe(1);
        expect(turn.element.querySelector('.tool.think .tool-name')?.textContent).toBe('think');
        expect(turn.element.textContent).not.toContain('failed musing');
        expect(turn.element.textContent).toContain('final');
        // The committed call chip is untouched by the discard (reasoning is not a call).
        expect(callChips(turn)).toBe(1);
        expectNoRetryChatter(turn);
    });

    // The chip is INLINE, so a discard removes it from the row the committed calls share
    // and leaves that row (and its chips) standing.
    it('removes only the failed attempt think chip from a shared tool row', () => {
        const board = mount();
        const turn = board.begin('ask');

        turn.apply(start());
        turn.apply(reasoning('first plan'));
        turn.apply(call('c1', 'read'));
        turn.apply(commit());
        // The next request mints its OWN chip in the same row, then fails.
        turn.apply(reasoning('second musing'));
        turn.apply(call('c2', 'search'));
        turn.flush();

        expect(rowsOf(turn)).toEqual([['think', 'read', 'think', 'search']]);
        expect(reasoningTexts(turn)).toEqual(['first plan', 'second musing']);

        turn.apply(retry());
        turn.flush();

        // Only the failed attempt's chips leave; the row keeps the committed pair, and
        // the committed chip's text is still exactly the committed buffer.
        expect(rowsOf(turn)).toEqual([['think', 'read']]);
        expect(reasoningTexts(turn)).toEqual(['first plan']);
        expect(turn.element.textContent).not.toContain('second musing');
    });

    // The discard also closes a dialog the discarded chip OWNS (`card.destroy()`): a
    // modal left behind by a chip that is no longer in the transcript is an orphan with
    // a stale focus trap and a body that no longer belongs to the document.
    it('closes a dialog the discarded think chip owns', () => {
        const board = mount();
        const turn = board.begin('ask');

        turn.apply(start());
        turn.apply(reasoning('committed plan'));
        turn.apply(commit());
        turn.apply(reasoning('failed musing'));
        turn.flush();

        const failed = turn.element.querySelectorAll('details.tool.think')[1] as HTMLDetailsElement;
        expect(failed.querySelector('.reasoning')?.textContent).toBe('failed musing');

        // Activating the chip MOVES that same body into the modal (no clone, no
        // duplicate), and with no context reported the title carries only the count.
        failed.querySelector('summary')?.click();
        const dialog = document.querySelector<HTMLElement>('.dialog');
        expect(dialog).not.toBeNull();
        expect(dialog?.querySelector('.dialog-title')?.textContent).toBe('think · 13 chars');
        expect(dialog?.querySelector('.reasoning')?.textContent).toBe('failed musing');

        turn.apply(retry());
        turn.flush();

        expect(document.querySelector('.dialog')).toBeNull();
        expect(thinkChips(turn)).toBe(1);
        expect(reasoningTexts(turn)).toEqual(['committed plan']);
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

        // The replayed record is the same event list, so the live and recorded paths
        // must agree chip for chip.
        expect(reasoningTexts(turn)).toEqual(['committed plan']);
        expect(rowsOf(turn)).toEqual([['think', 'read']]);
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

// ---------------------------------------------------------------------------
// T19 (R19) — the OTHER browser render path.
//
// The raw fold above never mints a retry line any more. A COMPILED document can still
// carry one: a session recorded by an older build stored the per-attempt notice as a
// `notice` node with tone `retry`, and an import/replay feeds that tree straight to the
// tile. Suppressing it is a rendering rule for every path, not only for the projector
// that stopped producing it — while the `error` tone that means "the budget ran out"
// keeps printing, because that one is the outcome the reader acts on.
//
// Driven with hand-written fixtures (`TurnSummary` + `TurnDisplay`), so the evidence is
// about the renderer, not about a test-side compiler.
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;

const row = (overrides: Partial<TurnSummary> = {}): TurnSummary =>
    ({
        id: 't1',
        index: 0,
        prompt: 'ask',
        status: 'running',
        state: 'streaming',
        updatedAt: T0,
        sectionCount: 1,
        stepCount: 0,
        activeAgents: ['instruct'],
        blocks: [],
        ...overrides
    }) as TurnSummary;

const tree = (nodes: unknown[]): TurnDisplay =>
    ({
        turnId: 't1',
        sections: [
            {
                id: 't1:0',
                role: 'primary',
                agent: 'instruct',
                agentLabel: 'RR1',
                state: 'streaming',
                nodes
            }
        ]
    }) as TurnDisplay;

const viewOf = (display: TurnDisplay): SessionView =>
    ({
        id: 's1',
        harness: 'instruct',
        status: 'running',
        model: 'm1',
        createdAt: 1,
        updatedAt: T0,
        turns: [row()],
        displays: { t1: display }
    }) as unknown as SessionView;

// The per-turn pending-tool map the shell threads through the reducer (main.ts keeps one per
// session view); an empty map is the honest stand-in for a document with no live calls.
const pending = new Map<string, HarnessPendingTool[]>();

const mountCompiled = (): { board: ReturnType<typeof createTurnBoard>; tile: () => HTMLElement } => {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const board = createTurnBoard({ empty });
    board.bindSession('s1');
    document.body.replaceChildren(board.element);

    return { board, tile: () => document.querySelector<HTMLElement>('.tile') as HTMLElement };
};

describe('a retry the browser never prints, compiled path included (T19, R19)', () => {
    it('renders an imported retry-tone notice as nothing at all', () => {
        // The tree an OLDER recording hands the tile: a committed first block plus the notice
        // line that build wrote for it, and the answer that followed. `committed` on the first
        // node is what the projector stamps for a settled round, and it is also what makes the
        // two prose blocks render as two elements — so a vanished notice is visible as a
        // MISSING element between them, not as fused text.
        const display = tree([
            { kind: 'text', id: 'n0', text: 'a half sentence', committed: true },
            { kind: 'notice', id: 'n1', tone: 'retry', text: 'attempt 1 of 11 failed · retrying in 1.0s · HTTP 500', at: T0 },
            { kind: 'text', id: 'n2', text: 'the answer', committed: true }
        ]);
        const { board, tile } = mountCompiled();
        const handle = board.upsertView(row(), viewOf(display));
        handle.renderDisplay(display);
        handle.flush();

        // The real content survives untouched…
        expect([...tile().querySelectorAll('.agent-text')].map((node) => node.textContent)).toEqual([
            'a half sentence\n',
            'the answer\n'
        ]);
        // …and the notice is simply not there: no line, and no trace of its words.
        expect(tile().querySelectorAll('.agent-notice')).toHaveLength(0);
        expect(tile().textContent ?? '').not.toMatch(/retry/i);
        expect(tile().textContent ?? '').not.toContain('HTTP 500');
    });

    it('keeps the terminal error-tone notice that a retry budget exhausting sends', () => {
        // The distinction is the TONE, never the words: this one is the outcome, so dropping
        // the chatter must not drop it.
        const display = tree([
            { kind: 'notice', id: 'n1', tone: 'retry', text: 'attempt 3 of 11 failed · retrying in 8.0s · HTTP 503', at: T0 },
            { kind: 'notice', id: 'n2', tone: 'error', text: 'Request failed: HTTP 503', at: T0 + 100 }
        ]);
        const { board, tile } = mountCompiled();
        const handle = board.upsertView(row(), viewOf(display));
        handle.renderDisplay(display);
        handle.flush();

        const lines = tile().querySelectorAll<HTMLElement>('.agent-notice');

        expect(lines).toHaveLength(1);
        expect(lines[0].dataset.tone).toBe('error');
        expect(lines[0].querySelector('.agent-notice-text')?.textContent).toBe('Request failed: HTTP 503');
    });

    it('stays silent when a live ops frame inserts a retry notice', () => {
        // The other way the same node arrives: an `node:insert` op, applied through the REAL
        // document reducer the shell runs before routing a frame.
        const display = tree([]);
        const view = viewOf(display);
        const { board, tile } = mountCompiled();
        const handle = board.upsertView(row(), view);
        handle.renderDisplay(display);

        const insert = {
            op: 'node:insert',
            turnId: 't1',
            sectionId: 't1:0',
            node: { kind: 'notice', id: 'n9', tone: 'retry', text: 'attempt 1 of 11 failed · retrying in 1.0s' }
        } as unknown as TurnDisplayOp;

        applyOpsToDisplay(view, 't1', [insert], pending);
        board.applyViewOps('t1', [insert], view);
        handle.flush();

        expect(tile().querySelectorAll('.agent-notice')).toHaveLength(0);
        expect(tile().textContent ?? '').not.toMatch(/retry/i);
    });
});

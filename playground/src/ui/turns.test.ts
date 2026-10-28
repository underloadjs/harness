// Turn-tile tests: the one-expanded-tile rule, streaming Markdown, tool pairing
// and subagent labelling. These pin the layout contract the UI depends on:
// newest tile open, older tiles compact, expansion never destroyed by stream
// deltas, and every event routed to the agent that emitted it.
//
// Run: npx vitest run --config playground/vitest.config.ts
import type { HarnessAssistantMessage, HarnessEvent, SessionTurn } from '../../../server/protocol';
import { createTurnBoard } from './turns';

const doneMessage = (agent: string): HarnessAssistantMessage => ({
    role: 'assistant',
    content: 'answer',
    reasoning: '',
    toolCalls: [],
    model: `${agent}-model`,
    stopReason: 'stop'
});

const mount = () => {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const board = createTurnBoard({ empty });
    document.body.replaceChildren(board.element);
    return { board, empty };
};

describe('createTurnBoard', () => {
    it('creates a queued tile, removes the empty state and expands it', () => {
        const { board, empty } = mount();
        const turn = board.begin('Hello **world**');

        expect(board.turns()).toEqual([turn]);
        expect(board.expanded()).toBe(turn);
        expect(turn.state()).toBe('queued');
        expect(turn.element.dataset.state).toBe('queued');
        expect(turn.element.classList.contains('is-expanded')).toBe(true);
        expect(turn.element.querySelector('.tile-index')?.textContent).toBe('#1');
        expect(turn.element.querySelector('.tile-status-text')?.textContent).toBe('queued');
        expect(turn.element.querySelector('.tile-select')?.getAttribute('aria-expanded')).toBe('true');
        expect(turn.element.querySelector('.tile-prompt')?.textContent).toBe('Hello world');
        expect(turn.element.querySelector('.turn-prompt')?.innerHTML).toBe(
            '<p>Hello <strong>world</strong></p>\n'
        );
        expect(empty.isConnected).toBe(false);
    });

    it('streams Markdown text and settles it on flush', () => {
        const { board } = mount();
        const turn = board.begin('ask');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        expect(turn.state()).toBe('streaming');

        turn.apply({ type: 'text', agent: 'writer', delta: '# Hi\n\n' });
        turn.apply({ type: 'text', agent: 'writer', delta: 'a **b**' });
        turn.flush();

        expect(turn.element.querySelector('.agent-text')?.innerHTML).toBe(
            '<h1>Hi</h1>\n<p>a <strong>b</strong></p>\n'
        );
        expect(turn.element.querySelector('.agent-meta')?.textContent).toBe('');
        expect(turn.element.querySelector('.tile-meta')?.textContent).toBe('1 agent');
    });

    it('pairs a tool call with its result inside the agent flow', () => {
        const { board } = mount();
        const turn = board.begin('run it');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply({
            type: 'tool_call',
            agent: 'writer',
            call: { id: 'c1', name: 'fileRead', arguments: '{"path":"package.json"}' }
        });

        const tool = turn.element.querySelector('details.tool');
        expect(tool?.getAttribute('data-state')).toBe('running');
        expect(turn.summary()).toEqual({ agents: 1, tools: 1, primary: 'writer' });

        turn.apply({
            type: 'tool_result',
            agent: 'writer',
            name: 'fileRead',
            content: '{"ok":true}',
            isError: false
        });

        expect(tool?.getAttribute('data-state')).toBe('ok');
        expect(turn.element.querySelectorAll('details.tool')).toHaveLength(1);
        expect(turn.element.querySelector('.tool-state')?.textContent).toBe('ok');
    });

    it('labels a delegated agent as a subagent and keeps the tile open until the stream ends', () => {
        const { board } = mount();
        const turn = board.begin('agentDelegate');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply({ type: 'tool_call', agent: 'writer', call: { id: 'd1', name: 'agentDelegate', arguments: '{}' } });
        turn.apply({ type: 'start', agent: 'helper', model: 'm2' });
        turn.apply({ type: 'text', agent: 'helper', delta: 'done' });

        const agents = [...turn.element.querySelectorAll('.agent')];
        expect(agents.map((agent) => agent.getAttribute('data-agent'))).toEqual(['writer', 'helper']);
        expect(agents.map((agent) => agent.getAttribute('data-role'))).toEqual(['primary', 'subagent']);
        expect(agents[1]?.querySelector('.agent-role')?.textContent).toBe('subagent');

        // `done` closes the agent turn, not the user turn: the primary still has
        // to return from its tool call.
        turn.apply({ type: 'done', agent: 'helper', message: doneMessage('helper') });
        expect(turn.state()).toBe('streaming');
        expect(agents[1]?.querySelector('.agent-meta')?.textContent).toBe('helper-model · stop');

        turn.setState('done', 'm1 · idle');
        expect(turn.state()).toBe('done');
        expect(turn.element.dataset.state).toBe('done');
        expect(turn.element.querySelector('.tile-status-text')?.textContent).toBe('done');
        expect(turn.element.querySelector('.tile-meta')?.textContent).toBe('2 agents · 1 tool call · m1 · idle');
    });

    it('keeps exactly one tile expanded and lets the user reopen an older one', () => {
        const { board } = mount();
        const first = board.begin('first');
        const second = board.begin('second');

        expect(board.turns()).toEqual([first, second]);
        expect(board.expanded()).toBe(second);
        expect(first.element.classList.contains('is-expanded')).toBe(false);
        expect(first.element.querySelector('.tile-select')?.getAttribute('aria-expanded')).toBe('false');

        board.expand(first);
        expect(board.expanded()).toBe(first);
        expect(first.element.classList.contains('is-expanded')).toBe(true);
        expect(second.element.classList.contains('is-expanded')).toBe(false);

        // A delta arriving for the newer turn must not steal the selection back.
        second.apply({ type: 'start', agent: 'writer', model: 'm1' });
        second.apply({ type: 'text', agent: 'writer', delta: 'late' });
        second.flush();

        expect(board.expanded()).toBe(first);
        expect(first.element.classList.contains('is-expanded')).toBe(true);
    });

    it('collapses the expanded tile when its header is clicked again', () => {
        const { board } = mount();
        const turn = board.begin('toggle');
        const select = turn.element.querySelector<HTMLButtonElement>('.tile-select');

        select?.click();
        expect(board.expanded()).toBeUndefined();
        expect(turn.element.classList.contains('is-expanded')).toBe(false);
        expect(select?.getAttribute('aria-expanded')).toBe('false');

        select?.click();
        expect(board.expanded()).toBe(turn);
        expect(turn.element.classList.contains('is-expanded')).toBe(true);
    });

    it('records notices and restores the empty state on clear', () => {
        const { board, empty } = mount();
        const turn = board.begin('one');

        const notice = board.notice('run cancelled');
        expect(notice.textContent).toBe('run cancelled');
        expect(notice.dataset.tone).toBe('info');

        const errorNotice = board.notice('run failed', 'error');
        expect(errorNotice.dataset.tone).toBe('error');

        board.clear();
        expect(board.turns()).toEqual([]);
        expect(board.expanded()).toBeUndefined();
        expect(board.element.contains(empty)).toBe(true);
        expect(turn.element.isConnected).toBe(false);

        // Numbering restarts with the new conversation.
        expect(board.begin('again').element.querySelector('.tile-index')?.textContent).toBe('#1');
    });

    it('turns an agent error event into a visible, readable node', () => {
        const { board } = mount();
        const turn = board.begin('fail');

        turn.apply({ type: 'error', agent: 'writer', error: { message: 'provider exploded' } });

        expect(turn.element.querySelector('.agent-error-label')?.textContent).toBe('error');
        expect(turn.element.querySelector('.agent-error-text')?.textContent).toBe('provider exploded');
    });
});

describe('server turns', () => {
    const serverTurn = (overrides: Partial<SessionTurn> = {}): SessionTurn => ({
        id: 't1',
        index: 0,
        prompt: 'server prompt',
        status: 'done',
        startedAt: 1,
        updatedAt: 2,
        events: [],
        ...overrides
    });

    it('binds the server id and the 1-based display index onto an optimistic tile', () => {
        const { board } = mount();
        const turn = board.begin('optimistic');

        expect(turn.id()).toBeUndefined();
        expect(turn.element.dataset.turnId).toBeUndefined();

        // Server `index` is 0-based; the fourth server turn is displayed "#5".
        turn.bind({ id: 'server-7', index: 4 });

        expect(turn.id()).toBe('server-7');
        expect(turn.element.dataset.turnId).toBe('server-7');
        expect(turn.element.querySelector('.tile-index')?.textContent).toBe('#5');
        expect(board.find('server-7')).toBe(turn);
        expect(board.find('other')).toBeUndefined();
    });

    it('adopts a recorded turn by replaying its events and settling its status', () => {
        const { board, empty } = mount();

        const turn = board.adopt(
            serverTurn({
                events: [
                    { type: 'start', agent: 'writer', model: 'm1' },
                    { type: 'tool_call', agent: 'writer', call: { id: 'c1', name: 'fileRead', arguments: '{}' } },
                    { type: 'tool_result', agent: 'writer', name: 'fileRead', content: '{"ok":true}', isError: false },
                    { type: 'text', agent: 'writer', delta: 'recorded **prose**' },
                    { type: 'done', agent: 'writer', message: doneMessage('writer') }
                ]
            }),
            'm1'
        );

        expect(turn.state()).toBe('done');
        expect(turn.id()).toBe('t1');
        expect(turn.element.dataset.state).toBe('done');
        expect(turn.element.querySelector('.tile-index')?.textContent).toBe('#1');
        expect(turn.element.querySelector('.tile-status-text')?.textContent).toBe('done');
        expect(turn.element.querySelector('.agent-text')?.innerHTML).toBe('<p>recorded <strong>prose</strong></p>\n');
        expect(turn.element.querySelector<HTMLElement>('details.tool')?.dataset.state).toBe('ok');
        // The meta line stops at the model: the settled state is carried by the
        // tile's colour (`data-state`), never repeated as a second "done" word.
        expect(turn.element.querySelector('.tile-meta')?.textContent).toBe('1 agent · 1 tool call · m1');
        expect(empty.isConnected).toBe(false);
    });

    it('hydrates a whole conversation in server index order, newest expanded', () => {
        const { board } = mount();

        const handles = board.hydrate(
            [
                serverTurn({
                    id: 'a',
                    index: 0,
                    prompt: 'first',
                    events: [
                        { type: 'start', agent: 'writer', model: 'm1' },
                        { type: 'text', agent: 'writer', delta: 'one' }
                    ]
                }),
                serverTurn({
                    id: 'b',
                    index: 1,
                    prompt: 'second',
                    status: 'error',
                    events: [
                        { type: 'start', agent: 'writer', model: 'm1' },
                        { type: 'error', agent: 'writer', error: { message: 'boom' } }
                    ]
                })
            ],
            { model: 'm1' }
        );

        expect(handles.map((handle) => handle.id())).toEqual(['a', 'b']);
        expect(board.turns()).toEqual(handles);
        expect(tileIndexes(board)).toEqual(['#1', '#2']);
        expect(handles.map((handle) => handle.state())).toEqual(['done', 'error']);
        expect(board.expanded()).toBe(handles[1]);
        expect(handles[0].element.classList.contains('is-expanded')).toBe(false);
        expect(handles[0].element.querySelector('.agent-text')?.textContent).toBe('one\n');
        expect(handles[1].element.querySelector('.agent-error-text')?.textContent).toBe('boom');
        // Failure is colour-coded (`data-state="error"`), not spelled out again.
        expect(handles[1].element.querySelector('.tile-meta')?.textContent).toBe('1 agent · m1');
    });

    it('keeps the reader’s expanded turn across a snapshot rebuild', () => {
        const { board } = mount();

        board.hydrate([serverTurn({ id: 'a', index: 0, prompt: 'first', events: [{ type: 'start', agent: 'w', model: 'm1' }] })]);
        board.hydrate([
            serverTurn({ id: 'a', index: 0, prompt: 'first', events: [{ type: 'start', agent: 'w', model: 'm1' }] }),
            serverTurn({
                id: 'b',
                index: 1,
                prompt: 'second',
                status: 'running',
                events: [{ type: 'start', agent: 'w', model: 'm1' }]
            })
        ]);

        // A later poll/snapshot names the older turn as the one to keep.
        const handles = board.hydrate(
            [
                serverTurn({ id: 'a', index: 0, prompt: 'first', events: [{ type: 'start', agent: 'w', model: 'm1' }] }),
                serverTurn({
                    id: 'b',
                    index: 1,
                    prompt: 'second',
                    status: 'running',
                    events: [{ type: 'start', agent: 'w', model: 'm1' }]
                })
            ],
            { keep: 'a' }
        );

        expect(board.expanded()).toBe(handles[0]);
        expect(handles[1].element.classList.contains('is-expanded')).toBe(false);
    });

    it('renders subagents from the recorded event order', () => {
        const { board } = mount();

        const [turn] = board.hydrate([
            serverTurn({
                events: [
                    { type: 'start', agent: 'writer', model: 'm1' },
                    { type: 'tool_call', agent: 'writer', call: { id: 'd1', name: 'agentDelegate', arguments: '{}' } },
                    { type: 'start', agent: 'helper', model: 'm2' },
                    { type: 'text', agent: 'helper', delta: 'delegated' },
                    { type: 'done', agent: 'helper', message: doneMessage('helper') },
                    { type: 'tool_result', agent: 'writer', name: 'agentDelegate', content: 'done', isError: false }
                ]
            })
        ]);

        const agents = [...turn.element.querySelectorAll<HTMLElement>('.agent')];
        expect(agents.map((agent) => agent.dataset.agent)).toEqual(['writer', 'helper']);
        expect(agents.map((agent) => agent.dataset.role)).toEqual(['primary', 'subagent']);
        expect(agents[0].querySelector('.agent-text')).toBeNull();
        expect(agents[1].querySelector('.agent-text')?.textContent).toBe('delegated\n');
    });

    it('restores the empty state when a snapshot has no turns', () => {
        const { board, empty } = mount();

        board.adopt(serverTurn());
        expect(board.turns()).toHaveLength(1);

        expect(board.hydrate([])).toEqual([]);
        expect(board.turns()).toEqual([]);
        expect(board.expanded()).toBeUndefined();
        expect(empty.isConnected).toBe(true);
    });
});

// Helper shared by the server-turn cases: reads a tile's index labels.
const tileIndexes = (board: ReturnType<typeof createTurnBoard>): (string | null)[] =>
    [...board.element.querySelectorAll<HTMLElement>('.tile-index')].map((node) => node.textContent);

// ---------------------------------------------------------------------------
// Server queue (R4)
// ---------------------------------------------------------------------------
//
// The server owns the queue: turns are FIFO, a task submitted while another runs
// is `queued`, and the browser reconciles records by the stable server id. These
// cases pin (a) queued rendering is neutral with no clock, (b) a queued turn sits
// after the active one, (c) merging a record NEVER replays events the tile already
// holds (no duplicated streamed text), and (d) reconcile keeps the reader's
// expanded tile while adopting a task the browser had never seen.

describe('server queue', () => {
    const T = 1_700_000_000_000;

    const start = (agent: string): { type: 'start'; agent: string; model: string } => ({
        type: 'start',
        agent,
        model: 'm1'
    });

    const turnRecord = (overrides: Partial<SessionTurn> = {}): SessionTurn =>
        ({
            id: 't1',
            index: 0,
            prompt: 'task',
            status: 'done',
            startedAt: T,
            updatedAt: T + 1000,
            events: [],
            ...overrides
        }) as SessionTurn;

    it('renders a queued turn neutral, with no ring and no elapsed clock', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(T));

        const { board } = mount();
        const queued = board.adopt(
            turnRecord({
                id: 't2',
                index: 1,
                prompt: 'second task',
                status: 'queued',
                startedAt: undefined,
                updatedAt: T,
                events: []
            })
        );

        expect(queued.state()).toBe('queued');
        expect(queued.element.dataset.state).toBe('queued');
        expect(queued.element.parentElement?.dataset.state).toBe('queued');
        expect(queued.element.querySelector('.tile-status-text')?.textContent).toBe('queued');
        // No clock: a queued task is not running and must not accrue time.
        expect(queued.elapsed()).toBe('');
        expect(queued.element.querySelector<HTMLElement>('.tile-elapsed')?.hidden).toBe(true);

        vi.advanceTimersByTime(5000);
        expect(queued.elapsed()).toBe('');

        vi.useRealTimers();
    });

    it('keeps queued tasks after the active one and advances them in FIFO order', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(T + 60_000));

        const { board } = mount();

        const active = turnRecord({
            id: 'a',
            index: 0,
            status: 'running',
            events: [start('writer')]
        });
        const queued = turnRecord({
            id: 'b',
            index: 1,
            prompt: 'behind',
            status: 'queued',
            startedAt: undefined,
            updatedAt: T,
            events: []
        });

        const handles = board.reconcile([active, queued], { model: 'm1' });

        expect(handles.map((handle) => handle.id())).toEqual(['a', 'b']);
        expect(handles.map((handle) => handle.state())).toEqual(['streaming', 'queued']);
        expect(
            [...board.element.querySelectorAll<HTMLElement>('.turn-row')].map((row) => row.dataset.state)
        ).toEqual(['streaming', 'queued']);

        // The server advances the queue: B's upsert becomes running with a start
        // stamp, and the tile now ticks from THAT stamp (never from the submit).
        const advanced = turnRecord({
            id: 'b',
            index: 1,
            prompt: 'behind',
            status: 'running',
            startedAt: T + 60_000,
            updatedAt: T + 60_500,
            events: [start('writer')]
        });
        handles[1].merge(advanced, 'm1');

        expect(handles[1].state()).toBe('streaming');
        expect(handles[1].elapsed()).toBe('0ms');
        expect(handles[0].state()).toBe('streaming');

        vi.useRealTimers();
    });

    it('merges a server record without replaying events the tile already streamed', () => {
        const { board } = mount();
        const turn = board.begin('streamed');
        turn.bind({ id: 't1', index: 0 });

        // Live frames: the tile already holds these two text deltas.
        turn.apply({ type: 'text', agent: 'writer', delta: 'Hello ' });
        turn.apply({ type: 'text', agent: 'writer', delta: 'world' });
        turn.flush();

        expect(turn.applied()).toBe(2);

        // A reconnect reports the same record (the server now also has a third
        // event). Only the third may be applied.
        turn.merge(
            turnRecord({
                events: [
                    { type: 'text', agent: 'writer', delta: 'Hello ' },
                    { type: 'text', agent: 'writer', delta: 'world' },
                    { type: 'text', agent: 'writer', delta: '!' }
                ],
                updatedAt: T + 100
            }),
            'm1'
        );
        turn.flush();

        expect(turn.applied()).toBe(3);
        expect(turn.element.querySelector('.agent-text')?.textContent).toBe('Hello world!\n');
        expect(turn.element.querySelectorAll('.agent-text')).toHaveLength(1);
    });

    it('reconciles by id: keeps the expanded tile and adopts a turn it never saw', () => {
        const { board } = mount();

        const first = turnRecord({
            id: 'a',
            index: 0,
            prompt: 'first',
            events: [start('writer')]
        });
        const [handleA] = board.reconcile([first]);
        board.expand(handleA);

        // A second task was submitted elsewhere; the snapshot carries both.
        const second = turnRecord({
            id: 'b',
            index: 1,
            prompt: 'second',
            status: 'running',
            startedAt: T + 10,
            updatedAt: T + 20,
            events: [start('writer')]
        });
        const handles = board.reconcile([first, second], { keep: 'a' });

        expect(handles.map((handle) => handle.id())).toEqual(['a', 'b']);
        expect(handles[0]).toBe(handleA);
        expect(board.expanded()).toBe(handleA);
        // The reader's tile was merged in place, not rebuilt: same DOM node.
        expect(handles[0].element).toBe(handleA.element);
        expect(handles[1].state()).toBe('streaming');
    });

    it('drops turns the server no longer lists but keeps an unbound optimistic tile', () => {
        const { board } = mount();

        board.reconcile([turnRecord({ id: 'a', index: 0 })]);
        const optimistic = board.begin('not answered yet');

        const handles = board.reconcile([turnRecord({ id: 'b', index: 1, prompt: 'other' })]);

        // Server authority removed `a`; the browser's own in-flight prompt stays.
        expect(handles.map((handle) => handle.id())).toEqual(['b', undefined]);
        expect(handles[1]).toBe(optimistic);
        expect(board.turns()).toHaveLength(2);
    });

    // --- R2: the enqueue/observer race ------------------------------------
    //
    // server/sessions.ts `enqueue` publishes the queued `turn` upsert BEFORE it
    // returns the 202 body, so an open observer can describe a turn whose
    // optimistic tile is still unbound. The board must CLAIM that tile (and, with
    // the ack arriving later, must not regress it), never adopt a duplicate.

    it('claims the optimistic tile when the record arrives before the POST answer', () => {
        const { board } = mount();

        const active = board.adopt(
            turnRecord({
                id: 'a',
                index: 0,
                prompt: 'first',
                status: 'running',
                events: [start('writer')],
                updatedAt: T + 10
            })
        );
        const optimistic = board.begin('second');
        expect(optimistic.id()).toBeUndefined();

        // The observer's queued upsert lands first: it claims the waiting tile.
        const queuedB = turnRecord({
            id: 'b',
            index: 1,
            prompt: 'second',
            status: 'queued',
            startedAt: undefined,
            updatedAt: T + 20,
            events: []
        });
        expect(board.claim(queuedB.prompt)).toBe(optimistic);
        optimistic.merge(queuedB, 'm1');

        expect(board.turns()).toEqual([active, optimistic]);
        expect(optimistic.id()).toBe('b');
        expect(optimistic.state()).toBe('queued');
        // The queued row is neutral: no clock until execution starts (R1/R2).
        expect(optimistic.elapsed()).toBe('');
        expect(board.element.querySelectorAll('.turn-row')).toHaveLength(2);

        // The ack now reconciles the same snapshot: still exactly two rows, in
        // submission order, with the active task first.
        const handles = board.reconcile([turnRecord({
            id: 'a',
            index: 0,
            prompt: 'first',
            status: 'running',
            events: [start('writer')],
            updatedAt: T + 10
        }), queuedB], { model: 'm1' });

        expect(handles).toEqual([active, optimistic]);
        expect(handles.map((handle) => handle.element.querySelector('.tile-index')?.textContent)).toEqual([
            '#1',
            '#2'
        ]);
        expect(board.element.querySelectorAll('.turn-row')).toHaveLength(2);
    });

    it('claims repeated prompts in submission order (FIFO), one tile per record', () => {
        const { board } = mount();

        const first = board.begin('same task');
        const second = board.begin('same task');

        const handles = board.reconcile([
            turnRecord({ id: 'x', index: 0, prompt: 'same task', status: 'queued', startedAt: undefined, updatedAt: T }),
            turnRecord({ id: 'y', index: 1, prompt: 'same task', status: 'queued', startedAt: undefined, updatedAt: T + 1 })
        ]);

        expect(handles).toEqual([first, second]);
        expect(handles.map((handle) => handle.id())).toEqual(['x', 'y']);
        expect(board.element.querySelectorAll('.turn-row')).toHaveLength(2);
    });

    it('removes a duplicate tile bound to the same id, including its row', () => {
        const { board } = mount();

        const record = turnRecord({
            id: 'b',
            index: 1,
            prompt: 'second',
            status: 'running',
            startedAt: T + 5,
            updatedAt: T + 10,
            events: [start('writer')]
        });

        // The duplicate the old code left behind: an adopted tile plus the
        // optimistic tile the ack bound to the same id.
        const adopted = board.adopt(record);
        const optimistic = board.begin('second');
        optimistic.bind({ id: 'b', index: 1 });
        expect(board.turns()).toHaveLength(2);

        const handles = board.reconcile([record]);

        // The first tile in board order keeps the id; the duplicate row is gone.
        expect(handles).toEqual([adopted]);
        expect(board.turns()).toEqual([adopted]);
        expect(board.element.querySelectorAll('.turn-row')).toHaveLength(1);
        expect(board.element.querySelectorAll('.tile')).toHaveLength(1);
        // The duplicate row is detached, not merely unlisted: an orphaned row is
        // what kept a stale green tile on screen after the record had moved on.
        expect(optimistic.element.isConnected).toBe(false);
    });

    it('ignores a stale record so a running row never regresses to queued', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(T + 60));

        const { board } = mount();

        const queued = turnRecord({
            id: 'b',
            index: 1,
            prompt: 'second',
            status: 'queued',
            startedAt: undefined,
            updatedAt: T,
            events: []
        });
        const tile = board.adopt(queued);

        const running = turnRecord({
            id: 'b',
            index: 1,
            prompt: 'second',
            status: 'running',
            startedAt: T + 50,
            updatedAt: T + 60,
            events: [start('writer')]
        });
        tile.merge(running, 'm1');
        expect(tile.state()).toBe('streaming');
        expect(tile.elapsed()).toBe('10ms');

        // The 202 body was captured at enqueue time and resolves last: it is
        // older than the running record, so it must change nothing.
        tile.merge(queued, 'm1');
        expect(tile.state()).toBe('streaming');
        expect(tile.elapsed()).toBe('10ms');

        // Same-millisecond stamp: the lower status rank may not win either.
        tile.merge(turnRecord({ ...queued, updatedAt: T + 60 }), 'm1');
        expect(tile.state()).toBe('streaming');

        vi.useRealTimers();
    });

    it('ignores a stale running record so a settled row stays settled', () => {
        const { board } = mount();

        const done = turnRecord({
            id: 'a',
            index: 0,
            prompt: 'first',
            status: 'done',
            startedAt: T,
            updatedAt: T + 100,
            events: [start('writer')]
        });
        const tile = board.adopt(done);
        expect(tile.state()).toBe('done');
        expect(tile.elapsed()).toBe('100ms');

        tile.merge(
            turnRecord({
                id: 'a',
                index: 0,
                prompt: 'first',
                status: 'running',
                startedAt: T,
                updatedAt: T + 100,
                events: [start('writer')]
            }),
            'm1'
        );

        expect(tile.state()).toBe('done');
        expect(tile.elapsed()).toBe('100ms');
    });

    it('retires a failed submit and claims the retried prompt, not the ghost', () => {
        const { board } = mount();

        // A submit that fails leaves an unbound, terminal tile (its message is a
        // separate `.notice` the submit path owns).
        const failed = board.begin('retry me');
        failed.setState('error', 'network unreachable');
        expect(failed.id()).toBeUndefined();
        expect(failed.state()).toBe('error');

        // The same prompt is submitted again: a NEW, genuinely pending tile.
        const retry = board.begin('retry me');

        // The observer's record arrives before the retry's ack: it must claim the
        // pending tile, never the failed one (which would resurrect the failure as
        // a running row).
        expect(board.claim('retry me')).toBe(retry);

        const record = turnRecord({
            id: 'r',
            index: 0,
            prompt: 'retry me',
            status: 'queued',
            startedAt: undefined,
            updatedAt: T
        });
        retry.merge(record, 'm1');
        expect(board.turns()).toEqual([failed, retry]);
        expect(retry.id()).toBe('r');

        // The next snapshot retires the failed ghost; the accepted retry stays.
        const handles = board.reconcile([record], { model: 'm1' });

        expect(handles).toEqual([retry]);
        expect(board.turns()).toEqual([retry]);
        expect(failed.element.isConnected).toBe(false);
        expect(board.element.querySelectorAll('.turn-row')).toHaveLength(1);
        expect(board.element.querySelectorAll('.tile')).toHaveLength(1);
    });

    it('does not preserve a failed row across a later session reconcile', () => {
        const { board } = mount();

        const failed = board.begin('lost task');
        failed.setState('error', 'server restarted');

        // A snapshot for this session knows nothing about the failed submit.
        board.reconcile([turnRecord({ id: 'a', index: 0, prompt: 'other', status: 'done' })]);

        expect(board.turns().map((handle) => handle.id())).toEqual(['a']);
        expect(failed.element.isConnected).toBe(false);
        expect(board.element.querySelectorAll('.turn-row')).toHaveLength(1);
    });

    it('keeps exactly one processing row across an out-of-order terminal + start snapshot', () => {
        const { board } = mount();

        const runningA = turnRecord({
            id: 'a',
            index: 0,
            prompt: 'first',
            status: 'running',
            events: [start('writer')],
            updatedAt: T + 10
        });
        const queuedB = turnRecord({
            id: 'b',
            index: 1,
            prompt: 'second',
            status: 'queued',
            startedAt: undefined,
            updatedAt: T + 20,
            events: []
        });

        board.reconcile([runningA, queuedB]);
        expect(tileStatesOf(board)).toEqual(['streaming', 'queued']);

        // A settles and B starts in ONE snapshot: A must go grey (done) first,
        // so only B keeps the streaming state.
        const handles = board.reconcile([
            turnRecord({
                id: 'a',
                index: 0,
                prompt: 'first',
                status: 'done',
                startedAt: T,
                updatedAt: T + 30,
                events: [...runningA.events, { type: 'done', agent: 'writer', message: doneMessage('writer') }]
            }),
            turnRecord({
                id: 'b',
                index: 1,
                prompt: 'second',
                status: 'running',
                startedAt: T + 40,
                updatedAt: T + 45,
                events: [start('writer')]
            })
        ]);

        expect(handles.map((handle) => handle.id())).toEqual(['a', 'b']);
        expect(tileStatesOf(board)).toEqual(['done', 'streaming']);
        expect(tileStatesOf(board).filter((state) => state === 'streaming')).toHaveLength(1);
        // Chronological: the completed task sits ABOVE the running one.
        expect(
            [...board.element.querySelectorAll('.tile-prompt')].map((node) => node.textContent)
        ).toEqual(['first', 'second']);
    });
});

// Row states in DOM (chronological) order: what a reader actually sees, as
// opposed to `board.turns()`, which is the model.
const tileStatesOf = (board: ReturnType<typeof createTurnBoard>): (string | null)[] =>
    [...board.element.querySelectorAll<HTMLElement>('.tile')].map((tile) => tile.dataset.state);


// ---------------------------------------------------------------------------
//
// Live labels tick from the local clock; hydration uses the server's
// startedAt/updatedAt and eventTimes, and a rebuild must not reset them. A legacy
// record (no eventTimes) must show no tool duration rather than a fabricated one.

describe('elapsed timing', () => {
    const T = 1_700_000_000_000;

    const serverTurn = (overrides: Partial<SessionTurn> = {}): SessionTurn => ({
        id: 't1',
        index: 0,
        prompt: 'server prompt',
        status: 'done',
        startedAt: 1,
        updatedAt: 2,
        events: [],
        ...overrides
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('counts a live turn and freezes it when the turn settles', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(T));

        const { board } = mount();
        const turn = board.begin('live');
        const label = turn.element.querySelector<HTMLElement>('.tile-elapsed');

        // R4: a queued tile has no clock. It may wait behind another task for
        // minutes and must not be charged for that wait.
        expect(turn.elapsed()).toBe('');
        expect(label?.hidden).toBe(true);

        // The clock starts only when the server advances the task to running.
        turn.setState('streaming');
        expect(turn.elapsed()).toBe('0ms');
        expect(label?.hidden).toBe(false);

        vi.advanceTimersByTime(2500);
        expect(turn.elapsed()).toBe('2.5s');

        turn.setState('done');
        expect(turn.elapsed()).toBe('2.5s');

        // A settled tile stops counting; a stray interval would keep growing.
        vi.advanceTimersByTime(10_000);
        expect(turn.elapsed()).toBe('2.5s');
    });

    it('hydrates elapsed from the server span and keeps it across a rebuild', () => {
        const { board } = mount();
        const source = serverTurn({
            startedAt: T,
            updatedAt: T + 3600,
            events: [{ type: 'start', agent: 'writer', model: 'm1' }]
        });

        const [first] = board.hydrate([source], { model: 'm1' });
        expect(first.elapsed()).toBe('3.6s');

        // The same record re-rendered by a poll/snapshot: same duration, because
        // it comes from the record, not from "now".
        const [second] = board.hydrate([source], { model: 'm1', keep: 't1' });
        expect(second.elapsed()).toBe('3.6s');
        expect(second.elapsed()).toBe(first.elapsed());
    });

    it('matches tool results by callId and reads durations from eventTimes', () => {
        const { board } = mount();
        const [turn] = board.hydrate([
            serverTurn({
                startedAt: T,
                updatedAt: T + 2200,
                events: [
                    { type: 'start', agent: 'writer', model: 'm1' },
                    { type: 'tool_call', agent: 'writer', call: { id: 'c1', name: 'fileRead', arguments: '{"path":"a"}' } },
                    { type: 'tool_call', agent: 'writer', call: { id: 'c2', name: 'fileRead', arguments: '{"path":"b"}' } },
                    // Results arrive out of call order; the call id is the match.
                    { type: 'tool_result', agent: 'writer', name: 'fileRead', content: 'b', isError: false, callId: 'c2' },
                    { type: 'tool_result', agent: 'writer', name: 'fileRead', content: 'a', isError: false, callId: 'c1' },
                    { type: 'done', agent: 'writer', message: doneMessage('writer') }
                ],
                eventTimes: [T, T + 100, T + 500, T + 900, T + 1500, T + 2200]
            } as SessionTurn)
        ]);

        expect(
            [...turn.element.querySelectorAll<HTMLElement>('.tool-duration')].map((node) => node.textContent)
        ).toEqual(['1.4s', '400ms']);
    });

    it('leaves legacy records without a fabricated tool duration', () => {
        const { board } = mount();
        const [turn] = board.hydrate([
            serverTurn({
                startedAt: T,
                updatedAt: T + 1000,
                events: [
                    { type: 'start', agent: 'writer', model: 'm1' },
                    { type: 'tool_call', agent: 'writer', call: { id: 'c1', name: 'fileRead', arguments: '{}' } },
                    { type: 'tool_result', agent: 'writer', name: 'fileRead', content: 'ok', isError: false }
                ]
            })
        ]);

        expect(turn.elapsed()).toBe('1.0s');
        expect(turn.element.querySelector<HTMLElement>('.tool-duration')?.textContent).toBe('');
        expect(turn.element.querySelector<HTMLElement>('.tool-duration')?.hidden).toBe(true);
        expect(turn.element.textContent ?? '').not.toContain('NaN');
    });

    it('uses the server clock carried on a live event for a tool duration', () => {
        const { board } = mount();
        const turn = board.begin('live call');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' }, T);
        turn.apply(
            { type: 'tool_call', agent: 'writer', call: { id: 'c1', name: 'fileRead', arguments: '{}' } },
            T
        );
        turn.apply(
            { type: 'tool_result', agent: 'writer', name: 'fileRead', content: 'ok', isError: false },
            T + 750
        );

        expect(turn.element.querySelector('.tool-duration')?.textContent).toBe('750ms');
    });

    // Consecutive calls must read as one compact row. jsdom cannot compute the
    // flex layout, so the DOM contract is the group boundary: calls between two
    // prose/reasoning blocks share one `.tool-group`, and every card stays a
    // direct child of that group (never a direct child of `.agent-flow`).
    it('puts consecutive tool calls in one wrapping group', () => {
        const { board } = mount();
        const turn = board.begin('two calls');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply({ type: 'tool_call', agent: 'writer', call: { id: 'c1', name: 'fileRead', arguments: '{"path":"a"}' } });
        turn.apply({ type: 'tool_call', agent: 'writer', call: { id: 'c2', name: 'websearch', arguments: '{"query":"x"}' } });

        const groups = [...turn.element.querySelectorAll('.agent-flow > .tool-group')];
        expect(groups).toHaveLength(1);
        expect([...groups[0].children].map((child) => child.className)).toEqual(['tool', 'tool']);
        expect([...groups[0].querySelectorAll('.tool-name')].map((node) => node.textContent)).toEqual([
            'fileRead',
            'websearch'
        ]);
        // No card escaped the group into the flow column.
        expect(turn.element.querySelectorAll('.agent-flow > details.tool')).toHaveLength(0);
    });

    it('starts a new group after prose and resolves calls in place', () => {
        const { board } = mount();
        const turn = board.begin('mixed flow');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply({ type: 'tool_call', agent: 'writer', call: { id: 'c1', name: 'fileRead', arguments: '{}' } });
        turn.apply({ type: 'text', agent: 'writer', delta: 'checking more' });
        turn.apply({ type: 'tool_call', agent: 'writer', call: { id: 'c2', name: 'commandRun', arguments: '{}' } });
        turn.apply({ type: 'tool_result', agent: 'writer', name: 'fileRead', content: '{"ok":true}', isError: false });

        const flowChildren = [...(turn.element.querySelector('.agent-flow')?.children ?? [])].map(
            (child) => child.className
        );
        // tool row → prose → tool row; the resolved card stays in the first row.
        expect(flowChildren).toEqual(['tool-group', 'markdown agent-text', 'tool-group']);

        const first = turn.element.querySelector<HTMLDetailsElement>('.tool-group > details.tool');
        expect(first?.getAttribute('data-state')).toBe('ok');
        expect(first?.querySelector('.tool-result code')?.textContent).toBe('{\n  "ok": true\n}');
        expect(turn.element.querySelectorAll('.agent-flow > details.tool')).toHaveLength(0);
    });

    it('replays the same grouping from a recorded turn', () => {
        const { board } = mount();
        const [turn] = board.hydrate([
            serverTurn({
                events: [
                    { type: 'start', agent: 'writer', model: 'm1' },
                    { type: 'tool_call', agent: 'writer', call: { id: 'c1', name: 'websearch', arguments: '{}' } },
                    { type: 'tool_call', agent: 'writer', call: { id: 'c2', name: 'websearch', arguments: '{}' } },
                    { type: 'reasoning', agent: 'writer', delta: 'thinking' },
                    { type: 'tool_call', agent: 'writer', call: { id: 'c3', name: 'fileRead', arguments: '{}' } }
                ]
            })
        ]);

        const groups = [...turn.element.querySelectorAll('.agent-flow > .tool-group')];
        expect(groups.map((group) => group.querySelectorAll('details.tool').length)).toEqual([2, 1]);
        expect(groups[1].querySelector('.tool-name')?.textContent).toBe('fileRead');
    });
});

// ---------------------------------------------------------------------------
// Token tally (W4)
// ---------------------------------------------------------------------------
//
// The header prints TWO deliberately different scopes next to the elapsed label:
// `#1  2m 29s | 150 (140)   [done]`.
//   - primary: the LATEST model request's input/context size (provider
//     `prompt_tokens`, including that request's cached subset);
//   - bracket: total cached (replayed) input sent across the whole turn.
// The title spells the scopes out. The tile derives the primary from the last
// `usage` event in emission order (deterministic for a multi-agent stream) and
// takes the bracket from the server's cumulative `SessionTurn.usage.cached`,
// falling back to the per-event cache sum only when a legacy record has no tally.
// A record with neither events nor tally shows nothing. The `|` is CSS decoration.

describe('token tally', () => {
    const serverTurn = (overrides: Partial<SessionTurn> = {}): SessionTurn => ({
        id: 't1',
        index: 0,
        prompt: 'server prompt',
        status: 'done',
        startedAt: 1,
        updatedAt: 2,
        events: [],
        ...overrides
    });

    // One request's reported usage. Output is non-zero on purpose: the row must
    // never include it, and this makes an accidental `total` read visible.
    const usageEvent = (agent: string, input: number, cached?: number, output = 0): HarnessEvent => ({
        type: 'usage',
        agent,
        usage: { input, output, total: input + output, ...(cached === undefined ? {} : { cached }) }
    });

    // The four header spans, in DOM order. `tile-tokens` sits between the elapsed
    // label and the status badge.
    const topClasses = (turn: { element: HTMLElement }): (string | null)[] =>
        [...(turn.element.querySelector('.tile-top')?.children ?? [])].map((child) => child.className);

    it('starts hidden and empty on a fresh optimistic tile', () => {
        const { board } = mount();
        const turn = board.begin('no usage yet');
        const label = turn.element.querySelector<HTMLElement>('.tile-tokens');

        // Nothing has reported usage, so the label claims nothing rather than "0".
        expect(turn.tokens()).toBe('');
        expect(label?.textContent).toBe('');
        expect(label?.hidden).toBe(true);
        expect(label?.hasAttribute('title')).toBe(false);
    });

    it('shows the latest request context with the cumulative cache, not the summed input', () => {
        const { board } = mount();
        const turn = board.begin('two requests');

        // Request 1 { input 100, cached 40, output 7 }.
        turn.apply(usageEvent('writer', 100, 40, 7));
        turn.setUsage({ input: 100, output: 7, total: 107, cached: 40 });
        expect(turn.tokens()).toBe('100 (40)');

        // Request 2 { input 150, cached 100, output 9 }; the server tally now sums
        // both requests (input 250, cached 140). The row must read 150 (140):
        //   NOT 250 (140) — the summed/re-sent transcript input;
        //   NOT 110 (140) — the latest context minus the cache.
        turn.apply(usageEvent('writer', 150, 100, 9));
        turn.setUsage({ input: 250, output: 16, total: 266, cached: 140 });

        const label = turn.element.querySelector<HTMLElement>('.tile-tokens');
        expect(turn.tokens()).toBe('150 (140)');
        expect(label?.textContent).toBe('150 (140)');
        expect(label?.hidden).toBe(false);
        // The accessible description names both scopes, so the mixed scopes cannot
        // be mistaken for the same unit.
        expect(label?.title).toBe(
            'Latest request context: 150 input tokens · Total cached input sent: 140 tokens'
        );
        expect(topClasses(turn)).toEqual(['tile-index', 'tile-elapsed', 'tile-tokens', 'tile-status']);
    });

    it('falls back to the cumulative input only when no usage event was recorded', () => {
        const { board } = mount();
        const turn = board.begin('legacy tally');

        // A legacy/hand-built record can carry the server tally with no events. The
        // latest request is then unknowable, so the cumulative input is the
        // conservative (never understated) fallback; the cache bracket still applies.
        turn.setUsage({ input: 122111, output: 4, total: 5, cached: 100301 });

        expect(turn.tokens()).toBe('122,111 (100,301)');
        // The title is honest about the fallback scope: this is not a latest-request
        // context, it is the only input total the record retained.
        expect(turn.element.querySelector<HTMLElement>('.tile-tokens')?.title).toBe(
            'Cumulative input (latest request not recorded): 122,111 input tokens · ' +
                'Total cached input sent: 100,301 tokens'
        );
    });

    it('hydrates the latest input and cumulative cache from a recorded turn', () => {
        const { board } = mount();

        const [turn] = board.hydrate([
            serverTurn({
                events: [
                    { type: 'start', agent: 'writer', model: 'm1' },
                    usageEvent('writer', 100, 40, 7),
                    { type: 'text', agent: 'writer', delta: 'first' },
                    usageEvent('writer', 150, 100, 9),
                    { type: 'text', agent: 'writer', delta: 'second' }
                ],
                usage: { input: 250, output: 16, total: 266, cached: 140 }
            })
        ]);

        // Same figure the live stream ended on: latest context, cumulative cache.
        expect(turn.tokens()).toBe('150 (140)');
        expect(turn.element.querySelector<HTMLElement>('.tile-tokens')?.hidden).toBe(false);
    });

    it('derives both figures from events when a legacy record has no tally', () => {
        const { board } = mount();

        const [turn] = board.hydrate([
            serverTurn({
                events: [
                    { type: 'start', agent: 'writer', model: 'm1' },
                    usageEvent('writer', 100, 40, 7),
                    usageEvent('writer', 150, 100, 9)
                ]
            })
        ]);

        expect(turn.tokens()).toBe('150 (140)');
    });

    it('keeps the latest reported input and accumulated cache for a cancelled run', () => {
        const { board } = mount();

        const [turn] = board.hydrate([
            serverTurn({
                status: 'cancelled',
                events: [
                    { type: 'start', agent: 'writer', model: 'm1' },
                    usageEvent('writer', 100, 40, 7),
                    { type: 'text', agent: 'writer', delta: 'partial' },
                    { type: 'error', agent: 'writer', error: { message: 'The run was aborted.' } }
                ],
                usage: { input: 100, output: 7, total: 107, cached: 40 }
            })
        ]);

        // The aborted request reported nothing: no fabricated 0, previous figures kept.
        expect(turn.tokens()).toBe('100 (40)');
    });

    it('uses the last usage event in emission order for a multi-agent turn', () => {
        const { board } = mount();

        const [turn] = board.hydrate([
            serverTurn({
                events: [
                    { type: 'start', agent: 'lead', model: 'm1' },
                    usageEvent('lead', 100, 40, 7),
                    { type: 'start', agent: 'helper', model: 'm1' },
                    usageEvent('helper', 150, 100, 9),
                    usageEvent('lead', 120, 50, 5)
                ]
            })
        ]);

        // Deterministic by stream order: the LAST reported request wins the
        // primary; the bracket sums every request's cache (40 + 100 + 50).
        expect(turn.tokens()).toBe('120 (190)');
    });

    it('omits the bracket when no request reported a cache figure', () => {
        const { board } = mount();
        const turn = board.begin('no cache');

        turn.apply(usageEvent('writer', 100));
        turn.setUsage({ input: 100, output: 7, total: 107 });

        // Unknown cache is not zero: no bracket, and the latest input still shows.
        expect(turn.tokens()).toBe('100');
    });

    it('hides the label when the tally is cleared and no event reported usage', () => {
        const { board } = mount();
        const turn = board.begin('cleared');

        turn.setUsage({ input: 122111, output: 4, total: 5, cached: 100301 });
        expect(turn.tokens()).toBe('122,111 (100,301)');

        turn.setUsage(undefined);

        const label = turn.element.querySelector<HTMLElement>('.tile-tokens');
        expect(turn.tokens()).toBe('');
        expect(label?.textContent).toBe('');
        expect(label?.hidden).toBe(true);
        expect(label?.hasAttribute('title')).toBe(false);
    });

    it('keeps an events-derived figure when a legacy record clears the tally', () => {
        const { board } = mount();
        const turn = board.begin('legacy events');

        turn.apply(usageEvent('writer', 100, 40, 7));
        expect(turn.tokens()).toBe('100 (40)');

        // Hydration of a record with events but no `usage` tally calls this; the
        // events are sufficient, so the figure must remain.
        turn.setUsage(undefined);
        expect(turn.tokens()).toBe('100 (40)');
    });

    it('is identical after a repeated upsert and a snapshot rebuild (no duplicates)', () => {
        const { board } = mount();
        const record = serverTurn({
            events: [
                { type: 'start', agent: 'writer', model: 'm1' },
                usageEvent('writer', 100, 40, 7),
                usageEvent('writer', 150, 100, 9)
            ],
            usage: { input: 250, output: 16, total: 266, cached: 140 }
        });

        const [first] = board.hydrate([record], { model: 'm1' });
        expect(first.tokens()).toBe('150 (140)');
        expect(first.applied()).toBe(3);

        // Re-applying the SAME record (poll/reconnect) and a fresh snapshot rebuild
        // must not add the usage events again, so neither figure doubles.
        first.merge(record, 'm1');
        expect(first.tokens()).toBe('150 (140)');
        expect(first.applied()).toBe(3);

        const [second] = board.hydrate([record], { model: 'm1', keep: 't1' });
        expect(second.tokens()).toBe('150 (140)');
        expect(second.applied()).toBe(3);
        expect(second.element.querySelector<HTMLElement>('.tile-tokens')?.hidden).toBe(false);
    });
});

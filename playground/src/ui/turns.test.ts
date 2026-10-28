// Turn-tile tests: the one-expanded-tile rule, streaming Markdown, tool pairing
// and subagent labelling. These pin the layout contract the UI depends on:
// newest tile open, older tiles compact, expansion never destroyed by stream
// deltas, and every event routed to the agent that emitted it.
//
// Run: npx vitest run --config playground/vitest.config.ts
import type { HarnessAssistantMessage, SessionTurn } from '../../../server/protocol';
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
});


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
// The header prints the SERVER's running tally next to the elapsed label:
// `#1  2m 29s | 122,111 (100,301)   [done]`. The separator is CSS decoration, so
// the span's text is exactly the formatted figure. The tile only ever prints a
// figure it was handed (a live frame's `usage` via setUsage, or a record's
// `SessionTurn.usage` on hydration) — it never sums `usage` events itself.

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
    });

    it('shows the server tally between the elapsed label and the status', () => {
        const { board } = mount();
        const turn = board.begin('tallied');

        turn.setUsage({ input: 122111, output: 4, total: 5, cached: 100301 });

        const label = turn.element.querySelector<HTMLElement>('.tile-tokens');
        // No pipe in the text: the `|` is styles.css decoration between the spans.
        expect(turn.tokens()).toBe('122,111 (100,301)');
        expect(label?.textContent).toBe('122,111 (100,301)');
        expect(label?.hidden).toBe(false);
        expect(topClasses(turn)).toEqual(['tile-index', 'tile-elapsed', 'tile-tokens', 'tile-status']);
    });

    it('hides the label again when the tally is cleared', () => {
        const { board } = mount();
        const turn = board.begin('cleared');

        turn.setUsage({ input: 122111, output: 4, total: 5, cached: 100301 });
        expect(turn.tokens()).toBe('122,111 (100,301)');

        turn.setUsage(undefined);

        const label = turn.element.querySelector<HTMLElement>('.tile-tokens');
        expect(turn.tokens()).toBe('');
        expect(label?.textContent).toBe('');
        expect(label?.hidden).toBe(true);
    });

    it('hydrates the recorded tally onto a replayed turn', () => {
        const { board } = mount();

        const [turn] = board.hydrate([
            serverTurn({ usage: { input: 292, output: 104, total: 396, cached: 168 } })
        ]);

        // formatTokens prints the INPUT count then the CACHED count, not totals.
        expect(turn.tokens()).toBe('292 (168)');
        expect(turn.element.querySelector<HTMLElement>('.tile-tokens')?.hidden).toBe(false);
    });

    it('leaves a hydrated turn without a usage record empty', () => {
        const { board } = mount();

        const [turn] = board.hydrate([serverTurn({ events: [{ type: 'start', agent: 'writer', model: 'm1' }] })]);

        // Absent usage is unknown, not a zero-spend turn.
        expect(turn.tokens()).toBe('');
        expect(turn.element.querySelector<HTMLElement>('.tile-tokens')?.hidden).toBe(true);
    });

    it('does not tally usage events itself when replaying a record', () => {
        const { board } = mount();

        const [turn] = board.hydrate([
            serverTurn({
                events: [
                    { type: 'start', agent: 'writer', model: 'm1' },
                    {
                        type: 'usage',
                        agent: 'writer',
                        usage: { input: 122111, output: 4, total: 5, cached: 100301 }
                    },
                    { type: 'text', agent: 'writer', delta: 'answer' }
                ]
            })
        ]);

        // The record carries no `usage` tally, so the header stays clean: two
        // accumulators (events here, server there) would disagree on a re-render.
        expect(turn.tokens()).toBe('');
        expect(turn.element.querySelector<HTMLElement>('.tile-tokens')?.hidden).toBe(true);
    });

    it('does not tally a live usage event applied through apply()', () => {
        const { board } = mount();
        const turn = board.begin('live usage');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply({
            type: 'usage',
            agent: 'writer',
            usage: { input: 122111, output: 4, total: 5, cached: 100301 }
        });

        // The server's own tally on the frame (setUsage) is authoritative; the
        // event alone changes nothing.
        expect(turn.tokens()).toBe('');
        expect(turn.element.querySelector<HTMLElement>('.tile-tokens')?.hidden).toBe(true);
    });

    it('keeps the tally across a snapshot rebuild', () => {
        const { board } = mount();
        const record = serverTurn({
            usage: { input: 122111, output: 4, total: 5, cached: 100301 },
            events: [{ type: 'start', agent: 'writer', model: 'm1' }]
        });

        const [first] = board.hydrate([record], { model: 'm1' });
        expect(first.tokens()).toBe('122,111 (100,301)');

        const [second] = board.hydrate([record], { model: 'm1', keep: 't1' });
        expect(second.tokens()).toBe('122,111 (100,301)');
        expect(second.tokens()).toBe(first.tokens());
        expect(second.element.querySelector<HTMLElement>('.tile-tokens')?.hidden).toBe(false);
    });
});


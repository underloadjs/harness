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
            call: { id: 'c1', name: 'readFile', arguments: '{"path":"package.json"}' }
        });

        const tool = turn.element.querySelector('details.tool');
        expect(tool?.getAttribute('data-state')).toBe('running');
        expect(turn.summary()).toEqual({ agents: 1, tools: 1, primary: 'writer' });

        turn.apply({
            type: 'tool_result',
            agent: 'writer',
            name: 'readFile',
            content: '{"ok":true}',
            isError: false
        });

        expect(tool?.getAttribute('data-state')).toBe('ok');
        expect(turn.element.querySelectorAll('details.tool')).toHaveLength(1);
        expect(turn.element.querySelector('.tool-state')?.textContent).toBe('ok');
    });

    it('labels a delegated agent as a subagent and keeps the tile open until the stream ends', () => {
        const { board } = mount();
        const turn = board.begin('delegate');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply({ type: 'tool_call', agent: 'writer', call: { id: 'd1', name: 'delegate', arguments: '{}' } });
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
                    { type: 'tool_call', agent: 'writer', call: { id: 'c1', name: 'readFile', arguments: '{}' } },
                    { type: 'tool_result', agent: 'writer', name: 'readFile', content: '{"ok":true}', isError: false },
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
        expect(turn.element.querySelector('.tile-meta')?.textContent).toBe('1 agent · 1 tool call · m1 · done');
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
        expect(handles[1].element.querySelector('.tile-meta')?.textContent).toBe('1 agent · m1 · error');
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
                    { type: 'tool_call', agent: 'writer', call: { id: 'd1', name: 'delegate', arguments: '{}' } },
                    { type: 'start', agent: 'helper', model: 'm2' },
                    { type: 'text', agent: 'helper', delta: 'delegated' },
                    { type: 'done', agent: 'helper', message: doneMessage('helper') },
                    { type: 'tool_result', agent: 'writer', name: 'delegate', content: 'done', isError: false }
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


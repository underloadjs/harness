// Turn-tile tests: the one-expanded-tile rule, streaming Markdown, tool pairing
// and subagent labelling. These pin the layout contract the UI depends on:
// newest tile open, older tiles compact, expansion never destroyed by stream
// deltas, and every event routed to the agent that emitted it.
//
// REASONING is an inline CHIP, not a block: one `details.tool.think` per model
// REQUEST, appended INTO the agent's `.tool-group` row (ui/turns.ts
// `appendReasoning` + ui/tools.ts `createReasoningCard`), so `[read][think][search]`
// is ONE wrapping row. Because the chip IS a `details.tool`, every TOOL-CALL
// assertion here selects `details.tool:not(.think)` and every REASONING assertion
// selects `.tool.think` / `.think .tool-name` / `.think .reasoning`. Its pill
// (`.think-count`) is a SHARE of the block's accumulated context — the figure the
// header tally prints (`BlockMeta.context()`), repainted on every `usage` event —
// never a character count; see the `inline reasoning chips (think)` section below.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts
import type { HarnessAssistantMessage, HarnessEvent, SessionTurn } from '../../server/protocol';
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
        // R3: the header has NO `#ordinal` — the server position is not displayed.
        expect(turn.element.querySelector('.tile-index')).toBeNull();
        // R1/F3: the root code is not claimed before an event names the agent.
        expect(turn.element.querySelector<HTMLElement>('.tile-agent')?.hidden).toBe(true);
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

        // R2/R3: the main block names its agent by the compact code (first + last
        // letter + occurrence), never by the raw agent id. R1/F3: the code lives in
        // the COMPACT header, in the same slot a child block uses.
        expect(turn.element.querySelector('.agent-name')?.textContent).toBe('WR1');
        expect(turn.element.querySelector<HTMLElement>('.tile-agent')?.textContent).toBe('WR1');
        expect(turn.element.querySelector<HTMLElement>('.tile-agent')?.hidden).toBe(false);
        expect(turn.element.textContent).not.toContain('writer');

        turn.apply({ type: 'text', agent: 'writer', delta: '# Hi\n\n' });
        turn.apply({ type: 'text', agent: 'writer', delta: 'a **b**' });
        turn.flush();

        expect(turn.element.querySelector('.agent-text')?.innerHTML).toBe(
            '<h1>Hi</h1>\n<p>a <strong>b</strong></p>\n'
        );
        // R5: the block footer is no longer a metadata line — the model / stop reason
        // / token figures belong to the block HEADER. And this answer never COMPLETED
        // (no `done`, no `attempt_commit`), so the footer has no Copy action yet: a
        // streaming partial is never presented as the final answer. The ROOT block does
        // own one control from birth: the Collapse/Expand toggle for the conversation
        // (`.tile-body`), which is why the row is no longer childless.
        expect(turn.element.querySelectorAll('.agent-meta')).toHaveLength(0);
        expect(
            [...(turn.element.querySelector('.agent-answer-actions')?.children ?? [])].map(
                (node) => node.className
            )
        ).toEqual(['answer-collapse']);
        expect(turn.element.querySelector('.answer-copy')).toBeNull();
        expect(turn.element.querySelector('.tile-meta')?.textContent).toBe('1 agent');
    });

    it('pairs a tool call with its result inside the agent flow', () => {
        const { board } = mount();
        const turn = board.begin('run it');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply({
            type: 'tool_call',
            agent: 'writer',
            call: { id: 'c1', name: 'read', arguments: '{"path":"package.json"}' }
        });

        const tool = turn.element.querySelector('details.tool');
        expect(tool?.getAttribute('data-state')).toBe('running');
        expect(turn.summary()).toEqual({ agents: 1, tools: 1, primary: 'writer' });

        turn.apply({
            type: 'tool_result',
            agent: 'writer',
            name: 'read',
            content: '{"ok":true}',
            isError: false
        });

        expect(tool?.getAttribute('data-state')).toBe('ok');
        expect(turn.element.querySelectorAll('details.tool')).toHaveLength(1);
        expect(turn.element.querySelector('.tool-state')?.textContent).toBe('ok');
    });

    it('colours a delegated agent block and keeps the tile open until the stream ends', () => {
        const { board } = mount();
        const turn = board.begin('delegate');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply({ type: 'tool_call', agent: 'writer', call: { id: 'd1', name: 'delegate', arguments: '{}' } });
        turn.apply({ type: 'start', agent: 'helper', model: 'm2' });
        turn.apply({ type: 'text', agent: 'helper', delta: 'done' });

        // R3: a delegated agent is NOT labelled; it is an agent section like any
        // other, told apart by nesting and its own colour (see the assertion below).
        const agents = [...turn.element.querySelectorAll('.agent')];
        expect(agents.map((agent) => agent.getAttribute('data-agent'))).toEqual(['writer', 'helper']);
        expect(agents.map((agent) => agent.getAttribute('data-role'))).toEqual(['primary', 'subagent']);
        // R3: no visible role badge — the nesting plus the agent colour say who
        // owns the block. `data-role` above is the structural attribute only.
        expect(agents[1]?.querySelector('.agent-role')).toBeNull();
        expect(turn.element.querySelectorAll('.agent-role, .thread-role')).toHaveLength(0);
        // Each section carries its own agent colour (name colour + outline var).
        // `writer`/`helper` are not built-in profile ids, so they use the palette
        // hash: writer → violet (slot 2), helper → teal (slot 5).
        expect(agents.map((agent) => agent.style.getPropertyValue('--agent-color'))).toEqual([
            '#a78bfa',
            '#2dd4bf'
        ]);

        // `done` closes the agent turn, not the user turn: the primary still has
        // to return from its tool call.
        turn.apply({ type: 'done', agent: 'helper', message: doneMessage('helper') });
        expect(turn.state()).toBe('streaming');
        // R5: the child block's footer no longer repeats `helper-model · stop`. It
        // carries the Copy action for that block's own completed answer instead, and
        // the button is an icon control (no visible word at idle).
        expect(agents[1]?.querySelectorAll('.agent-meta')).toHaveLength(0);
        const helperCopy = agents[1]?.querySelector<HTMLButtonElement>('.agent-answer-actions .answer-copy');
        expect(helperCopy?.getAttribute('aria-label')).toBe('Copy the final answer');
        expect(helperCopy?.textContent).toBe('');
        // The root block streamed nothing, so its footer stays empty (no action).
        expect(agents[0]?.querySelector('.answer-copy')).toBeNull();

        turn.setState('done', 'm1 · idle');
        expect(turn.state()).toBe('done');
        expect(turn.element.dataset.state).toBe('done');
        expect(turn.element.querySelector('.tile-status-text')?.textContent).toBe('done');
        expect(turn.element.querySelector('.tile-meta')?.textContent).toBe('2 agents · 1 tool call · m1 · idle');
    });

    it('paints the main block with its agent colour and keeps an unnamed tile neutral', () => {
        const { board } = mount();
        const turn = board.begin('colour identity');

        // Before any event names an agent the tile is NOT painted: the `:root`
        // fallback in styles.css supplies the neutral tone, so the tile cannot
        // borrow palette slot 0 and imply an identity it does not know yet.
        expect(turn.element.hasAttribute('data-agent')).toBe(false);
        expect(turn.element.style.getPropertyValue('--agent-color')).toBe('');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        // R3: the main block is agent-owned exactly like a nested block. `writer` is
        // not a built-in profile id, so it takes the palette hash (violet, slot 2).
        expect(turn.element.dataset.agent).toBe('writer');
        expect(turn.element.style.getPropertyValue('--agent-color')).toBe('#a78bfa');
        expect(turn.element.style.getPropertyValue('--agent-line')).toBe('rgba(167, 139, 250, 0.6)');

        // A different primary agent gets a different, deterministic tone.
        const other = board.begin('second');
        other.apply({ type: 'start', agent: 'researcher', model: 'm1' });
        expect(other.element.dataset.agent).toBe('researcher');
        expect(other.element.style.getPropertyValue('--agent-line')).toBe('rgba(244, 114, 182, 0.6)');
    });

    it('keeps an unattributable placeholder agent neutral on both the tile and its section', () => {
        const { board } = mount();
        const turn = board.begin('orphan result');

        // A result-only legacy frame with no start and no tool_call: the UI cannot
        // name an agent, so it renders the `unknown` placeholder section. The tile and
        // that section must agree on the SAME neutral tone (before the correction the
        // section hashed the literal 'unknown' to cyan while the tile stayed neutral).
        turn.apply({ type: 'tool_result', agent: 'ghost', name: 'read', content: 'ok', isError: false });

        const agent = turn.element.querySelector<HTMLElement>('.agent');
        expect(agent?.dataset.agent).toBeUndefined();
        expect(agent?.dataset.role).toBe('primary');
        expect(agent?.style.getPropertyValue('--agent-color')).toBe('#8b94a7');
        expect(agent?.style.getPropertyValue('--agent-line')).toBe('rgba(139, 148, 167, 0.55)');

        // The tile: same neutral tone, and no `data-agent` identity at all.
        expect(turn.element.style.getPropertyValue('--agent-color')).toBe('#8b94a7');
        expect(turn.element.style.getPropertyValue('--agent-line')).toBe('rgba(139, 148, 167, 0.55)');
        expect(turn.element.hasAttribute('data-agent')).toBe(false);
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

        // A new conversation starts with a fresh tile that still shows no ordinal.
        const again = board.begin('again');
        expect(again.element.querySelector('.tile-index')).toBeNull();
        expect(board.turns()).toEqual([again]);
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

    it('binds the server id while keeping the protocol index unrendered', () => {
        const { board } = mount();
        const turn = board.begin('optimistic');

        expect(turn.id()).toBeUndefined();
        expect(turn.element.dataset.turnId).toBeUndefined();

        // The server `index` (0-based) is retained for ordering/identity but R3
        // removed its visible `#position` label from the header.
        turn.bind({ id: 'server-7', index: 4 });

        expect(turn.id()).toBe('server-7');
        expect(turn.element.dataset.turnId).toBe('server-7');
        expect(turn.element.querySelector('.tile-index')).toBeNull();
        expect(board.find('server-7')).toBe(turn);
        expect(board.find('other')).toBeUndefined();
    });

    it('adopts a recorded turn by replaying its events and settling its status', () => {
        const { board, empty } = mount();

        const turn = board.adopt(
            serverTurn({
                events: [
                    { type: 'start', agent: 'writer', model: 'm1' },
                    { type: 'tool_call', agent: 'writer', call: { id: 'c1', name: 'read', arguments: '{}' } },
                    { type: 'tool_result', agent: 'writer', name: 'read', content: '{"ok":true}', isError: false },
                    { type: 'text', agent: 'writer', delta: 'recorded **prose**' },
                    { type: 'done', agent: 'writer', message: doneMessage('writer') }
                ]
            }),
            'm1'
        );

        expect(turn.state()).toBe('done');
        expect(turn.id()).toBe('t1');
        expect(turn.element.dataset.state).toBe('done');
        expect(turn.element.querySelector('.tile-index')).toBeNull();
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
        // R3: server order is the DOM order; no ordinal text is rendered.
        expect(turnPrompts(board)).toEqual(['first', 'second']);
        expect(handles.map((handle) => handle.element.querySelector('.tile-index'))).toEqual([null, null]);
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

// Helper shared by the server-turn cases: reads the tiles' prompts in DOM order.
// It replaced the old `#index` label reader: order is now proven by the rendered
// rows themselves, because the ordinal is no longer displayed (R3).
const turnPrompts = (board: ReturnType<typeof createTurnBoard>): string[] =>
    [...board.element.querySelectorAll<HTMLElement>('.tile')].map((node) => {
        const prompt = node.querySelector<HTMLElement>('.tile-prompt');
        return prompt?.textContent ?? '';
    });

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
    // src/server/sessions.ts `enqueue` publishes the queued `turn` upsert BEFORE it
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
        // Submission order is the rendered row order; the ordinal itself is gone.
        expect(turnPrompts(board)).toEqual(['first', 'second']);
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
                    { type: 'tool_call', agent: 'writer', call: { id: 'c1', name: 'read', arguments: '{"path":"a"}' } },
                    { type: 'tool_call', agent: 'writer', call: { id: 'c2', name: 'read', arguments: '{"path":"b"}' } },
                    // Results arrive out of call order; the call id is the match.
                    { type: 'tool_result', agent: 'writer', name: 'read', content: 'b', isError: false, callId: 'c2' },
                    { type: 'tool_result', agent: 'writer', name: 'read', content: 'a', isError: false, callId: 'c1' },
                    { type: 'done', agent: 'writer', message: doneMessage('writer') }
                ],
                eventTimes: [T, T + 100, T + 500, T + 900, T + 1500, T + 2200]
            } as SessionTurn)
        ]);

        expect(
            [...turn.element.querySelectorAll<HTMLElement>('.tool-duration')].map((node) => node.textContent)
        ).toEqual(['1.4s', '0.4s']);
    });

    it('leaves legacy records without a fabricated tool duration', () => {
        const { board } = mount();
        const [turn] = board.hydrate([
            serverTurn({
                startedAt: T,
                updatedAt: T + 1000,
                events: [
                    { type: 'start', agent: 'writer', model: 'm1' },
                    { type: 'tool_call', agent: 'writer', call: { id: 'c1', name: 'read', arguments: '{}' } },
                    { type: 'tool_result', agent: 'writer', name: 'read', content: 'ok', isError: false }
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
            { type: 'tool_call', agent: 'writer', call: { id: 'c1', name: 'read', arguments: '{}' } },
            T
        );
        turn.apply(
            { type: 'tool_result', agent: 'writer', name: 'read', content: 'ok', isError: false },
            T + 750
        );

        expect(turn.element.querySelector('.tool-duration')?.textContent).toBe('0.8s');
    });

    // Consecutive calls must read as one compact row. jsdom cannot compute the
    // flex layout, so the DOM contract is the group boundary: calls between two
    // prose blocks share one `.tool-group`, and every card stays a direct child of
    // that group (never a direct child of `.agent-flow`). A reasoning round joins the
    // same group as an inline `think` chip instead of breaking the row.
    it('puts consecutive tool calls in one wrapping group', () => {
        const { board } = mount();
        const turn = board.begin('two calls');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply({ type: 'tool_call', agent: 'writer', call: { id: 'c1', name: 'read', arguments: '{"path":"a"}' } });
        turn.apply({ type: 'tool_call', agent: 'writer', call: { id: 'c2', name: 'websearch', arguments: '{"query":"x"}' } });

        const groups = [...turn.element.querySelectorAll('.agent-flow > .tool-group')];
        expect(groups).toHaveLength(1);
        expect([...groups[0].children].map((child) => child.className)).toEqual(['tool', 'tool']);
        expect([...groups[0].querySelectorAll('.tool-name')].map((node) => node.textContent)).toEqual([
            'read',
            'websearch'
        ]);
        // No card escaped the group into the flow column.
        expect(turn.element.querySelectorAll('.agent-flow > details.tool')).toHaveLength(0);
    });

    it('starts a new group after prose and resolves calls in place', () => {
        const { board } = mount();
        const turn = board.begin('mixed flow');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply({ type: 'tool_call', agent: 'writer', call: { id: 'c1', name: 'read', arguments: '{}' } });
        turn.apply({ type: 'text', agent: 'writer', delta: 'checking more' });
        turn.apply({ type: 'tool_call', agent: 'writer', call: { id: 'c2', name: 'shell', arguments: '{}' } });
        turn.apply({ type: 'tool_result', agent: 'writer', name: 'read', content: '{"ok":true}', isError: false });

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
                    { type: 'tool_call', agent: 'writer', call: { id: 'c3', name: 'read', arguments: '{}' } }
                ]
            })
        ]);

        // R1/the think chip: a recorded reasoning round joins the row instead of
        // breaking it, so the whole batch replays as ONE row — three call chips plus the
        // chip for that request's thinking, in event order.
        const groups = [...turn.element.querySelectorAll('.agent-flow > .tool-group')];
        expect(groups).toHaveLength(1);
        expect(groups[0].querySelectorAll('details.tool').length).toBe(4);
        expect([...groups[0].querySelectorAll('.tool-name')].map((node) => node.textContent)).toEqual([
            'websearch',
            'websearch',
            'think',
            'read'
        ]);
        // The call tally excludes the chip, and the round's text is inside the chip.
        expect(groups[0].querySelectorAll('details.tool:not(.think)').length).toBe(3);
        expect(turn.element.querySelectorAll('.agent-flow > .thinking')).toHaveLength(0);
        expect(turn.element.querySelector('.tool.think .reasoning')?.textContent).toBe('thinking');
    });
});

// ---------------------------------------------------------------------------
// Token tally (W4)
// ---------------------------------------------------------------------------
//
// The header prints TWO deliberately different scopes next to the elapsed label:
// `2m29s | 150 (140)   [done]` (R3 removed the old `#position` label; R4 is the
// compact, unspaced duration).
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

    // The MEASUREMENT spans, in DOM order: `tile-tokens` follows the elapsed label, and
    // R3 puts the state box LAST — the state measures this block, it is not part of the
    // conversation's identity. T2 clips that box's word to screen-reader-only, so the
    // VISIBLE line is `34.2s | 18,654 (37,376)`; the text node stays for assistive tech
    // and the line's colour is the state. The persistent-thread badge stays identity
    // (`.tile-identity`, asserted below and in turns-threads.test.ts).
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
        // R1: the persistent-thread badge LEADS the header (identity before
        // measurements) and stays hidden (but present) for a turn with no runtime
        // thread identity. R3: the state word closes the measurement line, and the badge
        // line is the badge ALONE — the line the header Delete control is centred on.
        expect(topClasses(turn)).toEqual(['tile-elapsed', 'tile-tokens', 'tile-status']);
        expect(turn.element.querySelector('.tile-select')?.firstElementChild?.className).toBe('tile-identity');
        expect(
            [...(turn.element.querySelectorAll<HTMLElement>('.tile-identity > *') ?? [])].map(
                (child) => child.className
            )
        ).toEqual(['tile-thread']);
        expect(turn.element.querySelector('.tile-identity .tile-status-text')).toBeNull();
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

// --- Concurrent/background tools (R6) ---------------------------------------
//
// Tools are scheduled concurrently, so a tile can show one finished call while
// others are still running and can receive an agent response while its own calls
// are in flight. These tests pin the three additive wire fields and the rules the
// presentation must keep:
//   - `durationMs` wins over the browser's frame gap;
//   - a `pending` array updates the line but never resolves/abandons a card, and a
//     settled call is pruned from it even when the frame omits `pending`;
//   - `done` with pending is an interim response, not the end of the turn;
//   - `wakeup` is visible, keeps cards running, and does not settle the tile; a
//     wake without its required `pending` list is ignored;
//   - a terminal turn abandons calls that never returned (interrupted, not resumed),
//     and duplicate/late results never add a second card.
// The event helpers cast a `Record<string, unknown>` so a test can express one
// wire frame without restating every required field; the union itself is canonical.
describe('background tools (R6)', () => {
    const start = (): HarnessEvent => ({ type: 'start', agent: 'writer', model: 'm1' });

    const call = (id: string, name = 'read'): HarnessEvent => ({
        type: 'tool_call',
        agent: 'writer',
        call: { id, name, arguments: '{}' }
    });

    const result = (fields: Record<string, unknown> = {}): HarnessEvent =>
        ({
            type: 'tool_result',
            agent: 'writer',
            name: 'read',
            callId: 'c1',
            content: 'ok',
            isError: false,
            ...fields
        }) as unknown as HarnessEvent;

    const responseDone = (fields: Record<string, unknown> = {}): HarnessEvent =>
        ({
            type: 'done',
            agent: 'writer',
            message: doneMessage('writer'),
            ...fields
        }) as unknown as HarnessEvent;

    const wake = (fields: Record<string, unknown> = {}): HarnessEvent =>
        ({
            type: 'wakeup',
            agent: 'writer',
            reason: 'pending-tools',
            pending: [],
            ...fields
        }) as unknown as HarnessEvent;

    const card = (turn: { element: HTMLElement }): Element | null =>
        turn.element.querySelector('details.tool');

    it('prints the authoritative server duration instead of the browser gap', () => {
        const { board } = mount();
        const turn = board.begin('timed');

        turn.apply(start());
        turn.apply(call('c1'));
        // A recorded replay has no frame stamps: only `durationMs` can supply a span.
        turn.apply(result({ durationMs: 1250 }), undefined, 'recorded');

        expect(card(turn)?.getAttribute('data-state')).toBe('ok');
        expect(turn.element.querySelector('.tool-duration')?.textContent).toBe('1.3s');
    });

    it('shows calls the server still has in flight, with their elapsed spans', () => {
        const { board } = mount();
        const turn = board.begin('two calls');

        turn.apply(start());
        turn.apply(call('c1'));
        turn.apply(call('c2', 'search'));

        // c1 finished; the server reports c2 still running.
        turn.apply(
            result({ durationMs: 300, pending: [{ callId: 'c2', name: 'search', elapsedMs: 900 }] }),
            undefined,
            'recorded'
        );

        expect(turn.element.querySelector('.agent-pending')?.textContent).toBe(
            'pending · search 900ms'
        );
        expect(turn.element.querySelector('.tile-meta')?.textContent).toBe(
            '1 agent · 2 tool calls · 1 tool still running'
        );

        // A present-but-empty array means the server has nothing running: the line
        // goes away. (The cards are untouched either way.)
        turn.apply(result({ callId: 'c2', content: 'done', pending: [] }), undefined, 'recorded');
        expect(turn.element.querySelector('.agent-pending')).toBeNull();
        expect(turn.element.querySelector('.tile-meta')?.textContent).toBe('1 agent · 2 tool calls');
    });

    it('keeps pending cards alive across an interim done and keeps the tile running', () => {
        const { board } = mount();
        const turn = board.begin('interim');

        turn.apply(start());
        turn.apply(call('c1'));
        turn.apply(
            responseDone({ pending: [{ callId: 'c1', name: 'read', elapsedMs: 1200 }] })
        );

        // The response is complete, the turn is not: the card still runs and the
        // snapshot list names it with the server's span.
        expect(turn.state()).toBe('streaming');
        expect(card(turn)?.getAttribute('data-state')).toBe('running');
        expect(turn.element.querySelector('.agent-pending')?.textContent).toBe('pending · read 1.2s');
        // R5: the completed response no longer prints `writer-model · stop · 1 tool
        // still running` under the block. The footer is the answer action row, and the
        // still-running fact stays where it belongs: the section's `pending ·` line
        // above and the tile header's meta count below.
        expect(turn.element.querySelectorAll('.agent-meta')).toHaveLength(0);
        expect(turn.element.querySelector('.agent-answer-actions')?.textContent).toBe('');
        expect(
            turn.element.querySelector<HTMLButtonElement>('.agent-answer-actions .answer-copy')?.title
        ).toBe('Copy the final answer');
        expect(turn.element.querySelector('.tile-meta')?.textContent).toBe(
            '1 agent · 1 tool call · 1 tool still running'
        );
    });

    it('marks a wakeup and never resolves the running call it woke for', () => {
        const { board } = mount();
        const turn = board.begin('woken');

        turn.apply(start());
        turn.apply(call('c1'));
        turn.apply(
            responseDone({ pending: [{ callId: 'c1', name: 'read', elapsedMs: 1200 }] })
        );

        turn.apply(wake({ pending: [{ callId: 'c1', name: 'read', elapsedMs: 1200 }] }));

        const labels = [...turn.element.querySelectorAll('.agent-wakeup-label')].map((node) => node.textContent);
        const texts = [...turn.element.querySelectorAll('.agent-wakeup-text')].map((node) => node.textContent);

        expect(labels).toEqual(['wakeup']);
        expect(texts).toEqual(['1 tool still running · continuing']);
        // A wake is a resume: the card is still running and the tile is not settled.
        expect(card(turn)?.getAttribute('data-state')).toBe('running');
        expect(turn.state()).toBe('streaming');

        // A second wake with nothing left says so, and clears the pending line.
        turn.apply(wake({ pending: [] }));
        expect([...turn.element.querySelectorAll('.agent-wakeup-text')].map((node) => node.textContent)).toEqual([
            '1 tool still running · continuing',
            'pending tools finished · continuing'
        ]);
        expect(turn.element.querySelector('.agent-pending')).toBeNull();

        // Only the call's own result resolves it.
        turn.apply(result({ durationMs: 1200 }));
        expect(card(turn)?.getAttribute('data-state')).toBe('ok');
        expect(turn.element.querySelector('.tool-duration')?.textContent).toBe('1.2s');
    });

    it('abandons an interrupted call when the server settles the turn as cancelled', () => {
        const { board } = mount();
        const turn = board.begin('cancelled');

        turn.merge({
            id: 't1',
            index: 0,
            prompt: 'cancelled',
            status: 'cancelled',
            updatedAt: 300,
            events: [start(), call('c1')]
        });

        expect(turn.state()).toBe('cancelled');
        expect(card(turn)?.getAttribute('data-state')).toBe('cancelled');
        expect(turn.element.querySelector('.tool-state')?.textContent).toBe('cancelled');
        expect(turn.element.querySelector('.tool-pending')?.textContent).toBe(
            'Cancelled before the call returned.'
        );
        expect(turn.element.querySelector('.agent-pending')).toBeNull();

        // A late result for that call (queued before the cancel) is ignored: the
        // runtime detaches it, so the tile must not add a second resolved card.
        turn.apply(result({ durationMs: 1200 }));
        expect(turn.element.querySelectorAll('details.tool')).toHaveLength(1);
        expect(card(turn)?.getAttribute('data-state')).toBe('cancelled');
    });

    it('abandons an unmatched call when a turn ends without its result', () => {
        const { board } = mount();
        const turn = board.begin('ended');

        turn.merge({
            id: 't1',
            index: 0,
            prompt: 'ended',
            status: 'done',
            updatedAt: 300,
            events: [start(), call('c1')]
        });

        expect(turn.state()).toBe('done');
        expect(card(turn)?.getAttribute('data-state')).toBe('cancelled');
        expect(turn.element.querySelector('.tool-pending')?.textContent).toBe(
            'Interrupted when the turn ended without a result.'
        );
    });

    it('abandons a pending call when the turn fails', () => {
        const { board } = mount();
        const turn = board.begin('failed');

        turn.merge({
            id: 't1',
            index: 0,
            prompt: 'failed',
            status: 'error',
            updatedAt: 300,
            events: [start(), call('c1')]
        });

        expect(turn.state()).toBe('error');
        expect(card(turn)?.getAttribute('data-state')).toBe('cancelled');
        expect(turn.element.querySelector('.tool-pending')?.textContent).toBe(
            'Interrupted when the turn failed.'
        );
    });

    it('ignores a duplicate result for an already-settled call id', () => {
        const { board } = mount();
        const turn = board.begin('dupe');

        turn.apply(start());
        turn.apply(call('c1'));
        turn.apply(result({ durationMs: 900 }), undefined, 'recorded');
        // Retried/replayed frame for the SAME id: no second card, no overwrite.
        turn.apply(result({ content: 'duplicate', durationMs: 5000 }), undefined, 'recorded');

        const cards = [...turn.element.querySelectorAll('details.tool')];
        expect(cards).toHaveLength(1);
        expect(cards[0].getAttribute('data-state')).toBe('ok');
        expect(cards[0].querySelector('.tool-duration')?.textContent).toBe('0.9s');
        expect(cards[0].querySelector('.tool-result code')?.textContent).toBe('ok');
    });

    it('resolves same-name concurrent calls by id, out of order', () => {
        const { board } = mount();
        const turn = board.begin('siblings');

        turn.apply(start());
        turn.apply(call('c1'));
        turn.apply(call('c2'));
        turn.apply(result({ callId: 'c2', content: 'second', durationMs: 800 }), undefined, 'recorded');
        turn.apply(result({ callId: 'c1', content: 'first', durationMs: 400 }), undefined, 'recorded');

        const cards = [...turn.element.querySelectorAll('details.tool')];
        expect(cards.map((node) => node.getAttribute('data-state'))).toEqual(['ok', 'ok']);
        expect(cards.map((node) => node.querySelector('.tool-result code')?.textContent)).toEqual([
            'first',
            'second'
        ]);

        // A repeated id after both settled is ignored, not appended.
        turn.apply(result({ callId: 'c2', content: 'again', durationMs: 1 }), undefined, 'recorded');
        expect(turn.element.querySelectorAll('details.tool')).toHaveLength(2);
    });

    it('does not invent a card for a name-only result after a terminal turn', () => {
        const { board } = mount();
        const turn = board.begin('late');

        turn.merge({
            id: 't1',
            index: 0,
            prompt: 'late',
            status: 'cancelled',
            updatedAt: 300,
            events: [start(), call('c1')]
        });

        // Legacy frame with no callId arriving after the turn settled: the runtime
        // detached the call, so nothing may be added to the transcript.
        turn.apply({ type: 'tool_result', agent: 'writer', name: 'read', content: 'late', isError: false });

        expect(turn.element.querySelectorAll('details.tool')).toHaveLength(1);
        expect(card(turn)?.getAttribute('data-state')).toBe('cancelled');
    });

    it('still renders a legacy result-only frame during a live turn', () => {
        const { board } = mount();
        const turn = board.begin('legacy');

        turn.apply(start());
        turn.apply({ type: 'tool_result', agent: 'writer', name: 'timeNow', content: '12:00', isError: false });

        expect(turn.element.querySelectorAll('details.tool')).toHaveLength(1);
        expect(card(turn)?.getAttribute('data-state')).toBe('ok');
    });

    it('prunes a settled call from the pending snapshot when the frame omits pending', () => {
        const { board } = mount();
        const turn = board.begin('drain');

        turn.apply(start());
        turn.apply(call('c1'));
        turn.apply(call('c2', 'search'));
        turn.apply(
            responseDone({
                pending: [
                    { callId: 'c1', name: 'read', elapsedMs: 1200 },
                    { callId: 'c2', name: 'search', elapsedMs: 900 }
                ]
            })
        );
        expect(turn.element.querySelector('.agent-pending')?.textContent).toBe(
            'pending · read 1.2s · search 900ms'
        );

        // EXACT runtime shape for a finishing call: `durationMs` present, `pending`
        // omitted because nothing remained at that instant. The completed call must
        // still leave the line; the sibling must stay.
        turn.apply(result({ callId: 'c1', durationMs: 1200 }), undefined, 'recorded');
        expect(turn.element.querySelector('.agent-pending')?.textContent).toBe('pending · search 900ms');
        expect(turn.element.querySelector('.tile-meta')?.textContent).toBe(
            '1 agent · 2 tool calls · 1 tool still running'
        );

        turn.apply(result({ callId: 'c2', name: 'search', durationMs: 900 }), undefined, 'recorded');
        expect(turn.element.querySelector('.agent-pending')).toBeNull();
        expect(turn.element.querySelector('.tile-meta')?.textContent).toBe('1 agent · 2 tool calls');
    });

    it("keeps another agent's pending line when one agent drains", () => {
        const { board } = mount();
        const turn = board.begin('multi');

        turn.apply(start());
        turn.apply(call('c1'));
        turn.apply(responseDone({ pending: [{ callId: 'c1', name: 'read', elapsedMs: 1200 }] }));

        turn.apply({ type: 'start', agent: 'helper', model: 'm2' });
        turn.apply({
            type: 'tool_call',
            agent: 'helper',
            call: { id: 'h1', name: 'shell', arguments: '{}' }
        });
        turn.apply({
            type: 'done',
            agent: 'helper',
            message: doneMessage('helper'),
            pending: [{ callId: 'h1', name: 'shell', elapsedMs: 5000 }]
        });

        expect([...turn.element.querySelectorAll('.agent-pending')].map((node) => node.textContent)).toEqual([
            'pending · read 1.2s',
            'pending · shell 5.0s'
        ]);

        // The writer dries up; the helper's snapshot is untouched.
        turn.apply(result({ durationMs: 1200 }), undefined, 'recorded');
        expect([...turn.element.querySelectorAll('.agent-pending')].map((node) => node.textContent)).toEqual([
            'pending · shell 5.0s'
        ]);
    });

    it('leaves the pending line alone when a wakeup has no pending list', () => {
        const { board } = mount();
        const turn = board.begin('malformed wake');

        turn.apply(start());
        turn.apply(call('c1'));
        turn.apply(responseDone({ pending: [{ callId: 'c1', name: 'read', elapsedMs: 1200 }] }));

        // `pending` is required on a wake frame: absence is malformed, not "settled".
        turn.apply(wake({ pending: undefined }));

        expect(turn.element.querySelector('.agent-pending')?.textContent).toBe('pending · read 1.2s');
        expect(turn.element.querySelector('.agent-wakeup')).toBeNull();
        expect(card(turn)?.getAttribute('data-state')).toBe('running');
        expect(turn.state()).toBe('streaming');
    });
});

// ---------------------------------------------------------------------------
// Tool grouping across model batches (R1)
// ---------------------------------------------------------------------------
//
// A run of tool calls is ONE wrapping flow unless something the reader can
// actually SEE separates it (prose, an error, a retry notice, a steer). A
// reasoning round is no longer one of those separators: it is an inline `think`
// CHIP that joins the same row, so `[read][think][search]` stays one line.
// `attempt_commit`, `done` and `wakeup` are scheduler frames: they add
// no readable output between two calls, so they must not split four consecutive
// calls into two rows of two. jsdom cannot compute the flex layout, so the DOM
// boundary IS the contract: one `.tool-group` child of `.agent-flow` holding
// every chip in call order (styles.css flows and wraps its children).
describe('tool grouping across model batches (R1)', () => {
    const start = (): HarnessEvent => ({ type: 'start', agent: 'writer', model: 'm1' });

    const call = (id: string, name = 'read'): HarnessEvent => ({
        type: 'tool_call',
        agent: 'writer',
        call: { id, name, arguments: '{}' }
    });

    const result = (id: string, content = 'tool output'): HarnessEvent => ({
        type: 'tool_result',
        agent: 'writer',
        name: 'read',
        callId: id,
        content,
        isError: false
    });

    // The success boundary of one model request (R3/F1). It carries no visible
    // output of its own, which is the whole point of the grouping rule.
    const commit = (): HarnessEvent => ({
        type: 'attempt_commit',
        agent: 'writer',
        attempt: 1,
        maxAttempts: 11
    });

    const responseDone = (fields: Record<string, unknown> = {}): HarnessEvent =>
        ({ type: 'done', agent: 'writer', message: doneMessage('writer'), ...fields }) as unknown as HarnessEvent;

    const wake = (pending: Record<string, unknown>[]): HarnessEvent =>
        ({ type: 'wakeup', agent: 'writer', reason: 'pending-tools', pending }) as unknown as HarnessEvent;

    const record = (events: HarnessEvent[]): SessionTurn => ({
        id: 'turn-1',
        index: 0,
        prompt: 'batched',
        status: 'done',
        startedAt: 5,
        updatedAt: 10,
        events
    });

    // Every wrapping row in the block, as the chip names it contains.
    const rows = (turn: { element: HTMLElement }): string[][] =>
        [...turn.element.querySelectorAll('.agent-flow > .tool-group')].map((row) =>
            [...row.querySelectorAll('.tool-name')].map((name) => name.textContent ?? '')
        );

    const flowClasses = (turn: { element: HTMLElement }): string[] =>
        [...(turn.element.querySelector('.agent-flow')?.children ?? [])].map((child) => child.className);

    it('keeps four consecutive calls from two model batches in one row', () => {
        const { board } = mount();
        const turn = board.begin('four calls');

        turn.apply(start());
        turn.apply(call('c1', 'websearch'));
        turn.apply(call('c2', 'read'));
        // Invisible batch boundary: the tool-calling request commits, and the
        // follow-up request answers with two more calls and no prose.
        turn.apply(commit());
        turn.apply(call('c3', 'shell'));
        turn.apply(call('c4', 'write'));

        expect(rows(turn)).toEqual([['websearch', 'read', 'shell', 'write']]);
        // One row, nothing else in the column, and no chip that escaped the row.
        expect(flowClasses(turn)).toEqual(['tool-group']);
        expect(turn.element.querySelectorAll('.agent-flow > details.tool')).toHaveLength(0);
    });

    it('keeps the row across a done that separates two batches', () => {
        const { board } = mount();
        const turn = board.begin('done between calls');

        turn.apply(start());
        turn.apply(call('c1', 'read'));
        turn.apply(result('c1'));
        turn.apply(responseDone());
        turn.apply(call('c2', 'search'));

        expect(rows(turn)).toEqual([['read', 'search']]);
        expect(flowClasses(turn)).toEqual(['tool-group']);
    });

    it('merges calls across a wakeup and keeps the status markers after the merged row', () => {
        const { board } = mount();
        const turn = board.begin('woken batch');

        turn.apply(start());
        turn.apply(call('c1', 'read'));
        // The response finished while its own call was still running (R6)…
        turn.apply(responseDone({ pending: [{ callId: 'c1', name: 'read', elapsedMs: 1200 }] }));
        // …and the wake resumes it with a further call, no prose in between.
        turn.apply(wake([{ callId: 'c1', name: 'read', elapsedMs: 1200 }]));
        turn.apply(call('c2', 'search'));

        // The chips share one row; the wake marker and the pending snapshot FOLLOW
        // the row (they never split it, and neither is duplicated by the merge).
        expect(rows(turn)).toEqual([['read', 'search']]);
        expect(flowClasses(turn)).toEqual(['tool-group', 'agent-wakeup', 'agent-pending']);
        expect(turn.element.querySelectorAll('.agent-wakeup')).toHaveLength(1);
        expect(turn.element.querySelector('.agent-pending')?.textContent).toBe('pending · read 1.2s');
        expect(turn.element.querySelectorAll('.agent-flow > details.tool')).toHaveLength(0);
    });

    it('splits the row when real prose separates the batches', () => {
        const { board } = mount();
        const turn = board.begin('prose between batches');

        turn.apply(start());
        turn.apply(call('c1', 'read'));
        turn.apply(commit());
        turn.apply({ type: 'text', agent: 'writer', delta: 'now I know' });
        turn.apply(call('c2', 'search'));

        expect(rows(turn)).toEqual([['read'], ['search']]);
        expect(flowClasses(turn)).toEqual(['tool-group', 'markdown agent-text', 'tool-group']);
    });

    // R1/the think chip: reasoning is an INLINE chip now, so it no longer counts as a
    // readable block between two batches — `[read][think][search]` is ONE row, and the
    // round's text lives inside the chip (`.tool.think .reasoning`).
    it('keeps the row and puts reasoning in it as an inline think chip', () => {
        const { board } = mount();
        const turn = board.begin('reasoning between batches');

        turn.apply(start());
        turn.apply(call('c1', 'read'));
        turn.apply(commit());
        turn.apply({ type: 'reasoning', agent: 'writer', delta: 'checking' });
        turn.apply(call('c2', 'search'));

        expect(rows(turn)).toEqual([['read', 'think', 'search']]);
        expect(flowClasses(turn)).toEqual(['tool-group']);
        // Nothing of the old full-width block survives: no `.thinking`, and no chip
        // that escaped the row into the flow column.
        expect(turn.element.querySelectorAll('.agent-flow > details.tool')).toHaveLength(0);
        expect(turn.element.querySelectorAll('.thinking, .thinking-summary')).toHaveLength(0);
        // The chip is a `details.tool`, so a CALL count has to exclude it: three chips
        // in the row, two of them calls.
        expect(turn.element.querySelectorAll('details.tool')).toHaveLength(3);
        expect(turn.element.querySelectorAll('details.tool:not(.think)')).toHaveLength(2);
        // The chip's own anatomy (ui/tools.ts `createReasoningCard`): amber label plus
        // the round's text in its dialog body.
        const chip = turn.element.querySelector<HTMLElement>('details.tool.think');
        expect(chip?.className).toBe('tool think');
        expect(chip?.querySelector('.tool-name')?.textContent).toBe('think');
        expect(chip?.querySelector('.reasoning')?.textContent).toBe('checking');
        // A reasoning round is not a tool call, so it never enters the call tally.
        expect(turn.element.querySelector('.tile-meta')?.textContent).toBe('1 agent · 2 tool calls');
    });

    it('replays a batched recording into one row without duplicate chips', () => {
        const { board } = mount();
        const events = [start(), call('c1', 'websearch'), call('c2', 'read'), commit(), call('c3', 'shell')];
        const [turn] = board.hydrate([record(events)]);

        expect(rows(turn)).toEqual([['websearch', 'read', 'shell']]);
        expect(turn.element.querySelectorAll('details.tool')).toHaveLength(3);

        // The same record again (a poll/reconnect): the applied prefix matches, so
        // nothing is re-rendered — one row, three chips, no duplicates.
        turn.merge(record(events));
        expect(rows(turn)).toEqual([['websearch', 'read', 'shell']]);
        expect(turn.element.querySelectorAll('details.tool')).toHaveLength(3);
    });
});

// ---------------------------------------------------------------------------
// Final answer copy action (R5)
// ---------------------------------------------------------------------------
//
// The block footer is no longer a `model · stop · N tokens` line (the block
// HEADERS keep those measurements). It carries one right-aligned, accessible
// Copy action for THIS block's final answer: the raw Markdown of the last
// COMPLETED prose of that invocation. A streaming partial, a tool-only round,
// and an answer cut short by an error or a cancel are each pinned below.
describe('final answer copy action (R5)', () => {
    const start = (): HarnessEvent => ({ type: 'start', agent: 'writer', model: 'm1' });

    const text = (delta: string, agent = 'writer'): HarnessEvent => ({ type: 'text', agent, delta });

    const commit = (): HarnessEvent => ({
        type: 'attempt_commit',
        agent: 'writer',
        attempt: 1,
        maxAttempts: 11
    });

    const call = (id: string, name = 'read'): HarnessEvent => ({
        type: 'tool_call',
        agent: 'writer',
        call: { id, name, arguments: '{}' }
    });

    const result = (id: string, content = 'tool output'): HarnessEvent => ({
        type: 'tool_result',
        agent: 'writer',
        name: 'read',
        callId: id,
        content,
        isError: false
    });

    // One completed agent response. `content` is the terminal message content, so a
    // test can state whether the provider streamed deltas or answered on the frame.
    const answerDone = (content: string, agent = 'writer'): HarnessEvent => ({
        type: 'done',
        agent,
        message: {
            role: 'assistant',
            content,
            reasoning: '',
            toolCalls: [],
            model: `${agent}-model`,
            stopReason: 'stop'
        }
    });

    const record = (
        status: 'done' | 'error' | 'cancelled',
        events: HarnessEvent[]
    ): SessionTurn => ({
        id: 'turn-1',
        index: 0,
        prompt: 'the task',
        status,
        startedAt: 5,
        updatedAt: 10,
        events
    });

    const copyButton = (scope: ParentNode): HTMLButtonElement | null =>
        scope.querySelector<HTMLButtonElement>('.agent-answer-actions .answer-copy');

    // jsdom's navigator has no clipboard, so every copy test states the async API
    // and asserts the EXACT strings it received. ui/dialog.ts owns the write path
    // and its insecure-origin fallback (dialog-copy.test.ts); what is pinned here
    // is which text the transcript hands it.
    const setClipboard = (writeText: ((text: string) => Promise<void>) | undefined): void => {
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: writeText === undefined ? undefined : { writeText }
        });
    };

    afterEach(() => setClipboard(undefined));

    const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

    // Click the action and return the clipboard payloads, in call order.
    const copyPayloads = async (button: HTMLButtonElement | null): Promise<string[]> => {
        if (button === null) throw new Error('missing copy action');

        const written: string[] = [];
        setClipboard(async (value: string) => {
            written.push(value);
        });

        button.click();
        await settled();
        return written;
    };

    it('offers nothing while the answer streams and one the moment it completes', async () => {
        const { board } = mount();
        const turn = board.begin('ask');

        turn.apply(start());
        turn.apply(text('# Partial'));
        turn.flush();

        // The streamed half-answer is on screen, but it is not FINAL: no action.
        expect(turn.element.querySelector('.agent-text')?.textContent).toBe('Partial\n');
        expect(copyButton(turn.element)).toBeNull();
        // R5: the row is no longer childless for a block WITH a surface — the
        // Collapse/Expand toggle is there from creation — but the copy control is
        // still the only thing that appears on completion, so the child set is
        // exactly the toggle.
        expect(
            [...(turn.element.querySelector('.agent-answer-actions')?.children ?? [])].map(
                (node) => node.className
            )
        ).toEqual(['answer-collapse']);

        turn.apply(answerDone('# Partial'));
        const button = copyButton(turn.element);
        expect(button).not.toBeNull();
        expect(await copyPayloads(button)).toEqual(['# Partial']);
        // Success feedback lives in the button (glyph + `data-state`), and the
        // accessible name never changes.
        expect(button?.dataset.state).toBe('success');
        expect(button?.getAttribute('aria-label')).toBe('Copy the final answer');
        // R5: the completed copy control joins the row on the LEFT of the toggle, so
        // the answer's affordance reads first and the block's own collapse stays last.
        expect(button?.parentElement?.firstElementChild).toBe(button);
        expect(button?.nextElementSibling?.className).toBe('answer-collapse');
    });

    it('copies the raw Markdown of the last completed answer after several tool rounds', async () => {
        const { board } = mount();
        const turn = board.begin('ask');

        turn.apply(start());
        // Round 1: intermediate prose + a call, committed by `attempt_commit`.
        turn.apply(text('first **draft**'));
        turn.apply(call('c1'));
        turn.apply(result('c1', 'tool output'));
        turn.apply(commit());
        // Round 2: the real answer, streamed as Markdown and closed by `done`.
        turn.apply(text('# Title\n\n'));
        turn.apply(text('- one\n'));
        turn.apply(text('- two'));
        turn.apply(answerDone('# Title\n\n- one\n- two'));

        // Raw Markdown exactly as streamed: not the rendered HTML, not the prompt,
        // not the tool output, and not the intermediate prose joined on the front.
        expect(await copyPayloads(copyButton(turn.element))).toEqual(['# Title\n\n- one\n- two']);
    });

    it('keeps the older answer while a new one streams and advances it on completion', async () => {
        const { board } = mount();
        const turn = board.begin('ask');

        turn.apply(start());
        turn.apply(answerDone('A'));
        const button = copyButton(turn.element);
        expect(await copyPayloads(button)).toEqual(['A']);

        // A later message arrives: the reader can still copy the completed answer
        // (the action is not removed and the partial is never substituted for it).
        turn.apply(text('B still streaming'));
        expect(copyButton(turn.element)).toBe(button);
        expect(await copyPayloads(copyButton(turn.element))).toEqual(['A']);

        // Only its completion advances the target — and the same button carries it.
        // (The terminal content agrees with the streamed prose, as it does in a real
        // recording; the no-delta provider case is pinned separately below.)
        turn.apply(text(' and done'));
        turn.apply(answerDone('B still streaming and done'));
        expect(copyButton(turn.element)).toBe(button);
        expect(await copyPayloads(copyButton(turn.element))).toEqual(['B still streaming and done']);
    });

    it('falls back to the terminal message content when no deltas streamed', async () => {
        const { board } = mount();
        const turn = board.begin('ask');

        // The documented provider case: the answer arrives only on the terminal
        // message, so that content IS what the block completed.
        turn.apply(start());
        turn.apply(answerDone('message only answer'));

        expect(await copyPayloads(copyButton(turn.element))).toEqual(['message only answer']);
    });

    it('keeps the answer copyable through a tool-only round', async () => {
        const { board } = mount();
        const turn = board.begin('ask');

        turn.apply(start());
        turn.apply(answerDone('A'));
        // A round with no prose of its own must not blank the target with ''.
        turn.apply(call('c1'));
        turn.apply(result('c1'));
        turn.apply(commit());

        expect(await copyPayloads(copyButton(turn.element))).toEqual(['A']);
    });

    it('promotes the answer a committed request ended without a done frame', async () => {
        const { board } = mount();
        const turn = board.begin('ask');

        turn.apply(start());
        turn.apply(text('committed **answer**'));
        turn.apply(commit());

        expect(await copyPayloads(copyButton(turn.element))).toEqual(['committed **answer**']);
    });

    it('offers nothing when the only answer is cut short by an error', () => {
        const { board } = mount();
        const turn = board.begin('ask');

        turn.apply(start());
        turn.apply(text('half an answer'));
        turn.apply({ type: 'error', agent: 'writer', error: { message: 'provider failed' } });
        turn.flush();

        // The partial stays readable, but it is never labelled as the final answer.
        expect(turn.element.querySelector('.agent-text')?.textContent).toBe('half an answer\n');
        expect(copyButton(turn.element)).toBeNull();
    });

    it('keeps the last completed answer when a later response errors', async () => {
        const { board } = mount();
        const turn = board.begin('ask');

        turn.apply(start());
        turn.apply(answerDone('A'));
        turn.apply(text('interrupted draft'));
        turn.apply({ type: 'error', agent: 'writer', error: { message: 'provider failed' } });

        expect(await copyPayloads(copyButton(turn.element))).toEqual(['A']);
    });

    it('offers nothing for a turn that ends cancelled or failed mid-answer', () => {
        const { board } = mount();
        const cancelled = board.hydrate([record('cancelled', [start(), text('half')])])[0];

        expect(cancelled.element.querySelector('.agent-text')?.textContent).toBe('half\n');
        expect(copyButton(cancelled.element)).toBeNull();

        const [failed] = board.hydrate([record('error', [start(), text('half')])]);
        expect(copyButton(failed.element)).toBeNull();
    });

    it('completes an answer recorded without a done frame when the turn ends normally', async () => {
        const { board } = mount();
        // An older recording whose last response was streamed but never closed by a
        // `done`/`attempt_commit`: the normal end of the turn completes it.
        const [turn] = board.hydrate([record('done', [start(), text('recorded answer')])]);

        expect(turn.state()).toBe('done');
        expect(await copyPayloads(copyButton(turn.element))).toEqual(['recorded answer']);
    });

    it('gives every agent block its own final answer', async () => {
        const { board } = mount();
        const turn = board.begin('delegate');

        turn.apply(start());
        turn.apply(answerDone('root answer'));
        // A second agent in the same turn is its own block with its own answer.
        turn.apply({ type: 'start', agent: 'helper', model: 'm2' });
        turn.apply(text('child answer', 'helper'));
        turn.apply(answerDone('child answer', 'helper'));

        const buttons = [...turn.element.querySelectorAll('.agent-answer-actions .answer-copy')];
        expect(buttons).toHaveLength(2);
        // DOM order is block order: the primary section first, then the flat
        // subagent section — each copies ONLY its own answer.
        expect(await copyPayloads(buttons[0] as HTMLButtonElement)).toEqual(['root answer']);
        expect(await copyPayloads(buttons[1] as HTMLButtonElement)).toEqual(['child answer']);
    });

    it('keeps the header measurements the footer used to duplicate', () => {
        const { board } = mount();
        const turn = board.begin('ask');

        turn.apply(start());
        turn.apply({ type: 'usage', agent: 'writer', usage: { input: 150, output: 9, total: 159, cached: 140 } });
        turn.setUsage({ input: 150, output: 9, total: 159, cached: 140 });
        turn.apply(answerDone('A'));

        // R5 removed the footer line ONLY: the header still reports the model
        // (section `data-model`), the token tally and the state word.
        expect(turn.element.querySelectorAll('.agent-meta')).toHaveLength(0);
        expect(turn.element.querySelector('.agent-answer-actions')?.textContent).toBe('');
        expect(turn.tokens()).toBe('150 (140)');
        expect(turn.element.querySelector<HTMLElement>('.tile-tokens')?.hidden).toBe(false);
        expect(turn.element.querySelector('.tile-status-text')?.textContent).toBe('streaming');
        expect(turn.element.querySelector('.agent')?.getAttribute('data-model')).toBe('m1');
    });
});

// ---------------------------------------------------------------------------
// Inline reasoning chips ("think")
// ---------------------------------------------------------------------------
//
// A streamed `reasoning` round is NOT a full-width block any more: `appendReasoning`
// (ui/turns.ts) mints ONE chip per model REQUEST and appends it INTO the agent's
// `.tool-group` row (it does NOT call `closeToolGroup`), using the tool chip's anatomy
// (ui/tools.ts `createReasoningCard`). So a round between two calls reads
// `[read][think][search]` as ONE wrapping row instead of splitting it.
//
// The chip is a `details.tool`, which is why every CALL assertion in this file selects
// `details.tool:not(.think)` and every REASONING assertion selects `.tool.think`
// (`.think .tool-name` for the label, `.think .reasoning` for the whole round).
//
// The pill (`.think-count`) is the share of the block's accumulated CONTEXT the round
// occupies, never a character count. The denominator is `BlockMeta.context()`
// (`latestInput ?? tally.input`) — the same figure the header `.tile-tokens` prints —
// so:
//   - no usage reported anywhere -> the pill is `[hidden]` and its text is ''
//     (never a fabricated `0%` or a dash);
//   - a `usage` event, or the server tally via `setUsage`, advances that figure ->
//     `syncThinkingShares` repaints EVERY chip of the tile against the new denominator,
//     so a pill can never disagree with the header two lines above it;
//   - the text is `ceil(chars / 4)` tokens over that context: `<0.1%` strictly below a
//     tenth of a percent, one decimal below 10%, whole percent from 10% up
//     (`formatThinkShare`, ui/tools.ts).
describe('inline reasoning chips (think)', () => {
    const start = (): HarnessEvent => ({ type: 'start', agent: 'writer', model: 'm1' });

    const reasoning = (delta: string): HarnessEvent => ({ type: 'reasoning', agent: 'writer', delta });

    // One request's reported usage: `input` IS the context figure a pill divides by.
    const usage = (input: number): HarnessEvent => ({
        type: 'usage',
        agent: 'writer',
        usage: { input, output: 0, total: input }
    });

    // The success boundary of one model request. It drops the reasoning WRITER pointer
    // only (T8), so the next request mints its own chip.
    const commit = (): HarnessEvent => ({
        type: 'attempt_commit',
        agent: 'writer',
        attempt: 1,
        maxAttempts: 11
    });

    // The think chips of one block, in DOM order.
    const chips = (turn: { element: HTMLElement }): HTMLDetailsElement[] =>
        [...turn.element.querySelectorAll<HTMLDetailsElement>('details.tool.think')];

    // Each chip's cumulative round text, as the dialog body holds it.
    const thinkingTexts = (turn: { element: HTMLElement }): string[] =>
        chips(turn).map((chip) => chip.querySelector('.reasoning')?.textContent ?? '');

    // Each chip's pill text, and whether that pill is hidden.
    const pills = (turn: { element: HTMLElement }): string[] =>
        chips(turn).map((chip) => chip.querySelector('.think-count')?.textContent ?? '');

    const pillsHidden = (turn: { element: HTMLElement }): boolean[] =>
        chips(turn).map((chip) => chip.querySelector<HTMLElement>('.think-count')?.hidden === true);

    // (b) ONE chip per request, never one chip per round of deltas, and never one chip
    // shared by two requests.
    it('mints one chip per request and never fuses two rounds into it', () => {
        const { board } = mount();
        const turn = board.begin('ask');

        turn.apply(start());
        // Request 1 streams in two deltas: the first mints the chip, the second repaints
        // it with the CUMULATIVE buffer (plain text, no parse).
        turn.apply(reasoning('plan the '));
        turn.apply(reasoning('read'));
        turn.apply(commit());
        // Request 2 reasons after the commit, so it gets a chip of its own.
        turn.apply(reasoning('plan the search'));
        turn.flush();

        expect(chips(turn)).toHaveLength(2);
        expect(chips(turn).map((chip) => chip.querySelector('.tool-name')?.textContent)).toEqual([
            'think',
            'think'
        ]);
        expect(thinkingTexts(turn)).toEqual(['plan the read', 'plan the search']);
        // Both chips are in the ONE row this block's calls would share: no flow-level
        // block sits between them, and a thinking round is not a tool call.
        const rows = [...turn.element.querySelectorAll('.agent-flow > .tool-group')];
        expect(rows).toHaveLength(1);
        expect([...rows[0].children].map((child) => child.className)).toEqual([
            'tool think',
            'tool think'
        ]);
        expect(turn.element.querySelectorAll('details.tool:not(.think)')).toHaveLength(0);
        expect(turn.element.querySelector('.tile-meta')?.textContent).toBe('1 agent');
    });

    // Plain text, never Markdown: scratch space can contain markup and it must survive
    // byte-for-byte (no HTML parse of its own, no sanitizer round-trip).
    it('keeps the round verbatim instead of parsing it as Markdown', () => {
        const { board } = mount();
        const turn = board.begin('ask');

        turn.apply(start());
        turn.apply(reasoning('# not **markdown** <script>'));
        turn.flush();

        const text = '# not **markdown** <script>';
        expect(thinkingTexts(turn)).toEqual([text]);
        expect(chips(turn)[0].querySelector('.reasoning')?.innerHTML).toBe(
            '# not **markdown** &lt;script&gt;'
        );
    });

    // (d) half 1: with no denominator there is no percentage. The pill claims nothing
    // rather than `0%`, exactly like a tool chip with no honest span.
    it('hides the pill while the block has no context figure', () => {
        const { board } = mount();
        const turn = board.begin('ask');

        turn.apply(start());
        turn.apply(reasoning('a provider that reports no usage'));
        turn.flush();

        expect(pills(turn)).toEqual(['']);
        expect(pillsHidden(turn)).toEqual([true]);
        // The header agrees: it prints no tally either.
        expect(turn.element.querySelector<HTMLElement>('.tile-tokens')?.hidden).toBe(true);
        expect(turn.tokens()).toBe('');
    });

    // (d) half 2 + the hover arithmetic. Every figure below is derived from
    // `formatThinkShare`'s contract, not read off a run.
    it('paints the share of the block context a round occupies', () => {
        const { board } = mount();
        const turn = board.begin('ask');

        // 387 chars -> `ceil(387 / 4)` = 97 tokens; 97 / 42,212 = 0.2297% -> one decimal.
        turn.apply(start());
        turn.apply(reasoning('x'.repeat(387)));
        expect(pills(turn)).toEqual(['']);

        turn.apply(usage(42_212));
        expect(pills(turn)).toEqual(['0.2%']);
        expect(pillsHidden(turn)).toEqual([false]);

        // Request 2: 12,108 chars -> 3,027 tokens over the SAME 42,212 context =
        // 7.1709% -> `7.2%`. The pill is three or four characters; the exact counts stay
        // on hover, grouped with the pinned `en-US` locale.
        turn.apply(commit());
        turn.apply(reasoning('y'.repeat(12_108)));
        expect(pills(turn)).toEqual(['0.2%', '7.2%']);

        const second = chips(turn)[1];
        expect(second.querySelector('.tool-name')?.textContent).toBe('think');
        expect(second.querySelector('.think-count')?.textContent).toBe('7.2%');
        expect(second.querySelector('summary')?.getAttribute('aria-haspopup')).toBe('dialog');
        expect(second.querySelector('summary')?.getAttribute('aria-label')).toBe(
            'think: 7.2% of the context so far'
        );
        expect(second.querySelector('summary')?.title).toBe(
            '≈ 3,027 of 42,212 context tokens (7.2%)'
        );
        expect(second.querySelector('.reasoning')?.textContent).toBe('y'.repeat(12_108));
    });

    // (e) the denominator is the block's FRESHEST context, so a later `usage` event
    // re-measures every chip of the tile — not just the newest one.
    it('repaints every chip when a later usage event advances the context', () => {
        const { board } = mount();
        const turn = board.begin('ask');

        turn.apply(start());
        turn.apply(reasoning('x'.repeat(387)));
        turn.apply(usage(42_212));
        turn.apply(commit());
        turn.apply(reasoning('y'.repeat(12_108)));
        expect(pills(turn)).toEqual(['0.2%', '7.2%']);

        // The context moves to 358,448: 97 tokens is now a fraction of a tenth of a
        // percent (`<0.1%`, never `0.0%`) and 3,027 tokens is 0.8444% -> `0.8%`.
        turn.apply(usage(358_448));
        expect(pills(turn)).toEqual(['<0.1%', '0.8%']);
        // The header prints the same figure the pills divided by.
        expect(turn.tokens()).toBe('358,448');
    });

    // A record whose usage EVENTS were trimmed still has the server's cumulative tally,
    // and `context()` falls back to it — so `setUsage` is a real denominator too.
    it('measures against the server tally when no usage event was recorded', () => {
        const { board } = mount();
        const turn = board.begin('ask');

        turn.apply(start());
        turn.apply(reasoning('x'.repeat(400_000)));
        expect(pills(turn)).toEqual(['']);

        // 400,000 chars = 100,000 tokens over a 1,000,000 context: exactly 10%, which
        // leaves the one-decimal range and rounds to a whole percent.
        turn.setUsage({ input: 1_000_000, output: 0, total: 1_000_000 });
        expect(pills(turn)).toEqual(['10%']);
        expect(pillsHidden(turn)).toEqual([false]);
    });

    // The three rounding branches of `formatThinkShare`, each hand-computed.
    it('rounds a share at each branch boundary', () => {
        const { board } = mount();

        // `0.1%` EXACTLY: the `<` branch is strictly below a tenth of a percent, so the
        // boundary value itself keeps its decimal.
        const exact = board.begin('exact tenth');
        exact.apply(start());
        exact.apply(reasoning('abc'));
        exact.apply(usage(1_000));
        expect(pills(exact)).toEqual(['0.1%']);

        // 200 chars = 50 tokens over 100,000 = 0.05%: a real share below a tenth reads
        // `<0.1%`, because `0.0%` would claim the model never thought at all.
        const tiny = board.begin('sub tenth');
        tiny.apply(start());
        tiny.apply(reasoning('x'.repeat(200)));
        tiny.apply(usage(100_000));
        expect(pills(tiny)).toEqual(['<0.1%']);

        // 40 chars = 10 tokens over 100 = exactly 10%: the first value that drops the
        // decimal, so the pill never twitches one while a round streams.
        const whole = board.begin('whole percent');
        whole.apply(start());
        whole.apply(reasoning('x'.repeat(40)));
        whole.apply(usage(100));
        expect(pills(whole)).toEqual(['10%']);
    });
});

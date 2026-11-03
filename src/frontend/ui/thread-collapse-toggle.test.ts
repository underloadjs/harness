// R5/T7: the ONE Collapse chevron of an agent block — footer-only, collapse-only.
//
// T7 (user feedback: "the whole row is a toggle … [the chevron] is only needed when it is
// fully expanded and I'm at the bottom of the page, allowing me to collapse without having
// to scroll all the way up") removed the header chevron an earlier pass added. What is
// left is exactly one button per collapsible block — a nested invocation card
// (`.thread-body`) and the root conversation (`.tile-body`) — appended into that block's
// `.agent-answer-actions` footer row, after the Copy button:
//   - expanding belongs to the ROW: `.thread-select` / `.tile-select` is a real button
//     spanning the collapsed header, so a second chevron in that row was a duplicate
//     affordance ("unnecessary at this level");
//   - the chevron's whole row lives inside the body, which styles.css hides with
//     `display: none` while the block is closed. That single fact is what makes its
//     constants honest: a reader can only ever see or press it while the surface is OPEN,
//     so `aria-expanded="true"` and the name `Collapse thread` / `Collapse conversation`
//     are always true, and NOTHING repaints them — no `isExpanded()` probe, no sync pass,
//     no `TurnHandle.syncCollapseAction`;
//   - it never routes through `focusThread`, so collapsing a nested card in place leaves
//     board focus and the composer target where they were; the root chevron performs the
//     board's own `collapse()`, the same deliberate unfocus the header performs.
//
// What this file pins: one chevron per block and zero header chevrons; the constant ARIA
// contract; the copy-before-chevron order; collapse-only clicks (nested and root) with the
// focus guarantees; header expansion unchanged; a projection rebuild minting a fresh button
// with the same contract and no leftovers; no chevron at all for a flat legacy section;
// and the icon-only / keyboard / never-disabled shape. The CSS facts this depends on are
// asserted against the stylesheet SOURCE (jsdom computes no layout), like
// ui/agent-answer-style.test.ts does.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts ui/thread-collapse-toggle.test.ts

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { HarnessAssistantMessage, HarnessEvent, SessionTurn } from '../../server/protocol';
import { createTurnBoard } from './turns';
import type { TurnHandle } from './turns';
import type { SessionThreadEntry } from './threads';

const css = (() => {
    const stylesheet = ['src/frontend/styles.css', 'src/styles.css']
        .map((candidate) => resolve(process.cwd(), candidate))
        .find((candidate) => existsSync(candidate));
    if (stylesheet === undefined) throw new Error('styles.css not found');
    return readFileSync(stylesheet, 'utf8');
})();

// Attach frozen `thread` metadata to an otherwise ordinary event (the UI reads it
// structurally; see contract.ts `threadOf`).
const withThread = (
    event: Record<string, unknown>,
    thread: Record<string, unknown>
): HarnessEvent => ({ ...event, thread } as unknown as HarnessEvent);

const delegateCall = (agent: string, input: string, id: string): HarnessEvent =>
    ({
        type: 'tool_call',
        agent: 'writer',
        call: { id, name: 'delegate', arguments: JSON.stringify({ agent, input }) }
    }) as unknown as HarnessEvent;

const doneMessage = (agent: string): HarnessAssistantMessage => ({
    role: 'assistant',
    content: 'answer',
    reasoning: '',
    toolCalls: [],
    model: `${agent}-model`,
    stopReason: 'stop'
});

const serverTurn = (
    options: {
        id?: string;
        index?: number;
        prompt?: string;
        status?: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
        threadId?: string;
        events?: HarnessEvent[];
    } = {}
): SessionTurn =>
    ({
        id: options.id ?? 'turn-1',
        index: options.index ?? 0,
        prompt: options.prompt ?? 'task',
        status: options.status ?? 'done',
        startedAt: 5,
        updatedAt: 10,
        events: options.events ?? [],
        ...(options.threadId === undefined ? {} : { threadId: options.threadId })
    }) as unknown as SessionTurn;

const threadEntry = (overrides: Partial<SessionThreadEntry> & { id: string }): SessionThreadEntry => ({
    agent: 'writer',
    origin: 'host',
    status: 'idle',
    sequence: 1,
    ...overrides
});

// The board reports the composer's target on every focus change, so a test can state
// exactly how MANY times it moved and to what.
const mount = () => {
    const focused: (string | undefined)[] = [];
    const board = createTurnBoard({
        onFocusChange: (threadId) => focused.push(threadId)
    });
    document.body.replaceChildren(board.element);
    return { board, focused };
};

// A child invocation joined to a PERSISTENT conversation through the roster. Only a joined
// entry routes a HEADER CLICK into `focusThread`, which is what makes it the right surface
// for proving the chevron does not.
const rosterWithChild = (): SessionThreadEntry[] => [
    threadEntry({ id: 'thread-root', sequence: 1, label: 'Writer', agent: 'writer' }),
    threadEntry({
        id: 'thread-child',
        sequence: 2,
        label: 'Helper child',
        agent: 'helper',
        ownerThreadId: 'thread-root',
        invocationId: 'inv-9',
        messages: [
            { role: 'user', content: 'child prompt' },
            { role: 'assistant', content: 'child answer' }
        ]
    })
];

const childEvents = (input = 'child task'): HarnessEvent[] => [
    { type: 'start', agent: 'writer', model: 'm1' } as HarnessEvent,
    delegateCall('helper', input, 'd1'),
    withThread({ type: 'start', agent: 'helper', model: 'h1' }, { id: 'inv-9', callId: 'd1', input })
];

const threadRows = (turn: TurnHandle): HTMLElement[] => [
    ...((turn.element.parentElement as HTMLElement).querySelectorAll<HTMLElement>('.thread-row') ?? [])
];

// The chevron, for each owner. Scoped to the OWNING surface (`:scope >`), so a nested
// card's control is never counted as the parent's.
const rootChevron = (turn: TurnHandle): HTMLButtonElement | null =>
    turn.element.querySelector<HTMLButtonElement>('.tile-flow .agent-answer-actions .answer-collapse');

const rowChevron = (row: HTMLElement): HTMLButtonElement | null =>
    row.querySelector<HTMLButtonElement>(':scope > .thread-tile > .thread-body .answer-collapse');

const childChevron = (turn: TurnHandle): HTMLButtonElement | null => rowChevron(threadRows(turn)[0]);

// The footer's control order, as class names: the exact R5 contract (copy left, chevron
// right) that T7 must not disturb.
const footerOrder = (actions: Element | null): string[] =>
    [...((actions as HTMLElement | null)?.children ?? [])].map((node) => node.className);

// Every state-bearing attribute of the chevron. There is no `data-expanded` any more: the
// button carries a CONSTANT `aria-expanded`, so nothing has to keep a mirror in sync.
const chevronState = (button: HTMLButtonElement | null) => ({
    expanded: button?.getAttribute('aria-expanded'),
    label: button?.getAttribute('aria-label'),
    title: button?.title,
    controls: button?.getAttribute('aria-controls'),
    type: button?.type
});

describe('block footer collapse chevron (R5/T7)', () => {
    it('gives each collapsible block exactly one chevron, and no header chevron at all', () => {
        const { board } = mount();
        const turn = board.begin('delegate');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply(delegateCall('helper', 'child task', 'd1'));
        turn.apply(
            withThread({ type: 'start', agent: 'helper', model: 'h1' }, { id: 't1', callId: 'd1', input: 'child task' })
        );

        const row = threadRows(turn)[0];
        const tile = row.querySelector<HTMLElement>(':scope > .thread-tile') as HTMLElement;
        // ONE per block, each inside that block's own footer row.
        expect(turn.element.querySelectorAll('.answer-collapse')).toHaveLength(1);
        expect(tile.querySelectorAll('.answer-collapse')).toHaveLength(1);
        // Two distinct buttons: the child never borrows the root's control.
        expect(new Set([rootChevron(turn), childChevron(turn)]).size).toBe(2);

        // T7: NO header chevron anywhere — the collapsed row is the expander, so the
        // header surfaces are exactly what they were before the toggle existed.
        expect(board.element.querySelectorAll('.header-collapse')).toHaveLength(0);
        expect([...turn.element.children].map((node) => node.className)).toEqual([
            'tile-select',
            'tile-transcript-action',
            'tile-body'
        ]);
        expect([...tile.children].map((node) => node.className)).toEqual([
            'thread-select',
            'thread-transcript-action',
            'thread-body'
        ]);
    });

    it('carries a constant Collapse contract, honest because only the body renders it', () => {
        const { board } = mount();
        const turn = board.begin('delegate');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply(delegateCall('helper', 'child task', 'd1'));
        turn.apply(
            withThread({ type: 'start', agent: 'helper', model: 'h1' }, { id: 't1', callId: 'd1', input: 'child task' })
        );

        const row = threadRows(turn)[0];
        // The root block is OPEN (`begin` expanded the tile): the label matches the state.
        expect(chevronState(rootChevron(turn))).toEqual({
            expanded: 'true',
            label: 'Collapse conversation',
            title: 'Collapse conversation',
            controls: turn.element.querySelector<HTMLElement>('.tile-body')?.id,
            type: 'button'
        });
        // The child card is CLOSED, and its chevron still says `Collapse thread`. That is
        // not a lie: the whole row is inside `.thread-body`, which the stylesheet hides for
        // a collapsed card, so the button is unrendered, untabbable and out of the
        // accessibility tree in that state — the only moment it is reachable is when the
        // surface is open. These are the rules that make that guarantee.
        expect(chevronState(rowChevron(row))).toEqual({
            expanded: 'true',
            label: 'Collapse thread',
            title: 'Collapse thread',
            controls: row.querySelector<HTMLElement>('.thread-body')?.id,
            type: 'button'
        });
        expect(css).toContain('.thread-row:not(.is-expanded) .thread-body');
        expect(css).toContain('.tile:not(.is-expanded) .tile-body');
        // Both name a REAL body, and the two bodies differ.
        expect(rootChevron(turn)?.getAttribute('aria-controls')).toBeTruthy();
        expect(rowChevron(row)?.getAttribute('aria-controls')).toBeTruthy();
        expect(rootChevron(turn)?.getAttribute('aria-controls')).not.toBe(
            rowChevron(row)?.getAttribute('aria-controls')
        );
        // The constant ARIA replaced the mirrored attribute entirely.
        expect(rootChevron(turn)?.hasAttribute('data-expanded')).toBe(false);
        expect(rowChevron(row)?.hasAttribute('data-expanded')).toBe(false);
    });

    it('leaves a flat legacy section without a chevron', () => {
        const { board } = mount();
        const turn = board.begin('legacy ctx.run');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        // No delegate call and no thread metadata: an unattributable stream keeps the old
        // FLAT section, which has no collapsible surface at all.
        turn.apply({ type: 'start', agent: 'helper', model: 'h2' });
        turn.apply({ type: 'text', agent: 'helper', delta: 'legacy answer' });
        turn.apply({ type: 'done', agent: 'helper', message: doneMessage('helper') });
        turn.flush();

        const agents = [...turn.element.querySelectorAll<HTMLElement>('.agent')];
        expect(agents.map((agent) => agent.dataset.role)).toEqual(['primary', 'subagent']);

        const flat = agents[1].querySelector<HTMLElement>('.agent-answer-actions');
        expect(flat?.querySelector('.answer-collapse')).toBeNull();
        // The completed answer is the ONLY control it can ever hold, so the row is a
        // single child and the `:empty` rule still describes the pre-answer state.
        expect(footerOrder(flat ?? null)).toEqual(['text-copy answer-copy']);
        // The root block (the primary section) DOES own a surface, so it keeps its chevron.
        expect(agents[0].querySelector('.answer-collapse')).not.toBeNull();
    });

    it('keeps the copy button before the chevron, and the chevron alone before an answer', () => {
        const { board } = mount();
        const turn = board.begin('delegate');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply(delegateCall('helper', 'child task', 'd1'));
        turn.apply(
            withThread({ type: 'start', agent: 'helper', model: 'h1' }, { id: 't1', callId: 'd1', input: 'child task' })
        );

        const row = threadRows(turn)[0];
        row.querySelector<HTMLButtonElement>(':scope > .thread-tile > .thread-select')?.click();

        const actions = row.querySelector<HTMLElement>('.agent-answer-actions');
        // No completed answer yet: the chevron is the whole row, pinned right by CSS.
        expect(footerOrder(actions ?? null)).toEqual(['answer-collapse']);

        turn.apply(withThread({ type: 'text', agent: 'helper', delta: '# child answer' }, { id: 't1' }));
        turn.apply(withThread({ type: 'done', agent: 'helper', message: doneMessage('helper') }, { id: 't1' }));

        // R5: copy FIRST (left), chevron LAST (right).
        expect(footerOrder(actions ?? null)).toEqual(['text-copy answer-copy', 'answer-collapse']);
        expect(actions?.firstElementChild?.classList.contains('answer-copy')).toBe(true);
        expect(actions?.lastElementChild?.className).toBe('answer-collapse');
        expect(css).toContain('margin-left: auto');
    });

    it('collapses an expanded thread in place, and never re-opens it', () => {
        const { board } = mount();
        const turn = board.begin('delegate');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply(delegateCall('helper', 'child task', 'd1'));
        turn.apply(
            withThread({ type: 'start', agent: 'helper', model: 'h1' }, { id: 't1', callId: 'd1', input: 'child task' })
        );

        const row = threadRows(turn)[0];
        const tile = row.querySelector<HTMLElement>(':scope > .thread-tile') as HTMLElement;
        const chevron = rowChevron(row);
        // The HEADER expands (unchanged behaviour: the whole row is the toggle).
        row.querySelector<HTMLButtonElement>(':scope > .thread-tile > .thread-select')?.click();
        expect(row.classList.contains('is-expanded')).toBe(true);
        expect(tile.classList.contains('is-expanded')).toBe(true);
        expect(row.querySelector('.thread-select')?.getAttribute('aria-expanded')).toBe('true');

        // The CHEVRON closes it, and nothing else: the parent tile keeps its own state.
        chevron?.click();
        expect(row.classList.contains('is-expanded')).toBe(false);
        expect(tile.classList.contains('is-expanded')).toBe(false);
        expect(row.querySelector('.thread-select')?.getAttribute('aria-expanded')).toBe('false');
        expect(turn.element.classList.contains('is-expanded')).toBe(true);
        expect(board.expanded()).toBe(turn);
        // The label and ARIA are constants, so they are simply still what they were.
        expect(chevronState(chevron)).toEqual({
            expanded: 'true',
            label: 'Collapse thread',
            title: 'Collapse thread',
            controls: row.querySelector<HTMLElement>('.thread-body')?.id,
            type: 'button'
        });

        // T7: the chevron is collapse-ONLY. jsdom still dispatches a click on a
        // `display: none` node, so this proves the handler itself never toggles: a second
        // press cannot re-open the card the reader just closed.
        chevron?.click();
        expect(row.classList.contains('is-expanded')).toBe(false);

        // And the header row re-opens it.
        row.querySelector<HTMLButtonElement>(':scope > .thread-tile > .thread-select')?.click();
        expect(row.classList.contains('is-expanded')).toBe(true);
    });

    it('collapses the root conversation through the board, and never re-opens it', () => {
        const { board, focused } = mount();
        const turn = board.begin('ask');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        const chevron = rootChevron(turn);
        expect(board.expanded()).toBe(turn);
        expect(board.focusedThread()).toBeUndefined();
        const reports = focused.length;

        chevron?.click();
        // The same transition the tile header performs: the conversation closes AND a
        // collapse is a deliberate unfocus (T12). That board-level focus change is the
        // ROOT's own semantics, not the chevron inventing any routing of its own.
        expect(turn.element.classList.contains('is-expanded')).toBe(false);
        expect(turn.element.querySelector('.tile-select')?.getAttribute('aria-expanded')).toBe('false');
        expect(board.expanded()).toBeUndefined();
        expect(focused.length).toBeGreaterThan(reports);
        expect(focused[focused.length - 1]).toBeUndefined();
        expect(chevronState(chevron)?.label).toBe('Collapse conversation');

        // Collapse-only, idempotent: a second press cannot re-open the conversation …
        chevron?.click();
        expect(turn.element.classList.contains('is-expanded')).toBe(false);
        // … and the header row does.
        turn.element.querySelector<HTMLButtonElement>(':scope > .tile-select')?.click();
        expect(turn.element.classList.contains('is-expanded')).toBe(true);
        expect(board.expanded()).toBe(turn);
    });

    it('never moves board focus or the composer target when a persistent child collapses', () => {
        const { board, focused } = mount();
        board.setThreads(rosterWithChild());
        board.hydrate([
            serverTurn({
                id: 'turn-1',
                index: 0,
                threadId: 'thread-root',
                status: 'running',
                events: childEvents()
            })
        ]);

        const row = threadRows(board.turns()[0])[0];
        if (row === undefined) throw new Error(`no rows; html=${board.element.innerHTML.length}`);
        expect(row.dataset.persistentThread).toBe('thread-child');
        expect(board.focusedThread()).toBe('thread-root');

        // Opening a PERSISTENT child from its header focuses that conversation (S2).
        row.querySelector<HTMLButtonElement>(':scope > .thread-tile > .thread-select')?.click();
        expect(board.focusedThread()).toBe('thread-child');
        expect(row.classList.contains('is-expanded')).toBe(true);
        const reports = focused.length;

        // The footer chevron closes the card IN PLACE: the composer still targets
        // `thread-child`, and no focus change is reported at all.
        rowChevron(row)?.click();
        expect(row.classList.contains('is-expanded')).toBe(false);
        expect(board.focusedThread()).toBe('thread-child');
        expect(focused).toHaveLength(reports);
    });

    it('follows a board-driven implicit open, with the same constant contract', () => {
        const { board } = mount();
        board.setThreads(rosterWithChild());
        board.hydrate([
            serverTurn({
                id: 'turn-1',
                index: 0,
                threadId: 'thread-root',
                status: 'running',
                events: childEvents()
            })
        ]);

        const row = threadRows(board.turns()[0])[0];
        const chevron = rowChevron(row);
        // Focusing the CHILD conversation opens its card without a click on this surface
        // (`openEnclosingCards` / `focusChildThread` drive the model). The chevron needed
        // no repaint to become truthful: the body it sits in is what shows it.
        expect(board.focusThread('thread-child')).toBe(true);
        expect(row.classList.contains('is-expanded')).toBe(true);
        expect(chevronState(chevron)?.label).toBe('Collapse thread');

        // And it closes that implicitly-opened card like any other.
        chevron?.click();
        expect(row.classList.contains('is-expanded')).toBe(false);
        expect(chevronState(chevron)?.label).toBe('Collapse thread');
    });

    it('mints a fresh chevron with the same contract after a projection rebuild', () => {
        const { board } = mount();
        const turn = board.begin('rebuild');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply(delegateCall('helper', 'child task', 'd1'));
        turn.apply(
            withThread({ type: 'start', agent: 'helper', model: 'h1' }, { id: 't1', callId: 'd1', input: 'child task' })
        );

        const before = threadRows(turn)[0];
        before.querySelector<HTMLButtonElement>(':scope > .thread-tile > .thread-select')?.click();
        const stale = rowChevron(before);
        expect(stale).not.toBeNull();

        // A DISAGREEING prefix forces `resetProjection`: the row, the root section and
        // both chevrons below are NEW elements. Nothing may be left over from the
        // discarded projection (a header chevron once was; now every chevron is inside the
        // flow / body that gets replaced).
        turn.merge({
            ...serverTurn({
                status: 'running',
                events: [
                    { type: 'start', agent: 'writer', model: 'm1' } as HarnessEvent,
                    delegateCall('helper', 'child task', 'd1'),
                    withThread(
                        { type: 'start', agent: 'helper', model: 'h1' },
                        { id: 't1', callId: 'd1', input: 'changed by the record' }
                    )
                ]
            }),
            updatedAt: 11
        });

        const after = threadRows(turn)[0];
        expect(after).not.toBe(before);
        expect(after.classList.contains('is-expanded')).toBe(true);
        const fresh = rowChevron(after);
        expect(fresh).not.toBe(stale);
        expect(after.querySelectorAll('.answer-collapse')).toHaveLength(1);
        expect(chevronState(fresh)).toEqual({
            expanded: 'true',
            label: 'Collapse thread',
            title: 'Collapse thread',
            controls: after.querySelector<HTMLElement>('.thread-body')?.id,
            type: 'button'
        });

        // The root conversation, whose section was re-created too: one chevron, still
        // open, still collapse-only.
        expect(turn.element.querySelectorAll('.answer-collapse')).toHaveLength(1);
        expect(board.element.querySelectorAll('.header-collapse')).toHaveLength(0);
        expect(turn.element.classList.contains('is-expanded')).toBe(true);
        expect(chevronState(rootChevron(turn))?.label).toBe('Collapse conversation');
        fresh?.click();
        expect(after.classList.contains('is-expanded')).toBe(false);
        rootChevron(turn)?.click();
        expect(turn.element.classList.contains('is-expanded')).toBe(false);
    });

    it('is an icon-only, keyboard-reachable control that stays enabled while streaming', () => {
        const { board } = mount();
        const turn = board.begin('stream');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply({ type: 'text', agent: 'writer', delta: 'still streaming' });
        turn.apply(delegateCall('helper', 'child task', 'd1'));
        turn.apply(
            withThread({ type: 'start', agent: 'helper', model: 'h1' }, { id: 't1', callId: 'd1', input: 'child task' })
        );
        turn.flush();
        expect(turn.state()).toBe('streaming');

        // The shape contract applies to BOTH owners: the root conversation's chevron and
        // the nested card's. A running block is exactly when a reader most wants to close
        // the transcript they are looking at, so neither may be disabled.
        const chevrons = [rootChevron(turn), rowChevron(threadRows(turn)[0])];
        expect(chevrons.every((button) => button !== null)).toBe(true);

        for (const button of chevrons) {
            // Icon-only, exactly like the copy button: no visible word of its own.
            expect(button?.textContent).toBe('');
            const icon = button?.querySelector('svg');
            expect(icon?.getAttribute('aria-hidden')).toBe('true');
            expect(icon?.getAttribute('viewBox')).toBe('0 0 24 24');
            // ONE down-pointing path, rotated to face UP by CSS (the button is always
            // `aria-expanded="true"`), sized from the 24px box (styles.css).
            expect(icon?.querySelector('path')?.getAttribute('d')).toBe('M6 9l6 6 6-6');
            expect(button?.children).toHaveLength(1);
            // No nested interactive content anywhere inside it.
            expect(button?.querySelector('button, a, input, select')).toBeNull();

            // A real <button> (Enter/Space are native), in the tab order, never disabled — a
            // reader closes a running block without waiting for it to settle.
            expect(button?.type).toBe('button');
            expect(button?.disabled).toBe(false);
            expect(button?.hasAttribute('tabindex')).toBe(false);
            expect(button?.hasAttribute('aria-disabled')).toBe(false);
            expect(button?.getAttribute('role')).toBeNull();
        }

        // The 24px footprint the contract relies on is a stylesheet fact jsdom cannot
        // compute, so it is pinned against the source like ui/agent-answer-style.test.ts.
        expect(css).toMatch(
            /\.agent-answer-actions \.answer-collapse \{[^}]*width: 24px;[^}]*height: 24px;/s
        );
    });
});

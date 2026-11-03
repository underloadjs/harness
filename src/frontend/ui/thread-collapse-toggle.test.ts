// R5/T6: the Collapse/Expand chevrons of an agent block.
//
// Every block with a collapsible surface — a nested invocation card (`.thread-body`) and
// the root conversation (`.tile-body`) — owns TWO identical buttons, because one slot
// cannot serve both states: the footer control (`.answer-collapse`) sits where the Copy
// button used to be alone, INSIDE the body that a collapsed block hides with
// `display: none`, so it could only ever collapse; the header control
// (`.header-collapse`) sits immediately after the block's header button — a SIBLING of
// `.thread-select`/`.tile-select` inside `.thread-tile`/`.tile`, never nested in it,
// because the header is already a <button> — and renders only while the block is closed.
// styles.css shows exactly one of the pair per state, so one is never in the accessibility
// tree while the other is.
//
// What this file pins:
//   - ONE pair per nested thread and per root conversation, and NEITHER for a flat legacy
//     section (whose footer row therefore stays empty until an answer completes);
//   - both buttons always carry the same `aria-expanded`, state-aware `aria-label`/`title`,
//     `data-expanded` and `aria-controls`, read from the OWNER of the state (the entry for
//     a child card, the board for the root conversation) — at creation, on a click, on an
//     implicit board-driven open, and after a projection rebuild replaced the buttons
//     (including: no stale duplicate left in the tile header);
//   - the click is an in-place expand/collapse: it never routes through `focusThread`, so
//     board focus and the composer target do not move, and the header chevron does not
//     fire the header button beside it;
//   - both are icon-only, focusable <button type="button"> controls that stay enabled while
//     streaming;
//   - the copy button stays FIRST in the footer row (left) and the footer chevron LAST.
//
// jsdom cannot lay the transcript out, so the CSS facts this contract depends on (which
// chevron is rendered per state, and the header padding that keeps the measurement line
// clear of the chevron) are asserted against the stylesheet SOURCE, like
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

// A child invocation joined to a PERSISTENT conversation through the roster. Only a
// joined entry routes a HEADER CLICK into `focusThread`, which is what makes it the right
// surface for proving that NEITHER chevron does.
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

// The two slots, for each owner. Scoped to the OWNING surface (`:scope >`), so a nested
// card's controls are never counted as the parent's.
const rootFooter = (turn: TurnHandle): HTMLButtonElement | null =>
    turn.element.querySelector<HTMLButtonElement>('.tile-flow .agent-answer-actions .answer-collapse');

const rootHeader = (turn: TurnHandle): HTMLButtonElement | null =>
    turn.element.querySelector<HTMLButtonElement>(':scope > .header-collapse');

const rowFooter = (row: HTMLElement): HTMLButtonElement | null =>
    row.querySelector<HTMLButtonElement>(':scope > .thread-tile > .thread-body .answer-collapse');

const rowHeader = (row: HTMLElement): HTMLButtonElement | null =>
    row.querySelector<HTMLButtonElement>(':scope > .thread-tile > .header-collapse');

const childFooter = (turn: TurnHandle): HTMLButtonElement | null => rowFooter(threadRows(turn)[0]);
const childHeader = (turn: TurnHandle): HTMLButtonElement | null => rowHeader(threadRows(turn)[0]);

// The footer's control order, as class names: the exact R5 contract.
const footerOrder = (actions: Element | null): string[] =>
    [...((actions as HTMLElement | null)?.children ?? [])].map((node) => node.className);

// Every state-bearing attribute of one chevron, so a pair can be compared as a whole.
const chevronState = (button: HTMLButtonElement | null) => ({
    expanded: button?.getAttribute('aria-expanded'),
    label: button?.getAttribute('aria-label'),
    title: button?.title,
    data: button?.dataset.expanded,
    controls: button?.getAttribute('aria-controls'),
    type: button?.type
});

describe('block collapse chevrons (R5/T6)', () => {
    it('gives the root conversation and each nested thread exactly one pair', () => {
        const { board } = mount();
        const turn = board.begin('delegate');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply(delegateCall('helper', 'child task', 'd1'));
        turn.apply(
            withThread({ type: 'start', agent: 'helper', model: 'h1' }, { id: 't1', callId: 'd1', input: 'child task' })
        );

        const row = threadRows(turn)[0];
        const tile = row.querySelector<HTMLElement>(':scope > .thread-tile') as HTMLElement;
        // ONE of each, per block, each in its own slot.
        expect(turn.element.querySelectorAll('.tile-flow .answer-collapse')).toHaveLength(1);
        expect(turn.element.querySelectorAll(':scope > .header-collapse')).toHaveLength(1);
        expect(tile.querySelectorAll(':scope > .thread-body .answer-collapse')).toHaveLength(1);
        expect(tile.querySelectorAll(':scope > .header-collapse')).toHaveLength(1);
        // Four distinct buttons: the child never borrows the root's controls.
        expect(new Set([rootFooter(turn), rootHeader(turn), childFooter(turn), childHeader(turn)]).size).toBe(4);

        // T6: the header chevron is the header BUTTON's next sibling — inside the block
        // surface, and never nested inside the button (interactive content cannot nest).
        const rootSelect = turn.element.querySelector<HTMLElement>(':scope > .tile-select');
        expect(rootSelect?.nextElementSibling?.className).toBe('header-collapse');
        expect(rootSelect?.contains(turn.element.querySelector('.header-collapse') as Node)).toBe(false);

        const threadSelect = tile.querySelector<HTMLElement>(':scope > .thread-select');
        expect(threadSelect?.nextElementSibling?.className).toBe('header-collapse');
        expect(threadSelect?.contains(tile.querySelector('.header-collapse') as Node)).toBe(false);
    });

    it('paints both chevrons from the surface they control', () => {
        const { board } = mount();
        const turn = board.begin('delegate');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply(delegateCall('helper', 'child task', 'd1'));
        turn.apply(
            withThread({ type: 'start', agent: 'helper', model: 'h1' }, { id: 't1', callId: 'd1', input: 'child task' })
        );

        // `begin` expands the tile, and the root section is created AFTER that — so both
        // buttons must already read the live board state at creation, not a constant.
        const rootBodyId = turn.element.querySelector<HTMLElement>('.tile-body')?.id;
        expect(rootFooter(turn)).not.toBeNull();
        expect(chevronState(rootFooter(turn))).toEqual({
            expanded: 'true',
            label: 'Collapse conversation',
            title: 'Collapse conversation',
            data: 'true',
            controls: rootBodyId,
            type: 'button'
        });
        // Identical truth in the collapsed slot: CSS decides which one is rendered, the
        // ARIA never waits for it.
        expect(chevronState(rootHeader(turn))).toEqual(chevronState(rootFooter(turn)));

        // A nested card starts collapsed: both of its buttons offer the OTHER verb.
        const childBodyId = threadRows(turn)[0].querySelector<HTMLElement>('.thread-body')?.id;
        expect(chevronState(childFooter(turn))).toEqual({
            expanded: 'false',
            label: 'Expand thread',
            title: 'Expand thread',
            data: 'false',
            controls: childBodyId,
            type: 'button'
        });
        expect(chevronState(childHeader(turn))).toEqual(chevronState(childFooter(turn)));
        // The relation points at a REAL body, and both buttons name the same one.
        expect(rootBodyId).toBeTruthy();
        expect(childBodyId).toBeTruthy();
        expect(rootBodyId).not.toBe(childBodyId);
        // ... which is also the body the block's HEADER BUTTON controls: the pair and the
        // header describe one surface, three ways.
        expect(rootHeader(turn)?.getAttribute('aria-controls')).toBe(
            turn.element.querySelector('.tile-select')?.getAttribute('aria-controls')
        );
        const childRow = threadRows(turn)[0];
        expect(rowHeader(childRow)?.getAttribute('aria-controls')).toBe(
            childRow.querySelector('.thread-select')?.getAttribute('aria-controls')
        );
    });

    it('leaves a flat legacy section without either chevron', () => {
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
        expect(agents[1].querySelector('.header-collapse')).toBeNull();
        // The completed answer is the ONLY control it can ever hold, so the row is a
        // single child and the `:empty` rule still describes the pre-answer state.
        expect(footerOrder(flat ?? null)).toEqual(['text-copy answer-copy']);
        // The root block (the primary section) DOES own a surface, so it keeps its pair.
        expect(agents[0].querySelector('.answer-collapse')).not.toBeNull();
        expect(turn.element.querySelectorAll(':scope > .header-collapse')).toHaveLength(1);
    });

    it('keeps the copy button before the footer chevron, and the chevron alone before an answer', () => {
        const { board } = mount();
        const turn = board.begin('delegate');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply(delegateCall('helper', 'child task', 'd1'));
        turn.apply(
            withThread({ type: 'start', agent: 'helper', model: 'h1' }, { id: 't1', callId: 'd1', input: 'child task' })
        );

        const row = threadRows(turn)[0];
        row.querySelector<HTMLButtonElement>('.thread-select')?.click();

        const actions = row.querySelector<HTMLElement>('.agent-answer-actions');
        // No completed answer yet: the chevron is the whole row, pinned right by CSS.
        expect(footerOrder(actions ?? null)).toEqual(['answer-collapse']);

        turn.apply(withThread({ type: 'text', agent: 'helper', delta: '# child answer' }, { id: 't1' }));
        turn.apply(withThread({ type: 'done', agent: 'helper', message: doneMessage('helper') }, { id: 't1' }));

        // R5: copy FIRST (left), chevron LAST (right).
        expect(footerOrder(actions ?? null)).toEqual(['text-copy answer-copy', 'answer-collapse']);
        expect(actions?.firstElementChild?.classList.contains('answer-copy')).toBe(true);
        expect(actions?.lastElementChild?.classList.contains('answer-collapse')).toBe(true);
        // The header chevron is NOT part of that row (different slot, different state).
        expect(actions?.querySelector('.header-collapse')).toBeNull();
    });

    it('collapses an expanded thread with the footer chevron and re-opens it with the header one', () => {
        const { board } = mount();
        const turn = board.begin('delegate');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply(delegateCall('helper', 'child task', 'd1'));
        turn.apply(
            withThread({ type: 'start', agent: 'helper', model: 'h1' }, { id: 't1', callId: 'd1', input: 'child task' })
        );

        const row = threadRows(turn)[0];
        const tile = row.querySelector<HTMLElement>(':scope > .thread-tile') as HTMLElement;
        const footer = rowFooter(row);
        const header = rowHeader(row);
        row.querySelector<HTMLButtonElement>(':scope > .thread-tile > .thread-select')?.click();
        expect(row.classList.contains('is-expanded')).toBe(true);
        expect(chevronState(footer)?.expanded).toBe('true');
        expect(chevronState(header)?.expanded).toBe('true');

        // The click closes THIS card only: the parent tile keeps its own state.
        footer?.click();
        expect(row.classList.contains('is-expanded')).toBe(false);
        expect(tile.classList.contains('is-expanded')).toBe(false);
        for (const state of [chevronState(footer), chevronState(header)]) {
            expect(state).toEqual({
                expanded: 'false',
                label: 'Expand thread',
                title: 'Expand thread',
                data: 'false',
                controls: row.querySelector<HTMLElement>('.thread-body')?.id,
                type: 'button'
            });
        }
        // The header's own ARIA moves with it — one state, three surfaces.
        expect(row.querySelector('.thread-select')?.getAttribute('aria-expanded')).toBe('false');
        expect(turn.element.classList.contains('is-expanded')).toBe(true);
        expect(board.expanded()).toBe(turn);

        // T6: this is the state the footer control could never serve — the body that
        // holds it (and therefore the button itself) is hidden by
        // `.thread-row:not(.is-expanded) .thread-body { display: none }`. The header
        // chevron is the one a collapsed card renders.
        expect(css).toContain('.thread-row:not(.is-expanded) .thread-body');
        header?.click();
        expect(row.classList.contains('is-expanded')).toBe(true);
        expect(tile.classList.contains('is-expanded')).toBe(true);
        expect(chevronState(header)?.label).toBe('Collapse thread');
        expect(chevronState(footer)?.label).toBe('Collapse thread');
        expect(row.querySelector('.thread-select')?.getAttribute('aria-expanded')).toBe('true');
        // Re-opening a child card never touches the board's expanded turn.
        expect(board.expanded()).toBe(turn);
    });

    it('collapses and re-expands the root conversation through the board', () => {
        const { board } = mount();
        const turn = board.begin('ask');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        const footer = rootFooter(turn);
        const header = rootHeader(turn);
        expect(board.expanded()).toBe(turn);

        // The footer chevron collapses (a deliberate unfocus, exactly like the header).
        footer?.click();
        expect(turn.element.classList.contains('is-expanded')).toBe(false);
        expect(turn.element.querySelector('.tile-select')?.getAttribute('aria-expanded')).toBe('false');
        for (const state of [chevronState(footer), chevronState(header)]) {
            expect(state?.expanded).toBe('false');
            expect(state?.label).toBe('Expand conversation');
            expect(state?.title).toBe('Expand conversation');
            expect(state?.data).toBe('false');
        }
        expect(board.expanded()).toBeUndefined();

        // T6: and the HEADER chevron re-opens it — the state a collapsed tile renders
        // (`.tile:not(.is-expanded) .tile-body { display: none }`).
        header?.click();
        expect(turn.element.classList.contains('is-expanded')).toBe(true);
        expect(turn.element.querySelector('.tile-select')?.getAttribute('aria-expanded')).toBe('true');
        expect(chevronState(header)?.label).toBe('Collapse conversation');
        expect(chevronState(footer)?.label).toBe('Collapse conversation');
        expect(board.expanded()).toBe(turn);
    });

    it('never moves board focus or the composer target, from either chevron', () => {
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
        const reports = focused.length;

        // T6: opening a PERSISTENT child from its header CHEVRON expands the card without
        // focusing the conversation — the header BUTTON next to it does exactly the
        // opposite (S2), and that routing is deliberately not inherited.
        rowHeader(row)?.click();
        expect(row.classList.contains('is-expanded')).toBe(true);
        expect(board.focusedThread()).toBe('thread-root');
        expect(focused).toHaveLength(reports);

        // The HEADER click still routes focus (unchanged behaviour).
        row.querySelector<HTMLButtonElement>(':scope > .thread-tile > .thread-select')?.click();
        expect(board.focusedThread()).toBe('thread-child');
        expect(focused.length).toBeGreaterThan(reports);
        const afterFocus = focused.length;

        // And the FOOTER chevron closes the card without re-targeting the composer.
        rowFooter(row)?.click();
        expect(row.classList.contains('is-expanded')).toBe(false);
        expect(board.focusedThread()).toBe('thread-child');
        expect(focused).toHaveLength(afterFocus);
    });

    it('keeps both chevrons truthful after a projection rebuild', () => {
        const { board } = mount();
        const turn = board.begin('rebuild');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply(delegateCall('helper', 'child task', 'd1'));
        turn.apply(
            withThread({ type: 'start', agent: 'helper', model: 'h1' }, { id: 't1', callId: 'd1', input: 'child task' })
        );

        const before = threadRows(turn)[0];
        before.querySelector<HTMLButtonElement>(':scope > .thread-tile > .thread-select')?.click();
        expect(chevronState(rowHeader(before))?.expanded).toBe('true');

        // A DISAGREEING prefix forces `resetProjection`: the row, the root section and all
        // FOUR chevrons below are NEW elements.
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
        // The rebuilt child: exactly ONE header chevron (the discarded row went with its
        // own), and both buttons read the restored state.
        const childTile = after.querySelector<HTMLElement>(':scope > .thread-tile') as HTMLElement;
        expect(childTile.querySelectorAll(':scope > .header-collapse')).toHaveLength(1);
        expect(chevronState(rowHeader(after))).toEqual({
            expanded: 'true',
            label: 'Collapse thread',
            title: 'Collapse thread',
            data: 'true',
            controls: after.querySelector<HTMLElement>('.thread-body')?.id,
            type: 'button'
        });
        expect(chevronState(rowFooter(after))).toEqual(chevronState(rowHeader(after)));
        expect(rowHeader(after)).not.toBe(rowHeader(before));

        // Same for the root conversation, whose section was re-created too. The header
        // chevron lives OUTSIDE `.tile-flow`, so the rebuild must not leave the discarded
        // one in the header row: that would be two chevrons, the older one frozen.
        expect(turn.element.classList.contains('is-expanded')).toBe(true);
        expect(turn.element.querySelectorAll(':scope > .header-collapse')).toHaveLength(1);
        expect(chevronState(rootHeader(turn))).toEqual({
            expanded: 'true',
            label: 'Collapse conversation',
            title: 'Collapse conversation',
            data: 'true',
            controls: turn.element.querySelector<HTMLElement>('.tile-body')?.id,
            type: 'button'
        });
        expect(chevronState(rootFooter(turn))).toEqual(chevronState(rootHeader(turn)));
    });

    it('follows an implicit open from the board, not only a click', () => {
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
        expect(chevronState(rowFooter(row))?.expanded).toBe('false');
        expect(chevronState(rootHeader(board.turns()[0]))?.expanded).toBe('true');

        // Focusing the CHILD conversation opens its card without ANY click on this surface
        // (`openEnclosingCards` / `focusChildThread` drive the model), and it closes the
        // parent tile in the same move. All four buttons must follow.
        expect(board.focusThread('thread-child')).toBe(true);
        expect(row.classList.contains('is-expanded')).toBe(true);
        expect(chevronState(rowFooter(row))?.label).toBe('Collapse thread');
        expect(chevronState(rowHeader(row))?.label).toBe('Collapse thread');
        expect(chevronState(rootFooter(board.turns()[0]))?.expanded).toBe('false');
        expect(chevronState(rootHeader(board.turns()[0]))?.label).toBe('Expand conversation');
    });

    it('is an icon-only, keyboard-reachable control that stays enabled while streaming', () => {
        const { board } = mount();
        const turn = board.begin('stream');

        turn.apply({ type: 'start', agent: 'writer', model: 'm1' });
        turn.apply({ type: 'text', agent: 'writer', delta: 'still streaming' });
        turn.flush();
        expect(turn.state()).toBe('streaming');

        for (const button of [rootFooter(turn), rootHeader(turn)]) {
            expect(button).not.toBeNull();
            // Icon-only, exactly like the copy button: no visible word of its own.
            expect(button?.textContent).toBe('');
            const icon = button?.querySelector('svg');
            expect(icon?.getAttribute('aria-hidden')).toBe('true');
            expect(icon?.getAttribute('viewBox')).toBe('0 0 24 24');
            expect(icon?.querySelector('path')?.getAttribute('d')).toBe('M6 9l6 6 6-6');
            // ONE glyph child, so the accessible name is the label and nothing else — and
            // no nested interactive content anywhere inside it.
            expect(button?.children).toHaveLength(1);
            expect(button?.querySelector('button, a, input, select')).toBeNull();

            // A real <button> (Enter/Space are native), in the tab order, never disabled —
            // a reader collapses or re-opens a running conversation without waiting.
            expect(button?.type).toBe('button');
            expect(button?.disabled).toBe(false);
            expect(button?.hasAttribute('tabindex')).toBe(false);
            expect(button?.hasAttribute('aria-disabled')).toBe(false);
            expect(button?.getAttribute('role')).toBeNull();
        }
    });

    it('renders exactly one chevron per state, and reserves the header row for it', () => {
        // jsdom cannot compute the cascade, so the pair's exclusivity is pinned from the
        // stylesheet source: the header control is hidden by default and shown ONLY while
        // the block is collapsed, and the footer control is hidden while it is collapsed.
        expect(css).toContain(':is(.tile, .thread-tile) > .header-collapse {');
        expect(css).toContain(':is(.tile, .thread-tile):not(.is-expanded) > .header-collapse {');
        expect(css).toContain(
            ':is(.tile:not(.is-expanded) > .tile-body, .thread-tile:not(.is-expanded) > .thread-body) .answer-collapse {'
        );
        // The collapsed header reserves 10px padding + the 24px button + a 10px gap, so
        // the flush-right measurement line (`.tile-top`/`.thread-top`) is never under it.
        expect(css).toContain(
            ':is(.tile:not(.is-expanded), .thread-tile:not(.is-expanded)) > :is(.tile-select, .thread-select) {'
        );
        expect(css).toContain('padding-right: 44px');
        // T12b: an open CONVERSATION already renders every exchange's body, so there the
        // footer chevron renders and the header one gives its slot back.
        expect(css).toContain('.conversation.is-expanded > .turn-row > .tile > .header-collapse {');
        expect(css).toContain('.conversation.is-expanded > .turn-row > .tile > .tile-body .answer-collapse {');
    });
});

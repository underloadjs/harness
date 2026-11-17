// T-W3/F7 — a SOFT-DELETED conversation stops owning rows on the board.
//
// THE ARTIFACT (session a4a6f913-d8b4-436d-98c4-b9b0059b30cb, dump analyzed in
// Temp/orch-plan/report.md §2/§5): thread-13 is the live host conversation and
// thread-14/15/16/17 ran under it. thread-15/16/17 carry `inactive:true`
// (`SessionStore.deleteThread` writes the marker and RETAINS the row, so the transcript's
// turns and the invocation rows stay), while thread-13 and thread-14 do not. The board
// kept rendering rows for WE7/WE8/RR2 — runs of conversations the server had deleted —
// next to the live conversation's own card.
//
// WHAT THE CLIENT CAN KNOW (and this is the honest limit, stated once here rather than
// in every assertion): the roster the board receives is FILTERED
// (`threadRoster`, src/server/sessions.ts — `record.inactive !== true`), so a deletion
// arrives either as a row the roster STILL ships stamped `inactive`, or, on today's wire,
// only as an id the next roster stops naming. The second is a REMOVAL join — the same
// evidence the board already accepts for its invocation→thread cache
// (`forgetRemovedThreads`, ./turns.ts) — and it needs the previous roster to compare
// against, which is why the verdict is drawn in ./threads.ts (`rosterDeletionsOf`) and
// accumulated in a board-scoped ledger (./turns.ts `deletedThreads`).
//
// What each assertion is accountable for:
//   1. a live conversation's invocation row renders normally (the control case);
//   2. the roster frame that DROPS an id hides that conversation's row — HIDDEN, not
//      removed: `data-deleted` stays inspectable, `data-persistent-thread` stays so a
//      resume can restore the very same row, and the compiled ops plane still addresses
//      the section (a `section:set` after a removal would re-mint a deleted row);
//   3. a roster that names the conversation again WITHOUT the marker brings the row back
//      (a resume puts the row back in the roster — the verdict is re-derived, never
//      remembered past the server's word);
//   4. the marker itself is evidence on a FIRST roster, which is the only way a reload —
//      a board that never saw the conversation live — can hide the row at all;
//   5. an invocation the roster never joined is never hidden: that is the placeholder the
//      board legitimately renders, not a deletion verdict.
//
// T-W6 CLOSED THE RELOAD GAP THE FIRST PASS COULD NOT REACH. The marker of (4) cannot arrive on a
// roster row on today's wire: `threadRoster` (src/server/sessions.ts:4893, mirrored by
// ../server/api.ts `threadRecordsOf` :4834) hides a retired row entirely, so the deletion travels on
// the SESSION HEADER — REST `SessionResource.inactive_thread_ids` → `SessionView.inactiveThreads`
// (../server/protocol.ts:964) — and ./threads.ts `sessionThreadsOf` turns membership into the marker.
// The last describe below drives THAT chain end to end: a generated-style metadata row through
// `sessionViewOf`, the roster page WITHOUT the retired conversation, and the turn's compiled tree
// naming the thread on its delegated section (R18, ../shared/turn-display.ts:1045 — the join a reload
// has instead of a roster row).
//
// Run: yarn vitest run --config src/frontend/vitest.config.ts ui/turns-deleted-threads.test.ts

import type { HarnessAssistantMessage, HarnessEvent, SessionTurn, SessionView } from '../../server/protocol';
import type { SessionResource } from '../../shared/harness-api';
import type { DisplayTextNode, TurnDisplay, TurnSection, TurnSummary } from '../../shared/turn-display';
import type { SessionThreadEntry } from './threads';
import { sessionThreadsOf } from './threads';
// The one place `inactive_thread_ids` becomes `inactiveThreads` (./view-api.ts `sessionViewOf`), so the
// reload tests below start from the WIRE spelling rather than from a hand-made camelCase document.
import { sessionViewOf } from '../view-api';
import { createTurnBoard } from './turns';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const doneMessage = (agent: string): HarnessAssistantMessage => ({
    role: 'assistant',
    content: 'answer',
    reasoning: '',
    toolCalls: [],
    model: `${agent}-model`,
    stopReason: 'stop'
});

const withThread = (event: Record<string, unknown>, thread: Record<string, unknown>): HarnessEvent =>
    ({ ...event, thread }) as unknown as HarnessEvent;

const threadEntry = (overrides: Partial<SessionThreadEntry> & { id: string }): SessionThreadEntry => ({
    agent: 'Researcher',
    origin: 'host',
    status: 'idle',
    sequence: 1,
    ...overrides
});

const mount = () => {
    const board = createTurnBoard({});
    board.bindSession('s1');
    document.body.replaceChildren(board.element);

    return board;
};

// One host-thread RUN: metadata-only thread frames (no parent/callId/kind/branch), the
// wire shape the runtime emits for the conversation's own flow.
const hostRun = (invocation: string, input: string, answer: string): HarnessEvent[] => [
    withThread({ type: 'start', agent: 'Researcher', model: 'r1' }, { id: invocation, input }),
    withThread({ type: 'text', agent: 'Researcher', delta: answer }, { id: invocation }),
    withThread({ type: 'done', agent: 'Researcher', message: doneMessage('Researcher') }, { id: invocation })
];

// A delegation: the parent's `tool_call`, then the child's own frames naming the parent
// INVOCATION and the spawning call.
const delegated = (
    callId: string,
    agent: string,
    input: string,
    invocation: string,
    parentInvocation: string
): HarnessEvent[] => [
    {
        type: 'tool_call',
        agent: 'Researcher',
        call: { id: callId, name: 'delegate', arguments: JSON.stringify({ agent, input }) }
    } as HarnessEvent,
    withThread(
        { type: 'start', agent, model: 'w1' },
        { id: invocation, parentId: parentInvocation, callId, kind: 'delegation', input }
    ),
    withThread(
        { type: 'text', agent, delta: `${agent} answer` },
        { id: invocation, parentId: parentInvocation, callId, kind: 'delegation' }
    ),
    withThread(
        { type: 'done', agent, message: doneMessage(agent) },
        { id: invocation, parentId: parentInvocation, callId, kind: 'delegation' }
    )
];

const hostTurn = (overrides: Partial<SessionTurn> & { id: string; index: number }): SessionTurn => ({
    prompt: 'go',
    status: 'done',
    startedAt: 1,
    updatedAt: 2,
    events: [],
    ...overrides
});

// The roster exactly as the server ships it while every conversation is live: the host
// plus the two children that ran under it, each anchored by its invocation id.
const liveRoster = (): SessionThreadEntry[] => [
    threadEntry({ id: 'thread-13', sequence: 1, label: 'IT4', invocationId: 'inv-13' }),
    threadEntry({
        id: 'thread-15',
        sequence: 2,
        label: 'WE7',
        agent: 'Workspace',
        ownerThreadId: 'thread-13',
        invocationId: 'inv-15'
    }),
    threadEntry({
        id: 'thread-16',
        sequence: 3,
        label: 'WE8',
        agent: 'Workspace',
        ownerThreadId: 'thread-13',
        invocationId: 'inv-16'
    })
];

// The host turn that spawned both children, as one recorded turn of thread-13.
const hostTurns = (): SessionTurn[] => [
    hostTurn({
        id: 'turn-1',
        index: 0,
        prompt: 'stress test the tools',
        threadId: 'thread-13',
        threadLabel: 'IT4',
        events: [
            ...hostRun('inv-13', 'stress test the tools', 'the report'),
            ...delegated('call-15', 'Workspace', 'review read', 'inv-15', 'inv-13'),
            ...delegated('call-16', 'Workspace', 'review glob', 'inv-16', 'inv-13')
        ]
    })
];

// The invocation row of a persistent conversation, by the attribute the board paints from
// the roster join (the same handle ./turns.ts uses to keep a card addressable).
const rowFor = (board: ReturnType<typeof mount>, threadId: string): HTMLElement | null =>
    board.element.querySelector<HTMLElement>(`.thread-row[data-persistent-thread="${threadId}"]`);

const rowState = (
    board: ReturnType<typeof mount>,
    threadId: string
): [boolean, string | undefined, string | undefined] => {
    const row = rowFor(board, threadId);

    if (row === null) return [false, undefined, undefined];

    return [row.hidden, row.dataset.deleted, row.dataset.persistentThread];
};

// Every top-level card on the board, with its own visibility — the live conversation must
// keep rendering while a deleted one's rows go away.
const cardsOf = (board: ReturnType<typeof mount>): Array<[string | undefined, boolean]> =>
    [...board.element.querySelectorAll<HTMLElement>(':scope > .conversation')].map((host) => [
        host.dataset.threadId,
        host.hidden
    ]);

beforeEach(() => {
    document.body.innerHTML = '';
});

afterEach(() => {
    document.body.innerHTML = '';
});

describe('F7 — rows of a soft-deleted conversation', () => {
    it('renders every live conversation row normally', () => {
        const board = mount();

        board.setThreads(liveRoster());
        board.hydrate(hostTurns());

        // The control case: two child cards, joined, visible, and NOT carrying the verdict.
        expect(rowState(board, 'thread-15')).toEqual([false, undefined, 'thread-15']);
        expect(rowState(board, 'thread-16')).toEqual([false, undefined, 'thread-16']);
        expect(cardsOf(board)).toEqual([['thread-13', false]]);
    });

    it('hides the rows of a conversation the roster stops naming', () => {
        const board = mount();

        board.setThreads(liveRoster());
        board.hydrate(hostTurns());

        // The roster frame AFTER the soft delete: `threadRoster` filtered thread-15 out
        // (it stays in `core.threads`, marked `inactive`), so the only trace on the wire is
        // that the id is gone. thread-16 is still live and must not move.
        board.setThreads(liveRoster().filter((entry) => entry.id !== 'thread-15'));

        expect(rowState(board, 'thread-15')).toEqual([true, 'true', 'thread-15']);
        expect(rowState(board, 'thread-16')).toEqual([false, undefined, 'thread-16']);

        // HIDDEN, not removed: the host card still holds the deleted conversation's run
        // (its turns are retained), and the live conversation's own card is untouched.
        expect(cardsOf(board)).toEqual([['thread-13', false]]);
        expect(board.element.querySelectorAll<HTMLElement>('.thread-row').length).toBe(2);
    });

    it('brings the rows back when a resumed conversation is named live again', () => {
        const board = mount();

        board.setThreads(liveRoster());
        board.hydrate(hostTurns());
        board.setThreads(liveRoster().filter((entry) => entry.id !== 'thread-15'));

        expect(rowState(board, 'thread-15')).toEqual([true, 'true', 'thread-15']);

        // A resume re-ships the row WITHOUT the marker: the verdict is re-derived from the
        // roster, so the SAME row — with the transcript the reader had open — comes back.
        board.setThreads(liveRoster());

        expect(rowState(board, 'thread-15')).toEqual([false, undefined, 'thread-15']);
    });

    it('hides the rows on a reload, from the marker the roster ships', () => {
        const board = mount();

        // The reload path: this board never saw the conversation live, so the FIRST roster
        // is a baseline — the only evidence it can carry is the server's own marker.
        board.setThreads([
            threadEntry({ id: 'thread-13', sequence: 1, label: 'IT4', invocationId: 'inv-13' }),
            threadEntry({
                id: 'thread-15',
                sequence: 2,
                label: 'WE7',
                agent: 'Workspace',
                ownerThreadId: 'thread-13',
                invocationId: 'inv-15',
                deleted: true
            })
        ]);
        board.hydrate(hostTurns());

        expect(rowState(board, 'thread-15')).toEqual([true, 'true', 'thread-15']);

        // A baseline frame that simply OMITS an id is not evidence: thread-16 was never on
        // screen, so nothing decided about it, and a later roster naming it stays visible.
        board.setThreads([threadEntry({ id: 'thread-13', sequence: 1, label: 'IT4', invocationId: 'inv-13' })]);
        board.setThreads(liveRoster());

        expect(rowState(board, 'thread-16')).toEqual([false, undefined, 'thread-16']);
    });

    it('never hides an invocation the roster never joined', () => {
        const board = mount();

        // The roster names only the host, so the delegated runs have NO persistent thread
        // (the placeholder case the board legitimately renders for a conversation it was
        // never told about, ./threads.ts `UNKNOWN_THREAD_LABEL`).
        board.setThreads([threadEntry({ id: 'thread-13', sequence: 1, label: 'IT4', invocationId: 'inv-13' })]);
        board.hydrate(hostTurns());

        const rows = [...board.element.querySelectorAll<HTMLElement>('.thread-row')];

        expect(rows).toHaveLength(2);
        expect(rows.map((row) => [row.hidden, row.dataset.deleted, row.dataset.persistentThread])).toEqual([
            [false, undefined, undefined],
            [false, undefined, undefined]
        ]);
    });

    it('drops a session switch without carrying one session deletions into the next', () => {
        const board = mount();

        board.setThreads(liveRoster());
        board.hydrate(hostTurns());
        board.setThreads(liveRoster().filter((entry) => entry.id !== 'thread-15'));
        expect(rowState(board, 'thread-15')).toEqual([true, 'true', 'thread-15']);

        // Thread ids are unique per SESSION, so the ledger is board-scoped: a new session's
        // first roster is a baseline and may name `thread-15` as a live conversation again.
        board.bindSession('s2');
        board.setThreads(liveRoster());

        expect(rowState(board, 'thread-15')).toEqual([false, undefined, 'thread-15']);
    });
});

// ---------------------------------------------------------------------------
// T-W6: the RELOAD path — the deletion rides the SESSION HEADER and the roster never names it.
//
// Everything above draws the verdict from roster shapes. This describe drives the chain the browser
// actually runs on a page reload, starting from the WIRE spelling:
//   `GET /sessions/{id}`  →  `SessionResource.inactive_thread_ids`
//   ./view-api.ts `sessionViewOf`  →  `SessionView.inactiveThreads`
//   ./threads.ts `sessionThreadsOf`  →  a marked entry the roster never shipped
//   ./turns.ts `setThreads` + `hydrateView`  →  the retired conversation's rows stop rendering.
//
// The fixture is the artifact: thread-13 is the live host conversation, thread-15/16 are the
// delegated children recorded INSIDE its turn (so their rows survive a reload), and thread-15 is the
// retired one. The compiled tree names the persistent thread on each child section (R18), which is the
// join a reload has in place of a roster row — without it there would be no row to suppress.
// ---------------------------------------------------------------------------

const T = 1_700_000_000_000;

describe('F7 — a reload reads the deletion from the session header (T-W6)', () => {
    // `GET /sessions/{id}` as the generated contract answers it (../shared/harness-api.ts
    // `SessionResource`): retired ids beside the counters, and `thread_count` UNCHANGED — the row is
    // retained but stays out of the live roster, which is exactly why the deletion cannot ride on it.
    const sessionResource = (retired?: string[]): SessionResource =>
        ({
            id: 's1',
            harness: 'instruct',
            status: 'idle',
            model: 'm1',
            created_at: 1,
            updated_at: T,
            turn_count: 1,
            thread_count: 2,
            revision: 7,
            definition_revision: 1,
            agent_models: {},
            endpoint: { base_url: 'http://provider/v1', model: 'm1', has_api_key: false },
            runtime_execution: 'inline',
            pending_action_count: 0,
            created_tool_count: 0,
            created_tool_limit: 32,
            ...(retired === undefined ? {} : { inactive_thread_ids: retired })
        }) as SessionResource;

    // One row of the roster PAGE (`ThreadSummary`, camelCased by ./view-api.ts `threadRowOf`): the live
    // conversations in `sequence` order, each anchored by the invocation its compiled section names.
    const rosterRow = (id: string, agent: string, sequence: number, label: string, invocationId: string) => ({
        id,
        agent,
        origin: 'host' as const,
        status: 'idle' as const,
        sequence,
        label,
        invocationId,
        transcriptState: 'ok' as const,
        messageCount: 2,
        hasTranscript: true
    });

    const hostRow = () => rosterRow('thread-13', 'Instruct', 1, 'IT4', 'inv-13');
    const childRow = (id: string, label: string, invocationId: string, sequence: number) =>
        rosterRow(id, 'Workspace', sequence, label, invocationId);

    const answer = (id: string, text: string): DisplayTextNode => ({ kind: 'text', id, text, committed: true });

    const section = (overrides: Partial<TurnSection>): TurnSection => ({
        id: 'turn-1:0',
        role: 'primary',
        agent: 'Instruct',
        agentLabel: 'IT4',
        state: 'done',
        nodes: [answer('n1', 'the report')],
        ...overrides
    });

    // The turn's row (the `GET .../turns` page, projected) plus its compiled tree: one host turn that ran
    // WE7 (thread-15) and WE8 (thread-16) inside it.
    const turnRow: TurnSummary = {
        id: 'turn-1',
        index: 0,
        prompt: 'stress test the tools',
        status: 'done',
        state: 'done',
        threadId: 'thread-13',
        threadLabel: 'IT4',
        updatedAt: T,
        sectionCount: 3,
        stepCount: 0,
        activeAgents: [],
        blocks: []
    };

    const tree: TurnDisplay = {
        turnId: 'turn-1',
        sections: [
            section({ threadId: 'thread-13', invocationId: 'inv-13' }),
            section({
                id: 'turn-1:1',
                parentSectionId: 'turn-1:0',
                role: 'subagent',
                agent: 'Workspace',
                agentLabel: 'WE7',
                threadId: 'thread-15',
                invocationId: 'inv-15',
                nodes: [answer('n2', 'workspace answer')]
            }),
            section({
                id: 'turn-1:2',
                parentSectionId: 'turn-1:0',
                role: 'subagent',
                agent: 'Workspace',
                agentLabel: 'WE8',
                threadId: 'thread-16',
                invocationId: 'inv-16',
                nodes: [answer('n3', 'the second workspace answer')]
            })
        ]
    };

    // One assembled reload, composed the way ./view-api.ts `openSession` composes it: the header through
    // `sessionViewOf` (the ONLY place `inactive_thread_ids` is renamed), the roster page as `threadViews`,
    // the row window and the display trees. `rows` is whatever the roster filter left standing.
    const reloadView = (rows: ReturnType<typeof rosterRow>[], retired?: string[]): SessionView =>
        ({
            ...sessionViewOf(sessionResource(retired)),
            threadViews: rows,
            turns: [turnRow],
            displays: { 'turn-1': tree }
        }) as unknown as SessionView;

    // thread-15 retired: the roster page names only the host and thread-16.
    const deletedView = () => reloadView([hostRow(), childRow('thread-16', 'WE8', 'inv-16', 3)], ['thread-15']);

    it('suppresses the board rows of a conversation the roster never named', () => {
        const board = mount();
        const view = deletedView();

        // No previous roster, no marker on a row, nothing to diff: membership in
        // `inactive_thread_ids` is the only evidence this board can get, and it is enough on the
        // BASELINE frame — the roster-baseline path is not involved.
        board.setThreads(sessionThreadsOf(view));
        const [tile] = board.hydrateView(view);
        tile.flush();

        // HIDDEN, not removed: the row keeps `data-persistent-thread` (the compiled section's own join)
        // and `data-deleted` states the verdict, so a resume can restore this very row.
        expect(rowState(board, 'thread-15')).toEqual([true, 'true', 'thread-15']);

        // The live sibling and its card are untouched — the artifact showed WE8 next to WE7, and only
        // WE7 was gone.
        expect(rowState(board, 'thread-16')).toEqual([false, undefined, 'thread-16']);
        expect(cardsOf(board)).toEqual([['thread-13', false]]);
        expect(board.element.querySelectorAll<HTMLElement>('.thread-row').length).toBe(2);
    });

    it('brings the rows back when a resumed conversation is named live again', () => {
        const board = mount();
        const deleted = deletedView();

        board.setThreads(sessionThreadsOf(deleted));
        const [tile] = board.hydrateView(deleted);
        tile.flush();

        expect(rowState(board, 'thread-15')).toEqual([true, 'true', 'thread-15']);

        // THE REVIVAL. A host resume clears the store's retention ledger key AND the row marker in one
        // call (`reactivateThreadRow`, src/server/sessions.ts:5140-5163), so the next document names
        // thread-15 in the roster and stops naming it in `inactive_thread_ids`. The ledger is re-derived
        // from the newest roster, so the SAME row — with its recorded transcript — renders again.
        board.setThreads(
            sessionThreadsOf(
                reloadView([
                    hostRow(),
                    childRow('thread-15', 'WE7', 'inv-15', 2),
                    childRow('thread-16', 'WE8', 'inv-16', 3)
                ])
            )
        );

        expect(rowState(board, 'thread-15')).toEqual([false, undefined, 'thread-15']);
        expect(rowState(board, 'thread-16')).toEqual([false, undefined, 'thread-16']);
        expect(board.element.querySelectorAll<HTMLElement>('.thread-row').length).toBe(2);
    });

    it('renders every row of a session that never retired one', () => {
        const board = mount();

        // The control: the header carries NO `inactive_thread_ids`, every conversation is on the roster,
        // and nothing is marked or hidden. A normal reload is byte-identical to the pre-F7 board.
        const view = reloadView([
            hostRow(),
            childRow('thread-15', 'WE7', 'inv-15', 2),
            childRow('thread-16', 'WE8', 'inv-16', 3)
        ]);

        board.setThreads(sessionThreadsOf(view));
        const [tile] = board.hydrateView(view);
        tile.flush();

        expect(rowState(board, 'thread-15')).toEqual([false, undefined, 'thread-15']);
        expect(rowState(board, 'thread-16')).toEqual([false, undefined, 'thread-16']);
        expect(cardsOf(board)).toEqual([['thread-13', false]]);
    });

    it('renders every row when the retired list is explicitly empty', () => {
        const board = mount();

        // The server omits the field while nothing is retired, but `[]` is a legal answer (a session
        // whose retired rows the retention bound pruned). It names no deletions, so it infers none.
        const view = reloadView(
            [hostRow(), childRow('thread-15', 'WE7', 'inv-15', 2), childRow('thread-16', 'WE8', 'inv-16', 3)],
            []
        );

        expect(sessionViewOf(sessionResource([]))).not.toHaveProperty('inactiveThreads');

        board.setThreads(sessionThreadsOf(view));
        const [tile] = board.hydrateView(view);
        tile.flush();

        expect(rowState(board, 'thread-15')).toEqual([false, undefined, 'thread-15']);
        expect(rowState(board, 'thread-16')).toEqual([false, undefined, 'thread-16']);
    });
});

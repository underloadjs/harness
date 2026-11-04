// The payload strategy of the canonical display facade (./view-api.ts), asserted on
// EXACT request lists and exact composed documents. This is the test that pins the
// reason T14 exists: opening a conversation costs four bounded reads plus a display
// tree per VISIBLE turn — never `/api`, never `/views`, never an SSE stream, never a
// document assembled from the whole history.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HARNESS_PAGE_LIMIT } from '../shared/harness-api';
import type {
    PendingActionListResponse,
    SessionResponse,
    ThreadSummaryPage,
    TurnDisplayResponse,
    TurnSummaryPage,
    SessionResource,
    ThreadSummary,
    TurnSummary as WireTurnSummary
} from '../shared/harness-api';
import { loadOlderTurns, openSession, prependTurns, submitConversationTask, rowFromReceipt } from './view-api';
import { pageParams } from './api';

// The recorded requests, in the order the client made them.
let calls: { url: string; method: string; body?: unknown }[] = [];

const session: SessionResource = {
    id: 's1',
    harness: 'ghost-story',
    status: 'running',
    queue_depth: 2,
    model: 'gpt-5',
    created_at: 1000,
    updated_at: 2000,
    turn_count: 3,
    thread_count: 2,
    revision: 7,
    definition_revision: 3,
    agent_models: { narrator: 'gpt-5' },
    endpoint: { base_url: 'https://api.example/v1', model: 'gpt-5', has_api_key: true },
    runtime_execution: 'worker',
    pending_action_count: 1,
    created_tool_count: 0,
    created_tool_limit: 32
};

// Three rows, published NEWEST FIRST (the `order=desc` answer), each with a bounded
// prompt preview and no verbatim prompt.
const rows: WireTurnSummary[] = [
    {
        id: 'u3',
        index: 2,
        promptPreview: 'third task',
        promptChars: 10,
        status: 'running',
        state: 'streaming',
        threadId: 't1',
        updatedAt: 2000,
        sectionCount: 1,
        stepCount: 0,
        activeAgents: ['narrator'],
        blocks: []
    },
    {
        id: 'u2',
        index: 1,
        promptPreview: 'second task',
        promptChars: 11,
        status: 'done',
        state: 'done',
        threadId: 't2',
        updatedAt: 1500,
        sectionCount: 1,
        stepCount: 1,
        activeAgents: [],
        blocks: []
    },
    {
        id: 'u1',
        index: 0,
        promptPreview: 'first task',
        promptChars: 10,
        status: 'done',
        state: 'done',
        updatedAt: 1200,
        sectionCount: 1,
        stepCount: 0,
        activeAgents: [],
        blocks: []
    }
];

const threads: ThreadSummary[] = [
    {
        id: 't1',
        agent: 'narrator',
        origin: 'host',
        status: 'running',
        sequence: 0,
        label: 'Root',
        transcript_state: 'ok',
        message_count: 4,
        has_transcript: true,
        preview: 'the last entry'
    },
    {
        id: 't2',
        agent: 'scout',
        origin: 'agent',
        status: 'idle',
        sequence: 1,
        owner_thread_id: 't1',
        transcript_state: 'unreadable',
        transcript_error: 'expected an array',
        message_count: 0,
        has_transcript: false
    }
];

const turnPage: TurnSummaryPage = { limit: 25, next_cursor: 'cursor-older', observed_at: 2100, revision: 12, items: rows };

const rosterPage: ThreadSummaryPage = { limit: 25, next_cursor: null, observed_at: 2100, revision: 4, items: threads };

const actionList: PendingActionListResponse = {
    session_id: 's1',
    revision: 5,
    actions: [
        {
            request: { id: 'a1', title: 'Which ending?', options: [{ id: 'bleak', label: 'Bleak' }], createdAt: 1900 },
            turn_id: 'u3',
            thread_id: 't1',
            agent: 'narrator',
            received_at: 1990
        }
    ]
};

const displayOf = (turnId: string): TurnDisplayResponse => ({
    display: {
        turnId,
        revision: 9,
        sections: [
            {
                id: `${turnId}:0`,
                role: 'primary',
                agent: 'narrator',
                agentLabel: 'RR1',
                state: 'done',
                nodes: [{ kind: 'text', id: 'n1', text: 'the answer', committed: true, chars: 10 }]
            }
        ]
    }
});

const jsonOf = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), {
        status,
        headers: {
            'Content-Type': 'application/json',
            // The two headers every response stamps; the client keeps them so a
            // stream frame can be compared against the read it follows.
            'X-Harness-Epoch': 'epoch-7',
            'X-Harness-Revision': '7'
        }
    });

const routeOf = (path: string, init?: RequestInit): Response => {
    calls.push({ url: path, method: (init?.method ?? 'GET').toUpperCase(), ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) });

    if (path === '/v1/harness/sessions/s1') return jsonOf({ session } satisfies SessionResponse);
    if (path === '/v1/harness/sessions/s1/turns?limit=25&order=desc') return jsonOf(turnPage);
    // The second page, walked from the cursor the first page issued. It carries the
    // two oldest rows again (the server's window), with the collection end reached.
    if (path === '/v1/harness/sessions/s1/turns?limit=25&cursor=cursor-older&order=desc') {
        return jsonOf({ ...turnPage, items: [rows[1], rows[0]], next_cursor: null, revision: 13 } satisfies TurnSummaryPage);
    }
    if (path === '/v1/harness/sessions/s1/threads?limit=25') return jsonOf(rosterPage);
    if (path === '/v1/harness/sessions/s1/actions') return jsonOf(actionList);
    if (path.startsWith('/v1/harness/sessions/s1/turns/u')) return jsonOf(displayOf(path.split('/')[6]));
    if (path === '/v1/harness/sessions/s1/tasks') {
        return jsonOf({
            session_id: 's1',
            turn_id: 'u4',
            status: 'queued',
            thread_id: 't1',
            queue_position: 1,
            session_revision: 8,
            accepted_at: 2500,
            links: {
                turn: '/v1/harness/sessions/s1/turns/u4',
                turns: '/v1/harness/sessions/s1/turns?limit=25',
                thread: '/v1/harness/sessions/s1/threads/t1',
                stream: '/v1/harness/stream'
            }
        });
    }

    throw new Error(`unstubbed ${path}`);
};

describe('canonical display facade', () => {
    beforeEach(() => {
        calls = [];

        globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
            routeOf(String(input), init)
        ) as never;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('opens a conversation with four bounded reads and a tree per visible turn', async () => {
        const view = await openSession('s1');

        // Exact, ordered, and canonical. Note what is NOT here: no `/api`, no
        // `/views`, no `/events`, and no read that returns more than one page.
        expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
            'GET /v1/harness/sessions/s1',
            'GET /v1/harness/sessions/s1/turns?limit=25&order=desc',
            'GET /v1/harness/sessions/s1/threads?limit=25',
            'GET /v1/harness/sessions/s1/actions',
            'GET /v1/harness/sessions/s1/turns/u1/display',
            'GET /v1/harness/sessions/s1/turns/u2/display',
            'GET /v1/harness/sessions/s1/turns/u3/display'
        ]);

        // The header fields are the camelCase render spelling of `SessionResource`,
        // with the counters that let a panel decide whether a read is worth making.
        expect(view).toMatchObject({
            id: 's1',
            harness: 'ghost-story',
            status: 'running',
            queueDepth: 2,
            model: 'gpt-5',
            agentModels: { narrator: 'gpt-5' },
            createdAt: 1000,
            updatedAt: 2000,
            revision: 7,
            definitionRevision: 3,
            turnCount: 3,
            threadCount: 2,
            pendingActionCount: 1,
            createdToolLimit: 32,
            runtimeExecution: 'worker',
            turnsRevision: 12,
            olderCursor: 'cursor-older'
        });
    });

    it('keeps a row a preview and records that it is one', async () => {
        const view = await openSession('s1');

        // A `desc` page reversed into the board's recorded (ascending) order.
        expect(view.turns.map((row) => [row.id, row.index])).toEqual([
            ['u1', 0],
            ['u2', 1],
            ['u3', 2]
        ]);

        expect(view.turns[0]).toMatchObject({
            prompt: 'first task',
            promptPreview: 'first task',
            promptChars: 10,
            promptIsPreview: true
        });

        // The trees are keyed by turn, projected (the wire's `nodes` record becomes
        // the render model's node union member, with the required fields filled).
        expect(view.displays.u3?.sections[0]?.nodes).toEqual([
            { kind: 'text', id: 'n1', text: 'the answer', committed: true, chars: 10 }
        ]);
    });

    it('derives the invalid-transcript list from the roster rows', async () => {
        const view = await openSession('s1');

        expect(view.threadViews?.map((row) => [row.id, row.transcriptState, row.messageCount])).toEqual([
            ['t1', 'ok', 4],
            ['t2', 'unreadable', 0]
        ]);

        expect(view.invalidThreads).toEqual([
            {
                id: 't2',
                agent: 'scout',
                error: 'expected an array',
                messages: undefined,
                ...(threads[1].label === undefined ? {} : { label: threads[1].label })
            }
        ]);

        // The questions gate the composer, so they ride the open and nothing else.
        expect(view.actions?.map((action) => action.request.id)).toEqual(['a1']);
    });

    it('asks for older history only when the reader asks, from the issued cursor', async () => {
        const view = await openSession('s1');
        calls = [];

        const page = await loadOlderTurns('s1', view.olderCursor, { visibleTurns: 0 });

        // One rows page, no eager follow-up: `visibleTurns: 0` means the pane that
        // paged is not showing these rows yet.
        expect(calls.map((call) => call.url)).toEqual([
            '/v1/harness/sessions/s1/turns?limit=25&cursor=cursor-older&order=desc'
        ]);

        expect(page.nextCursor).toBe(null);
        expect(page.revision).toBe(13);
        expect(page.displays).toEqual({});

        // Merging is prepend-only and de-duplicated: the board never re-sorts a turn
        // the reader is looking at, and an overlapping window adds nothing.
        prependTurns(view, { ...page, rows: [...page.rows, page.rows[0]] });
        expect(view.turns.map((row) => row.id)).toEqual(['u1', 'u2', 'u3']);
        expect(view.olderCursor).toBe(null);
        expect(view.turnsRevision).toBe(13);
    });

    it('submits a task as a snake_case body and paints a flagged optimistic row', async () => {
        const receipt = await submitConversationTask('s1', {
            input: 'fourth task',
            threadId: 't1',
            references: [{ turnId: 'u2', label: 'RR1' } as never]
        });

        expect(calls).toEqual([
            {
                url: '/v1/harness/sessions/s1/tasks',
                method: 'POST',
                body: { input: 'fourth task', thread_id: 't1', references: [{ turnId: 'u2', label: 'RR1' }] }
            }
        ]);

        expect(receipt.turn_id).toBe('u4');
        expect(receipt.links.stream).toBe('/v1/harness/stream');

        // A receipt is not a display row, so the row it paints is marked paint-only;
        // the stream's `turn.upsert` is what replaces it.
        expect(rowFromReceipt(receipt, 'fourth task')).toEqual({
            id: 'u4',
            index: -1,
            prompt: 'fourth task',
            promptPreview: 'fourth task',
            promptChars: 11,
            promptIsPreview: false,
            status: 'queued',
            state: 'queued',
            threadId: 't1',
            updatedAt: 2500,
            sectionCount: 0,
            stepCount: 0,
            activeAgents: [],
            blocks: [],
            optimistic: true
        });
    });

    it('clamps every page request into the contract bounds', () => {
        expect(pageParams()).toBe(`?limit=${HARNESS_PAGE_LIMIT.default}`);
        expect(pageParams({ limit: 500 })).toBe('?limit=100');
        expect(pageParams({ limit: 0 })).toBe('?limit=1');
        expect(pageParams({ limit: 25, order: 'desc', cursor: 'c1', thread_id: 't1' })).toBe(
            '?limit=25&cursor=c1&order=desc&thread_id=t1'
        );
    });
});

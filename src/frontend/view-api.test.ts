// Route table for the browser's DISPLAY FACADE on the canonical control plane (T23).
//
// `view-api.ts` is the only place the UI assembles a render document, so what makes that
// enforceable is the ROUTE each call takes: the method, the encoded path, the query, the
// body, and which envelope field the answer is read from. The legacy `/views` mirror and
// its SSE observer are gone (./view-api.ts:1-36), and the composed open/paging/submit
// behaviour is pinned separately in ./view-api-canonical.test.ts — this file pins the
// routes that file does not touch, i.e. every write (which answers a RECEIPT, never a
// document), every lazy identified read, and the transcript pair.
//
// Two contract rules show up repeatedly here and are the reason the assertions are exact:
//   1. writes answer minimal receipts carrying a `revision`; the stream (./stream.ts) is
//      the update plane, so a stop no longer costs a view round trip;
//   2. request-side field spelling is snake_case (`agent_models`, `thread_id`,
//      `if_revision`), while the DISPLAY subtree keeps the camelCase the projector uses
//      (../shared/harness-api.ts header). A client that sends `agentModels` gets a 400
//      against a closed-object body.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts view-api.test.ts

import type {
    CancelSessionResult,
    DeleteSessionResult,
    DeleteThreadResult,
    CancelThreadResult,
    ResetSessionResult,
    SessionDefinitionResource,
    SessionResource,
    SessionResponse,
    SessionUsageResponse,
    ThreadResource,
    ThreadSummary,
    TranscriptDocumentResponse,
    TranscriptMessagePage,
    TranscriptMetadata,
    TranscriptWriteReceipt,
    TurnBlockDetail,
    TurnDisplayResponse,
    TurnResource,
    TurnStepDetail,
    CommandPage,
    QueuedTaskPage,
    PendingActionListResponse,
    AttachmentResponse
} from '../shared/harness-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    actionRequestOf,
    attachmentUrl,
    createSessionView,
    listAllSessions,
    listSessionPage,
    patchSessionView,
    readActions,
    readAttachmentBytes,
    readCommands,
    readDefinition,
    readQueue,
    readRawTurns,
    readStepDetail,
    readTranscript,
    readTranscriptMessages,
    readTurnDisplay,
    readTurnPrompt,
    readUsage,
    receiptLink,
    removeConversation,
    removeConversationOnUnload,
    removeThread,
    resetConversation,
    sessionViewOf,
    stopConversation,
    stopThread,
    receiptLink as receiptLinkOf,
    threadRowOf,
    writeTranscript
} from './view-api';

const T = 1_700_000_000_000;

type Call = { method: string; url: string; body: string; keepalive: boolean };

let calls: Call[] = [];

// A stub server that answers by `METHOD url`, records everything the client asked for, and
// THROWS for a route it does not declare — so a client that invents a request (an eager
// document read behind a head read, a session-level raw route that no longer exists) fails
// the test instead of silently getting `undefined`.
const serve = (routes: Record<string, unknown>, statuses: Record<string, number> = {}): void => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const method = (init?.method ?? 'GET').toUpperCase();
            const url = String(input);
            const body = String(init?.body ?? '');

            calls.push({ method, url, body, keepalive: init?.keepalive === true });

            const key = `${method} ${url}`;
            const value = routes[key] ?? routes[url];

            if (value === undefined) throw new Error(`unexpected request: ${method} ${url}`);

            return new Response(JSON.stringify(value), {
                status: statuses[key] ?? statuses[url] ?? 200,
                headers: { 'Content-Type': 'application/json' }
            });
        })
    );
};

const session: SessionResource = {
    id: 's 1',
    harness: 'instruct',
    status: 'idle',
    model: 'm1',
    created_at: 1,
    updated_at: 2,
    turn_count: 0,
    thread_count: 0,
    revision: 4,
    definition_revision: 1,
    agent_models: { worker: 'm1' },
    endpoint: { base_url: 'http://provider/v1', model: 'm1', has_api_key: false },
    runtime_execution: 'inline',
    pending_action_count: 0,
    created_tool_count: 0,
    created_tool_limit: 32
} as SessionResource;

const rosterRow: ThreadSummary = {
    id: 'th a',
    agent: 'instruct',
    origin: 'host',
    status: 'idle',
    sequence: 1,
    transcript_state: 'ok',
    message_count: 2,
    has_transcript: true
};

const thread: ThreadResource = {
    ...rosterRow,
    session_id: 's 1',
    invocation_ids: ['i1'],
    invocation_ids_truncated: false,
    transcript_revision: 4,
    revision: 6
} as ThreadResource;

beforeEach(() => {
    calls = [];
    window.history.replaceState(null, '', '/');
});

afterEach(() => {
    vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// The rename boundary (snake_case resource -> camelCase render model)
// ---------------------------------------------------------------------------

describe('the render-model boundary', () => {
    it('renames a session resource into the header model with an EMPTY turns window', () => {
        // The R1 boundary, asserted on the pure mapper: a metadata read answers counters,
        // so `turns` starts empty and nothing here can smuggle history back in.
        expect(sessionViewOf(session)).toEqual({
            id: 's 1',
            harness: 'instruct',
            status: 'idle',
            model: 'm1',
            agentModels: { worker: 'm1' },
            createdAt: 1,
            updatedAt: 2,
            revision: 4,
            definitionRevision: 1,
            endpoint: { base_url: 'http://provider/v1', model: 'm1', has_api_key: false },
            runtimeExecution: 'inline',
            pendingActionCount: 0,
            createdToolCount: 0,
            createdToolLimit: 32,
            turnCount: 0,
            threadCount: 0,
            turns: [],
            displays: {}
        });
    });

    it('renames a roster row, and keeps only the fields an identified read publishes', () => {
        expect(threadRowOf(rosterRow)).toEqual({
            id: 'th a',
            agent: 'instruct',
            origin: 'host',
            status: 'idle',
            sequence: 1,
            transcriptState: 'ok',
            messageCount: 2,
            hasTranscript: true
        });

        // The identified read adds the invocation roster and the transcript revision.
        expect(threadRowOf(thread).revision).toBe(6);
        expect(threadRowOf(thread).invocationIds).toEqual(['i1']);
    });
});

// ---------------------------------------------------------------------------
// The mutations: every one of them answers a receipt, not a document
// ---------------------------------------------------------------------------

describe('the conversation mutations', () => {
    it('POSTs a new conversation with the harness and settings, and answers a header', async () => {
        serve({ 'POST /v1/harness/sessions': { session } satisfies SessionResponse });

        expect((await createSessionView({ harness: 'instruct', settings: { model: 'm1' } })).id).toBe('s 1');
        expect(calls).toEqual([
            {
                method: 'POST',
                url: '/v1/harness/sessions',
                body: JSON.stringify({ harness: 'instruct', settings: { model: 'm1' } }),
                keepalive: false
            }
        ]);
    });

    it('drops an empty title instead of sending it', async () => {
        serve({ 'POST /v1/harness/sessions': { session } satisfies SessionResponse });

        await createSessionView({ harness: 'instruct', title: '' });

        expect(JSON.parse(calls[0].body)).toEqual({ harness: 'instruct' });
    });

    it('PATCHes the live model map in the contract spelling and answers the patched row', async () => {
        serve({
            'PATCH /v1/harness/sessions/s%201': {
                session: { ...session, agent_models: { worker: 'next/model' } }
            } satisfies SessionResponse
        });

        const view = await patchSessionView('s 1', { agent_models: { worker: 'next/model' } });

        expect(view.agentModels).toEqual({ worker: 'next/model' });
        expect(JSON.parse(calls[0].body)).toEqual({ agent_models: { worker: 'next/model' } });
        expect(calls[0].url).toBe('/v1/harness/sessions/s%201');
    });

    it('POSTs the reset with no body at all and answers the discard receipt', async () => {
        const reset: ResetSessionResult = {
            reset: true,
            session_id: 's 1',
            discarded_turns: 3,
            discarded_threads: 1,
            dropped_queued_tasks: 0,
            revision: 5
        };
        serve({ 'POST /v1/harness/sessions/s%201/reset': reset });

        expect(await resetConversation('s 1')).toEqual(reset);
        expect(calls).toEqual([{ method: 'POST', url: '/v1/harness/sessions/s%201/reset', body: '', keepalive: false }]);
    });

    it('drains the queue by default, and can stop the active run alone', async () => {
        const cancelled: CancelSessionResult = {
            cancelled: true,
            session_id: 's 1',
            dropped_queued_tasks: 2,
            active_turn_id: 'u1',
            revision: 6
        };
        serve({ 'POST /v1/harness/sessions/s%201/cancel': cancelled });

        // The facade default is `all = true`: a Stop button in this UI means "stop
        // everything", and the body is what the contract reads that from.
        expect((await stopConversation('s 1')).dropped_queued_tasks).toBe(2);
        expect(JSON.parse(calls[0].body)).toEqual({ all: true });

        await stopConversation('s 1', false);
        expect(calls[1].body).toBe('');
        expect(calls[1].url).toBe('/v1/harness/sessions/s%201/cancel');
    });

    it('DELETEs a conversation, and sends the unload variant with keepalive', async () => {
        const deleted: DeleteSessionResult = {
            deleted: true,
            session_id: 's 1',
            aborted_turns: 1,
            dropped_queued_tasks: 0
        };
        serve({ 'DELETE /v1/harness/sessions/s%201': deleted });

        expect((await removeConversation('s 1')).deleted).toBe(true);
        expect((await removeConversationOnUnload('s 1')).deleted).toBe(true);
        expect(calls.map((call) => [call.method, call.url, call.keepalive])).toEqual([
            ['DELETE', '/v1/harness/sessions/s%201', false],
            ['DELETE', '/v1/harness/sessions/s%201', true]
        ]);
    });

    it('stops and deletes ONE conversation with receipts that name what moved', async () => {
        const cancelled: CancelThreadResult = {
            cancelled: true,
            thread_id: 'th a',
            session_id: 's 1',
            status: 'stopped',
            dropped_queued_tasks: 1,
            revision: 7
        };
        const removed: DeleteThreadResult = {
            deleted: true,
            thread_id: 'th a',
            session_id: 's 1',
            removed_descendants: 2,
            removed_turns: 1,
            revision: 8
        };
        serve({
            'POST /v1/harness/sessions/s1/threads/th%20a/cancel': cancelled,
            'DELETE /v1/harness/sessions/s1/threads/th%20a': removed
        });

        expect(await stopThread('s1', 'th a')).toEqual(cancelled);
        expect(await removeThread('s1', 'th a')).toEqual(removed);

        // The legacy `{ cancelled, view }` / `{ deleted, view }` shape is gone: no stop
        // re-ships the document, because the stream is the update plane.
        expect(calls.map((call) => [call.method, call.url])).toEqual([
            ['POST', '/v1/harness/sessions/s1/threads/th%20a/cancel'],
            ['DELETE', '/v1/harness/sessions/s1/threads/th%20a']
        ]);
    });

    it('answers one owner question and refuses an answer the server did not accept', async () => {
        serve({
            'POST /v1/harness/sessions/s1/actions/r%201/answer': { ok: true, request_id: 'r 1', resolved_at: T },
            'POST /v1/harness/sessions/s1/actions/r1/answer': { ok: false }
        });

        const { answerAction } = await import('./api');

        expect(await answerAction('s1', 'r 1', { kind: 'option', option_id: 'yes' })).toBe(true);
        expect(JSON.parse(calls[0].body)).toEqual({ choice: { kind: 'option', option_id: 'yes' } });

        await expect(answerAction('s1', 'r1', { kind: 'custom', text: 'later' })).rejects.toThrow(
            'The harness server did not accept the answer.'
        );
    });

    it('surfaces the server\'s own message for a failed read', async () => {
        const { getSession } = await import('./api');
        serve(
            { 'GET /v1/harness/sessions/nope': { error: { message: 'Unknown session "nope".' } } },
            { 'GET /v1/harness/sessions/nope': 404 }
        );

        await expect(getSession('nope')).rejects.toThrow('Unknown session "nope".');
    });
});

// ---------------------------------------------------------------------------
// The lazy identified reads: one click, one route, one envelope field
// ---------------------------------------------------------------------------

describe('the lazy identified reads', () => {
    it('reads one compiled display tree and answers the PROJECTED tree', async () => {
        const response: TurnDisplayResponse = {
            display: {
                turnId: 't 1',
                revision: 2,
                sections: [
                    {
                        id: 't1:0',
                        role: 'primary',
                        agent: 'instruct',
                        state: 'done',
                        nodes: [{ kind: 'text', id: 'n1', text: 'hi', committed: true, chars: 2 }]
                    }
                ]
            }
        };
        serve({ 'GET /v1/harness/sessions/s%201/turns/t%201/display': response });

        const display = await readTurnDisplay('s 1', 't 1');

        expect(display.turnId).toBe('t 1');
        expect(display.sections[0]?.nodes).toEqual([
            { kind: 'text', id: 'n1', text: 'hi', committed: true, chars: 2 }
        ]);
        expect(calls).toEqual([
            { method: 'GET', url: '/v1/harness/sessions/s%201/turns/t%201/display', body: '', keepalive: false }
        ]);
    });

    it('reads one step by its exact address and unwraps the detail', async () => {
        const detail: TurnStepDetail = {
            sessionId: 's 1',
            turnId: 't 1',
            stepId: '7',
            sectionId: 't1:0',
            opening: { index: 7, event: { type: 'tool_call', agent: 'instruct', call: { id: 'c1', name: 'read', arguments: '{}' } } as never }
        };
        serve({ 'GET /v1/harness/sessions/s%201/turns/t%201/steps/7': { detail } });

        expect(await readStepDetail('s 1', 't 1', '7')).toEqual(detail);
        expect(calls).toEqual([
            { method: 'GET', url: '/v1/harness/sessions/s%201/turns/t%201/steps/7', body: '', keepalive: false }
        ]);
    });

    it('reads ONE attachment\'s bytes and unwraps the attachment envelope', async () => {
        const response: AttachmentResponse = {
            attachment: {
                id: 'a 1',
                kind: 'image',
                marker: '[Image 1]',
                name: 'shot.png',
                mime: 'image/png',
                size: 12,
                data: 'iVBORw0KGgoAAAAA'
            }
        } as unknown as AttachmentResponse;
        serve({ 'GET /v1/harness/sessions/s%201/turns/t%201/attachments/a%201': response });

        expect(await readAttachmentBytes('s 1', 't 1', 'a 1')).toEqual(response.attachment);
        expect(calls).toEqual([
            { method: 'GET', url: '/v1/harness/sessions/s%201/turns/t%201/attachments/a%201', body: '', keepalive: false }
        ]);
    });

    it('reads the verbatim prompt from the turn metadata route, and reports no prompt as undefined', async () => {
        const turn = {
            id: 't 1',
            index: 0,
            prompt: 'the whole recorded task text',
            promptChars: 27,
            status: 'done',
            state: 'done',
            updatedAt: T,
            sectionCount: 0,
            stepCount: 0,
            activeAgents: [],
            blocks: []
        };
        serve({ 'GET /v1/harness/sessions/s%201/turns/t%201': { turn } });

        expect(await readTurnPrompt('s 1', 't 1')).toBe('the whole recorded task text');

        serve({ 'GET /v1/harness/sessions/s1/turns/t2': { turn: { ...turn, id: 't2', prompt: undefined } } });
        expect(await readTurnPrompt('s1', 't2')).toBeUndefined();
    });

    it('reads the frozen definition and the usage fold from their own routes', async () => {
        const definition: SessionDefinitionResource = {
            ...(session as unknown as SessionDefinitionResource),
            session_id: 's 1',
            revision: 1,
            frozen_at: T,
            source_revision: 3,
            current: true,
            current_revision: 3
        };
        const usage: SessionUsageResponse = {
            session_id: 's 1',
            turn_count: 2,
            reported_turns: 1,
            by_thread: [],
            truncated: false,
            revision: 5
        };
        serve({
            'GET /v1/harness/sessions/s%201/definition': { definition },
            'GET /v1/harness/sessions/s%201/usage': usage
        });

        expect(await readDefinition('s 1')).toEqual(definition);
        expect(await readUsage('s 1')).toEqual(usage);
        expect(calls.map((call) => call.url)).toEqual([
            '/v1/harness/sessions/s%201/definition',
            '/v1/harness/sessions/s%201/usage'
        ]);
    });

    it('pages commands and queue with the contract\'s default page size', async () => {
        const commands: CommandPage = {
            limit: 25,
            next_cursor: null,
            observed_at: T,
            revision: 1,
            items: [{ name: 'help', invocation: '/help', description: 'Show help' }]
        };
        const queue: QueuedTaskPage = {
            limit: 25,
            next_cursor: null,
            observed_at: T,
            revision: 1,
            items: [{ id: 'u9', index: 9, prompt_preview: 'queued', prompt_chars: 400, agent: 'instruct', enqueued_at: T } as never]
        };
        serve({
            'GET /v1/harness/sessions/s1/commands?limit=25': commands,
            'GET /v1/harness/sessions/s1/queue?limit=25': queue
        });

        expect((await readCommands('s1')).items).toEqual(commands.items);
        expect((await readQueue('s1')).items).toEqual(queue.items);
        expect(calls.map((call) => call.url)).toEqual([
            '/v1/harness/sessions/s1/commands?limit=25',
            '/v1/harness/sessions/s1/queue?limit=25'
        ]);
    });

    it('answers the owner questions array, not the roster envelope', async () => {
        const body: PendingActionListResponse = { session_id: 's1', revision: 5, actions: [] };
        serve({ 'GET /v1/harness/sessions/s1/actions': body });

        expect(await readActions('s1')).toEqual([]);
        expect(calls).toEqual([
            { method: 'GET', url: '/v1/harness/sessions/s1/actions', body: '', keepalive: false }
        ]);
    });

    it('takes the request a card answers from the card itself', () => {
        const action = { request: { id: 'a1', title: 'Which ending?', options: [], createdAt: T }, turn_id: 'u1', thread_id: 't1', agent: 'instruct', received_at: T };

        expect(actionRequestOf(action as never)).toEqual(action.request);
    });
});

// ---------------------------------------------------------------------------
// Directory paging
// ---------------------------------------------------------------------------

describe('the session directory', () => {
    it('answers one page of rows verbatim', async () => {
        const page = {
            limit: 25,
            next_cursor: 'c2',
            observed_at: T,
            revision: 9,
            items: [{ ...session, id: 's1' }, { ...session, id: 's2' }]
        };
        serve({ 'GET /v1/harness/sessions?limit=25': page });

        expect((await listSessionPage()).items.map((row) => row.id)).toEqual(['s1', 's2']);
        expect(calls).toEqual([
            { method: 'GET', url: '/v1/harness/sessions?limit=25', body: '', keepalive: false }
        ]);
    });

    it('walks the issued cursors and stops at the end the server names', async () => {
        serve({
            'GET /v1/harness/sessions?limit=2': { limit: 2, next_cursor: 'c2', observed_at: T, revision: 9, items: [{ ...session, id: 's1' }, { ...session, id: 's2' }] },
            'GET /v1/harness/sessions?limit=2&cursor=c2': { limit: 2, next_cursor: null, observed_at: T, revision: 9, items: [{ ...session, id: 's3' }] }
        });

        expect((await listAllSessions(2)).map((row) => row.id)).toEqual(['s1', 's2', 's3']);
        expect(calls.map((call) => call.url)).toEqual([
            '/v1/harness/sessions?limit=2',
            '/v1/harness/sessions?limit=2&cursor=c2'
        ]);
    });
});

// ---------------------------------------------------------------------------
// Transcript: a head, a paged read, and a document — three differently sized routes
// ---------------------------------------------------------------------------

describe('the transcript surface', () => {
    const metadata: TranscriptMetadata = {
        session_id: 's1',
        thread_id: 'th a',
        agent: 'instruct',
        transcript_state: 'ok',
        message_count: 1,
        chars: 18,
        bytes: 24,
        revision: 4,
        role_counts: { system: 0, user: 1, assistant: 0, tool: 0 }
    };

    const document: TranscriptDocumentResponse = {
        session_id: 's1',
        thread_id: 'th a',
        agent: 'instruct',
        revision: 4,
        transcript_state: 'ok',
        document: '[{"role":"user","content":"hello"}]'
    };

    it('composes the editor payload from exactly two reads: the head and the document', async () => {
        serve({
            'GET /v1/harness/sessions/s1/threads/th%20a/transcript': { transcript: metadata },
            'GET /v1/harness/sessions/s1/threads/th%20a/transcript/document': document
        });

        expect(await readTranscript('s1', 'th a')).toEqual({
            threadId: 'th a',
            agent: 'instruct',
            messages: [{ role: 'user', content: 'hello' }],
            raw: document.document,
            revision: 4
        });
        expect(calls.map((call) => call.url)).toEqual([
            '/v1/harness/sessions/s1/threads/th%20a/transcript',
            '/v1/harness/sessions/s1/threads/th%20a/transcript/document'
        ]);
    });

    it('reports an unreadable document with the head\'s reason, and keeps the stored bytes for the editor', async () => {
        const broken = { ...document, transcript_state: 'unreadable' as const, document: '"nope"' };
        serve({
            'GET /v1/harness/sessions/s1/threads/th-a/transcript': {
                transcript: { ...metadata, transcript_state: 'unreadable', unreadable_reason: 'expected an array', stored_type: 'string' }
            },
            'GET /v1/harness/sessions/s1/threads/th-a/transcript/document': broken
        });

        expect(await readTranscript('s1', 'th-a')).toEqual({
            threadId: 'th-a',
            agent: 'instruct',
            messages: [],
            raw: '"nope"',
            revision: 4,
            invalid: { error: 'expected an array', raw: '"nope"', storedType: 'string' }
        });
    });

    it('answers an honest empty document when BOTH reads fail, instead of throwing', async () => {
        serve(
            {
                'GET /v1/harness/sessions/s1/threads/th-a/transcript': { error: { message: 'Unknown thread.' } },
                'GET /v1/harness/sessions/s1/threads/th-a/transcript/document': { error: { message: 'Unknown thread.' } }
            },
            {
                'GET /v1/harness/sessions/s1/threads/th-a/transcript': 404,
                'GET /v1/harness/sessions/s1/threads/th-a/transcript/document': 404
            }
        );

        expect(await readTranscript('s1', 'th-a')).toEqual({
            threadId: 'th-a',
            agent: '',
            messages: [],
            raw: '[]',
            revision: 0,
            invalid: { error: 'The transcript could not be read.', raw: '[]' }
        });
    });

    it('pages the message read for display, separately from the editable document', async () => {
        const page: TranscriptMessagePage = {
            limit: 25,
            next_cursor: null,
            observed_at: T,
            revision: 4,
            thread_id: 'th-a',
            agent: 'instruct',
            transcript_state: 'ok',
            total: 1,
            items: [{ role: 'user', content: 'hello' } as never]
        };
        serve({ 'GET /v1/harness/sessions/s1/threads/th-a/transcript/messages?limit=25': page });

        expect((await readTranscriptMessages('s1', 'th-a')).items).toEqual(page.items);
    });

    it('writes the whole document with the transcript revision as the concurrency guard', async () => {
        const writeReceipt: TranscriptWriteReceipt = {
            session_id: 's1',
            thread_id: 'th-a',
            accepted_as: 'transcript',
            message_count: 1,
            revision: 5
        };
        serve({ 'PUT /v1/harness/sessions/s1/threads/th-a/transcript': writeReceipt });

        expect(await writeTranscript('s1', 'th-a', [{ role: 'user' }], 4)).toEqual(writeReceipt);
        expect(JSON.parse(calls[0].body)).toEqual({ messages: [{ role: 'user' }], if_revision: 4 });
        expect(calls[0].url).toBe('/v1/harness/sessions/s1/threads/th-a/transcript');
    });
});

// ---------------------------------------------------------------------------
// Export: composed from bounded reads, and it never probes a session-level aggregate
// ---------------------------------------------------------------------------

describe('the bounded raw export', () => {
    const turnRow = (id: string): TurnResource & { prompt?: string } =>
        ({
            id,
            index: Number(id.slice(1)),
            prompt: `task ${id}`,
            promptChars: 6,
            status: 'done',
            state: 'done',
            threadId: 'th-a',
            startedAt: 1000,
            updatedAt: T,
            sectionCount: 0,
            stepCount: 0,
            activeAgents: [],
            blocks: []
        }) as unknown as TurnResource & { prompt?: string };

    const eventsPage = (turnId: string, cursor: string | null) => ({
        limit: 100,
        next_cursor: cursor,
        observed_at: T,
        revision: 3,
        turn_id: turnId,
        total_events: cursor === null ? 2 : 3,
        partial: false,
        items:
            cursor === null
                ? [
                      { index: 0, at: 1000, event: { type: 'start', agent: 'instruct', model: 'm1' } },
                      { index: 1, at: 1100, event: { type: 'stop', agent: 'instruct' } }
                  ]
                : [{ index: 2, at: 1200, event: { type: 'usage', usage: {} } }]
    });

    it('fetches each named turn once, walks its event pages, and skips a turn that went away', async () => {
        serve(
            {
                'GET /v1/harness/sessions/s1/turns/t1': { turn: turnRow('t1') },
                'GET /v1/harness/sessions/s1/turns/t1/events?limit=100': eventsPage('t1', 'c2'),
                'GET /v1/harness/sessions/s1/turns/t1/events?limit=100&cursor=c2': eventsPage('t1', null),
                'GET /v1/harness/sessions/s1/turns/t3': { error: { message: 'Unknown turn "t3".' } }
            },
            { 'GET /v1/harness/sessions/s1/turns/t3': 404 }
        );

        const documents = await readRawTurns('s1', ['t1', 't1', 't3']);

        expect(documents).toEqual([
            {
                id: 't1',
                index: 1,
                prompt: 'task t1',
                status: 'done',
                threadId: 'th-a',
                startedAt: 1000,
                updatedAt: T,
                events: [
                    { type: 'start', agent: 'instruct', model: 'm1' },
                    { type: 'stop', agent: 'instruct' },
                    { type: 'usage', usage: {} }
                ],
                eventTimes: [1000, 1100, 1200]
            }
        ]);
        expect(calls.map((call) => call.url)).toEqual([
            '/v1/harness/sessions/s1/turns/t1',
            '/v1/harness/sessions/s1/turns/t1/events?limit=100',
            '/v1/harness/sessions/s1/turns/t1/events?limit=100&cursor=c2',
            '/v1/harness/sessions/s1/turns/t3'
        ]);

        // The R1 boundary, restated on the canonical mount: there is no session-level raw
        // aggregate, so an export never spends a request probing for one.
        expect(calls.some((call) => call.url.endsWith('/sessions/s1/raw'))).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// The links a client follows verbatim
// ---------------------------------------------------------------------------

describe('the published links', () => {
    it('returns a receipt link unchanged, because it is already a contract path', () => {
        const receipt = {
            session_id: 's1',
            turn_id: 'u1',
            status: 'queued',
            thread_id: 'th-a',
            session_revision: 8,
            accepted_at: T,
            links: {
                turn: '/v1/harness/sessions/s1/turns/u1',
                turns: '/v1/harness/sessions/s1/turns?limit=25',
                thread: '/v1/harness/sessions/s1/threads/th-a',
                stream: '/v1/harness/stream'
            }
        };

        expect(receiptLink(receipt, 'turn')).toBe('/v1/harness/sessions/s1/turns/u1');
        expect(receiptLinkOf(receipt, 'stream')).toBe('/v1/harness/stream');
    });

    it('addresses an attachment under the session that owns the turn', async () => {
        // The contract route is `/v1/harness/sessions/{session_id}/turns/{turn_id}/
        // attachments/{attachment_id}` (../shared/harness-api.ts:98). An `<img>` source
        // that skips the session segment dials a path the router does not mount.
        expect(attachmentUrl('s 1', 't 1', 'a 1')).toBe(
            '/v1/harness/sessions/s%201/turns/t%201/attachments/a%201'
        );
    });
});

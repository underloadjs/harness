// Direct tests for the browser's DISPLAY client (`/views`), the frontend's default wire.
//
// Why this file exists next to `api.test.ts`: the raw contract (`SessionSnapshot` with
// `turns[].events`) stays byte-identical for the CLI and for embedders, so the browser got
// its own surface instead (R1). What makes that enforceable is the ROUTE each call takes,
// and a shell test driven through the raw→display shim cannot show it. Each assertion here
// pins one frozen line of the route table in `view-api.ts:19-34`: the method, the encoded
// path, the body, and which envelope field the answer is read from.
//
// The two routes that move recorded `HarnessEvent`s into a browser — the lazy step detail
// and the per-turn raw read — are pinned here too, including the composition rules that
// keep an explicit export BOUNDED: there is no session-level raw route on this surface
// (`src/server/api.ts` mounts `views/:id` read/patch/delete and
// `views/:id/turns/:turnId/raw`, nothing else), so `getRawSession` must never ask for one.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts view-api.test.ts

import type { SessionTurn, SessionView } from '../server/protocol';
import type { HarnessMessage } from '../types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    answerViewAction,
    cancelView,
    cancelViewThread,
    createView,
    deleteView,
    deleteViewOnUnload,
    deleteViewThread,
    getRawSession,
    getStepDetail,
    getThreadTranscript,
    getThreadTurnsRaw,
    getTurnRaw,
    getView,
    listViews,
    observeView,
    resetView,
    submitViewTask,
    updateThreadTranscript,
    updateView
} from './view-api';

const T = 1_700_000_000_000;

type Call = { method: string; url: string; body: string; keepalive: boolean };

const calls: Call[] = [];

// A stub server that answers by `METHOD path`, records everything the client asked for, and
// THROWS for a route it does not declare — the same discipline the shell stubs keep, so a
// client that invents a request fails the test instead of silently getting `undefined`.
const serve = (routes: Record<string, unknown>, statuses: Record<string, number> = {}): void => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const method = init?.method ?? 'GET';
            const url = String(input);
            const body = String(init?.body ?? '');

            calls.push({ method, url, body, keepalive: init?.keepalive === true });

            const key = `${method} ${url}`;
            const value = routes[key] ?? routes[url];

            if (value === undefined) throw new Error(`unexpected request: ${method} ${url}`);

            return new Response(JSON.stringify(value), {
                status: statuses[key] ?? 200,
                headers: { 'Content-Type': 'application/json' }
            });
        })
    );
};

const view: SessionView = {
    id: 's 1',
    harness: 'instruct',
    status: 'idle',
    model: 'm1',
    createdAt: 1,
    updatedAt: 2,
    turns: [
        { id: 't1', index: 0, prompt: 'go', status: 'done', state: 'done', updatedAt: T, sectionCount: 0, stepCount: 0, activeAgents: [], blocks: [] },
        { id: 't2', index: 1, prompt: 'more', status: 'done', state: 'done', updatedAt: T, sectionCount: 0, stepCount: 0, activeAgents: [], blocks: [] }
    ],
    displays: { t1: { turnId: 't1', sections: [] }, t2: { turnId: 't2', sections: [] } },
    threadViews: [
        { id: 'th-a', agent: 'instruct', origin: 'host', status: 'idle', sequence: 1, messageCount: 2, hasTranscript: true },
        { id: 'th-b', agent: 'helper', origin: 'host', status: 'idle', sequence: 2, ownerThreadId: 'th-a', messageCount: 0, hasTranscript: false }
    ]
} as unknown as SessionView;

const turnRecord = (id: string): SessionTurn =>
    ({ id, index: 0, prompt: 'go', status: 'done', updatedAt: T, events: [{ type: 'start', agent: 'instruct', model: 'm1' }] }) as unknown as SessionTurn;

const transcriptFor = (threadId: string): { threadId: string; agent: string; messages: HarnessMessage[]; raw: string } => ({
    threadId,
    agent: 'instruct',
    messages: [{ role: 'user', content: `hello ${threadId}` } as unknown as HarnessMessage],
    raw: '[{"role":"user"}]'
});

beforeEach(() => {
    calls.length = 0;
    window.history.replaceState(null, '', '/');
});

afterEach(() => {
    vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// The directory, the single view, and the mutations that answer with a view
// ---------------------------------------------------------------------------

describe('the compact reads', () => {
    it('GETs the view index and answers an array even for a malformed body', async () => {
        serve({ 'GET /api/views': { views: [view] } });

        expect(await listViews()).toHaveLength(1);
        expect(calls).toEqual([{ method: 'GET', url: '/api/views', body: '', keepalive: false }]);

        serve({ 'GET /api/views': {} });
        expect(await listViews()).toEqual([]);
    });

    it('GETs one compiled view with the id encoded', async () => {
        serve({ 'GET /api/views/s%201': { view } });

        expect((await getView('s 1')).id).toBe('s 1');
        expect(calls).toEqual([{ method: 'GET', url: '/api/views/s%201', body: '', keepalive: false }]);
    });

    it('POSTs a new conversation with the harness and settings, and reads the view back', async () => {
        serve({ 'POST /api/views': { view } });

        expect((await createView('instruct', { model: 'm1' })).id).toBe('s 1');
        expect(calls).toEqual([
            { method: 'POST', url: '/api/views', body: JSON.stringify({ harness: 'instruct', settings: { model: 'm1' } }), keepalive: false }
        ]);
    });

    it('PATCHes the per-agent models and answers with the view, not a snapshot', async () => {
        serve({ 'PATCH /api/views/s1': { view } });

        expect((await updateView('s1', { agentModels: { worker: 'next/model' } })).id).toBe('s 1');
        expect(JSON.parse(calls[0].body)).toEqual({ agentModels: { worker: 'next/model' } });
    });

    it('POSTs the reset with no body at all', async () => {
        serve({ 'POST /api/views/s1/reset': { view } });

        expect((await resetView('s1')).turns).toHaveLength(2);
        expect(calls).toEqual([{ method: 'POST', url: '/api/views/s1/reset', body: '', keepalive: false }]);
    });

    it('DELETEs a conversation, and sends the unload variant with keepalive', async () => {
        serve({ 'DELETE /api/views/s1': { deleted: true } });

        expect(await deleteView('s1')).toBeUndefined();
        expect(await deleteViewOnUnload('s1')).toBeUndefined();
        expect(calls.map((call) => [call.method, call.url, call.keepalive])).toEqual([
            ['DELETE', '/api/views/s1', false],
            ['DELETE', '/api/views/s1', true]
        ]);
    });

    it('omits the cancel body unless the queue is being drained', async () => {
        serve({ 'POST /api/views/s1/cancel': { cancelled: true } });

        expect(await cancelView('s1')).toBe(true);
        expect(calls[0].body).toBe('');

        expect(await cancelView('s1', true)).toBe(true);
        expect(calls[1].body).toBe(JSON.stringify({ all: true }));
    });

    it('mirrors the per-thread stop and delete to the views prefix, with the view attached', async () => {
        serve({
            'POST /api/views/s1/threads/th%20a/cancel': { cancelled: true, view },
            'DELETE /api/views/s1/threads/th%20a': { deleted: true, view }
        });

        expect((await cancelViewThread('s1', 'th a')).cancelled).toBe(true);
        expect(calls[0].url).toBe('/api/views/s1/threads/th%20a/cancel');

        const removed = await deleteViewThread('s1', 'th a');
        expect(removed.deleted).toBe(true);
        expect(removed.view.id).toBe('s 1');
        expect(calls[1].method).toBe('DELETE');
    });

    it('answers one owner question and refuses an answer the server did not accept', async () => {
        serve({ 'POST /api/views/s1/actions/r%201/answer': { ok: true } });

        expect(await answerViewAction('s1', 'r 1', { kind: 'option', optionId: 'yes' })).toBe(true);
        expect(JSON.parse(calls[0].body)).toEqual({ choice: { kind: 'option', optionId: 'yes' } });

        serve({ 'POST /api/views/s1/actions/r1/answer': { ok: false } });
        await expect(answerViewAction('s1', 'r1', { kind: 'custom', text: 'later' })).rejects.toThrow(
            'The harness server did not accept the answer.'
        );
    });

    it('surfaces the server\u2019s own message for a failed read', async () => {
        serve({ 'GET /api/views/nope': { error: { message: 'Unknown session "nope".' } } }, { 'GET /api/views/nope': 404 });

        await expect(getView('nope')).rejects.toThrow('Unknown session "nope".');
    });
});

// ---------------------------------------------------------------------------
// Transcript (C4/C5): a transcript document is not an event list
// ---------------------------------------------------------------------------

describe('the transcript routes', () => {
    it('reads the bare payload the display route answers with', async () => {
        serve({ 'GET /api/views/s1/threads/th%20a/transcript': transcriptFor('th a') });

        expect(await getThreadTranscript('s1', 'th a')).toEqual(transcriptFor('th a'));
        expect(calls).toEqual([{ method: 'GET', url: '/api/views/s1/threads/th%20a/transcript', body: '', keepalive: false }]);
    });

    it('also accepts the {transcript} envelope its raw twin uses', async () => {
        // src/server/api.ts:1636 wraps the same value; src/server/api.ts:1923 does not. One
        // client has to read both mirrors without handing the dialog an `undefined`.
        serve({ 'GET /api/views/s1/threads/th-a/transcript': { transcript: transcriptFor('th-a') } });

        expect((await getThreadTranscript('s1', 'th-a')).messages).toHaveLength(1);
    });

    it('answers an unreadable 200 with an honest empty document rather than a crash', () => {
        serve({ 'GET /api/views/s1/threads/th-a/transcript': { note: 'not a transcript' } });

        return expect(getThreadTranscript('s1', 'th-a')).resolves.toEqual({
            threadId: 'th-a',
            agent: '',
            messages: [],
            raw: '[]'
        });
    });

    it('sends the parsed value verbatim, including a value the user broke', async () => {
        serve({
            'PUT /api/views/s1/threads/th-a/transcript': { view, transcript: { ...transcriptFor('th-a'), invalid: { error: 'not an array', messages: 'nope' } } }
        });

        const result = await updateThreadTranscript('s1', 'th-a', 'nope');

        expect(JSON.parse(calls[0].body)).toEqual({ messages: 'nope' });
        expect(result.view.id).toBe('s 1');
        expect(result.transcript.invalid).toEqual({ error: 'not an array', messages: 'nope' });
    });
});

// ---------------------------------------------------------------------------
// Submit (202) and the display observer
// ---------------------------------------------------------------------------

describe('submit and observation', () => {
    it('posts the plain task with no optional wire fields', async () => {
        serve({ 'POST /api/views/s1/tasks': { view, turn: view.turns[0] } });

        const answer = await submitViewTask('s1', 'go');

        expect(JSON.parse(calls[0].body)).toEqual({ input: 'go' });
        expect(answer.turn.id).toBe('t1');
        expect(calls[0].url).toBe('/api/views/s1/tasks');
    });

    it('carries the thread, the attachments and the # references, and nothing the draft invented', async () => {
        serve({ 'POST /api/views/s1/tasks': { view, turn: view.turns[0], steered: true, steeredThreadId: 'th-a' } });

        const answer = await submitViewTask(
            's1',
            'continue',
            [{ id: 'a1', marker: '@[img](x.png)', name: 'x.png', kind: 'image', mime: 'image/png', data: 'AAA', size: 3 }],
            [
                // A ROOT block reference has NO `threadId`, and a draft-only field must not
                // ride the wire.
                { turnId: 't1', label: 'RR1', draftNote: 'local only' } as never,
                { turnId: 't2', label: 'RR2', threadId: 'th-a' }
            ],
            'th-a'
        );

        expect(JSON.parse(calls[0].body)).toEqual({
            input: 'continue',
            threadId: 'th-a',
            attachments: [{ id: 'a1', marker: '@[img](x.png)', name: 'x.png', kind: 'image', mime: 'image/png', data: 'AAA', size: 3 }],
            references: [{ turnId: 't1', label: 'RR1' }, { turnId: 't2', threadId: 'th-a', label: 'RR2' }]
        });
        expect(answer.steered).toBe(true);
        expect(answer.steeredThreadId).toBe('th-a');
    });

    it('drops empty optional collections instead of sending []', async () => {
        serve({ 'POST /api/views/s1/tasks': { view, turn: view.turns[0] } });

        await submitViewTask('s1', 'go', [], [], '');

        expect(JSON.parse(calls[0].body)).toEqual({ input: 'go' });
    });

    it('parses the display stream frame by frame with the SSE accept header', async () => {
        const frames = [
            { type: 'view', view },
            { type: 'ops', turnId: 't1', at: T, ops: [{ op: 'node:append', turnId: 't1', sectionId: 't1:0', nodeId: 'n0', delta: 'hi' }] }
        ];
        const sse = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(sse));
                controller.close();
            }
        });

        let sentHeaders: Record<string, string> = {};

        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
                calls.push({ method: init?.method ?? 'GET', url: String(input), body: String(init?.body ?? ''), keepalive: false });
                sentHeaders = { ...(init?.headers as Record<string, string> | undefined) };

                return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
            })
        );

        const seen: unknown[] = [];
        const controller = new AbortController();
        await observeView('s 1', (item) => seen.push(item), controller.signal);

        expect(seen).toEqual(frames);
        expect(calls).toEqual([{ method: 'GET', url: '/api/views/s%201/events', body: '', keepalive: false }]);
        // The observer announces itself as a browser on the display surface, exactly like
        // every other harness request (`api.ts` sets the same client marker).
        expect(sentHeaders).toEqual({ Accept: 'text/event-stream', 'X-Harness-Client': 'ui' });
    });

    it('refuses an answer with no body to read frames from', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })));

        await expect(observeView('s1', () => undefined, new AbortController().signal)).rejects.toThrow(
            'The harness server returned an empty event stream.'
        );
    });

    it('reports an observer the server refused, in the server\u2019s own words', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                new Response(JSON.stringify({ error: { message: 'Unknown session "s1".' } }), { status: 404, headers: { 'Content-Type': 'application/json' } })
            )
        );

        await expect(observeView('s1', () => undefined, new AbortController().signal)).rejects.toThrow('Unknown session "s1".');
    });
});

// ---------------------------------------------------------------------------
// R2: the ONE on-click request, and the export reads it answers to
// ---------------------------------------------------------------------------

describe('lazy detail and bounded raw export', () => {
    it('reads one step by its exact address and unwraps the detail', async () => {
        const detail = {
            sessionId: 's1',
            turnId: 't%201',
            stepId: '7',
            sectionId: 't1:0',
            opening: { index: 7, event: { type: 'tool_call', agent: 'instruct', call: { id: 'c1', name: 'read', arguments: '{}' } } }
        };
        serve({ 'GET /api/views/s1/turns/t%201/steps/7': { detail } });

        expect(await getStepDetail('s1', 't 1', '7')).toEqual(detail);
        expect(calls).toEqual([{ method: 'GET', url: '/api/views/s1/turns/t%201/steps/7', body: '', keepalive: false }]);
    });

    it('reads one recorded turn verbatim', async () => {
        serve({ 'GET /api/views/s1/turns/t%201/raw': { turn: turnRecord('t 1') } });

        expect((await getTurnRaw('s1', 't 1')).id).toBe('t 1');
        expect(calls[0].url).toBe('/api/views/s1/turns/t%201/raw');
    });

    it('fetches each named turn once, in order, and skips a turn that went away', async () => {
        serve({
            'GET /api/views/s1/turns/t1/raw': { turn: turnRecord('t1') },
            'GET /api/views/s1/turns/t3/raw': { error: { message: 'Unknown turn "t3".' } }
        }, { 'GET /api/views/s1/turns/t3/raw': 404 });

        const turns = await getThreadTurnsRaw('s1', view, ['t1', 't1', 't3']);

        expect(turns.map((turn) => turn.id)).toEqual(['t1']);
        expect(calls.map((call) => call.url)).toEqual(['/api/views/s1/turns/t1/raw', '/api/views/s1/turns/t3/raw']);
    });

    it('composes the export from the view, the named turns and the transcripts — and never asks for a session-level raw route', async () => {
        serve({
            'GET /api/views/s1': { view },
            'GET /api/views/s1/turns/t1/raw': { turn: turnRecord('t1') },
            'GET /api/views/s1/turns/t2/raw': { turn: turnRecord('t2') },
            'GET /api/views/s1/threads/th-a/transcript': transcriptFor('th-a'),
            'GET /api/views/s1/threads/th-b/transcript': transcriptFor('th-b')
        });

        const session = await getRawSession('s1');

        expect(calls.map((call) => call.url)).toEqual([
            '/api/views/s1',
            '/api/views/s1/turns/t1/raw',
            '/api/views/s1/turns/t2/raw',
            '/api/views/s1/threads/th-a/transcript',
            '/api/views/s1/threads/th-b/transcript'
        ]);
        // The R1 boundary: `GET /views/:id/raw` is NOT mounted on this surface, so a client
        // that probed it would spend a request on a 404 on every export.
        expect(calls.some((call) => call.url.endsWith('/views/s1/raw'))).toBe(false);

        // The document keeps every header field the browser renders and swaps in the
        // recorded turns; `messages` is the ENTRY agent's transcript, which the compiled
        // view does not ship at all, so an empty array is the honest answer.
        expect(session.id).toBe('s 1');
        expect(session.harness).toBe('instruct');
        expect(session.messages).toEqual([]);
        expect(session.turns.map((turn) => turn.id)).toEqual(['t1', 't2']);
        expect(session.turns[0].events).toHaveLength(1);
        // The roster is rebuilt in the raw shape the transcript quotes: identity verbatim
        // from `threadViews`, plus the committed messages.
        expect(((session as unknown as { threads: { id: string; messages: unknown[]; messageCount?: number }[] }).threads).map((entry) => [entry.id, entry.messages.length])).toEqual([
            ['th-a', 1],
            ['th-b', 1]
        ]);
    });

    it('names only the turns an export needs when the caller supplies them', async () => {
        serve({
            'GET /api/views/s1': { view },
            'GET /api/views/s1/turns/t2/raw': { turn: turnRecord('t2') },
            'GET /api/views/s1/threads/th-a/transcript': transcriptFor('th-a'),
            'GET /api/views/s1/threads/th-b/transcript': transcriptFor('th-b')
        });

        const session = await getRawSession('s1', ['t2', 't2']);

        expect(calls.filter((call) => call.url.includes('/turns/')).map((call) => call.url)).toEqual(['/api/views/s1/turns/t2/raw']);
        expect(session.turns.map((turn) => turn.id)).toEqual(['t2']);
    });

    it('skips the transcript reads entirely when the view already carries the raw roster', async () => {
        const withRoster = { ...view, threads: [{ id: 'th-a', agent: 'instruct', origin: 'host', status: 'idle', sequence: 1, messages: [] }] } as unknown as SessionView;
        serve({
            'GET /api/views/s1': { view: withRoster },
            'GET /api/views/s1/turns/t1/raw': { turn: turnRecord('t1') },
            'GET /api/views/s1/turns/t2/raw': { turn: turnRecord('t2') }
        });

        const session = await getRawSession('s1', ['t1']);

        expect(calls.map((call) => call.url)).toEqual(['/api/views/s1', '/api/views/s1/turns/t1/raw']);
        expect(((session as unknown as { threads: unknown[] }).threads)).toHaveLength(1);
    });

    it('keeps a conversation whose transcript read failed listed, with no messages', async () => {
        serve(
            {
                'GET /api/views/s1': { view, turns: [turnRecord('t1'), turnRecord('t2')] },
                'GET /api/views/s1/turns/t1/raw': { turn: turnRecord('t1') },
                'GET /api/views/s1/turns/t2/raw': { turn: turnRecord('t2') },
                'GET /api/views/s1/threads/th-a/transcript': { error: { message: 'Unknown thread "th-a".' } },
                'GET /api/views/s1/threads/th-b/transcript': transcriptFor('th-b')
            },
            { 'GET /api/views/s1/threads/th-a/transcript': 404 }
        );

        const session = await getRawSession('s1');
        const threads = (session as unknown as { threads: { id: string; messages: unknown[] }[] }).threads;

        expect(threads.map((entry) => [entry.id, entry.messages.length])).toEqual([['th-a', 0], ['th-b', 1]]);
    });
});

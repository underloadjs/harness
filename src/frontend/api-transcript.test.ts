// C5 — the transcript routes on the wire, on the CANONICAL mount (T23).
//
// The legacy pair (`GET`/`PUT /api/sessions/:id/threads/:threadId/transcript`, both
// answering `{ session, transcript }` or a bare payload) is gone. The contract splits
// the transcript into FOUR differently sized operations (../shared/harness-api.ts:172-177),
// which is the whole point of the payload rule — "read to display" and "read to edit"
// must not cost the same bytes:
//
//   GET    /v1/harness/sessions/{id}/threads/{thread_id}/transcript              -> TranscriptMetadataResponse  (head: counts, revision, validity — no content)
//   GET    .../transcript/messages?limit=&cursor=&role=                          -> TranscriptMessagePage       (paged entries, `total` for the whole document)
//   GET    .../transcript/document                                              -> TranscriptDocumentResponse    (the whole document as JSON TEXT)
//   PUT    .../transcript                                                       -> TranscriptWriteReceipt        (whole-document write, `if_revision` guard)
//
// The PUT body is `{ messages }` plus `if_revision` only when the caller holds one.
// `messages` is `unknown` ON PURPOSE (../shared/harness-api.ts:1541): a structurally
// broken value is a SUCCESSFUL write reported in the receipt's `invalid`, so the client
// must not validate or reshape it. Every non-2xx keeps the server's own message
// (409 running / 404 unknown / 400 no `messages` / 409 stale revision), which is what the
// dialog shows next to the reader's unchanged text.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts api-transcript.test.ts

import type {
    TranscriptDocumentResponse,
    TranscriptMessagePage,
    TranscriptMetadata,
    TranscriptWriteReceipt
} from '../shared/harness-api';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const metadata: TranscriptMetadata = {
    session_id: 's 1',
    thread_id: 'thread a',
    agent: 'Helper',
    transcript_state: 'ok',
    message_count: 1,
    chars: 18,
    bytes: 24,
    revision: 4,
    role_counts: { system: 0, user: 1, assistant: 0, tool: 0 }
};

const document: TranscriptDocumentResponse = {
    session_id: 's 1',
    thread_id: 'thread a',
    agent: 'Helper',
    revision: 4,
    transcript_state: 'ok',
    document: '[\n  {\n    "role": "user",\n    "content": "child task"\n  }\n]',
    content_type: 'application/json'
};

const messagePage: TranscriptMessagePage = {
    limit: 25,
    next_cursor: 'c2',
    observed_at: 900,
    revision: 4,
    thread_id: 'thread a',
    agent: 'Helper',
    transcript_state: 'ok',
    total: 3,
    items: [{ role: 'user', content: 'child task' } as never]
};

const receipt: TranscriptWriteReceipt = {
    session_id: 's 1',
    thread_id: 'thread a',
    accepted_as: 'transcript',
    message_count: 1,
    revision: 5,
    links: {
        transcript: '/v1/harness/sessions/s%201/threads/thread%20a/transcript',
        messages: '/v1/harness/sessions/s%201/threads/thread%20a/transcript/messages',
        document: '/v1/harness/sessions/s%201/threads/thread%20a/transcript/document'
    }
};

type Call = { method: string; url: string; body: string };

const calls: Call[] = [];

// A stub that THROWS for a route it does not declare, so a client that invents a second
// request (an eager document read behind a metadata call) fails here rather than passing
// silently, and answers every declared route with a real `application/json` body.
const serve = (routes: Record<string, unknown>, statuses: Record<string, number> = {}): void => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const method = init?.method ?? 'GET';
            const url = String(input);
            const body = String(init?.body ?? '');

            calls.push({ method, url, body });

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

beforeEach(() => {
    vi.resetModules();
    calls.length = 0;
    window.history.replaceState(null, '', '/');
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('getTranscriptMetadata', () => {
    it('reads the transcript head route and unwraps the { transcript } envelope', async () => {
        const { getTranscriptMetadata } = await import('./api');
        serve({ 'GET /v1/harness/sessions/s%201/threads/thread%20a/transcript': { transcript: metadata } });

        expect(await getTranscriptMetadata('s 1', 'thread a')).toEqual(metadata);
        // Both ids are URL-encoded: they are data, and a space must not break the path.
        expect(calls).toEqual([
            { method: 'GET', url: '/v1/harness/sessions/s%201/threads/thread%20a/transcript', body: '' }
        ]);
    });
});

describe('listTranscriptMessages', () => {
    it('pages the entries route and composes the page with the transcript-level fields', async () => {
        const { listTranscriptMessages } = await import('./api');
        serve({ 'GET /v1/harness/sessions/s1/threads/t1/transcript/messages?limit=25': messagePage });

        expect(await listTranscriptMessages('s1', 't1')).toEqual({
            items: messagePage.items,
            nextCursor: 'c2',
            revision: 4,
            limit: 25,
            total: 3,
            agent: 'Helper',
            state: 'ok'
        });
        expect(calls).toEqual([
            { method: 'GET', url: '/v1/harness/sessions/s1/threads/t1/transcript/messages?limit=25', body: '' }
        ]);
    });

    it('passes the role filter and the issued cursor verbatim', async () => {
        const { listTranscriptMessages } = await import('./api');
        serve({
            'GET /v1/harness/sessions/s1/threads/t1/transcript/messages?limit=2&cursor=c2&role=tool': messagePage
        });

        await listTranscriptMessages('s1', 't1', { limit: 2, cursor: 'c2', role: 'tool' });

        expect(calls.map((call) => call.url)).toEqual([
            '/v1/harness/sessions/s1/threads/t1/transcript/messages?limit=2&cursor=c2&role=tool'
        ]);
    });
});

describe('getTranscriptDocument', () => {
    it('reads the whole document as one JSON text, separately from the head', async () => {
        const { getTranscriptDocument } = await import('./api');
        serve({ 'GET /v1/harness/sessions/s%201/threads/thread%20a/transcript/document': document });

        expect(await getTranscriptDocument('s 1', 'thread a')).toEqual(document);
        expect(calls).toEqual([
            { method: 'GET', url: '/v1/harness/sessions/s%201/threads/thread%20a/transcript/document', body: '' }
        ]);
    });
});

describe('putTranscriptDocument', () => {
    it('sends the parsed value verbatim and answers the write receipt', async () => {
        const { putTranscriptDocument } = await import('./api');
        serve({ 'PUT /v1/harness/sessions/s1/threads/t1/transcript': receipt });

        const messages = [{ role: 'user', content: 'repaired' }];

        expect(await putTranscriptDocument('s1', 't1', messages)).toEqual(receipt);
        expect(calls).toEqual([
            { method: 'PUT', url: '/v1/harness/sessions/s1/threads/t1/transcript', body: JSON.stringify({ messages }) }
        ]);
    });

    it('sends any JSON value the editor parsed, including the broken ones', async () => {
        const { putTranscriptDocument } = await import('./api');
        serve({ 'PUT /v1/harness/sessions/s1/threads/t1/transcript': receipt });

        for (const value of [{ nope: true }, 'nope', 7, null, []]) {
            await putTranscriptDocument('s1', 't1', value);
        }

        expect(calls.map((call) => call.body)).toEqual([
            JSON.stringify({ messages: { nope: true } }),
            JSON.stringify({ messages: 'nope' }),
            JSON.stringify({ messages: 7 }),
            JSON.stringify({ messages: null }),
            JSON.stringify({ messages: [] })
        ]);
    });

    it('sends `if_revision` only when the caller holds a revision to guard with', async () => {
        const { putTranscriptDocument } = await import('./api');
        serve({ 'PUT /v1/harness/sessions/s1/threads/t1/transcript': receipt });

        await putTranscriptDocument('s1', 't1', [], 4);
        await putTranscriptDocument('s1', 't1', []);

        expect(calls.map((call) => JSON.parse(call.body))).toEqual([
            { messages: [], if_revision: 4 },
            { messages: [] }
        ]);
    });

    it('reports the server message for a refused write', async () => {
        const { putTranscriptDocument } = await import('./api');
        serve(
            { 'PUT /v1/harness/sessions/s1/threads/t1/transcript': { error: { message: 'a running thread cannot have its transcript replaced' } } },
            { 'PUT /v1/harness/sessions/s1/threads/t1/transcript': 409 }
        );

        await expect(putTranscriptDocument('s1', 't1', [])).rejects.toThrow(
            'a running thread cannot have its transcript replaced'
        );
    });

    it('reports a stale optimistic-concurrency guard without overwriting the other writer', async () => {
        const { putTranscriptDocument } = await import('./api');
        serve(
            { 'PUT /v1/harness/sessions/s1/threads/t1/transcript': { error: { message: 'The transcript moved to revision 6.' } } },
            { 'PUT /v1/harness/sessions/s1/threads/t1/transcript': 409 }
        );

        await expect(putTranscriptDocument('s1', 't1', [], 4)).rejects.toThrow(
            'The transcript moved to revision 6.'
        );
    });
});

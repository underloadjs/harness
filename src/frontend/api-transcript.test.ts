// C5 — the transcript routes on the wire.
//
// Pins the fixed server contract the editor is written against:
//   GET    /sessions/:id/threads/:threadId/transcript  -> { transcript }
//   PUT    /sessions/:id/threads/:threadId/transcript  -> { session, transcript }
// The PUT body is EXACTLY `{ messages }` with the value the editor parsed, which is
// `unknown` on purpose: a structurally invalid transcript is accepted with a 200 and
// reported in `transcript.invalid`, so the client must not validate or reshape it.
// Every non-2xx keeps the server's own message (409 running / 404 unknown / 400 no
// `messages`), which is what the dialog shows next to the reader's unchanged text.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts api-transcript.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transcript = {
    threadId: 'thread a',
    agent: 'Helper',
    messages: [{ role: 'user', content: 'child task' }],
    raw: '[\n  {\n    "role": "user",\n    "content": "child task"\n  }\n]'
};

const session = {
    id: 's 1',
    harness: 'instruct',
    status: 'idle',
    model: 'm1',
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    turns: []
};

type Call = { method: string; url: string; body: string };

const calls: Call[] = [];

const respondWith = (value: unknown, status = 200): undefined => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({
                method: init?.method ?? 'GET',
                url: String(input),
                body: String(init?.body ?? '')
            });

            return new Response(JSON.stringify(value), {
                status,
                headers: { 'Content-Type': 'application/json' }
            });
        })
    );

    return undefined;
};

beforeEach(() => {
    vi.resetModules();
    calls.length = 0;
    window.history.replaceState(null, '', '/');
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('getThreadTranscript', () => {
    it('reads the transcript route and unwraps the envelope', async () => {
        respondWith({ transcript });
        const { getThreadTranscript } = await import('./api');

        expect(await getThreadTranscript('s 1', 'thread a')).toEqual(transcript);
        // Both ids are URL-encoded: they are data, and a space must not break the path.
        expect(calls).toEqual([
            { method: 'GET', url: '/api/sessions/s%201/threads/thread%20a/transcript', body: '' }
        ]);
    });

    it('passes an unreadable transcript through as a success', async () => {
        respondWith({
            transcript: { ...transcript, messages: [], invalid: { error: 'messages is not an array', messages: 'nope' } }
        });
        const { getThreadTranscript } = await import('./api');

        expect(await getThreadTranscript('s1', 't1')).toEqual({
            ...transcript,
            messages: [],
            invalid: { error: 'messages is not an array', messages: 'nope' }
        });
    });
});

describe('updateThreadTranscript', () => {
    it('sends the parsed value verbatim and returns the session with the transcript', async () => {
        respondWith({ session, transcript });
        const { updateThreadTranscript } = await import('./api');

        const messages = [{ role: 'user', content: 'repaired' }];
        expect(await updateThreadTranscript('s1', 't1', messages)).toEqual({ session, transcript });
        expect(calls).toEqual([
            {
                method: 'PUT',
                url: '/api/sessions/s1/threads/t1/transcript',
                body: JSON.stringify({ messages })
            }
        ]);
    });

    it('sends any JSON value the editor parsed, including the broken ones', async () => {
        respondWith({ session, transcript });
        const { updateThreadTranscript } = await import('./api');

        for (const value of [{ nope: true }, 'nope', 7, null, []]) {
            await updateThreadTranscript('s1', 't1', value);
        }

        expect(calls.map((call) => call.body)).toEqual([
            JSON.stringify({ messages: { nope: true } }),
            JSON.stringify({ messages: 'nope' }),
            JSON.stringify({ messages: 7 }),
            JSON.stringify({ messages: null }),
            JSON.stringify({ messages: [] })
        ]);
    });

    it('reports the server message for a refused write', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                new Response(JSON.stringify({ error: { message: 'a running thread cannot have its transcript replaced' } }), {
                    status: 409,
                    headers: { 'Content-Type': 'application/json' }
                })
            )
        );
        const { updateThreadTranscript } = await import('./api');

        await expect(updateThreadTranscript('s1', 't1', [])).rejects.toThrow(
            'a running thread cannot have its transcript replaced'
        );
    });
});

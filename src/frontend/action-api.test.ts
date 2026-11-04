// answerAction wire contract (N3), on the CANONICAL mount (T14/T23).
//
// `POST /v1/harness/sessions/{session_id}/actions/{request_id}/answer` body is exactly
// `{ choice }` (../shared/harness-api.ts `AnswerActionRequest`), both ids are URL-encoded,
// and a non-ok answer surfaces the server's message (the card shows it without losing the
// user's selection). Answering is not a task submission: the method never touches /tasks
// or /messages, and the legacy `/api` prefix is gone from the client entirely.
//
// The choice union is request-side snake_case (`option_id`), NOT the internal
// camelCase spelling: a client that sends `optionId` gets a 400 from a closed-object body.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
    vi.resetModules();
    window.history.replaceState(null, '', '/');
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

it('posts the choice to the encoded answer route', async () => {
    const calls: Array<{ url: string; method: string | undefined; body: unknown }> = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({
                url: String(input),
                method: init?.method,
                body: init?.body === undefined ? undefined : JSON.parse(String(init.body))
            });

            // `AnswerActionResult` — the route restates nothing about the choice.
            return json({ ok: true, request_id: 'req/3', resolved_at: 1_700_000_000_000 });
        })
    );

    const { answerAction } = await import('./api');
    const accepted = await answerAction('s 1/2', 'req/3', {
        kind: 'custom',
        text: 'read the docs'
    });

    expect(accepted).toBe(true);
    expect(calls).toEqual([
        {
            url: '/v1/harness/sessions/s%201%2F2/actions/req%2F3/answer',
            method: 'POST',
            body: { choice: { kind: 'custom', text: 'read the docs' } }
        }
    ]);
});

it('sends an option answer with the contract\'s snake_case `option_id` spelling', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) });

            return json({ ok: true, request_id: 'r1', resolved_at: 2 });
        })
    );

    const { answerAction } = await import('./api');

    await answerAction('s1', 'r1', { kind: 'option', option_id: 'b' });

    expect(calls).toEqual([
        { url: '/v1/harness/sessions/s1/actions/r1/answer', body: { choice: { kind: 'option', option_id: 'b' } } }
    ]);
});

it('surfaces the server error message on a rejected answer', async () => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
            json({ error: { message: 'Unknown action request' } }, 404)
        )
    );

    const { answerAction } = await import('./api');

    // A 404 is NOT an accepted status here (unlike a delete): an answer that reached
    // nobody must stay loud, because the composer is gated on that question.
    await expect(
        answerAction('s1', 'req-1', { kind: 'option', option_id: 'b' })
    ).rejects.toThrow('Unknown action request');
});

it('refuses an answer the server acknowledged with ok: false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ ok: false })));

    const { answerAction } = await import('./api');

    await expect(answerAction('s1', 'req-1', { kind: 'custom', text: 'later' })).rejects.toThrow(
        'The harness server did not accept the answer.'
    );
});

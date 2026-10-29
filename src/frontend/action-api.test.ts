// answerAction wire contract (N3).
//
// POST /sessions/:id/actions/:requestId/answer body is exactly { choice }, both
// ids are URL-encoded, and a non-ok answer surfaces the server's message (the
// card shows it without losing the user's selection). Answering is not a task
// submission: the method never touches /tasks or /messages.

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
            return json({ ok: true });
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
            url: '/api/sessions/s%201%2F2/actions/req%2F3/answer',
            method: 'POST',
            body: { choice: { kind: 'custom', text: 'read the docs' } }
        }
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

    await expect(
        answerAction('s1', 'req-1', { kind: 'option', optionId: 'b' })
    ).rejects.toThrow('Unknown action request');
});

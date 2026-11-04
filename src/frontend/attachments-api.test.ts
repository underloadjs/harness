// POST /v1/harness/sessions/{session_id}/tasks payload (T5 clip/attach, T23 canonical).
//
// The wire contract (`SubmitTaskRequest`, ../shared/harness-api.ts:1187) is `{ input }`
// for a text-only turn and `{ input, attachments }` when the composer captured media.
// The array is OMITTED (not `[]`) when empty, so every pre-attachment caller stays
// byte-identical, and the same rule covers `references` and `thread_id` (an empty
// thread id means "open a new conversation", which is the field's absence).
//
// The route moved with the contract: the legacy `POST /api/sessions/:id/tasks` that
// answered `{ session, turn }` is gone. The canonical submit answers 202 with a
// `TaskReceipt` — identity, placement and revisions, never a session document — so the
// client returns the receipt verbatim and the stream supplies the rows.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts attachments-api.test.ts

import type { HarnessAttachment } from '../types';
import type { TaskReceipt } from '../shared/harness-api';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const attachment: HarnessAttachment = {
    id: 'attach-1',
    kind: 'image',
    marker: '[Image 1]',
    name: 'shot.png',
    mime: 'image/png',
    size: 12,
    data: 'iVBORw0KGgoAAAAA'
} as HarnessAttachment;

// The 202 answer of the canonical submit route, verbatim from `TaskReceipt`.
const receipt: TaskReceipt = {
    session_id: 's1',
    turn_id: 't1',
    status: 'queued',
    thread_id: 'th-a',
    queue_position: 1,
    session_revision: 4,
    accepted_at: 1_700_000_000_000,
    links: {
        turn: '/v1/harness/sessions/s1/turns/t1',
        turns: '/v1/harness/sessions/s1/turns?limit=25',
        thread: '/v1/harness/sessions/s1/threads/th-a',
        stream: '/v1/harness/stream'
    }
};

const requests: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];

beforeEach(() => {
    vi.resetModules();
    requests.length = 0;
    window.history.replaceState(null, '', '/');
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            requests.push({
                method: init?.method ?? 'GET',
                url: String(input),
                // Parsed, so an assertion catches an extra OR a missing key, not just a
                // different spelling of one that is present.
                body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
            });

            return new Response(JSON.stringify(receipt), {
                status: 202,
                headers: { 'Content-Type': 'application/json' }
            });
        })
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
});

it('omits attachments for a text-only submit', async () => {
    const { submitTask } = await import('./api');

    expect(await submitTask('s1', { input: 'hello' })).toEqual(receipt);
    expect(requests).toEqual([
        { method: 'POST', url: '/v1/harness/sessions/s1/tasks', body: { input: 'hello' } }
    ]);
});

it('omits attachments when the array is empty', async () => {
    const { submitTask } = await import('./api');

    await submitTask('s1', { input: 'hello', attachments: [] });

    expect(requests).toEqual([
        { method: 'POST', url: '/v1/harness/sessions/s1/tasks', body: { input: 'hello' } }
    ]);
});

it('sends the structured attachment array when present', async () => {
    const { submitTask } = await import('./api');

    await submitTask('s1', { input: 'look [Image 1]', attachments: [attachment] });

    expect(requests).toEqual([
        {
            method: 'POST',
            url: '/v1/harness/sessions/s1/tasks',
            body: { input: 'look [Image 1]', attachments: [attachment] }
        }
    ]);
});

it('names the target conversation as snake_case `thread_id` and drops an empty one', async () => {
    const { submitTask } = await import('./api');

    await submitTask('s 1', { input: 'go', threadId: 'th a' });
    await submitTask('s1', { input: 'go', threadId: '' });

    expect(requests).toEqual([
        { method: 'POST', url: '/v1/harness/sessions/s%201/tasks', body: { input: 'go', thread_id: 'th a' } },
        { method: 'POST', url: '/v1/harness/sessions/s1/tasks', body: { input: 'go' } }
    ]);
});

it('carries the # references and drops the empty collections instead of sending []', async () => {
    const { submitTask } = await import('./api');

    await submitTask('s1', {
        input: 'continue',
        attachments: [],
        references: [],
        threadId: ''
    });
    await submitTask('s1', { input: 'continue', references: [{ turnId: 't2', label: 'RR2' } as never] });

    expect(requests.map((request) => request.body)).toEqual([
        { input: 'continue' },
        { input: 'continue', references: [{ turnId: 't2', label: 'RR2' }] }
    ]);
});

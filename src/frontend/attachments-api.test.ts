// POST /sessions/:id/tasks payload (T5 clip/attach).
//
// The wire contract is `{ input }` for a text-only turn and `{ input, attachments }`
// when the composer captured media. The array is OMITTED (not `[]`) when empty, so
// every pre-attachment caller stays byte-identical.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts attachments-api.test.ts

import type { HarnessAttachment } from '../types';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const attachment: HarnessAttachment = {
    id: 'attach-1',
    kind: 'image',
    marker: '[Image 1]',
    name: 'shot.png',
    mime: 'image/png',
    size: 12,
    data: 'iVBORw0KGgoAAAAA'
};

const result = { session: { id: 's1' }, turn: { id: 't1' } };

const bodies: string[] = [];

beforeEach(() => {
    vi.resetModules();
    bodies.length = 0;
    window.history.replaceState(null, '', '/');
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            bodies.push(`${init?.method ?? 'GET'} ${String(input)} ${String(init?.body ?? '')}`);
            return new Response(JSON.stringify(result), {
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
    const { enqueueTask } = await import('./api');
    await enqueueTask('s1', 'hello');

    expect(bodies).toEqual(['POST /api/sessions/s1/tasks {"input":"hello"}']);
});

it('omits attachments when the array is empty', async () => {
    const { enqueueTask } = await import('./api');
    await enqueueTask('s1', 'hello', []);

    expect(bodies).toEqual(['POST /api/sessions/s1/tasks {"input":"hello"}']);
});

it('sends the structured attachment array when present', async () => {
    const { enqueueTask } = await import('./api');
    await enqueueTask('s1', 'look [Image 1]', [attachment]);

    expect(bodies).toEqual([
        `POST /api/sessions/s1/tasks ${JSON.stringify({ input: 'look [Image 1]', attachments: [attachment] })}`
    ]);
});

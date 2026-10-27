// The harness server, exercised over real HTTP.
//
// The scripted demo preset keeps this test offline and deterministic while still
// covering the whole path: create a session, stream a task, keep the conversation,
// reset it, and call a tool directly.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarnessServer } from './index';
import type { HarnessServer } from './index';
import type {
    HarnessIndex,
    SessionSnapshot,
    SessionStreamItem,
    ToolCallResult,
    ToolIndex
} from './protocol';

let server: HarnessServer;
let base: string;

// Every API request carries this header; see server/handler.ts.
const CLIENT = { 'X-Harness-Client': 'ui' };

beforeAll(async () => {
    server = await startHarnessServer({ port: 0, staticRoot: null });
    base = server.url;
});

afterAll(async () => {
    await server.close();
});

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

const sse = (body: string): SessionStreamItem[] => {
    const items: SessionStreamItem[] = [];

    for (const block of body.split('\n\n')) {
        const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');

        if (data.length > 0) items.push(JSON.parse(data) as SessionStreamItem);
    }

    return items;
};

const createDemoSession = async (): Promise<SessionSnapshot> => {
    const response = await fetch(`${base}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Harness-Client': 'ui' },
        body: JSON.stringify({ harness: 'demo' })
    });

    expect(response.status).toBe(201);
    return (await json<{ session: SessionSnapshot }>(response)).session;
};

const submit = async (id: string, input: string): Promise<SessionStreamItem[]> => {
    const response = await fetch(`${base}/api/sessions/${id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Harness-Client': 'ui' },
        body: JSON.stringify({ input })
    });

    expect(response.status).toBe(200);
    return sse(await response.text());
};

describe('harness server', () => {
    it('lists the catalogue and provider defaults', async () => {
        const response = await fetch(`${base}/api/harnesses`, { headers: CLIENT });
        expect(response.status).toBe(200);

        const index = await json<HarnessIndex>(response);
        const names = index.harnesses.map((harness) => harness.name);

        expect(names).toContain('demo');
        expect(names).toContain('workspace');
        expect(index.harnesses.find((harness) => harness.name === 'demo')?.requiresEndpoint).toBe(false);
        expect(index.defaults.model.length).toBeGreaterThan(0);
    });

    it('lists the tools a client can call directly', async () => {
        const response = await fetch(`${base}/api/tools`, { headers: CLIENT });
        expect(response.status).toBe(200);

        const index = await json<ToolIndex>(response);
        const names = index.tools.map((tool) => tool.name);

        expect(names).toContain('clock');
        expect(names).toContain('readFile');
        expect(names).toContain('runCommand');
        expect(index.tools.find((tool) => tool.name === 'clock')?.group).toBe('Harness tools');
    });

    it('streams a task, persists the session, and accepts another task', async () => {
        const session = await createDemoSession();
        const items = await submit(session.id, 'What time is it?');

        const events = items.filter((item) => item.type === 'event').map((item) => item.event);
        expect(events.map((event) => event.type)).toContain('start');
        expect(events.map((event) => event.type)).toContain('tool_call');
        expect(events.map((event) => event.type)).toContain('done');

        const final = items.at(-1);
        expect(final?.type).toBe('snapshot');

        const snapshot = await json<{ session: SessionSnapshot }>(
            await fetch(`${base}/api/sessions/${session.id}`, { headers: CLIENT })
        );
        expect(snapshot.session.messages.length).toBeGreaterThan(0);
        expect(snapshot.session.status).toBe('idle');

        // A second task continues the same conversation: the demo answers again
        // because its scripted transport reads the last tool message.
        const second = await submit(session.id, 'And once more?');
        expect(second.at(-1)?.type).toBe('snapshot');
    });

    it('resets a session to its seeded instructions', async () => {
        const session = await createDemoSession();
        await submit(session.id, 'What time is it?');

        const response = await fetch(`${base}/api/sessions/${session.id}/reset`, {
            method: 'POST',
            headers: { 'X-Harness-Client': 'ui' }
        });
        expect(response.status).toBe(200);

        const snapshot = (await json<{ session: SessionSnapshot }>(response)).session;
        expect(snapshot.status).toBe('idle');
        expect(snapshot.messages.every((message) => message.role === 'system')).toBe(true);
    });

    it('calls a tool directly with no harness and no model', async () => {
        const response = await fetch(`${base}/api/tools/clock`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Harness-Client': 'ui' },
            body: JSON.stringify({ parameters: 'UTC' })
        });

        expect(response.status).toBe(200);

        const result = await json<ToolCallResult>(response);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect((result.result as { timezone: string }).timezone).toBe('UTC');
        }
    });

    it('reports tool failures as data, not as a broken server', async () => {
        const response = await fetch(`${base}/api/tools/readFile`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Harness-Client': 'ui' },
            body: JSON.stringify({ parameters: 'does/not/exist.txt' })
        });

        expect(response.status).toBe(200);

        const result = await json<ToolCallResult>(response);
        expect(result.ok).toBe(false);
    });

    it('rejects unknown sessions and unknown harnesses', async () => {
        const missing = await fetch(`${base}/api/sessions/not-a-session`, { headers: CLIENT });
        expect(missing.status).toBe(404);

        const unknown = await fetch(`${base}/api/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Harness-Client': 'ui' },
            body: JSON.stringify({ harness: 'nope' })
        });
        expect(unknown.status).toBe(404);
    });

    it('rejects an empty task before opening a stream', async () => {
        const session = await createDemoSession();
        const response = await fetch(`${base}/api/sessions/${session.id}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Harness-Client': 'ui' },
            body: JSON.stringify({ input: '   ' })
        });

        expect(response.status).toBe(400);
    });

    it('refuses a request without the client header', async () => {
        const response = await fetch(`${base}/api/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ harness: 'demo' })
        });

        expect(response.status).toBe(403);
    });
});

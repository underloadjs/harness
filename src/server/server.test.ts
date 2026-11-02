// The harness server, exercised over real HTTP.
//
// The scripted demo preset keeps this test offline and deterministic while still
// covering the whole path: create a session, stream a task, keep the conversation,
// reset it, and call a tool directly. T5 moved that fixture out of the shipped
// catalogue, so the server below is started with the explicit fixture injection (see
// beforeAll); the un-injected production catalogue is pinned elsewhere.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_PRESET_TEMPLATES, createHarnessRegistry } from './harnesses';
import { startHarnessServer } from './index';
import type { HarnessServer } from './index';
import type {
    HarnessIndex,
    DeleteHarnessResult,
    SessionSnapshot,
    SessionStreamItem,
    ToolCallResult,
    ToolIndex
} from './protocol';

let server: HarnessServer;
let base: string;

// Every API request carries this header; see src/server/handler.ts.
const CLIENT = { 'X-Harness-Client': 'ui' };

beforeAll(async () => {
    // T5: the shipped catalogue is the five real roles, none of which run without a
    // provider. This file exercises the whole HTTP path offline (streams, resets,
    // tool calls), so the server is started over the shipped catalogue PLUS the
    // explicit fixtures — exactly the injection a host that wants the offline card
    // performs. The production default (five presets, no fixtures) is pinned by
    // src/server/api.test.ts and by the catalogue assertions in src/structure.test.ts.
    server = await startHarnessServer({
        port: 0,
        staticRoot: null,
        registry: createHarnessRegistry(ALL_PRESET_TEMPLATES)
    });
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

        expect(names).toContain('timeNow');
        expect(names).toContain('read');
        expect(names).toContain('shell');
        expect(index.tools.find((tool) => tool.name === 'timeNow')?.group).toBe('Harness tools');
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
        const response = await fetch(`${base}/api/tools/timeNow`, {
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
        // A missing path is a per-entry result now (read R1), so this uses a
        // genuinely invalid request (the documented "at least one path" rule) to
        // keep the point: an execute rejection is returned as ok:false data.
        const response = await fetch(`${base}/api/tools/read`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Harness-Client': 'ui' },
            body: JSON.stringify({ parameters: [] })
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

    // T5 over the standalone Node adapter (the `/api` mount the shipped UI uses):
    // 200 with exactly `{ deleted: true }`, the card leaves the listing, and an
    // unknown name is a real 404. The service-mount contract is pinned in
    // src/server/api.test.ts; this pins the same route through the Node adapter.
    it('deletes a harness through the standalone adapter', async () => {
        const created = await fetch(`${base}/api/harnesses`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...CLIENT },
            body: JSON.stringify({ name: 'temporary-server-card', primary: 'instruct' })
        });
        expect(created.status).toBe(201);

        const removed = await fetch(`${base}/api/harnesses/temporary-server-card`, {
            method: 'DELETE',
            headers: CLIENT
        });
        expect(removed.status).toBe(200);
        expect(await json<DeleteHarnessResult>(removed)).toEqual({ deleted: true });

        const index = await json<HarnessIndex>(await fetch(`${base}/api/harnesses`, { headers: CLIENT }));
        expect(index.harnesses.map((harness) => harness.name)).not.toContain('temporary-server-card');

        // A repeat delete did not remove anything, so it is not a second success.
        const again = await fetch(`${base}/api/harnesses/temporary-server-card`, {
            method: 'DELETE',
            headers: CLIENT
        });
        expect(again.status).toBe(404);
        expect(await json<{ error: { message: string } }>(again)).toEqual({
            error: { message: 'Unknown harness "temporary-server-card".' }
        });
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

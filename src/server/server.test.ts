// The harness server, exercised over real HTTP.
//
// The scripted demo preset keeps this test offline and deterministic while still
// covering the whole path: create a session, stream a task, keep the conversation,
// reset it, and call a tool directly. T5 moved that fixture out of the shipped
// catalogue, so the server below is started with the explicit fixture injection (see
// beforeAll); the un-injected production catalogue is pinned elsewhere.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_PRESET_TEMPLATES, createHarnessRegistry } from './harnesses';
// The runtime config error type is re-exported by the server barrel; asserting the
// class (not just the message) is what proves a bad deployment value is a
// DEPLOYMENT error rather than a client 400.
import { ServerRuntimeError } from './index';
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

describe('server runtime configuration', () => {
    // R3: the execution model is deployment configuration that the RUNNING server
    // reports, and a configured-but-unsupported model fails at startup instead of
    // degrading into an inline server the operator did not ask for.
    const RUNTIME_DEFAULTS = {
        threadExecution: 'inline',
        workerIdleMs: 120_000,
        maxLaneWorkers: 16,
        workerHandshakeMs: 60_000
    } as const;

    // The four runtime variables, saved and cleared so a developer's shell cannot
    // move the expected defaults (same isolation idiom as ./environment.test.ts).
    const RUNTIME_KEYS = [
        'HARNESS_THREAD_EXECUTION',
        'HARNESS_WORKER_IDLE_MS',
        'HARNESS_MAX_LANE_WORKERS',
        'HARNESS_WORKER_HANDSHAKE_MS',
        'HARNESS_WORKER_ENTRY'
    ] as const;

    const withRuntimeEnvironment = async (
        values: Partial<Record<(typeof RUNTIME_KEYS)[number], string>>,
        run: () => Promise<void>
    ): Promise<void> => {
        const saved: Record<string, string | undefined> = {};

        for (const key of RUNTIME_KEYS) {
            saved[key] = process.env[key];
            delete process.env[key];
        }

        for (const [key, value] of Object.entries(values)) process.env[key] = value;

        try {
            await run();
        } finally {
            for (const key of RUNTIME_KEYS) {
                if (saved[key] === undefined) delete process.env[key];
                else process.env[key] = saved[key];
            }
        }
    };

    it('reports the resolved runtime on a started server', async () => {
        await withRuntimeEnvironment({}, async () => {
            const started = await startHarnessServer({ port: 0, staticRoot: null });

            try {
                expect(started.runtime).toEqual(RUNTIME_DEFAULTS);
            } finally {
                await started.close();
            }
        });
    });

    it('starts with worker execution and reports it as the resolved runtime', async () => {
        // T5 replaced the "substrate only" refusal: `threadExecution: 'worker'` now runs
        // lanes, so startup must SUCCEED and report the mode. The promise an operator checks
        // from the running process is exactly this field - not an inferred default.
        const started = await startHarnessServer({ port: 0, staticRoot: null, runtime: { threadExecution: 'worker' } });

        try {
            expect(started.runtime).toEqual({ ...RUNTIME_DEFAULTS, threadExecution: 'worker' });
            expect(started.store.workerExecution).toBe(true);

            // No lane has been spawned yet: the host exists only once a session actually runs
            // something, so configuring worker mode costs an idle server nothing. (The HTTP
            // surface itself is unchanged in worker mode, and ./workers/lane-worker.test.ts
            // measures that this process keeps answering reads and 10 ms timer ticks while a
            // lane burns CPU - which is what a request depends on.)
            expect((started.store as unknown as { host?: unknown }).host).toBeUndefined();
        } finally {
            await started.close();
        }
    });

    it('refuses an out-of-range worker bound instead of clamping it', async () => {
        await expect(
            startHarnessServer({ port: 0, staticRoot: null, runtime: { maxLaneWorkers: 65 } })
        ).rejects.toThrowError(new ServerRuntimeError('maxLaneWorkers must be an integer between 1 and 64.'));

        await expect(
            startHarnessServer({ port: 0, staticRoot: null, runtime: { workerIdleMs: -1 } })
        ).rejects.toThrowError(new ServerRuntimeError('workerIdleMs must be an integer between 0 and 3600000.'));
    });

    it('honours the HARNESS_* variables and lets explicit options win per field', async () => {
        const saved = {
            mode: process.env.HARNESS_THREAD_EXECUTION,
            idle: process.env.HARNESS_WORKER_IDLE_MS,
            max: process.env.HARNESS_MAX_LANE_WORKERS,
            handshake: process.env.HARNESS_WORKER_HANDSHAKE_MS
        };

        process.env.HARNESS_THREAD_EXECUTION = 'inline';
        process.env.HARNESS_WORKER_IDLE_MS = '1000';
        process.env.HARNESS_MAX_LANE_WORKERS = '2';
        process.env.HARNESS_WORKER_HANDSHAKE_MS = '2000';

        let fromEnvironment: HarnessServer | undefined;

        try {
            fromEnvironment = await startHarnessServer({ port: 0, staticRoot: null });

            expect(fromEnvironment.runtime).toEqual({
                threadExecution: 'inline',
                workerIdleMs: 1000,
                maxLaneWorkers: 2,
                workerHandshakeMs: 2000
            });

            // An explicit field replaces only itself; the other environment values
            // stay, which is what a service host passing `variables` expects.
            const overridden = await startHarnessServer({
                port: 0,
                staticRoot: null,
                runtime: { maxLaneWorkers: 3 }
            });

            try {
                expect(overridden.runtime).toEqual({
                    threadExecution: 'inline',
                    workerIdleMs: 1000,
                    maxLaneWorkers: 3,
                    workerHandshakeMs: 2000
                });
            } finally {
                await overridden.close();
            }
        } finally {
            if (fromEnvironment !== undefined) await fromEnvironment.close();

            for (const [key, value] of Object.entries({
                HARNESS_THREAD_EXECUTION: saved.mode,
                HARNESS_WORKER_IDLE_MS: saved.idle,
                HARNESS_MAX_LANE_WORKERS: saved.max,
                HARNESS_WORKER_HANDSHAKE_MS: saved.handshake
            })) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    });
});

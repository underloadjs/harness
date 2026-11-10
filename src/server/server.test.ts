// The harness server, exercised over real HTTP.
//
// The scripted demo preset keeps this test offline and deterministic while still
// covering the whole path: create a session, stream a task, keep the conversation,
// reset it, and call a tool directly. T5 moved that fixture out of the shipped
// catalogue, so the server below is started with the explicit fixture injection (see
// beforeAll); the un-injected production catalogue is pinned elsewhere.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarnessRegistry } from './harnesses';
import { PRODUCTION_WITH_FIXTURES } from './harnesses/fixture-presets.test-support';
// The mount is the REST owner's constant, imported rather than spelled: the standalone listener now
// serves the canonical `/v1/harness` root (there is no `/api` any more), and a test that hard-coded
// the old root would fail the moment the contract root moved — which is exactly what happened.
import { STANDALONE_MOUNT } from './api';
// T18: every path, status, and payload below is stated the way the GENERATED contract states it
// (`src/shared/harness-api.ts`, produced from src/server/harness.swagger.yaml). That is deliberate:
// a network test that re-derives a path from the implementation cannot catch a route that moved,
// and the legacy spellings this file used (`/messages`, `/presets`, a streamed submit) are exactly
// the things the target contract removed.
import { HARNESS_ROUTES } from '../shared/harness-api';
import type {
    DeleteHarnessResult,
    GlobalConfigDocument,
    HarnessCardPage,
    ResetSessionResult,
    SessionResponse,
    SessionSummary,
    TaskReceipt,
    ToolCallResult,
    ToolSummaryPage,
    TurnEventPage,
    TurnEventRow,
    TurnResource,
    TurnResponse,
    TurnSummaryPage
} from '../shared/harness-api';
// The runtime config error type is re-exported by the server barrel; asserting the
// class (not just the message) is what proves a bad deployment value is a
// DEPLOYMENT error rather than a client 400.
import { ServerRuntimeError } from './index';
import { startHarnessServer } from './index';
import type { HarnessServer } from './index';

let server: HarnessServer;
let base: string;

// T15 removed the standalone `X-Harness-Client` gate (see src/server/handler.ts), and the target
// contract's mount is the canonical `/v1/harness`. The header is still SENT by these requests
// because the shipped UI sends it and a server must tolerate it; nothing here depends on it, and the
// dedicated test below pins that.
const CLIENT = { 'X-Harness-Client': 'ui' };

beforeAll(async () => {
    // T5: the shipped catalogue is the production roles, none of which run without a
    // provider. This file exercises the whole HTTP path offline (streams, resets,
    // tool calls), so the server is started over the shipped catalogue PLUS the
    // explicit fixtures — exactly the injection a host that wants the offline card
    // performs. The production default (seven presets, no fixtures) is pinned by
    // src/server/api.test.ts and by the catalogue assertions in src/structure.test.ts.
    server = await startHarnessServer({
        port: 0,
        staticRoot: null,
        registry: createHarnessRegistry(PRODUCTION_WITH_FIXTURES)
    });
    base = server.url;
});

afterAll(async () => {
    await server.close();
});

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

/**
 * Bounded poll over one contract READ. The target contract makes a submit asynchronous (202 plus a
 * receipt), so a test observes completion the way a client does: re-read the named resource until it
 * settles. The predicate, not the delay, decides when the read is meaningful.
 */
const until = async <T>(read: () => Promise<T>, settle: (value: T) => boolean, timeoutMs = 20_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    let last: T | undefined;

    for (;;) {
        last = await read();
        if (settle(last)) return last;
        if (Date.now() > deadline) return last;
        await new Promise((resolve) => setTimeout(resolve, 40));
    }
};

const createDemoSession = async (): Promise<SessionSummary> => {
    const response = await fetch(`${base}${HARNESS_ROUTES.sessions()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Harness-Client': 'ui' },
        // `harness` is the snake/free-form selection field the generated `CreateSessionRequest` carries.
        body: JSON.stringify({ harness: 'demo' })
    });

    expect(response.status).toBe(201);
    return (await json<SessionResponse>(response)).session;
};

/**
 * The durable submit: `POST /sessions/{id}/tasks`. The answer is `202` plus a `TaskReceipt`, NOT a
 * streamed body — the server owns execution, and a client that hangs up does not cancel the run
 * (spec `submitSessionTask`). The old `/messages` SSE surface is gone, so the run is observed through
 * the turn reads below, which is what the receipt's own `links` point at.
 */
const submit = (id: string, input: string): Promise<Response> =>
    fetch(`${base}${HARNESS_ROUTES.sessionsBySessionIdTasks(id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Harness-Client': 'ui' },
        body: JSON.stringify({ input })
    });

/**
 * The identified turn read. The envelope is the generated `TurnResponse` (`{ turn: ... }`), NOT the
 * bare resource — reading the resource directly is the classic way this test silently never settles,
 * because `status` would be `undefined` forever. A 404 (turn not visible yet) yields a pending
 * sentinel so the caller's poll keeps trying.
 */
const readTurn = async (id: string, turnId: string): Promise<TurnResource> => {
    const response = await fetch(`${base}${HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnId(id, turnId)}`, { headers: CLIENT });

    if (response.status !== 200) return { status: 'queued' } as TurnResource;

    return (await json<TurnResponse>(response)).turn;
};

/**
 * Read a whole page sequence with the contract's OWN cursor. One run records more events than a page
 * holds, so an assertion about the run's shape must walk `next_cursor` — which is exactly what a
 * client that fell behind on the stream does on the REST side. Bounded at 20 pages so a broken cursor
 * fails the test instead of hanging it.
 */
const readAllEvents = async (id: string, turnId: string): Promise<TurnEventRow[]> => {
    const rows: TurnEventRow[] = [];
    let cursor: string | null | undefined;

    for (let page = 0; page < 20; page += 1) {
        const body = await json<TurnEventPage>(
            await fetch(
                `${base}${HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnIdEvents(id, turnId)}?limit=100${
                    cursor === null || cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`
                }`,
                { headers: CLIENT }
            )
        );

        rows.push(...body.items);
        cursor = body.next_cursor;

        if (cursor === null || cursor === undefined) return rows;
    }

    throw new Error(`the events page sequence for ${turnId} never terminated`);
};

/** One submit, taken all the way to a settled turn — the behavioral assertion the old SSE body gave. */
const submitSettled = async (id: string, input: string): Promise<TaskReceipt> => {
    const response = await submit(id, input);
    expect(response.status).toBe(202);

    const receipt = await json<TaskReceipt>(response);
    const settled = await until(
        () => readTurn(id, receipt.turn_id),
        (turn) => turn.status === 'done' || turn.status === 'error' || turn.status === 'cancelled',
        12_000
    );

    // A run that never settles is a real contract failure (the server owns execution and must finish
    // it with no stream attached), so the report says which status it stuck at.
    expect({ turn_id: settled.id, status: settled.status }).toEqual({ turn_id: receipt.turn_id, status: 'done' });

    return receipt;
};

describe('harness server', () => {
    it('lists the catalogue and provider defaults', async () => {
        const response = await fetch(`${base}${HARNESS_ROUTES.harnesses()}`, { headers: CLIENT });
        expect(response.status).toBe(200);

        // The contract carries the epoch on EVERY response, and the adapter is the only layer that
        // can put the dispatcher's stamp on the wire. It must be the same value the stream reports,
        // which is what makes a `subscription_state.revisions` record comparable with a page read.
        expect(response.headers.get('x-harness-epoch')).toBe(server.events.epoch);
        expect(server.stream.broker.epoch()).toBe(server.events.epoch);

        const page = await json<HarnessCardPage>(response);
        const names = page.items.map((harness) => harness.name);

        expect(names).toContain('demo');
        expect(names).toContain('workspace');
        expect(page.items.find((harness) => harness.name === 'demo')?.requires_endpoint).toBe(false);
        // The envelope is the contract's `PageMeta` plus `items`: a bounded page with the revision it
        // was read at, which is what a stream client compares a frame against.
        expect(Object.keys(page).sort()).toEqual(['items', 'limit', 'next_cursor', 'observed_at', 'revision']);

        // Provider defaults are no longer fields of the boot document: they are the configuration
        // read, in the generated `ProviderDefaults` spelling (snake_case, and the key is never sent).
        const config = await json<GlobalConfigDocument>(
            await fetch(`${base}${HARNESS_ROUTES.config()}`, { headers: CLIENT })
        );

        expect(config.defaults.model.length).toBeGreaterThan(0);
        expect(Object.keys(config.defaults)).toEqual(['base_url', 'model', 'has_api_key']);
    });

    it('lists the tools a client can call directly', async () => {
        const response = await fetch(`${base}${HARNESS_ROUTES.tools()}`, { headers: CLIENT });
        expect(response.status).toBe(200);

        // `limit=100`: the page is capped, and the record engine added rows to the
        // catalogue (T3), so a default page no longer provably contains every tool. The
        // pagination probe below still asks for exactly one row.
        const page = await json<ToolSummaryPage>(
            await fetch(`${base}${HARNESS_ROUTES.tools()}?limit=100`, { headers: CLIENT })
        );
        const names = page.items.map((tool) => tool.name);

        expect(names).toContain('timeNow');
        expect(names).toContain('read');
        expect(names).toContain('shell');
        expect(page.items.find((tool) => tool.name === 'timeNow')?.group).toBe('Harness tools');

        // Query plumbing (T18): the Node adapter forwards the query string to the dispatcher, so a
        // page actually honors `limit` and hands back the cursor the client needs for the next one.
        const small = await json<ToolSummaryPage>(
            await fetch(`${base}${HARNESS_ROUTES.tools()}?limit=1`, { headers: CLIENT })
        );

        expect({ limit: small.limit, items: small.items.length, cursor: typeof small.next_cursor }).toEqual({
            limit: 1,
            items: 1,
            cursor: 'string'
        });

        // A `q` filter narrows the page without widening the row shape (spec `listHarnesses.q`:
        // case-insensitive substring over `name`, `title`, `description`).
        const filtered = await json<HarnessCardPage>(
            await fetch(`${base}${HARNESS_ROUTES.harnesses()}?limit=10&q=demo`, { headers: CLIENT })
        );

        expect(filtered.items.length).toBeGreaterThan(0);
        expect(filtered.items.every((harness) => harness.name.includes('demo'))).toBe(true);
    });

    it('runs a task, persists the session, and accepts another task', async () => {
        const session = await createDemoSession();
        const receipt = await submitSettled(session.id, 'What time is it?');

        // A submit answers with a receipt and nothing else. `links` is the contract's own pointer to
        // the reads that carry the outcome, and `links.stream` is the update stream the frames for
        // this turn arrive on — the surface the realtime owner owns.
        expect(['queued', 'running']).toContain(receipt.status);
        expect({
            session_id: receipt.session_id,
            turn_id: receipt.turn_id,
            turn_link: receipt.links.turn,
            turns_link: receipt.links.turns,
            stream_link: receipt.links.stream
        }).toEqual({
            session_id: session.id,
            turn_id: receipt.turn_id,
            turn_link: HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnId(session.id, receipt.turn_id),
            turns_link: HARNESS_ROUTES.sessionsBySessionIdTurns(session.id),
            stream_link: HARNESS_ROUTES.stream()
        });

        // The recorded events are the run's evidence, read the same bounded way the opt-in
        // `run.event` stream kind ships them. This keeps the ORIGINAL assertion — the run opened,
        // called a tool, and committed an answer — without leaning on a streamed response body.
        const events = await readAllEvents(session.id, receipt.turn_id);

        expect(events.map((row) => row.event.type)).toEqual(
            expect.arrayContaining(['start', 'tool_call', 'done'])
        );
        // The journal positions are contiguous from 0, which is what makes the stream's
        // `run.event` cursor meaningful against a REST re-read of the same turn.
        expect(events.map((row) => row.index)).toEqual(events.map((_row, position) => position));

        const persisted = await json<SessionResponse>(
            await fetch(`${base}${HARNESS_ROUTES.sessionsBySessionId(session.id)}`, { headers: CLIENT })
        );

        expect(persisted.session.status).toBe('idle');
        // "the conversation persisted", in the contract's vocabulary: the session owns one turn and
        // the one new thread the unfocused submit opened.
        expect({ turn_count: persisted.session.turn_count, thread_count: persisted.session.thread_count }).toEqual({
            turn_count: 1,
            thread_count: 1
        });

        // A second task continues the same conversation: the demo answers again
        // because its scripted transport reads the last tool message.
        const second = await submitSettled(session.id, 'And once more?');
        expect(second.turn_id).not.toBe(receipt.turn_id);

        const turns = await json<TurnSummaryPage>(
            await fetch(`${base}${HARNESS_ROUTES.sessionsBySessionIdTurns(session.id)}?limit=10`, { headers: CLIENT })
        );

        expect([...turns.items.map((turn) => turn.id)].sort()).toEqual([receipt.turn_id, second.turn_id].sort());
        expect(turns.items.map((turn) => turn.status)).toEqual(['done', 'done']);
    });

    it('resets a session to its seeded instructions', async () => {
        const session = await createDemoSession();
        await submitSettled(session.id, 'What time is it?');

        const response = await fetch(`${base}${HARNESS_ROUTES.sessionsBySessionIdReset(session.id)}`, {
            method: 'POST',
            headers: { 'X-Harness-Client': 'ui' }
        });
        expect(response.status).toBe(200);

        // A reset is a receipt, not an aggregate: it names what was discarded, never the emptied
        // conversation (`ResetSessionResult`). One turn and one thread existed, so those are the
        // exact counts, and nothing was queued.
        const receipt = await json<ResetSessionResult>(response);
        expect({ ...receipt, revision: undefined }).toEqual({
            reset: true,
            session_id: session.id,
            discarded_turns: 1,
            discarded_threads: 1,
            dropped_queued_tasks: 0,
            revision: undefined
        });

        // The behavioral half of the old assertion ("only the seeded instructions remain"): no turn
        // survives a reset, so the turns page is empty and the session is back to idle.
        const turns = await json<TurnSummaryPage>(
            await fetch(`${base}${HARNESS_ROUTES.sessionsBySessionIdTurns(session.id)}`, { headers: CLIENT })
        );

        expect(turns.items).toEqual([]);

        const after = await json<SessionResponse>(
            await fetch(`${base}${HARNESS_ROUTES.sessionsBySessionId(session.id)}`, { headers: CLIENT })
        );

        expect({ status: after.session.status, turn_count: after.session.turn_count }).toEqual({
            status: 'idle',
            turn_count: 0
        });
        // The receipt's revision is the revision the read landed at — the reconciliation rule the
        // stream's `subscription_state.revisions` depends on.
        expect(after.session.revision).toBe(receipt.revision);
    });

    it('calls a tool directly with no harness and no model', async () => {
        // The direct-call surface is `POST /tools/{tool_id}/executions` and its body carries
        // `parameters` only (no session field exists on this route). `timeNow` requires a `timezone`
        // label, so the argument object is asserted in that schema's shape.
        const response = await fetch(`${base}${HARNESS_ROUTES.toolsByToolIdExecutions('timeNow')}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Harness-Client': 'ui' },
            body: JSON.stringify({ parameters: { timezone: 'UTC' } })
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
        const response = await fetch(`${base}${HARNESS_ROUTES.toolsByToolIdExecutions('read')}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Harness-Client': 'ui' },
            body: JSON.stringify({ parameters: { paths: [] } })
        });

        expect(response.status).toBe(200);

        const result = await json<ToolCallResult>(response);
        expect(result.ok).toBe(false);
    });

    it('rejects unknown sessions and unknown harnesses', async () => {
        const missing = await fetch(`${base}${HARNESS_ROUTES.sessionsBySessionId('not-a-session')}`, { headers: CLIENT });
        expect(missing.status).toBe(404);

        const unknown = await fetch(`${base}${HARNESS_ROUTES.sessions()}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Harness-Client': 'ui' },
            body: JSON.stringify({ harness: 'nope' })
        });
        expect(unknown.status).toBe(404);
    });

    it('rejects an empty task before accepting it', async () => {
        const session = await createDemoSession();
        const response = await fetch(`${base}${HARNESS_ROUTES.sessionsBySessionIdTasks(session.id)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Harness-Client': 'ui' },
            body: JSON.stringify({ input: '   ' })
        });

        // Whitespace-only input with no attachment is refused up front, and nothing mutates: the
        // contract refuses before a turn record exists, so the turns page stays empty.
        expect(response.status).toBe(400);

        const turns = await json<TurnSummaryPage>(
            await fetch(`${base}${HARNESS_ROUTES.sessionsBySessionIdTurns(session.id)}`, { headers: CLIENT })
        );
        expect(turns.items).toEqual([]);
    });

    // The card deletion is asserted through the GENERATED result (`DeleteHarnessResult`): a destructive
    // route reports what it removed and whether a restart would bring it back, and nothing else. The
    // service-mount contract is pinned in src/server/api.test.ts; this pins the same route through the
    // Node adapter.
    it('deletes a harness through the standalone adapter', async () => {
        const created = await fetch(`${base}${HARNESS_ROUTES.harnesses()}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...CLIENT },
            body: JSON.stringify({ name: 'temporary-server-card', primary: 'instruct' })
        });
        expect(created.status).toBe(201);

        const removed = await fetch(`${base}${HARNESS_ROUTES.harnessesByHarnessName('temporary-server-card')}`, {
            method: 'DELETE',
            headers: CLIENT
        });
        expect(removed.status).toBe(200);
        expect(await json<DeleteHarnessResult>(removed)).toEqual({
            deleted: true,
            harness_name: 'temporary-server-card',
            tombstoned: false,
            restored_by_restart: false
        });

        const index = await json<HarnessCardPage>(
            await fetch(`${base}${HARNESS_ROUTES.harnesses()}`, { headers: CLIENT })
        );
        expect(index.items.map((harness) => harness.name)).not.toContain('temporary-server-card');

        // A repeat delete did not remove anything, so it is not a second success.
        const again = await fetch(`${base}${HARNESS_ROUTES.harnessesByHarnessName('temporary-server-card')}`, {
            method: 'DELETE',
            headers: CLIENT
        });
        expect(again.status).toBe(404);
        expect(await json<{ error: { message: string } }>(again)).toEqual({
            error: { message: 'Unknown harness "temporary-server-card".' }
        });
    });

    it('serves a request that carries no X-Harness-Client header', async () => {
        // T15: the client-hint gate is gone, so the absence of the header is no longer a 403. The
        // standalone rule is now the same one the stream applies — a browser Origin policy, which a
        // non-browser client (no Origin) simply is not subject to.
        const response = await fetch(`${base}${HARNESS_ROUTES.sessions()}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ harness: 'demo' })
        });

        expect(response.status).toBe(201);

        // The envelope is `{ session }` per the generated `SessionResponse`, and the row is the
        // contract's `SessionSummary` — so this also pins that the retired header changed nothing
        // about the body.
        const created = await json<SessionResponse>(response);
        expect(created.session.harness).toBe('demo');
        expect(created.session.id).toBeTruthy();
    });
});

describe('server runtime configuration', () => {
    // R3: the execution model is deployment configuration that the RUNNING server
    // reports, and a configured-but-unsupported model fails at startup instead of
    // degrading into an inline server the operator did not ask for.
    const RUNTIME_DEFAULTS = {
        threadExecution: 'inline',
        ioExecution: 'inline',
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
                ioExecution: 'inline',
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
                    ioExecution: 'inline',
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

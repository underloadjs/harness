// Real @underload/service integration for the harness endpoint.
//
// This starts an actual `vite-node` process running the real service loader
// (`packages/underload/service/src/server/start.ts`) with its scan root pointed
// at the harness package. The loader therefore discovers the REAL
// `endpoint/harness/service-route*.ts` modules, imports them through vite-node's
// TypeScript transform (exactly as `yarn start-service` does), and serves them on
// an ephemeral port.
//
// Why a child process instead of importing startServer: the loader imports
// endpoint modules with `import(pathToFileURL(filePath).href)`. Under Vitest that
// is Node's native loader, which cannot evaluate `.ts`; vite-node is the
// production path that can. The child also isolates the lazy runtime's `.env`
// load and its module-level singleton store.
//
// The bound port is obtained without ever passing a concrete port (which would
// make the service call `killPort`): the driver patches `http.Server.listen` and
// prints the OS-assigned port for the port-0 bind. No process is ever killed.
//
// Network: loopback HTTP only. The demo preset this suite streams against is scripted
// and offline; T5 moved it out of the shipped catalogue, so the driver below injects
// the fixtures explicitly (see the setHarnessRuntime call).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_API_BODY_BYTES } from './api';
import { MAX_SUBMIT_BODY_BYTES } from '../shared/attachments';
// T18: paths, envelopes, and statuses are stated from the GENERATED contract module, so this suite
// pins the target wire (canonical `/v1/harness`, paged catalogues, 202 submit receipts, the executions
// route for a direct tool call) instead of the legacy adapter shapes it grew.
import { HARNESS_API_ROOT, HARNESS_PATH_TEMPLATES, HARNESS_ROUTES } from '../shared/harness-api';
import type {
    DeleteSessionResult,
    GlobalConfigDocument,
    HarnessCardPage,
    ResetSessionResult,
    SessionDefinitionResponse,
    SessionResponse,
    SessionSummary,
    SessionSummaryPage,
    TaskReceipt,
    ToolCallResult,
    ToolSummaryPage,
    TurnEventPage,
    TurnEventRow,
    TurnResource,
    TurnResponse
} from '../shared/harness-api';
import type { ServiceInfo } from '../shared/harness-api';

// src/server/ -> package root is two levels up.
const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../../..');
const TEMP_ROOT = path.join(REPO_ROOT, 'Temp');
const WORK_DIR = path.join(TEMP_ROOT, `harness-service-start-${process.pid}-${Date.now()}`);
// The loader's variables.root for this child: a real directory under Temp, so the
// persistence path is exercised end-to-end (DATABASE_ROOT -> runtime -> disk).
const DATABASE_ROOT = path.join(WORK_DIR, 'database');

// This package is also published as a standalone repository (see package.json
// repository/homepage). The service integration only exists inside the noobscript
// workspace, so the suite skips itself when the sibling package is absent instead
// of failing standalone CI.
const SERVICE_START = path.join(REPO_ROOT, 'packages/underload/service/src/server/start.ts');
const HAS_SERVICE = fs.existsSync(SERVICE_START);
const describeService = HAS_SERVICE ? describe : describe.skip;

const DRIVER = `// Scratch integration driver written by src/server/service-start.test.ts.
// Scans the harness package for endpoint modules and serves them on port 0.
import http from 'node:http';
import { startServer } from '../../packages/underload/service/src/server/start';
import { createHarnessRegistry } from '../../packages/underload/harness/src/server/harnesses';
import { PRODUCTION_WITH_FIXTURES } from '../../packages/underload/harness/src/server/harnesses/fixture-presets.test-support';
import { createHarnessRuntime, setHarnessRuntime } from '../../packages/underload/harness/src/server/runtime';

const target = http.Server.prototype as unknown as { listen: (...args: unknown[]) => unknown };
const originalListen = target.listen;

// Report the OS-assigned port for the port-0 gateway bind. Port 0 is what keeps
// startServer from calling killPort, so this test can never kill another process.
target.listen = function (this: http.Server, ...args: unknown[]) {
    const callback = args[args.length - 1];

    if (typeof callback === 'function') {
        args[args.length - 1] = function (this: http.Server) {
            const address = this.address();
            if (address !== null && typeof address === 'object') {
                console.log('HARNESS_SERVICE_PORT=' + address.port);
            }
            return (callback as () => void).call(this);
        };
    }

    return originalListen.apply(this, args);
};

// T5: the production service catalogue is the seven real roles, none of which run
// without a provider. This suite's end-to-end assertions (a streamed turn, a reset,
// a persisted session under the loader's variables.root) need an OFFLINE harness, so
// the driver pre-seeds the root-keyed runtime with the shipped catalogue plus the
// explicit fixtures. getHarnessRuntime keeps one runtime per resolved root, so the
// discovered route reuses this one instead of building the default: everything else
// (loader -> endpoint -> handler -> <root>/harness/state.json) is the real path.
const serviceRoot = process.env.HARNESS_SERVICE_DATABASE_ROOT;
setHarnessRuntime(
    createHarnessRuntime({
        ...(serviceRoot === undefined ? {} : { root: serviceRoot }),
        registry: createHarnessRegistry(PRODUCTION_WITH_FIXTURES)
    }),
    serviceRoot
);

const server = await startServer({
    root: process.env.HARNESS_SERVICE_SCAN_ROOT,
    port: 0,
    host: '127.0.0.1',
    // The production service supplies DATABASE_ROOT through variables.root; the
    // test does the same with a Temp directory, so persistence exercises the real
    // loader -> handler -> disk path (and never writes into the package tree).
    variables: { root: process.env.HARNESS_SERVICE_DATABASE_ROOT }
});

console.log('HARNESS_SERVICE_READY');

const shutdown = () => {
    void server.close().then(
        () => process.exit(0),
        () => process.exit(1)
    );
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
`;

// The catalogue the driver-injected runtime serves (T5 + the roster/role-contract
// pass): the EIGHT shipped production presets plus the two fixtures the driver
// registers so this suite can run a real turn offline. An un-injected runtime lists
// only the first eight. Order is the shipped catalogue order, fixtures last
// (../harnesses/presets.ts + PRODUCTION_WITH_FIXTURES). The trailing production card is
// `chat`, the tool-less card of issue 0005-D — production, so it ships in the list, and
// last because it is not a role.
const PRESET_NAMES = [
    'general',
    'instruct',
    'research',
    'workspace',
    'reviewer',
    'planner',
    'debugger',
    'chat',
    'demo',
    'flaky'
];

// Core tools lead the catalogue (R8) in every listing surface, including the
// bootstrap document the service loader serves at GET /v1/harness. R9-R11 changed
// DECLARATION (visibility), not the catalogue: every session-bound runtime row is
// still listed here, in kernel registration order.
const TOOL_NAMES = [
    'toolRegistry',
    'toolRequest',
    'toolList',
    'toolManage',
    'toolCreate',
    'records',

    'tasks',
    'profiles',
    'chapters',
    'locations',
    'agentManage',
    'agentResult',
    'delegate',
    // N4: conditional harness-owned tools, appended to the global catalogue.
    'actionRequest',
    'threadFork',
    'syntax',
    'read',
    'write',
    'edit',
    'files',
    'glob',
    'grep',
    'shell',
    'gitDiff',
    'download',
    'timeNow',
    'textCount',
    'diceRoll',
    'noteSearch',
    'textSummarize',
    'search',
    // R9-R11: the web core pair is listed together (src/server/harnesses/webfetch.ts).
    'fetch'
];

const parseSse = (text: string): SessionStreamItem[] => {
    const items: SessionStreamItem[] = [];

    for (const block of text.split('\n\n')) {
        const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');

        if (data.length > 0) items.push(JSON.parse(data) as SessionStreamItem);
    }

    return items;
};

type Child = ReturnType<typeof spawn>;

let child: Child;
let base = '';
let output = '';
let errors = '';

// Wait for a marker on the child's stdout, failing fast if the process exits.
const waitFor = (pattern: RegExp, timeoutMs: number): Promise<RegExpMatchArray> =>
    new Promise<RegExpMatchArray>((resolve, reject) => {
        const started = Date.now();

        const inspect = (): void => {
            const match = output.match(pattern);
            if (match !== null) {
                clearInterval(poll);
                resolve(match);
            } else if (Date.now() - started > timeoutMs) {
                clearInterval(poll);
                reject(new Error(`Timed out waiting for ${pattern}. stdout:\n${output}\nstderr:\n${errors}`));
            }
        };

        const poll = setInterval(inspect, 50);
        inspect();
    });

beforeAll(async () => {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORK_DIR, 'driver.ts'), DRIVER, 'utf8');

    child = spawn(
        process.execPath,
        [path.join(REPO_ROOT, 'node_modules', 'vite-node', 'dist', 'cli.mjs'), path.join(WORK_DIR, 'driver.ts')],
        {
            cwd: REPO_ROOT,
            env: {
                ...process.env,
                // Scan only the harness package: its real endpoint folder, not
                // every distribution endpoint in the repository.
                HARNESS_SERVICE_SCAN_ROOT: PACKAGE_ROOT,
                // The loader forwards this as variables.root to the handler.
                HARNESS_SERVICE_DATABASE_ROOT: DATABASE_ROOT,
                TEMP: TEMP_ROOT,
                TMP: TEMP_ROOT,
                TMPDIR: TEMP_ROOT
            },
            stdio: ['ignore', 'pipe', 'pipe']
        }
    );

    child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
        errors += chunk.toString('utf8');
    });

    const [, port] = await waitFor(/HARNESS_SERVICE_PORT=(\d+)/, 25_000);
    await waitFor(/HARNESS_SERVICE_READY/, 25_000);
    base = `http://127.0.0.1:${port}`;
}, 40_000);

afterAll(async () => {
    if (child !== undefined && child.exitCode === null) {
        const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        child.kill();
        await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
    }

    fs.rmSync(WORK_DIR, { recursive: true, force: true });
});

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

/**
 * T18: the target contract makes a submit asynchronous (202 + receipt), so completion is observed by
 * re-reading the turn the receipt names — the same walk a stream client does when its cursor is gone.
 */
const until = async <T>(read: () => Promise<T>, settle: (value: T) => boolean, timeoutMs = 12_000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    let last: T | undefined;

    for (;;) {
        last = await read();
        if (settle(last)) return last;
        if (Date.now() > deadline) return last;
        await new Promise((resolve) => setTimeout(resolve, 40));
    }
};

const readTurn = async (base: string, sessionId: string, turnId: string): Promise<TurnResource> => {
    const response = await fetch(`${base}${HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnId(sessionId, turnId)}`);
    if (response.status !== 200) return { status: 'queued' } as TurnResource;
    return (await json<TurnResponse>(response)).turn;
};

/** Walk the events page with the contract's own cursor; one run outgrows a single page. */
const readAllEvents = async (base: string, sessionId: string, turnId: string): Promise<TurnEventRow[]> => {
    const rows: TurnEventRow[] = [];
    let cursor: string | null | undefined;

    for (let page = 0; page < 30; page += 1) {
        const body = await json<TurnEventPage>(
            await fetch(
                `${base}${HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnIdEvents(sessionId, turnId)}?limit=100${
                    cursor === null || cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`
                }`
            )
        );

        rows.push(...body.items);
        cursor = body.next_cursor;

        if (cursor === null || cursor === undefined) return rows;
    }

    throw new Error(`the events page sequence for ${turnId} never terminated`);
};

describeService('service endpoint discovery and canonical API', () => {
    it('is discoverable from the repository root the production service scans', async () => {
        // packages/underload/service/server.ts passes the repository root to
        // startServer, so this is the exact scan the deployed service performs.
        // Imported dynamically: the module does not exist in a standalone clone,
        // and the suite is already skipped there. Three levels up from src/server/
        // is packages/underload, where the sibling service package lives.
        const { findEndpoints } = await import('../../../service/src/utility/endpoints');
        const found = findEndpoints(REPO_ROOT, 'endpoint').map((endpoint) =>
            path.normalize(endpoint.filePath)
        );

        expect(found).toContain(
            path.join(PACKAGE_ROOT, 'src', 'server', 'endpoint', 'harness', 'service-route.ts')
        );
        expect(found).toContain(
            path.join(PACKAGE_ROOT, 'src', 'server', 'endpoint', 'harness', 'service-route-root.ts')
        );
    });

    it('discovers both real service-route modules through the loader', () => {
        // The loader logs one line per registered module; these are the actual
        // files under packages/underload/harness/src/server/endpoint/harness/.
        expect(output).toContain('Registered endpoint: [ALL] /v1/harness/* (file://');
        expect(output).toContain('Registered endpoint: [ALL] /v1/harness (file://');
        expect(output).toContain('endpoint/harness/service-route.ts');
        expect(output).toContain('endpoint/harness/service-route-root.ts');
    });

    it('returns the service document at GET /v1/harness', async () => {
        const response = await fetch(`${base}${HARNESS_API_ROOT}`);
        expect(response.status).toBe(200);
        // The service loader's global CORS applies to the canonical API.
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
        // T18: the epoch header is stamped by the ADAPTER, through the loader's optional `headers`
        // passthrough, and it must equal the body's epoch — that is the value the stream and every
        // revision comparison are anchored to.
        const stampedEpoch = response.headers.get('x-harness-epoch');

        const document = await json<ServiceInfo>(response);

        expect(stampedEpoch).toBe(document.epoch);

        // `ServiceInfo` is a CLOSED object (additionalProperties:false): identity, capability
        // booleans, the numeric bounds, the epoch, the clock, and links. The catalogues are their own
        // bounded reads now, which is what keeps this document constant-size.
        expect(Object.keys(document).sort()).toEqual([
            'api_root',
            'api_version',
            'capabilities',
            'epoch',
            'limits',
            'links',
            'server_time',
            'service'
        ]);
        expect(document.api_root).toBe(HARNESS_API_ROOT);
        expect(document.epoch).toBeTruthy();
        expect(document.capabilities.websocket_stream).toBe(true);
        expect(document.limits.body_bytes).toBe(MAX_API_BODY_BYTES);
        expect(document.limits.submit_body_bytes).toBe(MAX_SUBMIT_BODY_BYTES);
        expect(document.limits.input_chars).toBe(200_000);
        expect(document.links.stream).toBe(HARNESS_ROUTES.stream());

        // The old root document inlined the catalogues and the session list; each is now a page with
        // its own revision, which is what a stream client reconciles against.
        const harnesses = await json<HarnessCardPage>(await fetch(`${base}${HARNESS_ROUTES.harnesses()}?limit=100`));
        expect(harnesses.items.map((entry) => entry.name)).toEqual(PRESET_NAMES);

        const tools = await json<ToolSummaryPage>(await fetch(`${base}${HARNESS_ROUTES.tools()}?limit=100`));
        expect(tools.items.map((entry) => entry.name)).toEqual(TOOL_NAMES);

        const sessions = await json<SessionSummaryPage>(await fetch(`${base}${HARNESS_ROUTES.sessions()}`));
        expect(sessions.items).toEqual([]);

        // Defaults are the key-free `ProviderDefaults` shape, and they live on the configuration read,
        // in the contract's snake_case spelling, with the credential never sent.
        const config = await json<GlobalConfigDocument>(await fetch(`${base}${HARNESS_ROUTES.config()}`));
        expect(Object.keys(config.defaults)).toEqual(['base_url', 'model', 'has_api_key']);
        expect(typeof config.defaults.has_api_key).toBe('boolean');
        expect(Object.keys(config.defaults)).not.toContain('api_key');
    });

    it('does not serve /presets, which the target contract removed', async () => {
        const harnesses = await fetch(`${base}${HARNESS_ROUTES.harnesses()}`);
        const presets = await fetch(`${base}/v1/harness/presets`);

        expect(harnesses.status).toBe(200);
        // The alias was a compatibility surface; the contract has exactly one harnesses route, and
        // `HARNESS_PATH_TEMPLATES` states it. A 404 here is the contract, not a regression.
        expect(presets.status).toBe(404);
        expect(HARNESS_PATH_TEMPLATES).not.toHaveProperty('presets');

        const page = await json<HarnessCardPage>(harnesses);
        expect(page.items.map((entry) => entry.name)).toEqual(PRESET_NAMES);
    });

    it('persists through the loader variables.root at the real DATABASE_ROOT path', async () => {
        // Proves the whole chain the production service uses: server.ts passes
        // DATABASE_ROOT as `variables: { root }`, the loader forwards it as the
        // handler's third argument, and the handler selects the root-keyed runtime
        // that writes `<root>/harness/state.json`. A no-op root would leave no file.
        const created = await fetch(`${base}${HARNESS_ROUTES.sessions()}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ harness: 'demo' })
        });
        expect(created.status).toBe(201);
        const session = (await json<SessionResponse>(created)).session;

        const file = path.join(DATABASE_ROOT, 'harness', 'state.json');
        expect(fs.existsSync(file)).toBe(true);

        const database = JSON.parse(fs.readFileSync(file, 'utf8')) as {
            version: number;
            sessions: { id: string; settings: Record<string, unknown> }[];
        };
        // Provider defaults are the configuration read now (the service document is constant-size), and
        // the wire spelling is snake_case while the DATABASE document keeps its internal camelCase DTO
        // fields — a persistence detail, not part of the network contract.
        const config = await json<GlobalConfigDocument>(await fetch(`${base}${HARNESS_ROUTES.config()}`));

        expect(database.version).toBe(1);
        expect(database.sessions.map((entry) => entry.id)).toEqual([session.id]);
        // The session's provider settings are stored WITHOUT the credential.
        expect(database.sessions[0].settings).toEqual({
            baseURL: config.defaults.base_url,
            model: config.defaults.model
        });
        expect(Object.keys(database.sessions[0].settings)).toEqual(['baseURL', 'model']);

        // Clean up through the API as well, so the later create/list test still
        // starts from an empty session list.
        const deleted = await fetch(`${base}${HARNESS_ROUTES.sessionsBySessionId(session.id)}`, { method: 'DELETE' });
        expect(deleted.status).toBe(200);
        expect(
            (JSON.parse(fs.readFileSync(file, 'utf8')) as { sessions: unknown[] }).sessions
        ).toEqual([]);
    });

    it('creates, runs, resets, and deletes a session over the real service', async () => {
        const created = await fetch(`${base}${HARNESS_ROUTES.sessions()}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ harness: 'demo' })
        });
        expect(created.status).toBe(201);
        const session = (await json<SessionResponse>(created)).session;
        expect(session.harness).toBe('demo');
        expect(session.status).toBe('idle');
        // A fresh session owns no turns and no threads: the old aggregate-in-every-response shape is
        // gone, so those facts come from counters and from their own bounded reads.
        expect({ turn_count: session.turn_count, thread_count: session.thread_count }).toEqual({
            turn_count: 0,
            thread_count: 0
        });

        // The definition the session FROZE at creation is its own read, and the generated envelope is
        // `{ definition }` (a card-shaped `SessionDefinitionResource`). This preserves the old "the
        // session is seeded from the demo profile" behavior assertion: the member set, the primary, and
        // the captured definition name are what this session runs on, and a later global edit cannot
        // move them.
        const definition = await json<SessionDefinitionResponse>(
            await fetch(`${base}${HARNESS_ROUTES.sessionsBySessionIdDefinition(session.id)}`)
        );

        expect({ name: definition.definition.name, primary: definition.definition.primary }).toEqual({
            name: 'demo',
            primary: definition.definition.primary
        });
        expect(definition.definition.agents).toContain(definition.definition.primary);

        const listed = await json<SessionSummaryPage>(await fetch(`${base}${HARNESS_ROUTES.sessions()}`));
        expect(listed.items.map((entry: SessionSummary) => entry.id)).toEqual([session.id]);

        const read = await json<SessionResponse>(
            await fetch(`${base}${HARNESS_ROUTES.sessionsBySessionId(session.id)}`)
        );
        expect(read.session.id).toBe(session.id);

        // The submit is the contract's durable surface: 202 + a receipt, and the run continues with NO
        // response body attached. The loader's raw-Response passthrough is exercised by the stream
        // upgrade (src/server/stream/service-stream.test.ts); here the point is that the gateway hands
        // the receipt through with its revision stamp intact.
        const submitted = await fetch(`${base}${HARNESS_ROUTES.sessionsBySessionIdTasks(session.id)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input: 'What time is it?' })
        });
        expect(submitted.status).toBe(202);

        const receipt = await json<TaskReceipt>(submitted);
        expect({
            session_id: receipt.session_id,
            prompt_owner: receipt.links.turn,
            turns_link: receipt.links.turns,
            stream_link: receipt.links.stream
        }).toEqual({
            session_id: session.id,
            prompt_owner: HARNESS_ROUTES.sessionsBySessionIdTurnsByTurnId(session.id, receipt.turn_id),
            turns_link: HARNESS_ROUTES.sessionsBySessionIdTurns(session.id),
            stream_link: HARNESS_ROUTES.stream()
        });
        // The receipt is stamped with the session revision it was produced at, and the adapter put it
        // on the wire: that number is what a stream client compares `turn.upsert` frames against.
        expect(Number(submitted.headers.get('x-harness-revision'))).toBe(receipt.session_revision);

        const settled = await until(
            () => readTurn(base, session.id, receipt.turn_id),
            (turn) => turn.status === 'done' || turn.status === 'error' || turn.status === 'cancelled'
        );
        expect({ id: settled.id, prompt: settled.prompt, status: settled.status }).toEqual({
            id: receipt.turn_id,
            prompt: 'What time is it?',
            status: 'done'
        });

        const rows = await readAllEvents(base, session.id, receipt.turn_id);
        // The scripted demo always runs: toolRequest, clock, answer — with each
        // request's `usage` reported before the tool call (or the final `done`) it
        // belongs to. Asserting the non-delta sequence pins the recorder and the page
        // passthrough without depending on whitespace chunking.
        expect(
            rows
                .filter((row) => row.event.type !== 'text' && row.event.type !== 'reasoning')
                .map((row) => row.event.type)
        ).toEqual([
            'start',
            'usage',
            'tool_call',
            // R3/F1: each tool-calling request closes with `attempt_commit` (a tool
            // round never gets a `done`).
            'attempt_commit',
            'tool_result',
            'usage',
            'tool_call',
            'attempt_commit',
            'tool_result',
            'usage',
            'done'
        ]);
        // Journal positions are contiguous from 0, and the page is addressed to the turn the receipt
        // named — the dispatcher must not reshape or re-key anything on the way out.
        expect(rows.map((row) => row.index)).toEqual(rows.map((_row, position) => position));

        // `start` precedes every request, so it carries no usage figure; the three model requests each
        // record their own, and the turn's own tally is the exact sum of all three.
        expect(rows[0].event.type).toBe('start');
        expect(rows[0].event).not.toHaveProperty('usage');

        const usageEvents = rows.filter((row) => row.event.type === 'usage').map((row) => row.event.usage);
        expect(usageEvents).toHaveLength(3);

        expect(settled.usage).toEqual({ input: 292, output: 104, total: 396, cached: 168 });

        const reset = await json<ResetSessionResult>(
            await fetch(`${base}${HARNESS_ROUTES.sessionsBySessionIdReset(session.id)}`, { method: 'POST' })
        );
        expect({ ...reset, revision: undefined }).toEqual({
            reset: true,
            session_id: session.id,
            discarded_turns: 1,
            discarded_threads: 1,
            dropped_queued_tasks: 0,
            revision: undefined
        });

        const cancelled = await json<{ cancelled: boolean }>(
            await fetch(`${base}${HARNESS_ROUTES.sessionsBySessionIdCancel(session.id)}`, { method: 'POST' })
        );
        // Nothing is running, so the cancel reports that honestly instead of pretending to stop one.
        expect(cancelled.cancelled).toBe(false);

        const deleted = await json<DeleteSessionResult>(
            await fetch(`${base}${HARNESS_ROUTES.sessionsBySessionId(session.id)}`, { method: 'DELETE' })
        );
        expect(deleted).toEqual({
            deleted: true,
            session_id: session.id,
            aborted_turns: 0,
            dropped_queued_tasks: 0
        });

        const missing = await fetch(`${base}${HARNESS_ROUTES.sessionsBySessionId(session.id)}`);
        expect(missing.status).toBe(404);
        expect(await missing.json()).toEqual({ error: { message: `Unknown session "${session.id}".` } });
    });

    it('calls a tool directly and maps errors to exact statuses', async () => {
        // A direct catalogue call is `POST /tools/{tool_id}/executions` and its body carries
        // `parameters` only — this route has no session field at all.
        const clock = await fetch(`${base}${HARNESS_ROUTES.toolsByToolIdExecutions('timeNow')}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ parameters: { timezone: 'UTC' } })
        });
        expect(clock.status).toBe(200);
        const toolResult = await json<ToolCallResult>(clock);
        expect(toolResult.ok).toBe(true);
        if (toolResult.ok) {
            expect((toolResult.result as { timezone: string }).timezone).toBe('UTC');
        }

        const unknownTool = await fetch(`${base}${HARNESS_ROUTES.toolsByToolIdExecutions('nope')}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        expect(unknownTool.status).toBe(404);
        expect(await unknownTool.json()).toEqual({ error: { message: 'Unknown tool "nope".' } });

        const unknownHarness = await fetch(`${base}${HARNESS_ROUTES.sessions()}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ harness: 'nope' })
        });
        expect(unknownHarness.status).toBe(404);
        expect(await unknownHarness.json()).toEqual({ error: { message: 'Unknown harness "nope".' } });

        // Blank base URL is rejected before any provider request is attempted. The request field is
        // the generated `RunnerSettingsInput` spelling (`base_url`), not the legacy camelCase one.
        const models = await fetch(`${base}${HARNESS_ROUTES.models()}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings: { base_url: '' } })
        });
        expect(models.status).toBe(400);
        const modelsBody = (await models.json()) as { error?: { message?: string } };
        expect(modelsBody.error?.message.toLowerCase()).toContain('base url');

        const unknownRoute = await fetch(`${base}/v1/harness/not-a-route`);
        expect(unknownRoute.status).toBe(404);
        expect(await unknownRoute.json()).toEqual({
            error: { message: 'Unknown API route: GET /v1/harness/not-a-route' }
        });

        // Prefix handling: only `/v1/harness` and its children belong to this API.
        const neighbour = await fetch(`${base}/v1/harnessfoo`);
        expect(neighbour.status).toBe(404);

        // The canonical service API does not mount the legacy /api surface.
        const legacy = await fetch(`${base}/api/harnesses`, {
            headers: { 'X-Harness-Client': 'ui' }
        });
        expect(legacy.status).toBe(404);
    });

    it('refuses a malformed tool body without executing the tool', async () => {
        // The target contract makes `parameters` OPTIONAL and untyped (the tool decides what is a
        // valid argument and reports a bad one as `ok:false`), so the legacy "a tool call requires a
        // parameters property" 400 is gone. What MUST still hold — and what this test has always been
        // about — is that an unparseable document never runs the tool silently. In `body: 'raw'`
        // mode the harness reads the stream itself, so the parse failure is an explicit 400 instead
        // of the loader's old swallowed `{}`.
        const broken = await fetch(`${base}${HARNESS_ROUTES.toolsByToolIdExecutions('timeNow')}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{'
        });

        expect(broken.status).toBe(400);
        expect(await broken.json()).toEqual({ error: { message: 'The request body must be valid JSON.' } });

        // An absent wrapper is a VALID CALL: `timeNow` documents "UTC" as the omitted-label default,
        // so an empty body executes rather than being mistaken for a malformed one.
        const empty = await fetch(`${base}${HARNESS_ROUTES.toolsByToolIdExecutions('timeNow')}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        expect(empty.status).toBe(200);
        const emptyResult = await json<ToolCallResult>(empty);
        expect(emptyResult.ok).toBe(true);
        if (emptyResult.ok) expect((emptyResult.result as { timezone: unknown }).timezone).toBe('UTC');
    });

    it('rejects an over-sized parsed body with 413 through the real loader', async () => {
        // The loader has already buffered and parsed this JSON before the adapter
        // sees it (documented residual: the allocation is upstream of this
        // package). The adapter's serialized-size bound still refuses to dispatch.
        const huge = JSON.stringify({ settings: { apiKey: 'x'.repeat(1_050_000) } });
        const response = await fetch(`${base}/v1/harness/models`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: huge
        });

        expect(response.status).toBe(413);
        expect(await response.json()).toEqual({
            error: { message: `A request body cannot exceed ${MAX_API_BODY_BYTES} bytes.` }
        });
    });

    it('blocks foreign browser origins but allows loopback dev origins', async () => {
        const hostile = await fetch(`${base}/v1/harness`, {
            headers: { Origin: 'https://evil.example' }
        });
        expect(hostile.status).toBe(403);
        expect(await hostile.json()).toEqual({
            error: { message: 'Cross-origin requests are not allowed.' }
        });

        const dev = await fetch(`${base}/v1/harness`, {
            headers: { Origin: 'http://localhost:5173' }
        });
        expect(dev.status).toBe(200);
    });
});

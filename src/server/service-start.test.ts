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
// Network: loopback HTTP only. The demo preset is scripted and offline.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_API_BODY_BYTES } from './api';
import type { SessionSnapshot, SessionStreamItem, ToolCallResult } from './protocol';

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

const PRESET_NAMES = ['instruct', 'research', 'workspace', 'reviewer', 'planner', 'demo', 'flaky'];

// Core tools lead the catalogue (R8) in every listing surface, including the
// bootstrap document the service loader serves at GET /v1/harness.
const TOOL_NAMES = [
    'toolRequest',
    'toolCreate',
    'todoManage',
    'profileManage',
    'chapterManage',
    'locationManage',
    'agentDelegate',
    'syntaxCheck',
    'fileRead',
    'fileWrite',
    'fileEdit',
    'fileList',
    'fileGlob',
    'commandRun',
    'gitDiff',
    'timeNow',
    'textCount',
    'diceRoll',
    'noteSearch',
    'textSummarize',
    'testFlaky',
    'webSearch'
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

    it('returns the bootstrap document at GET /v1/harness', async () => {
        const response = await fetch(`${base}/v1/harness`);
        expect(response.status).toBe(200);
        // The service loader's global CORS applies to the canonical API.
        expect(response.headers.get('access-control-allow-origin')).toBe('*');

        const body = await json<Record<string, any>>(response);
        expect(Object.keys(body)).toEqual(['rootPath', 'presets', 'agents', 'tools', 'defaults', 'sessions']);
        // The advertised root is the canonical API URL, not a filesystem path:
        // the file tools use the server process's cwd and have no sandbox.
        expect(body.rootPath).toBe('/v1/harness');
        expect(body.presets.map((preset: { name: string }) => preset.name)).toEqual(PRESET_NAMES);
        expect(body.tools.map((tool: { name: string }) => tool.name)).toEqual(TOOL_NAMES);
        expect(body.sessions).toEqual([]);

        // Defaults are the key-free shape the existing UI consumes.
        expect(Object.keys(body.defaults)).toEqual(['baseURL', 'model', 'hasApiKey']);
        expect(typeof body.defaults.hasApiKey).toBe('boolean');
        expect(Object.keys(body.defaults)).not.toContain('apiKey');
    });

    it('serves /presets as an alias of /harnesses relative to the root', async () => {
        const harnesses = await fetch(`${base}/v1/harness/harnesses`);
        const presets = await fetch(`${base}/v1/harness/presets`);

        expect(harnesses.status).toBe(200);
        expect(presets.status).toBe(200);

        const harnessesBody = await json<{ harnesses: { name: string }[] }>(harnesses);
        const presetsBody = await json<{ harnesses: { name: string }[] }>(presets);
        expect(presetsBody).toEqual(harnessesBody);
        expect(presetsBody.harnesses.map((entry) => entry.name)).toEqual(PRESET_NAMES);
    });

    it('persists through the loader variables.root at the real DATABASE_ROOT path', async () => {
        // Proves the whole chain the production service uses: server.ts passes
        // DATABASE_ROOT as `variables: { root }`, the loader forwards it as the
        // handler's third argument, and the handler selects the root-keyed runtime
        // that writes `<root>/harness/state.json`. A no-op root would leave no file.
        const created = await fetch(`${base}/v1/harness/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ harness: 'demo' })
        });
        expect(created.status).toBe(201);
        const session = (await json<{ session: SessionSnapshot }>(created)).session;

        const file = path.join(DATABASE_ROOT, 'harness', 'state.json');
        expect(fs.existsSync(file)).toBe(true);

        const database = JSON.parse(fs.readFileSync(file, 'utf8')) as {
            version: number;
            sessions: { id: string; settings: Record<string, unknown> }[];
        };
        const bootstrap = await json<{ defaults: { baseURL: string; model: string } }>(
            await fetch(`${base}/v1/harness`)
        );
        expect(database.version).toBe(1);
        expect(database.sessions.map((entry) => entry.id)).toEqual([session.id]);
        // The session's provider settings are stored WITHOUT the credential.
        expect(database.sessions[0].settings).toEqual({
            baseURL: bootstrap.defaults.baseURL,
            model: bootstrap.defaults.model
        });
        expect(Object.keys(database.sessions[0].settings)).toEqual(['baseURL', 'model']);

        // Clean up through the API as well, so the later create/list test still
        // starts from an empty session list.
        const deleted = await fetch(`${base}/v1/harness/sessions/${session.id}`, { method: 'DELETE' });
        expect(deleted.status).toBe(200);
        expect(
            (JSON.parse(fs.readFileSync(file, 'utf8')) as { sessions: unknown[] }).sessions
        ).toEqual([]);
    });

    it('creates, streams, resets, and deletes a session over the real service', async () => {
        const created = await fetch(`${base}/v1/harness/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ harness: 'demo' })
        });
        expect(created.status).toBe(201);
        const session = (await json<{ session: SessionSnapshot }>(created)).session;
        expect(session.harness).toBe('demo');
        expect(session.status).toBe('idle');
        expect(session.turns).toEqual([]);
        expect(session.messages.map((message) => message.role)).toEqual(['system', 'system']);

        const listed = await json<{ sessions: SessionSnapshot[] }>(
            await fetch(`${base}/v1/harness/sessions`)
        );
        expect(listed.sessions.map((entry) => entry.id)).toEqual([session.id]);

        const read = await json<{ session: SessionSnapshot }>(
            await fetch(`${base}/v1/harness/sessions/${session.id}`)
        );
        expect(read.session.id).toBe(session.id);

        // SSE through the loader's raw-Response passthrough.
        const streamResponse = await fetch(`${base}/v1/harness/sessions/${session.id}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ input: 'What time is it?' })
        });
        expect(streamResponse.status).toBe(200);
        expect(streamResponse.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');

        const items = parseSse(await streamResponse.text());
        const first = items[0];
        expect(first.type).toBe('turn');
        if (first.type !== 'turn') throw new Error('expected a turn frame');
        expect(first.turn.index).toBe(0);
        expect(first.turn.prompt).toBe('What time is it?');
        expect(first.turn.status).toBe('running');

        const events = items.flatMap((item) => (item.type === 'event' ? [item.event] : []));
        // The scripted demo always runs: toolRequest, clock, answer — with each
        // request's `usage` reported before the tool call (or the final `done`) it
        // belongs to. Asserting the non-delta sequence pins the frame passthrough
        // without depending on whitespace chunking.
        expect(
            events
                .filter((event) => event.type !== 'text' && event.type !== 'reasoning')
                .map((event) => event.type)
        ).toEqual(['start', 'usage', 'tool_call', 'tool_result', 'usage', 'tool_call', 'tool_result', 'usage', 'done']);
        // The dispatcher must not reshape frames: every event names its turn.
        for (const item of items) {
            if (item.type === 'event') expect(item.turnId).toBe(first.turn.id);
        }

        // The adapter is transport-neutral: the `usage` field is forwarded on the
        // raw SSE `data:` JSON exactly as the in-process handler emits it. `start`
        // precedes every request, so it has no key; each `usage` frame carries the
        // server's running sum (not the request's own figure).
        const eventFrames = items.flatMap((item) => (item.type === 'event' ? [item] : []));
        expect(eventFrames[0].event.type).toBe('start');
        expect(eventFrames[0]).not.toHaveProperty('usage');

        const usageFrames = eventFrames.filter((frame) => frame.event.type === 'usage');
        expect(usageFrames.map((frame) => frame.usage)).toEqual([
            { input: 48, output: 18, total: 66, cached: 0 },
            { input: 144, output: 40, total: 184, cached: 48 },
            { input: 292, output: 104, total: 396, cached: 168 }
        ]);

        const terminal = items.at(-1);
        expect(terminal?.type).toBe('snapshot');
        if (terminal?.type !== 'snapshot') throw new Error('expected a terminal snapshot');
        expect(terminal.session.turns).toHaveLength(1);
        expect(terminal.session.turns[0].status).toBe('done');
        expect(terminal.session.turns[0].events).toEqual(events);
        // The terminal snapshot carries the run's exact tally of all three requests.
        expect(terminal.session.turns[0].usage).toEqual({
            input: 292,
            output: 104,
            total: 396,
            cached: 168
        });

        const reset = await json<{ session: SessionSnapshot }>(
            await fetch(`${base}/v1/harness/sessions/${session.id}/reset`, { method: 'POST' })
        );
        expect(reset.session.turns).toEqual([]);

        const cancelled = await json<{ cancelled: boolean }>(
            await fetch(`${base}/v1/harness/sessions/${session.id}/cancel`, { method: 'POST' })
        );
        expect(cancelled).toEqual({ cancelled: false });

        const deleted = await json<{ deleted: boolean }>(
            await fetch(`${base}/v1/harness/sessions/${session.id}`, { method: 'DELETE' })
        );
        expect(deleted).toEqual({ deleted: true });

        const missing = await fetch(`${base}/v1/harness/sessions/${session.id}`);
        expect(missing.status).toBe(404);
        expect(await missing.json()).toEqual({ error: { message: `Unknown session "${session.id}".` } });
    });

    it('calls a tool directly and maps errors to exact statuses', async () => {
        const clock = await fetch(`${base}/v1/harness/tools/timeNow`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ parameters: 'UTC' })
        });
        expect(clock.status).toBe(200);
        const toolResult = await json<ToolCallResult>(clock);
        expect(toolResult.ok).toBe(true);
        if (toolResult.ok) {
            expect((toolResult.result as { timezone: string }).timezone).toBe('UTC');
        }

        const unknownTool = await fetch(`${base}/v1/harness/tools/nope`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}'
        });
        expect(unknownTool.status).toBe(404);
        expect(await unknownTool.json()).toEqual({ error: { message: 'Unknown tool "nope".' } });

        const unknownHarness = await fetch(`${base}/v1/harness/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ harness: 'nope' })
        });
        expect(unknownHarness.status).toBe(404);
        expect(await unknownHarness.json()).toEqual({ error: { message: 'Unknown harness "nope".' } });

        // Blank base URL is rejected before any provider request is attempted.
        const models = await fetch(`${base}/v1/harness/models`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings: { baseURL: '' } })
        });
        expect(models.status).toBe(400);
        expect(await models.json()).toEqual({
            error: { message: 'Set a provider base URL before listing models.' }
        });

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

    it('refuses a wrapper-less or malformed tool body without executing the tool', async () => {
        // The loader calls `context.req.json()` and swallows a parse failure into
        // `{}` (packages/underload/service/src/server/start.ts), so a broken body
        // and a literal `{}` are indistinguishable here. Requiring the
        // `parameters` property is what keeps `clock` from running with its
        // default timezone on a request that never asked for a call.
        for (const raw of ['{', '{}']) {
            const response = await fetch(`${base}/v1/harness/tools/timeNow`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: raw
            });

            expect(response.status).toBe(400);
            expect(await response.json()).toEqual({
                error: {
                    message:
                        'A tool call requires a "parameters" property. Send {"parameters": {}} for a tool with no arguments.'
                }
            });
        }

        // An explicit empty wrapper is still a VALID CALL (a 400 would mean the
        // wrapper was missing). The single-property rule unwraps it to `undefined`,
        // and `timeNow` documents "UTC" as the omitted-label default.
        const empty = await fetch(`${base}/v1/harness/tools/timeNow`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ parameters: {} })
        });
        expect(empty.status).toBe(200);
        const result = await json<ToolCallResult>(empty);
        expect(result.ok).toBe(true);
        if (result.ok) expect((result.result as { timezone: unknown }).timezone).toBe('UTC');
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

// The transport-neutral API and the @underload/service adapter.
//
// These tests call the service handler directly (no listener, no Hono): the
// handler is structurally typed, so a plain object with `req.path`, `req.header`
// and `req.raw` exercises exactly what the service loader provides. The SSE path
// is a real Response with a ReadableStream, consumed through `response.text()`.
//
// Scope note: session internals (turns, cancellation) are covered by the session
// suite; this file pins the HTTP contract — routing, bootstrap, statuses, origin
// gate, body policy/bounds, and frame passthrough.
//
// No network is touched: `settings`/`defaults` are injected, websearch keys are
// stubbed empty, and only the scripted demo preset runs.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createToolCatalogue, createWebsearchCatalogueEntry, WEBSEARCH_UNCONFIGURED_HINT } from '../harnesses';
import { MAX_API_BODY_BYTES } from './api';
import { createHarnessRuntime } from './runtime';
import type { HarnessRuntime } from './runtime';
import { createHarnessServiceHandler } from './service';
import type { ServiceEndpointContext } from './service';
import { startHarnessServer } from './index';
import type { HarnessDescriptor, HarnessIndex, SessionSnapshot, SessionStreamItem, ToolCallResult, ToolIndex } from './protocol';

const SETTINGS = {
    baseURL: 'http://provider.test/v1',
    apiKey: 'server-secret',
    model: 'demo-model'
};

const DEFAULTS = {
    baseURL: 'http://provider.test/v1',
    model: 'demo-model',
    hasApiKey: true
};

// The exact catalogue order: ten package presets, six harness tools, websearch.
const TOOL_NAMES = [
    'javascriptSyntax',
    'pythonSyntax',
    'readFile',
    'writeFile',
    'editFile',
    'listFiles',
    'searchFiles',
    'globFiles',
    'runCommand',
    'gitDiff',
    'clock',
    'wordCount',
    'roll',
    'searchNotes',
    'summarize',
    'flaky',
    'websearch'
];

const PRESET_NAMES = ['instruct', 'research', 'workspace', 'demo', 'flaky'];

// Stub search keys so `websearch` is deterministically listed as unconfigured
// regardless of the machine/.env running the suite.
const stubEmptySearchKeys = (): void => {
    vi.stubEnv('EXA_API_KEY', '');
    vi.stubEnv('TAVILY_API_KEY', '');
};

const createRuntime = (
    settings: { baseURL: string; apiKey: string; model: string } = SETTINGS,
    defaults: { baseURL: string; model: string; hasApiKey: boolean } = DEFAULTS
): HarnessRuntime => {
    stubEmptySearchKeys();
    return createHarnessRuntime({
        settings,
        defaults,
        loadEnvironment: false
    });
};

type CallOptions = {
    body?: unknown;
    headers?: Record<string, string>;
    signal?: AbortSignal;
};

// Mirrors the loader: path is the full URL path, body is already parsed.
const callHandler = (
    runtime: HarnessRuntime,
    method: string,
    pathname: string,
    options: CallOptions = {}
): ReturnType<ReturnType<typeof createHarnessServiceHandler>> => {
    const handler = createHarnessServiceHandler({ runtime });
    const headers = options.headers ?? {};
    const context: ServiceEndpointContext = {
        req: {
            path: pathname,
            header: (name) => headers[name.toLowerCase()],
            raw: { method, signal: options.signal ?? new AbortController().signal }
        }
    };

    return handler(context, { body: options.body === undefined ? {} : options.body });
};

const jsonBody = async <T>(result: Awaited<ReturnType<ReturnType<typeof createHarnessServiceHandler>>>): Promise<{ status: number; body: T }> => {
    expect(result.raw).toBeUndefined();
    expect(result.response).toBeDefined();
    return { status: result.status, body: result.response as T };
};

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

const streamItems = async (
    result: Awaited<ReturnType<ReturnType<typeof createHarnessServiceHandler>>>
): Promise<SessionStreamItem[]> => {
    expect(result.raw).toBeInstanceOf(Response);
    const raw = result.raw!;
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    return parseSse(await raw.text());
};

const createDemo = async (runtime: HarnessRuntime): Promise<SessionSnapshot> => {
    const result = await callHandler(runtime, 'POST', '/v1/harness/sessions', {
        body: { harness: 'demo' }
    });
    const { status, body } = await jsonBody<{ session: SessionSnapshot }>(result);
    expect(status).toBe(201);
    return body.session;
};

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('canonical bootstrap document', () => {
    it('answers GET /v1/harness with the exact bootstrap shape', async () => {
        const runtime = createRuntime();
        const { status, body } = await jsonBody<Record<string, unknown>>(
            await callHandler(runtime, 'GET', '/v1/harness')
        );

        expect(status).toBe(200);
        expect(Object.keys(body)).toEqual(['rootPath', 'presets', 'tools', 'defaults', 'sessions']);
        // The advertised root is the canonical API URL, not a filesystem path.
        expect(body.rootPath).toBe('/v1/harness');
        expect((body.presets as { name: string }[]).map((preset) => preset.name)).toEqual(PRESET_NAMES);
        expect((body.tools as { name: string }[]).map((tool) => tool.name)).toEqual(TOOL_NAMES);
        expect(body.defaults).toEqual(DEFAULTS);
        expect(body.sessions).toEqual([]);

        // Descriptors, not factories: the first card is the Instruct harness, and
        // the core tools are server-owned (delegate is absent: no subagents).
        expect((body.presets as unknown[])[0]).toEqual({
            name: 'instruct',
            title: 'Instruct',
            description:
                'A general instruction-following agent with the full toolbox. File, command, search, app, and web tools are all registered but searchable: call getTools with capability tags to enable what the task needs. The live presets differ only in their agents, not their tools.',
            requiresEndpoint: true,
            agents: ['instruct'],
            tools: [
                'javascriptSyntax',
                'pythonSyntax',
                'readFile',
                'writeFile',
                'editFile',
                'listFiles',
                'searchFiles',
                'globFiles',
                'runCommand',
                'gitDiff',
                'clock',
                'wordCount',
                'roll',
                'searchNotes',
                'summarize'
            ],
            coreTools: ['getTools', 'createTool', 'todoTools']
        });

        // The offline fixture is still described, just no longer the first card.
        expect((body.presets as { name: string; tools: string[]; coreTools: string[] }[]).find(
            (preset) => preset.name === 'demo'
        )).toEqual({
            name: 'demo',
            title: 'Scripted demo',
            description:
                'Runs a scripted transport: a reasoning stream, a getTools discovery round, one tool call, and a final answer. No endpoint needed, so this is the fixture to try first. It is deliberately not a live harness: the toolbox rule applies to Instruct, Research, and Workspace.',
            requiresEndpoint: false,
            agents: ['demo'],
            tools: ['clock'],
            coreTools: ['getTools', 'createTool', 'todoTools']
        });
    });

    it('rejects methods other than GET on the canonical root', async () => {
        const runtime = createRuntime();
        const { status, body } = await jsonBody<{ error: { message: string } }>(
            await callHandler(runtime, 'POST', '/v1/harness', { body: {} })
        );

        expect(status).toBe(405);
        expect(body).toEqual({ error: { message: 'Use GET for /v1/harness.' } });
    });

    it('serves /presets as an alias of /harnesses', async () => {
        const runtime = createRuntime();
        const harnesses = await jsonBody<HarnessIndex>(await callHandler(runtime, 'GET', '/v1/harness/harnesses'));
        const presets = await jsonBody<HarnessIndex>(await callHandler(runtime, 'GET', '/v1/harness/presets'));

        expect(presets).toEqual(harnesses);
        expect(presets.body.harnesses.map((entry) => entry.name)).toEqual(PRESET_NAMES);
        expect(presets.body.defaults).toEqual(DEFAULTS);
    });

    it('lists the tool catalogue under the mount', async () => {
        const runtime = createRuntime();
        const { status, body } = await jsonBody<ToolIndex>(await callHandler(runtime, 'GET', '/v1/harness/tools'));

        expect(status).toBe(200);
        expect(body.tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    });
});

// Preset descriptors and the environment-backed `websearch` tool.
//
// The declarative half (`environmentTools` in harnesses/presets.ts) says WHICH
// preset can run websearch; the runtime catalogue says WHETHER this host has it.
// These tests pin the resolver in api.ts: configured hosts advertise the tool on
// every live preset (instruct/research/workspace), keyless hosts advertise the
// same shared toolbox minus websearch. The configured catalogue is injected with
// an explicit `env`, so the test never reads or mutates the real process
// environment.
describe('preset descriptor tool metadata', () => {
    // The exact shared toolbox every live preset advertises: ten package tools,
    // then five app tools. No live card gets a subset any more.
    const TOOLBOX = [
        'javascriptSyntax',
        'pythonSyntax',
        'readFile',
        'writeFile',
        'editFile',
        'listFiles',
        'searchFiles',
        'globFiles',
        'runCommand',
        'gitDiff',
        'clock',
        'wordCount',
        'roll',
        'searchNotes',
        'summarize'
    ];

    const CONFIGURED_PRESET_TOOLS = {
        instruct: [...TOOLBOX, 'websearch'],
        research: [...TOOLBOX, 'websearch'],
        workspace: [...TOOLBOX, 'websearch'],
        demo: ['clock'],
        // The example adds its own failure tool; websearch is not part of it.
        flaky: [...TOOLBOX, 'flaky']
    };

    const CORE_TOOLS = {
        instruct: ['getTools', 'createTool', 'todoTools'],
        // Agent configuration: only Research declares a subagent, so only Research
        // gets the delegate tool.
        research: ['getTools', 'createTool', 'todoTools', 'delegate'],
        workspace: ['getTools', 'createTool', 'todoTools'],
        demo: ['getTools', 'createTool', 'todoTools'],
        flaky: ['getTools', 'createTool', 'todoTools']
    };

    const configuredRuntime = (): HarnessRuntime => {
        // Explicit env: this catalogue is configured regardless of the machine.
        const catalogue = createToolCatalogue({
            websearch: createWebsearchCatalogueEntry({
                configuration: { env: { EXA_API_KEY: 'configured-exa-key' } }
            })
        });

        return createHarnessRuntime({
            settings: SETTINGS,
            defaults: DEFAULTS,
            loadEnvironment: false,
            catalogue
        });
    };

    const toolLists = (presets: HarnessDescriptor[]): Record<string, string[]> =>
        Object.fromEntries(presets.map((preset) => [preset.name, preset.tools]));

    const coreLists = (presets: HarnessDescriptor[]): Record<string, string[] | undefined> =>
        Object.fromEntries(presets.map((preset) => [preset.name, preset.coreTools]));

    it('appends websearch to every live preset when configured', async () => {
        const runtime = configuredRuntime();
        const bootstrap = await jsonBody<{ presets: HarnessDescriptor[] }>(
            await callHandler(runtime, 'GET', '/v1/harness')
        );

        expect(toolLists(bootstrap.body.presets)).toEqual(CONFIGURED_PRESET_TOOLS);
        expect(coreLists(bootstrap.body.presets)).toEqual(CORE_TOOLS);

        // Every live card advertises the identical list: the toolbox is not part
        // of what a harness choice changes.
        const lists = toolLists(bootstrap.body.presets);
        expect(lists.instruct).toEqual(lists.research);
        expect(lists.instruct).toEqual(lists.workspace);

        // The direct-call catalogue agrees: the same key makes the tool callable.
        const tools = await jsonBody<ToolIndex>(await callHandler(runtime, 'GET', '/v1/harness/tools'));
        expect(tools.body.tools.find((tool) => tool.name === 'websearch')?.availability).toEqual({
            state: 'available',
            environment: ['EXA_API_KEY', 'TAVILY_API_KEY']
        });

        // /harnesses and the /presets alias resolve through the same descriptors.
        const harnesses = await jsonBody<HarnessIndex>(await callHandler(runtime, 'GET', '/v1/harness/harnesses'));
        const presets = await jsonBody<HarnessIndex>(await callHandler(runtime, 'GET', '/v1/harness/presets'));

        expect(presets.body).toEqual(harnesses.body);
        expect(harnesses.body.harnesses).toEqual(bootstrap.body.presets);
    });

    it('keeps the same toolbox on every live preset when no search key is configured', async () => {
        const runtime = createRuntime();
        const bootstrap = await jsonBody<{ presets: HarnessDescriptor[] }>(
            await callHandler(runtime, 'GET', '/v1/harness')
        );

        expect(toolLists(bootstrap.body.presets)).toEqual({
            instruct: TOOLBOX,
            research: TOOLBOX,
            workspace: TOOLBOX,
            demo: ['clock'],
            flaky: [...TOOLBOX, 'flaky']
        });

        // Keyless stays honest: the global catalogue still lists websearch, but as
        // unconfigured, and no preset card advertises a tool it cannot call.
        const tools = await jsonBody<ToolIndex>(await callHandler(runtime, 'GET', '/v1/harness/tools'));
        expect(tools.body.tools.find((tool) => tool.name === 'websearch')?.availability).toEqual({
            state: 'unconfigured',
            environment: ['EXA_API_KEY', 'TAVILY_API_KEY'],
            hint: WEBSEARCH_UNCONFIGURED_HINT
        });
    });

    it('resolves legacy preset identifiers to the canonical session harness', async () => {
        const runtime = createRuntime();

        const created = await jsonBody<{ session: SessionSnapshot }>(
            await callHandler(runtime, 'POST', '/v1/harness/sessions', {
                body: { harness: 'researcher' }
            })
        );

        expect(created.status).toBe(201);
        expect(created.body.session.harness).toBe('research');
    });
});

describe('canonical sessions', () => {
    it('creates, lists, reads, and deletes a session', async () => {
        const runtime = createRuntime();
        const session = await createDemo(runtime);

        // Everything except the generated id/timestamps is fixed. `turns` is part
        // of the snapshot contract and must start empty.
        expect(Object.keys(session)).toEqual([
            'id',
            'harness',
            'status',
            'model',
            'createdAt',
            'updatedAt',
            'messages',
            'turns'
        ]);
        expect(session.harness).toBe('demo');
        expect(session.status).toBe('idle');
        expect(session.model).toBe('demo-model');
        expect(session.createdAt).toBe(session.updatedAt);
        expect(session.turns).toEqual([]);
        expect(session.messages.map((message) => message.role)).toEqual(['system']);

        const list = await jsonBody<{ sessions: SessionSnapshot[] }>(
            await callHandler(runtime, 'GET', '/v1/harness/sessions')
        );
        expect(list.status).toBe(200);
        expect(list.body.sessions.map((entry) => entry.id)).toEqual([session.id]);

        const read = await jsonBody<{ session: SessionSnapshot }>(
            await callHandler(runtime, 'GET', `/v1/harness/sessions/${session.id}`)
        );
        expect(read.status).toBe(200);
        expect(read.body.session.id).toBe(session.id);

        const removed = await jsonBody<{ deleted: boolean }>(
            await callHandler(runtime, 'DELETE', `/v1/harness/sessions/${session.id}`)
        );
        expect(removed).toEqual({ status: 200, body: { deleted: true } });

        const missing = await jsonBody<{ error: { message: string } }>(
            await callHandler(runtime, 'GET', `/v1/harness/sessions/${session.id}`)
        );
        expect(missing).toEqual({
            status: 404,
            body: { error: { message: `Unknown session "${session.id}".` } }
        });
    });

    it('streams a run and forwards every frame unchanged', async () => {
        const runtime = createRuntime();
        const session = await createDemo(runtime);

        const result = await callHandler(runtime, 'POST', `/v1/harness/sessions/${session.id}/messages`, {
            body: { input: 'What time is it?' }
        });
        const items = await streamItems(result);

        // The turn frame opens the stream; the session contract owns its id.
        const first = items[0];
        expect(first.type).toBe('turn');
        if (first.type !== 'turn') throw new Error('expected a turn frame');
        expect(Object.keys(first.turn)).toEqual(['id', 'index', 'prompt', 'status', 'startedAt', 'updatedAt', 'events']);
        expect(first.turn.index).toBe(0);
        expect(first.turn.prompt).toBe('What time is it?');
        expect(first.turn.status).toBe('running');

        // Non-delta events follow the scripted loop exactly: discovery call,
        // clock call, then the answer. Delta events are checked by membership in
        // the terminal equality assertion below.
        const events = items.flatMap((item) => (item.type === 'event' ? [item.event] : []));
        expect(
            events
                .filter((event) => event.type !== 'text' && event.type !== 'reasoning')
                .map((event) => event.type)
        ).toEqual(['start', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'done']);

        // Every event frame names the turn it belongs to.
        for (const item of items) {
            if (item.type === 'event') expect(item.turnId).toBe(first.turn.id);
        }

        // Terminal frame: complete session, turn done, events byte-identical to
        // the frames the client just received (the dispatcher must not reshape).
        const terminal = items.at(-1);
        expect(terminal?.type).toBe('snapshot');
        if (terminal?.type !== 'snapshot') throw new Error('expected a terminal snapshot');

        expect(terminal.session.id).toBe(session.id);
        expect(terminal.session.status).toBe('idle');
        expect(terminal.session.turns).toHaveLength(1);
        expect(terminal.session.turns[0].status).toBe('done');
        expect(terminal.session.turns[0].events).toEqual(events);
    });

    it('resets a canonical session', async () => {
        const runtime = createRuntime();
        const session = await createDemo(runtime);

        const result = await callHandler(runtime, 'POST', `/v1/harness/sessions/${session.id}/reset`, {
            body: {}
        });
        const { status, body } = await jsonBody<{ session: SessionSnapshot }>(result);

        expect(status).toBe(200);
        expect(body.session.status).toBe('idle');
        expect(body.session.turns).toEqual([]);
        expect(body.session.messages.map((message) => message.role)).toEqual(['system']);
    });

    it('rejects a second run while the first is still open with 409', async () => {
        const runtime = createRuntime();
        const session = await createDemo(runtime);

        // Dispatch directly to reach the stream object before its frames flow.
        const stream = await runtime.api({
            method: 'POST',
            pathname: `/v1/harness/sessions/${session.id}/messages`,
            mount: '/v1/harness',
            readBody: async () => ({ input: 'first' }),
            bootstrapRoot: true
        });
        if (stream.kind !== 'stream') throw new Error('expected a stream');

        // Block on the turn frame: at this point SessionStore.status is 'running'.
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let reached: () => void = () => {};
        const turnReached = new Promise<void>((resolve) => {
            reached = resolve;
        });

        const controller = new AbortController();
        const run = stream.start(async (item) => {
            if (item.type === 'turn') {
                reached();
                await gate;
            }
        }, controller.signal);

        await turnReached;

        const busy = await callHandler(runtime, 'POST', `/v1/harness/sessions/${session.id}/messages`, {
            body: { input: 'second' }
        });
        expect(await jsonBody<unknown>(busy)).toEqual({
            status: 409,
            body: { error: { message: 'A task is already running in this session.' } }
        });

        // Abort + release so the busy test cannot leak a running session.
        controller.abort();
        release();
        await run;
    });

    it('maps validation and lookup failures to exact statuses', async () => {
        const runtime = createRuntime();

        expect(
            await jsonBody(await callHandler(runtime, 'POST', '/v1/harness/sessions', { body: {} }))
        ).toEqual({ status: 400, body: { error: { message: 'A session requires a harness name.' } } });

        expect(
            await jsonBody(await callHandler(runtime, 'POST', '/v1/harness/sessions', { body: { harness: 'nope' } }))
        ).toEqual({ status: 404, body: { error: { message: 'Unknown harness "nope".' } } });

        const session = await createDemo(runtime);

        expect(
            await jsonBody(
                await callHandler(runtime, 'POST', `/v1/harness/sessions/${session.id}/messages`, {
                    body: { input: '   ' }
                })
            )
        ).toEqual({ status: 400, body: { error: { message: 'A task cannot be empty.' } } });

        expect(
            await jsonBody(
                await callHandler(runtime, 'POST', `/v1/harness/sessions/${session.id}/messages`, {
                    body: { input: 7 }
                })
            )
        ).toEqual({ status: 400, body: { error: { message: 'A task must be a string.' } } });

        expect(
            await jsonBody(await callHandler(runtime, 'GET', '/v1/harness/sessions/not-a-session'))
        ).toEqual({ status: 404, body: { error: { message: 'Unknown session "not-a-session".' } } });

        // The models route merges over the STORE's live settings (which hold the
        // key), not the key-free defaults advertised to clients. A blank base URL
        // is rejected before any network call.
        const blank = createRuntime(
            { baseURL: '', apiKey: '', model: 'demo-model' },
            { baseURL: '', model: 'demo-model', hasApiKey: false }
        );
        expect(
            await jsonBody(await callHandler(blank, 'POST', '/v1/harness/models', { body: {} }))
        ).toEqual({
            status: 400,
            body: { error: { message: 'Set a provider base URL before listing models.' } }
        });

        expect(
            await jsonBody(await callHandler(runtime, 'GET', '/v1/harness/not-a-route'))
        ).toEqual({ status: 404, body: { error: { message: 'Unknown API route: GET /v1/harness/not-a-route' } } });

        expect(
            await jsonBody(await callHandler(runtime, 'GET', '/v1/harness/sessions/'))
        ).toEqual({ status: 200, body: { sessions: [session] } });
    });

    it('calls a tool directly and reports an unknown tool as 404', async () => {
        const runtime = createRuntime();

        const clock = await jsonBody<ToolCallResult>(
            await callHandler(runtime, 'POST', '/v1/harness/tools/clock', { body: { parameters: 'UTC' } })
        );
        expect(clock.status).toBe(200);
        expect(clock.body.ok).toBe(true);
        if (clock.body.ok) {
            const result = clock.body.result as { timezone: string; iso: string; unix: number };
            expect(result.timezone).toBe('UTC');
            expect(typeof result.iso).toBe('string');
            expect(typeof result.unix).toBe('number');
        }

        expect(
            await jsonBody(await callHandler(runtime, 'POST', '/v1/harness/tools/nope', { body: {} }))
        ).toEqual({ status: 404, body: { error: { message: 'Unknown tool "nope".' } } });
    });
});

describe('body policy and bounds', () => {
    it('requires a JSON object body on every action endpoint', async () => {
        const runtime = createRuntime();
        const session = await createDemo(runtime);

        // `null`, arrays, strings, and numbers are not objects; every action
        // endpoint answers the same 400 before reading a field off them.
        const cases: { method: string; pathname: string; body: unknown }[] = [
            { method: 'POST', pathname: '/v1/harness/models', body: null },
            { method: 'POST', pathname: '/v1/harness/models', body: [] },
            { method: 'POST', pathname: '/v1/harness/models', body: 'https://provider.example/v1' },
            { method: 'POST', pathname: '/v1/harness/models', body: 7 },
            { method: 'POST', pathname: '/v1/harness/sessions', body: [] },
            { method: 'POST', pathname: `/v1/harness/sessions/${session.id}/messages`, body: 'hello' },
            { method: 'POST', pathname: '/v1/harness/tools/clock', body: 7 }
        ];

        for (const entry of cases) {
            const result = await jsonBody<{ error: { message: string } }>(
                await callHandler(runtime, entry.method, entry.pathname, { body: entry.body })
            );

            expect({ pathname: entry.pathname, result }).toEqual({
                pathname: entry.pathname,
                result: {
                    status: 400,
                    body: { error: { message: 'The request body must be a JSON object.' } }
                }
            });
        }
    });

    it('rejects a tool call without the parameters wrapper and keeps an empty wrapper valid', async () => {
        const runtime = createRuntime();

        // `{}` is exactly what the service loader produces when JSON parsing
        // fails, so it must never reach a tool as "no arguments". `clock` would
        // happily answer with its default timezone if it did.
        expect(
            await jsonBody(await callHandler(runtime, 'POST', '/v1/harness/tools/clock', { body: {} }))
        ).toEqual({
            status: 400,
            body: {
                error: {
                    message:
                        'A tool call requires a "parameters" property. Send {"parameters": {}} for a tool with no arguments.'
                }
            }
        });

        // An explicit empty wrapper stays a valid call (the UI sends this when
        // the argument box is empty). `clock` has one property, so the
        // single-property rule hands `execute` the wrapper object as the value;
        // that is the tool contract, not an HTTP concern, and it stays `ok: true`.
        const clock = await jsonBody<ToolCallResult>(
            await callHandler(runtime, 'POST', '/v1/harness/tools/clock', { body: { parameters: {} } })
        );
        expect(clock.status).toBe(200);
        expect(clock.body.ok).toBe(true);
        if (clock.body.ok) {
            const result = clock.body.result as { timezone: unknown };
            expect(result.timezone).toEqual({});
        }
    });

    it('rejects an over-sized body by declared length or serialized size with 413', async () => {
        const runtime = createRuntime();
        const limit = `A request body cannot exceed ${MAX_API_BODY_BYTES} bytes.`;

        // Honest content-length: rejected before the dispatcher inspects anything.
        const declared = await callHandler(runtime, 'POST', '/v1/harness/models', {
            body: {},
            headers: { 'content-length': String(MAX_API_BODY_BYTES + 1) }
        });
        expect(await jsonBody(declared)).toEqual({ status: 413, body: { error: { message: limit } } });

        // The loader pre-parses JSON, so this body is already in memory by the
        // time the adapter runs (documented residual); the adapter still refuses
        // to dispatch it.
        const oversized = await callHandler(runtime, 'POST', '/v1/harness/models', {
            body: { settings: { apiKey: 'x'.repeat(MAX_API_BODY_BYTES + 1_000) } }
        });
        expect(await jsonBody(oversized)).toEqual({ status: 413, body: { error: { message: limit } } });
    });

    it('maps shared settings validation to 400 with the exact message', async () => {
        const runtime = createRuntime();

        expect(
            await jsonBody(
                await callHandler(runtime, 'POST', '/v1/harness/models', {
                    body: { settings: { baseURL: 'x'.repeat(2_049) } }
                })
            )
        ).toEqual({
            status: 400,
            body: { error: { message: 'A provider base URL cannot exceed 2048 characters.' } }
        });

        expect(
            await jsonBody(
                await callHandler(runtime, 'POST', '/v1/harness/models', {
                    body: { settings: { model: 'x'.repeat(257) } }
                })
            )
        ).toEqual({
            status: 400,
            body: { error: { message: 'A model name cannot exceed 256 characters.' } }
        });

        expect(
            await jsonBody(
                await callHandler(runtime, 'POST', '/v1/harness/models', {
                    body: { settings: { baseURL: 5 } }
                })
            )
        ).toEqual({
            status: 400,
            body: { error: { message: '`settings.baseURL` must be a string when present.' } }
        });
    });
});

describe('service origin gate', () => {
    it('allows requests with no Origin, same-origin, and loopback origins', async () => {
        const runtime = createRuntime();

        const noOrigin = await jsonBody<{ ok: boolean }>(await callHandler(runtime, 'GET', '/v1/harness/health'));
        expect(noOrigin).toEqual({ status: 200, body: { ok: true, sessions: 0 } });

        const sameOrigin = await callHandler(runtime, 'GET', '/v1/harness/health', {
            headers: { origin: 'http://127.0.0.1:5000', host: '127.0.0.1:5000' }
        });
        expect(sameOrigin.status).toBe(200);

        const devLoopback = await callHandler(runtime, 'GET', '/v1/harness/health', {
            headers: { origin: 'http://localhost:5173', host: '127.0.0.1:5000' }
        });
        expect(devLoopback.status).toBe(200);
    });

    it('rejects a non-loopback cross-origin browser request with 403', async () => {
        const runtime = createRuntime();

        const hostile = await callHandler(runtime, 'GET', '/v1/harness', {
            headers: { origin: 'https://evil.example', host: '127.0.0.1:5000' }
        });
        expect(await jsonBody<unknown>(hostile)).toEqual({
            status: 403,
            body: { error: { message: 'Cross-origin requests are not allowed.' } }
        });

        const sameHostDifferentPort = await callHandler(runtime, 'GET', '/v1/harness', {
            headers: { origin: 'http://127.0.0.1:6000', host: '127.0.0.1:5000' }
        });
        // Loopback is allowed by design (dev UI); a LAN origin on another host is not.
        expect(sameHostDifferentPort.status).toBe(200);

        const lanOrigin = await callHandler(runtime, 'GET', '/v1/harness', {
            headers: { origin: 'http://192.168.1.20:8080', host: '127.0.0.1:5000' }
        });
        expect(lanOrigin.status).toBe(403);
    });
});

describe('standalone /api compatibility', () => {
    it('preserves /api root 404, client header auth, and adds the presets alias', async () => {
        const server = await startHarnessServer({ port: 0, staticRoot: null });

        try {
            // The canonical bootstrap does not leak into the legacy mount.
            const root = await fetch(`${server.url}/api`, { headers: { 'X-Harness-Client': 'ui' } });
            expect(root.status).toBe(404);
            expect(await root.json()).toEqual({ error: { message: 'Unknown API route.' } });

            const withoutHeader = await fetch(`${server.url}/api/harnesses`);
            expect(withoutHeader.status).toBe(403);

            const harnesses = await fetch(`${server.url}/api/harnesses`, {
                headers: { 'X-Harness-Client': 'ui' }
            });
            const presets = await fetch(`${server.url}/api/presets`, {
                headers: { 'X-Harness-Client': 'ui' }
            });
            expect(harnesses.status).toBe(200);
            expect(presets.status).toBe(200);
            expect(await presets.json()).toEqual(await harnesses.json());
        } finally {
            await server.close();
        }
    });
});

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

// The harness-owned core tools lead the catalogue (R8): GET /tools, its
// /tools/bootstrap alias, and the bootstrap document all list them so a client can
// review and manually execute them against a session.
const CORE_TOOL_NAMES = ['requestTools', 'createTool', 'todoTools', 'delegate'];

// The exact catalogue order after the core set: nine package presets, six harness
// tools, websearch.
const CATALOGUE_TOOL_NAMES = [
    'syntaxCheck',
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

const TOOL_NAMES = [...CORE_TOOL_NAMES, ...CATALOGUE_TOOL_NAMES];

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
        expect(Object.keys(body)).toEqual(['rootPath', 'presets', 'agents', 'tools', 'defaults', 'sessions']);
        // The advertised root is the canonical API URL, not a filesystem path.
        expect(body.rootPath).toBe('/v1/harness');
        expect((body.presets as { name: string }[]).map((preset) => preset.name)).toEqual(PRESET_NAMES);
        // The trusted agents are part of the boot document: a client can offer a
        // primary/subagent picker without a second request.
        expect((body.agents as { name: string }[]).map((agent) => agent.name)).toEqual([
            'instruct',
            'research',
            'summarizer',
            'workspace',
            'demo',
            'flaky'
        ]);
        expect((body.tools as { name: string }[]).map((tool) => tool.name)).toEqual(TOOL_NAMES);
        expect(body.defaults).toEqual(DEFAULTS);
        expect(body.sessions).toEqual([]);

        // Descriptors, not factories: the first card is the Instruct harness, and
        // the only core tools are the harness-owned ones (no subagents, so no
        // delegate). Every preset tool is searchable.
        expect((body.presets as unknown[])[0]).toEqual({
            name: 'instruct',
            title: 'Instruct',
            description:
                'A general instruction-following agent with the full shared toolbox. Every capability is searchable: call requestTools with capability tags to enable the file, command, git, time, text, notes, or web-search tools the task needs. The live presets differ only in their agents, not their tools.',
            requiresEndpoint: true,
            primary: 'instruct',
            subagents: [],
            agents: ['instruct'],
            tools: [
                'syntaxCheck',
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
            coreTools: ['requestTools', 'createTool', 'todoTools'],
            builtin: true,
            editable: true
        });

        // The offline fixture is still described, just no longer the first card;
        // it is a fixture, so it is not editable.
        expect((body.presets as { name: string; tools: string[]; coreTools: string[] }[]).find(
            (preset) => preset.name === 'demo'
        )).toEqual({
            name: 'demo',
            title: 'Scripted demo',
            description:
                'Runs a scripted transport: a reasoning stream, a requestTools discovery round, one tool call, and a final answer. No endpoint needed, so this is the fixture to try first. It is deliberately not a live harness: the toolbox rule applies to Instruct, Research, and Workspace.',
            requiresEndpoint: false,
            primary: 'demo',
            subagents: [],
            agents: ['demo'],
            tools: ['clock'],
            coreTools: ['requestTools', 'createTool', 'todoTools'],
            builtin: true,
            editable: false
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
    // The exact shared toolbox every live preset advertises: nine package tools,
    // then five app tools. No live card gets a subset any more.
    const TOOLBOX = [
        'syntaxCheck',
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

    // Only the harness-owned names are core now. The whole shared toolbox —
    // file tools included — is searchable, so no preset entry appears here.
    // Agent configuration: only Research declares a subagent, so only Research
    // gets the delegate tool.
    const CORE_TOOLS = {
        instruct: ['requestTools', 'createTool', 'todoTools'],
        research: ['requestTools', 'createTool', 'todoTools', 'delegate'],
        workspace: ['requestTools', 'createTool', 'todoTools'],
        demo: ['requestTools', 'createTool', 'todoTools'],
        flaky: ['requestTools', 'createTool', 'todoTools']
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
            'agentModels',
            'createdAt',
            'updatedAt',
            'messages',
            'turns',
            'harnessDefinition',
            'discoveredTools'
        ]);
        expect(session.harness).toBe('demo');
        expect(session.status).toBe('idle');
        expect(session.model).toBe('demo-model');
        expect(session.createdAt).toBe(session.updatedAt);
        expect(session.turns).toEqual([]);
        // The demo agent's profile seeds two system messages: the instruction and
        // the composed guidelines block.
        expect(session.messages.map((message) => message.role)).toEqual(['system', 'system']);

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
        expect(Object.keys(first.turn)).toEqual([
            'id',
            'index',
            'prompt',
            'status',
            'startedAt',
            'updatedAt',
            'events',
            'eventTimes'
        ]);
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
        // Two seeded system messages: profile instruction + guidelines.
        expect(body.session.messages.map((message) => message.role)).toEqual(['system', 'system']);
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

// R8 — all-tools manual execution, server-side.
//
// The Tools tab lists EVERY tool, core included, and every call executes on the
// server. A core tool has no standalone implementation: it runs inside a session's
// harness, so discovery, runtime creation, todos, and delegation change the
// conversation the user is looking at. These tests pin the listing shape, the
// session binding, the status contract (400 missing session, 404 unknown session or
// unavailable tool, 409 while running) and the effect on the session.
describe('all-tools manual execution', () => {
    const coreHint = 'Runs inside a session harness: send a sessionId with the call.';

    it('lists the core tools with their visibility and session binding', async () => {
        const runtime = createRuntime();
        const { status, body } = await jsonBody<ToolIndex>(
            await callHandler(runtime, 'GET', '/v1/harness/tools')
        );

        expect(status).toBe(200);
        const core = body.tools.slice(0, 4);
        expect(core.map((tool) => tool.name)).toEqual(CORE_TOOL_NAMES);

        // requestTools is exact: its schema is the R7 advertisement (five max,
        // `limit` cap, remaining count in the description).
        expect(core[0]).toEqual({
            name: 'requestTools',
            group: 'Core tools',
            description:
                'Find tools by capability tag and enable them. The whole catalogue is searchable (including the file and command tools). Pass the tags you need (for example ["files", "read"] or ["shell"] or ["git", "diff"]) and up to 5 of the closest matches become available on your next turn. The result\'s "remaining" field counts any further tools that matched but were not listed, so add a more specific tag to drill into the rest. Call this before concluding that something cannot be done.',
            tags: ['discovery', 'tools', 'catalogue'],
            visibility: 'core',
            parameters: {
                type: 'object',
                properties: {
                    tags: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Capability tags to look for, e.g. ["files", "read", "shell"].'
                    },
                    limit: {
                        type: 'integer',
                        minimum: 1,
                        maximum: 5,
                        description:
                            'How many matches to enable: 1-5. Defaults to 5 (the maximum); a lower value gives a tighter shortlist.'
                    }
                },
                required: ['tags'],
                additionalProperties: false
            },
            availability: { state: 'available', hint: coreHint },
            sessionBound: true
        });

        // The rest are core-marked, session-bound, and carry a real schema.
        expect(core.slice(1)).toEqual(
            ['createTool', 'todoTools', 'delegate'].map((name) => ({
                name,
                group: 'Core tools',
                description: expect.any(String),
                tags: expect.any(Array),
                visibility: 'core',
                parameters: expect.any(Object),
                availability: { state: 'available', hint: coreHint },
                sessionBound: true
            }))
        );

        // Everything else keeps the directly callable shape: no session binding.
        expect(body.tools.slice(4).map((tool) => tool.name)).toEqual(CATALOGUE_TOOL_NAMES);
        expect(body.tools.slice(4).every((tool) => tool.sessionBound === undefined)).toBe(true);
    });

    it('serves the same catalogue at /tools/bootstrap', async () => {
        const runtime = createRuntime();

        const listed = await jsonBody<ToolIndex>(await callHandler(runtime, 'GET', '/v1/harness/tools'));
        const bootstrapped = await jsonBody<ToolIndex>(
            await callHandler(runtime, 'GET', '/v1/harness/tools/bootstrap')
        );

        expect(bootstrapped).toEqual(listed);

        // The bootstrap document (GET /v1/harness) carries the same list.
        const root = await jsonBody<{ tools: unknown[] }>(await callHandler(runtime, 'GET', '/v1/harness'));
        expect(root.body.tools).toEqual(listed.body.tools);

        expect(
            await jsonBody(await callHandler(runtime, 'POST', '/v1/harness/tools/bootstrap', { body: {} }))
        ).toEqual({
            status: 405,
            body: { error: { message: 'Use GET for /v1/harness/tools/bootstrap.' } }
        });
    });

    it('runs requestTools inside the session so the match is enabled there', async () => {
        const runtime = createRuntime();
        const session = await createDemo(runtime);

        const result = await jsonBody<ToolCallResult>(
            await callHandler(runtime, 'POST', '/v1/harness/tools/requestTools', {
                body: { sessionId: session.id, parameters: { tags: ['time'] } }
            })
        );

        expect(result.status).toBe(200);
        expect(result.body).toEqual({
            ok: true,
            result: {
                enabled: ['clock'],
                tools: [
                    {
                        name: 'clock',
                        description:
                            'Read the current time. Returns an ISO 8601 timestamp and the Unix time in seconds. The timezone argument is only a label for the answer.',
                        tags: ['time', 'clock', 'date']
                    }
                ],
                remaining: 0
            },
            durationMs: expect.any(Number)
        });

        // The SESSION changed, not a detached catalogue: its snapshot now reports
        // the discovery, exactly as a model-driven requestTools would.
        expect(runtime.store.get(session.id).discoveredTools).toEqual(['clock']);
    });

    it('runs createTool inside the session with the guarded registration policy', async () => {
        const runtime = createRuntime();
        const session = await createDemo(runtime);

        const created = await jsonBody<ToolCallResult>(
            await callHandler(runtime, 'POST', '/v1/harness/tools/createTool', {
                body: {
                    sessionId: session.id,
                    parameters: {
                        name: 'uppercase',
                        description: 'Uppercase text.',
                        tags: ['text', 'upper'],
                        source: 'return String(args).toUpperCase();'
                    }
                }
            })
        );

        expect(created.status).toBe(200);
        expect(created.body).toEqual({
            ok: true,
            result: {
                name: 'uppercase',
                description: 'Uppercase text.',
                tags: ['text', 'upper'],
                enabled: true
            },
            durationMs: expect.any(Number)
        });
        expect(runtime.store.get(session.id).discoveredTools).toEqual(['uppercase']);

        // The policy is still enforced: the same name is now registered, so a
        // second manual creation fails as data (ok: false) instead of overwriting.
        const collided = await jsonBody<ToolCallResult>(
            await callHandler(runtime, 'POST', '/v1/harness/tools/createTool', {
                body: {
                    sessionId: session.id,
                    parameters: {
                        name: 'uppercase',
                        description: 'Again.',
                        tags: ['text'],
                        source: 'return 1;'
                    }
                }
            })
        );

        expect(collided.status).toBe(200);
        expect(collided.body.ok).toBe(false);
        if (!collided.body.ok) {
            expect(collided.body.error.message).toBe(
                'Tool "uppercase" is already registered; choose another name.'
            );
        }

        // A reserved name is refused by the same path, never by a bypass.
        const reserved = await jsonBody<ToolCallResult>(
            await callHandler(runtime, 'POST', '/v1/harness/tools/createTool', {
                body: {
                    sessionId: session.id,
                    parameters: {
                        name: 'todoTools',
                        description: 'Mine.',
                        tags: ['text'],
                        source: 'return 1;'
                    }
                }
            })
        );
        expect(reserved.body.ok).toBe(false);
        if (!reserved.body.ok) {
            expect(reserved.body.error.message).toBe('Tool name "todoTools" is reserved by the harness.');
        }
    });

    it('runs todoTools against the session list', async () => {
        const runtime = createRuntime();
        const session = await createDemo(runtime);

        const added = await jsonBody<ToolCallResult>(
            await callHandler(runtime, 'POST', '/v1/harness/tools/todoTools', {
                body: { sessionId: session.id, parameters: { action: 'add', text: '  check bounds ' } }
            })
        );

        expect(added.body).toEqual({
            ok: true,
            result: {
                todos: [{ id: '1', text: 'check bounds', completed: false }],
                todo: { id: '1', text: 'check bounds', completed: false },
                counts: { total: 1, completed: 0, remaining: 1 }
            },
            durationMs: expect.any(Number)
        });

        // A second call sees the SAME list: the tool lives in the session harness.
        const listed = await jsonBody<ToolCallResult>(
            await callHandler(runtime, 'POST', '/v1/harness/tools/todoTools', {
                body: { sessionId: session.id, parameters: { action: 'list' } }
            })
        );

        expect(listed.body).toEqual({
            ok: true,
            result: {
                todos: [{ id: '1', text: 'check bounds', completed: false }],
                counts: { total: 1, completed: 0, remaining: 1 }
            },
            durationMs: expect.any(Number)
        });
    });

    it('requires a usable sessionId for a core call', async () => {
        const runtime = createRuntime();
        const session = await createDemo(runtime);

        expect(
            await jsonBody(
                await callHandler(runtime, 'POST', '/v1/harness/tools/todoTools', {
                    body: { parameters: { action: 'list' } }
                })
            )
        ).toEqual({
            status: 400,
            body: {
                error: {
                    message: 'Tool "todoTools" runs inside a session; send a "sessionId" with the call.'
                }
            }
        });

        // An empty id is "no session" for this purpose, not a lookup.
        expect(
            await jsonBody(
                await callHandler(runtime, 'POST', '/v1/harness/tools/todoTools', {
                    body: { sessionId: '', parameters: { action: 'list' } }
                })
            )
        ).toEqual({
            status: 400,
            body: {
                error: {
                    message: 'Tool "todoTools" runs inside a session; send a "sessionId" with the call.'
                }
            }
        });

        // A present-but-unusable type is a 400, never coerced into a 404 lookup.
        expect(
            await jsonBody(
                await callHandler(runtime, 'POST', '/v1/harness/tools/todoTools', {
                    body: { sessionId: 7, parameters: { action: 'list' } }
                })
            )
        ).toEqual({
            status: 400,
            body: { error: { message: '`sessionId` must be a string when present.' } }
        });

        // The parameters wrapper is still mandatory, and an unknown tool still
        // answers 404 before the body is read.
        expect(
            await jsonBody(
                await callHandler(runtime, 'POST', '/v1/harness/tools/todoTools', {
                    body: { sessionId: session.id }
                })
            )
        ).toEqual({
            status: 400,
            body: {
                error: {
                    message:
                        'A tool call requires a "parameters" property. Send {"parameters": {}} for a tool with no arguments.'
                }
            }
        });
        expect(
            await jsonBody(
                await callHandler(runtime, 'POST', '/v1/harness/tools/nope', {
                    body: { sessionId: session.id, parameters: {} }
                })
            )
        ).toEqual({ status: 404, body: { error: { message: 'Unknown tool "nope".' } } });
    });

    it('answers 404 for an unknown session and for a core tool that session lacks', async () => {
        const runtime = createRuntime();
        await createDemo(runtime);

        expect(
            await jsonBody(
                await callHandler(runtime, 'POST', '/v1/harness/tools/todoTools', {
                    body: { sessionId: 'missing', parameters: { action: 'list' } }
                })
            )
        ).toEqual({ status: 404, body: { error: { message: 'Unknown session "missing".' } } });

        // The scripted demo has no subagents, so its harness registers no delegate.
        // The catalogue still DESCRIBES delegate; the session answers clearly.
        const session = await createDemo(runtime);
        expect(
            await jsonBody(
                await callHandler(runtime, 'POST', '/v1/harness/tools/delegate', {
                    body: { sessionId: session.id, parameters: { agent: 'helper', input: 'go' } }
                })
            )
        ).toEqual({
            status: 404,
            body: { error: { message: 'Tool "delegate" is not available in this session.' } }
        });
    });

    it('rejects a core call while the session is running with 409', async () => {
        const runtime = createRuntime();
        const session = await createDemo(runtime);

        // Hold the run open on its turn frame, exactly like the busy-session test.
        const stream = await runtime.api({
            method: 'POST',
            pathname: `/v1/harness/sessions/${session.id}/messages`,
            mount: '/v1/harness',
            readBody: async () => ({ input: 'first' }),
            bootstrapRoot: true
        });
        if (stream.kind !== 'stream') throw new Error('expected a stream');

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

        // A manual mutation must not race a live turn: discovery, created tools, and
        // todos all write harness state the running transcript depends on.
        expect(
            await jsonBody(
                await callHandler(runtime, 'POST', '/v1/harness/tools/requestTools', {
                    body: { sessionId: session.id, parameters: { tags: ['time'] } }
                })
            )
        ).toEqual({
            status: 409,
            body: { error: { message: 'A task is running in this session; try again when it finishes.' } }
        });

        controller.abort();
        release();
        await run;
    });

    it('accepts the verb-named /call alias for the same route', async () => {
        const runtime = createRuntime();
        const session = await createDemo(runtime);

        const alias = await jsonBody<ToolCallResult>(
            await callHandler(runtime, 'POST', '/v1/harness/tools/todoTools/call', {
                body: { sessionId: session.id, parameters: { action: 'list' } }
            })
        );

        expect(alias.body).toEqual({
            ok: true,
            result: { todos: [], counts: { total: 0, completed: 0, remaining: 0 } },
            durationMs: expect.any(Number)
        });

        expect(
            await jsonBody(await callHandler(runtime, 'GET', '/v1/harness/tools/todoTools/call'))
        ).toEqual({
            status: 405,
            body: { error: { message: 'Use POST for /v1/harness/tools/:name/call.' } }
        });
    });

    it('keeps the session-less runner for a directly callable tool', async () => {
        const runtime = createRuntime();
        const session = await createDemo(runtime);

        // One request shape: a UI may send the selected session with any call. For
        // a catalogue tool it is accepted and ignored — the direct runner is
        // unchanged, with no session state involved.
        const clock = await jsonBody<ToolCallResult>(
            await callHandler(runtime, 'POST', '/v1/harness/tools/clock', {
                body: { sessionId: session.id, parameters: 'UTC' }
            })
        );

        expect(clock.status).toBe(200);
        expect(clock.body.ok).toBe(true);
        if (clock.body.ok) {
            expect((clock.body.result as { timezone: string }).timezone).toBe('UTC');
        }
        expect(runtime.store.get(session.id).discoveredTools).toEqual([]);
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

// The harness registry over HTTP.
//
// A client may CREATE a harness (select trusted agents) and PATCH a built-in
// live harness's metadata/routing. Both are in-memory; both affect future
// sessions only, which the frozen-definition assertions below pin directly.
describe('harness registry over HTTP', () => {
    const INSTRUCT_GUIDELINES = [
        'The whole catalogue is searchable. Call requestTools with capability tags before concluding that a capability is missing; discovery enables the matches for your next turn.',
        'Tags are broad: "files"/"read" to read a file, "files"/"write" and "files"/"edit" to change one, "files"/"list", "files"/"search", and "files"/"glob" to inspect a tree, "shell" to run a command, "git"/"diff" to review the working tree, "javascript" or "python" to check syntax with syntaxCheck, and "time", "text", "random", "notes", and "web"/"search" for the internet when the host configured a search key.',
        'Prefer a tool over memory when it can answer more accurately, and say which tool you used.',
        'File and command tools execute on the server host with the server process permissions and are not sandboxed, so inspect before you change anything.',
        'If a small capability is missing, createTool can add one for this session.',
        'Be concise.'
    ];

    const createSessionFor = async (runtime: HarnessRuntime, harness: string): Promise<SessionSnapshot> => {
        const result = await callHandler(runtime, 'POST', '/v1/harness/sessions', {
            body: { harness }
        });
        const { status, body } = await jsonBody<{ session: SessionSnapshot }>(result);
        expect(status).toBe(201);
        return body.session;
    };

    it('serves the trusted agent registry', async () => {
        const runtime = createRuntime();
        const { status, body } = await jsonBody<{ agents: unknown[] }>(
            await callHandler(runtime, 'GET', '/v1/harness/agents')
        );

        expect(status).toBe(200);
        // The first descriptor is exact: the profile text is catalogue data, and a
        // picker renders it verbatim.
        expect(body.agents[0]).toEqual({
            name: 'instruct',
            title: 'Instruct',
            description:
                'General instruction-following agent with the shared toolbox. Answers directly, and discovers the capabilities it needs before using them.',
            instruction:
                'You are the Instruct agent. Answer the request directly and keep the answer focused.',
            guidelines: INSTRUCT_GUIDELINES
        });
        expect((body.agents as { name: string }[]).map((agent) => agent.name)).toEqual([
            'instruct',
            'research',
            'summarizer',
            'workspace',
            'demo',
            'flaky'
        ]);

        // It is also part of the harness index and the boot document.
        const index = await jsonBody<HarnessIndex>(await callHandler(runtime, 'GET', '/v1/harness/harnesses'));
        expect(index.body.agents).toEqual(body.agents);
        const bootstrap = await jsonBody<{ agents: unknown[] }>(
            await callHandler(runtime, 'GET', '/v1/harness')
        );
        expect(bootstrap.body.agents).toEqual(body.agents);
    });

    it('creates a harness, lists it, and runs a session with it', async () => {
        const runtime = createRuntime();

        const created = await callHandler(runtime, 'POST', '/v1/harness/harnesses', {
            body: {
                name: 'review',
                title: 'Review pair',
                description: 'Research plus a summarizer.',
                primary: 'research',
                subagents: ['summarizer']
            }
        });
        const { status, body } = await jsonBody<{ harness: HarnessDescriptor }>(created);

        expect(status).toBe(201);
        expect(body.harness).toEqual({
            name: 'review',
            title: 'Review pair',
            description: 'Research plus a summarizer.',
            requiresEndpoint: true,
            primary: 'research',
            subagents: ['summarizer'],
            agents: ['research', 'summarizer'],
            // The keyless runtime catalogue has no callable websearch, so the
            // descriptor advertises exactly the registered static toolbox.
            tools: [
                'syntaxCheck',
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
            coreTools: ['requestTools', 'createTool', 'todoTools', 'delegate'],
            builtin: false,
            editable: true
        });

        // The index now lists it after the built-ins, with the same descriptor.
        const index = await jsonBody<HarnessIndex>(await callHandler(runtime, 'GET', '/v1/harness/harnesses'));
        expect(index.body.harnesses.map((entry) => entry.name)).toEqual([
            'instruct',
            'research',
            'workspace',
            'demo',
            'flaky',
            'review'
        ]);
        expect(index.body.harnesses.at(-1)).toEqual(body.harness);

        // A session resolved by the same registry runs it; the snapshot freezes
        // the descriptor and the two seeded agents.
        const session = await createSessionFor(runtime, 'review');
        expect(session.harness).toBe('review');
        expect(session.harnessDefinition).toEqual(body.harness);
        expect(session.messages).toEqual([
            {
                role: 'system',
                content:
                    'You are the Research agent. Investigate before you answer, and separate what you found from what you inferred.'
            },
            {
                role: 'system',
                content: [
                    'Guidelines:',
                    ...runtime.registry
                        .agents()
                        .find((agent) => agent.name === 'research')!
                        .guidelines.map((line) => `- ${line}`)
                ].join('\n')
            }
        ]);
    });

    it('applies per-agent models and freezes them per session', async () => {
        const runtime = createRuntime();

        const created = await callHandler(runtime, 'POST', '/v1/harness/harnesses', {
            body: {
                name: 'modelled',
                primary: 'research',
                subagents: ['summarizer'],
                agentModels: { summarizer: 'small/fast' }
            }
        });
        const { status, body } = await jsonBody<{ harness: HarnessDescriptor }>(created);

        expect(status).toBe(201);
        // The descriptor carries the OVERRIDE map: the primary is absent because it
        // uses the session model, which is what a dropdown renders as "default".
        expect(body.harness.agentModels).toEqual({ summarizer: 'small/fast' });

        // The live factory applies the map per agent: the summarizer uses the
        // override, the primary falls back to the session model.
        const preset = runtime.registry.find('modelled')!;
        const built = preset.create(
            { baseURL: 'http://provider.test/v1', apiKey: '', model: 'demo-model' },
            () => undefined
        );
        expect(built.agents.summarizer.model()).toBe('small/fast');
        expect(built.agents.research.model()).toBe('demo-model');

        // A session captures the map in its frozen definition, and reports the
        // EFFECTIVE model per agent so a reload can render every dropdown.
        const session = await createSessionFor(runtime, 'modelled');
        expect(session.harnessDefinition?.agentModels).toEqual({ summarizer: 'small/fast' });
        expect(session.model).toBe('demo-model');
        expect(session.agentModels).toEqual({
            // Omitted in the map, so it uses the session model.
            research: 'demo-model',
            summarizer: 'small/fast'
        });

        // A stated map on PATCH replaces the previous one.
        const patched = await callHandler(runtime, 'PATCH', '/v1/harness/harnesses/modelled', {
            body: { agentModels: { research: 'big/model' } }
        });
        expect((await jsonBody<{ harness: HarnessDescriptor }>(patched)).body.harness.agentModels).toEqual({
            research: 'big/model'
        });

        // The earlier session keeps what it was built with (frozen definition AND
        // the effective per-agent models it reports).
        expect(runtime.store.get(session.id).harnessDefinition?.agentModels).toEqual({
            summarizer: 'small/fast'
        });
        expect(runtime.store.get(session.id).agentModels).toEqual({
            research: 'demo-model',
            summarizer: 'small/fast'
        });

        // An override on the primary shows up as the session's model, and the
        // summarizer falls back again because the replacement map omits it.
        const focused = await createSessionFor(runtime, 'modelled');
        expect(focused.model).toBe('big/model');
        expect(focused.agentModels).toEqual({ research: 'big/model', summarizer: 'demo-model' });

        // `{}` clears every override, and the descriptor drops the field again.
        const cleared = await callHandler(runtime, 'PATCH', '/v1/harness/harnesses/modelled', {
            body: { agentModels: {} }
        });
        expect(
            (await jsonBody<{ harness: HarnessDescriptor }>(cleared)).body.harness.agentModels
        ).toBeUndefined();
    });

    it('validates per-agent models: members only, bounded non-empty ids', async () => {
        const runtime = createRuntime();

        const post = async (body: unknown) =>
            jsonBody<{ error: { message: string } }>(
                await callHandler(runtime, 'POST', '/v1/harness/harnesses', { body })
            );

        // A key that is not a selected member is rejected with the member list.
        expect(
            await post({ name: 'model-x', primary: 'instruct', agentModels: { summarizer: 'small/fast' } })
        ).toEqual({
            status: 400,
            body: {
                error: {
                    message:
                        '`agentModels` names "summarizer", which is not a member of this harness. Members: instruct.'
                }
            }
        });

        // Not an object of strings.
        expect(await post({ name: 'model-y', primary: 'instruct', agentModels: ['small/fast'] })).toEqual({
            status: 400,
            body: { error: { message: '`agentModels` must be an object mapping agent ids to model ids.' } }
        });

        // Blank and over-long ids are rejected, naming the agent.
        expect(await post({ name: 'model-z', primary: 'instruct', agentModels: { instruct: '  ' } })).toEqual({
            status: 400,
            body: { error: { message: '`agentModels.instruct` cannot be empty.' } }
        });
        expect(
            await post({ name: 'model-w', primary: 'instruct', agentModels: { instruct: 'a'.repeat(201) } })
        ).toEqual({
            status: 400,
            body: { error: { message: '`agentModels.instruct` cannot exceed 200 characters.' } }
        });

        // The same validation applies on PATCH, against the final member set.
        expect(
            await jsonBody(
                await callHandler(runtime, 'PATCH', '/v1/harness/harnesses/instruct', {
                    body: { agentModels: { summarizer: 'small/fast' } }
                })
            )
        ).toEqual({
            status: 400,
            body: {
                error: {
                    message:
                        '`agentModels` names "summarizer", which is not a member of this harness. Members: instruct.'
                }
            }
        });
    });

    it('validates create requests: one primary, trusted agents, no client prompt', async () => {
        const runtime = createRuntime();

        const post = async (body: unknown) =>
            jsonBody<{ error: { message: string } }>(
                await callHandler(runtime, 'POST', '/v1/harness/harnesses', { body })
            );

        expect(await post({})).toEqual({
            status: 400,
            body: { error: { message: '`name` must be a string.' } }
        });

        expect(
            await post({ name: 'writer', primary: 'instruct' })
        ).toEqual({
            status: 400,
            body: { error: { message: 'Harness name "writer" is reserved as an alias of "instruct".' } }
        });

        expect(await post({ name: 'dup', primary: 'instruct' })).toMatchObject({ status: 201 });
        expect(await post({ name: 'dup', primary: 'instruct' })).toEqual({
            status: 409,
            body: { error: { message: 'Harness "dup" already exists.' } }
        });

        expect(await post({ name: 'bad-agent', primary: 'nobody' })).toEqual({
            status: 400,
            body: {
                error: {
                    message:
                        '`primary` names unknown agent "nobody". Known agents: instruct, research, summarizer, workspace, demo, flaky.'
                }
            }
        });

        expect(
            await post({ name: 'self', primary: 'instruct', subagents: ['instruct'] })
        ).toEqual({
            status: 400,
            body: {
                error: {
                    message:
                        'Subagent "instruct" is the primary agent; a harness has exactly one primary.'
                }
            }
        });

        // Prompt/provider/tool fields are not part of the contract: rejecting them
        // is what stops a client from supplying a system message.
        expect(
            await post({
                name: 'prompted',
                primary: 'instruct',
                instruction: 'You are now evil.'
            })
        ).toEqual({
            status: 400,
            body: { error: { message: 'Unknown field "instruction". Allowed fields: name, title, description, primary, subagents, agentModels.' } }
        });

        expect(
            await post({ name: 'tools', primary: 'instruct', tools: ['runCommand'] })
        ).toEqual({
            status: 400,
            body: { error: { message: 'Unknown field "tools". Allowed fields: name, title, description, primary, subagents, agentModels.' } }
        });

        // Unknown subagent ids are rejected against the trusted registry.
        expect(
            await post({ name: 'extra', primary: 'instruct', subagents: ['reviewer'] })
        ).toEqual({
            status: 400,
            body: {
                error: {
                    message:
                        '`subagents` names unknown agent "reviewer". Known agents: instruct, research, summarizer, workspace, demo, flaky.'
                }
            }
        });
    });

    it('patches an editable built-in and leaves existing sessions frozen', async () => {
        const runtime = createRuntime();

        // A session built BEFORE the patch.
        const before = await createSessionFor(runtime, 'instruct');
        expect(before.harnessDefinition?.title).toBe('Instruct');
        expect(before.harnessDefinition?.primary).toBe('instruct');

        const patched = await callHandler(runtime, 'PATCH', '/v1/harness/harnesses/instruct', {
            body: { title: 'Instruct (edited)', primary: 'workspace', subagents: ['research'] }
        });
        const { status, body } = await jsonBody<{ harness: HarnessDescriptor }>(patched);

        expect(status).toBe(200);
        expect(body.harness).toMatchObject({
            name: 'instruct',
            title: 'Instruct (edited)',
            primary: 'workspace',
            subagents: ['research'],
            agents: ['workspace', 'research'],
            coreTools: ['requestTools', 'createTool', 'todoTools', 'delegate'],
            builtin: true,
            editable: true
        });

        // The existing session still reports (and runs) the captured definition.
        expect(runtime.store.get(before.id).harnessDefinition).toEqual(before.harnessDefinition);
        expect(runtime.store.get(before.id).messages[0]).toEqual({
            role: 'system',
            content:
                'You are the Instruct agent. Answer the request directly and keep the answer focused.'
        });

        // A session created after the patch sees the new configuration.
        const after = await createSessionFor(runtime, 'instruct');
        expect(after.harnessDefinition).toEqual(body.harness);
        expect(after.messages[0]).toEqual({ role: 'system', content: 'You are a workspace coding agent.' });
    });

    it('refuses read-only fixtures and invalid patches', async () => {
        const runtime = createRuntime();

        const patch = async (name: string, body: unknown) =>
            jsonBody<{ error: { message: string } }>(
                await callHandler(runtime, 'PATCH', `/v1/harness/harnesses/${name}`, { body })
            );

        expect(await patch('demo', { title: 'Nope' })).toEqual({
            status: 403,
            body: { error: { message: 'Harness "demo" is read-only.' } }
        });
        expect(await patch('flaky', { title: 'Nope' })).toEqual({
            status: 403,
            body: { error: { message: 'Harness "flaky" is read-only.' } }
        });
        expect(await patch('missing', { title: 'Nope' })).toEqual({
            status: 404,
            body: { error: { message: 'Unknown harness "missing".' } }
        });

        expect(await patch('instruct', {})).toEqual({
            status: 400,
            body: {
                error: {
                    message:
                        'A patch must change at least one of: title, description, primary, subagents, agentModels.'
                }
            }
        });

        // `name` is immutable, and a client still cannot smuggle an instruction.
        expect(await patch('instruct', { name: 'renamed' })).toEqual({
            status: 400,
            body: { error: { message: 'Unknown field "name". Allowed fields: title, description, primary, subagents, agentModels.' } }
        });
        expect(await patch('instruct', { instruction: 'x' })).toEqual({
            status: 400,
            body: { error: { message: 'Unknown field "instruction". Allowed fields: title, description, primary, subagents, agentModels.' } }
        });

        // Writes are only on the canonical mount: /presets stays a read-only alias.
        const aliasWrite = await jsonBody<{ error: { message: string } }>(
            await callHandler(runtime, 'POST', '/v1/harness/presets', {
                body: { name: 'x', primary: 'instruct' }
            })
        );
        expect(aliasWrite).toEqual({ status: 405, body: { error: { message: 'Use GET for /v1/harness/presets.' } } });
    });
});

// Timing and discovery through the server record.
describe('recorded run timing', () => {
    it('stamps every event frame and persists the same times on the turn', async () => {
        const runtime = createRuntime();
        const session = await createDemo(runtime);

        const items = await streamItems(
            await callHandler(runtime, 'POST', `/v1/harness/sessions/${session.id}/messages`, {
                body: { input: 'What time is it?' }
            })
        );

        const frames = items.flatMap((item) => (item.type === 'event' ? [item] : []));

        // Every frame carries an epoch-ms stamp; the server clock is real here, so
        // assert alignment rather than one number.
        expect(frames.every((frame) => typeof frame.at === 'number' && frame.at > 0)).toBe(true);

        const terminal = items.at(-1);
        if (terminal?.type !== 'snapshot') throw new Error('expected a terminal snapshot');

        const turn = terminal.session.turns[0];
        expect(turn.eventTimes).toEqual(frames.map((frame) => frame.at));
        expect(turn.eventTimes).toHaveLength(turn.events.length);

        // Times are monotonic within the turn (the sink records in order).
        const times = turn.eventTimes!;
        expect(times.every((value, index) => index === 0 || value >= times[index - 1])).toBe(true);

        // Discovery is part of the recorded snapshot: the scripted demo enabled
        // `clock` through requestTools, so a reload can show it.
        expect(terminal.session.discoveredTools).toEqual(['clock']);

        // And the record survives the reload path unchanged.
        expect(runtime.store.get(session.id).turns).toEqual(terminal.session.turns);
        expect(runtime.store.get(session.id).discoveredTools).toEqual(['clock']);
    });
});


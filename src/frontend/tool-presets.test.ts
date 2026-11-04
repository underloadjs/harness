// R8 (T8 correction) — the playground presets must be USEFUL for every listed tool.
//
// The first pass curated presets for the file/shell/search tools and left the rest with a
// schema-derived skeleton, which for the runtime and story tools meant a button that
// filled `{}` or `{"action": ""}` — a payload the tool rejects. Every one of those tools
// now has hand-written presets, and this file pins them against the tools' REAL schemas
// (required keys, enum spellings, `additionalProperties: false`, bounds and patterns, read
// out of src/tools/**/​*.tool.ts).
//
// Two invariants are asserted for every tool, exactly:
//   1. the preset payload validates against the schema (a rejected preset is worse than
//      none, because it looks like guidance);
//   2. anything naming a RUNTIME id (a call, a thread, an id minted by `add`, an agent the
//      harness may not have) is an unmistakable `<angle-bracket>` placeholder AND its
//      button label says "(edit …)" — the runner never pretends an invented id is valid.
//
// It also pins that a preset only FILLS the box: "Call tool" sends the EDITED text,
// parsed, and nothing else.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts tool-presets.test.ts

import type { HarnessDescriptor, SessionSnapshot, ToolDescriptor } from '../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { viewAwareFetch } from './view-test-support';

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
};

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

// --- The tools under test, with the schemas their own metadata declares --------------

const object = (
    properties: Record<string, unknown>,
    required: string[] = [],
    additionalProperties = false
): Record<string, unknown> => ({
    type: 'object',
    properties,
    required,
    additionalProperties
});

const str = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: 'string', ...extra });
const ints = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: 'integer', ...extra });
const strings = (): Record<string, unknown> => ({ type: 'array', items: { type: 'string' } });

// The CRUD story tools share one shape: `action` (or `operation`) is the only required
// property, and the read/page actions are enums the presets must spell exactly.
const storySchema = (actions: string[]): Record<string, unknown> =>
    object(
        {
            action: { type: 'string', enum: actions },
            id: str(),
            name: str({ maxLength: 200 }),
            title: str({ maxLength: 200 }),
            description: str({ maxLength: 4000 }),
            summary: str({ maxLength: 4000 }),
            content: str({ maxLength: 4000 }),
            notes: str({ maxLength: 4000 }),
            traits: { type: 'array', items: str({ maxLength: 200 }), maxItems: 32 },
            status: { type: 'string', enum: ['planned', 'draft', 'complete'] },
            order: ints(),
            offset: ints({ minimum: 0 }),
            limit: { type: 'integer', minimum: 1, maximum: 100 }
        },
        ['action']
    );

const TOOLS: readonly ToolDescriptor[] = [
    // sessionBound: the runtime tools execute inside a session.
    //
    // `task` (R9-R11: the old `todoManage`) is a MERGE command, not an action enum: a
    // `tasks` entry with no `id` adds one, an entry with an `id` patches just the fields it
    // names, `remove` drops ids, and every property is optional because a bare `{}` reads
    // the current list. That is why its curated presets matter: the schema alone can only
    // describe the read.
    {
        name: 'task',
        group: 'Core tools',
        description: 'The task list for this chat.',
        tags: ['tasks', 'planning'],
        visibility: 'core',
        sessionBound: true,
        parameters: object({
            tasks: {
                type: 'array',
                items: object({
                    id: str(),
                    text: str({ maxLength: 2000 }),
                    completed: { type: 'boolean' }
                })
            },
            remove: strings(),
            offset: ints({ minimum: 0 }),
            limit: ints({ minimum: 1, maximum: 100 })
        })
    },
    { name: 'toolList', group: 'Core tools', description: 'Inventory.', tags: ['tools'], visibility: 'core', sessionBound: true, parameters: object({}) },
    {
        name: 'toolManage',
        group: 'Core tools',
        description: 'Inspect or replace one registration.',
        tags: ['tools'],
        visibility: 'core',
        sessionBound: true,
        parameters: object(
            {
                operation: {
                    type: 'string',
                    enum: ['list', 'details', 'source', 'path', 'create', 'update', 'reload']
                },
                name: str(),
                path: str(),
                folder: str(),
                persist: { type: 'string', enum: ['folder', 'runtime'], default: 'folder' },
                moduleText: str(),
                source: str(),
                description: str(),
                tags: strings(),
                parameters: { type: 'object' },
                visibility: { type: 'string', enum: ['core', 'searchable'] },
                dependencies: {
                    type: 'array',
                    items: object({ path: str(), text: str() }, ['path', 'text'])
                }
            },
            ['operation']
        )
    },
    {
        name: 'toolRegistry',
        group: 'Core tools',
        description: 'Install a tool module.',
        tags: ['tools'],
        visibility: 'core',
        sessionBound: true,
        parameters: object({
            name: str(),
            sourcePath: str(),
            moduleText: str(),
            source: str(),
            description: str(),
            tags: strings(),
            parameters: { type: 'object' },
            visibility: { type: 'string', enum: ['core', 'searchable'] },
            dependencies: { type: 'array', items: object({ path: str(), text: str() }, ['path', 'text']) }
        })
    },
    {
        name: 'toolCancel',
        group: 'Core tools',
        description: 'Cancel one tool call.',
        tags: ['tools'],
        visibility: 'core',
        sessionBound: true,
        parameters: object({ callId: str({ minLength: 1 }) }, ['callId'])
    },
    { name: 'agentManage', group: 'Core tools', description: 'Agent invocations.', tags: ['agents'], visibility: 'core', sessionBound: true, parameters: object({}) },
    {
        name: 'agentResult',
        group: 'Core tools',
        description: 'Read an agent result.',
        tags: ['agents'],
        visibility: 'core',
        sessionBound: true,
        parameters: object(
            {
                agent: str({ minLength: 1 }),
                invocationId: str({ minLength: 1 }),
                offset: ints({ minimum: 0 }),
                limit: { type: 'integer', minimum: 1, maximum: 8000 }
            },
            ['agent']
        )
    },
    { name: 'threadList', group: 'Core tools', description: 'Thread roster.', tags: ['threads'], visibility: 'core', sessionBound: true, parameters: object({}) },
    {
        name: 'threadSend',
        group: 'Core tools',
        description: 'Message a thread.',
        tags: ['threads'],
        visibility: 'core',
        sessionBound: true,
        parameters: object({ thread: str({ minLength: 1 }), message: str({ minLength: 1 }) }, ['thread', 'message'])
    },
    {
        name: 'threadFork',
        group: 'Core tools',
        description: 'Fork the conversation.',
        tags: ['threads'],
        visibility: 'core',
        sessionBound: true,
        parameters: object({ input: str({ minLength: 1 }), label: str({ minLength: 1, maxLength: 120 }) }, ['input'])
    },
    {
        name: 'profileManage',
        group: 'Core tools',
        description: 'Story profiles.',
        tags: ['story'],
        visibility: 'core',
        sessionBound: true,
        parameters: storySchema(['add', 'list', 'get', 'update', 'remove'])
    },
    {
        name: 'chapterManage',
        group: 'Core tools',
        description: 'Story chapters.',
        tags: ['story'],
        visibility: 'core',
        sessionBound: true,
        parameters: storySchema(['add', 'list', 'get', 'update', 'remove'])
    },
    {
        name: 'locationManage',
        group: 'Core tools',
        description: 'Story locations.',
        tags: ['story'],
        visibility: 'core',
        sessionBound: true,
        parameters: storySchema(['add', 'list', 'get', 'update', 'remove'])
    },
    {
        name: 'actionRequest',
        group: 'Core tools',
        description: 'Ask the owner to choose.',
        tags: ['runtime'],
        visibility: 'core',
        sessionBound: true,
        parameters: object(
            {
                question: str({ minLength: 1, maxLength: 4000 }),
                recommended: str({ minLength: 1, maxLength: 32, pattern: '^[A-Za-z0-9_-]+$' }),
                options: {
                    type: 'array',
                    minItems: 2,
                    maxItems: 8,
                    items: object(
                        {
                            id: str({ minLength: 1, maxLength: 32, pattern: '^[A-Za-z0-9_-]+$' }),
                            label: str({ minLength: 1, maxLength: 120 }),
                            description: str({ maxLength: 500 })
                        },
                        ['id', 'label']
                    )
                }
            },
            ['question', 'recommended', 'options']
        )
    },
    { name: 'gitDiff', group: 'Command', description: 'Git diff.', tags: ['git'], visibility: 'searchable', parameters: object({ ref: str(), staged: { type: 'boolean' }, paths: { oneOf: [str({ minLength: 1 }), { type: 'array', items: str(), minItems: 1 }] }, cwd: str() }) },
    { name: 'fetch', group: 'Web', description: 'Fetch a URL.', tags: ['web'], visibility: 'searchable', parameters: object({ url: str() }, ['url'], true) },
    { name: 'download', group: 'Web', description: 'Download a file.', tags: ['web'], visibility: 'searchable', parameters: object({ url: str(), name: str() }, ['url']) }
];

// The exact preset buttons each tool must offer. Pinned label-by-label: the button text is
// the documentation of what gets filled. The trailing entry on most tools is the
// schema-derived fallback (named by the shape it produces); it is deduplicated when a
// curated preset already carries that identical value (toolList, toolManage, agentManage,
// threadList, gitDiff), which is why those lists are shorter.
const EXPECTED_PRESETS: Record<string, readonly string[]> = {
    // The `{}` read is BOTH the curated first payload and the schema-derived fallback,
    // so it is offered once (the dedupe below), and the four buttons are the whole set.
    task: ['Current tasks', 'Add a task', 'Complete a task (edit id)', 'Remove a task (edit id)'],
    toolList: ['Full inventory'],
    toolManage: ['List registered', 'Details for read', 'Source of read'],
    toolRegistry: ['Install shoutText (body)', 'Empty call'],
    toolCancel: ['Cancel a call (edit id)', 'Only callId'],
    agentManage: ['Recent invocations'],
    threadList: ['Thread roster'],
    threadSend: ['Send to thread (edit id)', 'Required thread + message'],
    threadFork: ['Fork an alternate take', 'Required input'],
    profileManage: ['List profiles', 'Add a profile', 'Get by id (edit id)', 'Required action'],
    chapterManage: ['List chapters', 'Add a draft chapter', 'Get by id (edit id)', 'Required action'],
    locationManage: ['List locations', 'Add a location', 'Get by id (edit id)', 'Required action'],
    actionRequest: ['Ask which path to take', 'Required fields'],
    gitDiff: ['Working tree', 'Against HEAD~1', 'Staged index', 'Only src, against main'],
    fetch: ['Fetch example.com', 'Only url'],
    download: ['Save a named file', 'Required url']
};

const schemaFor = (name: string): Record<string, unknown> => {
    const entry = TOOLS.find((tool) => tool.name === name);
    if (entry === undefined) throw new Error(`missing fixture tool ${name}`);
    return entry.parameters as Record<string, unknown>;
};

// The single-property rule, mirrored from the runner: a schema with exactly ONE property
// means the box (and therefore the wire payload) holds that property's VALUE, not a wrapper
// object. `fetch` is the case this catches — its preset is a bare URL string.
const effectiveSchema = (schema: Record<string, unknown>): Record<string, unknown> => {
    if (schema.type !== 'object') return schema;
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const keys = Object.keys(properties);

    return keys.length === 1 ? properties[keys[0]] : schema;
};

// A deliberately small schema checker: it validates the preset payload against exactly the
// constraints the real tool declares (required, unknown-property rejection, enum, bounds,
// pattern, array items/min/max, oneOf) and returns every problem it found, so a failure
// names the property instead of just "invalid".
const validate = (value: unknown, schema: Record<string, unknown>, path = '$'): string[] => {
    const problems: string[] = [];

    if (schema.oneOf !== undefined) {
        const branches = schema.oneOf as Record<string, unknown>[];
        const matched = branches.some((branch) => validate(value, branch, path).length === 0);
        if (!matched) problems.push(`${path}: matches none of oneOf`);
        return problems;
    }

    if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) {
        problems.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
    }

    switch (schema.type) {
        case 'object': {
            if (value === null || typeof value !== 'object' || Array.isArray(value)) {
                problems.push(`${path}: expected an object`);
                break;
            }
            const record = value as Record<string, unknown>;
            const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;

            for (const required of (schema.required as string[] | undefined) ?? []) {
                if (!(required in record)) problems.push(`${path}.${required}: required property missing`);
            }
            if (schema.additionalProperties === false) {
                for (const key of Object.keys(record)) {
                    if (!(key in properties)) problems.push(`${path}.${key}: unknown property`);
                }
            }
            for (const [key, child] of Object.entries(properties)) {
                if (key in record) problems.push(...validate(record[key], child, `${path}.${key}`));
            }
            break;
        }
        case 'array': {
            if (!Array.isArray(value)) {
                problems.push(`${path}: expected an array`);
                break;
            }
            if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
                problems.push(`${path}: fewer than minItems ${schema.minItems}`);
            }
            if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
                problems.push(`${path}: more than maxItems ${schema.maxItems}`);
            }
            if (schema.items !== undefined) {
                value.forEach((item, index) => problems.push(...validate(item, schema.items as Record<string, unknown>, `${path}[${index}]`)));
            }
            break;
        }
        case 'string': {
            if (typeof value !== 'string') {
                problems.push(`${path}: expected a string`);
                break;
            }
            if (typeof schema.minLength === 'number' && value.length < schema.minLength) problems.push(`${path}: shorter than minLength`);
            if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) problems.push(`${path}: longer than maxLength`);
            if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) problems.push(`${path}: does not match ${schema.pattern}`);
            break;
        }
        case 'integer':
        case 'number': {
            if (typeof value !== 'number' || Number.isNaN(value)) {
                problems.push(`${path}: expected a number`);
                break;
            }
            if (typeof schema.minimum === 'number' && value < schema.minimum) problems.push(`${path}: below minimum`);
            if (typeof schema.maximum === 'number' && value > schema.maximum) problems.push(`${path}: above maximum`);
            break;
        }
        case 'boolean': {
            if (typeof value !== 'boolean') problems.push(`${path}: expected a boolean`);
            break;
        }
        default:
            break;
    }

    return problems;
};

// Every string value in a payload, flattened, so the placeholder rule can be checked
// exactly rather than by eyeballing one example.
const stringValues = (value: unknown): string[] => {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.flatMap(stringValues);
    if (value !== null && typeof value === 'object') return Object.values(value).flatMap(stringValues);
    return [];
};

const descriptor = (overrides: Partial<HarnessDescriptor> = {}): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: 'A general instruction-following agent.',
        requiresEndpoint: true,
        agents: ['instruct', 'research', 'workspace'],
        tools: [],
        coreTools: [],
        primary: 'instruct',
        subagents: ['research', 'workspace'],
        builtin: true,
        editable: true,
        ...overrides
    }) as HarnessDescriptor;

const snapshot = (): SessionSnapshot =>
    ({
        id: 's1',
        harness: 'instruct',
        status: 'idle',
        model: 'm1',
        createdAt: 1,
        updatedAt: 2,
        messages: [],
        turns: []
    }) as SessionSnapshot;

type Call = { url: string; method: string | undefined; body: unknown };

const boot = async (subagents: readonly string[] = ['research', 'workspace']): Promise<Call[]> => {
    const calls: Call[] = [];

    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const body = init?.body === undefined || init.body === null ? undefined : JSON.parse(String(init.body));
            calls.push({ url, method: init?.method, body });

            if (url === '/api') {
                return json({
                    rootPath: '/api',
                    presets: [descriptor({ subagents: [...subagents] })],
                    tools: TOOLS,
                    defaults: { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false },
                    sessions: [],
                    agents: []
                });
            }
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions' && init?.method === 'POST') return json({ session: snapshot() }, 201);
            if (url.startsWith('/api/sessions/') && method_is_get(url, init)) return json({ session: snapshot() });
            if (url.match(/^\/api\/tools\/.+$/) && init?.method === 'POST') {
                return json({ ok: true, result: { ok: true }, durationMs: 3 });
            }

            throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
        }, { root: '/api' }))
    );

    await import('./main');
    await flush();
    await flush();

    const toggle = document.querySelector<HTMLButtonElement>('.tools-toggle');
    if (toggle === null) throw new Error('missing tools toggle');
    toggle.click();
    await flush();

    return calls;
};

const method_is_get = (url: string, init?: RequestInit): boolean =>
    url !== '/api/sessions' && (init?.method === undefined || init.method === 'GET');

// Open one tool's runner and return its preset buttons, in document order.
const presetsFor = async (name: string): Promise<HTMLButtonElement[]> => {
    const entry = document.querySelector<HTMLButtonElement>(`.tool-tab-button[data-tool="${name}"]`);
    if (entry === null) throw new Error(`missing tool entry ${name}`);
    entry.click();
    await flush();

    return [...document.querySelectorAll<HTMLButtonElement>('.tool-card .tool-preset')];
};

// Pressing a preset is the only way to read its payload: the button carries the LABEL, and
// the payload is what lands in the fully editable box.
const payloadOf = (button: HTMLButtonElement): unknown => {
    button.click();
    const args = document.querySelector<HTMLTextAreaElement>('.tool-card .tool-args');
    if (args === null) throw new Error('missing arguments box');

    return JSON.parse(args.value);
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
});

it('offers named presets for every runtime, story, git and web tool', async () => {
    await boot();

    for (const [name, labels] of Object.entries(EXPECTED_PRESETS)) {
        const buttons = await presetsFor(name);

        // Exact label list: the button text is the documentation of what gets filled.
        expect(buttons.map((button) => button.textContent)).toEqual([...labels]);
    }
});

// A generated (schema-derived) fallback button is named by its shape: `Only <prop>`,
// `Required …`, or `Empty call`. Those payloads are the accepted schema skeleton that
// tool-template.test.ts pins separately (a required string with no `default` legitimately
// starts empty), so the strict payload check below covers the CURATED presets, which are
// the ones this correction is about.
const GENERATED_FALLBACK = /^(Only |Required )|^Empty call$/;

it('fills payloads that satisfy each tool real schema, not a blank skeleton', async () => {
    await boot();

    for (const name of Object.keys(EXPECTED_PRESETS)) {
        const buttons = await presetsFor(name);
        const problems: string[] = [];

        for (const button of buttons) {
            if (GENERATED_FALLBACK.test(button.textContent ?? '')) continue;

            problems.push(
                ...validate(payloadOf(button), effectiveSchema(schemaFor(name)), `${name}/${button.textContent}`)
            );
        }

        // A preset the server would reject is the bug this test exists for.
        expect(problems).toEqual([]);
    }

    // `task` (R9-R11) merge shapes, spelled out exactly: a read names nothing, an add
    // carries the `text` a new entry needs, a patch names only the id it changes plus the
    // flag, and a removal is an id list under `remove`.
    const tasks = await presetsFor('task');
    expect(payloadOf(tasks[0])).toEqual({});
    expect(payloadOf(tasks[1])).toEqual({ tasks: [{ text: 'Review the change' }] });
    expect(payloadOf(tasks[2])).toEqual({ tasks: [{ id: '<id from the list above>', completed: true }] });
    expect(payloadOf(tasks[3])).toEqual({ remove: ['<id from the list above>'] });

    // The specific regressions this correction targets, spelled out: the runtime and
    // command tools no longer start from a payload their own schema refuses.
    const profiles = await presetsFor('profileManage');
    expect(payloadOf(profiles[1])).toEqual({
        action: 'add',
        name: 'Iris',
        description: 'A cautious planner who asks before acting.',
        traits: ['brave', 'loyal']
    });

    const cancelled = await presetsFor('toolCancel');
    expect(payloadOf(cancelled[0])).toBe('<callId from a running tool call>');

    const diff = await presetsFor('gitDiff');
    expect(payloadOf(diff[1])).toEqual({ ref: 'HEAD~1' });
    expect(payloadOf(diff[3])).toEqual({ ref: 'main', paths: ['src'] });

    // One-property tools hold the VALUE, so the preset is a bare URL, not a wrapper object.
    const fetched = await presetsFor('fetch');
    expect(payloadOf(fetched[0])).toBe('https://example.com');

    // actionRequest's `recommended` must name one of its own option ids, so the preset is
    // one self-consistent request rather than three independent fields.
    const asked = await presetsFor('actionRequest');
    const question = payloadOf(asked[0]) as { recommended: string; options: { id: string }[] };
    expect(question.options.map((option) => option.id)).toContain(question.recommended);
});

it('marks every runtime-id preset as an edit, and never invents a real-looking id', async () => {
    await boot();

    for (const name of Object.keys(EXPECTED_PRESETS)) {
        for (const button of await presetsFor(name)) {
            const placeholders = stringValues(payloadOf(button)).filter((value) => value.startsWith('<'));

            for (const placeholder of placeholders) {
                // A placeholder is only honest if the button says it must be edited.
                expect(button.textContent).toContain('(edit');
                expect(placeholder.length > 2).toBe(true);
            }
        }
    }

    // `agentResult` is the dynamic case: its targets come from the playground harness, so
    // a real subagent gets a ready-to-run preset and the unknown-agent shape stays a
    // labelled placeholder.
    const withAgents = await presetsFor('agentResult');
    expect(withAgents.map((button) => button.textContent)).toEqual([
        'Read research',
        'Read workspace',
        'Page a result (edit ids)'
    ]);
    expect(payloadOf(withAgents[0])).toEqual({ agent: 'research' });
});

it('builds dynamic presets from the playground harness roster only', async () => {
    // A harness with NO subagents: `agentResult` has no valid target, so only the clearly
    // marked placeholder shape is offered (never `research`, which this harness lacks).
    await boot([]);

    const buttons = await presetsFor('agentResult');
    expect(buttons.map((button) => button.textContent)).toEqual(['Page a result (edit ids)']);
    expect(payloadOf(buttons[0])).toEqual({ agent: '<agent from agentManage>', offset: 0, limit: 2000 });

    expect(validate(payloadOf(buttons[0]), effectiveSchema(schemaFor('agentResult')), '$')).toEqual([]);
});

it('sends the edited preset verbatim, with the playground session id', async () => {
    const calls = await boot();

    const buttons = await presetsFor('profileManage');
    // Pressing a preset fills the box and calls nothing.
    buttons[2].click();
    expect(document.querySelector<HTMLTextAreaElement>('.tool-args')?.value).toBe(
        '{\n  "action": "get",\n  "id": "<id from add>"\n}'
    );
    expect(buttons[2].getAttribute('aria-pressed')).toBe('true');

    // The reader edits the placeholder into a real id; THAT text is the request.
    const args = document.querySelector<HTMLTextAreaElement>('.tool-args');
    if (args === null) throw new Error('missing arguments box');
    args.value = '{ "action" : "get",  "id" : "p-7" }';
    document.querySelector<HTMLButtonElement>('.tool-card button.primary')?.click();
    await flush();
    await flush();

    expect(calls.find((call) => call.url === '/api/tools/profileManage')).toEqual({
        url: '/api/tools/profileManage',
        method: 'POST',
        body: { parameters: { action: 'get', id: 'p-7' }, sessionId: 's1' }
    });

    // The response pane shows the answer JSON, so what is on screen is what the server said.
    expect(JSON.parse(document.querySelector('.tool-output .card-body')?.textContent ?? '')).toEqual({
        ok: true,
        result: { ok: true },
        durationMs: 3
    });
});

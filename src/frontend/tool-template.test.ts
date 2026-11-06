// The Tools tab's automatic argument template (T16).
//
// WHY THIS FILE EXISTS
// --------------------
// The manual runner pre-fills the arguments box from a curated example (EXAMPLES in
// main.ts) or, when there is none, from the tool's JSON Schema. The schema-derived
// path used to fill every property with a type-shaped blank, which produced inputs
// no tool would accept:
//
//   toolRequest -> { "tags": [], "limit": 0 }      (empty tags, 0 below the minimum)
//   glob        -> { "patterns": [], "paths": [], "maxResults": 0 }
//
// A pre-filled INVALID input is worse than an empty box: it looks like guidance.
// The rule now is:
//   - a curated example wins when one exists (toolRequest, syntax, glob, grep,
//     the batched file tools);
//   - otherwise only `required` properties are materialized, each taking the
//     schema's `default`, then the first `enum` member, then a type-shaped value —
//     so an optional `limit`/`maxResults` is simply ABSENT and the tool applies its
//     documented default.
//
// The fixtures below carry the CURRENT wire names and schemas: the rename made the
// file tools `read` / `write` / `edit` / `files` / `glob` / `grep`, split the old
// two-mode `fileGlob` (its `content` property is gone — a request that still sends
// it is rejected), and turned `syntaxCheck` into `syntax` with a free-text
// `language` (no enum: the tool normalizes aliases and errors on a language it has
// no parser for).
//
// Nothing runs on selection: the box stays editable and the only request this file
// makes is the boot document (asserted).

import type { ToolDescriptor } from '../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { viewAwareFetch } from './view-test-support';

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
};

const coreTool = (name: string, parameters: Record<string, unknown>): ToolDescriptor => ({
    name,
    group: 'Core tools',
    description: `${name} core tool`,
    tags: ['core', 'harness'],
    visibility: 'core',
    parameters,
    sessionBound: true
});

const catalogueTool = (name: string, parameters: Record<string, unknown>): ToolDescriptor => ({
    name,
    group: 'Package presets',
    description: `${name} package tool`,
    tags: ['files', 'read'],
    visibility: 'searchable',
    parameters
});

// The real toolRequest schema (src/core/metadata.ts): `tags` required, `limit`
// optional with a 1..5 range. The bug produced `{ tags: [], limit: 0 }`.
const TOOL_REQUEST = coreTool('toolRequest', {
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
            description: 'How many matches to enable: 1-5.'
        }
    },
    required: ['tags'],
    additionalProperties: false
});

// The real syntax schema (src/tools/syntax/syntax.tool.ts): two required properties
// and NO `enum` on `language` — it is a free-text name, so the schema alone can only
// produce an empty string and the curated example is what makes the call valid.
const SYNTAX = catalogueTool('syntax', {
    type: 'object',
    properties: {
        code: { type: 'string', description: 'Source code to check.' },
        language: {
            type: 'string',
            minLength: 1,
            description: 'Language to parse the snippet as.'
        }
    },
    required: ['code', 'language'],
    additionalProperties: false
});

// The real glob schema (src/tools/files/glob.tool.ts): three properties, every one
// optional, and NO `content` — the old `fileGlob` content mode is the `grep` tool
// now, and a request that still sends `content` is rejected. The bug produced empty
// `patterns`/`paths` and `maxResults: 0`.
const GLOB = catalogueTool('glob', {
    type: 'object',
    properties: {
        patterns: { type: 'array', items: { type: 'string' }, description: 'Glob patterns.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Root directories to walk.' },
        maxResults: { type: 'number', description: 'Maximum files to return. Defaults to 100.' }
    },
    additionalProperties: false
});

// The real grep schema (src/tools/files/grep.tool.ts): `pattern` is the one required
// property, so WITHOUT the curated example the box would be `{"pattern": ""}` — an
// empty regex source the tool rejects. This pins that a curated example beats the
// required-only template even when the schema is technically satisfiable.
const GREP = catalogueTool('grep', {
    type: 'object',
    properties: {
        pattern: { type: 'string', minLength: 1, description: 'Regular-expression source.' },
        patterns: { type: 'array', items: { type: 'string' }, description: 'Glob filter for files to read.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Root directories to walk.' },
        maxResults: { type: 'number', description: 'Maximum matching lines. Defaults to 100.' }
    },
    required: ['pattern'],
    additionalProperties: false
});

// A schema with NO curated example, to pin the generic template rule: only required
// properties appear, an enum contributes its first member, and optional fields
// (`text`, `id`, `completed`) are omitted rather than blanked.
const WIDGET_MANAGE = catalogueTool('widgetManage', {
    type: 'object',
    properties: {
        action: {
            type: 'string',
            enum: ['add', 'remove', 'list'],
            description: 'One of: add, remove, list.'
        },
        text: { type: 'string', description: 'Text for "add".' },
        id: { type: 'string', description: 'Widget id.' },
        completed: { type: 'boolean', description: 'Flag.' }
    },
    required: ['action'],
    additionalProperties: false
});

// The real `task` metadata (R9-R11: the old `todoManage`), which DOES have curated
// presets. The schema is a MERGE command, not an action enum: every property is
// optional, so the schema alone can only offer `{}` (the documented read), and the
// merge shapes the presets carry — an added entry with `text`, a patched entry with
// `id` + `completed`, a `remove` id list — are what the curated presets contribute.
const TASK = coreTool('task', {
    type: 'object',
    properties: {
        tasks: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'Existing task id to patch.' },
                    text: { type: 'string', description: 'Text for a task with no id.' },
                    completed: { type: 'boolean', description: 'Completion flag.' }
                },
                additionalProperties: false
            },
            description: 'Tasks to add (no id) or patch (with id).'
        },
        remove: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ids of tasks to remove.'
        },
        offset: { type: 'integer', minimum: 0, description: 'First index to return.' },
        limit: { type: 'integer', minimum: 1, description: 'How many tasks to return.' }
    },
    additionalProperties: false
});

// A schema whose required string carries an explicit default, plus a required number
// with a minimum: both must be honored instead of a blank / 0. Named so that no
// curated example applies (EXAMPLES is keyed by tool name).
const CUSTOM_DEFAULTS = catalogueTool('meterRead', {
    type: 'object',
    properties: {
        query: { type: 'string', default: 'tool loop', description: 'Words to look for.' },
        limit: { type: 'number', minimum: 3, description: 'How many results.' }
    },
    required: ['query', 'limit'],
    additionalProperties: false
});

const descriptor = {
    name: 'instruct',
    title: 'Instruct',
    description: 'A general instruction-following agent.',
    requiresEndpoint: false,
    agents: ['instruct'],
    tools: ['glob'],
    coreTools: ['toolRequest', 'task'],
    primary: 'instruct',
    subagents: [],
    builtin: true,
    editable: true
};

const TOOLS: readonly ToolDescriptor[] = [
    TOOL_REQUEST,
    TASK,
    WIDGET_MANAGE,
    SYNTAX,
    GLOB,
    GREP,
    CUSTOM_DEFAULTS
];

type Call = { url: string; method: string | undefined };

const calls: Call[] = [];

beforeEach(() => {
    calls.length = 0;
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';

    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            calls.push({ url, method: init?.method });

            if (url === '/api') {
                return json({
                    rootPath: '/api',
                    presets: [descriptor],
                    tools: TOOLS,
                    defaults: { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false },
                    sessions: [],
                    agents: []
                });
            }

            if (url === '/api/models') return json({ models: ['m1'] });

            throw new Error(`unexpected request: ${init?.method ?? 'GET'} ${url}`);
        }, { root: '/api' }))
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const toolMounted = async (): Promise<void> => {
    await import('./main');
    await flush();
    await flush();

    // R3: the global topbar toggle opens the tools view; there is no tab strip.
    const toolsToggle = document.querySelector<HTMLButtonElement>('.tools-toggle');
    if (toolsToggle === null) throw new Error('missing global Tools toggle');
    toolsToggle.click();
    await flush();
};

const argsFor = async (name: string): Promise<string> => {
    const button = document.querySelector<HTMLButtonElement>(`.tool-tab-button[data-tool="${name}"]`);
    if (button === null) throw new Error(`missing tool tab button for ${name}`);
    button.click();
    await flush();

    const box = document.querySelector<HTMLTextAreaElement>('.tool-card .tool-args');
    if (box === null) throw new Error('missing arguments box');

    return box.value;
};

// Presses one named preset button in the runner that `argsFor` just opened and returns
// the box text. A preset fill is the other half of the template contract: the button is
// the only place a payload the schema cannot describe reaches the wire.
const pressPreset = async (label: string): Promise<string> => {
    const button = document.querySelector<HTMLButtonElement>(`.tool-preset[data-preset="${label}"]`);
    if (button === null) throw new Error(`missing preset button: ${label}`);
    button.click();
    await flush();

    const box = document.querySelector<HTMLTextAreaElement>('.tool-card .tool-args');
    if (box === null) throw new Error('missing arguments box');

    return box.value;
};

it('pre-fills every tool with an argument set that satisfies its schema', async () => {
    await toolMounted();

    // toolRequest: non-empty tags, and the OPTIONAL limit is absent — an absent
    // limit means the documented default (5), while `0` was below the minimum.
    const request = await argsFor('toolRequest');
    expect(JSON.parse(request)).toEqual({ tags: ['files', 'read'] });
    expect(request).not.toContain('limit');

    // syntax: a real snippet and a language the tool actually parses. The schema
    // alone could only offer `language: ""`, so this is the curated example winning.
    const syntax = await argsFor('syntax');
    expect(JSON.parse(syntax)).toEqual({
        code: 'const answer = 42;\nconsole.log(answer);',
        language: 'javascript'
    });

    // glob: the documented pattern/root defaults, and no `maxResults` (an absent one
    // means the documented cap, while 0 would have been clamped). There is no
    // `content` property in this schema any more, so the box cannot invent one.
    const glob = await argsFor('glob');
    expect(JSON.parse(glob)).toEqual({ patterns: ['**/*'], paths: ['.'] });
    expect(glob).not.toContain('content');
    expect(glob).not.toContain('maxResults');

    // grep: the required `pattern` gets a regex source that parses, not the empty
    // string the required-only template would produce.
    const grep = await argsFor('grep');
    expect(JSON.parse(grep)).toEqual({ pattern: 'TODO|FIXME', patterns: ['*.ts'], paths: ['.'] });

    // `task` (the old todoManage) has NO required property, so the schema alone can only
    // offer the documented read: the curated first preset `{}` and the schema fallback are
    // the same value, and the runner dedupes that pair into one button.
    const task = await argsFor('task');
    expect(JSON.parse(task)).toEqual({});
    expect(document.querySelectorAll('.tool-preset')).toHaveLength(4);
    expect(
        [...document.querySelectorAll<HTMLButtonElement>('.tool-preset')].map((button) => button.textContent)
    ).toEqual(['Current tasks', 'Add a task', 'Complete a task (edit id)', 'Remove a task (edit id)']);

    // The curated merge payloads are the part the schema could never generate: an added
    // entry carries the `text` an add needs, a patched entry names only `id` +
    // `completed`, and a removal is an id list under `remove`.
    expect(JSON.parse(await pressPreset('Add a task'))).toEqual({
        tasks: [{ text: 'Review the change' }]
    });
    expect(JSON.parse(await pressPreset('Complete a task (edit id)'))).toEqual({
        tasks: [{ id: '<id from the list above>', completed: true }]
    });
    expect(JSON.parse(await pressPreset('Remove a task (edit id)'))).toEqual({
        remove: ['<id from the list above>']
    });

    // A schema with no example: ONLY the required property, taking enum[0], so the
    // action is a real one instead of "" and optional fields are absent.
    const widget = await argsFor('widgetManage');
    expect(JSON.parse(widget)).toEqual({ action: 'add' });

    // `default` and `minimum` are honored for a required property.
    const defaults = await argsFor('meterRead');
    expect(JSON.parse(defaults)).toEqual({ query: 'tool loop', limit: 3 });
});

it('leaves the arguments editable and executes nothing on selection', async () => {
    await toolMounted();

    await argsFor('glob');

    const box = document.querySelector<HTMLTextAreaElement>('.tool-card .tool-args');
    expect(box?.readOnly).toBe(false);
    expect(box?.disabled).toBe(false);

    // The full formatted example is what the user reads; pin one string so the
    // 2-space JSON formatting is part of the contract too.
    expect((await argsFor('toolRequest')).split('\n')).toEqual([
        '{',
        '  "tags": [',
        '    "files",',
        '    "read"',
        '  ]',
        '}'
    ]);

    // No tool call was made: the runner spent its ONE identified schema read (`GET
    // /v1/harness/tools/{id}` — the route that carries `parameters`, ../shared/harness-api.ts:654)
    // and nothing else. T5 R1: the catalogue embeds no conversations, so boot also reads the
    // compact directory index, which the double answers from this test's raw `/sessions` route.
    // What this assertion pins is that SELECTING a tool executes nothing.
    expect(calls.filter((call) => call.url.startsWith('/api/tools/') && call.method === 'POST')).toEqual([]);
    expect(calls.some((call) => call.url.includes('/executions'))).toBe(false);
});

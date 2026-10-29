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
//   fileGlob    -> { "patterns": [], "paths": [], "content": "", "maxResults": 0 }
//
// A pre-filled INVALID input is worse than an empty box: it looks like guidance.
// The rule now is:
//   - a curated example wins when one exists (toolRequest, syntaxCheck, fileGlob,
//     the batched file tools);
//   - otherwise only `required` properties are materialized, each taking the
//     schema's `default`, then the first `enum` member, then a type-shaped value —
//     so an optional `limit`/`content` is simply ABSENT and the tool applies its
//     documented default.
//
// Nothing runs on selection: the box stays editable and the only request this file
// makes is the boot document (asserted).

import type { ToolDescriptor } from '../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

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

// The real syntaxCheck schema: two required properties, with a language enum.
const SYNTAX_CHECK = catalogueTool('syntaxCheck', {
    type: 'object',
    properties: {
        code: { type: 'string', description: 'Source code to check.' },
        language: {
            type: 'string',
            enum: ['javascript', 'python'],
            description: 'Language to parse the snippet as.'
        }
    },
    required: ['code', 'language'],
    additionalProperties: false
});

// The real fileGlob schema: four properties, every one optional. The bug produced
// empty `patterns`/`paths`, `content: ""` and `maxResults: 0`.
const FILE_GLOB = catalogueTool('fileGlob', {
    type: 'object',
    properties: {
        patterns: { type: 'array', items: { type: 'string' }, description: 'Glob patterns.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Root directories to walk.' },
        content: { type: 'string', description: 'Regular expression to match inside each file.' },
        maxResults: { type: 'number', description: 'Maximum results. Defaults to 100.' }
    },
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

// The real todoManage metadata, which DOES have a curated example: the example must
// win over the generic template (it adds the `text` that "add" requires).
const TODO_MANAGE = coreTool('todoManage', {
    type: 'object',
    properties: {
        action: {
            type: 'string',
            enum: ['add', 'remove', 'check', 'uncheck', 'list'],
            description: 'One of: add, remove, check, uncheck, list.'
        },
        text: { type: 'string', description: 'Todo text for "add".' },
        id: { type: 'string', description: 'Todo id.' },
        completed: { type: 'boolean', description: 'For "check" only.' }
    },
    required: ['action'],
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
    tools: ['fileGlob'],
    coreTools: ['toolRequest', 'todoManage'],
    primary: 'instruct',
    subagents: [],
    builtin: true,
    editable: true
};

const TOOLS: readonly ToolDescriptor[] = [
    TOOL_REQUEST,
    TODO_MANAGE,
    WIDGET_MANAGE,
    SYNTAX_CHECK,
    FILE_GLOB,
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
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
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
        })
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const toolMounted = async (): Promise<void> => {
    await import('./main');
    await flush();
    await flush();

    const toolsTab = [...document.querySelectorAll<HTMLButtonElement>('.tab')].find(
        (candidate) => candidate.textContent === 'Tools'
    );
    if (toolsTab === undefined) throw new Error('missing Tools tab');
    toolsTab.click();
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

it('pre-fills every tool with an argument set that satisfies its schema', async () => {
    await toolMounted();

    // toolRequest: non-empty tags, and the OPTIONAL limit is absent — an absent
    // limit means the documented default (5), while `0` was below the minimum.
    const request = await argsFor('toolRequest');
    expect(JSON.parse(request)).toEqual({ tags: ['files', 'read'] });
    expect(request).not.toContain('limit');

    // syntaxCheck: a real snippet and a valid language member.
    const syntax = await argsFor('syntaxCheck');
    expect(JSON.parse(syntax)).toEqual({
        code: 'const answer = 42;\nconsole.log(answer);',
        language: 'javascript'
    });

    // fileGlob: the documented pattern/root defaults, and neither the optional
    // `content` (which would switch to content mode) nor `maxResults` (which would
    // have been clamped from 0).
    const glob = await argsFor('fileGlob');
    expect(JSON.parse(glob)).toEqual({ patterns: ['**/*'], paths: ['.'] });
    expect(glob).not.toContain('content');
    expect(glob).not.toContain('maxResults');

    // The curated todoManage example is used verbatim: it carries the `text` that
    // the "add" action requires, which the schema alone cannot know.
    const todo = await argsFor('todoManage');
    expect(JSON.parse(todo)).toEqual({ action: 'add', text: 'Review the harness catalogue' });

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

    await argsFor('fileGlob');

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

    // No tool call was made: only the boot document and the model catalogue.
    expect(calls.map((call) => call.url)).toEqual(['/api', '/api/models']);
    expect(calls.some((call) => call.url.startsWith('/api/tools/'))).toBe(false);
});

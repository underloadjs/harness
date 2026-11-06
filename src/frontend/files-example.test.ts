// The frontend's `files` example (T12).
//
// `files` declares ONE array property (`ops`), so the direct-call runner has to hand the
// textarea the array itself — not a `{ "ops": [...] }` wrapper — because the
// single-property rule makes `parameters` BE the `ops` value. This file pins both
// halves: the example that is shown, and the body that is sent. That is the same role
// the old `fileList` example pinned; the difference is the array now holds OPERATIONS
// (`{ op: 'list', path: '.' }`) rather than bare directories, and the answer is a
// receipt envelope instead of one flat listing.
//
// The stub server mirrors the real shape: `parameters` is the array, and the result is
// the `list` receipt the implementation returns.

import type { ToolDescriptor } from '../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { viewAwareFetch } from './view-test-support';

const filesTool: ToolDescriptor = {
    name: 'files',
    group: 'Package presets',
    description: 'Manage files and folders: list, move, copy, delete, and mkdir in ONE call.',
    tags: ['files', 'list', 'filesystem', 'folder', 'directory', 'move', 'rename', 'copy', 'delete', 'remove', 'mkdir'],
    visibility: 'searchable',
    parameters: {
        type: 'object',
        properties: {
            ops: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        op: {
                            type: 'string',
                            enum: ['list', 'move', 'copy', 'delete', 'mkdir'],
                            description: 'The operation this entry performs.'
                        },
                        path: {
                            oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
                            description: 'The directory or path this operation acts on.'
                        }
                    },
                    required: ['op'],
                    additionalProperties: false
                }
            }
        },
        required: ['ops'],
        additionalProperties: false
    }
};

type Call = { url: string; method: string | undefined; body: unknown };

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
};

const byClass = <K extends keyof HTMLElementTagNameMap>(selector: string, tag: K): HTMLElementTagNameMap[K] => {
    const found = document.querySelector<HTMLElementTagNameMap[K]>(selector);
    if (found === null) throw new Error(`missing element ${selector}`);
    return found;
};

// R3: the tools view is opened from the global topbar toggle (no tab strip).
const openTools = (): void => {
    const found = document.querySelector<HTMLButtonElement>('.tools-toggle');
    if (found === null) throw new Error('missing global Tools toggle');
    if (found.getAttribute('aria-pressed') !== 'true') found.click();
};
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
            const method = init?.method;
            const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
            calls.push({ url, method, body });

            if (url === '/api') {
                return json({
                    rootPath: '/api',
                    // A preset is required for the app to finish booting (an empty
                    // list is the "no harnesses" offline path).
                    presets: [
                        {
                            name: 'instruct',
                            title: 'Instruct',
                            description: 'A general instruction-following agent.',
                            requiresEndpoint: false,
                            agents: ['instruct'],
                            tools: ['files'],
                            coreTools: ['toolRequest', 'toolCreate', 'task'],
                            primary: 'instruct',
                            subagents: [],
                            builtin: true,
                            editable: true
                        }
                    ],
                    tools: [filesTool],
                    defaults: { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false },
                    sessions: [],
                    agents: []
                });
            }

            if (url === '/api/models') return json({ models: ['m1'] });

            // T17: an argument schema exists only on the identified tool read
            // (`GET /v1/harness/tools/{id}` → `ToolDetail`, ../shared/harness-api.ts:654;
            // the catalogue PAGE row `ToolSummary` deliberately carries none). The adapter
            // routes that read to this raw twin. The body is the same fixture entry plus
            // the `execution` scope and `session_bound` the contract requires — nothing the
            // fixture does not already state.
            if (url === '/api/tools/files' && method === undefined) {
                return json({
                    tool: { ...filesTool, session_bound: false, execution: { scope: 'global', manual: true } }
                });
            }

            if (url === '/api/tools/files' && method === 'POST') {
                return json({
                    ok: true,
                    result: {
                        results: [
                            {
                                op: 'list',
                                path: '.',
                                entries: ['src/a.ts', 'src/nested/', 'task/b.ts'],
                                truncated: false,
                                nextOffset: null,
                                offset: 0,
                                limit: 200,
                                bytes: 45
                            }
                        ],
                        bytes: 45,
                        contentBudget: 65536
                    },
                    durationMs: 3
                });
            }

            // T45: the shell dials the canonical control plane (service document, global
            // config, one page per catalogue) and `POST /tools/{id}/executions`; the
            // `viewAwareFetch` adapter above re-acts those from the routes declared here,
            // rewriting the execution call back to its `/api/tools/files` twin so the
            // recorded `calls` log keeps the path this test asserts on.
            throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);
        }, { root: '/api' }))
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
});

it('offers the ops array as the example and sends it unwrapped', async () => {
    await import('./main');
    await flush();
    await flush();

    openTools();
    await flush();

    document.querySelector<HTMLButtonElement>('.tool-tab-button[data-tool="files"]')?.click();
    await flush();

    // The example is the OPERATIONS array itself:
    // JSON.stringify([{ op: 'list', path: '.' }], null, 2).
    expect(byClass('.tool-args', 'textarea').value).toBe('[\n  {\n    "op": "list",\n    "path": "."\n  }\n]');
    // The rule line names the single property, which is what makes the array the
    // whole argument. Scoped to the runner card: the agent panel uses the same
    // `field-hint` class for unrelated guidance.
    expect(document.querySelector('.tool-card .field-hint')?.textContent).toBe(
        'Single-property rule: execute receives the value of "ops", so this textarea holds that value (JSON), not a wrapper object.'
    );

    document.querySelector<HTMLButtonElement>('.tool-card button.primary')?.click();
    await flush();
    await flush();

    // Unwrapped on the wire, exactly like the harness and the server expect. `method: 'POST'` is
    // the execution (`POST /v1/harness/tools/{id}/executions`): opening the tool also spends one
    // identified schema read on the same path (`GET`, ../shared/harness-api.ts:654).
    expect(calls.find((call) => call.url === '/api/tools/files' && call.method === 'POST')).toEqual({
        url: '/api/tools/files',
        method: 'POST',
        body: { parameters: [{ op: 'list', path: '.' }] }
    });

    // The receipt envelope is rendered verbatim, page and all.
    const output = document.querySelector('.tool-output .card-body')?.textContent ?? '';
    expect(output).toContain('"src/a.ts"');
    expect(output).toContain('"src/nested/"');
    expect(output).toContain('"task/b.ts"');
    expect(output).toContain('"op": "list"');
});

// The playground's fileList example (T12).
//
// fileList takes a directory ARRAY, so the direct-call runner has to hand the
// textarea the array itself — not a `{ "paths": [...] }` wrapper — because the
// single-property rule makes `parameters` BE the `paths` value. This file pins
// both halves: the example that is shown, and the body that is sent.
//
// The stub server mirrors the real shape: `parameters` is the array, and the
// result is the prefixed, directory-grouped listing the implementation returns.

import type { ToolDescriptor } from '../../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fileListTool: ToolDescriptor = {
    name: 'fileList',
    group: 'Package presets',
    description: 'List the immediate entries of one or more directories, non-recursively.',
    tags: ['files', 'list', 'filesystem'],
    visibility: 'searchable',
    parameters: {
        type: 'object',
        properties: {
            paths: {
                type: 'array',
                items: { type: 'string' },
                description:
                    'Directories to list, absolute or relative to the working directory, in the order the results are grouped. Defaults to ["."].'
            }
        },
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

const tab = (name: 'Chat' | 'Tools'): HTMLButtonElement => {
    const found = [...document.querySelectorAll<HTMLButtonElement>('.tab')].find(
        (candidate) => candidate.textContent === name
    );
    if (found === undefined) throw new Error(`missing ${name} tab`);
    return found;
};

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
                            tools: ['fileList'],
                            coreTools: ['toolRequest', 'toolCreate', 'todoManage'],
                            primary: 'instruct',
                            subagents: [],
                            builtin: true,
                            editable: true
                        }
                    ],
                    tools: [fileListTool],
                    defaults: { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false },
                    sessions: [],
                    agents: []
                });
            }

            if (url === '/api/models') return json({ models: ['m1'] });

            if (url === '/api/tools/fileList' && method === 'POST') {
                return json({
                    ok: true,
                    result: ['src/a.ts', 'src/nested/', 'task/b.ts'],
                    durationMs: 3
                });
            }

            throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);
        })
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
});

it('offers the paths array as the example and sends it unwrapped', async () => {
    await import('./main');
    await flush();
    await flush();

    tab('Tools').click();
    await flush();

    document.querySelector<HTMLButtonElement>('.tool-tab-button[data-tool="fileList"]')?.click();
    await flush();

    // The example is the ARRAY itself: JSON.stringify(["."], null, 2).
    expect(byClass('.tool-args', 'textarea').value).toBe('[\n  "."\n]');
    // The rule line names the single property, which is what makes the array the
    // whole argument. Scoped to the runner card: the agent panel uses the same
    // `field-hint` class for unrelated guidance.
    expect(document.querySelector('.tool-card .field-hint')?.textContent).toBe(
        'Single-property rule: execute receives the value of "paths", so this textarea holds that value (JSON), not a wrapper object.'
    );

    document.querySelector<HTMLButtonElement>('.tool-card button.primary')?.click();
    await flush();
    await flush();

    // Unwrapped on the wire, exactly like the harness and the server expect.
    expect(calls.find((call) => call.url === '/api/tools/fileList')).toEqual({
        url: '/api/tools/fileList',
        method: 'POST',
        body: { parameters: ['.'] }
    });

    // The prefixed listing is rendered verbatim.
    const output = document.querySelector('.tool-output .card-body')?.textContent ?? '';
    expect(output).toContain('"src/a.ts"');
    expect(output).toContain('"src/nested/"');
    expect(output).toContain('"task/b.ts"');
});

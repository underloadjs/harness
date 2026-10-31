// R5/T6 — the tools-tab manual runner dialog Copies its CURRENT result.
//
// The runner also contains editable arguments, but the inspector payload is the
// output box: tool identity, result label and the exact raw result text. The source
// is a click-time provider, so the button follows a call that completes while the
// dialog is open instead of copying a stale placeholder.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts tools-runner-copy.test.ts

import type { HarnessDescriptor, SessionSnapshot, ToolDescriptor } from '../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
};

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const descriptor = (): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: 'A general instruction-following agent.',
        requiresEndpoint: true,
        agents: ['instruct'],
        tools: ['fileRead'],
        coreTools: [],
        primary: 'instruct',
        subagents: [],
        builtin: true,
        editable: true
    }) as HarnessDescriptor;

const fileReadTool: ToolDescriptor = {
    name: 'fileRead',
    group: 'Files',
    description: 'Read one or more files.',
    tags: ['files'],
    visibility: 'searchable',
    parameters: {
        type: 'object',
        properties: { paths: { type: 'array', items: { type: 'string' } } }
    }
};

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

const setClipboard = (writeText: ((text: string) => Promise<void>) | undefined): void => {
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: writeText === undefined ? undefined : { writeText }
    });
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
    setClipboard(undefined);
});

afterEach(() => {
    vi.unstubAllGlobals();
    setClipboard(undefined);
    document.body.innerHTML = '';
});

it('copies the current runner result from an open tool dialog', async () => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url === '/api') {
                return json({
                    rootPath: '/api',
                    presets: [descriptor()],
                    tools: [fileReadTool],
                    defaults: { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false },
                    sessions: [],
                    agents: []
                });
            }
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/tools/fileRead') {
                return json({
                    ok: true,
                    result: { path: 'package.json', content: '{}' },
                    durationMs: 9
                });
            }
            if (url === '/api/sessions') return json({ session: snapshot() }, 201);
            throw new Error(`unexpected request: ${url}`);
        })
    );

    const writeText = vi.fn(async () => undefined);
    setClipboard(writeText);

    await import('./main');
    await flush();
    await flush();

    document.querySelector<HTMLButtonElement>('.tools-toggle')?.click();
    await flush();
    document.querySelector<HTMLButtonElement>('.tool-tab-button[data-tool="fileRead"]')?.click();
    expect(document.querySelector('.dialog-title')?.textContent).toBe('fileRead');

    const args = document.querySelector<HTMLTextAreaElement>('.tool-args');
    if (args === null) throw new Error('missing runner arguments');
    args.value = '["package.json"]';
    document.querySelector<HTMLButtonElement>('.tool-card button.primary')?.click();
    await flush();
    await flush();

    const copy = document.querySelector<HTMLButtonElement>('.dialog .dialog-copy');
    expect(copy).not.toBeNull();
    copy?.click();
    await flush();

    expect(writeText).toHaveBeenCalledWith(
        [
            'Tool: fileRead',
            'Result: result · 9ms',
            '',
            '{\n  "path": "package.json",\n  "content": "{}"\n}'
        ].join('\n')
    );
    expect(copy?.textContent).toBe('Copied');
});

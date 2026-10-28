// Tools tab: every bootstrap tool (core included) is listed and callable, and a
// core call runs on the server inside the selected session.
//
// R21.2 acceptance this file also pins: the Tools tab is the ONLY tool listing —
// the right rail no longer drops a catalogue or core-tools disclosure — and the
// enabled-for-session status lives here (`.tools-session-note`).
//
// R8 acceptance this file pins:
//   - the Tools tab exists as an accessible tablist and lists core tools as well
//     as catalogue tools;
//   - a session-bound core call sends the captured sessionId and no browser eval
//     is involved — the only effects are fetch requests;
//   - the session is created for the selected harness when none exists;
//   - an ordinary tool keeps its pre-R8 request body (no sessionId);
//   - after a core call the session snapshot is re-read, so discovered tools show
//     up without a reload;
//   - a truncated toolRequest result keeps its raw payload and adds guidance that
//     names the remaining count and asks for refined tags.

import type { HarnessDescriptor, SessionSnapshot, ToolDescriptor } from '../../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };

const descriptor = (overrides: Partial<HarnessDescriptor> = {}): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: 'A general instruction-following agent.',
        requiresEndpoint: true,
        agents: ['instruct'],
        tools: ['fileRead'],
        coreTools: ['toolRequest', 'toolCreate', 'todoManage'],
        primary: 'instruct',
        subagents: [],
        builtin: true,
        editable: true,
        ...overrides
    }) as HarnessDescriptor;

const coreTool = (name: string, parameters: Record<string, unknown>): ToolDescriptor => ({
    name,
    group: 'Core tools',
    description: `${name} core tool`,
    tags: ['core', 'harness'],
    visibility: 'core',
    parameters,
    sessionBound: true
});

const fileReadTool: ToolDescriptor = {
    name: 'fileRead',
    group: 'Files',
    description: 'Read one or more files.',
    tags: ['files', 'read'],
    visibility: 'searchable',
    parameters: {
        type: 'object',
        properties: {
            paths: {
                type: 'array',
                items: { type: 'string' },
                description: 'Files to read, in the order the results are returned.'
            }
        },
        required: ['paths']
    }
};

const toolRequestTool = coreTool('toolRequest', {
    type: 'object',
    properties: {
        tags: { type: 'array', items: { type: 'string' }, description: 'Capability tags.' }
    }
});

const snapshot = (overrides: Partial<SessionSnapshot> = {}): SessionSnapshot =>
    ({
        id: 's1',
        harness: 'instruct',
        status: 'idle',
        model: 'm1',
        createdAt: 1,
        updatedAt: 2,
        messages: [],
        turns: [],
        ...overrides
    }) as SessionSnapshot;

const json = (value: unknown, status = 200): Response =>
    new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
};

type Call = { url: string; method: string | undefined; body: unknown };

const bootstrap = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    rootPath: '/api',
    presets: [descriptor()],
    tools: [toolRequestTool, fileReadTool],
    defaults,
    sessions: [],
    agents: [],
    ...overrides
});

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

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.unstubAllGlobals();
});

it('lists core tools on the Tools tab, calls with the captured session and refreshes the snapshot', async () => {
    const calls: Call[] = [];

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const method = init?.method;
            const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
            calls.push({ url, method, body });

            if (url === '/api') return json(bootstrap());
            if (url === '/api/models') return json({ models: ['m1', 'm2'] });

            if (url === '/api/sessions' && method === 'POST') {
                return json({ session: snapshot() }, 201);
            }

            if (url === '/api/tools/toolRequest' && method === 'POST') {
                return json({
                    ok: true,
                    result: {
                        enabled: ['fileRead'],
                        tools: ['fileRead', 'fileGlob'],
                        truncated: true,
                        remaining: 2
                    },
                    durationMs: 7
                });
            }

            // The refresh a core call triggers. The discovery must reach the core
            // section without a reload.
            if (url === '/api/sessions/s1' && method === undefined) {
                return json({ session: snapshot({ discoveredTools: ['fileRead', 'fileGlob'] }) });
            }

            if (url === '/api/tools/fileRead' && method === 'POST') {
                return json({ ok: true, result: { path: 'package.json', content: '{}' }, durationMs: 2 });
            }

            throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);
        })
    );

    await import('./main');
    await flush();
    await flush();

    // A real tablist, and the only tool listing (R21.2).
    const tabs = byClass('.tabs', 'div');
    expect(document.querySelector('.rail-right .tool-list')).toBeNull();
    expect(document.querySelector('.rail-right .core-tools')).toBeNull();
    expect(tabs.getAttribute('role')).toBe('tablist');
    expect([...document.querySelectorAll<HTMLElement>('.tab')].map((node) => node.textContent)).toEqual([
        'Chat',
        'Tools'
    ]);
    expect(tab('Chat').getAttribute('aria-selected')).toBe('true');

    tab('Tools').click();
    await flush();

    expect(tab('Chat').getAttribute('aria-selected')).toBe('false');
    expect(tab('Tools').getAttribute('aria-selected')).toBe('true');
    expect(byClass('.stage', 'div').getAttribute('aria-labelledby')).toBe('harness-tab-tools');

    // EVERY bootstrap tool is listed, core tools included, in server group order.
    expect([...document.querySelectorAll<HTMLElement>('.tool-tab-group')].map((node) => node.textContent)).toEqual(
        ['Core tools', 'Files']
    );
    expect(
        [...document.querySelectorAll<HTMLElement>('.tool-tab-button')].map((node) => node.dataset.tool)
    ).toEqual(['toolRequest', 'fileRead']);
    expect(
        [...document.querySelectorAll<HTMLElement>('.tool-tab-kind')].map((node) => node.textContent)
    ).toEqual(['core · session', 'searchable']);

    // The first tool opens automatically; a core tool reports its session context
    // before anything is created.
    expect(document.querySelector('.main-title')?.textContent).toBe('toolRequest');
    expect(byClass('.agent-slot', 'div').hidden).toBe(true);
    expect(document.querySelector('.tool-session')?.textContent).toBe(
        'Session-bound: runs inside instruct. No session yet — Call creates one for this harness.'
    );

    byClass('.tool-args', 'textarea').value = '{"tags":["web"]}';
    document.querySelector<HTMLButtonElement>('.tool-card button.primary')?.click();
    await flush();
    await flush();

    // The session was created for the selected harness and the captured id was
    // sent with the call. Nothing else ran: a browser cannot evaluate these tools.
    expect(calls.filter((call) => call.url === '/api/sessions' && call.method === 'POST')).toHaveLength(1);
    expect(calls.find((call) => call.url === '/api/tools/toolRequest')).toEqual({
        url: '/api/tools/toolRequest',
        method: 'POST',
        body: { parameters: { tags: ['web'] }, sessionId: 's1' }
    });

    expect(document.querySelector('.tool-session')?.textContent).toBe(
        'Session-bound: runs inside instruct · session s1.'
    );

    // The raw structured result is intact …
    const output = document.querySelector('.tool-output .card-body')?.textContent ?? '';
    expect(output).toContain('"remaining": 2');
    expect(output).toContain('"truncated": true');
    // … and the guidance names the count and the fix.
    expect(byClass('.tool-hint', 'p').hidden).toBe(false);
    expect(byClass('.tool-hint', 'p').textContent).toBe(
        '1 tool enabled; 2 more tools match. Refine the tags to see them.'
    );

    // The post-call snapshot refresh surfaced the discovery on the Tools tab, while
    // the Tools tab still owns the centre (R21.2: this replaced the removed
    // right-rail core dropdown).
    expect(calls.filter((call) => call.url === '/api/sessions/s1')).toHaveLength(1);
    expect(byClass('.tools-session-note', 'p').textContent).toBe(
        'Session-bound tools run inside instruct · session s1 · enabled for this session: fileRead, fileGlob'
    );

    // An ordinary tool is unchanged: no sessionId key, no extra session traffic.
    document.querySelector<HTMLButtonElement>('.tool-tab-button[data-tool="fileRead"]')?.click();
    expect(document.querySelector('.tool-session')?.hidden).toBe(true);

    byClass('.tool-args', 'textarea').value = '["package.json"]';
    const getsBefore = calls.filter((call) => call.url === '/api/sessions/s1').length;
    const sessionsBefore = calls.filter((call) => call.url === '/api/sessions').length;

    document.querySelector<HTMLButtonElement>('.tool-card button.primary')?.click();
    await flush();
    await flush();

    expect(calls.find((call) => call.url === '/api/tools/fileRead')).toEqual({
        url: '/api/tools/fileRead',
        method: 'POST',
        body: { parameters: ['package.json'] }
    });
    expect(calls.filter((call) => call.url === '/api/sessions/s1')).toHaveLength(getsBefore);
    expect(calls.filter((call) => call.url === '/api/sessions')).toHaveLength(sessionsBefore);
    expect(document.querySelector('.tool-output .card-body')?.textContent).toContain('"content": "{}"');
    expect(byClass('.tool-hint', 'p').hidden).toBe(true);
});

it('shows a server request failure for a core call instead of pretending it ran', async () => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);

            if (url === '/api') return json(bootstrap());
            if (url === '/api/models') return json({ models: ['m1'] });
            if (url === '/api/sessions' && init?.method === 'POST') return json({ session: snapshot() }, 201);

            if (url === '/api/tools/toolRequest' && init?.method === 'POST') {
                // 409: the session is mid-run. The client reports the server's
                // message and must NOT refresh as if the call had applied.
                return json({ error: { message: 'Session "s1" is running; retry when it is idle.' } }, 409);
            }

            throw new Error(`unexpected request: ${url}`);
        })
    );

    await import('./main');
    await flush();
    await flush();

    tab('Tools').click();
    await flush();

    byClass('.tool-args', 'textarea').value = '{"tags":["web"]}';
    document.querySelector<HTMLButtonElement>('.tool-card button.primary')?.click();
    await flush();
    await flush();

    expect(byClass('.tool-output .card-head', 'div').textContent).toBe('error');
    expect(document.querySelector('.tool-output .card-body')?.textContent).toBe(
        'Session "s1" is running; retry when it is idle.'
    );
    expect(document.querySelector('.tool-output')?.className).toBe('card tool-output is-error');
});

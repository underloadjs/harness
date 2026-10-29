// Tool-catalogue rendering for the credential-dependent webSearch entry.
//
// C1 is a visibility fix: the catalogue must show webSearch even when the server
// has no key, the button must say so before a click, and the runner must offer the
// example arguments while refusing to call it. With a key, the same entry is a
// normal callable tool. `main.ts` is imported with a stubbed fetch, exactly like
// main.test.ts, so no server runs and no key exists anywhere.
//
// R21.2 moved this catalogue: the right rail no longer lists tools at all, so the
// Tools tab is the only place a tool is selected, and the runner opens there.
//
// Run: npx vitest run --config src/frontend/vitest.config.ts

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const descriptor = {
    name: 'demo',
    title: 'Demo harness',
    description: 'A harness for the catalogue test.',
    requiresEndpoint: false,
    agents: ['demo'],
    tools: []
};

const WEBSEARCH_PARAMETERS = {
    type: 'object',
    properties: {
        query: { type: 'string', description: 'What to search for, e.g. "harness tool discovery".' },
        maxResults: { type: 'integer', minimum: 1, maximum: 20, description: 'How many results to return.' }
    },
    required: ['query'],
    additionalProperties: false
};

const json = (value: unknown): Response =>
    new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

const stubFetch = (availability: unknown): void => {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);

            // Canonical-style bootstrap document: one answer carries the presets,
            // the tool catalogue and the (empty) session list.
            if (url === '/api') {
                return json({
                    rootPath: 'D:/repo',
                    presets: [descriptor],
                    tools: [
                        {
                            name: 'webSearch',
                            group: 'Web search',
                            description: 'Search the web with Exa or Tavily.',
                            tags: ['web', 'search', 'internet', 'news', 'research'],
                            // R18: a configured (or listed) webSearch is core.
                            visibility: 'core',
                            parameters: WEBSEARCH_PARAMETERS,
                            availability
                        }
                    ],
                    defaults: { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false },
                    sessions: []
                });
            }

            // Boot also refreshes the model catalogue in the background.
            if (url.endsWith('/api/models')) return json({ models: ['m1'] });

            throw new Error(`unexpected request: ${url}`);
        })
    );
};

const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 30));
};

const boot = async (): Promise<void> => {
    await import('./main');
    await flush();
    await flush();
};

// R21.2/R3: the tools view is the only catalogue. Selecting a tool means clicking
// its keyed button there, so the global topbar toggle is pressed first (there is no
// tab strip any more).
const openToolsTab = (): void => {
    const found = document.querySelector<HTMLButtonElement>('.tools-toggle');
    if (found === null) throw new Error('the global Tools toggle did not render');
    if (found.getAttribute('aria-pressed') !== 'true') found.click();
};

const toolButtons = (): HTMLButtonElement[] => [
    ...document.querySelectorAll<HTMLButtonElement>('.tool-tab-button')
];

const warningNotes = (): HTMLElement[] =>
    Array.from(document.querySelectorAll<HTMLElement>('.tool-card .tool-note.is-warning'));

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.unstubAllGlobals();
});

it('lists an unconfigured webSearch, explains it, and disables the call', async () => {
    const hint =
        'Web search is not configured on this server. Set EXA_API_KEY or TAVILY_API_KEY in packages/underload/harness/.env (or the process environment) and restart the harness server.';

    stubFetch({ state: 'unconfigured', environment: ['EXA_API_KEY', 'TAVILY_API_KEY'], hint });
    await boot();

    // R21.2: no tool list on the right rail any more, and no mode switch either.
    expect(document.querySelectorAll('.modes')).toHaveLength(0);
    expect(document.querySelector('.rail-right .tool-list')).toBeNull();
    expect(document.querySelector('.rail-right .core-tools')).toBeNull();

    openToolsTab();

    expect([...document.querySelectorAll<HTMLElement>('.tool-tab-group')].map((node) => node.textContent)).toEqual([
        'Web search'
    ]);

    const button = toolButtons()[0];
    expect(button.dataset.availability).toBe('unconfigured');
    expect(button.querySelector('.tool-tab-kind')?.textContent).toBe('core · unconfigured');

    // The Tools tab opens the first entry automatically, so the runner is already
    // showing webSearch; clicking the entry again is the explicit path.
    button.click();

    // The tool opens in the centre; the header describes it without badge clutter.
    expect(document.querySelector('.main-title')?.textContent).toBe('webSearch');
    expect(document.querySelector('.harness-id')?.textContent).toBe('Web search');
    expect(document.querySelector('.harness-note')?.textContent).toBe(
        'core · tags: web, search, internet, news, research · unconfigured'
    );
    // The rails stay accessible around the runner.
    expect(document.querySelector('.rail-left')).not.toBeNull();
    expect(document.querySelector('.rail-right')).not.toBeNull();

    // The example arguments are still offered (they are useful documentation),
    // but both inputs that could start a call are disabled.
    const args = document.querySelector<HTMLTextAreaElement>('.tool-args');
    expect(args?.value).toBe('{\n  "query": "harness tool discovery",\n  "maxResults": 5\n}');
    expect(args?.disabled).toBe(true);

    const call = document.querySelector<HTMLButtonElement>('.tool-card button.primary');
    expect(call?.disabled).toBe(true);

    // The visible warning is the server's hint, verbatim; the safety note is the
    // other warning paragraph and stays visible in both states.
    const notes = warningNotes();
    expect(notes).toHaveLength(2);
    expect(notes[1].hidden).toBe(false);
    expect(notes[1].textContent).toBe(hint);

    expect(document.querySelector('.tool-output .card-head')?.textContent).toBe('unconfigured');
    expect(document.querySelector('.tool-output .card-body')?.textContent).toBe('Not configured on this server.');
});

it('enables the same entry when the server reports it configured', async () => {
    stubFetch({ state: 'available', environment: ['EXA_API_KEY', 'TAVILY_API_KEY'] });
    await boot();

    openToolsTab();

    const button = toolButtons()[0];
    expect(button.dataset.availability).toBeUndefined();
    expect(button.querySelector('.tool-tab-kind')?.textContent).toBe('core');

    button.click();

    expect(document.querySelector('.main-title')?.textContent).toBe('webSearch');
    expect(document.querySelector('.harness-note')?.textContent).toBe(
        'core · tags: web, search, internet, news, research'
    );

    const args = document.querySelector<HTMLTextAreaElement>('.tool-args');
    expect(args?.disabled).toBe(false);

    const call = document.querySelector<HTMLButtonElement>('.tool-card button.primary');
    expect(call?.disabled).toBe(false);

    const notes = warningNotes();
    expect(notes).toHaveLength(2);
    expect(notes[1].hidden).toBe(true);

    expect(document.querySelector('.tool-output .card-head')?.textContent).toBe('result');
    expect(document.querySelector('.tool-output .card-body')?.textContent).toBe('Nothing yet. Press “Call tool”.');
});

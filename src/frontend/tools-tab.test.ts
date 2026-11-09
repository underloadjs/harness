// Tools view (global): every bootstrap tool (core included) is listed and callable,
// and a core call runs on the server inside the selected session.
//
// R21.2 acceptance this file also pins: the tools view is the ONLY tool listing —
// the right rail no longer drops a catalogue or core-tools disclosure — and the
// enabled-for-session status lives here (`.tools-session-note`).
//
// R3 acceptance this file pins:
//   - there is NO tab strip: no `.tabs`, no tablist/tab/tabpanel and no
//     `aria-labelledby` pointing at a removed tab;
//   - the topbar's icon-only Tools toggle is the single global control that opens
//     the same catalogue + runner view, and it reports its state with
//     `aria-pressed` while `aria-controls` names the centre region;
//
// R8 acceptance this file pins:
//   - the tools view lists core tools as well as catalogue tools;
//   - a session-bound core call sends the captured sessionId and no browser eval
//     is involved — the only effects are fetch requests;
//   - the session is created for the selected harness when none exists;
//   - an ordinary tool keeps its pre-R8 request body (no sessionId);
//   - after a core call the session snapshot is re-read, so discovered tools show
//     up without a reload;
//   - a truncated toolRequest result keeps its raw payload and adds guidance that
//     names the remaining count and asks for refined tags.
//
// Dialog rework (main.ts `selectTool`/`openToolDialog`/`setToolsView`): opening the
// tools view shows ONLY the catalogue list (head = "Tools"/"catalogue"/count note)
// and activating a `.tool-tab-button` opens the runner inside the shared
// `.dialog` (`.dialog-title` = tool name, `.tool-runner-slot > .pane > .log-wrap >
// .log > .tool-card`).
// The runner therefore does not exist in the document until an entry is clicked —
// every test that reads `.tool-args` must click its `.tool-tab-button` first.
//
// R1 + R3 (this pass) — the page is ALWAYS reachable and every row states its switch:
//   - no run gate: the toggle, the rows and the identified-detail read all work while a
//     conversation is streaming (`setToolsView`/`selectTool` dropped their `running`
//     guards, and `paintControls` now gates the controls on `booted` alone);
//   - each row carries a `role="switch"` SIBLING (a `<button>` cannot contain a control,
//     hence the `.tool-tab-row` wrapper) painted from the row's own `enabled`, and one
//     click writes `PATCH /tools/{tool_id}` `{ enabled: <next> }` — the answer is the
//     whole updated row, which is what the row repaints from;
//   - a `protected` (harness-owned) entry gets NO switch: the store answers `enabled: true`
//     for it and refuses a switch with 403, so the row carries a pin that says why.

import type { HarnessDescriptor, SessionSnapshot, ToolDescriptor } from '../server/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { viewAwareFetch } from './view-test-support';

const defaults = { baseURL: 'http://provider/v1', model: 'm1', hasApiKey: false };

const descriptor = (overrides: Partial<HarnessDescriptor> = {}): HarnessDescriptor =>
    ({
        name: 'instruct',
        title: 'Instruct',
        description: 'A general instruction-following agent.',
        requiresEndpoint: true,
        agents: ['instruct'],
        tools: ['read'],
        coreTools: ['toolRequest', 'toolCreate', 'tasks'],
        primary: 'instruct',
        subagents: [],
        builtin: true,
        editable: true,
        ...overrides
    }) as HarnessDescriptor;

// R3: the two enablement fields every catalogue row carries (../shared/harness-api.ts
// `ToolSummary`:741-752, mapped through by ./api.ts `toolRowOf`). `ToolDescriptor`
// (../server/protocol.ts:414) predates them, so the fixtures state the row the way the
// WIRE does — a `ToolRowEntry` in main.ts's spelling — and a row without them would
// render no switch at all.
type WireTool = ToolDescriptor & { enabled: boolean; protected: boolean };

// A harness-owned core entry: `enabled: true` and `protected: true`, because the store
// answers that way for its own set and its PATCH is a 403 (../server/api.ts `patchTool`).
const coreTool = (name: string, parameters: Record<string, unknown>): WireTool => ({
    name,
    group: 'Core tools',
    description: `${name} core tool`,
    tags: ['core', 'harness'],
    visibility: 'core',
    parameters,
    sessionBound: true,
    enabled: true,
    protected: true
});

const fileReadTool: WireTool = {
    name: 'read',
    group: 'Files',
    description: 'Read one or more files.',
    tags: ['files', 'read'],
    visibility: 'searchable',
    enabled: true,
    protected: false,
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

// A row the operator has already switched OFF, so the off state and its repaint are
// pinned against a server figure rather than against a click.
const disabledTool: WireTool = {
    ...fileReadTool,
    name: 'glob',
    description: 'List files by pattern.',
    tags: ['files'],
    enabled: false
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
        // A CREATED conversation has a frozen definition — that is the record the identified
        // definition read (`GET /sessions/:id/definition`) serves, and the only place the
        // canonical surface answers `discovered_tools`. A fixture without it is a record the
        // server never created, and the double correctly reports 404.
        harnessDefinition: descriptor(),
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

// R3: the centre has no tab strip. Tools is a GLOBAL icon-only toggle in the topbar
// that opens the same catalogue + runner view; these helpers drive it by its
// accessible name rather than by a tab role.
const toolsToggle = (): HTMLButtonElement => {
    const found = document.querySelector<HTMLButtonElement>('.tools-toggle');
    if (found === null) throw new Error('missing global Tools toggle');
    return found;
};

const openTools = (): void => {
    if (toolsToggle().getAttribute('aria-pressed') !== 'true') toolsToggle().click();
};

// The R1/R3 section's server: the same boot document every test here declares, plus the
// test's OWN routes. A route nobody declared is a FAILURE (the "no extra traffic" counts
// depend on the double being strict), and `runningSession` embeds a conversation the shell
// opens on boot — the pending state the catalogues used to hide behind.
const stubFetch = (
    handler: (url: string, method: string | undefined, body: unknown) => Response | undefined = () => undefined,
    runningSession?: SessionSnapshot
): Call[] => {
    const calls: Call[] = [];

    const raw = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const method = init?.method;
        const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));

        calls.push({ url, method, body });

        const declared = handler(url, method, body);

        if (declared !== undefined) return declared;
        if (url === '/api') return json(bootstrap(runningSession === undefined ? {} : { sessions: [runningSession] }));
        if (url === '/api/models') return json({ models: ['m1'] });

        throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);
    };

    // The adapter is built ONCE: its composition memo (one canonical answer per epoch) is
    // per-adapter, and building it per call would re-read the raw record every time.
    const adapter = viewAwareFetch(raw, { root: '/api' });

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const answer = adapter(input, init);

            return answer instanceof Promise ? await answer : answer;
        })
    );

    return calls;
};

const boot = async (): Promise<void> => {
    await import('./main');
    await flush();
    await flush();
};

beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
    vi.unstubAllGlobals();
});

it('lists core tools in the global tools view, calls with the captured session and refreshes the snapshot', async () => {
    const calls: Call[] = [];
    // The URL the SHELL dialed, recorded OUTSIDE the test-only adapter. `calls` below sees the raw
    // twin the double composes its answers from, and two different canonical resources — the
    // session row and its frozen definition (where `discovered_tools` lives, ./view-api.ts header)
    // — are both re-expressed from this fixture's single `/api/sessions/s1` route. The "exactly
    // one refresh read" rule is therefore stated against the request the browser actually made.
    const dialed: string[] = [];

    const fixtureFetch = viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
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
                        enabled: ['read'],
                        tools: ['read', 'glob'],
                        truncated: true,
                        remaining: 2
                    },
                    durationMs: 7
                });
            }

            // The refresh a core call triggers. The discovery must reach the core
            // section without a reload.
            if (url === '/api/sessions/s1' && method === undefined) {
                return json({ session: snapshot({ discoveredTools: ['read', 'glob'] }) });
            }

            if (url === '/api/tools/read' && method === 'POST') {
                return json({ ok: true, result: { path: 'package.json', content: '{}' }, durationMs: 2 });
            }

            throw new Error(`unexpected request: ${method ?? 'GET'} ${url}`);
    }, { root: '/api' });

    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            dialed.push(`${init?.method ?? 'GET'} ${String(input)}`);

            const answer = fixtureFetch(input, init);

            return answer instanceof Promise ? await answer : answer;
        })
    );

    await import('./main');
    await flush();
    await flush();

    // No tab strip at all (R3), and the only tool listing (R21.2).
    expect(document.querySelector('.rail-right .tool-list')).toBeNull();
    expect(document.querySelector('.rail-right .core-tools')).toBeNull();
    expect(document.querySelector('.tabs')).toBeNull();
    expect(document.querySelector('[role="tablist"]')).toBeNull();
    expect(document.querySelector('[role="tab"]')).toBeNull();
    expect(document.querySelector('[role="tabpanel"]')).toBeNull();
    expect(document.querySelector('[aria-labelledby^="harness-tab"]')).toBeNull();

    // The global control is an icon-only toggle with an accessible name: no visible
    // text, one decorative glyph, `aria-pressed` reporting the closed view, and
    // `aria-controls` naming the centre region it replaces.
    const toggle = toolsToggle();
    expect(toggle.type).toBe('button');
    expect(toggle.getAttribute('aria-label')).toBe('Tools');
    expect(toggle.textContent).toBe('⚒');
    expect(toggle.querySelector('[aria-hidden="true"]')?.textContent).toBe('⚒');
    expect(toggle.getAttribute('aria-controls')).toBe('harness-stage');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(byClass('.stage', 'div').id).toBe('harness-stage');

    openTools();
    await flush();

    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(byClass('.stage', 'div').querySelector('.tools-pane')).not.toBeNull();

    // EVERY bootstrap tool is listed, core tools included, in server group order.
    expect([...document.querySelectorAll<HTMLElement>('.tool-tab-group')].map((node) => node.textContent)).toEqual(
        ['Core tools', 'Files']
    );
    expect(
        [...document.querySelectorAll<HTMLElement>('.tool-tab-button')].map((node) => node.dataset.tool)
    ).toEqual(['toolRequest', 'read']);
    expect(
        [...document.querySelectorAll<HTMLElement>('.tool-tab-kind')].map((node) => node.textContent)
    ).toEqual(['core · session', 'searchable']);

    // Dialog rework: opening the tools view NO LONGER auto-opens a tool. The head
    // describes the catalogue itself and no runner exists until an entry is picked.
    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.querySelector('.tool-args')).toBeNull();
    expect(document.querySelector('.main-title')?.textContent).toBe('Tools');
    expect(document.querySelector('.harness-id')?.textContent).toBe('catalogue');
    expect(document.querySelector('.harness-note')?.textContent).toBe(
        '2 tools · calls run on the harness server'
    );

    // Activating the core entry adopts the persistent runner into the shared modal.
    // A core tool reports its session context before anything is created.
    document.querySelector<HTMLButtonElement>('.tool-tab-button[data-tool="toolRequest"]')?.click();

    expect(document.querySelectorAll('.dialog')).toHaveLength(1);
    expect(byClass('.dialog-title', 'h2').textContent).toBe('toolRequest');
    // F3: this is the REAL runner DOM the sizing rules must target. It is a direct
    // form card under `.log`, with `.tool-output > .card-body` and NO `.tool-body`
    // (that class belongs to the transcript tool-chip dialog only).
    const runnerCard = document.querySelector<HTMLElement>(
        '.dialog .tool-runner-slot > .pane > .log-wrap > .log > .tool-card'
    );
    expect(runnerCard).not.toBeNull();
    expect(runnerCard?.parentElement?.className).toBe('log');
    expect(runnerCard?.querySelector(':scope > .tool-body')).toBeNull();
    expect(runnerCard?.querySelector(':scope > .tool-output > .card-body')).not.toBeNull();
    expect(document.querySelector('.main-title')?.textContent).toBe('toolRequest');
    expect(byClass('.agent-slot', 'div').hidden).toBe(true);
    expect(document.querySelector('.tool-session')?.textContent).toBe(
        'Session-bound: runs in the playground’s own temporary session for instruct. None yet — Call creates one, and leaving the tools view deletes it.'
    );

    byClass('.tool-args', 'textarea').value = '{"tags":["web"]}';
    document.querySelector<HTMLButtonElement>('.tool-card button.primary')?.click();
    await flush();
    await flush();

    // The session was created for the selected harness and the captured id was
    // sent with the call. Nothing else ran: a browser cannot evaluate these tools.
    expect(calls.filter((call) => call.url === '/api/sessions' && call.method === 'POST')).toHaveLength(1);
    expect(calls.find((call) => call.url === '/api/tools/toolRequest' && call.method === 'POST')).toEqual({
        url: '/api/tools/toolRequest',
        method: 'POST',
        body: { parameters: { tags: ['web'] }, sessionId: 's1' }
    });

    // R7: the session the runner created is the PLAYGROUND's own, so its id appears only
    // in the playground copy — never as "your conversation".
    expect(document.querySelector('.tool-session')?.textContent).toBe(
        'Session-bound: runs in the playground’s own temporary session for instruct · session s1. The conversation you selected is untouched.'
    );

    // R7: the temporary session is not adopted into the reader's chat. No pill appears
    // anywhere, and no conversation was opened. (T9 moved the directory into the dashboard
    // behind the title, which the DISABLED title button cannot open while the tools view
    // owns the head — the empty-directory hint it used to assert is pinned in
    // session-pills.test.ts, where the dashboard is reachable.)
    expect(document.querySelectorAll('.session-pill')).toHaveLength(0);
    expect(document.querySelector('.session-pills-bar-head')).toBeNull();

    // The raw structured result is intact …
    const output = document.querySelector('.tool-output .card-body')?.textContent ?? '';
    expect(output).toContain('"remaining": 2');
    expect(output).toContain('"truncated": true');
    // … and the guidance names the count and the fix.
    expect(byClass('.tool-hint', 'p').hidden).toBe(false);
    expect(byClass('.tool-hint', 'p').textContent).toBe(
        '1 tool enabled; 2 more tools match. Refine the tags to see them.'
    );

    // The post-call snapshot refresh surfaced the discovery in the tools view, while
    // the tools view still owns the centre (R21.2: this replaced the removed
    // right-rail core dropdown).
    // One canonical session-row read for the refresh (`GET /v1/harness/sessions/{id}`), and one
    // frozen-definition read for the discovery line — each exactly once, no storms.
    expect(dialed.filter((line) => line === 'GET /v1/harness/sessions/s1')).toHaveLength(1);
    expect(dialed.filter((line) => line === 'GET /v1/harness/sessions/s1/definition').length).toBeGreaterThanOrEqual(1);
    // R7: the discovery line describes the PLAYGROUND context, and it is refreshed by
    // the temporary session's snapshot — never by the selected conversation's one.
    expect(byClass('.tools-session-note', 'p').textContent).toBe(
        'Session-bound tools run in the playground’s own context: instruct · temporary session s1 · enabled there: read, glob. The conversation you selected is never touched.'
    );

    // An ordinary tool is unchanged: no sessionId key, no extra session traffic.
    document.querySelector<HTMLButtonElement>('.tool-tab-button[data-tool="read"]')?.click();
    expect(document.querySelector('.tool-session')?.hidden).toBe(true);

    byClass('.tool-args', 'textarea').value = '["package.json"]';
    const getsBefore = calls.filter((call) => call.url === '/api/sessions/s1').length;
    const sessionsBefore = calls.filter((call) => call.url === '/api/sessions').length;

    document.querySelector<HTMLButtonElement>('.tool-card button.primary')?.click();
    await flush();
    await flush();

    expect(calls.find((call) => call.url === '/api/tools/read' && call.method === 'POST')).toEqual({
        url: '/api/tools/read',
        method: 'POST',
        body: { parameters: ['package.json'] }
    });
    expect(calls.filter((call) => call.url === '/api/sessions/s1')).toHaveLength(getsBefore);
    expect(calls.filter((call) => call.url === '/api/sessions')).toHaveLength(sessionsBefore);
    expect(document.querySelector('.tool-output .card-body')?.textContent).toContain('"content": "{}"');
    expect(byClass('.tool-hint', 'p').hidden).toBe(true);
});

// Dialog rework: the manual runner is a MODAL, not an inline panel under the list.
// This test pins the modal contract itself — the list-only head, the dialog title,
// one-at-a-time replacement, and the close reset (head back to the catalogue,
// `aria-pressed` false, focus back on the entry that opened it).
it('opens the tool runner in the shared dialog and restores the list on close', async () => {
    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url === '/api') return json(bootstrap());
            if (url === '/api/models') return json({ models: ['m1'] });

            throw new Error(`unexpected request: ${url}`);
        }, { root: '/api' }))
    );

    await import('./main');
    await flush();
    await flush();

    openTools();
    await flush();

    // The view is the catalogue only: no layer, no runner, and a head that
    // describes the list.
    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.querySelector('.tool-args')).toBeNull();
    expect(document.querySelector('.main-title')?.textContent).toBe('Tools');
    expect(document.querySelector('.harness-id')?.textContent).toBe('catalogue');
    expect(document.querySelector('.harness-note')?.textContent).toBe(
        '2 tools · calls run on the harness server'
    );

    const toolRequestButton = byClass('.tool-tab-button[data-tool="toolRequest"]', 'button');
    const fileReadButton = byClass('.tool-tab-button[data-tool="read"]', 'button');
    // Every entry advertises the popup it opens and starts unpressed.
    expect(toolRequestButton.getAttribute('aria-haspopup')).toBe('dialog');
    expect(toolRequestButton.getAttribute('aria-pressed')).toBe('false');
    expect(fileReadButton.getAttribute('aria-pressed')).toBe('false');

    toolRequestButton.click();

    // Exactly one dialog, named after the tool, with the runner adopted inside it.
    expect(document.querySelectorAll('.dialog')).toHaveLength(1);
    expect(byClass('.dialog-title', 'h2').textContent).toBe('toolRequest');
    expect(
        document.querySelector('.dialog .tool-runner-slot > .pane > .log-wrap > .log > .tool-card')
    ).not.toBeNull();
    expect(toolRequestButton.getAttribute('aria-pressed')).toBe('true');
    expect(fileReadButton.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('.main-title')?.textContent).toBe('toolRequest');
    expect(document.querySelector('.harness-id')?.textContent).toBe('Core tools');
    expect(document.querySelector('.harness-note')?.textContent).toBe(
        'core · tags: core, harness · session-bound'
    );

    // A second selection REPLACES the layer instead of stacking a second one.
    fileReadButton.click();

    expect(document.querySelectorAll('.dialog')).toHaveLength(1);
    expect(byClass('.dialog-title', 'h2').textContent).toBe('read');
    expect(toolRequestButton.getAttribute('aria-pressed')).toBe('false');
    expect(fileReadButton.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.main-title')?.textContent).toBe('read');
    expect(document.querySelector('.harness-id')?.textContent).toBe('Files');
    expect(document.querySelector('.harness-note')?.textContent).toBe('searchable · tags: files, read');

    // `.dialog-close` removes the layer, resets the pressed state, repaints the
    // catalogue head and hands focus back to the entry that opened it.
    byClass('.dialog-close', 'button').click();

    expect(document.querySelector('.dialog')).toBeNull();
    expect(fileReadButton.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('.main-title')?.textContent).toBe('Tools');
    expect(document.querySelector('.harness-id')?.textContent).toBe('catalogue');
    expect(document.querySelector('.harness-note')?.textContent).toBe(
        '2 tools · calls run on the harness server'
    );
    expect(document.activeElement).toBe(fileReadButton);

    // Escape is the other dismissal path and converges on the same reset.
    fileReadButton.click();
    expect(document.querySelectorAll('.dialog')).toHaveLength(1);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(document.querySelector('.dialog')).toBeNull();
    expect(fileReadButton.getAttribute('aria-pressed')).toBe('false');
    expect(document.querySelector('.main-title')?.textContent).toBe('Tools');
    expect(document.querySelector('.harness-id')?.textContent).toBe('catalogue');
    expect(document.querySelector('.harness-note')?.textContent).toBe(
        '2 tools · calls run on the harness server'
    );
    expect(document.activeElement).toBe(fileReadButton);

    // The list itself never left the stage: the dialog sits over it, not instead.
    expect(document.querySelector('.stage .tools-pane')?.isConnected).toBe(true);
    expect(document.querySelector('.dialog-overlay')).toBeNull();
});

it('shows a server request failure for a core call instead of pretending it ran', async () => {
    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
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
        }, { root: '/api' }))
    );

    await import('./main');
    await flush();
    await flush();

    openTools();
    await flush();

    // The runner only exists inside the modal now, so the entry must be opened first.
    document.querySelector<HTMLButtonElement>('.tool-tab-button[data-tool="toolRequest"]')?.click();

    byClass('.tool-args', 'textarea').value = '{"tags":["web"]}';
    document.querySelector<HTMLButtonElement>('.tool-card button.primary')?.click();
    await flush();
    await flush();

    // R8: a request-level failure is written AS a structured response, in the same JSON
    // shape the success path uses, and the payload draft stays exactly as typed.
    expect(byClass('.tool-output .card-label', 'span').textContent).toBe('error');
    expect(JSON.parse(document.querySelector('.tool-output .card-body')?.textContent ?? '')).toEqual({
        ok: false,
        error: {
            kind: 'request_failed',
            message: 'Session "s1" is running; retry when it is idle.'
        }
    });
    expect(byClass('.tool-args', 'textarea').value).toBe('{"tags":["web"]}');
    expect(document.querySelector('.tool-output')?.className).toBe('card tool-output tool-section is-error');
});

// T3/R7: delegate is configuration-dependent. The runner must build its presets from
// the PLAYGROUND harness's subagents (the server registers the tool only when there is
// a target) instead of the old hard-coded `summarizer`, which most harnesses do not
// configure — and never from the selected conversation's frozen team.
const agentDelegateTool = coreTool('delegate', {
    type: 'object',
    properties: {
        agent: { type: 'string', enum: ['research', 'workspace'], description: 'Target agent id.' },
        input: { type: 'string', description: 'A self-contained brief.' }
    },
    required: ['agent', 'input']
});

it('fills the delegation presets from the playground harness, not a hard-coded agent', async () => {
    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url === '/api') {
                return json(
                    bootstrap({
                        presets: [
                            descriptor({
                                agents: ['instruct', 'research', 'workspace'],
                                subagents: ['research', 'workspace']
                            })
                        ],
                        tools: [agentDelegateTool, fileReadTool]
                    })
                );
            }
            if (url === '/api/models') return json({ models: ['m1'] });

            throw new Error(`unexpected request: ${url}`);
        }, { root: '/api' }))
    );

    await import('./main');
    await flush();
    await flush();

    openTools();
    await flush();
    document.querySelector<HTMLButtonElement>('.tool-tab-button[data-tool="delegate"]')?.click();

    // The first configured subagent is the example target, and the brief says what a
    // self-contained brief must contain.
    expect(JSON.parse(byClass('.tool-args', 'textarea').value)).toEqual({
        agent: 'research',
        input:
            'Give research everything it needs: the goal, the files or areas, the constraints, and the evidence you want back.'
    });

    // R7: the runner states the playground harness's real targets and the one-level
    // limit, and never claims the selected conversation is the one it writes into.
    expect(document.querySelector('.tool-note')?.textContent).toBe(
        'Core tool — it runs in the playground’s temporary session and hands ONE subagent a self-contained brief. Targets for the playground harness: research, workspace. Subagents cannot delegate further.'
    );
    // R8: each target is its own named preset button, with the schema fallback after it.
    expect(
        [...document.querySelectorAll<HTMLElement>('.tool-preset')].map((node) => node.textContent)
    ).toEqual(['Delegate to research', 'Delegate to workspace']);
    expect(document.querySelector('.tool-card button.primary')?.disabled).toBe(false);
});

it('reports delegation as unavailable when the playground harness has no subagents', async () => {
    const calls: Call[] = [];

    vi.stubGlobal(
        'fetch',
        vi.fn(viewAwareFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            calls.push({ url, method: init?.method, body: undefined });

            if (url === '/api') return json(bootstrap({ tools: [agentDelegateTool] }));
            if (url === '/api/models') return json({ models: ['m1'] });

            throw new Error(`unexpected request: ${url}`);
        }, { root: '/api' }))
    );

    await import('./main');
    await flush();
    await flush();

    openTools();
    await flush();

    // The catalogue is host-wide, but the tab says when the tool is actually
    // registered for the playground's session, so a subagent-less harness claims nothing.
    expect(byClass('.tools-tab-hint', 'p').textContent).toContain(
        'delegate when the playground harness has subagents'
    );

    // Delegation is blocked rather than offered with a target this team lacks.
    // The runner is inside the modal now, so open the entry before reading it.
    document.querySelector<HTMLButtonElement>('.tool-tab-button[data-tool="delegate"]')?.click();

    expect(byClass('.tool-args', 'textarea').value).toBe('{}');
    // R8: no target means no preset to offer.
    expect(document.querySelectorAll('.tool-preset')).toHaveLength(0);
    expect(document.querySelector<HTMLButtonElement>('.tool-card button.primary')?.disabled).toBe(true);
    expect(document.querySelector('.tool-note')?.textContent).toBe(
        'Core tool — the playground harness declares no subagents, so delegation is not available in its session. Add an agent to that team to enable one-level delegation.'
    );
    expect(
        [...document.querySelectorAll<HTMLElement>('.tool-runner-slot .tool-note.is-warning')].map(
            (node) => node.textContent
        )
    ).toEqual([
        'This runs on the harness server with the server process permissions. The file and command presets are not sandboxed.',
        'Not available for the playground harness: it declares no subagents, so delegate is not registered in its session.'
    ]);
    expect(byClass('.tool-output .card-label', 'span').textContent).toBe('unavailable');

    // A programmatic click cannot reach the server either.
    document.querySelector<HTMLButtonElement>('.tool-card button.primary')?.click();
    await flush();
    // No EXECUTION left the browser (`POST /tools/{id}/executions`). The identified schema read
    // an opened tool costs is a GET on the same path and is not a call.
    expect(calls.filter((call) => call.url.includes('/tools/') && call.method === 'POST')).toEqual([]);
});

// ---------------------------------------------------------------------------
// R1 + R3: the page is always reachable, and every row states its switch.
//
// `fileReadTool` is a switchable catalogue entry (enabled, not protected) and
// `toolRequestTool` is harness-owned (enabled, PROTECTED), so the default bootstrap
// already carries one of each shape.
// ---------------------------------------------------------------------------

// The `PATCH /tools/{id}` answer: the WHOLE updated row in the contract's snake_case
// spelling, because `updateToolEnabled` unwraps `body.tool` and `toolRowOf` maps it
// (./api.ts:1502-1530). The pane repaints from THIS, never from the value it sent.
const toolRowAnswer = (name: string, enabled: boolean, isProtected: boolean): Record<string, unknown> => ({
    name,
    group: name === 'toolRequest' ? 'Core tools' : 'Files',
    description: `${name} tool`,
    tags: [name === 'toolRequest' ? 'core' : 'files'],
    visibility: name === 'toolRequest' ? 'core' : 'searchable',
    session_bound: name === 'toolRequest',
    enabled,
    protected: isProtected,
    parameters: { type: 'object', properties: {} },
    execution: { scope: name === 'toolRequest' ? 'session_required' : 'global', manual: true }
});

it('paints one global switch per switchable row, and a pin (not a control) on the harness-owned row', async () => {
    stubFetch();
    await boot();

    openTools();
    await flush();

    const readRow = byClass('.tool-tab-button[data-tool="read"]', 'button');
    const readSwitch = byClass('.tool-tab-toggle[data-tool="read"]', 'button');

    // The row is a wrapper with two SIBLINGS: a `<button>` cannot contain a control, and
    // nesting one would have made the list read as a single ambiguous control.
    expect(readRow.parentElement?.className).toBe('tool-tab-row');
    expect(readRow.contains(readSwitch)).toBe(false);
    expect(readSwitch.parentElement?.className).toBe('tool-tab-row');

    // The visible word is the STATE, `aria-checked` is the state for assistive tech, and
    // the accessible name is the ACTION the click performs.
    expect(readSwitch.type).toBe('button');
    expect(readSwitch.getAttribute('role')).toBe('switch');
    expect(readSwitch.getAttribute('aria-checked')).toBe('true');
    expect(readSwitch.textContent).toBe('on');
    expect(readSwitch.dataset.enabled).toBe('true');
    expect(readSwitch.getAttribute('aria-label')).toBe('Disable read for every conversation');
    expect(readSwitch.title).toBe('Enabled for every conversation · click to switch this tool off');
    // R1: a control that is not waiting on its own write is never disabled.
    expect(readSwitch.disabled).toBe(false);
    expect(readRow.dataset.enabled).toBe('true');

    // A harness-owned entry has NO control: the store answers `enabled: true` for it and
    // refuses a switch with 403, so the row says that instead of offering a dead button.
    expect(document.querySelector('.tool-tab-toggle[data-tool="toolRequest"]')).toBeNull();
    expect(document.querySelectorAll('.tool-tab-toggle')).toHaveLength(1);

    const pin = byClass('.tool-tab-pin', 'span');

    expect(pin.textContent).toBe('core');
    expect(pin.title).toBe(
        'toolRequest is a harness-owned core tool: always enabled, and it cannot be switched off.'
    );
    expect(pin.parentElement?.querySelector('button')).toBe(byClass('.tool-tab-button[data-tool="toolRequest"]', 'button'));

    // R3: the hint used to describe the list as something you only SELECT from. It now
    // says what the switch is and how far it reaches.
    const hint = byClass('.tools-tab-hint', 'p').textContent ?? '';

    expect(hint).toContain('Each row also carries that tool’s switch');
    expect(hint).toContain('enables or disables the tool for EVERY conversation');
    expect(hint).toContain('a run already in flight keeps the tool list it was given');
    expect(hint).toContain('Harness-owned core tools are pinned on and have no switch');
});

it('switches a tool off and back on with one click, and repaints the row from the server answer', async () => {
    // The double applies the switch the way the store does and answers the updated row, so
    // the repaint below is provably the SERVER's figure.
    let enabled = true;

    const calls = stubFetch((url, method, body) => {
        if (url === '/api/tools/read' && method === 'PATCH') {
            const patch = body as { enabled?: boolean };

            enabled = patch.enabled !== false;

            return json({ tool: toolRowAnswer('read', enabled, false) });
        }

        return undefined;
    });

    await boot();
    openTools();
    await flush();

    const row = byClass('.tool-tab-button[data-tool="read"]', 'button');
    const control = byClass('.tool-tab-toggle[data-tool="read"]', 'button');

    control.click();

    // In flight: only this row's control is locked (its own write), and the app pill says
    // what is being saved — the same reporting the plugin settings save uses.
    expect(control.disabled).toBe(true);
    expect(control.getAttribute('aria-busy')).toBe('true');

    await flush();
    await flush();

    expect(calls.filter((call) => call.url === '/api/tools/read' && call.method === 'PATCH')).toEqual([
        { url: '/api/tools/read', method: 'PATCH', body: { enabled: false } }
    ]);

    // The SAME nodes repaint from the answer: no list rebuild, so the row stays the node
    // the runner dialog would hand focus back to.
    expect(byClass('.tool-tab-button[data-tool="read"]', 'button')).toBe(row);
    expect(byClass('.tool-tab-toggle[data-tool="read"]', 'button')).toBe(control);
    expect(row.dataset.enabled).toBe('false');
    expect(control.className).toBe('tool-tab-toggle is-off');
    expect(control.textContent).toBe('off');
    expect(control.getAttribute('aria-checked')).toBe('false');
    expect(control.getAttribute('aria-label')).toBe('Enable read for every conversation');
    expect(control.disabled).toBe(false);

    // The pane's own live line states the accepted figure, and the pill returns to idle.
    expect(byClass('.tools-tab-note', 'p').textContent).toBe('read is now disabled for every conversation.');
    expect(byClass('.tools-tab-note', 'p').hidden).toBe(false);
    expect(byClass('.tools-tab-note', 'p').className).toBe('tools-tab-note field-hint');
    expect(byClass('.status-text', 'span').textContent).toBe('idle');

    // A second press inverts what the SERVER reported (the cache moved with the answer),
    // and no catalogue page was re-read to paint it.
    control.click();
    await flush();
    await flush();

    expect(calls.filter((call) => call.url === '/api/tools/read' && call.method === 'PATCH')).toHaveLength(2);
    expect(control.getAttribute('aria-checked')).toBe('true');
    expect(row.dataset.enabled).toBe('true');
});

it('states a refused switch with the server sentence and leaves the row as the server has it', async () => {
    const message = 'read is required by the selected harness and cannot be switched off.';
    const calls = stubFetch((url, method) => {
        if (url === '/api/tools/read' && method === 'PATCH') return json({ error: { message } }, 403);

        return undefined;
    });

    await boot();
    openTools();
    await flush();

    const row = byClass('.tool-tab-button[data-tool="read"]', 'button');
    const control = byClass('.tool-tab-toggle[data-tool="read"]', 'button');

    control.click();
    await flush();
    await flush();

    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);

    // The server's own sentence, on the classed failure line — and the row still states
    // the figure the server has, because nothing was written.
    expect(byClass('.tools-tab-note', 'p').textContent).toBe(message);
    expect(byClass('.tools-tab-note', 'p').className).toBe('tools-tab-note tools-tab-note-error');
    expect(control.getAttribute('aria-checked')).toBe('true');
    expect(control.textContent).toBe('on');
    expect(control.disabled).toBe(false);
    expect(row.dataset.enabled).toBe('true');
    expect(byClass('.status-text', 'span').textContent).toBe('error');
});

it('keeps the tools page, its rows and its switch usable while a run is pending', async () => {
    // The conversation the shell opens on boot still holds work, so the whole shell is in
    // its pending state — the state that used to hide the tools page entirely.
    const running = snapshot({
        status: 'running',
        turns: [
            {
                id: 't1',
                index: 0,
                prompt: 'long task',
                status: 'running',
                startedAt: 1,
                updatedAt: 2,
                events: [{ type: 'start', agent: 'instruct', model: 'm1' }]
            } as unknown as SessionSnapshot['turns'][number]
        ]
    });

    const calls = stubFetch((url, method) => {
        if (url === '/api/sessions/s1' && method === undefined) return json({ session: running });
        if (url === '/api/sessions' && method === undefined) return json({ sessions: [running] });
        if (url === '/api/tools/read' && method === 'PATCH') {
            return json({ tool: toolRowAnswer('read', false, false) });
        }

        return undefined;
    }, running);

    await boot();
    await flush();

    // Pending, and the chat's own gates stay locked (the ones R1 deliberately KEEPS).
    expect(byClass('.composer-action', 'button').dataset.action).toBe('stop');
    expect(byClass('.new-session', 'button').disabled).toBe(true);

    // The tools control answers to `booted` alone, so a run cannot grey it out.
    expect(byClass('.tools-toggle', 'button').disabled).toBe(false);

    openTools();
    await flush();

    expect(byClass('.stage', 'div').querySelector('.tools-pane')).not.toBeNull();
    expect(byClass('.tool-tab-button[data-tool="read"]', 'button').disabled).toBe(false);
    expect(byClass('.tool-tab-toggle[data-tool="read"]', 'button').disabled).toBe(false);

    // A row is clickable mid-run: its runner opens over the list, schema read and all.
    byClass('.tool-tab-button[data-tool="toolRequest"]', 'button').click();
    expect(byClass('.dialog-title', 'h2').textContent).toBe('toolRequest');
    byClass('.dialog-close', 'button').click();
    await flush();
    expect(byClass('.stage', 'div').querySelector('.tools-pane')?.isConnected).toBe(true);

    // And the global switch WRITES mid-run — the route has no idle window, and the run in
    // flight keeps the tool list it was already given.
    byClass('.tool-tab-toggle[data-tool="read"]', 'button').click();
    await flush();
    await flush();

    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([
        { url: '/api/tools/read', method: 'PATCH', body: { enabled: false } }
    ]);
    expect(byClass('.tool-tab-toggle[data-tool="read"]', 'button').getAttribute('aria-checked')).toBe('false');
});

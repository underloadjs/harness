// Tools view (global): every bootstrap tool (core included) is listed and callable,
// and a core call runs on the server inside the selected session.
//
// R21.2 acceptance this file also pins: the tools view is the ONLY tool listing —
// the right rail no longer drops a catalogue or core-tools disclosure. R3 removed the
// enabled-for-session status line that used to sit under the pane heading, and the
// enablement write's live line went with it later, so the pane is its title plus the grid.
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
// tools view shows ONLY the catalogue list (head title "Tools Catalogue" with the shared
// `.harness-id` badge HIDDEN, plus the count note) and activating a `.tool-tab-button`
// opens the runner inside the shared
// `.dialog` (`.dialog-title` = tool name, `.tool-runner-slot > .pane > .log-wrap >
// .log > .tool-card`).
// The runner therefore does not exist in the document until an entry is clicked —
// every test that reads `.tool-args` must click its `.tool-tab-button` first.
//
// Tools Catalogue pass (this pass), pinned below:
//   - R1: the pane's long "Every tool the server lists…" paragraph is GONE (no
//     `.tools-tab-hint` element at all); R3 then removed the playground note, and this
//     pass removes the enablement write's live line, so the head is ONLY its `h2` title;
//   - R2: the head title is "Tools Catalogue" and the badge next to it is blanked + hidden —
//     the stray `catalogue` word right of the "+" is what the reader asked to remove;
//   - R4: the bootstrap tools page is read at the contract's MAXIMUM size and followed to
//     exhaustion, so a 32-tool catalogue reaches the view complete (pinned in ./api.test.ts
//     `listAllTools`, and here by the head count equaling the rendered row count);
//   - R5: NO `.tool-tab-group` heading is emitted and the rows are strictly A–Z by tool name.
//
// R1 + R3 (this pass) — the page is ALWAYS reachable and every row states its switch:
//   - no run gate: the tick box, the rows and the identified-detail read all work while a
//     conversation is streaming (`setToolsView`/`selectTool` dropped their `running`
//     guards, and `paintControls` now gates the controls on `booted` alone);
//   - each row carries a corner `input[type=checkbox]` (a `<button>` cannot contain a
//     control, hence the `.tool-tab-row` wrapper and the absolutely positioned box)
//     painted from the row's own `enabled`, and one click writes
//     `PATCH /tools/{tool_id}` `{ enabled: <next> }` — the answer is the whole updated
//     row, which is what the row repaints from;
//   - EVERY row gets one, the harness-owned core entries included: the pinned-set flag
//     and its "core" pin are gone, so there is no affordance-less row shape left.

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

// R3: the enablement figure every catalogue row carries (../shared/harness-api.ts
// `ToolSummary`, mapped through by ./api.ts `toolRowOf`). `ToolDescriptor`
// (../server/protocol.ts:414) predates it, so the fixtures state the row the way the
// WIRE does — a `ToolRowEntry` in main.ts's spelling — and a row without it would render
// no tick box at all. There is NO pinned-set field: every entry, core tools included,
// is switchable, and the frontend reads no such figure.
type WireTool = ToolDescriptor & { enabled: boolean };

// A harness-owned core entry. It ships enabled and it carries a tick box like every
// other row — the server answers a PATCH for it too.
const coreTool = (name: string, parameters: Record<string, unknown>): WireTool => ({
    name,
    group: 'Core tools',
    description: `${name} core tool`,
    tags: ['core', 'harness'],
    visibility: 'core',
    parameters,
    sessionBound: true,
    enabled: true
});

const fileReadTool: WireTool = {
    name: 'read',
    group: 'Files',
    description: 'Read one or more files.',
    tags: ['files', 'read'],
    visibility: 'searchable',
    enabled: true,
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

    // R5: EVERY bootstrap tool is listed, core tools included, as ONE flat A–Z list — no
    // group heading is emitted anywhere in the pane ("Core tools" / "Package presets" and
    // every registration group are gone; the kind still rides each row's meta line).
    // `read` precedes `toolRequest` because 'r' < 't' case-insensitively, and the kind line
    // moves WITH the row it belongs to.
    expect(document.querySelectorAll('.tool-tab-group')).toHaveLength(0);
    // R3 + this pass: nothing sits between the heading and the grid any more — neither the
    // playground's context note nor the switch write's live line — so opening the view paints
    // the title and the rows only.
    expect(document.querySelector('.tools-session-note')).toBeNull();
    expect(document.querySelector('.tools-tab-note')).toBeNull();
    expect([...byClass('.tools-tab-head', 'div').children].map((node) => node.className)).toEqual([
        'tools-tab-title'
    ]);
    expect(
        [...document.querySelectorAll<HTMLElement>('.tool-tab-button')].map((node) => node.dataset.tool)
    ).toEqual(['read', 'toolRequest']);
    expect(
        [...document.querySelectorAll<HTMLElement>('.tool-tab-kind')].map((node) => node.textContent)
    ).toEqual(['searchable', 'core · session']);

    // Dialog rework: opening the tools view NO LONGER auto-opens a tool. The head
    // describes the catalogue itself and no runner exists until an entry is picked.
    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.querySelector('.tool-args')).toBeNull();
    // R2: the head names the view "Tools Catalogue", and the shared `.harness-id` badge that
    // used to print a stray `catalogue` to the right of the "+" is blanked and HIDDEN — the
    // same treatment the chat head gives it (main.test.ts pins the round trip).
    expect(document.querySelector('.main-title')?.textContent).toBe('Tools Catalogue');
    expect(byClass('.harness-id', 'span').hidden).toBe(true);
    expect(byClass('.harness-id', 'span').textContent).toBe('');
    // R4: the head's count and the rendered rows are the SAME figure — the catalogue the
    // server lists is the catalogue the pane paints, page by page until the cursor runs out
    // (./api.ts `listAllTools`), so nothing is silently truncated at a 25-row page.
    expect(document.querySelectorAll('.tool-tab-row')).toHaveLength(2);
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
    // R3: the pane no longer narrates the playground context, so the discovery refresh
    // above changes no DOM at all — the note element is gone and the head is still exactly
    // its heading. The tools the call enabled are still read back from the server (the
    // definition read asserted above); they are simply no longer printed under the heading.
    expect(document.querySelector('.tools-session-note')).toBeNull();
    expect(document.querySelector('.tools-tab-note')).toBeNull();
    expect([...byClass('.tools-tab-head', 'div').children].map((node) => node.className)).toEqual([
        'tools-tab-title'
    ]);

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
    // R2: the catalogue head says "Tools Catalogue" and keeps the shared badge hidden.
    expect(document.querySelector('.main-title')?.textContent).toBe('Tools Catalogue');
    expect(byClass('.harness-id', 'span').hidden).toBe(true);
    expect(byClass('.harness-id', 'span').textContent).toBe('');
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
    // R2: the catalogue head says "Tools Catalogue" and keeps the shared badge hidden.
    expect(document.querySelector('.main-title')?.textContent).toBe('Tools Catalogue');
    expect(byClass('.harness-id', 'span').hidden).toBe(true);
    expect(byClass('.harness-id', 'span').textContent).toBe('');
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
    // R2: the catalogue head says "Tools Catalogue" and keeps the shared badge hidden.
    expect(document.querySelector('.main-title')?.textContent).toBe('Tools Catalogue');
    expect(byClass('.harness-id', 'span').hidden).toBe(true);
    expect(byClass('.harness-id', 'span').textContent).toBe('');
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

    // R1 (Tools Catalogue): the pane's long "Every tool the server lists…" paragraph — the one
    // that used to name `delegate when the playground harness has subagents` — is GONE, from
    // the source and from the document. What still states that a subagent-less harness
    // registers no delegation is the runner this test opens below (`.tool-note`), and the
    // row's own meta line; nothing is claimed above the list any more.
    expect(document.querySelector('.tools-tab-hint')).toBeNull();

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
// R1 + R3: the page is always reachable, and every row states its tick box.
//
// The default bootstrap carries a catalogue entry (`fileReadTool`) AND a harness-owned
// core entry (`toolRequestTool`). Both are switchable now: the pinned-set flag left the
// wire with the old "core" pin, so there is exactly ONE row shape — a tile plus its
// corner box.
// ---------------------------------------------------------------------------

// The `PATCH /tools/{id}` answer: the WHOLE updated row in the contract's snake_case
// spelling, because `updateToolEnabled` unwraps `body.tool` and `toolRowOf` maps it
// (./api.ts `toolRowOf`). The pane repaints from THIS, never from the value it sent.
const toolRowAnswer = (name: string, enabled: boolean): Record<string, unknown> => ({
    name,
    group: name === 'toolRequest' ? 'Core tools' : 'Files',
    description: `${name} tool`,
    tags: [name === 'toolRequest' ? 'core' : 'files'],
    visibility: name === 'toolRequest' ? 'core' : 'searchable',
    session_bound: name === 'toolRequest',
    enabled,
    parameters: { type: 'object', properties: {} },
    execution: { scope: name === 'toolRequest' ? 'session_required' : 'global', manual: true }
});

// The corner tick box of one row. `input`, not a `role="switch"` button: the native
// control carries the state in `checked` and needs no ARIA mirror.
const toolBox = (name: string): HTMLInputElement =>
    byClass(`.tool-tab-enable[data-tool="${name}"]`, 'input');

it('paints one corner tick box on EVERY row, the harness-owned core row included', async () => {
    stubFetch();
    await boot();

    openTools();
    await flush();

    // Every row is a wrapper holding the tile and its box as SIBLINGS — a `<button>`
    // cannot contain a control — and the rows run A–Z by tool name (R5: one flat list, no
    // group headings; the server's core-first order is not what the reader sees).
    expect(
        [...document.querySelectorAll<HTMLElement>('.tool-tab-row')].map((node) =>
            [...node.children].map((child) => `${child.tagName.toLowerCase()}.${child.className}`)
        )
    ).toEqual([
        ['button.tool-tab-button', 'input.tool-tab-enable is-on'],
        ['button.tool-tab-button', 'input.tool-tab-enable is-on']
    ]);

    const readRow = byClass('.tool-tab-button[data-tool="read"]', 'button');
    const readSwitch = toolBox('read');

    // A real checkbox: `checked` IS the state (so no `role`, no `aria-checked` to keep
    // honest), the accessible name is the ACTION, and the title states the scope.
    expect(readSwitch.type).toBe('checkbox');
    expect(readSwitch.checked).toBe(true);
    expect(readSwitch.dataset.enabled).toBe('true');
    expect(readSwitch.getAttribute('role')).toBeNull();
    expect(readSwitch.getAttribute('aria-checked')).toBeNull();
    expect(readSwitch.getAttribute('aria-label')).toBe('Disable read');
    expect(readSwitch.title).toBe(
        'Enabled for every conversation on this harness server · click to switch this tool off'
    );
    // R1: a control that is not waiting on its own write is never disabled.
    expect(readSwitch.disabled).toBe(false);

    // The box is NOT inside the tile, and the tile carries the SAME figure — which is what
    // styles the enabled state: an `--ok-line` BORDER on the tile and no green wash behind it
    // (styles.css:1042-1058 `.tool-tab-button[data-enabled='true']`; an unticked row keeps the
    // plain surface).
    expect(readRow.parentElement?.className).toBe('tool-tab-row');
    expect(readRow.contains(readSwitch)).toBe(false);
    expect(readSwitch.parentElement?.className).toBe('tool-tab-row');
    expect(readSwitch.closest('.tool-tab-button')).toBeNull();
    expect(readRow.dataset.enabled).toBe('true');

    // The harness-owned core row is switchable like any other: the store no longer
    // refuses its PATCH, so the "core" pin is gone and its box is ticked, not absent.
    const coreRow = byClass('.tool-tab-button[data-tool="toolRequest"]', 'button');
    const coreSwitch = toolBox('toolRequest');

    expect(coreRow.dataset.enabled).toBe('true');
    expect(coreSwitch.checked).toBe(true);
    expect(coreSwitch.disabled).toBe(false);
    expect(coreSwitch.getAttribute('aria-label')).toBe('Disable toolRequest');

    // Nothing is left of the old pill or the pin, in the document or in the markup.
    expect(document.querySelectorAll('.tool-tab-toggle')).toHaveLength(0);
    expect(document.querySelectorAll('.tool-tab-pin')).toHaveLength(0);
    expect(document.querySelectorAll('[role="switch"]')).toHaveLength(0);
    expect(document.querySelectorAll('.tool-tab-enable')).toHaveLength(2);

    // R1 (Tools Catalogue): the paragraph that used to explain the switch from above the list
    // is gone, and the pane adds nothing about the switch of its own: the switch's `title`
    // (asserted above) carries the explanation, the tick box and the tile's edge carry the
    // state, and the topbar pill carries a refusal's sentence.
    expect(document.querySelector('.tools-tab-hint')).toBeNull();
    // R3 + this pass: the pane head is ONLY its heading — the playground's session note and
    // the switch write's live line are both gone, so nothing names the temporary context or
    // narrates a write up front any more.
    expect(document.querySelector('.tools-tab-note')).toBeNull();
    expect([...byClass('.tools-tab-head', 'div').children].map((node) => node.className)).toEqual([
        'tools-tab-title'
    ]);
    // …and the pane itself is nothing but that head and the grid: title, tools, done.
    expect([...byClass('.tools-pane', 'div').children].map((node) => node.className)).toEqual([
        'tools-tab-head',
        'tool-tab-list'
    ]);
    // The heading is the view's name, not a bare "Tools" with a stray badge word beside it.
    expect(byClass('.tools-tab-title', 'h2').textContent).toBe('Tools Catalogue');
});

// The guard main.ts documents: a row that never stated an enablement states NO state,
// rather than inventing a tick the server never reported.
it('renders no tick box and no enablement attribute for a row whose server never stated one', async () => {
    const legacyRow: Record<string, unknown> = { ...fileReadTool };
    delete legacyRow.enabled;

    stubFetch((url) => (url === '/api' ? json(bootstrap({ tools: [legacyRow] })) : undefined));
    await boot();

    openTools();
    await flush();

    const row = byClass('.tool-tab-button[data-tool="read"]', 'button');

    expect(row.dataset.enabled).toBeUndefined();
    expect(document.querySelectorAll('.tool-tab-enable')).toHaveLength(0);
    expect(document.querySelector('.tool-tab-pin')).toBeNull();
    // The tile still opens its runner: only the enablement affordance is withheld.
    expect(row.getAttribute('aria-haspopup')).toBe('dialog');
});

it('switches a tool off and back on with one click, and repaints the row from the server answer', async () => {
    // The double applies the switch the way the store does and answers the updated row, so
    // the repaint below is provably the SERVER's figure.
    let enabled = true;

    const calls = stubFetch((url, method, body) => {
        if (url === '/api/tools/read' && method === 'PATCH') {
            const patch = body as { enabled?: boolean };

            enabled = patch.enabled !== false;

            return json({ tool: toolRowAnswer('read', enabled) });
        }

        return undefined;
    });

    await boot();
    openTools();
    await flush();

    const row = byClass('.tool-tab-button[data-tool="read"]', 'button');
    const control = toolBox('read');

    control.click();

    // In flight: the native box has already flipped itself, only THIS row's control is
    // locked (its own write), and the app pill says what is being saved — the same
    // reporting the plugin settings save uses.
    expect(control.checked).toBe(false);
    expect(control.disabled).toBe(true);
    expect(control.getAttribute('aria-busy')).toBe('true');

    await flush();
    await flush();

    expect(calls.filter((call) => call.url === '/api/tools/read' && call.method === 'PATCH')).toEqual([
        { url: '/api/tools/read', method: 'PATCH', body: { enabled: false } }
    ]);

    // The SAME nodes repaint from the answer: no list rebuild, so the row stays the node
    // the runner dialog would hand focus back to. The box, its `data-enabled` and the
    // tile's enabled EDGE move together, so the tick and the green border can never disagree.
    expect(byClass('.tool-tab-button[data-tool="read"]', 'button')).toBe(row);
    expect(byClass('.tool-tab-enable[data-tool="read"]', 'input')).toBe(control);
    expect(row.dataset.enabled).toBe('false');
    expect(control.className).toBe('tool-tab-enable is-off');
    expect(control.checked).toBe(false);
    expect(control.dataset.enabled).toBe('false');
    expect(control.getAttribute('aria-label')).toBe('Enable read');
    expect(control.disabled).toBe(false);

    // The pane says NOTHING about the accepted switch: its live line is gone with the
    // markup, so the box/row figure asserted above IS the report, and the pill returns to idle.
    expect(document.querySelector('.tools-tab-note')).toBeNull();
    expect(byClass('.status-text', 'span').textContent).toBe('idle');

    // A second press inverts what the SERVER reported (the cache moved with the answer),
    // and no catalogue page was re-read to paint it.
    control.click();
    await flush();
    await flush();

    expect(calls.filter((call) => call.url === '/api/tools/read' && call.method === 'PATCH')).toHaveLength(2);
    expect(control.checked).toBe(true);
    expect(control.className).toBe('tool-tab-enable is-on');
    expect(row.dataset.enabled).toBe('true');
});

it('pulls a refused switch back to the server figure and keeps the server sentence on the pill', async () => {
    const message = 'read cannot be switched off while its harness is being rebuilt.';
    const calls = stubFetch((url, method) => {
        if (url === '/api/tools/read' && method === 'PATCH') return json({ error: { message } }, 403);

        return undefined;
    });

    await boot();
    openTools();
    await flush();

    const row = byClass('.tool-tab-button[data-tool="read"]', 'button');
    const control = toolBox('read');

    control.click();
    // A native checkbox flipped itself on the click — this is exactly the state a refusal
    // has to undo, and why the busy pass repaints from the cache when it unlocks.
    expect(control.checked).toBe(false);

    await flush();
    await flush();

    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);

    // The refusal leaves nothing in the pane that could lie: there is no line to contradict
    // the server (the live element is gone), and the row still states the figure the server
    // holds, because nothing was written and the unlock pass repaints from that cache.
    expect(document.querySelector('.tools-tab-note')).toBeNull();
    expect(control.checked).toBe(true);
    expect(control.className).toBe('tool-tab-enable is-on');
    expect(control.dataset.enabled).toBe('true');
    expect(control.getAttribute('aria-label')).toBe('Disable read');
    expect(control.disabled).toBe(false);
    expect(row.dataset.enabled).toBe('true');
    // The server's own sentence is NOT dropped with the pane line: the pill reports the state
    // word, its `title` carries the diagnostic for pointer readers, and the hidden live-region
    // child announces it — so a refused switch still fails out loud, just not in the pane.
    expect(byClass('.status-text', 'span').textContent).toBe('error');
    expect(byClass('.status-detail', 'span').textContent).toBe(`tool enablement: ${message}`);
});

// R1's click separation: the box and the tile are two controls in one row, and each owns
// exactly one of the two actions.
it('writes enablement from the corner box without opening the runner, and the tile click still opens it', async () => {
    let enabled = true;

    const calls = stubFetch((url, method, body) => {
        if (url === '/api/tools/read' && method === 'PATCH') {
            enabled = (body as { enabled?: boolean }).enabled !== false;

            return json({ tool: toolRowAnswer('read', enabled) });
        }

        // The schema read the runner costs when (and only when) the TILE is clicked.
        if (url === '/api/tools/read' && method === undefined) return json({ tool: toolRowAnswer('read', enabled) });

        return undefined;
    });

    await boot();
    openTools();
    await flush();

    // The box is the button's SIBLING, so its click cannot bubble into the tile's handler
    // (CSS positions it over the tile's corner and lifts it above the button).
    expect(toolBox('read').closest('button')).toBeNull();

    toolBox('read').click();
    await flush();
    await flush();

    // The write went, and NO runner layer was adopted over the list.
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([
        { url: '/api/tools/read', method: 'PATCH', body: { enabled: false } }
    ]);
    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.querySelector('.tool-args')).toBeNull();
    expect(toolBox('read').checked).toBe(false);
    expect(byClass('.tool-tab-button[data-tool="read"]', 'button').getAttribute('aria-pressed')).toBe('false');

    // The tile click is the other action: it opens the runner and writes nothing.
    byClass('.tool-tab-button[data-tool="read"]', 'button').click();

    expect(byClass('.dialog-title', 'h2').textContent).toBe('read');
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);

    byClass('.dialog-close', 'button').click();
    await flush();

    expect(document.querySelector('.dialog')).toBeNull();
    // The list came back with the server's figure still painted on both readings.
    expect(toolBox('read').checked).toBe(false);
    expect(byClass('.tool-tab-button[data-tool="read"]', 'button').dataset.enabled).toBe('false');
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
            return json({ tool: toolRowAnswer('read', false) });
        }

        return undefined;
    }, running);

    await boot();
    await flush();

    // Pending, and the chat's OWN gate stays locked: the composer offers STOP for this
    // conversation's queue. The session surface is no longer locked by a run — switching and
    // creating are view changes, and leaving a conversation only unsubscribes its observer (R4).
    expect(byClass('.composer-action', 'button').dataset.action).toBe('stop');
    expect(byClass('.new-session', 'button').disabled).toBe(false);

    // The tools control answers to `booted` alone, so a run cannot grey it out.
    expect(byClass('.tools-toggle', 'button').disabled).toBe(false);

    openTools();
    await flush();

    expect(byClass('.stage', 'div').querySelector('.tools-pane')).not.toBeNull();
    expect(byClass('.tool-tab-button[data-tool="read"]', 'button').disabled).toBe(false);
    expect(byClass('.tool-tab-enable[data-tool="read"]', 'input').disabled).toBe(false);

    // A row is clickable mid-run: its runner opens over the list, schema read and all.
    byClass('.tool-tab-button[data-tool="toolRequest"]', 'button').click();
    expect(byClass('.dialog-title', 'h2').textContent).toBe('toolRequest');
    byClass('.dialog-close', 'button').click();
    await flush();
    expect(byClass('.stage', 'div').querySelector('.tools-pane')?.isConnected).toBe(true);

    // And the global switch WRITES mid-run — the route has no idle window, and the run in
    // flight keeps the tool list it was already given.
    byClass('.tool-tab-enable[data-tool="read"]', 'input').click();
    await flush();
    await flush();

    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([
        { url: '/api/tools/read', method: 'PATCH', body: { enabled: false } }
    ]);
    expect(byClass('.tool-tab-enable[data-tool="read"]', 'input').checked).toBe(false);
});

// ---------------------------------------------------------------------------
// R5 + R4 (Tools Catalogue): ONE flat A–Z list of the WHOLE catalogue.
//
// The fixture deliberately arrives in the SERVER's order (core tools first, then each
// registration group) and mixes the groups the pane used to break apart with a
// `.tool-tab-group` heading, so the rendered order is evidence about the renderer's sort and
// not about the wire's order.
//
// Two names are a deliberate CASE pair (`appleTool` / `ZebraTool`): a case-SENSITIVE compare
// puts the capital `Z` first, the A–Z the reader asked for puts `appleTool` first, so this
// list proves the compare ignores case. `toolRegistry` before `toolRequest` is the real
// catalogue's own pair, and the reason the compare is code-point rather than `localeCompare`
// (an ICU collator may fold the pair differently across builds).
// ---------------------------------------------------------------------------

// One wire row of one group, in the shape the double answers (`ToolSummary` + `enabled`).
const catalogueRow = (
    name: string,
    group: string,
    visibility: 'core' | 'searchable' = 'searchable'
): WireTool => ({
    name,
    group,
    description: `${name} description`,
    tags: [group.toLowerCase()],
    visibility,
    enabled: true,
    parameters: { type: 'object', properties: {} }
});

it('lists the whole catalogue as ONE alphabetical list with no group headings, and counts what it renders', async () => {
    const served = [
        catalogueRow('toolRegistry', 'Core tools', 'core'),
        catalogueRow('toolRequest', 'Core tools', 'core'),
        catalogueRow('timeNow', 'Core tools', 'core'),
        catalogueRow('noteSearch', 'Harness tools'),
        catalogueRow('diceRoll', 'Harness tools'),
        catalogueRow('search', 'Web search', 'core'),
        catalogueRow('fetch', 'Web fetch', 'core'),
        catalogueRow('ZebraTool', 'Package presets'),
        catalogueRow('appleTool', 'Package presets')
    ];

    stubFetch((url) => (url === '/api' ? json(bootstrap({ tools: served })) : undefined));
    await boot();

    openTools();
    await flush();

    // R5: not ONE group heading in the pane — the "Core tools" / "Package presets" split the
    // reader could not tell apart is gone from this view (the Plugins pane keeps its own
    // sections, and a tool's kind still rides its meta line).
    expect(document.querySelectorAll('.tool-tab-group')).toHaveLength(0);

    // R5: strict A–Z across the whole list, whatever group a row belongs to.
    expect(
        [...document.querySelectorAll<HTMLElement>('.tool-tab-button')].map((node) => node.dataset.tool)
    ).toEqual([
        'appleTool',
        'diceRoll',
        'fetch',
        'noteSearch',
        'search',
        'timeNow',
        'toolRegistry',
        'toolRequest',
        'ZebraTool'
    ]);

    // R4: the head's total is the number of rows on screen. The catalogue that reached the
    // pane IS the catalogue the pane painted, so a page boundary cannot drop rows and still
    // print a confident count (the paging itself is pinned in ./api.test.ts `listAllTools`).
    expect(document.querySelectorAll('.tool-tab-row')).toHaveLength(9);
    expect(document.querySelector('.harness-note')?.textContent).toBe(
        '9 tools · calls run on the harness server'
    );
});

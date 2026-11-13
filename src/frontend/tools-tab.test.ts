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
// R1 + R3 (that pass) — the page is ALWAYS reachable and every row states its switch:
//   - no run gate on the rows or the identified-detail read (`setToolsView`/`selectTool`
//     dropped their `running` guards, and `paintControls` gates the controls on `booted`);
//   - each row carries a corner `input[type=checkbox]` (a `<button>` cannot contain a
//     control, hence the `.tool-tab-row` wrapper and the absolutely positioned box);
//   - EVERY row gets one, the harness-owned core entries included, so there is no
//     affordance-less row shape left.
//
// T4 (this pass) — the pane describes ONE CONVERSATION, not the deployment:
//   - it lists `GET /sessions/{id}/tools` for the conversation the card points at
//     (`src/frontend/main.ts` `configScope`/`loadSessionTools`), read on the pane's FIRST open
//     and dropped on every conversation change, so the rows can never be the previous
//     session's;
//   - the switch writes `PATCH /sessions/{id}/tools/{tool_id}` `{ enabled }` — the conversation
//     only, never `PATCH /tools/{tool_id}` — and repaints from the session re-read that follows
//     the accepted write (`main.ts` `setToolEnabled`/`applySessionToolRows`), which is why every
//     switch assertion below pins a PATCH and the re-read that follows it;
//   - a row the conversation cannot switch (`protected`: the harness declares that control
//     itself — `visibility: 'core'`, or a pending-only runtime control — never merely "declared by
//     the frozen definition"; ../shared/harness-api.ts:1885) renders a LOCKED box, and a run
//     in flight locks every box, because that PATCH answers 403 and 409 respectively;
//   - with NO conversation bound both header toggles are `hidden` (`main.ts` `syncConfigScope`,
//     `styles.css` `.tools-toggle[hidden]`), so these fixtures boot with one session in the
//     roster (`bootstrap` below) — the playground runner's own temporary session is a separate
//     conversation and is still created by the call itself.

import type { HarnessDescriptor, SessionSnapshot, ToolDescriptor } from '../server/protocol';
import type { SessionToolSummary } from '../shared/harness-api';
import type { SessionToolRowSeed } from './session-config-test-support';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sessionConfigDouble, sessionToolPage, sessionToolRow } from './session-config-test-support';
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

// T4: the pane's rows are this CONVERSATION's toolbox, in the spelling `GET /sessions/{id}/tools`
// serves (`SessionToolSummary`, ../shared/harness-api.ts:1852-1900). The three facts a catalogue
// row never carried follow the SERVER's rule (`sessionToolRowsOf`, src/server/api-reads.ts:1003-1032):
// `protected` is the kernel's switchability answer, so a `visibility: 'core'` name is protected and
// every other name here is switchable — `declared` plays no part in it (these fixtures declare
// nothing). The ordinary tools got in through `toolRequest`, so they are `declared: false` +
// `origin: 'discovered'` — the only shape whose PATCH the server accepts, which is what makes the
// switch tests below legal. A core row states `enabled: false` (a core tool never enters the
// enabled set) and is still in context, which is exactly what `toolRowInContext` in main.ts reads.
const sessionRow = (tool: WireTool, overrides: Partial<Omit<SessionToolSummary, 'name'>> = {}): SessionToolRowSeed => ({
    name: tool.name,
    group: tool.group,
    description: tool.description,
    tags: [...tool.tags],
    visibility: tool.visibility,
    session_bound: tool.sessionBound ?? false,
    enabled: tool.visibility === 'core' ? false : tool.enabled,
    declared: false,
    origin: tool.visibility === 'core' ? 'catalogue' : 'discovered',
    protected: tool.visibility === 'core',
    source_available: false,
    ...overrides
});

// The toolbox a fixture's boot tools add up to, in server order (the pane sorts for display).
const sessionRows = (tools: readonly WireTool[]): SessionToolRowSeed[] => tools.map((tool) => sessionRow(tool));

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
    // T4: the ⚒ and ⚙ panes describe the conversation the card points at, and with NO conversation
    // bound both header toggles are `hidden` (main.ts `syncConfigScope`), so a fixture that opens a
    // pane needs one session in the roster. The playground runner's temporary session is a SEPARATE
    // conversation the call itself creates, so binding one here changes nothing about execution.
    sessions: [snapshot()],
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
    runningSession?: SessionSnapshot,
    // T4: the toolbox this conversation's pane lists. It defaults to the boot document's own
    // tools; a test that overrides the boot `tools` page passes the tools that match it, so the
    // list it asserts is the list its server stated. They are given in the boot document's shape
    // because the runner's schema read below answers from the same descriptors.
    sessionTools?: readonly WireTool[]
): Call[] => {
    const calls: Call[] = [];
    const servedTools = sessionTools ?? [toolRequestTool, fileReadTool];
    // The conversation's configuration routes (`GET /sessions/s1/tools`, `PATCH
    // /sessions/s1/tools/{tool}` and the plugin pair) come from the shared double, whose store
    // APPLIES an accepted switch — so the repaint every switch test below asserts is provably
    // the figure the next server read carries, not a client-side guess. See
    // ./session-config-test-support.ts for why its semantics are the server's own.
    const config = sessionConfigDouble({ tools: () => sessionRows(servedTools) });

    // T4: a toolbox page row carries NO argument schema (../shared/harness-api.ts
    // `SessionToolSummary` states none), so the runner pays the deployment's identified detail read
    // (`GET /tools/{name}`, ./api.ts `getTool`) — the schema a manual call is built from is
    // execution, and T4 left execution global. These fixtures answer it from the same descriptor
    // the boot document describes, so the runner's card is the one these tests pinned before the
    // pane moved.
    const detailOf = (name: string): Response | undefined => {
        const tool = servedTools.find((candidate) => candidate.name === name);

        if (tool === undefined) return undefined;

        return json({
            tool: {
                ...tool,
                session_bound: tool.sessionBound ?? false,
                execution: { scope: tool.visibility === 'core' ? 'session_required' : 'global', manual: true }
            }
        });
    };

    const raw = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const method = init?.method;
        const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));

        calls.push({ url, method, body });

        // The test's own route wins, so a refusal (403/409) or a hand-built payload can be pinned
        // per test. A paged read arrives WITH its query string (`?limit=25`, ./api.ts
        // `pageParams`), and these fixtures match pathnames, so the bare spelling is offered as the
        // second attempt — before the shared double, which would otherwise answer its own default
        // page for a route the test means to own.
        const bare = url.split('?')[0];
        const declared =
            handler(url, method, body) ?? (bare === url ? undefined : handler(bare, method, body)) ?? config.respond(url, method, body);

        if (declared !== undefined) return declared;
        // The runner's identified schema read (`GET /api/tools/{name}`, see `detailOf`). It sits
        // after the test's own handler so a fixture that pins that read keeps authority.
        const detailName = /^\/api\/tools\/([^/?]+)$/.exec(bare);

        if (detailName !== null && method === undefined) {
            const answer = detailOf(decodeURIComponent(detailName[1]));

            if (answer !== undefined) return answer;
        }
        if (url === '/api') return json(bootstrap(runningSession === undefined ? {} : { sessions: [runningSession] }));
        if (url === '/api/models') return json({ models: ['m1'] });
        // T4: a boot roster that names a conversation makes the shell OPEN it, and every canonical
        // read of that conversation (the view open, the frozen definition, the history page) is
        // composed from this ONE raw record by ./view-test-support. A fixture whose own handler
        // answers `/api/sessions/s1` stays authoritative.
        if (url === '/api/sessions/s1' && method === undefined) return json({ session: runningSession ?? snapshot() });
        if (url === '/api/sessions' && method === undefined) {
            return json({ sessions: [runningSession ?? snapshot()] });
        }

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

            // T4: the pane's rows are THIS conversation's toolbox (`GET /sessions/s1/tools`), and
            // it is the only thing the double answers here beyond the routes this test already
            // declares — the runner's call routes below are execution, which T4 left alone.
            const configAnswer = sessionConfigDouble({ tools: () => sessionRows([toolRequestTool, fileReadTool]) }).respond(
                url,
                method,
                body
            );

            if (configAnswer !== undefined) return configAnswer;

            // T4: a toolbox page row carries no argument schema, so an opened runner pays the
            // identified detail read (`GET /tools/{name}`, ./api.ts `getTool`) — execution, which
            // T4 left on the deployment surface.
            if (url === '/api/tools/toolRequest' && method === undefined) {
                return json({ tool: { ...toolRequestTool, session_bound: true, execution: { scope: 'session_required', manual: true } } });
            }

            if (url === '/api/tools/read' && method === undefined) {
                return json({ tool: { ...fileReadTool, session_bound: false, execution: { scope: 'global', manual: true } } });
            }

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
    // R4: the head's count and the rendered rows are the SAME figure — the toolbox the server
    // listed for THIS conversation is the toolbox the pane paints, page by page until the cursor
    // runs out (./api.ts `listAllTools`), so nothing is silently truncated at a 25-row page. The
    // sentence names its subject (main.ts `paintToolsHead`): these are the tools of the
    // conversation on screen, not of the deployment.
    expect(document.querySelectorAll('.tool-tab-row')).toHaveLength(2);
    expect(document.querySelector('.harness-note')?.textContent).toBe(
        '2 tools · the toolbox of this conversation'
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
    // One canonical session-row read for the refresh (`GET /v1/harness/sessions/{id}`) plus the
    // one the boot paid to open the conversation it restored, and one frozen-definition read for
    // the discovery line — each exactly once per concern, no storms. T4 bound the conversation at
    // boot (the pane describes it), which is why the session-row figure is two and not one.
    expect(dialed.filter((line) => line === 'GET /v1/harness/sessions/s1')).toHaveLength(2);
    // T4: the toolbox itself is read once for the pane's first open and never again — neither the
    // core call, the refresh it triggers, nor the second selection re-dials it.
    expect(dialed.filter((line) => line === 'GET /v1/harness/sessions/s1/tools?limit=25')).toHaveLength(1);
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
    // T4: the pane lists the bound conversation's toolbox, which the shared stub serves (its own
    // routes are exactly the boot document, the session record the view double composes from, and
    // the toolbox page) — so this test's bespoke "boot + models only" stub is replaced by it.
    stubFetch();

    await boot();

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
        '2 tools · the toolbox of this conversation'
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
        '2 tools · the toolbox of this conversation'
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
        '2 tools · the toolbox of this conversation'
    );
    expect(document.activeElement).toBe(fileReadButton);

    // The list itself never left the stage: the dialog sits over it, not instead.
    expect(document.querySelector('.stage .tools-pane')?.isConnected).toBe(true);
    expect(document.querySelector('.dialog-overlay')).toBeNull();
});

it('shows a server request failure for a core call instead of pretending it ran', async () => {
    // T4: the shared stub carries the bound conversation and its toolbox; this fixture adds only
    // the playground create and the 409 the manual call answers.
    stubFetch((url, method) => {
        if (url === '/api/sessions' && method === 'POST') return json({ session: snapshot() }, 201);

        if (url === '/api/tools/toolRequest' && method === 'POST') {
            // 409: the session is mid-run. The client reports the server's
            // message and must NOT refresh as if the call had applied.
            return json({ error: { message: 'Session "s1" is running; retry when it is idle.' } }, 409);
        }

        return undefined;
    });

    await boot();

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
    // T4: the pane lists the bound conversation's toolbox, so the two tools this fixture cares
    // about are stated twice on purpose — as the deployment catalogue the boot document describes
    // and as the toolbox the conversation's page serves (the third `stubFetch` argument, which
    // also answers the runner's schema read from the same descriptors).
    stubFetch(
        (url) =>
            url === '/api'
                ? json(
                    bootstrap({
                        presets: [
                            descriptor({
                                agents: ['instruct', 'research', 'workspace'],
                                subagents: ['research', 'workspace']
                            })
                        ],
                        tools: [agentDelegateTool, fileReadTool]
                    })
                )
                : undefined,
        undefined,
        [agentDelegateTool, fileReadTool]
    );

    await boot();
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
    // T4: the same shift as the test above — the toolbox page and the runner's schema read are
    // both served from the `[agentDelegateTool]` list this fixture states.
    const calls = stubFetch(
        (url) => (url === '/api' ? json(bootstrap({ tools: [agentDelegateTool] })) : undefined),
        undefined,
        [agentDelegateTool]
    );

    await boot();
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

// T4: every read and write the tools pane makes lives under one path — the bound conversation's
// toolbox — and a paged read carries `?limit=25` (./api.ts `pageParams`). This filter collects
// that traffic IN ORDER, which is what lets the switch tests pin "the write, then the read that
// repaints the row from it" instead of trusting a local flip.
const toolboxTraffic = (calls: readonly Call[]): Call[] =>
    calls.filter((call) => {
        const path = call.url.split('?')[0];

        return path === '/api/sessions/s1/tools' || path === '/api/sessions/s1/tools/read';
    });

// The exact url a toolbox page read is dialled at, query included, because the query is part of
// the contract (`limit` is always sent).
const TOOLBOX_PAGE_URL = '/api/sessions/s1/tools?limit=25';

// The toolbox page one conversation's `GET /sessions/{id}/tools` answers: the same tool
// descriptors the boot document describes, restated in the session row shape
// (`sessionRows` → `sessionToolRow`, ./session-config-test-support.ts).
const toolboxPage = (tools: readonly WireTool[]): Response =>
    json(sessionToolPage(sessionRows(tools).map(sessionToolRow)));

// T4's cache discipline: the toolbox belongs to ONE conversation, so moving the card to another
// conversation must drop the old rows and ask again — never paint a list that belongs to a
// conversation the reader has left.
it('moves to a new conversation without ever painting the previous one’s toolbox', async () => {
    // s2 is a different conversation: the server lists only `read` in its toolbox, and it is not
    // the `read` + `toolRequest` pair the boot conversation (s1) carries.
    const calls = stubFetch((url, method) => {
        if (url === '/api/sessions' && method === 'POST') return json({ session: snapshot({ id: 's2' }) }, 201);

        if (url === '/api/sessions/s2/tools' || url === '/api/sessions/s2/tools?limit=25') return toolboxPage([fileReadTool]);

        return undefined;
    });

    await boot();
    openTools();
    await flush();

    // The conversation the card opened on owns the list: both of its rows, and the read that
    // paid for them names s1.
    expect(
        [...document.querySelectorAll<HTMLElement>('.tool-tab-button')].map((node) => node.dataset.tool)
    ).toEqual(['read', 'toolRequest']);
    expect(calls.filter((call) => call.url === TOOLBOX_PAGE_URL)).toHaveLength(1);

    byClass('.session-new', 'button').click();
    await flush();
    await flush();

    // The pointer was RELEASED for a moment (`+` tears the old conversation down before the
    // server mints the new one), and a released pointer closes the pane (main.ts
    // `syncConfigScope` → `closeConfigPanes`). The chat is back and the new conversation is bound:
    // the pill says s2, and both toggles are rendered again.
    expect(byClass('.session-cycle', 'button').dataset.sessionId).toBe('s2');
    expect(toolsToggle().hasAttribute('hidden')).toBe(false);
    expect(byClass('.tools-toggle', 'button').getAttribute('aria-pressed')).toBe('false');

    // Re-opening is where the cache discipline shows: the pane asks for s2, and the rows it paints
    // are s2's ONE tool — never the pair it was showing a moment ago. `loadSessionTools` would
    // answer from `toolEntries` for a conversation it already read, so reaching the network for
    // s2 at all is the proof `invalidateConfigPanes` ran.
    openTools();
    await flush();

    expect(
        [...document.querySelectorAll<HTMLElement>('.tool-tab-button')].map((node) => node.dataset.tool)
    ).toEqual(['read']);
    expect(document.querySelector('.harness-note')?.textContent).toBe('1 tool · the toolbox of this conversation');
    expect(calls.filter((call) => call.url === TOOLBOX_PAGE_URL)).toHaveLength(1);
    expect(calls.filter((call) => call.url === '/api/sessions/s2/tools?limit=25')).toHaveLength(1);
    // The write route follows the same scope: nothing was written here, and the deployment route
    // is never dialled by this pane.
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([]);
});

it('paints one corner tick box on EVERY row, the harness-owned core row included', async () => {
    const calls = stubFetch();
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
    // honest), the accessible name is the ACTION, and the title states the SCOPE — T4 moved that
    // scope from the deployment to this conversation (main.ts `toolSwitchTitleOf`).
    expect(readSwitch.type).toBe('checkbox');
    expect(readSwitch.checked).toBe(true);
    expect(readSwitch.dataset.enabled).toBe('true');
    expect(readSwitch.getAttribute('role')).toBeNull();
    expect(readSwitch.getAttribute('aria-checked')).toBeNull();
    expect(readSwitch.getAttribute('aria-label')).toBe('Disable read');
    expect(readSwitch.title).toBe(
        'Enabled for this conversation · click to switch this tool off'
    );
    // A control that is neither waiting on its own write nor locked by the conversation, and not
    // yet disabled by the transport.
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

    // T4: the harness-owned core row still gets a box — every row that states an enablement does —
    // but the box is LOCKED. `protected` is the server's figure (src/server/api-reads.ts:1003-1032:
    // the negation of `harness.isToolSwitchable`, so a `visibility: 'core'` control name) and its
    // PATCH answers 403, so main.ts states that refusal on the control before the click instead of
    // after it.
    const coreRow = byClass('.tool-tab-button[data-tool="toolRequest"]', 'button');
    const coreSwitch = toolBox('toolRequest');

    // A core row reads `enabled: false` on the session route and is STILL in context, which is
    // what `toolRowInContext` (main.ts:8752) decides from `protected` — so the tick is on.
    expect(coreRow.dataset.enabled).toBe('true');
    expect(coreSwitch.checked).toBe(true);
    expect(coreSwitch.disabled).toBe(true);
    expect(coreSwitch.getAttribute('aria-label')).toBe('Disable toolRequest');
    expect(coreSwitch.title).toBe(
        'Always in context for this conversation · the harness itself declares it, so it cannot be switched here'
    );

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

    // T4 moved the surface: the row that omits the figure is now a `GET /sessions/s1/tools` row.
    // `enabled` is a REQUIRED field of ../shared/harness-api.ts `SessionToolSummary`, so the
    // fixture drops the KEY the way JSON does — an `undefined` value is omitted by
    // `JSON.stringify`, which is exactly the payload an older server would send.
    const statedRow = { ...sessionToolRow(sessionRow(fileReadTool)), enabled: undefined } as unknown as SessionToolSummary;

    stubFetch((url, method) =>
        url === '/api'
            ? json(bootstrap({ tools: [legacyRow] }))
            : url === '/api/sessions/s1/tools' && method === undefined
              ? json(sessionToolPage([statedRow]))
              : undefined
    );
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

it('switches a tool off and back on with one click, and repaints the row from the conversation re-read', async () => {
    // T4: the switch is this conversation's, and the shared double's store APPLIES the accepted
    // write (./session-config-test-support.ts), so the figure the row repaints below can only come
    // from the `GET /sessions/s1/tools` re-read main.ts performs after the PATCH (`setToolEnabled`
    // → `applySessionToolRows`). No handler below answers a tool route at all.
    const calls = stubFetch();
    // The whole traffic of one switch, in order: the read that opened the pane, then the write and
    // the read that followed it. A local flip with no re-read could not produce this list.
    const traffic = (): Call[] => toolboxTraffic(calls);

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

    // One write, on the SESSION route, with the contract's body (../shared/harness-api.ts
    // `UpdateSessionToolRequest`), and the read that repaints the row after it. The deployment
    // route `PATCH /api/tools/read` is never dialled: this pane cannot move a switch that belongs
    // to every conversation.
    expect(traffic()).toEqual([
        { url: TOOLBOX_PAGE_URL, method: undefined, body: undefined },
        { url: '/api/sessions/s1/tools/read', method: 'PATCH', body: { enabled: false } },
        { url: TOOLBOX_PAGE_URL, method: undefined, body: undefined }
    ]);
    expect(calls.filter((call) => call.url === '/api/tools/read' && call.method === 'PATCH')).toEqual([]);


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

    // A second press inverts what the SERVER reported (the cache moved with the re-read), and the
    // traffic of the second switch is the same write-then-read pair — the pane never paints a
    // figure it did not get back from the conversation's own route.
    control.click();
    await flush();
    await flush();

    expect(calls.filter((call) => call.url === '/api/sessions/s1/tools/read' && call.method === 'PATCH')).toHaveLength(2);
    expect(traffic()).toHaveLength(5);
    expect(control.checked).toBe(true);
    expect(control.className).toBe('tool-tab-enable is-on');
    expect(row.dataset.enabled).toBe('true');
});

it('pulls a refused switch back to the server figure and keeps the server sentence on the pill', async () => {
    // The conversation's own route refuses the write (409 while it is working, 403 for a protected
    // name — ../shared/harness-api.ts:1885). The sentence is the server's, and it is the ONLY new
    // figure the refusal leaves anywhere: nothing was written, and no re-read follows a failure.
    const message = 'read cannot be switched off while this conversation is working.';
    const calls = stubFetch((url, method) => {
        if (url === '/api/sessions/s1/tools/read' && method === 'PATCH') return json({ error: { message } }, 409);

        return undefined;
    });

    await boot();
    openTools();
    await flush();

    const row = byClass('.tool-tab-button[data-tool="read"]', 'button');
    const control = toolBox('read');
    const trafficBefore = toolboxTraffic(calls).length;

    control.click();
    // A native checkbox flipped itself on the click — this is exactly the state a refusal
    // has to undo, and why the busy pass repaints from the cache when it unlocks.
    expect(control.checked).toBe(false);

    await flush();
    await flush();

    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([
        { url: '/api/sessions/s1/tools/read', method: 'PATCH', body: { enabled: false } }
    ]);
    // A refusal wrote nothing, so the pane asks for nothing: the toolbox traffic is exactly the
    // write plus the read that opened the pane, and there is no retry control either.
    expect(toolboxTraffic(calls)).toHaveLength(trafficBefore + 1);
    expect(document.querySelector('.tools-tab-retry')).toBeNull();

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

// ---------------------------------------------------------------------------
// The two row shapes the reader met on a BRAND-NEW conversation (the upgrade regression: a
// checkbox that answered with the top-right `error` pill).
//
// Both fixtures state ONLY the kernel facts a row is derived from — `visibility`, `pendingOnly`,
// `declared` — and let `sessionToolRow` compute `protected` / `enabled` / `origin` the way
// `sessionToolRowsOf` (src/server/api-reads.ts:1003-1032) does. That is deliberate: a fixture that
// hand-states `protected: true` pins its own opinion and cannot catch the rule drifting, while
// these two pin the derivation itself (the first `expect` of each test is the exact row the double
// projects, before the pane ever sees it).
// ---------------------------------------------------------------------------

// The shared double wired into a fixture's OWN handler, so its routes win over `stubFetch`'s
// default toolbox (`stubFetch` tries the test handler first — see its `declared` branch). The
// handler form also hands the test the double itself: `toolRows()` is the payload the pane is
// about to paint, and `toolWrites` is what the server actually received.
const seededFetch = (seeds: readonly SessionToolRowSeed[]) => {
    const config = sessionConfigDouble({ tools: seeds });
    const calls = stubFetch((url, method, body) => config.respond(url, method, body));

    return { calls, config };
};

it('renders a harness-owned row checked and locked, and its press cannot ask the server for a switch', async () => {
    // `delegate` as the live kernel reports it (measured on a real session): harness-owned, NOT
    // declared by the frozen definition, `session_bound: true`, and therefore `protected: true`
    // with `enabled: false`.
    const delegateSeed: SessionToolRowSeed = {
        name: 'delegate',
        group: 'Core tools',
        description: 'Delegate a unit of work to a subagent.',
        tags: ['core', 'harness'],
        visibility: 'core',
        session_bound: true,
        declared: false
    };
    // The other direction of the same rule: `toolCancel` is protected WITHOUT being declared,
    // because its registration is pending-only — its manifest visibility is demoted to
    // `searchable`, which is precisely the case a server-side guess from `visibility` used to get
    // wrong (and the case that made the pane offer a switch the route answers 403 to).
    const cancelSeed: SessionToolRowSeed = {
        name: 'toolCancel',
        group: 'Core tools',
        description: 'Cancel the work this conversation has queued.',
        tags: ['core', 'harness'],
        visibility: 'searchable',
        session_bound: true,
        declared: false,
        pendingOnly: true
    };
    const { calls, config } = seededFetch([delegateSeed, cancelSeed]);

    // The exact rows the double serves — the derivation, not an opinion. `protected` is the
    // negation of switchability in BOTH names (`delegate` by `visibility: 'core'`, `toolCancel` by
    // its pending-only registration), `enabled` is false because a protected name never enters the
    // capped set, and `origin` is `catalogue` for both — `discovered` is an ENABLED name this
    // session did not declare, and neither of these holds a slot.
    expect(config.toolRows()).toEqual([
        {
            name: 'delegate',
            group: 'Core tools',
            description: 'Delegate a unit of work to a subagent.',
            tags: ['core', 'harness'],
            visibility: 'core',
            session_bound: true,
            enabled: false,
            session_id: 's1',
            declared: false,
            origin: 'catalogue',
            protected: true,
            source_available: false
        },
        {
            name: 'toolCancel',
            group: 'Core tools',
            description: 'Cancel the work this conversation has queued.',
            tags: ['core', 'harness'],
            visibility: 'searchable',
            session_bound: true,
            enabled: false,
            session_id: 's1',
            declared: false,
            origin: 'catalogue',
            protected: true,
            source_available: false
        }
    ]);

    await boot();
    openTools();
    await flush();

    // `name:checked:disabled` for every row: both are ticked ON (`main.ts` `toolRowInContext` reads
    // `protected`, so a harness-owned name shows as in context whatever `enabled` says) and both
    // are LOCKED. Nothing here is clickable-but-off.
    expect(
        [...document.querySelectorAll<HTMLElement>('.tool-tab-row')].map((node) => {
            const box = node.querySelector<HTMLInputElement>('.tool-tab-enable');

            return `${node.querySelector('.tool-tab-button')?.dataset.tool}:${String(box?.checked)}:${String(box?.disabled)}`;
        })
    ).toEqual(['delegate:true:true', 'toolCancel:true:true']);

    // The lock says WHY, in the reader's terms — and the reason is the harness, not the team that
    // wrote this conversation's definition.
    const delegate = toolBox('delegate');

    expect(delegate.className).toBe('tool-tab-enable is-on');
    expect(delegate.dataset.enabled).toBe('true');
    expect(delegate.getAttribute('aria-label')).toBe('Disable delegate');
    expect(delegate.title).toBe(
        'Always in context for this conversation · the harness itself declares it, so it cannot be switched here'
    );

    // Two presses, in the two ways a press can arrive.
    //
    // The NATIVE one first: a disabled control swallows the click (real hit-testing, and jsdom's
    // `HTMLElement.click()` implements the same rule), so the row cannot move at all.
    delegate.click();
    toolBox('toolCancel').click();
    await flush();

    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([]);
    expect(toolBox('delegate').checked).toBe(true);
    expect(toolBox('toolCancel').checked).toBe(true);

    // A DISPATCHED click gets past the disabled control — the path a scripted reader, or a frame
    // that painted the box before its lock did, takes — so this is main.ts's own guard under test
    // (`if (row.protected === true) return`, main.ts:8722): no write leaves the pane. The native
    // checkbox still flips its own `checked` on a synthesized click and the guard returns before
    // any repaint, so the DOM figure is re-based by the next paint pass rather than by this click;
    // what may never change is the traffic and the pill, and those are what the reader's complaint
    // is about.
    delegate.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    toolBox('toolCancel').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    await flush();

    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([]);
    expect(config.toolWrites).toEqual([]);
    // The pill is the ONLY place a refusal could appear, and there is no refusal: the state is
    // still the idle one boot left, with no diagnostic under it. The pane itself keeps its
    // deliberate shape — no inline error line, no retry control, head = title only — which is the
    // layout the reader asked for (main.ts `setToolEnabled`'s catch reports on the pill alone).
    expect(byClass('.status-text', 'span').textContent).toBe('idle');
    expect(byClass('.status-detail', 'span').textContent).toBe('');
    expect(document.querySelector('.tools-tab-note')).toBeNull();
    expect(document.querySelector('.tools-tab-hint')).toBeNull();
    expect(document.querySelector('.tools-tab-retry')).toBeNull();
    expect([...byClass('.tools-tab-head', 'div').children].map((node) => node.className)).toEqual(['tools-tab-title']);
});

it('renders a brand-new session with every switchable box on, and switches one of them with one accepted write', async () => {
    // The seed a brand-new conversation ships with: `enableAllTools` (src/harness.ts:12046-12048,
    // set by `src/server/sessions.ts:2204` for a CREATE and for a RESTORE (`:3843`), and re-run by
    // `:10204` for a RESET) puts
    // every globally-enabled
    // SWITCHABLE registration in the capped set, so each row below must arrive
    // `enabled: true` / `protected: false` without a fixture saying so.
    const seededFetchRows: readonly SessionToolRowSeed[] = [
        { name: 'glob', group: 'Files', description: 'List files by pattern.', tags: ['files'], visibility: 'searchable', declared: false },
        { name: 'read', group: 'Files', description: 'Read one or more files.', tags: ['files', 'read'], visibility: 'searchable', declared: false },
        // Declared by the frozen definition AND switchable (`syntax` is in the definition's
        // `coreTools` and the kernel lets the session switch it): `declared` does NOT lock the row,
        // and because it is enabled-but-declared its `origin` is `catalogue`, not `discovered`.
        { name: 'syntax', group: 'Core tools', description: 'Check a file for syntax errors.', tags: ['core'], visibility: 'searchable', declared: true }
    ];
    const { calls, config } = seededFetch(seededFetchRows);

    // `name:enabled:protected:declared:origin` — the whole toolbox the pane is about to paint.
    expect(config.toolRows().map((row) => [row.name, row.enabled, row.protected, row.declared, row.origin])).toEqual([
        ['glob', true, false, false, 'discovered'],
        ['read', true, false, false, 'discovered'],
        ['syntax', true, false, true, 'catalogue']
    ]);

    await boot();
    openTools();
    await flush();

    // R1: every box is ON and every box is togglable — no row on a fresh conversation can produce
    // the refusal the reader hit.
    expect(
        [...document.querySelectorAll<HTMLElement>('.tool-tab-row')].map((node) => {
            const box = node.querySelector<HTMLInputElement>('.tool-tab-enable');

            return `${node.querySelector('.tool-tab-button')?.dataset.tool}:${String(box?.checked)}:${String(box?.disabled)}`;
        })
    ).toEqual(['glob:true:false', 'read:true:false', 'syntax:true:false']);
    expect(toolBox('read').title).toBe('Enabled for this conversation · click to switch this tool off');

    toolBox('read').click();
    await flush();
    await flush();

    // The write, on the conversation's route, and the re-read that repaints it — in that order.
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([
        { url: '/api/sessions/s1/tools/read', method: 'PATCH', body: { enabled: false } }
    ]);
    expect(toolboxTraffic(calls)).toHaveLength(3);
    expect(config.toolWrites).toEqual([{ name: 'read', body: { enabled: false } }]);

    // The row moves to the figure the next read states, and the read re-derives `origin` with it
    // (a name that is no longer enabled is not `discovered`). The other boxes are untouched.
    expect(config.toolRows().map((row) => [row.name, row.enabled, row.protected, row.origin])).toEqual([
        ['glob', true, false, 'discovered'],
        ['read', false, false, 'catalogue'],
        ['syntax', true, false, 'catalogue']
    ]);
    expect(toolBox('read').checked).toBe(false);
    expect(toolBox('read').className).toBe('tool-tab-enable is-off');
    expect(toolBox('read').dataset.enabled).toBe('false');
    expect(toolBox('read').getAttribute('aria-label')).toBe('Enable read');
    expect(toolBox('glob').checked).toBe(true);
    expect(toolBox('syntax').checked).toBe(true);
    expect(byClass('.tool-tab-button[data-tool="read"]', 'button').dataset.enabled).toBe('false');
    // An accepted switch says so on the pill the way every other accepted write does: `idle`, with
    // no diagnostic line — the error pill stays reserved for a refusal.
    expect(byClass('.status-text', 'span').textContent).toBe('idle');
    expect(byClass('.status-detail', 'span').textContent).toBe('');
});

// F2-3 — the figure the reader asked for, rendered from the payload the SERVER actually answers.
//
// The row list below is MEASURED, not invented: `Temp/final2/f23-probe.ts` boots the real
// in-process server, creates a session the way `POST /sessions` does, and reads
// `GET /v1/harness/sessions/{id}/tools?limit=100` (a keyless host, so the three search credential
// tools stay unregistered). That run answers 32 rows — 22 `enabled: true` / `protected: false` /
// `origin: 'discovered'`, 10 `enabled: false` / `protected: true` / `origin: 'catalogue'` — and the
// capture is kept in `Temp/final2/f23-rows.json`. The seeds here restate the KERNEL facts those
// figures come from (`visibility: 'core'` for the eight declared controls, `pendingOnly` for
// `toolCancel`, searchable-and-undeclared for the rest) and the shared double derives the wire
// row, so the payload this test paints is the payload the route answers, field for field.
//
// What is pinned is the pane's own two figures, NOT a translation of them: every box TICKED
// (`main.ts` `toolRowInContext` — a protected name is in context because the harness holds it, and
// the reader's complaint was a page that looked empty) and EXACTLY the ten protected boxes LOCKED
// (`toolSwitchLockOf` — the box that 403s is disabled before the click, which is the other half of
// the complaint: pressing `delegate` used to produce a refusal).
const hostRow = (name: string, over: Partial<SessionToolRowSeed> = {}): SessionToolRowSeed => ({
    name,
    group: 'Preset tools',
    description: `${name} preset tool`,
    tags: ['preset'],
    visibility: 'searchable',
    declared: false,
    ...over
});

// The 32 registrations of the measured keyless host, IN SERVER ORDER (registry order).
const MEASURED_SEEDS: readonly SessionToolRowSeed[] = [
    hostRow('toolRegistry'),
    hostRow('toolRequest', { visibility: 'core', declared: true }),
    hostRow('toolList'),
    hostRow('toolManage'),
    hostRow('toolCreate'),
    hostRow('records'),
    hostRow('tasks', { visibility: 'core', declared: true }),
    hostRow('profiles'),
    hostRow('chapters'),
    hostRow('locations'),
    hostRow('agentManage'),
    hostRow('agentResult'),
    hostRow('delegate', { visibility: 'core', declared: true }),
    hostRow('threadFork'),
    hostRow('actionRequest'),
    // Protected WITHOUT being declared — a pending-only runtime control (`main.ts` reads the same
    // figure through the row's `protected`, never by guessing from `visibility`).
    hostRow('toolCancel', { pendingOnly: true }),
    hostRow('syntax'),
    hostRow('read', { visibility: 'core', declared: true }),
    hostRow('write', { visibility: 'core', declared: true }),
    hostRow('edit', { visibility: 'core', declared: true }),
    hostRow('files'),
    hostRow('glob', { visibility: 'core', declared: true }),
    hostRow('grep', { visibility: 'core', declared: true }),
    hostRow('shell'),
    hostRow('gitDiff'),
    hostRow('download'),
    hostRow('timeNow'),
    hostRow('textCount'),
    hostRow('diceRoll'),
    hostRow('noteSearch'),
    hostRow('textSummarize'),
    // A core-visibility row that the frozen definition does NOT declare: protected, not declared.
    hostRow('fetch', { visibility: 'core' })
];

// The ten rows the harness owns itself — the exact set the probe reported as `protected: true`.
const PROTECTED_HOST_NAMES = ['delegate', 'edit', 'fetch', 'glob', 'grep', 'read', 'tasks', 'toolCancel', 'toolRequest', 'write'];

it('paints the measured 32-row new-session payload with every box ticked and exactly the ten protected boxes locked', async () => {
    const { config } = seededFetch(MEASURED_SEEDS);

    // The payload first: the 32 rows the pane is about to paint, in server order, exactly as the
    // measured route stated them. Any drift in the doubles' derivation shows up here as a name
    // moving between the enabled and the protected figure — which is the bug the report was about.
    expect(config.toolRows().map((row) => `${row.name}:${String(row.enabled)}:${String(row.protected)}:${row.origin}`)).toEqual([
        'toolRegistry:true:false:discovered',
        'toolRequest:false:true:catalogue',
        'toolList:true:false:discovered',
        'toolManage:true:false:discovered',
        'toolCreate:true:false:discovered',
        'records:true:false:discovered',
        'tasks:false:true:catalogue',
        'profiles:true:false:discovered',
        'chapters:true:false:discovered',
        'locations:true:false:discovered',
        'agentManage:true:false:discovered',
        'agentResult:true:false:discovered',
        'delegate:false:true:catalogue',
        'threadFork:true:false:discovered',
        'actionRequest:true:false:discovered',
        'toolCancel:false:true:catalogue',
        'syntax:true:false:discovered',
        'read:false:true:catalogue',
        'write:false:true:catalogue',
        'edit:false:true:catalogue',
        'files:true:false:discovered',
        'glob:false:true:catalogue',
        'grep:false:true:catalogue',
        'shell:true:false:discovered',
        'gitDiff:true:false:discovered',
        'download:true:false:discovered',
        'timeNow:true:false:discovered',
        'textCount:true:false:discovered',
        'diceRoll:true:false:discovered',
        'noteSearch:true:false:discovered',
        'textSummarize:true:false:discovered',
        'fetch:false:true:catalogue'
    ]);

    await boot();
    openTools();
    await flush();

    // Every row reaches the pane: the page read is `?limit=25`, so this also proves the cursor
    // walk (`main.ts` `readSessionToolRows`) followed the page instead of stopping at 25 rows.
    const painted = [...document.querySelectorAll<HTMLElement>('.tool-tab-row')].map((node) => {
        const box = node.querySelector<HTMLInputElement>('.tool-tab-enable')!;

        return { name: box.dataset.tool ?? '', checked: box.checked, disabled: box.disabled, title: box.title };
    });

    expect(painted).toHaveLength(32);
    // The complaint in one figure: on a brand-new conversation NO row is off.
    expect(painted.filter((row) => !row.checked).map((row) => row.name)).toEqual([]);
    // ...and the complaint that `delegate` errors when pressed: exactly the ten names the route
    // 403s are the ten boxes that cannot be pressed.
    expect(painted.filter((row) => row.disabled).map((row) => row.name).sort()).toEqual(PROTECTED_HOST_NAMES);

    // The two tooltip sentences, stated per row rather than counted: a locked box says WHY the
    // harness holds it, a live box says it can be switched off. A protected row that read as
    // "disabled, click to switch it on" is the lie this pass exists to remove.
    for (const row of painted) {
        expect(row.title).toBe(
            PROTECTED_HOST_NAMES.includes(row.name)
                ? 'Always in context for this conversation · the harness itself declares it, so it cannot be switched here'
                : 'Enabled for this conversation · click to switch this tool off'
        );
    }

    // The row SET is A–Z (R5), and the head note counts what it renders — both halves of "32 rows"
    // the reader can see, pinned so a page-walk regression cannot quietly drop seven rows off the
    // pane (`main.ts` `paintToolsHead` writes the count line).
    expect(painted.map((row) => row.name)).toEqual([...MEASURED_SEEDS.map((seed) => seed.name)].sort((left, right) => left.localeCompare(right)));
    expect(byClass('.harness-note', 'p').textContent).toBe('32 tools · the toolbox of this conversation');
});

// R1's click separation: the box and the tile are two controls in one row, and each owns
// exactly one of the two actions.
it('writes enablement from the corner box without opening the runner, and the tile click still opens it', async () => {
    // T4: the corner box writes the conversation (`PATCH /sessions/s1/tools/read`, answered by the
    // shared double), while the TILE still pays the deployment's identified detail read for the
    // runner's schema — that read is execution, and T4 left it global.
    const calls = stubFetch((url, method) => {
        if (url === '/api/tools/read' && method === undefined) return json({ tool: toolRowAnswer('read', false) });

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

    // The write went, on the conversation's route, and NO runner layer was adopted over the list.
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([
        { url: '/api/sessions/s1/tools/read', method: 'PATCH', body: { enabled: false } }
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

it('keeps the tools page and its rows usable while a run is pending, and locks every switch that route would refuse', async () => {
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

    const calls = stubFetch(
        (url, method) => {
            if (url === '/api/sessions/s1' && method === undefined) return json({ session: running });
            if (url === '/api/sessions' && method === undefined) return json({ sessions: [running] });

            return undefined;
        },
        running
    );

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

    // T4: the SWITCH is a different story. `PATCH /sessions/{id}/tools/{id}` answers 409 unless the
    // session is idle (../shared/harness-api.ts:1873, `assertIdleForToolMutation` in
    // src/server/api.ts), so main.ts states that rule on the control BEFORE the click
    // (`toolSwitchLockOf` → 'running') instead of taking the refusal on the chin afterwards.
    const runningSwitch = byClass('.tool-tab-enable[data-tool="read"]', 'input');

    expect(runningSwitch.disabled).toBe(true);
    expect(runningSwitch.title).toBe('This conversation is working · the switch unlocks when its run ends');

    // A row is clickable mid-run: its runner opens over the list, schema read and all.
    byClass('.tool-tab-button[data-tool="toolRequest"]', 'button').click();
    expect(byClass('.dialog-title', 'h2').textContent).toBe('toolRequest');
    byClass('.dialog-close', 'button').click();
    await flush();
    expect(byClass('.stage', 'div').querySelector('.tools-pane')?.isConnected).toBe(true);

    // A locked native control swallows the press, so the run costs the conversation no write and
    // no 409: the toolbox traffic of this fixture is the single read that opened the pane.
    runningSwitch.click();
    await flush();
    await flush();

    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([]);
    // The whole toolbox traffic of this fixture is the ONE read that opened the pane: the locked
    // control costs the conversation no write and no 409 round-trip.
    expect(toolboxTraffic(calls)).toEqual([{ url: TOOLBOX_PAGE_URL, method: undefined, body: undefined }]);
    expect(byClass('.tool-tab-enable[data-tool="read"]', 'input').checked).toBe(true);
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

    // T4: the rows the pane lists are the CONVERSATION's, so the toolbox served for this fixture
    // is the same nine-name catalogue, restated as session rows (`sessionRow` states the server's
    // switchability figure for `protected`: the `visibility: 'core'` names, and only those).
    stubFetch((url) => (url === '/api' ? json(bootstrap({ tools: served })) : undefined), undefined, served);
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
        '9 tools · the toolbox of this conversation'
    );
});

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
// `.harness-id` badge HIDDEN, plus the count note) and the corner `.tool-tab-info` control
// of one entry opens the runner inside the shared
// `.dialog` (`.dialog-title` = tool name, `.tool-runner-slot > .pane > .log-wrap >
// .log > .tool-card`).
// The runner therefore does not exist in the document until a row's info mark is clicked —
// every test that reads `.tool-args` clicks `.tool-tab-info` first.
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
//   - each row is a `.tool-tab-row` WRAPPER holding two SIBLINGS — the tile button and the
//     corner control — because a `<button>` cannot contain a control, and CSS positions the
//     corner control absolutely in the wrapper's top-right corner (`z-index` lifts it above
//     the tile, which is what keeps the two activations apart);
//   - EVERY row gets a corner control, the harness-owned core entries included, so there is
//     no affordance-less row shape left.
//
// R1 (this pass — the SWAP) — the two activations changed places:
//   - the TILE (`.tool-tab-button`) is the enable/disable switch: its `aria-pressed` IS the
//     enabled figure (the same figure as the row's green `data-enabled` edge), its click
//     writes `PATCH /sessions/{id}/tools/{tool_id}` `{ enabled }`, and it carries no
//     `aria-haspopup` any more;
//   - the corner control (`.tool-tab-info`) is an INFO BUTTON that opens the tool dialog —
//     the mark where the tick box used to be. It carries `aria-haspopup="dialog"`, the
//     accessible name `Details for <tool>`, and `aria-expanded`/`data-open` while its dialog
//     is open, and it is the dialog's `returnFocus` target;
//   - R4 (the reader's "green border is enough"): the pane prints NO sentence about a switch. An
//     accepted write is stated by the tile's green edge alone, and a REFUSED one by the row's own
//     corner mark: `data-toggle="error"` plus the warning glyph from `ui/info-icon.ts`, with the
//     server's sentence folded into that control's accessible name and `title`
//     (`Details for <tool> · switch failed: <server sentence>`) and kept verbatim on the topbar
//     pill. The figure clears when that row's NEXT attempt starts and when the list is rebuilt, and
//     it never sits on a row that later succeeded. The PLUGINS pane wears the identical figure
//     (`./plugins-tab.test.ts`), and its old footer sentence is cleared rather than written;
//   - the tick box (`input.tool-tab-enable`) is GONE: no `checked`, no `is-on`/`is-off`
//     class, no `Enable <tool>`/`Disable <tool>` label. A row that is not switchable keeps
//     its explanation on the TILE as an `aria-disabled` + `data-locked="<reason>"` pair plus
//     the existing `title` — never the `disabled` attribute, because the tile stays focusable
//     and the info mark must still open the dialog;
//   - a row whose server states NO enablement (`enabled === undefined`) falls back: the tile
//     opens the dialog like it always did, and the row still gets its info mark. A DIRECT
//     listing (no conversation bound, so `setToolEnabled` has nowhere to write) falls back the
//     same way — the tile is never a click that silently does nothing.
//
// R5 (this pass) — EVERY registered tool is switchable for this conversation:
//   - the `protected` lock reason and the `running` lock reason are GONE from the pane's
//     vocabulary. `data-locked` now names only `writing` (this tile's own PATCH), `offline` (no
//     transport) and `no-enablement` (a server that reported no figure), and the same sentence
//     pair is pinned in ./compact-ui.test.ts;
//   - a `visibility: 'core'` name (`write`) and the pending-only `toolCancel` toggle exactly like
//     any other row: the tile is not `aria-disabled`, the press sends the PATCH, and the shared
//     double answers it 200 — `protected` is the wire's UNREGISTER axis now, not a refusal;
//   - a conversation with work queued does NOT lock a switch: the `enabled` route is write-anytime
//     and the figure lands on the agents' next turn (pinned by the run-pending test below, which
//     now writes instead of swallowing the press);
//   - the tooltip states what the switch actually does — this conversation's agents and threads,
//     from their next turn, without stopping another tool calling it or a direct REST call running
//     it — and no row says it "cannot be switched here" unless its server really stated no figure.
//
// T4 (that pass) — the pane describes ONE CONVERSATION, not the deployment:
//   - it lists `GET /sessions/{id}/tools` for the conversation the card points at
//     (`src/frontend/main.ts` `configScope`/`loadSessionTools`), read on the pane's FIRST open
//     and dropped on every conversation change, so the rows can never be the previous
//     session's;
//   - the switch writes `PATCH /sessions/{id}/tools/{tool_id}` `{ enabled }` — the conversation
//     only, never `PATCH /tools/{tool_id}` — and repaints from the session re-read that follows
//     the accepted write (`main.ts` `setToolEnabled`/`applySessionToolRows`), which is why every
//     switch assertion below pins a PATCH and the re-read that follows it;
//   - R5: the row's `protected` figure is the wire's UNREGISTER axis ("this name cannot be removed
//     from the registry"), NOT a reason the pane can refuse its own press. It never locks a tile,
//     and the PATCH answers 200 for it. The route has no idle window either, so a run never locks a
//     switch (main.ts `toolSwitchLockOf`);
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
// The two glyphs a row's corner mark can wear (./ui/info-icon.ts). R4 states the failure figure as
// DATA — the warning path mounted under a `data-toggle='error'` hook — rather than as a colour no
// jsdom run can compute.
import { INFO_ICON_PATH, WARNING_ICON_PATH } from './ui/info-icon';

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
// WIRE does — a `ToolRowEntry` in main.ts's spelling — and a row without it renders no
// enabled figure at all (and its tile falls back to opening the dialog; see the
// `enabled === undefined` case pinned below). There is NO pinned-set field: every entry,
// core tools included, is switchable, and the frontend reads no such figure.
type WireTool = ToolDescriptor & { enabled: boolean };

// A harness-owned core entry. R5: `visibility: 'core'` is the UNREGISTER axis — it says the name
// cannot be removed from this conversation's registry, and nothing else. The row ships enabled like
// every other row, its tile is pressable, and the PATCH for it answers 200 (see the `write` test
// below, the regression this pass exists to pin: `write` used to render LOCKED).
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

// T4 (that pass): the pane's rows are this CONVERSATION's toolbox, in the spelling
// `GET /sessions/{id}/tools` serves (`SessionToolSummary`, ../shared/harness-api.ts). The three
// facts a catalogue row never carried follow the SERVER's rule (`sessionToolRowsOf`,
// src/server/api-reads.ts):
//   - `enabled` IS the gate's figure and comes straight from the wire row above. R5 removed the
//     old `visibility === 'core' ? false : …` translation: a core name is reported ON by a fresh
//     conversation exactly like any other, and a row reads off only because it was withheld or has
//     no free slot;
//   - `protected` is the UNREGISTER axis — `visibility: 'core'` here — and no longer makes a tile
//     locked or refused;
//   - `origin` is left to `sessionToolRow` to derive, because `discovered` is simply "enabled and
//     not declared" — which is now true of the core names in these fixtures too.
// These fixtures declare nothing, and `declared` was never a switch reason either.
const sessionRow = (tool: WireTool, overrides: Partial<Omit<SessionToolRowSeed, 'name'>> = {}): SessionToolRowSeed => ({
    name: tool.name,
    group: tool.group,
    description: tool.description,
    tags: [...tool.tags],
    visibility: tool.visibility,
    session_bound: tool.sessionBound ?? false,
    enabled: tool.enabled,
    declared: false,
    protected: tool.visibility === 'core',
    source_available: false,
    ...overrides
});

// The toolbox a fixture's boot tools add up to, in server order (the pane sorts for display).
const sessionRows = (tools: readonly WireTool[]): SessionToolRowSeed[] => tools.map((tool) => sessionRow(tool));

// The two tooltip sentences a live tile carries, written out VERBATIM rather than imported: R5 is a
// copy change, and a test that imports the constant it pins can never disagree with it. They are
// main.ts's `TOOL_ENABLED_TITLE` and `TOOL_DISABLED_TITLE`, and between them they state the three
// facts the switch actually has — the scope (this conversation's agents and threads), the timing
// (their NEXT turn, running or idle), and the limit (another tool calling it internally, or a direct
// REST call, still runs it). Nothing here says a name "cannot be switched": only a server that
// reports no figure at all earns that (`no-enablement`, pinned on its own test below).
const ENABLED_TITLE =
    'Enabled for this conversation · click to switch it off · the switch covers this conversation’s agents and threads, applies from their next turn whether a thread is running or idle, and does not stop another tool calling it or a direct REST call running it';

const DISABLED_TITLE =
    'Disabled for this conversation · click to switch it on · the switch covers this conversation’s agents and threads, applies from their next turn whether a thread is running or idle, and does not stop another tool calling it or a direct REST call running it · a name can be off because this conversation switched it off or because its toolbox has no free slot';

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

    // Activating the core entry's corner mark adopts the persistent runner into the shared
    // modal. A core tool reports its session context before anything is created.
    document.querySelector<HTMLButtonElement>('.tool-tab-info[data-tool="toolRequest"]')?.click();

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

    // An ordinary tool is unchanged: no sessionId key, no extra session traffic. The runner
    // is opened by the row's info mark, never by the tile (that press would write).
    document.querySelector<HTMLButtonElement>('.tool-tab-info[data-tool="read"]')?.click();
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
// one-at-a-time replacement, and the close reset (head back to the catalogue, the open
// figure cleared on the corner mark, focus back on the mark that opened it) — plus the
// R1 swap's two markup halves: the mark advertises the popup, the tile does not.
it('opens the tool runner from a row mark in the shared dialog and restores the list on close', async () => {
    // T4: the pane lists the bound conversation's toolbox, which the shared stub serves (its own
    // routes are exactly the boot document, the session record the view double composes from, and
    // the toolbox page) — so this test's bespoke "boot + models only" stub is replaced by it.
    // The calls are kept because the dialog path must cost this conversation NO write: after
    // the swap, opening a runner is never a PATCH, whatever the fixture answers.
    const calls = stubFetch();

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

    const readTile = toolTile('read');
    const requestTile = toolTile('toolRequest');
    const toolRequestButton = toolInfo('toolRequest');
    const fileReadButton = toolInfo('read');

    // R1 (swap): every row advertises the popup on its CORNER MARK and starts collapsed. The
    // mark is a real `<button>` with a real accessible name (an icon-only control is never
    // unnamed in this UI), and its glyph is decorative.
    expect(toolRequestButton.type).toBe('button');
    expect(toolRequestButton.getAttribute('aria-haspopup')).toBe('dialog');
    expect(toolRequestButton.getAttribute('aria-expanded')).toBe('false');
    expect(toolRequestButton.dataset.open).toBeUndefined();
    expect(toolRequestButton.getAttribute('aria-label')).toBe('Details for toolRequest');
    expect(toolRequestButton.title).toBe('Details for toolRequest');
    expect(toolRequestButton.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    // The tile no longer advertises the layer at all, and its `aria-pressed` is the ENABLED
    // figure — both rows of this fixture are enabled, so both start pressed.
    expect(readTile.getAttribute('aria-haspopup')).toBeNull();
    expect(readTile.getAttribute('aria-pressed')).toBe('true');
    expect(requestTile.getAttribute('aria-pressed')).toBe('true');

    toolRequestButton.click();

    // Exactly one dialog, named after the tool, with the runner adopted inside it. The mark
    // that opened it is the control that reports it — on the tile, opening a dialog says
    // nothing about enablement, so its `aria-pressed` cannot move.
    expect(document.querySelectorAll('.dialog')).toHaveLength(1);
    expect(byClass('.dialog-title', 'h2').textContent).toBe('toolRequest');
    expect(
        document.querySelector('.dialog .tool-runner-slot > .pane > .log-wrap > .log > .tool-card')
    ).not.toBeNull();
    expect(toolRequestButton.getAttribute('aria-expanded')).toBe('true');
    expect(toolRequestButton.dataset.open).toBe('true');
    expect(fileReadButton.getAttribute('aria-expanded')).toBe('false');
    expect(requestTile.getAttribute('aria-pressed')).toBe('true');
    expect(readTile.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.main-title')?.textContent).toBe('toolRequest');
    expect(document.querySelector('.harness-id')?.textContent).toBe('Core tools');
    expect(document.querySelector('.harness-note')?.textContent).toBe(
        'core · tags: core, harness · session-bound'
    );

    // A second selection REPLACES the layer instead of stacking a second one, and the single
    // "open" figure moves with it.
    fileReadButton.click();

    expect(document.querySelectorAll('.dialog')).toHaveLength(1);
    expect(byClass('.dialog-title', 'h2').textContent).toBe('read');
    expect(toolRequestButton.getAttribute('aria-expanded')).toBe('false');
    expect(toolRequestButton.dataset.open).toBeUndefined();
    expect(fileReadButton.getAttribute('aria-expanded')).toBe('true');
    expect(fileReadButton.dataset.open).toBe('true');
    expect(document.querySelector('.main-title')?.textContent).toBe('read');
    expect(document.querySelector('.harness-id')?.textContent).toBe('Files');
    expect(document.querySelector('.harness-note')?.textContent).toBe('searchable · tags: files, read');

    // `.dialog-close` removes the layer, resets the open figure, repaints the
    // catalogue head and hands focus back to the mark that opened it.
    byClass('.dialog-close', 'button').click();

    expect(document.querySelector('.dialog')).toBeNull();
    expect(fileReadButton.getAttribute('aria-expanded')).toBe('false');
    expect(fileReadButton.dataset.open).toBeUndefined();
    // R2: the catalogue head says "Tools Catalogue" and keeps the shared badge hidden.
    expect(document.querySelector('.main-title')?.textContent).toBe('Tools Catalogue');
    expect(byClass('.harness-id', 'span').hidden).toBe(true);
    expect(byClass('.harness-id', 'span').textContent).toBe('');
    expect(document.querySelector('.harness-note')?.textContent).toBe(
        '2 tools · the toolbox of this conversation'
    );
    expect(document.activeElement).toBe(fileReadButton);

    // Escape is the other dismissal path and converges on the same reset: the mark collapses,
    // the tile keeps the enabled figure it never lost, and focus is back on the mark.
    fileReadButton.click();
    expect(document.querySelectorAll('.dialog')).toHaveLength(1);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(document.querySelector('.dialog')).toBeNull();
    expect(fileReadButton.getAttribute('aria-expanded')).toBe('false');
    expect(fileReadButton.dataset.open).toBeUndefined();
    expect(readTile.getAttribute('aria-pressed')).toBe('true');
    expect(readTile.dataset.enabled).toBe('true');
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
    // And the whole dialog round trip cost this conversation NO write: five opens/closes of
    // two runners, and not one PATCH (the tile is the only control that writes).
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([]);
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

    // The runner only exists inside the modal now, so the entry's info mark must be pressed first.
    document.querySelector<HTMLButtonElement>('.tool-tab-info[data-tool="toolRequest"]')?.click();

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
    document.querySelector<HTMLButtonElement>('.tool-tab-info[data-tool="delegate"]')?.click();

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
    document.querySelector<HTMLButtonElement>('.tool-tab-info[data-tool="delegate"]')?.click();

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

// The corner INFO button of one row (R1 swap): a `<button>` whose one action is opening
// that tool's runner dialog. The tile — `toolTile` below — is the enable/disable switch now.
const toolInfo = (name: string): HTMLButtonElement =>
    byClass(`.tool-tab-info[data-tool="${name}"]`, 'button');

// One corner mark as DATA (R4): the state hook it carries and the glyph it is WEARING. The PAIR is
// the contract — the sheet paints only `data-toggle`, so a warning path with no hook (or a hook
// with the resting path) is a mark whose shape and colour disagree. The plugin pane's test file
// pins the same pair for its own marks (./plugins-tab.test.ts `markState`).
const markState = (control: HTMLButtonElement): string =>
    `${control.dataset.toggle ?? 'idle'}:${control.querySelector('path')?.getAttribute('d') === WARNING_ICON_PATH ? 'warning' : 'info'}`;

// The mark's accessible name and its tooltip, stated together: this UI's rule is that a `title` is
// never the only signal, so the two carry the SAME words — in the failure state, the server's
// sentence along with them.
const markNaming = (control: HTMLButtonElement): string[] => [
    control.getAttribute('aria-label') ?? '',
    control.title
];

// The tile of one row: the control that carries the enabled figure (`aria-pressed` +
// `data-enabled`) and performs the conversation's `PATCH` when it is pressed.
const toolTile = (name: string): HTMLButtonElement =>
    byClass(`.tool-tab-button[data-tool="${name}"]`, 'button');

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

it('paints one corner info button on EVERY row, the harness-owned core row included', async () => {
    const calls = stubFetch();
    await boot();

    openTools();
    await flush();

    // Every row is a wrapper holding the toggle tile and its info mark as SIBLINGS — a
    // `<button>` cannot contain a control — and the rows run A–Z by tool name (R5: one flat
    // list, no group headings; the server's core-first order is not what the reader sees).
    expect(
        [...document.querySelectorAll<HTMLElement>('.tool-tab-row')].map((node) =>
            [...node.children].map((child) => `${child.tagName.toLowerCase()}.${child.className}`)
        )
    ).toEqual([
        ['button.tool-tab-button', 'button.tool-tab-info'],
        ['button.tool-tab-button', 'button.tool-tab-info']
    ]);

    const readRow = toolTile('read');
    const readMark = toolInfo('read');

    // The mark: a real button that advertises the popup it opens, with a real accessible name
    // (an icon-only control is never unnamed here) and a purely decorative glyph.
    expect(readMark.type).toBe('button');
    expect(readMark.getAttribute('aria-haspopup')).toBe('dialog');
    expect(readMark.getAttribute('aria-expanded')).toBe('false');
    expect(readMark.getAttribute('aria-label')).toBe('Details for read');
    expect(readMark.title).toBe('Details for read');
    expect(readMark.disabled).toBe(false);
    expect(readMark.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(readMark.querySelector('svg')?.getAttribute('focusable')).toBe('false');
    expect(readMark.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(readMark.querySelector('path')?.getAttribute('fill')).toBe('none');
    // R4: the RESTING figure — no failure hook, and the info glyph mounted as the mark's only
    // child. `data-toggle='error'` and the warning path appear together, and only while a refused
    // enablement PATCH is outstanding on THIS row (see the switch tests below).
    expect(markState(readMark)).toBe('idle:info');
    expect(readMark.querySelector('path')?.getAttribute('d')).toBe(INFO_ICON_PATH);
    expect(readMark.children).toHaveLength(1);

    // The TILE is the switch (R1 swap): `aria-pressed` IS the enabled figure for assistive
    // tech, and it is the SAME figure the green edge paints (`data-enabled`, styles.css
    // `.tool-tab-button[data-enabled='true']`), because `paintToolRowEnablement` moves them in
    // one pass. The tooltip the tick box used to carry now sits on the control that performs
    // the write, and says what a press here does.
    expect(readRow.getAttribute('aria-pressed')).toBe('true');
    expect(readRow.dataset.enabled).toBe('true');
    expect(readRow.getAttribute('aria-disabled')).toBeNull();
    expect(readRow.dataset.locked).toBeUndefined();
    expect(readRow.getAttribute('aria-haspopup')).toBeNull();
    expect(readRow.title).toBe(ENABLED_TITLE);

    // The mark is the tile's SIBLING, never its child.
    expect(readRow.parentElement?.className).toBe('tool-tab-row');
    expect(readRow.contains(readMark)).toBe(false);
    expect(readMark.parentElement?.className).toBe('tool-tab-row');
    expect(readMark.closest('.tool-tab-button')).toBeNull();

    // R5: the harness-owned core row gets a mark like every row, and its TILE IS A SWITCH LIKE
    // EVERY OTHER ONE. `toolRequest` is `visibility: 'core'`, so the route states `protected: true`
    // — the UNREGISTER axis ("this name cannot be removed from the registry"), which is no longer a
    // reason to refuse a toggle — and the row reads `enabled: true`, the gate's own figure with no
    // `protected` escape hatch behind it. So the tile is pressed, NOT `aria-disabled`, carries no
    // `data-locked`, and its press sends the PATCH (pinned end to end in the `write` test below).
    const coreRow = toolTile('toolRequest');
    const coreMark = toolInfo('toolRequest');

    expect(coreRow.dataset.enabled).toBe('true');
    expect(coreRow.getAttribute('aria-pressed')).toBe('true');
    expect(coreRow.getAttribute('aria-disabled')).toBeNull();
    expect(coreRow.dataset.locked).toBeUndefined();
    expect(coreRow.disabled).toBe(false);
    expect(coreRow.title).toBe(ENABLED_TITLE);
    // The dialog is reachable from the mark either way.
    expect(coreMark.getAttribute('aria-expanded')).toBe('false');
    expect(coreMark.title).toBe('Details for toolRequest');

    // Nothing is left of the old pill, the pin, a `role="switch"`, or the tick box and its
    // input element.
    expect(document.querySelectorAll('.tool-tab-toggle')).toHaveLength(0);
    expect(document.querySelectorAll('.tool-tab-pin')).toHaveLength(0);
    expect(document.querySelectorAll('[role="switch"]')).toHaveLength(0);
    expect(document.querySelectorAll('.tool-tab-enable')).toHaveLength(0);
    expect(byClass('.tools-pane', 'div').querySelectorAll('input')).toHaveLength(0);
    expect(document.querySelectorAll('.tool-tab-info')).toHaveLength(2);
    // The swap writes nothing on its own: rendering the pane is a read, never a PATCH.
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([]);

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

// The guard main.ts documents: a row that never stated an enablement states NO figure,
// rather than inventing one the server never reported — and its tile keeps the one behaviour
// that is still true of it (open the runner), while the row still gets its info mark.
it('renders a mark and no enablement figure for a row whose server never stated one', async () => {
    const legacyRow: Record<string, unknown> = { ...fileReadTool };
    delete legacyRow.enabled;

    // T4 moved the surface: the row that omits the figure is now a `GET /sessions/s1/tools` row.
    // `enabled` is a REQUIRED field of ../shared/harness-api.ts `SessionToolSummary`, so the
    // fixture drops the KEY the way JSON does — an `undefined` value is omitted by
    // `JSON.stringify`, which is exactly the payload an older server would send.
    const statedRow = { ...sessionToolRow(sessionRow(fileReadTool)), enabled: undefined } as unknown as SessionToolSummary;

    const calls = stubFetch((url, method) =>
        url === '/api'
            ? json(bootstrap({ tools: [legacyRow] }))
            : url === '/api/sessions/s1/tools' && method === undefined
              ? json(sessionToolPage([statedRow]))
              : undefined
    );
    await boot();

    openTools();
    await flush();

    const row = toolTile('read');
    const mark = toolInfo('read');

    // NEITHER figure: no green edge, no pressed toggle. The lock marker says WHY, in the same
    // `aria-disabled` + `data-locked` pair the conversation locks use, and it is a marker, not
    // the `disabled` attribute — the tile is still focusable and still presses.
    expect(row.dataset.enabled).toBeUndefined();
    expect(row.getAttribute('aria-pressed')).toBeNull();
    expect(row.dataset.locked).toBe('no-enablement');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.disabled).toBe(false);
    expect(row.title).toBe('This server reports no enablement for this tool · it cannot be switched here');

    // The row keeps its corner mark: a tool with no switchable figure still has a runner.
    expect(document.querySelectorAll('.tool-tab-enable')).toHaveLength(0);
    expect(document.querySelector('.tool-tab-pin')).toBeNull();
    expect(document.querySelectorAll('.tool-tab-info')).toHaveLength(1);
    expect(mark.getAttribute('aria-haspopup')).toBe('dialog');
    expect(mark.getAttribute('aria-label')).toBe('Details for read');
    expect(mark.getAttribute('aria-expanded')).toBe('false');

    // The fallback: with nothing to toggle, the tile keeps the behaviour it always had and
    // opens the runner — and it still writes NOTHING, which is the half the reader would
    // otherwise experience as a silent 400 on a route the row never justified.
    row.click();

    expect(byClass('.dialog-title', 'h2').textContent).toBe('read');
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([]);
    // The open figure lands on the mark either way, so one control can never look open while
    // the layer was raised by the other.
    expect(mark.getAttribute('aria-expanded')).toBe('true');
    expect(mark.dataset.open).toBe('true');
    expect(row.getAttribute('aria-pressed')).toBeNull();

    byClass('.dialog-close', 'button').click();
    await flush();

    expect(document.querySelector('.dialog')).toBeNull();
    expect(mark.getAttribute('aria-expanded')).toBe('false');
});

it('switches a tool off and back on with one tile click, and repaints the row from the conversation re-read', async () => {
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

    const row = toolTile('read');
    const mark = toolInfo('read');

    row.click();

    // In flight: NOTHING about the enabled figure has moved — a `<button>` never flips its own
    // `aria-pressed` (the old native checkbox did, and had to be pulled back), so the only new
    // facts are the busy flag and the `writing` lock that makes the tile inert. Only THIS row's
    // tile is locked, by its own write, and the app pill says what is being saved — the same
    // reporting the plugin settings save uses.
    expect(row.dataset.enabled).toBe('true');
    expect(row.getAttribute('aria-pressed')).toBe('true');
    expect(row.getAttribute('aria-busy')).toBe('true');
    expect(row.dataset.locked).toBe('writing');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.title).toBe('Switching this tool for this conversation…');
    // A press while the write is out costs nothing (the single-flight guard), and the row's mark
    // is untouched by any of it: the dialog stays reachable during a write, and an in-flight row
    // is not yet a refused one (R4 — the warning figure only arrives with a refusal).
    expect(mark.getAttribute('aria-expanded')).toBe('false');
    expect(markState(mark)).toBe('idle:info');
    expect(document.querySelector('.dialog')).toBeNull();

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


    // The SAME node repaints from the answer: no list rebuild, so the row stays the node the
    // runner dialog would hand focus back to. `data-enabled` (the green edge) and `aria-pressed`
    // (the toggle) move together, so the border and the state can never disagree, and the busy
    // lock is cleared with the write.
    expect(byClass('.tool-tab-button[data-tool="read"]', 'button')).toBe(row);
    expect(row.dataset.enabled).toBe('false');
    expect(row.getAttribute('aria-pressed')).toBe('false');
    expect(row.dataset.locked).toBeUndefined();
    expect(row.getAttribute('aria-disabled')).toBeNull();
    expect(row.getAttribute('aria-busy')).toBe('false');
    expect(row.title).toBe(DISABLED_TITLE);

    // The pane says NOTHING about the accepted switch: its live line is gone with the
    // markup, so the tile figure asserted above IS the report, and the pill returns to idle.
    expect(document.querySelector('.tools-tab-note')).toBeNull();
    expect(byClass('.status-text', 'span').textContent).toBe('idle');
    // R4: and the accepted switch leaves the corner mark exactly as it found it — the resting
    // glyph, the resting name, no `data-toggle`. A green edge with a red mark beside it would
    // claim the same row both succeeded and failed.
    expect(markState(mark)).toBe('idle:info');
    expect(mark.querySelector('path')?.getAttribute('d')).toBe(INFO_ICON_PATH);
    expect(markNaming(mark)).toEqual(['Details for read', 'Details for read']);

    // A second press inverts what the SERVER reported (the cache moved with the re-read), and the
    // traffic of the second switch is the same write-then-read pair — the pane never paints a
    // figure it did not get back from the conversation's own route.
    row.click();
    await flush();
    await flush();

    expect(calls.filter((call) => call.url === '/api/sessions/s1/tools/read' && call.method === 'PATCH')).toHaveLength(2);
    expect(traffic()).toHaveLength(5);
    expect(row.dataset.enabled).toBe('true');
    expect(row.getAttribute('aria-pressed')).toBe('true');
    expect(row.dataset.locked).toBeUndefined();
    expect(row.title).toBe(ENABLED_TITLE);
});

it('marks a refused switch on that row\u2019s corner mark and keeps the server sentence on the pill', async () => {
    // The conversation's own route refuses the write (409 while it is working, 403 for a protected
    // name — ../shared/harness-api.ts:1885). The sentence is the server's, and R4 leaves it in
    // exactly two places: this row's corner mark (its `title` and accessible name) and the pill.
    // Nothing was written, and no re-read follows a failure.
    const message = 'read cannot be switched off while this conversation is working.';
    const calls = stubFetch((url, method) => {
        if (url === '/api/sessions/s1/tools/read' && method === 'PATCH') return json({ error: { message } }, 409);

        return undefined;
    });

    await boot();
    openTools();
    await flush();

    const row = toolTile('read');
    const mark = toolInfo('read');
    const trafficBefore = toolboxTraffic(calls).length;

    row.click();
    // During the flight the tile is locked by its own write, and that is the ONLY thing that
    // moves: an `<button>` cannot flip its own `aria-pressed`, so unlike the old checkbox there
    // is nothing for the refusal to undo.
    expect(row.getAttribute('aria-busy')).toBe('true');
    expect(row.dataset.locked).toBe('writing');
    expect(row.dataset.enabled).toBe('true');
    expect(row.getAttribute('aria-pressed')).toBe('true');
    // …and the row is not wearing a refusal it has not received yet.
    expect(markState(mark)).toBe('idle:info');

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
    // the server (the live element is gone), and the tile still states the figure the server
    // holds, because nothing was written and the unlock pass repaints from that cache. The
    // busy flag and the `writing` lock are both cleared, so the reader can press again.
    expect(document.querySelector('.tools-tab-note')).toBeNull();
    expect(row.dataset.enabled).toBe('true');
    expect(row.getAttribute('aria-pressed')).toBe('true');
    expect(row.getAttribute('aria-busy')).toBe('false');
    expect(row.dataset.locked).toBeUndefined();
    expect(row.getAttribute('aria-disabled')).toBeNull();
    expect(row.title).toBe(ENABLED_TITLE);

    // R4: THE row figure. `data-toggle='error'` (the hook styles.css paints with `--danger`,
    // `.tool-tab-info[data-toggle='error']`) and the warning glyph move together, and the reason
    // is in the control's accessible name and its tooltip — the shape and the words, never colour
    // alone. The mark still only opens the dialog: a refused row is not an inert row.
    expect(markState(mark)).toBe('error:warning');
    expect(mark.querySelector('path')?.getAttribute('d')).toBe(WARNING_ICON_PATH);
    expect(mark.children).toHaveLength(1);
    expect(markNaming(mark)).toEqual([
        `Details for read · switch failed: ${message}`,
        `Details for read · switch failed: ${message}`
    ]);
    expect(mark.getAttribute('aria-haspopup')).toBe('dialog');
    expect(mark.getAttribute('aria-expanded')).toBe('false');
    expect(mark.disabled).toBe(false);
    // The refusal belongs to ONE row: the other row's mark is untouched.
    expect(markState(toolInfo('toolRequest'))).toBe('idle:info');

    // The server's own sentence is NOT dropped with the pane line: the pill reports the state
    // word, its `title` carries the diagnostic for pointer readers, and the hidden live-region
    // child announces it — so a refused switch still fails out loud, just not in the pane.
    expect(byClass('.status-text', 'span').textContent).toBe('error');
    expect(byClass('.status-detail', 'span').textContent).toBe(`tool enablement: ${message}`);

    // The next press clears the mark the MOMENT the attempt starts (a row never wears a warning for
    // a write it has already redone), and the refusal lands it back on, because the figure describes
    // the LAST attempt.
    row.click();
    expect(markState(mark)).toBe('idle:info');

    await flush();
    await flush();

    expect(markState(mark)).toBe('error:warning');
    expect(markNaming(mark)).toEqual([
        `Details for read · switch failed: ${message}`,
        `Details for read · switch failed: ${message}`
    ]);
});

it('takes the refusal mark off a tool row whose next switch is accepted', async () => {
    // The lifecycle the reader actually walks: press, be refused, press again, land. R4's promise is
    // that a warning never sticks to a row that later succeeded — and the tools pane has no sentence
    // to overwrite, so the mark is the ONLY thing that could get this wrong.
    const message = 'read cannot be switched off while this conversation is working.';
    let refused = 0;
    const calls = stubFetch((url, method) => {
        // ONE refusal, then the double's own store applies the write.
        if (url === '/api/sessions/s1/tools/read' && method === 'PATCH' && refused++ === 0)
            return json({ error: { message } }, 409);

        return undefined;
    });

    await boot();
    openTools();
    await flush();

    const row = toolTile('read');
    const mark = toolInfo('read');

    row.click();
    await flush();
    await flush();

    expect(markState(mark)).toBe('error:warning');
    expect(row.dataset.enabled).toBe('true');

    row.click();
    await flush();
    await flush();
    await flush();

    // Accepted: the write, the re-read that repaints the row, and a CLEAN mark — the resting glyph
    // and the resting name — because the attempt cleared it and nothing put it back.
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(2);
    expect(row.dataset.enabled).toBe('false');
    expect(row.getAttribute('aria-pressed')).toBe('false');
    expect(markState(mark)).toBe('idle:info');
    expect(mark.querySelector('path')?.getAttribute('d')).toBe(INFO_ICON_PATH);
    expect(markNaming(mark)).toEqual(['Details for read', 'Details for read']);
    expect(byClass('.status-text', 'span').textContent).toBe('idle');
});

it('rebuilds the tools list clean after a refused switch', async () => {
    // The other clear condition R4 states: a pane RE-RENDER. Closing and re-opening the catalogue
    // repaints it from the cached page (`loadSessionTools` → `buildToolsTab`), and a rebuilt row is
    // a new node — the refusal figure belongs to the node it was painted on, so the map that drives
    // it is emptied with the nodes it describes rather than resurrected onto them.
    const message = 'read cannot be switched off while this conversation is working.';
    const calls = stubFetch((url, method) => {
        if (url === '/api/sessions/s1/tools/read' && method === 'PATCH') return json({ error: { message } }, 409);

        return undefined;
    });

    await boot();
    openTools();
    await flush();

    toolTile('read').click();
    await flush();
    await flush();

    expect(markState(toolInfo('read'))).toBe('error:warning');

    // Close the pane, then re-open it — the traffic of the second open is the cached re-read path,
    // and the list the pane paints is brand new.
    toolsToggle().click();
    await flush();
    openTools();
    await flush();
    await flush();

    expect(markState(toolInfo('read'))).toBe('idle:info');
    expect(markNaming(toolInfo('read'))).toEqual(['Details for read', 'Details for read']);
    expect([...document.querySelectorAll<HTMLButtonElement>('.tool-tab-info')].map(markState)).toEqual([
        'idle:info',
        'idle:info'
    ]);
    // The refusal is not a server figure either — nothing was written — so the rebuilt row states
    // the figure the conversation holds, unchanged.
    expect(toolTile('read').dataset.enabled).toBe('true');
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// The two row shapes the reader met on a BRAND-NEW conversation (the upgrade regression: a
// checkbox that answered with the top-right `error` pill), restated for R5 — the same two rows are
// now the two shapes that PROVE a harness-owned name switches.
//
// Both fixtures state ONLY the kernel facts a row is derived from — `visibility`, `pendingOnly`,
// `declared` — and let `sessionToolRow` compute `protected` / `enabled` / `origin` the way
// `sessionToolRowsOf` (src/server/api-reads.ts) does. That is deliberate: a fixture that hand-states
// `protected: true` pins its own opinion and cannot catch the rule drifting, while these two pin the
// derivation itself (the first `expect` of each test is the exact row the double projects, before
// the pane ever sees it).
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

it('switches a harness-owned core row and a pending-only control, because `protected` is the unregister axis', async () => {
    // `delegate` as the live kernel reports it: harness-owned (`visibility: 'core'`), NOT declared
    // by the frozen definition, `session_bound: true`. R5: that makes it UNREGISTERABLE, not
    // unswitchable — the gate states `enabled: true` for it on a fresh conversation exactly like it
    // does for a searchable name.
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
    // because its registration is pending-only — its manifest visibility reads `searchable`, which
    // is precisely the case a server-side guess from `visibility` used to get wrong. It is the row
    // whose tile used to be locked and whose press used to answer the reader with an `error` pill.
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
    // unregister figure in BOTH names (`delegate` by `visibility: 'core'`, `toolCancel` by its
    // pending-only registration), `enabled` is TRUE for both because a registered name is ON until
    // somebody withholds it or the toolbox runs out of slots, and `origin` is therefore
    // `discovered` for both — `discovered` is simply an ENABLED name this session did not declare.
    expect(config.toolRows()).toEqual([
        {
            name: 'delegate',
            group: 'Core tools',
            description: 'Delegate a unit of work to a subagent.',
            tags: ['core', 'harness'],
            visibility: 'core',
            session_bound: true,
            enabled: true,
            session_id: 's1',
            declared: false,
            origin: 'discovered',
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
            enabled: true,
            session_id: 's1',
            declared: false,
            origin: 'discovered',
            protected: true,
            source_available: false
        }
    ]);

    await boot();
    openTools();
    await flush();

    // `name:pressed:aria-disabled:locked` for every row. Both tiles are PRESSED and NEITHER is
    // locked: the `protected` figure paints nothing, and `data-locked` has no value that applies
    // here (its whole vocabulary is `writing` / `offline` / `no-enablement`).
    expect(
        [...document.querySelectorAll<HTMLElement>('.tool-tab-row')].map((node) => {
            const tile = node.querySelector<HTMLButtonElement>('.tool-tab-button')!;

            return `${tile.dataset.tool}:${String(tile.getAttribute('aria-pressed'))}:${tile.getAttribute('aria-disabled') ?? 'null'}:${tile.dataset.locked}`;
        })
    ).toEqual(['delegate:true:null:undefined', 'toolCancel:true:null:undefined']);

    // The tooltip is the LIVE one, not a sentence about the harness holding the name.
    const delegate = toolTile('delegate');

    expect(delegate.dataset.enabled).toBe('true');
    expect(delegate.getAttribute('aria-pressed')).toBe('true');
    expect(delegate.disabled).toBe(false);
    expect(delegate.title).toBe(ENABLED_TITLE);
    expect(toolTile('toolCancel').title).toBe(ENABLED_TITLE);

    // Both presses go through, in the two ways a press can arrive.
    //
    // The native one first: `delegate` is harness-owned and writes.
    delegate.click();
    await flush();
    await flush();

    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([
        { url: '/api/sessions/s1/tools/delegate', method: 'PATCH', body: { enabled: false } }
    ]);
    // The double accepted it — no 403 — and the re-read says so, which is what moved the tile.
    expect(config.toolWrites).toEqual([{ name: 'delegate', body: { enabled: false } }]);
    expect(toolTile('delegate').getAttribute('aria-pressed')).toBe('false');
    expect(toolTile('delegate').dataset.enabled).toBe('false');
    expect(toolTile('delegate').title).toBe(DISABLED_TITLE);
    expect(toolTile('delegate').dataset.locked).toBeUndefined();

    // A DISPATCHED click on the pending-only control takes the SAME path: the guard in
    // `buildToolsTab` only refuses `writing` and a dead transport, so a `protected` name is a
    // normal write. This is the state that used to answer the reader with an `error` pill.
    toolTile('toolCancel').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
    await flush();

    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(2);
    expect(config.toolWrites).toEqual([
        { name: 'delegate', body: { enabled: false } },
        { name: 'toolCancel', body: { enabled: false } }
    ]);
    expect(toolTile('toolCancel').dataset.enabled).toBe('false');
    expect(toolTile('toolCancel').getAttribute('aria-pressed')).toBe('false');
    expect(toolTile('toolCancel').getAttribute('aria-disabled')).toBeNull();
    // Withheld names stop reporting `origin: 'discovered'`, the way the server re-derives them:
    // `discovered` is an ENABLED name this session did not declare.
    expect(config.toolRows().map((row) => [row.name, row.enabled, row.protected, row.origin])).toEqual([
        ['delegate', false, true, 'catalogue'],
        ['toolCancel', false, true, 'catalogue']
    ]);
    // A switch never costs the row its dialog: the mark beside the tile opens the runner for both
    // names, which is the whole point of keeping the tile focusable and clickable.
    for (const name of ['delegate', 'toolCancel']) {
        toolInfo(name).click();
        expect(byClass('.dialog-title', 'h2').textContent).toBe(name);
        expect(toolInfo(name).getAttribute('aria-expanded')).toBe('true');
        byClass('.dialog-close', 'button').click();
        await flush();
        expect(document.querySelector('.dialog')).toBeNull();
        expect(toolInfo(name).getAttribute('aria-expanded')).toBe('false');
    }

    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(2);
    // Both writes were ACCEPTED, so there is no refusal anywhere: the pill is back to the idle
    // figure boot left, with no diagnostic under it, and neither row wears the warning glyph. The
    // pane itself keeps its deliberate shape — no inline error line, no retry control, head = title
    // only — which is the layout the reader asked for (main.ts `setToolEnabled`'s catch reports on
    // the pill alone).
    expect(byClass('.status-text', 'span').textContent).toBe('idle');
    expect(byClass('.status-detail', 'span').textContent).toBe('');
    expect(markState(toolInfo('delegate'))).toBe('idle:info');
    expect(markState(toolInfo('toolCancel'))).toBe('idle:info');
    expect(document.querySelector('.tools-tab-note')).toBeNull();
    expect(document.querySelector('.tools-tab-hint')).toBeNull();
    expect(document.querySelector('.tools-tab-retry')).toBeNull();
    expect([...byClass('.tools-tab-head', 'div').children].map((node) => node.className)).toEqual(['tools-tab-title']);
});

it('renders a brand-new session with every tile on, and switches one of them with one accepted write', async () => {
    // The seed a brand-new conversation ships with: `enableAllTools` (src/harness.ts, run by
    // src/server/sessions.ts for a CREATE, a RESTORE and a RESET) seeds the conversation's gate
    // with EVERY globally-enabled registration, so each row below must arrive `enabled: true`
    // without a fixture saying so. R5 removed the "switchable only" half of that rule, and these
    // three names are searchable anyway — the protected-name version of the same figure is pinned
    // by the test above.
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

    // R1 (swap): every TILE is pressed and none of them is locked — no row on a fresh
    // conversation can produce the refusal the reader hit. The triple is
    // `name:aria-pressed:aria-disabled`, and `aria-disabled` is absent ('false' here) exactly
    // when the tile may write.
    expect(
        [...document.querySelectorAll<HTMLElement>('.tool-tab-row')].map((node) => {
            const tile = node.querySelector<HTMLButtonElement>('.tool-tab-button');

            return `${tile?.dataset.tool}:${String(tile?.getAttribute('aria-pressed'))}:${tile?.getAttribute('aria-disabled') ?? 'false'}`;
        })
    ).toEqual(['glob:true:false', 'read:true:false', 'syntax:true:false']);
    expect(toolTile('read').title).toBe(ENABLED_TITLE);

    toolTile('read').click();
    await flush();
    await flush();

    // The write, on the conversation's route, and the re-read that repaints it — in that order.
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([
        { url: '/api/sessions/s1/tools/read', method: 'PATCH', body: { enabled: false } }
    ]);
    expect(toolboxTraffic(calls)).toHaveLength(3);
    expect(config.toolWrites).toEqual([{ name: 'read', body: { enabled: false } }]);

    // The row moves to the figure the next read states, and the read re-derives `origin` with it
    // (a name that is no longer enabled is not `discovered`). The other tiles are untouched.
    expect(config.toolRows().map((row) => [row.name, row.enabled, row.protected, row.origin])).toEqual([
        ['glob', true, false, 'discovered'],
        ['read', false, false, 'catalogue'],
        ['syntax', true, false, 'catalogue']
    ]);
    // THE FIGURE, on the toggle itself: `aria-pressed` and the green `data-enabled` edge move
    // together, and the tile keeps no state class of its own (the swap removed `is-on`/`is-off`).
    expect(toolTile('read').getAttribute('aria-pressed')).toBe('false');
    expect(toolTile('read').dataset.enabled).toBe('false');
    expect(toolTile('read').className).toBe('tool-tab-button');
    // The tile is a toggle, not a labelled checkbox: its accessible name is the row's own text
    // (the tool name and its kind), so a press is announced as "read core pressed/unpressed".
    expect(toolTile('read').getAttribute('aria-label')).toBeNull();
    expect(toolTile('glob').getAttribute('aria-pressed')).toBe('true');
    expect(toolTile('syntax').getAttribute('aria-pressed')).toBe('true');
    // And the switch cost the reader NO layer: the tile press never opens the runner, and the
    // corner mark it did not touch still says "closed".
    expect(document.querySelector('.dialog')).toBeNull();
    expect(toolInfo('read').getAttribute('aria-expanded')).toBe('false');
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
// What is pinned is the pane's own two figures, NOT a translation of them: every tile PRESSED
// (`main.ts` `toolRowInContext` — a protected name is in context because the harness holds it, and
// the reader's complaint was a page that looked empty) and EXACTLY the ten protected tiles LOCKED
// (`toolSwitchLockOf` — the tile whose PATCH would 403 carries the `aria-disabled` +
// `data-locked='protected'` pair before the click, which is the other half of the complaint:
// pressing `delegate` used to produce a refusal).
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

it('paints the measured 32-row new-session payload with every tile pressed and exactly the ten protected tiles locked', async () => {
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
    // The figure read is the TILE's: `aria-pressed` for the state, `data-locked` for the reason
    // a press cannot write, and `title` for the sentence the reader hears.
    const painted = [...document.querySelectorAll<HTMLElement>('.tool-tab-row')].map((node) => {
        const tile = node.querySelector<HTMLButtonElement>('.tool-tab-button')!;

        return {
            name: tile.dataset.tool ?? '',
            pressed: tile.getAttribute('aria-pressed'),
            locked: tile.dataset.locked,
            title: tile.title
        };
    });

    expect(painted).toHaveLength(32);
    // The complaint in one figure: on a brand-new conversation NO tile reads as off.
    expect(painted.filter((row) => row.pressed !== 'true').map((row) => row.name)).toEqual([]);
    // ...and the complaint that `delegate` errors when pressed: exactly the ten names the route
    // 403s are the ten tiles that cannot write — each one stating WHY, and none of them using the
    // `disabled` attribute, because every row keeps its info control.
    expect(painted.filter((row) => row.locked !== undefined)).toEqual(
        PROTECTED_HOST_NAMES.map((name) => ({
            name,
            pressed: 'true',
            locked: 'protected',
            title: 'Always in context for this conversation · the harness itself declares it, so it cannot be switched here'
        }))
    );
    expect(painted.filter((row) => row.locked === undefined).map((row) => row.name)).toEqual(
        MEASURED_SEEDS.map((seed) => seed.name)
            .filter((name) => !PROTECTED_HOST_NAMES.includes(name))
            .sort((left, right) => left.localeCompare(right))
    );
    // Every row of the payload has its own corner mark, locked rows included — the dialog is
    // reachable from all 32 rows even though ten of them cannot be switched.
    expect(document.querySelectorAll('.tool-tab-info')).toHaveLength(32);
    expect(document.querySelectorAll('.tool-tab-enable')).toHaveLength(0);

    // The two tooltip sentences, stated per row rather than counted: a locked tile says WHY the
    // harness holds it, a live tile says it can be switched off. A protected row that read as
    // "off, click to switch it on" is the lie this pass exists to remove.
    for (const row of painted) {
        expect(row.title).toBe(
            PROTECTED_HOST_NAMES.includes(row.name)
                ? 'Always in context for this conversation · the harness itself declares it, so it cannot be switched here'
                : ENABLED_TITLE
        );
    }

    // The row SET is A–Z (R5), and the head note counts what it renders — both halves of "32 rows"
    // the reader can see, pinned so a page-walk regression cannot quietly drop seven rows off the
    // pane (`main.ts` `paintToolsHead` writes the count line).
    expect(painted.map((row) => row.name)).toEqual([...MEASURED_SEEDS.map((seed) => seed.name)].sort((left, right) => left.localeCompare(right)));
    expect(byClass('.harness-note', 'p').textContent).toBe('32 tools · the toolbox of this conversation');
});

// R1 (swap)'s click separation: the tile and the corner mark are two controls in one row, and
// each owns exactly one of the two actions.
it('writes enablement from the tile without opening the runner, and the corner mark still opens it', async () => {
    // The TILE writes the conversation (`PATCH /sessions/s1/tools/read`, answered by the shared
    // double), while the corner MARK still pays the deployment's identified detail read for the
    // runner's schema — that read is execution, and T4 left it global.
    const calls = stubFetch((url, method) => {
        if (url === '/api/tools/read' && method === undefined) return json({ tool: toolRowAnswer('read', false) });

        return undefined;
    });

    await boot();
    openTools();
    await flush();

    // The mark is the tile's SIBLING inside the row wrapper, never its descendant: a `<button>`
    // cannot contain a control, and nesting them would merge the two actions into one.
    const info = toolInfo('read');

    expect(info.closest('.tool-tab-button')).toBeNull();
    expect(info.parentElement).toBe(toolTile('read').parentElement);
    expect(info.getAttribute('aria-haspopup')).toBe('dialog');
    expect(info.getAttribute('aria-expanded')).toBe('false');

    toolTile('read').click();
    await flush();
    await flush();

    // The write went, on the conversation's route, and NO runner layer was adopted over the list.
    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([
        { url: '/api/sessions/s1/tools/read', method: 'PATCH', body: { enabled: false } }
    ]);
    expect(document.querySelector('.dialog')).toBeNull();
    expect(document.querySelector('.tool-args')).toBeNull();
    expect(info.getAttribute('aria-expanded')).toBe('false');
    expect(toolTile('read').getAttribute('aria-pressed')).toBe('false');
    expect(byClass('.tool-tab-button[data-tool="read"]', 'button').getAttribute('aria-pressed')).toBe('false');

    // The mark's press is the other action: it opens the runner and writes nothing.
    info.click();

    expect(byClass('.dialog-title', 'h2').textContent).toBe('read');
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
    // The open state is the mark's, and it is the node the dialog hands focus back to.
    expect(info.getAttribute('aria-expanded')).toBe('true');
    expect(info.dataset.open).toBe('true');

    byClass('.dialog-close', 'button').click();
    await flush();

    expect(document.querySelector('.dialog')).toBeNull();
    // The list came back with the server's figure still painted on both readings.
    expect(toolTile('read').getAttribute('aria-pressed')).toBe('false');
    expect(info.getAttribute('aria-expanded')).toBe('false');
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
    // The row is still a real, focusable button mid-run — the tile never takes the `disabled`
    // attribute, because its corner mark has to keep opening the dialog.
    expect(byClass('.tool-tab-button[data-tool="read"]', 'button').disabled).toBe(false);

    // T4: the SWITCH is a different story. `PATCH /sessions/{id}/tools/{id}` answers 409 unless the
    // session is idle (../shared/harness-api.ts:1873, `assertIdleForToolMutation` in
    // src/server/api.ts), so main.ts states that rule on the control BEFORE the click
    // (`toolSwitchLockOf` → 'running') instead of taking the refusal on the chin afterwards.
    const runningTile = toolTile('read');

    expect(runningTile.getAttribute('aria-disabled')).toBe('true');
    expect(runningTile.dataset.locked).toBe('running');
    expect(runningTile.title).toBe('This conversation is working · the switch unlocks when its run ends');

    // A row is clickable mid-run: its runner opens over the list, schema read and all — from the
    // corner mark, which a pending run never locks.
    toolInfo('toolRequest').click();
    expect(byClass('.dialog-title', 'h2').textContent).toBe('toolRequest');
    byClass('.dialog-close', 'button').click();
    await flush();
    expect(byClass('.stage', 'div').querySelector('.tools-pane')?.isConnected).toBe(true);

    // A locked tile swallows the press in its handler, so the run costs the conversation no write
    // and no 409: the toolbox traffic of this fixture is the single read that opened the pane.
    runningTile.click();
    await flush();
    await flush();

    expect(calls.filter((call) => call.method === 'PATCH')).toEqual([]);
    // The whole toolbox traffic of this fixture is the ONE read that opened the pane: the locked
    // control costs the conversation no write and no 409 round-trip.
    expect(toolboxTraffic(calls)).toEqual([{ url: TOOLBOX_PAGE_URL, method: undefined, body: undefined }]);
    // And the figure is exactly what it was before the press: nothing moved, optimistically or
    // otherwise.
    expect(toolTile('read').getAttribute('aria-pressed')).toBe('true');
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
